// The side panel (#help-panel, "the dock"): one resizable, vertically tabbed
// column on the right that holds the help, the Stations cards and — above a
// phone's width — every one of the Stations map's own controls.
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
//   2. **The map's controls are all in the strip, from the first render.**
//      Every panel MapChrome builds for the Stations map is a pane with a
//      button of its own, every plain button is in the strip itself, in the
//      corner's groups and order with a gap between groups, the camera pair is
//      hidden, no pin is on screen — and the map's top-right corner holds
//      nothing at all. Building the map opened nothing.
//   3. **Panes and buttons.** Help and back, the map's panes opened from their
//      buttons and working to a real pointer, and the showing pane's own button
//      shutting the panel — measured as the map getting the width, and as
//      Leaflet having been told (a map that is wider than Leaflet thinks takes
//      clicks in the wrong place and says nothing about it).
//   4. **The width handle is a real separator** — role, orientation, a value in
//      px with its range, focusable with a ring — that a real pointer drags,
//      that the keys move, that clamps, and whose width survives a reload.
//   5. **Leaving the tab, and the map being built again.** The Stations button,
//      every card and every map control go with the tab, and no id is ever on
//      the page twice — the failure that would be silent: getElementById finds
//      the stale copy first and the app paints into a card nobody can see. A
//      render inside the tab keeps the same panes and strip buttons, the pane
//      that was showing, focus, the Map display find term and the pane's scroll.
//   6. **Full screen keeps the side panel.** The map fills the window except
//      the side panel, which stays beside it at its width, above the header,
//      with its panes, its handle and its buttons working; the map's edge
//      follows the side panel's, re-measured each time; Tab stays inside the
//      two of them and Escape from the side panel ends it.
//   7. **◫, the lg fold and a phone**: the cards under the map and back with
//      the same Leaflet map; below 1,100 px the cards fold under the map and
//      the strip keeps Help and the map's controls; at 375 px it is the old
//      phone shape exactly — no column, the help edge tab, the cards under the
//      map, and the map's controls back in its corner as flyouts whose pins
//      dock them there. Crossing 560 px either way keeps focus.
//   8. **No sideways scroll** at 375, 768 and 1440 with the side panel open,
//      and a strip taller than the window that scrolls, with every button in
//      reach and a scrollbar that stands beside the buttons, not over them.
//
// What this file used to hold and no longer does: a pin moving one panel into
// the side panel and an unpin putting it back, and full screen sending the
// pinned panels back to the map's corner. Neither exists any more — the side
// panel holds every panel whatever its pin says, and full screen leaves it on
// screen — so those assertions are gone rather than weakened, and §2, §5 and
// §6 hold what replaced them.
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

// …and every id the map's panels are found by, for the same rule.
const PANEL_IDS = ['map-display-block', 'map-legend', 'map-draw-panel', 'map-3d-panel-body', 'sites-run', 'polar-status'];

// The strip, top to bottom, as the corner orders it: the side panel's own two,
// then the map's groups — show, tools, 3d, screen, reset — and within each by
// its declared order. Panes are 'map-<id>', plain buttons their class.
const STRIP = ['help', 'stations',
               'map-display', 'map-legend',
               'map-draw', 'map-polar', 'map-sites', 'mn-map-here',
               'mn-map-3d', 'map-3d', 'mn-map-north', 'mn-map-tilt',
               'mn-map-full', 'mn-map-split',
               'mn-map-reset'];
const BUTTONS = STRIP.filter(k => k.startsWith('mn-map-'));

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
  const look = () => page.evaluate(([ids, pids]) => {
    const panel = document.getElementById('help-panel');
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; };
    const map = document.getElementById('leaflet-map');
    const counts = {};
    for (const id of [...ids, ...pids]) counts[id] = document.querySelectorAll('#' + id).length;
    const key = (b) => b.dataset.dock || [...b.classList].find(c => c.startsWith('mn-map-')) || b.className;
    const btns = [...panel.querySelectorAll('.dock-strip button')];
    return {
      showing: dockShowing(),
      pref: state.dockTab,
      open: state.dockOpen,
      collapsed: panel.classList.contains('collapsed'),
      panel: box(panel),
      map: box(map),
      leafletW: state.map ? state.map.getSize().x : null,
      mapClientW: map ? map.clientWidth : null,
      strip: btns.map(key),
      expanded: Object.fromEntries(btns.filter(b => b.dataset.dock).map(b => [b.dataset.dock, b.getAttribute('aria-expanded')])),
      help: document.querySelector('#help-panel .help-toggle')?.getAttribute('aria-expanded'),
      cardsIn: (() => { const c = document.getElementById('stations-cards');
        return !c ? null : c.closest('#help-panel') ? 'dock' : c.closest('#main-content') ? 'main' : '?'; })(),
      counts,
      active: document.activeElement ? key(document.activeElement) : null,
    };
  }, [CARD_IDS, PANEL_IDS]);

  // Where one map panel is: 'dock' (a pane of the side panel), 'corner' (the
  // map's own control corner) or '?'; whole — icon, heading, pin, body; and
  // whether its body is on screen.
  const wrapAt = (id) => page.evaluate((p) => {
    const all = [...document.querySelectorAll(`.mn-mapctl[data-panel="${p}"]`)];
    const w = all[0];
    if (!w) return { n: 0 };
    const body = w.querySelector('.mn-mapctl-body');
    const vis = (el) => !!(el && el.getClientRects().length && (el.offsetWidth || el.offsetHeight));
    return {
      n: all.length,
      where: w.closest('#help-panel') ? 'dock' : w.closest('.leaflet-control-container') ? 'corner' : '?',
      whole: !!(w.querySelector(':scope > .mn-mapctl-btn') && body
               && body.querySelector('.mn-mapctl-head .mn-mapctl-title') && body.querySelector('.mn-mapctl-pin')
               && body.querySelector('.mn-mapctl-content')),
      pinned: w.classList.contains('is-pinned'),
      shown: vis(body),
      icon: vis(w.querySelector(':scope > .mn-mapctl-btn')),
      pin: vis(w.querySelector('.mn-mapctl-pin')),
      title: (w.querySelector('.mn-mapctl-title') || {}).textContent,
      pane: (w.closest('.dock-pane') || {}).id || null,
    };
  }, id);

  // What is drawn in the map's top-right corner, as boxes the browser gave it.
  const cornerNow = () => page.evaluate(() => {
    const c = document.querySelector('#leaflet-map .leaflet-top.leaflet-right');
    if (!c) return { missing: true, drawn: [] };
    const drawn = [...c.querySelectorAll('*')]
      .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .map(el => el.className || el.tagName);
    const pseudo = [...c.querySelectorAll('*')].filter(el => {
      const cs = getComputedStyle(el, '::before');
      return cs.content && cs.content !== 'none' && cs.display !== 'none' && el.getClientRects().length;
    }).length;
    return { drawn, pseudo };
  });

  // ── 1. A fresh visit ─────────────────────────────────────────────────────
  let s = await look();
  check('a fresh visit opens the side panel on the Stations cards, at 1440',
    s.showing === 'stations' && s.cardsIn === 'dock' && !s.collapsed, JSON.stringify(s));
  check('…and ❔ says Help is not the pane showing, 📋 that Stations is',
    s.help === 'false' && s.expanded.stations === 'true', JSON.stringify(s.expanded));
  check('every card id and every panel id is on the page exactly once',
    [...CARD_IDS, ...PANEL_IDS].every(id => s.counts[id] === 1), JSON.stringify(s.counts));
  const shape = await page.evaluate(() => {
    const strip = document.querySelector('#help-panel .dock-strip');
    const outside = sel => [...document.querySelectorAll(sel)].filter(el => !el.closest('#main-content'));
    const btns = [...strip.querySelectorAll('button')].filter(b => b.getClientRects().length);
    return {
      asides: outside('aside').length,
      navs: outside('nav').length,
      stripRole: strip.getAttribute('role'),
      stripName: strip.getAttribute('aria-label'),
      named: btns.every(b => (b.getAttribute('aria-label') || '').trim().length > 0),
      controls: [...strip.querySelectorAll('.dock-tab')].every(b => !!document.getElementById(b.getAttribute('aria-controls'))),
      square: btns.map(b => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }),
      firstIsHelp: btns[0] && btns[0].classList.contains('help-toggle'),
      stationsH2: !!document.querySelector('#dock-pane-stations > h2'),
    };
  });
  check('still one <aside> and one <nav>, and the strip is a labelled group of named buttons',
    shape.asides === 1 && shape.navs === 1 && shape.stripRole === 'group' && !!shape.stripName
      && shape.named && shape.controls && shape.firstIsHelp, JSON.stringify(shape));
  check('…every one of them 44 px square', shape.square.every(([w, h]) => w === 44 && h === 44), JSON.stringify(shape.square));
  check('…and the Stations pane has the h2 its cards\' h3s step from', shape.stationsH2);

  // ── 2. The map's controls, all in the strip ──────────────────────────────
  check('the strip holds every one of the map\'s controls, in the corner\'s order, from the first render',
    JSON.stringify(s.strip) === JSON.stringify(STRIP), JSON.stringify(s.strip));
  const panels = {};
  for (const id of ['display', 'legend', 'draw', 'polar', 'sites', '3d']) panels[id] = await wrapAt(id);
  check('every panel is a pane of the side panel, whole, one of each',
    Object.values(panels).every(p => p.n === 1 && p.where === 'dock' && p.whole),
    JSON.stringify(panels));
  check('…with its own corner icon and its 📌 not on screen there',
    Object.values(panels).every(p => !p.icon && !p.pin), JSON.stringify(panels));
  check('…and building the map opened none of them — the cards are still the pane showing',
    s.showing === 'stations' && Object.values(panels).every(p => !p.shown), JSON.stringify(s));
  const buttons = await page.evaluate((cls) => cls.map(c => {
    const all = [...document.querySelectorAll('.' + c)];
    const b = all[0];
    return { c, n: all.length, inStrip: !!(b && b.closest('#help-panel .dock-strip')),
             shown: !!(b && b.getClientRects().length), pressed: b ? b.getAttribute('aria-pressed') : null };
  }), BUTTONS);
  check('every plain button is in the strip itself, one of each, still wearing its own class',
    buttons.every(b => b.n === 1 && b.inStrip), JSON.stringify(buttons));
  check('…the camera pair is not on screen while the map is flat',
    buttons.filter(b => /north|tilt/.test(b.c)).every(b => !b.shown)
      && buttons.filter(b => !/north|tilt/.test(b.c)).every(b => b.shown), JSON.stringify(buttons));
  check('…the toggles say whether they are on, the one-shot buttons do not',
    ['mn-map-here', 'mn-map-3d', 'mn-map-full', 'mn-map-split'].every(c => ['true', 'false'].includes(buttons.find(b => b.c === c).pressed))
      && ['mn-map-reset', 'mn-map-north', 'mn-map-tilt'].every(c => buttons.find(b => b.c === c).pressed === null),
    JSON.stringify(buttons.map(b => [b.c, b.pressed])));
  const groups = await page.evaluate(() => {
    const strip = document.querySelector('#help-panel .dock-strip');
    return [...strip.querySelectorAll(':scope > .dock-group')].map(g => ({
      name: g.dataset.group, role: g.getAttribute('role'), label: g.getAttribute('aria-label'),
      items: [...g.querySelectorAll('button')].filter(b => b.getClientRects().length)
        .map(b => { const r = b.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }),
    }));
  });
  const known = await page.evaluate(() => Object.keys(MapChrome.groups()));
  const mapGroups = groups.filter(g => g.name !== 'side');
  check('the map\'s groups stand in the order MapChrome declares, each a labelled group',
    JSON.stringify(mapGroups.map(g => g.name)) === JSON.stringify(known)
      && mapGroups.every(g => g.role === 'group' && /\S/.test(g.label || '')),
    JSON.stringify(groups.map(g => [g.name, g.role, g.label])));
  const inside = [], between = [];
  const vis = groups.filter(g => g.items.length);
  for (const g of vis) for (let i = 1; i < g.items.length; i++) inside.push(g.items[i].top - g.items[i - 1].bottom);
  for (let i = 1; i < vis.length; i++) between.push(vis[i].items[0].top - vis[i - 1].items[vis[i - 1].items.length - 1].bottom);
  check('…with every gap between two groups wider than every gap inside one',
    between.length === known.length && Math.min(...between) > Math.max(...inside) + 6,
    JSON.stringify({ inside, between }));
  const corner = await cornerNow();
  check('the map\'s top-right corner holds nothing — no icon, no empty bar, no hairline',
    !corner.missing && corner.drawn.length === 0 && corner.pseudo === 0, JSON.stringify(corner));
  const zoom = await page.evaluate(() => !!document.querySelector('#leaflet-map .leaflet-top.leaflet-left .leaflet-control-zoom')
    && document.querySelector('#leaflet-map .leaflet-control-zoom').getClientRects().length > 0);
  check('…while Leaflet\'s zoom stays on the map, top-left', zoom);

  // Pinning from code, on this map, above a phone: nothing moves, nothing shows.
  await page.evaluate(() => MapChrome.setPinned('legend', true));
  await page.waitForTimeout(200);
  const pinnedLegend = await wrapAt('legend');
  s = await look();
  check('a pin set on a panel in the side panel moves nothing and opens nothing',
    pinnedLegend.where === 'dock' && pinnedLegend.pinned && !pinnedLegend.pin && s.showing === 'stations',
    JSON.stringify({ pinnedLegend, showing: s.showing }));
  await page.evaluate(() => MapChrome.setPinned('legend', false));

  // ── 3. Panes and buttons ─────────────────────────────────────────────────
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
  // …through every group and every kind of button, the hidden camera pair skipped.
  const walked = [];
  for (let i = 0; i < STRIP.length; i++) { await page.keyboard.press('ArrowDown'); walked.push((await look()).active); }
  const onScreen = STRIP.filter(k => !/north|tilt/.test(k));
  check('…and on down the map\'s controls, across the groups, skipping the hidden ones, round to ❔',
    JSON.stringify(walked.slice(0, onScreen.length - 1)) === JSON.stringify(onScreen.slice(2).concat('help')),
    JSON.stringify(walked));
  await page.keyboard.press('End');
  check('End goes to the last of them', (await look()).active === 'mn-map-reset', (await look()).active);
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  s = await look();
  check('…and 📋 brings the cards back', s.showing === 'stations' && s.help === 'false', JSON.stringify(s));

  // A map pane from its button, by a real pointer, and a real click inside it.
  await page.click('#help-panel .dock-tab[data-dock="map-display"]');
  await page.waitForTimeout(300);
  let d = await wrapAt('display');
  s = await look();
  check('🗺️ opens Map display as a pane of the side panel, at the same width',
    s.showing === 'map-display' && s.expanded['map-display'] === 'true' && d.shown && s.panel.w === w0,
    JSON.stringify({ s, d }));
  const arrowsBefore = await page.evaluate(() => state.mapArrows);
  await page.click('#dock-pane-map-display #map-display-block input[onchange^="MapArrows.setEnabled"]');
  await page.waitForTimeout(300);
  check('a real click inside it works', await page.evaluate(() => state.mapArrows) === !arrowsBefore,
    `arrows ${arrowsBefore} → ${await page.evaluate(() => state.mapArrows)}`);
  await page.evaluate(() => MapArrows.setEnabled(true));
  await page.click('#help-panel .dock-tab[data-dock="map-sites"]');
  await page.waitForTimeout(250);
  await page.locator('#sites-paste').fill('Alstonville STP');
  check('the site finder\'s box takes typing in its pane',
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
  // A plain button in the strip does what it did on the map.
  await page.click('#help-panel .dock-strip .mn-map-here');
  await page.waitForTimeout(150);
  const here = await page.evaluate(() => ({ armed: MapHere.armed(), pressed: document.querySelector('.mn-map-here').getAttribute('aria-pressed') }));
  check('ℹ️ in the strip arms What is here, and says so', here.armed && here.pressed === 'true', JSON.stringify(here));
  await page.click('#help-panel .dock-strip .mn-map-here');
  await page.waitForTimeout(150);
  check('…and pressed again disarms it', await page.evaluate(() => !MapHere.armed()));

  await page.click('#help-panel .dock-tab[data-dock="stations"]');
  await page.waitForTimeout(300);
  const mapWide = (await look()).map.w;
  await page.click('#help-panel .dock-tab[data-dock="stations"]');
  await page.waitForTimeout(500);
  s = await look();
  check('pressing the showing pane\'s button shuts the side panel and the map takes the width',
    s.showing === null && s.collapsed && s.map.w > mapWide + 300 && s.pref === 'stations', JSON.stringify(s));
  check('…and Leaflet was told: the map it projects against is the map on screen',
    s.leafletW === s.mapClientW, `${s.leafletW} vs ${s.mapClientW}`);
  check('…with the map\'s controls still in the strip, which is all that is left of the panel',
    JSON.stringify(s.strip) === JSON.stringify(STRIP), JSON.stringify(s.strip));
  await page.click('#help-panel .dock-tab[data-dock="stations"]');
  await page.waitForTimeout(500);
  s = await look();
  check('…and opening it again gives the width back, re-measured',
    s.showing === 'stations' && Math.abs(s.map.w - mapWide) <= 2 && s.leafletW === s.mapClientW,
    JSON.stringify(s));

  // ── 4. The width handle ──────────────────────────────────────────────────
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
  // Reached the way a keyboard reaches it — Shift+Tab from ❔, the handle being
  // the one stop before the strip — because a focus ring is the browser's
  // answer to *how* focus arrived, and a programmatic focus after a mouse click
  // is correctly drawn without one.
  await page.focus('#help-panel .help-toggle');
  await page.keyboard.press('Shift+Tab');
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

  // ── 5. Leaving the tab, and the map being built again ────────────────────
  await page.evaluate(() => switchTab('passranges'));
  await page.waitForTimeout(300);
  s = await look();
  const away = await page.evaluate(() => ({
    wrappers: document.querySelectorAll('.mn-mapctl').length,
    buttons: document.querySelectorAll('.mn-map-full, .mn-map-3d, .mn-map-reset').length,
  }));
  check('leaving the tab takes the Stations button, every card and every map control with it',
    JSON.stringify(s.strip) === '["help"]' && away.wrappers === 0 && away.buttons === 0
      && [...CARD_IDS, ...PANEL_IDS].every(id => s.counts[id] === 0), JSON.stringify({ s, away }));
  check('…and the side panel is shut there, still preferring the cards',
    s.showing === null && s.collapsed && s.pref === 'stations' && s.open === true, JSON.stringify(s));
  await toStations();
  s = await look();
  check('coming back opens it on the cards again, the strip whole',
    s.showing === 'stations' && s.cardsIn === 'dock' && JSON.stringify(s.strip) === JSON.stringify(STRIP), JSON.stringify(s));
  check('…with every id on the page once, not twice',
    [...CARD_IDS, ...PANEL_IDS].every(id => s.counts[id] === 1), JSON.stringify(s.counts));
  // A render inside the tab re-emits every card while the old ones are in the
  // side panel, and builds a new map with new controls — the moment a duplicate
  // would be born, and the moment a pane could flicker shut or lose its place.
  await page.click('#help-panel .dock-tab[data-dock="map-display"]');
  await page.waitForTimeout(300);
  // Scrolled part-way down, the way somebody working in it leaves it.
  await page.mouse.move(1200, 500);
  await page.mouse.wheel(0, 180);
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => {
    const pane = document.getElementById('dock-pane-map-display');
    const tab = document.querySelector('#help-panel .dock-tab[data-dock="map-display"]');
    pane.__probe = 'pane'; tab.__probe = 'tab'; state.map.__probe = 'old';
    tab.focus();
    return { scroll: pane.scrollTop, room: pane.scrollHeight - pane.clientHeight };
  });
  // The pane is watched while the render runs: if it were ever shut, emptied of
  // its map and left that way, or swapped for another element, a frame would
  // show it — and a MutationObserver sees every change a frame could paint.
  await page.evaluate(() => {
    window.__paneSeen = [];
    const pane = document.getElementById('dock-pane-map-display');
    window.__paneObs = new MutationObserver(() => window.__paneSeen.push(pane.hidden ? 'hidden' : 'shown'));
    window.__paneObs.observe(pane, { attributes: true, attributeFilter: ['hidden'] });
    renderMain();
  });
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => {
    window.__paneObs.disconnect();
    const pane = document.getElementById('dock-pane-map-display');
    const tab = document.querySelector('#help-panel .dock-tab[data-dock="map-display"]');
    return {
      rebuilt: state.map.__probe !== 'old',
      samePane: !!pane && pane.__probe === 'pane', sameTab: !!tab && tab.__probe === 'tab',
      focus: document.activeElement === tab, showing: dockShowing(), seen: window.__paneSeen,
      scroll: pane.scrollTop,
    };
  });
  s = await look();
  check('a render inside the tab builds a new map and leaves one of every id, in the side panel',
    after.rebuilt && s.cardsIn === 'dock' && [...CARD_IDS, ...PANEL_IDS].every(id => s.counts[id] === 1),
    JSON.stringify(s.counts));
  check('…into the same pane and the same strip button, still showing, never shut on the way',
    after.samePane && after.sameTab && after.showing === 'map-display' && !after.seen.includes('hidden'),
    JSON.stringify(after));
  check('…with focus still on that strip button', after.focus, JSON.stringify(after));
  check('…and the pane scrolled where it was', before.scroll > 100 && Math.abs(after.scroll - before.scroll) <= 2,
    JSON.stringify({ before, after }));
  // The find term, typed, through the same rebuild.
  await page.fill('#map-display-find', 'contour');
  await page.waitForTimeout(300);
  await page.evaluate(() => renderMain());
  await page.waitForTimeout(500);
  const found = await page.evaluate(() => ({
    find: document.getElementById('map-display-find').value,
    rows: [...document.getElementById('map-display-block').children]
      .filter(el => el.getClientRects().length && el.id !== 'map-display-find-row').length,
  }));
  check('…and the Map display find term still in its box, still filtering the rows just built',
    found.find === 'contour' && found.rows > 0 && found.rows < 12, JSON.stringify(found));
  await page.fill('#map-display-find', '');
  // Focus on one of the map's own buttons across the same rebuild: a new
  // element, focused in place of the old one.
  await page.focus('#help-panel .dock-strip .mn-map-reset');
  await page.evaluate(() => { document.querySelector('.mn-map-reset').__probe = 'old'; renderMain(); });
  await page.waitForTimeout(500);
  const resetFocus = await page.evaluate(() => {
    const a = document.activeElement;
    return { cls: a && a.className, fresh: !!a && a.__probe !== 'old', inStrip: !!(a && a.closest('#help-panel .dock-strip')) };
  });
  check('…and focus on one of the map\'s own buttons lands on the new one',
    /mn-map-reset/.test(resetFocus.cls || '') && resetFocus.fresh && resetFocus.inStrip, JSON.stringify(resetFocus));
  // The pane last open is the pane that opens when the tab comes back.
  await page.click('#help-panel .dock-tab[data-dock="map-draw"]');
  await page.waitForTimeout(250);
  await page.evaluate(() => switchTab('passranges'));
  await page.waitForTimeout(300);
  await toStations();
  s = await look();
  check('leaving the tab and coming back opens the pane that was showing, Draw & measure',
    s.showing === 'map-draw' && (await wrapAt('draw')).shown, JSON.stringify(s));
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

  // ── 6. Full screen ───────────────────────────────────────────────────────
  const fullLook = () => page.evaluate(() => {
    const fp = document.querySelector('.map-panel.is-full');
    const side = document.getElementById('help-panel');
    const strip = side.querySelector('.dock-strip');
    const map = document.getElementById('leaflet-map');
    const r = el => el.getBoundingClientRect();
    const hit = (x, y) => { const t = document.elementFromPoint(x, y); return t ? (t.closest('#help-panel') ? 'side' : t.closest('.map-panel') ? 'map' : t.closest('header, .app-header, #tab-nav') ? 'shell' : (t.id || t.className || t.tagName)) : null; };
    return {
      full: !!fp, pressed: document.querySelector('.mn-map-full')?.getAttribute('aria-pressed'),
      mapRight: fp ? Math.round(r(fp).right) : null, sideLeft: Math.round(r(side).left),
      sideTop: Math.round(r(side).top), sideH: Math.round(r(side).height), stripH: Math.round(r(strip).height),
      winH: innerHeight, winW: innerWidth, sideRight: Math.round(r(side).right),
      showing: dockShowing(), fixed: getComputedStyle(side).position,
      leafletW: state.map.getSize().x, mapClientW: map.clientWidth,
      topRight: hit(innerWidth - 20, 12), topLeft: hit(40, 12), midSide: hit(Math.round(r(side).left + 40), innerHeight / 2),
    };
  });
  await page.click('#help-panel .dock-strip .mn-map-full');
  await page.waitForTimeout(400);
  let f = await fullLook();
  check('⛶ in the strip makes the map full screen and says so',
    f.full && f.pressed === 'true', JSON.stringify(f));
  check('…filling the window except the side panel, whose edge the map meets exactly',
    Math.abs(f.mapRight - f.sideLeft) <= 1 && f.sideRight === f.winW && f.fixed === 'fixed', JSON.stringify(f));
  check('…the side panel on screen the whole window tall, above the header, the cards still showing',
    f.sideTop === 0 && f.sideH === f.winH && f.stripH === f.winH && f.showing === 'stations'
      && f.topRight === 'side' && f.topLeft === 'map' && f.midSide === 'side', JSON.stringify(f));
  check('…and the map re-measured to its new size', f.leafletW === f.mapClientW, JSON.stringify(f));
  // The walls place every Tab themselves, so they have to stop wherever the
  // browser would — a <summary> included, or no card beside a full-screen map
  // could be opened or shut from the keyboard. From the filter box, the next
  // disclosure down is the Stations list's own summary.
  await page.focus('#station-search-quick');
  let sumAt = null;
  for (let i = 0; i < 40 && !sumAt; i++) {
    await page.keyboard.press('Tab');
    sumAt = await page.evaluate(() => {
      const a = document.activeElement;
      return a && a.tagName === 'SUMMARY' ? (a.closest('.panel') || {}).id || 'summary' : null;
    });
  }
  check('in full screen Tab stops on a card\'s <summary> — the Stations list\'s, after the filter box',
    sumAt === 'stations-list-card', String(sumAt));
  // The side panel works in full screen: a pane changes, the panel shuts and
  // opens, the handle moves — and the map's edge follows each, re-measured.
  await page.click('#help-panel .dock-tab[data-dock="map-display"]');
  await page.waitForTimeout(250);
  const fd = await wrapAt('display');
  f = await fullLook();
  check('in full screen a map pane opens from the strip, beside the map',
    f.full && f.showing === 'map-display' && fd.shown && Math.abs(f.mapRight - f.sideLeft) <= 1, JSON.stringify({ f, fd }));
  await page.click('#help-panel .dock-tab[data-dock="map-display"]');
  await page.waitForTimeout(250);
  f = await fullLook();
  check('…shutting the side panel gives the map the width at once, re-measured',
    f.full && f.showing === null && Math.abs(f.mapRight - f.sideLeft) <= 1 && f.winW - f.sideLeft <= 60
      && f.leafletW === f.mapClientW, JSON.stringify(f));
  await page.click('#help-panel .dock-tab[data-dock="stations"]');
  await page.waitForTimeout(250);
  const fw0 = (await fullLook()).mapRight;
  await page.focus('#help-panel .dock-resize');
  await page.keyboard.press('PageUp');
  await page.waitForTimeout(200);
  f = await fullLook();
  check('…and the handle widens the side panel over the map, which follows it, re-measured',
    f.mapRight <= fw0 - 90 && Math.abs(f.mapRight - f.sideLeft) <= 1 && f.leafletW === f.mapClientW,
    JSON.stringify({ fw0, f }));
  await page.keyboard.press('PageDown');
  // Tab stays inside the map and the side panel, in both directions, and
  // crosses between them at both seams: off the map's last stop into the side
  // panel's first (not onto the cards the map is covering, which is where the
  // browser's own next stop was), and off the side panel's last round to the
  // map's first. Both are hundreds of stops long — the map's pins are
  // focusable, and the station list is in the side panel — so each seam is
  // walked from beside it rather than by going all the way round.
  const where = () => page.evaluate(() => {
    const a = document.activeElement;
    return !a || a === document.body ? 'body' : a.closest('#help-panel') ? 'side'
      : a.closest('.map-panel.is-full') ? 'map' : (a.id || a.className || a.tagName);
  });
  const isHandle = () => page.evaluate(() => !!document.activeElement?.classList.contains('dock-resize'));
  const walk = async (key, n) => { const out = []; for (let i = 0; i < n; i++) { await page.keyboard.press(key); out.push(await where()); } return out; };
  await page.focus('#help-panel .dock-resize');
  const intoMap = await walk('Shift+Tab', 1);
  await page.keyboard.press('Tab');
  const backToHandle = await isHandle();
  const mapTail = await walk('Shift+Tab', 6);
  await page.focus('#help-panel .dock-resize');
  const sideHead = await walk('Tab', 6);
  await page.focus('#leaflet-map');
  const round = await walk('Shift+Tab', 1);
  await page.keyboard.press('Tab');
  const wrapped = await page.evaluate(() => document.activeElement && document.activeElement.id);
  const sideTail = await walk('Shift+Tab', 7);
  check('in full screen Tab crosses from the map\'s last stop to the side panel\'s first and back, and nothing else',
    intoMap[0] === 'map' && backToHandle && mapTail.every(t => t === 'map') && sideHead.every(t => t === 'side'),
    JSON.stringify({ intoMap, backToHandle, mapTail, sideHead }));
  check('…and round from the side panel\'s last stop to the map\'s first, both ways',
    round[0] === 'side' && wrapped === 'leaflet-map' && sideTail.every(t => t === 'side'),
    JSON.stringify({ round, wrapped, sideTail }));
  // The seam that has teeth: with the cards under the map, the page's own next
  // stop after the map's last is the Filters card — under the full-screen map,
  // where nobody can see what has focus. The side panel is shut then (its
  // Stations pane has gone under the map), so its first stop is ❔, the handle
  // being hidden with the pane it sizes.
  await page.evaluate(() => toggleStationsSplit(false));
  await page.waitForTimeout(300);
  await page.focus('#help-panel .help-toggle');
  await page.keyboard.press('Shift+Tab');
  const offSide = await where();
  await page.keyboard.press('Tab');
  const underMap = await page.evaluate(() => ({ help: !!document.activeElement?.classList.contains('help-toggle'),
    cards: !!document.activeElement?.closest('#stations-cards'), shut: dockShowing() === null }));
  check('…with the cards under the map, Tab off the map goes to the side panel, not to a card under it',
    underMap.shut && offSide === 'map' && underMap.help && !underMap.cards, JSON.stringify({ offSide, underMap }));
  await page.evaluate(() => toggleStationsSplit(true));
  await page.waitForTimeout(300);
  // …and a dialog opened over the full-screen map keeps its own walls: a Tab
  // between two of its controls stays in it, rather than being placed on the
  // map behind it.
  await page.evaluate(() => Modal.open({ title: 'Probe', html: '<button id="probe-a">A</button> <button id="probe-b">B</button> <button id="probe-c">C</button>' }));
  await page.focus('#probe-a');
  await page.keyboard.press('Tab');
  const inModal = await page.evaluate(() => document.activeElement && document.activeElement.id);
  await page.evaluate(() => Modal.close());
  check('…while a dialog over it keeps Tab inside itself', inModal === 'probe-b', String(inModal));
  await page.focus('#help-panel .dock-tab[data-dock="stations"]');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  f = await fullLook();
  s = await look();
  check('Escape from the side panel ends full screen, and the page is back as it was',
    !f.full && f.pressed === 'false' && f.fixed !== 'fixed' && s.showing === 'stations' && s.leafletW === s.mapClientW,
    JSON.stringify({ f, s }));
  // Leaving the tab ends it too: the help's "See also" is on screen beside a
  // full-screen map now, and it switches tabs.
  await page.evaluate(() => toggleMapFullscreen(true));
  await page.evaluate(() => switchTab('passranges'));
  await page.waitForTimeout(250);
  const other = await page.evaluate(() => ({ flag: state.mapFullscreen, fixed: getComputedStyle(document.getElementById('help-panel')).position }));
  await toStations();
  check('leaving the tab in full screen ends it, and coming back does not bring it back',
    other.flag === false && other.fixed !== 'fixed' && !(await fullLook()).full, JSON.stringify(other));

  // ── 6b. the keyboard, and a card that closes ─────────────────────────────
  // The strip is drawn on the panel's outer edge but written before the panes,
  // so Tab from a button that has just opened its pane goes into that pane —
  // past the rest of the strip, the map's controls included. Written after
  // them (as it first was), Tab left the panel for <body> and the skip link,
  // and the pane could only be reached backwards.
  await page.evaluate(() => setDockTab('stations', { instant: true }));
  await page.focus('#help-panel .help-toggle');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const tabbedHelp = [];
  for (let i = 0; i < STRIP.length + 4; i++) {
    await page.keyboard.press('Tab');
    const at = await page.evaluate(() => {
      const a = document.activeElement;
      return { tag: a ? a.tagName : '', inHelp: !!(a && a.closest('#dock-pane-help')),
               inStrip: !!(a && a.closest('#help-panel .dock-strip')) };
    });
    tabbedHelp.push(at);
    if (!at.inStrip) break;
  }
  const landed = tabbedHelp[tabbedHelp.length - 1];
  check('Tab from ❔, once it has opened Help, walks the strip and then into the help it opened',
    landed.inHelp && tabbedHelp.slice(0, -1).every(t => t.inStrip), JSON.stringify(tabbedHelp));

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

  // A line drawn from the ✏️ pane is drawn to see the ground under it, and the
  // card that shows that is in the Stations pane — which the ✏️ pane hides.
  // Finishing the line brings the card up, and focus, which was on Finish
  // line in the pane that just went, goes with it rather than to <body>.
  await page.click('#help-panel .dock-tab[data-dock="map-draw"]');
  await page.waitForTimeout(250);
  await page.locator('#map-draw-panel .draw-tool', { hasText: 'Line' }).click();
  const mb = await page.evaluate(() => { const r = document.getElementById('leaflet-map').getBoundingClientRect();
    return { x: r.left + r.width * 0.35, y: r.top + r.height * 0.5, w: r.width }; });
  await page.mouse.click(mb.x, mb.y);
  await page.waitForTimeout(150);
  await page.mouse.click(mb.x + mb.w * 0.2, mb.y + 40);
  await page.waitForTimeout(150);
  await page.click('#draw-finish');
  await page.waitForTimeout(400);
  const drew = await page.evaluate(() => {
    const el = document.getElementById('path-profile-panel');
    const a = document.activeElement;
    return { showing: dockShowing(), visible: !!el && el.checkVisibility(), lines: state.draw.shapes.filter(x => x.kind === 'line').length,
             focus: a ? a.tagName : null, focusSeen: !!(a && a !== document.body && a.getClientRects().length) };
  });
  check('finishing a line from the ✏️ pane brings its elevation profile up, with focus on something that is on screen',
    drew.lines === 1 && drew.showing === 'stations' && drew.visible && drew.focusSeen, JSON.stringify(drew));
  await page.evaluate(() => { MapDraw.setTool(''); state.draw.shapes = []; state.draw.selectedId = null; MapDraw.render(); MapDraw.rerenderPanel(); });
  await page.waitForTimeout(200);

  // ── 7. ◫, the fold, a phone ──────────────────────────────────────────────
  await page.evaluate(() => { state.map.__probe = 'same'; });
  await page.click('#help-panel .dock-strip .mn-map-split');
  await page.waitForTimeout(500);
  s = await look();
  check('◫ in the strip puts the cards under the map and takes the Stations button away',
    s.cardsIn === 'main' && !s.strip.includes('stations') && s.strip.includes('mn-map-split'), JSON.stringify(s));
  await page.click('#help-panel .dock-strip .mn-map-split');
  await page.waitForTimeout(500);
  s = await look();
  check('◫ again puts them back in the side panel, open on them, with the same Leaflet map',
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
  check('at 1000 px the cards fold under the map, and the strip keeps Help and every map control',
    s.cardsIn === 'main' && JSON.stringify(s.strip) === JSON.stringify(STRIP.filter(k => k !== 'stations'))
      && (await wrapAt('display')).where === 'dock', JSON.stringify(s));
  check('…without forgetting where the cards were wanted', s.pref === 'stations'
    && await page.evaluate(() => state.mapSplit === true), JSON.stringify(s));
  check('…and still nothing in the map\'s corner', (await cornerNow()).drawn.length === 0);

  // Crossing a phone's width with focus on a pane's strip button: it goes to
  // that panel's icon in the map's corner, which is what that button becomes.
  // The nav is put to its rail first — an expanded nav is a drawer over the
  // page on a phone, and the corner would be under it.
  await page.evaluate(() => setNavCollapsed(true));
  await page.waitForTimeout(300);
  await page.focus('#help-panel .dock-tab[data-dock="map-draw"]');
  await page.setViewportSize({ width: 375, height: 700 });
  await page.waitForTimeout(600);
  const toPhone = await page.evaluate(() => {
    const a = document.activeElement;
    return { icon: !!(a && a.classList.contains('mn-mapctl-btn') && a.closest('.mn-mapctl')?.dataset.panel === 'draw'),
             corner: !!(a && a.closest('.leaflet-control-container')), cls: a && a.className };
  });
  check('crossing to a phone with focus on ✏️ in the strip puts focus on ✏️ in the map\'s corner',
    toPhone.icon && toPhone.corner, JSON.stringify(toPhone));
  const phone = await page.evaluate((cls) => {
    const panel = document.getElementById('help-panel');
    const tab = panel.querySelector('.help-toggle');
    const r = tab.getBoundingClientRect();
    return {
      panelW: Math.round(panel.getBoundingClientRect().width),
      tabShown: r.width > 0 && r.height > 0 && getComputedStyle(tab.closest('.dock-strip')).position === 'fixed',
      tabAtEdge: Math.round(r.right) >= innerWidth - 1,
      strip: [...panel.querySelectorAll('.dock-strip button')].map(b => b.dataset.dock || b.className),
      cards: !!document.querySelector('#main-content #stations-cards'),
      panels: [...document.querySelectorAll('.mn-mapctl')].map(w => (w.closest('.leaflet-control-container') ? 'corner' : 'elsewhere')),
      buttons: cls.map(c => !!document.querySelector('.' + c)?.closest('.leaflet-control-container')),
      sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  }, BUTTONS);
  check('at 375 px there is no side-panel column, only the help tab on the screen edge',
    phone.panelW === 0 && phone.tabShown && phone.tabAtEdge && JSON.stringify(phone.strip) === '["help"]',
    JSON.stringify(phone));
  check('…the cards are under the map, and every one of the map\'s controls is back in its corner',
    phone.cards && phone.panels.length === 6 && phone.panels.every(p => p === 'corner') && phone.buttons.every(Boolean)
      && !phone.sideways, JSON.stringify(phone));
  // …where they are flyouts again, with pins that mean what they always did.
  // By the keyboard, which is the path a disclosure has to have; `mapctl`
  // drives the same flyouts with a real pointer.
  await page.mouse.move(10, 690);
  await page.focus('.leaflet-control-container .mn-mapctl[data-panel="legend"] .mn-mapctl-btn');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  const flyout = await wrapAt('legend');
  check('…where Enter on a panel\'s icon opens it as a flyout, its 📌 on screen',
    flyout.where === 'corner' && flyout.shown && flyout.pin && !flyout.pinned, JSON.stringify(flyout));
  await page.keyboard.press('Tab');
  const onPin = await page.evaluate(() => document.activeElement?.classList.contains('mn-mapctl-pin'));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.mouse.click(60, 650);
  await page.waitForTimeout(250);
  const pinnedPhone = await wrapAt('legend');
  check('…and its pin docks it open in the corner, still there after a click elsewhere',
    onPin && pinnedPhone.where === 'corner' && pinnedPhone.pinned && pinnedPhone.shown, JSON.stringify({ onPin, pinnedPhone }));
  await page.evaluate(() => MapChrome.setPinned('legend', false));
  await page.waitForTimeout(150);
  // …and back, the other way: the corner icon becomes the strip button.
  await page.focus('.leaflet-control-container .mn-mapctl[data-panel="draw"] .mn-mapctl-btn');
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.waitForTimeout(600);
  const toDesk = await page.evaluate(() => ({ dock: document.activeElement?.dataset?.dock || document.activeElement?.className }));
  s = await look();
  check('crossing back with focus on ✏️ in the corner puts focus on ✏️ in the strip, the strip whole again',
    toDesk.dock === 'map-draw' && JSON.stringify(s.strip) === JSON.stringify(STRIP.filter(k => k !== 'stations'))
      && (await cornerNow()).drawn.length === 0, JSON.stringify({ toDesk, strip: s.strip }));
  // Somebody typing in a pane as the window narrows: the field keeps focus,
  // in a flyout that stays open round it, and back in a pane that is showing.
  await page.click('#help-panel .dock-tab[data-dock="map-display"]');
  await page.waitForTimeout(250);
  await page.focus('#map-display-find');
  await page.keyboard.type('wind');
  await page.setViewportSize({ width: 375, height: 700 });
  await page.waitForTimeout(600);
  const typing = await page.evaluate(() => ({
    focus: document.activeElement?.id, value: document.getElementById('map-display-find').value,
    corner: !!document.activeElement?.closest('.leaflet-control-container'),
  }));
  const typingWrap = await wrapAt('display');
  check('crossing to a phone while typing in Map display keeps the caret in the box, in an open flyout',
    typing.focus === 'map-display-find' && typing.value === 'wind' && typing.corner && typingWrap.shown,
    JSON.stringify({ typing, typingWrap }));
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.waitForTimeout(600);
  const typingBack = await page.evaluate(() => ({ focus: document.activeElement?.id, showing: dockShowing(),
    inSide: !!document.activeElement?.closest('#help-panel') }));
  check('…and crossing back keeps it there, in the pane, which is showing',
    typingBack.focus === 'map-display-find' && typingBack.inSide && typingBack.showing === 'map-display',
    JSON.stringify(typingBack));
  await page.fill('#map-display-find', '');
  // A pane somebody typed in and then left — focus back on the map — goes to
  // a phone's corner shut, like every other panel nobody is in. The focusin
  // promotion used to mark it open while it was a pane, and it came back as a
  // flyout over the map that nobody had asked for.
  await page.focus('#map-display-find');
  await page.keyboard.type('x');
  await page.fill('#map-display-find', '');
  await page.evaluate(() => document.getElementById('leaflet-map').focus());
  await page.setViewportSize({ width: 375, height: 700 });
  await page.waitForTimeout(600);
  const leftShut = await wrapAt('display');
  check('a pane that was typed in, then left, comes back to a phone\'s corner shut',
    leftShut.where === 'corner' && !leftShut.shown && !leftShut.pinned, JSON.stringify(leftShut));
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.waitForTimeout(600);
  // One of the map's own buttons: the same element, wherever it stands.
  await page.focus('#help-panel .dock-strip .mn-map-reset');
  await page.setViewportSize({ width: 375, height: 700 });
  await page.waitForTimeout(600);
  const btnPhone = await page.evaluate(() => ({ reset: !!document.activeElement?.classList.contains('mn-map-reset'),
    corner: !!document.activeElement?.closest('.leaflet-control-container') }));
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.waitForTimeout(600);
  const btnDesk = await page.evaluate(() => ({ reset: !!document.activeElement?.classList.contains('mn-map-reset'),
    strip: !!document.activeElement?.closest('#help-panel .dock-strip') }));
  check('focus on ↺ goes with it to the corner and back to the strip',
    btnPhone.reset && btnPhone.corner && btnDesk.reset && btnDesk.strip, JSON.stringify({ btnPhone, btnDesk }));

  await page.setViewportSize({ width: 375, height: 700 });
  await page.waitForTimeout(600);
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
  // Full screen on a phone is what it was: the map over everything, its tools
  // on it, the side panel's edge tab under it.
  await page.evaluate(() => toggleMapFullscreen(true));
  await page.waitForTimeout(300);
  const phoneFull = await page.evaluate(() => {
    const fp = document.querySelector('.map-panel.is-full').getBoundingClientRect();
    const tab = document.querySelector('#help-panel .help-toggle').getBoundingClientRect();
    const t = document.elementFromPoint(tab.left + tab.width / 2, tab.top + tab.height / 2);
    return { w: Math.round(fp.width), winW: innerWidth, tabCovered: !!(t && !t.closest('#help-panel')),
             full: !!document.querySelector('.leaflet-control-container .mn-map-full') };
  });
  check('full screen on a phone covers the whole window, the edge tab included, with ⛶ on the map',
    phoneFull.w === phoneFull.winW && phoneFull.tabCovered && phoneFull.full, JSON.stringify(phoneFull));
  await page.evaluate(() => toggleMapFullscreen(false));
  await page.waitForTimeout(200);

  // ── 8. No sideways scroll with the side panel open ───────────────────────
  for (const [width, how] of [[375, 'help'], [768, 'help'], [768, 'map-display'], [1440, 'stations'], [1440, 'map-display']]) {
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
  check('no pageerror', errors.length === 0, errors.join(' | '));
  await context.close();
} finally {
  await browser.close();
}

// ── 8b. A strip taller than the window ─────────────────────────────────────
// Fifteen of the map's controls and the side panel's two are ~700 px of strip,
// and a laptop's window below the banner is less than that. In a browser that
// draws real scrollbars (Playwright's headless default hides them, which would
// make "the bar does not cover the buttons" true of any layout at all): the
// strip scrolls, every button in it can be reached and is the thing under the
// pointer where it is drawn, and the bar stands beside them.
const classic = await launchBrowser({ ignoreDefaultArgs: ['--hide-scrollbars'] });
try {
  const context = await classic.newContext({ viewport: { width: 1440, height: 550 } });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 1000, null, { timeout: 30_000 });
  await page.waitForTimeout(500);
  const tall = await page.evaluate(() => {
    const strip = document.querySelector('#help-panel .dock-strip');
    const sr = strip.getBoundingClientRect();
    const inner = sr.left + strip.clientLeft + strip.clientWidth;
    const out = [];
    for (const b of [...strip.querySelectorAll('button')].filter(x => x.getClientRects().length)) {
      b.scrollIntoView({ block: 'nearest' });
      const r = b.getBoundingClientRect();
      const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      out.push({ k: b.dataset.dock || b.className, hit: !!(t && (t === b || b.contains(t))),
                 clear: r.right <= inner + 0.5 && r.left >= sr.left - 0.5, inView: r.top >= sr.top - 0.5 && r.bottom <= sr.bottom + 0.5 });
    }
    return { scrolls: strip.scrollHeight > strip.clientHeight + 20, bar: strip.offsetWidth - strip.clientWidth,
             sideways: strip.scrollWidth > strip.clientWidth + 1, out };
  });
  check('at 1440 × 550 the strip is taller than the window and scrolls, with a real scrollbar',
    tall.scrolls && tall.bar > 0, JSON.stringify({ scrolls: tall.scrolls, bar: tall.bar }));
  check('…every button in it can be scrolled to and is the thing under the pointer there',
    tall.out.length === STRIP.length - 2 && tall.out.every(o => o.hit && o.inView), JSON.stringify(tall.out));
  check('…and the scrollbar stands beside the buttons, not over them, with nothing scrolling sideways',
    tall.out.every(o => o.clear) && !tall.sideways, JSON.stringify({ bar: tall.bar, out: tall.out.filter(o => !o.clear) }));
  // And from the keyboard, End scrolls the strip to its last button.
  await page.focus('#help-panel .help-toggle');
  await page.keyboard.press('End');
  const end = await page.evaluate(() => {
    const strip = document.querySelector('#help-panel .dock-strip');
    const a = document.activeElement, r = a.getBoundingClientRect(), sr = strip.getBoundingClientRect();
    return { reset: a.classList.contains('mn-map-reset'), inView: r.bottom <= sr.bottom + 0.5 && r.top >= sr.top - 0.5 };
  });
  check('…and End reaches the last of them and scrolls it into view', end.reset && end.inView, JSON.stringify(end));
  check('no pageerror with real scrollbars', errors.length === 0, errors.join(' | '));
} finally {
  await classic.close();
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
console.log('PASS — one side panel: the cards, the help and every one of the map\'s controls, tabbed,');
console.log('       resizable, beside the map in full screen, and nothing left behind or in the corner.');
