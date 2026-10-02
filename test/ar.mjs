// The AR station finder (station-ar.js) — 🔭 in the Stations side panel.
//
// Everything it shows is arithmetic on readings nobody else can see. A heading
// eleven degrees out still draws a tidy row of pins; a station gathered into
// the wrong direction still opens a sheet with its number on it; a camera left
// running after the view is shut is invisible on a desktop. `smoke` sees none
// of it — the view is not open until somebody presses — so the arithmetic is
// held first, under Node, against references that are not the module's own:
//
//   The World Magnetic Model — WMM2025 against NOAA's published test values
//       (WMM2025_TEST_VALUES.txt, shipped beside the coefficients): the
//       field's three components to the 0.1 nT they are printed to, and the
//       declination to the 0.01°, at three places, two heights and two dates.
//   The phone's attitude — the camera's heading, tilt and roll from alpha,
//       beta and gamma, for poses built by hand: upright facing north, turned
//       east, tipped up 30°, rolled 10° (where the three angles swing to ±90°
//       and the matrix they make does not), and held in landscape.
//   The directions — every station in exactly one, each led by its nearest, no
//       two leads within the width of each other, every member within the
//       width of its lead; and no two labels in one row overlapping.
//
// Then the finder in the app, on a phone (Chromium's fake camera, a GPS fix the
// harness sets, compass readings dispatched as the browser would) and on a
// desktop:
//
//   🔭 in the side panel's first group, and its pane; Look around opening the
//   view with the camera, the GPS and the compass; every station the map shows
//   within the distance — measured here by a haversine that is not the app's —
//   in exactly one direction; the heading true north by the declination where
//   the phone stands; the pins on the screen exactly the directions in the
//   view, each stem's foot on its bearing and no two labels in a row
//   overlapping; F, R and B in their roles' colours; a pin tapped opening its
//   station's sheet with its number and ALERT IDs; "I'm facing it" moving north
//   onto that station and Undo moving it back; the slider and the types
//   changing what is gathered, the pane's controls following; an iPhone's
//   compass (a gyro with no north and webkitCompassHeading beside it) giving
//   the same heading, following a turn, and shrugging off a spike; Escape
//   putting the sheet down, then the view — the camera's tracks ended, the GPS
//   watch cleared, the compass listeners gone, focus back on Look around; Show
//   on the map handing the station to its card; and on a desktop the map's
//   centre, no camera asked for, ← → and a drag turning the view.
//
//   npm run ar        (-v to print what passed)

import fs from 'node:fs';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  if (!pass || VERBOSE) console.log(`  ${pass ? '✓' : '✗'} ${name}${detail && !pass ? ' — ' + detail : ''}`);
}

const SRC = fs.readFileSync(new URL('../station-ar.js', import.meta.url), 'utf8');
const AR = new Function('window', `${SRC}\nreturn StationAR;`)({});

// ── The World Magnetic Model ─────────────────────────────────────────────────
// NOAA's WMM2025_TEST_VALUES.txt: date, height (km), latitude, longitude, X, Y,
// Z (nT) and the declination (°).
console.log('\nWMM2025 against NOAA\'s test values\n');
const WMM_TESTS = [
  [2025.0,   0,  80,   0,  6521.6,   145.9,  54791.5,  1.28],
  [2025.0,   0,   0, 120, 39677.8,  -109.6, -10580.2, -0.16],
  [2025.0,   0, -80, 240,  6117.5, 15751.9, -52022.5, 68.78],
  [2025.0, 100,  80,   0,  6216.0,    92.4,  52598.8,  0.85],
  [2025.0, 100,   0, 120, 37688.6,   -96.2, -10152.1, -0.15],
  [2025.0, 100, -80, 240,  5907.6, 14780.3, -49540.7, 68.21],
  [2027.5,   0,  80,   0,  6500.8,   294.5,  54869.4,  2.59],
  [2027.5,   0,   0, 120, 39701.6,  -167.4, -10381.8, -0.24],
  [2027.5,   0, -80, 240,  6200.7, 15730.3, -51783.7, 68.49],
  [2027.5, 100,  80,   0,  6196.7,   233.8,  52670.5,  2.16],
  [2027.5, 100,   0, 120, 37711.5,  -148.7,  -9969.8, -0.23],
  [2027.5, 100, -80, 240,  5984.0, 14760.1, -49317.7, 67.93],
];
for (const [yr, h, lat, lon, X, Y, Z, D] of WMM_TESTS) {
  const f = AR.wmmField(lat, lon, h, yr);
  const nT = Math.max(Math.abs(f.x - X), Math.abs(f.y - Y), Math.abs(f.z - Z));
  const dD = Math.abs(f.decl - D);
  check(`${yr} ${h} km ${lat}° ${lon}°: X Y Z to 0.1 nT, declination ${D}° to 0.01°`,
    nT <= 0.051 && dD <= 0.0051,
    JSON.stringify({ x: f.x.toFixed(2), y: f.y.toFixed(2), z: f.z.toFixed(2), decl: f.decl.toFixed(4) }));
}

// ── The phone's attitude ─────────────────────────────────────────────────────
console.log('\nThe camera\'s heading, tilt and roll from alpha, beta, gamma\n');
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const angNear = (a, b, tol = 1e-6) => Math.abs(((a - b) % 360 + 540) % 360 - 180) <= tol;
const pose = (name, [a, b, g], screen, want) => {
  const v = AR.orient(a, b, g);
  const got = { h: AR.headingOf(v), p: AR.pitchOf(v), r: AR.rollOf(v, screen) };
  check(`${name}: heading ${want.h}°, tilt ${want.p}°, roll ${want.r}°`,
    angNear(got.h, want.h) && near(got.p, want.p) && near(got.r, want.r), JSON.stringify(got));
};
pose('upright, facing north',               [0, 90, 0],     0,  { h: 0,  p: 0,  r: 0 });
pose('upright, turned to face east',        [270, 90, 0],   0,  { h: 90, p: 0,  r: 0 });
pose('upright, facing south-west',          [135, 90, 0],   0,  { h: 225, p: 0, r: 0 });
pose('tipped back to look 30° up',          [0, 120, 0],    0,  { h: 0,  p: 30, r: 0 });
// Upright, facing north, rolled 10° clockwise: the spec's angles for that are
// alpha 90, beta 100, gamma −90 — two of the three nowhere near the pose.
pose('rolled 10° clockwise (gamma at −90°)', [90, 100, -90], 0,  { h: 0,  p: 0,  r: -10 });
// Landscape, top edge to the left, facing north: level on a screen turned 90°.
pose('landscape, facing north',             [90, 0, -90],   90, { h: 0,  p: 0,  r: 0 });

// ── The directions ───────────────────────────────────────────────────────────
console.log('\nStations into directions, directions into rows\n');
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const items = Array.from({ length: 400 }, (_, i) => ({
  // Bunched as a network is: a few dense bearings and a scatter.
  b: (rnd() < 0.5 ? [40, 41, 200, 330][i % 4] + rnd() * 6 : rnd() * 360) % 360,
  d: 0.1 + rnd() * 30,
  s: { id: `s${i}`, name: `Station ${'x'.repeat(i % 25)}` },
})).sort((p, q) => p.d - q.d);
const WIDTH = 4;
const clusters = AR.clusterByBearing(items, WIDTH);
const all = clusters.flatMap(c => c.members.map(m => m.s.id));
const wrap = x => (((x % 360) + 540) % 360) - 180;
check('every station in exactly one direction', all.length === items.length && new Set(all).size === items.length,
  `${all.length} of ${items.length}`);
check('each direction led by its nearest station',
  clusters.every(c => c.members.every(m => m.d >= c.members[0].d) && c.b === c.members[0].b && c.d === c.members[0].d));
check(`no two directions start within ${WIDTH}° of each other`,
  clusters.every((c, i) => clusters.every((o, j) => i === j || Math.abs(wrap(c.b - o.b)) > WIDTH)));
check(`every member within ${WIDTH}° of its direction`,
  clusters.every(c => c.members.every(m => Math.abs(wrap(m.b - c.b)) <= WIDTH)));
check('the directions come out nearest first', clusters.every((c, i) => i === 0 || clusters[i - 1].d <= c.d));
const fits = AR.layoutRows(clusters, 11, 5);
const clashes = [];
for (const c of clusters) for (const o of clusters) {
  if (c !== o && c.row === o.row && Math.abs(wrap(c.b - o.b)) < c.half + o.half - 1e-9) clashes.push([c.b, o.b]);
}
check('no two labels in one row overlap, round the whole circle', fits && clashes.length === 0,
  JSON.stringify({ fits, clashes: clashes.slice(0, 3) }));
check('the nearest direction is on the lowest row', clusters[0].row === 0);

// ── In the app ───────────────────────────────────────────────────────────────

const R = 6371.0088, rad = Math.PI / 180;
function haversineKm(a, b) {
  const dp = (b.lat - a.lat) * rad, dl = (b.lon - a.lon) * rad;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
function bearing(a, b) {
  const p1 = a.lat * rad, p2 = b.lat * rad, dl = (b.lon - a.lon) * rad;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

// Where the phone stands: on the station nearest Brisbane's centre, so "you're
// at" has something to say and that station is no direction at all.
const DATA = JSON.parse(fs.readFileSync(new URL('../stations.json', import.meta.url), 'utf8'));
const CBD = { lat: -27.4698, lon: 153.0251 };
const STAND = DATA.stations.filter(s => s.lat != null && s.lon != null)
  .reduce((best, s) => (!best || haversineKm(CBD, s) < haversineKm(CBD, best) ? s : best), null);
const HERE = { lat: STAND.lat, lon: STAND.lon };

const frames = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

// What the finder should hold at `here` within `km`, from the stations the map
// shows (the finder promises the map's filters) measured by this file's own
// haversine — and whether it does.
async function gathered(page, here, km, label, roles = null) {
  const list = await page.evaluate(() => filteredStations()
    .filter(s => s.lat != null && s.lon != null && isFinite(s.lat) && isFinite(s.lon))
    .map(s => ({ id: s.id, lat: s.lat, lon: s.lon, role: primaryRole(s) })));
  const want = new Map(), edge = new Set();
  for (const s of list) {
    if (roles && !roles.includes(s.role)) continue;
    const d = haversineKm(here, s);
    if (Math.abs(d - km) < 0.001 || Math.abs(d - 0.02) < 0.001) { edge.add(s.id); continue; }
    if (d <= km && d >= 0.02) want.set(s.id, { d, b: bearing(here, s) });
  }
  const dbg = await page.evaluate(() => StationAR.debug());
  const got = (dbg.clusters || []).flatMap(c => c.ids).filter(id => !edge.has(id));
  const gotSet = new Set(got);
  const missing = [...want.keys()].filter(id => !gotSet.has(id));
  const extra = got.filter(id => !want.has(id));
  check(`${label}: every station within ${km} km in exactly one direction (${want.size})`,
    !missing.length && !extra.length && got.length === gotSet.size,
    JSON.stringify({ missing: missing.slice(0, 5), extra: extra.slice(0, 5), dup: got.length - gotSet.size }));
  const leadsOk = (dbg.clusters || []).every(c => c.ids.every(id => !want.has(id) || want.get(id).d >= c.d - 1e-6)
    && c.ids.every(id => !want.has(id) || Math.abs(wrap(want.get(id).b - c.b)) <= dbg.width + 1e-6));
  check(`${label}: each direction led by its nearest, its members within ${dbg.width && dbg.width.toFixed(2)}°`, leadsOk);
  return { want, dbg };
}

// The pins on the screen, against the directions in view at this heading.
async function pinsAgree(page, label) {
  await frames(page);
  const dbg = await page.evaluate(() => StationAR.debug());
  const { f, w, heading } = dbg;
  const expect = [], unsure = new Set();
  for (const c of dbg.clusters) {
    const rel = wrap(c.b - heading);
    if (Math.abs(rel) >= 80) continue;
    const x = w / 2 + f * Math.tan(rel * rad);
    if (Math.abs(x + 8) < 1 || Math.abs(x - (w + 8)) < 1) { unsure.add(c.id); continue; }
    if (x > -8 && x < w + 8) expect.push({ id: c.id, x });
  }
  const vis = dbg.visible.filter(id => !unsure.has(id));
  const wantIds = expect.map(e => e.id);
  check(`${label}: the pins on the screen are the directions in view (${wantIds.length})`,
    vis.length === wantIds.length && wantIds.every(id => vis.includes(id)),
    JSON.stringify({ vis, wantIds }));
  const dom = await page.evaluate(() => [...document.querySelectorAll('.ar-pin:not([hidden])')].map(el => {
    const box = el.querySelector('.ar-pin-box').getBoundingClientRect();
    const stem = el.querySelector('.ar-pin-stem').getBoundingClientRect();
    return { id: el.dataset.id, row: getComputedStyle(el).getPropertyValue('--ar-row').trim(),
             l: box.left, r: box.right, h: box.height, foot: (stem.left + stem.right) / 2 };
  }));
  const feet = dom.map(p => ({ p, e: expect.find(e => e.id === p.id) })).filter(x => x.e);
  check(`${label}: each stem's foot on its station's bearing`,
    feet.every(({ p, e }) => Math.abs(p.foot - e.x) <= 1.5), JSON.stringify(feet.slice(0, 3).map(({ p, e }) => [p.foot, e.x])));
  const overlaps = [];
  for (const a of dom) for (const b of dom) {
    if (a !== b && a.row === b.row && a.l < b.r - 1 && b.l < a.r - 1) overlaps.push([a.id, b.id]);
  }
  check(`${label}: no two labels in one row overlap on the screen`, !overlaps.length, JSON.stringify(overlaps.slice(0, 3)));
  check(`${label}: every label a finger's height`, dom.every(p => p.h >= 43.5), JSON.stringify(dom.map(p => p.h)));
  return { dbg, expect };
}

const absolute = (page, trueHeading, decl, n = 40) => page.evaluate(([alpha, n]) => {
  for (let i = 0; i < n; i++) {
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientationabsolute', { alpha, beta: 90, gamma: 0, absolute: true }));
  }
}, [((360 - (trueHeading - decl)) % 360 + 360) % 360, n]);

// An iPhone's reading: a gyro alpha against wherever it started (`gyroZero`)
// and the compass's magnetic heading beside it.
const iphone = (page, magnetic, gyroZero, compassSays = magnetic, n = 40) => page.evaluate(([alpha, w, n]) => {
  for (let i = 0; i < n; i++) {
    const ev = new Event('deviceorientation');
    for (const [k, v] of Object.entries({ alpha, beta: 90, gamma: 0, absolute: false,
                                          webkitCompassHeading: w, webkitCompassAccuracy: 10 })) {
      Object.defineProperty(ev, k, { value: v });
    }
    window.dispatchEvent(ev);
  }
}, [(((360 - magnetic) + gyroZero) % 360 + 360) % 360, compassSays, n]);

const server = await startServer();
const browser = await launchBrowser({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const errors = [];

try {
  // ── A phone ────────────────────────────────────────────────────────────────
  console.log(`\nOn a phone, standing on ${STAND.name}\n`);
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    geolocation: { latitude: HERE.lat, longitude: HERE.lon, accuracy: 6 },
    permissions: ['geolocation', 'camera'],
  });
  const page = await phone.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(`phone: ${e.message}`));
  await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 1000, null, { timeout: 30_000 });

  // Spies on what the view starts, so its going can be seen to stop it.
  await page.evaluate(() => {
    const g = navigator.geolocation;
    const watch = g.watchPosition.bind(g), clear = g.clearWatch.bind(g);
    window.__geo = new Set();
    g.watchPosition = (...a) => { const id = watch(...a); window.__geo.add(id); return id; };
    g.clearWatch = id => { window.__geo.delete(id); return clear(id); };
    const add = window.addEventListener.bind(window), rem = window.removeEventListener.bind(window);
    window.__orient = new Set();
    window.addEventListener = (t, fn, o) => { if (/^deviceorientation/.test(t)) window.__orient.add(t); return add(t, fn, o); };
    window.removeEventListener = (t, fn, o) => { if (/^deviceorientation/.test(t)) window.__orient.delete(t); return rem(t, fn, o); };
  });

  // ⋮ brings the rail out; 🔭 is in its first group, after 🧊.
  if (await page.isVisible('#btn-side')) await page.click('#btn-side');
  const side = await page.evaluate(() => [...document.querySelectorAll('#help-panel .dock-group[data-group="side"] .dock-tab')]
    .map(b => b.dataset.dock));
  check('🔭 is in the side panel\'s first group, after 🧊', JSON.stringify(side.slice(-2)) === '["twin","ar"]', JSON.stringify(side));
  await page.click('#help-panel .dock-tab[data-dock="ar"]');
  await page.waitForTimeout(300);
  const pane = await page.evaluate(() => ({
    showing: dockShowing(),
    h: document.getElementById('ar-pane-h')?.textContent.trim(),
    range: document.getElementById('ar-pane-range')?.value,
    out: document.getElementById('ar-pane-range-out')?.textContent,
    note: document.getElementById('ar-pane-note')?.textContent,
    roles: [...document.querySelectorAll('#dock-pane-ar .ar-role')].map(b => `${b.textContent.trim()}:${b.getAttribute('aria-pressed')}`),
  }));
  check('its pane opens: the finder, 30 km, three types on, and what it will show',
    pane.showing === 'ar' && /AR station finder/.test(pane.h) && pane.out === '30 km'
      && JSON.stringify(pane.roles) === '["FField:true","RRepeater:true","BBase:true"]' && /stations with a position/.test(pane.note),
    JSON.stringify(pane));

  await page.tap('#ar-pane-gps');
  await page.waitForFunction(() => StationAR.debug().here && StationAR.debug().camera === 'on'
    && document.getElementById('ar-cam').videoWidth > 0, null, { timeout: 15_000 });
  await page.waitForTimeout(300);
  const opened = await page.evaluate(() => {
    const v = document.getElementById('ar-view');
    const letter = getComputedStyle(document.documentElement).getPropertyValue('--role-field').trim();
    return { role: v?.getAttribute('role'), modal: v?.getAttribute('aria-modal'), theme: v?.dataset.theme,
             pageRoleField: letter, viewRoleField: getComputedStyle(v).getPropertyValue('--role-field').trim(),
             watching: window.__geo.size, orient: [...window.__orient].sort(), focusIn: v.contains(document.activeElement),
             sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
  });
  check('Look around opens a modal dialog, dark in a light page, focus inside it',
    opened.role === 'dialog' && opened.modal === 'true' && opened.theme === 'dark'
      && opened.viewRoleField !== opened.pageRoleField && opened.focusIn && !opened.sideways, JSON.stringify(opened));
  check('…with the camera on, the GPS watched and the compass listened to',
    opened.watching === 1 && JSON.stringify(opened.orient) === '["deviceorientation","deviceorientationabsolute"]',
    JSON.stringify(opened));

  const decl = AR.declination(HERE.lat, HERE.lon, 0);
  let { want, dbg } = await gathered(page, HERE, 30, 'at 30 km');
  check(`the GPS fix is where the view stands, and the station under it is no direction — "You're at" it`,
    near(dbg.here.lat, HERE.lat) && near(dbg.here.lon, HERE.lon) && !dbg.clusters.some(c => c.ids.includes(STAND.id))
      && (await page.textContent('#ar-count')).includes(`You're at ${STAND.name}`), JSON.stringify(dbg.here));

  // Face the nearest station, by an Android compass: magnetic, so the heading
  // the finder holds is that plus the declination where the phone stands.
  const nearest = [...want.entries()].sort((a, b) => a[1].d - b[1].d)[0];
  await absolute(page, nearest[1].b, decl);
  await frames(page);
  dbg = await page.evaluate(() => StationAR.debug());
  check(`an Android compass: absolute, and its heading turned to true north by ${decl.toFixed(2)}°`,
    dbg.compass === 'absolute' && near(dbg.decl, decl, 1e-9) && angNear(dbg.heading, nearest[1].b, 0.01),
    JSON.stringify({ compass: dbg.compass, decl: dbg.decl, heading: dbg.heading, want: nearest[1].b }));
  const head = await page.textContent('#ar-heading');
  check('the heading is written as a bearing and a point', /^\d{3}° [NSEW]{1,3}$/.test(head.trim()), head);
  await pinsAgree(page, 'facing the nearest station');

  // The pins say what they are: their letter, their colour, their count.
  const pins = await page.evaluate(() => [...document.querySelectorAll('.ar-pin:not([hidden])')].map(el => ({
    id: el.dataset.id, cls: el.className,
    letter: el.querySelector('.ar-letter').textContent,
    bg: getComputedStyle(el.querySelector('.ar-letter')).backgroundColor,
    n: el.querySelector('.ar-pin-n')?.textContent || '1',
    name: el.querySelector('.ar-pin-name').textContent,
    label: el.querySelector('.ar-pin-box').getAttribute('aria-label'),
  })));
  dbg = await page.evaluate(() => StationAR.debug());
  const COLOUR = { field: 'rgb(87, 214, 87)', repeater: 'rgb(107, 182, 255)', base: 'rgb(255, 138, 99)' };
  const pinOk = pins.every(p => {
    const c = dbg.clusters.find(x => x.id === p.id);
    return c && p.letter === { field: 'F', repeater: 'R', base: 'B' }[c.role] && p.bg === COLOUR[c.role]
      && p.n === String(c.n) && p.name === c.name && p.label.includes(c.name)
      && (c.n === 1 || p.label.includes(`${c.n} stations this way`));
  });
  check('each pin: its nearest station\'s name, F/R/B in its role\'s colour, and how many stand that way',
    pins.length > 0 && pinOk, JSON.stringify(pins.slice(0, 2)));

  // A pin tapped: the station's sheet.
  await page.tap(`.ar-pin[data-id="${nearest[0]}"] .ar-pin-box`);
  await page.waitForTimeout(150);
  const sheet = await page.evaluate(id => {
    const s = state.data.stations.find(x => x.id === id);
    const el = document.getElementById('ar-detail');
    return { hidden: el.hidden, name: document.getElementById('ar-detail-h')?.textContent, want: s.name,
             text: el.textContent.replace(/\s+/g, ' '), number: s.station_number, ids: stationAlertIds(s),
             focus: el.contains(document.activeElement) || document.activeElement === el };
  }, nearest[0]);
  check('a pin tapped opens its station\'s sheet: its name, its number, its ALERT IDs',
    !sheet.hidden && sheet.name === sheet.want && (!sheet.number || sheet.text.includes(`Stn # ${sheet.number}`))
      && (sheet.ids.length ? sheet.ids.every(i => sheet.text.includes(String(i))) : sheet.text.includes('No ALERT IDs on file'))
      && sheet.focus, JSON.stringify(sheet));

  // "I'm facing it": the compass 7° out, put right on the station.
  await absolute(page, nearest[1].b + 7, decl);
  await frames(page);
  await page.click('#ar-detail .ar-detail-actions button:nth-child(2)');
  await frames(page);
  dbg = await page.evaluate(() => StationAR.debug());
  const unalign = await page.evaluate(() => ({ hidden: document.getElementById('ar-unalign').hidden, text: document.getElementById('ar-unalign').textContent }));
  check('"I\'m facing it" moves north so the station is dead ahead, and offers to undo it',
    angNear(dbg.heading, nearest[1].b, 0.02) && near(dbg.align, -7, 0.02) && !unalign.hidden && /−7°/.test(unalign.text),
    JSON.stringify({ heading: dbg.heading, align: dbg.align, unalign }));
  await page.click('#ar-unalign');
  await frames(page);
  dbg = await page.evaluate(() => StationAR.debug());
  check('…and Undo puts it back', dbg.align === 0 && angNear(dbg.heading, nearest[1].b + 7, 0.02), JSON.stringify(dbg.heading));

  // The distance and the types.
  await page.keyboard.press('Escape');
  const idx5 = AR.RANGES_KM.indexOf(5);
  await page.$eval('#ar-range', (el, v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, idx5);
  await frames(page);
  await gathered(page, HERE, 5, 'the slider at 5 km');
  const sync = await page.evaluate(() => ({ pane: document.getElementById('ar-pane-range').value,
    outs: [document.getElementById('ar-pane-range-out').textContent, document.getElementById('ar-range-out').textContent],
    stored: localStorage.getItem('mn-ar-range'), count: document.getElementById('ar-count').textContent }));
  check('…the pane\'s slider follows, both say 5 km, and it is remembered',
    sync.pane === String(idx5) && sync.outs.every(t => t === '5 km') && sync.stored === String(idx5) && /within 5 km/.test(sync.count),
    JSON.stringify(sync));
  // Field stations off, out to 100 km — where there are repeaters and bases
  // to be left with.
  await page.$eval('#ar-range', (el, v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, AR.RANGES_KM.indexOf(100));
  await page.tap('#ar-view .ar-role[data-role="field"]');
  await frames(page);
  const left = await gathered(page, HERE, 100, 'field stations switched off', ['repeater', 'base']);
  const pressed = await page.evaluate(() => [...document.querySelectorAll('.ar-role[data-role="field"]')].map(b => b.getAttribute('aria-pressed')));
  check('…leaving repeaters and bases only, and both Field toggles say so',
    left.want.size > 0 && left.dbg.clusters.every(c => c.role !== 'field') && JSON.stringify(pressed) === '["false","false"]',
    JSON.stringify({ n: left.want.size, pressed }));
  await page.tap('#ar-view .ar-role[data-role="field"]');
  await page.$eval('#ar-range', (el, v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, AR.RANGES_KM.indexOf(30));
  await frames(page);

  // Escape twice: the sheet, then the view — and everything it started, stopped.
  await page.tap(`.ar-pin[data-id="${nearest[0]}"] .ar-pin-box`);
  await page.evaluate(() => { window.__tracks = document.getElementById('ar-cam').srcObject.getTracks(); });
  await page.keyboard.press('Escape');
  const once = await page.evaluate(() => ({ open: StationAR.debug().open, pick: StationAR.debug().pick,
    focus: document.activeElement?.closest('.ar-pin')?.dataset.id }));
  check('Escape puts the sheet down, focus on its pin', once.open && once.pick === null && once.focus === nearest[0], JSON.stringify(once));
  await page.keyboard.press('Escape');
  const shut = await page.evaluate(() => ({ view: !!document.getElementById('ar-view'), tracks: window.__tracks.map(t => t.readyState),
    watching: window.__geo.size, orient: window.__orient.size, focus: document.activeElement?.id, drawer: dockShowing() }));
  check('…and again shuts the view: the camera\'s tracks ended, the GPS watch cleared, the compass let go, focus on Look around',
    !shut.view && shut.tracks.length > 0 && shut.tracks.every(s => s === 'ended') && shut.watching === 0 && shut.orient === 0
      && shut.focus === 'ar-pane-gps' && shut.drawer === 'ar', JSON.stringify(shut));

  // An iPhone: the gyro's alpha has no north in it; webkitCompassHeading does.
  console.log('\nAn iPhone\'s compass\n');
  await page.tap('#ar-pane-gps');
  await page.waitForFunction(() => StationAR.debug().here, null, { timeout: 15_000 });
  const m0 = 100;
  await iphone(page, m0, 37);
  await frames(page);
  dbg = await page.evaluate(() => StationAR.debug());
  check('a gyro with no north and the compass beside it: the same true heading as Android\'s',
    dbg.compass === 'ios' && angNear(dbg.heading, m0 + decl, 0.05), JSON.stringify({ compass: dbg.compass, heading: dbg.heading }));
  await iphone(page, m0 + 30, 37);
  await frames(page);
  dbg = await page.evaluate(() => StationAR.debug());
  check('…a turn of 30° followed', angNear(dbg.heading, m0 + 30 + decl, 0.1), JSON.stringify(dbg.heading));
  await iphone(page, m0 + 30, 37, m0 + 50, 3);
  await frames(page);
  const spike = await page.evaluate(() => StationAR.debug().heading);
  check('…and a 20° spike in the compass moves it by less than 3.5°', Math.abs(wrap(spike - (m0 + 30 + decl))) < 3.5, String(spike));

  // Show on the map: the station's card, the drawer put away.
  await iphone(page, m0 + 30, 37, m0 + 30, 60);
  await absolute(page, nearest[1].b, decl);   // an absolute reading takes over, as it would
  await frames(page);
  await page.tap(`.ar-pin[data-id="${nearest[0]}"] .ar-pin-box`);
  await page.click('#ar-detail .ar-detail-actions button.primary');
  await page.waitForTimeout(400);
  const handed = await page.evaluate(() => ({ view: !!document.getElementById('ar-view'), card: state.stnCard.id, drawer: dockShowing() }));
  check('Show on the map: the view shut, the station\'s card open, the drawer put away',
    !handed.view && handed.card === nearest[0] && handed.drawer === null, JSON.stringify(handed));
  await phone.close();

  // ── A desktop ──────────────────────────────────────────────────────────────
  console.log('\nOn a desktop, from the map\'s centre\n');
  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const dp = await desk.newPage();
  await applyNetworkPolicy(dp, server.origin);
  dp.on('pageerror', e => errors.push(`desktop: ${e.message}`));
  await dp.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await dp.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
  await dp.evaluate(() => switchTab('stations'));
  await dp.waitForFunction(() => !!state.map && state.mapMarkers.length > 1000, null, { timeout: 30_000 });
  const CENTRE = { lat: -27.5636, lon: 152.2797 };
  await dp.evaluate(c => {
    state.map.setView([c.lat, c.lon], 11, { animate: false });
    window.__gum = 0;
    const md = navigator.mediaDevices;
    if (md) { const gum = md.getUserMedia.bind(md); md.getUserMedia = (...a) => { window.__gum++; return gum(...a); }; }
  }, CENTRE);
  await dp.click('#help-panel .dock-tab[data-dock="ar"]');
  await dp.click('#ar-pane-map');
  await dp.waitForFunction(() => StationAR.debug().compass === 'none', null, { timeout: 10_000 });
  dbg = await dp.evaluate(() => StationAR.debug());
  const asked = await dp.evaluate(() => window.__gum);
  check('From the map\'s centre: standing there, no camera asked for, no compass, turning by hand',
    dbg.source === 'map' && near(dbg.here.lat, CENTRE.lat, 1e-6) && near(dbg.here.lon, CENTRE.lon, 1e-6)
      && dbg.camera === 'off' && asked === 0 && !dbg.gps && /drag or ← → to turn/.test(await dp.textContent('#ar-status')),
    JSON.stringify({ source: dbg.source, here: dbg.here, camera: dbg.camera, asked, gps: dbg.gps }));
  await gathered(dp, CENTRE, 30, 'from the map\'s centre');
  for (let i = 0; i < 3; i++) await dp.keyboard.press('ArrowRight');
  await dp.keyboard.press('Shift+ArrowLeft');
  await frames(dp);
  dbg = await dp.evaluate(() => StationAR.debug());
  check('→ turns 5° and Shift+← 20°', angNear(dbg.heading, 355), String(dbg.heading));
  await pinsAgree(dp, 'facing 355°');
  const stage = await dp.evaluate(() => { const r = document.getElementById('ar-stage').getBoundingClientRect(); return { x: r.width / 2, y: r.height * 0.75 }; });
  await dp.mouse.move(stage.x, stage.y);
  await dp.mouse.down();
  await dp.mouse.move(stage.x + 200, stage.y, { steps: 5 });
  await dp.mouse.up();
  await frames(dp);
  const dragged = await dp.evaluate(() => StationAR.debug());
  check('a drag of 200 px to the right turns the view left by 200 px of it',
    angNear(dragged.heading, 355 - 200 / (dragged.f * rad), 0.01), JSON.stringify({ heading: dragged.heading, f: dragged.f }));
  await pinsAgree(dp, 'after the drag');
  await dp.click('.ar-close');
  check('✕ shuts it, focus back on the button that opened it',
    await dp.evaluate(() => !document.getElementById('ar-view') && document.activeElement?.id === 'ar-pane-map'));
  await desk.close();
} finally {
  await browser.close();
  server.close();
}

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log(`FAIL — ${failed.length} failed`); process.exit(1); }
console.log('PASS — the AR station finder');
