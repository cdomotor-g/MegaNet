// The slot table on file (tdma-slots.js, 0120), Node only.
//
//   The sheet      0120 carries the owner's slot sheet: 151 occupied slots on
//                  four channels (87 + 24 + 20 + 20), every slot a half-second
//                  boundary inside its frame, one row a slot, Mt Pechey RF's
//                  four IDs in its four slots, Mt Mee RF with no ID.
//   Runs           adjacent slots fold into runs; "2.5–4 s" and "32–33.5 s".
//   Checks         a slot with no ID; one ID under two names; a station whose
//                  register ID is another; an ID the register gives elsewhere;
//                  not heard on a channel the base stations hear, and nothing
//                  said on one they do not; heard on another channel; IDs
//                  heard that no slot holds.
//   Taking over    what a save would take from another site.
//   The words      every term on the panel has a meaning of its own.
//
// Run:  npm run tdmaslots
//       npm run tdmaslots -- -v    also print what passed

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
vm.runInContext(fs.readFileSync(repo('tdma-slots.js'), 'utf8') + '\n;this.TdmaSlots = TdmaSlots;', ctx, { filename: 'tdma-slots.js' });
const T = ctx.TdmaSlots;

// ── the sheet, as 0120 seeds it ──
console.log('\nThe sheet\n');
const sql = fs.readFileSync(repo('db/migrations/0120_tdma_slots.sql'), 'utf8');
const rowRe = /^\s*\((\d+\.\d+), ([\d.]+), (\d+|null), '((?:[^']|'')*)', ('[a-z0-9_]+'|null)\)/gm;
const seed = [...sql.matchAll(rowRe)].map(m => ({ freq_mhz: Number(m[1]), slot_s: Number(m[2]), alert2_id: m[3] === 'null' ? null : Number(m[3]),
  site: m[4].replace(/''/g, "'"), station_id: m[5] === 'null' ? null : m[5].slice(1, -1) }));
const per = f => seed.filter(s => s.freq_mhz === f).length;
ok('151 occupied slots in all', seed.length === 151, String(seed.length));
ok('87 on 151.5375, 24 on 152.4625, 20 on 173.9 and 20 on 173.95', per(151.5375) === 87 && per(152.4625) === 24 && per(173.9) === 20 && per(173.95) === 20,
  [151.5375, 152.4625, 173.9, 173.95].map(per).join(', '));
const frame = { 151.5375: 60, 152.4625: 60, 173.9: 20, 173.95: 20 };
ok('every slot starts on a half-second inside its frame', seed.every(s => s.slot_s * 2 === Math.round(s.slot_s * 2) && s.slot_s < frame[s.freq_mhz]));
ok('one row a slot', new Set(seed.map(s => `${s.freq_mhz}/${s.slot_s}`)).size === seed.length);
const at = (f, t) => seed.find(s => s.freq_mhz === f && s.slot_s === t);
ok('slot 0 on 151.5375 is Fords Rd Reserve, 11058 — the sheet leaves its time blank', at(151.5375, 0)?.alert2_id === 11058 && at(151.5375, 0)?.site === 'Fords Rd Reserve');
ok('Mt Pechey RF (Rptr) sends 10310–10313 in 3.5–5 s and again in 33.5–35 s',
  J([3.5, 4, 4.5, 5, 33.5, 34, 34.5, 35].map(t => at(152.4625, t)?.alert2_id)) === J([10310, 10311, 10312, 10313, 10310, 10311, 10312, 10313]));
ok('Mt Mee RF holds 52–53.5 s with no ID', [52, 52.5, 53, 53.5].every(t => at(151.5375, t)?.site === 'Mt Mee RF' && at(151.5375, t)?.alert2_id == null));
ok('Mt Glorious Primary holds 173.9 at 0–9.5 s, Secondary 173.95 at 10–19.5 s',
  seed.filter(s => s.freq_mhz === 173.9).every(s => s.alert2_id === 9511 && s.slot_s < 10) && seed.filter(s => s.freq_mhz === 173.95).every(s => s.alert2_id === 9601 && s.slot_s >= 10));
const linked = new Map();
for (const s of seed) if (s.station_id) { if (!linked.has(s.alert2_id)) linked.set(s.alert2_id, new Set()); linked.get(s.alert2_id).add(s.station_id); }
ok('17 IDs linked to a station, each to one station, no station twice', linked.size === 17 && [...linked.values()].every(v => v.size === 1)
  && new Set([...linked.values()].map(v => [...v][0])).size === 17, String(linked.size));

// ── runs ──
console.log('\nRuns\n');
const runs = T.runsOf([2.5, 3, 3.5, 4, 32, 32.5, 33, 33.5], 0.5);
ok('Mt Crosby Rptr: two runs of four', J(runs) === J([{ start: 2.5, n: 4 }, { start: 32, n: 4 }]), J(runs));
ok('"2.5–4 s" and "32–33.5 s"', runs.map(r => T.runText(r, 0.5)).join(', ') === '2.5–4 s, 32–33.5 s');
ok('a lone slot reads "15 s"', T.runText({ start: 15, n: 1 }, 0.5) === '15 s');
ok('out of order still folds', J(T.runsOf([1, 0, 0.5, 5], 0.5)) === J([{ start: 0, n: 3 }, { start: 5, n: 1 }]));
const sites = T.sitesOn(seed, 151.5375, 0.5);
ok('the 151.5375 channel has 29 sites, Fords Rd Reserve first', sites.length === 29 && sites[0].site === 'Fords Rd Reserve', `${sites.length}, ${sites[0]?.site}`);
ok('Mt Cotton West: 8 slots in two runs', (() => { const e = sites.find(x => x.site === 'Mt Cotton West'); return e && e.count === 8 && e.runs.length === 2; })());

// ── checks ──
console.log('\nChecks\n');
const ch = { freq_mhz: 151.5375, frame_s: 60, slot_s: 0.5, label: 'x' };
const slots = [
  { freq_mhz: 151.5375, slot_s: 0, alert2_id: 11058, site: 'Fords Rd Reserve', station_id: 'fords_rd_al' },
  { freq_mhz: 151.5375, slot_s: 0.5, alert2_id: 8233, site: 'Gympie Weir', station_id: 'gympie_weir_tm' },
  { freq_mhz: 151.5375, slot_s: 1, alert2_id: 11081, site: 'Cedar Grove', station_id: null },
  { freq_mhz: 151.5375, slot_s: 2, alert2_id: null, site: 'Mt Mee RF', station_id: null },
  { freq_mhz: 151.5375, slot_s: 3, alert2_id: 10315, site: 'Mt Pechey', station_id: null },
  { freq_mhz: 151.5375, slot_s: 4, alert2_id: 9600, site: 'Wirth Crossing', station_id: null },
  { freq_mhz: 151.5375, slot_s: 5, alert2_id: 9600, site: 'Wirth Xing', station_id: null },
  { freq_mhz: 152.4625, slot_s: 0, alert2_id: 10184, site: 'Bill Gun Dam HW (Rptr)', station_id: null },
];
const stations = [
  { id: 'fords_rd_al', name: 'Fords Rd AL', alert2_station_id: 11058 },
  { id: 'gympie_weir_tm', name: 'Gympie Weir TM', alert2_station_id: 9999 },
  { id: 'cedar_grove_weir_hw_tm', name: 'Cedar Grove Weir HW TM', alert2_station_id: 11081 },
];
const heard = [
  { alert2_id: 11058, freq_mhz: 151.5375, as_source: 1091, as_relay: 0, last_heard: '2026-11-12T01:00:00Z' },
  { alert2_id: 10315, freq_mhz: 151.5, as_source: 8810, as_relay: 0, last_heard: '2026-11-07T01:00:00Z' },
  { alert2_id: 10115, freq_mhz: 151.5375, as_source: 41832, as_relay: 900, last_heard: '2026-11-12T01:00:00Z' },
  { alert2_id: 128, freq_mhz: 151.5375, as_source: 2, as_relay: 0, last_heard: '2026-10-21T01:00:00Z' },
];
const K = T.checks({ channel: ch, slots, heard, stations });
const note = (site, k) => (K.sites.find(e => e.site === site)?.notes || []).some(n => n.k === k);
ok('Fords Rd Reserve: linked, heard 1,091 times, nothing to say', K.sites[0].air?.source === 1091 && K.sites[0].notes.length === 0, J(K.sites[0].notes));
ok('Gympie Weir: the register gives its station another ID', note('Gympie Weir', 'station-other-id'));
ok('Gympie Weir: not heard on a channel the base stations hear', note('Gympie Weir', 'unheard'));
ok('Cedar Grove: not linked, and the register gives 11081 to Cedar Grove Weir HW TM', note('Cedar Grove', 'unlinked-held'));
ok('Mt Mee RF: no ALERT2 ID', note('Mt Mee RF', 'no-id'));
ok('Mt Pechey: heard on 151.5 MHz instead', note('Mt Pechey', 'other-channel') && !note('Mt Pechey', 'unheard'));
ok('9600 under two names, said on both', note('Wirth Crossing', 'two-sites') && note('Wirth Xing', 'two-sites'));
ok('10115 heard on the channel and on no slot; 128, heard twice, is not listed', K.strangers.length === 1 && K.strangers[0].alert2_id === 10115, J(K.strangers));
ok('7 used of 120, 113 spare', K.used === 7 && K.total === 120 && K.spare === 113, `${K.used} ${K.total} ${K.spare}`);
const K2 = T.checks({ channel: { freq_mhz: 152.4625, frame_s: 60, slot_s: 0.5 }, slots, heard, stations });
ok('on a channel no base station heard, "not heard" is not said', K2.channelHeard === false && !K2.sites[0].notes.some(n => n.k === 'unheard'));
const K3 = T.checks({ channel: ch, slots, heard: [], stations });
ok('with nothing heard at all, no "not heard" either', !K3.sites.some(e => e.notes.some(n => n.k === 'unheard')));

// ── taking over ──
console.log('\nTaking over\n');
ok('putting X in 0–1 s takes Fords Rd, Gympie Weir and Cedar Grove', J(T.takenBy(slots, 151.5375, 0, 3, 0.5, 'X', 1).map(s => s.site)) === J(['Fords Rd Reserve', 'Gympie Weir', 'Cedar Grove']));
ok('putting Fords Rd Reserve back where it is takes nothing', T.takenBy(slots, 151.5375, 0, 1, 0.5, 'Fords Rd Reserve', 11058).length === 0);
ok('another channel is never taken', T.takenBy(slots, 151.5375, 0, 1, 0.5, 'X', 1).every(s => s.freq_mhz === 151.5375));

// ── the words ──
console.log('\nThe words\n');
ok('every word has a meaning of its own, a sentence long', Object.values(T.WORDS).every(m => typeof m === 'string' && m.length > 40 && /\.$/.test(m)));
ok('MHz printed as the sheet prints it', T.fmtMhz(151.5375) === '151.5375' && T.fmtMhz(173.9) === '173.9' && T.fmtMhz(173.95) === '173.95');

console.log(`\n${failures ? 'FAIL' : 'PASS'} — ${passes} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
