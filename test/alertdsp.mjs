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
