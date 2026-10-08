// The Field Camera (field-camera.js, photo-stamp.js) — 📸 under Site visits.
//
// Everything this tab does is out of sight of `smoke`, which opens it and sees
// a Start button. The camera, the GPS and the compass are not running until
// somebody presses; the stamp is pixels; the record goes to a database the
// harness blocks; and a photo kept on the device for want of a signal looks,
// on screen, exactly like one that will never be sent. So:
//
//   1. photo-stamp.js on its own, under Node — the file this check require()s
//      is the one the camera runs. The EXIF it writes, read back by
//      PhotoMeta.read (the reader every other door uses): the position to the
//      millimetre, the ±, the altitude and its sign, the true heading, the GPS
//      clock, the shutter's local time with its offset, the software, a
//      description in UTF-8 — spliced after a JFIF header, and replaced rather
//      than doubled when written twice. The panel's words — Solocator's eight
//      compass words, six places, the ± and the height with its datum, the
//      zone by name only where the reader knows it — and the panel as text,
//      read back by PhotoMeta.vote into the same position, heading, ±, height
//      and time.
//
//   2. The tab in Chromium, as a phone: the fake camera, a GPS fix the harness
//      sets (with a height, and without one), compass readings dispatched as
//      Android and an iPhone send them, a timezone, and a fake project
//      (lib/photo-project.mjs, lib/storage.mjs) that records what was sent.
//      Nothing asked for before Start; then the camera, the GPS and both
//      compass streams; the heading true by the declination where the phone
//      stands, none pointed at the ground; the stations suggested — where you
//      stand, in view, the last photo's — and the one on the stamp. Photos
//      taken signed out kept on the device, through a reload, sending nothing;
//      signed in, sent by themselves in the order the Field Photos tab sends
//      them (asked by hash, bytes, thumbnail, row), filed under the station on
//      the stamp, logged, and let go. Picked by hand, "No station", a station
//      the database refuses, an account that may not add photos, the same
//      photo already there, no network and the network back. A photo from the
//      camera app placed and filed by its own EXIF — and that photo, stripped
//      of its EXIF as Messages would strip it, read back by the real OCR
//      engine into the same place, heading, ±, height, time and station. The
//      town asked of OpenStreetMap once, and not at all when switched off.
//      Leaving the tab letting the camera, the GPS and the compass go;
//      coming back taking them up again; a re-render keeping the picture.
//
// What is *not* here: 0035's rules, which tools/check_field_photos.sql holds
// against a real Postgres; and the compass arithmetic and the World Magnetic
// Model, which `npm run ar` holds (this tab uses station-ar.js's).
//
// Run:  npm run camera
//       npm run camera -- -v    also print what passed

// The phone's clock is Brisbane's — set before the first Date is made, so the
// Node half's local times are the ones the browser half's context keeps.
process.env.TZ = 'Australia/Brisbane';

import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { auditHandlers } from './lib/controls.mjs';
import { storageStore, installStorage } from './lib/storage.mjs';
import { photoProject, installPhotoProject, serveObjects } from './lib/photo-project.mjs';
import { jpegShell } from './lib/exif.mjs';

const require = createRequire(import.meta.url);
const PhotoStamp = require('../photo-stamp.js');
const PhotoMeta = require('../photo-meta.js');

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const OCR_TIMEOUT = Number(process.env.OCR_TIMEOUT || 180_000);

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass: !!pass });
  if (!pass || VERBOSE) console.log(`  ${pass ? '✓' : '✗'} ${name}${detail && (!pass || VERBOSE) ? ` — ${detail}` : ''}`);
}
function section(title) { console.log(`\n${title}\n`); }
const J = v => JSON.stringify(v);
const near = (a, b, tol = 1e-6) => a != null && b != null && Math.abs(a - b) <= tol;
const angNear = (a, b, tol = 0.6) => a != null && Math.abs((((a - b) % 360) + 540) % 360 - 180) <= tol;
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');

// The JPEG segments up to the scan, as [marker, payload's first bytes].
function segments(b) {
  const out = [];
  let o = 2;
  while (o + 4 <= b.length && b[o] === 0xff) {
    const m = b[o + 1];
    if (m === 0xda || m === 0xd9) break;
    const len = (b[o + 2] << 8) | b[o + 3];
    out.push({ m, head: Buffer.from(b.subarray(o + 4, o + 10)).toString('latin1') });
    o += 2 + len;
  }
  return out;
}
// A JPEG with its EXIF taken out — what Messages, a chat app or an email sends.
function stripExif(b) {
  const keep = [b.subarray(0, 2)];
  let o = 2;
  while (o + 4 <= b.length && b[o] === 0xff) {
    const m = b[o + 1];
    if (m === 0xda || m === 0xd9) break;
    const end = o + 2 + ((b[o + 2] << 8) | b[o + 3]);
    if (!(m === 0xe1 && Buffer.from(b.subarray(o + 4, o + 8)).toString('latin1') === 'Exif')) keep.push(b.subarray(o, end));
    o = end;
  }
  keep.push(b.subarray(o));
  return Buffer.concat(keep.map(x => Buffer.from(x)));
}

// ═══ 1. photo-stamp.js, under Node ═══════════════════════════════════════════

section('The EXIF it writes, read back by PhotoMeta.read');

const WHEN = PhotoStamp.moment(new Date('2026-06-24T02:26:08.123Z'), 'AEST');
check('the shutter is the phone\'s local time, its offset, its zone by name and the instant',
  WHEN.local === '2026-06-24T12:26:08' && WHEN.offset === '+10:00' && WHEN.label === 'AEST'
    && WHEN.iso === '2026-06-24T02:26:08.123Z' && WHEN.sub === '123', J(WHEN));

const F0 = { lat: -27.554294, lon: 152.274116, accuracy: 4.4, alt: 134.25, heading: 242.4, headingRef: 'T',
             when: WHEN, width: 4032, height: 3024, description: 'Gatton AL (540156) — Logger cabinet' };
const shell = jpegShell(4032, 3024);
const stamped = Buffer.from(PhotoStamp.withExif(shell, PhotoStamp.app1(F0)));
let m = PhotoMeta.read(stamped);
check('the position, to the millimetre, from the GPS block (placement exif)',
  m.format === 'jpeg' && m.gps && m.gps.source === 'exif' && near(m.gps.lat, F0.lat, 1e-7) && near(m.gps.lon, F0.lon, 1e-7),
  J(m.gps));
check('the ±, the altitude and the datum the GPS block names',
  near(m.gps.accuracy, 4.4, 1e-9) && near(m.gps.alt, 134.25, 1e-9) && m.gps.datum === 'WGS-84', J(m.gps));
check('the heading, true',
  near(m.gps.heading, 242.4, 1e-9) && m.gps.headingRef === 'T', J(m.gps));
check('the GPS clock is UTC, to the second',
  m.gps.utc === '2026-06-24T02:26:08.000Z', m.gps.utc);
check('the shutter\'s local time with its offset, so no zone is guessed (OffsetTimeOriginal)',
  m.taken && m.taken.local === '2026-06-24T12:26:08' && m.taken.offset === '+10:00' && m.taken.zoneSource === 'exif'
    && m.taken.iso === '2026-06-24T02:26:08.000Z', J(m.taken));
check('signed as the Field Camera, upright, its pixel size, the description in UTF-8',
  m.software === 'Flood-Net Field Camera' && m.orientation === 1 && m.width === 4032 && m.height === 3024
    && m.description === F0.description, J({ software: m.software, orientation: m.orientation, description: m.description }));
const rec0 = PhotoMeta.reconcile(m, null);
check('PhotoMeta.reconcile places it from the file — no OCR needed', rec0.pos.placement === 'exif'
  && !PhotoMeta.needsOcr(m), J(rec0.pos));

m = PhotoMeta.read(PhotoStamp.withExif(shell, PhotoStamp.app1({ ...F0, lat: 33.8688, lon: -151.2093, alt: -3.2 })));
check('north and west, and below the sea, keep their signs',
  near(m.gps.lat, 33.8688, 1e-7) && near(m.gps.lon, -151.2093, 1e-7) && near(m.gps.alt, -3.2, 1e-9), J(m.gps));
m = PhotoMeta.read(PhotoStamp.withExif(shell, PhotoStamp.app1({ ...F0, heading: null, accuracy: null, alt: null })));
check('what was not known is not written: no heading, no ±, no altitude',
  m.gps && !('heading' in m.gps) && !('accuracy' in m.gps) && !('alt' in m.gps), J(m.gps));
m = PhotoMeta.read(PhotoStamp.withExif(shell, PhotoStamp.app1({ ...F0, lat: null, lon: null })));
check('no position: no GPS block, the time still there', m.gps === null && m.taken && m.taken.local === WHEN.local, J({ gps: m.gps, taken: m.taken }));

const JFIF = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0', 'latin1'),
                            Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0]), shell.subarray(2)]);
const once = Buffer.from(PhotoStamp.withExif(JFIF, PhotoStamp.app1(F0)));
const twice = Buffer.from(PhotoStamp.withExif(once, PhotoStamp.app1({ ...F0, heading: 10 })));
const segs = segments(twice);
check('after a JFIF header (exiftool\'s order), and replaced rather than doubled when written again',
  segs[0].m === 0xe0 && segs[1].m === 0xe1 && segs.filter(s => s.m === 0xe1 && s.head.startsWith('Exif')).length === 1
    && near(PhotoMeta.read(twice).gps.heading, 10, 1e-9), J(segs));
let threw = '';
try { PhotoStamp.withExif(Buffer.from('not a photo'), PhotoStamp.app1(F0)); } catch (e) { threw = e.message; }
check('a file that is not a JPEG is refused, not mangled', /not a JPEG/.test(threw), threw);

section('The panel\'s words');

check('Solocator\'s eight compass words', J([0, 22.4, 22.6, 46, 242, 337.6, 359.6].map(PhotoStamp.point8))
  === J(['N', 'N', 'NE', 'NE', 'SW', 'N', 'N']));
check('the heading as it prints it: 242°SW (T), and 359.6° as 0°N',
  PhotoStamp.headingText(242.4) === '242°SW (T)' && PhotoStamp.headingText(359.6) === '0°N (T)'
    && PhotoStamp.headingText(null) === '', J([PhotoStamp.headingText(242.4), PhotoStamp.headingText(359.6)]));
check('the position to six places with its ± to the metre (never ±0m)',
  PhotoStamp.positionText(-27.5542941, 152.2741159, 4.4) === '-27.554294°, 152.274116° ±4m'
    && PhotoStamp.positionText(-27.5, 152.25, 0.3) === '-27.500000°, 152.250000° ±1m'
    && PhotoStamp.positionText(-27.5, 152.25, null) === '-27.500000°, 152.250000°');
check('the height always with its datum',
  PhotoStamp.altitudeText(134.25, 'HAE') === '134m (HAE)' && PhotoStamp.altitudeText(95.21, 'AHD') === '95m (AHD)'
    && PhotoStamp.altitudeText(null, 'HAE') === '');
check('the station by name and number, the number not said twice',
  PhotoStamp.stationText({ name: 'Gatton AL', number: '540156' }) === 'Gatton AL (540156)'
    && PhotoStamp.stationText({ name: 'Bridge 40444', number: '40444' }) === 'Bridge 40444'
    && PhotoStamp.stationText(null) === '');
check('the file is named floodnet-, the station and the shutter\'s time',
  PhotoStamp.fileName({ station: { name: 'Gatton AL' }, when: WHEN }) === 'floodnet-gatton-al-20260624-122608.jpg'
    && PhotoStamp.fileName({ station: null, when: WHEN }) === 'floodnet-photo-20260624-122608.jpg');
const L = PhotoStamp.lines({ ...F0, station: { name: 'Gatton AL', number: '540156' }, project: 'BoM-FWIN', locality: 'Gatton', caption: 'Logger cabinet' });
check('bottom right: the station, the project, the time; bottom left: what it shows, then where',
  J(L.right) === J(['Gatton AL (540156)', 'BoM-FWIN', '2026-06-24, 12:26:08 AEST']) && J(L.left) === J(['Logger cabinet', 'Gatton']),
  J(L));
check('an empty project line is left out', J(PhotoStamp.lines({ ...F0, project: '' }).right) === J(['2026-06-24, 12:26:08 AEST']));

check('the zone by name only where it agrees with the clock: ACST in Brisbane is printed as UTC+10:00',
  PhotoStamp.moment(new Date('2026-06-24T02:26:08Z'), 'ACST').label === 'UTC+10:00'
    && PhotoStamp.moment(new Date('2026-06-24T02:26:08Z'), '').label === 'UTC+10:00');
process.env.TZ = 'Australia/Adelaide';
const ADL = PhotoStamp.moment(new Date('2026-01-10T00:00:00Z'), 'ACDT');
process.env.TZ = 'UTC';
const UTC = PhotoStamp.moment(new Date('2026-01-10T00:00:00Z'), 'GMT');
process.env.TZ = 'Australia/Brisbane';
check('Adelaide in summer is ACDT, +10:30; a phone on UTC prints UTC',
  ADL.offset === '+10:30' && ADL.label === 'ACDT' && ADL.local === '2026-01-10T10:30:00' && UTC.label === 'UTC' && UTC.offset === '+00:00',
  J({ ADL, UTC }));

section('The panel as text, read back by the overlay parser');

const HOME = { lat: -25, lon: 145, km: 3000 };
const CASES = [
  { label: 'Solocator\'s own photo', f: { ...F0, accuracy: 4, alt: 134, altRef: 'HAE' } },
  { label: 'no heading, a height above sea level, a zone the reader has no name for',
    f: { ...F0, heading: null, alt: 61.6, altRef: 'MSL', when: PhotoStamp.moment(new Date('2026-06-24T02:26:08Z'), '') } },
  { label: 'the ground\'s height in AHD, a heading due north', f: { ...F0, heading: 0.3, alt: 95.21, altRef: 'AHD', accuracy: 12 } },
  { label: 'Adelaide, in daylight saving', f: { ...F0, lat: -34.928499, lon: 138.600746, accuracy: 3, alt: 48, altRef: 'HAE', when: ADL } },
];
for (const c of CASES) {
  const f = { ...c.f, station: { name: 'Gatton AL', number: '540156' }, project: 'BoM-FWIN', locality: 'Gatton', caption: 'Staff gauge 1.25 m' };
  const v = PhotoMeta.vote([PhotoStamp.text(f)], { home: HOME });
  const lines = PhotoStamp.lines(f);
  const ok = v.coords && near(v.coords.lat, f.lat, 5e-7) && near(v.coords.lon, f.lon, 5e-7)
    && (f.heading == null ? !v.heading : v.heading && angNear(v.heading.heading, Math.round(f.heading) % 360, 0.01) && v.heading.ref === 'T')
    && v.accuracy && v.accuracy.accuracy === Math.max(1, Math.round(f.accuracy))
    && v.altitude && v.altitude.altitude === Math.round(f.alt) && v.altitude.ref === f.altRef
    && v.time && v.time.local === f.when.local && v.time.offset === f.when.offset;
  check(`${c.label}: ${lines.heading ? `${lines.heading} ` : ''}${lines.position} ${lines.altitude} · ${f.when.label}`, ok,
    J({ coords: v.coords && [v.coords.lat, v.coords.lon], heading: v.heading, accuracy: v.accuracy, altitude: v.altitude, time: v.time }));
}

// ═══ 2. The tab, in Chromium ════════════════════════════════════════════════

// Standing where the two Solocator photos were taken, beside the Gatton gauges:
// Gatton AL 41 m south, Gatton 58 m east-south-east (both within the 60 m that
// is "where you stand"), Gatton TM 717 m north-west, Gatton (40083) 1.5 km
// north-north-east.
const HERE = { lat: -27.554294, lon: 152.274116 };
const FAR = { lat: -27.55, lon: 152.31 };          // 3.6 km east: past the 2 km a picked station holds for

const errors = [];
const server = await startServer();
const browser = await launchBrowser({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const store = storageStore();
const db = photoProject();
let refuseNext = null;
let offline = false;
const nominatim = [];

// Spies on what the tab starts, so its going can be seen to stop it — and a
// GPS fix with a height in it, which the harness's own fix does not carry.
const SPIES = () => {
  window.__gum = 0;
  const md = navigator.mediaDevices;
  if (md && md.getUserMedia) {
    const gum = md.getUserMedia.bind(md);
    md.getUserMedia = c => { window.__gum++; window.__gumWant = c; return gum(c); };
  }
  const g = navigator.geolocation;
  const watch = g.watchPosition.bind(g), clear = g.clearWatch.bind(g);
  window.__geo = new Set();
  window.__alt = null;
  g.watchPosition = (ok, err, o) => {
    window.__geoOpts = o;
    const id = watch(p => ok({ timestamp: p.timestamp, coords: {
      latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy,
      altitude: window.__alt, altitudeAccuracy: window.__alt == null ? null : 9, heading: null, speed: null,
    } }), err, o);
    window.__geo.add(id);
    return id;
  };
  g.clearWatch = id => { window.__geo.delete(id); return clear(id); };
  const add = window.addEventListener.bind(window), rem = window.removeEventListener.bind(window);
  window.__orient = new Set();
  window.addEventListener = (t, fn, o) => { if (/^deviceorientation/.test(t)) window.__orient.add(t); return add(t, fn, o); };
  window.removeEventListener = (t, fn, o) => { if (/^deviceorientation/.test(t)) window.__orient.delete(t); return rem(t, fn, o); };
};

// An Android compass: alpha against magnetic north, the phone upright.
const android = (page, trueHeading, decl, beta = 90) => page.evaluate(([alpha, beta]) => {
  for (let i = 0; i < 40; i++) {
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientationabsolute', { alpha, beta, gamma: 0, absolute: true }));
  }
}, [((360 - (trueHeading - decl)) % 360 + 360) % 360, beta]);
// An iPhone's: a gyro alpha against wherever it started, and the compass beside it.
const iphone = (page, magnetic, gyroZero) => page.evaluate(([alpha, w]) => {
  for (let i = 0; i < 80; i++) {
    const ev = new Event('deviceorientation');
    for (const [k, v] of Object.entries({ alpha, beta: 90, gamma: 0, absolute: false, webkitCompassHeading: w, webkitCompassAccuracy: 10 })) {
      Object.defineProperty(ev, k, { value: v });
    }
    window.dispatchEvent(ev);
  }
}, [(((360 - magnetic) + gyroZero) % 360 + 360) % 360, magnetic]);

const dbg = page => page.evaluate(() => FieldCamera._debug());
const text = (page, sel) => page.evaluate(s => { const el = document.querySelector(s); return el ? el.textContent.replace(/\s+/g, ' ').trim() : null; }, sel);
const settle = page => page.waitForFunction(() => !FieldCamera._debug().pumping, null, { timeout: 30_000 });
const shotsBy = (d, status) => d.shots.filter(s => s.status === status);
const adds = () => db.calls.filter(c => c.fn === 'add_field_photo');

try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    geolocation: { latitude: HERE.lat, longitude: HERE.lon, accuracy: 4 },
    permissions: ['geolocation', 'camera'], timezoneId: 'Australia/Brisbane',
  });
  await context.addInitScript(SPIES);
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  await installPhotoProject(page, db, store);
  await installStorage(page, store);
  await serveObjects(page, store);
  // A refusal the database would give, once — asked before the project.
  await page.route('**://*.supabase.co/rest/v1/rpc/add_field_photo', route => {
    if (!refuseNext) return route.fallback();
    const r = refuseNext;
    refuseNext = null;
    db.calls.push({ fn: 'add_field_photo', body: JSON.parse(route.request().postData() || '{}'), refused: r.code, uploadsBefore: store.uploads.map(u => u.path) });
    return route.fulfill({ status: r.status, contentType: 'application/json', body: J({ code: r.code, message: r.message, details: null, hint: null }) });
  });
  // No network to the project, while `offline` says so: Playwright's own
  // offline mode still lets a route answer, so the requests are refused here
  // the way a dead connection refuses them — asked before every route above.
  await page.route('**://*.supabase.co/**', route => (offline ? route.abort('internetdisconnected') : route.fallback()));
  // OpenStreetMap's reverse lookup, answered here and counted.
  await page.route('https://nominatim.openstreetmap.org/reverse**', route => {
    nominatim.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
      body: J({ name: 'Gatton', address: { town: 'Gatton', county: 'Lockyer Valley Regional', state: 'Queensland' } }) });
  });
  page.on('pageerror', e => errors.push(e.stack || e.message));
  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const t = msg.text();
    if (/^Failed to load resource|ERR_BLOCKED_BY_CLIENT|ERR_FAILED|ERR_INTERNET_DISCONNECTED/i.test(t)) return;
    errors.push(t);
  });

  await page.goto(server.origin + '/index.html', { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
  // The State's LiDAR, as Elvis would answer for the ground under the photos.
  await page.evaluate(() => Elvis.seed(() => ({ 'HEIGHT AT LOCATION': '95.21m', 'DEM RESOLUTION': '1m',
    SOURCE: 'QLD Government - https://www.qld.gov.au/', DATASET: 'Lockyer_2015_1m.tif' })));

  // ── The tab, before anything is pressed ──────────────────────────────────
  section('The tab, before anything is pressed');
  const navBtn = await page.evaluate(() => {
    const t = TAB_LIST.find(x => x.id === 'camera');
    const g = TABS.find(x => x.tabs.some(y => y.id === 'camera'));
    return { label: t && t.label, icon: t && t.icon, group: g && g.group, help: !!HELP.camera };
  });
  check('📸 Field Camera is a tab under Site visits, with its help', navBtn.label === 'Field Camera' && navBtn.icon === '📸'
    && navBtn.group === 'Site visits' && navBtn.help, J(navBtn));
  await page.evaluate(() => switchTab('camera'));
  await page.waitForSelector('#cam-panel');
  let d = await dbg(page);
  check('it asks for nothing until Start is pressed — no camera, no GPS, no compass',
    (await page.evaluate(() => window.__gum)) === 0 && d.cam === 'off' && !d.watching && !d.listening
      && !!(await page.$('.cam-start')), J({ cam: d.cam, watching: d.watching, listening: d.listening }));
  check('…and says the photos wait on this device, and where they go',
    /No photos taken on this device yet/.test(await text(page, '#cam-out')) && /Field Photos/.test(await text(page, '.cam-lead')));
  let audit = await auditHandlers(page);
  check(`every handler on the tab resolves (${audit.checked})`, audit.unresolved.length === 0, J(audit.unresolved));

  // ── Start ────────────────────────────────────────────────────────────────
  section('Start: the camera, the GPS and the compass');
  await page.evaluate(() => { window.__alt = 134.2; });
  await page.tap('.cam-start');
  await page.waitForFunction(() => FieldCamera._debug().cam === 'on' && document.getElementById('cam-video').videoWidth > 0
    && FieldCamera._debug().gps, null, { timeout: 20_000 });
  d = await dbg(page);
  const want = await page.evaluate(() => window.__gumWant);
  check('the back camera, as large as it will give', want && want.audio === false && want.video.facingMode.ideal === 'environment'
    && want.video.width.ideal >= 4000, J(want));
  check('the GPS watched for its best fix', (await page.evaluate(() => window.__geo.size)) === 1
    && J(await page.evaluate(() => window.__geoOpts)) === J({ enableHighAccuracy: true, maximumAge: 0, timeout: 30000 }));
  check('both compass streams listened to', J(await page.evaluate(() => [...window.__orient].sort()))
    === J(['deviceorientation', 'deviceorientationabsolute']));
  check('the fix and its ± under the picture', near(d.gps.lat, HERE.lat) && near(d.gps.lon, HERE.lon) && d.gps.acc === 4
    && /±4 m/.test(await text(page, '#cam-readout')), J(d.gps));
  const decl = await page.evaluate(([la, lo]) => StationAR.declination(la, lo, 0), [HERE.lat, HERE.lon]);
  check(`the magnetic model asked where the phone stands (${decl.toFixed(2)}° E)`, near(d.decl, decl, 1e-9), String(d.decl));

  section('Which way, and which station');
  // Turned to face Gatton TM, 717 m north-west — "in view".
  const tm = d.suggestions.find(s => s.id === 'gatton_tm');
  await android(page, tm.b, decl);
  await page.waitForTimeout(700);
  d = await dbg(page);
  check(`Android's compass, turned to true north: facing ${tm.b}°`, d.compass === 'absolute' && angNear(d.heading, tm.b, 1),
    J({ compass: d.compass, heading: d.heading }));
  check('the readout says it in the stamp\'s words', new RegExp(`${Math.round(d.heading) % 360}° ${PhotoStamp.point8(d.heading)} true`).test(await text(page, '#cam-readout')),
    await text(page, '#cam-readout'));
  const why = Object.fromEntries(d.suggestions.map(s => [s.id, s.why]));
  check('suggested: the two you stand at first, nearest first, then the one in view, then the rest by distance',
    J(d.suggestions.slice(0, 3).map(s => s.id)) === J(['gatton_al', 'gatton', 'gatton_tm'])
      && why.gatton_al === 'here' && why.gatton === 'here' && why.gatton_tm === 'view' && why.gatton_2 === 'near',
    J(d.suggestions));
  check('the stamp carries the nearest within a kilometre — the database\'s own rule', d.chosen === 'gatton_al' && d.how === 'suggested'
    && /Gatton AL \(540156\)/.test(await text(page, '#cam-station .cam-chosen')), J({ chosen: d.chosen, how: d.how }));
  await android(page, tm.b, decl, 0);
  await page.waitForTimeout(400);
  d = await dbg(page);
  check('pointed at the ground, the camera faces no direction — no heading rather than a wrong one',
    d.heading === null && near(d.pitch, -90, 1), J({ heading: d.heading, pitch: d.pitch }));
  await android(page, 242, decl);
  await page.waitForTimeout(400);

  // The ranking on its own, against stations built for it.
  const ranked = await page.evaluate(() => {
    const S = [
      { id: 'a', name: 'A', lat: -27.5, lon: 152.0 },          // where you stand
      { id: 'b', name: 'B', lat: -27.5, lon: 152.012 },        // 1.18 km east, in view facing east
      { id: 'c', name: 'C', lat: -27.507, lon: 152.0 },        // 774 m south
      { id: 'd', name: 'D', lat: -27.49, lon: 152.0 },         // 1.1 km north — the last photo's
      { id: 'e', name: 'E', lat: -27.3, lon: 152.0 },          // 22 km north — out of the 5 km
    ];
    const here = { lat: -27.5, lon: 152.0004, acc: 5 };
    return {
      east: FieldCamera.suggest(S, here, 90, 'd').map(x => `${x.s.id}:${x.why}`),
      none: FieldCamera.suggest(S, here, null, null).map(x => `${x.s.id}:${x.why}`),
      far: FieldCamera.suggest(S, { lat: -27.2, lon: 152.0, acc: 5 }, null, null).map(x => `${x.s.id}:${x.why}`),
    };
  });
  check('ranked: where you stand, the last photo\'s, in view, then nearest — nothing past 5 km while there is something within it',
    J(ranked.east) === J(['a:here', 'd:last', 'b:view', 'c:near']) && J(ranked.none) === J(['a:here', 'c:near', 'd:near', 'b:near']),
    J(ranked));
  check('…and out to 25 km where nothing is nearer', J(ranked.far) === J(['e:near']), J(ranked.far));

  section('The town, and the ground');
  await page.waitForFunction(() => FieldCamera._debug().locality === 'Gatton' && FieldCamera._debug().ground, null, { timeout: 10_000 });
  d = await dbg(page);
  check('the town asked of OpenStreetMap once, at zoom 14', nominatim.length === 1 && /zoom=14/.test(nominatim[0])
    && /lat=-27\.554294/.test(nominatim[0]), J(nominatim));
  check('…and kept on the device for the next visit with no signal',
    /Gatton/.test(await page.evaluate(() => localStorage.getItem('mn-localities') || '')));
  check('the ground under it in AHD, from Elvis\'s LiDAR', d.ground && d.ground.m === 95.21 && d.ground.source === 'elvis', J(d.ground));

  // ── Signed out ───────────────────────────────────────────────────────────
  section('A photo taken signed out');
  await page.evaluate(() => FieldCamera.tapCaption(1));
  await page.tap('#cam-shutter');
  await page.waitForFunction(() => FieldCamera._debug().shots.length === 1, null, { timeout: 20_000 });
  await page.waitForTimeout(300);
  d = await dbg(page);
  let shot = d.shots[0];
  const r1 = shot.record;
  check('kept on the device, waiting — nothing sent', shot.status === 'waiting' && store.uploads.length === 0 && adds().length === 0
    && db.selects.length === 0, J({ status: shot.status, uploads: store.uploads.length }));
  check('the tab says it waits for a sign-in', /1 waiting — sign in to send/.test(await text(page, '#cam-sum'))
    && !!(await page.$('#cam-out-actions button.primary')) && /Signed out/.test(await text(page, '#cam-out')));
  check('its record: placed by its own GPS, the ±, the true heading, the height above the ellipsoid (Android)',
    r1.placement === 'exif' && near(r1.lat, HERE.lat, 1e-7) && near(r1.lon, HERE.lon, 1e-7) && r1.accuracy_m === 4
      && near(r1.heading_deg, 242, 0.6) && r1.heading_ref === 'T' && r1.altitude_m === 134.2 && r1.altitude_ref === 'HAE'
      && near(r1.pitch_deg, 0, 0.5), J(r1));
  check('filed under the station on its stamp, said outright', r1.station_id === 'gatton_al' && shot.station === 'gatton_al'
    && r1.meta.capture.station.how === 'suggested' && r1.meta.capture.station.suggested[0] === 'gatton_al', J(r1.meta.capture.station));
  check('its time is the phone\'s, in Brisbane, with the zone written into the file',
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(r1.taken_local) && r1.taken_source === 'exif' && r1.meta.taken.zone_source === 'exif'
      && Math.floor(new Date(r1.taken_at).getTime() / 1000) * 1000 === Date.parse(`${r1.taken_local}+10:00`), J({ local: r1.taken_local, at: r1.taken_at }));
  check('the caption, the town, the project, the ground and how the heading was known, kept with it',
    r1.caption === 'Logger cabinet' && r1.meta.capture.locality.name === 'Gatton' && r1.meta.capture.project === 'BoM-FWIN'
      && r1.meta.capture.ground.m === 95.21 && r1.meta.capture.heading.source === 'absolute'
      && near(r1.meta.capture.heading.declination, decl, 0.01) && r1.meta.camera.software === 'Flood-Net Field Camera',
    J(r1.meta.capture));
  check('named floodnet-, the station and the time', /^floodnet-gatton-al-\d{8}-\d{6}\.jpg$/.test(shot.name) && r1.title === shot.name, shot.name);

  section('Kept through a reload');
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => Elvis.seed(() => ({ 'HEIGHT AT LOCATION': '95.21m', 'DEM RESOLUTION': '1m',
    SOURCE: 'QLD Government - https://www.qld.gov.au/', DATASET: 'Lockyer_2015_1m.tif' })));
  await page.evaluate(() => switchTab('camera'));
  await page.waitForFunction(() => FieldCamera._debug().shots.length === 1, null, { timeout: 10_000 });
  d = await dbg(page);
  check('the photo is still on the device after the page is closed and opened again', d.shots[0].id === shot.id
    && d.shots[0].status === 'waiting' && d.cam === 'off', J(d.shots.map(s => s.status)));
  check('…and nothing was sent signed out', store.uploads.length === 0 && adds().length === 0);

  // ── Signed in ────────────────────────────────────────────────────────────
  section('Signed in: sent by itself');
  check('auth.js tells the Field Camera when somebody signs in',
    /typeof FieldCamera !== 'undefined' \? FieldCamera : null/.test(await page.evaluate(() => fetch('/auth.js').then(r => r.text()))));
  await page.evaluate(() => { dbSetAccessToken('test-token'); FieldCamera.authChanged(); });
  await page.waitForFunction(() => FieldCamera._debug().shots[0].status === 'done', null, { timeout: 20_000 });
  d = await dbg(page);
  shot = d.shots[0];
  const add1 = adds()[0];
  const photoUp = store.uploads.find(u => /^photo\/[0-9a-f-]{36}\.jpg$/.test(u.path));
  const thumbUp = store.uploads.find(u => /\.thumb\.jpg$/.test(u.path));
  check('asked by its hash first — the same photo twice is one photo',
    db.selects.length >= 1 && db.selects[0].table === 'field_photo' && db.selects[0].search.includes(`sha256=eq.${shot.sha}`), J(db.selects[0]));
  check('the bytes, then the thumbnail, then the row that points at them',
    photoUp && thumbUp && add1 && add1.uploadsBefore.includes(photoUp.path) && add1.uploadsBefore.includes(thumbUp.path)
      && thumbUp.path === photoUp.path.replace(/\.jpg$/, '.thumb.jpg') && photoUp.contentType === 'image/jpeg',
    J(store.uploads.map(u => u.path)));
  const p1 = add1.body.p_photo;
  check('the row: the paths, the type, the size and the hash of the bytes that went up',
    p1.storage_path === photoUp.path && p1.thumb_path === thumbUp.path && p1.content_type === 'image/jpeg'
      && p1.byte_size === photoUp.bytes && p1.sha256 === sha(photoUp.data), J({ path: p1.storage_path, bytes: p1.byte_size }));
  check('…filed under the station on the stamp, by a person, not by distance',
    p1.station_id === 'gatton_al' && db.photos[0].station_id === 'gatton_al' && db.photos[0].station_auto === false);
  check('in Flood-Net: its line says so, its bytes let go here, its line kept',
    shot.status === 'done' && shot.rowId === db.photos[0].id && /In Flood-Net/.test(await text(page, '#cam-out'))
      && (await page.evaluate(id => new Promise(res => {
        const r = indexedDB.open('mn-field-camera');
        r.onsuccess = () => { const g = r.result.transaction('bytes').objectStore('bytes').get(id); g.onsuccess = () => res(g.result === undefined); };
      }), shot.id)), J(shot));
  await page.waitForTimeout(300);
  const log1 = db.uploads.find(u => u.photo_id === shot.rowId);
  check('logged for the Review panel: imported, with its station', log1 && log1.outcome === 'imported' && log1.station_id === 'gatton_al'
    && log1.origin === 'upload' && log1.file_name === shot.name && log1.sha256 === shot.sha, J(log1));
  const m1 = PhotoMeta.read(photoUp.data);
  check('the bytes that went up carry the GPS, the heading, the time and the software in their EXIF',
    m1.gps && near(m1.gps.lat, HERE.lat, 1e-7) && near(m1.gps.lon, HERE.lon, 1e-7) && near(m1.gps.heading, p1.heading_deg, 0.01)
      && m1.gps.accuracy === 4 && m1.taken.local === p1.taken_local && m1.software === 'Flood-Net Field Camera'
      && m1.description === 'Gatton AL (540156) — Logger cabinet', J({ gps: m1.gps, taken: m1.taken, description: m1.description }));
  await page.evaluate(id => FieldCamera.openShot(id), shot.id);
  await page.waitForFunction(() => FieldPhotos.isOpen(), null, { timeout: 10_000 });
  check('Show it opens it in the Field Photos viewer', (await page.evaluate(() => FieldPhotos._viewer().ids)).includes(shot.rowId));
  await page.evaluate(() => FieldPhotos.close());

  // ── Picked by hand, and no station ──────────────────────────────────────
  section('Picked by hand, no station, and the height from the ground');
  await page.tap('.cam-start');
  await page.waitForFunction(() => FieldCamera._debug().cam === 'on' && document.getElementById('cam-video').videoWidth > 0
    && FieldCamera._debug().gps, null, { timeout: 20_000 });
  await page.evaluate(() => FieldCamera.findStation('Gatton TM'));
  check('found by name, nearest first', /Gatton TM/.test(await text(page, '#cam-hits')));
  await page.evaluate(() => FieldCamera.pickStation('gatton_tm'));
  check('picked: on the stamp, and said so', (await dbg(page)).chosen === 'gatton_tm' && /picked by you/.test(await text(page, '#cam-station')));
  // No height from the GPS: the ground's, in AHD, goes on the stamp instead.
  await page.evaluate(() => { window.__alt = null; });
  await context.setGeolocation({ latitude: HERE.lat, longitude: HERE.lon + 0.000002, accuracy: 4 });
  await page.waitForFunction(() => FieldCamera._debug().gps && FieldCamera._debug().gps.alt === null, null, { timeout: 10_000 });
  await page.tap('#cam-shutter');
  await page.waitForFunction(() => FieldCamera._debug().shots.some(s => s.station === 'gatton_tm' && s.status === 'done'), null, { timeout: 20_000 });
  let p2 = adds().at(-1).body.p_photo;
  check('the picked station is the one it is filed under', p2.station_id === 'gatton_tm' && p2.meta.capture.station.how === 'picked', J(p2.meta.capture.station));
  check('with no height from the GPS, the ground\'s height in AHD from the LiDAR, and it says so',
    p2.altitude_m === 95.21 && p2.altitude_ref === 'AHD' && p2.meta.capture.height.source === 'elvis', J({ alt: p2.altitude_m, ref: p2.altitude_ref }));
  await page.evaluate(() => FieldCamera.pickNone());
  await page.tap('#cam-shutter');
  await page.waitForFunction(() => FieldCamera._debug().shots.filter(s => s.status === 'done').length === 3, null, { timeout: 20_000 });
  p2 = adds().at(-1).body.p_photo;
  check('"No station" is sent as a null, not left to the database to fill',
    'station_id' in p2 && p2.station_id === null && db.photos.at(-1).station_id === null && p2.meta.capture.station.how === 'none', J(p2.station_id));
  await page.evaluate(() => FieldCamera.pickAuto());
  check('back to the suggestion — the last photo\'s station leads the rest after where you stand',
    (await dbg(page)).chosen === 'gatton_al');
  await page.evaluate(() => FieldCamera.pickStation('gatton_tm'));
  await context.setGeolocation({ latitude: FAR.lat, longitude: FAR.lon, accuracy: 4 });
  await page.waitForFunction(() => FieldCamera._debug().how !== 'picked', null, { timeout: 10_000 });
  check('a station picked by hand is let go 2 km from it, and the tab says why',
    /more than 2 km away/.test(await text(page, '#cam-msg')));
  await context.setGeolocation({ latitude: HERE.lat, longitude: HERE.lon, accuracy: 4 });
  await page.waitForFunction(([la]) => FieldCamera._debug().gps && Math.abs(FieldCamera._debug().gps.lat - la) < 1e-7, [HERE.lat], { timeout: 10_000 });

  // ── When it cannot go ────────────────────────────────────────────────────
  section('When it cannot go, and when it can again');
  const before = store.uploads.length;
  offline = true;
  await context.setOffline(true);
  await page.tap('#cam-shutter');
  await page.waitForFunction(() => FieldCamera._debug().shots.some(s => s.status === 'failed'), null, { timeout: 20_000 });
  d = await dbg(page);
  const lost = d.shots.find(s => s.status === 'failed');
  check('no network: kept, and tried again later on its own', lost && /trying again in 15 s/.test(lost.note) && lost.tries === 1
    && store.uploads.length === before, J(lost && lost.note));
  offline = false;
  // The browser's own word that the network is back — its `online` event.
  await context.setOffline(false);
  const backAt = Date.now();
  await page.waitForFunction(id => FieldCamera._debug().shots.find(s => s.id === id).status === 'done', lost.id, { timeout: 20_000 });
  check('the network back: sent at once, without waiting out the back-off', Date.now() - backAt < 10_000);

  await page.evaluate(() => FieldCamera.setPref('auto', false));
  await page.tap('#cam-shutter');
  await page.waitForFunction(() => FieldCamera._debug().shots.some(s => s.status === 'waiting'), null, { timeout: 20_000 });
  d = await dbg(page);
  const held = d.shots.find(s => s.status === 'waiting');
  check('with uploads switched off, it waits for Upload now', !!held && /Upload now/.test(await text(page, '#cam-out-actions')));
  // The same photo already in Flood-Net — sent before its answer was lost.
  db.photos.push({ id: '00000000-0000-4000-8000-0000000000aa', sha256: held.sha, station_id: 'gatton_al', uploaded_by: 'someone@example.test',
                   created_at: '2026-06-24T05:00:00Z', deleted_at: null, storage_path: 'photo/x.jpg', lat: HERE.lat, lon: HERE.lon });
  const upsBefore = store.uploads.length;
  await page.evaluate(() => FieldCamera.sendNow());
  await page.waitForFunction(id => FieldCamera._debug().shots.find(s => s.id === id).status === 'already', held.id, { timeout: 20_000 });
  await page.waitForTimeout(300);
  check('already in Flood-Net: asked by its hash, and not a byte sent',
    store.uploads.length === upsBefore && db.uploads.some(u => u.sha256 === held.sha && u.outcome === 'duplicate'));
  await page.evaluate(() => FieldCamera.setPref('auto', true));

  refuseNext = { status: 400, code: '23503', message: 'no such station: gatton_al' };
  await page.tap('#cam-shutter');
  await page.waitForFunction(() => FieldCamera._debug().shots.some(s => s.status === 'refused'), null, { timeout: 20_000 });
  await settle(page);
  d = await dbg(page);
  const refused = d.shots.find(s => s.status === 'refused');
  const removedBefore = store.removed.length;
  check('a station the database no longer has: refused, said, and its bytes taken down again',
    refused && /no such station/.test(refused.note) && store.removed.length >= 2
      && /Send it filed under no station/.test(await text(page, `#cam-item-${refused.id}`)), J(refused && refused.note));
  await page.evaluate(id => FieldCamera.sendUnfiled(id), refused.id);
  await page.waitForFunction(id => FieldCamera._debug().shots.find(s => s.id === id).status === 'done', refused.id, { timeout: 20_000 });
  check('…and sent again filed under no station', adds().at(-1).body.p_photo.station_id === null && store.removed.length === removedBefore);

  refuseNext = { status: 403, code: '42501', message: 'not authorised to add field photos' };
  await page.tap('#cam-shutter');
  await page.waitForFunction(() => FieldCamera._debug().shots.some(s => s.status === 'refused' && /editors/.test(s.note)), null, { timeout: 20_000 });
  check('an account that may not add photos: refused, and told who can fix it', true);

  // ── The camera app ───────────────────────────────────────────────────────
  section('From the camera app, and read back by OCR with its EXIF stripped');
  // A photograph — the Solocator photo's own rock and water, above its text —
  // with the camera app's EXIF: a place 30 m from the phone, a heading, a time.
  const SHOT_AT = { lat: -27.554562, lon: 152.274003 };
  const appPhoto = await page.evaluate(async ([at]) => {
    const img = await createImageBitmap(await (await fetch('/test/fixtures/photos/solocator-gatton-sw.jpg')).blob());
    const cv = document.createElement('canvas');
    cv.width = 2000; cv.height = 1500;
    cv.getContext('2d').drawImage(img, 0, 905, img.width, 135, 0, 0, 2000, 1500);
    const raw = new Uint8Array(await (await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.9))).arrayBuffer());
    const when = PhotoStamp.moment(new Date('2026-06-24T02:26:08Z'), 'AEST');
    const b = PhotoStamp.withExif(raw, PhotoStamp.app1({ lat: at.lat, lon: at.lon, accuracy: 3, heading: 46, headingRef: 'T', when,
                                                         width: 2000, height: 1500, software: 'iOS 19.1' }));
    let s = '';
    for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
    return btoa(s);
  }, [SHOT_AT]);
  await page.evaluate(() => { window.__alt = 61.5; });
  await context.setGeolocation({ latitude: HERE.lat, longitude: HERE.lon, accuracy: 6 });
  await page.waitForFunction(() => FieldCamera._debug().gps && FieldCamera._debug().gps.alt === 61.5, null, { timeout: 10_000 });
  const nBefore = (await dbg(page)).shots.length;
  await page.setInputFiles('#cam-files', { name: 'IMG_0001.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(appPhoto, 'base64') });
  await page.waitForFunction(n => FieldCamera._debug().shots.length === n + 1 && FieldCamera._debug().shots[0].status === 'done', nBefore, { timeout: 30_000 });
  d = await dbg(page);
  const app = d.shots[0];
  const pA = adds().at(-1).body.p_photo;
  check('placed by its own EXIF, not by where the phone is now', near(pA.lat, SHOT_AT.lat, 1e-7) && near(pA.lon, SHOT_AT.lon, 1e-7)
    && pA.accuracy_m === 3 && pA.meta.capture.source === 'camera-app' && pA.meta.capture.file === 'IMG_0001.jpg', J({ lat: pA.lat, lon: pA.lon }));
  check('its heading and its time are the camera app\'s', pA.heading_deg === 46 && pA.meta.capture.heading.source === 'exif'
    && pA.taken_local === '2026-06-24T12:26:08' && pA.pitch_deg === undefined, J({ h: pA.heading_deg, t: pA.taken_local }));
  check('its station suggested for where it was taken', pA.station_id === 'gatton_al' && app.station === 'gatton_al', pA.station_id);
  const upA = store.uploads.filter(u => /^photo\/[0-9a-f-]{36}\.jpg$/.test(u.path)).at(-1);
  const stripped = stripExif(upA.data);
  check('stripped of its EXIF, as Messages sends it, it says nothing of where it was', !PhotoMeta.read(stripped).gps
    && PhotoMeta.needsOcr(PhotoMeta.read(stripped)));
  const ocr = await page.evaluate(async b64 => {
    const bin = atob(b64), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([u], { type: 'image/jpeg' }));
    const o = await PhotoMeta.ocrImage(bmp, bmp.width, bmp.height, { home: { lat: -25, lon: 145, km: 3000 } });
    const meta = PhotoMeta.read(u);
    const rec = PhotoMeta.reconcile(meta, o);
    return { coords: o.coords, heading: o.heading, accuracy: o.accuracy, altitude: o.altitude, time: o.time,
             texts: (o.texts || []).map(t => t.text).join('\n'), pos: rec.pos, taken: rec.taken };
  }, stripped.toString('base64'));
  check('the real OCR engine reads the place back off the stamp, two readings agreeing',
    ocr.coords && near(ocr.coords.lat, SHOT_AT.lat, 5e-7) && near(ocr.coords.lon, SHOT_AT.lon, 5e-7) && ocr.coords.confidence === 'high',
    J(ocr.coords));
  check('…and the heading (true), the ±, and the height with its datum',
    ocr.heading && ocr.heading.heading === 46 && ocr.heading.ref === 'T' && ocr.accuracy && ocr.accuracy.accuracy === 3
      && ocr.altitude && ocr.altitude.altitude === 62 && ocr.altitude.ref === 'HAE', J({ h: ocr.heading, a: ocr.accuracy, alt: ocr.altitude }));
  check('…and the time with its zone', ocr.time && ocr.time.local === '2026-06-24T12:26:08' && ocr.time.offset === '+10:00', J(ocr.time));
  check('…and the station and the project, in the corner', /Gatton AL \(540156\)/.test(ocr.texts) && /BoM-FWIN/.test(ocr.texts), ocr.texts);
  check('so a stripped copy dropped on Field Photos is placed again, read off the picture',
    ocr.pos && ocr.pos.placement === 'ocr' && ocr.pos.confidence === 'high' && ocr.taken && ocr.taken.source === 'ocr', J(ocr.pos));

  // A photo from the gallery, months old and with no GPS of its own: not
  // stamped with where the phone is now.
  const oldPhoto = await page.evaluate(async () => {
    const cv = document.createElement('canvas');
    cv.width = 800; cv.height = 600;
    cv.getContext('2d').fillRect(0, 0, 800, 600);
    const raw = new Uint8Array(await (await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.8))).arrayBuffer());
    const b = PhotoStamp.withExif(raw, PhotoStamp.app1({ lat: null, lon: null, when: PhotoStamp.moment(new Date('2026-03-02T23:00:00Z'), 'AEST'),
                                                         width: 800, height: 600 }));
    let s = '';
    for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
    return btoa(s);
  });
  const nOld = (await dbg(page)).shots.length;
  await page.setInputFiles('#cam-files', { name: 'IMG_0420.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(oldPhoto, 'base64') });
  await page.waitForFunction(n => FieldCamera._debug().shots.length === n + 1 && FieldCamera._debug().shots[0].status === 'done', nOld, { timeout: 30_000 });
  const pOld = adds().at(-1).body.p_photo;
  check('a months-old gallery photo with no GPS of its own is not given where the phone is now',
    pOld.lat === undefined && pOld.placement === undefined && !('station_id' in pOld) && pOld.meta.capture.gps === null
      && pOld.taken_local === '2026-03-03T09:00:00' && pOld.altitude_m === undefined, J({ lat: pOld.lat, t: pOld.taken_local, gps: pOld.meta.capture.gps }));

  // ── The town switched off ────────────────────────────────────────────────
  section('Settings');
  const asked = nominatim.length;
  await page.evaluate(() => { FieldCamera.setPref('place', false); localStorage.removeItem('mn-localities'); });
  await context.setGeolocation({ latitude: -27.5, longitude: 152.2, accuracy: 5 });
  await page.waitForFunction(() => FieldCamera._debug().gps && FieldCamera._debug().gps.lat === -27.5, null, { timeout: 10_000 });
  await page.waitForTimeout(1500);
  check('with the town switched off, OpenStreetMap is not asked, and nothing is printed', nominatim.length === asked
    && (await page.evaluate(() => FieldCamera._facts().locality)) === '');
  await page.evaluate(() => FieldCamera.setPref('project', 'Lockyer 2026'));
  check('the project line is this device\'s own', (await page.evaluate(() => FieldCamera._facts().project)) === 'Lockyer 2026'
    && JSON.parse(await page.evaluate(() => localStorage.getItem('mn-camera'))).project === 'Lockyer 2026');
  await context.setGeolocation({ latitude: HERE.lat, longitude: HERE.lon, accuracy: 4 });

  // ── Leaving, and coming back ─────────────────────────────────────────────
  section('Leaving the tab, coming back, and drawn afresh');
  await page.evaluate(() => renderMain());
  await page.waitForTimeout(400);
  const again = await page.evaluate(() => { const v = document.getElementById('cam-video'); return { live: !!v.srcObject, w: v.videoWidth, hidden: v.hidden }; });
  check('drawn afresh under a running camera, the picture carries on', again.live && again.w > 0 && !again.hidden, J(again));
  await page.evaluate(() => switchTab('photos'));
  await page.waitForTimeout(300);
  d = await dbg(page);
  check('leaving the tab lets the camera, the GPS and the compass go',
    d.cam === 'off' && d.tracks === 0 && (await page.evaluate(() => window.__geo.size)) === 0
      && (await page.evaluate(() => window.__orient.size)) === 0 && !d.listening, J({ cam: d.cam, tracks: d.tracks }));
  await page.evaluate(() => switchTab('camera'));
  await page.waitForFunction(() => FieldCamera._debug().cam === 'on' && document.getElementById('cam-video').videoWidth > 0, null, { timeout: 20_000 });
  check('coming back takes them up again without a press', (await page.evaluate(() => window.__geo.size)) === 1 && (await dbg(page)).listening);
  await iphone(page, 100, 37);
  await page.waitForTimeout(500);
  d = await dbg(page);
  check('an iPhone\'s compass, its gyro kept on north: magnetic 100° is true 100° plus the declination',
    d.compass === 'ios' && angNear(d.heading, 100 + decl, 1), J({ compass: d.compass, heading: d.heading }));
  await page.evaluate(() => FieldCamera.off());
  await page.evaluate(() => switchTab('photos'));
  await page.evaluate(() => switchTab('camera'));
  await page.waitForTimeout(500);
  d = await dbg(page);
  check('✕ stops it, and it stays stopped on the way back', d.cam === 'off' && !d.watching && !!(await page.$('.cam-start')));
  audit = await auditHandlers(page);
  check(`every handler on the tab resolves, with photos on it (${audit.checked})`, audit.unresolved.length === 0, J(audit.unresolved));
  const clear = (await dbg(page)).shots.filter(s => s.status === 'done' || s.status === 'already').length;
  await page.evaluate(() => FieldCamera.clearDone());
  d = await dbg(page);
  check(`Clear the uploaded takes the ${clear} uploaded lines and leaves the rest`, d.shots.every(s => s.status !== 'done' && s.status !== 'already'));

  await context.close();
} finally {
  await browser.close();
  server.close();
}

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log(`FAIL — ${failed.length} failed`); process.exit(1); }
console.log('PASS — the Field Camera: the stamp, the station, kept and sent');
