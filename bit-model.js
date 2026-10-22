// MegaNet — bit-model.js
//
//   BitModel   the arithmetic behind the 🧪 Bit Bench tab and the ⚡ Bit Errors
//              lesson: numbers as bits, the ALERT Binary frame as it goes on
//              the air, and fourteen faults that corrupt it — each changing the
//              bits the way its physics does, so a batch of frames sent through
//              one leaves the fingerprint the real fault leaves in a station's
//              data.
//
// After core.js and propagation-physics.js, whose ALERT Binary map, codec,
// seeded generator and timing figures it reads at call time — so the frame here
// is the frame the 🎓 Radio Propagation lesson draws and the ALERT Packets tab
// decodes, and test/bitbench.mjs holds all three to each other. No DOM, no
// `state`, nothing at load: test/bitbench.mjs runs this file in Node's vm.
//
// ── What is exact, and what is a model ───────────────────────────────────────
//
// Exact: the frame. Four 10-bit words — a start bit (0), eight bits sent least
// significant first, a stop bit (1) — at 300 baud, 3.33 ms a bit, 133 ms a
// frame; 13 address bits, 11 value bits and the eight fixed check bits ALERT
// Binary has instead of a CRC (PropPhysics.ABF_MAP). The tones are the
// decoder's (alert-dsp.js): mark 1300.8 Hz for a 1, space 2109.4 Hz for a 0.
// The arithmetic of a fault is exact too where it is arithmetic: 1 ppm at
// 151.5 MHz is 151.5 Hz, an intermodulation product of f1 and f2 is at
// 2f1 − f2, and a UART samples bit k of a word (k + ½) bits after the edge
// that started it.
//
// Models, and said to be on both tabs: how the receiver turns a signal into
// bits. A bit's chance of being misread at a given signal-to-noise ratio is
// non-coherent FSK's textbook curve, ½·e^(−γ/2), taken per tone when the two
// tones arrive at different strengths; two signals together follow
// PropPhysics's capture rule (6 dB clear wins outright; nearer than that, bits
// flip, a quarter as often where the two are sending the same bit); an
// off-frequency carrier costs nothing until its swing reaches the receiver's
// filter and then about 1.5 dB for every 100 Hz past it. The figures behind
// those — the 2 kHz the tones swing the carrier, the ±4 kHz a 12.5 kHz
// channel's filter passes — are typical settings, not any one radio's. What the models are for is the *shape* of each fault's damage:
// where in the frame it lands, which way the bits go, whether the frame is
// caught or gets through, and when. Those follow from the physics and do not
// depend on the exact figures.
//
// ── The three families ───────────────────────────────────────────────────────
//
//   air    on the way: noise, impulses, reflections, a collision, an
//          intermodulation product — channel(), between the two radios
//   tx     in the radios and the logger: the transmitter's crystal, its PLL at
//          key-up, the logger's bit clock, the tones' levels — channel() too,
//          since what they spoil is the signal on the air
//   data   in the wiring and the decoder: a stuck line, lines shifted, inverted
//          or reversed, Gray code — dataPath(), before the frame is built, so
//          the frame on the air is perfect and carries the wrong number
//
// A frame through any of them is judged against what the station meant to
// send: clean, rejected (a start or stop bit wrong — framing — or a check bit
// wrong), lost (never decoded at all), a ghost (passed, wrong address) or a
// wrong value (passed, right address). Only the last two reach a database.
//
// Exposes: constants (MARK_HZ, SPACE_HZ, DEV_HZ, IF_HALF_HZ, WIDE_HALF_HZ,
//          PREAMBLE, FIELDS, EFFECTS), bitMs, fMhz, hzPerPpm, mask, wrap, bin,
//          hex, parse, flip, shl, shr, rotl, rotr, invert, reverse, swapBytes,
//          toGray, fromGray, signed, popcount, positions, diff, layout, air,
//          read, judge, ber, fadeAmp, imProducts, nearestProduct, dayTemp,
//          crystalHz, edgePenaltyDb, pllHz, toneResp, defaults, withDefaults,
//          dataPath, channel, run, fingerprint, analysePairs, airOf, causes,
//          cellName, passShare, crcCatches.

const BitModel = (function () {
  const PP = () => PropPhysics;

  // ── Constants ──────────────────────────────────────────────────────────────

  // The ALERT tones as alert-dsp.js decodes them: a 1 (and the idle line) is
  // the mark tone, a 0 the space tone.
  const MARK_HZ = 1300.8;
  const SPACE_HZ = 2109.4;
  // How far the data tones swing the carrier, and half the width a receiver's
  // filter passes — a 12.5 kHz channel's typical figures, and a 25 kHz one's.
  const DEV_HZ = 2000;
  const IF_HALF_HZ = 4000;
  const WIDE_HALF_HZ = 8000;
  // The lead-in a transmitter sends before its frame for the receivers to lock
  // on to: 0x55 as UART words — start, 1 0 1 0 1 0 1 0 (least significant
  // first), stop. alert-dsp.js drops station 5461 for exactly this pattern.
  const PREAMBLE = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1];

  // The two numbers in a frame, and the widths the number bench offers.
  const FIELDS = {
    value:   { width: 11, kind: 'D', max: 2047 },
    address: { width: 13, kind: 'A', max: 8191 },
  };

  const bitMs = () => PP().BIT_MS;
  const fMhz = () => PP().F_MHZ;
  const hzPerPpm = () => PP().F_MHZ;      // one part per million of 151.5 MHz is 151.5 Hz

  // ── Numbers as bits ────────────────────────────────────────────────────────
  // Widths here are 16 bits or fewer, so plain 32-bit integer arithmetic holds.

  const mask = w => (1 << w) - 1;
  // A number brought into a width the way a counter of that many bits holds
  // it: past the top it starts again at nought.
  function wrap(v, w) {
    const m = mask(w) + 1;
    return ((Math.round(Number(v) || 0) % m) + m) % m;
  }
  const bin = (v, w) => (v >>> 0).toString(2).padStart(w, '0').slice(-w);
  const hex = (v, w) => (v >>> 0).toString(16).toUpperCase().padStart(Math.ceil(w / 4), '0');

  // What somebody typed: decimal, 0b… binary, 0x… hex, or a run of 0s and 1s
  // eight or more long (which no decimal reading of a station is). Spaces and
  // underscores are ignored, so 0b0101 1010 reads.
  function parse(s) {
    const t = String(s == null ? '' : s).trim().replace(/[\s_]/g, '');
    if (!t) return null;
    let m;
    if ((m = /^0b([01]+)$/i.exec(t))) return { value: parseInt(m[1], 2), base: 2 };
    if ((m = /^0x([0-9a-f]+)$/i.exec(t))) return { value: parseInt(m[1], 16), base: 16 };
    if (/^[01]{8,}$/.test(t)) return { value: parseInt(t, 2), base: 2 };
    if (/^-?\d+$/.test(t)) return { value: parseInt(t, 10), base: 10 };
    return null;
  }

  const flip = (v, i) => v ^ (1 << i);
  const shl = (v, w) => (v << 1) & mask(w);
  const shr = v => v >>> 1;
  const rotl = (v, w) => ((v << 1) | (v >>> (w - 1))) & mask(w);
  const rotr = (v, w) => ((v >>> 1) | ((v & 1) << (w - 1))) & mask(w);
  const invert = (v, w) => ~v & mask(w);
  function reverse(v, w) {
    let r = 0;
    for (let i = 0; i < w; i++) if (v & (1 << i)) r |= 1 << (w - 1 - i);
    return r;
  }
  const swapBytes = v => ((v & 0xff) << 8) | ((v >>> 8) & 0xff);
  // Gray code: neighbouring numbers differ in one bit, which is why a shaft
  // encoder's disc is printed in it — and why it reads as nonsense to a logger
  // expecting plain binary.
  const toGray = v => v ^ (v >>> 1);
  function fromGray(g) {
    let v = g;
    for (let s = g >>> 1; s; s >>>= 1) v ^= s;
    return v;
  }
  // The same bits read as a signed (two's complement) number.
  const signed = (v, w) => (v & (1 << (w - 1)) ? v - (mask(w) + 1) : v);
  function popcount(x) {
    let n = 0;
    for (let y = x >>> 0; y; y >>>= 1) n += y & 1;
    return n;
  }
  function positions(x) {
    const out = [];
    for (let i = 0, y = x >>> 0; y; i++, y >>>= 1) if (y & 1) out.push(i);
    return out;
  }

  // Two numbers of one width: which bits differ, which way each went, and
  // every one of the bench's transforms that turns the first into the second.
  function diff(a, b, w) {
    const x = (a ^ b) & mask(w);
    const flips = positions(x);
    const cleared = flips.filter(i => (a >>> i) & 1);    // was 1, reads 0
    const set = flips.filter(i => !((a >>> i) & 1));     // was 0, reads 1
    const kinds = [];
    if (!x) {
      kinds.push('same');
    } else {
      if (flips.length === 1) kinds.push('flip1');
      if (b === shl(a, w)) kinds.push('shl');
      if (b === shr(a)) kinds.push('shr');
      if (b === invert(a, w)) kinds.push('invert');
      if (b === reverse(a, w)) kinds.push('reverse');
      if (b === (toGray(a) & mask(w))) kinds.push('gray');
      if (b === fromGray(a)) kinds.push('ungray');
      if (w === 16 && b === swapBytes(a)) kinds.push('swap');
    }
    return { a, b, w, xor: x, flips, cleared, set, delta: b - a, kinds };
  }

  // ── The frame on the air ───────────────────────────────────────────────────

  // Each of the 40 bits a transmitter sends, in the order it sends them: which
  // word, where in the word (0 the start bit, 1–8 the data least significant
  // first, 9 the stop bit), and what it is — `kind` 'start', 'stop', 'A' an
  // address bit, 'D' a value bit or 'K' a check bit, with `i` the address or
  // value bit it carries or the value a check bit must hold; `data` its index
  // among the 32 the ALERT Packets tab reads, −1 for framing.
  let LAYOUT = null;
  function layout() {
    if (LAYOUT) return LAYOUT;
    const map = PP().ABF_MAP;
    const out = [];
    for (let w = 0; w < 4; w++) {
      out.push({ j: w * 10, word: w, pos: 0, kind: 'start', i: 0, data: -1 });
      for (let b = 0; b < 8; b++) {
        const [k, i] = map[w * 8 + b];
        out.push({ j: w * 10 + 1 + b, word: w, pos: 1 + b, kind: k, i, data: w * 8 + b });
      }
      out.push({ j: w * 10 + 9, word: w, pos: 9, kind: 'stop', i: 1, data: -1 });
    }
    LAYOUT = out;
    return out;
  }

  // Where on the air bit `i` of the value or the address goes.
  function airOf(field, i) {
    const kind = FIELDS[field].kind;
    const cell = layout().find(c => c.kind === kind && c.i === i);
    return cell ? cell.j : -1;
  }

  // An address (0–8191) and a value (0–2047) as the 40 bits on the air.
  function air(addr, value) {
    const bits = PP().encodeAbf(addr & 8191, value & 2047);
    const out = new Uint8Array(40);
    for (let w = 0; w < 4; w++) {
      out[w * 10] = 0;
      for (let b = 0; b < 8; b++) out[w * 10 + 1 + b] = bits[w * 8 + b];
      out[w * 10 + 9] = 1;
    }
    return out;
  }

  // What a decoder makes of 40 bits: which words have a start or stop bit
  // wrong, which check bits are wrong (positions among the 32), and the
  // address and value they would decode to.
  function read(rx) {
    const framing = [];
    for (let w = 0; w < 4; w++) if (rx[w * 10] !== 0 || rx[w * 10 + 9] !== 1) framing.push(w);
    const bits = [];
    for (let w = 0; w < 4; w++) for (let b = 0; b < 8; b++) bits.push(rx[w * 10 + 1 + b] ? 1 : 0);
    const d = PP().decodeAbf(bits);
    return { framing, badChecks: d.badChecks, addr: d.addr, value: d.value, ok: !framing.length && d.ok };
  }

  // A received frame (or null, if nothing was decoded) against what the
  // station meant to send.
  function judge(addr, value, rx) {
    if (!rx) return { status: 'lost', why: 'lost', addr: null, value: null, flips: [], cleared: [], set: [], framing: [], badChecks: [] };
    const tx = air(addr, value);
    const flips = [], cleared = [], set = [];
    for (let j = 0; j < 40; j++) {
      if (rx[j] === tx[j]) continue;
      flips.push(j);
      (tx[j] ? cleared : set).push(j);
    }
    const r = read(rx);
    let status = 'clean', why = '';
    if (r.framing.length) { status = 'rejected'; why = 'framing'; }
    else if (r.badChecks.length) { status = 'rejected'; why = 'check'; }
    else if (r.addr !== addr) status = 'ghost';
    else if (r.value !== value) status = 'wrong';
    return { status, why, addr: r.addr, value: r.value, flips, cleared, set, framing: r.framing, badChecks: r.badChecks };
  }

  // ── The receiver, as a model ───────────────────────────────────────────────

  // A bit's chance of being misread at an Eb/N0 of `snrDb`: non-coherent FSK,
  // ½·e^(−γ/2). The cliff is the lesson: 0.7% at 9 dB, 0.002% at 13.
  function ber(snrDb) {
    if (!Number.isFinite(snrDb)) return snrDb > 0 ? 0 : 0.5;
    return Math.min(0.5, 0.5 * Math.exp(-0.5 * Math.pow(10, snrDb / 10)));
  }

  // A direct wave and one echo of relative strength `rho`, `phase` radians
  // apart, as an amplitude against their average: 1 + ρ in step, 1 − ρ in
  // opposition, nothing at all when an equal echo arrives half a cycle late.
  function fadeAmp(rho, phase) {
    const re = 1 + rho * Math.cos(phase), im = rho * Math.sin(phase);
    return Math.sqrt(re * re + im * im) / Math.sqrt(1 + rho * rho);
  }

  // The third-order intermodulation products of two transmitters at f1 and
  // f2 MHz, and how far each lands from the channel.
  function imProducts(f1, f2, fc) {
    const c = fc == null ? fMhz() : fc;
    return [
      { key: '2f1-f2', mhz: 2 * f1 - f2 },
      { key: '2f2-f1', mhz: 2 * f2 - f1 },
    ].map(x => ({ ...x, offsetHz: Math.round((x.mhz - c) * 1e7) / 10 }));
  }
  function nearestProduct(f1, f2) {
    return imProducts(f1, f2).reduce((a, b) => (Math.abs(b.offsetHz) < Math.abs(a.offsetHz) ? b : a));
  }

  // A day's temperature: coolest at three in the morning, warmest at three
  // in the afternoon.
  function dayTemp(h, tmin, tmax) {
    return (tmin + tmax) / 2 + (tmax - tmin) / 2 * Math.cos(2 * Math.PI * (h - 15) / 24);
  }
  // A transmitter's carrier offset, in Hz, at hour `h`: its error at 25 °C
  // and so much more for every degree away from it.
  function crystalHz(p, h) {
    return (p.ppm + p.tc * (dayTemp(h, p.tmin, p.tmax) - 25)) * hzPerPpm();
  }

  // What an off-frequency carrier costs, in dB of signal: nothing until the
  // tones' swing reaches the edge of the receiver's filter, then about 1.5 dB
  // for every 100 Hz past it; Infinity once the whole signal is outside.
  function edgePenaltyDb(offHz, wide) {
    const half = wide ? WIDE_HALF_HZ : IF_HALF_HZ;
    const dev = wide ? 2 * DEV_HZ : DEV_HZ;
    const a = Math.abs(offHz);
    if (a >= half + dev) return Infinity;
    const over = a + dev - half;
    return over <= 0 ? 0 : 1.5 * over / 100;
  }

  // A PLL settling after key-up: its frequency error `t` ms in, from `kick`
  // kHz, falling by e every `tau` ms — ringing through zero as it goes, if
  // its loop is under-damped.
  function pllHz(t, p) {
    const e = Math.exp(-t / p.tau);
    return p.kick * 1000 * e * (p.ring ? Math.cos(2 * Math.PI * t / (4 * p.tau)) : 1);
  }

  // A tone detector's response to a tone `df` Hz from the one it listens for:
  // a one-bit integrate-and-dump — which is what alert-dsp.js's sliding DFT
  // over a symbol is — |sinc(df·T)|. ALERT's tones are 808.6 Hz apart, which
  // at 300 baud is not a whole number of cycles, so each detector hears a
  // tenth of the other tone. The lesson draws it.
  function toneResp(df) {
    const u = df * bitMs() / 1000;
    return u === 0 ? 1 : Math.abs(Math.sin(Math.PI * u) / (Math.PI * u));
  }

  function gauss(rand) {
    let u = 0;
    while (!u) u = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  }

  // ── The fourteen faults ────────────────────────────────────────────────────
  // Each parameter is a range {min, max, step, def}, a switch {bool, def} or a
  // choice {pick, def}. The words for them are the tabs'; the figures are here
  // so that the bench, the lesson and the check all start from the same ones.

  const SNR = def => ({ min: 0, max: 24, step: 0.5, def });
  const FIELD = { pick: ['value', 'address'], def: 'value' };
  const EFFECTS = {
    noise:     { family: 'air', params: { snr: SNR(10) } },
    impulse:   { family: 'air', params: { rate: { min: 0.5, max: 20, step: 0.5, def: 4 },
                                          width: { min: 0.5, max: 20, step: 0.5, def: 8 },
                                          regular: { bool: true, def: false }, snr: SNR(18) } },
    multipath: { family: 'air', params: { echo: { min: 0, max: 1, step: 0.05, def: 0.85 },
                                          rate: { min: 0, max: 10, step: 0.25, def: 2 },
                                          place: { min: 0, max: 360, step: 5, def: 180 }, snr: SNR(14) } },
    collision: { family: 'air', params: { sir: { min: -10, max: 12, step: 0.5, def: 2 },
                                          start: { min: -500, max: 130, step: 5, def: 40 },
                                          copy: { bool: true, def: false }, vary: { bool: true, def: true } } },
    intermod:  { family: 'air', params: { f1: { min: 148, max: 174, step: 0.0001, def: 152 },
                                          f2: { min: 148, max: 174, step: 0.0001, def: 152.5021 },
                                          sir: { min: -6, max: 20, step: 0.5, def: 3 },
                                          duty: { min: 0, max: 1, step: 0.05, def: 0.3 }, snr: SNR(18) } },
    crystal:   { family: 'tx',  params: { ppm: { min: -25, max: 25, step: 0.5, def: 12 },
                                          tc: { min: 0, max: 1, step: 0.05, def: 0.4 },
                                          tmin: { min: -10, max: 30, step: 1, def: 6 },
                                          tmax: { min: 10, max: 50, step: 1, def: 38 },
                                          hour: { min: 0, max: 23, step: 1, def: 15 },
                                          wide: { bool: true, def: false }, snr: SNR(14) } },
    pll:       { family: 'tx',  params: { lead: { min: 5, max: 400, step: 5, def: 25 },
                                          tau: { min: 2, max: 200, step: 1, def: 30 },
                                          kick: { min: 1, max: 15, step: 0.5, def: 10 },
                                          ring: { bool: true, def: false }, snr: SNR(16) } },
    clock:     { family: 'tx',  params: { err: { min: -12, max: 12, step: 0.25, def: 4 },
                                          uart: { bool: true, def: true },
                                          jitter: { min: 0, max: 20, step: 1, def: 6 }, snr: SNR(18) } },
    twist:     { family: 'tx',  params: { twist: { min: -9, max: 9, step: 0.1, def: 4.2 }, snr: SNR(10) } },
    stuck:     { family: 'data', params: { field: FIELD, bit: { min: 0, max: 12, step: 1, def: 4 },
                                           to: { pick: [1, 0], def: 1 } } },
    shift:     { family: 'data', params: { field: FIELD, left: { bool: true, def: true } } },
    invert:    { family: 'data', params: { field: FIELD } },
    reverse:   { family: 'data', params: { field: FIELD } },
    gray:      { family: 'data', params: { field: FIELD, way: { pick: ['gray', 'ungray'], def: 'gray' } } },
  };

  function defaults(id) {
    const e = EFFECTS[id];
    const out = {};
    if (e) for (const [k, d] of Object.entries(e.params)) out[k] = d.def;
    return out;
  }

  // Parameters as given, held to their ranges and choices, the rest defaulted.
  function withDefaults(id, given) {
    const e = EFFECTS[id];
    const out = defaults(id);
    if (!e || !given) return out;
    for (const [k, d] of Object.entries(e.params)) {
      if (!(k in given)) continue;
      const v = given[k];
      if (d.bool) out[k] = !!v;
      else if (d.pick) out[k] = d.pick.find(o => String(o) === String(v)) ?? d.def;
      else if (Number.isFinite(Number(v))) out[k] = Math.min(d.max, Math.max(d.min, Number(v)));
    }
    if (id === 'stuck') out.bit = Math.min(out.bit, FIELDS[out.field].width - 1);
    if (id === 'crystal' && out.tmax < out.tmin) out.tmax = out.tmin;
    return out;
  }

  // The data path: what the logger actually puts in the frame for a station
  // whose true reading is `addr` = `value`.
  function dataPath(id, p, addr, value) {
    const f = FIELDS[p.field] || FIELDS.value;
    const w = f.width;
    const take = n => {
      switch (id) {
        case 'stuck':   return p.to ? n | (1 << p.bit) : n & ~(1 << p.bit) & mask(w);
        case 'shift':   return p.left ? shl(n, w) : shr(n);
        case 'invert':  return invert(n, w);
        case 'reverse': return reverse(n, w);
        case 'gray':    return p.way === 'ungray' ? fromGray(n) : toGray(n) & mask(w);
        default:        return n;
      }
    };
    return p.field === 'address' ? { addr: take(addr), value } : { addr, value: take(value) };
  }

  // One frame through a fault on the air or in the transmitter. `tx` the 40
  // bits sent; `rand` the seeded generator; `opt.batch` when it is one of
  // many (a collision then meets its frame at a different moment each time),
  // `opt.hour` the time of day for the crystal, `opt.trace` for the drawings'
  // inner workings. Returns { rx, lost, trace } — rx null when nothing was
  // decoded at all, and `lost` saying why.
  function channel(id, p, tx, rand, opt) {
    const o = opt || {};
    switch (id) {
      case 'noise':     return chNoise(p, tx, rand, o);
      case 'impulse':   return chImpulse(p, tx, rand, o);
      case 'multipath': return chMultipath(p, tx, rand, o);
      case 'collision': return chCollision(p, tx, rand, o);
      case 'intermod':  return chIntermod(p, tx, rand, o);
      case 'crystal':   return chCrystal(p, tx, rand, o);
      case 'pll':       return chPll(p, tx, rand, o);
      case 'clock':     return chClock(p, tx, rand, o);
      case 'twist':     return chTwist(p, tx, rand, o);
      default:          return { rx: Uint8Array.from(tx), lost: '', trace: null };
    }
  }

  function chNoise(p, tx, rand, o) {
    const rx = Uint8Array.from(tx);
    const e = ber(p.snr);
    for (let j = 0; j < 40; j++) if (rand() < e) rx[j] ^= 1;
    return { rx, lost: '', trace: o.trace ? { snr: new Array(40).fill(p.snr) } : null };
  }

  // Short bursts of wide-band noise — lightning, a car's ignition, an electric
  // fence's pulse, a switching regulator — each wiping whatever bits it lands
  // on. Random arrivals, or evenly spaced (a fence) from a random start.
  function chImpulse(p, tx, rand, o) {
    const T = bitMs(), dur = 40 * T;
    const hits = [];
    if (p.regular) {
      const per = 1000 / p.rate;
      for (let t = rand() * per - p.width; t < dur; t += per) hits.push([t, t + p.width]);
    } else {
      for (let t = -p.width; ;) {
        t += -Math.log(1 - rand()) * 1000 / p.rate;
        if (t >= dur) break;
        hits.push([t, t + p.width]);
      }
    }
    const rx = Uint8Array.from(tx);
    const e = ber(p.snr);
    for (let j = 0; j < 40; j++) {
      const a = j * T, b = a + T;
      const hit = hits.some(([s, f]) => s < b && f > a);
      if (rand() < (hit ? 0.5 : e)) rx[j] ^= 1;
    }
    return { rx, lost: '', trace: o.trace ? { hits } : null };
  }

  // A direct wave and an echo. At 300 baud an echo microseconds late smears
  // nothing — a bit lasts 3.33 ms — but the two add or cancel, so the signal
  // is as strong as the pair's sum. A still path sits at one point of that
  // pattern (`place`, degrees between the two); anything moving — a vehicle,
  // trees in wind — sweeps it through at `rate` fades a second.
  function chMultipath(p, tx, rand, o) {
    const T = bitMs() / 1000;
    const phi0 = p.rate > 0 ? rand() * 2 * Math.PI : p.place * Math.PI / 180;
    const rx = Uint8Array.from(tx);
    const snrs = [];
    for (let j = 0; j < 40; j++) {
      const a = fadeAmp(p.echo, phi0 + 2 * Math.PI * p.rate * (j + 0.5) * T);
      const s = p.snr + 20 * Math.log10(Math.max(a, 1e-4));
      snrs.push(s);
      if (rand() < ber(s)) rx[j] ^= 1;
    }
    return { rx, lost: '', trace: o.trace ? { snr: snrs, phi0 } : null };
  }

  // Another transmitter keying up over this frame: `sir` dB weaker than ours
  // (negative: stronger), starting `start` ms after our first bit. Its own
  // keying is PropPhysics's: the 0x55 lead-in, its frame, then the idle tail.
  // `copy` makes it a second repeater relaying the same reading at the same
  // delay, so its frame lies exactly on ours.
  function chCollision(p, tx, rand, o) {
    const P = PP(), T = P.BIT_MS, cap = P.CAPTURE_DB;
    const other = p.copy ? tx : air(1 + Math.floor(rand() * 8191), Math.floor(rand() * 2048));
    const start = p.copy ? -P.LEAD_MS
      : (o.batch && p.vary ? -P.KEYING_MS + rand() * (P.KEYING_MS + 40 * T) : p.start);
    const otherBit = t => {
      const u = t - start;
      if (u < 0 || u >= P.KEYING_MS) return null;
      if (u < P.LEAD_MS) return PREAMBLE[Math.floor(u / T) % 10];
      const k = Math.floor((u - P.LEAD_MS) / T);
      return k < 40 ? other[k] : 1;
    };
    const rx = Uint8Array.from(tx);
    const trace = o.trace ? { start, other: Array.from(other), over: [] } : null;
    for (let j = 0; j < 40; j++) {
      const ob = otherBit((j + 0.5) * T);
      if (ob == null) continue;
      if (trace) trace.over.push(j);
      if (p.sir >= cap) continue;
      if (p.sir <= -cap) return { rx: null, lost: 'captured', trace };
      let pf = 0.5 * (1 - Math.abs(p.sir) / cap);
      if (ob === tx[j]) pf *= 0.25;
      if (rand() < pf) rx[j] ^= 1;
    }
    return { rx, lost: '', trace };
  }

  // Two strong transmitters near the receiver mix in anything non-linear —
  // its own front end overloaded, or a corroded joint on the mast — and the
  // mixture has a product at 2f1 − f2. One landing inside our receiver's
  // filter is an unwanted carrier whenever both are on the air together
  // (`duty` of the time), and our own station's signal has nothing to do with
  // when. Capture's rule then holds: 6 dB clear and ours wins; nearer, bits
  // flip; stronger by 6 dB and it takes the receiver. After the FM detector a
  // product off the channel is a tone at its offset, which hurts most where
  // ALERT's own tones are (beatWeight) — and a product right on the channel is
  // a carrier sitting on ours.
  function beatWeight(hz) {
    if (hz < 300) return 1;
    if (hz < 900) return (hz - 300) / 600 * 0.6 + 0.4;
    if (hz <= 2600) return 1;
    return Math.max(0, 1 - (hz - 2600) / 1400);
  }
  function chIntermod(p, tx, rand, o) {
    const near = nearestProduct(p.f1, p.f2);
    const ihz = Math.abs(near.offsetHz);
    const inBand = ihz <= IF_HALF_HZ;
    const on = inBand && rand() < p.duty;
    const trace = o.trace ? { on, near, prods: imProducts(p.f1, p.f2), inBand, weight: inBand ? beatWeight(ihz) : 0 } : null;
    const cap = PP().CAPTURE_DB;
    if (on && p.sir <= -cap) return { rx: null, lost: 'captured', trace };
    const rx = Uint8Array.from(tx);
    const e = ber(p.snr);
    const pc = on && p.sir < cap ? 0.5 * (1 - Math.abs(p.sir) / cap) * 0.5 * beatWeight(ihz) : 0;
    const pf = Math.max(e, pc);
    for (let j = 0; j < 40; j++) if (rand() < pf) rx[j] ^= 1;
    return { rx, lost: '', trace };
  }

  function chCrystal(p, tx, rand, o) {
    const h = o.hour != null ? o.hour : p.hour;
    const off = crystalHz(p, h);
    const pen = edgePenaltyDb(off, p.wide);
    const trace = o.trace ? { off, pen, temp: dayTemp(h, p.tmin, p.tmax), hour: h } : null;
    if (!Number.isFinite(pen)) return { rx: null, lost: 'offchannel', trace };
    const rx = Uint8Array.from(tx);
    const e = ber(p.snr - pen);
    for (let j = 0; j < 40; j++) if (rand() < e) rx[j] ^= 1;
    return { rx, lost: '', trace };
  }

  // The frame starts `lead` ms after key-up; each bit is read at whatever
  // frequency the PLL has reached by then.
  function chPll(p, tx, rand, o) {
    const T = bitMs();
    const rx = Uint8Array.from(tx);
    const offs = [];
    for (let j = 0; j < 40; j++) {
      const off = pllHz(p.lead + (j + 0.5) * T, p);
      offs.push(off);
      const pen = edgePenaltyDb(off, false);
      if (rand() < (Number.isFinite(pen) ? ber(p.snr - pen) : 0.5)) rx[j] ^= 1;
    }
    return { rx, lost: '', trace: o.trace ? { offs } : null };
  }

  // The sender's bit clock `err` per cent fast (negative: slow). A UART
  // receiver finds each word by the falling edge of its start bit and reads
  // bit k (k + ½) of its own bits later, so the error builds up over a word and
  // starts again at the next; a receiver that times the whole frame from its
  // first edge lets it build up over all 40 bits. `jitter` is how far, in per
  // cent of a bit, the instant it reads at wanders.
  function chClock(p, tx, rand, o) {
    const T = bitMs(), Ttx = T / (1 + p.err / 100), sj = p.jitter / 100 * T;
    const level = t => {
      if (t < 0) return 1;
      const j = Math.floor(t / Ttx);
      return j < 40 ? tx[j] : 1;
    };
    // The first falling edge (a 1 then a 0) strictly after t.
    const nextFall = t => {
      for (let m = Math.max(0, Math.floor(t / Ttx) + 1); m < 40; m++) {
        if (m * Ttx > t && tx[m] === 0 && (m === 0 || tx[m - 1] === 1)) return m * Ttx;
      }
      return null;
    };
    const e = ber(p.snr);
    const read1 = t => (rand() < e ? level(t) ^ 1 : level(t));
    const rx = new Uint8Array(40).fill(1);     // a word never found reads as the idle line
    const samples = [];
    if (!p.uart) {
      const t0 = nextFall(-1) + Math.abs(sj * gauss(rand));
      for (let j = 0; j < 40; j++) {
        const t = t0 + (j + 0.5) * T + sj * gauss(rand);
        samples.push(t);
        rx[j] = read1(t);
      }
    } else {
      let armed = -1;
      for (let w = 0; w < 4; w++) {
        const edge = nextFall(armed);
        if (edge == null) break;
        const t0 = edge + Math.abs(sj * gauss(rand));    // an edge is seen late, never early
        let t = t0;
        for (let k = 0; k < 10; k++) {
          t = t0 + (k + 0.5) * T + sj * gauss(rand);
          samples.push(t);
          rx[w * 10 + k] = read1(t);
        }
        armed = t;
      }
    }
    return { rx, lost: '', trace: o.trace ? { samples, Ttx } : null };
  }

  // The two tones sent at different strengths — `twist` dB, the space tone
  // over the mark. A radio whose data input is pre-emphasised (6 dB an
  // octave, for voice) sends 2109.4 Hz 4.2 dB louder than 1300.8 Hz, and a
  // receiver that does not take it out again hears them so. The average power
  // is the same; the weaker tone's bits are the ones noise turns over, so the
  // flips all go one way.
  function twistEbN0(p) {
    const g = Math.pow(10, p.snr / 10), k = Math.pow(10, p.twist / 10);
    return { mark: g * 2 / (1 + k), space: g * 2 * k / (1 + k) };
  }
  function chTwist(p, tx, rand, o) {
    const g = twistEbN0(p);
    const eMark = Math.min(0.5, 0.5 * Math.exp(-g.mark / 2)), eSpace = Math.min(0.5, 0.5 * Math.exp(-g.space / 2));
    const rx = Uint8Array.from(tx);
    for (let j = 0; j < 40; j++) if (rand() < (tx[j] ? eMark : eSpace)) rx[j] ^= 1;
    return { rx, lost: '', trace: o.trace ? { eMark, eSpace, markDb: 10 * Math.log10(g.mark), spaceDb: 10 * Math.log10(g.space) } : null };
  }

  // ── What a check would have caught ─────────────────────────────────────────

  // Of every way `k` of a frame's 40 bits can flip at random, the share that
  // leave its eight check bits and eight framing bits alone — and so pass,
  // as a ghost or a wrong value: C(24, k) / C(40, k).
  function passShare(k) {
    let r = 1;
    for (let i = 0; i < k; i++) r *= (24 - i) / (40 - i);
    return r;
  }

  // A 6-bit CRC on x⁶ + x⁴ + x³ + 1 — the one Enhanced iFLOWS frames carry —
  // over 24 data bits and its own 6: of every pattern of `k` flipped bits in
  // those 30, the share it catches. Exhaustive, so exact: a pattern slips
  // through only if the polynomial divides it.
  const CRC6 = 0b1011001;
  function crcCatches(k) {
    let all = 0, caught = 0;
    const pick = [];
    const walk = start => {
      if (pick.length === k) {
        let r = 0;
        for (let i = 29; i >= 0; i--) {
          r = (r << 1) | (pick.includes(i) ? 1 : 0);
          if (r & 64) r ^= CRC6;
        }
        all++;
        if (r) caught++;
        return;
      }
      for (let i = start; i < 30; i++) { pick.push(i); walk(i + 1); pick.pop(); }
    };
    walk(0);
    return caught / all;
  }

  // ── A batch, and what it says ──────────────────────────────────────────────

  // `n` frames through one fault. Each is a random station's random reading
  // unless `opt.fixed` (then opt.addr = opt.value every time); with
  // `opt.hours` they are spread evenly over a day, for the faults that come
  // and go with it; with `opt.rows` every frame's outcome is kept, for a CSV.
  function run(id, given, opt) {
    const o = opt || {};
    const P = PP();
    const n = Math.max(1, Math.min(20000, Math.round(o.n || 500)));
    const rand = P.rng(o.seed || 1);
    const p = withDefaults(id, given);
    const fam = EFFECTS[id] ? EFFECTS[id].family : 'air';
    const st = {
      id, n, params: p,
      counts: { clean: 0, rejected: 0, lost: 0, ghost: 0, wrong: 0 },
      why: { framing: 0, check: 0, captured: 0, offchannel: 0 },
      flipsAt: new Array(40).fill(0), passedAt: new Array(40).fill(0), firstAt: new Array(40).fill(0),
      cleared: 0, set: 0, adjacent: 0, flips: 0, damaged: 0,
      byHour: o.hours ? Array.from({ length: 24 }, () => ({ n: 0, bad: 0, through: 0 })) : null,
      pairs: [], examples: [], rows: o.rows ? [] : null,
    };
    for (let i = 0; i < n; i++) {
      const addr = o.fixed ? o.addr & 8191 : 1 + Math.floor(rand() * 8191);
      const value = o.fixed ? o.value & 2047 : Math.floor(rand() * 2048);
      const hour = o.hours ? (i + 0.5) * 24 / n : undefined;
      let rx, lost = '';
      if (fam === 'data') {
        const s = dataPath(id, p, addr, value);
        rx = air(s.addr, s.value);
      } else {
        const ch = channel(id, p, air(addr, value), rand, { batch: true, hour });
        rx = ch.rx; lost = ch.lost;
      }
      const j = judge(addr, value, rx);
      st.counts[j.status]++;
      if (j.status === 'rejected') st.why[j.why]++;
      if (j.status === 'lost') st.why[lost === 'offchannel' ? 'offchannel' : 'captured']++;
      const fs = new Set(j.flips);
      for (const k of j.flips) {
        st.flipsAt[k]++;
        if (fs.has(k - 1) || fs.has(k + 1)) st.adjacent++;
      }
      st.flips += j.flips.length;
      if (j.flips.length) { st.damaged++; st.firstAt[j.flips[0]]++; }
      st.cleared += j.cleared.length;
      st.set += j.set.length;
      if (j.status === 'ghost' || j.status === 'wrong') {
        for (const k of j.flips) st.passedAt[k]++;
        if (st.pairs.length < 4000) st.pairs.push({ addr, value, raddr: j.addr, rvalue: j.value, status: j.status });
      }
      if (st.byHour) {
        const b = st.byHour[Math.min(23, Math.floor(hour))];
        b.n++;
        if (j.status !== 'clean') b.bad++;
        if (j.status === 'ghost' || j.status === 'wrong') b.through++;
      }
      if (st.rows) {
        st.rows.push({ addr, value, hour, status: j.status, why: j.status === 'lost' ? lost : j.why,
          raddr: j.addr, rvalue: j.value, flips: j.flips.slice() });
      }
      if (j.status !== 'clean' && st.examples.length < 12) {
        st.examples.push({ ...j, addr, value, raddr: j.addr, rvalue: j.value, rx: rx ? Array.from(rx) : null, lost });
      }
    }
    return st;
  }

  // Of the flips in `at` (40 positions), the share landing where `pick(cell)`.
  function share(at, pick) {
    const tot = at.reduce((a, b) => a + b, 0);
    if (!tot) return 0;
    return layout().reduce((a, c) => a + (pick(c) ? at[c.j] : 0), 0) / tot;
  }

  // Which effects could leave a finding with this key, best first — what the
  // bench offers to try and the lesson's sections to read.
  const CAUSES = {
    single:    ['stuck'],
    early:     ['pll'],
    late:      ['clock', 'collision'],
    wordend:   ['clock'],
    runs:      ['impulse', 'multipath', 'collision'],
    onset:     ['collision', 'impulse'],
    patchy:    ['intermod', 'multipath', 'impulse'],
    even:      ['noise', 'collision', 'crystal'],
    down:      ['twist', 'stuck'],
    up:        ['twist', 'stuck'],
    hours:     ['crystal', 'clock', 'impulse'],
    lost:      ['collision', 'intermod', 'crystal'],
    caught:    ['clock', 'pll', 'noise'],
    shl: ['shift'], shr: ['shift'], invert: ['invert'], reverse: ['reverse'], gray: ['gray'], ungray: ['gray'],
    stuck:     ['stuck'],
    singles:   ['noise', 'collision', 'multipath'],
    lowaddr:   ['pll'],
  };
  const causes = key => (CAUSES[key] || []).slice();

  // What a batch's damage looks like, as findings: { key, says, ...figures }.
  // Read from the bits alone — never from which fault made them — so the same
  // reasoning runs on a mystery batch and, through analysePairs, on readings
  // somebody has pasted in.
  function fingerprint(st) {
    const out = [];
    const pct = x => `${Math.round(x * 100)}%`;
    const hit = st.n - st.counts.clean;
    const through = st.counts.ghost + st.counts.wrong;
    if (!hit) {
      out.push({ key: 'none', says: `All ${st.n} frames arrived exactly as sent.` });
      return out;
    }
    // A fixed rule first: if one explains every reading that got through, the
    // patterns below are its shadow, not separate findings.
    const rules = [];
    if (st.pairs.length >= 8) {
      const wrong = st.pairs.filter(x => x.status === 'wrong').map(x => ({ a: x.value, b: x.rvalue }));
      const ghost = st.pairs.filter(x => x.status === 'ghost').map(x => ({ a: x.addr, b: x.raddr }));
      const pick = wrong.length >= ghost.length ? { pairs: wrong, field: 'value' } : { pairs: ghost, field: 'address' };
      if (pick.pairs.length >= 8) {
        for (const f of analysePairs(pick.pairs, pick.field).findings) {
          if (TRANSFORMS.includes(f.key) || f.key === 'stuck') rules.push({ ...f, field: pick.field });
        }
      }
    }
    const ruled = rules.some(f => f.key !== 'stuck');
    if (st.counts.lost >= 0.1 * st.n) {
      out.push({ key: 'lost', share: st.counts.lost / st.n,
        says: `${pct(st.counts.lost / st.n)} of frames were never decoded at all — the station looks silent rather than wrong.` });
    }
    const caught = st.counts.rejected;
    if (caught && caught >= 0.6 * (caught + through)) {
      out.push({ key: 'caught', share: caught / (caught + through), framing: st.why.framing / Math.max(1, caught),
        says: `Of the damaged frames that were decoded, ${pct(caught / (caught + through))} were thrown out — `
          + `${st.why.framing >= st.why.check ? 'mostly at a start or stop bit' : 'mostly at a check bit'}. `
          + 'The receiver sees the frame and discards it: the station goes quiet, it does not go wrong.' });
    }
    if (through) {
      out.push({ key: 'through', share: through / st.n,
        says: `${through} of ${st.n} got through looking valid — ${st.counts.ghost} on the wrong address (ghosts), `
          + `${st.counts.wrong} as a wrong value. Those are the ones that reach the database.` });
    }
    const at = st.flipsAt;
    let hours = null;
    if (st.byHour) {
      const rates = st.byHour.map(b => (b.n ? b.bad / b.n : 0));
      const hi = Math.max(...rates), lo = Math.min(...rates);
      if (hi >= 0.05 && hi >= 3 * (lo + 0.01)) {
        const peak = rates.indexOf(hi);
        hours = { key: 'hours', peak, hi, lo,
          says: `It comes and goes with the time of day: ${pct(hi)} of frames damaged at ${String(peak).padStart(2, '0')}:00, ${pct(lo)} at the best hour.` };
      }
    }
    if (st.flips >= 10 && !ruled) {
      const top = at.indexOf(Math.max(...at));
      const topShare = at[top] / st.flips;
      const early = share(at, c => c.j < 10);
      const late = share(at, c => c.j >= 30);
      // Where each damaged frame's first flip is: a timing error's begins at
      // the end of a word whatever garbage follows once the receiver has lost
      // its place; a burst's begins wherever the burst did.
      const wordend = share(st.firstAt, c => c.pos >= 7);
      let onsetAt = 0, onset = 0;
      for (let j = 1; j <= 36; j++) {
        const w = (st.firstAt[j] + st.firstAt[j + 1] + st.firstAt[j + 2] + st.firstAt[j + 3]) / Math.max(1, st.damaged);
        if (w > onset) { onset = w; onsetAt = j; }
      }
      const mean = st.flips / 40;
      const cv = Math.sqrt(at.reduce((a, v) => a + (v - mean) * (v - mean), 0) / 40) / mean;
      if (topShare >= 0.9) {
        const c = layout()[top];
        out.push({ key: 'single', j: top, share: topShare,
          says: `Every change is in one bit: on-air bit ${top + 1} (${cellName(c)}). One line, one track, one input — look at the hardware.` });
      } else if (early >= 0.55) {
        out.push({ key: 'early', share: early,
          says: `${pct(early)} of the flips are in the first word sent — the start of the transmission is the trouble.` });
      } else if (wordend >= 0.6) {
        out.push({ key: 'wordend', share: wordend,
          says: `In ${pct(wordend)} of damaged frames the first flip is in the last three bits of a word, where a timing error builds up to — the two clocks disagree.` });
      } else if (onset >= 0.5) {
        out.push({ key: 'onset', j: onsetAt, share: onset,
          says: `In ${pct(onset)} of damaged frames the trouble starts at the same moment — on-air bits ${onsetAt + 1}–${onsetAt + 4}, `
            + `${Math.round(onsetAt * bitMs())} ms in. Something else switches on at a fixed time.` });
      } else if (late >= 0.55) {
        out.push({ key: 'late', share: late,
          says: `${pct(late)} of the flips are in the last word sent — something gets worse as the frame goes on.` });
      } else if (st.flips >= 80 && cv <= Math.max(0.45, 1.6 / Math.sqrt(mean))) {
        // No more uneven than chance makes this many flips across 40 places.
        out.push({ key: 'even', cv,
          says: 'The flips land evenly across all 40 bits — no part of the frame is safer than another.' });
      }
      // Whole frames wrecked among frames untouched: something switching on
      // and off, rather than a steady rate of bits going wrong.
      const perHit = st.damaged ? st.flips / st.damaged : 0;
      const hitShare = st.damaged / st.n;
      if (!hours && perHit >= 3.5 && hitShare >= 0.03 && hitShare <= 0.7) {
        out.push({ key: 'patchy', perHit, share: hitShare,
          says: `${pct(1 - hitShare)} of frames are perfect, and the damaged ones lost ${perHit.toFixed(1)} bits each on average — `
            + 'when it strikes it takes several bits at once, rather than wearing a bit here and there off every frame.' });
      }
      const adj = st.adjacent / st.flips;
      if (adj >= 0.45) {
        out.push({ key: 'runs', share: adj,
          says: `${pct(adj)} of flipped bits have a flipped neighbour — they come in runs of neighbouring bits, not one at a time.` });
      }
      const down = st.cleared / Math.max(1, st.cleared + st.set);
      if (down >= 0.85) {
        out.push({ key: 'down', share: down,
          says: `${pct(down)} of the flips turn a 1 into a 0: something is pushing every bit the same way.` });
      } else if (down <= 0.15) {
        out.push({ key: 'up', share: 1 - down,
          says: `${pct(1 - down)} of the flips turn a 0 into a 1: something is pushing every bit the same way.` });
      }
    }
    if (hours) out.push(hours);
    return out.concat(rules);
  }

  // A bit on the air, in words: "address bit 5", "the stop bit of word 2".
  function cellName(c) {
    if (c.kind === 'A') return `address bit ${c.i}`;
    if (c.kind === 'D') return `value bit ${c.i}`;
    if (c.kind === 'K') return `a check bit of word ${c.word + 1}`;
    return `the ${c.kind} bit of word ${c.word + 1}`;
  }

  const TRANSFORMS = ['shl', 'shr', 'invert', 'reverse', 'gray', 'ungray', 'swap'];

  // Pairs of numbers — what should have arrived and what did — read the way a
  // batch is: which bits differ, which way, where on the air those bits are
  // sent, and whether one transform explains them all. `field` 'value',
  // 'address', or a width (8 or 16) for numbers that are neither.
  function analysePairs(pairs, field) {
    const f = FIELDS[field] || null;
    const w = f ? f.width : Math.min(16, Math.max(1, Number(field) || 16));
    const at = new Array(w).fill(0);
    const kinds = {};
    let same = 0, singles = 0, cleared = 0, set = 0, differing = 0;
    const diffs = pairs.map(pr => {
      const a = wrap(pr.a, w), b = wrap(pr.b, w);
      const d = diff(a, b, w);
      if (!d.xor) { same++; return d; }
      differing++;
      if (d.flips.length === 1) singles++;
      for (const i of d.flips) at[i]++;
      cleared += d.cleared.length;
      set += d.set.length;
      for (const k of d.kinds) kinds[k] = (kinds[k] || 0) + 1;
      return d;
    });
    const findings = [];
    const pct = x => `${Math.round(x * 100)}%`;
    if (!differing) {
      findings.push({ key: 'none', says: pairs.length ? 'Every pair is the same number twice — nothing to explain.' : 'No pairs yet.' });
      return { w, field, n: pairs.length, same, differing, at, cleared, set, kinds, diffs, findings };
    }
    const all = TRANSFORMS.filter(k => (kinds[k] || 0) === differing && differing >= 2);
    const NAMES = {
      shl: 'every reading is the true one shifted one bit left — doubled, with its top bit lost',
      shr: 'every reading is the true one shifted one bit right — halved, its bottom bit lost',
      invert: 'every reading is the true one with all its bits inverted — a mirror image, 2ⁿ − 1 − x',
      reverse: 'every reading is the true one with its bit order reversed',
      gray: 'every reading is the true one written in Gray code and read as plain binary',
      ungray: 'every reading is the true one read as Gray code when it was plain binary',
      swap: 'every reading is the true one with its two bytes swapped',
    };
    for (const k of all) findings.push({ key: k, says: `${NAMES[k][0].toUpperCase()}${NAMES[k].slice(1)}. A fixed rule like this is wiring or a decoder setting, never radio.` });
    // One bit, one way, every time: stuck.
    const onlyBit = at.findIndex(c => c === differing);
    if (!all.length && singles === differing && onlyBit >= 0 && at.filter(Boolean).length === 1 && (cleared === 0 || set === 0)) {
      findings.push({ key: 'stuck', bit: onlyBit, to: set ? 1 : 0,
        says: differing >= 5
          ? `Every difference is bit ${onlyBit} (worth ${1 << onlyBit}) going ${set ? '0 → 1' : '1 → 0'}: that bit is stuck at ${set ? 1 : 0}. `
            + 'Readings that already had it right came through right.'
          : `All ${differing} differences are bit ${onlyBit} (worth ${1 << onlyBit}) going ${set ? '0 → 1' : '1 → 0'} — consistent with that bit `
            + `stuck at ${set ? 1 : 0}. A few more pairs would settle it.` });
    }
    if (!all.length && !findings.some(x => x.key === 'stuck')) {
      if (singles >= 0.7 * differing) {
        findings.push({ key: 'singles', share: singles / differing,
          says: `${pct(singles / differing)} of the wrong readings are one bit from the true one — the mark of bits flipped one at a time on the way.` });
      }
      const down = cleared / Math.max(1, cleared + set);
      if (cleared + set >= 4 && down >= 0.85) findings.push({ key: 'down', share: down, says: `${pct(down)} of the flipped bits went 1 → 0 — the readings only ever lose bits, so they read low.` });
      else if (cleared + set >= 4 && down <= 0.15) findings.push({ key: 'up', share: 1 - down, says: `${pct(1 - down)} of the flipped bits went 0 → 1 — the readings only ever gain bits, so they read high.` });
      if (f) {
        // Where on the air the differing bits are sent.
        const tot = at.reduce((a, b) => a + b, 0);
        const sentEarly = at.reduce((a, c, i) => a + (airOf(field, i) < 10 ? c : 0), 0) / Math.max(1, tot);
        const sentLast = at.reduce((a, c, i) => a + (layout()[airOf(field, i)].pos === 6 ? c : 0), 0) / Math.max(1, tot);
        if (field === 'address' && tot >= 3 && sentEarly >= 0.7) {
          findings.push({ key: 'lowaddr', share: sentEarly,
            says: `${pct(sentEarly)} of the differences are in address bits 0–5 — the first six data bits on the air. The start of the transmission is the trouble.` });
        } else if (tot >= 3 && sentLast >= 0.6) {
          findings.push({ key: 'wordend', share: sentLast,
            says: `${pct(sentLast)} of the differences are in the last data bit of a word — where a timing error strikes first.` });
        }
        const hiBits = at.reduce((a, c, i) => a + (i >= w - 3 ? c : 0), 0) / Math.max(1, tot);
        if (tot >= 3 && hiBits >= 0.6) {
          findings.push({ key: 'high', share: hiBits,
            says: `${pct(hiBits)} of the differences are in the top three bits — so the wrong readings are wrong by hundreds, not by a few.` });
        }
      }
    }
    return { w, field, n: pairs.length, same, differing, singles, at, cleared, set, kinds, diffs, findings };
  }

  return {
    MARK_HZ, SPACE_HZ, DEV_HZ, IF_HALF_HZ, WIDE_HALF_HZ, PREAMBLE, FIELDS, EFFECTS,
    bitMs, fMhz, hzPerPpm, mask, wrap, bin, hex, parse, flip, shl, shr, rotl, rotr, invert, reverse,
    swapBytes, toGray, fromGray, signed, popcount, positions, diff, layout, airOf, air, read, judge,
    ber, fadeAmp, imProducts, nearestProduct, dayTemp, crystalHz, edgePenaltyDb, pllHz, toneResp,
    defaults, withDefaults, dataPath, channel, run, fingerprint, analysePairs, causes, cellName, passShare, crcCatches,
  };
})();

if (typeof window !== 'undefined') window.BitModel = BitModel;
