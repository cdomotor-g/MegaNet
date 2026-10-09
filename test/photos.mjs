// Field photos: a photo in, placed where it was taken, and shown there — on
// the Field Photos tab, on the Stations map and in the Digital Twin
// (photo-meta.js, field-photos.js, map-photos.js, digital-twin.js).
//
// Why this is a check of its own. `smoke` opens the tab signed out, where it
// says "sign in" and nothing else, and passes. Everything this feature is
// for happens past that sentence: a photo read, its position taken out of
// its EXIF or read off the picture by OCR, a station matched, bytes and a row
// sent in the right order, and the same photo drawn as a pin on the map and
// a marker in the twin, each opening one carousel. None of it is visible to
// a check that does not sign in, drop files and look.
//
// Two halves.
//
//   1. photo-meta.js on its own, under Node — the file the Dropbox sync
//      require()s, so both doors read a photo alike. The reader against
//      photos built byte by byte (lib/exif.mjs): EXIF in a JPEG either byte
//      order, in a HEIC (in mdat and in idat), a PNG and a WebP; XMP, a DJI
//      drone's own tags; a file that is not a photo, cut short, or holding
//      a (0, 0) fix. The overlay parser against the text field camera apps
//      print — Solocator's (the two photos the issue came with), GPS Map
//      Camera's, Timestamp Camera's DMS, NoteCam's, an MGA grid reference —
//      and against what OCR makes of them: a (T) read as (1), ± as +, a
//      digit wrong in one reading of three, a decimal point lost. The
//      compass word that has to agree with a heading; a date written day
//      first; the zone a time was in, where only the place says. Then
//      reconcile() and record(): the file's facts before the overlay's, and
//      no field the photo did not say (null is not nought).
//
//   2. The app in Chromium, against a fake project: the Data API answered
//      from rows this file keeps (the attachment vocabulary parsed out of
//      0010, as the form checks do), Storage from lib/storage.mjs, and the
//      OCR engine and the HEIC decoder served off disk by the network policy
//      — real Tesseract, a real read of the two Solocator photos, and real
//      libheif. Signed out, then in; eight files dropped in one go (the two
//      photos, one with GPS in its EXIF, the same photo twice, a HEIC with no
//      picture in it, two photos with no position anywhere, and a text file);
//      the queue checked and a photo placed by hand; the upload's order,
//      paths and records; the same photo again, refused before a byte moves —
//      and again in a race, and again refused by the database, each taking
//      its bytes back down; the library, its filters and one batch of signed
//      thumbnails; the carousel by keyboard and by click, a caption, a
//      placing, a removal; linking Dropbox, PKCE end to end. Then the map: a
//      pin per spot with a cone per way the camera faced, merged as they
//      would overlap, opening the carousel — and the same pins tilted into
//      3-D, standing on the terrain, pressed with a pointer and a key, and
//      gone for each of the three reasons they go in 2-D (skipped without
//      WebGL2). Then the twin (skipped without WebGL): a marker standing on
//      the ground where each spot is, a wedge per view, "In the twin" standing
//      the camera behind the photographer, the badge clicked, the POV walked
//      up to it and Enter pressed — and none of it in the .glb. Last, a real
//      HEIC, which Chromium cannot draw: decoded by libheif, fetched for it
//      and for nothing before it, placed from its EXIF and uploaded as a JPEG
//      whose pixels are the picture, the right way up.
//
// What is *not* here: 0035's rules. tools/check_field_photos.sql holds them
// against a real Postgres, and a JavaScript copy in this fake would be a
// fixture testing itself. The fake does only what the pages downstream of it
// need to draw — an id, a station by distance, a live row per hash — and
// records what the browser sent, which is the thing under test.
//
// Run:  npm run photos
//       npm run photos -- -v    also print what passed

import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { auditHandlers } from './lib/controls.mjs';
import { answer } from './lib/ask.mjs';
import { storageStore, installStorage, fileOf } from './lib/storage.mjs';
import { serveObjects } from './lib/photo-project.mjs';
import { seedRows, attachmentsSql } from './lib/migration.mjs';
import { hillyTerrariumPng } from './lib/terrarium.mjs';
import { repo } from './lib/paths.mjs';
import { tiff, gpsEntries, jpegWith, jpegShell, heicWith, pngWith, webpWith, xmpPacket } from './lib/exif.mjs';

const require = createRequire(import.meta.url);
const PhotoMeta = require(repo('photo-meta.js'));

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT  = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const OCR_TIMEOUT   = Number(process.env.PHOTOS_OCR_TIMEOUT || 300_000);
const BUILD_TIMEOUT = Number(process.env.TWIN_TIMEOUT || 90_000);

let failures = 0, passes = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passes++; if (VERBOSE) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};
const near = (a, b, tol) => a != null && b != null && isFinite(a) && isFinite(b) && Math.abs(a - b) <= tol;
const section = t => console.log(`\n${t}\n`);
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const J = v => JSON.stringify(v);

// ═════════════════════════════════════════════════════════════════════════════
// 1. photo-meta.js, under Node
// ═════════════════════════════════════════════════════════════════════════════

// Where the two Solocator photos were taken, as their overlay prints it.
const G = { lat: -27.554294, lon: 152.274116 };

// A phone's EXIF: the camera, the shutter in local time and its zone, a 26 mm
// equivalent lens, and a GPS block with everything a GPS block can hold.
function exifTiff({ le = true, orientation = 1, local = '2026:06:24 12:26:08', offset = '+10:00', f35 = 26, gps = {} } = {}) {
  const exif = [];
  if (local) exif.push([0x9003, 2, local]);
  if (offset) exif.push([0x9011, 2, offset]);
  if (f35) exif.push([0xa405, 3, [f35]]);
  return tiff({
    le,
    ifd0: [[0x010f, 2, 'Apple'], [0x0110, 2, 'iPhone 15'], [0x0112, 3, [orientation]]],
    exif,
    gps: gps === null ? [] : gpsEntries({ lat: G.lat, lon: G.lon, alt: 134, heading: 242, accuracy: 4,
                                          date: '2026:06:24', time: [2, 26, 8], datum: 'WGS-84', ...gps }),
  });
}

// The horizontal field of view of a 26 mm equivalent lens, across a frame
// `w` wide and `h` high: the 35 mm diagonal (43.27 mm) shared out by aspect.
const fov26 = (w, h) => 2 * Math.atan((43.27 * w / Math.hypot(w, h)) / 52) * 180 / Math.PI;

function fullRead(r, what, { make = true } = {}) {
  ok(`${what}: the position, to a centimetre`,
    r.gps && near(r.gps.lat, G.lat, 1e-7) && near(r.gps.lon, G.lon, 1e-7) && r.gps.source === 'exif', J(r.gps));
  ok(`${what}: altitude, heading (true), accuracy, datum and the GPS clock`,
    r.gps && r.gps.alt === 134 && r.gps.altRef === 'MSL' && r.gps.heading === 242 && r.gps.headingRef === 'T'
      && r.gps.accuracy === 4 && r.gps.datum === 'WGS-84' && r.gps.utc === '2026-06-24T02:26:08.000Z', J(r.gps));
  ok(`${what}: the time, in the zone the camera wrote`,
    r.taken && r.taken.local === '2026-06-24T12:26:08' && r.taken.offset === '+10:00'
      && r.taken.iso === '2026-06-24T02:26:08.000Z' && r.taken.zoneSource === 'exif' && r.taken.source === 'exif', J(r.taken));
  if (make) ok(`${what}: the camera`, r.make === 'Apple' && r.model === 'iPhone 15' && r.hasExif, `${r.make} ${r.model}`);
}

function nodeHalf() {
  const read = PhotoMeta.read;

  section('Reading a file — EXIF in four containers, XMP, and what is not a photo');

  const le = read(jpegWith(jpegShell(4032, 3024), { tiff: exifTiff({ orientation: 6 }) }));
  ok('a JPEG with little-endian EXIF is a JPEG, 4032 × 3024', le.format === 'jpeg' && le.width === 4032 && le.height === 3024, `${le.format} ${le.width}×${le.height}`);
  fullRead(le, 'little-endian JPEG');
  ok('orientation 6 stands it up: 3024 wide, 4032 high', le.orientation === 6 && le.uprightWidth === 3024 && le.uprightHeight === 4032,
    `${le.orientation} ${le.uprightWidth}×${le.uprightHeight}`);
  ok('and the field of view is across the upright width — 26 mm on a portrait frame', near(le.fov, fov26(3024, 4032), 1e-9) && near(le.fov, 53.1, 0.1),
    `${le.fov}`);

  fullRead(read(jpegWith(jpegShell(4032, 3024), { tiff: exifTiff({ le: false }) })), 'big-endian JPEG');

  for (const inIdat of [false, true]) {
    const h = read(heicWith({ tiff: exifTiff({ le: false }), width: 4032, height: 3024, inIdat }));
    ok(`a HEIC with its Exif item in ${inIdat ? 'idat' : 'mdat'}: a HEIC, its size from ispe`,
      h.format === 'heic' && h.width === 4032 && h.height === 3024, `${h.format} ${h.width}×${h.height}`);
    fullRead(h, `HEIC, Exif in ${inIdat ? 'idat' : 'mdat'}`);
  }

  const png = read(pngWith({ tiff: exifTiff(), width: 8, height: 6 }));
  ok('a PNG with eXIf after its pixels: the size from IHDR', png.format === 'png' && png.width === 8 && png.height === 6, `${png.width}×${png.height}`);
  fullRead(png, 'PNG eXIf');

  const webp = read(webpWith({ tiff: exifTiff(), width: 1600, height: 1200 }));
  ok('a WebP with VP8X and EXIF: the size from VP8X', webp.format === 'webp' && webp.width === 1600 && webp.height === 1200, `${webp.width}×${webp.height}`);
  fullRead(webp, 'WebP EXIF');

  // XMP alone, the way a photo that has been through an editor carries it.
  const x = read(jpegWith(jpegShell(4000, 3000), { xmp: xmpPacket({
    'exif:GPSLatitude': '27,33.25764S', 'exif:GPSLongitude': '152,16.44696E', 'exif:GPSAltitude': '1342/10',
    'exif:GPSImgDirection': '242/1', 'exif:GPSImgDirectionRef': 'M', 'exif:DateTimeOriginal': '2026-06-24T12:26:08+10:00',
  }) }));
  ok('XMP only: the position in degrees and decimal minutes, from the XMP',
    x.gps && x.gps.source === 'xmp' && near(x.gps.lat, G.lat, 1e-7) && near(x.gps.lon, G.lon, 1e-7) && !x.hasExif && x.hasXmp, J(x.gps));
  ok('XMP only: altitude as a rational, a magnetic heading, and the time with its offset',
    x.gps && near(x.gps.alt, 134.2, 1e-9) && x.gps.heading === 242 && x.gps.headingRef === 'M'
      && x.taken && x.taken.local === '2026-06-24T12:26:08' && x.taken.offset === '+10:00' && x.taken.source === 'xmp', J({ g: x.gps, t: x.taken }));

  // A DJI drone: its own tags, longitude spelt as some firmware spells it, and
  // the gimbal — where the camera points — rather than the aircraft's heading.
  const dji = read(jpegWith(jpegShell(5280, 3956), { xmp: xmpPacket({
    'drone-dji:GpsLatitude': '-27.5543', 'drone-dji:GpsLongtitude': '152.274115', 'drone-dji:AbsoluteAltitude': '+180.50',
    'drone-dji:GimbalYawDegree': '-118.0', 'drone-dji:GimbalPitchDegree': '-30.5',
  }) }));
  ok('a DJI photo: its own position tags, "Longtitude" and all',
    dji.gps && dji.gps.source === 'xmp-dji' && dji.gps.lat === -27.5543 && dji.gps.lon === 152.274115 && dji.gps.alt === 180.5, J(dji.gps));
  ok('…the gimbal\'s yaw as the heading (−118° is 242°) and its pitch as the tilt', dji.gps && dji.gps.heading === 242 && dji.pitch === -30.5,
    `${dji.gps && dji.gps.heading} ${dji.pitch}`);
  const djiRec = PhotoMeta.record({ name: 'DJI_0042.JPG', meta: dji, ...PhotoMeta.reconcile(dji, null) });
  ok('…placed from the XMP, facing 242°, pitched −30.5°',
    djiRec.placement === 'xmp' && djiRec.heading_deg === 242 && djiRec.pitch_deg === -30.5 && djiRec.altitude_m === 180.5, J(djiRec));

  // What is not a photo, or not all of one: never a throw, never a position.
  let threw = null, placed = 0;
  let seed = 42;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const shapes = [];
  for (let i = 0; i < 60; i++) shapes.push(Buffer.from(Array.from({ length: 64 + Math.floor(rnd() * 4000) }, () => Math.floor(rnd() * 256))));
  const whole = jpegWith(jpegShell(4032, 3024), { tiff: exifTiff() });
  for (let n = 0; n < whole.length; n += 3) shapes.push(whole.subarray(0, n));
  const heic = heicWith({ tiff: exifTiff(), inIdat: true });
  for (let n = 0; n < heic.length; n += 7) shapes.push(heic.subarray(0, n));
  // A JPEG whose APP1 claims more than it has, and one full of 0xff.
  shapes.push(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]), Buffer.from('Exif\0\0II*\0', 'latin1')]));
  shapes.push(Buffer.alloc(512, 0xff));
  for (const b of shapes) {
    try { const r = read(b); if (r.gps && !(near(r.gps.lat, G.lat, 1e-6) && near(r.gps.lon, G.lon, 1e-6))) placed++; }
    catch (e) { threw = threw || e; }
  }
  ok(`${shapes.length} random, truncated and malformed files: read() never throws, and places none anywhere else`,
    !threw && placed === 0, threw ? threw.stack : `${placed} placed wrongly`);
  const junk = read(Buffer.from('this is a text file, not a photo'));
  ok('a text file reads as no known format, with no position and no time', junk.format === 'unknown' && !junk.gps && !junk.taken, J(junk));

  const zero = read(jpegWith(jpegShell(640, 480), { tiff: exifTiff({ gps: { lat: 0, lon: 0 } }) }));
  ok('a GPS fix of (0, 0) is no fix, not a photo in the Gulf of Guinea', !zero.gps, J(zero.gps));
  const half = read(jpegWith(jpegShell(640, 480), { tiff: tiff({ gps: gpsEntries({ lat: G.lat }) }) }));
  ok('a latitude with no longitude is no position', !half.gps, J(half.gps));

  section('The zone a time was taken in, where the file does not say');

  const clock = read(jpegWith(jpegShell(4032, 3024), { tiff: exifTiff({ offset: null }) }));
  ok('no offset written, a GPS clock: the zone is the difference between the two, to the quarter hour',
    clock.taken.offset === '+10:00' && clock.taken.zoneSource === 'gps-clock' && clock.taken.iso === '2026-06-24T02:26:08.000Z', J(clock.taken));
  const qld = read(jpegWith(jpegShell(4032, 3024), { tiff: exifTiff({ offset: null, gps: { time: undefined, date: undefined } }) }));
  ok('no offset and no GPS clock at Gatton: AEST, and it says it was assumed',
    qld.taken.offset === '+10:00' && qld.taken.zoneSource === 'assumed' && qld.taken.iso === '2026-06-24T02:26:08.000Z', J(qld.taken));
  const syd = read(jpegWith(jpegShell(4032, 3024), { tiff: exifTiff({ local: '2026:01:15 09:00:00', offset: null,
    gps: { lat: -33.87, lon: 151.21, time: undefined, date: undefined } }) }));
  ok('…and in Sydney in January, daylight saving', syd.taken.offset === '+11:00' && syd.taken.iso === '2026-01-14T22:00:00.000Z', J(syd.taken));

  const zone = (lat, lon, local) => { const z = PhotoMeta.auZone(lat, lon, local); return z ? z.offset : null; };
  const zones = [
    ['Brisbane in January (Queensland keeps no summer time)', -27.47, 153.03, '2026-01-15T12:00:00', '+10:00'],
    ['Sydney in January', -33.87, 151.21, '2026-01-15T12:00:00', '+11:00'],
    ['Sydney in July', -33.87, 151.21, '2026-07-15T12:00:00', '+10:00'],
    ['Melbourne in January', -37.81, 144.96, '2026-01-15T12:00:00', '+11:00'],
    ['Hobart in January', -42.88, 147.33, '2026-01-15T12:00:00', '+11:00'],
    ['Adelaide in January', -34.93, 138.60, '2026-01-15T12:00:00', '+10:30'],
    ['Adelaide in July', -34.93, 138.60, '2026-07-15T12:00:00', '+09:30'],
    ['Darwin in January', -12.46, 130.84, '2026-01-15T12:00:00', '+09:30'],
    ['Perth in January', -31.95, 115.86, '2026-01-15T12:00:00', '+08:00'],
    ['the Gold Coast in January — north of the border', -28.0, 153.43, '2026-01-15T12:00:00', '+10:00'],
    ['Byron Bay in January — south of it', -28.64, 153.61, '2026-01-15T12:00:00', '+11:00'],
    ['Sydney on the first Sunday in October 2026', -33.87, 151.21, '2026-10-04T12:00:00', '+11:00'],
    ['Sydney the day before', -33.87, 151.21, '2026-10-03T12:00:00', '+10:00'],
    ['Sydney the day before the first Sunday in April 2026', -33.87, 151.21, '2026-04-04T12:00:00', '+11:00'],
    ['Sydney on it', -33.87, 151.21, '2026-04-05T12:00:00', '+10:00'],
    ['London (not guessed at)', 51.5, -0.12, '2026-01-15T12:00:00', null],
    ['nowhere (a null latitude is not 0°)', null, 152.27, '2026-01-15T12:00:00', null],
  ];
  const wrongZones = zones.filter(([, la, lo, t, want]) => zone(la, lo, t) !== want);
  ok(`the zone by place and date, ${zones.length} ways`, wrongZones.length === 0,
    wrongZones.map(([n, la, lo, t, want]) => `${n}: ${zone(la, lo, t)} not ${want}`).join('; '));

  section('The overlay, as text — what field camera apps print, and what OCR makes of it');

  const vote = (texts, opts) => PhotoMeta.vote(Array.isArray(texts) ? texts : [texts], opts);
  const at = (c, lat, lon, tol = 2e-7) => c && near(c.lat, lat, tol) && near(c.lon, lon, tol);

  const SOLO = '242°SW (T) -27.554294°, 152.274116° ±4m ▲ 134m (HAE)\nBoM-FWIN\nGatton\n2026-06-24, 12:26:08 AEST';
  const s = vote(SOLO);
  ok('Solocator: the position, one reading, medium confidence', at(s.coords, G.lat, G.lon) && s.coords.votes === 1 && s.coords.confidence === 'medium',
    J(s.coords));
  ok('Solocator: 242° true, ±4 m, 134 m above the ellipsoid',
    s.heading && s.heading.heading === 242 && s.heading.ref === 'T' && s.accuracy && s.accuracy.accuracy === 4
      && s.altitude && s.altitude.altitude === 134 && s.altitude.ref === 'HAE', J({ h: s.heading, a: s.accuracy, z: s.altitude }));
  ok('Solocator: the time, and AEST is +10:00', s.time && s.time.local === '2026-06-24T12:26:08' && s.time.offset === '+10:00', J(s.time));

  // Three readings of one overlay, as OCR returns them: the (T) read as (1),
  // the ± as a +, the ▲ as an A — and in the third a 9 read as a 0 and the
  // degree sign as a nought.
  const noisy = vote([
    '242°SW (T) -27.554294°, 152.274116° ±4m ▲ 134m (HAE)',
    '242°SW (1) -27.554294°, 152.274116° +4m A 134m (HAE)',
    '2420SW (T) -27.554204°, 152.274116° ±4m',
  ]);
  ok('three readings, one misread: the two that agree win, with high confidence, and the misreading is kept as the rival',
    at(noisy.coords, G.lat, G.lon) && noisy.coords.votes === 2 && noisy.coords.confidence === 'high'
      && noisy.coords.rivals.some(r => near(r.lat, -27.554204, 1e-7)), J(noisy.coords));
  ok('…the heading from the two readings that have one, (1) read as (T)', noisy.heading && noisy.heading.heading === 242 && noisy.heading.ref === 'T' && noisy.heading.votes === 2,
    J(noisy.heading));
  ok('…±4 m in all three, the + after a coordinate included', noisy.accuracy && noisy.accuracy.accuracy === 4 && noisy.accuracy.votes === 3, J(noisy.accuracy));

  const gpsmap = vote('Gatton, Queensland, Australia\n23 Railway St, Gatton QLD 4343, Australia\nLat -27.554294° Long 152.274116°\nWednesday, 24/06/2026 12:26 PM GMT +10:00');
  ok('GPS Map Camera: labelled, and a day-first date with GMT +10:00',
    at(gpsmap.coords, G.lat, G.lon) && gpsmap.coords.kind === 'labelled' && gpsmap.time && gpsmap.time.local === '2026-06-24T12:26:00'
      && gpsmap.time.offset === '+10:00' && !gpsmap.time.ambiguous, J({ c: gpsmap.coords, t: gpsmap.time }));

  const dms = vote('27°33\'15.46"S 152°16\'26.82"E\nJun 24, 2026 12:26:08 PM');
  ok('Timestamp Camera: degrees, minutes and seconds', at(dms.coords, -(27 + 33 / 60 + 15.46 / 3600), 152 + 16 / 60 + 26.82 / 3600, 1e-9) && dms.coords.kind === 'dms',
    J(dms.coords));
  ok('…and "Jun 24, 2026 12:26:08 PM", with no zone', dms.time && dms.time.local === '2026-06-24T12:26:08' && dms.time.offset === null, J(dms.time));

  const notecam = vote('S 27.554294 E 152.274116\nAltitude: 134.2m\nAccuracy: 5m\n24 June 2026 12:26:08');
  ok('NoteCam: the hemisphere first, a labelled altitude and accuracy, "24 June 2026"',
    at(notecam.coords, G.lat, G.lon) && notecam.coords.kind === 'hemisphere' && notecam.altitude && notecam.altitude.altitude === 134.2
      && notecam.accuracy && notecam.accuracy.accuracy === 5 && notecam.time && notecam.time.local === '2026-06-24T12:26:08', J(notecam));

  // Flinders Peak, the textbook's worked example (GDA94 / MGA zone 55).
  const FP = { lat: -(37 + 57 / 60 + 3.72030 / 3600), lon: 144 + 25 / 60 + 29.52440 / 3600 };
  const mga = vote('MGA55 E 273741.297 N 5796489.777');
  ok('an MGA grid reference: Flinders Peak, to a centimetre', at(mga.coords, FP.lat, FP.lon, 1e-7) && mga.coords.kind === 'grid' && mga.coords.grid.zone === 55,
    J(mga.coords));
  const utm = vote('55H 273741 5796490');
  ok('…and as UTM with a band letter, to the metre it was written to', at(utm.coords, FP.lat, FP.lon, 1e-5), J(utm.coords));
  const fp = PhotoMeta.utmToLatLon(55, 273741.297, 5796489.777, true);
  ok('utmToLatLon: Krüger\'s series lands on the published coordinates', near(fp.lat, FP.lat, 1e-8) && near(fp.lon, FP.lon, 1e-8), J(fp));

  const guessed = vote('27.554294, 152.274116', { home: { lat: -27.5, lon: 152.9 } });
  ok('a bare pair with no sign: south of the equator, where the network is — and it says it guessed, at low confidence',
    at(guessed.coords, G.lat, G.lon) && guessed.coords.signGuessed && guessed.coords.confidence === 'low', J(guessed.coords));
  const repaired = vote('46°NE (T) -27554300°,152.274115° ±4m');
  ok('a latitude that lost its decimal point is put back, at low confidence', at(repaired.coords, -27.5543, 152.274115)
    && repaired.coords.kind === 'repaired' && repaired.coords.confidence === 'low', J(repaired.coords));
  const lopsided = vote('-27.5543°, 152.274116°');
  ok('a pair whose halves disagree in precision, read once, is low confidence', lopsided.coords && lopsided.coords.confidence === 'low', J(lopsided.coords));

  const heads = t => PhotoMeta.parseOverlay(t).headings.map(h => `${h.heading}${h.ref || ''}`);
  const headingCases = [
    ['"242°SW (T)"', '242°SW (T)', ['242T']],
    ['"46°NE", no reference', '46°NE', ['46']],
    ['"242°SW (M)"', '242°SW (M)', ['242M']],
    ['"353° N (T)" — within a point of north', '353° N (T)', ['353T']],
    ['"Heading: 118°"', 'Heading: 118°', ['118']],
    ['a latitude followed by S is not a heading', 'Lat 27.5° S', []],
    ['"90° N" — the word disagrees', '90° N', []],
    ['a compass ribbon\'s bare numbers', '300 NW 330 N 30 NE 60', []],
  ];
  const wrongHeads = headingCases.filter(([, t, want]) => J(heads(t)) !== J(want));
  ok('headings: five read, and the three lookalikes that are not', wrongHeads.length === 0,
    wrongHeads.map(([n, t]) => `${n}: ${J(heads(t))}`).join('; '));

  const times = t => PhotoMeta.parseOverlay(t).times.map(x => `${x.local}${x.offset || ''}${x.ambiguous ? '?' : ''}`);
  const timeCases = [
    ['06/05/2026 09:15 — both ways round, read day first and flagged', '06/05/2026 09:15', ['2026-05-06T09:15:00?']],
    ['05/13/2026 09:15 — the month cannot be 13, so it is not', '05/13/2026 09:15', ['2026-05-13T09:15:00']],
    ['13 Jan 2026 18:05:00 AEDT', '13 Jan 2026 18:05:00 AEDT', ['2026-01-13T18:05:00+11:00']],
    ['Jun 24, 2026 12:26:08 AM — twelve in the morning is nought', 'Jun 24, 2026 12:26:08 AM', ['2026-06-24T00:26:08']],
    ['2026-06-24 12:26:08 +09:30', '2026-06-24 12:26:08 +09:30', ['2026-06-24T12:26:08+09:30']],
    ['2026-13-40 25:61 — nothing', '2026-13-40 25:61', []],
  ];
  const wrongTimes = timeCases.filter(([, t, want]) => J(times(t)) !== J(want));
  ok(`times, ${timeCases.length} ways`, wrongTimes.length === 0, wrongTimes.map(([n, t]) => `${n}: ${J(times(t))}`).join('; '));

  const alts = t => PhotoMeta.parseOverlay(t).altitudes.map(a => `${+a.altitude.toFixed(3)}${a.ref || ''}`);
  const accs = t => PhotoMeta.parseOverlay(t).accuracies.map(a => a.accuracy);
  ok('altitudes: "▲ 134m (HAE)", "Alt: 440 ft" in metres, "Elevation 98.5 m AHD"',
    J(alts('▲ 134m (HAE)')) === J(['134HAE', '134HAE']) && J(alts('Alt: 440 ft')) === J(['134.112'])
      && alts('Elevation 98.5 m AHD').every(a => a === '98.5AHD'),
    `${J(alts('▲ 134m (HAE)'))} ${J(alts('Alt: 440 ft'))} ${J(alts('Elevation 98.5 m AHD'))}`);
  ok('accuracies: "±4m", "Accuracy: 5 m", "HAcc 3.2m"',
    J(accs('±4m')) === '[4]' && J(accs('Accuracy: 5 m')) === '[5]' && J(accs('HAcc 3.2m')) === '[3.2]',
    `${J(accs('±4m'))} ${J(accs('Accuracy: 5 m'))} ${J(accs('HAcc 3.2m'))}`);

  ok('compass points: 242° is WSW, 46° NE, 359° N', PhotoMeta.compassPoint(242) === 'WSW' && PhotoMeta.compassPoint(46) === 'NE' && PhotoMeta.compassPoint(359) === 'N'
    && PhotoMeta.compassPoint(null) === '', `${PhotoMeta.compassPoint(242)} ${PhotoMeta.compassPoint(46)}`);

  section('Reconciled and recorded — the file before the overlay, and nothing the photo did not say');

  const need = PhotoMeta.needsOcr;
  ok('the overlay is read only where the file lacks a position or a time',
    need(le) === false && need(read(jpegWith(jpegShell(640, 480), { tiff: exifTiff({ gps: null }) }))) === true
      && need(read(jpegWith(jpegShell(640, 480), { tiff: exifTiff({ local: null, offset: null }) }))) === true && need(null) === true);

  const ocrOf = text => Object.assign(PhotoMeta.vote([text, text]), { passes: 2, texts: [{ band: 'bottom', variant: 'grey', psm: '6', text }, { band: 'bottom', variant: 'key', psm: '7', text }] });
  const ocr = ocrOf('46°NE (T) -27.554300°, 152.274115° ±4m ▲ 134m (HAE)\n2026-06-24, 12:26:02 AEST');
  const both = PhotoMeta.reconcile(le, ocr);
  ok('GPS in the file and a position on the picture: the file\'s wins, heading and all, and the reading is kept',
    both.pos.placement === 'exif' && at(both.pos, G.lat, G.lon) && both.heading.deg === 242 && both.ocr && both.ocr.confidence === 'high', J(both));
  const onlyOcr = PhotoMeta.reconcile(read(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), ocr);
  ok('nothing in the file: the overlay places it — position, accuracy, heading, altitude and a printed zone',
    onlyOcr.pos.placement === 'ocr' && at(onlyOcr.pos, -27.5543, 152.274115) && onlyOcr.pos.accuracy === 4 && onlyOcr.pos.confidence === 'high'
      && onlyOcr.heading.deg === 46 && onlyOcr.altitude.m === 134 && onlyOcr.altitude.ref === 'HAE'
      && onlyOcr.taken.local === '2026-06-24T12:26:02' && onlyOcr.taken.zone === 'printed' && onlyOcr.taken.iso === '2026-06-24T02:26:02.000Z', J(onlyOcr));
  const noZone = PhotoMeta.reconcile(read(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), ocrOf('-27.554300°, 152.274115°\n24/06/2026 12:26'));
  ok('an overlay time with no zone takes the zone of where it was taken, and says so',
    noZone.taken.zone === 'assumed' && noZone.taken.iso === '2026-06-24T02:26:00.000Z', J(noZone.taken));

  // Solocator writes the fix into the EXIF without GPSHPositioningError and
  // prints the ± on the overlay (the Gatton photos: `±13m` on the picture,
  // nothing in the file) — so its photos are read for the ± alone.
  const soloTiff = ({ accuracy } = {}) => tiff({
    ifd0: [[0x010f, 2, 'Apple'], [0x0110, 2, 'iPhone 12 mini'], [0x0112, 3, [1]], [0x0131, 2, 'Solocator']],
    exif: [[0x9003, 2, '2026:06:24 12:26:08'], [0x9011, 2, '+10:00'], [0xa405, 3, [26]]],
    gps: gpsEntries({ lat: G.lat, lon: G.lon, alt: 94, heading: 242, accuracy }),
  });
  const solo = read(jpegWith(jpegShell(640, 480), { tiff: soloTiff() }));
  const soloAcc = read(jpegWith(jpegShell(640, 480), { tiff: soloTiff({ accuracy: 5 }) }));
  ok('a file that places the photo but leaves out a ± its app prints is read for the ± — and only then',
    solo.software === 'Solocator' && PhotoMeta.printsAccuracy(solo) && need(solo) === true && need(soloAcc) === false
      && PhotoMeta.printsAccuracy(le) === false && need(le) === false && PhotoMeta.printsAccuracy(null) === false, J(solo.gps));
  const soloBoth = PhotoMeta.reconcile(solo, ocrOf('242°SW (T) -27.554294°, 152.274116° ±13m ▲ 134m (HAE)\nGatton 2026-06-24, 12:26:08 AEST'));
  ok('…the overlay\'s ± joins the file\'s fix, and nothing else of the overlay\'s does',
    soloBoth.pos.placement === 'exif' && at(soloBoth.pos, G.lat, G.lon) && soloBoth.pos.accuracy === 13 && soloBoth.pos.accuracySource === 'ocr'
      && soloBoth.altitude.m === 94 && soloBoth.altitude.ref === 'MSL' && soloBoth.heading.deg === 242 && soloBoth.taken.source === 'exif', J(soloBoth));
  const soloRec = PhotoMeta.record({ name: 'BoM-FWIN_Gatton.jpg', meta: solo, ...soloBoth });
  ok('…recorded as the photo\'s accuracy_m, with meta saying where the number came from',
    soloRec.accuracy_m === 13 && soloRec.placement === 'exif' && J(soloRec.meta.accuracy) === J({ source: 'ocr' }), J(soloRec));
  const elsewhere = PhotoMeta.reconcile(solo, ocrOf('-27.564294°, 152.274116° ±13m'));
  ok('…but not from an overlay that printed another fix (a kilometre off): that is its ±, not this one\'s',
    elsewhere.pos.accuracy === null && !('accuracy_m' in PhotoMeta.record({ name: 'x.jpg', ...elsewhere })), J(elsewhere.pos));
  ok('…and the file\'s own ± is never replaced by the overlay\'s',
    PhotoMeta.reconcile(soloAcc, ocrOf('-27.554294°, 152.274116° ±13m')).pos.accuracy === 5);
  ok('overlayAccuracy(): the ± when the overlay\'s fix is the one given (or unread), null when it is another or there is none',
    PhotoMeta.overlayAccuracy(ocrOf('±13m'), G) === 13 && PhotoMeta.overlayAccuracy(ocrOf('-27.554300°, 152.274115° ±13m'), G) === 13
      && PhotoMeta.overlayAccuracy(ocrOf('-27.554294°, 152.284116° ±13m'), G) === null && PhotoMeta.overlayAccuracy(ocrOf('-27.554294°, 152.274116°'), G) === null
      && PhotoMeta.overlayAccuracy(null, G) === null);

  const rec = PhotoMeta.record({ name: 'IMG_0042.jpg', size: 2163393, type: 'image/jpeg', width: 4032, height: 3024, meta: le, ...PhotoMeta.reconcile(le, null) });
  ok('record(): the position to seven places, the GPS\'s accuracy, heading, altitude and the time twice over',
    rec.lat === -27.554294 && rec.lon === 152.274116 && rec.placement === 'exif' && rec.accuracy_m === 4
      && rec.heading_deg === 242 && rec.heading_ref === 'T' && rec.altitude_m === 134 && rec.altitude_ref === 'MSL'
      && rec.taken_local === '2026-06-24T12:26:08' && rec.taken_at === '2026-06-24T02:26:08.000Z' && rec.taken_source === 'exif', J(rec));
  ok('record(): the lens\'s field of view to a tenth, the camera and the datum in meta',
    rec.fov_deg === +fov26(3024, 4032).toFixed(1) && rec.meta.camera.make === 'Apple' && rec.meta.gps.datum === 'WGS-84'
      && rec.meta.taken.zone_source === 'exif' && rec.title === 'IMG_0042.jpg', J(rec.meta));
  const bare = PhotoMeta.record({ name: 'x.jpg', ...PhotoMeta.reconcile({ gps: { lat: -27.5, lon: 152.2, source: 'exif' }, pitch: null, fov: null, taken: null }, null) });
  ok('record(): a photo that says no pitch, no field of view and no accuracy sends none — null is not nought',
    !('pitch_deg' in bare) && !('fov_deg' in bare) && !('accuracy_m' in bare) && !('heading_deg' in bare) && bare.placement === 'exif', J(bare));
  const none = PhotoMeta.record({ name: 'blank.jpg', ...PhotoMeta.reconcile({ gps: null, taken: null }, null) });
  ok('record(): a photo with no position sends no position at all', !('lat' in none) && !('lon' in none) && !('placement' in none) && !('taken_at' in none), J(none));
  const edge = PhotoMeta.record({ name: 'x.jpg', heading: { deg: 359.999, ref: 'T' }, pitch: -120, fov: 250 });
  ok('record(): a heading that rounds to 360 is 0, and pitch and field of view are kept in range',
    edge.heading_deg === 0 && edge.pitch_deg === -90 && edge.fov_deg === 180, J(edge));
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. The app, in Chromium, against a fake project
// ═════════════════════════════════════════════════════════════════════════════

const FIX = repo('test', 'fixtures', 'photos');
const SW = fs.readFileSync(`${FIX}/solocator-gatton-sw.jpg`);
const NE = fs.readFileSync(`${FIX}/solocator-gatton-ne.jpg`);

// A phone photo with its GPS in the EXIF — 25 m north-east of the Gatton
// gauge — taken the next morning. The picture is the NE photo, overlay and
// all: the file's own position has to win without the OCR being asked.
const GPS_AT = { lat: -27.55484, lon: 152.27518 };
const GPS_JPG = jpegWith(NE, { tiff: tiff({
  ifd0: [[0x010f, 2, 'Apple'], [0x0110, 2, 'iPhone 15'], [0x0112, 3, [1]]],
  exif: [[0x9003, 2, '2026:06:25 09:15:00'], [0x9011, 2, '+10:00'], [0xa405, 3, [26]]],
  gps: gpsEntries({ ...GPS_AT, alt: 96.5, heading: 118.25, accuracy: 3.5, date: '2026:06:24', time: [23, 15, 0] }),
}) });
// An iPhone's HEIC, as far as its metadata goes — no picture in it at all, so
// that the decoder Chromium needs is fetched, finds nothing, and says so.
const HEIC = heicWith({ tiff: exifTiff(), width: 4032, height: 3024 });

// And a real one (#202): 160 × 120, four colours — red, green over blue,
// yellow — so a picture decoded upside down or mirrored reads as one, with an
// iPhone's EXIF (big-endian, as Apple writes it) 60 m east of the Gatton
// gauge, facing 205.5° true, taken at 10:02 AEST. 1.4 kB. Made with
// pillow-heif 1.8.0 (libheif 1.23.4, x265), the EXIF from lib/exif.mjs:
//
//   tiff({ le: false,
//     ifd0: [[0x010f, 2, 'Apple'], [0x0110, 2, 'iPhone 15'], [0x0112, 3, [1]]],
//     exif: [[0x9003, 2, '2026:06:25 10:02:00'], [0x9011, 2, '+10:00'], [0xa405, 3, [26]]],
//     gps: gpsEntries({ lat: -27.5551, lon: 152.2756, alt: 97.5, heading: 205.5,
//                       accuracy: 4.5, date: '2026:06:25', time: [0, 2, 0] }) })
//
//   img = Image.new('RGB', (160, 120)); d = ImageDraw.Draw(img)
//   d.rectangle([0, 0, 79, 59], fill=(220, 40, 40));   d.rectangle([80, 0, 159, 59], fill=(40, 180, 60))
//   d.rectangle([0, 60, 79, 119], fill=(40, 80, 220)); d.rectangle([80, 60, 159, 119], fill=(240, 210, 40))
//   pillow_heif.from_pillow(img).save('IMG_2041.HEIC', quality=80, exif=b'Exif\x00\x00' + tiff)
const HEIC_REAL = fs.readFileSync(`${FIX}/IMG_2041.HEIC`);
const HEIC_AT = { lat: -27.5551, lon: 152.2756 };
const HEIC_QUADS = [['top left', 40, 30, [220, 40, 40]], ['top right', 120, 30, [40, 180, 60]],
                    ['bottom left', 40, 90, [40, 80, 220]], ['bottom right', 120, 90, [240, 210, 40]]];

// Where the three Gatton stations stood when these photos were placed round
// them. Which station a photo is filed under, and how far away, is a fact about
// these positions — and stations.json follows the database, where a person
// corrects a station's position in the editor (Gatton moved 67 m and Gatton AL
// 221 m on 27–28 September 2026, which filed the SW photo under Gatton AL). So the
// check pins them, in what it reads here and in the file the page is served,
// rather than chasing the survey.
const PINNED = {
  gatton:    { lat: -27.555,    lon: 152.275 },
  gatton_al: { lat: -27.556389, lon: 152.273056 },
  gatton_tm: { lat: -27.55,     lon: 152.26861 },
};
const DOC = JSON.parse(fs.readFileSync(repo('stations.json'), 'utf8'));
for (const s of DOC.stations) if (PINNED[s.id]) Object.assign(s, PINNED[s.id]);
const STATIONS = DOC.stations.filter(s => s.lat != null && s.lon != null);
const GATTON = STATIONS.find(s => s.id === 'gatton');
const metres = (a, b) => Math.hypot((b.lat - a.lat) * 110574, (b.lon - a.lon) * 111320 * Math.cos(a.lat * Math.PI / 180));
function nearestStation(p, within = 1000) {
  let best = null, bd = Infinity;
  for (const s of STATIONS) {
    if (Math.abs(s.lat - p.lat) > 0.05 || Math.abs(s.lon - p.lon) > 0.06) continue;
    const d = metres(p, s);
    if (d <= within && d < bd) { best = s; bd = d; }
  }
  return best;
}

// ── The fake project's Data API ──────────────────────────────────────────────
// PostgREST as far as these pages use it: a select list with aliases into the
// JSON meta, eq / gte / lte / is.null, an order with nulls placement, a limit.
// Rows live here; deleted ones are tombstones, invisible as they are to an
// editor under 0035's policy.

function project(row, select) {
  if (!select || select === '*') return { ...row };
  const out = {};
  for (const part of select.split(',')) {
    const [alias, expr] = part.includes(':') ? part.split(':') : [null, part];
    const pathOf = expr.split(/->>|->/);
    let v = row[pathOf[0]];
    for (const k of pathOf.slice(1)) v = v && typeof v === 'object' ? v[k] : undefined;
    if (v === undefined) v = null;
    if (expr.includes('->>') && v !== null && typeof v !== 'string') v = typeof v === 'object' ? J(v) : String(v);
    out[alias || pathOf[pathOf.length - 1]] = v;
  }
  return out;
}
function matches(row, key, cond) {
  const v = row[key];
  if (cond === 'is.null') return v === null || v === undefined;
  const dot = cond.indexOf('.');
  const op = cond.slice(0, dot), arg = cond.slice(dot + 1);
  if (op === 'eq') return v != null && String(v) === arg;
  if (op === 'gte') return v != null && +v >= +arg;
  if (op === 'lte') return v != null && +v <= +arg;
  throw new Error(`the photo fixture does not do ${op}`);
}
function ordered(rows, order) {
  const keys = (order || '').split(',').filter(Boolean).map(k => {
    const [col, ...mods] = k.split('.');
    const desc = mods.includes('desc');
    return { col, desc, nullsLast: mods.includes('nullslast') ? true : mods.includes('nullsfirst') ? false : !desc };
  });
  return rows.slice().sort((a, b) => {
    for (const k of keys) {
      const x = a[k.col], y = b[k.col];
      if (x == null && y == null) continue;
      if (x == null) return k.nullsLast ? 1 : -1;
      if (y == null) return k.nullsLast ? -1 : 1;
      if (x < y) return k.desc ? 1 : -1;
      if (x > y) return k.desc ? -1 : 1;
    }
    return 0;
  });
}

function photoProject() {
  return {
    rows: [],            // meganet.field_photo, tombstones included
    calls: [],           // { fn, body, uploadsBefore } for every RPC, in order
    selects: [],         // every field_photo query string
    sync: [],            // meganet.field_photo_sync
    hideSha: false,      // answer the next hash look-up with nothing — a race lost
    refuseNext: null,    // { status, body } for the next add_field_photo
    seq: 0,
  };
}

function installProject(page, db, store, types) {
  return page.route('**://*.supabase.co/rest/v1/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const name = url.pathname.replace(/^.*\/rest\/v1\//, '');
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: J(body) });
    const live = id => db.rows.find(r => r.id === id && !r.deleted_at);

    if (req.method() === 'POST' && name.startsWith('rpc/')) {
      const fn = name.slice(4);
      const body = JSON.parse(req.postData() || '{}');
      if (!/^(add|update|remove)_field_photo$/.test(fn)) return route.fallback();
      db.calls.push({ fn, body, uploadsBefore: store.uploads.map(u => u.path) });

      if (fn === 'add_field_photo') {
        const p = body.p_photo;
        if (db.refuseNext) { const r = db.refuseNext; db.refuseNext = null; return json(r.status, r.body); }
        const dup = db.rows.find(r => !r.deleted_at && r.sha256 === p.sha256);
        if (dup) return json(409, { code: '23505', message: 'this photo is already in MegaNet', details: dup.id, hint: null });
        const n = ++db.seq;
        const at = new Date(Date.UTC(2026, 5, 24, 5, 0, 0) + n * 1000).toISOString();
        let station_id = null, station_auto = false;
        if ('station_id' in p) station_id = p.station_id;
        else if (p.lat != null) { const s = nearestStation(p); if (s) { station_id = s.id; station_auto = true; } }
        const row = {
          id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
          storage_bucket: 'field-photos', storage_path: p.storage_path, thumb_path: p.thumb_path ?? null,
          content_type: p.content_type, byte_size: p.byte_size, sha256: p.sha256, width: p.width ?? null, height: p.height ?? null,
          title: p.title ?? '', caption: p.caption ?? '',
          taken_at: p.taken_at ?? null, taken_local: p.taken_local ?? null, taken_source: p.taken_source ?? null,
          lat: p.lat ?? null, lon: p.lon ?? null, placement: p.placement ?? null, accuracy_m: p.accuracy_m ?? null,
          altitude_m: p.altitude_m ?? null, altitude_ref: p.altitude_ref ?? null,
          heading_deg: p.heading_deg ?? null, heading_ref: p.heading_ref ?? null, pitch_deg: p.pitch_deg ?? null, fov_deg: p.fov_deg ?? null,
          station_id, station_auto, meta: p.meta ?? {}, origin: 'upload', origin_ref: null,
          uploaded_by: 'fixture@example.test', created_at: at, updated_at: at, updated_by: null, deleted_at: null, deleted_by: null,
        };
        db.rows.push(row);
        return json(200, row);
      }
      const row = live(body.p_id);
      if (!row) return json(400, { code: 'P0002', message: `no such field photo: ${body.p_id}` });
      if (fn === 'update_field_photo') {
        const p = body.p_patch;
        if ('lat' in p || 'lon' in p) {
          const rematch = !('station_id' in p) && (row.station_auto || (row.lat == null && row.station_id == null));
          row.lat = p.lat; row.lon = p.lon;
          row.placement = p.lat == null ? null : (p.placement || 'manual');
          row.accuracy_m = 'accuracy_m' in p ? p.accuracy_m : null;
          if (rematch) { const s = row.lat == null ? null : nearestStation(row); row.station_id = s ? s.id : null; row.station_auto = !!s; }
        } else if ('accuracy_m' in p) {
          row.accuracy_m = p.accuracy_m;
        }
        if ('station_id' in p) { row.station_id = p.station_id; row.station_auto = false; }
        for (const k of ['title', 'caption', 'heading_deg', 'heading_ref', 'pitch_deg']) if (k in p) row[k] = p[k];
        if ('taken_at' in p) { row.taken_at = p.taken_at; row.taken_source = p.taken_at ? (p.taken_source || 'manual') : null; }
        row.updated_by = 'fixture@example.test';
        return json(200, row);
      }
      row.deleted_at = '2026-06-25T00:00:00Z';
      row.deleted_by = 'fixture@example.test';
      return json(200, { removed: true, storage_bucket: row.storage_bucket, storage_path: row.storage_path, thumb_path: row.thumb_path });
    }

    if (req.method() !== 'GET') return route.fallback();
    if (name === 'attachment_type') return json(200, types);
    if (name === 'field_photo_sync') return json(200, db.sync);
    if (name !== 'field_photo') return route.fallback();

    db.selects.push(url.search);
    const q = url.searchParams;
    let rows = db.rows.filter(r => !r.deleted_at);
    for (const [k, v] of q) {
      if (['select', 'order', 'limit'].includes(k)) continue;
      if (k === 'sha256' && db.hideSha) { db.hideSha = false; rows = []; continue; }
      rows = rows.filter(r => matches(r, k, v));
    }
    rows = ordered(rows, q.get('order'));
    if (q.get('limit')) rows = rows.slice(0, +q.get('limit'));
    return json(200, rows.map(r => project(r, q.get('select'))));
  });
}

// ── The browser half ─────────────────────────────────────────────────────────

async function browserHalf() {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];
  const store = storageStore();
  const db = photoProject();
  const types = seedRows(attachmentsSql(), 'attachment_type');
  const dropbox = { posts: [] };

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await context.newPage();
    const net = await applyNetworkPolicy(page, server.origin);
    await installProject(page, db, store, types);
    await installStorage(page, store);
    // The document with the Gatton stations where the photos were placed (above).
    await page.route(`${server.origin}/stations.json`, route =>
      route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: J(DOC) }));
    // A signed picture is the bytes that went up, or ones a section put in the
    // bucket by hand — the viewer's photos seeded as the Dropbox sync would
    // have stored them — rather than the storage fixture's one-pixel GIF.
    const objects = {};
    await serveObjects(page, store, objects);
    await page.route(/elevation-tiles-prod\/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/, route => {
      const m = /terrarium\/(\d+)\/(\d+)\/(\d+)\.png/.exec(route.request().url());
      return route.fulfill({ status: 200, contentType: 'image/png', body: hillyTerrariumPng(+m[1], +m[2], +m[3]),
                             headers: { 'Access-Control-Allow-Origin': '*' } });
    });
    await page.route('https://api.dropboxapi.com/oauth2/token', route => {
      const req = route.request();
      if (req.method() === 'OPTIONS') {
        return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST' } });
      }
      dropbox.posts.push(Object.fromEntries(new URLSearchParams(req.postData() || '')));
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
        body: J({ access_token: 'sl.fixture', token_type: 'bearer', expires_in: 14400, refresh_token: 'rt-fixture-5b1d9e', account_id: 'dbid:fixture' }) });
    });

    const tessRequests = [];
    page.on('request', r => { if (/unpkg\.com\/tesseract\.js@/.test(r.url())) tessRequests.push(r.url()); });
    // The HEIC decoder is fetched from inside a worker, so it is counted where
    // the route sees it — registered after the policy, so it is asked first —
    // and handed on to the policy to be answered.
    const heifRequests = [];
    await page.route(/unpkg\.com\/libheif-js@/, route => { heifRequests.push(route.request().url()); return route.fallback(); });
    page.on('pageerror', e => errors.push(e.stack || e.message));
    page.on('console', m => {
      if (m.type() !== 'error') return;
      const t = m.text();
      if (/^Failed to load resource|ERR_BLOCKED_BY_CLIENT|ERR_FAILED|WebGL|GL_|GPU stall/i.test(t)) return;
      errors.push(t);
    });
    const dialogs = [];
    page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });

    await page.goto(server.origin + '/index.html', { waitUntil: 'load', timeout: LOAD_TIMEOUT });
    await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
      null, { timeout: LOAD_TIMEOUT });
    // The twin's lines over the stage stay open for the buttons pressed in
    // them (twinsite holds the fold itself).
    await page.evaluate(() => { if (typeof DigitalTwin !== 'undefined') DigitalTwin._infoFold(null); });
    await page.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(String(u)); return null; }; });

    const queue = () => page.evaluate(() => FieldPhotos._queue());
    const text = sel => page.evaluate(s => { const el = document.querySelector(s); return el ? el.textContent.replace(/\s+/g, ' ').trim() : null; }, sel);
    const viewer = () => page.evaluate(() => FieldPhotos._viewer());
    const settledQueue = () => page.waitForFunction(() => !state.photos.reading && !state.photos.uploading
      && state.photos.queue.every(i => !['waiting', 'reading', 'ocr', 'queued', 'uploading'].includes(i.status)), null, { timeout: OCR_TIMEOUT });

    // ── Signed out ───────────────────────────────────────────────────────────
    section('Signed out');
    await page.evaluate(() => switchTab('photos'));
    await page.waitForTimeout(200);
    ok('signed out, the tab says the photos are for signed-in editors, and offers no way to add any',
      /private to signed-in editors/.test(await text('#fp-add-panel')) && !(await page.$('#fp-files')), await text('#fp-add-panel'));
    ok('…and asks the project for nothing', db.selects.length === 0 && store.uploads.length === 0, `${db.selects.length} select(s)`);
    ok('the OCR engine is not fetched until a photo needs it', tessRequests.length === 0 && !(await page.evaluate(() => !!window.Tesseract)));
    ok('…nor the HEIC decoder until a HEIC does', heifRequests.length === 0 && !(await page.evaluate(() => !!window.libheif)));
    let audit = await auditHandlers(page);
    ok(`signed out: all ${audit.checked} handler(s) resolve`, audit.unresolved.length === 0, audit.unresolved.map(u => u.path).join(', '));

    // ── Signed in ────────────────────────────────────────────────────────────
    section('Signed in, and eight files dropped at once');
    await page.evaluate(() => { dbSetAccessToken('test-token'); FieldPhotos.authChanged(); });
    await page.waitForFunction(() => !!document.getElementById('fp-files') && state.photos.lib !== null && state.photos.sync !== null,
      null, { timeout: LOAD_TIMEOUT });
    ok('signed in: the drop zone, a file picker and a folder picker',
      !!(await page.$('#fp-drop')) && !!(await page.$('#fp-files[multiple]')) && !!(await page.$('#fp-folder[webkitdirectory]')));
    ok('the library is empty and says so', /No field photos yet/.test(await text('#fp-lib')), await text('#fp-lib'));
    ok('the sync panel says nothing has reported from Dropbox', /Not set up yet/.test(await text('#fp-sync')), await text('#fp-sync'));

    // Two photos with nothing in them — a paddock and some sky, drawn here,
    // no overlay and no EXIF — so the OCR has to look and find nothing.
    const blanks = (await page.evaluate(async () => {
      const make = async (seed) => {
        const c = document.createElement('canvas');
        c.width = 1200; c.height = 900;
        const x = c.getContext('2d');
        const sky = x.createLinearGradient(0, 0, 0, 520);
        sky.addColorStop(0, '#6fa3d8'); sky.addColorStop(1, '#dfeaf4');
        x.fillStyle = sky; x.fillRect(0, 0, 1200, 520);
        x.fillStyle = '#6b7f3a'; x.fillRect(0, 520, 1200, 380);
        let s = seed;
        const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
        for (let i = 0; i < 500; i++) {
          x.fillStyle = `rgba(${40 + rnd() * 40 | 0},${60 + rnd() * 50 | 0},20,${0.25 + 0.5 * rnd()})`;
          x.fillRect(rnd() * 1200, 520 + rnd() * 380, 3 + rnd() * 14, 2 + rnd() * 6);
        }
        const b = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
        const bytes = new Uint8Array(await b.arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(bin);
      };
      return [await make(7), await make(11)];
    })).map(b => Buffer.from(b, 'base64'));

    const files = [
      { name: 'solocator-gatton-sw.jpg', mimeType: 'image/jpeg', buffer: SW },
      { name: 'solocator-gatton-ne.jpg', mimeType: 'image/jpeg', buffer: NE },
      { name: 'IMG_1187.jpg', mimeType: 'image/jpeg', buffer: GPS_JPG },
      { name: 'copy of solocator-gatton-sw.jpg', mimeType: 'image/jpeg', buffer: SW },
      { name: 'IMG_1188.HEIC', mimeType: 'image/heic', buffer: HEIC },
      { name: 'paddock-1.jpg', mimeType: 'image/jpeg', buffer: blanks[0] },
      { name: 'paddock-2.jpg', mimeType: 'image/jpeg', buffer: blanks[1] },
      fileOf('notes.txt', 'text/plain', 300),
    ];
    const t0 = Date.now();
    await page.setInputFiles('#fp-files', files);
    const added = await page.evaluate(() => state.photos.msg && state.photos.msg.text);
    ok('eight files in: seven photos queued, the text file left out and said to be',
      /^7 photos added — 1 file was not a photo and was left out/.test(added || ''), added);
    await settledQueue();
    const readS = ((Date.now() - t0) / 1000).toFixed(1);
    let q = await queue();
    const byName = n => q.find(i => i.name === n);
    const sw = byName('solocator-gatton-sw.jpg'), ne = byName('solocator-gatton-ne.jpg'), gps = byName('IMG_1187.jpg');
    const dup = byName('copy of solocator-gatton-sw.jpg'), heic = byName('IMG_1188.HEIC');
    const p1 = byName('paddock-1.jpg'), p2 = byName('paddock-2.jpg');
    ok(`seven in the queue, read in ${readS} s`, q.length === 7, q.map(i => `${i.name}:${i.status}`).join(', '));

    ok('the SW photo, read off its overlay: the position Solocator printed, at high confidence',
      sw && sw.status === 'ready' && sw.pos && sw.pos.placement === 'ocr' && at2(sw.pos, G.lat, G.lon) && sw.pos.confidence === 'high' && sw.pos.accuracy === 4,
      J(sw && { pos: sw.pos, ocr: sw.ocr }));
    ok('…facing 242° true, 134 m above the ellipsoid, at 12:26:08 AEST as printed',
      sw && sw.heading && sw.heading.deg === 242 && sw.heading.ref === 'T' && sw.altitude && sw.altitude.m === 134 && sw.altitude.ref === 'HAE'
        && sw.taken && sw.taken.local === '2026-06-24T12:26:08' && sw.taken.iso === '2026-06-24T02:26:08.000Z' && sw.taken.zone === 'printed',
      J(sw && { h: sw.heading, a: sw.altitude, t: sw.taken }));
    ok('…and filed under Gatton, the nearest station, 117 m away',
      sw && sw.station && sw.station.id === 'gatton' && sw.station.auto && near(sw.station.m, metres(G, GATTON), 1.5), J(sw && sw.station));
    ok('…its hash the file\'s own, its size the picture\'s, a thumbnail made',
      sw && sw.sha === sha256(SW) && sw.width === 1545 && sw.height === 1159 && sw.thumb && sw.contentType === 'image/jpeg' && sw.ext === 'jpg',
      J(sw && { sha: sw.sha, w: sw.width, h: sw.height }));
    ok('the NE photo, six seconds earlier from the same spot, facing 46°',
      ne && ne.status === 'ready' && ne.pos && ne.pos.placement === 'ocr' && at2(ne.pos, -27.5543, 152.274115) && ne.pos.confidence === 'high'
        && ne.heading && ne.heading.deg === 46 && ne.taken && ne.taken.local === '2026-06-24T12:26:02', J(ne && { p: ne.pos, h: ne.heading, t: ne.taken }));
    ok('the photo with GPS in its EXIF is placed from that — the OCR never asked, though it has the same overlay',
      gps && gps.status === 'ready' && gps.pos && gps.pos.placement === 'exif' && at2(gps.pos, GPS_AT.lat, GPS_AT.lon, 1e-7) && !gps.ocr
        && gps.heading.deg === 118.25 && gps.pos.accuracy === 3.5 && gps.altitude.m === 96.5 && gps.taken.zone === 'exif'
        && gps.station && gps.station.id === 'gatton', J(gps));
    ok('the same photo twice in one drop is refused as the same photo, before it is read any further',
      dup && dup.status === 'refused' && /same photo is already in this list/.test(dup.note), dup && dup.note);
    ok('a HEIC with no picture in it goes to the decoder Chromium needs, which finds none — refused, and said to be damaged',
      heic && heic.status === 'refused' && /the HEIC could not be decoded — no picture in it could be read; it may be damaged/.test(heic.note), heic && heic.note);
    ok('two photos with nothing in them: the OCR looked, found nothing, and placed neither',
      [p1, p2].every(p => p && p.status === 'ready' && !p.pos && p.ocr && p.ocr.passes >= 1 && /Nothing in the file or on the picture/.test(p.note)),
      J([p1, p2].map(p => p && { s: p.status, pos: p.pos, ocr: p.ocr, note: p.note })));
    const msg = await page.evaluate(() => state.photos.msg && state.photos.msg.text);
    ok('the summary line counts each outcome',
      /^7 photos read: 1 placed from the camera's GPS; 2 placed from the position printed on the photo; 2 not placed .*; 2 refused\. Check the positions, then press Upload\.$/.test(msg || ''), msg);
    ok('the table has a row each, and the button offers the five that can go',
      (await page.$$eval('.fp-queue-table tbody tr[id^="fp-row-"]', rs => rs.length)) === 7
        && /Upload 5 photos/.test(await text('#fp-upload')) && (await page.$$eval('.fp-chip-ocr', e => e.length)) === 2, await text('#fp-upload'));
    ok('the OCR engine arrived only now, every part of it from the version pinned',
      tessRequests.length > 0 && !net.blocked.some(u => /tesseract/.test(u)), `${tessRequests.length} request(s); blocked: ${net.blocked.filter(u => /tesseract/.test(u)).join(', ')}`);
    ok('…and so did the HEIC decoder — its glue and its WebAssembly, at the version pinned, into a worker and not the page',
      J(heifRequests) === J(['https://unpkg.com/libheif-js@1.23.2/libheif-wasm/libheif.js', 'https://unpkg.com/libheif-js@1.23.2/libheif-wasm/libheif.wasm'])
        && !net.blocked.some(u => /libheif/.test(u)) && !(await page.evaluate(() => !!window.libheif)), J(heifRequests));

    // ── Placing one by hand ──────────────────────────────────────────────────
    section('Placing one by hand');
    await page.click(`#fp-row-${p1.key} button[aria-controls="fp-edit-${p1.key}"]`);
    const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
    ok('"Place it…" opens the editor under the row, with the coordinates box focused', focused === `fp-place-${p1.key}`, focused);
    await page.fill(`#fp-place-${p1.key}`, 'beside the gauge');
    await page.press(`#fp-place-${p1.key}`, 'Enter');
    ok('words that are not a coordinate are refused, with an example', /is not a coordinate this can read/.test(await text(`#fp-edit-${p1.key}`)),
      await text(`#fp-edit-${p1.key}`));
    await page.fill(`#fp-place-${p1.key}`, '-27.5561, 152.2731');
    await page.press(`#fp-place-${p1.key}`, 'Enter');
    q = await queue();
    let it = q.find(i => i.key === p1.key);
    ok('a coordinate places it by hand, and the nearest station comes with it (Gatton AL, 32 m)',
      it.pos && it.pos.placement === 'manual' && it.pos.lat === -27.5561 && it.pos.lon === 152.2731 && it.station && it.station.id === 'gatton_al' && it.station.auto,
      J(it));
    let rec = await page.evaluate(k => FieldPhotos._record(k), p1.key);
    ok('…and the record leaves the station to the database, which picks the same way', !('station_id' in rec) && rec.placement === 'manual', J(rec));
    await page.evaluate(k => FieldPhotos.queueEdit(k, true), p1.key);
    await page.click(`#fp-edit-${p1.key} button:has-text("No station")`);
    rec = await page.evaluate(k => FieldPhotos._record(k), p1.key);
    ok('"No station" is sent as a null — said, not left to the distance rule', 'station_id' in rec && rec.station_id === null, J(rec.station_id));
    await page.evaluate(k => FieldPhotos.queueEdit(k, true), p1.key);
    await page.fill(`#fp-edit-${p1.key} input[type="search"]`, '40444');
    await page.click(`#fp-hits-${p1.key} .fp-hit:has-text("Gatton")`);
    q = await queue();
    it = q.find(i => i.key === p1.key);
    rec = await page.evaluate(k => FieldPhotos._record(k), p1.key);
    ok('a station found by its number is chosen, and sent as chosen — the position stays the one typed',
      it.station && it.station.id === 'gatton' && !it.station.auto && rec.station_id === 'gatton' && it.pos.placement === 'manual' && it.pos.lat === -27.5561, J({ st: it.station, rec: rec.station_id }));
    audit = await auditHandlers(page);
    ok(`the queue: all ${audit.checked} handler(s) resolve`, audit.unresolved.length === 0, audit.unresolved.map(u => u.path).join(', '));

    // ── Uploading ────────────────────────────────────────────────────────────
    section('Uploading');
    await page.click('#fp-upload');
    await settledQueue();
    q = await queue();
    const done = q.filter(i => i.status === 'done');
    ok('five uploaded; the two refused stay refused', done.length === 5 && q.filter(i => i.status === 'refused').length === 2,
      q.map(i => `${i.name}:${i.status}`).join(', '));
    ok('the line says so', /^5 uploaded\.$/.test(await page.evaluate(() => state.photos.msg && state.photos.msg.text)), await page.evaluate(() => state.photos.msg && state.photos.msg.text));
    const adds = db.calls.filter(c => c.fn === 'add_field_photo');
    const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
    ok('ten objects, all in the field-photos bucket: each photo and its thumbnail, named by a fresh uuid',
      store.uploads.length === 10 && store.uploads.every(u => u.bucket === 'field-photos')
        && adds.every(c => new RegExp(`^photo/${UUID}\\.jpg$`).test(c.body.p_photo.storage_path)
                        && c.body.p_photo.thumb_path === c.body.p_photo.storage_path.replace(/\.jpg$/, '.thumb.jpg')),
      store.uploads.map(u => `${u.bucket}/${u.path}`).join(', '));
    ok('the bytes go up before the row that points at them — both objects, every photo',
      adds.length === 5 && adds.every(c => c.uploadsBefore.includes(c.body.p_photo.storage_path) && c.uploadsBefore.includes(c.body.p_photo.thumb_path)));
    ok('no object is named after the file', store.uploads.every(u => !/solocator|IMG_|paddock/i.test(u.path)));
    const sent = n => (adds.find(c => c.body.p_photo.title === n) || {}).body?.p_photo;
    const pSW = sent('solocator-gatton-sw.jpg'), pGPS = sent('IMG_1187.jpg'), pP1 = sent('paddock-1.jpg'), pP2 = sent('paddock-2.jpg');
    ok('the SW record: where, which way, how high, when — and that it was read off the picture',
      pSW && pSW.lat === -27.554294 && pSW.lon === 152.274116 && pSW.placement === 'ocr' && pSW.accuracy_m === 4
        && pSW.heading_deg === 242 && pSW.heading_ref === 'T' && pSW.altitude_m === 134 && pSW.altitude_ref === 'HAE'
        && pSW.taken_local === '2026-06-24T12:26:08' && pSW.taken_at === '2026-06-24T02:26:08.000Z' && pSW.taken_source === 'ocr', J(pSW));
    ok('…the file: its hash, its size, its type, its name as the title — and no station, for the database to match',
      pSW && pSW.sha256 === sha256(SW) && pSW.byte_size === SW.length && pSW.content_type === 'image/jpeg' && pSW.width === 1545 && pSW.height === 1159
        && !('station_id' in pSW), J(pSW && { sha: pSW.sha256, n: pSW.byte_size }));
    ok('…and in meta, what the OCR saw: its confidence, its passes and every reading\'s text',
      pSW && pSW.meta.ocr && pSW.meta.ocr.confidence === 'high' && pSW.meta.ocr.passes >= 2 && pSW.meta.ocr.texts.length === pSW.meta.ocr.passes
        && pSW.meta.ocr.texts.some(t => /27\.55429/.test(t.text)) && pSW.meta.taken.zone_source === 'printed', J(pSW && pSW.meta.ocr && { c: pSW.meta.ocr.confidence, p: pSW.meta.ocr.passes }));
    ok('the EXIF record: the camera\'s own facts, the lens\'s field of view, and no OCR at all',
      pGPS && pGPS.placement === 'exif' && pGPS.heading_deg === 118.25 && pGPS.accuracy_m === 3.5 && pGPS.altitude_m === 96.5 && pGPS.altitude_ref === 'MSL'
        && pGPS.taken_at === '2026-06-24T23:15:00.000Z' && pGPS.taken_source === 'exif' && pGPS.meta.taken.zone_source === 'exif'
        && pGPS.fov_deg === +fov26(1545, 1159).toFixed(1) && pGPS.meta.camera.make === 'Apple' && !pGPS.meta.ocr && !('pitch_deg' in pGPS), J(pGPS));
    ok('the hand-placed record: manual, and the station chosen', pP1 && pP1.placement === 'manual' && pP1.lat === -27.5561 && pP1.station_id === 'gatton', J(pP1));
    ok('the unplaced record: no position, no placement, no time — nothing it did not know',
      pP2 && !('lat' in pP2) && !('placement' in pP2) && !('taken_at' in pP2) && !('heading_deg' in pP2) && !('fov_deg' in pP2) && pP2.meta.ocr, J(pP2));
    const rowOf = n => db.rows.find(r => r.title === n && !r.deleted_at);
    const R = { sw: rowOf('solocator-gatton-sw.jpg'), ne: rowOf('solocator-gatton-ne.jpg'), gps: rowOf('IMG_1187.jpg'),
                p1: rowOf('paddock-1.jpg'), p2: rowOf('paddock-2.jpg') };
    ok('each uploaded row offers "Show it"', (await page.$$eval('.fp-q-done button', bs => bs.filter(b => b.textContent === 'Show it').length)) === 5);

    // ── The same photo again ─────────────────────────────────────────────────
    section('The same photo again — asked first, raced, and refused');
    await page.click('button:has-text("Clear finished")');
    ok('"Clear finished" empties the list', (await queue()).length === 0);
    const again = async () => {
      await page.setInputFiles('#fp-files', [{ name: 'IMG_1187.jpg', mimeType: 'image/jpeg', buffer: GPS_JPG }]);
      await settledQueue();
      await page.click('#fp-upload');
      await settledQueue();
      return (await queue())[0];
    };
    let n0 = store.uploads.length, c0 = adds.length;
    let one = await again();
    ok('asked before a byte moves: "Already in Flood-Net — added by … on …", and nothing sent',
      one.status === 'already' && /^Already in Flood-Net — added by fixture@example\.test on 2026-06-24\.$/.test(one.note)
        && one.existingId === R.gps.id && store.uploads.length === n0 && db.calls.filter(c => c.fn === 'add_field_photo').length === c0, J(one));
    ok('…with a way to it', /Show it/.test(await text(`#fp-row-${one.key}`)));

    await page.click('button:has-text("Clear finished")');
    db.hideSha = true;
    n0 = store.uploads.length;
    const r0 = store.removed.length;
    one = await again();
    const raced = store.uploads.slice(n0).map(u => u.path);
    ok('a race lost — the check said no, the database said yes: the two objects sent are taken down again',
      one.status === 'already' && one.existingId === R.gps.id && raced.length === 2 && raced.every(p => store.removed.slice(r0).includes(p)), J({ one, raced, removed: store.removed.slice(r0) }));

    await page.click('button:has-text("Clear finished")');
    db.hideSha = true;
    db.refuseNext = { status: 400, body: { code: '22023', message: 'the fixture refuses this photo', hint: null } };
    n0 = store.uploads.length;
    const r1 = store.removed.length;
    one = await again();
    const refusedUp = store.uploads.slice(n0).map(u => u.path);
    ok('a row the database refuses fails the photo with the database\'s words, and takes both objects down',
      one.status === 'failed' && /the fixture refuses this photo/.test(one.note) && refusedUp.length === 2
        && refusedUp.every(p => store.removed.slice(r1).includes(p)), J({ one, refusedUp }));
    ok('…and a failed photo can be sent again', /Upload 1 photo/.test(await text('#fp-upload')));
    await page.click('#fp-upload');
    await settledQueue();
    one = (await queue())[0];
    ok('…which finds it already there', one.status === 'already', J(one));
    await page.click('button:has-text("Clear finished")');

    // ── Placing many at once ─────────────────────────────────────────────────
    section('Placing many at once — ticked, and one station chosen for them all');
    const up0 = store.uploads.length;
    await page.setInputFiles('#fp-files', [
      { name: 'paddock-1.jpg', mimeType: 'image/jpeg', buffer: blanks[0] },
      { name: 'IMG_1187.jpg', mimeType: 'image/jpeg', buffer: GPS_JPG },
      { name: 'paddock-2.jpg', mimeType: 'image/jpeg', buffer: blanks[1] },
    ]);
    await settledQueue();
    q = await queue();
    const [b1, bGps, b2] = ['paddock-1.jpg', 'IMG_1187.jpg', 'paddock-2.jpg'].map(n => q.find(i => i.name === n));
    ok('the bar is up, a box on each row, nothing ticked, and nowhere to search until something is',
      !(await page.$eval('#fp-bulk', e => e.hidden)) && (await page.$$eval('.fp-q-pick', e => e.length)) === 3
        && /^3 photos can be placed — none selected$/.test(await text('#fp-bulk-count')) && (await page.$eval('#fp-bulk-find', e => e.disabled)),
      await text('#fp-bulk-count'));
    await page.click('#fp-bulk button:has-text("Select unplaced")');
    q = await queue();
    ok('"Select unplaced" ticks the two nothing could place, and not the one its GPS placed',
      J(q.filter(i => i.picked).map(i => i.key).sort()) === J([b1.key, b2.key].sort()) && /^2 of 3 selected$/.test(await text('#fp-bulk-count')),
      await text('#fp-bulk-count'));
    await page.fill('#fp-bulk-find', '40444');
    await page.click('#fp-bulk-hits .fp-hit:has-text("Gatton")');
    q = await queue();
    let bPair = [b1, b2].map(b => q.find(i => i.key === b.key));
    ok('one station chosen puts both at it — its position, chosen, not the nearest — and the ticks go',
      bPair.every(i => i.pos && i.pos.placement === 'station' && i.pos.lat === GATTON.lat && i.pos.lon === GATTON.lon
        && i.station && i.station.id === 'gatton' && !i.station.auto && !i.picked),
      J(bPair.map(i => ({ p: i.pos, s: i.station, k: i.picked }))));
    ok('…and the line says what became of them',
      /^2 photos filed under Gatton, at the station's position\.$/.test(await page.evaluate(() => state.photos.msg && state.photos.msg.text)),
      await page.evaluate(() => state.photos.msg && state.photos.msg.text));
    await page.click(`#fp-pick-${b1.key}`);
    await page.click(`#fp-pick-${b2.key}`, { modifiers: ['Shift'] });
    q = await queue();
    ok('a shift-click ticks the run between', q.every(i => i.picked) && /^3 of 3 selected$/.test(await text('#fp-bulk-count')), await text('#fp-bulk-count'));
    ok('the station chosen lately is offered in one click, and so are the stations around them',
      /Chosen lately:\s*Gatton 40444/.test(await text('#fp-bulk-quick')) && /Around where they were taken:.*Gatton AL/.test(await text('#fp-bulk-quick')),
      await text('#fp-bulk-quick'));
    await page.click('#fp-bulk-quick .fp-hit:has-text("Gatton AL")');
    q = await queue();
    const gpsNow = q.find(i => i.key === bGps.key);
    bPair = [b1, b2].map(b => q.find(i => i.key === b.key));
    const recs = await page.evaluate(ks => ks.map(k => FieldPhotos._record(k)), [b1.key, bGps.key, b2.key]);
    ok('all three filed under Gatton AL: the two put at a station move to this one, the GPS photo stays where it was taken',
      bPair.every(i => i.pos.placement === 'station' && i.pos.lat === PINNED.gatton_al.lat && i.station.id === 'gatton_al' && !i.station.auto)
        && gpsNow.pos.placement === 'exif' && at2(gpsNow.pos, GPS_AT.lat, GPS_AT.lon, 1e-7) && gpsNow.station.id === 'gatton_al' && !gpsNow.station.auto
        && recs.every(r => r.station_id === 'gatton_al') && q.every(i => !i.picked),
      J({ pair: bPair.map(i => ({ p: i.pos, s: i.station })), gps: gpsNow.pos, recs: recs.map(r => r.station_id) }));
    ok('…with nothing sent until Upload is pressed', store.uploads.length === up0, `${store.uploads.length - up0} upload(s)`);
    audit = await auditHandlers(page);
    ok(`the bulk bar: all ${audit.checked} handler(s) resolve`, audit.unresolved.length === 0, audit.unresolved.map(u => u.path).join(', '));
    await page.evaluate(() => FieldPhotos._queue().forEach(i => FieldPhotos.removeFromQueue(i.key)));
    ok('taken off the list, the bar goes with them', (await queue()).length === 0 && !(await page.$('#fp-bulk')));

    // ── The library ──────────────────────────────────────────────────────────
    section('The library');
    await page.waitForFunction(() => document.querySelectorAll('#fp-lib .fp-card').length === 5, null, { timeout: LOAD_TIMEOUT });
    const cards = await page.$$eval('#fp-lib .fp-card', bs => bs.map(b => b.getAttribute('aria-label')));
    ok('five photos, newest first — the EXIF one taken the next morning, then SW, then NE; the unplaced last',
      /^IMG_1187\.jpg — Gatton, 25 Jun 2026, 09:15:00 UTC\+10$/.test(cards[0]) && /^solocator-gatton-sw\.jpg — Gatton/.test(cards[1])
        && /^solocator-gatton-ne\.jpg/.test(cards[2]) && cards.slice(3).some(c => /Unplaced/.test(c)), cards.join(' | '));
    await page.waitForFunction(() => [...document.querySelectorAll('#fp-lib img[data-fp-src]')].every(i => i.src), null, { timeout: LOAD_TIMEOUT });
    ok('every thumbnail signed — in one request, not five', (store.batches || 0) >= 1
      && [R.sw, R.ne, R.gps, R.p1, R.p2].every(r => store.signed.includes(r.thumb_path)), `${store.batches} batch(es)`);
    await page.waitForFunction(() => /Unplaced \(\d+\)/.test(document.getElementById('fp-filter').textContent), null, { timeout: LOAD_TIMEOUT });
    ok('the Unplaced chip counts one', /Unplaced \(1\)/.test(await text('#fp-filter')), await text('#fp-filter'));

    await page.click('#fp-filter button:has-text("Unplaced")');
    await page.waitForFunction(() => document.querySelectorAll('#fp-lib .fp-card').length === 1, null, { timeout: LOAD_TIMEOUT });
    ok('Unplaced shows the one with no position', /with no position/.test(await text('#fp-lib-lead'))
      && db.selects.some(s => /lat=is\.null/.test(s)), await text('#fp-lib-lead'));
    await page.click('#fp-lib .fp-card');
    let v = await viewer();
    ok('opening it: "Unplaced photos — photo 1 of 1", saying it is not placed',
      v && v.title === 'Unplaced photos' && /Not placed/.test(await text('#fp-v-details')) && /photo 1 of 1/.test(await text('#fp-v-title')), J(v));
    await page.click('#fp-v-details button:has-text("Place it…")');
    ok('"Place it…" opens the coordinates box, focused', (await page.evaluate(() => document.activeElement && document.activeElement.id)) === 'fp-v-coord');
    await page.fill('#fp-v-coord', '-27.554, 152.279');
    await page.press('#fp-v-coord', 'Enter');
    await page.waitForFunction(() => /Moved\./.test((document.getElementById('fp-v-msg') || {}).textContent || ''), null, { timeout: LOAD_TIMEOUT });
    const moved = db.calls.filter(c => c.fn === 'update_field_photo').pop();
    ok('placed from the viewer: a patch of the position, by hand', moved && moved.body.p_id === R.p2.id
      && J(moved.body.p_patch) === J({ lat: -27.554, lon: 152.279, placement: 'manual' }), J(moved && moved.body));
    ok('…and it is filed under the nearest station, as if it had come in with the position',
      R.p2.station_id === 'gatton' && R.p2.station_auto && /Gatton/.test(await text('#fp-v-details')), await text('#fp-v-details'));
    await page.keyboard.press('Escape');
    ok('Escape closes the viewer', !(await viewer()) && await page.evaluate(() => document.getElementById('fp-viewer').hidden));
    await page.waitForFunction(() => /Every photo has a place/.test(document.getElementById('fp-lib').textContent), null, { timeout: LOAD_TIMEOUT });
    ok('…and Unplaced is empty now', true);
    await page.click('#fp-filter button:has-text("All")');
    await page.waitForFunction(() => document.querySelectorAll('#fp-lib .fp-card').length === 5, null, { timeout: LOAD_TIMEOUT });

    // ── The carousel ─────────────────────────────────────────────────────────
    section('The carousel');
    await page.click('#fp-lib .fp-card >> nth=0');
    v = await viewer();
    ok('a card opens the viewer on it, over all five', v && v.ids.length === 5 && v.i === 0 && v.ids[0] === R.gps.id
      && /Field photos — photo 1 of 5/.test(await text('#fp-v-title')), J(v));
    ok('it is a dialog, labelled by its title, with the focus in it',
      await page.evaluate(() => { const c = document.querySelector('#fp-viewer .fp-v-card'); return !!c && c.getAttribute('role') === 'dialog' && c.getAttribute('aria-modal') === 'true' && c.contains(document.activeElement); }));
    await page.waitForFunction(id => { const i = document.getElementById('fp-v-img'); return i && i.src && /photo\//.test(i.src); }, null, { timeout: LOAD_TIMEOUT });
    ok('the full-size picture through a signed URL', store.signed.includes(R.gps.storage_path));
    ok('the details: taken, where, facing, altitude, station, file, added',
      /Taken\s*25 Jun 2026, 09:15:00 UTC\+10/.test(await text('#fp-v-details')) && /Where\s*-27\.554840, 152\.275180 ±4 m/.test(await text('#fp-v-details'))
        && /Facing\s*118° ESE \(true\)/.test(await text('#fp-v-details')) && /Altitude\s*97 m MSL/.test(await text('#fp-v-details'))
        && /Station\s*Gatton — 25 m NE of the station, the nearest/.test(await text('#fp-v-details')), await text('#fp-v-details'));
    await page.keyboard.press('ArrowRight');
    ok('→ is the next photo', (await viewer()).i === 1 && /photo 2 of 5/.test(await text('#fp-v-title')));
    await page.keyboard.press('ArrowLeft');
    ok('← the one before', (await viewer()).i === 0);
    await page.keyboard.press('End');
    ok('End the last', (await viewer()).i === 4 && /photo 5 of 5/.test(await text('#fp-v-title')));
    await page.keyboard.press('Home');
    ok('Home the first', (await viewer()).i === 0);
    await page.keyboard.press('ArrowLeft');
    ok('← from the first wraps to the last', (await viewer()).i === 4);
    await page.click('.fp-v-thumb >> nth=1');
    ok('a thumbnail in the strip goes straight to it, and says it is the current one',
      (await viewer()).i === 1 && await page.evaluate(() => document.querySelectorAll('.fp-v-thumb')[1].getAttribute('aria-current') === 'true'));
    await page.click('.fp-v-next');
    ok('› is the next photo too', (await viewer()).i === 2);
    await page.evaluate(() => document.querySelector('#fp-viewer .fp-v-thumb:last-child').focus());
    await page.keyboard.press('Tab');
    ok('Tab from the last control goes round to the first — the focus stays in the dialog',
      await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('modal-x')));
    ok('the metadata is fetched whole for the photo on screen', db.selects.some(s => /select=\*&id=eq\./.test(s)));

    // ⟲ ⟳: a turn for the viewer, remembered per photo in this browser.
    const rot = () => page.evaluate(() => document.getElementById('fp-v-img').style.transform);
    await page.click('.fp-v-rot button[aria-label="Rotate right"]');
    ok('⟳ turns the photo a quarter right', await rot() === 'rotate(90deg)', await rot());
    const fits = await page.evaluate(() => {
      const i = document.getElementById('fp-v-img').getBoundingClientRect(), st = document.getElementById('fp-v-stage').getBoundingClientRect();
      return i.left >= st.left - 1 && i.right <= st.right + 1 && i.top >= st.top - 1 && i.bottom <= st.bottom + 1;
    });
    ok('…and the turned picture still fits the stage', fits);
    await page.click('.fp-v-next');
    ok('the next photo is not turned', await rot() === '');
    await page.click('.fp-v-prev');
    ok('the turned one is still turned coming back to it', await rot() === 'rotate(90deg)');
    await page.click('.fp-v-rot button[aria-label="Rotate left"]');
    ok('⟲ turns it back, and nothing is left remembered',
      await rot() === '' && await page.evaluate(() => localStorage.getItem('mn-fp-rot')) === '{}');

    // A caption, typed and left.
    await page.keyboard.press('Home');
    await page.fill('#fp-v-details textarea', 'The staff gauge from the bridge, looking downstream');
    await page.click('#fp-v-title');
    await page.waitForFunction(() => /Caption saved/.test((document.getElementById('fp-v-msg') || {}).textContent || ''), null, { timeout: LOAD_TIMEOUT });
    const cap = db.calls.filter(c => c.fn === 'update_field_photo').pop();
    ok('a caption is saved as a patch of the caption and nothing else',
      cap && cap.body.p_id === R.gps.id && J(cap.body.p_patch) === J({ caption: 'The staff gauge from the bridge, looking downstream' }), J(cap && cap.body));
    await page.click('#fp-v-details button:has-text("Open the original")');
    const opened = await page.evaluate(() => window.__opened.slice());
    ok('"Open the original" opens the signed full-size picture, inside the click', opened.some(u => u.includes(`/object/sign/field-photos/${R.gps.storage_path}`)), opened.join(', '));
    audit = await auditHandlers(page);
    ok(`the viewer: all ${audit.checked} handler(s) resolve`, audit.unresolved.length === 0, audit.unresolved.map(u => u.path).join(', '));
    await page.keyboard.press('Escape');
    ok('Escape closes it and hands the focus back to the card that opened it',
      !(await viewer()) && await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('fp-card')));

    // Removing.
    await page.evaluate(id => FieldPhotos.openOne(id), R.p1.id);
    await page.click('#fp-v-details button:has-text("Remove")');
    // Asked in the app's own dialog (#223), over the viewer — which has to
    // still be there underneath, not torn down by the asking.
    await page.waitForSelector('#app-ask .modal-card', { timeout: 5000 });
    const over = await page.evaluate(() => !!document.querySelector('#fp-viewer:not([hidden]) .fp-v-card'));
    const asked = await answer(page, true);
    await page.waitForFunction(id => !FieldPhotos.row(id), R.p1.id, { timeout: LOAD_TIMEOUT });
    ok('Remove asks first — over the viewer, which stays — and says the picture is deleted, not hidden',
      over && /is deleted, not just hidden/.test(asked.text) && asked.yes === 'Remove the photo' && asked.danger,
      JSON.stringify({ over, asked, native: dialogs }));
    ok('…takes the row, then both objects', R.p1.deleted_at && store.removed.includes(R.p1.storage_path) && store.removed.includes(R.p1.thumb_path));
    ok('…and a viewer of one photo closes', !(await viewer()));
    await page.waitForFunction(() => document.querySelectorAll('#fp-lib .fp-card').length === 4, null, { timeout: LOAD_TIMEOUT });

    // ── The sync's report, and linking Dropbox ───────────────────────────────
    section('Dropbox');
    db.sync = [{ source: 'dropbox', folder: '/Field photos', account: 'Flood Crew', last_run_at: new Date(Date.now() - 5 * 60000).toISOString(),
                 last_ok_at: new Date(Date.now() - 5 * 60000).toISOString(), last_error: null, runs: 12, seen: 3, imported: 2, unplaced: 1, skipped: 0, failed: 0 }];
    await page.evaluate(() => FieldPhotos.retry());
    await page.waitForFunction(() => /Working/.test(document.getElementById('fp-sync').textContent), null, { timeout: LOAD_TIMEOUT });
    ok('the sync\'s last run, as the tab reads it', /Working — last ran 5 min ago, reading Flood Crew's Dropbox \(\/Field photos\)\./.test(await text('#fp-sync'))
      && /3 new files seen, 2 imported \(1 could not be placed/.test(await text('#fp-sync')), await text('#fp-sync'));
    await page.click('#fp-connect summary');
    await page.fill('#fp-dbx-key', 'k3y4ppabc123');
    await page.press('#fp-dbx-key', 'Tab');
    await page.click('#fp-connect button:has-text("Open Dropbox to allow access")');
    const auth = (await page.evaluate(() => window.__opened.slice())).find(u => u.startsWith('https://www.dropbox.com/oauth2/authorize'));
    const aq = auth ? new URL(auth).searchParams : new URLSearchParams();
    ok('Dropbox is opened on its authorize page with the app key, for a code and an offline token, PKCE S256',
      aq.get('client_id') === 'k3y4ppabc123' && aq.get('response_type') === 'code' && aq.get('token_access_type') === 'offline'
        && aq.get('code_challenge_method') === 'S256' && /^[A-Za-z0-9_-]{43}$/.test(aq.get('code_challenge') || ''), auth);
    await page.fill('#fp-dbx-code', 'the-code-dropbox-showed');
    await page.click('#fp-connect button:has-text("Get the token")');
    await page.waitForFunction(() => !!document.getElementById('fp-dbx-token'), null, { timeout: LOAD_TIMEOUT });
    const post = dropbox.posts[0] || {};
    ok('the code is traded with the verifier the challenge was made from, and no secret',
      post.code === 'the-code-dropbox-showed' && post.grant_type === 'authorization_code' && post.client_id === 'k3y4ppabc123'
        && !('client_secret' in post) && b64url(crypto.createHash('sha256').update(post.code_verifier || '').digest()) === aq.get('code_challenge'), J(post));
    ok('the refresh token is shown once, to be pasted into GitHub', (await page.inputValue('#fp-dbx-token')) === 'rt-fixture-5b1d9e'
      && /DROPBOX_REFRESH_TOKEN/.test(await text('#fp-connect')));
    ok('…and kept nowhere in this browser', await page.evaluate(() => ![...Object.values(localStorage), ...Object.values(sessionStorage)].some(v => String(v).includes('rt-fixture'))));

    // ── The map ──────────────────────────────────────────────────────────────
    section('The Stations map');
    await page.evaluate(id => FieldPhotos.openOne(id), R.sw.id);
    await page.click('#fp-v-details button:has-text("On the map")');
    await page.waitForFunction(() => state.activeTab === 'stations' && !!state.map && typeof MapPhotos !== 'undefined'
      && MapPhotos._note().kind === 'ok' && MapPhotos.drawn().length === 3, null, { timeout: LOAD_TIMEOUT });
    const centre = await page.evaluate(() => { const c = state.map.getCenter(); return { lat: c.lat, lon: c.lng, z: state.map.getZoom() }; });
    ok('"On the map" closes the viewer and shows the Stations map on the spot, at zoom 16',
      !(await viewer()) && near(centre.lat, R.sw.lat, 1e-5) && near(centre.lon, R.sw.lon, 1e-5) && centre.z === 16, J(centre));
    const drawn = await page.evaluate(() => MapPhotos.drawn());
    const pair = drawn.find(d => d.n === 2), exifPin = drawn.find(d => d.ids.includes(R.gps.id)), p2pin = drawn.find(d => d.ids.includes(R.p2.id));
    ok('three pins for four photos: the SW and NE photos are one spot', drawn.length === 3 && !!pair && !!exifPin && !!p2pin,
      J(drawn.map(d => ({ n: d.n, cones: d.cones }))));
    ok('…at the first photo taken there, with a cone each way the camera faced — 46° and 242°',
      pair && near(pair.lat, R.ne.lat, 1e-9) && near(pair.lon, R.ne.lon, 1e-9) && J(pair.cones.slice().sort((a, b) => a - b)) === J([46, 242]), J(pair));
    ok('the EXIF photo\'s pin faces 118.25°, and the one placed by hand has no cone',
      exifPin && J(exifPin.cones) === J([118.25]) && p2pin && p2pin.cones.length === 0, J({ exifPin, p2pin }));
    const cones = await page.$$eval('.mn-photo-cone', cs => cs.map(c => c.style.getPropertyValue('--rot')));
    ok('each cone is turned by a custom property, not an inline transform', cones.length === 3 && cones.every(c => /^\d+(\.\d)?deg$/.test(c)), cones.join(', '));
    ok('the note under the switch counts them', /4 field photos in and around this view, at 3 spots/.test(await text('#map-photos-note')), await text('#map-photos-note'));
    ok('the legend explains the 📷', !!(await page.$('#map-legend .legend-photo')));
    ok('asked for the view\'s box, not for every photo', db.selects.some(s => /lat=gte\..*lat=lte\..*lon=gte\..*lon=lte\./.test(s)));
    const pairTitle = await page.evaluate(() => { const m = [...document.querySelectorAll('.mn-photo-icon')].find(e => /^2 field photos/.test(e.title)); return m ? m.title : null; });
    ok('its name says what it is', pairTitle === '2 field photos taken here, facing 46° and 242° — open them', pairTitle);
    await page.click('.mn-photo-icon[title^="2 field photos"] .mn-photo-badge');
    v = await viewer();
    ok('a click on the pin opens the carousel over the photos taken there', v && v.ids.length === 2 && v.ids.includes(R.sw.id) && v.ids.includes(R.ne.id)
      && /2 photos taken here — photo 1 of 2/.test(await text('#fp-v-title')), J(v));
    await page.keyboard.press('Escape');
    await page.evaluate(() => state.map.setZoom(11, { animate: false }));
    await page.waitForFunction(() => MapPhotos._note().kind === 'zoom', null, { timeout: LOAD_TIMEOUT });
    ok('zoomed out past 12 there are no pins, and the note says to zoom in', (await page.$$('.mn-photo-icon')).length === 0
      && /Zoom in/.test(await text('#map-photos-note')));
    await page.evaluate(() => state.map.setZoom(16, { animate: false }));
    await page.waitForFunction(() => MapPhotos._note().kind === 'ok' && MapPhotos.drawn().length === 3, null, { timeout: LOAD_TIMEOUT });
    await page.evaluate(() => MapPhotos.setEnabled(false));
    ok('switched off: nothing drawn, and remembered', (await page.$$('.mn-photo-icon')).length === 0
      && await page.evaluate(() => localStorage.getItem('mn-field-photos') === 'off' && !document.querySelector('#map-legend .legend-photo')));
    await page.evaluate(() => MapPhotos.setEnabled(true));
    await page.waitForFunction(() => MapPhotos.drawn().length === 3, null, { timeout: LOAD_TIMEOUT });
    ok('…and back on', true);

    // ── The map, tilted ──────────────────────────────────────────────────────
    section('The Stations map in 3-D');
    const gl2 = await page.evaluate(() => { try { return !!document.createElement('canvas').getContext('webgl2'); } catch (_) { return false; } });
    if (!gl2) {
      console.log('  SKIP — this Chromium has no WebGL2; the 3-D view\'s pins cannot be exercised here.');
    } else {
      await tiltedHalf(page, R, db, viewer, text);
    }

    // ── The twin ─────────────────────────────────────────────────────────────
    section('The Digital Twin');
    const gl = await page.evaluate(() => { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); });
    if (!gl) {
      console.log('  SKIP — this Chromium has no WebGL; the twin\'s markers cannot be exercised here.');
    } else {
      await twinHalf(page, R, db, viewer, text);
    }

    // ── The viewer: the ±, the compass, a pin moved ──────────────────────────
    section('The viewer — a rough fix in red, the compass, and a pin moved');
    await compassHalf(page, R, db, objects, viewer, text);

    // ── Signing out ──────────────────────────────────────────────────────────
    section('Signing out');
    // The twin up with its photos first: it is inside the Stations map now,
    // and a render of that tab since (a photo moved above) takes it down.
    if (gl) {
      await page.evaluate(() => { if (!MapTwin.active()) DigitalTwin.openStation('gatton'); });
      await page.waitForFunction(() => MapTwin.active() && DigitalTwin.debug().built && DigitalTwin.debug().photos
        && DigitalTwin.debug().photos.status === 'ok', null, { timeout: BUILD_TIMEOUT }).catch(() => {});
    }
    await page.evaluate(() => { dbSetAccessToken(null); FieldPhotos.authChanged(); });
    await page.waitForTimeout(400);
    if (gl) {
      const d = await page.evaluate(() => DigitalTwin.debug().photos);
      ok('the twin takes its markers down and says to sign in', d && d.status === 'signed-out' && d.spots.length === 0
        && /sign in/.test(await text('#twin-pane-photos')), J(d));
    }
    ok('the viewer\'s rows are forgotten', await page.evaluate(id => !FieldPhotos.row(id), R.sw.id));
    // A request of the last session's that answers after it has ended — the
    // twin's spots, a page of the library — must not put its rows back.
    // openOne() asks for exactly one such row, now, and answers into keep().
    await page.evaluate(id => FieldPhotos.openOne(id), R.sw.id);
    ok('…and a row that arrives after signing out is kept nowhere and shown nowhere',
      await page.evaluate(id => !FieldPhotos.row(id) && !FieldPhotos.isOpen(), R.sw.id));
    await page.evaluate(() => switchTab('stations'));
    await page.waitForFunction(() => MapPhotos._note().kind === 'signed-out', null, { timeout: LOAD_TIMEOUT });
    ok('the map draws no pins for a session that is not signed in', (await page.$$('.mn-photo-icon')).length === 0);

    // ── A real HEIC ──────────────────────────────────────────────────────────
    // Last, and signed in again, so that the photo it adds is in none of the
    // counts above.
    section('A real HEIC, in a browser that cannot draw one');
    await heicHalf(page, db, store, queue, settledQueue, net);

    ok('nothing threw and the console stayed clean', errors.length === 0, errors.slice(0, 4).join(' | '));
    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
}

// A position within `tol` degrees (2e-7 is 2 cm).
function at2(p, lat, lon, tol = 2e-7) { return !!p && near(p.lat, lat, tol) && near(p.lon, lon, tol); }

// A HEIC as an iPhone makes one, dropped on Chromium, which draws none
// (#202). Everything after the pixels is the path a HEIC Safari drew takes —
// so what is asserted is that the pixels are the picture (sampled out of the
// JPEG that went up, the four colours in their four corners) and that
// everything the file says still reaches the record: the position and
// heading from its EXIF, its hash as it arrived, what it was converted from.
async function heicHalf(page, db, store, queue, settledQueue, net) {
  await page.evaluate(() => { dbSetAccessToken('test-token'); FieldPhotos.authChanged(); switchTab('photos'); });
  await page.waitForFunction(() => !!document.getElementById('fp-files'), null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => FieldPhotos.clearFinished());
  const uploads0 = store.uploads.length;
  await page.setInputFiles('#fp-files', [{ name: 'IMG_2041.HEIC', mimeType: 'image/heic', buffer: HEIC_REAL }]);
  await settledQueue();
  let one = (await queue()).find(i => i.name === 'IMG_2041.HEIC');
  ok('read: decoded by libheif, the picture\'s own 160 × 120, and a thumbnail made from it',
    one && one.status === 'ready' && one.decoder === 'libheif' && one.width === 160 && one.height === 120 && one.thumb, J(one));
  const station = nearestStation(HEIC_AT);
  ok('…placed from its EXIF, 205.5° true, 10:02 AEST — the OCR not asked — and filed under the nearest station',
    one && one.pos && one.pos.placement === 'exif' && at2(one.pos, HEIC_AT.lat, HEIC_AT.lon, 1e-7) && one.pos.accuracy === 4.5
      && one.heading && one.heading.deg === 205.5 && one.taken && one.taken.iso === '2026-06-25T00:02:00.000Z' && !one.ocr
      && one.station && station && one.station.id === station.id, J(one && { pos: one.pos, h: one.heading, t: one.taken, st: one.station }));
  ok('…its hash the HEIC\'s, as it arrived; to be stored as a JPEG', one && one.sha === sha256(HEIC_REAL) && one.converted
    && one.contentType === 'image/jpeg' && one.ext === 'jpg', J(one && { sha: one.sha, c: one.converted, t: one.contentType }));

  await page.click('#fp-upload');
  await settledQueue();
  one = (await queue()).find(i => i.name === 'IMG_2041.HEIC');
  const add = db.calls.filter(c => c.fn === 'add_field_photo').pop();
  const p = add && add.body.p_photo;
  const up = store.uploads.slice(uploads0);
  const obj = p && up.find(u => u.path === p.storage_path);
  ok('uploaded: a .jpg object that is a JPEG, image/jpeg, and its thumbnail beside it',
    one && one.status === 'done' && p && /\.jpg$/.test(p.storage_path) && p.content_type === 'image/jpeg' && obj
      && obj.contentType === 'image/jpeg' && obj.data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
      && p.byte_size === obj.bytes && up.some(u => u.path === p.thumb_path), J({ one: one && one.status, p: p && { path: p.storage_path, type: p.content_type }, up: up.map(u => u.path) }));
  ok('…the record: the HEIC\'s hash, where and which way, 160 × 120, and what it was converted from',
    p && p.sha256 === sha256(HEIC_REAL) && p.placement === 'exif' && p.lat === HEIC_AT.lat && p.lon === HEIC_AT.lon && p.heading_deg === 205.5
      && p.width === 160 && p.height === 120 && p.meta.converted && p.meta.converted.from === 'image/heic'
      && p.meta.converted.bytes === HEIC_REAL.length && p.meta.file.format === 'heic' && p.meta.camera.make === 'Apple', J(p));
  const px = obj ? await page.evaluate(async ({ b64, quads }) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const x = c.getContext('2d');
    x.drawImage(bmp, 0, 0);
    return { w: bmp.width, h: bmp.height, at: quads.map(([, qx, qy]) => Array.from(x.getImageData(qx, qy, 1, 1).data.slice(0, 3))) };
  }, { b64: obj.data.toString('base64'), quads: HEIC_QUADS }) : null;
  const off = px ? HEIC_QUADS.map(([name, , , want], i) => ({ name, want, got: px.at[i] }))
    .filter(q => q.got.some((v, k) => Math.abs(v - q.want[k]) > 24)) : null;
  ok('the JPEG is the picture, the right way up: red and green over blue and yellow, to a JPEG\'s rounding',
    px && px.w === 160 && px.h === 120 && off.length === 0, J(px && { w: px.w, h: px.h, off }));
  ok('nothing from the decoder\'s host was refused, then or since', !net.blocked.some(u => /libheif/.test(u)),
    net.blocked.filter(u => /libheif/.test(u)).join(', '));
}

// The same pins with the map tilted (#200). What is under test is the seam
// the 3-D view is built on — it draws what MapPhotos drew and asks for
// nothing — and the one thing the 2-D pins had to learn the hard way: a pin
// that is on screen can be pressed. So the badges are found where MapLibre
// puts them, clicked with a real pointer and pressed with a real key, and the
// three reasons for no pins are each met with the map tilted.
async function tiltedHalf(page, R, db, viewer, text) {
  const photos3 = () => page.evaluate(() => Map3D._photos());
  const idle = () => page.waitForFunction(() => { const m = Map3D._map(); return !!m && !m.isMoving() && m.areTilesLoaded(); },
    null, { timeout: BUILD_TIMEOUT }).catch(() => {});
  const byFirst = list => Object.fromEntries(list.map(p => [p.ids[0], p]));

  const selects0 = db.selects.length;
  await page.locator('.mn-map-3d').click();
  await page.waitForFunction(() => typeof Map3D !== 'undefined' && !!Map3D._map() && Map3D._map().isStyleLoaded()
    && !!Map3D._map().getTerrain() && Map3D._photos().pins.length === 3, null, { timeout: BUILD_TIMEOUT });
  await page.waitForTimeout(600);
  await idle();

  let P = await photos3();
  const flat = await page.evaluate(() => MapPhotos.drawn());
  const want = byFirst(flat), got = byFirst(P.pins);
  const same = flat.every(d => { const g = got[d.ids[0]]; return g && g.lat === d.lat && g.lon === d.lon && J(g.ids) === J(d.ids) && g.n === d.n && J(g.cones) === J(d.cones); });
  ok('tilted, a badge for each of the three pins 2-D drew — at the same point, opening the same photos, facing the same ways',
    P.pins.length === 3 && same, J(P.pins.map(p => ({ n: p.n, lat: p.lat, lon: p.lon }))));
  const pair3 = P.pins.find(p => p.n === 2), exif3 = P.pins.find(p => p.ids.includes(R.gps.id)), p2_3 = P.pins.find(p => p.ids.includes(R.p2.id));
  ok('…the SW/NE spot where the first of them was taken, the EXIF photo where its GPS put it, the one placed by hand where it was placed',
    pair3 && at2(pair3, R.ne.lat, R.ne.lon, 1e-9) && exif3 && at2(exif3, R.gps.lat, R.gps.lon, 1e-9) && p2_3 && at2(p2_3, R.p2.lat, R.p2.lon, 1e-9),
    J({ pair3, exif3, p2_3 }));
  ok('…named as the 2-D pins are', pair3 && pair3.label === '2 field photos taken here, facing 46° and 242° — open them'
    && Object.values(want).every(d => got[d.ids[0]] && got[d.ids[0]].label === d.title), pair3 && pair3.label);
  ok('entering 3-D asked the project for nothing — the pins are read off the 2-D layer, not fetched again',
    db.selects.length === selects0, `${db.selects.length - selects0} more select(s)`);

  const feats = (P.drawn && P.drawn.features) || [];
  const dots = feats.filter(f => f.properties.kind === 'dot'), cones = feats.filter(f => f.properties.kind === 'cone');
  const at = (f, p) => f.geometry.coordinates[0] === p.lon && f.geometry.coordinates[1] === p.lat;
  ok('a dot on each point, in the renderer\'s own source', P.source && dots.length === 3 && flat.every(d => dots.some(f => at(f, d))),
    J(dots.map(f => f.geometry.coordinates)));
  const conesAt = p => cones.filter(f => at(f, p)).map(f => f.properties.heading).sort((a, b) => a - b);
  ok('…and a cone each way a camera faced — 46° and 242° at the pair, 118.25° at the EXIF photo, none at the one placed by hand',
    J(conesAt(pair3)) === J([46, 242]) && J(conesAt(exif3)) === J([118.25]) && conesAt(p2_3).length === 0 && cones.length === 3 && P.image,
    J(cones.map(f => [f.geometry.coordinates, f.properties.heading])));
  const style = await page.evaluate(() => {
    const m = Map3D._map(), ids = m.getStyle().layers.map(l => l.id);
    return { ids, rot: m.getLayoutProperty('mn-photos-cones', 'icon-rotation-alignment'),
             pitch: m.getLayoutProperty('mn-photos-cones', 'icon-pitch-alignment'),
             rotate: m.getLayoutProperty('mn-photos-cones', 'icon-rotate') };
  });
  const ix = id => style.ids.indexOf(id);
  ok('the dots and cones are over the links and under the station pins, as 2-D\'s photo pane is',
    ix('mn-photos-cones') > ix('mn-links') && ix('mn-photos-dot') > ix('mn-photos-cones') && ix('mn-photos-dot') < ix('mn-stations'),
    style.ids.join(', '));
  ok('…the cones laid in the ground\'s plane, turned by heading from north',
    style.rot === 'map' && style.pitch === 'map' && J(style.rotate) === J(['get', 'heading']), J(style));

  // Where the badge is on screen, against where MapLibre puts its point: the
  // badge stands up and to the right of it, 4 px each way, as in 2-D.
  const seen = await page.evaluate(() => {
    const m = Map3D._map(), c = m.getCanvas().getBoundingClientRect();
    return [...document.querySelectorAll('#map3d .mn-photo-3d')].map(el => {
      const pin = Map3D._photos().pins.find(p => p.ids[0] === el.dataset.mnPhotoId);
      const b = el.querySelector('.mn-photo-badge').getBoundingClientRect();
      const pt = m.project([pin.lon, pin.lat]);
      const x = b.left + b.width / 2, y = b.top + b.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { id: el.dataset.mnPhotoId, dx: b.left - (c.left + pt.x), dy: (c.top + pt.y) - b.bottom,
               x, y, mine: !!(hit && el.contains(hit)), n: el.querySelector('.mn-photo-badge b').textContent,
               role: el.getAttribute('role'), tab: el.tabIndex };
    });
  });
  ok('each badge stands just up and right of its point on the terrain, as MapLibre projects it',
    seen.length === 3 && seen.every(s => near(s.dx, 4, 1.5) && near(s.dy, 4, 1.5)), J(seen.map(s => ({ dx: s.dx, dy: s.dy }))));
  ok('…carries the count, is a button in the tab order, and is what is under the pointer at its own middle',
    seen.every(s => s.role === 'button' && s.tab === 0 && s.mine) && seen.map(s => s.n).sort().join() === '1,1,2', J(seen));

  // A real pointer on the pair's badge.
  const pairSeen = seen.find(s => s.id === pair3.ids[0]);
  await page.evaluate(() => {
    window.__lfClicks = 0; window.__mlClicks = 0;
    state.map.on('click', () => window.__lfClicks++);
    Map3D._map().on('click', () => window.__mlClicks++);
  });
  await page.mouse.click(pairSeen.x, pairSeen.y);
  let v = await viewer();
  const leaked = await page.evaluate(() => ({ lf: window.__lfClicks, ml: window.__mlClicks, here: MapHere.point() }));
  ok('a click on the pair\'s badge opens the carousel over the two photos taken there, as the 2-D pin does',
    v && v.ids.length === 2 && v.ids.includes(R.sw.id) && v.ids.includes(R.ne.id) && /2 photos taken here — photo 1 of 2/.test(await text('#fp-v-title')),
    `${J(v)} ${await text('#fp-v-title')}`);
  ok('…answered by the badge alone — not the 3-D map, not the 2-D map under it', leaked.lf === 0 && leaked.ml === 0 && leaked.here === null, J(leaked));
  await page.keyboard.press('Escape');

  // And the keyboard: Enter on the badge, then Escape back to it.
  await page.evaluate(id => document.querySelector(`#map3d .mn-photo-3d[data-mn-photo-id="${id}"]`).focus(), exif3.ids[0]);
  await page.keyboard.press('Enter');
  v = await viewer();
  ok('Enter on a focused badge opens its photos', v && v.ids.length === 1 && v.ids[0] === R.gps.id, J(v));
  await page.keyboard.press('Escape');
  ok('…and Escape hands the focus back to that badge', await page.evaluate(id => document.activeElement
    && document.activeElement.dataset.mnPhotoId === id, exif3.ids[0]));

  // The three reasons for no pins, each met tilted: zoomed out, switched off,
  // signed out — and the note under 🗺️ Map display's switch saying which.
  const none3 = async () => {
    const p = await photos3();
    return p.pins.length === 0 && p.drawn && p.drawn.features.length === 0
      && (await page.$$('#map3d .mn-photo-3d')).length === 0;
  };
  const back3 = () => page.waitForFunction(() => MapPhotos._note().kind === 'ok' && Map3D._photos().pins.length === 3,
    null, { timeout: BUILD_TIMEOUT });
  const zoom0 = await page.evaluate(() => Map3D._map().getZoom());
  await page.evaluate(() => Map3D._map().jumpTo({ zoom: 10 }));
  await page.waitForFunction(() => MapPhotos._note().kind === 'zoom', null, { timeout: LOAD_TIMEOUT });
  ok('the camera pulled back past 12 (the 2-D map under it at 11): no pins, and the note says to zoom in',
    await none3() && /Zoom in/.test(await text('#map-photos-note')), await text('#map-photos-note'));
  await page.evaluate(z => Map3D._map().jumpTo({ zoom: z }), zoom0);
  await back3();
  ok('…brought back in, they are back', true);

  await page.evaluate(() => MapPhotos.setEnabled(false));
  ok('switched off: none tilted either, and the note is the switch\'s own', await none3()
    && /A 📷 where each field photo was taken/.test(await text('#map-photos-note')), await text('#map-photos-note'));
  await page.evaluate(() => MapPhotos.setEnabled(true));
  await back3();

  await page.evaluate(() => { dbSetAccessToken(null); FieldPhotos.authChanged(); });
  await page.waitForFunction(() => MapPhotos._note().kind === 'signed-out', null, { timeout: LOAD_TIMEOUT });
  ok('signed out: no pins in 3-D, and the note says to sign in', await none3() && /sign in/.test(await text('#map-photos-note')),
    await text('#map-photos-note'));
  await page.evaluate(() => { dbSetAccessToken('test-token'); FieldPhotos.authChanged(); });
  await back3();
  ok('…signed back in, they come back', true);

  await page.locator('.mn-map-3d').click();
  await page.waitForFunction(() => !Map3D._map(), null, { timeout: BUILD_TIMEOUT });
  const gone = await page.evaluate(() => ({ markers: document.querySelectorAll('.maplibregl-marker').length,
                                           pins: Map3D._photos().pins.length, flat: document.querySelectorAll('.mn-photo-icon').length }));
  ok('leaving 3-D takes its badges with it, and leaves the 2-D pins', gone.markers === 0 && gone.pins === 0 && gone.flat === 3, J(gone));
}


// The viewer's side, on a spot of five: the SW and NE photos (their widths not
// recorded — each drawn 60° and dashed) and three more put in the bucket by
// hand as the Dropbox sync would have stored them, Solocator photos placed from
// their EXIF, one of them a rough fix, one with no ± at all whose picture is
// the SW photo, overlay and all. In time order NE 46°, SW 242°, then 201°,
// 234° and 325°; round the compass NE, 201°, 234°, SW, 325°.
async function compassHalf(page, R, db, objects, viewer, text) {
  const seeded = [];
  const seed = (n, o) => {
    const id = `00000000-0000-4000-8000-0000000c0${String(n).padStart(3, '0')}`;
    const row = {
      id, storage_bucket: 'field-photos', storage_path: `photo/${id}.jpg`, thumb_path: null,
      content_type: 'image/jpeg', byte_size: SW.length, sha256: crypto.createHash('sha256').update(id).digest('hex'), width: 1545, height: 1159,
      title: `BoM-FWIN_Gatton_2026-06-24_12-58-0${n}.JPG`, caption: '',
      taken_at: `2026-06-24T02:58:0${n}.000Z`, taken_local: `2026-06-24T12:58:0${n}`, taken_source: 'exif',
      lat: G.lat, lon: G.lon, placement: 'exif', accuracy_m: null, altitude_m: 104, altitude_ref: 'MSL',
      heading_deg: null, heading_ref: 'T', pitch_deg: null, fov_deg: null, station_id: 'gatton', station_auto: true,
      meta: { camera: { make: 'Apple', model: 'iPhone 12 mini', software: 'Solocator', lens: null }, file: { format: 'jpeg', exif: true } },
      origin: 'dropbox', origin_ref: null, uploaded_by: 'fixture@example.test',
      created_at: '2026-06-24T06:00:00.000Z', updated_at: '2026-06-24T06:00:00.000Z', updated_by: null, deleted_at: null, deleted_by: null,
      ...o,
    };
    db.rows.push(row);
    seeded.push(row);
    return row;
  };
  const s1 = seed(1, { heading_deg: 201, fov_deg: 67.3, accuracy_m: 13, lat: G.lat - 0.000004 });
  const s2 = seed(2, { heading_deg: 234, fov_deg: 53.1 });
  const s3 = seed(3, { heading_deg: 325, fov_deg: 58.9, accuracy_m: 4, lon: G.lon + 0.000004 });
  objects[s2.storage_path] = SW;
  const wedges = () => page.$$eval('#fp-v-spotmap .fp-cmp-wedge', ws => ws.map(w => ({
    id: w.dataset.fpId, here: w.classList.contains('is-here'), gold: w.classList.contains('is-gold'),
    assumed: w.classList.contains('is-assumed'), fill: +getComputedStyle(w).fillOpacity })));
  const boxed = () => page.$$eval('#fp-viewer .fp-v-thumb', bs => bs.map(b => b.classList.contains('is-gold')));
  // A click on the dial `deg` round from north, `rad` of its 140 pixels out —
  // near the rim, where a pixel is least of an angle.
  const dial = async (deg, rad = 52) => {
    const p = await page.evaluate(({ deg, rad }) => {
      document.querySelector('#fp-v-spotmap .fp-cmp').scrollIntoView({ block: 'center' });
      const b = document.querySelector('#fp-v-spotmap .fp-cmp').getBoundingClientRect(), k = b.width / 140, a = deg * Math.PI / 180;
      return { x: b.left + b.width / 2 + rad * Math.sin(a) * k, y: b.top + b.height / 2 - rad * Math.cos(a) * k };
    }, { deg, rad });
    await page.mouse.click(p.x, p.y);
  };
  const msg = () => text('#fp-v-msg');

  // On whichever tab the twin left open — the viewer is over all of them, and
  // signing out, next, reads the twin's markers.
  await page.evaluate(() => FieldPhotos.changed());
  // The rows reach the page the way the map's and the twin's do: in a box.
  await page.evaluate(g => FieldPhotos.inBox({ south: g.lat - 0.001, north: g.lat + 0.001, west: g.lon - 0.001, east: g.lon + 0.001 }), G);
  const ids = [R.ne.id, R.sw.id, s1.id, s2.id, s3.id];
  await page.evaluate(ids => FieldPhotos.openSpot(ids, null, 'Photos taken 120 m NW of Gatton'), ids);
  let v = await viewer();
  ok('a spot opens in the compass\'s order, N → E → S → W — NE 46°, 201°, 234°, SW 242°, 325° — on the first',
    v && J(v.ids) === J([R.ne.id, s1.id, s2.id, R.sw.id, s3.id]) && v.i === 0 && /photo 1 of 5/.test(await text('#fp-v-title')), J(v && v.ids));

  let w = await wedges();
  ok('the compass: a wedge for each of the five, the one shown drawn last and strong, the other four dimmed',
    w.length === 5 && w[4].id === R.ne.id && w[4].here && w.slice(0, 4).every(x => !x.here && x.fill < w[4].fill), J(w));
  ok('…a width the file did not give drawn at 60° and dashed — the SW and NE photos\', read off their overlays',
    w.filter(x => x.assumed).map(x => x.id).sort().join() === [R.ne.id, R.sw.id].sort().join(), J(w));
  ok('…and under it, which way this one faces and how to use it',
    /Facing 46° NE \(true\)\. 5 photos taken here — click a direction for the one facing it\./.test(await text('#fp-cmp-note')), await text('#fp-cmp-note'));
  const cmpBox = await page.evaluate(() => {
    const m = document.querySelector('#fp-v-spotmap');
    const mb = m ? m.getBoundingClientRect() : null;
    const c = m ? m.querySelector('.fp-cmp') : null, cb = c ? c.getBoundingClientRect() : null;
    const n = document.querySelector('#fp-cmp-note'), nb = n ? n.getBoundingClientRect() : null;
    return { map: !!mb, ring: !!cb, w: cb ? cb.width : 0,
             inside: !!(cb && mb && cb.left >= mb.left && cb.right <= mb.right && cb.top >= mb.top && cb.bottom <= mb.bottom),
             letters: c ? [...c.querySelectorAll('.fp-cmp-label')].map(t => t.textContent).join('') : '',
             noteBelow: !!(nb && mb && nb.top >= mb.bottom - 1), separateDial: !!document.querySelector('#fp-v-compass .fp-cmp'),
             mapW: mb ? Math.round(mb.width) : 0, tiles: m ? m.querySelectorAll('.leaflet-tile').length : 0,
             here: m ? m.querySelectorAll('.fp-sm-here').length : 0, others: m ? m.querySelectorAll('.fp-mm-other').length : 0 };
  });
  ok('…on the satellite map of the spot — one compass, not two — a ring round the photo\'s point with N, E, S and W on it',
    cmpBox.map && cmpBox.ring && cmpBox.inside && cmpBox.letters === 'NESW' && !cmpBox.separateDial && cmpBox.mapW > 120, J(cmpBox));
  ok('…this photo\'s point, the other four as dots, and the note under the map',
    cmpBox.here === 1 && cmpBox.others === 4 && cmpBox.noteBelow, J(cmpBox));

  await dial(201);
  v = await viewer();
  ok('a click on a wedge brings its photo up: 201°, the photo facing SSW, alone in that direction — nothing boxed',
    v.i === 1 && v.ids[1] === s1.id && v.gold.length === 0 && J(await boxed()) === J([false, false, false, false, false]), J(v));
  const acc = await page.evaluate(() => {
    const e = document.querySelector('#fp-v-details .fp-acc');
    return e && { text: e.textContent, rough: e.classList.contains('fp-acc-rough'), colour: getComputedStyle(e).color,
                  bad: getComputedStyle(document.documentElement).getPropertyValue('--bad').trim() };
  });
  const rgb = hex => { const n = parseInt(hex.replace('#', ''), 16); return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`; };
  ok('its ± is shown with the coordinates, red — ±13 m is wider than 7 m — and says "a rough fix" in words too',
    acc && acc.rough && acc.colour === rgb(acc.bad) && acc.text === '±13 m — a rough fix, wider than 7 m'
      && /Where\s*-27\.554298, 152\.274116 ±13 m/.test(await text('#fp-v-details')), J(acc));

  await dial(236);
  v = await viewer();
  ok('236° is in two wedges — 234° 53° wide, and the SW photo\'s 242° — so both are boxed in gold and the nearer, 234°, comes up',
    v.i === 2 && J(v.gold.slice().sort()) === J([s2.id, R.sw.id].sort()) && J(await boxed()) === J([false, false, true, true, false]), J(v));
  w = await wedges();
  ok('…boxed on the dial too, and the note says so',
    w.filter(x => x.gold).map(x => x.id).sort().join() === [s2.id, R.sw.id].sort().join()
      && /2 photos taken here face 23[5-7]° W?SW — boxed in gold on the strip\. Click there again for the next\./.test(await text('#fp-cmp-note')),
    `${J(w)} ${await text('#fp-cmp-note')}`);
  const gold = await page.evaluate(() => {
    const b = document.querySelectorAll('#fp-viewer .fp-v-thumb')[3], cs = getComputedStyle(b);
    return { border: cs.borderTopColor, shadow: cs.boxShadow, ring: getComputedStyle(document.documentElement).getPropertyValue('--hit-ring').trim() };
  });
  ok('…the box in the search-hit amber', gold.border === rgb(gold.ring) && gold.shadow.includes(rgb(gold.ring)), J(gold));
  ok('…this one\'s ± was never in its file: it says so, and offers to read it off the picture',
    /No ± in the file — Solocator printed it on the picture\.\s*Read it off the photo/.test(await text('#fp-v-details'))
      && !(await page.$('#fp-v-details .fp-acc')), await text('#fp-v-details'));
  await dial(236);
  v = await viewer();
  ok('the same direction again steps to the next of them, the gold kept', v.i === 3 && v.ids[3] === R.sw.id && v.gold.length === 2, J(v));
  await page.click('.fp-v-thumb >> nth=2');
  ok('a boxed thumbnail goes to its photo and the boxes stay', (await viewer()).i === 2 && J(await boxed()) === J([false, false, true, true, false]));
  await dial(90);
  v = await viewer();
  ok('a direction nobody faced (90°) clears the gold and says so, leaving the photo where it was',
    v.i === 2 && v.gold.length === 0 && J(await boxed()) === J([false, false, false, false, false])
      && /No photo taken here faces (89|90|91)° E\./.test(await text('#fp-cmp-note')), `${J(v)} ${await text('#fp-cmp-note')}`);
  await page.focus(`#fp-v-spotmap .fp-cmp-wedge[data-fp-id="${s3.id}"]`);
  await page.keyboard.press('Enter');
  ok('Enter on a wedge brings its photo up, the focus staying on that wedge',
    (await viewer()).i === 4 && await page.evaluate(id => document.activeElement && document.activeElement.dataset.fpId === id, s3.id));
  await page.keyboard.press('ArrowLeft');
  ok('← from there is still the photo before, round the compass', (await viewer()).i === 3);

  // The ± off the picture.
  await page.click('.fp-v-thumb >> nth=2');
  const before = db.calls.length;
  await page.click('#fp-v-details button:has-text("Read it off the photo")');
  await page.waitForFunction(() => /read and saved|could not be read|could not/.test((document.getElementById('fp-v-msg') || {}).textContent || ''),
    null, { timeout: OCR_TIMEOUT });
  const readCall = db.calls.slice(before).filter(c => c.fn === 'update_field_photo');
  ok('"Read it off the photo": the stored picture read by the OCR, its ±4 m saved as a patch of accuracy_m and nothing else',
    readCall.length === 1 && J(readCall[0].body) === J({ p_id: s2.id, p_patch: { accuracy_m: 4 } }) && s2.accuracy_m === 4
      && /The ± is read and saved\./.test(await msg()), `${J(readCall.map(c => c.body))} ${await msg()}`);
  ok('…and shown, not red — 4 m is inside 7', /Where\s*-27\.554294, 152\.274116 ±4 m/.test(await text('#fp-v-details'))
    && !(await page.$('#fp-v-details .fp-acc-rough')) && !/Read it off/.test(await text('#fp-v-details')), await text('#fp-v-details'));

  // Moving a pin: the rough one, and the four taken with it.
  await page.click('.fp-v-thumb >> nth=1');
  await page.click('#fp-v-details button:has-text("Move…")');
  await page.waitForFunction(() => { const x = FieldPhotos._viewer(); return !!(x && x.moving && x.moving.pin); }, null, { timeout: LOAD_TIMEOUT });
  let mv = (await viewer()).moving;
  ok('Move… opens a map with the photo\'s pin where it stands, its GPS\'s ±13 m ring round it, and the four others taken there',
    mv.id === s1.id && near(mv.from[0], s1.lat, 1e-9) && near(mv.from[1], s1.lon, 1e-9) && mv.ring === 13 && mv.others === 4 && mv.withOthers
      && mv.zoom >= 18 && (await page.evaluate(() => document.activeElement && document.activeElement.id)) === 'fp-v-coord', J(mv));
  ok('…the ring red, as the ± is', await page.evaluate(() => !!document.querySelector('#fp-v-map path.fp-mm-ring.is-rough')));
  ok('…with the way the camera looked drawn from the pin, and the others\' dots',
    await page.evaluate(() => !!document.querySelector('#fp-v-map path.fp-mm-cone') && document.querySelectorAll('#fp-v-map path.fp-mm-other').length === 4));
  const audit = await auditHandlers(page);
  ok(`the viewer with the mover and the compass: all ${audit.checked} handler(s) resolve`, audit.unresolved.length === 0, audit.unresolved.map(u => u.path).join(', '));
  const pin = await page.evaluate(() => FieldPhotos._pinAt());
  await page.mouse.move(pin.x, pin.y);
  await page.mouse.down();
  await page.mouse.move(pin.x + 15, pin.y, { steps: 3 });
  await page.mouse.move(pin.x + 40, pin.y, { steps: 5 });
  await page.mouse.up();
  mv = (await viewer()).moving;
  const coord = await page.inputValue('#fp-v-coord');
  ok('dragging the pin moves it east, and the coordinates box follows',
    mv.at[1] > mv.from[1] + 2e-5 && Math.abs(mv.at[0] - mv.from[0]) < 3e-6 && coord === `${mv.at[0].toFixed(6)}, ${mv.at[1].toFixed(6)}`, `${J(mv)} ${coord}`);
  ok('…and says how far, which way, and from what',
    /^\d+ m E of where the GPS put it \(the GPS said ±13 m\)\. Save to keep it\.$/.test(await text('#fp-v-moved')), await text('#fp-v-moved'));
  const dots = await page.evaluate(() => [...document.querySelectorAll('#fp-v-map path.fp-mm-other')].map(p => p.getBoundingClientRect().x));
  await page.uncheck('#fp-v-with');
  const home = await page.evaluate(() => [...document.querySelectorAll('#fp-v-map path.fp-mm-other')].map(p => p.getBoundingClientRect().x));
  ok('…the four others\' dots went with it, and back when "with it" is unticked',
    dots.length === 4 && dots.every((x, i) => x - home[i] > 25), J({ dots, home }));
  await page.check('#fp-v-with');
  const at0 = [...mv.at], was = Object.fromEntries(seeded.concat([R.ne, R.sw]).map(r => [r.id, [r.lat, r.lon]]));
  const from0 = callsFrom(db);
  await page.click('#fp-v-place button:has-text("Save")');
  await page.waitForFunction(() => /^Moved/.test((document.getElementById('fp-v-msg') || {}).textContent || ''), null, { timeout: LOAD_TIMEOUT });
  const moves = from0();
  const saved = moves[0] && moves[0].body.p_patch;
  const dLat = saved ? saved.lat - was[s1.id][0] : NaN, dLon = saved ? saved.lon - was[s1.id][1] : NaN;
  ok('Save: the photo to where its pin was dropped, placed by hand',
    moves.length === 5 && moves[0].body.p_id === s1.id && near(saved.lat, +at0[0].toFixed(6), 1e-9) && near(saved.lon, +at0[1].toFixed(6), 1e-9)
      && saved.placement === 'manual' && Object.keys(saved).length === 3, J(moves.map(c => c.body)));
  ok('…and the other four taken there by the same offset, one patch each',
    new Set(moves.slice(1).map(c => c.body.p_id)).size === 4 && moves.slice(1).every(c => {
      const b = was[c.body.p_id], p = c.body.p_patch;
      return b && near(p.lat - b[0], dLat, 2e-7) && near(p.lon - b[1], dLon, 2e-7) && p.placement === 'manual';
    }) && /^Moved, and the 4 other photos taken here with it\.$/.test(await msg()), `${J(moves.map(c => c.body))} ${await msg()}`);
  v = await viewer();
  ok('…the mover shuts, the ± goes — the place is somebody\'s word now, not the GPS\'s — and the five are still one spot',
    !v.editing && !v.moving && s1.accuracy_m === null && /placed by hand/.test(await text('#fp-v-details'))
      && !(await page.$('#fp-v-details .fp-acc')) && (await wedges()).length === 5, `${J(v)} ${await text('#fp-v-details')}`);

  // Once more, alone: clicked on the map, then typed.
  await page.click('#fp-v-details button:has-text("Move…")');
  await page.waitForFunction(() => { const x = FieldPhotos._viewer(); return !!(x && x.moving && x.moving.pin); }, null, { timeout: LOAD_TIMEOUT });
  await page.uncheck('#fp-v-with');
  const there = { lat: s1.lat - 0.00006, lon: s1.lon + 0.00001 };
  const pt = await page.evaluate(p => FieldPhotos._mapPoint(p.lat, p.lon), there);
  await page.mouse.click(pt.x, pt.y);
  mv = (await viewer()).moving;
  ok('a click on the map puts the pin there — to the pixel', near(mv.at[0], there.lat, 6e-6) && near(mv.at[1], there.lon, 6e-6), J(mv));
  await page.fill('#fp-v-coord', '-27.554330, 152.274150');
  mv = (await viewer()).moving;
  ok('…and coordinates typed in the box move it as they are typed', near(mv.at[0], -27.55433, 1e-9) && near(mv.at[1], 152.27415, 1e-9), J(mv));
  const from1 = callsFrom(db);
  await page.press('#fp-v-coord', 'Enter');
  await page.waitForFunction(() => /^Moved\.$/.test((document.getElementById('fp-v-msg') || {}).textContent || ''), null, { timeout: LOAD_TIMEOUT });
  const alone = from1();
  ok('unticked, Save moves that photo alone', alone.length === 1 && alone[0].body.p_id === s1.id
    && J(alone[0].body.p_patch) === J({ lat: -27.55433, lon: 152.27415, placement: 'manual' }), J(alone.map(c => c.body)));

  await page.click('#fp-v-details button:has-text("Move…")');
  await page.waitForFunction(() => !!(FieldPhotos._viewer() || {}).moving, null, { timeout: LOAD_TIMEOUT });
  await page.keyboard.press('Escape');
  v = await viewer();
  ok('Escape shuts the mover — the map with it — and hands the focus back to Move…', v && !v.editing && !v.moving
    && !(await page.$('#fp-v-map')) && await page.evaluate(() => /Move…/.test((document.activeElement || {}).textContent || '')), J(v));
  await page.keyboard.press('Escape');
  ok('…and Escape again closes the viewer', !(await viewer()));

  // One photo alone at its spot.
  await page.evaluate(id => FieldPhotos.openOne(id), R.gps.id);
  ok('a photo alone at its spot: one wedge, and the note says so',
    (await wedges()).length === 1 && /Facing 118° ESE \(true\), \d+° wide\. The only photo taken here\./.test(await text('#fp-cmp-note')),
    await text('#fp-cmp-note'));
  await page.keyboard.press('Escape');
  // Put back as they were, and out of the counts the sections after this keep
  // — the twin's markers read again before anything signs out under them.
  for (const r of seeded) r.deleted_at = '2026-06-25T00:00:00Z';
  for (const r of [R.ne, R.sw]) [r.lat, r.lon] = was[r.id];
  await page.evaluate(() => FieldPhotos.changed());
  await page.waitForFunction(() => {
    const d = typeof DigitalTwin !== 'undefined' && DigitalTwin.debug ? DigitalTwin.debug().photos : null;
    return !d || d.status !== 'loading';
  }, null, { timeout: LOAD_TIMEOUT });
}
// The update_field_photo calls made after this point, when asked.
function callsFrom(db) {
  const n = db.calls.length;
  return () => db.calls.slice(n).filter(c => c.fn === 'update_field_photo');
}

async function twinHalf(page, R, db, viewer, text) {
  const settled = () => page.waitForFunction(() => DigitalTwin.debug().built && !DigitalTwin.debug().status.endsWith('…')
    && DigitalTwin.debug().photos && DigitalTwin.debug().photos.status === 'ok', null, { timeout: BUILD_TIMEOUT });
  const photos = () => page.evaluate(() => DigitalTwin.debug().photos);
  const frame = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

  // "In the twin", from the viewer, on the SW photo.
  await page.evaluate(id => FieldPhotos.openOne(id), R.sw.id);
  await page.click('#fp-v-details button:has-text("In the twin")');
  await page.waitForFunction(() => state.activeTab === 'stations' && MapTwin.active(), null, { timeout: LOAD_TIMEOUT });
  await settled();
  await frame();
  let P = await photos();
  const st = { lat: -27.555, lon: 152.275 };
  const xz = (lat, lon) => ({ x: (lon - st.lon) * 111320 * Math.cos(st.lat * Math.PI / 180), z: -(lat - st.lat) * 110574 });
  const pairAt = xz(R.ne.lat, R.ne.lon), exifAt = xz(R.gps.lat, R.gps.lon);
  ok('"In the twin" opens the twin on the photo\'s station, with the photos in its patch loaded',
    (await page.evaluate(() => DigitalTwin.debug().stationId)) === 'gatton' && P.status === 'ok' && P.count === 3, J({ status: P.status, count: P.count }));
  ok('two spots in the patch — the photo placed 400 m east is outside it', P.spots.length === 2, J(P.spots.map(s => ({ n: s.n, x: s.x, z: s.z }))));
  const [a, b] = P.spots;
  ok('the SW/NE spot stands 87 m west and 77 m north of the gauge, to 5 cm', a && a.n === 2 && near(a.x, pairAt.x, 0.05) && near(a.z, pairAt.z, 0.05),
    `${a && a.x.toFixed(2)}, ${a && a.z.toFixed(2)} vs ${pairAt.x.toFixed(2)}, ${pairAt.z.toFixed(2)}`);
  ok('…on the ground there', a && near(a.y, a.groundY, 1e-6), `${a && a.y} vs ${a && a.groundY}`);
  ok('…with a wedge each way the camera faced — 46° and 242° — and the camera turned to the first',
    a && J(a.wedges.map(w => +w.toFixed(3)).sort((p, q) => p - q)) === J([46, 242]) && near(a.yaw, 46, 1e-6), J(a && { w: a.wedges, yaw: a.yaw }));
  ok('the EXIF photo\'s spot, 25 m north-east, faces 118.25° and holds one', b && b.n === 1 && near(b.x, exifAt.x, 0.05) && near(b.z, exifAt.z, 0.05)
    && J(b.wedges.map(w => +w.toFixed(3))) === J([118.25]) && near(b.yaw, 118.25, 1e-6) && near(b.y, b.groundY, 1e-6), J(b));
  ok('no marker goes into the .glb', P.spots.every(s => s.exported === false));
  const cam = await page.evaluate(() => DigitalTwin.debug().camera);
  const look = (Math.atan2(a.x - cam.x, -(a.z - cam.z)) * 180 / Math.PI + 360) % 360;
  ok('the camera stands behind the SW photo\'s camera, looking the way it looked — 242°, not the spot\'s first 46°',
    near(look, 242, 1.5), `looking ${look.toFixed(1)}°`);
  ok('the line under the stage lists both spots — where from the gauge, to ten metres past a hundred — and all three photos',
    /Field photos \(3\): 2 120 m NW · 1 25 m NE · all 3/.test(await text('#twin-photos')), await text('#twin-photos'));

  // The badge, clicked where it is drawn.
  const hit = await page.evaluate(() => {
    const r = document.getElementById('twin-canvas').getBoundingClientRect();
    for (let dy = 0; dy <= 0.5; dy += 0.01) {
      for (const sy of [-1, 1]) {
        for (let dx = -0.2; dx <= 0.2; dx += 0.01) {
          const x = r.left + r.width * (0.5 + dx), y = r.top + r.height * (0.5 + sy * dy);
          if (DigitalTwin._photoAt(x, y) === 0) return { x, y };
        }
      }
    }
    return null;
  });
  ok('the marker is under the pointer somewhere near the middle of the stage', !!hit, J(hit));
  if (hit) {
    await page.mouse.click(hit.x, hit.y);
    const v = await viewer();
    ok('a click on it opens the carousel over its two photos, titled by where they were taken',
      v && v.ids.length === 2 && /Photos taken 120 m NW of Gatton — photo 1 of 2/.test(await text('#fp-v-title')), `${J(v)} ${await text('#fp-v-title')}`);
    await page.keyboard.press('Escape');
  }
  await page.click('#twin-photos .twin-photo >> nth=1');
  let v = await viewer();
  ok('a spot on the line under the stage opens it too', v && v.ids.length === 1 && v.ids[0] === R.gps.id, J(v));
  await page.keyboard.press('Escape');

  // Walked up to, in the POV.
  await page.evaluate(sp => DigitalTwin._pov({ px: sp.x + 1.2, pz: sp.z, yaw: -Math.PI / 2, pitch: 0 }), a);
  await frame();
  P = await photos();
  ok('standing 1.2 m from the spot in the POV: "📷 2 photos taken here — Enter to look"',
    P.near === 0 && P.prompt === '📷 2 photos taken here — Enter to look', J({ near: P.near, prompt: P.prompt }));
  await page.focus('#twin-canvas');
  await page.keyboard.press('Enter');
  v = await viewer();
  ok('Enter opens them', v && v.ids.length === 2, J(v));
  await page.keyboard.press('Escape');
  ok('Escape closes the viewer and leaves the visitor in the POV', !(await viewer()) && (await page.evaluate(() => DigitalTwin.debug().mode)) === 'walk');
  await page.evaluate(() => DigitalTwin._pov({ px: 40, pz: 40 }));
  await frame();
  P = await photos();
  ok('walked away, the prompt goes', P.near === -1 && P.prompt === null, J({ near: P.near, prompt: P.prompt }));
  await page.evaluate(() => DigitalTwin.toggleWalk());
}

// ── Run ──────────────────────────────────────────────────────────────────────
try {
  nodeHalf();
  await browserHalf();
} catch (err) {
  failures++;
  console.log(`\nThe photos check could not finish:\n${err.stack || err}`);
}
console.log(`\n  ${passes + failures} assertion(s).`);
if (failures) {
  console.log(`\nFAIL — ${failures} of ${passes + failures}.`);
  process.exitCode = 1;
} else {
  console.log('\nPASS — a photo in, placed where it was taken, and shown there: on the tab, the map and the twin.');
}
