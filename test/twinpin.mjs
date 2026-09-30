// Moving a station's pin where the ground can be seen: in the Digital Twin —
// on its own tab, and inside the Stations map — and in ⛰️ 3-D.
//
// Why a check of its own. `movepin` drives the mode on the flat map, and it
// is right there. Everywhere else the mode used to arm, put its panel in the
// map's corner, and leave the pin under a WebGL canvas that covered it: out
// of sight, out of reach, and — in 3-D — moved by a click on the ground to
// the *flat* map's coordinate for that pixel, which on a tilted camera is not
// the ground the operator pointed at. Every one of those looks like a mode
// that works: the panel is there, the numbers change. So what is asserted is
// the pin itself, in each renderer, and the coordinate each hands back.
//
//   The twin's tab   📍 arms the mode with no map under it; an amber post
//                    stands on the ground at the station; a real pointer drags
//                    it across the terrain and the readout follows to the
//                    centimetre (the ground point back through the inverse of
//                    the twin's own projection); a click on the ground puts it
//                    there; Escape ends the move and not the twin; Save writes
//                    the database's *current* copy of the station with only
//                    the position changed and none of its lists — against the
//                    stamp that copy came with — refuses to write signed out,
//                    and rebuilds the twin on the new spot.
//   In the map       the overlay's 📍 arms the same mode on the map; its panel
//                    is on the stage and the map's own stands down; a click on
//                    the twin's ground moves the pin; Escape ends the move and
//                    leaves the twin up.
//   ⛰️ 3-D           armed, the pin is on the terrain as a draggable marker at
//                    the station, with its leader and ring; a click on the
//                    ground moves it to the camera's own coordinate for that
//                    pixel — not Leaflet's; a real drag of the marker moves it;
//                    cancelling takes it away.
//
// The world: the twin's ground and imagery are answered as `twinsite` answers
// them; the 3-D view's terrain and base tiles as `map3d` answers them. Nothing
// here signs in or writes to a database — the datastore is stubbed at
// dbSelect and dbSaveStation, and what the save sends is the assertion.
//
// Needs WebGL2; skips rather than fails if that is ever absent.
//
//   node --run twinpin        (or: npm run twinpin)
//       npm run twinpin -- -v    also print what passed

import fs from 'node:fs';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { tiffF32, snapExtent } from './lib/geotiff.mjs';
import { hillyTerrariumPng, flatTerrariumPng } from './lib/terrarium.mjs';
import { repo } from './lib/paths.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT  = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const BUILD_TIMEOUT = Number(process.env.TWIN_TIMEOUT || 90_000);
const GL_TIMEOUT    = Number(process.env.MAP3D_TIMEOUT || 45_000);

let failures = 0, passes = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passes++; if (VERBOSE) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};
const near = (a, b, tol) => a != null && b != null && isFinite(a) && isFinite(b) && Math.abs(a - b) <= tol;
const section = t => console.log(`\n${t}\n`);
const J = v => JSON.stringify(v);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const STATIONS = JSON.parse(fs.readFileSync(repo('stations.json'), 'utf8')).stations;
const GATTON = STATIONS.find(s => s.id === 'gatton');

// The twin's ground: a gentle slope and a creek, about wherever CUR is.
let CUR = { lat: GATTON.lat, lon: GATTON.lon };
const M_LAT = 110574, M_LON = () => 111320 * Math.cos(CUR.lat * Math.PI / 180);
const valley = (x, z) => 90.5 - 5.5 * Math.exp(-(((x + 30) / 8) ** 2)) + 0.02 * z;
const groundAt = (lat, lon) => valley((lon - CUR.lon) * M_LON(), -(lat - CUR.lat) * M_LAT);

const server = await startServer();
const browser = await launchBrowser();
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  const cors = { 'Access-Control-Allow-Origin': '*' };
  await page.route(/QldDem\/ImageServer\/exportImage/, route => {
    const u = new URL(route.request().url());
    const bbox = (u.searchParams.get('bbox') || '').split(',').map(Number);
    const [W, H] = (u.searchParams.get('size') || '0,0').split(',').map(Number);
    const extent = snapExtent(bbox, W, H, u.searchParams.get('adjustAspectRatio'));
    const pw = (extent[2] - extent[0]) / W, ph = (extent[3] - extent[1]) / H;
    return route.fulfill({ status: 200, contentType: 'image/tiff', headers: cors,
      body: tiffF32(W, H, extent, (x, y) => groundAt(extent[3] - (y + 0.5) * ph, extent[0] + (x + 0.5) * pw)) });
  });
  await page.route(/LatestStateProgram_AllUsers\/ImageServer\/exportImage/, route =>
    route.fulfill({ status: 200, contentType: 'image/png', body: hillyTerrariumPng(14, 15000, 9000), headers: cors }));
  await page.route(/LatestStateProgram_AllUsers\/ImageServer\/query/, route =>
    route.fulfill({ status: 200, contentType: 'application/json', headers: cors,
      body: J({ features: [{ attributes: { name: 'Lockyer_Valley_Urban_2021_10cm_SISP', lowps: 0.1, capturestart: Date.UTC(2021, 4, 15) } }] }) }));
  await page.route(/RoadsAndTracks\/MapServer\/22\/query|OtherTransport\/MapServer\/160\/query/, route =>
    route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: J({ features: [] }) }));
  // The 3-D view's world: terrain with hills in it, and a plain base.
  await page.route(/elevation-tiles-prod\/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/, route => {
    const m = /terrarium\/(\d+)\/(\d+)\/(\d+)\.png/.exec(route.request().url());
    return route.fulfill({ status: 200, contentType: 'image/png', headers: cors, body: hillyTerrariumPng(+m[1], +m[2], +m[3]) });
  });
  await page.route(/(tile\.openstreetmap\.org|tile\.opentopomap\.org|server\.arcgisonline\.com)/, route =>
    route.fulfill({ status: 200, contentType: 'image/png', body: flatTerrariumPng(0), headers: cors }));
  page.on('pageerror', e => errors.push(e.stack || e.message));

  await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations), null, { timeout: LOAD_TIMEOUT });
  const gl = await page.evaluate(() => { const c = document.createElement('canvas'); return !!c.getContext('webgl2'); });
  if (!gl) {
    console.log('\n  SKIP — this Chromium has no WebGL2; the twin and the 3-D view cannot be exercised here.');
  } else {
    await page.evaluate(() => DigitalTwin._infoFold(null));
    const built = id => page.waitForFunction(i => {
      const d = DigitalTwin.debug();
      return d.built && d.stationId === i && !d.status.endsWith('…');
    }, id, { timeout: BUILD_TIMEOUT });
    const drawn = () => page.evaluate(() => MapMovePin.drawn());
    const panel = () => page.evaluate(() => {
      const p = document.getElementById('twin-movepin-panel');
      if (!p) return null;
      const dds = [...p.querySelectorAll('dd')].map(d => d.textContent.trim());
      return { hidden: p.hidden || getComputedStyle(p).display === 'none', lat: Number(dds[0]), lon: Number(dds[1]), moved: dds[2],
               msg: (p.querySelector('.mn-movepin-msg') || {}).textContent || null };
    });
    // A scene point on the screen.
    const screen = (x, y, z) => page.evaluate(([x, y, z]) => DigitalTwin._screen(x, y, z), [x, y, z]);
    const groundY = (x, z) => page.evaluate(([x, z]) => { const d = DigitalTwin.debug(); return (DigitalTwin._heightAt(x, z) - d.h0) * d.exag; }, [x, z]);
    const latLonAt = (x, z) => page.evaluate(([x, z]) => DigitalTwin._latLonAt(x, z), [x, z]);
    // Looking down on the patch, so every point asked about is in view.
    const topDown = () => page.evaluate(() => { DigitalTwin.topView(); });

    // ═══════════════════════════════════════════════════════════════════════
    section('Opened by name — the twin in the map, no editor open on the station');

    await page.evaluate(() => DigitalTwin.openStation('gatton'));
    await built('gatton');
    await topDown();
    await sleep(300);
    await page.click('#twin-movepin-btn');
    let d = await page.evaluate(() => ({ armed: MapMovePin.armed(), onMap: MapMovePin.onMap(), dbg: DigitalTwin.debug().movepin,
                                         pressed: document.getElementById('twin-movepin-btn').getAttribute('aria-pressed') }));
    ok('📍 on the twin\'s bar arms the mode for the station on the stage',
      d.armed === 'gatton' && d.pressed === 'true', J(d));
    ok('…and an amber post stands on the ground at the station, taller than what is built there',
      d.dbg && d.dbg.visible && near(d.dbg.x, 0, 1e-6) && near(d.dbg.z, 0, 1e-6) && near(d.dbg.y, d.dbg.groundY, 1e-6) && d.dbg.height >= 3.5
        && d.dbg.exported === false, J(d.dbg));
    let P = await panel();
    ok('its panel is on the stage, reading the station\'s own position',
      P && !P.hidden && P.lat === Number(GATTON.lat.toFixed(6)) && P.lon === Number(GATTON.lon.toFixed(6)) && /cm|new position|0 m/.test(P.moved), J(P));

    // A real drag: from the post's middle to a point 12 m east, 6 m north.
    const H = d.dbg.height;
    const from = await screen(0, d.dbg.y + H * 0.5, 0);
    const toY = await groundY(12, -6);
    const to = await screen(12, toY, -6);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 14 });
    await page.mouse.up();
    let at = await drawn();
    let want = await latLonAt(12, -6);
    ok('a real pointer drags the post across the ground: 12 m east and 6 m north is where it lands, to a few centimetres',
      at && near(at.at[0], want.lat, 5e-7) && near(at.at[1], want.lon, 5e-7), J({ at: at && at.at, want }));
    d = await page.evaluate(() => DigitalTwin.debug().movepin);
    ok('…standing on the ground there, with a ring where the station was and a line along the ground between',
      near(d.x, 12, 0.06) && near(d.z, -6, 0.06) && near(d.y, d.groundY, 1e-6) && d.ghost && near(d.ghost.x, 0, 1e-6) && d.leader > 2, J(d));
    P = await panel();
    ok('…and the panel reads it back', P.lat === at.at[0] && P.lon === at.at[1] && /^\d+ m$/.test(P.moved), J(P));

    // A click on the ground: the post goes there.
    const gy = await groundY(-8, 5);
    const pt = await screen(-8, gy, 5);
    await page.mouse.click(pt.x, pt.y);
    at = await drawn();
    want = await latLonAt(-8, 5);
    ok('a click on the ground puts it there', near(at.at[0], want.lat, 5e-7) && near(at.at[1], want.lon, 5e-7), J({ at: at.at, want }));

    // The sharp drape follows the pin, in 25 m steps, once it is let go.
    await page.waitForFunction(() => !!DigitalTwin.debug().sharp, null, { timeout: BUILD_TIMEOUT });
    const far = await latLonAt(60, -40);
    await page.evaluate(([la, lo]) => MapMovePin.moveTo(la, lo), [far.lat, far.lon]);
    await page.waitForFunction(() => { const s = DigitalTwin.debug().sharp; return s && s.x === 50 && s.z === -50; }, null, { timeout: BUILD_TIMEOUT });
    d = await page.evaluate(() => DigitalTwin.debug().sharp);
    ok('the 10 cm drape follows the pin: moved 60 m east and 40 m north, it is round the pin, in its 25 m steps',
      d.x === 50 && d.z === -50 && d.onGround && near(d.mpp, 100 / 1024, 1e-12), J(d));

    // Escape: the move ends, the twin does not.
    await page.focus('#twin-canvas');
    await page.keyboard.press('Escape');
    d = await page.evaluate(() => ({ armed: MapMovePin.armed(), tab: state.activeTab, built: DigitalTwin.debug().built, pin: DigitalTwin.debug().movepin, panel: document.getElementById('twin-movepin-panel').hidden }));
    ok('Escape ends the move — and only the move: the twin is still up, in the map', d.armed === null && d.tab === 'stations' && d.built && !d.pin && d.panel, J(d));

    // Signed out, Save refuses and says so; the pin stays.
    await page.click('#twin-movepin-btn');
    await page.evaluate(() => MapMovePin.moveTo(state.data.stations.find(s => s.id === 'gatton').lat + 0.0001, state.data.stations.find(s => s.id === 'gatton').lon));
    await page.evaluate(() => { window.dbCanWrite = () => false; });
    await page.click('#twin-movepin-panel button.is-on');
    P = await panel();
    // (In the map, as the twin is now: the Save's own click must not reach the
    // flat map under the twin and move the pin there — map-move-pin.js.)
    ok('signed out, Save writes nothing and says why, and the pin stays where it was dragged',
      !P.hidden && /signed-in session/.test(P.msg || '') && (await page.evaluate(() => MapMovePin.armed())) === 'gatton', J(P));

    // Signed in, against a stubbed datastore: what is sent is the assertion.
    const moved = await page.evaluate(() => {
      const mem = state.data.stations.find(s => s.id === 'gatton');
      // The database's copy has moved on since this tab loaded it: somebody
      // has written a note. The save must carry it, not the old one.
      const dbDoc = JSON.parse(JSON.stringify(mem));
      dbDoc.notes = 'changed in the database since this tab loaded';
      window.__save = { selects: [], saves: [] };
      window.dbCanWrite = () => true;
      window.editorWritesGoToDatabase = () => true;
      window.dbSelect = async q => { window.__save.selects.push(q); return [{ doc: dbDoc, updated_at: '2026-09-28T01:02:03+00:00' }]; };
      window.dbSaveStation = async (doc, stamp) => {
        window.__save.saves.push({ doc: JSON.parse(JSON.stringify(doc)), stamp });
        return { station: { ...doc }, updated_at: '2026-09-28T01:05:00+00:00', updated_by: 'the check', created: false };
      };
      return MapMovePin.drawn().at;
    });
    CUR = { lat: moved[0], lon: moved[1] };
    await page.click('#twin-movepin-panel button.is-on');
    await page.waitForFunction(() => !MapMovePin.armed(), null, { timeout: 10_000 });
    const sent = await page.evaluate(() => window.__save);
    const doc = sent.saves[0] && sent.saves[0].doc;
    const listKeys = await page.evaluate(() => RiverDetails.LIST_KEYS.concat(['frequencies']));
    ok('Save reads the station\'s current copy from the database, and writes it back with the stamp it came with',
      sent.selects.filter(q => /^station_json/.test(q)).length === 1 && /^station_json\?id=eq\.gatton&select=doc,updated_at$/.test(sent.selects[0])
        && sent.saves.length === 1 && sent.saves[0].stamp === '2026-09-28T01:02:03+00:00', J({ selects: sent.selects, stamp: sent.saves[0] && sent.saves[0].stamp }));
    ok('…with the position changed and somebody else\'s change kept — not this tab\'s older copy',
      doc && doc.lat === moved[0] && doc.lon === moved[1] && doc.notes === 'changed in the database since this tab loaded' && doc.name === GATTON.name,
      J(doc && { lat: doc.lat, lon: doc.lon, notes: doc.notes }));
    ok('…and none of its lists, so save_station() leaves every one of them as it is', doc && listKeys.every(k => !(k in doc)), J(listKeys.filter(k => doc && k in doc)));
    await page.waitForFunction(([la, lo]) => { const d = DigitalTwin.debug(); return d.built && d.origin && d.origin.lat === la && d.origin.lon === lo && !d.status.endsWith('…'); },
      moved, { timeout: BUILD_TIMEOUT });
    d = await page.evaluate(() => ({ mem: (s => [s.lat, s.lon])(state.data.stations.find(x => x.id === 'gatton')), origin: DigitalTwin.debug().origin, panel: document.getElementById('twin-movepin-panel').hidden }));
    ok('saved: the station is where the pin was put, and the twin is rebuilt standing on the new spot',
      d.mem[0] === moved[0] && d.mem[1] === moved[1] && d.origin.lat === moved[0] && d.panel, J(d));

    // ═══════════════════════════════════════════════════════════════════════
    section('Inside the Stations map\'s twin');

    await page.evaluate(() => switchTab('stations'));
    await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0, null, { timeout: LOAD_TIMEOUT });
    await page.evaluate(([lat, lon]) => { showStationCard('gatton'); state.map.setView([lat, lon], 17, { animate: false }); }, moved);
    await page.waitForFunction(() => { const el = document.getElementById('map-twin-offer'); return el && !el.hidden; }, null, { timeout: LOAD_TIMEOUT });
    await page.click('#map-twin-offer .map-twin-offer-open');
    await page.waitForFunction(() => MapTwin.active() && DigitalTwin.debug().built && !DigitalTwin.debug().status.endsWith('…'), null, { timeout: BUILD_TIMEOUT });
    await topDown();
    await sleep(300);
    await page.click('#map-twin #twin-movepin-btn');
    d = await page.evaluate(() => ({
      armed: MapMovePin.armed(), onMap: MapMovePin.onMap(),
      lfPanel: (() => { const el = document.querySelector('.leaflet-control.mn-movepin-panel'); return el ? getComputedStyle(el).display : null; })(),
      stage: (() => { const el = document.getElementById('twin-movepin-panel'); return el ? !el.hidden && getComputedStyle(el).display !== 'none' : null; })(),
      pin: DigitalTwin.debug().movepin,
    }));
    ok('the overlay\'s 📍 arms the mode on the map, and the pin stands in the twin at the station',
      d.armed === 'gatton' && d.onMap === true && d.pin && d.pin.visible && near(d.pin.x, 0, 1e-6), J(d));
    ok('…its panel on the stage, and the map\'s own in the corner standing down for it', d.stage === true && d.lfPanel === 'none', J(d));
    const gy2 = await groundY(6, -4);
    const pt2 = await screen(6, gy2, -4);
    await page.mouse.click(pt2.x, pt2.y);
    at = await drawn();
    want = await latLonAt(6, -4);
    ok('a click on the twin\'s ground moves the pin there — the map\'s own marker with it, since it is one mode',
      near(at.at[0], want.lat, 5e-7) && near(at.at[1], want.lon, 5e-7) && at.onMap, J({ at, want }));
    await page.focus('#twin-canvas');
    await page.keyboard.press('Escape');
    d = await page.evaluate(() => ({ armed: MapMovePin.armed(), twin: MapTwin.active() }));
    ok('Escape ends the move, and leaves the twin up', d.armed === null && d.twin === true, J(d));
    await page.evaluate(() => MapTwin.leave());
    await page.waitForFunction(() => !MapTwin.active(), null, { timeout: 10_000 });

    // ═══════════════════════════════════════════════════════════════════════
    section('In ⛰️ 3-D');

    await page.evaluate(([lat, lon]) => { closeStnCard(false); state.map.setView([lat, lon], 14, { animate: false }); }, moved);
    await page.click('.mn-map-3d');
    await page.waitForFunction(() => typeof Map3D !== 'undefined' && !!Map3D._map() && Map3D._map().isStyleLoaded() && !!Map3D._map().getTerrain(),
      null, { timeout: GL_TIMEOUT });
    const idle = () => page.waitForFunction(() => { const m = Map3D._map(); return m && !m.isMoving() && m.areTilesLoaded(); }, null, { timeout: GL_TIMEOUT });
    await idle();
    await page.evaluate(() => MapMovePin.start('gatton'));
    await idle();
    let m3 = await page.evaluate(() => Map3D._movePin());
    ok('armed in 3-D, the pin is on the terrain at the station, as a marker that can be dragged',
      m3.pin && near(m3.pin.lat, moved[0], 1e-7) && near(m3.pin.lon, moved[1], 1e-7) && m3.pin.draggable, J(m3));
    ok('…with its leader and its "was here" ring in a source of their own',
      m3.features.some(f => f.kind === 'leader') && m3.features.some(f => f.kind === 'ghost'), J(m3.features));

    // A click on the ground, 140 px right of the pin and 60 up.
    const click = await page.evaluate(() => {
      const m = Map3D._map();
      const c = m.getCanvas().getBoundingClientRect();
      const p = m.project(MapMovePin.drawn().at.slice().reverse());
      const q = { x: p.x + 140, y: p.y - 60 };
      const ll = m.unproject([q.x, q.y]);
      const flat = state.map.containerPointToLatLng([q.x, q.y]);
      return { x: c.left + q.x, y: c.top + q.y, lat: ll.lat, lon: ll.lng, flat: [flat.lat, flat.lng] };
    });
    // What the renderer itself reported for the click, caught on its own
    // event: the coordinate MapLibre gives the pixel on the terrain, as
    // map-3d.js's handler receives it.
    await page.evaluate(() => { window.__mlClick = null; Map3D._map().once('click', e => { window.__mlClick = [e.lngLat.lat, e.lngLat.lng]; }); });
    await page.mouse.click(click.x, click.y);
    await sleep(200);
    at = await drawn();
    const ml = await page.evaluate(() => window.__mlClick);
    ok('a click on the ground moves it to the camera\'s own coordinate for that pixel',
      ml && near(at.at[0], ml[0], 1e-6) && near(at.at[1], ml[1], 1e-6) && near(at.at[1], click.lon, 1e-4), J({ at: at.at, ml, click }));
    ok('…not to the flat map\'s, which a tilted camera puts somewhere else',
      !(near(at.at[0], click.flat[0], 2e-5) && near(at.at[1], click.flat[1], 2e-5)), J({ at: at.at, flat: click.flat }));

    // A real drag of the marker itself.
    const handle = await page.evaluate(() => {
      const el = document.querySelector('.mn-movepin-3d');
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    const before = at.at.slice();
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await page.mouse.move(handle.x - 70, handle.y + 40, { steps: 12 });
    await page.mouse.up();
    await sleep(200);
    at = await drawn();
    m3 = await page.evaluate(() => Map3D._movePin());
    ok('a real drag of the pin moves it, and the mode reads where it was let go',
      (at.at[0] !== before[0] || at.at[1] !== before[1]) && near(at.at[0], m3.pin.lat, 2e-6) && near(at.at[1], m3.pin.lon, 2e-6), J({ before, at: at.at, pin: m3.pin }));
    await page.keyboard.press('Escape');
    await sleep(100);
    m3 = await page.evaluate(() => Map3D._movePin());
    ok('cancelled, the pin leaves the terrain', m3.pin === null && m3.features.length === 0 && (await page.evaluate(() => MapMovePin.armed())) === null, J(m3));
  }
  ok('no uncaught page errors', errors.length === 0, errors.join(' | '));
} catch (err) {
  failures++;
  console.log(`  FAIL the check itself threw: ${err.stack || err}`);
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures ? 1 : 0);
