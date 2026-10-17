// The TDMA Planner tab (tdma-planner.js), held to the sources' figures and to
// the two frames worked by hand in its design.
//
// Node first: the module is loaded on its own in a vm, with no DOM and no
// state, so every number here is the protocol's arithmetic and nothing else.
//
//   Air time        the AirLink v1.1 blocking and FEC tables: a padded first
//                   block is 82 bytes and 228.33 ms of RF (Telos's "228 msec"),
//                   233.33 ms with the 5 ms tail; a 23rd byte opens a follow-on
//                   block; the captured ERT-A2 river report (25 B) is exactly
//                   300 ms; 54 bytes is a first block and one full follow-on
//                   (396.67 ms); 1023 bytes, the maximum, is 5.28 s.
//   Capacity        the largest payload a window carries: 54 bytes in a ½ s
//                   slot with 50 ms buffers (Telos's "a first block and a full
//                   follow-on"), 971 in Telos's 5 s repeater slot, 1023 from
//                   5.4 s; and the fewest slot units a load needs.
//   Frames          79 lengths divide 12 hours in 500 ms steps between 5 s and
//                   an hour, 61 of them 600 s or shorter; 7 and 11 s do not.
//   Reports         the ERT-A2's reports in MANT bytes — rain + battery 20,
//                   river 25, the quick start 28 (29 with path service), each
//                   sensor as its own PDU 61 — and a concentration PDU of m
//                   legacy records.
//   Sketches        a sketched network's shape: who is under whom, how deep.
//   Telos's frame   30 gauges and a repeater in 20 s: 30 half-second slots,
//                   then a 5 s repeater run of 948 of 950 bytes, the frame
//                   full, the worst report home in 40 s.
//   A 2-hop chain   2 repeaters × 12 stations in 60 s: the deeper repeater's
//                   run after its stations and before the nearer repeater's,
//                   38 of 120 slots used, the worst report home in 79 s.
//   The rules       the validity errors, overflow, ordering by name wrapping
//                   a frame, sectors splitting the runs, the ALOHA share and
//                   reserved slots, legacy concentration, the shortest frame
//                   that fits.
//   Over capacity   40 stations under one repeater: a run of 1,258 bytes that
//                   no frame carries, the remedy (2 repeater slots per frame)
//                   named, and the shortest frame at two is 27 s; 38 stations
//                   in 20 s leave the repeater no slot and the latency unknown.
//
// Then Chromium, over the real register:
//
//   The tab         its seven tiles, its timeline and its table, the heading;
//                   no "MegaNet" anywhere a person reads; a unit's sheet is
//                   drawn when its fold is opened.
//   The card        a slider works the plan again in place (on the next
//                   frame) and keeps its focus; a preset changes the figures
//                   and another puts them back; "Use it" takes the shortest
//                   frame.
//   The register    a repeater picked as a hub brings its stations, under a
//                   virtual base named for the nearest one; a base + repeater
//                   picked alone is the root.
//   The files       the two CSVs are floodnet-… and carry the plan.
//   Housekeeping    nothing is written silently; leaving and returning leaves
//                   one playhead; the animation stops with the tab.
//
// Run:  npm run tdma
//       npm run tdma -- -v    also print what passed

import fs from 'node:fs';
import vm from 'node:vm';
import { repo } from './lib/paths.mjs';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

let failures = 0, passes = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passes++; if (VERBOSE) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;
const J = x => JSON.stringify(x);
// A warning or error is a stable code, carried bare or as { code, text }.
const codes = list => (list || []).map(x => (typeof x === 'string' ? x : x && x.code));

// ═══════════════════════════════════════════════════════════════════════════
// Node: the module alone
// ═══════════════════════════════════════════════════════════════════════════

const ctx = vm.createContext({ console, Math, Number, String, Array, JSON, Object, Set, Map, Date, Error,
                               isFinite, parseInt, parseFloat, window: {} });
vm.runInContext(fs.readFileSync(repo('tdma-planner.js'), 'utf8') + '\n;this.TdmaPlanner = TdmaPlanner;', ctx, { filename: 'tdma-planner.js' });
const T = ctx.TdmaPlanner;
const { frameBytes, rfMs, airtimeMs, capacityBytes, unitsFor, validFrames, validate, reportBytes, concentrationBytes,
        sketchNetwork, allocate, suggestFrame } = T;
const DEF = T.defaults();
const byId = (plan, id) => plan.devices.find(d => d.id === id);

// ── air time ──
console.log('\nAir time\n');
ok('a padded first block is 82 frame bytes, for 0 and for 22 payload bytes', frameBytes(0) === 82 && frameBytes(22) === 82, `${frameBytes(0)}, ${frameBytes(22)}`);
ok('22 bytes are 228.33 ms of RF — Telos\'s "228 msec first block"', near(rfMs(22), 228.33), rfMs(22).toFixed(2));
ok('…and 233.33 ms on air with the 5 ms tail', near(airtimeMs(22), 233.33), airtimeMs(22).toFixed(2));
ok('a 23rd byte opens a 1-byte follow-on block: 118 bytes, 293.33 ms', frameBytes(23) === 118 && near(airtimeMs(23), 293.33), `${frameBytes(23)}, ${airtimeMs(23).toFixed(2)}`);
ok('the captured ERT-A2 river report, 25 bytes, is exactly 300 ms', near(airtimeMs(25), 300, 1e-6), airtimeMs(25).toFixed(4));
ok('the quick-start report is 310 ms without the path count byte and 313.33 with it', near(airtimeMs(28), 310) && near(airtimeMs(29), 313.33), `${airtimeMs(28).toFixed(2)}, ${airtimeMs(29).toFixed(2)}`);
ok('53 bytes: 178 frame bytes, 388.33 ms of RF', frameBytes(53) === 178 && near(rfMs(53), 388.33), `${frameBytes(53)}, ${rfMs(53).toFixed(2)}`);
ok('54 bytes — a first block and one full follow-on — is 180 frame bytes, 391.67 ms RF, 396.67 ms on air',
  frameBytes(54) === 180 && near(rfMs(54), 391.67) && near(airtimeMs(54), 396.67), `${frameBytes(54)}, ${rfMs(54).toFixed(2)}, ${airtimeMs(54).toFixed(2)}`);
ok('the 55th byte begins a second follow-on block: 453.33 ms', near(airtimeMs(55), 453.33), airtimeMs(55).toFixed(2));
ok('100, 200 and 500 bytes are 656.67, 1150 and 2630 ms', near(airtimeMs(100), 656.67) && near(airtimeMs(200), 1150) && near(airtimeMs(500), 2630),
  [100, 200, 500].map(p => airtimeMs(p).toFixed(2)).join(', '));
ok('the 1023-byte maximum is 3110 frame bytes and 5.28 s on air', frameBytes(1023) === 3110 && near(airtimeMs(1023), 5280), `${frameBytes(1023)}, ${airtimeMs(1023).toFixed(2)}`);
ok('with the IND API\'s own defaults (carrier 10, AGC 55) the 22-byte frame is 223.33 ms — 10 ms under Telos\'s 60 + 15',
  near(airtimeMs(22, { carrierMs: 10, agcMs: 55 }), 223.33), airtimeMs(22, { carrierMs: 10, agcMs: 55 }).toFixed(2));

// ── capacity ──
console.log('\nCapacity\n');
ok('a 400 ms window carries 54 bytes — a first block and a full follow-on, with 3.33 ms to spare', capacityBytes(400) === 54, String(capacityBytes(400)));
ok('exactly 300 ms carries the 25-byte report (the floating-point edge)', capacityBytes(300) === 25, String(capacityBytes(300)));
ok('900 ms carries 150 bytes', capacityBytes(900) === 150, String(capacityBytes(900)));
ok('1900 and 2000 ms carry 345 and 374 — Telos\'s 2 s concentrator slot, 84 records', capacityBytes(1900) === 345 && capacityBytes(2000) === 374, `${capacityBytes(1900)}, ${capacityBytes(2000)}`);
ok('2400 and 4400 ms carry 447 and 854 — runs of 5 and 9 half-second units', capacityBytes(2400) === 447 && capacityBytes(4400) === 854, `${capacityBytes(2400)}, ${capacityBytes(4400)}`);
ok('4900 and 5000 ms carry 950 and 971 — Telos\'s 5 s repeater slot', capacityBytes(4900) === 950 && capacityBytes(5000) === 971, `${capacityBytes(4900)}, ${capacityBytes(5000)}`);
ok('5400 ms reaches the 1023-byte cap', capacityBytes(5400) === 1023, String(capacityBytes(5400)));
ok('the maximum frame needs 11 half-second units (a 5.5 s slot)', unitsFor(1023, 500, 50) === 11, String(unitsFor(1023, 500, 50)));
ok('948, 390 and 806 bytes need 10, 5 and 9 units — the worked examples\' repeater runs',
  unitsFor(948, 500, 50) === 10 && unitsFor(390, 500, 50) === 5 && unitsFor(806, 500, 50) === 9,
  [948, 390, 806].map(b => unitsFor(b, 500, 50)).join(', '));

// ── frames ──
console.log('\nFrames\n');
const VF = validFrames();
ok('79 frame lengths divide 12 hours, 61 of them 600 s or shorter', VF.length === 79 && VF.filter(f => f <= 600000).length === 61, `${VF.length}, ${VF.filter(f => f <= 600000).length}`);
ok('20, 60 and 120 s are among them', [20000, 60000, 120000].every(f => VF.includes(f)));
ok('7 s and 11 s do not divide 12 hours, and 4.5 s is under the 5 s minimum', ![7000, 11000, 4500].some(f => VF.includes(f)));
ok('they are ascending and every one a multiple of 500 ms between 5 s and an hour',
  VF.every((f, i) => f % 500 === 0 && f >= 5000 && f <= 3600000 && (i === 0 || f > VF[i - 1]) && 43200000 % f === 0));

// ── reports ──
console.log('\nReports\n');
ok('rain + battery is 20 bytes, river 25, the ERT-A2 quick start 28 (29 with path service), a weather station 43',
  reportBytes('rain', 0, false) === 20 && reportBytes('river', 0, false) === 25 && reportBytes('quick', 0, false) === 28
  && reportBytes('quick', 0, true) === 29 && reportBytes('weather', 0, false) === 43,
  ['rain', 'river', 'quick', 'weather'].map(k => reportBytes(k, 0, false)).join(', '));
ok('a repeater\'s housekeeping report with path service is 18 bytes', reportBytes('housekeeping', 0, true) === 18, String(reportBytes('housekeeping', 0, true)));
ok('two extra 2-byte sensors add 8: 36 bytes', reportBytes('quick', 2, false) === 36, String(reportBytes('quick', 2, false)));
ok('each sensor as its own PDU, as the ERT-A2 capture reported: 61 bytes, 65 with path service',
  reportBytes('quick', 0, false, { perSensor: true }) === 61 && reportBytes('quick', 0, true, { perSensor: true }) === 65,
  `${reportBytes('quick', 0, false, { perSensor: true })}, ${reportBytes('quick', 0, true, { perSensor: true })}`);
ok('3 legacy records concentrate into 21 bytes (the first block), 11 into 53', concentrationBytes(3, false) === 21 && concentrationBytes(11, false) === 53,
  `${concentrationBytes(3, false)}, ${concentrationBytes(11, false)}`);

// ── sketches ──
console.log('\nSketches\n');
const SK = (o) => ({ skRepeaters: 2, skDepth: 2, skFieldPer: 12, skDirect: 0, skLegacyPer: 0, ...o });
const chainNet = sketchNetwork(SK({}));
ok('2 repeaters, 2 deep, 12 stations each: 27 devices, r2 under r1, the deepest station 3 down',
  chainNet.devices.length === 27 && chainNet.devices.find(d => d.id === 'r2').parents[0] === 'r1' && chainNet.maxDepth === 3,
  `${chainNet.devices.length} devices, maxDepth ${chainNet.maxDepth}`);
const four = sketchNetwork(SK({ skRepeaters: 4, skFieldPer: 0 }));
ok('4 repeaters, 2 deep: r3 under r1 and r4 under r2', four.devices.find(d => d.id === 'r3').parents[0] === 'r1' && four.devices.find(d => d.id === 'r4').parents[0] === 'r2');
const direct = sketchNetwork(SK({ skRepeaters: 0, skDepth: 1, skFieldPer: 0, skDirect: 5 }));
ok('no repeater and 5 stations heard straight by the base: 5 field devices at depth 1',
  direct.devices.filter(d => d.role === 'field').length === 5 && direct.devices.filter(d => d.role === 'field').every(d => d.depth === 1 && d.parents[0] === 'base'));

// ── Telos's frame ──
console.log('\nTelos\'s frame: 30 gauges, one repeater, 20 s\n');
const telosSet = { ...DEF, frameMs: 20000, slotMs: 500, bufferMs: 50, carrierMs: 60, agcMs: 15, sectors: 1, fieldEvery: false, order: 'hops',
                   kind: 'quick', extraSensors: 0, reportsPerFrame: 1, repeaterOwn: 'housekeeping', path: true, spareTarget: 0, reservedSlots: 0, alohaShare: 0 };
const telosNet = sketchNetwork({ skRepeaters: 1, skDepth: 1, skFieldPer: 30, skDirect: 0, skLegacyPer: 0 });
const P1 = allocate(telosNet, telosSet);
const f1 = Array.from({ length: 30 }, (_, i) => byId(P1, `r1-f${String(i + 1).padStart(2, '0')}`));
ok('the plan is valid and every device has a row', P1.valid !== false && f1.every(Boolean) && !!byId(P1, 'r1'), J(codes(P1.errors)));
ok('every station has one half-second slot in order: unit i, offset 500·i, a 400 ms window, 54 bytes of capacity for its 29',
  f1.every((d, i) => d.slots.length === 1 && d.slots[0].unit === i && d.slots[0].offsetMs === 500 * i && d.slots[0].lengthMs === 500
    && d.slots[0].windowMs === 400 && d.slots[0].capacityBytes === 54 && d.slots[0].peakBytes === 29),
  J(f1.slice(0, 2).map(d => d.slots[0])));
const r1t = byId(P1, 'r1');
ok('the repeater\'s run is slots 30–39: 15 s in, 5 s long, a 4900 ms window, 948 of 950 bytes',
  r1t.slots.length === 1 && r1t.slots[0].unit === 30 && r1t.slots[0].units === 10 && r1t.slots[0].offsetMs === 15000 && r1t.slots[0].lengthMs === 5000
  && r1t.slots[0].windowMs === 4900 && r1t.slots[0].capacityBytes === 950 && r1t.slots[0].peakBytes === 948, J(r1t.slots[0]));
ok('…4870 ms on air, and within 10 % of capacity', near(r1t.slots[0].airMs, 4870) && codes(r1t.warnings).includes('W_NEAR_CAPACITY'), `${r1t.slots[0].airMs}, ${J(codes(r1t.warnings))}`);
ok('the frame is 40 slots, all used, none spare', P1.summary.units === 40 && P1.summary.used === 40 && P1.summary.spare === 0, J({ units: P1.summary.units, used: P1.summary.used, spare: P1.summary.spare }));
ok('the worst report home in 40 s is the first station\'s', P1.summary.worstLatencyS === 40 && P1.summary.worstDeviceId === 'r1-f01', `${P1.summary.worstLatencyS} s at ${P1.summary.worstDeviceId}`);
ok('the last station\'s report is home in 25.5 s and the repeater\'s own in 25', near(f1[29].latencyS, 25.5, 1e-6) && near(r1t.latencyS, 25, 1e-6), `${f1[29].latencyS}, ${r1t.latencyS}`);
ok('hop limit 1 for the stations, 0 for the repeater', f1.every(d => d.hopLimit === 1) && r1t.hopLimit === 0);

// ── a 2-hop chain ──
console.log('\nA 2-hop chain: 2 repeaters × 12 stations, 60 s\n');
const chainSet = { ...telosSet, frameMs: 60000, spareTarget: 20 };
const P2 = allocate(chainNet, chainSet);
const r2c = byId(P2, 'r2'), r1c = byId(P2, 'r1');
const g = (id) => byId(P2, id);
ok('r2\'s run is slots 12–16: a 2400 ms window, 390 of 447 bytes',
  r2c.slots.length === 1 && r2c.slots[0].unit === 12 && r2c.slots[0].units === 5 && r2c.slots[0].windowMs === 2400 && r2c.slots[0].capacityBytes === 447 && r2c.slots[0].peakBytes === 390, J(r2c.slots[0]));
ok('r1\'s run is slots 29–37: a 4400 ms window, 806 of 854 bytes',
  r1c.slots.length === 1 && r1c.slots[0].unit === 29 && r1c.slots[0].units === 9 && r1c.slots[0].windowMs === 4400 && r1c.slots[0].capacityBytes === 854 && r1c.slots[0].peakBytes === 806, J(r1c.slots[0]));
ok('r1\'s first station follows r2\'s run: slot 17, 8.5 s in', g('r1-f01').slots[0].unit === 17 && g('r1-f01').slots[0].offsetMs === 8500, J(g('r1-f01').slots[0]));
ok('38 of 120 slots used, 82 spare, the worst report home in 79 s over 2 hops, room for about one more station',
  P2.summary.used === 38 && P2.summary.spare === 82 && P2.summary.worstLatencyS === 79 && P2.summary.maxHops === 2 && P2.summary.headroomStations === 1,
  J({ used: P2.summary.used, spare: P2.summary.spare, worst: P2.summary.worstLatencyS, hops: P2.summary.maxHops, room: P2.summary.headroomStations }));
const lat = ['r2-f01', 'r2-f12', 'r2', 'r1-f01', 'r1-f12', 'r1'].map(id => g(id).latencyS);
ok('latencies 79 / 73.5 / 73 / 70.5 / 65 / 64.5 s from the deepest station to the nearest repeater',
  lat.every((v, i) => near(v, [79, 73.5, 73, 70.5, 65, 64.5][i], 1e-6)), lat.join(' / '));
ok('hop limits 2 / 1 / 1 / 0', g('r2-f01').hopLimit === 2 && r2c.hopLimit === 1 && g('r1-f01').hopLimit === 1 && r1c.hopLimit === 0);
ok('r1 is within 10 % of capacity and says so; r2 is not', codes(r1c.warnings).includes('W_NEAR_CAPACITY') && !codes(r2c.warnings).includes('W_NEAR_CAPACITY'), J(codes(r1c.warnings)));
ok('the runs are 2103.33 and 4183.33 ms on air', near(r2c.slots[0].airMs, 2103.33) && near(r1c.slots[0].airMs, 4183.33), `${r2c.slots[0].airMs}, ${r1c.slots[0].airMs}`);

// ── the rules ──
console.log('\nThe rules\n');
const V = (o) => validate({ ...DEF, ...o });
ok('the defaults validate with no error', V({}).errors.length === 0, J(codes(V({}).errors)));
ok('a 7 s frame does not divide 12 hours', codes(V({ frameMs: 7000, slotMs: 500 }).errors).includes('E_FRAME_INVALID'), J(codes(V({ frameMs: 7000 }).errors)));
const v750 = V({ frameMs: 20000, slotMs: 750 });
ok('20 s is not a whole number of 750 ms slots, and an odd 250 ms slot misaligns the AL200', codes(v750.errors).includes('E_FRAME_SLOT') && codes(v750.warnings).includes('W_SLOT_250'), J([codes(v750.errors), codes(v750.warnings)]));
ok('a 400 ms slot is under the 500 ms minimum', codes(V({ slotMs: 400 }).errors).includes('E_SLOT_RANGE'));
ok('a 20 ms buffer is under the 25 ms minimum', codes(V({ bufferMs: 20 }).errors).includes('E_BUFFER'));
ok('carrier and AGC off the Telos values are flagged', codes(V({ carrierMs: 10, agcMs: 55 }).warnings).includes('W_IND_DEFAULTS'));
const PO = allocate(sketchNetwork({ skRepeaters: 1, skDepth: 1, skFieldPer: 60, skDirect: 0, skLegacyPer: 0 }), telosSet);
const allCodes = p => codes([...(p.errors || []), ...(p.warnings || []), ...((p.summary && p.summary.warnings) || [])]);
ok('60 stations and their repeater do not fit 40 slots: E_OVERFLOW, with transmitters unplaced',
  allCodes(PO).includes('E_OVERFLOW') && PO.devices.some(d => d.unplaced), J(allCodes(PO)));
const PN = allocate(chainNet, { ...chainSet, order: 'name' });
ok('ordered by name a repeater comes before its stations, so a report waits a frame: W_WRAP, and a worse latency than the hop order',
  PN.devices.some(d => codes(d.warnings).includes('W_WRAP')) && PN.summary.worstLatencyS > P2.summary.worstLatencyS, `${PN.summary.worstLatencyS} s against ${P2.summary.worstLatencyS}`);
const PS = allocate(chainNet, { ...chainSet, sectors: 2 });
ok('two sectors split r2 into two runs of 3 units and r1 into two of 5, and the worst report is home sooner',
  byId(PS, 'r2').slots.length === 2 && byId(PS, 'r2').slots.every(s => s.units === 3) && byId(PS, 'r1').slots.length === 2 && byId(PS, 'r1').slots.every(s => s.units === 5)
  && PS.summary.worstLatencyS < P2.summary.worstLatencyS, J({ r2: byId(PS, 'r2').slots.map(s => s.units), r1: byId(PS, 'r1').slots.map(s => s.units), worst: PS.summary.worstLatencyS }));
const PE = allocate(chainNet, { ...chainSet, sectors: 2, fieldEvery: true });
ok('…and with field stations in every sector each has two slots', PE.devices.filter(d => d.role === 'field').every(d => d.slots.length === 2));
const PA = allocate(chainNet, { ...chainSet, alohaShare: 25, reservedSlots: 2 });
ok('a 25 % ALOHA share and 2 reserved slots leave 88 of 120 to allocate, and mixing ALOHA is flagged',
  PA.summary.alohaUnits === 30 && PA.summary.reservedUnits === 2 && PA.summary.units - PA.summary.alohaUnits - PA.summary.reservedUnits === 88 && allCodes(PA).includes('W_SHARED'),
  J({ aloha: PA.summary.alohaUnits, reserved: PA.summary.reservedUnits, units: PA.summary.units, codes: allCodes(PA) }));
const legNet = sketchNetwork(SK({ skFieldPer: 0, skLegacyPer: 15 }));
const PL = allocate(legNet, { ...chainSet, legacyPerMin: 1 });
ok('15 legacy gauges a repeater at a reading a minute in a 60 s frame: each run carries a 15-record concentration PDU',
  byId(PL, 'r2').peakBytes === concentrationBytes(15, true) + reportBytes('housekeeping', 0, true)
  && byId(PL, 'r1').peakBytes === concentrationBytes(15, true) + reportBytes('housekeeping', 0, true) + byId(PL, 'r2').peakBytes + 4,
  J({ r2: byId(PL, 'r2').peakBytes, r1: byId(PL, 'r1').peakBytes, conc: concentrationBytes(15, true) }));
ok('an hour-long frame makes a legacy reading wait longer than its 255 s offset allows: E_CONC_WAIT',
  allCodes(allocate(legNet, { ...chainSet, frameMs: 3600000, legacyPerMin: 1 })).includes('E_CONC_WAIT'));
ok('the shortest frame that fits Telos\'s 30 gauges with nothing spare is 20 s', suggestFrame(telosNet, telosSet) === 20000, String(suggestFrame(telosNet, telosSet)));
const sugg = suggestFrame(chainNet, DEF);
ok('…and the defaults\' network fits a frame under 120 s with 20 % spare', sugg !== null && sugg < 120000 && VF.includes(sugg), String(sugg));

// ── over capacity, and a repeater with no slot ──
console.log('\nOver capacity, and a repeater with no slot\n');
const net40 = sketchNetwork({ skRepeaters: 1, skDepth: 1, skFieldPer: 40, skDirect: 0, skLegacyPer: 0 });
const set40 = { ...telosSet, frameMs: 32000 };
const P40 = allocate(net40, set40), r40 = byId(P40, 'r1');
ok('40 stations under one repeater: its run is 1,258 of 1,023 bytes — over capacity — and the remedy is 2 runs, said in the warning',
  r40.slots[0].peakBytes === 1258 && r40.slots[0].capacityBytes === 1023 && r40.runsNeeded === 2 && P40.summary.runsNeeded === 2 && P40.summary.overCapacity === 1
  && /needs 2 runs of ≤ 1023 bytes: raise Repeater slots per frame to 2/.test((r40.warnings.find(w => w.code === 'W_OVER_CAPACITY') || {}).text || ''),
  J({ slot: r40.slots[0], k: r40.runsNeeded, w: r40.warnings.map(w => w.text) }));
ok('…so no frame fits at one repeater slot per frame; at two the shortest is 27 s, both runs under capacity',
  suggestFrame(net40, set40) === null && suggestFrame(net40, { ...set40, sectors: 2 }) === 27000 && allocate(net40, { ...set40, sectors: 2, frameMs: 27000 }).summary.overCapacity === 0,
  `${suggestFrame(net40, set40)}, ${suggestFrame(net40, { ...set40, sectors: 2 })}`);
const P38 = allocate(sketchNetwork({ skRepeaters: 1, skDepth: 1, skFieldPer: 38, skDirect: 0, skLegacyPer: 0 }), telosSet);
const s38 = byId(P38, 'r1-f01');
ok('38 stations in 20 s leave the repeater no slot: a station\'s latency is unknown and names the repeater, and so is the frame\'s worst',
  byId(P38, 'r1').unplaced === true && s38.latencyS === null && s38.noSlotAt === 'Repeater 1' && P38.summary.worstLatencyS === null && P38.summary.latencyUnknownAt === 'Repeater 1'
  && Array.isArray(s38.trace) && s38.trace[s38.trace.length - 1].noSlot === true,
  J({ unplaced: byId(P38, 'r1').unplaced, lat: s38.latencyS, at: s38.noSlotAt, worst: P38.summary.worstLatencyS, unknown: P38.summary.latencyUnknownAt }));
ok('a run within capacity needs one run; W_LONG_RUN is gone and so is TX_START_MS', r1t.runsNeeded === 1 && !JSON.stringify([P1, P2, P40]).includes('W_LONG_RUN') && !('TX_START_MS' in T.PROTO));

// ═══════════════════════════════════════════════════════════════════════════
// Chromium: the tab
// ═══════════════════════════════════════════════════════════════════════════

const server = await startServer();
const browser = await launchBrowser();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await applyNetworkPolicy(page, server.origin);

try {
  await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => { try { localStorage.removeItem('meganet.tdma.scenario'); } catch (_) {} });

  // ── the tab ──
  console.log('\nThe tab\n');
  await page.evaluate(() => switchTab('tdma'));
  await page.waitForFunction(() => !!document.getElementById('tdp-out'), null, { timeout: 20_000 });
  const drawn = await page.evaluate(() => ({
    kpis: document.querySelectorAll('#tdp-kpis .adm-kpi').length,
    out: !!document.getElementById('tdp-out'),
    fields: document.querySelectorAll('svg.tdp-anim .tdp-slot-field').length,
    reps: document.querySelectorAll('svg.tdp-anim .tdp-slot-rep').length,
    rows: document.querySelectorAll('.tdp-plan-table tbody tr:not(.tdp-total) th[scope="row"]').length,
    heading: [...document.querySelectorAll('#main-content h2')].map(h => h.textContent).join(' | '),
    mega: /MegaNet/.test(document.getElementById('main-content').textContent),
    circle: document.querySelectorAll('#tdp-circle svg path').length,
    journey: !!document.getElementById('tdp-follow'),
    headers: [...document.querySelectorAll('.tdp-plan-table thead th')].map(th => th.scrollWidth <= th.clientWidth + 1),
    cols: document.querySelectorAll('.tdp-plan-table colgroup col').length,
  }));
  ok('seven tiles, the live region, and a timeline with field and repeater runs', drawn.kpis === 7 && drawn.out && drawn.fields >= 1 && drawn.reps >= 1, J(drawn));
  ok('the slot plan has a row for the base, the two repeaters and the 24 stations', drawn.rows === 27, `${drawn.rows} row(s)`);
  ok('the heading names the TDMA Planner, and nothing a person reads says MegaNet', /TDMA Planner/.test(drawn.heading) && !drawn.mega, drawn.heading);
  ok('the circle has its arcs and the journey its picker', drawn.circle >= 1 && drawn.journey, `${drawn.circle} arc(s)`);
  ok('the slot plan\'s twelve columns each have a <col>, and every header reads in full at 1440', drawn.cols === 12 && drawn.headers.length === 12 && drawn.headers.every(Boolean), J({ cols: drawn.cols, headers: drawn.headers }));
  const lazy = await page.evaluate(async () => {
    const ds = [...document.querySelectorAll('#tdp-out details.tdp-sheet-d')];
    const before = document.querySelectorAll('#tdp-out details.tdp-sheet-d table').length;
    const shut = ds.find(d => !d.open && !/— base\b/.test(d.querySelector('summary').textContent));
    shut.open = true;
    await new Promise(r => setTimeout(r, 0));
    const after = document.querySelectorAll('#tdp-out details.tdp-sheet-d table').length;
    const rows = shut.querySelectorAll('tbody tr').length;
    shut.open = false;
    return { total: ds.length, before, after, rows };
  });
  ok('the sheet has a fold per device, only the first drawn; opening another draws its table', lazy.total === 27 && lazy.before === 1 && lazy.after === 2 && lazy.rows >= 10, J(lazy));

  // ── the card ──
  // A slider's repaint is coalesced under one animation frame, and the
  // shortest-frame tile is worked after it, so every look waits a frame.
  console.log('\nThe card\n');
  const slid = await page.evaluate(async () => {
    const tick = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
    const el = document.getElementById('tdp-c-bufferMs');
    el.focus();
    el.value = '100';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    const field = TdmaPlanner.plan().devices.find(d => d.role === 'field');
    const wide = field.slots[0].lengthMs;
    const out = document.getElementById('tdp-c-bufferMs-o').textContent;
    const focused = document.activeElement && document.activeElement.id;
    const strip = (document.querySelector('.tdp-detail figcaption') || {}).textContent || '';
    el.value = '50';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    const back = TdmaPlanner.plan().devices.find(d => d.role === 'field').slots[0].lengthMs;
    return { focused, out, wide, back, buffer: TdmaPlanner.scenario().bufferMs, strip: /100 ms buffers/.test(strip) };
  });
  ok('a slider works the plan again in place on the next frame and keeps its focus', slid.focused === 'tdp-c-bufferMs' && /100 ms/.test(slid.out) && slid.strip, J({ focused: slid.focused, out: slid.out, strip: slid.strip }));
  ok('a 100 ms buffer leaves a 300 ms window — 25 bytes, short of 29 — so a station needs two units; back at 50 it needs one',
    slid.wide === 1000 && slid.back === 500 && slid.buffer === 50, J(slid));
  const named0 = await page.evaluate(() => floodnetName.count || 0);
  const pre = await page.evaluate(async () => {
    const tick = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
    TdmaPlanner.preset('telos');
    await tick();
    const S = TdmaPlanner.plan().summary;
    const tile = (re) => ([...document.querySelectorAll('#tdp-kpis .adm-kpi')].find(t => re.test(t.textContent)) || {}).textContent || '';
    const worst = tile(/Worst latency/), shortest = tile(/Shortest frame that fits/);
    TdmaPlanner.preset('review');
    await tick();
    return { frame: S.frameMs, used: S.used, spare: S.spare, worst: /(^|\D)40(\.0)? s/.test(worst), source: TdmaPlanner.scenario().source,
             back: TdmaPlanner.plan().summary.frameMs, shortest: /(^|\D)20 s/.test(shortest) && /already the shortest/.test(shortest) };
  });
  ok('the Telos preset is 20 s, 40 slots used and none spare, the tile says 40 s, and 20 s is already the shortest frame', pre.frame === 20000 && pre.used === 40 && pre.spare === 0 && pre.worst && pre.shortest, J(pre));
  ok('…and "Network Review default" puts the frame back to 120 s, the source a sketch', pre.back === 120000 && pre.source === 'sketch', String(pre.back));
  const use = await page.evaluate(async () => {
    const tick = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
    TdmaPlanner.preset('telos');
    TdmaPlanner.set('frameMs', 60000);
    await tick();
    const before = TdmaPlanner.scenario().frameMs;
    const tile = ([...document.querySelectorAll('#tdp-kpis .adm-kpi')].find(t => /Shortest frame that fits/.test(t.textContent)) || {}).textContent || '';
    const hadButton = !!document.querySelector('#tdp-sug button');
    TdmaPlanner.useSuggested();
    await tick();
    const after = TdmaPlanner.scenario().frameMs;
    const focused = document.activeElement && document.activeElement.id;
    TdmaPlanner.set('skFieldPer', 40);
    await tick(); await tick();
    const noFit = ([...document.querySelectorAll('#tdp-kpis .adm-kpi')].find(t => /Shortest frame that fits/.test(t.textContent)) || {}).textContent || '';
    const noFitButton = !!document.querySelector('#tdp-sug button');
    const room = ([...document.querySelectorAll('#tdp-kpis .adm-kpi')].find(t => /Room for/.test(t.textContent)) || {}).textContent || '';
    TdmaPlanner.preset('review');
    return { before, after, tile: /(^|\D)20 s/.test(tile), hadButton, focused, noFit, noFitButton, room };
  });
  ok('the shortest frame that fits Telos\'s network is offered as 20 s with a button; "Use it" takes it and leaves the focus on the frame select',
    use.before === 60000 && use.after === 20000 && use.tile && use.hadButton && use.focused === 'tdp-c-frameMs', J(use));
  ok('with 40 stations under the repeater no frame fits at one repeater slot per frame: the tile says so, needs 2, offers no button, and "Room for" names the remedy',
    /No frame fits at 1 repeater slot per frame — needs 2/.test(use.noFit) && !use.noFitButton && /needs 2 runs of ≤ 1023 bytes: raise Repeater slots per frame to 2/.test(use.room), J({ noFit: use.noFit, button: use.noFitButton, room: use.room }));
  const named1 = await page.evaluate(() => floodnetName.count || 0);
  ok('nothing is written silently by a slider or a preset', named1 === named0, `${named1 - named0} file(s)`);

  // ── the register ──
  console.log('\nThe register\n');
  const reg = await page.evaluate(async () => {
    const tick = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
    const idx = passRelationIndex();
    const hasBase = id => { const s = state.data.stations.find(x => x.id === id); return !!(s && s.roles && s.roles.includes('base')); };
    // The repeater with the most stations in its pass ranges that is not also a base.
    let pick = null, most = 0;
    for (const [id, list] of idx.byRepeater) { if (!hasBase(id) && list.length > most) { most = list.length; pick = id; } }
    const tilesBefore = document.querySelector('#tdp-kpis').textContent;
    TdmaPlanner.source('register');
    TdmaPlanner.pickHub(pick);
    await tick();
    const N = TdmaPlanner.network();
    const rep = N.devices.find(d => d.id === pick);
    const fields = N.devices.filter(d => d.role === 'field' && d.parents[0] === pick);
    const table = document.querySelector('.tdp-plan-table').textContent;
    const tilesAfter = document.querySelector('#tdp-kpis').textContent;
    const pickedTxt = (document.getElementById('tdp-hubs-n') || {}).textContent;
    const virtual = N.devices.find(d => d.id === 'base:virtual');
    const noBase = N.notes.some(n => n.code === 'W_NO_BASE');
    TdmaPlanner.unpickHub(pick);
    await tick();
    const N2 = TdmaPlanner.network();
    // A base + repeater picked alone is the root.
    TdmaPlanner.pickHub('constitution_hill');
    await tick();
    const N3 = TdmaPlanner.network(), P3 = TdmaPlanner.plan();
    const ch = N3.devices.find(d => d.id === 'constitution_hill');
    const chRow = P3.devices.find(d => d.id === 'constitution_hill');
    const pickedTxt2 = (document.getElementById('tdp-hubs-n') || {}).textContent;
    TdmaPlanner.unpickHub('constitution_hill');
    await tick();
    TdmaPlanner.source('sketch');
    return { pick, most, source: N.source, depth: rep && rep.depth, role: rep && rep.role, fields: fields.length,
             named: fields.length > 0 && table.includes(fields[0].name), changed: tilesBefore !== tilesAfter, pickedTxt, pickedTxt2,
             virtual: virtual ? virtual.name : null, noBase,
             left: N2.devices.filter(d => d.parents && d.parents[0] === pick).length, hubs: TdmaPlanner.scenario().regHubs.length,
             ch: ch ? { role: ch.role, depth: ch.depth, fields: N3.devices.filter(d => d.role === 'field' && d.parents[0] === 'constitution_hill').length, flags: ch.flags,
                        noBase: N3.notes.some(n => n.code === 'W_NO_BASE'), virtual: N3.devices.some(d => d.id === 'base:virtual'),
                        said: !!chRow && chRow.warnings.some(w => w.code === 'I_BASE_REPEATER'), reps: P3.devices.filter(d => d.role === 'repeater').length } : null };
  });
  ok('a repeater picked as a hub (one without the base role) is a repeater at depth 1 and its stations come with it', reg.source === 'register' && reg.role === 'repeater' && reg.depth === 1 && reg.fields >= 1, J(reg));
  ok('…the table shows a station\'s name, the tiles changed and the picker says "1 picked"', reg.named && reg.changed && reg.pickedTxt === '1 picked', J({ named: reg.named, changed: reg.changed, picked: reg.pickedTxt }));
  ok('…with no base picked it hangs under a virtual base named for the nearest base in the register, and the network says "No base picked"',
    /^Base \(not picked — assumed .+, \d+ km\)$/.test(reg.virtual || '') && reg.noBase, J({ virtual: reg.virtual, noBase: reg.noBase }));
  ok('unpicking it empties the network', reg.left === 0, J({ left: reg.left }));
  ok('Constitution Hill — a base + repeater — picked alone is the root at depth 0 with at least 100 field stations straight under it, no virtual base, no "No base picked", and its row says why',
    !!reg.ch && reg.ch.role === 'base' && reg.ch.depth === 0 && reg.ch.fields >= 100 && !reg.ch.virtual && !reg.ch.noBase && reg.ch.said && reg.pickedTxt2 === '1 picked' && reg.hubs === 0, J(reg.ch));

  // ── the files ──
  console.log('\nThe files\n');
  const nTx = await page.evaluate(() => TdmaPlanner.plan().devices.filter(d => d.role !== 'base' && !d.legacyAloha).length);
  const [csv] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => TdmaPlanner.exportCsv())]);
  const text = fs.readFileSync(await csv.path(), 'utf8');
  const rows = text.split(/\r?\n/);
  const blank = rows.indexOf('');
  const dataRows = (blank < 0 ? rows : rows.slice(0, blank)).slice(1).filter(Boolean).length;
  ok('the slot plan is floodnet-tdma-plan-…s.csv, a row a transmitter, then the settings',
    /^floodnet-tdma-plan-\d+s\.csv$/.test(csv.suggestedFilename()) && /^Device,Role,Hops,Slots/.test(rows[0]) && dataRows === nTx && /Setting,Value/.test(text),
    `${csv.suggestedFilename()}, ${dataRows} row(s) for ${nTx} transmitter(s)`);
  const [sheet] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => TdmaPlanner.exportSheetCsv())]);
  const sheetText = fs.readFileSync(await sheet.path(), 'utf8');
  ok('the configuration sheet is floodnet-tdma-config-sheet-…s.csv with the IND API\'s names and the ERT-A2\'s honesty',
    /^floodnet-tdma-config-sheet-\d+s\.csv$/.test(sheet.suggestedFilename()) && sheetText.includes('TDMA Slot Length') && sheetText.includes('not in the documented menus'),
    sheet.suggestedFilename());

  // ── housekeeping ──
  console.log('\nHousekeeping\n');
  const hk = await page.evaluate(async () => {
    TdmaPlanner.toggle();
    const playing = TdmaPlanner.playing();
    switchTab('stations');
    const stopped = TdmaPlanner.playing();
    switchTab('tdma');
    await new Promise(r => setTimeout(r, 30));
    return { playing, stopped, heads: document.querySelectorAll('#tdp-playhead').length, nows: document.querySelectorAll('#tdp-now').length };
  });
  ok('play starts the playhead, and leaving the tab stops it', hk.playing === true && hk.stopped === false, J(hk));
  ok('leaving and returning leaves one playhead and one journey marker', hk.heads === 1 && hk.nows === 1, J(hk));

  ok('no uncaught page errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n  ${passes + failures} assertion(s).\n`);
if (failures) {
  console.log(`FAIL — ${failures} of ${passes + failures}.`);
  process.exit(1);
}
console.log(`PASS — the TDMA Planner's air time, capacities and two worked frames are the sources', and the tab does what its card says (${passes} checks).`);
