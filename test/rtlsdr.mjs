// The RTL-SDR WebUSB driver (rtlsdr.js) against a simulated dongle.
//
// No CI machine has an RTL-SDR on a USB port, so this does the next best
// thing: a fake USBDevice that keeps a register file and answers the way the
// chips do — the RTL2832U's control-transfer register blocks, the demod pages,
// an I2C bus with an R820T at 0x34 or an R828D at 0x74 (registers read back
// from 0, bit-reversed, with a PLL-lock bit and a VCO fine-tune field), or an
// FC0012/FC0013 at 0xc6 (plain registers, a VCO calibration readback; the
// FC0012 silent until reset), and a 256-byte EEPROM at 0xa0, or none. The
// driver opens it, tunes it, sets its gain and streams from it, and the checks
// read what ended up in the registers.
//
// What it holds is the arithmetic and the sequences, which is most of what
// can go wrong in a port: the sample-rate ratio, the IF the bandwidth implies,
// the PLL's integer and fractional parts, the gain-step walk, the GPIOs —
// and, model by model, the parts that distinguish a V3 from a V4: direct
// sampling on the Q-branch below 24 MHz, the V4's upconverter, its three
// inputs and its notch filters, the 28.8 MHz versus 16 MHz tuner crystal.
// What it cannot hold is whether the real chips agree; the hardware does that.
//
// Node only. Run:  npm run rtlsdr   (-v to list what passed)

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO_ROOT } from './lib/paths.mjs';

const require = createRequire(import.meta.url);
const R = require(path.join(REPO_ROOT, 'rtlsdr.js'));

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  if (!pass || VERBOSE) console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

// ── the simulated stick ──────────────────────────────────────────────────────

class FakeStick {
  constructor({ tuner = 'R820T', manufacturer = 'RTLSDRBlog', product = 'Blog V3', eeprom7 = 0x02, eeprom = true, claimFails = false } = {}) {
    this.manufacturerName = manufacturer;
    this.productName = product;
    this.serialNumber = '00000001';
    this.vendorId = 0x0bda; this.productId = 0x2838;
    this.opened = false; this.configuration = null;
    this.claimFails = claimFails;
    this.regs = {};                       // `${block}:${addr}` → value
    this.demod = {};                      // `${page}:${addr}` → value
    // An R82xx, an FC0012/FC0013 (plain registers, chip ID at 0), or an E4000 (ID at 2).
    this.kind = /^FC/.test(tuner) ? 'fc' : tuner === 'E4000' ? 'e4k' : 'r82xx';
    this.tunerAddr = { R828D: 0x74, R820T: 0x34, FC0012: 0xc6, FC0013: 0xc6, E4000: 0xc8 }[tuner] || null;
    this.fine = tuner === 'R828D' ? 1 : 2;
    this.t = new Uint8Array(32);          // tuner registers
    this.t[0] = { FC0012: 0xa1, FC0013: 0xa3 }[tuner] || 0x69;
    if (tuner === 'E4000') this.t[2] = 0x40;
    this.needsReset = tuner === 'FC0012'; // answers only after a reset pulse on GPIO 4, as librtlsdr assumes
    this.resetDone = false;
    this.vcoCal = 0x20;                   // what an FC's VCO calibration reads back (reg 0x0e)
    this.fcLog = [];                      // [reg, value] for every FC register write
    this.hasEeprom = eeprom;
    this.eeprom = new Uint8Array(256); this.eeprom[7] = eeprom7;
    this.ptr = {};
    this.writes = 0;
    this.released = false;
  }
  async open() { this.opened = true; }
  async selectConfiguration() { this.configuration = { configurationValue: 1 }; }
  async claimInterface() {
    if (this.claimFails) { const e = new Error('Unable to claim interface.'); e.name = 'NetworkError'; throw e; }
  }
  async releaseInterface() { this.released = true; }
  async close() { this.opened = false; }
  async reset() {}
  async controlTransferOut(setup, data) {
    const b = Array.from(data), { value, index } = setup;
    this.writes++;
    const block = index >> 8;
    if (block === 0 && (value & 0xff) === 0x20) {
      const page = index & 0x0f, addr = value >> 8;
      this.demod[`${page}:${addr}`] = b.length === 2 ? (b[0] << 8) | b[1] : b[0];
    } else if (block === 6) {
      if (b.length === 1) this.ptr[value] = b[0];
      else if (value === this.tunerAddr) {
        for (let i = 1; i < b.length; i++) this.t[b[0] + i - 1] = b[i];
        if (this.kind === 'fc') this.fcLog.push([b[0], b[1]]);
      }
      else if (value === 0xa0 && this.hasEeprom) for (let i = 1; i < b.length; i++) this.eeprom[b[0] + i - 1] = b[i];
      else return { status: 'stall' };
    } else {
      const key = `${block}:${value}`, was = this.regs[key] || 0;
      this.regs[key] = b.length === 2 ? (b[0] << 8) | b[1] : b[0];
      if (key === '2:' + 0x3001 && (was & 0x10) && !(this.regs[key] & 0x10)) this.resetDone = true;   // GPIO 4 pulsed
    }
    return { status: 'ok', bytesWritten: b.length };
  }
  async controlTransferIn(setup, len) {
    const { value, index } = setup;
    const block = index >> 8;
    let out;
    if (block === 0 && (value & 0xff) === 0x20) {
      out = [this.demod[`${index & 0x0f}:${value >> 8}`] || 0];
    } else if (block === 6) {
      if (value === this.tunerAddr && this.kind !== 'r82xx') {
        // An FC or E4000 reads from the register the last 1-byte write named,
        // as written; an FC0012 is silent until it has been reset.
        if (this.needsReset && !this.resetDone) return { status: 'stall', data: new DataView(new ArrayBuffer(0)) };
        const p = this.ptr[value] || 0;
        out = [];
        for (let i = 0; i < len; i++) out.push(this.kind === 'fc' && p + i === 0x0e ? this.vcoCal : this.t[p + i]);
      } else if (value === this.tunerAddr) {
        // An R82xx reads from register 0, each byte bit-reversed on the wire —
        // except that the probe compares the raw first byte with 0x69, so
        // that is what the wire carries. Status bits it reports itself: PLL
        // locked (reg 2 bit 6), VCO fine tune (reg 4 bits 5:4), filter
        // calibration code (reg 4 bits 3:0).
        const v = Array.from(this.t.slice(0, len));
        if (len > 2) v[2] = 0x40 | 0x1a;
        if (len > 4) v[4] = (this.fine << 4) | 0x07;
        out = v.map(R.bitrev);
        out[0] = 0x69;
      } else if (value === 0xa0 && this.hasEeprom) {
        out = [];
        for (let i = 0; i < len; i++) out.push(this.eeprom[(this.ptr[0xa0] || 0) + i]);
        this.ptr[0xa0] = (this.ptr[0xa0] || 0) + len;
      } else return { status: 'stall', data: new DataView(new ArrayBuffer(0)) };
    } else {
      const v = this.regs[`${block}:${value}`] || 0;
      out = len === 2 ? [v & 0xff, v >> 8] : [v & 0xff];
    }
    return { status: 'ok', data: new DataView(Uint8Array.from(out).buffer) };
  }
  async transferIn(ep, len) {
    await new Promise(r => setTimeout(r, 2));
    const u = new Uint8Array(len);
    for (let i = 0; i < len; i++) u[i] = 127 + ((i * 7) % 3);
    return { status: 'ok', data: new DataView(u.buffer) };
  }
  // what the chips hold
  gpo(bit) { return ((this.regs['2:' + 0x3001] || 0) >> bit) & 1; }
  gpoe(bit) { return ((this.regs['2:' + 0x3003] || 0) >> bit) & 1; }
  ifHz() {
    let v = ((this.demod['1:25'] & 0x3f) << 16) | (this.demod['1:26'] << 8) | this.demod['1:27'];
    if (v & 0x200000) v -= 0x400000;      // 22-bit two's complement
    return -v * 28.8e6 / 4194304;
  }
  // the LO an FC tuner's PLL registers program: N = 8·reg2 + reg1, and a
  // signed 15-bit fraction in reg3:reg4, of half the crystal, over the divider
  fcLo(multi, xtal = 28.8e6) {
    const n = 8 * this.t[2] + this.t[1];
    let k = (this.t[3] << 8) | this.t[4];
    if (k >= 32768) k -= 65536;
    return (xtal / 2) * (n + k / 32768) / multi;
  }
  // the LO the PLL registers program, from the registers alone
  lo(ref) {
    const r14 = this.t[0x14], ni = r14 & 0x3f, si = r14 >> 6;
    const nint = 4 * ni + si + 13;
    const sdm = (this.t[0x16] << 8) | this.t[0x15];
    const divNum = this.t[0x10] >> 5;
    const mixDiv = 2 << divNum;
    return 2 * ref * (nint + sdm / 65536) / mixDiv;
  }
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ── a V3 ──────────────────────────────────────────────────────────────────────

{
  const fake = new FakeStick();
  const dev = new R.Device(fake);
  const info = await dev.open({ model: 'auto' });
  check('V3: the R820T answers and the stick names itself a Blog V3', info.tuner === 'R820T' && info.model === 'v3', `${info.tuner} ${info.model}`);
  check('V3: bias tee and direct sampling are offered', info.biasTee && info.directSampling && !info.upconverter);
  check('V3: the baseband is initialised (SDR mode, zero-IF off, spectrum inverted)',
    fake.demod['0:25'] === 0x05 && fake.demod['1:177'] === 0x1a && fake.demod['1:21'] === 0x01);
  check('V3: the default FIR is loaded', fake.demod['1:28'] === 0xca && fake.demod['1:47'] === 0xa5);

  const real = await dev.setSampleRate(240000);
  // Ratio 0x1E000000. The chip holds bits 27..2 and rebuilds bit 28 from bit
  // 27, so 0x9f carries 0x0E00 — librtlsdr's `& 0x0ffffffc` does the same.
  check('240 ksps is exact: ratio 0x1E000000, written as 0x0E00 0000', real === 240000 && fake.demod['1:159'] === 0x0e00 && fake.demod['1:161'] === 0x0000,
    `${real}, ${fake.demod['1:159'].toString(16)} ${fake.demod['1:161'].toString(16)}`);
  check('…and the narrow IF filter puts the IF at 2.125 MHz', dev.ifFreq === 2125000 && near(fake.ifHz(), 2125000, 10), `${dev.ifFreq}, regs say ${fake.ifHz().toFixed(0)}`);
  await dev.setSampleRate(2400000);
  check('2.4 Msps: the IF moves to 1.815 MHz', dev.ifFreq === 1815000, String(dev.ifFreq));
  await dev.setSampleRate(240000);

  const t = await dev.setFrequency(151500000);
  const lo = fake.lo(28.8e6);
  check('151.5 MHz: the PLL registers program LO = RF + IF', near(lo, 151.5e6 + 2125000, 1500), `${(lo / 1e6).toFixed(6)} MHz`);
  check('…÷16 mixer divider, N = 42 (ni 7, si 1)', fake.t[0x14] === 71 && (fake.t[0x10] >> 5) === 3, `0x14=${fake.t[0x14]} div=${fake.t[0x10] >> 5}`);
  check('…tuned within 1.5 kHz, through the tuner', t.mode === 'tuner' && Math.abs(t.errorHz) < 1500, `${t.mode} ${t.errorHz} Hz`);
  check('…with the 140–180 MHz tracking filter', fake.t[0x1b] === 0x14);

  const g = await dev.setGain(296);
  check('gain 29.6 dB walks to LNA step 8, mixer step 8 = 29.7 dB', g === 297 && (fake.t[5] & 0x0f) === 8 && (fake.t[7] & 0x0f) === 8,
    `${g}, lna ${fake.t[5] & 0x0f}, mix ${fake.t[7] & 0x0f}`);
  check('…manual: LNA and mixer AGC off', (fake.t[5] & 0x10) === 0x10 && (fake.t[7] & 0x10) === 0);
  check('every offered gain is a step the walk lands on exactly', await (async () => {
    for (const s of R.GAINS) if (await dev.setGain(s) !== s) return false;
    return true;
  })());
  await dev.setGain(null);
  check('auto gain: LNA and mixer AGC on, VGA 26.5 dB', (fake.t[5] & 0x10) === 0 && (fake.t[7] & 0x10) === 0x10 && (fake.t[0x0c] & 0x9f) === 0x0b);

  await dev.setAgc(true);
  check('RTL AGC on', fake.demod['0:25'] === 0x25);
  await dev.setAgc(false);

  await dev.setBiasTee(true);
  check('bias tee on: GPIO 0 an output, driven high', fake.gpo(0) === 1 && fake.gpoe(0) === 1);
  await dev.setBiasTee(false);
  check('bias tee off', fake.gpo(0) === 0);

  const hf = await dev.setFrequency(7100000);
  check('7.1 MHz on a V3: direct sampling on the Q-branch, automatically', hf.mode === 'direct-Q' && fake.demod['0:6'] === 0x90 && fake.demod['1:21'] === 0x00,
    `${hf.mode} 0x06=${(fake.demod['0:6'] || 0).toString(16)}`);
  check('…the tuner in standby, the RTL\'s own IF at 7.1 MHz', fake.t[0x06] === 0xb1 && near(fake.ifHz(), 7100000, 10), fake.ifHz().toFixed(0));
  const back = await dev.setFrequency(151500000);
  check('…and back to VHF: tuner re-initialised, spectrum inverted again', back.mode === 'tuner' && fake.demod['0:6'] === 0x80 && fake.demod['1:21'] === 0x01);
  await dev.setDirectSampling('off');
  await dev.setFrequency(7100000).then(
    () => check('direct sampling forced off: 7.1 MHz is refused, not mis-tuned', false),
    e => check('direct sampling forced off: 7.1 MHz is refused, not mis-tuned', /No mixer divider/.test(e.message), e.message));
  await dev.setFrequency(26000000).then(r => check('26 MHz is the bottom of the tuner\'s reach and tunes', r.mode === 'tuner'),
    e => check('26 MHz is the bottom of the tuner\'s reach and tunes', false, e.message));

  await dev.setPpm(10);
  check('+10 ppm: the sample clock correction is written', fake.demod['1:63'] === ((-Math.round(10 * 16777216 / 1e6)) & 0xff));

  await dev.setSampleRate(500000).then(() => check('500 ksps is refused (the RTL2832U\'s gap)', false), e => check('500 ksps is refused (the RTL2832U\'s gap)', /225/.test(e.message)));

  let chunks = 0, bytes = 0;
  const size = await dev.start(u8 => { chunks++; bytes += u8.length; }, { inflight: 3 });
  await new Promise(r => setTimeout(r, 60));
  await dev.stop();
  check('streaming: transfers arrive, a multiple of 512 bytes each', chunks > 3 && size % 512 === 0 && bytes === chunks * size, `${chunks} × ${size}`);
  check('…and the FIFO was reset first', fake.regs['1:' + 0x2148] === 0x0000);
  await dev.close();
  check('close: tuner to standby, interface released', fake.t[0x05] === 0xa0 && fake.released);
}

// ── a V4 ──────────────────────────────────────────────────────────────────────

{
  const fake = new FakeStick({ tuner: 'R828D', product: 'Blog V4' });
  const dev = new R.Device(fake);
  const info = await dev.open({});
  check('V4: an R828D at 0x74 that names itself "Blog V4"', info.tuner === 'R828D' && info.model === 'v4', `${info.tuner} ${info.model}`);
  check('V4: upconverter, bias tee, no direct sampling; tunes from 0.5 MHz', info.upconverter && info.biasTee && !info.directSampling && info.minHz === 500000);
  await dev.setSampleRate(960000);
  const hf = await dev.setFrequency(7100000);
  check('7.1 MHz on a V4: through the upconverter, LO = 7.1 + 28.8 MHz + IF', hf.mode === 'upconverter' && near(fake.lo(28.8e6), 7.1e6 + 28.8e6 + dev.ifFreq, 1500),
    `${hf.mode} ${(fake.lo(28.8e6) / 1e6).toFixed(4)} MHz`);
  check('…on cable 2 (HF), upconverter switch GPIO 5 low, tracking filter bypassed',
    (fake.t[0x06] & 0x08) === 0x08 && fake.gpo(5) === 0 && fake.gpoe(5) === 1 && fake.t[0x1b] === 0x00 && (fake.t[0x1a] & 0xc3) === 0x40);
  await dev.setFrequency(151500000);
  check('151.5 MHz: cable 1 (VHF), GPIO 5 high, air input off', (fake.t[0x06] & 0x08) === 0 && fake.gpo(5) === 1 && (fake.t[0x05] & 0x60) === 0x60);
  check('…notch filters on (outside the FM and DAB bands)', (fake.t[0x17] & 0x08) === 0x08);
  check('…the PLL from a 28.8 MHz crystal', near(fake.lo(28.8e6), 151.5e6 + dev.ifFreq, 1500));
  await dev.setFrequency(98000000);
  check('98 MHz, inside the FM band: notch filters off', (fake.t[0x17] & 0x08) === 0);
  await dev.setFrequency(433920000);
  check('433.92 MHz: the air input (UHF), cable 1 off', (fake.t[0x05] & 0x60) === 0x00);
  await dev.close();
}

// ── a V2: FC0013, zero-IF, offset-tuned ──────────────────────────────────────
//
// Brought up against librtlsdr on a real RTL-SDR Blog V2 (an FC0013 that calls
// itself "Generic" / "RTL2832U", one USB interface, no EEPROM): the same
// carrier at the same frequency, the same noise at each gain. These hold the
// registers that got it there.

{
  const fake = new FakeStick({ tuner: 'FC0013', manufacturer: 'Generic', product: 'RTL2832U', eeprom: false, eeprom7: 0x00 });
  const dev = new R.Device(fake);
  const info = await dev.open({});
  check('V2: an FC0013 at 0xc6 (ID 0xa3) — a generic FC0013 until the user says V2', info.tuner === 'FC0013' && info.model === 'fc0013' && info.zeroIf, `${info.tuner} ${info.model}`);
  check('…22–1100 MHz, and 23 LNA steps from -9.9 to 19.7 dB', info.minHz === 22e6 && info.maxHz === 1100e6 && info.gains.length === 23 && info.gains[0] === -99 && info.gains[22] === 197);
  check('…the RTL2832U zero-IF: I and Q sampled, spectrum upright', fake.demod['1:177'] === 0x1b && fake.demod['0:8'] === 0xcd && fake.demod['1:21'] === 0x00);
  check('…the tuner initialised: 28.8 MHz crystal bit, dual master, loop-through off', (fake.t[0x07] & 0x20) === 0x20 && fake.t[0x0c] === 0xfe && fake.t[0x09] === 0x6e);
  check('…and left as librtlsdr\'s tools leave it: tuner AGC, IF gain fixed', (fake.t[0x0d] & 0x08) === 0 && fake.t[0x13] === 0x0a);
  check('…no EEPROM read, no bias tee forced, nothing on GPIO 0', !info.forceBiasTee && fake.gpo(0) === 0);

  await dev.setSampleRate(960000);
  check('960 ksps: the offset is 0.85 × the rate, 816 kHz, on the RTL\'s IF', dev.ifFreq === 816000 && near(fake.ifHz(), 816000, 10), `${dev.ifFreq}, regs ${fake.ifHz().toFixed(0)}`);
  const t = await dev.setFrequency(151500000);
  check('151.5 MHz: the LO 816 kHz below it, in the ÷16 band', near(fake.fcLo(16), 151.5e6 - 816000, 100) && fake.t[0x05] === 0x47,
    `${(fake.fcLo(16) / 1e6).toFixed(6)} MHz, 0x05=${fake.t[0x05].toString(16)}`);
  check('…tuned within 100 Hz, offset', t.mode === 'offset' && Math.abs(t.errorHz) < 100, `${t.mode} ${t.errorHz} Hz`);
  check('…VHF: the VHF filter in, the UHF input off, tracking filter 7', (fake.t[0x07] & 0x10) === 0x10 && (fake.t[0x14] & 0xe0) === 0 && (fake.t[0x1d] & 0x1c) === 0x1c);
  check('…6 MHz IF filter, clock out, the low VCO', fake.t[0x06] === 0xa2, fake.t[0x06].toString(16));
  const cal = fake.fcLog.filter(([r]) => r === 0x0e).slice(-3).map(([, v]) => v).join();
  check('…and the VCO calibrated (0x80, then 0x00)', cal === '128,0,0', cal);
  await dev.setFrequency(210000000);
  check('210 MHz: VHF tracking filter 2', (fake.t[0x1d] & 0x1c) === 0x08);
  await dev.setFrequency(45000000);
  check('45 MHz: the ÷64 band, with its bit in 0x11', (fake.t[0x11] & 0x04) === 0x04 && near(fake.fcLo(64), 45e6 - 816000, 100));
  await dev.setFrequency(433920000);
  check('433.92 MHz: the UHF input, the VHF filter out, ÷8', (fake.t[0x14] & 0xe0) === 0x40 && (fake.t[0x07] & 0x10) === 0
    && (fake.t[0x11] & 0x04) === 0 && near(fake.fcLo(8), 433.92e6 - 816000, 300));
  await dev.setSampleRate(2400000);
  await dev.setFrequency(1090000000);
  check('1090 MHz at 2.4 Msps: offset 2.04 MHz, the ÷2 band', dev.ifFreq === 2040000 && fake.t[0x05] === 0x0f && near(fake.fcLo(2), 1090e6 - 2040000, 600));
  await dev.setFrequency(10000000).then(
    () => check('10 MHz is refused (below the FC0013), not mis-tuned', false),
    e => check('10 MHz is refused (below the FC0013), not mis-tuned', /No PLL setting/.test(e.message), e.message));

  // a VCO that calibrates at the end of its range: the other one is taken
  fake.vcoCal = 0x01;
  await dev.setSampleRate(960000);
  await dev.setFrequency(151500000);
  check('a low VCO that calibrates at its floor switches to the high VCO', (fake.t[0x06] & 0x08) === 0x08);
  fake.vcoCal = 0x3f;
  await dev.setFrequency(101000000);       // LO 100.184 MHz × 32: the high VCO
  check('…and a high one at its ceiling to the low', (fake.t[0x06] & 0x08) === 0);
  fake.vcoCal = 0x20;

  const g = await dev.setGain(-99);
  check('gain -9.9 dB: LNA forced, code 0x02, IF gain fixed', g === -99 && (fake.t[0x0d] & 0x08) === 0x08 && (fake.t[0x14] & 0x1f) === 0x02 && fake.t[0x13] === 0x0a);
  check('…and the band bits above the code left alone', (fake.t[0x14] & 0xe0) === 0x00);
  check('every offered gain is a step it lands on exactly', await (async () => {
    for (const s of info.gains) if (await dev.setGain(s) !== s) return false;
    return true;
  })());
  check('10 dB, between steps: the next step up (17.9 dB)', await dev.setGain(100) === 179);
  await dev.setGain(null);
  check('auto gain: the FC0013\'s own AGC', (fake.t[0x0d] & 0x08) === 0);
  await dev.close();
  check('close: no R82xx standby written to an FC tuner, interface released', fake.t[0x05] !== 0xa0 && fake.released);
}
{
  const fake = new FakeStick({ tuner: 'FC0013', manufacturer: 'Generic', product: 'RTL2832U', eeprom: false });
  const dev = new R.Device(fake);
  const info = await dev.open({ model: 'v2' });
  check('picked as a Blog V2: the bias tee is offered, not forced', info.model === 'v2' && info.biasTee && !info.forceBiasTee && fake.gpo(0) === 0);
  await dev.setBiasTee(true);
  check('…and on GPIO 0 when asked for', fake.gpo(0) === 1 && fake.gpoe(0) === 1);
  await dev.close();
}

// ── an FC0012 ────────────────────────────────────────────────────────────────

{
  const fake = new FakeStick({ tuner: 'FC0012', manufacturer: 'Generic', product: 'RTL2832U' });
  const dev = new R.Device(fake);
  const info = await dev.open({});
  check('FC0012: found at 0xc6 (ID 0xa1) after a reset pulse on GPIO 4', info.tuner === 'FC0012' && info.model === 'fc0012' && fake.resetDone);
  check('…GPIO 6 made an output for its band filter; 22–948.6 MHz; 5 LNA steps',
    fake.gpoe(6) === 1 && info.maxHz === 948600000 && info.gains.join() === '-99,-40,71,179,192');
  await dev.setSampleRate(960000);
  await dev.setFrequency(151500000);
  check('151.5 MHz: its VHF filter (GPIO 6 low), the FC0012\'s ÷16 code', fake.gpo(6) === 0 && fake.t[0x05] === 0x27 && near(fake.fcLo(16), 151.5e6 - 816000, 100));
  await dev.setFrequency(433920000);
  check('433.92 MHz: its UHF filter (GPIO 6 high)', fake.gpo(6) === 1);
  check('…and none of the FC0013\'s band registers touched', fake.t[0x1d] === 0 && fake.t[0x14] === 0x00);
  await dev.setGain(179);
  check('gain 17.9 dB: code 0x17 in register 0x13', (fake.t[0x13] & 0x1f) === 0x17);
  await dev.setGain(null);
  check('…and "auto" is its start-up gain (code 0x00)', (fake.t[0x13] & 0x1f) === 0x00);
  await dev.close();
}

// ── a generic R828D, a V2, and the things that go wrong ──────────────────────

{
  const fake = new FakeStick({ tuner: 'R828D', manufacturer: 'Realtek', product: 'RTL2838UHIDIR' });
  const dev = new R.Device(fake);
  const info = await dev.open({});
  await dev.setSampleRate(2400000);
  await dev.setFrequency(151500000);
  check('a generic R828D: 16 MHz crystal, cable 1 below 345 MHz', info.model === 'r828d' && near(fake.lo(16e6), 151.5e6 + dev.ifFreq, 1500)
    && (fake.t[0x05] & 0x60) === 0x60, `${info.model} ${(fake.lo(16e6) / 1e6).toFixed(4)}`);
  await dev.close();
}
{
  const fake = new FakeStick({ manufacturer: 'Realtek', product: 'RTL2838UHIDIR' });
  const info = await new R.Device(fake).open({});
  check('an R820T stick that does not name itself is a generic R820T (no bias tee, no HF)', info.model === 'r820t' && !info.biasTee && info.minHz === 25000000);
  const v3 = await new R.Device(new FakeStick({ manufacturer: 'Realtek', product: 'RTL2838UHIDIR' })).open({ model: 'v3' });
  check('…unless the user says it is a V3', v3.model === 'v3' && v3.directSampling);
  const v4 = await new R.Device(new FakeStick({ manufacturer: 'Realtek', product: 'RTL2838UHIDIR' })).open({ model: 'v4' });
  check('…and a V4 cannot be claimed for an R820T', v4.model === 'r820t');
  const v2 = await new R.Device(new FakeStick({ manufacturer: 'Realtek', product: 'RTL2838UHIDIR' })).open({ model: 'v2' });
  check('…nor a V2 (an FC0012/FC0013 stick)', v2.model === 'r820t');
  const e7 = new FakeStick({ manufacturer: 'Realtek', product: 'RTL2832U', eeprom7: 0x00 });
  const gi = await new R.Device(e7).open({});
  check('a generic stick with EEPROM byte 7 bit 1 clear (IR off) is not taken as "bias tee forced on"', !gi.forceBiasTee && e7.gpo(0) === 0);
}
{
  const fake = new FakeStick({ eeprom7: 0x00 });
  const dev = new R.Device(fake);
  const info = await dev.open({});
  check('EEPROM forces the bias tee: on at open', info.forceBiasTee && fake.gpo(0) === 1);
  await dev.setBiasTee(false);
  check('…and it stays on when asked off, as in the Blog driver', fake.gpo(0) === 1);
}
await new R.Device(new FakeStick({ tuner: null })).open({}).then(
  () => check('no tuner answering: refused', false),
  e => check('no tuner answering: refused, saying which tuners are supported', /No tuner/.test(e.message) && /R828D/.test(e.message) && /FC0013/.test(e.message), e.message));
await new R.Device(new FakeStick({ tuner: 'E4000' })).open({}).then(
  () => check('an E4000 stick: refused', false),
  e => check('an E4000 stick: refused, naming the tuner it found', /has an Elonics E4000 tuner/.test(e.message), e.message));
await new R.Device(new FakeStick({ claimFails: true })).open({}).then(
  () => check('a claimed stick: refused', false),
  e => {
    const why = R.describeOpenError(e);
    check('a stick the OS still holds: the reason names the DVB driver, the Windows driver installer and Zadig',
      /dvb_usb_rtl28xxu/.test(why) && why.includes(R.WINDOWS_INSTALLER) && /Zadig/.test(why));
  });

// ── the Windows driver installer ─────────────────────────────────────────────
//
// On Windows a stick with no WinUSB driver never reaches the browser's
// chooser, so the card links tools/install-rtlsdr-driver.cmd. It finds sticks
// by its own list of IDs: this holds that list to FILTERS, and the file to the
// shape cmd.exe needs, since it is a batch file and a PowerShell script at once.

{
  const file = path.join(REPO_ROOT, R.WINDOWS_INSTALLER);
  const exists = fs.existsSync(file);
  check('the Windows driver installer the card links is in the repo', exists, R.WINDOWS_INSTALLER);
  if (exists) {
    const buf = fs.readFileSync(file);
    const text = buf.toString('latin1');
    check('…plain ASCII, no byte-order mark: cmd.exe reads its first lines', buf.every(b => b < 0x80));
    check('…a batch file that hands itself to PowerShell: "<# :" first, "#>" closing the batch part',
      text.startsWith('<# :') && /\r?\n#>\r?\n/.test(text));
    const line = (text.match(/^\$StickIds = @\((.*)\)\s*$/m) || [])[1] || '';
    const hex = n => n.toString(16).padStart(4, '0');
    const ids = [...line.matchAll(/VID_([0-9A-F]{4})&PID_([0-9A-F]{4})/gi)].map(m => `${m[1]}:${m[2]}`.toLowerCase()).sort();
    const want = R.FILTERS.map(f => `${hex(f.vendorId)}:${hex(f.productId)}`).sort();
    check('…and it looks for exactly the sticks the browser is asked for (FILTERS)', ids.join() === want.join(),
      `installer ${ids.join(' ') || 'none'}, FILTERS ${want.join(' ')}`);
  }
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
console.log('PASS — the driver programs a simulated V2 (FC0013), V3, V4 and FC0012 the way librtlsdr and the Blog driver program real ones.');
