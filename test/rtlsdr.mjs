// The RTL-SDR WebUSB driver (rtlsdr.js) against a simulated dongle.
//
// No CI machine has an RTL-SDR on a USB port, so this does the next best
// thing: a fake USBDevice that keeps a register file and answers the way the
// chips do — the RTL2832U's control-transfer register blocks, the demod pages,
// an I2C bus with an R820T at 0x34 or an R828D at 0x74 (registers read back
// from 0, bit-reversed, with a PLL-lock bit and a VCO fine-tune field), and a
// 256-byte EEPROM at 0xa0. The driver opens it, tunes it, sets its gain and
// streams from it, and the checks read what ended up in the registers.
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
  constructor({ tuner = 'R820T', manufacturer = 'RTLSDRBlog', product = 'Blog V3', eeprom7 = 0x02, claimFails = false } = {}) {
    this.manufacturerName = manufacturer;
    this.productName = product;
    this.serialNumber = '00000001';
    this.vendorId = 0x0bda; this.productId = 0x2838;
    this.opened = false; this.configuration = null;
    this.claimFails = claimFails;
    this.regs = {};                       // `${block}:${addr}` → value
    this.demod = {};                      // `${page}:${addr}` → value
    this.tunerAddr = tuner === 'R828D' ? 0x74 : tuner === 'R820T' ? 0x34 : null;
    this.fine = tuner === 'R828D' ? 1 : 2;
    this.t = new Uint8Array(32);          // tuner registers
    this.t[0] = 0x69;
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
      else if (value === this.tunerAddr) for (let i = 1; i < b.length; i++) this.t[b[0] + i - 1] = b[i];
      else if (value === 0xa0) for (let i = 1; i < b.length; i++) this.eeprom[b[0] + i - 1] = b[i];
      else return { status: 'stall' };
    } else {
      this.regs[`${block}:${value}`] = b.length === 2 ? (b[0] << 8) | b[1] : b[0];
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
      if (value === this.tunerAddr) {
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
      } else if (value === 0xa0) {
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
  check('an R820T stick that does not name itself is a V2 (no bias tee, no HF)', info.model === 'v2' && !info.biasTee && info.minHz === 25000000);
  const v3 = await new R.Device(new FakeStick({ manufacturer: 'Realtek', product: 'RTL2838UHIDIR' })).open({ model: 'v3' });
  check('…unless the user says it is a V3', v3.model === 'v3' && v3.directSampling);
  const v4 = await new R.Device(new FakeStick({ manufacturer: 'Realtek', product: 'RTL2838UHIDIR' })).open({ model: 'v4' });
  check('…and a V4 cannot be claimed for an R820T', v4.model === 'v2');
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
  () => check('no Rafael tuner: refused', false),
  e => check('no Rafael tuner: refused, saying which sticks are supported', /R820T or R828D/.test(e.message)));
await new R.Device(new FakeStick({ claimFails: true })).open({}).then(
  () => check('a claimed stick: refused', false),
  e => { const why = R.describeOpenError(e); check('a stick the OS still holds: the reason names the DVB driver and Zadig', /dvb_usb_rtl28xxu/.test(why) && /Zadig/.test(why)); });

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
console.log('PASS — the driver programs a simulated V2, V3 and V4 the way the Blog driver programs real ones.');
