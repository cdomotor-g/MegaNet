// The 🧪 Path test planner on the Pass Ranges tab (alert-test.js), Node only.
//
//   Safe        an address is safe for a repeater when only it passes it on, no
//               station holds it in its area (a station in another hub does not
//               count), nothing is set aside, and a decommissioned repeater is
//               not "another repeater". Read through the real
//               AddressSpace.index(), the one the wheel and the grid use.
//   Choose      one ID: the middle of the roomiest runs; several: a run of
//               consecutive safe addresses, snug but with a spare at each end.
//   Fallback    a repeater whose every address is shared is told so, and the
//               nearest are named with who else carries them.
//   Fade margin the steps that arrive say: at least N dB, between N and M dB,
//               nothing arrived, and the band (good / fair / poor / unclear)
//               against the map's own thresholds; a step that arrives after a
//               lost one is flagged.
//   Arrivals    readings rows are counted per address (dup copies included),
//               and the query is bounded by received_at, never wider than a day.
//   The card    names the bases that hear the repeater, says a miss cannot tell
//               "it did not hear you" from "no base hears it", escapes names,
//               and every word has a meaning of its own.
//
// Run:  npm run alerttest
//       npm run alerttest -- -v    also print what passed

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

const stations = [
  { id: 'x', name: 'Mt Test', roles: ['repeater'], hub_id: 'brisbane', lat: -27, lon: 153,
    repeater: { pass_ranges: [{ low: 1000, high: 1099 }], exclusions: [{ low: 1040, high: 1044 }] } },
  { id: 'r2', name: 'Other Rptr', roles: ['repeater'], hub_id: 'brisbane', repeater: { pass_ranges: [{ low: 1050, high: 1199 }] } },
  { id: 'r3', name: 'Gone Rptr', roles: ['repeater'], hub_id: 'brisbane', decommissioned: true, repeater: { pass_ranges: [{ low: 1000, high: 1019 }] } },
  { id: 'r4', name: 'Far Rptr', roles: ['repeater'], hub_id: 'cairns', repeater: { pass_ranges: [{ low: 1010, high: 1012 }] } },
  { id: 'f1', name: 'Gauge One', roles: ['field'], hub_id: 'brisbane', sensors: [{ alert_id: 1030 }] },
  { id: 'f3', name: 'Cairns Gauge', roles: ['field'], hub_id: 'cairns', sensors: [{ alert_id: 1005 }] },
  { id: 'b1', name: 'Pi Base', roles: ['base'], hub_id: 'brisbane', lat: -27.1, lon: 153.1, sensors: [] },
  { id: 'y', name: 'Backbone Y', roles: ['repeater'], hub_id: 'brisbane', repeater: { pass_ranges: [{ low: 2000, high: 2010 }] } },
  { id: 'z', name: 'Backbone Z', roles: ['repeater'], hub_id: 'brisbane', repeater: { pass_ranges: [{ low: 2000, high: 2010 }] } },
  { id: 'w', name: 'Backbone W', roles: ['repeater'], hub_id: 'brisbane', repeater: { pass_ranges: [{ low: 2005, high: 2010 }] } },
  { id: 'evil', name: '<img src=x onerror=alert(1)>', roles: ['repeater'], hub_id: 'brisbane', repeater: { pass_ranges: [{ low: 3000, high: 3010 }] } },
];
const hubs = [{ id: 'brisbane', name: 'Brisbane Hub', ord: 1 }, { id: 'cairns', name: 'Cairns Hub', ord: 2 }];

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const store = {};
const ctx = vm.createContext({ console, Math, Number, String, Array, JSON, Object, Set, Map, Date, Error, Promise,
  isFinite, parseInt, parseFloat, window: {}, esc, escAttr: esc,
  termHtml: (t, m) => (m ? `<span class="term" title="${esc(m)}">${esc(t)}</span>` : esc(t)),
  state: { data: { stations, hubs, radio_networks: [] }, mapFadeGoodDb: 15, mapFadeOkDb: 6 },
  localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
  passRangeProto: () => ctx.__proto, __proto: 'alert',
  backboneIndex: () => ({ pairs: [{ kind: 'base', a: stations[0], b: stations[6], km: 15.4 }], cover: new Map(), offAir: [] }) });
const load = f => vm.runInContext(fs.readFileSync(repo(f), 'utf8') + `\n;this.${f === 'address-space.js' ? 'AddressSpace' : f === 'alert2-ids.js' ? 'Alert2Ids' : 'AlertTest'} = ${f === 'address-space.js' ? 'AddressSpace' : f === 'alert2-ids.js' ? 'Alert2Ids' : 'AlertTest'};`, ctx, { filename: f });
load('address-space.js'); load('alert2-ids.js'); load('alert-test.js');
const T = ctx.AlertTest, AS = ctx.AddressSpace;

console.log('\nSafe addresses\n');
const I = AS.index();
const C = T.candidates(I, 'x', ['brisbane']);
const exp = [];
for (let a = 1000; a <= 1099; a++) {
  if ((a >= 1040 && a <= 1044) || a >= 1050 || (a >= 1010 && a <= 1012) || a === 1030) continue;
  exp.push(a);
}
ok('only X passes it, nobody holds it, exclusions respected', J(C.safe) === J(exp), J(C.safe.slice(0, 12)));
ok('a decommissioned repeater is not "another repeater"', C.safe.includes(1000) && C.safe.includes(1019));
ok('another hub\'s repeater is another repeater (strict)', !C.safe.includes(1011));
ok('a station in X\'s hub holds 1030', !C.safe.includes(1030) && C.blocked.held === 1);
ok('a station in another hub does not block 1005', C.safe.includes(1005));
ok('the exclusion 1040–1044 is not X\'s to pass', !C.x.carried.includes(1042));
ok('shared ones name who else carries them', C.shared.find(s => s.a === 1060).others.join() === 'Other Rptr');
const C2 = T.candidates(I, 'x', ['brisbane', 'cairns']);
ok('asking both hubs, the Cairns holder blocks 1005', !C2.safe.includes(1005));
ok('an unknown repeater is null', T.candidates(I, 'nope', []) === null);
const Ias = { ...I, allocs: new Map([['brisbane', new Map([[1001, { alert_id: 1001 }]])]]) };
ok('a set-aside address is not safe', !T.candidates(Ias, 'x', ['brisbane']).safe.includes(1001) && T.candidates(Ias, 'x', ['brisbane']).blocked.setAside === 1);

console.log('\nChoosing\n');
ok('runs', J(T.runs([1, 2, 3, 7, 9, 10])) === J([{ lo: 1, hi: 3, n: 3 }, { lo: 7, hi: 7, n: 1 }, { lo: 9, hi: 10, n: 2 }]));
ok('one ID: the middle of each of the roomiest runs', J(T.choose(C.safe, 'one', 0, 5).ids) === J([1004, 1021, 1035, 1047]), J(T.choose(C.safe, 'one', 0, 5).ids));
ok('one ID: at most five', T.choose(Array.from({ length: 200 }, (_, i) => i * 3 + 1), 'one', 0, 5).ids.length === 5);
ok('several: a snug run with a spare each end, centred', J(T.choose(C.safe, 'steps', 5).ids) === J([1033, 1034, 1035, 1036, 1037]), J(T.choose(C.safe, 'steps', 5).ids));
ok('several: consecutive', T.choose(C.safe, 'steps', 5).consecutive === true);
const broken = T.choose([10, 11, 20, 21, 22, 40], 'steps', 5);
ok('several, no run long enough: the roomiest first, not consecutive', J(broken.ids) === J([10, 11, 20, 21, 22]) && broken.consecutive === false, J(broken));
ok('nothing safe: nothing chosen', T.choose([], 'one', 0, 5).ids.length === 0);
ok('steps', J(T.steps(5, 5, 0)) === J([0, 5, 10, 15, 20]) && T.steps(99, 5).length === 10 && T.steps(1, 5).length === 2);

console.log('\nFallback when every address is shared\n');
const CY = T.candidates(I, 'y', ['brisbane']);
ok('Backbone Y has nothing safe', CY.safe.length === 0);
ok('fewest-others first: 2000–2004 (Z) before 2005–2010 (Z, W)', CY.shared[0].a === 2000 && CY.shared[0].others.join() === 'Backbone Z' && CY.shared[CY.shared.length - 1].others.length === 2);

console.log('\nFade margin from the steps\n');
const D = [0, 5, 10, 15, 20];
const inf = got => T.infer(D, got, 15, 6);
ok('arrived to 10, lost at 15: between 10 and 15, fair', J(inf([0, 5, 10])) === J({ lo: 10, hi: 15, mixed: false, band: 'fair', all: false, none: false }), J(inf([0, 5, 10])));
ok('every step: at least 20, good', inf(D).all && inf(D).lo === 20 && inf(D).band === 'good');
ok('nothing: none', inf([]).none && inf([]).band === 'none');
ok('only 0: below the floor, poor', inf([0]).band === 'poor' && inf([0]).hi === 5);
ok('0 and 5: between 5 and 10 — not clear', inf([0, 5]).band === 'unclear');
ok('arrived to 15, lost at 20: good', inf([0, 5, 10, 15]).band === 'good');
ok('a step after a lost one is flagged', inf([0, 10]).mixed === true && inf([0, 10]).lo === 0 && inf([0, 10]).hi === 5);
ok('steps given out of order', T.infer([20, 0, 10, 5, 15], [0, 5], 15, 6).hi === 10);
ok('uses the map\'s own thresholds', T.infer(D, [0, 5], 12, 3).band === 'fair' && T.infer(D, [0, 5], 8, 3).band === 'unclear');

console.log('\nArrivals\n');
const rows = [
  { alert_id: 1004, received_at: '2026-11-27T01:00:05Z', path: 'serial-monitor/pi-1/stick-0', dup_count: 2, rssi_dbm: -98 },
  { alert_id: 1004, received_at: '2026-11-27T01:02:00Z', path: 'pi-2/stick-0', dup_count: 0, rssi_dbm: -91 },
  { alert_id: 1021, received_at: '2026-11-27T01:01:00Z', path: 'pi-1/stick-0' },
  { alert_id: 9999, received_at: '2026-11-27T01:01:00Z' },
];
const ar = T.arrivals(rows, [1004, 1021, 1035], 'alert_id');
ok('copies counted: 2 rows + 2 dups', ar.get(1004).n === 4);
ok('first, last, the paths without the prefix, the best signal', ar.get(1004).first === '2026-11-27T01:00:05Z' && ar.get(1004).last === '2026-11-27T01:02:00Z' && J(ar.get(1004).paths) === J(['pi-1/stick-0', 'pi-2/stick-0']) && ar.get(1004).rssi === -91);
ok('an address that did not arrive is there, empty', ar.get(1035).n === 0);
ok('a stray address is not counted', !ar.has(9999));
const now = Date.parse('2026-11-27T05:00:00Z');
const q = T.queryPath('alert', [1004, 1021], Date.parse('2026-11-27T04:00:00Z'), now);
ok('the query: legacy ALERT, these addresses, from the clock', q.startsWith('reading?received_at=gte.2026-11-27T04%3A00%3A00.000Z&protocol=eq.1&alert_id=in.(1004,1021)') && q.includes('limit=500'), q);
ok('the query never reaches back more than a day', T.queryPath('alert', [1], 0, now).includes('2026-11-26T05%3A00%3A00.000Z'));
ok('ALERT2 asks the ALERT2 column', T.queryPath('alert2', [60001], now - 1000, now).includes('protocol=eq.2&a2_station=in.(60001)'));

console.log('\nThe card\n');
ctx.AlertTest.set('x', 'x');
let html = T.cardHtml();
ok('the plan names the repeater and its safe addresses', html.includes('Mt Test') && html.includes('<th scope="row" class="tdp-num">1021</th>'));
ok('it says how many addresses are safe', /\b\d+ of them are/.test(html.replace(/<[^>]+>/g, '')));
ok('the base that hears it is named, with the distance', html.includes('Pi Base (15 km)'));
ok('a miss cannot tell "it did not hear you" from "no base hears it"', /no base hears/.test(html) && /does not have full coverage/.test(html));
ok('the check and the clock are on the card', html.includes('Check Flood-Net') && html.includes("I've started sending"));
T.set('mode', 'steps');
html = T.cardHtml();
ok('stepped: each address has its attenuation', html.includes('<td>0 dB</td>') && html.includes('<td>20 dB</td>') && html.includes('1033') && html.includes('1037'));
T.lock();
ok('locked: the clock is shown and Start over offered', T.cardHtml().includes('Start over') && T.cardHtml().includes('only messages received after that count'));
ok('locked: kept per device without the whole station in it', !store['mn-alert-test'].includes('Mt Test') && store['mn-alert-test'].includes('"ids":[1033'));
T.set('x', 'y');
ok('another repeater un-keeps them; no safe address says so and names who else carries the nearest', !T.cardHtml().includes('Start over') && /nearest to it/.test(T.cardHtml()) && T.cardHtml().includes('Backbone Z'));
T.set('x', 'evil');
ok('a repeater\'s name is escaped', !T.cardHtml().includes('<img') && T.cardHtml().includes('&lt;img'));
ctx.__proto = 'alert2'; T.set('x', 'x'); T.set('mode', 'one');
html = T.cardHtml();
ok('ALERT2: IDs from the free finder, and it says it cannot promise who relays', html.includes('60000') && /nobody uses/.test(html) && /cannot say that only/.test(html), html.replace(/<[^>]+>/g, ' ').slice(0, 400));

console.log('\nThe words\n');
ok('every word has a meaning of its own, a sentence long', Object.values(T.WORDS).every(m => typeof m === 'string' && m.length > 40 && /\.$/.test(m)));
ok('every meaning is in the key', Object.keys(T.WORDS).every(k => html.includes(T.WORDS[k].slice(0, 30)) || /^(attn|margin|band|direct|hub|setaside|clock|a2|safe|pass|others)$/.test(k)));

console.log(`\n${failures ? 'FAIL' : 'PASS'} — ${passes} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
