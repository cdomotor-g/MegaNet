// Which kind of sensor a field series is, and what the chart may therefore
// offer to convert.
//
// This exists because of a defect that reached the screen: the two SDI-12 level
// sensors at 18 Bateson charted as **RainAccum**, with the inspector offering
// "= 0.36 mm (assumed 0.2 mm/tip)" against a river level in metres. Every layer
// underneath was right — the logger sent `s:999998/level_1` with `unit: "m"`,
// `meganet.ingest()` stored it as that, and the sensor row is typed
// `Water Level` — and the app still called it rain, because of two defects that
// only produce a wrong answer together:
//
//   `fieldAddrs()` only ever built `a:<alert_id>` addresses, so a sensor that
//   reports by channel was not in the station's address list at all. The series
//   builder looks the address up in that list to find its sensor row, missed,
//   and got `sensor = null`.
//
//   `guessKind()` then had nothing but an empty label — and its fallback is
//   `'RA'`. **A fallback is not a guess.** It looked at neither the unit the
//   readings carried nor the channel in the address, both of which say "level"
//   in as many words.
//
// Neither is visible to `npm run smoke`: the tab renders perfectly, the axis is
// drawn, nothing throws. The chart is simply wrong about what it is charting,
// which is the class of failure this repository has decided grows a check of
// its own (roadmap constraint 1).
//
//   node --run fieldkind      (or: npm run fieldkind)

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const LOAD_TIMEOUT = 60000;

let failures = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};

// The rig as `db/migrations/0026_bateson_test_rig.sql` actually creates it: four
// channels with no ALERT address, one self-test address that has one, and a
// station number. Plus an ARRO-shaped alert-less sensor, because 927 of those
// exist and must NOT be mistaken for channels.
const RIG = {
  id: 'bateson_test', name: '18 Bateson workshop test rig', station_number: '999998',
  sensors: [
    { sensor_id: 'rain',            type: 'Rainfall',    alert_id: null },
    { sensor_id: 'level_1',         type: 'Water Level', alert_id: null },
    { sensor_id: 'level_2',         type: 'Water Level', alert_id: null },
    { sensor_id: 'battery',         type: 'Battery',     alert_id: null },
    { sensor_id: 'alert2_selftest', type: 'Self-test',   alert_id: 8101 },
    { sensor_id: '514923.1.R',      type: 'Rainfall',    alert_id: null },
  ],
};

const server = await startServer();
const browser = await launchBrowser();
const errors = [];

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(e.message));

  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });

  const out = await page.evaluate(async (RIG) => {
    const log = {};
    const A = window.ArroData;

    // ── the classification rule, on its own ──────────────────────────────
    const K = (unit, addr, type, label) =>
      A.guessKind({ unit, addr, sensorLabel: label || '' }, type ? { type } : null);

    // The unit is the device's own statement and outranks everything.
    log.unitM       = K('m',    's:999998/level_1', 'Water Level');
    log.unitMm      = K('mm',   's:999998/rain',    'Rainfall');
    log.unitMbeatsType = K('m',  '',                'Rainfall');   // unit wins
    log.unitMmBeatsType = K('mm', '',               'Water Level'); // both ways
    log.unitMahd    = K('mAHD', '',                 '');

    // The exact regression: no sensor row resolved, no label, no unit — the
    // address is the only evidence there is, and it is enough.
    log.channelOnly = K('', 's:999998/level_1', null, '');
    log.channelRain = K('', 's:999998/rain',    null, '');

    // The sensor row still works when it is the only thing present.
    log.typeOnly    = K('', '', 'Water Level');
    // And an ALERT address carries no channel, so it contributes nothing —
    // which must not accidentally read as "level".
    log.alertAddr   = K('', 'a:6128', null, '');
    // Nothing at all is still RA, unchanged and documented.
    log.nothing     = K('', '', null, '');

    // ── which addresses a station is reachable on ────────────────────────
    const addrs = A.fieldAddrs(RIG).map(a => a.addr);
    log.addrs = addrs;
    log.levelSensorType = (A.fieldAddrs(RIG).find(a => a.addr === 's:999998/level_1') || {}).sensor?.type;
    log.noAddr = A.fieldNoAddr(RIG);
    log.chanOfLevel = A.fieldChannelId(RIG.sensors[1]);
    log.chanOfArro  = A.fieldChannelId(RIG.sensors[5]);
    log.chanOfRadio = A.fieldChannelId(RIG.sensors[4]);
    // A channel needs a station number: the address is <number>/<channel>.
    log.addrsNoNumber = A.fieldAddrs({ ...RIG, station_number: '' }).map(a => a.addr);

    // ── the whole path, as the operator drives it ────────────────────────
    // Real readings, in the shape meganet.reading returns them, through the
    // real fetch → series → chart path with only the network stubbed.
    state.data.stations.push(RIG);
    const rows = [];
    for (let i = 0; i < 12; i++) {
      rows.push({
        addr: 's:999998/level_1', reading_ts: new Date(Date.now() - i * 300000).toISOString(),
        received_at: new Date(Date.now() - i * 300000).toISOString(),
        value_raw: 1.797 + i * 0.001, value: 1.797 + i * 0.001, unit: 'm',
        quality: 0, path: '18 Bateson', dup_count: 0, dup_paths: [],
      });
    }
    window.dbSelect = async (q) => /^quality\?/.test(q) ? [{ code: 0, key: 'good' }]
                                : /\/?reading\?/.test(q) || /reading/.test(q) ? rows : [];

    switchTab('field');
    await new Promise(r => setTimeout(r, 60));
    A.fieldShow('s:999998/level_1', Date.now());
    for (let i = 0; i < 60 && !A.ad.series.length; i++) await new Promise(r => setTimeout(r, 100));

    const s = A.ad.series[0];
    log.built = !!s;
    if (s) {
      log.seriesKind = s.kind;
      log.seriesUnit = s.engUnit;
      log.seriesLabel = s.label;
      log.linkedSensor = s.sensor?.type || null;
    }
    // rawBucketNote() renders inside the pinned-reading inspector, so a point
    // has to actually be pinned for the assertion below to mean anything. This
    // was vacuous until a mutation run proved it: with the unit veto removed the
    // check still passed, because nothing on the page had asked for the note.
    // The readout is rendered into #ad-readout by a function the module does not
    // export, so the pin is set and the tab re-rendered the way a tab switch
    // would — which is the same path a real click ends on.
    if (s) {
      A.ad.pin = { key: s.key, i: 5 };
      switchTab('arro');
      await new Promise(r => setTimeout(r, 40));
      switchTab('field');
      await new Promise(r => setTimeout(r, 120));
    }
    log.pinned = !!document.querySelector('.ad-pin');
    log.pageText = document.getElementById('main-content')?.textContent || '';

    // And now the case the unit veto actually exists for. `kind` is not proof of
    // anything: the series list has a RainAccum / WaterLevel dropdown, so an
    // operator can put a river level on RA with two clicks — and a fallback can
    // do it without any. Multiplying metres by 0.2 mm/tip then produces a number
    // that looks like rainfall and is nothing at all.
    //
    // This assertion is here because a mutation run said it had to be: with the
    // other two fixes in place the guard never runs, so removing it broke
    // nothing and the check passed a program that still had the bug in it.
    if (s) {
      A.setKind(s.key, 'RA');
      switchTab('arro');
      await new Promise(r => setTimeout(r, 40));
      switchTab('field');
      await new Promise(r => setTimeout(r, 120));
      log.forcedKind = A.ad.series[0]?.kind;
      log.forcedPinned = !!document.querySelector('.ad-pin');
      log.forcedText = document.getElementById('main-content')?.textContent || '';
    }
    return log;
  }, RIG);

  console.log('\n  the classification rule');
  ok('a reading in metres is a water level, not rain', out.unitM === 'WL', out.unitM);
  ok('a reading in mm is rainfall', out.unitMm === 'RA', out.unitMm);
  ok('the unit outranks a sensor row that says Rainfall', out.unitMbeatsType === 'WL', out.unitMbeatsType);
  ok('and outranks one that says Water Level, the other way', out.unitMmBeatsType === 'RA', out.unitMmBeatsType);
  ok('mAHD is a level too', out.unitMahd === 'WL', out.unitMahd);
  ok('THE REGRESSION: the channel alone is enough — s:.../level_1 is not rain',
     out.channelOnly === 'WL', `got ${out.channelOnly}`);
  ok('and s:.../rain still is', out.channelRain === 'RA', out.channelRain);
  ok('a sensor row on its own still decides', out.typeOnly === 'WL', out.typeOnly);
  ok('an ALERT address carries no channel and does not fake one',
     out.alertAddr === 'RA', out.alertAddr);
  ok('no evidence at all is still RA, unchanged', out.nothing === 'RA', out.nothing);

  console.log('\n  which addresses a station is reachable on');
  ok('the four channels are addressable as s:<number>/<channel>',
     ['s:999998/rain', 's:999998/level_1', 's:999998/level_2', 's:999998/battery']
       .every(a => out.addrs.includes(a)), out.addrs.join(', '));
  ok('and the ALERT address still is', out.addrs.includes('a:8101'), out.addrs.join(', '));
  ok('an ARRO sensor id is NOT mistaken for a channel',
     !out.addrs.some(a => a.includes('514923')), out.addrs.join(', '));
  ok('it stays in the un-addressable list instead', out.noAddr.length === 1, JSON.stringify(out.noAddr));
  ok('the address carries its sensor row, so the label and kind can be resolved',
     out.levelSensorType === 'Water Level', String(out.levelSensorType));
  ok('fieldChannelId: a channel is a channel', out.chanOfLevel === 'level_1', String(out.chanOfLevel));
  ok('fieldChannelId: a dotted ARRO id is not', out.chanOfArro === null, String(out.chanOfArro));
  ok('fieldChannelId: a sensor with an ALERT address is not', out.chanOfRadio === null, String(out.chanOfRadio));
  ok('a station with no number has no channel addresses — the address needs both halves',
     !out.addrsNoNumber.some(a => a.startsWith('s:')), out.addrsNoNumber.join(', '));

  console.log('\n  the whole path, as the operator drives it');
  ok('the series was built', out.built);
  ok('THE REGRESSION, end to end: a level charts as WaterLevel', out.seriesKind === 'WL',
     `kind ${out.seriesKind}, unit ${out.seriesUnit}`);
  ok('its readings kept their unit', out.seriesUnit === 'm', String(out.seriesUnit));
  ok('the series resolved to its sensor row rather than to nothing',
     out.linkedSensor === 'Water Level', String(out.linkedSensor));
  ok('the label names the sensor rather than the bare address',
     /Water Level/.test(out.seriesLabel || ''), String(out.seriesLabel));
  ok('a reading is pinned, so the inspector is actually on screen',
     out.pinned, 'nothing was pinned — the assertion below would be vacuous');
  ok('and no mm/tip conversion is offered anywhere on the page',
     !/mm\/tip/.test(out.pageText), 'the page still offers a tip conversion');

  console.log('\n  the unit has a veto, whatever the kind says');
  ok('the kind can still be set to RainAccum by hand', out.forcedKind === 'RA', String(out.forcedKind));
  ok('the inspector is on screen for it', out.forcedPinned);
  ok('and metres are STILL not offered a 0.2 mm/tip conversion',
     !/mm\/tip/.test(out.forcedText || ''),
     'a water level on RA was offered a bucket size');

  ok('no page errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  await server.close();
}

console.log('');
if (failures) { console.log(`FAIL — ${failures} assertion(s).`); process.exit(1); }
console.log('PASS — a level charts as a level, and nothing offers it a bucket size.');
