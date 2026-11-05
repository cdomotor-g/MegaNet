// The banner that names the Stations map's mode while it is in one
// (map-mode.js): what a click does now, with ✕ and "Esc leaves".
//
//   1. **Nothing to say**: a map in no mode has no banner.
//   2. **Each mode names itself**: a draw tool (and that station pins are off),
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
      J(b.modes) === '["draw"]' && /Drawing a line/.test(b.text) && /station pins can’t be opened until you leave/.test(b.text)
        && /Esc leaves/.test(b.text) && b.x[0] === 'Leave: Drawing a line', J(b));
    const note = await page.evaluate(() => {
      const n = document.getElementById('map-note').getBoundingClientRect();
      const m = document.getElementById('map-mode').getBoundingClientRect();
      return { below: n.top >= m.bottom - 1, text: document.getElementById('map-note').textContent };
    });
    check('…the tool\'s how-to still in the note, under the banner', note.below && /Click each corner/.test(note.text), J(note));
    await page.keyboard.press('Escape');
    await settle(page);
    b = await banner(page);
    check('…Escape leaves it, and the banner goes', b.hidden && await page.evaluate(() => !state.draw.tool), J(b));

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
