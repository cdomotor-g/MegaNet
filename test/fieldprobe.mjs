// What the datastore holds, as opposed to what the registry says it should.
//
// The Field Data picker offered a station's sensors out of `stations.json` and
// nothing else. For most of the network that is right and sufficient. For the
// station this check is written against it is not even close:
//
//   `18_bateson` is document-managed and carries no station number, no ALERT
//   ids and no sensor rows, so `fieldAddrs()` returns an empty list, the picker
//   says "No ALERT addresses recorded for this station", and an operator is
//   left with a free-text box and no way to find out what to type into it.
//
//   Meanwhile four channels report every five minutes into `meganet.reading` —
//   `s:999998/rain`, `/level_1`, `/level_2`, `/battery` — filed against a
//   *second* station row, `bateson_test`, which `db/migrations/0026` created on
//   purpose so that rain measured in a workshop can never be read as gauged
//   rainfall.
//
// Both halves of that are correct and the app had no path between them. The
// probe is that path: a search over the four columns a reading carries its
// identity in (`station_id`, `channel`, `station_number`, `alert_id`), reported
// as distinct addresses that tick exactly like a registry sensor.
//
// The two assertions that matter most here are about what it refuses to do:
//
//   1. **A widened match is never charted on its own.** Opening the tab from a
//      station card auto-loads what it finds *for that station*; when nothing
//      matched and it fell back to a word out of the station's name, it lists
//      the results, tags them with the station row they are filed under, says
//      it widened, and stops. Auto-charting there would put the workshop rig's
//      rain on screen under the name of the pin somebody clicked, which is
//      precisely the separation 0026 exists to keep.
//
//   2. **A series is labelled by whose readings they are.** Ticking a probed
//      address that belongs to another station and charting it must name that
//      station, not the one the picker happens to be showing.
//
// None of this is visible to `npm run smoke`: the tab renders, the picker
// draws, nothing throws, and the answer is either missing or attributed to the
// wrong site.
//
//   node --run fieldprobe      (or: npm run fieldprobe)

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const LOAD_TIMEOUT = 60000;
const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');

let failures = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${name}${VERBOSE && detail ? `  (${detail})` : ''}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};

// The rig as 0026 creates it, and the surveyed site as stations.json carries
// it. The point of both being here is that they are two rows: the readings are
// the rig's and the map pin is the site's.
const RIG = {
  id: 'bateson_test', name: '18 Bateson workshop test rig', station_number: '999998',
  roles: ['base'], lat: null, lon: null, sensors: [
    { sensor_id: 'rain',    type: 'Rainfall',    alert_id: null },
    { sensor_id: 'level_1', type: 'Water Level', alert_id: null },
    { sensor_id: 'level_2', type: 'Water Level', alert_id: null },
    { sensor_id: 'battery', type: 'Battery',     alert_id: null },
  ],
};

const server = await startServer();
const browser = await launchBrowser();
const errors = [];

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(e.message));

  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });

  const out = await page.evaluate(async (RIG) => {
    const log = { queries: [] };
    const A = window.ArroData;
    const wait = ms => new Promise(r => setTimeout(r, ms));

    // meganet.reading, stubbed at the one function that talks to it, so the
    // whole path above — filter building, paging, reduction, rendering,
    // ticking, the query that follows — is the real one.
    const CHANNELS = [
      ['s:999998/rain',    'mm'], ['s:999998/level_1', 'm'],
      ['s:999998/level_2', 'm'],  ['s:999998/battery', 'V'],
    ];
    const now = Date.now();
    const readings = (list, n) => list.flatMap(([addr, unit], k) =>
      Array.from({ length: n }, (_, i) => ({
        addr, station_id: 'bateson_test', unit,
        reading_ts:  new Date(now - i * 300000).toISOString(),
        received_at: new Date(now - i * 300000).toISOString(),
        value_raw: 10 + i + k, value: (10 + i + k) * 0.2,
        quality: 0, path: '18 Bateson', dup_count: 0, dup_paths: [],
      })));

    window.dbSelect = async (q) => {
      log.queries.push(q);
      if (/^quality\?/.test(q)) return [{ code: 0, key: 'good' }];
      if (!/^reading\?/.test(q)) return [];
      // The site's own id: nothing has ever been filed against it.
      if (/station_id=eq\.18_bateson/.test(q)) return [];
      // The widened search on a word out of its name.
      if (/ilike\.\*bateson\*/.test(q)) return readings(CHANNELS, 6);
      // A search that matches nothing.
      if (/ilike\.\*nosuchthing\*/.test(q)) return [];
      // One channel, searched for by name.
      if (/ilike\.\*battery\*/.test(q)) return readings([CHANNELS[3]], 6);
      // The chart query.
      const want = decodeURIComponent((q.match(/addr=in\.\(([^)]*)\)/) || [])[1] || '');
      if (want) return readings(CHANNELS.filter(c => want.includes(c[0])), 6);
      return [];
    };

    state.data.stations.push(RIG);

    // ── the filter, on its own ────────────────────────────────────────────
    // Asserted through the queries the probe actually issues, below; what is
    // checked here is that the picker draws its block at all before anything
    // has been asked.
    switchTab('field');
    await wait(80);
    log.blockBeforeAnything = !!document.querySelector('#ad-side .ad-field-probe');

    // ── opening the tab on the site, from the station card's door ─────────
    A.fieldOpenStation('18_bateson');
    for (let i = 0; i < 60 && A.ad.fq.probe.loading; i++) await wait(50);
    const p = A.ad.fq.probe;
    log.station   = A.ad.fq.stationId;
    log.registry  = A.fieldAddrs(state.data.stations.find(s => s.id === '18_bateson')).length;
    log.found     = p.rows.map(r => r.addr);
    log.units     = p.rows.map(r => r.unit);
    log.owners    = [...new Set(p.rows.map(r => r.stationId))];
    log.widened   = p.widened;
    log.scanned   = p.scanned;
    log.autoTicked = A.ad.fq.sensors.length;
    log.autoDrawn  = A.ad.series.length;
    log.rowsDrawn  = document.querySelectorAll('#ad-side .ad-probe-row').length;
    log.saysWidened = /matched\s+bateson/i.test(document.getElementById('ad-side')?.textContent || '');
    log.tagsOwner   = /bateson_test/.test(document.getElementById('ad-side')?.textContent || '');
    log.selectable  = A.fieldSelectableAddrs().length;

    // ── ticking them, and charting them ───────────────────────────────────
    A.fieldAllSensors();
    log.allTicked = A.ad.fq.sensors.length;
    A.fieldRun();
    for (let i = 0; i < 60 && !A.ad.series.length; i++) await wait(100);
    log.series = A.ad.series.map(s => ({
      label: s.label, station: s.station && s.station.id, kind: s.kind, unit: s.engUnit,
    }));

    // ── a search that finds nothing says so ───────────────────────────────
    A.fieldProbe('nosuchthing');
    for (let i = 0; i < 60 && A.ad.fq.probe.loading; i++) await wait(50);
    log.emptyRows = A.ad.fq.probe.rows.length;
    log.emptyText = /Nothing in the datastore/.test(document.getElementById('ad-side')?.textContent || '');

    // ── and a search by channel name finds the one ────────────────────────
    A.fieldProbe('battery');
    for (let i = 0; i < 60 && A.ad.fq.probe.loading; i++) await wait(50);
    log.byChannel = A.ad.fq.probe.rows.map(r => r.addr);
    log.byChannelWidened = A.ad.fq.probe.widened;

    // ── the probe belongs to the station that was showing ─────────────────
    A.fieldSetStation('', '');
    log.clearedRows = A.ad.fq.probe.rows.length;
    log.clearedAsked = A.ad.fq.probe.asked;

    return log;
  }, RIG);

  console.log('\n  the block is there before anything is asked');
  ok('the datastore block is drawn on the picker', out.blockBeforeAnything);

  console.log('\n  a station with nothing in the registry: 18 Bateson');
  ok('stations.json offers no address at all for it', out.registry === 0, `${out.registry}`);
  ok('the card\'s door lands the picker on it', out.station === '18_bateson', out.station);
  ok('and the probe finds the four channels anyway',
     ['s:999998/rain', 's:999998/level_1', 's:999998/level_2', 's:999998/battery']
       .every(a => out.found.includes(a)) && out.found.length === 4, out.found.join(', '));
  ok('carrying the unit each reported in', out.units.join(',') === 'mm,m,m,V', out.units.join(','));
  ok('it says it widened, and names the word it widened on',
     out.widened === 'bateson' && out.saysWidened, out.widened);
  ok('and tags every row with the station row it is really filed under',
     out.owners.join(',') === 'bateson_test' && out.tagsOwner, out.owners.join(','));
  ok('all four are drawn as tickable rows', out.rowsDrawn === 4, `${out.rowsDrawn}`);

  console.log('\n  what a widened match must NOT do');
  ok('THE RULE: a widened match is not ticked on its own', out.autoTicked === 0,
     `${out.autoTicked} ticked`);
  ok('and nothing is charted under the pin that was clicked', out.autoDrawn === 0,
     `${out.autoDrawn} series`);

  console.log('\n  ticked by hand, they chart — as whose they are');
  ok('"all" covers the probed addresses, not just the registry\'s',
     out.selectable === 4 && out.allTicked === 4, `${out.allTicked} of ${out.selectable}`);
  ok('all four are drawn', out.series.length === 4, `${out.series.length}`);
  ok('THE RULE: each is labelled with the station its readings are filed under',
     out.series.every(s => s.station === 'bateson_test'),
     out.series.map(s => `${s.label} → ${s.station}`).join(' | '));
  ok('and named apart by the channel, not four times the same',
     new Set(out.series.map(s => s.label)).size === 4,
     out.series.map(s => s.label).join(' | '));
  // The kind rule is `npm run fieldkind`'s subject; what is checked here is
  // that it still reaches a series that arrived through the probe rather than
  // through the registry. Battery comes out RA — volts is neither mm nor
  // metres, so guessKind falls through to its documented fallback, which is the
  // behaviour that check pins and not this one's to change.
  const kindOf = ch => (out.series.find(s => s.label.endsWith(ch)) || {}).kind;
  ok('a probed level still charts as a level',
     kindOf('level_1') === 'WL' && kindOf('level_2') === 'WL',
     out.series.map(s => `${s.label}=${s.kind}`).join(' | '));
  ok('and probed rain as rain', kindOf('rain') === 'RA',
     out.series.map(s => `${s.label}=${s.kind}`).join(' | '));

  console.log('\n  the search box');
  ok('a term that matches nothing says so rather than showing the last answer',
     out.emptyRows === 0 && out.emptyText);
  ok('a channel name finds its address', out.byChannel.join(',') === 's:999998/battery',
     out.byChannel.join(','));
  ok('and a typed search never claims to have widened', out.byChannelWidened === '',
     out.byChannelWidened);

  console.log('\n  it belongs to the station that was showing');
  ok('clearing the station clears the probe with it',
     out.clearedRows === 0 && out.clearedAsked === false);

  console.log('\n  the queries it issued');
  // The probe's own queries: the chart query that follows carries a window, and
  // selects the whole raw column list rather than the four this reduces.
  const asked = out.queries.filter(q => /^reading\?/.test(q) && !/reading_ts=gte\./.test(q));
  ok('it asked the station\'s own id first — the indexed question',
     /^reading\?station_id=eq\.18_bateson&/.test(asked[0] || ''), asked[0]);
  ok('then widened across the four columns a reading carries identity in',
     /or=\(station_id\.ilike\.\*bateson\*,channel\.ilike\.\*bateson\*,station_number\.ilike\.\*bateson\*\)/
       .test(asked[1] || ''), asked[1]);
  ok('a digits-only term also asks alert_id by equality, not by ilike',
     await page.evaluate(() => {
       // The filter builder is reached through a probe, so this drives one and
       // reads the query back rather than exporting a function for the test.
       const seen = [];
       const prev = window.dbSelect;
       window.dbSelect = async q => { seen.push(q); return []; };
       return ArroData.fieldProbe('8101').then(() => {
         window.dbSelect = prev;
         return seen.some(q => /alert_id\.eq\.8101/.test(q) && !/alert_id\.ilike/.test(q));
       });
     }));
  ok('and every one of them selected only the four columns it reduces',
     asked.every(q => q.includes('select=addr,station_id,unit,reading_ts')),
     asked.map(q => q.slice(0, 80)).join('\n         '));

  console.log('\n  nothing threw');
  ok('no page errors for the whole run', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  await server.close?.();
}

console.log(failures
  ? `\nFAIL — ${failures} assertion(s).\n`
  : '\nPASS — the picker can say what the datastore holds, it never charts another\n'
    + '       station\'s readings under this one\'s name, and a widened match says so.\n');
process.exit(failures ? 1 : 0);
