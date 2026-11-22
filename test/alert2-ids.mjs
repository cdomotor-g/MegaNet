// The ALERT2 half of the ALERT IDs tab (alert2-ids.js), and 0121's shared
// addresses, Node only.
//
//   Rows        an ID a row from the register, the slot table and what was
//               heard; a stray decode is not a row; a shared ID lists both
//               stations with their sensor numbers.
//   Checks      heard with no station; on the slot table with no station; a
//               shared ID with a holder listing no sensor numbers, or one
//               sensor on two stations; not heard; heard only relaying; heard
//               on another channel than the slot table's; no slot on file.
//   Filter      an ID, a range, a name.
//   Free        the next unused IDs, skipping anything held, on file or heard.
//   0121        the HW/TW split is sensor 7 / 17 at both weirs, Maleny WWTP is
//               a new station at the owner's position, and ingest() resolves
//               by address and slot.
//
// Run:  npm run alert2ids
//       npm run alert2ids -- -v    also print what passed

import fs from 'node:fs';
import vm from 'node:vm';
import { repo } from './lib/paths.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
let failures = 0, passes = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passes++; if (VERBOSE) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};
const J = x => JSON.stringify(x);

const ctx = vm.createContext({ console, Math, Number, String, Array, JSON, Object, Set, Map, Date, Error, Promise,
                               isFinite, parseInt, parseFloat, window: {} });
vm.runInContext(fs.readFileSync(repo('alert2-ids.js'), 'utf8') + '\n;this.Alert2Ids = Alert2Ids;', ctx, { filename: 'alert2-ids.js' });
vm.runInContext(fs.readFileSync(repo('alert2-space.js'), 'utf8') + '\n;this.Alert2Space = Alert2Space;', ctx, { filename: 'alert2-space.js' });
const A = ctx.Alert2Ids, SP = ctx.Alert2Space;

const stations = [
  { id: 'bromelton_weir_hw_tm', name: 'Bromelton Weir HW TM', alert2_station_id: 11047, sensors: [{ alert2_sensor_id: 7 }, { alert2_sensor_id: 8 }] },
  { id: 'bromelton_weir_tw_tm', name: 'Bromelton Weir TW TM', alert2_station_id: 11047, sensors: [{ alert2_sensor_id: 17 }] },
  { id: 'cg_hw', name: 'Cedar Grove Weir HW TM', alert2_station_id: 11081, sensors: [{ alert2_sensor_id: 7 }] },
  { id: 'cg_tw', name: 'Cedar Grove Weir TW TM', alert2_station_id: 11081, sensors: [] },
  { id: 'x1', name: 'Clash A', alert2_station_id: 500, sensors: [{ alert2_sensor_id: 7 }] },
  { id: 'x2', name: 'Clash B', alert2_station_id: 500, sensors: [{ alert2_sensor_id: 7 }] },
  { id: 'gympie', name: 'Gympie Weir TM', alert2_station_id: 8233, hub_id: 'brisbane', sensors: [] },
  { id: 'crosby', name: 'Mt Crosby AL', alert2_station_id: 10019, hub_id: 'cairns', sensors: [] },
  { id: 'nothing', name: 'No ALERT2', sensors: [] },
];
const channels = [{ freq_mhz: 151.5375, slot_s: 0.5, frame_s: 60 }, { freq_mhz: 152.4625, slot_s: 0.5, frame_s: 60 }];
const slots = [
  { freq_mhz: 151.5375, slot_s: 11, alert2_id: 11047, site: 'Bromelton Weir HW/TW' },
  { freq_mhz: 151.5375, slot_s: 11.5, alert2_id: 11047, site: 'Bromelton Weir HW/TW' },
  { freq_mhz: 151.5375, slot_s: 0.5, alert2_id: 8233, site: 'Gympie Weir' },
  { freq_mhz: 151.5375, slot_s: 6, alert2_id: 10290, site: 'Black snake Ck @ Mockers Rd' },
  { freq_mhz: 151.5375, slot_s: 2.5, alert2_id: 10019, site: 'Mt Crosby Rptr' },
  { freq_mhz: 152.4625, slot_s: 40.5, alert2_id: 11070, site: 'South MacLean TW' },
  { freq_mhz: 152.4625, slot_s: 9, alert2_id: 9999, site: 'Never heard here' },
];
const heard = [
  { alert2_id: 11047, freq_mhz: 151.5375, as_source: 1009, as_relay: 0, last_heard: '2026-11-11T00:00:00Z' },
  { alert2_id: 10290, freq_mhz: 151.5375, as_source: 11309, as_relay: 0 },
  { alert2_id: 10115, freq_mhz: 151.5375, as_source: 41832, as_relay: 264616 },
  { alert2_id: 10019, freq_mhz: 151.5375, as_source: 0, as_relay: 900 },
  { alert2_id: 11070, freq_mhz: 151.5375, as_source: 1768, as_relay: 0 },
  { alert2_id: 128, freq_mhz: 151.5375, as_source: 2, as_relay: 0 },
];
const R = A.rows({ stations, slots, channels, heard });
const row = id => R.find(r => r.id === id);
const has = (id, k) => !!row(id) && row(id).checks.some(c => c.k === k);

console.log('\nRows\n');
ok('one row an ID, in number order', J(R.map(r => r.id)) === J([500, 8233, 9999, 10019, 10115, 10290, 11047, 11070, 11081]), J(R.map(r => r.id)));
ok('a stray decode (128, twice) is not a row', !row(128));
ok('11047 lists both Bromelton stations with their sensor numbers', J(row(11047).holders.map(h => [h.id, h.slots])) === J([['bromelton_weir_hw_tm', [7, 8]], ['bromelton_weir_tw_tm', [17]]]));
ok('11047 on the slot table at 11–11.5 s', J(row(11047).sites.map(s => s.runs)) === J([['11–11.5 s']]));

console.log('\nChecks\n');
ok('Bromelton: shared and told apart', has(11047, 'shared') && !has(11047, 'shared-bare'));
ok('Cedar Grove: shared, and TW lists no sensor numbers', has(11081, 'shared-bare'));
ok('500: sensor 7 on two stations', has(500, 'shared-clash'));
ok('10290 heard, on the slot table, no station', has(10290, 'stranger'));
ok('10115 heard, no station, not on the slot table — and no slot', has(10115, 'stranger') && has(10115, 'no-slot'));
ok('Gympie Weir held and on file but not heard', has(8233, 'unheard'));
ok('10019 heard only relaying', has(10019, 'relay-only') && !has(10019, 'unheard'));
ok('11070 on the slot table at 152.4625, heard on 151.5375', has(11070, 'other-channel'));
ok('9999 on a channel nobody hears: not "not heard", but on file with no station', !has(9999, 'unheard') && has(9999, 'no-station'));
const R0 = A.rows({ stations, slots, channels, heard: null });
ok('with nothing heard read, no on-air checks', !R0.some(r => r.checks.some(c => ['unheard', 'relay-only', 'stranger'].includes(c.k))));

console.log('\nFilter\n');
ok('an ID', R.filter(r => A.matches(r, '11047')).length === 1);
ok('a range', J(R.filter(r => A.matches(r, '10000-10999')).map(r => r.id)) === J([10019, 10115, 10290]));
ok('a station name', J(R.filter(r => A.matches(r, 'bromelton')).map(r => r.id)) === J([11047]));
ok('a site name', J(R.filter(r => A.matches(r, 'mockers')).map(r => r.id)) === J([10290]));

console.log('\nFree\n');
ok('from 10018: skip 10019', J(A.free(R, 10018, 3)) === J([10018, 10020, 10021]));
ok('from 10115: skip it', A.free(R, 10115, 1)[0] === 10116);
ok('blocks of a thousand', J(A.blocks(R).map(b => [b.lo, b.n])) === J([[0, 1], [8000, 1], [9000, 1], [10000, 3], [11000, 3]]));

console.log('\nThe wheel and the grid\n');
const I = SP.index(R, [{ id: 'cairns', name: 'Cairns Hub', ord: 2 }, { id: 'brisbane', name: 'Brisbane Hub', ord: 1 }]);
const st = (a, sc = 'all') => SP.statusOf(I, sc, a);
ok('the hubs that hold any, in their order', J(I.hubList.map(h => h.id)) === J(['brisbane', 'cairns']));
ok('one holder: in use', st(8233) === 'use');
ok('shared and told apart: shared', st(11047) === 'shared');
ok('shared, a holder with no sensor numbers: not told apart', st(11081) === 'clash');
ok('shared, one sensor on two: not told apart', st(500) === 'clash');
ok('on the slot table, no station', st(9999) === 'slot');
ok('heard, no station', st(10290) === 'stranger' && st(10115) === 'stranger');
ok('free in a thousand in use, open in one nobody uses', st(10020) === 'free' && st(30000) === 'open');
ok('0 and past 65,534 are no IDs', st(0) === 'void' && st(65535) === 'void');
ok('a hub: its own in use, another hub\'s faint', st(8233, 'hub:brisbane') === 'use' && st(10019, 'hub:brisbane') === 'elsewhere');
ok('on air: heard sending, passing on only, on file only', SP.airOf(I, 10290) === 3 && SP.airOf(I, 10019) === 2 && SP.airOf(I, 9999) === 1 && SP.airOf(I, 10020) === 0);
const W = SP.wedges(I, 'all');
ok('66 wedges of a thousand', W.length === 66 && W[10].lo === 10000 && W[10].hi === 10999);
ok('a wedge counts its colours', W[11].held === 2 && W[11].stranger === 1 && W[11].free === 997, J(W[11]));
ok('a wedge with nothing in it is all open', W[30].taken === 0 && W[30].open === 1000);
ok('the wedge at the top starts at 1', W[0].n === 999);
const G = SP.gaps(I, 3);
ok('the biggest gaps between IDs in use, biggest first', J(G.runs.map(g => [g.lo, g.hi, g.n])) === J([[501, 8232, 7732], [8234, 9998, 1765], [10291, 11046, 756]]), J(G.runs));
ok('…and where nothing is used below or above', G.lo === 500 && G.hi === 11081);
ok('the grid\'s thousands: each in use, and one asked for', J(SP.thousands(I, [30500])) === J([0, 8, 9, 10, 11, 30]));
ok('the filter box: an ID, a range, or nothing', J(SP.boxOf('11047')) === J({ id: 11047, range: null }) && J(SP.boxOf('10100 – 10000')) === J({ id: null, range: { lo: 10000, hi: 10100 } })
  && J(SP.boxOf('bromelton')) === J({ id: null, range: null }) && SP.boxOf('70000').id === null);
ok('a holder carries its hub', row(8233).holders[0].hub === 'brisbane');
ok('the wheel\'s words have meanings a sentence long', Object.values(SP.WORDS).every(m => typeof m === 'string' && m.length > 30 && /\.$/.test(m)) && SP.GLOSSARY.every(([k]) => SP.WORDS[k]));

console.log('\n0121\n');
const sql = fs.readFileSync(repo('db/migrations/0121_alert2_shared_ids.sql'), 'utf8');
ok('HW holds sensors 7 and 8, TW sensor 17, at both weirs',
  /'bromelton_weir_hw_tm',\s+'540270\.a2\.7',\s+'Water Level', 7/.test(sql) && /'bromelton_weir_tw_tm',\s+'540271\.a2\.17',\s+'Water Level', 17/.test(sql)
  && /'cedar_grove_weir_hw_tm', '540590\.a2\.7',\s+'Water Level', 7/.test(sql) && /'cedar_grove_weir_tw_tm', '540748\.a2\.17', 'Water Level', 17/.test(sql));
ok('Maleny WWTP at the owner\'s position, holding 8278', /'Maleny WWTP',\s+-26\.765182, 152\.867250/.test(sql) && /\(8278, 'maleny_wwtp'\)/.test(sql));
ok('Maleny AL is not given 8278', !/8278,\s*'maleny_al'/.test(sql));
ok('ingest() resolves by address and slot', sql.includes('meganet.resolve_a2_sensor(v_a2_stn, v_a2_sen),') && !sql.includes('coalesce(meganet.resolve_a2_station(v_a2_stn),'));
ok('resolve_readings() too', sql.includes('meganet.resolve_a2_sensor(r.a2_station, r.a2_sensor),'));
ok('the unique index goes', sql.includes('drop index if exists meganet.station_alert2_unique_idx'));

// A station's name is anybody's typing: every place the sensor grid shows it,
// the tooltip inside each cell included, it goes through esc().
ctx.esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
ctx.escAttr = ctx.esc;
{
  const bad = '</title><img src=x onerror=alert(1)>';
  const html = SP.sensorsHtml({ id: 12345, holders: [{ id: 'x', name: bad, slots: [3] }] });
  ok('the sensor grid escapes station names, tooltips too', !html.includes('<img') && html.includes('&lt;/title&gt;&lt;img'), html.match(/<title>Sensor 3[^]*?<\/title>/)?.[0]);
}

console.log('\nThe words\n');
ok('every word has a meaning of its own, a sentence long', Object.values(A.WORDS).every(m => typeof m === 'string' && m.length > 40 && /\.$/.test(m)));

console.log(`\n${failures ? 'FAIL' : 'PASS'} — ${passes} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
