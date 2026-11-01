// 🚘 Drive and ▶ Preview (map-drive-mode.js): the route 🛣️ Route on map
// worked out (map-drive.js), followed in the ⛰️ 3-D view (map-3d.js) as it is
// driven.
//
// What fails in silence here, and so what is asserted. Every one of these
// leaves `drive`, `map3d` and `smoke` green while the drive is wrong:
//
//   * the camera — over the car, heading up, at PITCH, with the car CAR_AT of
//     the way down the road the screen leaves between its banner and its foot
//     (read from the file, measured off the screen). A camera a few metres
//     behind, or turned the wrong way, is still a picture of a road;
//   * the words — the router's own, the next one after the car, said at the
//     right distance ahead ("In 150 metres, …") and again at the turn, put in
//     the live region whether or not the voice is on; the arrow the words name
//     ("Turn left onto Left Bank Road" is a left), the road's bend where they
//     name none;
//   * the stations named — the one driven to flagged, the rest whole, between
//     the banner and the foot, never over each other;
//   * the screen — the whole window, over the side panel, the flat map hidden
//     under the road, the radio paths and the rising water off for as long as
//     the drive lasts and back after it; the 3-D view closed again if the drive
//     opened it and left as it was if not; focus back on the pill that started
//     it;
//   * the drive outliving a render of the tab, and ending with the tab, with
//     Escape and with the route (signing out);
//   * and on a phone, the drive following the phone: its fixes put on the
//     route, a rough one not followed, leaving the road asking for the route
//     again from where the car is — once — and a refusal of the position
//     ending the drive and saying so.
//
// The router, the database and the phone's position are stand-ins; the 3-D
// view is the real one (MapLibre on SwiftShader), with every tile blocked.
//
// Run:  npm run drivemode
//       npm run drivemode -- -v    also print what passed

import fs from 'node:fs';
import { shapeTrip } from '../worker/drive.js';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { repo } from './lib/paths.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const GL_TIMEOUT = 90_000;

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass: !!pass, detail });
  if (!pass) console.log(`  ✗ ${name}${detail ? ` — ${String(detail).slice(0, 400)}` : ''}`);
  else if (VERBOSE) console.log(`  ✓ ${name}`);
}
const J = v => JSON.stringify(v);

// The file's own numbers, so a change to one is a change to what is asserted.
const SRC = fs.readFileSync(repo('map-drive-mode.js'), 'utf8');
const num = name => Number((new RegExp(`const ${name} = ([\\d.]+)`).exec(SRC) || [])[1]);
const PITCH = num('PITCH'), CAR_AT = num('CAR_AT'), OFF_MS = num('OFF_MS'), TAG_MAX = num('TAG_MAX');
const PITCH_HOME = Number((/const PITCH_HOME = ([\d.]+)/.exec(fs.readFileSync(repo('map-3d.js'), 'utf8')) || [])[1]);
for (const [k, v] of Object.entries({ PITCH, CAR_AT, OFF_MS, TAG_MAX, PITCH_HOME })) {
  if (!isFinite(v)) { console.log(`FAIL — could not read ${k} from the source`); process.exit(1); }
}

const STATION = 'gatton_al';      // a Brisbane-hub station: a desk starts at Pritchard Road

// ── The stand-in router ──────────────────────────────────────────────────────
// Google's encoded polyline at six places, written here rather than borrowed.
function encode6(pts) {
  const one = v => {
    let n = v < 0 ? ~(v << 1) : v << 1, out = '';
    while (n >= 0x20) { out += String.fromCharCode((0x20 | (n & 0x1f)) + 63); n >>= 5; }
    return out + String.fromCharCode(n + 63);
  };
  let out = '', pl = 0, pn = 0;
  for (const [lat, lon] of pts) {
    const a = Math.round(lat * 1e6), b = Math.round(lon * 1e6);
    out += one(a - pl) + one(b - pn);
    pl = a; pn = b;
  }
  return out;
}

function km(a, b) {
  const R = 6371.0088, r = Math.PI / 180;
  const h = Math.sin((b[0] - a[0]) * r / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin((b[1] - a[1]) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// A winding road from `from` to 150 m short of `to`: along, a right turn, a
// bend, a left — each turn's length its own, at 60 km/h, as Valhalla answers.
function trip(from, to) {
  const end = [to[0] + 0.00135, to[1]];
  const pts = [];
  const n1 = 80, n2 = 80, n3 = 60;
  const mid1 = [from[0], (from[1] + end[1]) / 2];
  for (let i = 0; i <= n1; i++) { const t = i / n1; pts.push([from[0] + 0.002 * Math.sin(t * Math.PI * 2), from[1] + (mid1[1] - from[1]) * t]); }
  const mid2 = [(from[0] + end[0]) / 2, mid1[1] + 0.004];
  for (let i = 1; i <= n2; i++) { const t = i / n2; pts.push([mid1[0] + (mid2[0] - mid1[0]) * t, mid1[1] + (mid2[1] - mid1[1]) * t + 0.003 * Math.sin(t * Math.PI)]); }
  for (let i = 1; i <= n3; i++) { const t = i / n3; pts.push([mid2[0] + (end[0] - mid2[0]) * t, mid2[1] + (end[1] - mid2[1]) * t]); }
  const len = (a, b) => { let s = 0; for (let i = a + 1; i <= b; i++) s += km(pts[i - 1], pts[i]); return s; };
  const cut = [0, n1, n1 + n2, pts.length - 1];
  const words = ['Drive west on Tenthill Creek Road.', 'Turn right onto Old Laidley Road.', 'Turn left onto William Street.'];
  const maneuvers = words.map((instruction, k) => {
    const l = len(cut[k], cut[k + 1]);
    return { type: k ? (k === 1 ? 10 : 15) : 1, instruction, length: l, time: l / 60 * 3600, begin_shape_index: cut[k] };
  });
  maneuvers.push({ type: 4, instruction: 'You have arrived at your destination.', length: 0, time: 0, begin_shape_index: pts.length - 1 });
  const total = maneuvers.reduce((s, m) => s + m.length, 0);
  return { trip: { status: 0, units: 'kilometers', language: 'en-GB',
    summary: { length: total, time: total / 60 * 3600, has_ferry: false, has_toll: false },
    legs: [{ shape: encode6(pts), summary: {}, maneuvers }] } };
}

const server = await startServer();
const browser = await launchBrowser();
const errors = [];
const drives = [];          // every /api/drive asked: { from, at }

async function openApp(contextOpts = {}, { gps = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...contextOpts });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(String(e.stack || e)));
  page.on('dialog', async dlg => { errors.push(`dialog: ${dlg.message()}`); await dlg.dismiss().catch(() => {}); });
  await page.route(/\/api\/drive\?/, async route => {
    const u = new URL(route.request().url());
    const p = s => s.split(',').map(Number);
    const from = p(u.searchParams.get('from')), to = p(u.searchParams.get('to'));
    drives.push({ from: u.searchParams.get('from'), at: Date.now() });
    return route.fulfill({ status: 200, contentType: 'application/json', body: J(shapeTrip(trip(from, to), from, to, Date.now())) });
  });
  await page.route('**://*.supabase.co/rest/v1/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  // The voice, the screen's wake lock and — on the phone — its position,
  // stood in before the page has a chance to reach for the real ones.
  await page.addInitScript(gpsOn => {
    // Every announcement the live region is given, kept: the region itself
    // holds only the latest, and the next one may come a frame later.
    window.__live = [];
    document.addEventListener('DOMContentLoaded', () => {
      const el = document.getElementById('app-status');
      if (el) new MutationObserver(() => { if (el.textContent) window.__live.push(el.textContent); })
        .observe(el, { childList: true, characterData: true, subtree: true });
    });
    window.__said = [];
    window.__hush = 0;
    const synth = { speak: u => window.__said.push(u.text), cancel: () => { window.__hush++; } };
    Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
    if (typeof window.SpeechSynthesisUtterance === 'undefined') window.SpeechSynthesisUtterance = function (t) { this.text = t; };
    window.__wake = { asked: 0, released: 0 };
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: () => {
      window.__wake.asked++;
      const lock = new EventTarget();
      lock.release = () => { window.__wake.released++; return Promise.resolve(); };
      return Promise.resolve(lock);
    } } });
    if (gpsOn) {
      window.__geo = { watchers: new Map(), n: 0, at: [-27.556, 152.21] };
      const g = navigator.geolocation;
      g.getCurrentPosition = ok => setTimeout(() => ok({ coords: { latitude: window.__geo.at[0], longitude: window.__geo.at[1], accuracy: 8 } }), 10);
      g.watchPosition = (ok, bad) => { const id = ++window.__geo.n; window.__geo.watchers.set(id, { ok, bad }); return id; };
      g.clearWatch = id => window.__geo.watchers.delete(id);
      window.__emit = (lat, lon, acc = 8, speed = 15) => {
        for (const w of window.__geo.watchers.values()) w.ok({ coords: { latitude: lat, longitude: lon, accuracy: acc, speed, heading: null }, timestamp: Date.now() });
      };
      window.__refuse = () => { for (const w of window.__geo.watchers.values()) w.bad({ code: 1, message: 'denied' }); };
    }
  }, gps);
  await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations), null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0, null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => {
    dbSetAccessToken('test-token');
    Auth.isSignedIn = () => true;
    Auth.mayWrite = () => true;
    Auth.role = () => 'editor';
    Auth.accessToken = () => 'test-token';
    SiteFeatures.authChanged();
    MapDrive.authChanged();
  });
  return { context, page };
}

const st = page => page.evaluate(() => DriveMode._state());
const view = page => page.evaluate(() => {
  const d = Map3D._drive();
  return { ...d, route: d.route ? d.route.features.map(f => f.properties.kind) : null };
});
const routeReady = page => page.waitForFunction(() => { const j = MapDrive._job(); return !!j && j.status === 'ok'; }, null, { timeout: 15_000 });
const drawing = page => page.waitForFunction(() => {
  const m = Map3D._map();
  return DriveMode.active() && Map3D._drive().on && !!m && m.isStyleLoaded() && !!Map3D._drive().puck;
}, null, { timeout: GL_TIMEOUT });
const banner = page => page.evaluate(() => ({
  dist: (document.querySelector('.mn-dm-dist') || {}).textContent || '',
  text: (document.querySelector('.mn-dm-text') || {}).textContent || '',
}));
const wrap = a => ((a % 360) + 540) % 360 - 180;

// Where the HUD leaves the road in view, in the stage's pixels.
const band = page => page.evaluate(() => {
  const hud = document.querySelector('.mn-dm');
  const s = hud.getBoundingClientRect();
  const b = document.querySelector('.mn-dm-next').getBoundingClientRect().bottom - s.top;
  const f = s.bottom - document.querySelector('.mn-dm-foot').getBoundingClientRect().top;
  return { top: b, bottom: s.height - f, H: s.height, W: s.width, left: s.left, topPx: s.top };
});

let gl2 = true;
try {
  // ════════════════════════════════════════════════════════════════════════
  // A desk: ▶ Preview
  // ════════════════════════════════════════════════════════════════════════
  console.log('\nA desk: ▶ Preview');
  const { context, page } = await openApp();
  gl2 = await page.evaluate(() => { try { return !!document.createElement('canvas').getContext('webgl2'); } catch (_) { return false; } });
  if (!gl2) throw new Error('no-webgl');

  await page.evaluate(id => MapDrive.open(id), STATION);
  await routeReady(page);
  const pills = await page.evaluate(() => [...document.querySelectorAll('.mn-drive-panel .mn-dm-pill')]
    .map(b => ({ text: b.textContent.replace(/\s+/g, ' ').trim(), mode: b.dataset.mode, real: typeof DriveMode[(/DriveMode\.(\w+)/.exec(b.getAttribute('onclick')) || [])[1]] === 'function' })));
  check('a desk is offered ▶ Preview the drive, and no 🚘 Drive — nobody drives a desk',
    pills.length === 1 && pills[0].mode === 'preview' && pills[0].text === '▶ Preview the drive' && pills[0].real, J(pills));

  // From a map already ⛶ full screen, whose own rule would otherwise leave room
  // for the side panel and stand under it.
  await page.evaluate(() => toggleMapFullscreen(true));
  await page.click('.mn-drive-panel .mn-dm-pill[data-mode="preview"]');
  await drawing(page);
  await page.evaluate(() => DriveMode.act('pause'));
  await page.waitForTimeout(1500);       // the opening ease, and the frames after it

  const scr = await page.evaluate(() => {
    const p = document.querySelector('.map-panel.is-driving');
    const r = p && p.getBoundingClientRect();
    const hud = document.querySelector('.mn-dm');
    const at = document.elementFromPoint(innerWidth - 8, Math.round(innerHeight / 2));
    const flat = document.querySelector('.map-panel.is-driving .leaflet-map-pane');
    return { rect: r && [r.left, r.top, r.width, r.height], role: hud && hud.getAttribute('role'),
             label: hud && hud.getAttribute('aria-label'), overSide: !!(at && at.closest('.map-panel')),
             flat: flat && getComputedStyle(flat).visibility, focus: document.activeElement && document.activeElement.className,
             opened: DriveMode._state().opened3d, active: Map3D.active() };
  });
  check('the drive is the whole window, over the side panel — even from a map already full screen', J(scr.rect) === J([0, 0, 1280, 800]) && scr.overSide, J(scr));
  check('… a region named for the drive, with focus on ✕ End', scr.role === 'region' && scr.label === 'Preview of the drive to Gatton AL'
    && /mn-dm-end/.test(scr.focus), J(scr));
  check('… the 3-D view opened by the drive, the flat map out of sight under it', scr.opened === true && scr.active && scr.flat === 'hidden', J(scr));

  const v1 = await view(page);
  const s1 = await st(page);
  const plan = await page.evaluate(() => MapDrive.plan());
  check('in the 3-D view: the radio paths and the rising water off, the route draped, its start dot gone',
    v1.on && v1.host && v1.links === 'none' && !v1.water && J(v1.route) === J(plan.legs.map(l => l.kind)), J({ links: v1.links, water: v1.water, route: v1.route }));
  const roadSrc = await page.evaluate(() => Map3D._drive().route.features.find(f => f.properties.kind === 'road').geometry.coordinates);
  const roadPlan = plan.legs.find(l => l.kind === 'road').pts;
  check('… the road drawn where the plan has it, point for point',
    roadSrc.length === roadPlan.length && roadSrc.every((c, i) => Math.abs(c[0] - roadPlan[i][1]) < 1e-9 && Math.abs(c[1] - roadPlan[i][0]) < 1e-9),
    `${roadSrc.length} vs ${roadPlan.length}`);
  check('the screen kept awake, and the drive said out loud',
    await page.evaluate(() => window.__wake.asked) >= 1
    && await page.evaluate(() => /^Previewing the drive to Gatton AL: .+ kilometres?, about .+\./.test(window.__said.find(Boolean) || '')),
    await page.evaluate(() => JSON.stringify(window.__said)));

  // ── The camera ──
  const cam = v1.camera, pk = v1.puck;
  const dm = (a, b) => km(a, b) * 1000;
  check(`the camera over the car, tilted ${PITCH}°, heading where the car is pointing`,
    Math.abs(cam.pitch - PITCH) < 0.5 && Math.abs(wrap(cam.bearing - s1.heading)) < 1
    && dm([cam.lat, cam.lon], [pk.lat, pk.lon]) < 1 && dm([pk.lat, pk.lon], s1.pos) < 1 && Math.abs(wrap(pk.rotation - s1.heading)) < 1,
    J({ cam, pk, pos: s1.pos, heading: s1.heading }));
  const b1 = await band(page);
  const onScreen = await page.evaluate(() => { const d = Map3D._drive(); const p = Map3D._map().project([d.puck.lon, d.puck.lat]); return [p.x, p.y]; });
  const wantY = b1.top + CAR_AT * (b1.bottom - b1.top);
  check(`… the car ${CAR_AT * 100}% of the way down the road between the banner and the foot, in the middle across`,
    Math.abs(onScreen[1] - wantY) < 4 && Math.abs(onScreen[0] - b1.W / 2) < 4, J({ at: onScreen, wantY, band: b1 }));
  const puckBox = await page.evaluate(() => { const r = document.querySelector('.mn-drive-puck').getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; });
  check('… and drawn there', onScreen[0] + b1.left >= puckBox[0] && onScreen[0] + b1.left <= puckBox[2]
    && onScreen[1] + b1.topPx >= puckBox[1] - 2 && onScreen[1] + b1.topPx <= puckBox[3] + 2, J({ puckBox, onScreen }));

  // ── The words ──
  console.log('\nThe words, and when they are said');
  const items = s1.items;
  const turnR = items.find(it => it.text === 'Turn right onto Old Laidley Road.');
  const turnL = items.find(it => it.text === 'Turn left onto William Street.');
  check('the plan: the router\'s turns, then where the mapped road ends, then arriving',
    J(items.map(it => it.kind)) === J(['road', 'road', 'road', 'gap', 'arrive'])
    && /^The mapped road ends: the station is 1\d\d m on, not mapped\.$/.test(items[3].text) && items[4].text === 'Arrive at Gatton AL.', J(items.map(it => it.text)));
  const b0 = await banner(page);
  check('the banner names the next turn after the car, and how far', b0.text === turnR.text && /km$/.test(b0.dist), J(b0));
  const said0 = await page.evaluate(() => window.__said.length);
  await page.evaluate(s => DriveMode._at(s), turnR.s - 150);
  await page.waitForFunction(() => window.__said.includes('In 150 metres, turn right onto Old Laidley Road.'), null, { timeout: 5000 }).catch(() => {});
  check('150 m out it is said ahead of time, in the router\'s words',
    await page.evaluate(() => window.__said.includes('In 150 metres, turn right onto Old Laidley Road.')), await page.evaluate(n => JSON.stringify(window.__said.slice(n)), said0));
  check('… and the banner says 150 m', (await banner(page)).dist === '150 m', J(await banner(page)));
  await page.evaluate(s => DriveMode._at(s), turnR.s - 20);
  await page.waitForFunction(() => window.__said[window.__said.length - 1] === 'Turn right onto Old Laidley Road.', null, { timeout: 5000 }).catch(() => {});
  check('at the turn it is said again', await page.evaluate(() => window.__said[window.__said.length - 1]) === 'Turn right onto Old Laidley Road.',
    await page.evaluate(() => JSON.stringify(window.__said.slice(-3))));
  check('… and put in the live region', await page.waitForFunction(() => window.__live.includes('Turn right onto Old Laidley Road.'), null, { timeout: 5000 }).then(() => true, () => false),
    await page.evaluate(() => JSON.stringify(window.__live.slice(-4))));
  await page.evaluate(s => DriveMode._at(s), turnR.s + 15);
  await page.waitForFunction(t => (document.querySelector('.mn-dm-text') || {}).textContent === t, turnL.text, { timeout: 5000 }).catch(() => {});
  const s2 = await st(page);
  check('past it, the banner moves on to the next — a left, drawn as one', (await banner(page)).text === turnL.text
    && s2.next.turn.k === 'turn' && s2.next.turn.ang === -90 && turnR.turn.ang === 90, J({ b: await banner(page), next: s2.next }));

  // The arrow from the words, and from the road where they name none.
  const turns = await page.evaluate(() => {
    const straight = DriveMode._buildPath([{ kind: 'road', pts: [[-27, 153], [-27.01, 153], [-27.02, 153]] }]);
    const bent = DriveMode._buildPath([{ kind: 'road', pts: [[-27, 153], [-27.01, 153], [-27.01, 152.99]] }]);
    const t = (path, text, at = path.total / 2) => DriveMode._turnFor(path, at, text, 'road');
    return {
      leftBank: t(straight, 'Turn right onto Left Bank Road.'), rightSt: t(straight, 'Turn left onto Right Street.'),
      bear: t(straight, 'Bear left onto Gore Highway.'), keep: t(straight, 'Keep right to take M1.'),
      sharp: t(straight, 'Make a sharp left onto Brook Street.'), uR: t(straight, 'Make a right U-turn onto Main Street.'),
      uL: t(straight, 'Make a left U-turn.'), round: t(straight, 'Enter the roundabout and take the 2nd exit onto Ipswich Road.'),
      drive: t(straight, 'Drive north on Lefroy Street.'), exit: t(bent, 'Take the exit.', bent.cum[1]), arrive: DriveMode._turnFor(straight, 0, 'x', 'arrive'),
    };
  });
  check('the arrow is the turn the words name, from the words before the road\'s name',
    turns.leftBank.ang === 90 && turns.rightSt.ang === -90 && turns.bear.ang === -35 && turns.keep.ang === 35
    && turns.sharp.ang === -135 && turns.uR.k === 'uturn' && turns.uR.ang === 180 && turns.uL.ang === -180
    && turns.round.k === 'round' && turns.drive.ang === 0 && turns.arrive.k === 'arrive', J(turns));
  check('… and the road\'s own bend where they name none (south, then west: a right)', Math.abs(turns.exit.ang - 90) < 10, J(turns.exit));

  // ── The stations named ──
  console.log('\nThe stations named');
  await page.evaluate(() => DriveMode._at(DriveMode._state().total - 400));
  await page.waitForFunction(() => DriveMode._state().tags.some(t => t.dest), null, { timeout: 8000 }).catch(() => {});
  const b2 = await band(page);
  const tags = await page.evaluate(() => [...document.querySelectorAll('.mn-drive-tag')].map(el => {
    const r = el.getBoundingClientRect();
    return { text: el.textContent, dest: el.classList.contains('is-dest'), box: [r.left, r.top, r.right, r.bottom] };
  }));
  const inside = tags.every(t => t.box[0] >= b2.left - 1 && t.box[2] <= b2.left + b2.W + 1 && t.box[1] >= b2.topPx + b2.top - 2 && t.box[3] <= b2.topPx + b2.bottom + 2);
  const clear = tags.every((a, i) => tags.every((b, j) => j <= i || a.box[2] <= b.box[0] || b.box[2] <= a.box[0] || a.box[3] <= b.box[1] || b.box[3] <= a.box[1]));
  check('the station driven to is named over its pin with a flag, with how far it is', tags.some(t => t.dest && /^🏁 Gatton AL \d+ m$/.test(t.text)), J(tags.map(t => t.text)));
  check(`… other stations near the road named too, at most ${TAG_MAX}, each with how far`,
    tags.filter(t => !t.dest).length >= 1 && tags.filter(t => !t.dest).length <= TAG_MAX && tags.every(t => /\d(?:\.\d)? (?:m|km)$/.test(t.text)), J(tags.map(t => t.text)));
  check('… every name whole, between the banner and the foot, and none over another', inside && clear, J({ tags, b2 }));

  // ── Arriving ──
  await page.evaluate(() => DriveMode._at(DriveMode._state().total));
  await page.waitForFunction(() => DriveMode._state().arrived, null, { timeout: 5000 }).catch(() => {});
  const arr = await page.evaluate(() => ({ s: DriveMode._state(), said: window.__said.slice(-1)[0],
    tools: [...document.querySelectorAll('.mn-dm-tools button')].map(b => b.dataset.act), left: document.querySelector('.mn-dm-left').textContent }));
  check('at the end: arrived, said, and the preview stops with ▶ to play it again',
    arr.s.arrived && arr.said === 'You have arrived at Gatton AL.' && (await banner(page)).text === 'You have arrived at Gatton AL.'
    && arr.tools[0] === 'play' && /Arrived/.test(arr.left), J({ said: arr.said, tools: arr.tools, left: arr.left }));

  // ── Looking round ──
  // While the preview plays, so the camera is being put over the car every
  // frame — which is what stopped every drag before it began.
  console.log('\nLooking round, and the overview');
  await page.evaluate(() => { DriveMode._at(DriveMode._state().total * 0.3); DriveMode.act('play'); });
  await page.waitForTimeout(700);
  const box = await page.evaluate(() => { const r = document.getElementById('map3d').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * 0.45 }; });
  // The ground under the pointer when it goes down, and where that ground is
  // when it comes up: a drag moves the map with it.
  const ground = (x, y) => page.evaluate(([px, py]) => {
    const m = Map3D._map(), r = m.getContainer().getBoundingClientRect(), ll = m.unproject([px - r.left, py - r.top]);
    return [ll.lng, ll.lat];
  }, [x, y]);
  const screenOf = ll => page.evaluate(q => {
    const m = Map3D._map(), r = m.getContainer().getBoundingClientRect(), pt = m.project(q);
    return [pt.x + r.left, pt.y + r.top];
  }, ll);
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  const grabbed = await ground(box.x, box.y);
  await page.mouse.move(box.x + 120, box.y + 60, { steps: 8 });
  await page.mouse.up();
  const dropped = await screenOf(grabbed);
  await page.waitForTimeout(300);
  const free = await page.evaluate(() => ({ follow: DriveMode._state().follow, tools: [...document.querySelectorAll('.mn-dm-tools button')].map(b => b.dataset.act) }));
  free.moved = [Math.round(dropped[0] - box.x), Math.round(dropped[1] - box.y)];
  check('a drag of the map while the car moves is the driver looking round: the map goes with the pointer, is left there, and ◎ is offered',
    free.follow === false && free.tools.includes('centre') && !free.tools.includes('overview')
    && Math.abs(free.moved[0] - 120) < 25 && Math.abs(free.moved[1] - 60) < 25, J(free));
  await page.evaluate(() => DriveMode.act('pause'));
  await page.click('.mn-dm-tools [data-act="centre"]', { timeout: 3000 }).catch(() => page.evaluate(() => DriveMode.act('centre')));
  await page.waitForTimeout(1500);
  const back = await view(page);
  check('◎ puts the camera back over the car', (await st(page)).follow === true
    && km([back.camera.lat, back.camera.lon], [back.puck.lat, back.puck.lon]) * 1000 < 1 && Math.abs(back.camera.pitch - PITCH) < 0.5, J(back.camera));
  await page.evaluate(() => DriveMode._at(DriveMode._state().total * 0.3));
  await page.waitForTimeout(600);
  await page.evaluate(() => DriveMode.act('overview'));
  await page.waitForTimeout(1300);
  const ov = await page.evaluate(() => {
    const m = Map3D._map(), s = DriveMode._state(), w = m.getContainer().clientWidth, h = m.getContainer().clientHeight;
    // The rest of the route, from the car: what the overview is of.
    const path = DriveMode._buildPath(MapDrive.plan().legs);
    const p = path.pts.filter((_, i) => path.cum[i] >= s.s && (i % 10 === 0 || i === path.pts.length - 1));
    const out = p.filter(q => { const s2 = m.project([q[1], q[0]]); return s2.x < -2 || s2.x > w + 2 || s2.y < -2 || s2.y > h + 2; });
    return { pitch: m.getPitch(), bearing: m.getBearing(), out: out.length, of: p.length, follow: s.follow };
  });
  check('🗺️ the rest of the route from straight overhead, north up, all of it in view', ov.pitch < 1 && Math.abs(wrap(ov.bearing)) < 1 && ov.of > 5 && ov.out === 0 && !ov.follow, J(ov));
  await page.evaluate(() => DriveMode.act('centre'));

  // ── The voice ──
  await page.evaluate(() => DriveMode.act('voice'));
  const quiet = await page.evaluate(() => ({ kept: localStorage.getItem('mn-drive-voice'), pressed: document.querySelector('.mn-dm-tools [data-act="voice"]').getAttribute('aria-pressed'), n: window.__said.length }));
  await page.evaluate(s => DriveMode._at(s), turnL.s - 20);
  await page.waitForFunction(t => window.__live.includes(t), turnL.text, { timeout: 5000 }).catch(() => {});
  const after = await page.evaluate(t => ({ n: window.__said.length, live: window.__live.includes(t) }), turnL.text);
  check('🔊 off: remembered, the turns no longer said — and still put in the live region',
    quiet.kept === 'off' && quiet.pressed === 'false' && after.n === quiet.n && after.live, J({ quiet, after }));
  await page.evaluate(() => DriveMode.act('voice'));

  // ── A render of the tab under the drive ──
  console.log('\nA render of the tab, Escape, and 3-D left as it was');
  await page.evaluate(() => renderMain());
  await drawing(page);
  const kept = await page.evaluate(() => ({ cls: !!document.querySelector('.map-panel.is-driving'), hud: !!document.querySelector('.mn-dm'), on: Map3D._drive().on }));
  check('the tab rendered again under the drive: the drive goes on, on the new map', kept.cls && kept.hud && kept.on, J(kept));
  await page.evaluate(() => Map3D.stop());
  await drawing(page);
  check('the 3-D view closed under the drive some other way: opened again, and the drive goes on',
    await page.evaluate(() => DriveMode.active() && Map3D.active() && Map3D._drive().on && !!document.querySelector('.map-panel.is-driving .mn-dm')));

  // ── Escape ──
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !DriveMode.active(), null, { timeout: 5000 }).catch(() => {});
  const gone = await page.evaluate(() => ({
    active: DriveMode.active(), cls: !!document.querySelector('.is-driving'), hud: !!document.querySelector('.mn-dm'),
    map3d: Map3D.active(), focus: document.activeElement && document.activeElement.dataset.mode, drawn: MapDrive._drawn().length,
    wake: window.__wake, panel: !!document.querySelector('.mn-drive-panel'),
  }));
  check('Escape ends it: the screen gone, the 3-D view it opened closed, the route still on the flat map, its panel back',
    !gone.active && !gone.cls && !gone.hud && !gone.map3d && gone.drawn > 0 && gone.panel, J(gone));
  check('… focus back on ▶ Preview, and the screen let sleep', gone.focus === 'preview' && gone.wake.released >= 1, J(gone));
  check('… and the Escape was the drive\'s alone: the map is still full screen',
    await page.evaluate(() => state.mapFullscreen && !!document.querySelector('.map-panel.is-full')));
  await page.evaluate(() => toggleMapFullscreen(false));

  // ── 3-D open before the drive ──
  await page.evaluate(() => Map3D.toggle());
  await page.waitForFunction(() => !!Map3D._map() && Map3D._map().isStyleLoaded(), null, { timeout: GL_TIMEOUT });
  await page.evaluate(() => Map3D.setWater(true));
  const pre = await view(page);
  check('with the route up, ⛰️ 3-D drapes it too — with its start dot', J(pre.route) === J([...plan.legs.map(l => l.kind), 'start']), J(pre.route));
  await page.evaluate(() => DriveMode.start('preview'));
  await drawing(page);
  const during = await view(page);
  await page.evaluate(() => DriveMode.end());
  await page.waitForTimeout(1200);
  const post = await view(page);
  check('driven from an open 3-D view: the paths and the water off while it lasts …', during.links === 'none' && !during.water, J({ links: during.links, water: during.water }));
  check(`… and back after it, the view left open, padding gone and the tilt back to ${PITCH_HOME}°`,
    await page.evaluate(() => Map3D.active()) && post.links === 'visible' && post.water && !post.on && !post.puck && post.tags.length === 0
    && J(post.camera.padding) === J({ top: 0, bottom: 0, left: 0, right: 0 }) && Math.abs(post.camera.pitch - PITCH_HOME) < 0.5,
    J({ links: post.links, water: post.water, padding: post.camera.padding, pitch: post.camera.pitch }));

  // The route's credit is in the ⓘ while there is a route, and only then.
  const credit = () => page.evaluate(() => (document.querySelector('#map3d .maplibregl-ctrl-attrib-inner') || {}).textContent || '');
  const withRoute = await credit();
  await page.evaluate(() => MapDrive.clear());
  await page.waitForFunction(() => !/Valhalla/.test((document.querySelector('#map3d .maplibregl-ctrl-attrib-inner') || {}).textContent || ''), null, { timeout: 5000 }).catch(() => {});
  const without = await credit();
  check('the route\'s credit is in the 3-D view\'s ⓘ while a route is up, and goes with it',
    /Route © OpenStreetMap contributors, by Valhalla/.test(withRoute) && !/Valhalla/.test(without), J({ withRoute: withRoute.slice(-90), without: without.slice(-90) }));
  await page.evaluate(id => MapDrive.open(id), STATION);
  await routeReady(page);

  // ── Leaving the tab, and signing out ──
  await page.evaluate(() => DriveMode.start('preview'));
  await drawing(page);
  await page.evaluate(() => switchTab('home'));
  await page.waitForTimeout(300);
  check('leaving the Stations tab ends the drive', await page.evaluate(() => !DriveMode.active() && !document.querySelector('.is-driving, .mn-dm')));
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0, null, { timeout: LOAD_TIMEOUT });
  await routeReady(page);
  await page.evaluate(() => DriveMode.start('preview'));
  await drawing(page);
  await page.evaluate(() => {
    dbSetAccessToken(null);
    Auth.isSignedIn = () => false; Auth.mayWrite = () => false; Auth.role = () => null; Auth.accessToken = () => null;
    SiteFeatures.authChanged();
    MapDrive.authChanged();
  });
  await page.waitForTimeout(300);
  await page.waitForFunction(() => window.__live.some(t => /route was taken off the map/.test(t)), null, { timeout: 3000 }).catch(() => {});
  check('signing out takes the route, and the drive ends saying why',
    await page.evaluate(() => !DriveMode.active() && !document.querySelector('.is-driving')
      && window.__live.some(t => /route was taken off the map/.test(t))));
  await context.close();

  // ════════════════════════════════════════════════════════════════════════
  // A phone: 🚘 Drive
  // ════════════════════════════════════════════════════════════════════════
  console.log('\nA phone: 🚘 Drive, following its position');
  const phone = await openApp({ viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true }, { gps: true });
  const pp = phone.page;
  const n0 = drives.length;
  await pp.evaluate(id => MapDrive.open(id), STATION);
  await routeReady(pp);
  check('the route starts where the phone is', drives.length === n0 + 1 && drives[n0].from === '-27.55600,152.21000', J(drives.slice(n0)));
  const ppills = await pp.evaluate(() => [...document.querySelectorAll('.mn-drive-panel .mn-dm-pill')].map(b => b.dataset.mode));
  check('a phone is offered 🚘 Drive and ▶ Preview', J(ppills) === J(['gps', 'preview']), J(ppills));
  await pp.click('.mn-drive-panel .mn-dm-pill[data-mode="gps"]');
  await drawing(pp);
  const waiting = await pp.evaluate(() => ({ watch: window.__geo.watchers.size, label: document.querySelector('.mn-dm').getAttribute('aria-label'),
    status: document.querySelector('.mn-dm-status').textContent }));
  check('🚘 Drive watches the position, and says it is waiting for one', waiting.watch === 1 && waiting.label === 'Driving to Gatton AL'
    && /Waiting for this phone/.test(waiting.status), J(waiting));

  const road = await pp.evaluate(() => MapDrive.plan().legs.find(l => l.kind === 'road').pts);
  const dists = [];
  for (let i = 0; i <= 72; i += 4) {
    await pp.evaluate(([a, b]) => window.__emit(a, b, 8, 15), road[i]);
    await pp.waitForTimeout(140);
    dists.push((await banner(pp)).dist);
  }
  await pp.waitForTimeout(400);
  const on = await st(pp);
  const exp = await pp.evaluate(p => { const path = DriveMode._buildPath(MapDrive.plan().legs); return { s: (() => { let best = 0, bd = Infinity; for (let i = 0; i < path.pts.length; i++) { const dd = Math.hypot(path.pts[i][0] - p[0], path.pts[i][1] - p[1]); if (dd < bd) { bd = dd; best = path.cum[i]; } } return best; })() }; }, road[72]);
  check('its fixes are put on the route, and the car carried along it', on.fix && on.fix.on && Math.abs(on.s - exp.s) < 60 && on.follow,
    J({ s: on.s, want: exp.s, fix: on.fix }));
  const metresOf = t => (/km$/.test(t) ? parseFloat(t) * 1000 : parseFloat(t));
  const ds = dists.map(metresOf).filter(isFinite);
  check('… the banner counting down to the turn as it goes', ds.length > 5 && ds.every((x, k) => k === 0 || x <= ds[k - 1] + 1) && ds[ds.length - 1] < ds[0], J(dists));

  await pp.evaluate(([a, b]) => window.__emit(a, b, 500, 15), road[76]);
  await pp.waitForTimeout(300);
  check('a fix good only to ±500 m is not followed, and the screen says so',
    /only good to ±500 m/.test(await pp.evaluate(() => document.querySelector('.mn-dm-status').textContent)) && Math.abs((await st(pp)).s - on.s) < 80);

  // Off the road, for longer than OFF_MS.
  const n1 = drives.length;
  const offAt = [road[76][0] - 0.0028, road[76][1]];
  const t0 = Date.now();
  while (Date.now() - t0 < OFF_MS + 2500) {
    await pp.evaluate(([a, b]) => window.__emit(a, b, 8, 10), offAt);
    await pp.waitForTimeout(500);
  }
  await pp.waitForFunction(() => !DriveMode._state().rerouting, null, { timeout: 10_000 }).catch(() => {});
  await pp.waitForTimeout(400);
  const re = await st(pp);
  const said = await pp.evaluate(() => window.__said.slice(-4));
  check(`off the route for ${OFF_MS / 1000} s: the route asked for again — once — from where the car is, and not before`,
    drives.length === n1 + 1 && drives[n1].from === `${offAt[0].toFixed(5)},${offAt[1].toFixed(5)}` && drives[n1].at - t0 >= OFF_MS - 300,
    J({ asked: drives.slice(n1), after: drives[n1] && drives[n1].at - t0 }));
  check('… the new one followed, and both said', re.fix && re.fix.on && Math.abs(re.total - on.total) > 1
    && said.some(x => /^Off the route\. Working it out again from here\.$/.test(x)) && said.some(x => /^New route: .+, about .+\.$/.test(x)), J({ said, total: re.total }));

  // The screen, at a phone's width.
  const lay = await pp.evaluate(() => {
    const btns = [...document.querySelectorAll('.mn-dm-foot button')].map(b => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
    const top = document.querySelector('.mn-dm-next').getBoundingClientRect();
    return { scroll: document.scrollingElement.scrollWidth, btns, top: [top.left, top.right] };
  });
  check('at 375 px: nothing sideways, the banner inside the screen, every button 44 px or more',
    lay.scroll <= 375 && lay.top[0] >= 0 && lay.top[1] <= 375 && lay.btns.every(([w, h]) => w >= 44 && h >= 44), J(lay));

  // A refusal of the position ends it.
  await pp.evaluate(() => window.__refuse());
  await pp.waitForFunction(() => window.__live.some(t => /not allowed to say where it is/.test(t)), null, { timeout: 3000 }).catch(() => {});
  const refused = await pp.evaluate(() => ({ active: DriveMode.active(), live: window.__live.filter(t => /not allowed/.test(t)).pop() || '', watch: window.__geo.watchers.size }));
  check('the position refused: the drive ends, saying so and offering the preview', !refused.active && refused.watch === 0
    && /not allowed to say where it is/.test(refused.live) && /Preview/.test(refused.live), J(refused));
  await phone.context.close();

  check('no pageerror', errors.length === 0, errors.join(' | '));
} catch (err) {
  if (String(err && err.message) !== 'no-webgl') throw err;
} finally {
  await browser.close();
  await server.close();
}

if (!gl2) {
  console.log('\n  SKIP — this browser has no WebGL2, so the drive cannot be checked here.');
  process.exit(0);
}

const failed = results.filter(r => !r.pass);
console.log('');
console.log(`  ${results.length} assertion(s).`);
if (failed.length) {
  console.log('');
  console.log(`FAIL — ${failed.length} assertion(s):`);
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${String(f.detail).slice(0, 300)}` : ''}`);
  process.exit(1);
}
console.log(`PASS — ${results.length} checks: the route followed in 3-D, heading up with the car where the screen leaves room for it; the next turn shown and said in time; the stations ahead named; the drive kept through a render of the tab and given back as it found the map; and on a phone, the position followed and the route asked for again when the car leaves it.`);
