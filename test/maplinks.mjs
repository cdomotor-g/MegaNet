// What the Stations map's links say, and where its furniture sits (#186).
//
// Nine changes landed together and every one of them is invisible to the checks
// that already exist. `smoke` opens the tab and asserts a clean console, which
// a map whose links are all one colour, whose arrows never draw, whose credit
// line covers the move-pin panel's Save button, whose Clear buttons leave the
// map three-quarters faded and whose Map display search hides nothing at all
// passes without a murmur. So:
//
//   1. **The credit line is under the map, not on it.** Leaflet floats its
//      attribution over the bottom-right corner and this app's is two
//      full-width lines long, so it was sitting on the move-pin panel's
//      buttons. The assertion is geometric — the panel's box and the credit
//      strip's box must not intersect — because "it looks fine" is what the
//      old layout also reported at every width but the one it was broken at.
//   2. **And moving it must not move the cards.** Every on-map card is
//      positioned against a box that used to be `.map-panel` and is now
//      `.mn-map-stage`; get that wrong and the station card is anchored below
//      the map instead of inside it. `stn-card.mjs` caught this once already
//      (`341×209 on a 338×347 map`); this holds the containing block itself.
//   3. **Link colour is one radio group.** Frequency by default, and the
//      colour a link is painted has to be the one the frequency table says for
//      the repeater on its end — asserted against `MapFreq.rows()` rather than
//      against a literal, so a re-ordered palette is still checked and a
//      *wrong* pairing is not.
//   4. **A backbone path is black dashes over that colour.** Three lines per
//      path — casing, coloured core, black dash — and the dash carries a
//      `dashArray` while the core does not.
//   5. **Arrows point the way the traffic runs.** The direction is data, not
//      decoration: a field link points at its repeater, a repeater-to-base
//      path at the base, and a repeater-to-repeater path is two-way. Also
//      asserted: the canvas exists, is in a pane above the links, and takes no
//      pointer.
//   6. **Clear filters clears the repeater focus.** The reported bug is a map
//      dimmed by a focus, no filter running, and *both* Clear buttons greyed
//      out — so the enable rule is asserted as well as the clear.
//   7. **The place strip belongs to the box the caret is in.** Shown on focus,
//      gone on blur, and back on refocus *with the same results* — the last
//      clause is what separates a paint rule from a `clear()`.
//   8. **Find a control filters the Map display panel.** Measured by
//      `getClientRects()`, never by `el.hidden`. The first implementation set
//      `hidden` and looked perfect in a property dump and wrong on screen —
//      half these rows are labels the stylesheet gives `display: flex`, and an
//      author rule beats the browser's own `[hidden] { display: none }` at the
//      same specificity. **A check reading the property would have agreed with
//      the bug**, which is the reason this file says so out loud.
//   9. **Side by side is the map and the cards beside it, in the side panel,
//      with a handle that moves.** Rewritten for the side panel (the dock): the
//      cards were a column inside <main> with a divider of their own, and are a
//      pane of #help-panel now, sized by its width handle. Asserted by the
//      map's own width against the container's, before and after the handle is
//      moved from the keyboard, by where the cards wrapper is, by the fold at
//      `lg`, and by the map object surviving the toggle — the whole reason it
//      is a move rather than a re-render.
//
// Everything runs against the bundled `stations.json` on loopback with the
// network policy in force: none of it needs a tile, a terrain fetch or the
// datastore.
//
// Run:  npm run maplinks
//       npm run maplinks -- -v    also print what passed

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

// Miles / Chinchilla, where the reported screenshots were taken: a dense
// enough patch that both kinds of backbone path and a fan of field links are
// on screen at one zoom.
const VIEW = { lat: -26.66, lon: 150.19, zoom: 10 };
// map-arrows.js's own MIN_ZOOM. Written here rather than read off the module,
// because "the arrows start somewhere" is not the claim — the claim is that
// they start at a zoom where direction is a question somebody is asking, and a
// check that read the constant would agree with any answer.
const MIN_ARROW_ZOOM = 10;

const server = await startServer();
const browser = await launchBrowser();
const errors = [];

try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await page.waitForFunction(
    () => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(
    () => !!state.map && state.mapMarkers.length > 1000, null, { timeout: 30_000 });
  await page.evaluate((v) => state.map.setView([v.lat, v.lon], v.zoom, { animate: false }), VIEW);
  await page.waitForTimeout(600);

  // ── 1. The credit line is under the map ──────────────────────────────────
  const attrib = await page.evaluate(() => {
    const strip = document.querySelector('.mn-map-attrib');
    const mapEl = document.getElementById('leaflet-map');
    if (!strip || !mapEl) return null;
    const s = strip.getBoundingClientRect(), m = mapEl.getBoundingClientRect();
    return {
      insideMap: mapEl.contains(strip),
      insideStage: !!strip.closest('.mn-map-stage'),
      below: s.top >= m.bottom - 1,
      text: strip.textContent.replace(/\s+/g, ' ').trim(),
    };
  });
  check('the credit line exists and is out of the map container',
    !!attrib && !attrib.insideMap, JSON.stringify(attrib));
  check('…and out of the box the on-map cards are positioned against',
    !!attrib && !attrib.insideStage, JSON.stringify(attrib));
  check('…sitting below the map rather than over it',
    !!attrib && attrib.below, JSON.stringify(attrib));
  check('…still carrying what the layers on the map credit',
    !!attrib && /Leaflet/.test(attrib.text) && /OpenStreetMap/.test(attrib.text),
    (attrib || {}).text);

  // The move-pin panel, which is what found this: bottom left of the map, and
  // its two buttons were behind the credits.
  const pinStation = await page.evaluate(
    () => state.data.stations.find((s) => s.lat != null && s.lon != null).id);
  await page.evaluate((id) => MapMovePin.start(id), pinStation);
  await page.waitForTimeout(400);
  const overlap = await page.evaluate(() => {
    const panel = document.querySelector('.mn-movepin-panel');
    const strip = document.querySelector('.mn-map-attrib');
    if (!panel || !strip) return null;
    const a = panel.getBoundingClientRect(), b = strip.getBoundingClientRect();
    const save = panel.querySelector('.mn-movepin-actions .pill');
    const sr = save && save.getBoundingClientRect();
    return {
      hit: !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom),
      saveHit: !!sr && !(sr.right < b.left || sr.left > b.right || sr.bottom < b.top || sr.top > b.bottom),
      saveVisible: !!sr && sr.width > 0 && sr.height > 0,
    };
  });
  check('the move-pin panel and the credit line do not overlap',
    !!overlap && !overlap.hit && !overlap.saveHit, JSON.stringify(overlap));
  check('…and its Save button is on screen with a box of its own',
    !!overlap && overlap.saveVisible, JSON.stringify(overlap));
  await page.evaluate(() => MapMovePin.cancel());
  await page.waitForTimeout(200);

  // ── 2. The stage is what the cards are positioned against ────────────────
  const stage = await page.evaluate(() => {
    const card = document.getElementById('stn-card');
    const st = document.querySelector('.mn-map-stage');
    if (!card || !st) return null;
    return {
      cardInStage: st.contains(card),
      stagePositioned: getComputedStyle(st).position === 'relative',
      mapInStage: st.contains(document.getElementById('leaflet-map')),
    };
  });
  check('the map, the note and the cards share one positioned stage',
    !!stage && stage.cardInStage && stage.mapInStage && stage.stagePositioned,
    JSON.stringify(stage));

  // ── 3. Link colour: the frequency table decides ──────────────────────────
  const freq = await page.evaluate(() => {
    const rows = MapFreq.rows();
    const byMhz = new Map(rows.map((r) => [r.mhz, r.colour]));
    const wrong = [];
    let checked = 0;
    for (const l of state.mapLines) {
      if (l.mnLinkRole !== 'core') continue;
      const mhz = l.mnFreqMhz;
      if (mhz == null) continue;
      checked++;
      if (l.options.color !== byMhz.get(mhz)) wrong.push({ mhz, got: l.options.color });
    }
    return { mode: state.mapLinkColour, rows, checked, wrong: wrong.slice(0, 3) };
  });
  check('the map opens colouring links by frequency', freq.mode === 'freq', freq.mode);
  check('every channel in the file is in the table, in ascending order',
    freq.rows.length > 1 && freq.rows.every((r, i) => i === 0 || r.mhz > freq.rows[i - 1].mhz),
    JSON.stringify(freq.rows.map((r) => r.mhz)));
  check('and the colours on the map are the ones that table gives',
    freq.checked > 100 && freq.wrong.length === 0,
    `${freq.checked} link(s) checked; ${JSON.stringify(freq.wrong)}`);

  // The legend has to say the same thing, or the colours are unreadable.
  const legend = await page.evaluate(() => {
    MapChrome.setPinned('legend', true);
    return document.getElementById('map-legend').textContent.replace(/\s+/g, ' ');
  });
  check('the legend names every channel with how many repeaters are on it',
    (await page.evaluate(() => MapFreq.rows())).every((r) =>
      legend.includes(r.label) && legend.includes(`${r.count} repeater`)), legend.slice(0, 160));
  await page.evaluate(() => MapChrome.setPinned('legend', false));

  // Plain and fade are the same one setting, so picking either has to move
  // both `mapLinkColour` and the flag MapFade has always been asked about.
  await page.evaluate(() => setMapLinkColour('plain'));
  await page.waitForTimeout(300);
  const plain = await page.evaluate(() => ({
    mode: state.mapLinkColour,
    fade: state.mapFade,
    colour: (state.mapLines.find((l) => l.mnLinkRole === 'core') || {}).options.color,
    token: cssVar('--map-line', ''),
  }));
  check('Plain puts every link back on the one link colour',
    plain.mode === 'plain' && plain.fade === false && plain.colour === plain.token,
    JSON.stringify(plain));

  await page.evaluate(() => setMapLinkColour('fade'));
  await page.waitForTimeout(300);
  check('By fade margin is the same setting, and it moves state.mapFade with it',
    await page.evaluate(() => state.mapLinkColour === 'fade' && state.mapFade === true
                           && MapFreq.active() === false));
  check('…and the two are stored so the next visit opens the same way',
    await page.evaluate(() => localStorage.getItem('mn-map-link-colour') === 'fade'
                           && localStorage.getItem('mn-map-fade') === 'on'));
  await page.evaluate(() => setMapLinkColour('freq'));
  await page.waitForTimeout(400);

  // ── 4. Backbone: black dashes over the colour ────────────────────────────
  const backbone = await page.evaluate(() => {
    const roles = {};
    for (const l of state.mapLines) roles[l.mnLinkRole] = (roles[l.mnLinkRole] || 0) + 1;
    const core = state.mapLines.find((l) => l.mnLinkRole === 'backbone');
    const dash = state.mapLines.find((l) => l.mnLinkRole === 'backbone-dash');
    return {
      roles,
      coreColour: core && core.options.color,
      coreDash: core && core.options.dashArray,
      dashColour: dash && dash.options.color,
      dashArray: dash && dash.options.dashArray,
      backboneToken: cssVar('--map-backbone', ''),
      sameCount: roles.backbone === roles['backbone-dash']
              && roles.backbone === roles['backbone-casing'],
    };
  });
  check('a backbone path is three lines: casing, coloured core, black dash',
    backbone.sameCount && backbone.roles.backbone > 0, JSON.stringify(backbone.roles));
  check('the core carries the link colour and no dash pattern',
    backbone.coreColour !== backbone.backboneToken && !backbone.coreDash,
    JSON.stringify(backbone));
  check('and the overlay is the black one, dashed',
    backbone.dashColour === backbone.backboneToken && /^\d+\s*,\s*\d+$/.test(backbone.dashArray || ''),
    JSON.stringify(backbone));

  // ── 5. Arrows say which way the traffic runs ─────────────────────────────
  const arrows = await page.evaluate(() => {
    const canvas = document.querySelector('.mn-arrow-canvas');
    const pane = canvas && canvas.parentElement;
    const dirs = {};
    let casingWithArrow = 0, dashWithArrow = 0;
    for (const l of state.mapLines) {
      if (l.mnArrowDir) dirs[`${l.mnLinkRole}:${l.mnArrowDir}`] = (dirs[`${l.mnLinkRole}:${l.mnArrowDir}`] || 0) + 1;
      if (l.mnArrowDir && /casing/.test(l.mnLinkRole)) casingWithArrow++;
      if (l.mnArrowDir && l.mnLinkRole === 'backbone-dash') dashWithArrow++;
    }
    // A field link is drawn station end first, so 'fwd' is "at the repeater".
    const field = state.mapLines.find((l) => l.mnLinkRole === 'core');
    const ll = field && field.getLatLngs();
    const rpt = field && state.data.stations.find((s) => s.id === field.mnLinkRepeaterId);
    return {
      on: state.mapArrows,
      hasCanvas: !!canvas,
      paneZ: pane ? Number(getComputedStyle(pane).zIndex) : null,
      pointer: pane ? getComputedStyle(pane).pointerEvents : null,
      sized: !!canvas && canvas.width > 0 && canvas.height > 0,
      dirs,
      casingWithArrow,
      dashWithArrow,
      // The far end of the polyline is the repeater the arrow points at.
      pointsAtRepeater: !!(ll && rpt)
        && Math.abs(ll[1].lat - rpt.lat) < 1e-9 && Math.abs(ll[1].lng - rpt.lon) < 1e-9,
    };
  });
  check('the arrows are on by default, on a sized canvas of their own',
    arrows.on && arrows.hasCanvas && arrows.sized, JSON.stringify(arrows));
  check('…in a pane above the links (400) and below the markers (600)',
    arrows.paneZ > 400 && arrows.paneZ < 600, String(arrows.paneZ));
  check('…which never takes a pointer — an arrow is not a click target',
    arrows.pointer === 'none', String(arrows.pointer));
  check('one set of arrows per path: not on the casings, not on the dash overlay',
    arrows.casingWithArrow === 0 && arrows.dashWithArrow === 0, JSON.stringify(arrows));
  check('a field link points one way, at the repeater that carries it',
    arrows.dirs['core:fwd'] > 0 && arrows.pointsAtRepeater, JSON.stringify(arrows.dirs));
  check('a repeater-to-repeater backbone path is drawn two-way',
    arrows.dirs['backbone:both'] > 0, JSON.stringify(arrows.dirs));

  await page.evaluate(() => MapArrows.setEnabled(false));
  await page.waitForTimeout(300);
  check('turning them off is remembered and leaves the lines alone',
    await page.evaluate(() => state.mapArrows === false
                           && localStorage.getItem('mn-map-arrows') === 'off'
                           && state.mapLines.length > 0));
  await page.evaluate(() => MapArrows.setEnabled(true));
  await page.waitForTimeout(300);

  // ── 6. Clear filters clears the repeater focus ───────────────────────────
  const rptId = await page.evaluate(
    () => state.data.stations.find((s) => s.roles.includes('repeater') && s.lat != null).id);
  await page.evaluate((id) => setMapFocusRepeater(id), rptId);
  await page.waitForTimeout(300);
  const focused = await page.evaluate(() => ({
    dimmed: state.mapMarkers.filter((m) => m.mnFocusDimmed).length,
    lines: state.mapLines.filter((l) => l.mnFocusDimmed).length,
    // No filter is running — this is the reported state exactly.
    filtering: anyStationFilterActive(),
    enabled: [...document.querySelectorAll('#stations-filter-card .filter-reset')]
      .every((b) => !b.disabled),
  }));
  check('a repeater focus dims the rest of the map with no filter running',
    focused.dimmed > 1000 && focused.lines > 0 && focused.filtering === false,
    JSON.stringify(focused));
  check('…and that alone enables both Clear buttons', focused.enabled, JSON.stringify(focused));

  await page.evaluate(() => clearStationFilters(false));
  await page.waitForTimeout(500);
  const cleared = await page.evaluate(() => ({
    focus: state.mapFocusRepeaterId,
    blast: state.mapBlast,
    dimmed: state.mapMarkers.filter((m) => m.mnFocusDimmed).length,
    lines: state.mapLines.filter((l) => l.mnFocusDimmed).length,
  }));
  check('Clear filters puts every station and link back at full opacity',
    cleared.focus === null && cleared.blast === false
      && cleared.dimmed === 0 && cleared.lines === 0, JSON.stringify(cleared));

  // ── 7. The place strip follows the caret ─────────────────────────────────
  await page.click('#station-search-quick');
  await page.fill('#station-search-quick', '-26.66, 150.19');
  await page.waitForTimeout(500);
  const strip = () => page.evaluate(() => {
    const el = document.querySelector('[data-mn-places="0"]');
    return { len: el ? el.innerHTML.length : -1,
             coord: !!el && /150\.19/.test(el.textContent) };
  });
  const onFocus = await strip();
  await page.evaluate(() => document.getElementById('station-search-quick').blur());
  await page.waitForTimeout(400);
  const onBlur = await strip();
  await page.click('#station-search-quick');
  await page.waitForTimeout(250);
  const back = await strip();
  check('a coordinate typed into the filter box is offered under it',
    onFocus.len > 0 && onFocus.coord, JSON.stringify(onFocus));
  check('…and goes when focus leaves the box', onBlur.len === 0, JSON.stringify(onBlur));
  check('…and comes back on refocus, with the same answer and no new lookup',
    back.len === onFocus.len && back.coord, JSON.stringify(back));
  await page.evaluate(() => {
    const box = document.getElementById('station-search-quick');
    box.value = '';
    mapSearchInput(0, '');
    box.blur();
  });
  await page.waitForTimeout(400);

  // ── 8. Find a control, measured on screen ────────────────────────────────
  // getClientRects(), never el.hidden: see the header. A row with the
  // attribute set and `display: flex` still on it is a row that is on screen.
  await page.evaluate(() => MapChrome.setPinned('display', true));
  await page.waitForTimeout(300);
  const panel = () => page.evaluate(() => {
    const root = document.getElementById('map-display-block');
    const vis = (el) => !!el && el.getClientRects().length > 0;
    const rows = [...root.children]
      .filter((el) => vis(el) && el.id !== 'map-display-find-row');
    const acma = root.parentNode.querySelector('.filter-block');
    return {
      rows: rows.length,
      heads: rows.filter((r) => r.classList.contains('map-display-h')).map((r) => r.textContent.trim()),
      text: rows.map((r) => r.textContent.replace(/\s+/g, ' ').trim()).join(' | '),
      acma: vis(acma),
      none: vis(document.getElementById('map-display-find-none')),
    };
  });
  const whole = await panel();
  // Five since the base maps moved in from a panel of their own, at the top.
  check('the panel is five groups when nothing is typed, base maps first',
    whole.heads.join('|') === 'Base maps|Stations & links|Link colour|Overlay layers|Labels & export',
    whole.heads.join(' | '));

  await page.fill('#map-display-find', 'contour');
  await page.waitForTimeout(300);
  const narrowed = await panel();
  // Both halves, and the second is the one with teeth: a filter that hides the
  // headings and leaves every switch on screen passes "fewer rows than before"
  // and "the word is in there" without hiding anything anybody was looking at.
  // That is exactly the state the first implementation was in.
  check('a term narrows the panel to the rows that match it, on screen',
    narrowed.rows < whole.rows && narrowed.rows > 0 && /contour/i.test(narrowed.text),
    `${narrowed.rows} of ${whole.rows}: ${narrowed.text.slice(0, 120)}`);
  check('…and takes the rows that do not match off it',
    !/Hide stations that don't match/.test(narrowed.text)
      && !/Wind regions/.test(narrowed.text) && !/Arrows along the links/.test(narrowed.text),
    narrowed.text.slice(0, 160));
  check('…and drops the headings with nothing left under them',
    narrowed.heads.length === 1 && narrowed.heads[0] === 'Overlay layers',
    narrowed.heads.join(' | '));
  check('…and the ACMA block with them', narrowed.acma === false);

  // The base-map rows are rows like any other: one base's switch and slider
  // are one row, found by its name and nothing else of the section with it.
  await page.fill('#map-display-find', 'satellite');
  await page.waitForTimeout(300);
  const base = await panel();
  check('a base map is found by name, its switch and slider together',
    base.heads.join('|') === 'Base maps' && /Satellite/.test(base.text)
      && !/OSM-Topo/.test(base.text) && !/OpenStreetMap/.test(base.text),
    `${base.heads.join(' | ')}: ${base.text.slice(0, 160)}`);

  await page.fill('#map-display-find', 'licence');
  await page.waitForTimeout(300);
  const acmaOnly = await panel();
  check('a term that is only in the ACMA block leaves that block and nothing else',
    acmaOnly.acma === true && acmaOnly.rows === 0, JSON.stringify(acmaOnly));

  await page.fill('#map-display-find', 'qqzz');
  await page.waitForTimeout(300);
  const nothing = await panel();
  check('a term that matches nothing says so rather than showing an empty panel',
    nothing.rows === 1 && nothing.none === true, JSON.stringify(nothing));

  // The term has to survive the panel redrawing itself, which it does whenever
  // one of its own switches moves.
  await page.fill('#map-display-find', 'arrows');
  await page.waitForTimeout(200);
  await page.evaluate(() => rerenderMapDisplayControls());
  await page.waitForTimeout(300);
  const afterRerender = await panel();
  check('the term survives the panel redrawing itself',
    afterRerender.rows > 0 && /Arrows along the links/.test(afterRerender.text)
      && await page.evaluate(() => document.getElementById('map-display-find').value === 'arrows'),
    JSON.stringify(afterRerender));

  await page.fill('#map-display-find', '');
  await page.waitForTimeout(300);
  const restored = await panel();
  check('clearing the box gives the whole panel back',
    restored.rows === whole.rows && restored.acma === true, `${restored.rows} of ${whole.rows}`);
  await page.evaluate(() => MapChrome.setPinned('display', false));

  // ── 9. Side by side ──────────────────────────────────────────────────────
  // The default since the follow-up to #186 — the single column put the map's
  // own answer below the fold, so reading it cost the map. Since the side
  // panel took the right-hand column over, "side by side" is the map filling
  // the page and the station cards in the side panel's Stations pane, and the
  // old divider is the side panel's own width handle: this section was
  // rewritten for that, and asserts the same four things it always did — the
  // two layouts, the map object surviving the switch, a separator that moves,
  // and one scroll region rather than three — against the shape they have now.
  // The check drives it the other way round: it opens side by side, and the
  // assertion about the stacked shape is made by switching it off.
  const mapId = await page.evaluate(() => { state.map.__probe = 'same'; return true; });
  const opened = await page.evaluate(() => ({
    split: state.mapSplit,
    onClass: document.getElementById('stations-main').classList.contains('is-split'),
    showing: dockShowing(),
    cardsInDock: !!document.querySelector('#help-panel #dock-pane-stations > #stations-cards'),
    // One scroll region, not three: the pane scrolls, the page does not.
    docScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
  }));
  check('the tab opens side by side, the cards in the side panel beside the map',
    opened.split && opened.onClass && opened.showing === 'stations' && opened.cardsInDock,
    JSON.stringify(opened));
  check('…and the page itself does not scroll behind the pane that does',
    !opened.docScrolls, JSON.stringify(opened));

  await page.evaluate(() => toggleStationsSplit(false));
  await page.waitForTimeout(500);
  const before = await page.evaluate(() => {
    const main = document.getElementById('stations-main');
    return {
      split: main.classList.contains('is-split'),
      cardsUnder: !!main.querySelector(':scope > #stations-cards'),
      paneButton: !!document.querySelector('#help-panel .dock-tab[data-dock="stations"]'),
      showing: dockShowing(),
      mapW: Math.round(document.getElementById('leaflet-map').getBoundingClientRect().width),
      mainW: Math.round(main.getBoundingClientRect().width),
      handle: document.querySelector('#help-panel .dock-resize').getClientRects().length > 0,
      mapObj: !!state.map,
    };
  });
  check('switched off, the cards are under the map and the side panel has no Stations pane',
    !before.split && before.cardsUnder && !before.paneButton && before.showing === null,
    JSON.stringify(before));
  check('…and the map has the page to itself, with no handle on screen',
    !before.handle && before.mapW > before.mainW * 0.9, JSON.stringify(before));

  await page.evaluate(() => toggleStationsSplit(true));
  await page.waitForTimeout(600);
  const split = await page.evaluate(() => {
    const handle = document.querySelector('#help-panel .dock-resize');
    const pane = document.getElementById('dock-pane-stations');
    const map = document.getElementById('leaflet-map').getBoundingClientRect();
    const panel = document.getElementById('help-panel').getBoundingClientRect();
    return {
      mapW: Math.round(map.width),
      mapRight: Math.round(map.right),
      panelLeft: Math.round(panel.left),
      paneW: Math.round(pane.getBoundingClientRect().width),
      cardsInDock: !!pane.querySelector(':scope > #stations-cards'),
      handle: handle.getClientRects().length > 0,
      role: handle.getAttribute('role'),
      orient: handle.getAttribute('aria-orientation'),
      now: Number(handle.getAttribute('aria-valuenow')),
      width: dockWidth(),
      sameMap: state.map.__probe === 'same',
      paneScrolls: getComputedStyle(pane).overflowY,
    };
  });
  check('side by side puts the cards beside the map, not under it',
    split.mapW < before.mapW && split.paneW > 200 && split.cardsInDock
      && split.mapRight <= split.panelLeft, JSON.stringify(split));
  check('…with the same Leaflet map, never a rebuilt one',
    mapId && split.sameMap, JSON.stringify(split));
  check('…a real separator carrying its value', split.handle && split.role === 'separator'
    && split.orient === 'vertical' && split.now === split.width, JSON.stringify(split));
  check('…and a pane that scrolls on its own',
    /auto|scroll/.test(split.paneScrolls), split.paneScrolls);

  // **The map is only charged for the overflow it caused.**
  //
  // syncStationsSplitHeight measures the map's height, applies it, and then
  // corrects itself against whatever the document turns out to overflow by. The
  // first version subtracted the *whole* of that overflow, on the reasoning
  // that the only thing below the fold could be the column it had just sized.
  // Let anything else stick out down there and the map paid for it: the
  // reported case came back with a 306 px map — `.stn-split.is-split`'s own
  // min-height, hit from above — on a window with room for 929, and the page
  // shortened in the same gesture.
  //
  // Nothing about that state looks broken from inside the app. The cards are
  // still beside the map, `state.mapSplit` is still on, the class is still
  // there, and every number in the calculation is a real measurement of
  // something. So the assertion cannot be "the split has a height" or "the
  // class survived" — it has to be the height itself, against a page that is
  // deliberately made to overflow by something the split has no part in and
  // cannot shrink away. An absolutely positioned strip in the document does
  // that honestly: it is not in the map's column, it is not in a scroller, and
  // shrinking the map by a pixel does nothing for it.
  const beforeSpacer = await page.evaluate(() => ({
    splitH: document.getElementById('stations-main').style.getPropertyValue('--mn-split-h'),
    mapH: Math.round(document.getElementById('leaflet-map').getBoundingClientRect().height),
  }));
  const spaced = await page.evaluate(() => {
    const d = document.createElement('div');
    d.id = 'mn-overflow-probe';
    d.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:2400px;pointer-events:none';
    document.body.appendChild(d);
    updateChromeHeight();                      // what a resize or the memory strip does
    return {
      over: document.documentElement.scrollHeight - window.innerHeight,
      splitH: document.getElementById('stations-main').style.getPropertyValue('--mn-split-h'),
      mapH: Math.round(document.getElementById('leaflet-map').getBoundingClientRect().height),
      paneH: Math.round(document.getElementById('dock-pane-stations').getBoundingClientRect().height),
    };
  });
  check('a page that overflows for somebody else does not shrink the map',
    spaced.over > 1000 && spaced.mapH >= beforeSpacer.mapH - 8,
    `${beforeSpacer.mapH} → ${spaced.mapH} with ${spaced.over} px of overflow elsewhere`);
  check('…and the side panel\'s pane keeps its height with it',
    spaced.paneH > 600, `${spaced.paneH} px`);
  const unspaced = await page.evaluate(() => {
    document.getElementById('mn-overflow-probe').remove();
    updateChromeHeight();
    return {
      over: document.documentElement.scrollHeight - window.innerHeight,
      mapH: Math.round(document.getElementById('leaflet-map').getBoundingClientRect().height),
    };
  });
  check('…and taking it away leaves the height where it was',
    unspaced.over <= 1 && Math.abs(unspaced.mapH - beforeSpacer.mapH) <= 2,
    `${beforeSpacer.mapH} → ${unspaced.mapH}, over ${unspaced.over}`);

  // The handle, from the keyboard — the reason it is a focusable separator.
  // ArrowLeft widens the pane: the handle is on its left edge, and that is the
  // way the edge moves.
  await page.focus('#help-panel .dock-resize');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(400);
  const moved = await page.evaluate(() => ({
    width: dockWidth(),
    now: Number(document.querySelector('#help-panel .dock-resize').getAttribute('aria-valuenow')),
    mapW: Math.round(document.getElementById('leaflet-map').getBoundingClientRect().width),
    stored: Number(localStorage.getItem('mn-dock-w')),
  }));
  check('the arrow keys move the handle and the map narrows with it',
    moved.width > split.width && moved.mapW < split.mapW && moved.now === moved.width,
    JSON.stringify(moved));
  check('…and where it was left is remembered', moved.stored === moved.width, JSON.stringify(moved));

  // The fold at `lg`, with the setting left on — and this one is here because
  // the first version of the split's fold did not work: 381 px of map in a
  // 688 px column at 1000 px wide, which is the state the fold exists to
  // prevent. Below `lg` the cards go back under the map, the side panel loses
  // its Stations pane (and is shut, since that was the pane on screen), and
  // nothing about the *setting* may change — a laptop docked to a wide screen
  // has to find the cards beside its map again.
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.waitForTimeout(700);
  const folded = await page.evaluate(() => {
    const main = document.getElementById('stations-main');
    return {
      mapW: Math.round(document.getElementById('leaflet-map').getBoundingClientRect().width),
      mainW: Math.round(main.getBoundingClientRect().width),
      cardsUnder: !!main.querySelector(':scope > #stations-cards'),
      paneButton: !!document.querySelector('#help-panel .dock-tab[data-dock="stations"]'),
      handle: document.querySelector('#help-panel .dock-resize').getClientRects().length > 0,
      stillSet: state.mapSplit,
      preference: state.dockTab,
      splitH: main.style.getPropertyValue('--mn-split-h'),
      sideways: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  check('below the lg breakpoint the cards fold back under the map',
    folded.cardsUnder && !folded.paneButton && !folded.handle
      && folded.mapW > folded.mainW * 0.9 && !folded.sideways, JSON.stringify(folded));
  check('…without forgetting that side by side is on, or which pane was open',
    folded.stillSet === true && folded.preference === 'stations', JSON.stringify(folded));
  // And nothing is written down while it is folded. Below `lg` the page is one
  // long scroller on purpose, so a height measured against it is a
  // measurement of a layout that is not on screen — and it used to be stored
  // anyway, as the floor, because the correction above read that scroller as
  // the map being too tall.
  check('…and nothing is measured against the folded page',
    folded.splitH === '', `--mn-split-h: ${JSON.stringify(folded.splitH)}`);
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.waitForTimeout(700);
  const unfolded = await page.evaluate(() => ({
    showing: dockShowing(),
    cardsInDock: !!document.querySelector('#dock-pane-stations > #stations-cards'),
    sameMap: state.map.__probe === 'same',
  }));
  check('…and back above it the cards are beside the map again, on the same map',
    unfolded.showing === 'stations' && unfolded.cardsInDock && unfolded.sameMap,
    JSON.stringify(unfolded));

  await page.evaluate(() => toggleStationsSplit(false));
  await page.waitForTimeout(500);
  const stacked = await page.evaluate(() => ({
    mapW: Math.round(document.getElementById('leaflet-map').getBoundingClientRect().width),
    cardsUnder: !!document.querySelector('#stations-main > #stations-cards'),
    sameMap: state.map.__probe === 'same',
  }));
  check('and switching back stacks it again, still the same map',
    stacked.mapW >= before.mapW - 2 && stacked.cardsUnder && stacked.sameMap, JSON.stringify(stacked));
  await page.evaluate(() => toggleStationsSplit(true));
  await page.waitForTimeout(500);

  // ── 10. The arrows are a function of the zoom ────────────────────────────
  // Fixed-size marks buried a dense network at a whole-state view and were too
  // small to read at the zoom the question is actually asked at. Measured as
  // ink on the arrow canvas — the property this is about is what is on screen,
  // and "draw() ran" is not that.
  const ARROW_VIEW = { lat: -26.66, lon: 150.19 };
  const inkAt = async (z) => {
    await page.evaluate((v) => state.map.setView([v.lat, v.lon], v.z, { animate: false }),
      { ...ARROW_VIEW, z });
    await page.waitForTimeout(700);
    return page.evaluate(() => {
      const c = document.querySelector('.mn-arrow-canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let ink = 0, n = 0;
      for (let i = 3; i < d.length; i += 4) { n++; if (d[i] > 8) ink++; }
      return { zoom: state.map.getZoom(), drawing: MapArrows.drawing(), pct: 100 * ink / n };
    });
  };
  const far  = await inkAt(MIN_ARROW_ZOOM - 1);
  const near = await inkAt(MIN_ARROW_ZOOM);
  check('below the arrow zoom nothing is drawn at all — not small, none',
    !far.drawing && far.pct === 0, JSON.stringify(far));
  check('…and at it they are on the map', near.drawing && near.pct > 0, JSON.stringify(near));
  // The mark itself grows with the zoom, and closes up. Read off the module's
  // own ramp rather than off total ink: the number of links in view falls as
  // you zoom in, so ink would measure both effects at once and could not tell
  // "bigger marks" from "fewer links".
  const ramp = await page.evaluate(async () => {
    const at = async z => {
      state.map.setView([-26.66, 150.19], z, { animate: false });
      await new Promise(r => setTimeout(r, 500));
      return MapArrows.scale();
    };
    return { far: await at(10), mid: await at(12), near: await at(15), over: await at(16) };
  });
  check('the marks grow with the zoom, and close up as they do',
    ramp.far.head < ramp.mid.head && ramp.mid.head < ramp.near.head
      && ramp.far.spacing > ramp.mid.spacing && ramp.mid.spacing > ramp.near.spacing,
    JSON.stringify(ramp));
  check('…and stop growing once they are full size',
    ramp.over.head === ramp.near.head && ramp.over.spacing === ramp.near.spacing,
    JSON.stringify({ near: ramp.near, over: ramp.over }));

  // ── 11. A backbone path's arrows are black ──────────────────────────────
  // The backbone's identity on this map *is* the black line, and a chevron in
  // the channel colour over it reads as a field link.
  await page.evaluate(() => state.map.setView([-26.66, 150.19], 10, { animate: false }));
  await page.waitForTimeout(700);
  // The field links come off the map first, so the only arrowheads on the
  // canvas are the backbone's. With them on, a fan of field links crosses this
  // one and their arrows land in the same few pixels — which is a true fact
  // about the picture and a useless one for this assertion.
  await page.evaluate(() => { state.mapShowLinks = false; refreshMapLayers({ skipFit: true }); });
  await page.waitForTimeout(800);
  const black = await page.evaluate(() => {
    const hex = c => {
      const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(c).trim());
      return m ? [1, 2, 3].map(i => parseInt(m[i], 16)) : null;
    };
    const size = state.map.getSize();
    // A backbone path with both ends on screen, so the mark positions are
    // known: MapArrows puts a two-way path's heads at 14% and 86% along it.
    const bb = state.mapLines.find(l => {
      if (l.mnLinkRole !== 'backbone' || l.mnArrowDir !== 'both') return false;
      const ll = l.getLatLngs();
      return ll.every(p => {
        const q = state.map.latLngToContainerPoint(p);
        return q.x > 40 && q.y > 40 && q.x < size.x - 40 && q.y < size.y - 40;
      });
    });
    if (!bb) return { found: false };
    const ll = bb.getLatLngs();
    const a = state.map.latLngToContainerPoint(ll[0]);
    const b = state.map.latLngToContainerPoint(ll[1]);
    const x = a.x + (b.x - a.x) * 0.86, y = a.y + (b.y - a.y) * 0.86;
    const cv = document.querySelector('.mn-arrow-canvas');
    const dpr = cv.width / size.x;
    const r = 9;
    const d = cv.getContext('2d').getImageData(
      Math.round(x * dpr) - r, Math.round(y * dpr) - r, r * 2, r * 2).data;
    const core = hex(bb.options.color);
    let dark = 0, coloured = 0, any = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 40) continue;
      any++;
      if (d[i] < 70 && d[i + 1] < 70 && d[i + 2] < 70) dark++;
      if (core && Math.abs(d[i] - core[0]) < 40 && Math.abs(d[i + 1] - core[1]) < 40
               && Math.abs(d[i + 2] - core[2]) < 40) coloured++;
    }
    return { found: true, core: bb.options.color, any, dark, coloured };
  });
  // Read off the arrow canvas at the mark's own position: the line under it is
  // the channel colour, so "black there" can only be the arrowhead.
  check('a backbone path\'s arrowheads are drawn black, not in the channel colour',
    black.found && black.any > 0 && black.dark > 0 && black.coloured === 0,
    JSON.stringify(black));
  await page.evaluate(() => { state.mapShowLinks = true; refreshMapLayers({ skipFit: true }); });
  await page.waitForTimeout(600);

  // ── 12. What is here ────────────────────────────────────────────────────
  const here = await page.evaluate(async () => {
    MapHere.arm(true);
    const armed = MapHere.armed();
    state.map.fire('click', { latlng: L.latLng(-26.66, 150.19),
                              originalEvent: new MouseEvent('click') });
    await new Promise(r => setTimeout(r, 2500));
    const el = document.getElementById('here-card');
    return {
      armed,
      disarmed: !MapHere.armed(),
      shown: !el.hidden,
      pin: !!document.querySelector('.mn-here'),
      text: el.textContent.replace(/\s+/g, ' '),
      stnCardShut: !state.stnCard.id,
    };
  });
  check('the tool arms, and the click that answers it disarms it again',
    here.armed && here.disarmed, JSON.stringify({ a: here.armed, d: here.disarmed }));
  check('a pin lands on the point and the card opens', here.shown && here.pin,
    JSON.stringify({ shown: here.shown, pin: here.pin }));
  // The rows that need no network, which are the ones this harness can see.
  for (const row of ['Wind region', 'Drainage basin', 'Maintenance hub',
                     'Nearest station', 'Nearest repeater', 'Nearest survey mark']) {
    check(`the card answers "${row}"`, here.text.includes(row), here.text.slice(0, 120));
  }
  check('…and it names a real basin and a real hub rather than a placeholder',
    /Balonne|Condamine|Basin|basin/.test(here.text) && /Hub/.test(here.text),
    here.text.slice(0, 200));
  // Every row that cannot be answered says so rather than showing nothing: the
  // terrain and cover services are off-origin and this harness blocks them.
  check('an answer it cannot reach is named as unavailable, not left blank',
    /no terrain tile|unavailable/.test(here.text), here.text.slice(0, 200));
  check('opening it closes the station card — one card in that rectangle',
    here.stnCardShut, String(here.stnCardShut));

  const closed = await page.evaluate(() => {
    MapHere.close();
    return { shown: !document.getElementById('here-card').hidden,
             pin: !!document.querySelector('.mn-here') };
  });
  check('closing it takes the card and the pin', !closed.shown && !closed.pin,
    JSON.stringify(closed));

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
console.log('PASS — the links say what channel they are on and which way they run, the credit');
console.log('       line is off the map, and the side panel can hold the map\'s answer beside it.');
