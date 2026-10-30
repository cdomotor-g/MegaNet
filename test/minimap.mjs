// The Stations map's minimap (map-mini.js), driven in a real browser with a
// real mouse.
//
//   1. **Where it is** — in the map's stage, bottom right, open and medium on
//      a desktop that has never set it, over the map and under the station
//      card; nothing added to Leaflet's corners.
//   2. **Following** — centred on the map and four levels further out; the
//      map's view outlined on it, a ring once the outline is a speck.
//   3. **The wheel** — over the minimap it zooms the minimap and not the map,
//      and how far out it was left is how far out it stays as the map moves.
//   4. **Drag and click** — a drag takes the map along when it is let go and
//      the minimap does not snap back; while it is held, the outline is grey
//      and moves with the ground, and a red one of the view's size stands in
//      the middle; a click sends the map to the point.
//   4b. **Its corner** — the grip top left resizes it with a real mouse, the
//      bottom-right corner staying put; the arrow keys nudge it; it stops at
//      its smallest and at the map's caps, and keeps the size it was left at.
//   5. **⚙** — the dialog's every setting applies as it is changed and is
//      remembered: the base (its credit in the map's credit line), place
//      names, which stations, the backbone, the outline, following, how far
//      out, click to move, the size; Done and Escape close it with focus back
//      on ⚙; Back to the defaults.
//   6. **Fold** — put away it is one button and no map at all; brought back,
//      it is the map it was.
//   7. **The tab** — a reload keeps the settings; leaving the tab takes it
//      down, and coming back or re-rendering the tab builds exactly one.
//   8. **A phone** — put away until asked for, and small when it is.
//
// Why a check of its own: every failure here is a page that looks right. A
// wheel that zooms both maps, a drag that snaps the minimap back, a credit
// left behind for a base no longer drawn, a minimap still fetching tiles
// behind another tab — none of them throws.
//
// Run:  npm run minimap
//       npm run minimap -- -v

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
const near = (a, b, tol) => Math.abs(a - b) <= tol;
// One zoom level a wheel step. Leaflet turns a step's pixels into levels by a
// curve and a per-platform factor, and 120 px is two levels on Linux Chromium;
// 50 is one everywhere.
const STEP = 50;
// Degrees of longitude in `px` pixels at zoom `z` — a click lands on a whole
// pixel, so a point worked out from a fractional one is that far out.
const lngPx = (z, px) => px * 360 / (256 * 2 ** z);
// The minimap on the map's centre — to the pixel, since Leaflet pans a map
// whose zoom has not changed by whole pixels.
const centred = S => near(S.mini.lat, S.main.lat, lngPx(S.mini.z, 1)) && near(S.mini.lng, S.main.lng, lngPx(S.mini.z, 1));

async function openStations(context, server, errors) {
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(server.origin + '/index.html?tab=stations', { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.map && state.mapMarkers.length > 0,
    null, { timeout: LOAD_TIMEOUT });
  await settle(page);
  return page;
}

// Both maps still: Leaflet ignores a setView while a zoom animation runs.
async function settle(page) {
  await page.waitForFunction(() => {
    const busy = m => !!m && (m._animatingZoom || (m._panAnim && m._panAnim._inProgress));
    return !busy(state.map) && !busy(MapMini.map());
  }, null, { timeout: 10_000 });
  await page.waitForTimeout(200);
}

// The outline as drawn on the minimap: its colour, and its corners in the
// minimap's pixels (left, top, right, bottom) — where the main map's view is.
const outlineNow = `(() => {
  const n = MapMini.map(), b = state.map.getBounds();
  let color = null;
  n.eachLayer(l => { if (l instanceof L.Rectangle && l.options.fillOpacity > 0) color = l.options.color; });
  const nw = n.latLngToContainerPoint(b.getNorthWest()), se = n.latLngToContainerPoint(b.getSouthEast());
  const sheet = document.querySelector('.mn-minimap-next');
  const d = MapMini.drawn();
  return { color, box: [nw.x, nw.y, se.x, se.y], size: [n.getSize().x, n.getSize().y],
           grey: d.grey, next: d.next, sheet: !!sheet && getComputedStyle(sheet).display !== 'none' };
})()`;
// A polygon's box, [left, top, right, bottom].
const boxOf = pts => [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])),
                      Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))];

// The two maps' views, the outline's bounds, the box the minimap stands in.
const read = `(() => {
  const m = state.map, n = MapMini.map();
  const v = x => x && { lat: x.getCenter().lat, lng: x.getCenter().lng, z: x.getZoom() };
  const r = el => { if (!el) return null; const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height }; };
  const wrap = document.querySelector('.mn-map-stage > .mn-minimap');
  return {
    main: v(m), mini: v(n),
    bounds: m.getBounds().toBBoxString(),
    wraps: document.querySelectorAll('.mn-minimap').length,
    wrap: r(wrap), stage: r(document.querySelector('.mn-map-stage')),
    mapBox: r(wrap && wrap.querySelector('.mn-minimap-map')),
    folded: !!wrap && wrap.classList.contains('is-folded'),
    open: r(wrap && wrap.querySelector('.mn-map-mini-open')),
    openShown: !!wrap && getComputedStyle(wrap.querySelector('.mn-map-mini-open')).display !== 'none',
    z: wrap && getComputedStyle(wrap).zIndex,
    drawn: MapMini.drawn(), cfg: MapMini.settings(),
    saved: (() => { try { return JSON.parse(localStorage.getItem('mn-minimap')); } catch (_) { return null; } })(),
    focus: document.activeElement && document.activeElement.className,
    credits: (document.querySelector('.mn-map-attrib') || {}).textContent || '',
    corner: document.querySelectorAll('#leaflet-map .leaflet-bottom.leaflet-right > *').length,
  };
})()`;

async function main() {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];
  try {
    // ═══════════════════════════════════════════════════════════════════════
    log('\nWhere it is, and following the map (1440 × 900)\n');
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await openStations(context, server, errors);
    const g = () => page.evaluate(read);
    let S = await g();
    check('a desktop that never set it gets one minimap, open, in the map\'s stage',
      S.wraps === 1 && !S.folded && !!S.mini, J({ wraps: S.wraps, folded: S.folded }));
    check('…in the stage\'s bottom-right corner, medium',
      S.wrap && near(S.stage.right - S.wrap.right, 14.4, 3) && near(S.stage.bottom - S.wrap.bottom, 19.2, 3)
        && near(S.wrap.width, 232, 1) && near(S.wrap.height, 174, 1), J({ wrap: S.wrap, stage: S.stage }));
    check('…over the map and under the station card (680 < 690), nothing in Leaflet\'s bottom-right corner',
      S.z === '680' && S.corner === 0, J({ z: S.z, corner: S.corner }));
    check('…drawing the stations, the outline and the main map\'s base',
      S.drawn.dots > 1000 && S.drawn.box && S.drawn.base === (await page.evaluate(() => state.map.mnBaseName)),
      J(S.drawn));

    await page.evaluate(() => state.map.setView([-27.47, 153.02], 10, { animate: false }));
    await settle(page);
    S = await g();
    check('following: centred on the map, four levels out',
      S.mini.z === 6 && centred(S), J({ main: S.main, mini: S.mini }));
    const outline = await page.evaluate(() => {
      const r = MapMini.map();
      let b = null;
      r.eachLayer(l => { if (l instanceof L.Rectangle && l.options.fillOpacity > 0) b = l.getBounds().toBBoxString(); });
      return b;
    });
    check('…with the map\'s view outlined on it', outline === S.bounds, J({ outline, bounds: S.bounds }));
    check('…no ring while the outline is big enough to see', !S.drawn.aim, J(S.drawn));
    const outAt = async z => {
      await page.evaluate(zz => state.map.setZoom(zz, { animate: false }), z);
      await settle(page);
      return (await g()).mini.z;
    };
    const far = [await outAt(4), await outAt(3), await outAt(2), await outAt(14)];
    check('never further out than the continent (zoom 2), unless the map is: then one level beyond it; and four out again nearer in',
      J(far) === J([2, 2, 1, 10]), J({ 'map 4, 3, 2, 14': far }));
    await page.evaluate(() => state.map.setView([-27.47, 153.02], 10, { animate: false }));
    await settle(page);

    // ── The wheel ─────────────────────────────────────────────────────────────
    const mid = b => ({ x: b.left + b.width / 2, y: b.top + b.height / 2 });
    let c = mid(S.mapBox);
    await page.mouse.move(c.x, c.y);
    await page.mouse.wheel(0, -STEP);
    await page.waitForTimeout(400);
    await settle(page);
    S = await g();
    check('a wheel over the minimap zooms the minimap in, and not the map',
      S.main.z === 10 && S.mini.z === 7, J({ main: S.main.z, mini: S.mini.z }));
    check('…about its centre, which stays the map\'s', centred(S), J({ main: S.main, mini: S.mini }));
    check('…and that is how far out it sits now — kept on this device', S.cfg.out === 3 && S.saved && S.saved.out === 3,
      J({ cfg: S.cfg.out, saved: S.saved && S.saved.out }));
    await page.mouse.wheel(0, STEP);
    await page.waitForTimeout(400);
    await page.mouse.wheel(0, STEP);
    await page.waitForTimeout(400);
    await settle(page);
    S = await g();
    check('wheeled out twice, five levels out', S.main.z === 10 && S.mini.z === 5 && S.cfg.out === 5, J({ main: S.main.z, mini: S.mini.z, out: S.cfg.out }));
    for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, STEP); await page.waitForTimeout(400); }
    await settle(page);
    S = await g();
    check('…and the wheel stops at eight, where it holds rather than bouncing back',
      S.main.z === 10 && S.mini.z === 2 && S.cfg.out === 8, J({ main: S.main.z, mini: S.mini.z, out: S.cfg.out }));
    for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, -STEP); await page.waitForTimeout(400); }
    await settle(page);
    await page.evaluate(() => state.map.setZoom(12, { animate: false }));
    await settle(page);
    S = await g();
    check('the map zoomed in two: the minimap keeps its five', S.mini.z === 7, J({ main: S.main.z, mini: S.mini.z }));
    await page.evaluate(() => state.map.setZoom(10, { animate: false }));
    await settle(page);

    // A wheel over the map itself is still the map's.
    const st = (await g()).stage;
    await page.mouse.move(st.left + 200, st.top + 300);
    await page.mouse.wheel(0, -STEP);
    await page.waitForTimeout(400);
    await settle(page);
    S = await g();
    check('…while a wheel over the map zooms the map, and the minimap follows',
      S.main.z === 11 && S.mini.z === 6, J({ main: S.main.z, mini: S.mini.z }));
    await page.evaluate(() => state.map.setView([-27.47, 153.02], 10, { animate: false }));
    await settle(page);

    // ── Drag and click ────────────────────────────────────────────────────────
    S = await g();
    c = mid(S.mapBox);
    const before = S.main;
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(c.x - 5 * i, c.y);
    // Held: Leaflet moves its pane on the next frame.
    await page.waitForTimeout(100);
    const held = await page.evaluate(outlineNow);
    const nb = held.next ? boxOf(held.next) : null;
    const gw = held.box[2] - held.box[0], gh = held.box[3] - held.box[1];
    check('held mid-drag: the outline turns grey and moves with the ground — still the map\'s view, 40 px west',
      held.grey && held.color === '#5f6368' && near((held.box[0] + held.box[2]) / 2, held.size[0] / 2 - 40, 2)
        && near((held.box[1] + held.box[3]) / 2, held.size[1] / 2, 2), J(held));
    check('…and a red one of the same size stands in the middle of the minimap, where the map will go',
      held.sheet && !!nb && near((nb[0] + nb[2]) / 2, held.size[0] / 2, 1) && near((nb[1] + nb[3]) / 2, held.size[1] / 2, 1)
        && near(nb[2] - nb[0], gw, 1) && near(nb[3] - nb[1], gh, 1), J({ next: nb, grey: held.box, size: held.size }));
    await page.mouse.up();
    await page.waitForTimeout(500);
    await settle(page);
    S = await g();
    check('a drag on the minimap takes the map along when it is let go (dragged west, the view goes east)',
      S.main.lng > before.lng + 0.5 && near(S.main.lat, before.lat, 0.05), J({ before, after: S.main }));
    check('…and the minimap is where it was dragged to, centred on the map again',
      centred(S) && S.mini.z === 5, J({ main: S.main, mini: S.mini }));
    const after = await page.evaluate(outlineNow);
    check('…the outline red again, in the middle, and the grey one and the sheet gone',
      !after.grey && after.color === '#d50000' && !after.next && !after.sheet
        && near((after.box[0] + after.box[2]) / 2, after.size[0] / 2, 1.5), J(after));

    const target = await page.evaluate(({ x, y }) => {
      const n = MapMini.map(), b = n.getContainer().getBoundingClientRect();
      const ll = n.containerPointToLatLng([x - b.left, y - b.top]);
      return { lat: ll.lat, lng: ll.lng };
    }, { x: c.x + 50, y: c.y + 30 });
    await page.mouse.click(c.x + 50, c.y + 30);
    await page.waitForTimeout(500);
    await settle(page);
    S = await g();
    const tol = lngPx(S.mini.z, 2);
    check('a click on the minimap sends the map to the point clicked', near(S.main.lat, target.lat, tol) && near(S.main.lng, target.lng, tol),
      J({ target, main: S.main, tol }));

    // ── Its corner ──────────────────────────────────────────────────────────────
    log('\nIts corner\n');
    S = await g();
    const gripAt = () => page.evaluate(() => {
      const el = document.querySelector('.mn-minimap-grip'), r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height, cursor: getComputedStyle(el).cursor };
    });
    let grip = await gripAt();
    check('a grip in its top-left corner, the resize cursor over it',
      near(grip.left, S.wrap.left, 3) && near(grip.top, S.wrap.top, 3) && grip.width >= 20 && grip.cursor === 'nwse-resize',
      J({ grip, wrap: S.wrap }));
    const dragGrip = async (dx, dy, to) => {
      grip = await gripAt();
      const gx = grip.left + grip.width / 2, gy = grip.top + grip.height / 2;
      await page.mouse.move(gx, gy);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) {
        await page.mouse.move(to ? gx + (to.x - gx) * i / 10 : gx + dx * i / 10, to ? gy + (to.y - gy) * i / 10 : gy + dy * i / 10);
      }
      await page.mouse.up();
      await page.waitForTimeout(150);
      await settle(page);
      return g();
    };
    const w0 = S.wrap;
    S = await dragGrip(-100, -60);
    check('dragged up and left 100 × 60, it is 100 × 60 larger, its bottom-right corner where it was',
      near(S.wrap.width, w0.width + 100, 1) && near(S.wrap.height, w0.height + 60, 1)
        && near(S.wrap.right, w0.right, .5) && near(S.wrap.bottom, w0.bottom, .5), J({ before: w0, after: S.wrap }));
    check('…the map inside re-measured, still centred on the map and as far out as it was',
      near(S.mapBox.width, S.wrap.width - 4, 1) && await page.evaluate(() => MapMini.map().getSize().x) === Math.round(S.mapBox.width)
        && centred(S) && S.mini.z === S.main.z - 5, J({ mapBox: S.mapBox, main: S.main, mini: S.mini }));
    check('…and kept on this device as its own size',
      S.saved.size === 'own' && S.saved.w === Math.round(S.wrap.width) && S.saved.h === Math.round(S.wrap.height), J(S.saved));
    const w1 = S.wrap;
    await page.focus('.mn-minimap-grip');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowDown');
    await settle(page);
    S = await g();
    check('the arrow keys on the grip move the corner: left 16 px wider, down 16 px shorter',
      near(S.wrap.width, w1.width + 16, 1) && near(S.wrap.height, w1.height - 16, 1) && S.saved.w === Math.round(S.wrap.width),
      J({ before: w1, after: S.wrap }));
    S = await dragGrip(600, 600);
    check('dragged far down and right, it stops at its smallest, 128 × 96', near(S.wrap.width, 128, 1) && near(S.wrap.height, 96, 1)
      && near(S.wrap.right, w0.right, .5), J(S.wrap));
    S = await dragGrip(0, 0, { x: 2, y: 2 });
    check('dragged to the window\'s corner, it stops inside the map, and what is kept is what it reached',
      S.wrap.left >= S.stage.left && S.wrap.top >= S.stage.top + 40 && S.wrap.width > 400
        && S.saved.w === Math.round(S.wrap.width) && S.saved.h === Math.round(S.wrap.height), J({ wrap: S.wrap, stage: S.stage, saved: S.saved }));

    // ── ⚙ ───────────────────────────────────────────────────────────────────────
    log('\n⚙ Minimap settings\n');
    await page.evaluate(() => state.map.setView([-27.47, 153.02], 10, { animate: false }));
    await settle(page);
    await page.click('.mn-map-mini-gear');
    await page.waitForSelector('#mmini-settings');
    check('⚙ opens the dialog', await page.evaluate(() =>
      document.getElementById('app-modal-title').textContent === 'Minimap settings'));
    const set = (sel, v) => page.evaluate(([s, val]) => {
      const el = document.querySelector(`#mmini-settings ${s}`);
      if (el.type === 'checkbox' || el.type === 'radio') el.checked = val; else el.value = val;
      el.dispatchEvent(new Event(el.type === 'range' ? 'input' : 'change', { bubbles: true }));
    }, [sel, v]);

    await set('[data-mmini="stations"][value="repeaters"]', true);
    S = await g();
    const allDots = await page.evaluate(() => state.data.stations.filter(s => s.lat != null && s.lon != null).length);
    check('Stations → Repeaters and base stations: the field stations go', S.drawn.dots > 50 && S.drawn.dots < allDots / 4,
      J({ dots: S.drawn.dots, all: allDots }));
    await set('[data-mmini="stations"][value="none"]', true);
    S = await g();
    check('Stations → None: no dots', S.drawn.dots === 0, J(S.drawn));
    await set('[data-mmini="stations"][value="all"]', true);

    await set('[data-mmini="base"]', 'Satellite');
    S = await g();
    check('Base map → Satellite: drawn, with its two name layers', S.drawn.base === 'Satellite' && S.drawn.labels === 2, J(S.drawn));
    check('…and its credit in the map\'s credit line, though the map is not on Satellite',
      /Esri/.test(S.credits) && (await page.evaluate(() => state.map.mnBaseName)) !== 'Satellite', S.credits.slice(0, 160));
    await set('[data-mmini="names"]', false);
    S = await g();
    check('Place names off: Satellite alone', S.drawn.base === 'Satellite' && S.drawn.labels === 0, J(S.drawn));
    await set('[data-mmini="base"]', 'none');
    S = await g();
    check('Base map → None: no base, and the credit it brought is gone again',
      S.drawn.base === null && !/Maxar/.test(S.credits), S.credits.slice(0, 160));
    await set('[data-mmini="base"]', 'same');
    await set('[data-mmini="names"]', true);
    S = await g();
    check('Same as the map: back on the map\'s base', S.drawn.base === (await page.evaluate(() => state.map.mnBaseName)), J(S.drawn));

    await set('[data-mmini="backbone"]', true);
    S = await g();
    const pairs = await page.evaluate(() => backboneLinks(state.mapMaxLinkKm).length);
    check('Backbone paths on: one per repeater-to-repeater or -base pair', pairs > 0 && S.drawn.paths === pairs, J({ drawn: S.drawn.paths, pairs }));
    await set('[data-mmini="box"]', false);
    S = await g();
    check('The map\'s view off: no outline', !S.drawn.box, J(S.drawn));
    await set('[data-mmini="box"]', true);

    await set('#mmini-out', 7);
    S = await g();
    check('How far out → 7: zoom 3 at the map\'s 10',
      S.cfg.out === 7 && S.mini.z === 3, J({ out: S.cfg.out, mini: S.mini.z }));
    check('…a speck of an outline, ringed', S.drawn.aim, J(S.drawn));
    await set('#mmini-out', 4);

    check('Size: the corner\'s size is offered as Yours, and picked',
      await page.evaluate(() => { const r = document.querySelector('#mmini-settings [data-mmini="size"][value="own"]');
        return !!r && r.checked && /Yours \(\d+ × \d+\)/.test(r.parentNode.textContent); }));
    await set('[data-mmini="size"][value="l"]', true);
    S = await g();
    check('Size → Large: 320 × 240 — the corner\'s size let go — the map inside re-measured',
      near(S.wrap.width, 320, 1) && near(S.wrap.height, 240, 1) && S.saved.size === 'l' && S.saved.w === null
      && await page.evaluate(() => MapMini.map().getSize().x > 300), J({ wrap: S.wrap, saved: S.saved }));

    await set('[data-mmini="follow"]', false);
    check('Follow off: How far out stands down', await page.evaluate(() => document.getElementById('mmini-out').disabled));
    await set('[data-mmini="jump"]', false);
    await page.click('#mmini-settings [data-mmini-do="done"]');
    S = await g();
    check('Done closes it, focus back on ⚙', await page.evaluate(() => document.getElementById('app-modal').style.display === 'none')
      && /mn-map-mini-gear/.test(S.focus), J({ focus: S.focus }));

    const fixed = S.mini;
    await page.evaluate(() => state.map.panBy([300, 0], { animate: false }));
    await settle(page);
    S = await g();
    check('not following, the map moves and the minimap stays put',
      near(S.mini.lat, fixed.lat, 1e-9) && near(S.mini.lng, fixed.lng, 1e-9), J({ fixed, now: S.mini }));
    c = mid(S.mapBox);
    await page.mouse.move(c.x + 60, c.y);
    await page.mouse.wheel(0, -STEP);
    await page.waitForTimeout(400);
    await settle(page);
    S = await g();
    check('…a wheel zooms only the minimap, about the pointer, and where it was left is remembered',
      S.mini.z === fixed.z + 1 && S.mini.lng > fixed.lng && S.saved.view && S.saved.view.z === S.mini.z
        && S.main.z === 10, J({ mini: S.mini, saved: S.saved.view, main: S.main.z }));
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(c.x - 5 * i, c.y - 3 * i);
    await page.waitForTimeout(100);
    const loose = await page.evaluate(outlineNow);
    await page.mouse.up();
    await page.waitForTimeout(300);
    check('…a drag, not following, moves only the minimap: the outline stays red and goes with it, nothing in the middle',
      !loose.grey && loose.color === '#d50000' && !loose.next && !loose.sheet, J(loose));
    S = await g();
    const main0 = S.main;
    await page.mouse.click(c.x - 40, c.y + 20);
    await page.waitForTimeout(400);
    S = await g();
    check('…and with Click to move off, a click leaves the map where it is',
      near(S.main.lat, main0.lat, 1e-9) && near(S.main.lng, main0.lng, 1e-9), J({ main0, now: S.main }));

    // A reload: everything set comes back.
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => typeof state !== 'undefined' && !!state.map && state.mapMarkers.length > 0,
      null, { timeout: LOAD_TIMEOUT });
    await settle(page);
    const kept = S.mini;
    S = await g();
    check('a reload keeps the settings, and the minimap where it was left',
      S.cfg.size === 'l' && !S.cfg.follow && !S.cfg.jump && S.cfg.backbone && S.mini.z === kept.z
        && near(S.mini.lat, kept.lat, 1e-6) && near(S.mini.lng, kept.lng, 1e-6), J({ cfg: S.cfg, mini: S.mini, kept }));

    await page.click('.mn-map-mini-gear');
    await page.waitForSelector('#mmini-settings');
    await page.click('#mmini-settings [data-mmini-do="reset"]');
    await page.waitForSelector('#mmini-settings');
    S = await g();
    check('Back to the defaults: following again, medium, four out, the controls drawn from them',
      S.cfg.follow && S.cfg.size === 'm' && S.cfg.out === 4 && !S.cfg.backbone && S.cfg.view === null && S.mini.z === S.main.z - 4
        && await page.evaluate(() => document.querySelector('#mmini-settings [data-mmini="follow"]').checked),
      J({ cfg: S.cfg, main: S.main.z, mini: S.mini.z }));
    await page.keyboard.press('Escape');
    check('Escape closes it', await page.evaluate(() => document.getElementById('app-modal').style.display === 'none'));

    // ── Fold ────────────────────────────────────────────────────────────────────
    log('\nPut away and brought back\n');
    await page.click('.mn-map-mini-fold');
    S = await g();
    check('put away: no map at all, one button, focused, remembered',
      S.folded && !S.mini && S.openShown && /mn-map-mini-open/.test(S.focus) && S.saved.open === false,
      J({ folded: S.folded, mini: S.mini, focus: S.focus, saved: S.saved && S.saved.open }));
    check('…the size of the map\'s other buttons, in the same corner',
      S.open && near(S.open.width, 36, 1) && near(S.stage.right - S.open.right, 14.4, 3), J(S.open));
    await page.click('.mn-map-mini-open');
    await settle(page);
    S = await g();
    check('brought back: the map it was, focus on the fold button',
      !S.folded && !!S.mini && S.mini.z === S.main.z - 4 && S.drawn.dots > 1000 && /mn-map-mini-fold/.test(S.focus),
      J({ mini: S.mini, focus: S.focus }));

    // ── The tab ─────────────────────────────────────────────────────────────────
    log('\nThe tab\n');
    await page.evaluate(() => switchTab('home'));
    await page.waitForTimeout(400);
    check('leaving the tab takes it down', await page.evaluate(() =>
      !MapMini.map() && !document.querySelector('.mn-minimap') && _liveMaps.has('Minimap')));
    await page.evaluate(() => switchTab('stations'));
    await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0, null, { timeout: LOAD_TIMEOUT });
    await settle(page);
    S = await g();
    check('…coming back builds exactly one', S.wraps === 1 && !!S.mini, J({ wraps: S.wraps }));
    await page.evaluate(() => renderMain());
    await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0, null, { timeout: LOAD_TIMEOUT });
    await settle(page);
    S = await g();
    check('…and so does the tab drawn over itself, following the map it is drawn with',
      S.wraps === 1 && !!S.mini && S.mini.z === Math.max(2, S.main.z - 4) && centred(S),
      J({ wraps: S.wraps, main: S.main, mini: S.mini }));
    await context.close();

    // ═══════════════════════════════════════════════════════════════════════
    log('\nA phone (375 × 740, touch)\n');
    const phone = await browser.newContext({ viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true });
    const pp = await openStations(phone, server, errors);
    S = await pp.evaluate(read);
    check('a phone that never set it gets it put away: one button, no map',
      S.wraps === 1 && S.folded && !S.mini && S.openShown, J({ folded: S.folded, mini: !!S.mini }));
    check('…a finger\'s worth', S.open && S.open.width >= 44 && S.open.height >= 44, J(S.open));
    await pp.tap('.mn-map-mini-open');
    await pp.waitForTimeout(300);
    S = await pp.evaluate(read);
    check('tapped, it is the small one', !S.folded && !!S.mini && near(S.wrap.width, 168, 1), J(S.wrap));
    const pgrip = await pp.evaluate(() => { const r = document.querySelector('.mn-minimap-grip').getBoundingClientRect(); return { width: r.width, height: r.height }; });
    check('…its corner\'s grip a finger\'s worth', pgrip.width >= 32 && pgrip.height >= 32, J(pgrip));
    await phone.close();

    check('nothing threw for the whole run', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    await server.close();
  }

  const failed = results.filter(r => !r.ok);
  log(`\n  ${results.length} assertion(s).`);
  if (failed.length) {
    log(`\nFAIL — ${failed.length} of them:\n`);
    for (const f of failed) log(`  ✗ ${f.label}${f.detail ? `\n      ${f.detail}` : ''}`);
    process.exit(1);
  }
  log('\nPASS — the Stations map\'s minimap follows it further out, zooms under the wheel\n'
    + '       without the map, moves the map from a drag or a click, and keeps what ⚙ set.');
}

main().catch(err => { console.error(err); process.exit(1); });
