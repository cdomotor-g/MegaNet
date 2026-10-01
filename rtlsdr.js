// MegaNet — rtlsdr.js
//
//   RtlSdr   a WebUSB driver for RTL2832U dongles with a Rafael R820T/R820T2
//            or R828D tuner — the RTL-SDR Blog V2-era sticks, the V3 and the
//            V4 — enough of one to tune, set gain, and stream 8-bit IQ into
//            the Serial Monitor's RTL-SDR card.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches for nothing but the USBDevice it is handed: no DOM, no state. That
// is what lets test/rtlsdr.mjs drive it under Node against a simulated dongle
// (a register file that answers like the chips do) — the guarded
// module.exports at the foot is the door. Real hardware is the check that
// matters; the simulation holds the arithmetic and the register sequences.
//
// ── What this is built from ─────────────────────────────────────────────────
//
// The shape — a control-transfer register layer, a baseband init, a tuner
// object with shadow registers — is rtlsdrjs's (Google's radioreceiver, ported
// to WebUSB by Sandeep Mistry; Apache-2.0). Its R820T support is a minimal
// one: a fixed 3.57 MHz IF, no R828D, no bandwidth, no GPIOs. What it lacks is
// written here from what the RTL-SDR Blog's own driver (rtlsdrblog/rtl-sdr-blog)
// does with these chips: the register addresses and values are the hardware's
// interface, and the behaviours below are that driver's, re-expressed:
//
//   * IF and filter from the sample rate (r82xx_set_bandwidth): at 240 ksps
//     the IF drops to 2.125 MHz and the narrowest IF filters engage.
//   * V3 (R820T2): bias tee on GPIO 0; below 24 MHz the tuner is bypassed and
//     the RTL2832U samples the Q-branch directly (direct sampling, "auto").
//   * V4 (R828D, identified by its USB strings "RTLSDRBlog" / "Blog V4"): a
//     28.8 MHz tuner crystal, not the R828D's usual 16; below 28.8 MHz it tunes
//     freq + 28.8 MHz through the on-board upconverter; it switches between
//     its three inputs (HF cable 2, VHF cable 1, UHF air) and drives the
//     upconverter path switch on GPIO 5; and it turns the FM / DAB notch
//     filters off when tuned inside those bands. Bias tee on GPIO 0.
//   * Any other R828D: 16 MHz crystal, cable 1 below 345 MHz, air above.
//   * Every tune forces the VGA to 16.3 dB and the VCO current to maximum —
//     the Blog driver's "hacks", kept because they are what its users run.
//
// ── What the browser needs ──────────────────────────────────────────────────
//
// WebUSB: Chrome or Edge, https or localhost. The operating system must let go
// of the stick first — exactly as for rtl_sdr:
//   Windows  WinUSB on the dongle's interface 0 (Zadig), as for SDR# and rtl_tcp.
//   Linux    the DVB-T driver claims it: `sudo rmmod dvb_usb_rtl28xxu`, or
//            blacklist it; and a udev rule for 0bda:2838 so it is not root-only.
//   macOS    nothing to do.
// docs/serial-sdr.md says this at length; describeOpenError() says it briefly.

const RtlSdr = (function () {
  const FILTERS = [{ vendorId: 0x0bda, productId: 0x2838 }, { vendorId: 0x0bda, productId: 0x2832 }];

  const RTL_XTAL = 28800000;
  const R828D_XTAL = 16000000;
  const BLOCK = { DEMOD: 0, USB: 1, SYS: 2, TUN: 3, ROM: 4, IR: 5, IIC: 6 };
  const REG = {
    USB_SYSCTL: 0x2000, USB_EPA_CTL: 0x2148, USB_EPA_MAXPKT: 0x2158,
    DEMOD_CTL: 0x3000, GPO: 0x3001, GPI: 0x3002, GPOE: 0x3003, GPD: 0x3004, DEMOD_CTL_1: 0x300b,
  };
  const I2C = { R820T: 0x34, R828D: 0x74, EEPROM: 0xa0 };

  // The default FIR the RTL2832U ships with, packed as the chip wants it
  // (eight 8-bit taps, then eight 12-bit taps in pairs).
  const FIR = [0xca, 0xdc, 0xd7, 0xd8, 0xe0, 0xf2, 0x0e, 0x35, 0x06, 0x50, 0x9c, 0x0d, 0x71, 0x11, 0x14, 0x71, 0x74, 0x19, 0x41, 0xa5];

  // R82xx registers 0x05-0x1f at power-up.
  const R82XX_INIT = [0x83, 0x30, 0x75, 0xc0, 0x40, 0xd6, 0x6c, 0xf5, 0x63, 0x75, 0x68, 0x6c, 0x83, 0x80, 0x00,
    0x0f, 0x00, 0xc0, 0x30, 0x48, 0xcc, 0x60, 0x00, 0x54, 0xae, 0x4a, 0xc0];

  // [start MHz, open_d, rf_mux_ploy, tf_c] — the tracking filter by band.
  const MUX = [
    [0, 0x08, 0x02, 0xdf], [50, 0x08, 0x02, 0xbe], [55, 0x08, 0x02, 0x8b], [60, 0x08, 0x02, 0x7b],
    [65, 0x08, 0x02, 0x69], [70, 0x08, 0x02, 0x58], [75, 0x00, 0x02, 0x44], [80, 0x00, 0x02, 0x44],
    [90, 0x00, 0x02, 0x34], [100, 0x00, 0x02, 0x34], [110, 0x00, 0x02, 0x24], [120, 0x00, 0x02, 0x24],
    [140, 0x00, 0x02, 0x14], [180, 0x00, 0x02, 0x13], [220, 0x00, 0x02, 0x13], [250, 0x00, 0x02, 0x11],
    [280, 0x00, 0x02, 0x00], [310, 0x00, 0x41, 0x00], [450, 0x00, 0x41, 0x00], [588, 0x00, 0x40, 0x00],
    [650, 0x00, 0x40, 0x00],
  ];

  // LNA and mixer gain steps, tenths of a dB (measured by steve-m on an R820T).
  const LNA_STEPS = [0, 9, 13, 40, 38, 13, 31, 22, 26, 31, 26, 14, 19, 5, 35, 13];
  const MIX_STEPS = [0, 5, 10, 10, 19, 9, 10, 25, 17, 10, 8, 16, 13, 6, 3, -8];
  // The gains rtl_sdr offers, tenths of a dB: the running sum of the steps above.
  const GAINS = [0, 9, 14, 27, 37, 77, 87, 125, 144, 157, 166, 197, 207, 229, 254, 280, 297, 328, 338, 364,
    372, 386, 402, 421, 434, 439, 445, 480, 496];

  const IF_LPF = [1700000, 1600000, 1550000, 1450000, 1200000, 900000, 700000, 550000, 450000, 350000];

  const MODELS = {
    auto: { label: 'Detect from the stick' },
    v2: { label: 'RTL-SDR Blog V2 / generic R820T(2)', tuner: 'R820T', biasTee: false, direct: false,
      note: 'Tunes about 25–1766 MHz. No bias tee or HF direct sampling unless the stick has been modified.' },
    v3: { label: 'RTL-SDR Blog V3 (R820T2)', tuner: 'R820T', biasTee: true, direct: true,
      note: 'Tunes about 25–1766 MHz on the tuner, and 0.5–24 MHz by direct sampling on the Q-branch (HF on the same SMA).' },
    v4: { label: 'RTL-SDR Blog V4 (R828D)', tuner: 'R828D', biasTee: true, direct: false, upconverter: true,
      note: 'Tunes 0.5–1766 MHz: below 28.8 MHz through its built-in upconverter. FM and DAB notch filters switch themselves.' },
    r828d: { label: 'Generic R828D', tuner: 'R828D', biasTee: false, direct: false,
      note: 'A 16 MHz-crystal R828D stick (not a Blog V4).' },
  };

  function supported() { return typeof navigator !== 'undefined' && !!navigator.usb; }
  async function request() { return navigator.usb.requestDevice({ filters: FILTERS }); }
  async function known() {
    if (!supported()) return [];
    const all = await navigator.usb.getDevices();
    return all.filter(d => FILTERS.some(f => f.vendorId === d.vendorId && f.productId === d.productId));
  }

  function label(dev) {
    const m = dev.manufacturerName || '', p = dev.productName || '';
    const s = dev.serialNumber ? ' s/n ' + dev.serialNumber : '';
    return ((m + ' ' + p).trim() || 'RTL2832U') + s;
  }

  // A plain-English cause for what WebUSB throws on open/claim.
  function describeOpenError(e) {
    const msg = (e && e.message) || String(e);
    const name = e && e.name;
    if (/claim/i.test(msg) || name === 'NetworkError' || name === 'InvalidStateError') {
      return 'The computer would not hand the stick over (' + msg + '). Something else has it: on Linux the '
        + 'DVB-T driver — run `sudo rmmod dvb_usb_rtl28xxu` (or blacklist it) and re-plug; on Windows the '
        + 'stick needs the WinUSB driver (Zadig, interface 0), as for SDR#; anywhere, close rtl_tcp, SDR#, '
        + 'SDR++ or another tab using it.';
    }
    if (name === 'SecurityError') return 'The browser blocked USB access (' + msg + '). WebUSB needs https or localhost, and no IT policy blocking it.';
    if (name === 'NotFoundError') return 'The stick is no longer connected. Re-plug it and choose it again.';
    return msg;
  }

  const bitrev = b => {
    let r = 0;
    for (let i = 0; i < 8; i++) if (b & (1 << i)) r |= 0x80 >> i;
    return r;
  };

  class Device {
    constructor(usb, log) {
      this.usb = usb;
      this.log = log || (() => {});
      this.queue = Promise.resolve();
      this.tuner = null;            // 'R820T' | 'R828D'
      this.model = null;            // a MODELS key
      this.ppm = 0;
      this.rate = 0;
      this.freq = 0;
      this.ifFreq = 3570000;
      this.bw = 0;
      this.gain = null;             // null = tuner AGC, else tenths of a dB
      this.agc = false;
      this.biasTee = false;
      this.forceBiasTee = false;
      this.directMode = 'auto';     // auto | off | i | q
      this.direct = 0;              // 0 off, 1 I, 2 Q — what is in effect
      this.input = 0;               // R82xx input in effect
      this.regs = new Uint8Array(R82XX_INIT);
      this.hasLock = false;
      this.streaming = false;
      this.stats = { transfers: 0, bytes: 0, errors: 0, startedAt: 0 };
    }

    // Every control sequence runs one at a time: a gain change mid-tune would
    // interleave I2C writes through the one repeater.
    serial(fn) {
      const p = this.queue.then(fn, fn);
      this.queue = p.catch(() => {});
      return p;
    }

    // ── register layer ───────────────────────────────────────────────────────

    async ctrlOut(value, index, bytes) {
      const r = await this.usb.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 0, value, index }, new Uint8Array(bytes));
      if (r && r.status && r.status !== 'ok') throw new Error('USB write ' + r.status + ' (value 0x' + value.toString(16) + ', index 0x' + index.toString(16) + ')');
    }
    async ctrlIn(value, index, len) {
      const r = await this.usb.controlTransferIn({ requestType: 'vendor', recipient: 'device', request: 0, value, index }, Math.max(1, len));
      if (r.status && r.status !== 'ok') throw new Error('USB read ' + r.status + ' (value 0x' + value.toString(16) + ', index 0x' + index.toString(16) + ')');
      return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
    }
    writeReg(block, addr, val, len) {
      return this.ctrlOut(addr, (block << 8) | 0x10, len === 2 ? [(val >> 8) & 0xff, val & 0xff] : [val & 0xff]);
    }
    async readReg(block, addr, len) {
      const d = await this.ctrlIn(addr, block << 8, len || 1);
      return len === 2 ? (d[1] << 8) | d[0] : d[0];
    }
    async demodWrite(page, addr, val, len) {
      await this.ctrlOut((addr << 8) | 0x20, 0x10 | page, len === 2 ? [(val >> 8) & 0xff, val & 0xff] : [val & 0xff]);
      await this.demodRead(0x0a, 0x01);       // the chip wants a read after every demod write
    }
    async demodRead(page, addr) { return (await this.ctrlIn((addr << 8) | 0x20, page, 1))[0]; }
    i2cWrite(addr, bytes) { return this.ctrlOut(addr, (BLOCK.IIC << 8) | 0x10, bytes); }
    i2cRead(addr, len) { return this.ctrlIn(addr, BLOCK.IIC << 8, len); }
    async i2cReadReg(addr, reg) {
      try { await this.i2cWrite(addr, [reg]); return (await this.i2cRead(addr, 1))[0]; } catch (_) { return null; }
    }
    repeater(on) { return this.demodWrite(1, 0x01, on ? 0x18 : 0x10, 1); }

    async gpioOutput(bit) {
      const m = 1 << bit;
      await this.writeReg(BLOCK.SYS, REG.GPD, (await this.readReg(BLOCK.SYS, REG.GPD, 1)) & ~m, 1);
      await this.writeReg(BLOCK.SYS, REG.GPOE, (await this.readReg(BLOCK.SYS, REG.GPOE, 1)) | m, 1);
    }
    async gpioBit(bit, on) {
      const m = 1 << bit, r = await this.readReg(BLOCK.SYS, REG.GPO, 1);
      await this.writeReg(BLOCK.SYS, REG.GPO, on ? (r | m) : (r & ~m), 1);
    }

    // ── R82xx ────────────────────────────────────────────────────────────────

    get i2cAddr() { return this.tuner === 'R828D' ? I2C.R828D : I2C.R820T; }
    get tunerXtal() {
      const base = (this.tuner === 'R828D' && this.model !== 'v4') ? R828D_XTAL : RTL_XTAL;
      return Math.round(base * (1 + this.ppm / 1e6));
    }
    get rtlXtal() { return RTL_XTAL * (1 + this.ppm / 1e6); }

    async tw(reg, val) { this.regs[reg - 5] = val; await this.i2cWrite(this.i2cAddr, [reg, val]); }
    async twm(reg, val, mask) {
      const old = this.regs[reg - 5];
      const v = (old & ~mask) | (val & mask);
      this.regs[reg - 5] = v;
      await this.i2cWrite(this.i2cAddr, [reg, v]);
    }
    // The R82xx reads from register 0, and returns each byte bit-reversed.
    async tread(len) {
      await this.i2cWrite(this.i2cAddr, [0]);
      const d = await this.i2cRead(this.i2cAddr, len);
      return Array.from(d, bitrev);
    }

    async tunerInit() {
      this.regs = new Uint8Array(R82XX_INIT);
      for (let i = 0; i < R82XX_INIT.length; i += 7) {           // 8-byte I2C messages: register + 7
        await this.i2cWrite(this.i2cAddr, [5 + i].concat(R82XX_INIT.slice(i, i + 7)));
      }
      // tv standard: filter calibration, then the 6 MHz defaults
      await this.twm(0x0c, 0x00, 0x0f);
      await this.twm(0x13, 49, 0x3f);
      await this.twm(0x1d, 0x00, 0x38);
      let cal = 0;
      for (let i = 0; i < 2; i++) {
        await this.twm(0x0b, 0x6b, 0x60);
        await this.twm(0x0f, 0x04, 0x04);
        await this.twm(0x10, 0x00, 0x03);
        await this.setPll(56000000);
        if (!this.hasLock) throw new Error('The tuner\'s PLL did not lock during filter calibration.');
        await this.twm(0x0b, 0x10, 0x10);
        await this.twm(0x0b, 0x00, 0x10);
        await this.twm(0x0f, 0x00, 0x04);
        cal = (await this.tread(5))[4] & 0x0f;
        if (cal && cal !== 0x0f) break;
      }
      if (cal === 0x0f) cal = 0;
      this.filterCal = cal;
      await this.twm(0x0a, 0x10 | cal, 0x1f);
      await this.twm(0x0b, 0x6b, 0xef);
      await this.twm(0x07, 0x00, 0x80);
      await this.twm(0x06, 0x30, 0x30);
      await this.twm(0x1e, 0x60, 0x60);
      await this.twm(0x05, 0x80, 0x80);
      await this.twm(0x1f, 0x00, 0x80);
      await this.twm(0x0f, 0x00, 0x80);
      await this.twm(0x19, 0x60, 0x60);
      // system frequency select, digital TV defaults
      await this.twm(0x1d, 0xe5, 0xc7);
      await this.twm(0x1c, 0x24, 0xf8);
      await this.tw(0x0d, 0x53);
      await this.tw(0x0e, 0x75);
      this.input = 0;
      await this.twm(0x05, 0x00, 0x60);
      await this.twm(0x06, 0x00, 0x08);
      await this.twm(0x11, 0x38, 0x38);
      await this.twm(0x17, 0xa0, 0x30);       // Blog: PLL drop-out 2.0 V, for L-band
      await this.twm(0x0a, 0x40, 0x60);
      await this.twm(0x1d, 0x00, 0x38);
      await this.twm(0x1c, 0x00, 0x04);
      await this.twm(0x06, 0x00, 0x40);
      await this.twm(0x1a, 0x30, 0x30);
      await this.twm(0x1d, 0x18, 0x38);
      await this.twm(0x1c, 0x24, 0x04);
      await this.twm(0x1e, 14, 0x1f);
      await this.twm(0x1a, 0x20, 0x30);
      this.ifFreq = 3570000;
    }

    async tunerStandby() {
      for (const [r, v] of [[0x06, 0xb1], [0x05, 0xa0], [0x07, 0x3a], [0x08, 0x40], [0x09, 0xc0], [0x0a, 0x36],
        [0x0c, 0x35], [0x0f, 0x68], [0x11, 0x03], [0x17, 0xf4], [0x19, 0x0c]]) await this.tw(r, v);
    }

    async setMux(lo) {
      const mhz = lo / 1e6;
      let i = 0;
      while (i < MUX.length - 1 && mhz >= MUX[i + 1][0]) i++;
      const m = MUX[i];
      await this.twm(0x17, m[1], 0x08);
      await this.twm(0x1a, m[2], 0xc3);
      await this.tw(0x1b, m[3]);
      await this.twm(0x10, 0x00, 0x0b);       // xtal cap: high, 0 pF
      await this.twm(0x08, 0x00, 0x3f);
      await this.twm(0x09, 0x00, 0x3f);
    }

    // The LO. Returns the frequency the synthesiser actually lands on.
    async setPll(freq) {
      const ref = this.tunerXtal;
      const refKhz = Math.round(ref / 1000);
      const freqKhz = Math.round(freq / 1000);
      await this.twm(0x10, 0x00, 0x10);
      await this.twm(0x1a, 0x00, 0x0c);
      await this.twm(0x12, 0x06, 0xff);       // Blog: VCO current to maximum
      let mixDiv = 2, divNum = 0, found = false;
      while (mixDiv <= 64) {
        if (freqKhz * mixDiv >= 1770000 && freqKhz * mixDiv < 3540000) {
          let b = mixDiv;
          while (b > 2) { b >>= 1; divNum++; }
          found = true;
          break;
        }
        mixDiv <<= 1;
      }
      // librtlsdr carries on with a divider of 128 the register cannot hold,
      // and mis-tunes. Below ~27.7 MHz of LO there is no honest answer.
      if (!found) { this.hasLock = false; throw new Error('No mixer divider reaches ' + (freq / 1e6).toFixed(3) + ' MHz — below what the tuner can tune'); }
      const data = await this.tread(5);
      const powerRef = this.tuner === 'R828D' ? 1 : 2;
      const fine = (data[4] & 0x30) >> 4;
      if (fine > powerRef) divNum--;
      else if (fine < powerRef) divNum++;
      await this.twm(0x10, (divNum << 5) & 0xe0, 0xe0);
      const vco = freq * mixDiv;
      const nint = Math.floor(vco / (2 * ref));
      let fra = Math.floor((vco - 2 * ref * nint) / 1000);
      if (nint > 128 / powerRef - 1) { this.hasLock = false; throw new Error('No PLL setting reaches ' + (freq / 1e6).toFixed(3) + ' MHz'); }
      const ni = Math.floor((nint - 13) / 4), si = nint - 4 * ni - 13;
      await this.tw(0x14, (ni + (si << 6)) & 0xff);
      await this.twm(0x12, fra ? 0x00 : 0x08, 0x08);
      let nSdm = 2, sdm = 0;
      while (fra > 1) {
        const step = Math.floor(2 * refKhz / nSdm);
        if (fra > step) {
          sdm += Math.floor(32768 / (nSdm / 2));
          fra -= step;
          if (nSdm >= 0x8000) break;
        }
        nSdm <<= 1;
        if (nSdm > 0x10000) break;
      }
      sdm &= 0xffff;
      await this.tw(0x16, sdm >> 8);
      await this.tw(0x15, sdm & 0xff);
      this.hasLock = false;
      for (let i = 0; i < 2; i++) {
        const st = await this.tread(3);
        if (st[2] & 0x40) { this.hasLock = true; break; }
        if (!i) await this.twm(0x12, 0x06, 0xff);
      }
      if (!this.hasLock) return null;
      await this.twm(0x1a, 0x08, 0x08);
      this.pll = { nint, sdm, mixDiv, divNum };
      return 2 * ref * (nint + sdm / 65536) / mixDiv;
    }

    async tunerSetFreq(freq) {
      const v4 = this.model === 'v4';
      const up = v4 && freq < 28800000 ? freq + 28800000 : freq;
      const lo = up + this.ifFreq;
      await this.setMux(lo);
      await this.twm(0x0c, 0x08, 0x9f);       // Blog: fixed VGA, 16.3 dB
      const got = await this.setPll(lo);
      if (got == null) throw new Error('The tuner\'s PLL did not lock at ' + (freq / 1e6).toFixed(4) + ' MHz.');
      if (v4) {
        // The notches are off inside the bands they notch (≤2.2, 85–112, 172–242 MHz).
        const inNotch = freq <= 2200000 || (freq >= 85e6 && freq <= 112e6) || (freq >= 172e6 && freq <= 242e6);
        await this.twm(0x17, inNotch ? 0x00 : 0x08, 0x08);
        const band = freq <= 28800000 ? 1 : freq < 250e6 ? 2 : 3;   // HF, VHF, UHF
        if (band === 1) { await this.twm(0x1a, 0x40, 0xc3); await this.tw(0x1b, 0x00); }
        if (band !== this.input) {
          this.input = band;
          const hf = band === 1;
          await this.twm(0x06, hf ? 0x08 : 0x00, 0x08);           // cable 2: HF
          await this.gpioOutput(5);
          await this.gpioBit(5, !hf);                              // upconverter path switch
          await this.twm(0x05, band === 2 ? 0x40 : 0x00, 0x40);   // cable 1: VHF
          await this.twm(0x05, band === 3 ? 0x00 : 0x20, 0x20);   // air in: UHF
        }
      } else if (this.tuner === 'R828D') {
        const inp = freq > 345e6 ? 0x00 : 0x60;
        if (inp !== this.input) { this.input = inp; await this.twm(0x05, inp, 0x60); }
      }
      return { lo: got, rf: got - this.ifFreq - (up - freq) };
    }

    // r82xx_set_bandwidth: the IF filter for a bandwidth, and the IF it implies.
    async tunerSetBandwidth(bw) {
      let r0a, r0b, ifFreq;
      if (bw > 7000000) { r0a = 0x10; r0b = 0x0b; ifFreq = 4570000; }
      else if (bw > 6000000) { r0a = 0x10; r0b = 0x2a; ifFreq = 4570000; }
      else if (bw > IF_LPF[0] + 350000 + 380000) { r0a = 0x10; r0b = 0x6b; ifFreq = 3570000; }
      else {
        r0a = 0x00; r0b = 0x80; ifFreq = 2300000;
        let real = 0;
        if (bw > IF_LPF[0] + 350000) { bw -= 380000; ifFreq += 380000; real += 380000; } else r0b |= 0x20;
        if (bw > IF_LPF[0]) { bw -= 350000; ifFreq += 350000; real += 350000; } else r0b |= 0x40;
        let i = 0;
        while (i < IF_LPF.length && !(bw > IF_LPF[i])) i++;
        i--;
        if (i < 0) i = 0;
        r0b |= 15 - i;
        real += IF_LPF[i];
        ifFreq -= Math.floor(real / 2);
      }
      await this.twm(0x0a, r0a, 0x10);
      await this.twm(0x0b, r0b, 0xef);
      this.ifFreq = ifFreq;
      return ifFreq;
    }

    async setIfFreq(freq) {
      const v = -Math.floor(freq * 4194304 / this.rtlXtal);
      await this.demodWrite(1, 0x19, (v >> 16) & 0x3f, 1);
      await this.demodWrite(1, 0x1a, (v >> 8) & 0xff, 1);
      await this.demodWrite(1, 0x1b, v & 0xff, 1);
    }

    async sampleFreqCorrection(ppm) {
      const offs = (-Math.round(ppm * 16777216 / 1e6)) & 0xffff;
      await this.demodWrite(1, 0x3f, offs & 0xff, 1);
      await this.demodWrite(1, 0x3e, (offs >> 8) & 0x3f, 1);
    }

    // ── public: open / tune / stream ─────────────────────────────────────────

    open(opts) {
      return this.serial(async () => {
        opts = opts || {};
        this.ppm = opts.ppm || 0;
        const u = this.usb;
        if (!u.opened) await u.open();
        if (!u.configuration) await u.selectConfiguration(1);
        await u.claimInterface(0);
        try { await this.writeReg(BLOCK.USB, REG.USB_SYSCTL, 0x09, 1); }
        catch (_) {
          // a dummy write that fails means a wedged stick: reset it once
          if (u.reset) await u.reset();
          await this.writeReg(BLOCK.USB, REG.USB_SYSCTL, 0x09, 1);
        }
        // baseband
        await this.writeReg(BLOCK.USB, REG.USB_EPA_MAXPKT, 0x0002, 2);
        await this.writeReg(BLOCK.USB, REG.USB_EPA_CTL, 0x1002, 2);
        await this.writeReg(BLOCK.SYS, REG.DEMOD_CTL_1, 0x22, 1);
        await this.writeReg(BLOCK.SYS, REG.DEMOD_CTL, 0xe8, 1);
        await this.demodWrite(1, 0x01, 0x14, 1);
        await this.demodWrite(1, 0x01, 0x10, 1);
        await this.demodWrite(1, 0x15, 0x00, 1);
        await this.demodWrite(1, 0x16, 0x0000, 2);
        for (let i = 0; i < 6; i++) await this.demodWrite(1, 0x16 + i, 0x00, 1);
        for (let i = 0; i < FIR.length; i++) await this.demodWrite(1, 0x1c + i, FIR[i], 1);
        await this.demodWrite(0, 0x19, 0x05, 1);
        await this.demodWrite(1, 0x93, 0xf0, 1);
        await this.demodWrite(1, 0x94, 0x0f, 1);
        await this.demodWrite(1, 0x11, 0x00, 1);
        await this.demodWrite(1, 0x04, 0x00, 1);
        await this.demodWrite(0, 0x61, 0x60, 1);
        await this.demodWrite(0, 0x06, 0x80, 1);
        await this.demodWrite(1, 0xb1, 0x1b, 1);
        await this.demodWrite(0, 0x0d, 0x83, 1);
        // probe the tuner
        await this.repeater(true);
        if ((await this.i2cReadReg(I2C.R820T, 0)) === 0x69) this.tuner = 'R820T';
        else if ((await this.i2cReadReg(I2C.R828D, 0)) === 0x69) this.tuner = 'R828D';
        if (!this.tuner) {
          await this.repeater(false);
          throw new Error('No R820T or R828D tuner answered. This driver supports RTL-SDR Blog V2/V3/V4-style sticks '
            + '(Rafael tuners); an E4000 or FC0012 stick is not supported.');
        }
        this.model = this.pickModel(opts.model);
        // R82xx: low IF, In-phase ADC only, spectrum inverted
        await this.demodWrite(1, 0xb1, 0x1a, 1);
        await this.demodWrite(0, 0x08, 0x4d, 1);
        await this.setIfFreq(3570000);
        await this.demodWrite(1, 0x15, 0x01, 1);
        // EEPROM byte 7, bit 1 clear: the owner has forced the bias tee on
        try {
          await this.i2cWrite(I2C.EEPROM, [7]);
          const b7 = (await this.i2cRead(I2C.EEPROM, 1))[0];
          this.forceBiasTee = !(b7 & 0x02);
        } catch (_) { this.forceBiasTee = false; }
        await this.repeater(true);
        if (this.forceBiasTee) await this.biasTeeRaw(true);
        await this.tunerInit();
        await this.repeater(false);
        this.log('Opened ' + label(u) + ' — tuner ' + this.tuner + ', ' + MODELS[this.model].label);
        return this.info();
      });
    }

    pickModel(want) {
      const m = this.usb.manufacturerName || '', p = this.usb.productName || '';
      if (want && want !== 'auto' && MODELS[want]) {
        if (MODELS[want].tuner === this.tuner) return want;
        this.log('Asked for ' + MODELS[want].label + ' but the tuner is an ' + this.tuner + ' — detecting instead.');
      }
      if (this.tuner === 'R828D') return (m === 'RTLSDRBlog' && p === 'Blog V4') ? 'v4' : 'r828d';
      if (/Blog V3/i.test(p)) return 'v3';
      // An R820T(2) that does not name itself: a V3 is the common case and the
      // superset (its extras do nothing harmful on a V2), but say so honestly.
      return /RTLSDRBlog/i.test(m) ? 'v3' : 'v2';
    }

    info() {
      const u = this.usb, M = MODELS[this.model] || {};
      const min = this.model === 'v4' ? 500000 : M.direct ? 500000 : 25000000;
      return {
        tuner: this.tuner, model: this.model, modelLabel: M.label, note: M.note,
        manufacturer: u.manufacturerName || '', product: u.productName || '', serial: u.serialNumber || '',
        label: label(u), biasTee: !!M.biasTee, directSampling: !!M.direct, upconverter: !!M.upconverter,
        forceBiasTee: this.forceBiasTee, gains: GAINS.slice(), minHz: min, maxHz: 1766000000,
        filterCal: this.filterCal,
      };
    }

    setSampleRate(rate) {
      return this.serial(async () => {
        if (rate <= 225000 || rate > 3200000 || (rate > 300000 && rate <= 900000)) throw new Error('The RTL2832U takes 225–300 ksps or 0.9–3.2 Msps, not ' + rate);
        let ratio = Math.floor(RTL_XTAL * 4194304 / rate) & 0x0ffffffc;
        const real = RTL_XTAL * 4194304 / (ratio | ((ratio & 0x08000000) << 1));
        this.rate = real;
        if (!this.direct) {
          await this.repeater(true);
          const ifFreq = await this.tunerSetBandwidth(this.bw > 0 ? this.bw : real);
          await this.repeater(false);
          await this.setIfFreq(ifFreq);
        }
        await this.demodWrite(1, 0x9f, (ratio >> 16) & 0xffff, 2);
        await this.demodWrite(1, 0xa1, ratio & 0xffff, 2);
        await this.sampleFreqCorrection(this.ppm);
        await this.demodWrite(1, 0x01, 0x14, 1);
        await this.demodWrite(1, 0x01, 0x10, 1);
        if (this.freq) await this.tuneRaw(this.freq);
        return real;
      });
    }

    async directRaw(on) {
      if (on) {
        await this.repeater(true);
        await this.tunerStandby();
        await this.repeater(false);
        await this.demodWrite(1, 0xb1, 0x1a, 1);
        await this.demodWrite(1, 0x15, 0x00, 1);
        await this.demodWrite(0, 0x08, 0x4d, 1);
        await this.demodWrite(0, 0x06, on > 1 ? 0x90 : 0x80, 1);
      } else {
        await this.repeater(true);
        await this.tunerInit();
        const ifFreq = await this.tunerSetBandwidth(this.bw > 0 ? this.bw : (this.rate || 2048000));
        if (this.gain != null) await this.gainRaw(this.gain);
        await this.repeater(false);
        await this.setIfFreq(ifFreq);
        await this.demodWrite(1, 0x15, 0x01, 1);
        await this.demodWrite(0, 0x06, 0x80, 1);
      }
      this.direct = on;
    }

    async tuneRaw(freq) {
      // Direct sampling: off, I, Q — or, in "auto", Q below 24 MHz on an R820T
      // stick that has the V3's Q-branch (the Blog driver's own rule).
      let want = 0;
      if (this.directMode === 'i') want = 1;
      else if (this.directMode === 'q') want = 2;
      else if (this.directMode === 'auto' && freq < 24000000 && this.tuner === 'R820T' && MODELS[this.model].direct) want = 2;
      if (want !== this.direct) await this.directRaw(want);
      let res;
      if (this.direct) {
        await this.setIfFreq(freq);
        res = { lo: freq, rf: freq, mode: 'direct-' + (this.direct > 1 ? 'Q' : 'I') };
      } else {
        await this.repeater(true);
        try { res = await this.tunerSetFreq(freq); } finally { await this.repeater(false); }
        res.mode = this.model === 'v4' && freq < 28800000 ? 'upconverter' : 'tuner';
      }
      this.freq = freq;
      res.errorHz = Math.round(res.rf - freq);
      this.lastTune = res;
      return res;
    }

    setFrequency(hz) { return this.serial(() => this.tuneRaw(Math.round(hz))); }

    setDirectSampling(mode) {
      return this.serial(async () => {
        this.directMode = mode || 'auto';
        if (this.freq) return this.tuneRaw(this.freq);
        return null;
      });
    }

    async gainRaw(tenths) {
      if (tenths == null) {
        await this.twm(0x05, 0x00, 0x10);
        await this.twm(0x07, 0x10, 0x10);
        await this.twm(0x0c, 0x0b, 0x9f);
        return null;
      }
      await this.twm(0x05, 0x10, 0x10);
      await this.twm(0x07, 0x00, 0x10);
      await this.twm(0x0c, 0x08, 0x9f);
      let total = 0, lna = 0, mix = 0;
      for (let i = 0; i < 15; i++) {
        if (total >= tenths) break;
        total += LNA_STEPS[++lna];
        if (total >= tenths) break;
        total += MIX_STEPS[++mix];
      }
      await this.twm(0x05, lna, 0x0f);
      await this.twm(0x07, mix, 0x0f);
      return total;
    }

    // null = the tuner's own AGC; else tenths of a dB (the nearest step at or above).
    setGain(tenths) {
      return this.serial(async () => {
        this.gain = tenths == null ? null : Math.max(0, Math.min(496, Math.round(tenths)));
        if (this.direct) return this.gain;
        await this.repeater(true);
        try { return await this.gainRaw(this.gain); } finally { await this.repeater(false); }
      });
    }

    // The RTL2832U's own digital AGC — separate from the tuner's.
    setAgc(on) {
      return this.serial(async () => { this.agc = !!on; await this.demodWrite(0, 0x19, on ? 0x25 : 0x05, 1); });
    }

    setPpm(ppm) {
      return this.serial(async () => {
        this.ppm = Math.max(-200, Math.min(200, Math.round(ppm) || 0));
        await this.sampleFreqCorrection(this.ppm);
        if (this.freq) return this.tuneRaw(this.freq);
        return null;
      });
    }

    setBandwidth(hz) {
      return this.serial(async () => {
        this.bw = hz > 0 ? hz : 0;
        if (this.direct) return null;
        await this.repeater(true);
        const ifFreq = await this.tunerSetBandwidth(this.bw > 0 ? this.bw : (this.rate || 2048000));
        await this.repeater(false);
        await this.setIfFreq(ifFreq);
        if (this.freq) await this.tuneRaw(this.freq);
        return ifFreq;
      });
    }

    async biasTeeRaw(on) {
      if (this.forceBiasTee) on = true;       // the EEPROM's word is final, as in the Blog driver
      await this.gpioOutput(0);
      await this.gpioBit(0, on);
      this.biasTee = on;
      return on;
    }
    setBiasTee(on) { return this.serial(() => this.biasTeeRaw(!!on)); }

    // Stream: `onData(Uint8Array)` per transfer, interleaved u8 I/Q. Several
    // transfers stay in flight so the stick's FIFO never fills.
    start(onData, opts) {
      return this.serial(async () => {
        opts = opts || {};
        const rate = this.rate || 2048000;
        const size = opts.bufferSize || Math.max(8192, Math.min(262144, Math.round(rate * 2 / 25 / 512) * 512));
        const inflight = opts.inflight || 4;
        await this.writeReg(BLOCK.USB, REG.USB_EPA_CTL, 0x1002, 2);
        await this.writeReg(BLOCK.USB, REG.USB_EPA_CTL, 0x0000, 2);
        this.streaming = true;
        this.stats = { transfers: 0, bytes: 0, errors: 0, startedAt: Date.now(), size };
        const pump = async () => {
          while (this.streaming) {
            try {
              const r = await this.usb.transferIn(1, size);
              if (!this.streaming) break;
              if (r.status === 'babble' || r.status === 'stall') {
                this.stats.errors++;
                if (r.status === 'stall' && this.usb.clearHalt) await this.usb.clearHalt('in', 1);
                continue;
              }
              if (r.data && r.data.byteLength) {
                this.stats.transfers++; this.stats.bytes += r.data.byteLength;
                onData(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength));
              }
            } catch (e) {
              if (!this.streaming) break;
              this.stats.errors++;
              this.streaming = false;
              if (opts.onError) opts.onError(e);
              break;
            }
          }
        };
        this.pumps = [];
        for (let i = 0; i < inflight; i++) this.pumps.push(pump());
        return size;
      });
    }

    async stop() {
      this.streaming = false;
      if (this.pumps) { try { await Promise.all(this.pumps); } catch (_) {} }
      this.pumps = null;
    }

    async close() {
      await this.stop();
      await this.serial(async () => {
        try {
          if (this.tuner) { await this.repeater(true); await this.tunerStandby(); await this.repeater(false); }
          await this.writeReg(BLOCK.SYS, REG.DEMOD_CTL, 0x20, 1);
        } catch (_) {}
        try { await this.usb.releaseInterface(0); } catch (_) {}
        try { await this.usb.close(); } catch (_) {}
      });
    }
  }

  return { FILTERS, MODELS, GAINS, supported, request, known, label, describeOpenError, Device, bitrev };
})();

// test/rtlsdr.mjs requires this same file and drives it against a simulated
// dongle. Guarded so the browser, where `module` is undefined, never runs it.
// Constrains nothing below it.
if (typeof module !== 'undefined' && module.exports) module.exports = RtlSdr;
