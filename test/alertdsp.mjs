// The off-air ALERT decoder (alert-dsp.js) against a real burst.
//
// alert-dsp.js is a port of agmurf/sdr-alert-decoder's Android decoder, and a
// port is only as good as the evidence that it decodes what the original
// decodes. The original's own evidence is a recording: three seconds of the
// 4078 ERT-A2 test rig captured off air on 2026-08-29, resampled to 240 ksps
// and stored as interleaved u8 IQ — exactly what the dongle hands the
// browser. It lives at test/fixtures/sdr/testrig_burst_240k.iq8, copied from
// that repository (MIT). The Kotlin's unit test requires 4079 = 420 and
// 4080 = 121 (12.1 V) from it under Enhanced iFLOWS, accepts 4078 = 528 only if
// present, and requires noise to decode to nothing. So does this.
//
// The rest holds the parts a recording cannot:
//
//   * the CRC-6 against the five real rig frames, and the encoder against them
//   * the one-format-at-a-time rule — the rig's burst read as Binary is nothing
//   * the vote bar against noise with the carrier search bypassed, because the
//     search would otherwise never let noise through to be voted on
//   * synthesised bursts round-tripping through every format, both
//     polarities, off-centre carriers and a low SNR
//   * the live pipeline: a 960 ksps stream with the channel 50 kHz off centre
//     is gated, decimated, decoded once, and reports a spectrum, a level, a
//     scope and a capture
//   * the Worker source builds — it is this module rebuilt from its own text
//
// and two ALERT Binary bursts off the air, since the rig's is Enhanced iFLOWS
// and the live networks send Binary (see "Two real ALERT Binary bursts" below).
//
// Node only, no browser. Run:  npm run alertdsp   (-v to list what passed)

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO_ROOT } from './lib/paths.mjs';

const require = createRequire(import.meta.url);
const D = require(path.join(REPO_ROOT, 'alert-dsp.js'));

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  if (!pass || VERBOSE) console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}
const show = rs => rs.map(r => `${r.sensorId}=${r.value}(${r.votes})`).join(' ') || 'nothing';

// ── The real burst ───────────────────────────────────────────────────────────

const iq = new Uint8Array(fs.readFileSync(path.join(REPO_ROOT, 'test/fixtures/sdr/testrig_burst_240k.iq8')));
check('the vector is 3 s of 240 ksps u8 IQ', iq.length === 240000 * 2 * 3, `${iq.length} bytes`);

{
  const r = D.decodeU8(iq, { format: D.ENHANCED_IFLOWS });
  const got = id => r.readings.find(x => x.sensorId === id);
  check('Enhanced iFLOWS: 4079 = 420 (river level)', got(4079) && got(4079).value === 420, show(r.readings));
  check('Enhanced iFLOWS: 4080 = 121 (12.1 V battery)', got(4080) && got(4080).value === 121, show(r.readings));
  check('4078, if recovered, is 528 mm', !got(4078) || got(4078).value === 528, show(r.readings));
  check('every reading carries a valid CRC', r.readings.length > 0 && r.readings.every(x => x.crcOk === true));
  check('4079\'s raw bytes are the rig\'s EF 3F D2 08', got(4079) && got(4079).hex === 'EF 3F D2 08', got(4079) && got(4079).hex);
  check('nothing else is reported', r.readings.every(x => [4078, 4079, 4080].includes(x.sensorId)), show(r.readings));
  check('the trace carries the frames it was decoded from',
    r.trace && r.trace.symbols.length > 100 && r.trace.frames.length >= 1,
    r.trace ? `${r.trace.symbols.length} symbols, ${r.trace.frames.length} frames` : 'no trace');
  check('a 3 s window decodes faster than real time', r.ms < 3000, `${Math.round(r.ms)} ms`);
  const whole = D.decodeU8(iq, { format: D.ENHANCED_IFLOWS, trim: false });
  check('the untrimmed window (the Kotlin\'s way) agrees',
    show(whole.readings).replace(/\(\d+\)/g, '') === show(r.readings).replace(/\(\d+\)/g, ''),
    `${show(whole.readings)} vs ${show(r.readings)}`);
  const asBinary = D.decodeU8(iq, { format: D.BINARY });
  check('one format at a time: the rig\'s Enhanced burst read as Binary is nothing',
    asBinary.readings.length === 0, show(asBinary.readings));
}

// ── Two real ALERT Binary bursts, 18 Bateson, 151.500 MHz ───────────────────
// Recorded by RPi ALERT's Recordings at the 18 Bateson base station (an
// RTL-SDR at 240 ksps, centred on the channel: the burst and 0.4 s either
// side, as its decoder read it) and fetched over the base-station request
// queue: 1957 = 29 on 2026-10-19, about 16 dB over the noise, and 5304 = 41
// on 2026-11-01, about 9 dB — the weak one is the test of a filter change that
// costs sensitivity. Each decoded to exactly this on the station.

for (const [file, id, value] of [['binary_151.500_1957.iq8', 1957, 29], ['binary_151.500_5304_weak.iq8', 5304, 41]]) {
  const v = new Uint8Array(fs.readFileSync(path.join(REPO_ROOT, 'test/fixtures/sdr', file)));
  check(`${file} is 1.25 s of 240 ksps u8 IQ`, v.length === 240000 * 2 * 1.25, `${v.length} bytes`);
  const r = D.decodeU8(v, { format: D.BINARY });
  check(`ALERT Binary off the air: ${id} = ${value}, and nothing else`,
    r.readings.length === 1 && r.readings[0].sensorId === id && r.readings[0].value === value, show(r.readings));
  const asEif = D.decodeU8(v, { format: D.ENHANCED_IFLOWS });
  check(`one format at a time: ${file} read as Enhanced iFLOWS is nothing`, asEif.readings.length === 0, show(asEif.readings));
}

// ── The CRC and the encoder, against the rig's own frames ────────────────────

for (const [w, id, v] of [
  [[0xEF, 0xBF, 0x87, 0x53], 4079, 1807],   // the frozen payload HANDOVER §7 solved
  [[0xEF, 0x3F, 0xD2, 0x08], 4079, 420],
  [[0xF0, 0xBF, 0x3C, 0x4C], 4080, 121],
  [[0xEE, 0x3F, 0x08, 0x01], 4078, 528],
]) {
  const r = D.parseBytes(w, D.ENHANCED_IFLOWS);
  const hex = w.map(b => b.toString(16).toUpperCase()).join(' ');
  check(`${hex} → ${id} = ${v}, CRC valid`, r && r.sensorId === id && r.value === v && r.crcOk === true);
  check(`…and ${id} = ${v} encodes back to ${hex}`, JSON.stringify(D.encodeFrame(D.ENHANCED_IFLOWS, id, v)) === JSON.stringify(w));
  const bad = w.slice(); bad[2] ^= 0x10;
  check(`…and one flipped data bit fails the CRC`, D.parseBytes(bad, D.ENHANCED_IFLOWS).crcOk === false);
}
{
  // The Quansheng firmware's first DEC example: id 2088, value 143, ABF, payload
  // 16067B23 — its bytes, bit-reversed per the console doc, are 68 60 DE C4.
  const w = D.encodeFrame(D.BINARY, 2088, 143);
  const back = D.parseBytes(w, D.BINARY);
  check('Binary 2088 = 143 round-trips', back.sensorId === 2088 && back.value === 143);
  const rev = b => parseInt(b.toString(2).padStart(8, '0').split('').reverse().join(''), 2);
  const payload = w.map(rev).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  check('…and is the same frame the radio reports as payload 16067B23', payload === '16067B23', payload);
}

// ── Noise ─────────────────────────────────────────────────────────────────────

{
  // The high bits: the low byte of a power-of-two LCG repeats every 256
  // samples, which is a comb of spectral lines, not noise.
  let s = 42;
  const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return (s >>> 16) & 255; };
  const noise = new Uint8Array(240000 * 2 * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = rnd();
  for (const f of [D.BINARY, D.ENHANCED_IFLOWS, D.ASCII]) {
    const searched = D.decodeU8(noise, { format: f });
    check(`noise offers the ${f} search no carrier`, searched.candidates.length === 0, `${searched.candidates.length} candidates`);
    const forced = D.decodeU8(noise, { format: f, candidates: [0, 2500, -4000] });
    check(`noise, carriers forced, clears no ${f} vote bar`, forced.readings.length === 0 && forced.combos === 45,
      `${show(forced.readings)}, ${forced.combos} combinations`);
  }
}

// ── Synthesised bursts ───────────────────────────────────────────────────────

for (const c of [
  { f: D.BINARY, ids: [[2088, 143], [2442, 23]], cfo: 0, snr: 25 },
  { f: D.BINARY, ids: [[4109, 1290], [4110, 12]], cfo: 3200, snr: 20, pol: 'NEG' },
  { f: D.ENHANCED_IFLOWS, ids: [[4078, 528], [4079, 420], [4080, 121]], cfo: -2500, snr: 22 },
  { f: D.ASCII, ids: [[42, 17]], cfo: 800, snr: 25 },
  { f: D.BINARY, ids: [[1234, 567]], cfo: -600, snr: 10 },
]) {
  const frames = c.ids.map(([i, v]) => D.encodeFrame(c.f, i, v));
  const r = D.decodeU8(D.synthIq({ frames, seconds: 1.5, startSec: 0.4, cfoHz: c.cfo, snrDb: c.snr, polarity: c.pol, seed: 3 }), { format: c.f });
  const want = c.ids.map(([i, v]) => `${i}=${v}`).sort().join(' ');
  const got = r.readings.map(x => `${x.sensorId}=${x.value}`).sort().join(' ');
  check(`synth ${c.f}${c.pol ? ' ' + c.pol : ''}, ${c.snr} dB, carrier ${c.cfo} Hz → ${want}`, got === want, show(r.readings));
  if (c.pol) check('…and reports the polarity it decoded under', r.readings.every(x => x.polarity === c.pol));
}

// ── The demo band, and bit-flip shadows ──────────────────────────────────────

{
  const band = D.demoBand();
  const msgs = [];
  const p = new D.Pipeline(m => msgs.push(m));
  for (let o = 0; o < band.length; o += 48000) p.feed(band.subarray(o, o + 48000));
  const dec = msgs.filter(m => m.type === 'decode');
  const got = dec.flatMap(m => m.readings.map(x => `${x.sensorId}=${x.value}`)).sort().join(' ');
  check('the demo band: three bursts, five readings, at three strengths',
    msgs.filter(m => m.type === 'burst').length === 3 && got === '2088=143 2442=23 2443=142 4109=1290 4110=12', got);
  const shadows = dec.flatMap(m => m.shadows);
  check('…and a one-bit ghost of 2088 = 143 is reported as its shadow, not as a station',
    shadows.some(s => s.sensorId === 2080 && s.value === 143 && s.of === '2088=143')
    && got.split(' ').every(k => !shadows.some(s => `${s.sensorId}=${s.value}` === k)),
    JSON.stringify(shadows));
}

// ── The live pipeline ────────────────────────────────────────────────────────

{
  const rate = 960000;
  const frames = [[2088, 143], [2443, 142]].map(([i, v]) => D.encodeFrame(D.BINARY, i, v));
  const stream = D.synthIq({ fs: rate, frames, seconds: 4, startSec: 1.5, cfoHz: 50300, snrDb: 25, seed: 9 });
  const msgs = [];
  const p = new D.Pipeline(m => msgs.push(m));
  p.configure({ deviceRate: rate, channelOffsetHz: 50000, format: D.BINARY, gate: true, squelchDb: 8 });
  for (let o = 0; o < stream.length; o += 65536) p.feed(stream.subarray(o, Math.min(stream.length, o + 65536)));
  const of = t => msgs.filter(m => m.type === t);
  check('960 ksps, channel 50 kHz off centre: the gate opens once', of('burst').length === 1, `${of('burst').length} bursts`);
  const dec = of('decode');
  check('…and the burst is decoded once, both frames', dec.length === 1 &&
    dec[0].readings.map(x => `${x.sensorId}=${x.value}`).sort().join(' ') === '2088=143 2443=142',
    dec.map(m => show(m.readings)).join(' | '));
  check('…from a window around the burst, not the whole buffer', dec[0] && dec[0].seconds < 2.5, dec[0] && dec[0].seconds.toFixed(2) + ' s');
  const spec = of('spectrum').pop();
  check('a spectrum is reported, fftSize bins, floor below peak', spec && spec.db.length === 2048 && spec.floorDb < spec.peakDb);
  const lv = of('level').pop();
  check('a level is reported with a noise floor and no clipping', lv && lv.nfDb != null && lv.clipPct === 0 && lv.hist.length === 32);
  check('the scope reports FM audio and the two tones', of('scope').length > 10 && of('scope').some(m => m.mark > 0 && m.space > 0));
  p.capture(2);
  const cap = of('capture')[0];
  check('capture hands back 2 s of 240 ksps u8 IQ', cap && cap.buf.byteLength === 240000 * 2 * 2);

  const msgs2 = [];
  const q = new D.Pipeline(m => msgs2.push(m));
  q.configure({ gate: false });
  const s2 = D.synthIq({ frames, seconds: 4, startSec: 1.0, cfoHz: -1500, snrDb: 25, seed: 4 });
  for (let o = 0; o < s2.length; o += 32768) q.feed(s2.subarray(o, Math.min(s2.length, o + 32768)));
  const d2 = msgs2.filter(m => m.type === 'decode');
  const all = d2.flatMap(m => m.readings.map(x => `${x.sensorId}=${x.value}`));
  check('ungated at 240 ksps: overlapping windows report each reading once',
    all.sort().join(' ') === '2088=143 2443=142', all.join(' '));
  check('…and none of them as a copy', d2.every(m => !(m.copies || []).length), JSON.stringify(d2.map(m => m.copies)));

  // A repeater's copy: the same reading again, 1.2 s later, as its own burst on
  // its own carrier. Not a reading again — but reported, as copy 1, so the
  // repeater's carrier can be measured (#217).
  const msgs3 = [];
  const r3 = new D.Pipeline(m => msgs3.push(m));
  r3.configure({ deviceRate: 240000, channelOffsetHz: 0, format: D.BINARY, gate: true, squelchDb: 8 });
  const one = [D.encodeFrame(D.BINARY, 2088, 143)];
  const s3 = D.synthIq({ fs: 240000, seconds: 5, snrDb: 25, seed: 6, bursts: [
    { startSec: 1.0, frames: one, cfoHz: 300, amp: 30 }, { startSec: 2.2, frames: one, cfoHz: -700, amp: 30 }] });
  for (let o = 0; o < s3.length; o += 32768) r3.feed(s3.subarray(o, Math.min(s3.length, o + 32768)));
  const d3 = msgs3.filter(m => m.type === 'decode' && (m.readings.length || (m.copies || []).length));
  check('a repeater\'s copy 1.2 s later: one reading, then the same reading reported as copy 1 of another burst',
    d3.length === 2 && d3[0].readings.length === 1 && d3[0].readings[0].sensorId === 2088 && !d3[0].copies.length
      && !d3[1].readings.length && d3[1].copies.length === 1 && d3[1].copies[0].sensorId === 2088 && d3[1].copies[0].copy === 1
      && d3[0].burst.t !== d3[1].burst.t,
    JSON.stringify(d3.map(m => ({ r: show(m.readings), c: (m.copies || []).map(x => `${x.sensorId}#${x.copy}`), t: m.burst && m.burst.t }))));
  check('…each reading this burst\'s own, by where its frame starts',
    d3.length === 2 && d3[0].readings[0].own === true && d3[1].copies[0].own === true && d3[0].readings[0].at.length >= 1,
    JSON.stringify(d3.map(m => [...m.readings, ...(m.copies || [])].map(x => ({ id: x.sensorId, own: x.own, at: x.at })))));

  // Two stations keying up 170 ms apart: each window reads both, but neither
  // is a copy, and each reading is its own burst's only in that burst's window.
  const msgs4 = [];
  const r4 = new D.Pipeline(m => msgs4.push(m));
  r4.configure({ deviceRate: 240000, channelOffsetHz: 0, format: D.BINARY, gate: true, squelchDb: 8 });
  const len = (Math.round(0.12 * D.BAUD) + 40 + Math.round(0.05 * D.BAUD)) / D.BAUD;
  const s4 = D.synthIq({ fs: 240000, seconds: 4, snrDb: 25, seed: 8, bursts: [
    { startSec: 1.0, frames: [D.encodeFrame(D.BINARY, 2088, 143)], cfoHz: 300, amp: 30 },
    { startSec: 1.0 + len + 0.17, frames: [D.encodeFrame(D.BINARY, 2443, 142)], cfoHz: -700, amp: 30 }] });
  for (let o = 0; o < s4.length; o += 32768) r4.feed(s4.subarray(o, Math.min(s4.length, o + 32768)));
  const d4 = msgs4.filter(m => m.type === 'decode' && m.burst);
  const ownOf = (m, id) => { const x = m.readings.find(r => r.sensorId === id); return x ? x.own : undefined; };
  check('two stations 170 ms apart: no copies, and a reading read in its neighbour\'s window is not that burst\'s own',
    d4.length === 2 && d4.every(m => !(m.copies || []).length)
      && ownOf(d4[0], 2088) === true && (ownOf(d4[0], 2443) === false || ownOf(d4[0], 2443) === undefined)
      && d4.flatMap(m => m.readings).filter(r => r.sensorId === 2443).length === 1,
    JSON.stringify(d4.map(m => ({ r: m.readings.map(x => `${x.sensorId}:${x.own}:${x.at}`), c: (m.copies || []).map(x => x.sensorId) }))));
}

// ── The lean decoder (#259) ──────────────────────────────────────────────────
//
// decodeWindow({ lean: true }) filters once per carrier guess and nudges after.
// It must read what the full decoder reads — the real bursts, the demo band
// through the live pipeline, and synthesised bursts across SNRs and carrier
// offsets — and do it in clearly less time. Off unless asked for.

{
  const keys = r => r.readings.map(x => `${x.sensorId}=${x.value}`).sort().join(' ');
  const real = [
    ['the rig (Enhanced iFLOWS)', 'testrig_burst_240k.iq8', D.ENHANCED_IFLOWS],
    ['Binary 151.500 #1957', 'binary_151.500_1957.iq8', D.BINARY],
    ['Binary 151.500 #5304, weak', 'binary_151.500_5304_weak.iq8', D.BINARY],
  ];
  for (const [name, file, format] of real) {
    const v = new Uint8Array(fs.readFileSync(path.join(REPO_ROOT, 'test/fixtures/sdr', file)));
    const a = D.decodeU8(v, { format }), b = D.decodeU8(v, { format, lean: true });
    check(`lean reads ${name} as the full decoder does`, keys(a) === keys(b) && a.combos === b.combos, `${keys(a)} | lean ${keys(b)}`);
  }

  let same = 0, n = 0, tFull = 0, tLean = 0;
  const diffs = [];
  for (let t = 0; t < 24; t++) {
    const snr = 3 + (t * 7) % 23, cfo = ((t * 389) % 2400) - 1200, id = 1 + (t * 331) % 8000, val = (t * 97) % 2047;
    const v = D.synthIq({ frames: [D.encodeFrame(D.BINARY, id, val)], seconds: 3, startSec: 1.0, cfoHz: cfo, snrDb: snr, seed: 100 + t });
    const f = D.u8ToFloat(v);
    const a = D.decodeWindow(f.ir, f.ii), b = D.decodeWindow(f.ir, f.ii, { lean: true });
    tFull += a.ms; tLean += b.ms; n++;
    if (keys(a) === keys(b)) same++; else diffs.push(`${snr} dB ${cfo} Hz: ${keys(a)} | lean ${keys(b)}`);
  }
  check('lean reads 24 synthesised Binary bursts (3–25 dB, ±1.2 kHz) exactly as the full decoder does', same === n, diffs.join('; '));
  check('…in under 80% of the time', tLean < 0.8 * tFull, `${Math.round(tFull / n)} ms → ${Math.round(tLean / n)} ms a burst`);

  const run = lean => {
    const out = [];
    const p = new D.Pipeline(m => { if (m.type === 'decode') out.push(...m.readings.map(x => `${x.sensorId}=${x.value}`)); });
    p.configure({ deviceRate: 240000, channelOffsetHz: 0, format: D.BINARY, gate: true, squelchDb: 8, lean });
    const band = D.demoBand();
    for (let o = 0; o < band.length; o += 32768) p.feed(band.subarray(o, Math.min(band.length, o + 32768)));
    return out.sort().join(' ');
  };
  const full = run(false), lean = run(true);
  check('the live pipeline with lean on reads the demo band as with it off', full === lean && full.length > 0, `${full} | lean ${lean}`);
  check('lean is off unless asked for', new D.Pipeline(() => {}).cfg.lean === false);
}

// ── The Worker's source ──────────────────────────────────────────────────────

{
  let ok = true, why = '';
  try { new Function(D.workerSource()); } catch (e) { ok = false; why = e.message; }
  check('workerSource() is a script that parses', ok, why);
  check('…and carries the module and the worker program', /const AlertDsp = \(function alertDspModule/.test(D.workerSource())
    && /self\.onmessage/.test(D.workerSource()));
}

// ── Verdict ──────────────────────────────────────────────────────────────────

const failed = results.filter(r => !r.pass);
console.log('');
console.log(`  ${results.length} assertion(s).`);
if (failed.length) {
  console.log('');
  console.log(`FAIL — ${failed.length} assertion(s):`);
  for (const f of failed) console.log(`  ✗ ${f.name}`);
  process.exit(1);
}
console.log('PASS — the port decodes the rig\'s real burst as the original does, and noise as nothing.');
