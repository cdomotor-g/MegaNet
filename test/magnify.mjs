// The Stations map's magnifier (map-magnify.js), driven in a real browser with
// a real mouse, and on a phone with a finger.
//
//   1. **The switch** — in the side panel's rail, last in Tools after What's
//      here?, off and with no glass on a first visit.
//   2. **On** — one glass, in the map's container, in the middle of the map;
//      4× (two levels closer than the map); its map holding base-map tiles and
//      nothing else — the main map's blend, and no pin, name, line or overlay;
//      over that map, the stations' pins as small dots and their names faint;
//      2 cm (76 px) wider than it was; the badge saying how to change it; over
//      the panes and the minimap and under the station card and Leaflet's
//      corners (685); taking no pointer.
//   3. **Following** — a real mouse over the map moves the glass's centre to
//      the pointer and the glass's map to the ground under it; the pointer is
//      hidden over the map and back over Leaflet's corners.
//   4. **Power** — Shift + scroll steps it, and the map does not zoom; a
//      scroll without Shift zooms the map, and the glass stays that much closer.
//      Remembered on the device.
//   5. **The blend** — a base ticked in Layers is in the glass, Satellite with
//      the State imagery that rides along with it.
//   6. **Off** — Escape, and the switch again; no glass and no pointer hidden.
//   7. **The tab** — a rebuild of the map keeps it on, with one glass; leaving
//      the tab puts it away.
//   8. **A phone** — the glass takes the finger: dragged, it moves and the map
//      does not; tapped, it steps the power.
//
//   9. **The ground's own layers** — a property picture, a road reserve and a
//      survey mark the map draws are in the glass (the picture asked again at
//      the glass's scale); a radio path is not.
//
// Why a check of its own: every failure here is a page that looks fine. A line
// that got into the glass, a pin drawn full size or not at all, a glass that zooms the map with the power, a lens
// still fetching tiles behind another tab, a pointer left hidden after the
// glass has gone — none of them throws.
//
// Run:  npm run magnify
//       npm run magnify -- -v

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

async function settle(page) {
  await page.waitForFunction(() => {
    const m = state.map;
    return !!m && !m._animatingZoom && !(m._panAnim && m._panAnim._inProgress);
  }, null, { timeout: 10_000 });
  await page.waitForTimeout(250);
}

// Everything a check reads, in one look.
function read() {
  const box = state.map.getContainer();
  const glass = box.querySelectorAll('.mn-magnify');
  const g = glass[0];
  const btn = document.querySelector('.mn-map-magnify');
  const r = box.getBoundingClientRect();
  const gr = g && !g.hidden ? g.getBoundingClientRect() : null;
  const cs = g ? getComputedStyle(g) : null;
  return {
    glasses: glass.length,
    glassesAnywhere: document.querySelectorAll('.mn-magnify').length,
    btn: btn && { pressed: btn.getAttribute('aria-pressed'), inStrip: !!btn.closest('#help-panel .dock-strip'),
                  group: btn.closest('.dock-group') ? btn.closest('.dock-group').dataset.group : null,
                  after: btn.previousElementSibling ? [...btn.previousElementSibling.classList].join(' ') : '',
                  label: btn.getAttribute('aria-label') || '', title: btn.title },
    size: { x: Math.round(r.width), y: Math.round(r.height) },
    box: { left: r.left, top: r.top },
    centre: gr ? { x: gr.left + gr.width / 2 - r.left, y: gr.top + gr.height / 2 - r.top, d: gr.width } : null,
    z: cs ? cs.zIndex : null,
    pe: cs ? cs.pointerEvents : null,
    cursor: getComputedStyle(box).cursor,
    paneCursor: getComputedStyle(box.querySelector('.leaflet-overlay-pane')).cursor,
    ctlCursor: (() => { const c = box.querySelector('.leaflet-control-container'); return c ? getComputedStyle(c).cursor : null; })(),
    m: MapMagnify.drawn(),
    main: (() => { const c = state.map.getCenter(); return { lat: c.lat, lng: c.lng, z: state.map.getZoom() }; })(),
    // The ground under the glass's centre on the main map, to compare with
    // the glass map's own centre.
    under: (() => {
      const a = MapMagnify.drawn().at;
      if (!a) return null;
      const ll = state.map.containerPointToLatLng([a.x, a.y]);
      return { lat: ll.lat, lng: ll.lng };
    })(),
    mix: state.map.mnBases.mix(),
  };
}

// Degrees in `px` pixels at zoom `z`, for "the same point, to the pixel".
const degPx = (z, px) => px * 360 / (256 * 2 ** z);

async function main() {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];
  try {
    // ═══════════════════════════════════════════════════════════════════════
    log('\nThe switch, and the glass (1440 × 900)\n');
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await openStations(context, server, errors);
    const g = () => page.evaluate(read);
    await page.evaluate(() => state.map.setView([-27.47, 153.02], 12, { animate: false }));
    await settle(page);
    let S = await g();
    check('a switch in the side panel\'s rail, in Tools, after What\'s here?',
      S.btn && S.btn.inStrip && S.btn.group === 'tools' && /mn-map-here/.test(S.btn.after), J(S.btn));
    check('…called Magnifier, saying what it does, and off', S.btn && S.btn.pressed === 'false'
      && /^magnifier/i.test(S.btn.label) && /pins/.test(S.btn.title) && /Shift \+ scroll/.test(S.btn.title), J(S.btn));
    check('…and no glass anywhere until it is on', S.glassesAnywhere === 0 && !S.m.on, J(S.m));

    await page.click('#help-panel .dock-strip .mn-map-magnify');
    await page.waitForTimeout(300);
    S = await g();
    check('pressed: on, and one glass in the map\'s container', S.btn.pressed === 'true' && S.m.on && S.glasses === 1
      && S.glassesAnywhere === 1 && S.m.shown, J({ btn: S.btn, m: S.m }));
    check('…in the middle of the map', S.centre && near(S.centre.x, S.size.x / 2, 2) && near(S.centre.y, S.size.y / 2, 2),
      J({ centre: S.centre, size: S.size }));
    check('…4×, two levels closer than the map', S.m.power === 4 && S.m.zoom === S.m.mainZoom + 2, J(S.m));
    check('…showing the ground under its middle', S.m.centre && S.under
      && near(S.m.centre.lat, S.under.lat, degPx(S.m.mainZoom, 1.5)) && near(S.m.centre.lng, S.under.lng, degPx(S.m.mainZoom, 1.5)),
      J({ glass: S.m.centre, under: S.under }));
    const want = Object.keys(S.mix).filter(n => S.mix[n].on && S.mix[n].op > 0).sort();
    check('…its map holds base-map tiles and nothing else, the bases the map has on',
      S.m.layers > 0 && S.m.layers === S.m.tileLayers && J(S.m.bases.slice().sort()) === J(want), J({ m: S.m, want }));
    const lensStuff = await page.evaluate(() => {
      const el = MapMagnify.map().getContainer();
      return { markers: el.querySelectorAll('.leaflet-marker-icon, .leaflet-tooltip, path, canvas').length,
               panes: [...el.querySelectorAll('.leaflet-pane')].filter(p => p.children.length).map(p => p.className.replace(/leaflet-pane /, '').trim()) };
    });
    check('…no pin, name, line or shape in it', lensStuff.markers === 0
      && lensStuff.panes.every(p => /leaflet-(map|tile)-pane/.test(p)), J(lensStuff));
    // Over that map, the pins as small dots — every pin near the glass's middle
    // on the map is one in the glass.
    const under = await page.evaluate(() => {
      const g = document.querySelector('.mn-magnify').getBoundingClientRect();
      const box = state.map.getContainer().getBoundingClientRect();
      const cx = g.left + g.width / 2 - box.left, cy = g.top + g.height / 2 - box.top;
      let near = 0, r = 0;
      for (const m of state.mapMarkers) {
        if (!m._map) continue;
        const p = state.map.latLngToContainerPoint(m.getLatLng());
        // The glass at 4× shows a quarter of its width of the map.
        if (Math.hypot(p.x - cx, p.y - cy) > g.width / 8) continue;
        near++;
        r = Math.max(r, m.mnRadius || 0);
      }
      const cv = document.querySelector('.mn-magnify-pins');
      const cr = cv.getBoundingClientRect();
      return { near, r, cv: { w: Math.round(cr.width), z: getComputedStyle(cv).zIndex,
               inLens: !!cv.closest('.mn-magnify-lens'), inMap: !!cv.closest('.mn-magnify-map') } };
    });
    check('…the stations under it drawn as small dots, under half their size on the map',
      under.near > 0 && S.m.pins >= under.near && S.m.pinR > 0 && S.m.pinR < under.r / 2,
      J({ under, pins: S.m.pins, pinR: S.m.pinR }));
    check('…on a layer of their own over the glass\'s map and inside its circle, not in that map',
      under.cv.inLens && !under.cv.inMap && under.cv.z === '2' && near(under.cv.w, S.centre.d, 1), J(under.cv));
    // Close in on one station, where the map names the pins in view: its name
    // is in the glass too, faint.
    const named = await page.evaluate(() => {
      const m = state.mapMarkers.find(x => x._map && x.mnStation && x.mnStation.name);
      state.map.setView(m.getLatLng(), 15, { animate: false });
      return m.mnStation.name;
    });
    await settle(page);
    await page.waitForTimeout(250);
    const N = await page.evaluate(() => ({
      m: MapMagnify.drawn(),
      named: state.mapMarkers.filter(m => m._map && m.getTooltip() && m.getTooltip().options.permanent).length,
    }));
    check('…their names, where the map names them, painted faint (a fifth of full strength)',
      N.named > 0 && N.m.pins > 0 && N.m.names > 0 && N.m.nameAlpha > 0 && N.m.nameAlpha <= 0.25,
      J({ named, mapNames: N.named, pins: N.m.pins, names: N.m.names, alpha: N.m.nameAlpha }));
    await page.evaluate(() => state.map.setView([-27.47, 153.02], 12, { animate: false }));
    await settle(page);
    check('…the glass 2 cm (76 px) wider than the 240 px it was', near(S.centre.d, 316, 1), J(S.centre));
    check('…the badge saying how to change it', /^4× · Shift \+ scroll/.test(S.m.badge), J(S.m.badge));
    check('…over the panes and the minimap, under the station card and the corners, taking no pointer',
      S.z === '685' && S.pe === 'none', J({ z: S.z, pe: S.pe }));
    const big = await page.evaluate(() => {
      const el = MapMagnify.map().getContainer();
      const g = el.closest('.mn-magnify').getBoundingClientRect(), r = el.getBoundingClientRect();
      return { glass: Math.round(g.width), map: Math.round(r.width), map2: Math.round(MapMagnify.map().getSize().x) };
    });
    check('…its map twice the glass, and measured at that size', big.map === big.glass * 2 && big.map2 === big.map, J(big));

    // ── Following ──────────────────────────────────────────────────────────
    const P = { x: Math.round(S.box.left + 300), y: Math.round(S.box.top + 260) };
    await page.mouse.move(P.x - 40, P.y - 30);
    await page.mouse.move(P.x, P.y, { steps: 4 });
    await page.waitForTimeout(250);
    S = await g();
    check('a mouse over the map: the glass\'s middle on the pointer',
      S.centre && near(S.centre.x + S.box.left, P.x, 1.5) && near(S.centre.y + S.box.top, P.y, 1.5), J({ centre: S.centre, P }));
    check('…showing the ground under it', near(S.m.centre.lat, S.under.lat, degPx(S.m.mainZoom, 1.5))
      && near(S.m.centre.lng, S.under.lng, degPx(S.m.mainZoom, 1.5)), J({ glass: S.m.centre, under: S.under }));
    check('…the pointer hidden over the map, and back over Leaflet\'s corners',
      S.cursor === 'none' && S.paneCursor === 'none' && S.ctlCursor === 'auto', J({ c: S.cursor, p: S.paneCursor, k: S.ctlCursor }));
    // Over ↺: the glass stays where it was rather than climbing onto the corner.
    const reset = await page.evaluate(() => { const b = document.querySelector('.mn-map-reset').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
    await page.mouse.move(reset.x, reset.y, { steps: 1 });
    await page.waitForTimeout(200);
    const onReset = await g();
    check('…over ↺ the glass waits where it was', near(onReset.centre.x, S.centre.x, 1) && near(onReset.centre.y, S.centre.y, 1),
      J({ was: S.centre, now: onReset.centre }));
    await page.mouse.move(P.x, P.y, { steps: 3 });
    await page.waitForTimeout(200);

    // ── Power ──────────────────────────────────────────────────────────────
    const z0 = (await g()).main.z;
    await page.keyboard.down('Shift');
    await page.mouse.wheel(0, -100);
    await page.keyboard.up('Shift');
    await page.waitForTimeout(400);
    S = await g();
    check('Shift + scroll up: 8×, three levels closer, and the map has not zoomed',
      S.m.power === 8 && S.m.zoom === S.main.z + 3 && S.main.z === z0, J({ m: S.m, z0, main: S.main.z }));
    await page.keyboard.down('Shift');
    await page.mouse.wheel(0, 100);
    await page.keyboard.up('Shift');
    await page.waitForTimeout(400);
    await page.keyboard.down('Shift');
    await page.mouse.wheel(0, 100);
    await page.keyboard.up('Shift');
    await page.waitForTimeout(400);
    S = await g();
    check('…down twice: 2×, one level closer', S.m.power === 2 && S.m.zoom === S.main.z + 1 && S.main.z === z0, J(S.m));
    await page.keyboard.down('Shift');
    await page.mouse.wheel(0, -100);
    await page.keyboard.up('Shift');
    await page.waitForTimeout(400);
    await page.mouse.wheel(0, -50);
    await settle(page);
    await page.waitForTimeout(200);
    S = await g();
    check('a scroll without Shift zooms the map, and the glass stays 4× closer than it',
      S.main.z === z0 + 1 && S.m.power === 4 && S.m.zoom === S.main.z + 2, J({ z0, main: S.main.z, m: S.m }));
    check('…the power remembered on the device', (await page.evaluate(() => localStorage.getItem('mn-magnify'))) === '4');
    // ── The blend ──────────────────────────────────────────────────────────
    const ticked = await page.evaluate(() => {
      const box = document.getElementById('map-display-block');
      const cb = box && box.querySelector('input[type="checkbox"][data-base="Satellite"]');
      if (!cb) return null;
      const was = cb.checked;
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
      return { was };
    });
    // Off the map and back on, as somebody who has just ticked it in Layers.
    await page.mouse.move(1430, 450, { steps: 3 });
    await page.mouse.move(P.x, P.y, { steps: 4 });
    await page.waitForTimeout(300);
    S = await g();
    const want2 = Object.keys(S.mix).filter(n => S.mix[n].on && S.mix[n].op > 0);
    check('a base ticked in Layers is in the glass — Satellite, with the State imagery beside it',
      ticked && S.mix.Satellite.on && S.m.bases.includes('Satellite') && S.m.bases.length === want2.length
        && S.m.tileLayers === want2.length + 2 && S.m.layers === S.m.tileLayers, J({ ticked, bases: S.m.bases, m: S.m, want2 }));

    // At the map's closest, the glass still enlarges — past the map's 19,
    // which Satellite (ticked above) lets the map reach; OSM-Topo stops at 17.
    await page.evaluate(() => state.map.setView([-27.47, 153.02], 19, { animate: false }));
    await settle(page);
    await page.mouse.move(P.x + 2, P.y, { steps: 2 });
    await page.waitForTimeout(250);
    S = await g();
    check('at the map\'s closest (19) the glass still goes closer: 21', S.main.z === 19 && S.m.zoom === 21, J(S.m));
    await page.evaluate(() => state.map.setView([-27.47, 153.02], 12, { animate: false }));
    await settle(page);

    // ── Off ────────────────────────────────────────────────────────────────
    await page.focus('#help-panel .dock-strip .mn-map-magnify');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    S = await g();
    check('Escape puts it away: off, no glass, the pointer back',
      !S.m.on && S.glassesAnywhere === 0 && S.btn.pressed === 'false' && S.cursor !== 'none' && !(await page.evaluate(() => !!MapMagnify.map())),
      J({ m: S.m, n: S.glassesAnywhere, cursor: S.cursor }));
    check('…and the map still in its own full screen state (one press, one thing)',
      await page.evaluate(() => !state.mapFullscreen));
    await page.click('#help-panel .dock-strip .mn-map-magnify');
    await page.waitForTimeout(200);
    await page.click('#help-panel .dock-strip .mn-map-magnify');
    await page.waitForTimeout(200);
    S = await g();
    check('the switch twice: on and off again, nothing left', !S.m.on && S.glassesAnywhere === 0 && S.btn.pressed === 'false', J(S.m));

    // ── The tab ────────────────────────────────────────────────────────────
    await page.click('#help-panel .dock-strip .mn-map-magnify');
    await page.waitForTimeout(200);
    await page.evaluate(() => initMap());
    await settle(page);
    await page.mouse.move(P.x, P.y + 10, { steps: 3 });
    await page.waitForTimeout(300);
    S = await g();
    check('a rebuild of the map keeps it on, with one glass on the new map',
      S.m.on && S.glassesAnywhere === 1 && S.glasses === 1 && S.m.shown && S.btn.pressed === 'true', J({ m: S.m, n: S.glassesAnywhere }));
    await page.evaluate(() => switchTab('home'));
    await page.waitForTimeout(400);
    const gone = await page.evaluate(() => ({ on: MapMagnify.on(), lens: !!MapMagnify.map(), n: document.querySelectorAll('.mn-magnify').length }));
    check('leaving the tab puts it away: off, and its map gone', !gone.on && !gone.lens && gone.n === 0, J(gone));
    await page.evaluate(() => switchTab('stations'));
    await page.waitForFunction(() => !!state.map && !!document.querySelector('.mn-map-magnify'), null, { timeout: LOAD_TIMEOUT });
    await page.waitForTimeout(300);
    S = await g();
    check('…and back on the tab it is off, the switch saying so', !S.m.on && S.glassesAnywhere === 0 && S.btn.pressed === 'false', J(S.m));
    await context.close();

    // ═══════════════════════════════════════════════════════════════════════
    log('\nThe ground\'s own layers (1440 × 900)\n');
    {
      const gctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const gp = await gctx.newPage();
      await applyNetworkPolicy(gp, server.origin);
      gp.on('pageerror', e => errors.push(String(e)));
      const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
      const exports = [];
      await gp.route(/example\.invalid\/arcgis\/MapServer\/export\?/, route => {
        const q = new URL(route.request().url()).searchParams;
        exports.push({ bbox: q.get('bbox'), size: q.get('size'), keep: q.get('dynamicLayers') });
        return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
      });
      await gp.goto(server.origin + '/index.html?tab=stations', { waitUntil: 'load', timeout: LOAD_TIMEOUT });
      await gp.waitForFunction(() => typeof state !== 'undefined' && !!state.map && state.mapMarkers.length > 0,
        null, { timeout: LOAD_TIMEOUT });
      // Out at sea, where the map draws nothing of its own: what is in the
      // glass is what this puts on the map.
      await gp.evaluate(() => state.map.setView([-27.2, 154.6], 15, { animate: false }));
      await settle(gp);
      await gp.evaluate(() => MapMagnify.toggle(true));
      await gp.waitForTimeout(300);
      await gp.evaluate(() => {
        // Round the point under the glass's middle.
        const m = state.map, a = MapMagnify.drawn().at, c = m.containerPointToLatLng([a.x, a.y]);
        for (const n of ['mnLots', 'mnRoads', 'mnSurvey']) if (!m.getPane(n)) m.createPane(n);
        window.__g = {
          // The lots' picture, as a map server's export.
          pic: L.imageOverlay('https://example.invalid/arcgis/MapServer/export?f=image&bboxSR=3857&imageSR=3857&size=100%2C100'
            + '&bbox=1%2C2%2C3%2C4&dynamicLayers=the-lots', m.getBounds().pad(.3), { pane: 'mnLots', opacity: .9 }).addTo(m),
          // A road reserve, a survey mark — and a radio path, which is not the ground's.
          road: L.polygon([[c.lat - .001, c.lng - .001], [c.lat - .001, c.lng + .001], [c.lat + .001, c.lng]],
            { pane: 'mnRoads', renderer: L.svg({ pane: 'mnRoads' }), color: '#ff8800', weight: 2, interactive: false }).addTo(m),
          mark: L.marker(c, { pane: 'mnSurvey', interactive: false, keyboard: false,
            icon: L.divIcon({ className: 'mn-test-mark', html: '<b>PM1</b>', iconSize: [20, 20] }) }).addTo(m),
          path: L.polyline([[c.lat - .002, c.lng - .002], [c.lat + .002, c.lng + .002]], { color: '#00ff00', weight: 4 }).addTo(m),
        };
      });
      await gp.waitForTimeout(900);
      let G = await gp.evaluate(() => {
        const lens = MapMagnify.map(), el = lens.getContainer(), b = lens.getBounds();
        const sw = L.CRS.EPSG3857.project(b.getSouthWest()), ne = L.CRS.EPSG3857.project(b.getNorthEast());
        const cv = document.querySelector('.mn-magnify-pins');
        // Is anything orange (the road reserve's line) or green (the radio path's) on the canvas?
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let orange = 0, green = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] < 120) continue;
          if (d[i] > 200 && d[i + 1] > 90 && d[i + 1] < 180 && d[i + 2] < 60) orange++;
          if (d[i] < 60 && d[i + 1] > 200 && d[i + 2] < 60) green++;
        }
        const copy = document.querySelector('.mn-magnify-marks .mn-test-mark');
        const gr = document.querySelector('.mn-magnify').getBoundingClientRect();
        const cr = copy ? copy.getBoundingClientRect() : null;
        return { g: MapMagnify.drawn().ground, box: [sw.x, sw.y, ne.x, ne.y], size: `${el.clientWidth},${el.clientHeight}`,
                 orange, green, copies: document.querySelectorAll('.mn-magnify-marks > *').length,
                 copyText: copy ? copy.textContent : '',
                 copyOff: cr ? { x: cr.left + cr.width / 2 - (gr.left + gr.width / 2), y: cr.top + cr.height / 2 - (gr.top + gr.height / 2) } : null,
                 inLens: el.querySelectorAll('.leaflet-marker-icon, path').length,
                 imgs: el.querySelectorAll('img.leaflet-image-layer').length };
      });
      check('the map\'s property picture is in the glass', J(G.g.pictures) === J(['mnLots']) && G.imgs >= 1, J(G));
      const last = exports[exports.length - 1];
      const bb = last ? last.bbox.split(',').map(Number) : [];
      check('…asked again for the glass\'s own box at its own size, the rest of the request kept',
        !!last && last.size === G.size && last.keep === 'the-lots' && bb.length === 4 && bb.every((v, i) => near(v, G.box[i], 1)),
        J({ last, G }));
      check('…and once that has come, the stretched copy of the map\'s picture is put away',
        J(G.g.sharp) === J(['mnLots']) && G.g.softShown.length === 0, J(G.g));
      check('a road reserve the map draws is painted in the glass, in its own colour', G.g.paths === 1 && G.orange > 20, J(G));
      check('…a radio path is not', G.green === 0, J({ green: G.green }));
      check('a survey mark is copied in, at the glass\'s middle where its point is',
        G.g.marks === 1 && G.copies === 1 && G.copyText === 'PM1' && G.copyOff && Math.abs(G.copyOff.x) < 3 && Math.abs(G.copyOff.y) < 3, J(G));
      check('…and none of it is a layer in the glass\'s map but the picture', G.inLens === 0, J(G));
      await gp.mouse.move(700, 450);
      await gp.waitForTimeout(700);
      const n0 = exports.length;
      await gp.mouse.move(712, 458, { steps: 3 });
      await gp.waitForTimeout(700);
      G = await gp.evaluate(() => MapMagnify.drawn().ground);
      check('a small move of the glass asks for no new picture', exports.length === n0 && J(G.sharp) === J(['mnLots']), J({ n0, n: exports.length, G }));
      await gp.evaluate(() => { for (const l of Object.values(window.__g)) l.remove(); });
      await gp.waitForTimeout(400);
      const gone = await gp.evaluate(() => ({ g: MapMagnify.drawn().ground,
        copies: document.querySelectorAll('.mn-magnify-marks > *').length,
        imgs: MapMagnify.map().getContainer().querySelectorAll('img.leaflet-image-layer').length }));
      check('taken off the map, they are out of the glass',
        gone.g.pictures.length === 0 && gone.g.paths === 0 && gone.g.marks === 0 && gone.copies === 0 && gone.imgs === 0, J(gone));
      await gctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════════
    log('\nA phone (375 × 740, touch)\n');
    const phone = await browser.newContext({ viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true });
    const pp = await openStations(phone, server, errors);
    const hoverNone = await pp.evaluate(() => matchMedia('(hover: none)').matches);
    check('the phone has no hover', hoverNone);
    await pp.evaluate(() => MapMagnify.toggle(true));
    await pp.waitForTimeout(300);
    let T = await pp.evaluate(read);
    check('on: one glass, in the middle, taking the finger, and the pointer not hidden',
      T.glasses === 1 && T.m.shown && T.pe === 'auto' && T.cursor !== 'none'
        && near(T.centre.x, T.size.x / 2, 2) && near(T.centre.y, T.size.y / 2, 2), J({ T: T.m, pe: T.pe, c: T.centre, s: T.size }));
    check('…the badge saying to tap it', /tap the glass/.test(T.m.badge), J(T.m.badge));
    // A drag, as a finger's pointer events on the glass.
    const before = T.main;
    await pp.evaluate(() => {
      const g = document.querySelector('.mn-magnify');
      const r = g.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const ev = (type, dx, dy) => g.dispatchEvent(new PointerEvent(type, {
        pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true,
        clientX: x + dx, clientY: y + dy, button: 0, buttons: type === 'pointerup' ? 0 : 1 }));
      ev('pointerdown', 0, 0);
      ev('pointermove', -20, -15);
      ev('pointermove', -60, -50);
      ev('pointerup', -60, -50);
    });
    await pp.waitForTimeout(300);
    T = await pp.evaluate(read);
    check('dragged: the glass moved with the finger, and the map did not',
      near(T.centre.x, T.size.x / 2 - 60, 2) && near(T.centre.y, T.size.y / 2 - 50, 2)
        && T.main.lat === before.lat && T.main.lng === before.lng && T.main.z === before.z,
      J({ c: T.centre, s: T.size, before, after: T.main }));
    const p0 = T.m.power;
    await pp.evaluate(() => {
      const g = document.querySelector('.mn-magnify');
      const r = g.getBoundingClientRect();
      const o = { pointerId: 8, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true,
                  clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
      g.dispatchEvent(new PointerEvent('pointerdown', { ...o, buttons: 1 }));
      g.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
    });
    await pp.waitForTimeout(250);
    T = await pp.evaluate(read);
    check('tapped: the power steps (4× → 8×)', p0 === 4 && T.m.power === 8 && T.m.zoom === T.main.z + 3, J({ p0, m: T.m }));
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
  log('\nPASS — the Stations map\'s magnifier shows the ground under the pins, the pins small\n'
    + '       and their names faint, the ground\'s own layers and no radio path,\n'
    + '       follows the mouse or the finger, changes its power without zooming the map,\n'
    + '       and goes away with Escape and with the tab.');
}

main().catch(err => { console.error(err); process.exit(1); });
