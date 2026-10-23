// The ALERT2 decoder, held to the specifications it is read from (#209).
//
// `alert2.js` named the ERT-A2's fields from a capture before any spec was to
// hand, and four of the names were wrong in ways that lost data: field 18 is
// the MANT port, not "frame valid", so every self-report was thrown away as
// corrupt; field 22 is the hop limit; the payload's stamp counts from the last
// 00:00 *or* 12:00, so every afternoon frame lost its time; and a concentration
// record's fourth byte is a time offset, not a status. The NHWC documents —
// IND API v1.1 §5.2, MANT v1.2 Fig 2-2, Application Layer v1.3 §2–3 — are the
// oracle now, and these are their worked examples and the capture's own frames:
//
//   * the "corrupt" frame of the reference capture is the test rig's General
//     Sensor Report: battery 129, stage −1247, rain 8, port 0, hop limit 1;
//   * a frame stamped after noon is timed by its own stamp, and the decoder
//     says whether the stamp counts from UTC's half-days or local time's;
//   * a test-flagged control byte (0x7C), a record held before export, a line
//     carrying repeater path addresses, a destination and a PDU ID all decode;
//   * nothing decides whether a frame or a record is clean from field 18,
//     field 22 or a record's fourth byte — only from structure that does not
//     add up;
//   * and where a legacy address came from: a record is the spec's three
//     bytes and a time offset (Fig 3-3), it rebuilds to the ALERT Binary word
//     the concentrator heard (Fig 5-5-1) — which the ALERT Packets decoder
//     reads back to the same address and value — and a concentrator passing
//     on misheard words, all 1s, is told from a clean one, a misheard word is
//     matched to the clean reading another concentrator heard that second,
//     and Flood-Net's reception log reads in as frames, its receiver's decode
//     checked against its own bytes.
//
// Node only, under a second. alert2.js is a browser script with no exports, so
// it is run in a context of its own and its codec read off the result; the
// time zone is pinned so "local" means one thing.
//
// Run:  npm run alert2
//       npm run alert2 -- -v    also print what passed

process.env.TZ = 'Australia/Brisbane';   // UTC+10, no daylight saving

import fs from 'node:fs';
import vm from 'node:vm';
import { repo } from './lib/paths.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  if (!pass || VERBOSE) console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}
// The decoder's objects point back at their frame and report; a detail line wants the values.
const J = x => JSON.stringify(x, (k, v) => (k === 'frame' || k === 'report' || k === 'x') ? undefined : v);

// The station lookup reads the page's state and two helpers from core.js and
// app.js; a small database of its own stands in for them.
const ctx = vm.createContext({ console, TextDecoder, Uint8Array, DataView, Date, Math, Number, String,
                               Array, Object, JSON, Set, Map, isFinite, parseInt,
                               state: { data: { stations: [] }, a2: { picks: {} } },
                               stationSensors: s => s.sensors || [],
                               stationAlertIds: s => (s.sensors || []).map(x => x.alert_id),
                               Packets: { stationName: () => null } });
vm.runInContext(fs.readFileSync(repo('alert2.js'), 'utf8') + '\nthis.Alert2 = Alert2;', ctx, { filename: 'alert2.js' });
const A = ctx.Alert2;
// The ALERT Packets decoder, on its own, to read a rebuilt legacy word back.
const pctx = vm.createContext({ console, Math });
vm.runInContext(fs.readFileSync(repo('packets.js'), 'utf8') + '\nthis.Packets = Packets;', pctx, { filename: 'packets.js' });
const PK = pctx.Packets;

const one = line => A.parseAscii(line).frames[0];
const hex2 = n => n.toString(16).toUpperCase().padStart(2, '0');
// An N string with the header fields given, the payload as hex bytes, and
// whatever optional fields sit between field 24 and the payload.
function line({ clock = [2026, 6, 8, 14, 0, '0.000'], f13to17 = [0, 0, 0, 0, 0], port = 1, hop = 7,
                source = 9999, opt = [], bytes }) {
  return ['ALERT2A', 1, 9999, 'ELPRO', 'N', 1, ...clock, ...f13to17, port, 0, 0, 0, hop,
          bytes.length, source, ...opt, ...bytes.map(hex2)].join(',');
}
const stamp = (h, m, s) => { const t = ((h % 12) * 3600 + m * 60 + s); return [t >> 8, t & 255]; };

console.log('\nThe reference capture\'s "corrupt" frame is a self-report\n');

const SAMPLE = A.samples().ascii.split('\n');
const gsrLine = SAMPLE.find(l => l.includes('20,51,10.161'));
const g = one(gsrLine);
check('it decodes, with no error and no warning', !g.error && g.warn.length === 0, J({ e: g.error, w: g.warn }));
check('field 18 is the port, and it is 0 — a self-report', g.hdr.port === 0);
check('field 22 is the hop limit, and it is 1', g.hdr.hopLimit === 1);
check('the control byte is 0x74: version 0, a stamp, not test, PDU id off',
  g.payload.ctl.byte === 0x74 && g.payload.ctl.version === 0 && g.payload.ctl.ts && !g.payload.ctl.test && g.payload.ctl.apdu === 7);
check('one General Sensor Report', g.reports.length === 1 && g.reports[0].type === 1 && g.reports[0].len === 14);
check('battery 129, stage −1247, rain 8 — byte for byte',
  J(g.sensors.map(s => [s.sensor, s.value])) === J([[8, 129], [7, -1247], [0, 8]]), J(g.sensors.map(s => [s.sensor, s.value])));
check('in the formats the bytes say: 1-byte unsigned, 3-byte signed, 4-byte unsigned',
  J(g.sensors.map(s => s.fl)) === J([0x11, 0x23, 0x14]));
check('every value good, and no concentration records cut out of it', g.sensors.every(s => s.ok) && g.records.length === 0);
check('filed under the gauge and the sensor: a2:9999/8 and the rest', J(g.sensors.map(s => A.a2Key(s.source, s.sensor))) === J(['9999/8', '9999/7', '9999/0']));

console.log('\nThe stamp counts from 00:00 or 12:00\n');

const afternoon = one(SAMPLE[0]);   // 19:10:41 by the receiver, stamp 0x64F0
check('a concentration frame received at 19:10:41 carries 25,840 s — 07:10:40 into the half-day',
  afternoon.payload.stamp === 0x64f0);
check('and is timed at 19:10:40, by its own stamp, not twelve hours early',
  afternoon.time && afternoon.time.ms === new Date(2026, 5, 8, 19, 10, 40).getTime(), afternoon.time && new Date(afternoon.time.ms).toString());
check('counting from the same half-days as the receiver\'s clock', afternoon.time.base === 'local', afternoon.time.base);

// The same arrival, a stamp counted from UTC's half-days: 19:10:41 in Brisbane
// is 09:10:41 UTC.
const utcF = one(line({ clock: [2026, 6, 8, 19, 10, '41.000'], bytes: [0x74, ...stamp(9, 10, 40), 0x18, 0x15, 0x00, 0x00] }));
check('a stamp counting from UTC\'s half-days is found as UTC, at the same instant',
  utcF.time.base === 'utc' && utcF.time.ms === new Date(2026, 5, 8, 19, 10, 40).getTime(), J(utcF.time));
const cap = A.parseAscii(A.samples().ascii);
check('the sample capture\'s receiver clock reads about a second off its frames, not twelve hours',
  Math.abs(cap.stats.skew - 1) < 1, String(cap.stats.skew));
check('and its stamps are counted as the receiver\'s own half-days', cap.stats.bases.local >= 5 && cap.stats.bases.utc === 0, J(cap.stats.bases));

const ref = Date.UTC(2026, 5, 8, 9, 10, 41);
check('placeStamp: a UTC stamp near its arrival is UTC', A.placeStamp(stamp(9, 10, 40).reduce((a, b) => a * 256 + b), ref).base === 'utc');
check('placeStamp: a local one is local', A.placeStamp(stamp(19, 10, 40).reduce((a, b) => a * 256 + b), ref).base === 'local');
check('placeStamp: one near neither says so, and still gives both placements',
  (p => p.base === null && p.ms === null && p.utc != null && p.local != null)(A.placeStamp(stamp(3, 0, 0).reduce((a, b) => a * 256 + b), ref)));
check('placeStamp: no stamp, no placement', A.placeStamp(null, ref) === null);
process.env.TZ = 'UTC';
check('on a computer on UTC the two are one, and it says so', A.placeStamp(stamp(9, 10, 40).reduce((a, b) => a * 256 + b), ref).base === 'either');
process.env.TZ = 'Australia/Brisbane';

console.log('\nValid frames the first decoder refused\n');

const test7c = one(line({ bytes: [0x7C, ...stamp(14, 0, 0), 0x18, 0x15, 0x00, 0x00] }));
check('control byte 0x7C decodes — flagged as test data, its reading kept',
  !test7c.error && test7c.payload.ctl.test && test7c.records.length === 1 && test7c.records[0].ok, J({ e: test7c.error, w: test7c.warn }));
const noTs = one(line({ bytes: [0x70, 0x18, 0x15, 0x00, 0x00] }));
check('control byte 0x70 — no stamp — decodes, its reading starting at byte 1',
  !noTs.error && noTs.payload.stamp === null && noTs.records.length === 1 && noTs.records[0].alertId === 0x1518);
const apdu = one(line({ bytes: [0x04, ...stamp(14, 0, 0), 0x18, 0x15, 0x00, 0x00] }));
check('control byte 0x04 — PDU id 0 switched on — decodes', !apdu.error && apdu.payload.ctl.apdu === 0 && apdu.records.length === 1);
const held = one(line({ bytes: [0x74, ...stamp(14, 0, 0), 0x18, 0x15, 0x00, 0x1E] }));
check('a record with fourth byte 0x1E is a reading held 30 s, and good',
  held.records[0].offset === 30 && held.records[0].ok && held.warn.length === 0, J(held.records[0]));
check('…its address and value unchanged by it', held.records[0].alertId === 5400 && held.records[0].value === 0);

const pathed = line({ f13to17: [0, 0, 0, 1, 0], opt: [2, 1111, 2222], bytes: [0x74, ...stamp(14, 0, 0), 0x18, 0x15, 0x00, 0x00] });
const pf = one(pathed);
check('a line with appended path addresses keeps them, and its payload starts after them',
  !pf.error && J(pf.hdr.path) === J([1111, 2222]) && pf.records.length === 1 && pf.records[0].alertId === 5400, J({ e: pf.error, p: pf.hdr.path }));
const dpd = one(line({ f13to17: [0, 1, 0, 0, 1], opt: [4000, 5], bytes: [0x74, ...stamp(14, 0, 0), 0x18, 0x15, 0x00, 0x00] }));
check('a destination address and a MANT PDU ID are read off before the payload',
  !dpd.error && dpd.hdr.dest === 4000 && dpd.hdr.pduId === 5 && dpd.records.length === 1, J({ e: dpd.error, d: dpd.hdr.dest, i: dpd.hdr.pduId }));
const cut = pathed.split(',');
const rejoined = A.parseAscii(cut.slice(0, 30).join(',') + '\n,' + cut.slice(30).join(','));
check('wrapped after its path addresses, the line is sewn back together',
  rejoined.frames.length === 1 && rejoined.frames[0].wrapped && rejoined.frames[0].records.length === 1, J(rejoined.stats));

console.log('\nWhat makes a frame bad is structure, never a field\n');

const portHop = [[0, 1], [1, 1], [1, 7], [0, 7]].every(([port, hop]) => {
  const f = one(line({ port, hop, bytes: port ? [0x74, 0, 1, 0x18, 0x15, 0x00, 0x09] : [0x74, 0, 1, 0x01, 0x03, 0x08, 0x11, 0x81] }));
  return !f.error && !f.damaged && (f.records.concat(f.sensors)).every(r => r.ok) && (f.records.length + f.sensors.length) === 1;
});
check('no combination of port, hop limit and offset makes a reading bad', portHop);
const over = one(line({ bytes: [0x74, ...stamp(14, 0, 0), 0x18, 0x15, 0x00, 0x00, 0xFF] }));
check('a byte left over after the last record does: the frame is damaged and its reading not vouched for',
  !!over.damaged && over.records.length === 1 && !over.records[0].ok);
const short = one(line({ bytes: [0x74, ...stamp(14, 0, 0), 0x18, 0x15, 0x00, 0x00] }).replace(/,7,9999,/, ',9,9999,'));
check('as does a payload shorter than the header says', !!short.damaged && !short.records[0].ok, J(short.warn));
const v1 = one(line({ bytes: [0x75, 0, 1, 0x18, 0x15, 0x00, 0x00] }));
check('an application layer version other than 0 is refused, and says which', !!v1.error && /version 1/.test(v1.error), v1.error);

console.log('\nThe Application Layer\'s own examples (v1.3 appendix 1)\n');

const gsrSpec = one(line({ port: 0, bytes: [0x70, 0x01, 0x0A, 0x12, 0x34, 0x41, 0x00, 0xA3, 0xD7, 0x13, 0x22, 0x02, 0x76] }));
check('4.1: sensor 18 is pH 8.04, a float32', Math.abs(gsrSpec.sensors[0].value - 8.04) < 1e-6 && gsrSpec.sensors[0].type === 'float32');
check('4.1: sensor 19 is 630, a 2-byte signed', gsrSpec.sensors[1].sensor === 19 && gsrSpec.sensors[1].value === 630);
const tb = one(line({ port: 0, bytes: [0x50, 0x02, 0x0A, 0x00, 0x14, 0x00, 0x00, 0x00, 0x68, 0x14, 0x0F, 0x0A, 0x02] }));
check('4.2: the tipping bucket reads 104, with tips 20, 15, 10 and 2 s before the report',
  tb.sensors.length === 1 && tb.sensors[0].value === 104 && J(tb.sensors[0].tips) === J([20, 15, 10, 2]), J(tb.sensors));
check('4.2: control 0x50 is PDU id 5 and no stamp', tb.payload.ctl.apdu === 5 && !tb.payload.ctl.ts);
const msr = one(line({ port: 0, bytes: [0x7C, ...stamp(14, 0, 0), 0x03, 0x08, 0x9B, 0x00, 0xEA, 0x29, 0x08, 0x01, 0x09, 0x7F] }));
check('4.3: a Multi-Sensor Report is kept as its bytes, named, and not an error',
  !msr.error && !msr.damaged && msr.reports.length === 1 && msr.reports[0].kept && /Multi-Sensor/.test(msr.reports[0].name));
const fp2 = one(line({ port: 0, bytes: [0x70, 0x01, 0x0C, 0x07, 0x32, 0xC4, 0xD2, 0x01, 0x32, 0x1F, 0x3F, 0x02, 0x32, 0x9F, 0xFE] }));
check('appendix 3: FP2 C4 D2 is −12.34, 1F 3F is 7,999, 9F FE is NaN',
  fp2.sensors[0].value === -12.34 && fp2.sensors[1].value === 7999 && Number.isNaN(fp2.sensors[2].value), J(fp2.sensors.map(s => s.value)));
const long = one(line({ port: 0, bytes: [0x70, 0x01, 0x80, 0x03, 0x08, 0x11, 0x81] }));
check('§2.1.4: a two-byte length (top bit set) is read as fifteen bits', !long.error && !long.damaged && long.sensors[0].value === 129);
const odd = one(line({ port: 0, bytes: [0x70, 0x01, 0x07, 0x05, 0x52, 0xAA, 0xBB, 0x08, 0x11, 0x81] }));
check('§2.2.4: an undefined format/length is skipped by its length, and the next sensor still read',
  odd.sensors.length === 2 && odd.sensors[0].value === null && odd.sensors[1].value === 129 && !odd.damaged);

console.log('\nThe USB framing\'s MANT header\n');

const bin = A.parseBin(A.samples().bin);
const f0 = bin.frames[0];
check('00 10 70 07 27 0F: port 1, hop limit 7, 7 payload bytes, source 9999',
  f0.hdr.port === 1 && f0.hdr.hopLimit === 7 && f0.hdr.payLen === 7 && f0.hdr.source === 9999, J([f0.hdr.port, f0.hdr.hopLimit, f0.hdr.payLen, f0.hdr.source]));
check('every frame of the USB sample decodes without a warning', bin.stats.errors === 0 && bin.frames.every(f => !f.warn.length));

console.log('\nWhere a legacy address comes from\n');

// Figure 3-3: byte 1 A7–A0, byte 2 D10–D8 over A12–A8, byte 3 D7–D0, byte 4 the time offset.
// Address 0x1ABC, value 0x5A3, held 5 s, packed by hand from the figure.
const fig33 = A.decodeRecord([0xBC, 0xBA, 0xA3, 0x05], 3);
check('Fig 3-3: BC BA A3 05 is address 6844 (0x1ABC), value 1443 (0x5A3), held 5 s',
  fig33.alertId === 0x1ABC && fig33.value === 0x5A3 && fig33.offset === 5, J(fig33));
// Figure 5-5-1, ALERT Binary: 01 A5–A0 · 01 A11–A6 · 11 D4–D0 A12 · 11 D10–D5.
const w = A.legacyWord(0x1ABC, 0x5A3);
check('Fig 5-5-1: it was heard as the ALERT Binary word 7C 6A C7 ED', J(w.bytes) === J([0x7C, 0x6A, 0xC7, 0xED]), J(w.bytes.map(hex2)));
const lsbFirst = bytes => bytes.map(b => [0, 1, 2, 3, 4, 5, 6, 7].map(i => (b >> i) & 1).join('')).join('');
const abfOf = (aid, val) => PK.decodeMessage(lsbFirst(A.legacyWord(aid, val).bytes)).results.find(r => r.format === 'abf');
const words = [[0x1ABC, 0x5A3], [7182, 3], [8191, 2047], [0, 0], [4018, 1263]];
check('the ALERT Packets decoder reads every rebuilt word back as ABF, to the same address and value',
  words.every(([aid, val]) => { const r = abfOf(aid, val); return r && r.valid && r.values.A === aid && r.values.D === val; }),
  J(words.map(([aid, val]) => { const r = abfOf(aid, val); return r && [r.valid, r.values.A, r.values.D]; })));
check('a record counts the 1s in its 24 address and value bits', fig33.ones === 8 + 6 && A.decodeRecord([0xFF, 0xFF, 0xFF, 0], 0).ones === 24);
check('18 of 24 looks misheard; a battery reading of 132 does not',
  A.legacyWord(7679, 1535).heavy && !A.legacyWord(2390, 132).heavy && A.BIT_HEAVY === 18);

// Two concentrators, one clean and one passing on misheard words. Frames a
// minute apart; the misheard one's second and third records are all 1s.
const rec = (aid, val, off = 0) => [aid & 0xff, ((val >> 8) << 5) | (aid >> 8), val & 0xff, off];
const at = i => { const t = 3600 + i * 60; return { clock: [2026, 6, 8, 13, i, '0.500'], st: [t >> 8, t & 255] }; };
const caps = [];
for (let i = 0; i < 30; i++) {
  const { clock, st } = at(i);
  caps.push(line({ clock, source: 1111, bytes: [0x74, ...st, ...rec(1000, 130 + (i % 3)), ...rec(1001, 5 + i), ...rec(1002, 300)] }));
  caps.push(line({ clock, source: 2222, bytes: [0x74, ...st, ...rec(1500, 10), ...rec(8191, 2047 - (i % 4)), ...rec(7679, 1535)] }));
}
// The clean concentrator's first frame again, by another path: a second copy, not a second record.
caps.push(line({ clock: at(0).clock, source: 1111, f13to17: [0, 0, 0, 1, 0], opt: [1, 10019], bytes: [0x74, ...at(0).st, ...rec(1000, 130), ...rec(1001, 5), ...rec(1002, 300)] }));
// And the clean one heard the legacy station the misheard one turned into 7679 at the same second.
caps.push(line({ clock: at(5).clock, source: 1111, bytes: [0x74, ...at(5).st, ...rec(7424, 1280)] }));
ctx.state.data.stations = [
  { id: 'n1', name: 'Near one', lat: -27.40, lon: 152.80, sensors: [{ alert_id: 1000, type: 'Battery' }, { alert_id: 1001, type: 'Rainfall' }, { alert_id: 1002, type: 'Water Level' }] },
  { id: 'n2', name: 'Near two', lat: -27.45, lon: 152.90, sensors: [{ alert_id: 1500, type: 'Rainfall' }, { alert_id: 7424, type: 'Rainfall' }] },
  { id: 'f1', name: 'Far one', lat: -33.90, lon: 151.20, sensors: [{ alert_id: 7679, type: 'Battery' }] },
  { id: 'f2', name: 'Far two', lat: -37.80, lon: 145.00, sensors: [{ alert_id: 8191, type: 'Battery' }] },
];
const two = A.parseAscii(caps.join('\n'));
const res2 = A.resolve(two);
const conc = A.concentrators(two, res2);
const c1 = conc.find(e => e.source === 1111), c2 = conc.find(e => e.source === 2222);
check('the clean concentrator is clean, the one passing on 1s is mishearing',
  c1 && c2 && c1.verdict === 'ok' && c2.verdict === 'bad' && Math.abs(c2.share - 2 / 3) < 1e-9, J(conc.map(e => [e.source, e.verdict, e.share])));
check('a frame heard by two paths is two copies of one set of records', c1.copies === c1.records + 3 && c1.records === 91, J([c1.copies, c1.records]));
check('the misheard addresses land far away, and say so', res2.byAlertId.get(7679).far && res2.byAlertId.get(8191).far && !res2.byAlertId.get(1000).far,
  J([...res2.byAlertId.values()].map(r => [r.aid, r.far, r.chosen && Math.round(r.chosen.distKm)])));
check('…and do not pull the middle of the capture towards them', res2.centre && Math.abs(res2.centre.lat + 27.4) < 0.1, J(res2.centre));
const jam = two.records.find(r => r.alertId === 7679 && r.frame.payload.stamp === 3600 + 5 * 60);
const tw = A.twins(two, jam);
check('a misheard 7679:1535 is matched to the clean 7424:1280 heard that second, 16 bits forced',
  tw && tw.length === 1 && tw[0].r.alertId === 7424 && tw[0].r.value === 1280 && tw[0].forced === 16, J(tw && tw.map(x => [x.r.alertId, x.r.value, x.forced])));
const tr = A.traceAddress(two, res2, 7679);
check('tracing 7679 finds it from one concentrator only, every reading of it misheard',
  tr.bySource.length === 1 && tr.bySource[0].source === 2222 && tr.bySource[0].heavy === 30, J(tr.bySource.map(e => [e.source, e.recs.length, e.heavy])));

// Flood-Net's reception log: rows as reception_window() returns them.
const row = (o, d) => Object.assign({ protocol: 'alert2', point_id: 'pi-1', point_name: 'Pi one', heard_at: '2026-10-21T21:51:04.502Z',
  ok: true, lat: -27.39, lon: 152.78 }, o, { detail: Object.assign({ source: 33300, path: [11056, 10019], hop_limit: 3, stamp: 35421, snr_db: 24 }, d) });
const rows = [
  row({ alert_id: 4018, value_raw: 1263, payload_hex: 'B28FEF3C' }, { before_s: 60 }),
  row({ alert_id: 4030, value_raw: 1598, payload_hex: 'BECF3E37' }, { before_s: 55 }),
  row({ alert_id: 4018, value_raw: 1263, payload_hex: 'B28FEF3C', heard_at: '2026-10-21T21:50:35.053Z' }, { before_s: 60, path: [10019], hop_limit: 4 }),
  row({ alert_id: 4031, value_raw: 1598, payload_hex: 'BECF3E37', heard_at: '2026-10-21T21:52:00.000Z' }, { before_s: 55 }),
  row({ protocol: 'alert', alert_id: 7, value_raw: 1 }, {}),
];
const rx = A.parseRx(rows);
check('the reception log reads as frames: one per moment heard, source and path',
  rx.mode === 'rx' && rx.frames.length === 3 && rx.frames[1].records.length === 2 && J(rx.frames[1].hdr.path) === J([11056, 10019]) && rx.frames[1].hdr.source === 33300,
  J(rx.frames.map(f => [f.hdr.source, f.hdr.path, f.records.length])));
check('each record decoded afresh from its bytes: B2 8F EF 3C is 4018 = 1263, held 60 s',
  (r => r.alertId === 4018 && r.value === 1263 && r.offset === 60)(rx.frames[1].records[0]));
check('a row whose logged address disagrees with its bytes is flagged on its frame',
  rx.stats.mismatched === 1 && rx.frames[2].warn.some(x => /4031/.test(x) && /4030/.test(x)), J(rx.frames[2].warn));
check('the frame is timed by its stamp against when it was heard', rx.frames[1].time && rx.frames[1].time.base !== null, J(rx.frames[1].time));
check('the receiver\'s position comes with it, and distances are measured from there',
  rx.receiver && rx.receiver.lat === -27.39 && (r => r.ref && r.ref.kind === 'receiver')(A.resolve(rx)), J(rx.receiver));
const rc = A.concentrators(rx, A.resolve(rx));
// The fourth row repeats the second's bytes under the same stamp: the same record, one more copy.
check('two paths of the same frame count once as records', rc.length === 1 && rc[0].records === 2 && rc[0].copies === 4, J(rc.map(e => [e.records, e.copies])));

const failed = results.filter(r => !r.pass);
console.log(`\n${failed.length ? 'FAIL' : 'PASS'} — the ALERT2 decoder reads the fields, the stamp and the self-reports as the spec writes them `
  + `(${results.length - failed.length}/${results.length}).`);
process.exit(failed.length ? 1 : 0);
