// A simulated RTL-SDR stick: a fake WebUSB USBDevice that keeps a register
// file and answers the way the chips do — see test/rtlsdr.mjs's header for what
// it holds and what it cannot. Shared by rtlsdr.mjs, which drives the driver
// with it, and sdrpi.mjs, which drives the Raspberry Pi relay (sdr-pi/relay.js)
// with it through that same driver.

import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO_ROOT } from './paths.mjs';

const require = createRequire(import.meta.url);
const R = require(path.join(REPO_ROOT, 'rtlsdr.js'));

export class FakeStick {
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
