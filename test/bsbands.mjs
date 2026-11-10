// The Base Stations tab's Steady signals reasoning (base-station-bands.js), in
// Node, on spectra built an hour at a time so the answer is known.
//
//   * a band is what stands over its surroundings in the level a frequency
//     never dropped below: a carrier there every hour is found, with its
//     frequency, width and how far over; a window's sloping edges are not
//   * what is strong in the median only is busy, not constant
//   * hours of too few rows, and a stick with too few hours, are not judged
//   * the middle of the window is the stick's own centre spike
//   * another stick hearing the frequency with nothing there makes it this
//     stick's own; with a band there it is on the air — licensed when the
//     ACMA has it, no licence found when it does not, unchecked when the
//     licences have not loaded
//   * a retune: the band keeping its place in the window is the stick's own,
//     keeping its frequency is on the air
//   * a multiple of a clock a computer runs at is said to be that
//   * there by day and gone at night is solar gear, the reverse is lighting
//   * a frequency that wanders is electrical noise
//   * traffic the station decodes there is a channel, never interference —
//     unless most of it fails to decode under something steady
//   * whether it matters is where it is and how strong: on a channel, beside
//     one, strong anywhere, or neither
//   * every word the panel marks has a meaning, and every band something to do
//
// Run:  npm run bsbands
//       npm run bsbands -- -v    also print what passed

import { createRequire } from 'node:module';
import { REPO_ROOT } from './lib/paths.mjs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const B = require(path.join(REPO_ROOT, 'base-station-bands.js'));

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  if (!pass || VERBOSE) console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

// ── Building spectra ──────────────────────────────────────────────────────────
// A 240 kHz window of 256 bins (0.9375 kHz a bin) centred on 151.500 MHz. The
// floor reads 6 half-dB steps in the middle and rolls off to 0 over the outer
// tenth either side, as a stick's filter does.
const LEN = 256, RATE = 240000, CENTRE = 151500000, BIN = RATE / LEN;
const T0 = Math.floor(Date.UTC(2026, 10, 8, 0) / 1000);   // midnight UTC
const b64 = v => Buffer.from(v).toString('base64');
function line(marks) {
  const v = new Uint8Array(LEN);
  for (let i = 0; i < LEN; i++) { const e = Math.min(i, LEN - 1 - i); v[i] = e < 26 ? Math.round(6 * e / 26) : 6; }
  for (const [bin, half, width = 1] of marks || []) for (let i = bin; i < bin + width; i++) v[i] = half;
  return v;
}
// hours(n, h => ({ low: [...marks], mid: [...marks] })) for one stick and tuning.
function hours(n, fn, o = {}) {
  const out = [];
  for (let h = 0; h < n; h++) {
    const m = fn(h) || {};
    out.push({ t: T0 + h * 3600, key: o.key || 'sdr-1', center_hz: o.centre || CENTRE, rate: o.rate || RATE, n: o.n || 60,
      floor_db: m.floor == null ? -40 : m.floor, low: b64(line(m.low)), mid: b64(line(m.mid || m.low)) });
  }
  return out;
}
const binOf = (hz, centre = CENTRE) => Math.floor((hz - (centre - RATE / 2)) / BIN);
const at = (r, hz) => r.sticks[0].bands.find(b => Math.abs(b.f - hz) <= 1500);
const stick = (r, key) => r.sticks.find(s => s.key === key);

// ── Finding a band ────────────────────────────────────────────────────────────
{
  const F = 151540000, bin = binOf(F);
  const r = B.analyse(hours(24, () => ({ low: [[bin, 46, 2]] })), {});
  const b = at(r, F);
  check('a carrier there every hour is one band', r.sticks.length === 1 && r.sticks[0].bands.length === 1 && !!b, JSON.stringify(r.counts));
  check('…with its frequency to within a bin', b && Math.abs(b.f - F) <= BIN, b && String(b.f));
  check('…how far it stands over its surroundings (46 half-steps over 6: 20 dB)', b && b.over_db === 20, b && String(b.over_db));
  check('…its width (two bins)', b && Math.abs(b.width_hz - 2 * BIN) < 1, b && String(b.width_hz));
  check('…there in every hour, the whole time looked at', b && b.share === 1 && b.whole && b.since_t === T0, b && JSON.stringify([b.share, b.whole, b.since_t]));
  check('a window\'s sloping edges are not bands', B.analyse(hours(24, () => ({})), {}).counts.bands === 0);
  check('the stick says what it was judged on', r.sticks[0].hours === 24 && r.sticks[0].bin_hz === BIN && r.sticks[0].steady.length === LEN);
}
{
  const F = 151460000, bin = binOf(F);
  const r = B.analyse(hours(24, () => ({ low: [], mid: [[bin, 50, 8]] })), {});
  const b = r.sticks[0].bands[0];
  check('strong in the median only is busy, not constant', r.counts.bands === 1 && b && b.steady === false && r.counts.steady === 0, JSON.stringify(r.counts));
}
{
  const bin = binOf(151540000);
  check('hours of fewer than ten rows are not judged',
    B.analyse(hours(24, () => ({ low: [[bin, 46]] }), { n: 4 }), {}).sticks.length === 0);
  const r = B.analyse(hours(2, () => ({ low: [[bin, 46]] })), { names: { 'sdr-1': 'Stick A' } });
  check('a stick with two hours is waiting, by name', r.sticks.length === 0 && r.waiting.length === 1 && r.waiting[0].name === 'Stick A' && r.waiting[0].hours === 2);
  const s = B.analyse(hours(24, h => ({ low: h >= 10 ? [[bin, 46]] : [] })), {});
  const b = at(s, 151540000);
  check('a band that began ten hours in says since when', b && !b.whole && b.since_t === T0 + 10 * 3600 && Math.abs(b.share - 14 / 24) < 0.01, b && JSON.stringify([b.since_t, b.share]));
}

// ── What it is ────────────────────────────────────────────────────────────────
{
  const r = B.analyse(hours(24, () => ({ low: [[128, 40]] })), {});
  const b = r.sticks[0].bands[0];
  check('the middle of the window is the stick\'s own centre spike', b && b.centre && b.v.kind === 'centre' && b.v.impact.k === 'none', b && b.v.kind);
  const on = B.analyse(hours(24, () => ({ low: [[128, 40]] })), { listening: [{ f: 151.5, stick: 'Stick A', inBand: true, running: true }] });
  check('…and matters when a channel sits on it, with moving it the first thing to do',
    on.sticks[0].bands[0].v.impact.k === 'on' && /Move it off the channel/.test(on.sticks[0].bands[0].v.todo[0]), on.sticks[0].bands[0].v.todo[0]);
}
{
  // Two sticks, the second 60 kHz up: 151.540 is in the middle of both.
  const F = 151540000, C2 = 151560000;
  const a = hours(24, () => ({ low: [[binOf(F), 46]] }));
  const quiet = hours(24, () => ({}), { key: 'sdr-2', centre: C2 });
  const both = hours(24, () => ({ low: [[binOf(F, C2), 30]] }), { key: 'sdr-2', centre: C2 });
  const names = { 'sdr-1': 'Stick A', 'sdr-2': 'Stick B' };
  let b = stick(B.analyse(a.concat(quiet), { names, acma: [] }), 'sdr-1').bands[0];
  check('another stick hearing the frequency with nothing there: made inside this one',
    b.other === 'absent' && b.v.kind === 'spur' && /Stick B/.test(b.v.why[0]) && /nothing to report/.test(b.v.todo.join(' ')), b.v.kind + ' ' + b.v.why[0]);
  b = stick(B.analyse(a.concat(both), { names, acma: [] }), 'sdr-1').bands[0];
  check('the other stick seeing it too: on the air, and no licence found', b.other === 'seen' && b.v.kind === 'unlicensed' && /ACMA licences/.test(b.v.todo[0]), b.v.kind);
  b = stick(B.analyse(a.concat(both), { names, acma: null }), 'sdr-1').bands[0];
  check('…unchecked while the licences have not loaded, and never called unlicensed', b.v.kind === 'onair', b.v.kind);
  b = stick(B.analyse(a.concat(both), { names, acma: [{ f: 151.5375, client: 'Example Water', site: 'Mount Example', km: 12 }, { f: 151.9, client: 'Elsewhere', site: 'X', km: 3 }] }), 'sdr-1').bands[0];
  check('…a licensed transmitter when the ACMA has one within 6.25 kHz, named with its site and distance',
    b.v.kind === 'licensed' && b.v.sure === 'sure' && /Example Water/.test(b.v.title) && /Mount Example, 12 km/.test(b.v.why[0]) && !/Elsewhere/.test(b.v.why.join(' ')), b.v.title);
  const weak = hours(24, () => ({ low: [[binOf(F), 20]] }));
  b = stick(B.analyse(weak.concat(quiet), { names, acma: [] }), 'sdr-1').bands[0];
  check('a weak band the other stick misses proves nothing, and says so', b.v.kind !== 'spur' && /too weak/.test(b.v.why.join(' ')), b.v.kind);
  const alone = B.analyse(a, { names, acma: [] }).sticks[0].bands[0];
  check('one stick alone cannot tell: not identified, with the antenna test to do',
    alone.other === 'none' && alone.v.kind === 'unknown' && /antenna off/.test(alone.v.todo.join(' ')) && /Only this stick/.test(alone.v.why.join(' ')), alone.v.kind);
}
{
  // Retuned 30 kHz up twelve hours ago.
  const F = 151540000, C2 = 151530000;
  const before = hours(12, () => ({ low: [[binOf(F), 46]] }));
  const later = fn => hours(12, fn, { centre: C2 }).map(r => Object.assign(r, { t: r.t + 12 * 3600 }));
  let b = B.analyse(before.concat(later(() => ({ low: [[binOf(F, C2), 46]] }))), { acma: [] }).sticks[0].bands[0];
  check('retuned, the band kept its frequency: on the air', b.retune === 'stayed' && b.v.kind === 'unlicensed' && /kept its frequency/.test(b.v.why.join(' ')), b.retune + ' ' + b.v.kind);
  b = B.analyse(before.concat(later(() => ({ low: [[binOf(F), 46]] }))), { acma: [] }).sticks[0].bands[0];
  check('retuned, the band kept its place in the window: the stick\'s own', b.retune === 'moved' && b.v.kind === 'spur', b.retune + ' ' + b.v.kind);
  check('the newest tuning is the one judged', B.analyse(before.concat(later(() => ({}))), {}).sticks[0].center_hz === C2);
}
{
  const C = 150040000, F = 150000000;
  const r = B.analyse(hours(24, () => ({ low: [[binOf(F, C), 40]] }), { centre: C }), { acma: [] });
  const b = r.sticks[0].bands[0];
  check('a bare carrier on 6 × 25 MHz is put down to wired Ethernet', b.v.kind === 'clock' && /Ethernet/.test(b.v.title) && /Unplug the network cable/.test(b.v.todo.join(' ')), b.v.title);
  check('151.500 MHz is no clock\'s multiple', B.clockOf(151500000) === null && B.clockOf(153600000).mhz === 19.2);
}
{
  // Brisbane, 153 E: ten hours ahead of UTC.
  const bin = binOf(151540000);
  const local = h => (h + 10) % 24;
  let b = B.analyse(hours(72, h => ({ low: local(h) >= 7 && local(h) < 17 ? [[bin, 40, 4]] : [] })), { lon: 153, acma: [] }).sticks[0].bands[0];
  check('there by day and gone at night: solar gear', b && b.when === 'day' && b.v.kind === 'solar', b && b.when + ' ' + b.v.kind);
  const night = B.analyse(hours(72, h => ({ low: local(h) >= 18 || local(h) < 6 ? [[bin, 40, 4]] : [] })), { lon: 153, acma: [] }).sticks[0].bands;
  check('there at night and gone by day: lighting or a timer', night.length === 1 && night[0].when === 'night' && night[0].v.kind === 'lights', night.length && night[0].v.kind);
  b = B.analyse(hours(72, () => ({ low: [[bin, 40, 4]] })), { lon: 153, acma: [] }).sticks[0].bands[0];
  check('there round the clock is neither', b.when === 'always' && b.v.kind === 'unknown');
}
{
  const bin = binOf(151540000);
  const b = B.analyse(hours(24, h => ({ low: [[bin + (h % 3), 40]] })), { acma: [] }).sticks[0].bands[0];
  check('a frequency that wanders is electrical noise, not a transmitter', b && b.drift_hz >= 1500 && b.v.kind === 'drifting', b && b.drift_hz + ' ' + b.v.kind);
}
{
  const F = 151500000 + 20000, bin = binOf(F);
  const rows = hours(24, () => ({ low: [[bin, 30, 6]] }));
  let b = B.analyse(rows, { heard: [{ f: 151.52, n: 4000, ok: 3900 }], listening: [{ f: 151.52, stick: 'Stick A', inBand: true, running: true }] }).sticks[0].bands[0];
  check('traffic the station decodes there is a channel, and does not matter', b.v.kind === 'traffic' && b.v.impact.k === 'none' && /3,900 of 4,000/.test(b.v.why[0]), b.v.kind);
  b = B.analyse(rows, { heard: [{ f: 151.52, n: 4000, ok: 900 }], listening: [{ f: 151.52, stick: 'Stick A', inBand: true, running: true }] }).sticks[0].bands[0];
  check('…unless most of it fails to decode under something steady', b.v.kind === 'traffic' && /Fewer than half/.test(b.v.why.join(' ')) && /stuck on/.test(b.v.todo.join(' ')), b.v.why.join(' '));
  b = B.analyse(rows, { heard: [{ f: 151.52, n: 300, ok: 0 }], acma: [] }).sticks[0].bands[0];
  check('bursts heard there and none decoded is said', b.v.kind !== 'traffic' && /heard 300 bursts here and decoded none/.test(b.v.why.join(' ')));
}

// ── Whether it matters ────────────────────────────────────────────────────────
{
  const F = 151540000, bin = binOf(F);
  const L = f => [{ f, stick: 'Stick A', inBand: true, running: true }];
  const run = (half, listening) => B.analyse(hours(24, () => ({ low: [[bin, half]] })), { acma: [], listening }).sticks[0].bands[0].v.impact;
  check('on a channel it decodes: yes', run(46, L(151.54)).k === 'on' && /151.540 MHz/.test(run(46, L(151.54)).text), run(46, L(151.54)).text);
  check('15 kHz from one and 20 dB over: possibly, it can swamp the channel beside it', run(46, L(151.525)).k === 'beside');
  check('15 kHz from one and 10 dB over: no', run(26, L(151.525)).k === 'none');
  check('far from any channel but 35 dB over: possibly, it uses up the stick\'s range', run(76, L(151.45)).k === 'strong');
  check('far from any channel and modest: no, leave it', run(30, L(151.45)).k === 'none');
  check('a channel outside the stick\'s window is not one it decodes', run(46, [{ f: 151.54, stick: 'Stick A', inBand: false, running: true }]).k === 'none');
  const r = B.analyse(hours(24, () => ({ low: [[bin, 46]] })), { acma: [], listening: L(151.54) });
  check('the counts say how many matter and how many are unidentified', r.counts.on === 1 && r.counts.unknown === 1 && r.counts.bands === 1, JSON.stringify(r.counts));
}
{
  const r = B.analyse(hours(48, h => ({ floor: (h + 10) % 24 >= 8 && (h + 10) % 24 < 16 ? -32 : -40 })), { lon: 153 });
  check('a floor that rises by day is measured, and said to be by day', r.sticks[0].floor && r.sticks[0].floor.swing === 8 && r.sticks[0].floor.high === 'day', JSON.stringify(r.sticks[0].floor));
}

// ── The words ─────────────────────────────────────────────────────────────────
{
  check('every word has a meaning of a sentence or more', B.WORDS.length >= 10 && B.WORDS.every(w => w[0] && w[1] && w[2].length > 40 && !w[2].startsWith(w[1] + ' is ' + w[1])));
  check('every test says how to do it', B.TESTS.length >= 5 && B.TESTS.every(t => t[0] && t[1].length > 60));
  const kinds = [];
  const bin = binOf(151540000);
  for (const ctx of [{}, { acma: [] }, { acma: [{ f: 151.54, client: 'X', site: 'Y', km: 1 }] }, { heard: [{ f: 151.54, n: 10, ok: 9 }] }]) {
    for (const marks of [[[bin, 46]], [[128, 46]], [[5, 46]], [[bin, 46, 120]]]) {
      for (const b of B.analyse(hours(24, () => ({ low: marks })), ctx).sticks[0].bands) kinds.push(b.v);
    }
  }
  check('every band, whatever it is, has a reason and something to do', kinds.length >= 12 && kinds.every(v => v.title && v.why.length && v.todo.length && v.impact.text), JSON.stringify(kinds.find(v => !v.why.length || !v.todo.length)));
  check('nothing a person reads says MegaNet', !JSON.stringify([B.WORDS, B.TESTS, kinds]).includes('MegaNet'));
}

const failed = results.filter(r => !r.pass).length;
console.log(`${failed ? 'FAIL' : 'ok'}  bsbands: ${results.length - failed} of ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
