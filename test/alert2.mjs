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
//     add up.
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

const ctx = vm.createContext({ console, TextDecoder, Uint8Array, DataView, Date, Math, Number, String,
                               Array, Object, JSON, Set, Map, isFinite, parseInt });
vm.runInContext(fs.readFileSync(repo('alert2.js'), 'utf8') + '\nthis.Alert2 = Alert2;', ctx, { filename: 'alert2.js' });
const A = ctx.Alert2;

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

const failed = results.filter(r => !r.pass);
console.log(`\n${failed.length ? 'FAIL' : 'PASS'} — the ALERT2 decoder reads the fields, the stamp and the self-reports as the spec writes them `
  + `(${results.length - failed.length}/${results.length}).`);
process.exit(failed.length ? 1 : 0);
