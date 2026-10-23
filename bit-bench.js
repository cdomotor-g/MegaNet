// MegaNet — bit-bench.js
//
//   BitBench   the 🧪 Bit Bench tab: a bench to play with the bits a station
//              sends, and with the faults that change them on the way. Seven
//              sections, each something to do:
//
//                1  numbers as bits — decimal, binary and hex side by side,
//                   every bit a button, and the operations a fault performs
//                   (flip, shift, rotate, invert, reverse, Gray) one press away
//                2  the frame on the air — an address and a value as the 40
//                   bits ALERT Binary sends, and the tones they go out as
//                3  where faults happen — one site in 3-D (bit-scene.js) with
//                   every fault's cause somewhere in it, toured a fault at a
//                   time: each lit where it happens, with a close-up of what
//                   goes wrong there
//                4  faults — fourteen of them, from noise to a wire on the
//                   wrong pin: each drawn as it happens to a frame, one frame
//                   at a time or five hundred, with the fingerprint the batch
//                   leaves read out of its bits
//                5  whodunnit — a batch from a fault the bench will not name,
//                   to be told from its fingerprint alone
//                6  your readings — pairs pasted in (what should have arrived,
//                   what did) read the same way
//                7  where to read more: the ⚡ Bit Errors lesson, which takes
//                   each fault in depth, and the tabs that show them in the
//                   network's own data
//
// Each section's heading wears a picture on a tile of its own colour
// (glyphs.js), so the seven tell apart at a glance down a long page.
//
// After bit-model.js (BitModel: every number, every fault, every verdict),
// bit-scene.js (BitScene: the site and its drawing) and core.js (esc,
// escAttr, cssVar, announce, csvEscape, dlText, registerTabTeardown, state);
// glyphs.js (Glyphs) for the headings' pictures; across to app.js (switchTab), bit-flipper.js
// (openBitFlipper), bit-errors.js (BitErrors.open) and core.js's
// buildSensorIndex — all at call time. Nothing runs at load: renderMain()
// calls render() and init().
//
// ── How it is drawn ──────────────────────────────────────────────────────────
// Four canvases (the tones, the site, a fault at work, a rising river through
// a wiring fault), each sized by CSS and given a backing store to match; one
// animation loop draws whichever are on screen and stops the moment the tab is
// left (registerTabTeardown). The site tours the faults on that loop's clock,
// seven seconds each, and only while it is on screen does it keep the loop
// running. A device asking for reduced motion gets every drawing
// still — the frame on the bench at its end, its verdict shown — with ▶ to run
// it. Each canvas is named with what it shows now, and what it shows is also a
// table or a sentence beside it: the bits sent and heard, the batch's counts
// and where its flips landed.
//
// The words here are the tab's; every figure is BitModel's, so the bench, the
// lesson and test/bitbench.mjs cannot disagree about a number.
//
// Exposes: render, init, open, width, setNum, flipBit, op, setFrame,
//          randomFrame, siteTour, siteStep, siteShow, siteBench,
//          pick, set, sendOne, play, batch, batchSize, fixed,
//          mystery, guess, pairs, pairsField, pairsExample, exportCsv, goTo,
//          learn, tab, keepOpen, ink (the drawing kit the lesson shares), state.

const BitBench = (function () {
  const BM = () => BitModel;

  // ── The session's settings ─────────────────────────────────────────────────
  // Kept while the app is open, so a redraw — a theme, a list arriving — does
  // not reset what somebody was in the middle of.
  const S = {
    width: 11, num: 1263, lastOp: '', lastBit: -1,
    addr: 4021, value: 1263,
    effect: 'noise', params: {},
    seed: 1, live: null, liveAt: 0, playing: true, playOnce: false, liveOpen: false,
    n: 500, fixed: false, batch: null,
    mystery: null, score: { right: 0, tried: 0 },
    pairsText: '', pairsField: 'value',
    site: { id: 'noise', tour: true, at: 0, yaw: null },
  };

  // ── The words for each fault ───────────────────────────────────────────────

  const FAMILIES = [
    { key: 'air',  name: 'Between the radios' },
    { key: 'tx',   name: 'In the radio and the logger' },
    { key: 'data', name: 'In the wiring and the decoder' },
  ];

  const num = (x, d = 0) => (Number.isFinite(x) ? Number(x).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
  const sgn = (x, d = 0) => (x > 0 ? '+' : x < 0 ? '−' : '±') + num(Math.abs(x), d);
  const pct = x => `${Math.round(x * 100)}%`;
  const hz = x => (Math.abs(x) >= 1000 ? `${sgn(x / 1000, 2)} kHz` : `${sgn(x)} Hz`);
  const oneIn = p => (p <= 0 ? 'never' : p >= 0.5 ? 'every other bit — a coin toss' : `1 bit in ${num(Math.round(1 / p))}`);

  // Each fault: its icon and name, what it is (two or three sentences), what
  // it does to the bits (one), its parameters' labels and how each reads,
  // and the figures worth saying about the settings as they stand.
  const UI = {
    noise: {
      icon: '📶', name: 'Weak signal',
      what: 'Every receiver hears a hiss of noise. While the signal is well above it the tones are read cleanly; as it sinks towards it, '
        + 'bits are misread at random — and the fall-off is a cliff, not a slope: a few decibels separate a link that never errs from one '
        + 'that is useless.',
      bits: 'Single bits flipped at random, anywhere in the frame, either way.',
      params: { snr: { label: 'Signal over the noise', fmt: v => `${num(v, 1)} dB` } },
      facts: p => [`A bit is misread ${oneIn(BM().ber(p.snr))}.`,
        `A whole frame arrives untouched ${pct(Math.pow(1 - BM().ber(p.snr), 40))} of the time.`],
    },
    impulse: {
      icon: '⚡', name: 'Impulse noise',
      what: 'Lightning, a car\'s ignition, an electric fence, a solar regulator switching — short, loud bursts of noise that wipe out '
        + 'whatever bits they land on, while the bits either side come through clean.',
      bits: 'A few neighbouring bits at a time, at random places in the frame.',
      params: {
        rate: { label: 'Bursts', fmt: v => `${num(v, 1)} a second` },
        width: { label: 'Each lasting', fmt: v => `${num(v, 1)} ms` },
        regular: { label: 'Evenly spaced, like an electric fence' },
        snr: { label: 'Signal over the noise between bursts', fmt: v => `${num(v, 1)} dB` },
      },
      facts: p => [`Each burst covers about ${num(p.width / BM().bitMs() + 1, 1)} bits.`,
        `A 133 ms frame meets ${num(p.rate * (40 * BM().bitMs() + p.width) / 1000, 2)} bursts on average.`],
    },
    multipath: {
      icon: '🪞', name: 'Reflections',
      what: 'The signal arrives by more than one path — straight, and bounced off a hill, a shed or the water. At 300 baud an echo a few '
        + 'microseconds late smears nothing (a bit lasts 3.33 ms), but the copies add or cancel. A still path sits at one point of that '
        + 'pattern for good; anything moving — a vehicle, trees in the wind, a gate — sweeps it through, and the signal fades in and out.',
      bits: 'Runs of bits wiped in each fade, and whole frames in a deep one.',
      params: {
        echo: { label: 'Echo, against the direct wave', fmt: v => (v > 0 ? `${num(20 * Math.log10(v), 1)} dB` : 'none') },
        rate: { label: 'Fades', fmt: v => (v ? `${num(v, 2)} a second` : 'none — nothing moving') },
        place: { label: 'Where a still path sits (0° in step, 180° opposed)', fmt: v => `${num(v)}°` },
        snr: { label: 'Signal over the noise, on average', fmt: v => `${num(v, 1)} dB` },
      },
      facts: p => {
        const lo = 20 * Math.log10(Math.max(1e-4, BM().fadeAmp(p.echo, Math.PI)));
        const hi = 20 * Math.log10(BM().fadeAmp(p.echo, 0));
        const out = [`The two copies range from ${sgn(hi, 1)} dB (in step) to ${lo < -60 ? 'nothing at all' : sgn(lo, 1) + ' dB'} (opposed).`];
        out.push(p.rate ? `A fade every ${num(1000 / p.rate)} ms — ${num(1000 / p.rate / (40 * BM().bitMs()), 1)} frames long.`
          : `Still, at ${num(p.place)}°: the signal is ${sgn(20 * Math.log10(Math.max(1e-4, BM().fadeAmp(p.echo, p.place * Math.PI / 180))), 1)} dB on its average, for good.`);
        out.push('An echo 9 µs late is 0.3% of a bit: reflections fade the signal, they do not shift the bits.');
        return out;
      },
    },
    collision: {
      icon: '💥', name: 'Collision',
      what: 'ALERT is ALOHA: nobody listens before they talk, so now and then two transmitters key up together. FM\'s capture effect hears '
        + 'the stronger cleanly if it is 6 dB ahead; closer than that, bits flip where the two disagree — and a receiver captured by a '
        + 'stronger signal loses ours altogether.',
      bits: 'Flips from the moment the other keys up, most where its bits differ from ours.',
      params: {
        sir: { label: 'Ours, against the other', fmt: v => `${sgn(v, 1)} dB` },
        start: { label: 'The other keys up', fmt: v => (v < 0 ? `${num(-v)} ms before our first bit` : `${num(v)} ms after our first bit`) },
        copy: { label: 'It is a second repeater relaying the same reading at the same delay' },
        vary: { label: 'In a batch, each frame meets it at a different moment' },
      },
      facts: p => {
        const cap = PropPhysics.CAPTURE_DB;
        return [p.sir >= cap ? `${num(p.sir, 1)} dB ahead: FM captures ours, and the other does no harm.`
          : p.sir <= -cap ? `The other is ${num(-p.sir, 1)} dB ahead: the receiver locks on to it and ours is lost.`
          : `Within ${num(cap)} dB of each other: a bit flips ${pct(0.5 * (1 - Math.abs(p.sir) / cap))} of the time where the two differ, a quarter of that where they agree.`];
      },
    },
    intermod: {
      icon: '🔀', name: 'Intermodulation',
      what: 'Two strong transmitters near a receiver — a pager, a phone tower, another radio network — mix in anything non-linear: the '
        + 'receiver\'s own overloaded front end, or a corroded joint on the mast. The mixture has products at 2f₁ − f₂ and 2f₂ − f₁, and '
        + 'one landing in our channel is interference whenever both are on the air: on their schedule, not ours, and for every station '
        + 'that receiver hears.',
      bits: 'Whole frames wrecked while both are on the air, and the rest untouched.',
      params: {
        f1: { label: 'Transmitter 1', fmt: v => `${num(v, 4)} MHz` },
        f2: { label: 'Transmitter 2', fmt: v => `${num(v, 4)} MHz` },
        sir: { label: 'Ours, against the product', fmt: v => `${sgn(v, 1)} dB` },
        duty: { label: 'Both on the air together', fmt: v => `${pct(v)} of the time` },
        snr: { label: 'Signal over the noise', fmt: v => `${num(v, 1)} dB` },
      },
      facts: p => {
        const out = BM().imProducts(p.f1, p.f2).map(x => `${x.key === '2f1-f2' ? '2f₁ − f₂' : '2f₂ − f₁'} = ${num(x.mhz, 4)} MHz — ${hz(x.offsetHz)} from 151.5 MHz.`);
        const near = BM().nearestProduct(p.f1, p.f2);
        out.push(Math.abs(near.offsetHz) <= BM().IF_HALF_HZ ? `Inside the receiver\'s ±${num(BM().IF_HALF_HZ / 1000)} kHz filter: it gets in.`
          : 'Outside the receiver\'s filter: this pair does no harm here.');
        return out;
      },
    },
    crystal: {
      icon: '💎', name: 'Crystal drift',
      what: 'A transmitter\'s frequency comes from a quartz crystal, and crystals age and change with temperature: one part per million is '
        + '151.5 Hz on this channel. Nothing goes wrong until the carrier has moved far enough that its swing reaches the edge of the '
        + 'receiver\'s filter — then the signal degrades fast. So a drifting crystal is worst at one end of the day, and only for its own station.',
      bits: 'Random flips — but only at some hours, and only from the one transmitter.',
      params: {
        ppm: { label: 'Off frequency at 25 °C', fmt: v => `${sgn(v, 1)} ppm` },
        tc: { label: 'Moving with temperature', fmt: v => `${num(v, 2)} ppm a °C` },
        tmin: { label: 'Coolest, before dawn', fmt: v => `${num(v)} °C` },
        tmax: { label: 'Warmest, mid-afternoon', fmt: v => `${num(v)} °C` },
        hour: { label: 'Time of day for a single frame', fmt: v => `${String(v).padStart(2, '0')}:00` },
        wide: { label: 'A 25 kHz channel (wider filter, wider swing)' },
        snr: { label: 'Signal over the noise', fmt: v => `${num(v, 1)} dB` },
      },
      facts: p => {
        const T = BM().dayTemp(p.hour, p.tmin, p.tmax);
        const off = BM().crystalHz(p, p.hour);
        const edge = (p.wide ? BM().WIDE_HALF_HZ - 2 * BM().DEV_HZ : BM().IF_HALF_HZ - BM().DEV_HZ);
        const pen = BM().edgePenaltyDb(off, p.wide);
        return [`At ${String(p.hour).padStart(2, '0')}:00 it is ${num(T, 1)} °C and the carrier is ${sgn(off / BM().hzPerPpm(), 1)} ppm — ${hz(off)}.`,
          `The swing reaches the filter's edge ${num(edge)} Hz out (${num(edge / BM().hzPerPpm(), 1)} ppm); ${!Number.isFinite(pen) ? 'this one is wholly outside it.' : pen ? `this one loses ${num(pen, 1)} dB to it.` : 'this one is inside.'}`];
      },
    },
    pll: {
      icon: '🔒', name: 'PLL at key-up',
      what: 'A synthesised transmitter makes its frequency with a phase-locked loop, which needs a moment to settle each time it keys up. '
        + 'If the data starts before it has — a key-up delay set too short, a tired loop, a battery sagging under the load of '
        + 'transmitting — the first bits go out off frequency.',
      bits: 'The first bits sent — the start of word one, address bits 0–5 — so its ghosts land within 63 of the true address.',
      params: {
        lead: { label: 'Key-up to the first data bit', fmt: v => `${num(v)} ms` },
        tau: { label: 'The loop settles by e every', fmt: v => `${num(v)} ms` },
        kick: { label: 'Off frequency at key-up', fmt: v => `${num(v, 1)} kHz` },
        ring: { label: 'It overshoots and rings as it settles' },
        snr: { label: 'Signal over the noise', fmt: v => `${num(v, 1)} dB` },
      },
      facts: p => {
        const edge = BM().IF_HALF_HZ - BM().DEV_HZ;
        const settle = p.kick * 1000 > edge ? p.tau * Math.log(p.kick * 1000 / edge) : 0;
        return [`It is inside the filter's reach ${num(settle)} ms after key-up; the data starts at ${num(p.lead)} ms.`,
          settle > p.lead ? `So the first ${num(Math.min(40, Math.ceil((settle - p.lead) / BM().bitMs())))} bits go out before it has settled.` : 'So the frame goes out on frequency.'];
      },
    },
    clock: {
      icon: '⏲️', name: 'Clock drift',
      what: 'The logger sends its bits by its own clock and the receiver reads them by its own. A UART finds each word by the edge of its '
        + 'start bit and reads every bit after it by counting, so a clock a few per cent fast or slow lands each reading further from the '
        + 'middle of its bit — and the last bits of each word go first.',
      bits: 'The ends of words — which in ALERT Binary are check bits and stop bits, so most such frames are thrown out rather than misread.',
      params: {
        err: { label: 'The sender\'s clock', fmt: v => (v ? `${num(Math.abs(v), 2)}% ${v > 0 ? 'fast' : 'slow'}` : 'exact') },
        uart: { label: 'The receiver re-times on every word (a UART), rather than on the frame\'s first edge' },
        jitter: { label: 'Where it reads wanders by', fmt: v => `${num(v)}% of a bit` },
        snr: { label: 'Signal over the noise', fmt: v => `${num(v, 1)} dB` },
      },
      facts: p => {
        const k = p.uart ? 9 : 39;
        const off = (k + 0.5) * (p.err / 100);
        return [`By the ${p.uart ? 'stop bit of each word' : 'last bit of the frame'} the reading point is ${num(Math.abs(off) * 100)}% of a bit from the middle${Math.abs(off) >= 0.5 ? ' — in the next bit.' : '.'}`,
          `${p.uart ? 'A UART' : 'Timed from the first edge, a receiver'} reads every bit right while the error stays under ±${num(50 / (k + 0.5), 1)}%.`];
      },
    },
    twist: {
      icon: '🎚️', name: 'Tone twist',
      what: 'The two tones should arrive equally strong. A radio whose data input is pre-emphasised — boosted 6 dB an octave, as voice is — '
        + 'sends the 2109.4 Hz tone 4.2 dB louder than the 1300.8 Hz one, and a receiver that does not take it out again hears them so. '
        + 'Noise then misreads the weaker tone\'s bits far more often than the other\'s.',
      bits: 'Flips that all go one way: 1 → 0 when the mark tone is the weak one, 0 → 1 when the space tone is.',
      params: {
        twist: { label: 'The space tone (0), against the mark (1)', fmt: v => `${sgn(v, 1)} dB` },
        snr: { label: 'Signal over the noise', fmt: v => `${num(v, 1)} dB` },
      },
      facts: p => {
        const g = Math.pow(10, p.snr / 10), k = Math.pow(10, p.twist / 10);
        const m = 10 * Math.log10(g * 2 / (1 + k)), s = 10 * Math.log10(g * 2 * k / (1 + k));
        const em = BM().ber(m), es = BM().ber(s);
        return [`The mark tone arrives at ${num(m, 1)} dB over the noise, the space tone at ${num(s, 1)} dB.`,
          `A 1 is misread ${oneIn(em)}, a 0 ${oneIn(es)}.`,
          `Pre-emphasis left in makes it +${num(20 * Math.log10(BM().SPACE_HZ / BM().MARK_HZ), 1)} dB.`];
      },
    },
    stuck: {
      icon: '📌', name: 'Stuck bit',
      what: 'A wire to the logger broken or shorted, a dirty track on a shaft encoder\'s disc, a failed input: one bit that always reads the '
        + 'same. Readings that already had that bit right come through right; the others are out by exactly its weight.',
      bits: 'One bit, one way, every time — a jump of exactly 2ⁿ.',
      params: {
        field: { label: 'In the', fmt: v => v },
        bit: { label: 'Bit', fmt: v => `${num(v)} (worth ${num(1 << v)})` },
        to: { label: 'Stuck at', fmt: v => String(v) },
      },
      facts: p => [`Every reading with bit ${p.bit} ${p.to ? 'clear' : 'set'} reads ${p.to ? 'high' : 'low'} by ${num(1 << p.bit)}; the rest are right.`],
    },
    shift: {
      icon: '↔️', name: 'Shifted by one',
      what: 'Wired one line over, or a decoder told the field starts a bit early or late: every bit lands in its neighbour\'s place. '
        + 'Shifted left every reading doubles (and its last bit is always 0); shifted right it halves.',
      bits: 'Every reading wrong by the same rule: twice the true one, or half.',
      params: { field: { label: 'In the', fmt: v => v }, left: { label: 'Shifted left (doubled), rather than right (halved)' } },
      facts: p => [p.left ? `${num(1000)} reads as ${num(BM().shl(1000, BM().FIELDS[p.field].width))}; anything past ${num(BM().FIELDS[p.field].max >> 1)} loses its top bit.`
        : `${num(1000)} reads as ${num(BM().shr(1000))}; odd readings lose their last bit.`],
    },
    invert: {
      icon: '🔃', name: 'Inverted bits',
      what: 'Logic the other way up — a sensor whose output is active-low, or a decoder set to the wrong polarity: every 1 reads 0 and '
        + 'every 0 reads 1, so a reading comes out as its mirror image.',
      bits: 'Every bit of the field, every time.',
      params: { field: { label: 'In the', fmt: v => v } },
      facts: p => [`A reading x arrives as ${num(BM().FIELDS[p.field].max)} − x: ${num(100)} as ${num(BM().invert(100, BM().FIELDS[p.field].width))}.`],
    },
    reverse: {
      icon: '🔁', name: 'Reversed bit order',
      what: 'Bits sent least significant first and read most significant first, or wired backwards: the number comes out with its bits '
        + 'in reverse order.',
      bits: 'Every reading scrambled by one fixed rule; a reading that is the same both ways round reads right.',
      params: { field: { label: 'In the', fmt: v => v } },
      facts: p => [`${num(1)} arrives as ${num(BM().reverse(1, BM().FIELDS[p.field].width))}, and ${num(1263)} as ${num(BM().reverse(1263 & BM().FIELDS[p.field].max, BM().FIELDS[p.field].width))}.`],
    },
    gray: {
      icon: '🌀', name: 'Gray code',
      what: 'Shaft encoders print their discs in Gray code, where neighbouring numbers differ in one bit, so a reading taken mid-step is '
        + 'never wildly wrong. Read as plain binary it is nonsense with a pattern: as the river rises steadily, the reading zig-zags.',
      bits: 'One fixed rule — n XOR (n ÷ 2) — so the readings jump about while the river rises smoothly.',
      params: {
        field: { label: 'In the', fmt: v => v },
        way: { label: 'Which way', fmt: v => (v === 'gray' ? 'sent in Gray code, read as binary' : 'sent in binary, read as Gray code') },
      },
      facts: p => {
        const f = p.way === 'ungray' ? BM().fromGray : BM().toGray;
        return [`600, 601, 602, 603 arrive as ${[600, 601, 602, 603].map(v => num(f(v))).join(', ')}.`];
      },
    },
  };

  // Where each fault is taken further: the lesson's section, and the tabs
  // where it shows in the network's own data.
  const SEE = {
    noise:     [['propagation', 'Radio Propagation — the fade-margin test', 'rp-fade'], ['review', 'Network Review — every link\'s fade margin']],
    impulse:   [['health', 'Station Health — when a station\'s readings go wrong']],
    multipath: [['propagation', 'Radio Propagation — waves adding up or cancelling', 'rp-waves']],
    collision: [['propagation', 'Radio Propagation — collisions and capture', 'rp-bits'], ['health', 'Station Health — the Airtime panel'], ['flipsources', 'Bit-Flip Sources']],
    intermod:  [['rf', 'RF Environment — licensed transmitters nearby'], ['workbench', 'Interference Workbench']],
    crystal:   [['health', 'Station Health — Transmitter frequency'], ['flipsources', 'Bit-Flip Sources']],
    pll:       [['packets', 'ALERT Packets — the check message\'s VCO error flag']],
    clock:     [['packets', 'ALERT Packets — framing, bit by bit']],
    twist:     [['serial', 'Serial Monitor — the tones off the air']],
    stuck:     [['field', 'Field Data — a sensor\'s readings over time']],
    shift:     [['field', 'Field Data — a sensor\'s readings over time']],
    invert:    [['packets', 'ALERT Packets — polarity']],
    reverse:   [['packets', 'ALERT Packets — bit order']],
    gray:      [['field', 'Field Data — a sensor\'s readings over time']],
  };

  // Settings that leave a clear fingerprint, for a mystery.
  const MYSTERY = {
    noise: [{ snr: 9 }, { snr: 10.5 }],
    impulse: [{ rate: 5, width: 8 }, { rate: 3, width: 10, regular: true }],
    multipath: [{ echo: 0.9, rate: 3 }, { echo: 0.85, rate: 1.5, snr: 15 }],
    collision: [{ sir: 2 }, { sir: 3.5 }, { sir: -2 }],
    intermod: [{ sir: 2, duty: 0.25 }, { sir: 3, duty: 0.4, f2: 152.5005 }],
    crystal: [{}, { ppm: -12, tc: 0.45 }],
    pll: [{}, { lead: 15, tau: 25 }],
    clock: [{ err: 4 }, { err: -4.5 }],
    twist: [{ twist: 4.2 }, { twist: -5 }],
    stuck: [{ bit: 5, to: 1 }, { bit: 8, to: 0 }, { field: 'address', bit: 3, to: 1 }],
    shift: [{ left: true }, { left: false }],
    invert: [{}],
    reverse: [{}],
    gray: [{}, { way: 'ungray' }],
  };

  const ids = () => Object.keys(BM().EFFECTS);
  const fam = id => BM().EFFECTS[id].family;
  const params = id => {
    if (!S.params[id]) S.params[id] = BM().defaults(id);
    return S.params[id];
  };
  const fieldOf = p => BM().FIELDS[p.field] || BM().FIELDS.value;
  const stillPreferred = () => {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch (_) { return false; }
  };
  const tok = (name, fb) => (typeof cssVar === 'function' ? cssVar(name, fb) : fb);

  // ── The sections ───────────────────────────────────────────────────────────
  // Each: its id, its name, and the picture and colour its heading wears.
  const SECS = [
    ['bb-num',     '1 · Numbers as bits',        '1 · Numbers as bits',  'bits',      'net'],
    ['bb-frame',   '2 · The frame on the air',   '2 · The frame',        'packet',    'data'],
    ['bb-site',    '3 · Where faults happen',    '3 · Where it happens', 'interfere', 'field'],
    ['bb-fault',   '4 · Faults',                 '4 · Faults',           'bolt',      'radio'],
    ['bb-mystery', '5 · Whodunnit?',             '5 · Whodunnit?',       'search',    'learn'],
    ['bb-pairs',   '6 · Your readings',          '6 · Your readings',    'data',      'admin'],
    ['bb-more',    '7 · Where to read more',     '7 · Read more',        'book',      'net'],
  ];
  const secOf = id => SECS.find(x => x[0] === id);
  const glyph = (name, cls) => (typeof Glyphs !== 'undefined' ? Glyphs.svg(name, cls) : '');
  // A section's opening tag and heading: the picture on its colour's tile.
  function secOpen(id) {
    const [, title, , pic, hue] = secOf(id);
    const tile = typeof Glyphs !== 'undefined' ? Glyphs.tile(pic, hue, 'bb-sec-tile') : '';
    return `<section class="panel bb-sec" id="${id}" data-hue="${hue}" aria-labelledby="${id}-h">
      <h3 id="${id}-h" class="bb-sec-h" tabindex="-1">${tile}<span>${esc(title)}</span></h3>`;
  }

  // ── 1 · Numbers as bits ────────────────────────────────────────────────────

  const WIDTHS = [[8, '8 bits'], [11, '11 — a value'], [13, '13 — an address'], [16, '16 bits']];

  function numBody() {
    const M = BM(), w = S.width, v = S.num;
    const bits = [];
    for (let i = w - 1; i >= 0; i--) {
      const on = (v >> i) & 1;
      const flipped = BM().flip(v, i) & M.mask(w);
      const anim = S.lastBit === i ? ' is-flipped' : '';
      bits.push(`<button type="button" class="bb-nbit${on ? ' is-on' : ''}${anim}" id="bb-nbit-${i}" aria-pressed="${on ? 'true' : 'false'}"
        aria-label="Bit ${i}, worth ${num(1 << i)}: ${on}. Flipping it makes ${num(flipped)}."
        title="Flip bit ${i} (worth ${num(1 << i)}): ${num(v)} → ${num(flipped)}" onclick="BitBench.flipBit(${i})">
        <span class="bb-nbit-w" aria-hidden="true">${num(1 << i)}</span><span class="bb-nbit-v" aria-hidden="true">${on}</span><span class="bb-nbit-i" aria-hidden="true">${i}</span></button>`);
    }
    // Each set bit's share of the number, as a bar — why the top bits matter.
    const total = M.mask(w);
    const segs = M.positions(v).reverse().map(i => `<span class="bb-wseg" style="--w:${((1 << i) / total * 100).toFixed(3)}%"
      title="bit ${i}: ${num(1 << i)}"></span>`).join('');
    const grouped = M.bin(v, w).replace(/\B(?=(\d{4})+(?!\d))/g, ' ');
    const anim = S.lastOp ? ` bb-anim-${S.lastOp}` : '';
    return `
      <div class="bb-nbits${anim}" role="group" aria-label="The ${w} bits of ${num(v)}, most significant first">${bits.join('')}</div>
      <div class="bb-ops button-group" role="group" aria-label="What a fault can do to the number">
        ${OPS.map(([k, t, d]) => `<button type="button" class="btn" id="bb-op-${k}" title="${escAttr(d)}" aria-label="${escAttr(t.replace(/[⇇⇉↶↷]/g, '').trim() + ': ' + d)}"
          ${k === 'swap' && w !== 16 ? 'disabled' : ''} onclick="BitBench.op('${k}')">${t}</button>`).join('')}
      </div>
      <div class="bb-wbar" aria-hidden="true">${segs}</div>
      <p class="bb-aside bb-wbar-cap">Each set bit's share of the largest ${w}-bit number, ${num(total)}: bit ${w - 1} alone is ${pct((1 << (w - 1)) / total)} of it, bit 0 just ${((1 / total) * 100).toFixed(2)}%.</p>
      <dl class="bb-readout">
        <div><dt>Decimal</dt><dd>${num(v)}</dd></div>
        <div><dt>Binary</dt><dd class="bb-mono">${grouped}</dd></div>
        <div><dt>Hex</dt><dd class="bb-mono">0x${M.hex(v, w)}</dd></div>
        <div><dt>Signed (two's complement)</dt><dd>${num(M.signed(v, w))}</dd></div>
        <div><dt>Gray code of it</dt><dd>${num(M.toGray(v) & M.mask(w))}</dd></div>
        <div><dt>Bits set</dt><dd>${M.popcount(v)} of ${w}</dd></div>
      </dl>
      <p class="bb-why"><strong>Why it matters:</strong> flipping bit 0 changes ${num(v)} by 1; flipping bit ${w - 1} changes it by
        ${num(1 << (w - 1))}. One flipped bit can be a reading out by a millimetre or by a metre, and which it is depends only on
        where the bit sits.</p>
      <p class="bb-aside">Is it an ALERT address? <button type="button" class="link-btn" onclick="BitBench.tab('bitflipper')">See which
        stations are a bit away from ${num((v & 8191) || 1)} on the Bit Flipper</button>.</p>`;
  }

  const OPS = [
    ['shl', '⇇ Shift left', 'Every bit one place left: doubles it, losing the top bit'],
    ['shr', 'Shift right ⇉', 'Every bit one place right: halves it, losing the bottom bit'],
    ['rotl', '↶ Rotate left', 'Left, with the top bit coming round to the bottom'],
    ['rotr', 'Rotate right ↷', 'Right, with the bottom bit coming round to the top'],
    ['invert', 'Invert all', 'Every 1 to 0 and every 0 to 1'],
    ['reverse', 'Reverse order', 'Bit 0 swaps with the top bit, and so on inwards'],
    ['gray', 'To Gray code', 'n XOR (n ÷ 2), as a shaft encoder prints it'],
    ['ungray', 'From Gray code', 'Back again'],
    ['swap', 'Swap bytes', 'The two bytes of a 16-bit number change places (16 bits only)'],
    ['inc', '+1', 'Add one, wrapping past the top to nought like a counter'],
  ];

  function numHtml() {
    return `
    ${secOpen('bb-num')}
      <p>A reading travels as a row of bits, each worth twice the one to its right. Type a number — decimal, <code>0b…</code> for binary
        or <code>0x…</code> for hex — or press the bits themselves to flip them.</p>
      <div class="bb-num-top">
        <label class="bb-num-in" for="bb-num-in">Number
          <input type="text" id="bb-num-in" inputmode="numeric" autocomplete="off" spellcheck="false" value="${escAttr(String(S.num))}"
            aria-describedby="bb-num-note" oninput="BitBench.setNum(this.value)"></label>
        <fieldset class="bb-chips" aria-describedby="bb-num-note"><legend>Width</legend>
          ${WIDTHS.map(([w, t]) => `<label class="bb-chip" for="bb-w-${w}"><input type="radio" name="bb-w" id="bb-w-${w}" value="${w}"
            ${S.width === w ? 'checked' : ''} onchange="BitBench.width(${w})">${t}</label>`).join('')}
        </fieldset>
      </div>
      <p class="bb-aside" id="bb-num-note">An ALERT reading's value is 11 bits (0–2,047) and its address 13 (0–8,191).</p>
      <div id="bb-num-body">${numBody()}</div>
    </section>`;
  }

  // ── 2 · The frame on the air ───────────────────────────────────────────────

  const KIND = { start: 'frm', stop: 'frm', A: 'addr', D: 'val', K: 'chk' };
  function cellLabel(c) {
    if (c.kind === 'start') return 'S';
    if (c.kind === 'stop') return 'P';
    if (c.kind === 'K') return 'K';
    return `${c.kind}${c.i}`;
  }
  function cellWords(c) {
    if (c.kind === 'start') return 'start bit, always 0';
    if (c.kind === 'stop') return 'stop bit, always 1';
    if (c.kind === 'K') return `check bit, always ${c.i}`;
    return BM().cellName(c);
  }

  // The word column, wide enough for its name; the ten bit columns share the rest.
  const COLS = '<colgroup><col style="width:4.6rem"><col span="10"></colgroup>';

  // The 40 bits as a table, a word to a row — the form a reader can step
  // through, and the one the bench's drawings mirror.
  function frameTable(bits, opt) {
    const o = opt || {};
    const L = BM().layout();
    const flips = new Set(o.flips || []);
    const rows = [0, 1, 2, 3].map(w => {
      const cells = [];
      for (let k = 0; k < 10; k++) {
        const c = L[w * 10 + k];
        const b = bits ? bits[c.j] : '·';
        const f = flips.has(c.j);
        cells.push(`<td class="bb-bit bb-bit--${KIND[c.kind]}${f ? ' bb-bit--flip' : ''}" title="${escAttr(cellWords(c))}${f ? ' — flipped' : ''}">`
          + `<span class="bb-bit-v">${b}</span><span class="bb-bit-k" aria-hidden="true">${cellLabel(c)}</span>`
          + `${f ? '<span class="sr-only">, flipped</span>' : ''}</td>`);
      }
      return `<tr><th scope="row">Word ${w + 1}</th>${cells.join('')}</tr>`;
    }).join('');
    return `<div class="table-wrap"><table class="bb-frame${o.small ? ' bb-frame--small' : ''}">
      <caption class="${o.capShown ? '' : 'sr-only'}">${esc(o.caption || 'The 40 bits on the air')}</caption>${COLS}
      <thead><tr><th scope="col">Word</th><th scope="col">Start</th>${[0, 1, 2, 3, 4, 5, 6, 7].map(b => `<th scope="col">Bit ${b}</th>`).join('')}<th scope="col">Stop</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  function frameBody() {
    const M = BM();
    const tx = M.air(S.addr, S.value);
    const who = stationName(S.addr);
    return `
      ${frameTable(tx, { caption: `Address ${S.addr}, value ${S.value}, as the 40 bits on the air, a word to a row` })}
      <ul class="bb-key" aria-label="What the colours mean">
        <li><span class="bb-sw bb-sw--addr" aria-hidden="true"></span> address — 13 bits${who ? `: ${esc(who)}` : ''}</li>
        <li><span class="bb-sw bb-sw--val" aria-hidden="true"></span> value — 11 bits</li>
        <li><span class="bb-sw bb-sw--chk" aria-hidden="true"></span> check bits — fixed, 8</li>
        <li><span class="bb-sw bb-sw--frm" aria-hidden="true"></span> start and stop — 8</li>
      </ul>`;
  }

  function frameHtml() {
    const M = BM();
    return `
    ${secOpen('bb-frame')}
      <p>An ALERT station sends a reading as four words of ten bits: a start bit, eight bits least significant first, and a stop bit.
        Thirteen carry the station's address, eleven its value — and nothing else checks them: ALERT Binary has no CRC, only eight
        fixed check bits and the start and stop bits. <strong>Flip any of the 24 that carry the reading and the frame still passes</strong>,
        on the wrong address or with the wrong value.</p>
      <div class="bb-frame-in control-row">
        <label for="bb-addr">Address <input type="number" class="field-num" id="bb-addr" min="1" max="8191" value="${S.addr}"
          oninput="BitBench.setFrame('addr', this.value)"></label>
        <label for="bb-value">Value <input type="number" class="field-num" id="bb-value" min="0" max="2047" value="${S.value}"
          oninput="BitBench.setFrame('value', this.value)"></label>
        <button type="button" class="btn" onclick="BitBench.randomFrame()">🎲 Another station</button>
      </div>
      <div id="bb-frame-body">${frameBody()}</div>
      <h4>The tones it goes out as</h4>
      <p>Each bit is a burst of tone for ${num(M.bitMs(), 2)} ms — <strong>${num(M.MARK_HZ, 1)} Hz for a 1</strong> (the mark tone, also the
        idle line) and <strong>${num(M.SPACE_HZ, 1)} Hz for a 0</strong> (space) — and the tones swing the carrier's frequency, which is
        what the receiver hears. A whole frame lasts ${num(40 * M.bitMs())} ms.</p>
      <canvas class="bb-wave" id="bb-wave" role="img" aria-label="The frame's bits going out as tones, ten at a time: a 1 as ${num(M.MARK_HZ, 1)} Hz, a 0 as ${num(M.SPACE_HZ, 1)} Hz."></canvas>
    </section>`;
  }

  // ── 3 · Where faults happen ────────────────────────────────────────────────
  // The site in 3-D (bit-scene.js draws it): the fault it shows, toured or
  // held, and the sentence under it saying where that fault happens.

  const TOUR_MS = 7000;
  const siteIds = () => (typeof BitScene !== 'undefined' ? BitScene.ORDER.filter(id => UI[id]) : ids());
  const spot = id => (typeof BitScene !== 'undefined' && BitScene.SPOTS[id]) || { where: '', close: '' };

  function siteSayHtml() {
    const id = S.site.id, u = UI[id];
    return `<p class="bb-site-say"><strong><span aria-hidden="true">${u.icon}</span> ${esc(u.name)}</strong> — ${esc(spot(id).where)}</p>`;
  }
  function siteName() {
    const id = S.site.id;
    return `A model of an ALERT site in 3-D — a river gauge sending, a repeater on the hill across the valley hearing it — `
      + `showing ${UI[id].name}: ${spot(id).where} The close-up in the corner: ${spot(id).close}.`;
  }
  const zoomName = () => `Close-up: ${spot(S.site.id).close}.`;
  const tourWords = () => (S.site.tour ? '⏸ Hold this one' : '⏵ Tour the faults');

  function siteHtml() {
    return `
    ${secOpen('bb-site')}
      <p>One made-up site with every fault's cause somewhere in it. Our gauge by the river sends; the repeater on the far hill hears;
        and between and around them stand a hill, a shed beside the road, another gauge, a pager mast and a phone tower, a storm and an
        electric fence. The tour lights each fault where it happens, with a close-up of what goes wrong there beside it. Drag the
        site sideways to turn it.</p>
      <div class="bb-site-grid">
        <canvas class="bb-site-cv" id="bb-site-cv" role="img" aria-label="${escAttr(siteName())}"></canvas>
        <div class="bb-site-side">
          <canvas class="bb-site-zoom" id="bb-site-zoom" role="img" aria-label="${escAttr(zoomName())}"></canvas>
          <div id="bb-site-say">${siteSayHtml()}</div>
          <div class="bb-site-ctl">
            <div class="button-group" role="group" aria-label="The tour">
              <button type="button" class="btn" aria-label="The fault before" title="The fault before" onclick="BitBench.siteStep(-1)">◀</button>
              <button type="button" class="btn" id="bb-site-tour" aria-pressed="${S.site.tour ? 'true' : 'false'}" onclick="BitBench.siteTour()">${tourWords()}</button>
              <button type="button" class="btn" aria-label="The next fault" title="The next fault" onclick="BitBench.siteStep(1)">▶</button>
            </div>
            <label class="bb-pick" for="bb-site-pick">Show <select id="bb-site-pick" onchange="BitBench.siteShow(this.value)">${siteIds().map(id =>
              `<option value="${id}" ${S.site.id === id ? 'selected' : ''}>${esc(UI[id].name)}</option>`).join('')}</select></label>
            <p><button type="button" class="btn btn-primary" onclick="BitBench.siteBench()">🧪 Try it on the bench</button></p>
          </div>
        </div>
      </div>
    </section>`;
  }

  // ── 4 · Faults ─────────────────────────────────────────────────────────────

  function pickerHtml() {
    return FAMILIES.map(f => `
      <fieldset class="bb-chips bb-fam"><legend>${esc(f.name)}</legend>
        ${ids().filter(id => fam(id) === f.key).map(id => `<label class="bb-chip" for="bb-fx-${id}"><input type="radio" name="bb-fx"
          id="bb-fx-${id}" value="${id}" ${S.effect === id ? 'checked' : ''} onchange="BitBench.pick('${id}')"><span aria-hidden="true">${UI[id].icon}</span> ${esc(UI[id].name)}</label>`).join('')}
      </fieldset>`).join('');
  }

  function controlHtml(id, key) {
    const d = BM().EFFECTS[id].params[key];
    const u = UI[id].params[key] || { label: key };
    const p = params(id);
    const cid = `bb-p-${id}-${key}`;
    if (d.bool) {
      return `<label class="check-label bb-check" for="${cid}"><input type="checkbox" id="${cid}" ${p[key] ? 'checked' : ''}
        onchange="BitBench.set('${key}', this.checked)"><span>${esc(u.label)}</span></label>`;
    }
    if (d.pick) {
      return `<label class="bb-pick" for="${cid}"><span>${esc(u.label)}</span>
        <select id="${cid}" onchange="BitBench.set('${key}', this.value)">${d.pick.map(o => `<option value="${escAttr(String(o))}"
          ${String(p[key]) === String(o) ? 'selected' : ''}>${esc(u.fmt ? u.fmt(o) : String(o))}</option>`).join('')}</select></label>`;
    }
    const max = id === 'stuck' && key === 'bit' ? fieldOf(p).width - 1 : d.max;
    return `<div class="bb-range">
      <label for="${cid}">${esc(u.label)}</label>
      <input type="range" id="${cid}" min="${d.min}" max="${max}" step="${d.step}" value="${p[key]}"
        oninput="BitBench.set('${key}', this.value, true)" onchange="BitBench.set('${key}', this.value)">
      <output for="${cid}" id="${cid}-out">${esc(u.fmt ? u.fmt(p[key]) : String(p[key]))}</output>
    </div>`;
  }

  function factsHtml(id) {
    return `<ul class="bb-facts">${UI[id].facts(params(id)).map(t => `<li>${esc(t)}</li>`).join('')}</ul>`;
  }

  function seeHtml(id) {
    const links = (SEE[id] || []).map(([tab, label, sec]) => `<li><button type="button" class="link-btn"
      onclick="BitBench.tab('${tab}'${sec ? `, '${sec}'` : ''})">${esc(label)}</button></li>`).join('');
    return `<div class="bb-learn">
      <p><button type="button" class="btn bb-deep" onclick="BitBench.learn('${id}')"><span aria-hidden="true">⚡</span> ${esc(UI[id].name)} in depth — the Bit Errors lesson</button></p>
      ${links ? `<p class="bb-aside">Where it shows in the network's own data:</p><ul class="bb-see">${links}</ul>` : ''}
    </div>`;
  }

  function faultBody() {
    const id = S.effect, u = UI[id];
    const keys = Object.keys(BM().EFFECTS[id].params);
    return `
      <div class="bb-fx-grid">
        <div class="bb-fx-about">
          <h4 class="bb-fx-name"><span aria-hidden="true">${u.icon}</span> ${esc(u.name)}</h4>
          <p>${esc(u.what)}</p>
          <p class="bb-fx-bits"><strong>What it does to the bits:</strong> ${esc(u.bits)}</p>
          <div class="bb-ranges">${keys.map(k => controlHtml(id, k)).join('')}</div>
          <div id="bb-facts">${factsHtml(id)}</div>
          ${seeHtml(id)}
        </div>
        <div class="bb-fx-stage">
          <canvas class="bb-cv" id="bb-cv" role="img" aria-label="${escAttr(liveName())}"></canvas>
          <div class="bb-stage-ctl button-group">
            <button type="button" class="btn btn-primary" onclick="BitBench.sendOne()">📡 Send the frame through it</button>
            <button type="button" class="btn" id="bb-play" aria-pressed="${S.playing ? 'true' : 'false'}" onclick="BitBench.play()">${S.playing ? '⏸ Pause' : '▶ Keep sending'}</button>
          </div>
          <div id="bb-live" class="bb-live">${liveHtml()}</div>
        </div>
      </div>
      <div class="bb-batch-ctl control-row">
        <label for="bb-n">Frames in a batch
          <select id="bb-n" onchange="BitBench.batchSize(this.value)">${[100, 500, 2000].map(n => `<option value="${n}" ${S.n === n ? 'selected' : ''}>${num(n)}</option>`).join('')}</select></label>
        <label class="check-label" for="bb-fixed"><input type="checkbox" id="bb-fixed" ${S.fixed ? 'checked' : ''}
          onchange="BitBench.fixed(this.checked)"><span>Only the frame above (address ${S.addr}, value ${S.value}), rather than every station's</span></label>
        <button type="button" class="btn btn-primary" onclick="BitBench.batch()">📦 Send a batch</button>
      </div>
      <div id="bb-batch">${S.batch && S.batch.id === id ? batchHtml(S.batch, true) : `<p class="bb-aside">A batch sends ${num(S.n)} frames through the fault and reads the fingerprint they leave: where the flips land, which way they go, what got through.</p>`}</div>`;
  }

  function faultHtml() {
    return `
    ${secOpen('bb-fault')}
      <p>Pick a fault and watch the frame above go through it — the bits as sent, and as heard, with what the receiver made of them. Then
        send a batch: one frame tells you little, but five hundred leave a pattern, and the pattern is what tells one cause from another.</p>
      ${pickerHtml()}
      <div id="bb-fault-body">${faultBody()}</div>
    </section>`;
  }

  // ── The frame on the bench, live ───────────────────────────────────────────

  function newLive() {
    const M = BM(), id = S.effect, p = params(id);
    S.seed = (Math.imul(S.seed, 1103515245) + 12345) >>> 0 || 1;
    const rand = PropPhysics.rng(S.seed);
    let tx = M.air(S.addr, S.value), ch;
    if (fam(id) === 'data') {
      const s = M.dataPath(id, p, S.addr, S.value);
      tx = M.air(s.addr, s.value);
      ch = { rx: tx, lost: '', trace: { sent: s } };
    } else {
      ch = M.channel(id, p, tx, rand, { trace: true });
    }
    const j = M.judge(S.addr, S.value, ch.rx);
    S.live = { id, p: { ...p }, addr: S.addr, value: S.value, truth: M.air(S.addr, S.value), tx, ch, j };
    S.liveAt = performance.now();
  }

  const OUTCOME = {
    clean:    ['✅', 'Arrived exactly as sent'],
    rejected: ['🛑', 'Thrown out'],
    lost:     ['❌', 'Never decoded'],
    ghost:    ['👻', 'Passed — on the wrong address'],
    wrong:    ['⚠️', 'Passed — with the wrong value'],
  };

  const andList = xs => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

  function verdict(l) {
    const j = l.j;
    const [mark, word] = OUTCOME[j.status];
    let more = '';
    if (j.status === 'rejected') {
      more = j.why === 'framing' ? `a start or stop bit wrong in word${j.framing.length > 1 ? 's' : ''} ${andList(j.framing.map(w => w + 1))}`
        : `${j.badChecks.length} check bit${j.badChecks.length > 1 ? 's' : ''} wrong`;
    } else if (j.status === 'lost') {
      more = l.ch.lost === 'offchannel' ? 'the carrier is outside the receiver\'s filter altogether' : 'the receiver locked on to the stronger signal';
    } else if (j.status === 'ghost') {
      more = `filed under ${j.addr} instead of ${l.addr}${stationName(j.addr) ? ` — ${stationName(j.addr)}` : ''}`;
    } else if (j.status === 'wrong') {
      more = `${j.value} instead of ${l.value} (${sgn(j.value - l.value)})`;
    }
    return { mark, word, more };
  }

  function stationName(addr) {
    try {
      if (typeof state === 'undefined' || !state.data || typeof buildSensorIndex !== 'function') return '';
      if (!stationName.idx || stationName.src !== state.data) { stationName.idx = buildSensorIndex(); stationName.src = state.data; }
      const hit = stationName.idx.get(addr);
      return hit && hit[0] ? hit[0].station.name : '';
    } catch (_) { return ''; }
  }

  function liveName() {
    const l = S.live;
    if (!l) return 'The fault at work on the frame — press Send to send one.';
    const v = verdict(l);
    return `${UI[l.id].name}, at work on address ${l.addr}, value ${l.value}: ${v.word}${v.more ? ' — ' + v.more : ''}. `
      + `${l.j.flips.length} of 40 bits flipped. The bits sent and heard are in the table under the drawing.`;
  }

  function liveHtml() {
    const l = S.live;
    if (!l) return '';
    const v = verdict(l);
    return `
      <p class="bb-verdict bb-verdict--${l.j.status}"><span aria-hidden="true">${v.mark}</span> <strong>${esc(v.word)}</strong>${v.more ? ` — ${esc(v.more)}` : ''}.
        <span class="bb-aside">${l.j.flips.length ? `${l.j.flips.length} bit${l.j.flips.length > 1 ? 's' : ''} flipped${l.j.flips.length ? `: ${l.j.cleared.length} 1 → 0, ${l.j.set.length} 0 → 1` : ''}.` : 'No bit changed.'}</span></p>
      <details class="bb-more" ${S.liveOpen ? 'open' : ''} ontoggle="BitBench.keepOpen(this.open)"><summary id="bb-live-sum">The bits, sent and heard</summary>
        <div class="bb-pair">
          ${frameTable(l.truth, { caption: fam(l.id) === 'data' ? 'What the station meant to send' : 'Sent', capShown: true, small: true })}
          ${frameTable(l.ch.rx, { caption: l.ch.rx ? (fam(l.id) === 'data' ? 'What went on the air, and was heard' : 'Heard') : 'Heard — nothing decoded', capShown: true, small: true, flips: l.j.flips })}
        </div>
      </details>`;
  }

  // ── A batch, read ──────────────────────────────────────────────────────────

  function countsHtml(st) {
    const parts = [
      ['clean', 'arrived exactly as sent', st.counts.clean],
      ['rejected', 'thrown out by the receiver', st.counts.rejected],
      ['lost', 'never decoded', st.counts.lost],
      ['ghost', 'passed on the wrong address', st.counts.ghost],
      ['wrong', 'passed with the wrong value', st.counts.wrong],
    ];
    const bar = parts.filter(x => x[2]).map(([k, t, n]) => `<span class="bb-seg bb-seg--${k}" style="--w:${(n / st.n * 100).toFixed(2)}%" title="${escAttr(`${num(n)} ${t}`)}"></span>`).join('');
    return `<div class="bb-bar" aria-hidden="true">${bar}</div>
      <ul class="bb-counts">${parts.map(([k, t, n]) => `<li class="bb-count bb-count--${k}"><span class="bb-sw bb-sw--${k}" aria-hidden="true"></span>
        <strong>${num(n)}</strong> ${esc(t)} <span class="bb-aside">(${pct(n / st.n)})</span></li>`).join('')}</ul>`;
  }

  // Where the flips landed, as the frame's own table with each cell shaded
  // by its share of the flips.
  function heatHtml(st, cap) {
    const L = BM().layout();
    const max = Math.max(1, ...st.flipsAt);
    const rows = [0, 1, 2, 3].map(w => {
      const cells = [];
      for (let k = 0; k < 10; k++) {
        const c = L[w * 10 + k];
        const n = st.flipsAt[c.j];
        cells.push(`<td class="bb-heat bb-bit--${KIND[c.kind]}" style="--heat:${(n / max).toFixed(3)}" title="${escAttr(`${cellWords(c)}: flipped ${num(n)} times`)}">`
          + `<span class="bb-bit-v">${n ? num(n) : ''}</span><span class="bb-bit-k" aria-hidden="true">${cellLabel(c)}</span></td>`);
      }
      return `<tr><th scope="row">Word ${w + 1}</th>${cells.join('')}</tr>`;
    }).join('');
    return `<div class="table-wrap"><table class="bb-frame bb-heatmap">
      <caption>${esc(cap)}</caption>${COLS}
      <thead><tr><th scope="col">Word</th><th scope="col">Start</th>${[0, 1, 2, 3, 4, 5, 6, 7].map(b => `<th scope="col">Bit ${b}</th>`).join('')}<th scope="col">Stop</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  function dirHtml(st) {
    const tot = st.cleared + st.set;
    if (!tot) return '';
    return `<div class="bb-dir">
      <p class="bb-dir-row"><span class="bb-dir-k">1 → 0</span><span class="bb-dir-bar"><span class="bb-dir-fill bb-dir-fill--down" style="--w:${(st.cleared / tot * 100).toFixed(1)}%"></span></span><span>${num(st.cleared)} (${pct(st.cleared / tot)})</span></p>
      <p class="bb-dir-row"><span class="bb-dir-k">0 → 1</span><span class="bb-dir-bar"><span class="bb-dir-fill bb-dir-fill--up" style="--w:${(st.set / tot * 100).toFixed(1)}%"></span></span><span>${num(st.set)} (${pct(st.set / tot)})</span></p>
      <p class="bb-aside">Which way the flipped bits went. A frame holds a few more 1s than 0s, so even noise leans a little towards 1 → 0.</p>
    </div>`;
  }

  function hoursHtml(st) {
    if (!st.byHour) return '';
    const rates = st.byHour.map(b => (b.n ? b.bad / b.n : 0));
    const bars = rates.map((r, h) => `<li class="bb-hr" style="--h:${(r * 100).toFixed(1)}%" title="${String(h).padStart(2, '0')}:00 — ${pct(r)} damaged"><span class="bb-hr-k" aria-hidden="true">${h % 3 ? '' : String(h).padStart(2, '0')}</span></li>`).join('');
    const rows = st.byHour.map((b, h) => `<tr><th scope="row">${String(h).padStart(2, '0')}:00</th><td>${num(b.n)}</td><td>${num(b.bad)}</td><td>${pct(b.n ? b.bad / b.n : 0)}</td><td>${num(b.through)}</td></tr>`).join('');
    return `<h5>Through the day</h5>
      <ol class="bb-hours" aria-hidden="true">${bars}</ol>
      <details class="bb-more"><summary>Hour by hour, as a table</summary>
        <div class="table-wrap"><table class="bb-tbl"><caption class="sr-only">Frames damaged at each hour of the day</caption>
          <thead><tr><th scope="col">Hour</th><th scope="col">Frames</th><th scope="col">Damaged</th><th scope="col">Share</th><th scope="col">Got through wrong</th></tr></thead>
          <tbody>${rows}</tbody></table></div></details>`;
  }

  function findingsHtml(fp, reveal) {
    const items = fp.map(f => `<li>${esc(f.says)}</li>`).join('');
    const seen = new Set();
    const cands = [];
    for (const f of fp) for (const c of BM().causes(f.key)) if (!seen.has(c)) { seen.add(c); cands.push(c); }
    return `<h5>What the bits say</h5><ul class="bb-findings">${items}</ul>
      ${reveal && cands.length ? `<p class="bb-aside">Most consistent with:</p><ul class="bb-cands">${cands.slice(0, 5).map(c => `<li><button type="button"
        class="bb-chip-btn${c === S.effect ? ' is-on' : ''}" onclick="BitBench.pick('${c}', true)"><span aria-hidden="true">${UI[c].icon}</span> ${esc(UI[c].name)}</button></li>`).join('')}</ul>` : ''}`;
  }

  function examplesHtml(st) {
    if (!st.examples.length) return '';
    const rows = st.examples.slice(0, 8).map(e => {
      const [mark, word] = OUTCOME[e.status];
      const got = e.status === 'ghost' || e.status === 'wrong' ? `${num(e.raddr)} = ${num(e.rvalue)}` : '—';
      return `<tr><td>${num(e.addr)} = ${num(e.value)}</td><td>${got}</td>
        <td><span aria-hidden="true">${mark}</span> ${esc(word)}</td><td>${e.flips.length ? e.flips.map(j => j + 1).join(', ') : '—'}</td></tr>`;
    }).join('');
    return `<details class="bb-more"><summary>Some of the damaged frames</summary>
      <div class="table-wrap"><table class="bb-tbl"><caption class="sr-only">The first damaged frames of the batch</caption>
        <thead><tr><th scope="col">Sent</th><th scope="col">Arrived as</th><th scope="col">Outcome</th><th scope="col">Bits flipped (1–40)</th></tr></thead>
        <tbody>${rows}</tbody></table></div></details>`;
  }
  function batchHtml(st, reveal) {
    const fp = BM().fingerprint(st);
    const through = st.counts.ghost + st.counts.wrong;
    return `
      <div class="bb-batch">
        <h4>${reveal ? `${esc(UI[st.id].name)}: ${num(st.n)} frames` : `The mystery batch: ${num(st.n)} frames`}</h4>
        ${countsHtml(st)}
        <div class="bb-batch-grid">
          <div>${heatHtml(st, `Where the ${num(st.flips)} flipped bits landed, by place in the frame`)}${dirHtml(st)}</div>
          <div>${findingsHtml(fp, reveal)}${hoursHtml(st)}</div>
        </div>
        ${reveal && fam(st.id) === 'data' ? riverHtml() : ''}
        ${examplesHtml(st)}
        ${reveal ? `<p><button type="button" class="btn" onclick="BitBench.exportCsv('batch')">⤓ This batch, frame by frame — CSV</button>
          <span class="bb-aside">${num(through)} of these got through looking valid: those are the ones a database would hold.</span></p>` : ''}
      </div>`;
  }

  // A rising river through a wiring fault: the true level climbing a step at
  // a time, and what the logger would report.
  function riverHtml() {
    const pts = riverPoints();
    const rows = pts.filter((_, i) => i % 4 === 0).map(p => `<tr><td>${num(p.t)}</td><td>${num(p.a)}</td><td>${num(p.b)}</td></tr>`).join('');
    return `<h5>A rising river through it</h5>
      <canvas class="bb-river" id="bb-river" role="img" aria-label="${escAttr(riverName(pts))}"></canvas>
      <details class="bb-more"><summary>The readings, as a table</summary>
        <div class="table-wrap"><table class="bb-tbl"><caption class="sr-only">A rising river's true readings and what the logger reports</caption>
          <thead><tr><th scope="col">Step</th><th scope="col">True reading</th><th scope="col">Reported</th></tr></thead>
          <tbody>${rows}</tbody></table></div></details>`;
  }
  function riverPoints() {
    const id = S.effect, p = params(id), M = BM();
    const f = fieldOf(p);
    // Gray code's zig-zag is a few units wide whatever the level, so it is
    // drawn rising from nought, where that is most of the picture.
    const base = id === 'gray' ? 0 : f === M.FIELDS.address ? 4000 : 600;
    const out = [];
    for (let t = 0; t <= 64; t++) {
      const a = Math.min(f.max, base + t);
      const s = M.dataPath(id, p, p.field === 'address' ? a : S.addr, p.field === 'address' ? S.value : a);
      out.push({ t, a, b: p.field === 'address' ? s.addr : s.value });
    }
    return out;
  }
  function riverName(pts) {
    const wrong = pts.filter(p => p.a !== p.b).length;
    return `A river rising from ${num(pts[0].a)} to ${num(pts[pts.length - 1].a)} a step at a time, and what the logger reports through this fault: `
      + `${wrong} of ${pts.length} readings wrong, reported between ${num(Math.min(...pts.map(p => p.b)))} and ${num(Math.max(...pts.map(p => p.b)))}.`;
  }

  // ── 4 · Whodunnit ──────────────────────────────────────────────────────────

  function mysteryBody() {
    const m = S.mystery;
    const score = S.score.tried ? `<p class="bb-aside">${S.score.right} of ${S.score.tried} right this session.</p>` : '';
    if (!m) return `<p><button type="button" class="btn btn-primary" onclick="BitBench.mystery()">🎲 A new mystery</button></p>${score}`;
    const opts = ids().map(id => `<option value="${id}" ${m.guess === id ? 'selected' : ''}>${esc(UI[id].name)}</option>`).join('');
    let answer = '';
    if (m.guess) {
      const right = m.guess === m.id;
      const fp = BM().fingerprint(m.st);
      const told = fp.filter(f => BM().causes(f.key).includes(m.id)).map(f => `<li>${esc(f.says)}</li>`).join('');
      const could = !right && fp.some(f => BM().causes(f.key).includes(m.guess));
      answer = `<div class="bb-answer bb-answer--${right ? 'right' : 'wrong'}" role="status">
        <p><span aria-hidden="true">${right ? '🎯' : '🔍'}</span> <strong>${right ? 'Right' : 'Not this time'}</strong> — it was
          <strong>${esc(UI[m.id].name)}</strong>${right ? '.' : `, not ${esc(UI[m.guess].name)}${could ? ' (which the fingerprint was consistent with — the lesson says what tells the two apart)' : ''}.`}</p>
        ${told ? `<p class="bb-aside">The findings that pointed to it:</p><ul class="bb-findings">${told}</ul>` : ''}
        <p class="button-group"><button type="button" class="btn" onclick="BitBench.pick('${m.id}', true, true)">Open it on the bench, set as it was</button>
          <button type="button" class="btn" onclick="BitBench.learn('${m.id}')">⚡ Read about it</button>
          <button type="button" class="btn btn-primary" onclick="BitBench.mystery()">🎲 Another</button></p>
      </div>`;
    }
    return `
      ${batchHtml(m.st, false)}
      <div class="bb-guess control-row">
        <label for="bb-guess">Your verdict <select id="bb-guess" ${m.guess ? 'disabled' : ''}><option value="">Pick a fault…</option>${opts}</select></label>
        <button type="button" class="btn btn-primary" ${m.guess ? 'disabled' : ''} onclick="BitBench.guess(document.getElementById('bb-guess').value)">Check</button>
        ${m.guess ? '' : '<button type="button" class="btn" onclick="BitBench.mystery()">🎲 A different one</button>'}
      </div>
      ${answer}${score}`;
  }

  function mysteryHtml() {
    return `
    ${secOpen('bb-mystery')}
      <p>The bench picks a fault and its settings without saying which, sends a batch through it, and shows you only what a network would:
        what arrived, and where the bits went wrong. Name the culprit. It is the same reasoning as a real case — and some faults leave
        fingerprints so alike that the bits alone cannot separate them, which is a finding too.</p>
      <div id="bb-mystery-body">${mysteryBody()}</div>
    </section>`;
  }

  // ── 5 · Your readings ──────────────────────────────────────────────────────

  function parsePairs(text) {
    const out = [], bad = [];
    String(text || '').split(/\r?\n/).forEach((line, i) => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return;
      const m = t.match(/(0x[0-9a-f]+|0b[01]+|\d+)\D+?(0x[0-9a-f]+|0b[01]+|\d+)/i);
      const a = m && BM().parse(m[1]), b = m && BM().parse(m[2]);
      if (a && b) out.push({ a: a.value, b: b.value, line: i + 1 });
      else bad.push(i + 1);
    });
    return { pairs: out, bad };
  }

  function pairsBody() {
    const { pairs, bad } = parsePairs(S.pairsText);
    if (!pairs.length) {
      return `<p class="bb-aside">${bad.length ? `Line${bad.length > 1 ? 's' : ''} ${bad.slice(0, 6).join(', ')} did not read as two numbers.` : 'Nothing to read yet.'}</p>`;
    }
    const field = S.pairsField;
    const an = BM().analysePairs(pairs, BM().FIELDS[field] ? field : Number(field));
    const w = an.w;
    const max = Math.max(1, ...an.at);
    const isAddr = field === 'address';
    const cells = [];
    for (let i = w - 1; i >= 0; i--) cells.push(`<td class="bb-heat" style="--heat:${(an.at[i] / max).toFixed(3)}" title="bit ${i}: differs in ${an.at[i]} pairs"><span class="bb-bit-v">${an.at[i] || ''}</span></td>`);
    const shown = an.diffs.slice(0, 200);
    const rows = shown.map((d, k) => {
      const mark = BM().bin(d.b, w).split('').map((ch, i) => ((d.xor >> (w - 1 - i)) & 1 ? `<mark>${ch}</mark>` : ch)).join('');
      const kinds = d.kinds.filter(x => x !== 'same' && x !== 'flip1');
      const what = !d.xor ? 'the same' : d.flips.length === 1 ? `bit ${d.flips[0]} ${d.set.length ? '0 → 1' : '1 → 0'}` : `${d.flips.length} bits`;
      return `<tr><td>${num(d.a)}${isAddr && stationName(d.a) ? `<br><span class="bb-aside">${esc(stationName(d.a))}</span>` : ''}</td>
        <td>${num(d.b)}${isAddr && stationName(d.b) ? `<br><span class="bb-aside">${esc(stationName(d.b))}</span>` : ''}</td>
        <td class="bb-mono">${mark}</td><td>${d.xor ? sgn(d.delta) : '0'}</td>
        <td>${esc(what)}${kinds.length ? ` · ${kinds.map(k => KIND_WORDS[k]).join(', ')}` : ''}</td></tr>`;
    }).join('');
    const seen = new Set(), cands = [];
    for (const f of an.findings) for (const c of BM().causes(f.key)) if (!seen.has(c)) { seen.add(c); cands.push(c); }
    return `
      <h4>${num(pairs.length)} pair${pairs.length > 1 ? 's' : ''}: ${num(an.differing)} differ${bad.length ? ` <span class="bb-aside">(line${bad.length > 1 ? 's' : ''} ${bad.slice(0, 6).join(', ')} skipped)</span>` : ''}</h4>
      <h5>What they say</h5>
      <ul class="bb-findings">${an.findings.map(f => `<li>${esc(f.says)}</li>`).join('')}</ul>
      ${cands.length ? `<p class="bb-aside">Most consistent with — try it on the bench:</p><ul class="bb-cands">${cands.slice(0, 5).map(c => `<li><button type="button"
        class="bb-chip-btn" onclick="BitBench.pick('${c}', true)"><span aria-hidden="true">${UI[c].icon}</span> ${esc(UI[c].name)}</button></li>`).join('')}</ul>` : ''}
      <div class="table-wrap"><table class="bb-frame bb-heatmap bb-bitrow"><caption>Which bits differ, most significant first</caption>
        <thead><tr>${Array.from({ length: w }, (_, k) => `<th scope="col">${w - 1 - k}</th>`).join('')}</tr></thead>
        <tbody><tr>${cells.join('')}</tr></tbody></table></div>
      <p class="bb-aside">${an.cleared + an.set ? `${num(an.cleared)} bits went 1 → 0 and ${num(an.set)} went 0 → 1.` : ''}</p>
      <details class="bb-more" ${pairs.length <= 12 ? 'open' : ''}><summary>Pair by pair</summary>
        <div class="table-wrap"><table class="bb-tbl"><caption class="sr-only">Each pair, the bits that differ marked</caption>
          <thead><tr><th scope="col">Should be</th><th scope="col">Arrived</th><th scope="col">Arrived, in binary</th><th scope="col">Out by</th><th scope="col">What changed</th></tr></thead>
          <tbody>${rows}</tbody></table></div>
        ${an.diffs.length > shown.length ? `<p class="bb-aside">The first ${shown.length} of ${num(an.diffs.length)} — every pair is in the CSV.</p>` : ''}
      </details>
      <p><button type="button" class="btn" onclick="BitBench.exportCsv('pairs')">⤓ Pair by pair — CSV</button></p>`;
  }
  const KIND_WORDS = { shl: 'shifted left', shr: 'shifted right', invert: 'inverted', reverse: 'reversed', gray: 'as Gray code', ungray: 'from Gray code', swap: 'bytes swapped' };

  function pairsHtml() {
    const FIELDS = [['value', 'readings (11-bit values)'], ['address', 'ALERT addresses (13-bit)'], ['8', 'other 8-bit numbers'], ['16', 'other 16-bit numbers']];
    const EX = [['flips', 'one-bit flips'], ['stuck', 'a stuck bit'], ['double', 'doubled'], ['gray', 'Gray code'], ['lowaddr', 'ghost addresses']];
    return `
    ${secOpen('bb-pairs')}
      <p>Seen something odd? Paste pairs — what should have arrived, then what did, one pair to a line (<code>1263 1295</code>,
        <code>1263 → 1295</code> and <code>1263,1295</code> all read) — and the bench reads them the way it reads a batch: which bits
        differ, which way, and whether one rule explains them all.</p>
      <div class="bb-pairs-in">
        <label for="bb-pairs-text">Pairs <textarea id="bb-pairs-text" rows="7" spellcheck="false" placeholder="1263 1295&#10;1263 1271&#10;840 872"
          oninput="BitBench.pairs(this.value)">${esc(S.pairsText)}</textarea></label>
        <div>
          <label for="bb-pairs-field">These are <select id="bb-pairs-field" onchange="BitBench.pairsField(this.value)">${FIELDS.map(([k, t]) => `<option value="${k}" ${S.pairsField === k ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
          <p class="bb-aside">Or start from an example:</p>
          <p class="button-group">${EX.map(([k, t]) => `<button type="button" class="btn" onclick="BitBench.pairsExample('${k}')">${esc(t)}</button>`).join('')}</p>
        </div>
      </div>
      <div id="bb-pairs-body">${pairsBody()}</div>
    </section>`;
  }

  // ── 6 · Where to read more ─────────────────────────────────────────────────

  function moreHtml() {
    const link = (tab, icon, name, why, sec) => `<li><button type="button" class="link-btn bb-link" onclick="BitBench.tab('${tab}'${sec ? `, '${sec}'` : ''})"><span aria-hidden="true">${icon}</span> ${esc(name)}</button><span class="bb-aside">${esc(why)}</span></li>`;
    return `
    ${secOpen('bb-more')}
      <p>The bench shows each fault in a paragraph. The <strong>⚡ Bit Errors</strong> lesson, in the Knowledge base, takes each in depth:
        the physics, why it leaves the marks it does, how to confirm it in the field and what fixes it.</p>
      <ul class="bb-links">
        ${link('biterrors', '⚡', 'Bit Errors — every fault in depth', 'The lesson behind this bench: symptoms, causes, fingerprints and fixes.')}
        ${link('propagation', '🎓', 'Radio Propagation', 'How a reading travels: echoes, shadows, collisions and the fade-margin test, in pictures that move.')}
        ${link('bitflipper', '🔀', 'Bit Flipper', 'Every address one or two bits from a station\'s, and the stations a ghost would land on.')}
        ${link('flipsources', '🔎', 'Bit-Flip Sources', 'The network\'s own corrupted copies, put down to the transmitter that sent them.')}
        ${link('health', '🚦', 'Station Health', 'Corrupted copies, transmitter frequency drift and the Airtime panel, station by station.')}
        ${link('packets', '📦', 'ALERT Packets', 'Decode a frame bit by bit, check bits and all.')}
      </ul>
    </section>`;
  }

  // ── The page ───────────────────────────────────────────────────────────────

  function render() {
    if (!S.live) newLive();
    return `
    <div class="page bb-page" id="bb-page" style="--page-max:1180px">
      <div class="bb-hero">
        <h2 class="bb-title" id="bb-h"><span aria-hidden="true">🧪</span> Bit Bench</h2>
        <p class="bb-lede">Play with the bits a station sends, and with the faults that change them on the way — noise, echoes, a
          collision, a drifting crystal, a wire on the wrong pin. Every frame here is a real ALERT frame and every fault changes it the way
          the real one does, so a batch through it leaves the same marks you would find in a station's data. When a station's readings
          look wrong in a way that seems to have a pattern, this is where to work out what could have made it.</p>
        <nav class="bb-toc" aria-label="On this page">${SECS.map(([id, , t, pic]) =>
          `<button type="button" class="bb-toc-btn" onclick="BitBench.goTo('${id}')">${glyph(pic, 'gl bb-toc-gl')}${t}</button>`).join('')}</nav>
      </div>
      ${numHtml()}
      ${frameHtml()}
      ${siteHtml()}
      ${faultHtml()}
      ${mysteryHtml()}
      ${pairsHtml()}
      ${moreHtml()}
    </div>`;
  }

  // ── Repainting a part ──────────────────────────────────────────────────────
  // A part is redrawn in place; whatever had focus inside it gets it back by
  // id, so a keyboard user pressing a bit stays on that bit.
  function paint(id, html) {
    const el = document.getElementById(id);
    if (!el) return;
    const had = document.activeElement && el.contains(document.activeElement) ? document.activeElement.id : '';
    el.innerHTML = html;
    if (had) { const back = document.getElementById(had); if (back) back.focus({ preventScroll: true }); }
  }
  const repaintNum = () => paint('bb-num-body', numBody());
  function repaintLive() {
    paint('bb-live', liveHtml());
    const cv = document.getElementById('bb-cv');
    if (cv) cv.setAttribute('aria-label', liveName());
  }
  function repaintFault() {
    paint('bb-fault-body', faultBody());
    wireCanvases();
    drawAll(true);
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  function fit(cv) {
    if (!cv) return null;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return null;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  let palCache = null, palTheme = null;
  function pal() {
    const theme = document.documentElement.getAttribute('data-theme');
    if (palCache && palTheme === theme) return palCache;
    palTheme = theme;
    palCache = {
      text: tok('--text', '#16202a'), muted: tok('--muted', '#4f6478'), border: tok('--border', '#dde5ee'),
      panel: tok('--panel', '#ffffff'), subtle: tok('--subtle', '#f2f6fa'), accent: tok('--accent', '#0b5cab'),
      ok: tok('--ok', '#107c10'), warn: tok('--warn', '#9a6700'), bad: tok('--bad', '#c62828'),
      addr: tok('--rp-bit-addr', '#0b5cab'), val: tok('--rp-bit-val', '#107c10'), chk: tok('--rp-bit-chk', '#7c35a3'),
      frm: tok('--rp-bit-frm', '#7a8794'), wave: tok('--rp-wave', '#0088b8'), echo: tok('--rp-echo', '#d26a00'),
      sum: tok('--rp-sum', '#7c35a3'),
    };
    return palCache;
  }
  const FONT = '11px system-ui, -apple-system, Segoe UI, sans-serif';
  const FONT_B = '600 11px system-ui, -apple-system, Segoe UI, sans-serif';
  const MONO = '600 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

  function text(ctx, s, x, y, color, opt) {
    const o = opt || {};
    ctx.font = o.font || FONT;
    ctx.fillStyle = color;
    ctx.textAlign = o.align || 'left';
    ctx.textBaseline = o.base || 'alphabetic';
    ctx.fillText(s, x, y);
  }
  // Text wrapped to a width, a line at a time from y down; returns the y
  // under the last line.
  function wrapText(ctx, s, x, y, maxW, color, opt) {
    const o = opt || {};
    ctx.font = o.font || FONT;
    const words = String(s).split(' ');
    let cur = '';
    const lines = [];
    for (const wd of words) {
      const t = cur ? cur + ' ' + wd : wd;
      if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = wd; } else cur = t;
    }
    if (cur) lines.push(cur);
    const lh = o.lh || 14;
    lines.forEach((ln, i) => text(ctx, ln, x, y + i * lh, color, o));
    return y + lines.length * lh;
  }
  // A caption along the foot of a drawing, wrapped upwards from its last line.
  function caption(ctx, s, box, color, x0) {
    const x = x0 == null ? box.x : x0;
    const maxW = box.x + box.w - x;
    ctx.font = FONT;
    const words = String(s).split(' ');
    const lines = [];
    let cur = '';
    for (const wd of words) {
      const t = cur ? cur + ' ' + wd : wd;
      if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = wd; } else cur = t;
    }
    if (cur) lines.push(cur);
    lines.forEach((ln, i) => text(ctx, ln, x, box.y + box.h - 2 - (lines.length - 1 - i) * 13, color));
  }
  function line(ctx, x1, y1, x2, y2, color, width, dash) {
    ctx.beginPath();
    ctx.setLineDash(dash || []);
    ctx.strokeStyle = color;
    ctx.lineWidth = width || 1;
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  let ctx2 = null;
  function alpha(color, a) {
    if (!ctx2) ctx2 = document.createElement('canvas').getContext('2d');
    ctx2.fillStyle = color;
    const c = ctx2.fillStyle;      // the browser's own normalised form, #rrggbb
    if (/^#[0-9a-f]{6}$/i.test(c)) {
      const n = parseInt(c.slice(1), 16);
      return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
    }
    return c;
  }
  const kindColor = (C, c) => C[KIND[c.kind]];
  // Repeatable noise: the same sample index is the same noise every frame, so
  // a waveform scrolling past does not seethe.
  function hn(i) { const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); }
  const hg0 = i => (hn(i) + hn(i + 0.37) + hn(i + 0.71) - 1.5) * 2;
  // …smoothed between points six samples apart, as noise through a receiver's
  // filters looks.
  function hg(i) {
    const k = Math.floor(i / 6), f = i / 6 - k;
    return hg0(k) * (1 - f) + hg0(k + 1) * f;
  }

  // The time on the bench. A frame takes LEAD on screen before its first bit,
  // BIT a bit, and HOLD after its last, its verdict shown; then the next.
  const LEAD = 600, BIT = 55, HOLD = 1400;
  const CYCLE = LEAD + 40 * BIT + HOLD;
  const moving = () => S.playing && !stillPreferred();
  function phase(now) {
    if (!S.playOnce && !moving()) return { j: 40, tMs: 40 * BM().bitMs(), done: true };
    const tt = now - S.liveAt;
    const j = tt < LEAD ? -1 : Math.min(40, Math.floor((tt - LEAD) / BIT));
    const tMs = Math.max(0, Math.min(40, (tt - LEAD) / BIT)) * BM().bitMs();
    return { j, tMs, tt, done: tt >= CYCLE };
  }

  // The rows under every drawing: the bits as sent, and as heard so far.
  function drawRows(ctx, w, h, C, l, jNow) {
    const x0 = 58, x1 = w - 8, cw = (x1 - x0) / 40, ch = Math.min(20, cw * 1.6);
    const ySent = h - 2 * ch - 14, yHeard = h - ch - 6;
    const L = BM().layout();
    const flips = new Set(l.j.flips);
    text(ctx, fam(l.id) === 'data' ? 'Meant' : 'Sent', 6, ySent + ch * 0.68, C.muted, { font: FONT_B });
    text(ctx, 'Heard', 6, yHeard + ch * 0.68, C.muted, { font: FONT_B });
    for (let j = 0; j < 40; j++) {
      const c = L[j], x = x0 + j * cw;
      const kc = kindColor(C, c);
      ctx.fillStyle = C.subtle;
      ctx.fillRect(x + 1, ySent, cw - 2, ch);
      ctx.fillStyle = kc;
      ctx.fillRect(x + 1, ySent + ch - 3, cw - 2, 3);
      if (cw >= 9) text(ctx, String(l.truth[j]), x + cw / 2, ySent + ch * 0.62, C.text, { font: MONO, align: 'center' });
      const shown = j <= jNow;
      const f = flips.has(j);
      ctx.fillStyle = shown && f ? C.bad : shown ? C.subtle : alpha(C.subtle, 0.4);
      ctx.fillRect(x + 1, yHeard, cw - 2, ch);
      if (shown && l.ch.rx && cw >= 9) text(ctx, String(l.ch.rx[j]), x + cw / 2, yHeard + ch * 0.62, f ? C.panel : C.text, { font: MONO, align: 'center' });
      if (j % 10 === 0 && j) line(ctx, x, ySent - 3, x, yHeard + ch + 3, C.border, 1);
    }
    if (jNow >= 0 && jNow < 40) {
      const x = x0 + (jNow + 0.5) * cw;
      ctx.fillStyle = C.accent;
      ctx.beginPath();
      ctx.moveTo(x - 5, ySent - 9); ctx.lineTo(x + 5, ySent - 9); ctx.lineTo(x, ySent - 2); ctx.closePath(); ctx.fill();
    }
    return { x0, x1, cw, top: ySent - 12 };
  }

  // A run of bits as AFSK: each bit a burst of its tone, the phase running on
  // across the boundaries as a real modulator's does. `amp(j)` scales a bit's
  // tone, `noise(i)` is added per pixel. Draws bits [j0, j0 + n) across
  // x0…x1 around ymid.
  function drawTones(ctx, bits, j0, n, x0, x1, ymid, A, color, opt) {
    const o = opt || {};
    const M = BM();
    const T = M.bitMs() / 1000;
    const pxPerBit = (x1 - x0) / n;
    // phase at the start of each bit
    const ph = [0];
    for (let j = 0; j < 40; j++) ph.push(ph[j] + 2 * Math.PI * (bits[j] ? M.MARK_HZ : M.SPACE_HZ) * T);
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = o.width || 1.4;
    ctx.setLineDash(o.dash || []);
    let started = false;
    for (let x = x0; x <= x1; x += 1) {
      const u = j0 + (x - x0) / pxPerBit;      // in bits
      const j = Math.floor(u);
      if (j < 0 || j >= 40) continue;
      const f = bits[j] ? M.MARK_HZ : M.SPACE_HZ;
      const y0 = Math.sin(ph[j] + 2 * Math.PI * f * (u - j) * T);
      const a = A * (o.amp ? o.amp(j) : 1);
      const y = ymid - a * y0 + (o.noise ? o.noise(Math.round(u * 400)) : 0);
      if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true; }
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // The window of bits a drawing shows: ten around the one being sent.
  function windowAt(jNow, n) {
    const j = Math.max(0, Math.min(40 - n, (jNow < 0 ? 0 : jNow) - Math.floor(n / 2)));
    return j;
  }

  function drawWave(now) {
    const cv = document.getElementById('bb-wave');
    const f = fit(cv);
    if (!f) return;
    const { ctx, w, h } = f, C = pal(), M = BM();
    const bits = M.air(S.addr, S.value);
    const L = M.layout();
    const still = stillPreferred() || !S.playing;
    const jNow = still ? 4 : Math.floor((now / 260) % 46) - 3;
    const n = Math.max(6, Math.min(12, Math.floor(w / 70)));
    const j0 = windowAt(jNow, n);
    const x0 = 10, x1 = w - 10, pb = (x1 - x0) / n;
    // the 40 bits as a strip, the window marked
    const sx0 = 10, scw = (w - 20) / 40;
    for (let j = 0; j < 40; j++) {
      ctx.fillStyle = j >= j0 && j < j0 + n ? kindColor(C, L[j]) : alpha(kindColor(C, L[j]), 0.35);
      ctx.fillRect(sx0 + j * scw + 0.5, 6, scw - 1, 8);
    }
    if (jNow >= 0 && jNow < 40) { ctx.fillStyle = C.text; ctx.fillRect(sx0 + jNow * scw + 0.5, 15, scw - 1, 2); }
    const ymid = h * 0.55, A = h * 0.22;
    for (let k = 0; k <= n; k++) line(ctx, x0 + k * pb, 24, x0 + k * pb, h - 6, C.border, 1, [2, 3]);
    drawTones(ctx, bits, j0, n, x0, x1, ymid, A, C.wave, { width: 1.6 });
    for (let k = 0; k < n; k++) {
      const j = j0 + k, c = L[j];
      const xm = x0 + (k + 0.5) * pb;
      ctx.fillStyle = j === jNow ? alpha(C.accent, 0.12) : 'transparent';
      ctx.fillRect(x0 + k * pb, 24, pb, h - 30);
      text(ctx, `${bits[j]}`, xm, 38, kindColor(C, c), { font: '700 13px system-ui, sans-serif', align: 'center' });
      text(ctx, cellLabel(c), xm, 50, C.muted, { font: FONT, align: 'center' });
      if (pb > 64) text(ctx, bits[j] ? `${num(M.MARK_HZ, 1)} Hz` : `${num(M.SPACE_HZ, 1)} Hz`, xm, h - 10, C.muted, { font: FONT, align: 'center' });
    }
  }

  // ── The site ───────────────────────────────────────────────────────────────
  // BitScene draws it; the bench says which fault, how long it has been on
  // screen, which way the site is turned and where the tour has got to.
  const siteMoving = () => !stillPreferred();
  const siteLive = () => onScreen.has('bb-site-cv') && (S.site.tour || siteMoving());
  function drawSite(now) {
    const cv = document.getElementById('bb-site-cv');
    if (!cv || typeof BitScene === 'undefined') return;
    const list = siteIds();
    const o = {
      id: S.site.id, name: UI[S.site.id].name, t: Math.max(0, now - S.site.at) / 1000, yaw: S.site.yaw, still: !siteMoving(),
      tour: { i: list.indexOf(S.site.id), n: list.length, on: S.site.tour, frac: (now - S.site.at) / TOUR_MS },
    };
    BitScene.draw(cv, o);
    BitScene.closeUp(document.getElementById('bb-site-zoom'), o);
  }

  // ── The fault drawings ─────────────────────────────────────────────────────

  function drawFault(now) {
    const cv = document.getElementById('bb-cv');
    const f = fit(cv);
    if (!f || !S.live) return;
    const { ctx, w, h } = f, C = pal();
    const l = S.live;
    const ph = phase(now);
    const rows = drawRows(ctx, w, h, C, l, ph.j);
    const band = rows.top - 16;
    const box = { x: 8, y: 6, w: w - 16, h: band - 10 };
    const D = DRAW[l.id] || DRAW.data;
    D(ctx, box, C, l, ph, now);
    // The band between the drawing and the rows: what is being sent, then
    // what the receiver made of it.
    line(ctx, 8, band - 2, w - 8, band - 2, C.border, 1);
    if (ph.j >= 40) {
      const v = verdict(l);
      const s = `${v.mark === '✅' ? '✓' : v.mark === '🛑' ? '■' : v.mark === '❌' ? '✗' : '!'} ${v.word}${v.more ? ' — ' + v.more : ''}`;
      text(ctx, s, 8, band + 11, l.j.status === 'clean' ? C.ok : l.j.status === 'rejected' || l.j.status === 'lost' ? C.warn : C.bad, { font: FONT_B });
    } else if (ph.j >= 0) {
      const c = BM().layout()[ph.j];
      text(ctx, `Sending bit ${ph.j + 1} of 40 — ${cellWords(c)}`, 8, band + 11, C.muted);
    } else {
      text(ctx, 'Keying up…', 8, band + 11, C.muted);
    }
  }

  // Noise on the tones: the clean tones faint, what the receiver hears over
  // them, and each bit as it is read.
  function drawNoisyTones(ctx, box, C, l, ph, sigma, opt) {
    const o = opt || {};
    const n = Math.max(6, Math.min(10, Math.floor(box.w / 80)));
    const j0 = windowAt(ph.j, n);
    const x0 = box.x, x1 = box.x + box.w, pb = box.w / n;
    const top = box.y + 40, bot = box.y + box.h - 18;
    const ymid = (top + bot) / 2, A = (bot - top) * 0.36;
    for (let k = 0; k <= n; k++) line(ctx, x0 + k * pb, top - 18, x0 + k * pb, bot, C.border, 1, [2, 3]);
    if (o.under) o.under(j0, n, x0, pb);
    drawTones(ctx, l.tx, j0, n, x0, x1, ymid, A, alpha(C.wave, 0.35), { dash: [3, 3], amp: o.amp });
    drawTones(ctx, l.tx, j0, n, x0, x1, ymid, A, C.wave, { amp: o.amp, noise: i => sigma(Math.floor(i / 400)) * A * hg(i + l.addr) });
    const flips = new Set(l.j.flips);
    for (let k = 0; k < n; k++) {
      const j = j0 + k, xm = x0 + (k + 0.5) * pb;
      if (j > ph.j) continue;
      const bad = flips.has(j);
      text(ctx, `${l.ch.rx ? l.ch.rx[j] : '·'}`, xm, top - 4, bad ? C.bad : C.text, { font: '700 13px system-ui, sans-serif', align: 'center' });
      if (bad) { ctx.strokeStyle = C.bad; ctx.lineWidth = 2; ctx.strokeRect(x0 + k * pb + 2, top - 18, pb - 4, bot - top + 18); }
    }
    text(ctx, 'read as', x0, top - 24, C.muted);
  }

  const DRAW = {
    noise(ctx, box, C, l, ph) {
      const s = 1 / Math.sqrt(2 * Math.pow(10, l.p.snr / 10));
      drawNoisyTones(ctx, box, C, l, ph, () => Math.min(1.2, s));
      caption(ctx, `${num(l.p.snr, 1)} dB over the noise — a bit misread ${oneIn(BM().ber(l.p.snr))}. Faint: the tones as sent.`, box, C.muted);
    },

    impulse(ctx, box, C, l, ph) {
      const T = BM().bitMs();
      const hits = (l.ch.trace && l.ch.trace.hits) || [];
      const inHit = j => hits.some(([s, f]) => s < (j + 1) * T && f > j * T);
      const s = 1 / Math.sqrt(2 * Math.pow(10, l.p.snr / 10));
      drawNoisyTones(ctx, box, C, l, ph, j => (inHit(j) ? 1.6 : Math.min(1.2, s)), {
        under(j0, n, x0, pb) {
          for (const [a, b] of hits) {
            const xa = x0 + (a / T - j0) * pb, xb = x0 + (b / T - j0) * pb;
            if (xb < x0 || xa > x0 + n * pb) continue;
            ctx.fillStyle = alpha(C.warn, 0.18);
            ctx.fillRect(Math.max(x0, xa), box.y + 22, Math.min(x0 + n * pb, xb) - Math.max(x0, xa), box.h - 40);
          }
        },
      });
      const meet = 1 - Math.exp(-l.p.rate * (40 * T + l.p.width) / 1000);
      caption(ctx, `${hits.length ? `${hits.length} burst${hits.length === 1 ? '' : 's'} in this frame, ${num(l.p.width, 1)} ms each — shaded` : 'No burst in this frame'}; `
        + `at this rate about ${pct(l.p.regular ? Math.min(1, l.p.rate * (40 * T + l.p.width) / 1000) : meet)} of frames meet one.`, box, C.muted);
    },

    multipath(ctx, box, C, l, ph) {
      const tr = l.ch.trace || {};
      const size = Math.min(box.h - 10, box.w * 0.34);
      const cx = box.x + size * 0.22, cy = box.y + size / 2 + 8, r = size * 0.36;
      const phi = (tr.phi0 || 0) + 2 * Math.PI * l.p.rate * (ph.tMs / 1000);
      const ex = cx + r + l.p.echo * r * Math.cos(phi), ey = cy - l.p.echo * r * Math.sin(phi);
      const amp = BM().fadeAmp(l.p.echo, phi);
      ctx.beginPath(); ctx.strokeStyle = C.border; ctx.setLineDash([2, 3]);
      ctx.arc(cx + r, cy, l.p.echo * r, 0, 2 * Math.PI); ctx.stroke(); ctx.setLineDash([]);
      const arrow = (x1, y1, x2, y2, color, wdt) => {
        line(ctx, x1, y1, x2, y2, color, wdt);
        const a = Math.atan2(y2 - y1, x2 - x1);
        ctx.beginPath(); ctx.fillStyle = color;
        ctx.moveTo(x2, y2); ctx.lineTo(x2 - 8 * Math.cos(a - 0.4), y2 - 8 * Math.sin(a - 0.4)); ctx.lineTo(x2 - 8 * Math.cos(a + 0.4), y2 - 8 * Math.sin(a + 0.4));
        ctx.closePath(); ctx.fill();
      };
      arrow(cx, cy, cx + r, cy, C.wave, 2);
      if (l.p.echo > 0.02) arrow(cx + r, cy, ex, ey, C.echo, 2);
      arrow(cx, cy, ex, ey, amp < 0.4 ? C.bad : amp < 0.8 ? C.warn : C.sum, 2.5);
      text(ctx, 'direct', cx + r / 2, cy + 14, C.wave, { align: 'center' });
      text(ctx, 'echo', ex, ey - 8, C.echo, { align: 'center' });
      text(ctx, `sum ${sgn(20 * Math.log10(Math.max(amp, 1e-4)), 1)} dB`, box.x, box.y + 12, C.text, { font: FONT_B });
      // the signal across the frame
      const px = box.x + size + 16, pw = box.x + box.w - px, py = box.y + 18, phh = box.h - 34;
      const snr = tr.snr || [];
      const lo = -10, hi = Math.max(20, l.p.snr + 8);
      const Y = v => py + phh - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * phh;
      ctx.fillStyle = alpha(C.bad, 0.08);
      ctx.fillRect(px, Y(9), pw, py + phh - Y(9));
      line(ctx, px, Y(9), px + pw, Y(9), C.bad, 1, [4, 3]);
      text(ctx, 'below about 9 dB, bits start to go', px + 4, Y(9) + 12, C.bad);
      ctx.beginPath(); ctx.strokeStyle = C.sum; ctx.lineWidth = 2;
      snr.forEach((v, j) => { const x = px + (j + 0.5) / 40 * pw; if (j) ctx.lineTo(x, Y(v)); else ctx.moveTo(x, Y(v)); });
      ctx.stroke();
      if (ph.j >= 0 && ph.j < 40) line(ctx, px + (ph.j + 0.5) / 40 * pw, py, px + (ph.j + 0.5) / 40 * pw, py + phh, C.accent, 1);
      text(ctx, 'signal over the noise across the frame (dB)', px, box.y + 12, C.muted);
      text(ctx, `${num(hi)}`, px - 3, py + 8, C.muted, { align: 'right' });
      text(ctx, `${num(lo)}`, px - 3, py + phh, C.muted, { align: 'right' });
      if (!l.p.rate) text(ctx, 'nothing moving: the same strength for good', px + 4, py + 12, C.muted);
    },

    collision(ctx, box, C, l, ph) {
      const P = PropPhysics, M = BM(), T = P.BIT_MS;
      const tr = l.ch.trace || { start: l.p.start, other: [] };
      const start = tr.start;
      const t0 = Math.min(-P.LEAD_MS, start) - 20, t1 = Math.max(P.KEYING_MS - P.LEAD_MS, start + P.KEYING_MS) + 20;
      const X = t => box.x + 70 + (t - t0) / (t1 - t0) * (box.w - 74);
      const lane = (y, s, bits, label, color) => {
        text(ctx, label, box.x, y + 13, color, { font: FONT_B });
        ctx.fillStyle = alpha(color, 0.15);
        ctx.fillRect(X(s), y, X(s + P.LEAD_MS) - X(s), 18);
        text(ctx, 'lead-in', (X(s) + X(s + P.LEAD_MS)) / 2, y + 13, C.muted, { align: 'center' });
        const L = M.layout();
        for (let j = 0; j < 40; j++) {
          const a = X(s + P.LEAD_MS + j * T), b = X(s + P.LEAD_MS + (j + 1) * T);
          ctx.fillStyle = bits ? alpha(kindColor(C, L[j]), bits[j] ? 0.9 : 0.45) : color;
          ctx.fillRect(a, y, Math.max(0.6, b - a - 0.4), 18);
        }
        ctx.fillStyle = alpha(color, 0.1);
        ctx.fillRect(X(s + P.LEAD_MS + 40 * T), y, X(s + P.KEYING_MS) - X(s + P.LEAD_MS + 40 * T), 18);
      };
      const yA = box.y + 22, yB = box.y + 58;
      lane(yA, -P.LEAD_MS, l.tx, 'Ours', C.wave);
      lane(yB, start, tr.other.length ? tr.other : null, l.p.copy ? 'Relay B' : 'Theirs', C.echo);
      const oa = Math.max(0, start), ob = Math.min(40 * T, start + P.KEYING_MS);
      if (ob > oa) {
        ctx.fillStyle = alpha(C.bad, 0.12);
        ctx.fillRect(X(oa), yA - 6, X(ob) - X(oa), yB + 24 - yA + 6);
        text(ctx, 'on the air together', (X(oa) + X(ob)) / 2, yB + 36, C.bad, { align: 'center' });
      }
      line(ctx, X(0), box.y + 14, X(0), yB + 22, C.muted, 1, [2, 2]);
      text(ctx, 'our first bit', X(0) + 3, box.y + 12, C.muted);
      if (ph.j >= 0 && ph.j < 40) line(ctx, X((ph.j + 0.5) * T), yA - 4, X((ph.j + 0.5) * T), yA + 22, C.accent, 2);
      // Bit by bit, during our frame: our bit, and whatever theirs is at the
      // same instant — where the two differ is where the flips fall.
      const yC = yB + 52, cwB = (box.w - 74) / 40;
      const xc = j => box.x + 70 + j * cwB;
      const theirs = j => {
        const u = (j + 0.5) * T - start;
        if (u < 0 || u >= P.KEYING_MS) return null;
        if (u < P.LEAD_MS) return M.PREAMBLE[Math.floor(u / T) % 10];
        const k = Math.floor((u - P.LEAD_MS) / T);
        return k < 40 ? (tr.other[k] ?? 1) : 1;
      };
      text(ctx, 'Ours', box.x, yC + 11, C.wave, { font: FONT_B });
      text(ctx, 'Theirs', box.x, yC + 29, C.echo, { font: FONT_B });
      const flips = new Set(l.j.flips);
      for (let j = 0; j < 40; j++) {
        const o = theirs(j), ours = l.tx[j];
        const differ = o != null && o !== ours;
        ctx.fillStyle = differ ? alpha(C.bad, 0.16) : 'transparent';
        ctx.fillRect(xc(j), yC - 2, cwB, 38);
        if (cwB >= 8) {
          text(ctx, String(ours), xc(j) + cwB / 2, yC + 11, j <= ph.j && flips.has(j) ? C.bad : C.text, { font: MONO, align: 'center' });
          text(ctx, o == null ? '·' : String(o), xc(j) + cwB / 2, yC + 29, C.muted, { font: MONO, align: 'center' });
        }
      }
      text(ctx, 'shaded: the two differ', box.x + box.w, yC + 46, C.bad, { align: 'right' });
      const cap = P.CAPTURE_DB;
      const rule = l.p.sir >= cap ? `Ours is ${num(l.p.sir, 1)} dB ahead: FM's capture effect hears ours cleanly.`
        : l.p.sir <= -cap ? `Theirs is ${num(-l.p.sir, 1)} dB ahead: the receiver locks on to theirs.`
        : `Within ${cap} dB of each other: where the two differ, bits flip.`;
      caption(ctx, rule, box, C.text);
    },

    intermod(ctx, box, C, l, ph, now) {
      const M = BM(), tr = l.ch.trace || {};
      const prods = M.imProducts(l.p.f1, l.p.f2);
      const fs = [l.p.f1, l.p.f2, M.fMhz(), ...prods.map(x => x.mhz)];
      let lo = Math.min(...fs), hi = Math.max(...fs);
      const pad = Math.max(0.1, (hi - lo) * 0.12);
      lo -= pad; hi += pad;
      const ax = box.y + box.h * 0.46;
      const X = f => box.x + 6 + (f - lo) / (hi - lo) * (box.w - 12);
      line(ctx, box.x, ax, box.x + box.w, ax, C.border, 1);
      const on = !!tr.on;
      const pulse = on ? 0.6 + 0.4 * Math.sin(now / 140) : 1;
      const bar = (f, hgt, color, label, sub) => {
        line(ctx, X(f), ax, X(f), ax - hgt, color, 4);
        text(ctx, label, X(f), ax - hgt - 14, color, { font: FONT_B, align: 'center' });
        text(ctx, sub, X(f), ax - hgt - 3, C.muted, { align: 'center' });
      };
      bar(l.p.f1, box.h * 0.26, C.accent, 'f₁', `${num(l.p.f1, 4)}`);
      bar(l.p.f2, box.h * 0.26, C.accent, 'f₂', `${num(l.p.f2, 4)}`);
      prods.forEach(x => bar(x.mhz, box.h * 0.13 * pulse, on && Math.abs(x.offsetHz) <= M.IF_HALF_HZ ? C.bad : C.echo, x.key === '2f1-f2' ? '2f₁−f₂' : '2f₂−f₁', `${num(x.mhz, 4)}`));
      line(ctx, X(M.fMhz()), ax + 4, X(M.fMhz()), ax - box.h * 0.36, C.ok, 1.5, [3, 2]);
      text(ctx, 'our channel', X(M.fMhz()), ax + 15, C.ok, { font: FONT_B, align: 'center' });
      text(ctx, 'MHz', box.x + box.w, ax + 15, C.muted, { align: 'right' });
      // the zoom: ±6 kHz round our channel
      const zy = box.y + box.h * 0.66, zh = box.h * 0.22;
      const span = M.IF_HALF_HZ + 2500;
      const Z = d => box.x + box.w / 2 + d / span * (box.w / 2 - 8);
      ctx.fillStyle = alpha(C.ok, 0.1);
      ctx.fillRect(Z(-M.IF_HALF_HZ), zy, Z(M.IF_HALF_HZ) - Z(-M.IF_HALF_HZ), zh);
      ctx.fillStyle = alpha(C.wave, 0.25);
      ctx.fillRect(Z(-M.DEV_HZ), zy + zh * 0.3, Z(M.DEV_HZ) - Z(-M.DEV_HZ), zh * 0.4);
      text(ctx, `receiver's filter, ±${num(M.IF_HALF_HZ / 1000)} kHz`, Z(-M.IF_HALF_HZ) + 3, zy - 3, C.ok);
      text(ctx, 'our signal', Z(0), zy + zh * 0.62, C.wave, { align: 'center' });
      const near = M.nearestProduct(l.p.f1, l.p.f2);
      if (Math.abs(near.offsetHz) <= span) {
        const inside = Math.abs(near.offsetHz) <= M.IF_HALF_HZ;
        line(ctx, Z(near.offsetHz), zy - 2, Z(near.offsetHz), zy + zh + 2, inside ? (on ? C.bad : C.warn) : C.muted, 3);
        text(ctx, `product ${hz(near.offsetHz)}`, Z(near.offsetHz), zy + zh + 14, inside ? C.bad : C.muted, { align: 'center' });
      } else {
        text(ctx, `nearest product ${hz(near.offsetHz)} away — outside`, Z(0), zy + zh + 14, C.muted, { align: 'center' });
      }
      text(ctx, on ? 'Both transmitters on the air: the product is in our channel for this frame.'
        : tr.inBand ? `Not both on the air for this frame (they are together ${pct(l.p.duty)} of the time).` : 'The products land outside our filter.',
        box.x, box.y + 12, on ? C.bad : C.muted, { font: FONT_B });
    },

    crystal(ctx, box, C, l, ph, now) {
      const M = BM(), p = l.p;
      const cw = box.w * 0.52;
      const px = box.x + 58, pw = cw - 64, py = box.y + 20, phh = box.h - 40;
      const edge = p.wide ? M.WIDE_HALF_HZ - 2 * M.DEV_HZ : M.IF_HALF_HZ - M.DEV_HZ;
      const offs = Array.from({ length: 97 }, (_, i) => M.crystalHz(p, i / 4));
      const lim = Math.max(edge * 1.6, ...offs.map(Math.abs)) * 1.05;
      const Y = v => py + phh / 2 - v / lim * (phh / 2);
      ctx.fillStyle = alpha(C.bad, 0.08);
      ctx.fillRect(px, py, pw, Y(edge) - py);
      ctx.fillRect(px, Y(-edge), pw, py + phh - Y(-edge));
      line(ctx, px, Y(edge), px + pw, Y(edge), C.bad, 1, [4, 3]);
      line(ctx, px, Y(-edge), px + pw, Y(-edge), C.bad, 1, [4, 3]);
      line(ctx, px, Y(0), px + pw, Y(0), C.border, 1);
      ctx.beginPath(); ctx.strokeStyle = C.accent; ctx.lineWidth = 2;
      offs.forEach((v, i) => { const x = px + i / 96 * pw; if (i) ctx.lineTo(x, Y(v)); else ctx.moveTo(x, Y(v)); });
      ctx.stroke();
      const hr = p.hour;
      line(ctx, px + hr / 24 * pw, py, px + hr / 24 * pw, py + phh, C.text, 1, [2, 2]);
      for (let hh = 0; hh <= 24; hh += 6) text(ctx, String(hh).padStart(2, '0'), px + hh / 24 * pw, py + phh + 12, C.muted, { align: 'center' });
      text(ctx, 'carrier offset through the day', px, box.y + 12, C.muted);
      text(ctx, `${hz(lim)}`, px - 3, py + 8, C.muted, { align: 'right' });
      text(ctx, 'past here it hurts', px + pw - 2, Y(edge) - 3, C.bad, { align: 'right' });
      // the channel at the chosen hour
      const qx = box.x + cw + 14, qw = box.x + box.w - qx;
      const half = p.wide ? M.WIDE_HALF_HZ : M.IF_HALF_HZ, dev = p.wide ? 2 * M.DEV_HZ : M.DEV_HZ;
      const span = half + dev + 1500;
      const Q = d => qx + qw / 2 + d / span * (qw / 2 - 4);
      const off = M.crystalHz(p, hr);
      const qy = box.y + box.h * 0.34, qh = box.h * 0.32;
      ctx.fillStyle = alpha(C.ok, 0.12);
      ctx.fillRect(Q(-half), qy, Q(half) - Q(-half), qh);
      line(ctx, Q(-half), qy, Q(-half), qy + qh, C.ok, 1.5);
      line(ctx, Q(half), qy, Q(half), qy + qh, C.ok, 1.5);
      text(ctx, 'receiver\'s filter', Q(0), qy - 4, C.ok, { align: 'center' });
      const a = Q(off - dev), b = Q(off + dev);
      ctx.fillStyle = alpha(C.wave, 0.3);
      ctx.fillRect(a, qy + qh * 0.3, b - a, qh * 0.4);
      for (const [s, e] of [[off - dev, -half], [half, off + dev]]) {
        if (e > s) { ctx.fillStyle = alpha(C.bad, 0.5); ctx.fillRect(Q(s), qy + qh * 0.3, Q(e) - Q(s), qh * 0.4); }
      }
      const swing = Math.sin(now / 90) * dev;
      ctx.fillStyle = C.wave;
      ctx.beginPath(); ctx.arc(Q(off + swing), qy + qh / 2, 4, 0, 2 * Math.PI); ctx.fill();
      line(ctx, Q(off), qy + qh, Q(off), qy + qh + 8, C.wave, 2);
      text(ctx, `carrier ${hz(off)}`, Q(off), qy + qh + 20, C.wave, { align: 'center' });
      const T = M.dayTemp(hr, p.tmin, p.tmax);
      text(ctx, `${String(hr).padStart(2, '0')}:00 · ${num(T, 1)} °C · ${sgn(off / M.hzPerPpm(), 1)} ppm`, qx, box.y + 12, C.text, { font: FONT_B });
      text(ctx, 'the tones swing the carrier this far', Q(0), qy + qh + 34, C.muted, { align: 'center' });
    },

    pll(ctx, box, C, l, ph) {
      const M = BM(), p = l.p, T = M.bitMs();
      const tEnd = p.lead + 40 * T + 10;
      const px = box.x + 58, pw = box.w - 64, py = box.y + 22, phh = box.h - 38;
      const X = t => px + t / tEnd * pw;
      const lim = Math.max(p.kick * 1000, M.IF_HALF_HZ + M.DEV_HZ) * 1.08;
      const Y = v => py + phh / 2 - v / lim * (phh / 2);
      const edge = M.IF_HALF_HZ - M.DEV_HZ, out = M.IF_HALF_HZ + M.DEV_HZ;
      ctx.fillStyle = alpha(C.muted, 0.1);
      ctx.fillRect(X(0), py, X(p.lead) - X(0), phh);
      if (X(p.lead) - X(0) > 70) text(ctx, 'lead-in: no data', (X(0) + X(p.lead)) / 2, py + phh - 16, C.muted, { align: 'center' });
      for (const v of [edge, -edge]) line(ctx, px, Y(v), px + pw, Y(v), C.warn, 1, [4, 3]);
      for (const v of [out, -out]) line(ctx, px, Y(v), px + pw, Y(v), C.bad, 1, [2, 2]);
      text(ctx, 'swing reaches the filter', px + pw - 2, Y(edge) - 3, C.warn, { align: 'right' });
      text(ctx, 'wholly outside', px + pw - 2, Y(out) - 3, C.bad, { align: 'right' });
      line(ctx, px, Y(0), px + pw, Y(0), C.border, 1);
      ctx.beginPath(); ctx.strokeStyle = C.accent; ctx.lineWidth = 2;
      for (let i = 0; i <= 200; i++) {
        const t = i / 200 * tEnd, y = Y(M.pllHz(t, p));
        if (i) ctx.lineTo(X(t), y); else ctx.moveTo(X(t), y);
      }
      ctx.stroke();
      const flips = new Set(l.j.flips);
      for (let j = 0; j < 40; j++) {
        const a = X(p.lead + j * T), b = X(p.lead + (j + 1) * T);
        ctx.fillStyle = j <= ph.j && flips.has(j) ? C.bad : alpha(kindColor(C, BM().layout()[j]), j <= ph.j ? 0.9 : 0.3);
        ctx.fillRect(a, py + phh - 10, Math.max(0.8, b - a - 0.5), 10);
      }
      if (ph.j >= 0 && ph.j < 40) line(ctx, X(p.lead + (ph.j + 0.5) * T), py, X(p.lead + (ph.j + 0.5) * T), py + phh, C.text, 1);
      text(ctx, 'key-up', X(0), py + phh + 12, C.muted, { align: 'center' });
      text(ctx, `first bit, ${num(p.lead)} ms`, X(p.lead), py + phh + 12, C.muted, { align: 'center' });
      text(ctx, `+${num(lim / 1000, 1)} kHz`, px - 4, py + 8, C.muted, { align: 'right' });
      text(ctx, `−${num(lim / 1000, 1)} kHz`, px - 4, py + phh, C.muted, { align: 'right' });
      text(ctx, 'The transmitter\'s frequency error after key-up; the frame\'s bits along the foot, red where flipped', box.x, box.y + 12, C.muted);
    },

    clock(ctx, box, C, l, ph) {
      const M = BM(), p = l.p, T = M.bitMs();
      const Ttx = T / (1 + p.err / 100);
      const smp = (l.ch.trace && l.ch.trace.samples) || [];
      // The word being sent — or, once the receiver has lost its place (a word
      // whose start it found in the wrong bit), the last word it found right.
      let found = 0;
      if (p.uart) { while (found < 4 && smp.length >= (found + 1) * 10 && Math.floor(smp[found * 10] / Ttx) === found * 10) found++; }
      else found = 4;
      const word = Math.max(0, Math.min(3, found - 1, Math.floor((ph.j < 0 ? 0 : ph.j) / 10)));
      const t0 = word * 10 * Ttx;
      const tA = t0 - 0.6 * T, tB = t0 + 10.8 * T;
      const X = t => box.x + 46 + (t - tA) / (tB - tA) * (box.w - 50);
      const yTx = box.y + 30, hTx = 28, yRx = yTx + hTx + 24;
      text(ctx, 'Sent', box.x, yTx + 18, C.muted, { font: FONT_B });
      text(ctx, 'Read', box.x, yRx + 14, C.muted, { font: FONT_B });
      const L = M.layout();
      for (let k = -1; k <= 11; k++) {
        const j = word * 10 + k;
        const a = X(j * Ttx), b = X((j + 1) * Ttx);
        if (b < X(tA) || a > X(tB)) continue;
        const bit = j < 0 || j >= 40 ? 1 : l.tx[j];
        ctx.fillStyle = j < 0 || j >= 40 ? alpha(C.muted, 0.15) : alpha(kindColor(C, L[j]), k >= 0 && k <= 9 ? 0.85 : 0.35);
        ctx.fillRect(a + 0.5, yTx, b - a - 1, hTx);
        if (b - a > 14) text(ctx, String(bit), (a + b) / 2, yTx + 18, C.panel, { font: '700 12px system-ui, sans-serif', align: 'center' });
        if (k >= 0 && k <= 9 && b - a > 18) text(ctx, cellLabel(L[j]), (a + b) / 2, yTx - 4, C.muted, { align: 'center' });
      }
      // the receiver's own bit grid from the start edge, and where it read
      const first = word * 10;
      const rd = smp.slice(first, first + 10);
      let worst = 0;
      rd.forEach((t, k) => {
        const intended = first + k;
        const got = Math.floor(t / Ttx);
        const ok = got === intended;
        const x = X(t);
        line(ctx, x, yTx + hTx + 2, x, yRx + 4, ok ? C.ok : C.bad, ok ? 1.5 : 2.5);
        ctx.fillStyle = ok ? C.ok : C.bad;
        ctx.beginPath(); ctx.moveTo(x, yTx + hTx + 1); ctx.lineTo(x - 4, yTx + hTx + 8); ctx.lineTo(x + 4, yTx + hTx + 8); ctx.closePath(); ctx.fill();
        text(ctx, String(l.ch.rx ? l.ch.rx[intended] : '·'), x, yRx + 16, ok ? C.text : C.bad, { font: '700 12px system-ui, sans-serif', align: 'center' });
        const into = (t / Ttx - intended);
        worst = Math.max(worst, Math.abs(into - 0.5));
      });
      // How far each reading lands from the middle of the bit it was meant
      // for: the error building up across the word.
      const gy = yRx + 30, gh = Math.max(24, box.y + box.h - 40 - gy);
      if (rd.length && gh >= 24) {
        const G = v => gy + gh / 2 - Math.max(-0.75, Math.min(0.75, v)) / 0.75 * (gh / 2);
        line(ctx, box.x + 46, G(0), box.x + box.w, G(0), C.border, 1);
        line(ctx, box.x + 46, G(0.5), box.x + box.w, G(0.5), C.bad, 1, [3, 3]);
        line(ctx, box.x + 46, G(-0.5), box.x + box.w, G(-0.5), C.bad, 1, [3, 3]);
        text(ctx, 'off the middle', box.x, G(0) + 4, C.muted);
        text(ctx, 'into the next bit', box.x + box.w, G(0.5) - 3, C.bad, { align: 'right' });
        rd.forEach((t, k) => {
          const off = t / Ttx - (first + k) - 0.5;
          const x = X(t);
          line(ctx, x, G(0), x, G(off), Math.abs(off) >= 0.5 ? C.bad : C.accent, 3);
        });
      }
      wrapText(ctx, `Word ${word + 1}. The sender's bits are ${p.err ? `${num(Math.abs(p.err), 2)}% ${p.err > 0 ? 'short (fast)' : 'long (slow)'}` : 'exact'}; `
        + `the receiver reads every ${num(T, 2)} ms from the start edge — a green arrow lands in the right bit, a red one in its neighbour.`,
        box.x, box.y + box.h - 16, box.w, C.text);
      text(ctx, rd.length ? `furthest from a bit's middle: ${num(worst * 100)}% of a bit${found < 4 ? ` — it lost its place after word ${found}` : ''}` : 'the receiver found no word at all',
        box.x + box.w, box.y + 12, worst >= 0.5 || found < 4 ? C.bad : C.muted, { align: 'right' });
    },

    twist(ctx, box, C, l, ph) {
      const tr = l.ch.trace || {};
      const bw = Math.min(150, box.w * 0.24);
      const bx = box.x, by = box.y + 18, bh = box.h - 40;
      const top = Math.max(tr.markDb || 0, tr.spaceDb || 0, 12) + 2;
      const Y = v => by + bh - Math.max(0, v) / top * bh;
      const col = (x, v, label, color) => {
        ctx.fillStyle = color;
        ctx.fillRect(x, Y(v), bw * 0.32, by + bh - Y(v));
        text(ctx, `${num(v, 1)} dB`, x + bw * 0.16, Y(v) - 4, color, { font: FONT_B, align: 'center' });
        text(ctx, label, x + bw * 0.16, by + bh + 12, C.muted, { align: 'center' });
      };
      col(bx + 8, tr.markDb || 0, '1 · mark', C.addr);
      col(bx + 8 + bw * 0.45, tr.spaceDb || 0, '0 · space', C.val);
      line(ctx, bx, Y(9), bx + bw, Y(9), C.bad, 1, [4, 3]);
      text(ctx, 'each tone over the noise', bx, box.y + 10, C.muted);
      const k = Math.pow(10, l.p.twist / 20);
      const am = Math.sqrt(2 / (1 + k * k)), as = am * k;
      const s = 1 / Math.sqrt(2 * Math.pow(10, l.p.snr / 10));
      drawNoisyTones(ctx, { x: box.x + bw + 16, y: box.y, w: box.w - bw - 16, h: box.h }, C, l, ph, () => Math.min(1, s) * 0.8,
        { amp: j => (l.tx[j] ? am : as) * 0.75 });
      caption(ctx, `The mark tone ${l.p.twist >= 0 ? 'weaker' : 'stronger'} by ${num(Math.abs(l.p.twist), 1)} dB: ${l.p.twist >= 0 ? '1s' : '0s'} go first.`, box, C.muted, box.x + bw + 16);
    },

    // The wiring faults: the field's bits at the sensor, the wires, and the
    // bits in the frame.
    data(ctx, box, C, l, ph, now) {
      const M = BM(), p = l.p, id = l.id;
      const f = fieldOf(p), w = f.width;
      const isA = p.field === 'address';
      const a = isA ? l.addr : l.value;
      const sent = l.ch.trace && l.ch.trace.sent;
      const b = sent ? (isA ? sent.addr : sent.value) : a;
      const x0 = box.x + 70, x1 = box.x + box.w - 6, cw = (x1 - x0) / w;
      const yT = box.y + 22, yB = box.y + box.h - 28, ch = 20;
      const X = i => x0 + (w - 1 - i + 0.5) * cw;    // most significant on the left
      text(ctx, 'Sensor', box.x, yT + 14, C.muted, { font: FONT_B });
      text(ctx, 'Frame', box.x, yB + 14, C.muted, { font: FONT_B });
      for (let i = 0; i < w; i++) {
        const ta = (a >> i) & 1, tb = (b >> i) & 1;
        ctx.fillStyle = alpha(isA ? C.addr : C.val, ta ? 0.85 : 0.25);
        ctx.fillRect(X(i) - cw / 2 + 1, yT, cw - 2, ch);
        text(ctx, String(ta), X(i), yT + 14, ta ? C.panel : C.text, { font: MONO, align: 'center' });
        ctx.fillStyle = tb !== ta ? C.bad : alpha(isA ? C.addr : C.val, tb ? 0.85 : 0.25);
        ctx.fillRect(X(i) - cw / 2 + 1, yB, cw - 2, ch);
        text(ctx, String(tb), X(i), yB + 14, tb || tb !== ta ? C.panel : C.text, { font: MONO, align: 'center' });
      }
      const wires = [];
      const tie = (i, v) => wires.push({ from: null, to: i, v });
      for (let i = 0; i < w; i++) {
        if (id === 'stuck' && i === p.bit) { tie(i, p.to); continue; }
        if (id === 'shift') {
          const src = p.left ? i - 1 : i + 1;
          if (src < 0 || src >= w) tie(i, 0); else wires.push({ from: src, to: i });
          continue;
        }
        if (id === 'reverse') { wires.push({ from: w - 1 - i, to: i }); continue; }
        if (id === 'gray') {
          if (p.way === 'gray') { wires.push({ from: i, to: i }); if (i + 1 < w) wires.push({ from: i + 1, to: i, xor: true }); }
          else { for (let k = i; k < w; k++) wires.push({ from: k, to: i, xor: k > i, faint: k > i + 1 }); }
          continue;
        }
        wires.push({ from: i, to: i, inv: id === 'invert' });
      }
      const yA = yT + ch, yZ = yB;
      const tFlow = (now / 1400) % 1;
      wires.forEach((wi, n) => {
        const xb = X(wi.to);
        if (wi.from == null) {
          line(ctx, xb, yZ - 18, xb, yZ, C.bad, 2);
          text(ctx, wi.v ? '+V' : '0 V', xb, yZ - 22, C.bad, { font: FONT_B, align: 'center' });
          if (id === 'stuck') {
            line(ctx, xb, yA, xb, yA + 12, C.muted, 1.5);
            text(ctx, '✕', xb, yA + 24, C.bad, { font: FONT_B, align: 'center' });
          }
          return;
        }
        const xa = X(wi.from);
        const color = wi.faint ? alpha(C.chk, 0.22) : wi.xor ? alpha(C.chk, 0.8) : alpha(C.muted, 0.9);
        line(ctx, xa, yA, xb, yZ, color, wi.xor ? 1 : 1.5);
        if (!stillPreferred() && S.playing) {
          const u = (tFlow + n * 0.037) % 1;
          ctx.fillStyle = (a >> wi.from) & 1 ? C.accent : C.border;
          ctx.beginPath(); ctx.arc(xa + (xb - xa) * u, yA + (yZ - yA) * u, 2.5, 0, 2 * Math.PI); ctx.fill();
        }
        if (wi.inv) {
          const ym = (yA + yZ) / 2;
          ctx.beginPath(); ctx.fillStyle = C.panel; ctx.strokeStyle = C.chk; ctx.lineWidth = 1.5;
          ctx.moveTo(xb - 5, ym - 6); ctx.lineTo(xb + 5, ym - 6); ctx.lineTo(xb, ym + 3); ctx.closePath(); ctx.fill(); ctx.stroke();
          ctx.beginPath(); ctx.arc(xb, ym + 6, 2.5, 0, 2 * Math.PI); ctx.stroke();
        }
      });
      if (id === 'gray') for (let i = 0; i < w - 1; i++) text(ctx, '⊕', X(i), yZ - 6, C.chk, { font: FONT_B, align: 'center' });
      if (id === 'shift') {
        const lostBit = p.left ? w - 1 : 0;
        text(ctx, '✕ lost', X(lostBit), yA + 14, C.bad, { font: FONT_B, align: 'center' });
      }
      text(ctx, `${isA ? 'Address' : 'Value'}: the sensor says ${num(a)}; the frame carries ${num(b)}${b === a ? ' — right, this time' : ` (${sgn(b - a)})`}.`, box.x, box.y + 12, b === a ? C.ok : C.bad, { font: FONT_B });
    },
  };

  function drawRiver() {
    const cv = document.getElementById('bb-river');
    const f = fit(cv);
    if (!f) return;
    const { ctx, w, h } = f, C = pal();
    const pts = riverPoints();
    const all = pts.flatMap(p => [p.a, p.b]);
    const lo = Math.min(...all), hi = Math.max(...all);
    const pad = Math.max(1, (hi - lo) * 0.08);
    const px = 46, pw = w - px - 8, py = 10, phh = h - 30;
    const X = t => px + t / 64 * pw;
    const Y = v => py + phh - (v - lo + pad) / (hi - lo + 2 * pad) * phh;
    line(ctx, px, py + phh, px + pw, py + phh, C.border, 1);
    text(ctx, num(hi), px - 4, Y(hi) + 4, C.muted, { align: 'right' });
    text(ctx, num(lo), px - 4, Y(lo) + 4, C.muted, { align: 'right' });
    const path = (key, color, width, dash) => {
      ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash || []);
      pts.forEach((p, i) => { if (i) ctx.lineTo(X(p.t), Y(p[key])); else ctx.moveTo(X(p.t), Y(p[key])); });
      ctx.stroke(); ctx.setLineDash([]);
    };
    path('a', C.ok, 2, [5, 3]);
    path('b', C.bad, 2);
    text(ctx, 'true', px + 6, Y(pts[0].a) - 6, C.ok, { font: FONT_B });
    text(ctx, 'reported', X(64) - 4, Y(pts[64].b) - 6, C.bad, { font: FONT_B, align: 'right' });
    text(ctx, 'steps, one reading each →', px + pw, py + phh + 16, C.muted, { align: 'right' });
  }

  // ── The loop ───────────────────────────────────────────────────────────────
  let loop = 0;
  let wired = null;
  let onScreen = new Set();

  function tick(now) {
    loop = 0;
    if (!document.getElementById('bb-page')) return;
    if (moving() && S.live && now - S.liveAt >= CYCLE) { newLive(); repaintLive(); }
    if (S.playOnce && now - S.liveAt >= CYCLE - HOLD + 300) S.playOnce = false;
    if (S.site.tour && now - S.site.at >= TOUR_MS) siteGo(1, now);
    if (onScreen.has('bb-wave')) drawWave(now);
    if (onScreen.has('bb-site-cv')) drawSite(now);
    if (onScreen.has('bb-cv')) drawFault(now);
    if (moving() || S.playOnce || siteLive()) loop = requestAnimationFrame(tick);
  }
  function kick() { if (!loop && document.getElementById('bb-page')) loop = requestAnimationFrame(tick); }
  function drawAll(fresh) {
    const now = performance.now();
    drawWave(now);
    drawSite(now);
    drawFault(now);
    drawRiver();
    if (fresh) kick();
  }

  function wireCanvases() {
    if (!wired) return;
    wired.io && wired.io.disconnect();
    wired.ro && wired.ro.disconnect();
    const list = ['bb-wave', 'bb-site-cv', 'bb-cv', 'bb-river'].map(id => document.getElementById(id)).filter(Boolean);
    onScreen = new Set(list.map(el => el.id));
    if (wired.io) list.forEach(el => wired.io.observe(el));
    if (wired.ro) list.forEach(el => wired.ro.observe(el));
  }

  function unwire() {
    if (loop) cancelAnimationFrame(loop);
    loop = 0;
    if (!wired) return;
    wired.io && wired.io.disconnect();
    wired.ro && wired.ro.disconnect();
    wired = null;
  }

  function init() {
    unwire();
    registerTabTeardown('BitBench', unwire);
    if (!document.getElementById('bb-page')) return;
    if (stillPreferred()) { S.playing = false; S.site.tour = false; }
    syncPlay();
    syncSite();
    S.site.at = performance.now();
    wireSite();
    const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(es => {
      for (const e of es) { if (e.isIntersecting) onScreen.add(e.target.id); else onScreen.delete(e.target.id); }
      kick();
    }) : null;
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { drawAll(false); }) : null;
    wired = { io, ro };
    wireCanvases();
    requestAnimationFrame(() => drawAll(true));
  }

  // ── Controls ───────────────────────────────────────────────────────────────

  function width(w) {
    if (![8, 11, 13, 16].includes(Number(w))) return;
    S.width = Number(w);
    S.num = BM().wrap(S.num, S.width);
    S.lastOp = ''; S.lastBit = -1;
    const box = document.getElementById('bb-num-in');
    if (box) box.value = String(S.num);
    repaintNum();
  }

  function setNum(raw) {
    const r = BM().parse(raw);
    const box = document.getElementById('bb-num-in');
    if (box) { if (r || !String(raw).trim()) box.removeAttribute('aria-invalid'); else box.setAttribute('aria-invalid', 'true'); }
    if (!r) return;
    const v = r.value < 0 ? BM().wrap(r.value, S.width) : r.value;
    // A number too big for the width widens it, up to 16 bits.
    if (v > BM().mask(S.width)) {
      const fitW = [8, 11, 13, 16].find(w => v <= BM().mask(w));
      if (fitW) { S.width = fitW; const radio = document.getElementById(`bb-w-${fitW}`); if (radio) radio.checked = true; }
    }
    S.num = BM().wrap(v, S.width);
    S.lastOp = ''; S.lastBit = -1;
    repaintNum();
  }

  function flipBit(i) {
    if (!(i >= 0 && i < S.width)) return;
    S.num = BM().flip(S.num, i) & BM().mask(S.width);
    S.lastBit = i; S.lastOp = '';
    const box = document.getElementById('bb-num-in');
    if (box) box.value = String(S.num);
    repaintNum();
  }

  function op(k) {
    const M = BM(), w = S.width, v = S.num;
    const out = { shl: () => M.shl(v, w), shr: () => M.shr(v), rotl: () => M.rotl(v, w), rotr: () => M.rotr(v, w),
      invert: () => M.invert(v, w), reverse: () => M.reverse(v, w), gray: () => M.toGray(v) & M.mask(w),
      ungray: () => M.fromGray(v) & M.mask(w), swap: () => (w === 16 ? M.swapBytes(v) : v), inc: () => M.wrap(v + 1, w) }[k];
    if (!out) return;
    if (k === 'swap' && w !== 16) return;
    S.num = out();
    S.lastOp = k; S.lastBit = -1;
    const box = document.getElementById('bb-num-in');
    if (box) box.value = String(S.num);
    repaintNum();
    announce(`${num(v)} becomes ${num(S.num)}.`);
  }

  function setFrame(which, raw) {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) return;
    if (which === 'addr') S.addr = Math.max(1, Math.min(8191, n));
    else if (which === 'value') S.value = Math.max(0, Math.min(2047, n));
    else return;
    paint('bb-frame-body', frameBody());
    newLive();
    repaintLive();
    const fx = document.getElementById('bb-fixed');
    if (fx && fx.nextElementSibling) fx.nextElementSibling.textContent = `Only the frame above (address ${S.addr}, value ${S.value}), rather than every station's`;
  }

  function randomFrame() {
    const idx = typeof state !== 'undefined' && state.data && typeof buildSensorIndex === 'function' ? buildSensorIndex() : null;
    const keys = idx ? [...idx.keys()].filter(a => a > 0 && a < 8192) : [];
    S.addr = keys.length ? keys[Math.floor(Math.random() * keys.length)] : 1 + Math.floor(Math.random() * 8191);
    S.value = Math.floor(Math.random() * 2048);
    const a = document.getElementById('bb-addr'), v = document.getElementById('bb-value');
    if (a) a.value = String(S.addr);
    if (v) v.value = String(S.value);
    setFrame('addr', S.addr);
  }

  // The site: turned by dragging it across (up and down still scrolls the
  // page), a fault at a time by the tour or by hand.
  function wireSite() {
    const cv = document.getElementById('bb-site-cv');
    if (!cv) return;
    let drag = null;
    cv.addEventListener('pointerdown', e => {
      drag = { x: e.clientX, yaw: S.site.yaw == null ? BitScene.YAW0 : S.site.yaw };
      try { cv.setPointerCapture(e.pointerId); } catch (_) { /* a synthetic pointer has nothing to capture */ }
      cv.classList.add('is-turning');
    });
    cv.addEventListener('pointermove', e => {
      if (!drag) return;
      S.site.yaw = BitScene.clampYaw(drag.yaw - (e.clientX - drag.x) / 260);
      drawSite(performance.now());
    });
    const end = () => { drag = null; cv.classList.remove('is-turning'); };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
  }

  function syncSite() {
    const b = document.getElementById('bb-site-tour');
    if (b) { b.setAttribute('aria-pressed', S.site.tour ? 'true' : 'false'); b.textContent = tourWords(); }
    const sel = document.getElementById('bb-site-pick');
    if (sel) sel.value = S.site.id;
    paint('bb-site-say', siteSayHtml());
    const cv = document.getElementById('bb-site-cv');
    if (cv) cv.setAttribute('aria-label', siteName());
    const zm = document.getElementById('bb-site-zoom');
    if (zm) zm.setAttribute('aria-label', zoomName());
  }

  function siteSet(id, now) {
    if (!UI[id]) return;
    S.site.id = id;
    S.site.at = now == null ? performance.now() : now;
    syncSite();
    drawSite(S.site.at);
    kick();
  }
  // On by `d` faults, round and round.
  function siteGo(d, now) {
    const list = siteIds();
    const i = list.indexOf(S.site.id);
    siteSet(list[(i + d + list.length) % list.length], now);
  }

  function siteTour() {
    S.site.tour = !S.site.tour;
    S.site.at = performance.now();
    syncSite();
    kick();
  }
  function siteStep(d) {
    siteGo(d < 0 ? -1 : 1);
    announce(`${UI[S.site.id].name}: ${spot(S.site.id).where}`);
  }
  function siteShow(id) {
    S.site.tour = false;
    siteSet(id);
  }
  function siteBench() { pick(S.site.id, true); }

  function pick(id, scroll, fromMystery) {
    if (!UI[id]) return;
    S.effect = id;
    // The site follows, and holds there: the fault on the bench is the one
    // somebody is looking at.
    if (S.site.id !== id || S.site.tour) { S.site.tour = false; siteSet(id); }
    if (fromMystery && S.mystery && S.mystery.id === id) S.params[id] = { ...S.mystery.params };
    const radio = document.getElementById(`bb-fx-${id}`);
    if (radio) radio.checked = true;
    newLive();
    repaintFault();
    if (scroll) goTo('bb-fault');
  }

  function set(key, raw, live) {
    const id = S.effect, d = BM().EFFECTS[id].params[key];
    if (!d) return;
    const p = params(id);
    const given = { ...p, [key]: raw };
    S.params[id] = BM().withDefaults(id, given);
    const out = document.getElementById(`bb-p-${id}-${key}-out`);
    const u = UI[id].params[key];
    if (out && u && u.fmt) out.textContent = u.fmt(S.params[id][key]);
    paint('bb-facts', factsHtml(id));
    if (key === 'field') {
      newLive();
      repaintFault();
      if (S.batch && S.batch.id === id) batch(true);
      return;
    }
    newLive();
    repaintLive();
    if (!live && S.batch && S.batch.id === id) batch(true);
    if (!S.playing || stillPreferred()) drawAll(false);
  }

  function sendOne() {
    newLive();
    repaintLive();
    if (!moving()) { S.playOnce = true; kick(); }
    const v = verdict(S.live);
    announce(`${v.word}${v.more ? ' — ' + v.more : ''}.`);
  }

  function syncPlay() {
    const b = document.getElementById('bb-play');
    if (!b) return;
    b.setAttribute('aria-pressed', S.playing ? 'true' : 'false');
    b.textContent = S.playing ? '⏸ Pause' : '▶ Keep sending';
  }

  function play() {
    S.playing = !S.playing;
    S.playOnce = false;
    if (S.playing) S.liveAt = performance.now();
    syncPlay();
    kick();
    drawAll(false);
  }

  function batch(quiet) {
    const id = S.effect;
    S.batch = BM().run(id, params(id), { n: S.n, seed: (S.seed % 100000) + 1, fixed: S.fixed, addr: S.addr, value: S.value,
      hours: id === 'crystal', rows: true });
    paint('bb-batch', batchHtml(S.batch, true));
    wireCanvases();
    drawRiver();
    if (!quiet) announce(`${num(S.batch.n)} frames sent: ${num(S.batch.counts.clean)} clean, ${num(S.batch.counts.rejected + S.batch.counts.lost)} lost or thrown out, ${num(S.batch.counts.ghost + S.batch.counts.wrong)} got through wrong.`);
  }

  function batchSize(n) {
    const v = Number(n);
    if ([100, 500, 2000].includes(v)) S.n = v;
  }
  function fixed(on) { S.fixed = !!on; }

  function mystery() {
    const all = ids();
    let id = all[Math.floor(Math.random() * all.length)];
    if (S.mystery && id === S.mystery.id && Math.random() < 0.7) id = all[(all.indexOf(id) + 1 + Math.floor(Math.random() * (all.length - 1))) % all.length];
    const presets = MYSTERY[id] || [{}];
    const p = BM().withDefaults(id, presets[Math.floor(Math.random() * presets.length)]);
    const st = BM().run(id, p, { n: 600, seed: 1 + Math.floor(Math.random() * 1e6), hours: id === 'crystal' });
    S.mystery = { id, params: p, st, guess: '' };
    paint('bb-mystery-body', mysteryBody());
    const sel = document.getElementById('bb-guess');
    if (sel) sel.focus();
  }

  function guess(id) {
    const m = S.mystery;
    if (!m || m.guess || !UI[id]) return;
    m.guess = id;
    S.score.tried++;
    if (id === m.id) S.score.right++;
    paint('bb-mystery-body', mysteryBody());
  }

  let pairsTimer = 0;
  function pairs(text) {
    S.pairsText = String(text || '').slice(0, 200000);
    clearTimeout(pairsTimer);
    pairsTimer = setTimeout(() => paint('bb-pairs-body', pairsBody()), 250);
  }
  function pairsField(f) {
    if (!['value', 'address', '8', '16'].includes(String(f))) return;
    S.pairsField = String(f);
    paint('bb-pairs-body', pairsBody());
  }
  function pairsExample(kind) {
    const M = BM();
    const rand = PropPhysics.rng(Date.now() % 100000 + 7);
    const lines = [];
    let field = 'value';
    for (let i = 0; i < 14; i++) {
      const v = 200 + Math.floor(rand() * 1600);
      let b = v;
      if (kind === 'flips') b = M.flip(v, Math.floor(rand() * 11));
      else if (kind === 'stuck') b = v | 64;
      else if (kind === 'double') b = M.shl(v, 11);
      else if (kind === 'gray') b = M.toGray(v);
      else if (kind === 'lowaddr') {
        field = 'address';
        const a = 1000 + Math.floor(rand() * 6000);
        lines.push(`${a} ${M.flip(a, Math.floor(rand() * 6))}`);
        continue;
      }
      lines.push(`${v} ${b}`);
    }
    S.pairsText = lines.join('\n');
    S.pairsField = field;
    const ta = document.getElementById('bb-pairs-text');
    if (ta) ta.value = S.pairsText;
    const sel = document.getElementById('bb-pairs-field');
    if (sel) sel.value = field;
    paint('bb-pairs-body', pairsBody());
  }

  function keepOpen(open) { S.liveOpen = !!open; }

  // ── Files ──────────────────────────────────────────────────────────────────

  function exportCsv(which) {
    const c = v => csvEscape(v == null ? '' : String(v));
    if (which === 'batch') {
      const st = S.batch;
      if (!st || !st.rows) return;
      const keys = Object.keys(st.params);
      const head = ['frame', 'address', 'value', ...(st.byHour ? ['hour'] : []), 'outcome', 'why', 'arrived_address', 'arrived_value', 'bits_flipped'];
      const rows = st.rows.map((r, i) => [i + 1, r.addr, r.value, ...(st.byHour ? [r.hour.toFixed(2)] : []), r.status, r.why || '',
        r.raddr == null ? '' : r.raddr, r.rvalue == null ? '' : r.rvalue, r.flips.map(j => j + 1).join(' ')].map(c).join(','));
      const meta = `# Flood-Net Bit Bench — ${UI[st.id].name}: ${keys.map(k => `${k}=${st.params[k]}`).join('; ')} — a model, not a recording\n`;
      dlText(`bit-bench-${st.id}-${st.n}.csv`, meta + head.join(',') + '\n' + rows.join('\n') + '\n');
    } else if (which === 'pairs') {
      const { pairs: list } = parsePairs(S.pairsText);
      if (!list.length) return;
      const an = BM().analysePairs(list, BM().FIELDS[S.pairsField] ? S.pairsField : Number(S.pairsField));
      const head = ['line', 'should_be', 'arrived', 'out_by', 'bits_differing', 'went_1_to_0', 'went_0_to_1', 'pattern'];
      const rows = an.diffs.map((d, i) => [list[i].line, d.a, d.b, d.delta, d.flips.join(' '), d.cleared.join(' '), d.set.join(' '),
        d.kinds.filter(k => k !== 'same').join(' ')].map(c).join(','));
      dlText(`bit-bench-readings.csv`, head.join(',') + '\n' + rows.join('\n') + '\n');
    }
  }

  // ── Getting about ──────────────────────────────────────────────────────────

  function goTo(id) {
    const sec = document.getElementById(id);
    if (!sec) return;
    const h = sec.querySelector('h3');
    sec.scrollIntoView({ behavior: stillPreferred() ? 'auto' : 'smooth', block: 'start' });
    if (h) h.focus({ preventScroll: true });
  }

  // Open the bench on a fault — from the lesson, a link, or anything else
  // that wants to show one.
  function open(id) {
    if (UI[id]) S.effect = id;
    if (typeof switchTab === 'function') switchTab('bitbench');
    if (UI[id]) goTo('bb-fault');
  }

  function learn(id) {
    if (typeof BitErrors !== 'undefined' && BitErrors.open) BitErrors.open(id);
    else if (typeof switchTab === 'function') switchTab('biterrors');
  }

  function tab(t, sec) {
    if (t === 'bitflipper' && typeof openBitFlipper === 'function') { openBitFlipper(S.num & 8191 || 1, { bits: '1' }); return; }
    if (typeof switchTab === 'function') switchTab(t);
    if (sec && t === 'propagation' && typeof Propagation !== 'undefined' && Propagation.go) Propagation.go(sec);
  }

  return {
    render, init, open, width, setNum, flipBit, op, setFrame, randomFrame, siteTour, siteStep, siteShow, siteBench,
    pick, set, sendOne, play, batch, batchSize, fixed,
    mystery, guess, pairs, pairsField, pairsExample, exportCsv, goTo, learn, tab, keepOpen,
    // The drawing kit, for the ⚡ Bit Errors lesson's figures: the same
    // canvases, colours and type as the bench's.
    ink: { fit, pal, text, line, alpha, caption, wrapText, FONT, FONT_B, MONO },
    state: () => ({ effect: S.effect, params: { ...params(S.effect) }, num: S.num, width: S.width, addr: S.addr, value: S.value,
      site: { id: S.site.id, tour: S.site.tour, yaw: S.site.yaw },
      live: S.live ? { status: S.live.j.status, flips: S.live.j.flips.slice() } : null,
      batch: S.batch ? { id: S.batch.id, n: S.batch.n, counts: { ...S.batch.counts } } : null,
      pairs: parsePairs(S.pairsText).pairs.length,
      mystery: S.mystery ? { guessed: !!S.mystery.guess } : null }),
  };
})();
