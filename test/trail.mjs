// The station trail (station-trail.js): the stations looked at this session,
// as a pill in the Stations map's top row, driven in a real browser.
//
//   1. **What goes on it** — a pin click, a row, a callout tapped on a phone,
//      a twin opened: the station to the head of the trail, the latest first,
//      each once. Kept for the session (a reload keeps it, a new session does
//      not), capped, and a station the loaded file does not carry is not
//      shown.
//   2. **The pill** — nothing until a station has been looked at; then one row
//      in the map's top row, right of the zoom buttons and short of ↺, naming
//      the station the card was last on, however long its name. Pressed after
//      the card was closed, it brings the card back and drops the list.
//   3. **The list** — the trail, the pill's station first and marked as such;
//      a pick selects the station, puts the card on it and the map on it,
//      zoomed in, and moves it to the head; Escape, a press elsewhere and a
//      pick put the list away, and focus that was in it lands on the pill.
//      The arrow keys walk it. A station the filters leave out is picked all
//      the same, the filters narrowed to it.
//   4. **The twin** (skipped without WebGL) — the pill at the top of the
//      twin's stage, right of the flood scale's column, the card's top kept
//      below it; a pick from the list takes the twin to that station; the map
//      back, the pill back beside the zoom buttons.
//   5. **The phone** — a tapped pin's callout goes on the trail, the pill is a
//      zoom button's height and a finger's reach, and the list stays on the
//      map, in the twin moved left to fit.
//
// Why a check of its own: every failure here is a page that looks right. A
// trail that forgets a station, lists one twice, or keeps the order of the
// first look rather than the last; a pill that drops under the card it is
// meant to bring back, or wraps to two rows over the map; a pick that moves
// the map and leaves the old station selected — none of them throws.
//
// Run:  npm run trail
//       npm run trail -- -v

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { tiffF32, snapExtent } from './lib/geotiff.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT  = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const BUILD_TIMEOUT = Number(process.env.TWIN_TIMEOUT || 90_000);

const log  = (...a) => console.log(...a);
const vlog = (...a) => { if (VERBOSE) console.log(...a); };

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok: !!ok, detail });
  log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (ok && detail) vlog(`      ${detail}`);
}
const J = v => JSON.stringify(v);

// Open the app in a fresh context (a fresh session: sessionStorage starts
// empty) and land on the Stations tab with the map built and settled.
async function openStations(browser, server, errors, contextOpts, context = null) {
  context = context || await browser.newContext(contextOpts);
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  // The twin's ground: flat, at 98 m — under Gatton's major level, so its
  // flood scale is up.
  await page.route(/QldDem\/ImageServer\/exportImage/, route => {
    const u = new URL(route.request().url());
    const bbox = (u.searchParams.get('bbox') || '').split(',').map(Number);
    const [W, H] = (u.searchParams.get('size') || '0,0').split(',').map(Number);
    const extent = snapExtent(bbox, W, H, u.searchParams.get('adjustAspectRatio'));
    return route.fulfill({ status: 200, contentType: 'image/tiff', body: tiffF32(W, H, extent, () => 98),
      headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await page.waitForFunction(
    () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => { if (typeof setNavCollapsed === 'function' && isPhoneNav()) setNavCollapsed(true); });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0, null, { timeout: LOAD_TIMEOUT });
  await settle(page);
  return { context, page };
}

// Leaflet ignores a setView while a zoom animation runs.
async function settle(page) {
  await page.waitForFunction(() => !state.map._animatingZoom
    && !(state.map._panAnim && state.map._panAnim._inProgress), null, { timeout: 10_000 });
  await page.waitForTimeout(150);
}

// A pin click, the way stn-card.mjs makes one: on a station with no other
// within ~500 m, zoomed onto it, so the click opens rather than fans a stack.
const clickLonePin = n => `(() => {
  const near = (a, b) => Math.abs(a.lat - b.lat) < 0.005 && Math.abs(a.lon - b.lon) < 0.005;
  const all = state.data.stations.filter(x => x.lat != null && x.lon != null);
  const s = all.filter(x => !all.some(y => y !== x && near(x, y)))[${n}];
  const m = state.mapMarkers.find(x => x.mnStationId === s.id);
  state.map.setView(m.getLatLng(), 14, { animate: false });
  m.fire('click', { originalEvent: new MouseEvent('click'), latlng: m.getLatLng() });
  return s.id;
})()`;

// Where the pill and its list are, against what they stand beside.
const geometry = `(() => {
  const r = el => { if (!el) return null; const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height }; };
  const root = document.getElementById('stn-trail');
  const stage = document.querySelector('.mn-map-stage');
  const card = document.getElementById('stn-card');
  return {
    hidden: !root || root.hidden || getComputedStyle(root).display === 'none',
    pill: r(document.getElementById('stn-trail-pill')),
    drop: document.getElementById('stn-trail-drop') && !document.getElementById('stn-trail-drop').hidden ? r(document.getElementById('stn-trail-drop')) : null,
    stage: r(stage),
    zoom: r(document.querySelector('.mn-map-stage .leaflet-top.leaflet-left .leaflet-control')),
    reset: r(document.querySelector('.mn-map-stage .leaflet-top.leaflet-right .leaflet-control')),
    card: card && !card.hidden ? r(card) : null,
    twinStage: r(document.querySelector('#map-twin.is-on #twin-stage')),
    scale: r(document.querySelector('#map-twin.is-on #twin-flood-scale')),
    scaleHead: r(document.querySelector('#map-twin.is-on .twin-scale-head')),
    compass: r(document.querySelector('#map-twin.is-on #twin-compass')),
    name: (document.querySelector('#stn-trail-pill .stn-trail-name') || {}).textContent || null,
    label: (document.getElementById('stn-trail-pill') || { getAttribute: () => null }).getAttribute('aria-label'),
    expanded: (document.getElementById('stn-trail-pill') || { getAttribute: () => null }).getAttribute('aria-expanded'),
    title: (document.getElementById('stn-trail-pill') || {}).title || null,
    items: [...document.querySelectorAll('#stn-trail-drop .stn-trail-item')].map(b => ({ id: b.dataset.sid,
      current: b.getAttribute('aria-current') === 'true', name: b.querySelector('.stn-trail-item-name').textContent })),
    focus: document.activeElement && (document.activeElement.id || document.activeElement.className || document.activeElement.tagName),
  };
})()`;

async function main() {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];
  try {
    // ═══════════════════════════════════════════════════════════════════════
    log('\nWhat goes on the trail, and the pill in the map\'s top row (1440 × 900)\n');
    const { context, page } = await openStations(browser, server, errors, { viewport: { width: 1440, height: 900 } });
    const g = () => page.evaluate(geometry);

    let G = await g();
    check('a fresh session: no pill until a station has been looked at', G.hidden && (await page.evaluate(() => StationTrail.ids().length)) === 0);

    const a = await page.evaluate(clickLonePin(0));
    const b = await page.evaluate(clickLonePin(1));
    const c = await page.evaluate(clickLonePin(2));
    await page.waitForTimeout(100);
    G = await g();
    let ids = await page.evaluate(() => StationTrail.ids());
    check('three pins clicked: each on the trail, the latest first', J(ids) === J([c, b, a]), J(ids));
    const cName = await page.evaluate(id => state.data.stations.find(s => s.id === id).name, c);
    check('the pill is up, naming the station the card is on, with the rest counted', !G.hidden && G.name === cName
      && /\+2/.test(await page.evaluate(() => document.getElementById('stn-trail-pill').textContent)), J({ name: G.name, cName }));
    check('…right of the zoom buttons and level with their top, and short of ↺',
      G.pill.left >= G.zoom.right + 4 && G.pill.left <= G.zoom.right + 12 && Math.abs(G.pill.top - G.zoom.top) <= 1
        && G.pill.right <= G.reset.left - 4, J({ pill: G.pill, zoom: G.zoom, reset: G.reset }));
    check('…one row, a zoom button\'s height', G.pill.height >= 30 && G.pill.height <= 40, `${G.pill.height} px`);
    check('…and clear of the card, which stays under the zoom buttons', !G.card || G.card.top >= G.pill.bottom, J({ card: G.card, pill: G.pill }));

    // Looked at again: back to the top, once.
    await page.evaluate(id => showStationCard(id), a);
    ids = await page.evaluate(() => StationTrail.ids());
    check('a station looked at again goes back to the top, and is on the trail once', J(ids) === J([a, c, b]), J(ids));
    // A row in the list is a look as well.
    await page.evaluate(id => selectStation(id), b);
    ids = await page.evaluate(() => StationTrail.ids());
    check('a row selected in the station list goes on it too', ids[0] === b && ids.length === 3, J(ids));

    // The longest name in the file, on the pill: one row still, and short of ↺.
    const longest = await page.evaluate(() => state.data.stations.filter(s => s.lat != null)
      .reduce((m, s) => (s.name.length > m.name.length ? s : m)).id);
    await page.evaluate(id => showStationCard(id), longest);
    G = await g();
    check('the longest name in the file keeps the pill to one row, short of ↺, with an ellipsis',
      G.pill.height <= 40 && G.pill.right <= G.reset.left - 4
        && await page.evaluate(() => { const n = document.querySelector('#stn-trail-pill .stn-trail-name'); return n.scrollWidth > n.clientWidth || n.getBoundingClientRect().right <= document.getElementById('stn-trail-pill').getBoundingClientRect().right; }),
      J({ pill: G.pill, reset: G.reset }));

    // ── The card back ──
    await page.evaluate(id => showStationCard(id), c);
    await page.click('#stn-card .acma-card-head button');
    G = await g();
    check('the card closed: the pill stays, and says it brings the card back', !G.hidden && G.card === null
      && G.title.startsWith(`${cName}'s card again`), G.title);
    await page.click('#stn-trail-pill');
    G = await g();
    check('pressed, the pill brings the card back on its station…', G.card !== null
      && (await page.evaluate(() => state.stnCard.id)) === c);
    check('…and drops the list under it: the trail in order, its station first and marked',
      G.expanded === 'true' && G.drop && G.drop.top >= G.pill.bottom
        && J(G.items.map(i => i.id)) === J(await page.evaluate(() => StationTrail.ids()))
        && G.items[0].id === c && G.items[0].current && G.items.slice(1).every(i => !i.current), J(G.items));
    check('…over the card', await page.evaluate(() => {
      const d = document.getElementById('stn-trail-drop').getBoundingClientRect();
      const x = d.left + 20, y = d.top + d.height / 2;
      const hit = document.elementFromPoint(x, y);
      return !!hit && !!hit.closest('#stn-trail-drop');
    }));
    check('nothing moved focus into the card for a press on the pill', G.focus === 'stn-trail-pill', G.focus);

    // Escape, and focus — in full screen, which leaves on an unclaimed Escape.
    await page.evaluate(() => toggleMapFullscreen(true));
    await page.waitForTimeout(150);
    if (!(await page.evaluate(() => StationTrail.isOpen()))) await page.click('#stn-trail-pill');
    await page.focus('.stn-trail-item[data-sid="' + b + '"]');
    await page.keyboard.press('Escape');
    G = await g();
    check('Escape puts the list away and gives focus to the pill', G.drop === null && G.expanded === 'false' && G.focus === 'stn-trail-pill', J({ drop: G.drop, focus: G.focus }));
    check('…and the full-screen map stays full screen: the list took the key', await page.evaluate(() => state.mapFullscreen === true));
    await page.keyboard.press('Escape');
    check('…the next Escape is the map\'s', await page.evaluate(() => state.mapFullscreen === false));
    await page.waitForTimeout(150);
    await page.focus('#stn-trail-pill');
    // The keys.
    await page.keyboard.press('ArrowDown');
    G = await g();
    check('↓ on the pill drops the list and goes to its first station', G.drop !== null && G.focus.includes('stn-trail-item')
      && (await page.evaluate(() => document.activeElement.dataset.sid)) === G.items[0].id);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    const third = await page.evaluate(() => document.activeElement.dataset.sid);
    await page.keyboard.press('ArrowUp');
    const second = await page.evaluate(() => document.activeElement.dataset.sid);
    check('↓ and ↑ walk the list', third === G.items[2].id && second === G.items[1].id, J({ third, second }));
    await page.keyboard.press('End');
    const last = await page.evaluate(() => document.activeElement.dataset.sid);
    await page.keyboard.press('Home');
    const first = await page.evaluate(() => document.activeElement.dataset.sid);
    check('Home and End go to its ends', last === G.items[G.items.length - 1].id && first === G.items[0].id);

    // A press elsewhere.
    await page.mouse.click(G.stage.right - 60, G.stage.bottom - 60);
    G = await g();
    check('a press on the map puts the list away', G.drop === null && !(await page.evaluate(() => StationTrail.isOpen())));

    // ── A pick ──
    await page.evaluate(() => state.map.setView([-25.6, 134.3], 6, { animate: false }));
    await settle(page);
    await page.click('#stn-trail-pill');
    await page.click(`.stn-trail-item[data-sid="${a}"]`);
    await settle(page);
    const after = await page.evaluate(id => {
      const s = state.data.stations.find(x => x.id === id);
      const b = state.map.getBounds();
      return { sel: state.selectedId, card: state.stnCard.id, zoom: state.map.getZoom(), inView: b.contains([s.lat, s.lon]),
               ids: StationTrail.ids(), open: StationTrail.isOpen(), focus: document.activeElement.id,
               row: !!document.querySelector(`#stations-table-wrap tr[data-sid="${CSS.escape(id)}"].selected, #stations-table-wrap tr[data-sid="${CSS.escape(id)}"][aria-selected="true"]`) || state.selectedId === id,
               editor: state.editorId };
    }, a);
    check('a pick selects the station — the list and the editor with it', after.sel === a && after.editor === a, J(after));
    check('…puts its card up and the map on it, zoomed in', after.card === a && after.inView && after.zoom >= 15, J(after));
    check('…moves it to the head of the trail', after.ids[0] === a && after.ids.length === 4, J(after.ids));
    check('…and puts the list away, focus on the pill', !after.open && after.focus === 'stn-trail-pill', J(after));
    const zNow = await page.evaluate(() => { state.map.setZoom(17, { animate: false }); return state.map.getZoom(); });
    await settle(page);
    await page.click('#stn-trail-pill');
    await page.click(`.stn-trail-item[data-sid="${c}"]`);
    await settle(page);
    check('a pick from closer in stays as close', (await page.evaluate(() => state.map.getZoom())) === zNow);

    // A station the filters leave out.
    await page.evaluate(() => { resetStationFilters(); state.filters.searches = [newSearchRow('zzzz no such station')]; renderMain(); });
    await page.waitForFunction(() => !!state.map && !!document.getElementById('stn-trail-pill'), null, { timeout: LOAD_TIMEOUT });
    await settle(page);
    G = await g();
    check('the tab re-rendered: the pill is back, still naming the station', !G.hidden && G.name === cName, G.name);
    await page.click('#stn-trail-pill');
    await page.click(`.stn-trail-item[data-sid="${b}"]`);
    await page.waitForFunction(id => state.selectedId === id && state.stnCard.id === id, b, { timeout: LOAD_TIMEOUT });
    const narrowed = await page.evaluate(id => ({ listed: tableStations().some(s => s.id === id), focus: document.activeElement.id }), b);
    check('a station the filters leave out is picked all the same, the filters narrowed to it', narrowed.listed, J(narrowed));
    check('…and focus lands on the pill the re-render drew', narrowed.focus === 'stn-trail-pill', narrowed.focus);
    await page.evaluate(() => { resetStationFilters(); renderMain(); });
    await page.waitForFunction(() => !!state.map && !!document.getElementById('stn-trail-pill'), null, { timeout: LOAD_TIMEOUT });
    await settle(page);

    // A station not in the file.
    const gone = await page.evaluate(id => {
      const i = state.data.stations.findIndex(s => s.id === id);
      const [s] = state.data.stations.splice(i, 1);
      StationTrail.sync();
      const out = { ids: StationTrail.ids(), shown: StationTrail.shownIds() };
      state.data.stations.splice(i, 0, s);
      StationTrail.sync();
      return out;
    }, c);
    check('a station the loaded file does not carry is not shown, and is kept', !gone.shown.includes(c) && gone.ids.includes(c), J(gone));

    // The session.
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
    await page.evaluate(() => switchTab('stations'));
    await page.waitForFunction(() => !!state.map, null, { timeout: LOAD_TIMEOUT });
    const reloaded = await page.evaluate(() => ({ ids: StationTrail.ids(), hidden: document.getElementById('stn-trail').hidden, card: state.stnCard.id }));
    check('a reload keeps the trail and the pill — the session is the tab\'s', reloaded.ids.length === 4 && !reloaded.hidden && reloaded.card === null, J(reloaded));
    const cap = await page.evaluate(() => {
      for (const s of state.data.stations.slice(0, StationTrail.max + 5)) StationTrail.visit(s.id);
      return StationTrail.ids().length;
    });
    check(`the trail keeps the latest ${await page.evaluate(() => StationTrail.max)}`, cap === await page.evaluate(() => StationTrail.max), String(cap));
    await context.close();

    const other = await openStations(browser, server, errors, { viewport: { width: 1440, height: 900 } });
    check('a new session starts with none', (await other.page.evaluate(() => StationTrail.ids().length)) === 0
      && (await other.page.evaluate(() => document.getElementById('stn-trail').hidden)));
    await other.context.close();

    // ═══════════════════════════════════════════════════════════════════════
    log('\nIn the twin (1440 × 900)\n');
    {
      const { context, page } = await openStations(browser, server, errors, { viewport: { width: 1440, height: 900 } });
      const gl = await page.evaluate(() => { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); });
      if (!gl) {
        log('  SKIP — this Chromium has no WebGL; the twin cannot be built here.');
      } else {
        const g = () => page.evaluate(geometry);
        await page.evaluate(() => DigitalTwin._infoFold(null));
        await page.evaluate(() => { showStationCard('abbieglassie_al'); showStationCard('gatton'); state.map.setView([-27.555, 152.275], 18, { animate: false }); });
        await page.waitForFunction(() => { const el = document.getElementById('map-twin-offer'); return !!el && !el.hidden; }, null, { timeout: LOAD_TIMEOUT });
        await page.click('#map-twin-offer .map-twin-offer-open');
        await page.waitForFunction(() => { const d = DigitalTwin.debug(); return MapTwin.active() && d.built && !d.status.endsWith('…') && d.flood && !d.flood.none; }, null, { timeout: BUILD_TIMEOUT });
        await page.waitForFunction(() => { const b = document.getElementById('twin-flood-scale'); return b && !b.hidden; }, null, { timeout: BUILD_TIMEOUT });
        await page.waitForTimeout(300);
        let T = await g();
        check('the twin up: the pill at the top of its stage, right of the flood scale\'s column',
          !T.hidden && Math.abs(T.pill.top - (T.twinStage.top + 8)) <= 1.5 && T.pill.left >= T.scale.right + 4 && T.pill.left <= T.scale.right + 12,
          J({ pill: T.pill, stage: T.twinStage, scale: T.scale }));
        check('…level with the scale\'s head, and short of the compass', Math.abs(T.pill.top - T.scaleHead.top) <= 2 && T.pill.right <= T.compass.left - 4,
          J({ pill: T.pill, head: T.scaleHead, compass: T.compass }));
        check('…the scale where it was, at the stage\'s top left', Math.abs(T.scale.left - (T.twinStage.left + 8)) <= 1.5 && Math.abs(T.scale.top - (T.twinStage.top + 8)) <= 1.5);
        check('…and the card\'s top kept below the pill', T.card && T.card.top >= T.pill.bottom, J({ card: T.card, pill: T.pill }));
        await page.click('#stn-trail-pill');
        T = await g();
        check('the list drops down over the card and the twin', T.drop && await page.evaluate(() => {
          const d = document.getElementById('stn-trail-drop').getBoundingClientRect();
          const hit = document.elementFromPoint(d.left + 20, d.top + d.height / 2);
          return !!hit && !!hit.closest('#stn-trail-drop');
        }));
        await page.click('.stn-trail-item[data-sid="abbieglassie_al"]');
        await page.waitForFunction(() => MapTwin.active() && MapTwin.station() === 'abbieglassie_al', null, { timeout: BUILD_TIMEOUT });
        const went = await page.evaluate(() => ({ sel: state.selectedId, card: state.stnCard.id, twin: MapTwin.station(), ids: StationTrail.ids() }));
        check('a pick in the twin takes the twin to that station, selected and on the card', went.sel === 'abbieglassie_al' && went.card === 'abbieglassie_al'
          && went.ids[0] === 'abbieglassie_al', J(went));
        await page.evaluate(() => MapTwin.leave());
        await page.waitForTimeout(200);
        T = await g();
        check('the map back: the pill back beside the zoom buttons', !T.twinStage && T.pill.left >= T.zoom.right + 4 && Math.abs(T.pill.top - T.zoom.top) <= 1, J({ pill: T.pill, zoom: T.zoom }));
      }
      await context.close();
    }

    // ═══════════════════════════════════════════════════════════════════════
    log('\nA phone in the hand (393 × 760, touch)\n');
    {
      const { context, page } = await openStations(browser, server, errors,
        { viewport: { width: 393, height: 760 }, hasTouch: true, isMobile: true });
      const g = () => page.evaluate(geometry);
      const tapped = await page.evaluate(clickLonePin(3));
      await page.waitForTimeout(100);
      let P = await g();
      const popup = await page.evaluate(() => !!document.querySelector('.leaflet-popup'));
      check('a tapped pin opens its callout, and goes on the trail', popup && (await page.evaluate(() => StationTrail.ids()[0])) === tapped && !P.hidden);
      check('the pill is a zoom button\'s height, beside them', P.pill.height >= 30 && P.pill.height <= 40 && P.pill.left >= P.zoom.right + 4, J({ pill: P.pill, zoom: P.zoom }));
      const reach = await page.evaluate(() => {
        const p = document.getElementById('stn-trail-pill').getBoundingClientRect();
        const at = y => { const e = document.elementFromPoint(p.left + p.width / 2, y); return !!e && !!e.closest('#stn-trail-pill'); };
        return { above: at(p.top - 3), below: at(p.bottom + 3) };
      });
      check('…and a finger lands on it a little above and below it', reach.above && reach.below, J(reach));
      await page.tap('#stn-trail-pill');
      P = await g();
      check('tapped, it brings the card up as a sheet and drops the list', (await page.evaluate(() => state.stnCard.id)) === tapped && P.drop);
      check('…the list on the map, over the sheet', P.drop.right <= P.stage.right + 0.5 && P.drop.left >= P.stage.left - 0.5
        && await page.evaluate(() => { const d = document.getElementById('stn-trail-drop').getBoundingClientRect(); const e = document.elementFromPoint(d.left + 20, d.bottom - 10); return !!e && !!e.closest('#stn-trail-drop'); }),
        J({ drop: P.drop, stage: P.stage }));
      await page.tap('.leaflet-container', { position: { x: 200, y: 300 } }).catch(() => {});

      const gl = await page.evaluate(() => { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); });
      if (gl) {
        await page.evaluate(() => DigitalTwin._infoFold(null));
        await page.evaluate(() => { showStationCard('abbieglassie_al'); showStationCard('gatton'); state.map.setView([-27.555, 152.275], 18, { animate: false }); });
        await page.waitForFunction(() => { const el = document.getElementById('map-twin-offer'); return !!el && !el.hidden; }, null, { timeout: LOAD_TIMEOUT });
        await page.tap('#map-twin-offer .map-twin-offer-open');
        await page.waitForFunction(() => { const d = DigitalTwin.debug(); return MapTwin.active() && d.built && !d.status.endsWith('…'); }, null, { timeout: BUILD_TIMEOUT });
        await page.waitForTimeout(300);
        await page.evaluate(() => closeStnCard());
        P = await g();
        check('in a phone\'s twin the pill is between the scale\'s column and the compass, the name alone on it',
          P.pill.left >= P.twinStage.left + 8 && P.pill.right <= P.compass.left - 4
            && await page.evaluate(() => getComputedStyle(document.querySelector('#stn-trail .stn-trail-ico')).display === 'none'),
          J({ pill: P.pill, compass: P.compass, stage: P.twinStage }));
        await page.tap('#stn-trail-pill');
        P = await g();
        check('…and its list moved left until it is on the map, as wide as the names want', P.drop && P.drop.right <= P.stage.right + 0.5
          && P.drop.left < P.pill.left && P.drop.width >= 280, J({ drop: P.drop, pill: P.pill, stage: P.stage }));
      } else {
        log('  SKIP — no WebGL for the phone\'s twin.');
      }
      await context.close();
    }

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
  log('\nPASS — the stations looked at this session are a pill in the map\'s top row that\n'
    + '       brings the card back and goes back to any of them, on the map, in the twin\n'
    + '       and on a phone.');
}

main().catch(err => { console.error(err); process.exit(1); });
