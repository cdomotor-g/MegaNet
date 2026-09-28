// The Field Photos tab's Review panel, and reading equipment off photos
// (photo-review.js, photo-equipment.js, PhotoMeta.ocrLabels, the outcome log
// in field-photos.js, the station card's Equipment section; 0036).
//
// Why this is a check of its own. Everything here is quiet when it is wrong.
// A label parser that reads CR3OO as nothing, or a battery's B2106 as 82106,
// throws nothing; an approval that sends the whole suggestion back as a
// "correction" writes the right register row and a record claiming the
// administrator changed four fields they never touched; a panel that enables
// Approve for an editor who is not an administrator looks exactly as right as
// one that does not, until the database says no; and an outcome log that is
// never written leaves a Review panel that simply shows nothing, forever.
//
// Two halves.
//
//   1. Under Node: PhotoEquipment.parse — the file a sync or an agent will
//      require() — against what OCR makes of the labels this network fits:
//      clean, garbled (lookalike letters in model codes and serials, `S|N`,
//      `Ser. No.`), with and without the make, pooled over several readings
//      (a majority serial and its rival, two units kept two, a make in one
//      quarter and the model in another made one), and against text that is
//      not a label at all (a warning sign, a Solocator overlay), which must
//      come back empty. Then PhotoMeta's label plan and reader against a fake
//      host: the whole frame and four overlapping quarters at the sizes it
//      promises, the passes in order, and the bound on them.
//
//   2. The app in Chromium against a fake project (lib/photo-project.mjs) and
//      the real OCR engine: the Review panel's three lists; an editor who is
//      not an administrator — the lists, the disabled buttons and the sentence
//      why, and a forced decision refused by the database in its words; the
//      filters asking the database; an upload whose outcome is logged; 🔎 in
//      the viewer reading a drawn equipment label and proposing what it says;
//      an administrator correcting a serial and approving (the patch is the
//      correction and nothing else), approving untouched (no patch), choosing
//      "alongside" (`replaces: null`), rejecting with a note; a station's
//      photos scanned in bulk; the box that reads labels after an upload; the
//      sync panel's Google Drive block; and the station card's Equipment
//      section.
//
// What is *not* here: 0036's rules — tools/check_photo_review.sql holds them
// against a real Postgres. The fake records what the browser sent.
//
// Run:  npm run photoreview
//       npm run photoreview -- -v    also print what passed

import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { auditHandlers } from './lib/controls.mjs';
import { storageStore, installStorage } from './lib/storage.mjs';
import { seedRows, attachmentsSql, inspectionsSql } from './lib/migration.mjs';
import { photoProject, installPhotoProject, serveObjects } from './lib/photo-project.mjs';
import { repo } from './lib/paths.mjs';
import { tiff, gpsEntries, jpegWith } from './lib/exif.mjs';

const require = createRequire(import.meta.url);
const PhotoEquipment = require(repo('photo-equipment.js'));
const PhotoMeta = require(repo('photo-meta.js'));

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const OCR_TIMEOUT = Number(process.env.PHOTOS_OCR_TIMEOUT || 300_000);

let failures = 0, passes = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passes++; if (VERBOSE) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};
const section = t => console.log(`\n${t}\n`);
const J = v => JSON.stringify(v);

// ═════════════════════════════════════════════════════════════════════════════
// 1. Under Node
// ═════════════════════════════════════════════════════════════════════════════

async function nodeHalf() {
  section('What a label says — PhotoEquipment.parse, on what OCR makes of real ones');

  const one = t => PhotoEquipment.parse(t);
  const is = (c, key, make, model, serial) => !!c && c.equipment_key === key && c.make === make && c.model === model && c.serial_no === serial;
  const brief = cs => J(cs.map(c => [c.equipment_key, c.make, c.model, c.serial_no, c.confidence]));

  const cases = [
    ['a Campbell CR300\'s label, read cleanly',
     'CAMPBELL SCIENTIFIC, INC.\nLOGAN UTAH USA\nMODEL: CR300-RF407\nS/N: 12345\nMADE IN USA',
     ['logger', 'Campbell Scientific', 'CR300', '12345'], c => c.confidence >= 0.9],
    ['…read badly — i for I, O for 0, S|N for S/N, S for 5 — and put right, trusted a little less',
     'CAMPBELL SClENTlFIC\nCR3OO\nS|N 1234S',
     ['logger', 'Campbell Scientific', 'CR300', '12345'], c => c.confidence < 0.9 && c.confidence >= 0.7],
    ['…with no make in view: CR3OO keeps three of its own characters, and stands',
     'CR3OO\nSN: 12345', ['logger', 'Campbell Scientific', 'CR300', '12345'], c => c.confidence < 0.75],
    ['an ELPRO ERRTS ERT-A2 — an ALERT2 radio, not a modem', 'ELPRO TECHNOLOGIES\nERRTS ERT-A2\nSerial No. 20231145\nFW 2.4',
     ['ert_a2', 'ELPRO', 'ERT-A2', '20231145'], c => c.confidence >= 0.9],
    ['an ELPRO 905U read as 9O5U, its serial with an O in it', 'elpro 9O5U-1\nS/N: 1O2345', ['modem', 'ELPRO', '905U', '102345'], () => true],
    ['a Beam modem: its RST number, and its IMEI — fifteen digits, an O put back to 0',
     'BEAM COMMUNICATIONS\nIRIDIUM SBD TRANSCEIVER RST100\nIMEI: 30023401O123450', ['modem', 'Beam', 'RST100', '300234010123450'], () => true],
    ['…a Beam label with no RST number is its Iridium SBD modem', 'BEAM\nIRIDIUM SBD\nIMEI: 300234010123450',
     ['modem', 'Beam', 'Iridium SBD', '300234010123450'], () => true],
    ['an IMEI beside nothing but IRIDIUM is a modem of no known make, at low confidence', 'IRIDIUM SBD\nIMEI 300234010123450',
     ['modem', '', '', '300234010123450'], c => c.confidence < 0.5],
    ['a Kisters HS40 Compact bubbler', 'KISTERS\nHS40 COMPACT BUBBLER\nSN: 21150012', ['bubble_unit', 'Kisters', 'HS40 Compact', '21150012'], () => true],
    ['a Victron SmartSolar, its rating and its HQ serial', 'victron energy\nSmartSolar Charge Controller\nMPPT 100/30\nSerial number HQ2239ABCDE\n12/24V-30A',
     ['solar_regulator', 'Victron Energy', 'SmartSolar MPPT 100/30', 'HQ2239ABCDE'], c => c.confidence >= 0.9],
    ['…a Victron serial needs no label, and an O in its digits is put back', 'VICTRON ENERGY BLUE POWER\nSMARTSOLAR MPPT 75/15\nHQ2O41XYZ12',
     ['solar_regulator', 'Victron Energy', 'SmartSolar MPPT 75/15', 'HQ2041XYZ12'], () => true],
    ['a Hydrological Services TB3, and its tip', 'HYDROLOGICAL SERVICES PTY LTD\nTB3 0.2MM TIPPING BUCKET RAIN GAUGE\nS/N 07-1234',
     ['tbrg', 'Hydrological Services', 'TB3 0.2 mm', '07-1234'], () => true],
    ['a tipping bucket of no make — the kind from the words, at low confidence', 'TIPPING BUCKET RAIN GAUGE\nSERIAL NO: 99-0123',
     ['tbrg', '', '', '99-0123'], c => c.confidence <= 0.4],
    ['a Druck PTX 1830 pressure transmitter', 'GE DRUCK PTX 1830\nS/N 3412345\n0-10 M H2O', ['pressure_transmitter', 'Druck', 'PTX 1830', '3412345'], () => true],
    ['a VEGAPULS C 21 radar', 'VEGA\nVEGAPULS C 21\nSN 45678901', ['water_level_sensor', 'VEGA', 'VEGAPULS C 21', '45678901'], () => true],
    ['an OTT PLS-C, "Ser. No." and all', 'OTT HYDROMET\nPLS-C\nSer. No. 12345', ['pressure_transmitter', 'OTT HydroMet', 'PLS-C', '12345'], () => true],
    ['a WaterLOG H-number filed by what the label says it is', 'WATERLOG H-3553T RADAR WATER LEVEL SENSOR\nS/N 6621',
     ['water_level_sensor', 'WaterLOG', 'H-3553T', '6621'], () => true],
    ['a battery\'s serial starting with a B keeps its B — only a letter between digits is a misread digit',
     'FULLRIVER DC105-12\n12V 105AH\nSN: B2106-0042', ['power_supply', '', '', 'B2106-0042'], () => true],
  ];
  for (const [name, text, want, extra] of cases) {
    const got = one(text);
    ok(name, got.length === 1 && is(got[0], ...want) && extra(got[0]), brief(got));
  }

  const nothing = [
    ['a warning sign', 'KEEP OUT\nDANGER HIGH VOLTAGE\nPROPERTY OF BUREAU OF METEOROLOGY\nIN AN EMERGENCY CALL 000'],
    ['a Solocator overlay', '242°SW (T) -27.554294°, 152.274116° ±4m ▲ 134m (HAE)\nBoM-FWIN\nGatton\n2026-06-24, 12:26:08 AEST'],
    ['bark, as OCR reads it', 'ClRO0 ll SOLl\n/// ,., ~ l1l'],
    ['a code made mostly of lookalikes, with no make beside it (IOSU is a 105U only on an ELPRO label)', 'IOSU\nS/N 12345'],
    ['a station sign with a number that is not a serial', 'BUREAU OF METEOROLOGY\nSTATION 040444\nGATTON AL'],
  ];
  for (const [name, text] of nothing) {
    const got = one(text);
    ok(`nothing from ${name}`, got.length === 0, brief(got));
  }
  ok('…and the same lookalikes on an ELPRO label are a 105U', is(one('ELPRO\nIOSU\nS/N 12345')[0], 'modem', 'ELPRO', '105U', '12345'),
    brief(one('ELPRO\nIOSU\nS/N 12345')));

  section('Several readings, pooled');
  const pooled = PhotoEquipment.parse([
    { region: 'whole', text: 'CAMPBELL SCIENTIFIC\nCR300\nS/N: 12345' },
    { region: 'top left', text: 'CR300 S/N 12346' },
    { region: 'top right', text: 'CR300\nSN 12345' },
    { region: 'bottom left', text: 'CAMPBELL SCIENTIFIC' },
  ]);
  ok('one unit read three times with a digit disagreeing: one candidate, the majority\'s serial, the rival named, counted in three readings',
    pooled.length === 1 && pooled[0].serial_no === '12345' && pooled[0].votes === 3 && /also read as 12346/.test(pooled[0].evidence)
      && /in 3 of 4 readings/.test(pooled[0].evidence) && pooled[0].confidence >= 0.9, J(pooled));
  const two = PhotoEquipment.parse(['VICTRON ENERGY SMARTSOLAR MPPT 100/30 SN HQ2239ABCDE', 'CAMPBELL SCIENTIFIC CR300 S/N 12345']);
  ok('two different units in two readings stay two', two.length === 2 && two.some(c => c.model === 'CR300') && two.some(c => c.serial_no === 'HQ2239ABCDE'), brief(two));
  const split = PhotoEquipment.parse(['VICTRON ENERGY\nSN HQ2239ABCDE', 'SMARTSOLAR MPPT 100/30\nHQ2239ABCDE']);
  ok('a make read in one quarter and the model in another are one unit, with both',
    split.length === 1 && is(split[0], 'solar_regulator', 'Victron Energy', 'SmartSolar MPPT 100/30', 'HQ2239ABCDE'), brief(split));
  const panels = PhotoEquipment.parse(['SOLAR MODULE 80W\nS/N SP-0001', 'SOLAR MODULE 80W\nS/N SP-7788']);
  ok('two of one kind with serials far apart are two units, not a misreading', panels.length === 2, brief(panels));
  ok('a floor on confidence drops what is not worth a look', PhotoEquipment.parse('IRIDIUM SBD\nIMEI 300234010123450', { minConfidence: 0.5 }).length === 0);

  section('Reading labels — the plan, and the passes (PhotoMeta.readLabels)');
  const plan = PhotoMeta.labelPlan(4032, 3024);
  const whole = plan[0], quarters = plan.slice(1);
  ok('the whole frame, long edge 2,400 px, and four quarters', plan.length === 5 && whole.name === 'whole' && whole.outW === 2400
    && J(quarters.map(q => q.name)) === J(['top left', 'top right', 'bottom left', 'bottom right']), J(plan.map(p => [p.name, p.outW, p.outH])));
  ok('…the quarters overlapping, together covering the frame, each read at the photo\'s own resolution',
    quarters[0].x === 0 && quarters[1].x < 2016 && quarters[1].x + quarters[1].w === 4032 && quarters[2].y < 1512
      && quarters[3].y + quarters[3].h === 3024 && quarters.every(q => q.outW === q.w), J(quarters));
  const small = PhotoMeta.labelPlan(1200, 900);
  ok('a small photo\'s quarters are enlarged to at least 1,400 px wide, and never past three times',
    small.slice(1).every(q => q.outW >= 1400 && q.outW <= q.w * 3), J(small.map(p => [p.name, p.w, p.outW])));
  const huge = PhotoMeta.labelPlan(8064, 6048);
  ok('a 48-megapixel photo\'s quarters are read at 2,600 px, not 4,677', huge.slice(1).every(q => q.outW === 2600), J(huge.map(p => p.outW)));

  const asked = [];
  const host = {
    width: 1600, height: 1200,
    pixels: r => ({ data: new Uint8ClampedArray(r.outW * r.outH * 4).fill(200), width: r.outW, height: r.outH }),
    recognize: (v, psm) => { asked.push([v.variant, psm, v.width]); return `pass ${asked.length}`; },
  };
  const passesSeen = [];
  const got = await PhotoMeta.readLabels(host, { onPass: (n, total) => passesSeen.push(`${n}/${total}`) });
  ok('six passes by default: sparse text over the whole frame and each quarter, then the whole frame as a page',
    got.passes === 6 && J(asked.map(a => a[1])) === J(['11', '11', '11', '11', '11', '3']) && asked.every(a => a[0] === 'grey')
      && J(got.texts.map(t => t.region)) === J(['whole', 'top left', 'top right', 'bottom left', 'bottom right', 'whole'])
      && J(passesSeen) === J(['1/6', '2/6', '3/6', '4/6', '5/6', '6/6']), J({ asked, passesSeen }));
  asked.length = 0;
  const two2 = await PhotoMeta.readLabels(host, { maxPasses: 2 });
  ok('…and never more than it is allowed', two2.passes === 2 && asked.length === 2, J(asked));
  asked.length = 0;
  const lots = await PhotoMeta.readLabels(host, { maxPasses: 99 });
  ok('…nor more than there are passes to make', lots.passes === 6, String(lots.passes));
  const g = PhotoMeta.greyStretch({ data: new Uint8ClampedArray([10, 10, 10, 255, 200, 200, 200, 255, 105, 105, 105, 255]), width: 3, height: 1 });
  ok('grey, stretched from the darkest to the lightest', g.gray[0] === 0 && g.gray[1] === 255 && g.gray[2] > 100 && g.gray[2] < 160, J([...g.gray]));
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. The app, in Chromium
// ═════════════════════════════════════════════════════════════════════════════

const NE = fs.readFileSync(repo('test', 'fixtures', 'photos', 'solocator-gatton-ne.jpg'));
const exifAt = (lat, lon, local) => tiff({
  ifd0: [[0x010f, 2, 'Apple'], [0x0110, 2, 'iPhone 15'], [0x0112, 3, [1]]],
  exif: [[0x9003, 2, local], [0x9011, 2, '+10:00']],
  gps: gpsEntries({ lat, lon, alt: 96, heading: 118, accuracy: 4 }),
});
const iso = (d, h) => new Date(Date.UTC(2026, 5, d, h, 0, 0)).toISOString();

// Rows the fake starts with: two photos filed under Gatton — one of an
// equipment label, drawn below, and one of a paddock — eight log rows from
// every way in, three suggestions waiting and one decided, and Gatton's
// register as it stands: a CR1000X logger and two solar panels.
function seed(db) {
  const photo = (n, title) => ({
    id: `00000000-0000-4000-8000-00000000c00${n}`, storage_bucket: 'field-photos',
    storage_path: `photo/00000000-0000-4000-8000-00000000c00${n}.jpg`, thumb_path: `photo/00000000-0000-4000-8000-00000000c00${n}.thumb.jpg`,
    content_type: 'image/jpeg', byte_size: 120000, sha256: crypto.createHash('sha256').update(title).digest('hex'),
    width: 1200, height: 900, title, caption: '', taken_at: iso(20, 1), taken_local: '2026-06-20T11:00:00', taken_source: 'exif',
    lat: -27.5549, lon: 152.2752, placement: 'exif', accuracy_m: 4, altitude_m: null, altitude_ref: null, heading_deg: 90, heading_ref: 'T',
    pitch_deg: null, fov_deg: null, station_id: 'gatton', station_auto: true, meta: {}, origin: 'upload', origin_ref: null,
    uploaded_by: 'crew@example.test', created_at: iso(20, 2), updated_at: iso(20, 2), updated_by: null, deleted_at: null,
  });
  db.photos.push(photo(1, 'cabinet-logger.jpg'), photo(2, 'paddock.jpg'));
  const up = (n, h, fields) => Object.assign({ id: `00000000-0000-4000-a000-0000000000${String(n).padStart(2, '0')}`,
    attempted_at: iso(21, h), origin: 'upload', batch_id: '00000000-0000-4000-b000-000000000001', archive_name: null,
    sha256: null, byte_size: 150000, reason: '', photo_id: null, station_id: null, uploaded_by: 'crew@example.test' }, fields);
  db.uploads.push(
    up(1, 1, { file_name: 'cabinet-logger.jpg', outcome: 'imported', photo_id: db.photos[0].id, station_id: 'gatton' }),
    up(2, 1, { file_name: 'paddock.jpg', outcome: 'imported', photo_id: db.photos[1].id, station_id: 'gatton' }),
    up(3, 1, { file_name: 'IMG_0007.JPG', archive_name: 'run-3.zip', outcome: 'unplaced', photo_id: db.photos[1].id }),
    up(4, 2, { file_name: 'IMG_0008.JPG', archive_name: 'run-3.zip', outcome: 'refused', reason: 'Refused — it unpacks to more than the zip says it holds.' }),
    up(5, 3, { file_name: 'IMG_0009.JPG', outcome: 'failed', reason: 'HTTP 503' }),
    up(6, 4, { file_name: 'DSC_0101.JPG', origin: 'dropbox', outcome: 'duplicate', reason: 'the same photo is already in MegaNet', photo_id: db.photos[0].id, uploaded_by: 'Dropbox — Flood Crew' }),
    up(7, 5, { file_name: 'notes.txt', origin: 'gdrive', outcome: 'skipped', reason: 'not a photo', uploaded_by: 'Google Drive — Flood Crew' }),
    up(8, 6, { file_name: 'IMG_0010.JPG', origin: 'gdrive', outcome: 'failed', reason: 'the download stopped', uploaded_by: 'Google Drive — Flood Crew' }),
  );
  const sug = (n, fields) => Object.assign({ id: `00000000-0000-4000-e000-00000000000${n}`, station_id: 'gatton', photo_id: null,
    make: '', model: '', serial_no: '', evidence: '', confidence: null, proposed_by: 'ocr', created_by: 'crew@example.test',
    created_at: iso(22, n), status: 'pending', decided_by: null, decided_at: null, decision_note: null, decision_patch: null,
    equipment_id: null }, fields);
  db.suggestions.push(
    sug(1, { photo_id: db.photos[0].id, equipment_key: 'logger', make: 'Campbell Scientific', model: 'CR300', serial_no: '12346',
             evidence: 'CAMPBELL SCIENTIFIC / CR300 / S/N: 12346', confidence: 0.8 }),
    sug(2, { equipment_key: 'modem', make: 'Beam', model: 'Iridium SBD', serial_no: '300234010123450',
             evidence: 'The 2025-11 inspection lists IMEI 300234010123450', confidence: 0.6, proposed_by: 'agent:history-reader' }),
    sug(3, { photo_id: db.photos[1].id, equipment_key: 'solar_panel', model: '80 W', serial_no: 'SP-3', evidence: 'SOLAR MODULE 80W / S/N SP-3', confidence: 0.45 }),
    sug(4, { equipment_key: 'antenna', make: 'RFI', serial_no: 'ANT-9', status: 'rejected', decided_by: 'admin@example.test',
             decided_at: iso(22, 9), decision_note: 'that is the neighbour\'s mast' }),
  );
  const unit = (n, fields) => Object.assign({ id: `00000000-0000-4000-f000-00000000000${n}`, station_id: 'gatton', make: '', model: '',
    serial_no: '', note: '', source: 'inspection', photo_id: null, suggestion_id: null, created_at: iso(1, n), updated_at: iso(1, n),
    retired_at: null, replaced_by: null }, fields);
  db.equipment.push(
    unit(1, { equipment_key: 'logger', make: 'Campbell Scientific', model: 'CR1000X', serial_no: '9999' }),
    unit(2, { equipment_key: 'solar_panel', model: '80 W', serial_no: 'SP-1' }),
    unit(3, { equipment_key: 'solar_panel', model: '80 W', serial_no: 'SP-2' }),
  );
  db.sync.push(
    { source: 'dropbox', folder: '/Field photos', account: 'Flood Crew', last_run_at: new Date(Date.now() - 5 * 60000).toISOString(),
      last_ok_at: new Date(Date.now() - 5 * 60000).toISOString(), last_error: null, runs: 12, seen: 3, imported: 2, unplaced: 1, skipped: 0, failed: 0 },
    { source: 'gdrive', folder: 'Field photos', account: 'meganet-sync@example.iam.gserviceaccount.com',
      last_run_at: new Date(Date.now() - 12 * 60000).toISOString(), last_ok_at: new Date(Date.now() - 12 * 60000).toISOString(),
      last_error: null, runs: 3, seen: 4, imported: 2, unplaced: 0, skipped: 1, failed: 1 },
  );
}

// An equipment label, drawn: a dark cabinet, a light plate, black print.
async function labelJpeg(page, lines) {
  const b64 = await page.evaluate(async lines => {
    const c = document.createElement('canvas');
    c.width = 1200; c.height = 900;
    const x = c.getContext('2d');
    x.fillStyle = '#3b4148'; x.fillRect(0, 0, 1200, 900);
    x.fillStyle = '#f2f2ee'; x.fillRect(220, 220, 760, 420);
    x.fillStyle = '#111111'; x.textBaseline = 'top';
    lines.forEach((t, i) => { x.font = `bold ${i === 1 ? 64 : 46}px sans-serif`; x.fillText(t, 260, 260 + i * 110); });
    const b = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
    const bytes = new Uint8Array(await b.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }, lines);
  return Buffer.from(b64, 'base64');
}
async function paddockJpeg(page) {
  const b64 = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 1200; c.height = 900;
    const x = c.getContext('2d');
    x.fillStyle = '#9cc2e6'; x.fillRect(0, 0, 1200, 500);
    x.fillStyle = '#6b7f3a'; x.fillRect(0, 500, 1200, 400);
    const b = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    const bytes = new Uint8Array(await b.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  });
  return Buffer.from(b64, 'base64');
}

async function browserHalf() {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];
  const store = storageStore();
  const db = photoProject({
    types: seedRows(attachmentsSql(), 'attachment_type'),
    kinds: seedRows(inspectionsSql(), 'equipment_kind'),
    user: 'crew@example.test',
  });
  seed(db);
  const objects = {};

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await applyNetworkPolicy(page, server.origin);
    await installPhotoProject(page, db, store);
    await installStorage(page, store);
    await serveObjects(page, store, objects);
    page.on('pageerror', e => errors.push(e.stack || e.message));
    page.on('console', m => {
      if (m.type() !== 'error') return;
      const t = m.text();
      if (/^Failed to load resource|ERR_BLOCKED_BY_CLIENT|ERR_FAILED/i.test(t)) return;
      // No exception for the OCR engine: the label reader sends Tesseract's
      // layout narration ("Estimating resolution as 812") to the engine's own
      // /dev/null (PhotoMeta.ocrLabels), so any of it here is a regression.
      errors.push(t);
    });

    await page.goto(server.origin + '/index.html', { waitUntil: 'load', timeout: LOAD_TIMEOUT });
    await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations), null, { timeout: LOAD_TIMEOUT });
    await page.evaluate(() => { window.__opened = []; window.open = u => { window.__opened.push(String(u)); return null; }; });

    // The two photos' bytes, as the bucket would hand them back.
    objects[db.photos[0].storage_path] = await labelJpeg(page, ['CAMPBELL SCIENTIFIC', 'CR300', 'S/N: 12345']);
    objects[db.photos[1].storage_path] = await paddockJpeg(page);

    const text = sel => page.evaluate(s => { const el = document.querySelector(s); return el ? el.textContent.replace(/\s+/g, ' ').trim() : null; }, sel);
    const review = () => page.evaluate(() => PhotoReview._state());
    const calls = fn => db.calls.filter(c => c.fn === fn);
    const loaded = () => page.waitForFunction(() => { const r = state.photos.review; return r && r.loaded && !r.loading; }, null, { timeout: LOAD_TIMEOUT });
    const settled = () => page.waitForFunction(() => !state.photos.reading && !state.photos.uploading
      && state.photos.queue.every(i => !['waiting', 'reading', 'ocr', 'queued', 'uploading'].includes(i.status)), null, { timeout: OCR_TIMEOUT });
    const scanned = () => page.waitForFunction(() => { const r = state.photos.review; return r && r.scan && !r.scan.running; }, null, { timeout: OCR_TIMEOUT });

    // ── Signed out ───────────────────────────────────────────────────────────
    section('Signed out');
    await page.evaluate(() => switchTab('photos'));
    ok('signed out, the Review panel says to sign in and asks for nothing',
      /Sign in to see what came in/.test(await text('#fp-review')) && !db.selects.some(s => s.table === 'field_photo_upload'), await text('#fp-review'));

    // ── An editor who is not an administrator ────────────────────────────────
    section('An editor who is not an administrator');
    await page.evaluate(() => { dbSetAccessToken('test-token'); FieldPhotos.authChanged(); });
    await loaded();
    let r = await review();
    ok('the database is asked whether this is an administrator, and says no', calls('is_admin').length >= 1 && r.admin === false, J(r));
    ok('"From this browser" says nothing has been added yet', /Nothing has been added in this browser/.test(await text('#pr-queue')), await text('#pr-queue'));
    const upRows = await page.$$eval('#pr-uploads tbody tr', rs => rs.length);
    ok('recent uploads: all eight, newest first, from every way in', upRows === 8
      && /^IMG_0010\.JPG/.test((await text('#pr-uploads tbody tr:first-child td:nth-child(3)')) || '')
      && /Google Drive/.test(await text('#pr-uploads tbody tr:first-child')), `${upRows} rows; ${await text('#pr-uploads tbody tr:first-child')}`);
    ok('…counted per outcome over them', /All 8/.test(await text('#pr-uploads .pr-filters')) && /Imported 2/.test(await text('#pr-uploads .pr-filters'))
      && /Failed 2/.test(await text('#pr-uploads .pr-filters')) && /Already in MegaNet 1/.test(await text('#pr-uploads .pr-filters')), await text('#pr-uploads .pr-filters'));
    ok('…each saying the zip it came out of, and why it was refused',
      /IMG_0008\.JPG from run-3\.zip Refused Refused — it unpacks to more than the zip says it holds\./.test(await text('#pr-uploads tbody')), await text('#pr-uploads tbody'));
    ok('…with a way to the photo a file became', (await page.$$eval('#pr-uploads button', bs => bs.filter(b => b.textContent === 'Show it').length)) === 4);
    const cards = await page.$$eval('.pr-sug', ls => ls.length);
    ok('three suggestions waiting, the count in the heading', cards === 3 && /3 waiting/.test(await text('#pr-eq-h')), `${cards} — ${await text('#pr-eq-h')}`);
    const s1 = await text('#pr-sug-00000000-0000-4000-e000-000000000001');
    ok('a suggestion shows what it was read from, who by, and what the register says now beside it',
      /Logger at Gatton/.test(s1) && /read off the photo for crew@example\.test/.test(s1) && /80% sure/.test(s1)
        && /CAMPBELL SCIENTIFIC \/ CR300 \/ S\/N: 12346/.test(s1) && /On the register now: .*Campbell Scientific CR1000X · s\/n 9999/.test(s1), s1);
    ok('an agent\'s suggestion says which agent', /agent history-reader/.test(await text('#pr-sug-00000000-0000-4000-e000-000000000002')));
    const locked = await page.evaluate(() => [...document.querySelectorAll('.pr-actions button')].map(b => ({ disabled: b.disabled, why: b.getAttribute('aria-describedby') })));
    ok('Approve and Reject are there, and disabled, pointing at the sentence that says why',
      locked.length === 6 && locked.every(b => b.disabled && b.why === 'pr-why') && !(await page.$('.pr-sug input')), J(locked));
    ok('…which says what an administrator is, and where to read how one is made',
      /is for an administrator — an editor the owner has marked as one \(how\)/.test(await text('#pr-why'))
        && /#administrators$/.test(await page.getAttribute('#pr-why a', 'href') || ''), await text('#pr-why'));
    await page.evaluate(() => PhotoReview.approve('00000000-0000-4000-e000-000000000001'));
    await page.waitForFunction(() => /Not approved/.test((document.getElementById('pr-msg-00000000-0000-4000-e000-000000000001') || {}).textContent || ''), null, { timeout: LOAD_TIMEOUT });
    ok('a decision forced past the disabled button is refused by the database, in its words, on the card',
      /Not approved — only an administrator may approve or reject equipment suggestions/.test(await text('#pr-msg-00000000-0000-4000-e000-000000000001'))
        && db.suggestions[0].status === 'pending', await text('#pr-msg-00000000-0000-4000-e000-000000000001'));

    // The filters ask the database.
    await page.click('#pr-uploads button:has-text("Failed")');
    await page.waitForFunction(() => document.querySelectorAll('#pr-uploads tbody tr').length === 2, null, { timeout: LOAD_TIMEOUT });
    ok('filtered to Failed: the database is asked for the failures, and only they are listed',
      db.selects.some(s => s.table === 'field_photo_upload' && /outcome=eq\.failed/.test(s.search))
        && await page.getAttribute('#pr-uploads button:has-text("Failed")', 'aria-pressed') === 'true', await text('#pr-up-lead'));
    await page.selectOption('#pr-uploads select', 'gdrive');
    await page.waitForFunction(() => document.querySelectorAll('#pr-uploads tbody tr').length === 1, null, { timeout: LOAD_TIMEOUT });
    ok('…and by way in, together: the one Google Drive failure', db.selects.some(s => /outcome=eq\.failed/.test(s.search) && /origin=eq\.gdrive/.test(s.search))
      && /IMG_0010\.JPG/.test(await text('#pr-uploads tbody')), await text('#pr-uploads tbody'));
    await page.click('#pr-uploads button:has-text("Failed")');
    await page.selectOption('#pr-uploads select', '');
    await page.waitForFunction(() => document.querySelectorAll('#pr-uploads tbody tr').length === 8, null, { timeout: LOAD_TIMEOUT });
    ok('…and cleared, all eight again', true);
    let audit = await auditHandlers(page);
    ok(`the panel: all ${audit.checked} handler(s) resolve`, audit.unresolved.length === 0, audit.unresolved.map(u => u.path).join(', '));

    ok('the sync panel draws every linked folder: Dropbox, and Google Drive the same way, with a way to its setup',
      /Working — last ran 5 min ago, reading Flood Crew's Dropbox \(\/Field photos\)\./.test(await text('#fp-sync-dropbox'))
        && /Working — last ran 12 min ago, reading meganet-sync@example\.iam\.gserviceaccount\.com's Google Drive \(Field photos\)\./.test(await text('#fp-sync-gdrive'))
        && /4 new files seen, 2 imported, 1 skipped, 1 failed/.test(await text('#fp-sync-gdrive'))
        && /#linking-a-google-drive-folder$/.test(await page.getAttribute('#fp-sync-gdrive a', 'href') || '')
        && !(await page.$('#fp-sync-gdrive #fp-connect')) && !!(await page.$('#fp-sync-dropbox #fp-connect')),
      `${await text('#fp-sync-dropbox')} | ${await text('#fp-sync-gdrive')}`);

    // ── An upload, and its outcome logged ────────────────────────────────────
    section('An upload, and what became of it');
    const IMG = jpegWith(NE, { tiff: exifAt(-27.55484, 152.27518, '2026:06:25 09:15:00') });
    await page.setInputFiles('#fp-files', [{ name: 'IMG_5001.jpg', mimeType: 'image/jpeg', buffer: IMG }]);
    await settled();
    await page.click('#fp-upload');
    await settled();
    await page.waitForFunction(() => document.querySelectorAll('#pr-uploads tbody tr').length === 9, null, { timeout: LOAD_TIMEOUT });
    const logged = calls('log_field_photo_upload');
    const added = db.photos.find(p => p.title === 'IMG_5001.jpg');
    const row0 = logged.length === 1 && logged[0].body.p_rows[0];
    ok('when the upload finished, one row was logged: imported, the photo it became, its station, its hash and size, one batch',
      logged.length === 1 && logged[0].body.p_rows.length === 1 && row0.outcome === 'imported' && row0.origin === 'upload'
        && row0.file_name === 'IMG_5001.jpg' && row0.photo_id === added.id && row0.station_id === 'gatton'
        && row0.sha256 === crypto.createHash('sha256').update(IMG).digest('hex') && row0.byte_size === IMG.length
        && /^[0-9a-f-]{36}$/.test(row0.batch_id) && row0.reason === '' && !('uploaded_by' in row0) && !('attempted_at' in row0),
      J(logged.map(c => c.body)));
    // "From this browser" follows the queue at most four times a second, and
    // against this fake the whole of add, read, upload and log can be quicker.
    await page.waitForFunction(() => /1 file: 1 uploaded/.test((document.getElementById('pr-queue') || {}).textContent || ''), null, { timeout: LOAD_TIMEOUT });
    ok('…and the panel shows it at the top of the list, and in "From this browser"',
      /IMG_5001\.jpg/.test(await text('#pr-uploads tbody tr:first-child')) && /1 file: 1 uploaded/.test(await text('#pr-queue')),
      `${await text('#pr-uploads tbody tr:first-child')} | ${await text('#pr-queue')}`);
    await page.click('button:has-text("Clear finished")');

    // ── 🔎 in the viewer ─────────────────────────────────────────────────────
    section('🔎 Read equipment labels, in the viewer — the real OCR engine, on a drawn label');
    await page.evaluate(id => FieldPhotos.openOne(id), db.photos[0].id);
    await page.waitForFunction(() => !!document.querySelector('#fp-v-details button[title^="Read the makes"]'), null, { timeout: LOAD_TIMEOUT });
    const n0 = calls('propose_equipment').length;
    await page.click('#fp-v-details button:has-text("Read equipment labels")');
    await scanned();
    const proposed = calls('propose_equipment').slice(n0).map(c => c.body.p);
    const cr = proposed.find(p => p.model === 'CR300');
    ok('the label is read, and what it says proposed: a Campbell Scientific CR300 logger, serial 12345, as the OCR\'s reading of this photo',
      cr && cr.photo_id === db.photos[0].id && cr.equipment_key === 'logger' && cr.make === 'Campbell Scientific' && cr.serial_no === '12345'
        && cr.proposed_by === 'ocr' && cr.confidence >= 0.6 && /CR300/.test(cr.evidence) && !('station_id' in cr), J(proposed));
    ok('…and nothing else off a label that says nothing else', proposed.length === 1, J(proposed));
    await page.waitForFunction(() => /^Read the labels/.test((document.getElementById('fp-v-msg') || {}).textContent || ''), null, { timeout: LOAD_TIMEOUT });
    const vmsg = await text('#fp-v-msg');
    ok('the viewer says what it did', /^Read the labels on this photo: 1 suggestion made\.$/.test(vmsg || ''), vmsg);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelectorAll('.pr-sug').length === 4, null, { timeout: LOAD_TIMEOUT });
    ok('the new suggestion is in the list, waiting', /4 waiting/.test(await text('#pr-eq-h')));

    // ── An administrator ─────────────────────────────────────────────────────
    section('An administrator');
    db.admin = true;
    await page.evaluate(() => PhotoReview.reload());
    await loaded();
    r = await review();
    ok('asked again, the database says yes — the buttons are live and the values editable',
      r.admin === true && (await page.$$eval('.pr-actions button', bs => bs.every(b => !b.disabled))) && !!(await page.$('.pr-sug input'))
        && /You are an administrator/.test(await text('#pr-intro')), await text('#pr-intro'));

    // A serial the OCR misread, put right, and approved.
    const S1 = '#pr-sug-00000000-0000-4000-e000-000000000001';
    await page.fill(`${S1} label:has-text("Serial number") input`, '12345');
    await page.fill(`${S1} label:has-text("Note") input`, 'the label says 12345');
    const d0 = calls('decide_equipment_suggestion').length;
    await page.click(`${S1} button:has-text("Approve")`);
    await page.waitForFunction(() => !document.getElementById('pr-sug-00000000-0000-4000-e000-000000000001'), null, { timeout: LOAD_TIMEOUT });
    let dec = calls('decide_equipment_suggestion')[d0];
    ok('approved with a correction: exactly the serial that was changed is sent, with the note',
      dec && J(dec.body) === J({ p_id: '00000000-0000-4000-e000-000000000001', p_decision: 'approve', p_note: 'the label says 12345', p_patch: { serial_no: '12345' } }),
      J(dec && dec.body));
    ok('…it leaves the list for the decided ones, and the panel says what happened',
      (await review()).decided.includes('00000000-0000-4000-e000-000000000001')
        && /Approved: Campbell Scientific CR300 · s\/n 12345 is on Gatton's register\./.test(await text('#pr-sugs')), await text('#pr-sugs'));

    // The OCR's own reading of the same label, approved as it is.
    const ocrId = db.suggestions.find(s => s.model === 'CR300' && s.serial_no === '12345' && s.status === 'pending');
    // (the fake does not supersede; the real database does — check_photo_review.sql)
    await page.click(`#pr-sug-${ocrId.id} button:has-text("Approve")`);
    await page.waitForFunction(id => !document.getElementById(`pr-sug-${id}`), ocrId.id, { timeout: LOAD_TIMEOUT });
    dec = calls('decide_equipment_suggestion').at(-1);
    ok('approved untouched: no corrections at all — the patch is null, not the suggestion sent back',
      J(dec.body) === J({ p_id: ocrId.id, p_decision: 'approve', p_note: null, p_patch: null }), J(dec.body));

    // A third solar panel, with two on the register: said to be another one.
    const S3 = '#pr-sug-00000000-0000-4000-e000-000000000003';
    const options = await page.$$eval(`${S3} label:has-text("What it is") option`, os => os.map(o => o.textContent.trim()));
    ok('with two panels on the register, the administrator is asked what this one is — replacing either, or alongside',
      options.length === 4 && /^Choose which it replaces/.test(options[0]) && /^Replaces 80 W · s\/n SP-1 — retired$/.test(options[1])
        && /^Another one, alongside/.test(options[3]), J(options));
    await page.selectOption(`${S3} label:has-text("What it is") select`, 'alongside');
    await page.click(`${S3} button:has-text("Approve")`);
    await page.waitForFunction(() => !document.getElementById('pr-sug-00000000-0000-4000-e000-000000000003'), null, { timeout: LOAD_TIMEOUT });
    dec = calls('decide_equipment_suggestion').at(-1);
    ok('"alongside" is sent as replaces: null, and nothing else',
      J(dec.body) === J({ p_id: '00000000-0000-4000-e000-000000000003', p_decision: 'approve', p_note: null, p_patch: { replaces: null } }), J(dec.body));

    // The agent's suggestion, rejected.
    const S2 = '#pr-sug-00000000-0000-4000-e000-000000000002';
    await page.fill(`${S2} label:has-text("Note") input`, 'that modem was moved to Helidon');
    await page.click(`${S2} button:has-text("Reject")`);
    await page.waitForFunction(() => !document.getElementById('pr-sug-00000000-0000-4000-e000-000000000002'), null, { timeout: LOAD_TIMEOUT });
    dec = calls('decide_equipment_suggestion').at(-1);
    ok('rejected with a note: no patch, whatever was typed into the values',
      J(dec.body) === J({ p_id: '00000000-0000-4000-e000-000000000002', p_decision: 'reject', p_note: 'that modem was moved to Helidon', p_patch: null }), J(dec.body));
    await page.click('.pr-decided summary');
    ok('the decided list says who decided what, and why', /Rejected by crew@example\.test — that modem was moved to Helidon/.test(await text('.pr-decided'))
      && /Approved by crew@example\.test, corrected — the label says 12345/.test(await text('.pr-decided')), await text('.pr-decided'));
    ok('nothing is waiting now', /Nothing is waiting for a decision/.test(await text('#pr-sugs')) && !/waiting/.test(await text('#pr-eq-h')));
    audit = await auditHandlers(page);
    ok(`an administrator's panel: all ${audit.checked} handler(s) resolve`, audit.unresolved.length === 0, audit.unresolved.map(u => u.path).join(', '));

    // ── A station's worth ────────────────────────────────────────────────────
    section('A station\'s photos, read in bulk');
    await page.fill('#pr-scan-find', 'Gatton');
    await page.dispatchEvent('#pr-scan-find', 'input');
    await page.click('#pr-scan-hits .fp-hit >> nth=0');
    await page.waitForFunction(() => /Scan \d+ photos? at /.test((document.querySelector('.pr-scan-go button') || {}).textContent || ''), null, { timeout: LOAD_TIMEOUT });
    ok('a station chosen: its photos counted, newest first, and offered', /🔎 Scan 3 photos at Gatton$/.test(await text('.pr-scan-go button'))
      && db.selects.some(s => s.table === 'field_photo' && /station_id=eq\.gatton/.test(s.search) && /limit=60/.test(s.search)), await text('.pr-scan-go button'));
    const p0 = calls('propose_equipment').length;
    await page.click('.pr-scan-go button');
    await scanned();
    const bulk = calls('propose_equipment').slice(p0).map(c => c.body.p);
    const result = (await review()).scanResult;
    ok('three photos read one at a time: the label again (already on the register — known, not a failure), the uploaded photo and the paddock',
      result && /^Read the labels on 3 photos at Gatton: 0 suggestions made; 1 already known — waiting, on the register, or turned down before; nothing readable on 2\.$/.test(result.text)
        && bulk.length === 1 && bulk[0].serial_no === '12345', J({ result, bulk }));
    ok('…and says so on the panel', await text('#pr-scan-msg') === result.text, await text('#pr-scan-msg'));

    // ── Reading labels after an upload ───────────────────────────────────────
    section('Read equipment labels after upload');
    await page.check('#fp-read-labels');
    const kisters = jpegWith(await labelJpeg(page, ['KISTERS', 'HS40', 'SN: 21150012']), { tiff: exifAt(-27.55486, 152.27520, '2026:06:26 08:00:00') });
    await page.setInputFiles('#fp-files', [{ name: 'IMG_5002.jpg', mimeType: 'image/jpeg', buffer: kisters }]);
    await settled();
    const p1 = calls('propose_equipment').length;
    await page.click('#fp-upload');
    await settled();
    await page.waitForFunction(() => { const r = state.photos.review; return r && r.scan && !r.scan.running && r.scan.total === 1 && r.scan.i === 1; }, null, { timeout: OCR_TIMEOUT });
    await page.waitForFunction(() => /Read the labels on the 1 photo just uploaded/.test((state.photos.msg || {}).text || ''), null, { timeout: OCR_TIMEOUT });
    const after = calls('propose_equipment').slice(p1).map(c => c.body.p);
    const newPhoto = db.photos.find(p => p.title === 'IMG_5002.jpg');
    ok('ticked, the photo just uploaded has its labels read from the bytes this page still had, and what they say proposed',
      after.length === 1 && after[0].photo_id === newPhoto.id && after[0].equipment_key === 'bubble_unit' && after[0].make === 'Kisters'
        && after[0].model === 'HS40' && after[0].serial_no === '21150012' && after[0].proposed_by === 'ocr'
        && !store.signed.includes(newPhoto.storage_path), J(after));
    ok('…and the line under the drop zone says so', /^Read the labels on the 1 photo just uploaded: 1 suggestion made\./.test(await page.evaluate(() => state.photos.msg.text)),
      await page.evaluate(() => state.photos.msg.text));
    await page.uncheck('#fp-read-labels');

    // ── The station card ─────────────────────────────────────────────────────
    section('The station card');
    await page.evaluate(() => { switchTab('stations'); });
    await page.waitForFunction(() => !!state.map, null, { timeout: LOAD_TIMEOUT });
    await page.evaluate(() => showStationCard('gatton'));
    await page.waitForFunction(() => { const el = document.getElementById('mn-equip-card-gatton'); return el && el.children.length; }, null, { timeout: LOAD_TIMEOUT });
    const eq = await text('#mn-equip-card-gatton');
    ok('Gatton\'s card has an Equipment section: what the register says is fitted now',
      /Equipment — the station's register/.test(eq) && /Logger\s*Campbell Scientific CR300 · s\/n 12345/.test(eq)
        && /Solar Panel\s*80 W · s\/n SP-3/.test(eq), eq);
    ok('…read from the live register only', db.selects.some(s => s.table === 'station_equipment' && /station_id=eq\.gatton/.test(s.search) && /retired_at=is\.null/.test(s.search)));
    const helidon = await page.evaluate(() => { const s = state.data.stations.find(x => x.id !== 'gatton' && x.lat != null); showStationCard(s.id); return s.id; });
    await page.waitForTimeout(400);
    ok('a station with nothing on its register has no Equipment section to show',
      await page.evaluate(id => { const el = document.getElementById(`mn-equip-card-${id}`); return !el || getComputedStyle(el).display === 'none'; }, helidon));
    await page.evaluate(() => { dbSetAccessToken(null); FieldPhotos.authChanged(); showStationCard('gatton'); });
    await page.waitForTimeout(200);
    ok('signed out, the card has no Equipment section at all', !(await page.$('#mn-equip-card-gatton')));

    ok('nothing threw and the console stayed clean', errors.length === 0, errors.slice(0, 4).join(' | '));
    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────
try {
  await nodeHalf();
  await browserHalf();
} catch (err) {
  failures++;
  console.log(`\nThe photo review check could not finish:\n${err.stack || err}`);
}
console.log(`\n  ${passes + failures} assertion(s).`);
if (failures) {
  console.log(`\nFAIL — ${failures} of ${passes + failures}.`);
  process.exitCode = 1;
} else {
  console.log('\nPASS — what came in is on the Review panel, and what the labels say waits for an administrator.');
}
