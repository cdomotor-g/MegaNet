// MegaNet — rtlsdr.js
//
//   RtlSdr   a WebUSB driver for RTL2832U dongles with a Rafael R820T/R820T2
//            or R828D tuner — the RTL-SDR Blog V3 and V4, and the generic
//            R820T sticks — or a Fitipower FC0012/FC0013 — the RTL-SDR Blog
//            V2 and the older DVB-T sticks — enough of one to tune, set gain,
//            and stream 8-bit IQ into the Serial Monitor's RTL-SDR card.
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
// The Fitipower FC0012 and FC0013 are librtlsdr's (osmocom rtl-sdr,
// tuner_fc0012.c and tuner_fc0013.c, from the Linux kernel's drivers),
// re-expressed the same way:
//
//   * Zero-IF tuners. The RTL2832U samples I and Q in zero-IF mode with no
//     spectrum inversion, and the tuner's DC spike sits on its LO. So an FC
//     tune is always offset — librtlsdr's offset tuning, off unless asked for
//     there and always on here, because the decoder's channel is the centre:
//     the LO goes 0.85 × the sample rate below the frequency, the RTL2832U's
//     own mixer brings the frequency back to the centre, and the spike falls
//     outside the band.
//   * The PLL: the VCO at the LO times a divider (96 down to 2), as an integer
//     and a signed 15-bit fraction of half the 28.8 MHz crystal; then a VCO
//     calibration, and the other VCO if this one ends at the edge of its range.
//     The FC0013 also picks a VHF tracking filter and its VHF or UHF input by
//     band; the FC0012 switches its input filter on GPIO 6.
//   * Gain is the LNA's steps — 23 on the FC0013, 5 on the FC0012 — with the
//     FC0013's own AGC when no gain is set, and its IF gain fixed either way.
//
// ── What the browser needs ──────────────────────────────────────────────────
//
// WebUSB: Chrome or Edge, https or localhost. The operating system must let go
// of the stick first — exactly as for rtl_sdr:
//   Windows  WinUSB, as for SDR# and rtl_tcp — without it the stick is not in
//            the browser's chooser at all. A V3/V4 is a composite device and
//            takes it on interface 0; many V2-era and generic sticks (0bda:2832)
//            have one interface and take it on the device itself, which Zadig
//            lists as "RTL2832U", not "Interface 0". WINDOWS_INSTALLER does
//            either, for every stick plugged in, with Windows' own winusb.inf.
//   Linux    the DVB-T driver claims it: `sudo rmmod dvb_usb_rtl28xxu`, or
//            blacklist it; and a udev rule for 0bda:2838 and 0bda:2832 so it is
//            not root-only.
//   macOS    nothing to do.
// docs/serial-sdr.md says this at length; describeOpenError() says it briefly.

const RtlSdr = (function () {
  // The installer looks for these same sticks; test/rtlsdr.mjs holds the two lists together.
  const FILTERS = [{ vendorId: 0x0bda, productId: 0x2838 }, { vendorId: 0x0bda, productId: 0x2832 }];
  const WINDOWS_INSTALLER = 'tools/install-rtlsdr-driver.cmd';

  const RTL_XTAL = 28800000;
  const R828D_XTAL = 16000000;
  const BLOCK = { DEMOD: 0, USB: 1, SYS: 2, TUN: 3, ROM: 4, IR: 5, IIC: 6 };
  const REG = {
    USB_SYSCTL: 0x2000, USB_EPA_CTL: 0x2148, USB_EPA_MAXPKT: 0x2158,
    DEMOD_CTL: 0x3000, GPO: 0x3001, GPI: 0x3002, GPOE: 0x3003, GPD: 0x3004, DEMOD_CTL_1: 0x300b,
  };
  const I2C = { R820T: 0x34, R828D: 0x74, FC001X: 0xc6, E4000: 0xc8, FC2580: 0xac, EEPROM: 0xa0 };

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

  // FC0012 / FC0013 registers 0x01-0x15 at init, with librtlsdr's two edits
  // made: 0x07 bit 5 (a 28.8 MHz crystal) and 0x0c bit 1 (dual master).
  const FC0013_INIT = [0x09, 0x16, 0x00, 0x00, 0x17, 0x02, 0x2a, 0xff, 0x6e, 0xb8, 0x82, 0xfe, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x50, 0x01];
  const FC0012_INIT = [0x05, 0x10, 0x00, 0x00, 0x0f, 0x00, 0x20, 0xff, 0x6e, 0xb8, 0x82, 0xfe, 0x02, 0x00, 0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x04];
  // [LO below Hz, VCO multiple, reg 0x05, reg 0x06]: the RF divider by band.
  // The chips share the bands and differ in 0x05; only the FC0013 has ÷2.
  const FC0013_DIV = [[37084000, 96, 0x82, 0x00], [55625000, 64, 0x02, 0x02], [74167000, 48, 0x42, 0x00], [111250000, 32, 0x82, 0x02],
    [148334000, 24, 0x22, 0x00], [222500000, 16, 0x42, 0x02], [296667000, 12, 0x12, 0x00], [445000000, 8, 0x22, 0x02],
    [593334000, 6, 0x0a, 0x00], [950000000, 4, 0x12, 0x02], [Infinity, 2, 0x0a, 0x02]];
  const FC0012_DIV = [[37084000, 96, 0x82, 0x00], [55625000, 64, 0x82, 0x02], [74167000, 48, 0x42, 0x00], [111250000, 32, 0x42, 0x02],
    [148334000, 24, 0x22, 0x00], [222500000, 16, 0x22, 0x02], [296667000, 12, 0x12, 0x00], [445000000, 8, 0x12, 0x02],
    [593334000, 6, 0x0a, 0x00], [Infinity, 4, 0x0a, 0x02]];
  // FC0013 VHF tracking filter, reg 0x1d bits 4-2, by LO: [up to Hz, bits].
  const FC0013_TRACK = [[177500000, 0x1c], [184500000, 0x18], [191500000, 0x14], [198500000, 0x10], [205500000, 0x0c],
    [219500000, 0x08], [299999999, 0x04], [Infinity, 0x1c]];
  // LNA gain (tenths of a dB) and the code for it. -6.3 dB has two codes on
  // the FC0013; the first is the one used, as in librtlsdr.
  const FC0013_LNA = [[-99, 0x02], [-73, 0x03], [-65, 0x05], [-63, 0x04], [-63, 0x00], [-60, 0x07], [-58, 0x01], [-54, 0x06],
    [58, 0x0f], [61, 0x0e], [63, 0x0d], [65, 0x0c], [67, 0x0b], [68, 0x0a], [70, 0x09], [71, 0x08],
    [179, 0x17], [181, 0x16], [182, 0x15], [184, 0x14], [186, 0x13], [188, 0x12], [191, 0x11], [197, 0x10]];
  const FC0012_LNA = [[-99, 0x02], [-40, 0x00], [71, 0x08], [179, 0x17], [192, 0x10]];
  const steps = lna => lna.map(g => g[0]).filter((g, i, a) => a.indexOf(g) === i);

  // What each tuner answers at, reaches, and offers.
  const TUNERS = {
    R820T: { addr: I2C.R820T, zeroIf: false, minHz: 25000000, maxHz: 1766000000, gains: GAINS },
    R828D: { addr: I2C.R828D, zeroIf: false, minHz: 25000000, maxHz: 1766000000, gains: GAINS },
    FC0012: { addr: I2C.FC001X, zeroIf: true, minHz: 22000000, maxHz: 948600000, gains: steps(FC0012_LNA) },
    FC0013: { addr: I2C.FC001X, zeroIf: true, minHz: 22000000, maxHz: 1100000000, gains: steps(FC0013_LNA) },
  };
  // librtlsdr's offset: 0.85 × the sample rate ("based on keenerd's 1/f noise
  // measurements"), past the band's edge, so the DC spike is filtered out.
  const offsetFor = rate => Math.floor(Math.floor(Math.floor(rate) / 2) * 170 / 100);

  // `tuners`: the tuners a model can have. `eepromBiasTee`: the Blog's own
  // EEPROM convention for forcing the bias tee on, which only its V3 and V4
  // follow — on another stick that bit just switches its IR interface off.
  const MODELS = {
    auto: { label: 'Detect from the stick' },
    v2: { label: 'RTL-SDR Blog V2 (FC0013 / FC0012)', tuners: ['FC0013', 'FC0012'], biasTee: true, direct: false,
      note: 'Tunes about 22–1100 MHz (948 on an FC0012). A zero-IF tuner: the stick is tuned to one side so its DC spike stays out of the band. '
        + 'Bias tee on GPIO 0, as on the V3 — the label ticks BIAS-T, but check it with a meter before trusting an LNA to it.' },
    v3: { label: 'RTL-SDR Blog V3 (R820T2)', tuners: ['R820T'], biasTee: true, direct: true, eepromBiasTee: true,
      note: 'Tunes about 25–1766 MHz on the tuner, and 0.5–24 MHz by direct sampling on the Q-branch (HF on the same SMA).' },
    v4: { label: 'RTL-SDR Blog V4 (R828D)', tuners: ['R828D'], biasTee: true, direct: false, upconverter: true, eepromBiasTee: true,
      note: 'Tunes 0.5–1766 MHz: below 28.8 MHz through its built-in upconverter. FM and DAB notch filters switch themselves.' },
    r820t: { label: 'Generic R820T / R820T2', tuners: ['R820T'], biasTee: false, direct: false,
      note: 'Tunes about 25–1766 MHz. No bias tee or HF direct sampling unless the stick has been modified.' },
    r828d: { label: 'Generic R828D', tuners: ['R828D'], biasTee: false, direct: false,
      note: 'A 16 MHz-crystal R828D stick (not a Blog V4).' },
    fc0013: { label: 'Generic FC0013', tuners: ['FC0013'], biasTee: false, direct: false,
      note: 'Tunes about 22–1100 MHz. A zero-IF tuner: the stick is tuned to one side so its DC spike stays out of the band.' },
    fc0012: { label: 'Generic FC0012', tuners: ['FC0012'], biasTee: false, direct: false,
      note: 'Tunes about 22–948 MHz. A zero-IF tuner, tuned to one side like the FC0013; it has no AGC of its own, so "tuner AGC" leaves it at its start-up gain.' },
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
        + 'stick needs the WinUSB driver, as for SDR# — run the driver installer (' + WINDOWS_INSTALLER + '), '
        + 'or Zadig; anywhere, close rtl_tcp, SDR#, SDR++ or another tab using it.';
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

    get tunerSpec() { return TUNERS[this.tuner] || TUNERS.R820T; }
    get zeroIf() { return !!(TUNERS[this.tuner] && TUNERS[this.tuner].zeroIf); }
    get i2cAddr() { return this.tunerSpec.addr; }
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
      if (this.zeroIf) return this.fcInit();
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
      if (this.zeroIf) return;                // librtlsdr's FC "exit" does nothing either
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
      if (this.zeroIf) return this.fcSetFreq(freq);
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

    // ── FC0012 / FC0013 ──────────────────────────────────────────────────────
    // Plain registers that read back as written (no bit reversal). librtlsdr
    // reads before every masked write rather than shadowing, and so does this.

    fcWrite(reg, val) { return this.i2cWrite(I2C.FC001X, [reg, val & 0xff]); }
    async fcRead(reg) {
      await this.i2cWrite(I2C.FC001X, [reg]);
      return (await this.i2cRead(I2C.FC001X, 1))[0];
    }
    async fcMask(reg, val, mask) { await this.fcWrite(reg, ((await this.fcRead(reg)) & ~mask) | (val & mask)); }

    async fcInit() {
      const init = this.tuner === 'FC0013' ? FC0013_INIT : FC0012_INIT;
      for (let i = 0; i < init.length; i++) await this.fcWrite(1 + i, init[i]);
    }

    // fc001x_set_params at a 6 MHz bandwidth: the LO. Returns the LO the
    // registers program — librtlsdr's arithmetic, integer for integer.
    async fcSetLo(freq) {
      const fc13 = this.tuner === 'FC0013';
      if (fc13) {
        await this.fcMask(0x1d, FC0013_TRACK.find(t => freq <= t[0])[1], 0x1c);
        await this.fcMask(0x07, freq < 300e6 ? 0x10 : 0x00, 0x10);     // VHF filter
        await this.fcMask(0x14, freq < 300e6 ? 0x00 : 0x40, 0xe0);     // UHF input (librtlsdr never selects GPS)
      } else {
        await this.gpioBit(6, freq > 300e6);                           // the FC0012's VHF / UHF filter
      }
      const half = Math.floor(this.tunerXtal / 2);
      const [, multi, r5, r6base] = (fc13 ? FC0013_DIV : FC0012_DIV).find(d => freq < d[0]);
      const vco = freq * multi, vcoHigh = vco >= 3060000000;
      let r6 = r6base | (vcoHigh ? 0x08 : 0);
      let xdiv = Math.floor(vco / half);
      if (vco - xdiv * half >= Math.floor(half / 2)) xdiv++;
      let pm = Math.floor(xdiv / 8), am = xdiv - 8 * pm;
      if (am < 2) { am += 8; pm--; }
      const r1 = pm > 31 ? am + 8 * (pm - 31) : am, r2 = pm > 31 ? 31 : pm;
      if (r1 > 15 || r2 < 0x0b) throw new Error('No PLL setting reaches ' + (freq / 1e6).toFixed(3) + ' MHz — outside what the tuner can tune');
      // The fraction is signed: past a half, xdiv was rounded up and it counts back.
      let xin = Math.floor(Math.floor((vco - Math.floor(vco / half) * half) / 1000) * 32768 / Math.floor(half / 1000));
      if (xin >= 16384) xin += 32768;
      xin &= 0xffff;
      r6 = ((r6 | 0x20) & 0x3f) | 0x80;                                // clock out on; IF filter 6 MHz
      const regs = [r1, r2, xin >> 8, xin & 0xff, r5 | 0x07, r6];
      for (let i = 0; i < regs.length; i++) await this.fcWrite(1 + i, regs[i]);
      if (fc13) await this.fcMask(0x11, multi === 64 ? 0x04 : 0x00, 0x04);
      // Calibrate the VCO; if it has landed at the edge of its range, change VCO and calibrate again.
      await this.fcWrite(0x0e, 0x80);
      await this.fcWrite(0x0e, 0x00);
      await this.fcWrite(0x0e, 0x00);
      const v = (await this.fcRead(0x0e)) & 0x3f;
      if (vcoHigh ? v > 0x3c : v < 0x02) {
        await this.fcWrite(0x06, r6 ^ 0x08);
        await this.fcWrite(0x0e, 0x80);
        await this.fcWrite(0x0e, 0x00);
      }
      const n = 8 * r2 + r1, frac = xin >= 32768 ? xin - 65536 : xin;
      this.pll = { n, xin, multi, vco: v };
      return half * (n + frac / 32768) / multi;
    }

    // The LO sits ifFreq (the offset) below the frequency; the RTL2832U's mixer
    // brings the frequency back to the centre.
    async fcSetFreq(freq) {
      const lo = await this.fcSetLo(freq - this.ifFreq);
      return { lo, rf: lo + this.ifFreq };
    }

    // null = the FC0013's own AGC (the FC0012 has none: its start-up gain).
    async fcGain(tenths) {
      if (this.tuner === 'FC0013') {
        await this.fcMask(0x0d, tenths == null ? 0x00 : 0x08, 0x08);   // LNA forced, or AGC
        await this.fcWrite(0x13, 0x0a);                                 // IF gain fixed, as librtlsdr fixes it
        if (tenths == null) return null;
      }
      const lna = this.tuner === 'FC0013' ? FC0013_LNA : FC0012_LNA;
      const g = tenths == null ? [null, FC0012_INIT[0x13 - 1]] : lna.find(x => x[0] >= tenths) || lna[lna.length - 1];
      await this.fcMask(this.tuner === 'FC0013' ? 0x14 : 0x13, g[1], 0x1f);
      return g[0];
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
        this.tuner = await this.probeTuner();
        if (!this.tuner) {
          const other = await this.probeUnsupported();
          await this.repeater(false);
          throw new Error((other ? 'This stick has ' + other + ' tuner, which this driver does not support'
            : 'No tuner this driver knows answered') + '. It supports the Rafael R820T, R820T2 and R828D (RTL-SDR Blog V3, V4 '
            + 'and most sticks since) and the Fitipower FC0012 and FC0013 (RTL-SDR Blog V2, older DVB-T sticks).');
        }
        this.model = this.pickModel(opts.model);
        if (this.zeroIf) {
          // FC0012 / FC0013: zero-IF, I and Q both sampled, spectrum upright.
          // The IF register carries the offset once there is a sample rate.
          await this.demodWrite(1, 0xb1, 0x1b, 1);
          await this.demodWrite(0, 0x08, 0xcd, 1);
          this.ifFreq = 0;
          await this.setIfFreq(0);
          await this.demodWrite(1, 0x15, 0x00, 1);
        } else {
          // R82xx: low IF, In-phase ADC only, spectrum inverted
          await this.demodWrite(1, 0xb1, 0x1a, 1);
          await this.demodWrite(0, 0x08, 0x4d, 1);
          await this.setIfFreq(3570000);
          await this.demodWrite(1, 0x15, 0x01, 1);
        }
        // EEPROM byte 7, bit 1 clear: on a Blog V3 or V4, the owner has forced
        // the bias tee on. Asked of those alone — elsewhere the bit only turns
        // the IR interface off, and a one-interface stick has it clear.
        this.forceBiasTee = false;
        if (MODELS[this.model].eepromBiasTee) {
          try {
            await this.i2cWrite(I2C.EEPROM, [7]);
            const b7 = (await this.i2cRead(I2C.EEPROM, 1))[0];
            this.forceBiasTee = !(b7 & 0x02);
          } catch (_) { this.forceBiasTee = false; }
        }
        await this.repeater(true);
        if (this.forceBiasTee) await this.biasTeeRaw(true);
        await this.tunerInit();
        if (this.zeroIf) await this.gainRaw(null);   // the state librtlsdr's tools leave it in: AGC, IF gain fixed
        await this.repeater(false);
        this.log('Opened ' + label(u) + ' — tuner ' + this.tuner + ', ' + MODELS[this.model].label);
        return this.info();
      });
    }

    // librtlsdr's probe, for the tuners this drives: each chip's ID register
    // at its own address; the FC0012 only after a reset pulse on GPIO 4.
    async probeTuner() {
      if ((await this.i2cReadReg(I2C.R820T, 0)) === 0x69) return 'R820T';
      if ((await this.i2cReadReg(I2C.R828D, 0)) === 0x69) return 'R828D';
      if ((await this.i2cReadReg(I2C.FC001X, 0)) === 0xa3) return 'FC0013';
      await this.gpioOutput(4);
      await this.gpioBit(4, true);
      await this.gpioBit(4, false);
      if ((await this.i2cReadReg(I2C.FC001X, 0)) === 0xa1) {
        await this.gpioOutput(6);              // its VHF / UHF filter switch
        return 'FC0012';
      }
      return null;
    }
    // The tuners it does not drive, so the refusal can name the one it found.
    async probeUnsupported() {
      if ((await this.i2cReadReg(I2C.E4000, 2)) === 0x40) return 'an Elonics E4000';
      const id = await this.i2cReadReg(I2C.FC2580, 1);
      return id != null && (id & 0x7f) === 0x56 ? 'an FCI FC2580' : null;
    }

    pickModel(want) {
      const m = this.usb.manufacturerName || '', p = this.usb.productName || '';
      if (want && want !== 'auto' && MODELS[want]) {
        if ((MODELS[want].tuners || []).includes(this.tuner)) return want;
        this.log('Asked for ' + MODELS[want].label + ' but the tuner is an ' + this.tuner + ' — detecting instead.');
      }
      if (this.tuner === 'R828D') return (m === 'RTLSDRBlog' && p === 'Blog V4') ? 'v4' : 'r828d';
      // An FC stick does not say whose it is — the Blog V2 this was brought up
      // on reports "Generic" / "RTL2832U" — so the generic model, and the V2
      // (for its bias tee) picked by hand.
      if (this.tuner === 'FC0013') return 'fc0013';
      if (this.tuner === 'FC0012') return 'fc0012';
      if (/Blog V3/i.test(p)) return 'v3';
      // An R820T(2) that does not name itself: a V3 is the common case and the
      // superset (its extras do nothing harmful on a generic stick), but say so honestly.
      return /RTLSDRBlog/i.test(m) ? 'v3' : 'r820t';
    }

    info() {
      const u = this.usb, M = MODELS[this.model] || {}, T = this.tunerSpec;
      const min = this.model === 'v4' || M.direct ? 500000 : T.minHz;
      return {
        tuner: this.tuner, model: this.model, modelLabel: M.label, note: M.note,
        manufacturer: u.manufacturerName || '', product: u.productName || '', serial: u.serialNumber || '',
        label: label(u), biasTee: !!M.biasTee, directSampling: !!M.direct, upconverter: !!M.upconverter,
        forceBiasTee: this.forceBiasTee, gains: T.gains.slice(), minHz: min, maxHz: T.maxHz,
        zeroIf: !!T.zeroIf, filterCal: this.filterCal,
      };
    }

    setSampleRate(rate) {
      return this.serial(async () => {
        if (rate <= 225000 || rate > 3200000 || (rate > 300000 && rate <= 900000)) throw new Error('The RTL2832U takes 225–300 ksps or 0.9–3.2 Msps, not ' + rate);
        let ratio = Math.floor(RTL_XTAL * 4194304 / rate) & 0x0ffffffc;
        const real = RTL_XTAL * 4194304 / (ratio | ((ratio & 0x08000000) << 1));
        this.rate = real;
        if (!this.direct && this.zeroIf) {
          this.ifFreq = offsetFor(real);       // the offset follows the rate; tuneRaw() below moves the LO
          await this.setIfFreq(this.ifFreq);
        } else if (!this.direct) {
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
        const ifFreq = this.zeroIf ? (this.ifFreq = offsetFor(this.rate || 2048000))
          : await this.tunerSetBandwidth(this.bw > 0 ? this.bw : (this.rate || 2048000));
        if (this.gain != null || this.zeroIf) await this.gainRaw(this.gain);
        await this.repeater(false);
        await this.setIfFreq(ifFreq);
        if (this.zeroIf) {
          await this.demodWrite(0, 0x08, 0xcd, 1);
          await this.demodWrite(1, 0xb1, 0x1b, 1);
        } else await this.demodWrite(1, 0x15, 0x01, 1);
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
        res.mode = this.model === 'v4' && freq < 28800000 ? 'upconverter' : this.zeroIf ? 'offset' : 'tuner';
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
      if (this.zeroIf) return this.fcGain(tenths);
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

    // null = the tuner's own AGC; else tenths of a dB (the nearest step at or
    // above, from info().gains — each tuner has its own).
    setGain(tenths) {
      return this.serial(async () => {
        const G = this.tunerSpec.gains;
        this.gain = tenths == null ? null : Math.max(G[0], Math.min(G[G.length - 1], Math.round(tenths)));
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
        if (this.direct || this.zeroIf) return null;     // an FC tuner's IF filter stays at 6 MHz, as in librtlsdr
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

  return { FILTERS, WINDOWS_INSTALLER, MODELS, GAINS, supported, request, known, label, describeOpenError, Device, bitrev };
})();

// test/rtlsdr.mjs requires this same file and drives it against a simulated
// dongle. Guarded so the browser, where `module` is undefined, never runs it.
// Constrains nothing below it.
if (typeof module !== 'undefined' && module.exports) module.exports = RtlSdr;
