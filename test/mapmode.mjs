// The banner that names the Stations map's mode while it is in one
// (map-mode.js): what a click does now, with ✕ and "Esc leaves".
//
//   1. **Nothing to say**: a map in no mode has no banner.
//   2. **Each mode names itself**: a draw tool (and that station pins are off;
//      for a line, that Enter finishes it — and a real Enter does),
//      What's here, the Best repeater pick, the link budget picking its ends
//      (and which end), moving a pin (and whose). The drive's start and site
//      features are checked in drive.mjs and sitefeatures.mjs, which already
//      stand up the route service and an editor's sign-in they need.
//   3. **Leaving**: ✕ pressed for real leaves the mode, the banner goes and
//      focus is on the map; Escape leaves every one — the five that already
//      took it themselves, and What's here and the Best repeater pick, which
//      did not and now do through the banner.
//   4. **One press, one thing**: Escape with a dialog open leaves the mode
//      alone; Escape on the full-screen map with What's here armed leaves
//      What's here and keeps full screen.
//      It is seen: solid red with white words, and the map framed in the same
//      red while the mode lasts.
//   5. **Where it sits**: inside the map, under the zoom buttons, the station
//      trail and ↺, the note under it; at 375 px across the map under the zoom
//      buttons, with no sideways scroll.
//
// Run:  npm run mapmode
//       npm run mapmode -- -v

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const log  = (...a) => console.log(...a);
const vlog = (...a) => { if (VERBOSE) console.log(...a); };

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok: !!ok, detail });
  log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (ok && detail) vlog(`      ${detail}`);
}
const J = v => JSON.stringify(v);

async function openStations(browser, server, errors, contextOpts) {
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await page.waitForFunction(
    () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0, null, { timeout: LOAD_TIMEOUT });
  return { context, page };
}

const banner = page => page.evaluate(() => {
  const el = document.getElementById('map-mode');
  const rows = [...el.querySelectorAll('.map-mode-row')];
  return {
    hidden: el.hidden || !el.getClientRects().length,
    modes: rows.map(r => r.dataset.mode),
    text: el.innerText.replace(/\s+/g, ' ').trim(),
    x: [...el.querySelectorAll('.map-mode-x')].map(b => b.getAttribute('aria-label')),
  };
});
// The banner is looked at once the module that changed has finished.
const settle = page => page.waitForTimeout(120);

async function main() {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];
  try {
    const { context, page } = await openStations(browser, server, errors, { viewport: { width: 1440, height: 1000 } });
    const field = await page.evaluate(() => {
      const s = state.data.stations.find(x => x.lat != null && x.roles.length === 1 && x.roles[0] === 'field');
      return { id: s.id, name: s.name };
    });

    log('\nNothing to say\n');
    let b = await banner(page);
    check('a map in no mode has no banner', b.hidden && !b.modes.length, J(b));

    log('\nEach mode names itself, and Escape leaves it\n');
    await page.evaluate(() => MapDraw.setTool('line'));
    await settle(page);
    b = await banner(page);
    check('a draw tool: what it is, and that station pins are off till it is left, with Esc and ✕',
      J(b.modes) === '["draw"]' && /Drawing a line/.test(b.text) && /station pins can’t be opened until you leave/i.test(b.text)
        && /Esc leaves/.test(b.text) && b.x[0] === 'Leave: Drawing a line', J(b));
    check('…and how a line ends: press Enter to finish the line',
      /click each corner, then press Enter to finish the line\. Station pins/.test(b.text), J(b.text));
    // …which is true: two real clicks on the map, then a real Enter, is a line.
    const before = await page.evaluate(() => (state.draw.shapes || []).length);
    const spot = await page.evaluate(() => {
      const r = state.map.getContainer().getBoundingClientRect();
      return { x: r.left + r.width * 0.35, y: r.top + r.height * 0.6 };
    });
    await page.mouse.click(spot.x, spot.y);
    await page.waitForTimeout(350);
    await page.mouse.click(spot.x + 90, spot.y + 40);
    await page.waitForTimeout(350);
    await page.keyboard.press('Enter');
    await settle(page);
    const lined = await page.evaluate(() => {
      const sh = state.draw.shapes || [];
      const last = sh[sh.length - 1];
      return { n: sh.length, kind: last && last.kind, pts: last && last.pts && last.pts.length, tool: state.draw.tool };
    });
    check('…and Enter does: two clicks and Enter are a line of two points, the tool still on',
      lined.n === before + 1 && lined.kind === 'line' && lined.pts === 2 && lined.tool === 'line', J({ before, ...lined }));
    await page.evaluate(() => { const sh = state.draw.shapes || []; if (sh.length) MapDraw.remove(sh[sh.length - 1].id); });
    const note = await page.evaluate(() => {
      const n = document.getElementById('map-note').getBoundingClientRect();
      const m = document.getElementById('map-mode').getBoundingClientRect();
      return { below: n.top >= m.bottom - 1, text: document.getElementById('map-note').textContent };
    });
    check('…the tool\'s how-to still in the note, under the banner', note.below && /Click each corner/.test(note.text), J(note));
    // Seen, not just there: the map's red, white on it, and the map framed in
    // the same red while the mode lasts (the owner could not find the first,
    // panel-grey banner over the satellite imagery on the dark theme).
    const frame = () => page.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      const row = document.querySelector('#map-mode .map-mode-row');
      const after = getComputedStyle(document.getElementById('leaflet-map'), '::after');
      const probe = document.createElement('i');
      probe.style.color = css.getPropertyValue('--mode-bg');
      document.body.appendChild(probe);
      const red = getComputedStyle(probe).color;
      probe.remove();
      return { red, fill: row ? getComputedStyle(row).backgroundColor : null,
               ink: row ? getComputedStyle(row).color : null,
               frame: after.content !== 'none' && after.borderTopStyle === 'solid' ? after.borderTopColor : null,
               width: parseFloat(after.borderTopWidth) || 0 };
    });
    let fr = await frame();
    check('…on the map\'s red, in white, with the map framed in the same red',
      fr.fill === fr.red && fr.ink === 'rgb(255, 255, 255)' && fr.frame === fr.red && fr.width >= 3, J(fr));
    await page.keyboard.press('Escape');
    await settle(page);
    b = await banner(page);
    check('…Escape leaves it, and the banner goes', b.hidden && await page.evaluate(() => !state.draw.tool), J(b));
    fr = await frame();
    check('…and the frame goes with it', !fr.frame, J(fr));

    await page.evaluate(() => MapHere.arm(true));
    await settle(page);
    b = await banner(page);
    check('What\'s here?: a click on the map says what is known about the spot',
      J(b.modes) === '["here"]' && /What’s here\?/.test(b.text) && /click the map/.test(b.text), J(b));
    await page.keyboard.press('Escape');
    await settle(page);
    check('…which never took Escape itself, and now leaves on it',
      (await banner(page)).hidden && await page.evaluate(() => !MapHere.armed()));

    await page.evaluate(() => MapBestRepeater.arm(true));
    await settle(page);
    b = await banner(page);
    check('the Best repeater pick: a click on the map is where the new station would go',
      J(b.modes) === '["bestrep"]' && /Best repeater/.test(b.text) && /new station would go/.test(b.text), J(b));
    await page.keyboard.press('Escape');
    await settle(page);
    check('…and leaves on Escape too', (await banner(page)).hidden && await page.evaluate(() => !MapBestRepeater.armed()));

    await page.evaluate(() => LinkBudget.arm('b'));
    await settle(page);
    b = await banner(page);
    check('the link budget picking: a click on a station sets an end, not its card — and which end',
      J(b.modes) === '["linkpick"]' && /Picking the link budget’s ends/.test(b.text) && /sets end B, not the station’s card/.test(b.text), J(b));
    await page.keyboard.press('Escape');
    await settle(page);
    check('…Escape stops the picking', (await banner(page)).hidden && await page.evaluate(() => !state.link.picking));

    await page.evaluate(id => MapMovePin.start(id), field.id);
    await settle(page);
    b = await banner(page);
    check('moving a pin: whose, and where to save it',
      J(b.modes) === '["movepin"]' && b.text.includes(`Moving ${field.name}’s pin`) && /Save in its panel/.test(b.text), J(b));
    await page.keyboard.press('Escape');
    await settle(page);
    check('…Escape puts it back', (await banner(page)).hidden && await page.evaluate(() => !MapMovePin.armed()));

    log('\n✕\n');
    for (const [name, on, off] of [
      ['a draw tool', () => MapDraw.setTool('circle'), () => !state.draw.tool],
      ['What\'s here', () => MapHere.arm(true), () => !MapHere.armed()],
      ['the link budget\'s pick', () => LinkBudget.setPicking(true), () => !state.link.picking],
    ]) {
      await page.evaluate(on);
      await settle(page);
      await page.click('#map-mode .map-mode-x');
      await settle(page);
      const after = await page.evaluate(off);
      const focus = await page.evaluate(() => document.activeElement === state.map.getContainer());
      check(`✕ pressed for real leaves ${name}, the banner goes and focus is on the map`,
        after && (await banner(page)).hidden && focus, J({ after, focus }));
    }

    log('\nOne press, one thing\n');
    await page.evaluate(() => MapHere.arm(true));
    await settle(page);
    await page.evaluate(() => Modal.open({ title: 'A question', html: '<p>Over the map.</p>' }));
    await page.waitForTimeout(150);
    await page.keyboard.press('Escape');
    await settle(page);
    const withDialog = await page.evaluate(() => ({ armed: MapHere.armed(),
      dialog: (document.getElementById('app-modal') || {}).style?.display !== 'none' }));
    check('Escape with a dialog open is the dialog\'s: What\'s here stays armed', withDialog.armed, J(withDialog));
    await page.evaluate(() => { try { Modal.close(); } catch (_) { /* already shut */ } });
    await page.waitForTimeout(150);
    await page.evaluate(() => toggleMapFullscreen(true));
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await settle(page);
    const full = await page.evaluate(() => ({ armed: MapHere.armed(), full: !!state.mapFullscreen }));
    check('Escape on the full-screen map leaves What\'s here and keeps full screen', !full.armed && full.full, J(full));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    check('…and the next Escape is full screen\'s', await page.evaluate(() => !state.mapFullscreen));

    log('\nWhere it sits\n');
    await page.evaluate(id => { showStationCard(id); StationTrail.visit(id); MapHere.arm(true); }, field.id);
    await settle(page);
    const geo = await page.evaluate(() => {
      const box = el => el && el.getClientRects().length ? el.getBoundingClientRect() : null;
      const m = box(document.getElementById('map-mode'));
      const map = box(state.map.getContainer());
      const zoom = box(document.querySelector('#leaflet-map .leaflet-control-zoom'));
      const reset = box(document.querySelector('#leaflet-map .mn-map-reset'));
      const trail = box(document.getElementById('stn-trail'));
      const clear = (a, c) => !c || a.bottom <= c.top || a.top >= c.bottom || a.right <= c.left || a.left >= c.right;
      return { inMap: m.left >= map.left && m.right <= map.right && m.top >= map.top,
               clear: clear(m, zoom) && clear(m, reset) && clear(m, trail), found: [!!zoom, !!reset, !!trail] };
    });
    check('inside the map, clear of the zoom buttons, the station trail and ↺',
      geo.inMap && geo.clear && geo.found.every(Boolean), J(geo));
    await page.evaluate(() => { MapHere.arm(false); closeStnCard(); });

    // ── The rail's rings, and 🧹 ─────────────────────────────────────────────
    // A rail button is gold (.is-on) while its pane is the one open, and ringed
    // (.is-live) while its tool has something on behind another pane (app.js,
    // syncDockLive). 🧹 Clear the selection disarms every mode and takes every
    // tool's answer off, so no ring is left — but for the views it leaves on.
    log('\nThe rail rings a tool with something on, and Clear the selection takes the rings off\n');
    const railLook = () => page.evaluate(() => {
      syncDockLive();
      const strip = document.querySelector('#help-panel .dock-strip');
      const one = k => { const b = strip.querySelector(`.dock-tab[data-dock="${k}"]`);
        return b ? { gold: b.classList.contains('is-on'), ring: b.classList.contains('is-live'), title: b.title } : null; };
      return { showing: dockShowing(), draw: one('map-draw'), bestrep: one('map-bestrep'), paths: one('paths'), places: one('places'),
               rings: [...strip.querySelectorAll('.is-live')].map(b => b.dataset.dock || b.className),
               modes: MapMode.shown(), magnify: MapMagnify.on(), shapes: state.draw.shapes.length, tool: state.draw.tool || '',
               linkPicking: !!state.link.picking, here: MapHere.armed(), bestArmed: MapBestRepeater.armed() };
    });
    await page.evaluate(() => { setDockTab('map-display'); });
    let rl = await railLook();
    check('nothing on: no button in the rail is ringed', !rl.rings.length, J(rl.rings));
    await page.evaluate(() => MapDraw.setTool('line'));
    await settle(page);
    rl = await railLook();
    check('a draw tool armed behind the Layers pane: ✏️ ringed, not gold, its tooltip ending "on now"',
      rl.draw && rl.draw.ring && !rl.draw.gold && /on now$/.test(rl.draw.title), J(rl.draw));
    const ringCss = await page.evaluate(() => {
      const b = document.querySelector('#help-panel .dock-tab[data-dock="map-draw"]');
      const ico = b.querySelector('.rail-ico');
      return { btn: getComputedStyle(b).boxShadow, ico: ico ? getComputedStyle(ico).boxShadow : 'none' };
    });
    check('…and the ring is drawn', ringCss.btn !== 'none' || ringCss.ico !== 'none', J(ringCss));
    await page.evaluate(() => setDockTab('map-draw'));
    rl = await railLook();
    check('its own pane opened: gold, and no ring', rl.draw.gold && !rl.draw.ring && !/on now$/.test(rl.draw.title), J(rl.draw));
    // Several things on at once, behind the Layers pane: a drawing, Best
    // repeater's pick armed, a link-budget end, pins being dropped is not
    // possible beside them (one click-taker at a time), and the magnifier.
    await page.evaluate(() => {
      MapDraw.setTool('');
      const c = state.map.getCenter();
      state.draw.shapes.push({ id: 'rail-check', kind: 'line', pts: [[c.lat, c.lng], [c.lat + 0.05, c.lng + 0.05]], colour: '#f00' });
      MapDraw.render();
      const s = state.data.stations.find(x => x.lat != null);
      Places.arm(true);
      MapBestRepeater.pickStation(s.id);
      MapBestRepeater.arm(true);
      MapMagnify.toggle(true);
      setDockTab('map-display');
    });
    await settle(page);
    rl = await railLook();
    check('a drawing, Best repeater armed with a site chosen, and the magnifier on: ✏️ and 🎯 both ringed',
      rl.draw.ring && rl.bestrep && rl.bestrep.ring && rl.magnify && rl.modes.includes('bestrep'), J(rl));
    await page.evaluate(() => clearStationsMapSelection());
    await settle(page);
    rl = await railLook();
    check('🧹 Clear the selection: no mode armed, the magnifier away, nothing drawn, Best repeater emptied',
      !rl.modes.length && !rl.magnify && !rl.shapes && !rl.tool && !rl.linkPicking && !rl.here && !rl.bestArmed
        && !(await page.evaluate(() => MapBestRepeater.live())), J(rl));
    check('…and no ring left in the rail; the open pane is still the gold one',
      !rl.rings.length && rl.showing === 'map-display'
        && await page.evaluate(() => document.querySelector('.dock-tab[data-dock="map-display"]').classList.contains('is-on')),
      J(rl.rings));
    // A tool that says how to clear itself where it makes its panel
    // (MapChrome.panel's live / clear) is ringed and cleared with no line of
    // its own in app.js.
    const hook = await page.evaluate(async () => {
      const e = dockMapItems.get('map-polar');
      const was = { live: e.live, clear: e.clear };
      let on = true, cleared = 0;
      e.live = () => on; e.clear = () => { on = false; cleared++; };
      const saved = DOCK_LIVE['map-polar'];
      delete DOCK_LIVE['map-polar'];
      syncDockLive();
      const b = document.querySelector('.dock-tab[data-dock="map-polar"]');
      const ringed = b.classList.contains('is-live');
      await clearStationsMapSelection();
      syncDockLive();
      const after = b.classList.contains('is-live');
      DOCK_LIVE['map-polar'] = saved; e.live = was.live; e.clear = was.clear;
      return { ringed, cleared, after };
    });
    check('a panel\'s own live() rings its button and its clear() is called by 🧹', hook.ringed && hook.cleared === 1 && !hook.after, J(hook));

    // 🧹 leaves nothing on: Latency & signal's colouring is a view that is
    // switched on rather than drawn, and it goes too (as 3-D and the twin do).
    const views = await page.evaluate(async () => {
      MapLatency.setOn(true);
      syncDockLive();
      const was = MapLatency.on();
      await clearStationsMapSelection();
      return { was, latency: MapLatency.on(), twin: MapTwin.active(), in3d: Map3D.active(),
               rings: [...document.querySelectorAll('#help-panel .dock-strip .is-live')].length };
    });
    check('🧹 also switches off Latency colouring, the twin and 3-D — no ring left',
      views.was && !views.latency && !views.twin && !views.in3d && views.rings === 0, J(views));

    await context.close();

    const phone = await openStations(browser, server, errors, { viewport: { width: 375, height: 800 } });
    await phone.page.evaluate(() => MapDraw.setTool('line'));
    await settle(phone.page);
    const pg = await phone.page.evaluate(() => {
      const m = document.getElementById('map-mode').getBoundingClientRect();
      const map = state.map.getContainer().getBoundingClientRect();
      const zoom = document.querySelector('#leaflet-map .leaflet-control-zoom');
      const z = zoom && zoom.getClientRects().length ? zoom.getBoundingClientRect() : null;
      return { inMap: m.left >= map.left - 1 && m.right <= map.right + 1, under: !z || m.top >= z.bottom,
               wide: m.width >= map.width - 24, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };
    });
    check('at 375 px: across the map under the zoom buttons, no sideways scroll',
      pg.inMap && pg.under && pg.wide && pg.sw <= pg.cw, J(pg));
    await phone.context.close();

    check('nothing threw for the whole run', !errors.length, errors.join(' | '));
  } finally {
    await browser.close();
    await server.close?.();
  }

  const failed = results.filter(r => !r.ok);
  log(`\n  ${results.length} assertion(s).\n`);
  if (failed.length) {
    log(`FAIL — ${failed.length} of them.`);
    process.exit(1);
  }
  log('PASS — the map says which mode it is in, and ✕ or Escape leaves it.');
}

main().catch(e => { console.error(e); process.exit(1); });
