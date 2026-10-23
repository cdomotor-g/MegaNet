// MegaNet — swr-model.js
//
//   SwrModel   the arithmetic behind the 📟 SWR Meter tab: what a through-line
//              power and SWR meter reads, where in the antenna line it reads
//              it, and what a set of readings says about the station. Pure —
//              no DOM — so test/swr.mjs runs every figure in Node.
//
// ── What is exact, and what is a model ──────────────────────────────────────
// Exact: watts and decibels, SWR, the reflection coefficient Γ, return loss,
// mismatch loss and the share of the power that comes back — each is a line of
// textbook algebra — and a lossy feeder taking its loss off the forward wave
// once and off the reflected wave twice, which is why a meter at the radio end
// of a long feeder reads a better SWR than the antenna has.
//
// Published figures, quoted rather than derived: the feeders' loss at 150 MHz
// (Times Microwave's tables, as collected by Raveon; the heliax from Andrew's
// LDF4-50A sheet), and the meters' bands, ranges and limits from their makers'
// manuals and listings (the sources are named on each METERS entry).
//
// A model, to show the shape and not to predict a station: how many messages
// a fade margin loses. It is the Bit Bench's receiver (BitModel.ber, a
// non-coherent FSK bit error rate) over a 40-bit frame, placed so that a
// margin of 0 dB loses half the messages — the point a fade-margin test stops
// at — and smeared by a couple of decibels of real-world flutter, the same
// σ the Radio Propagation bench's "flutter" uses. ALERT2's frames, coding and
// receiver differ; what carries over is the cliff: a decibel costs nothing at
// ten decibels of margin and a great deal at two.
//
// The situations (SCENARIOS) are made-up stations, each built to show one
// fault the way a meter sees it. Their numbers are plausible, not measured.
//
// After nothing; read by swr-meter.js at call time. Nothing runs at load.
//
// Exposes: F_MHZ, SWR_BANDS, MARGIN_GOOD, MARGIN_FLOOR, FLUTTER_DB, CABLES,
//          METERS, SCENARIOS, wToDbm, dbmToW, db, gammaFromSwr, swrFromGamma,
//          gammaFromPowers, returnLossDb, mismatchLossDb, swrBand, cableLossDb,
//          line, interpret, frameLoss, missed, marginCost.

const SwrModel = (function () {
  const lg = Math.log10;

  const F_MHZ = 151.5;

  // The inspection form's own bands (inspections.js, Antenna Tests: "<1.5 =
  // Good · 1.5–2.0 = Fair · >2.0 = Poor"), so the tab and the sheet the
  // reading is booked on never disagree.
  const SWR_BANDS = [
    { id: 'good', label: 'Good', cls: 'ok',   test: s => s < 1.5 },
    { id: 'fair', label: 'Fair', cls: 'warn', test: s => s <= 2.0 },
    { id: 'poor', label: 'Poor', cls: 'bad',  test: () => true },
  ];

  // The link budget card's fade-margin bands (link-budget.js, LB_MARGIN) and
  // the Radio Propagation bench's flutter (propagation-fade.js, FLUTTER_DB).
  const MARGIN_GOOD = 10;
  const MARGIN_FLOOR = 3;
  const FLUTTER_DB = 2;

  // ── Decibels and the line ─────────────────────────────────────────────────

  const wToDbm = w => (w > 0 ? 10 * lg(w * 1000) : null);
  const dbmToW = dbm => Math.pow(10, dbm / 10) / 1000;
  // A power ratio in decibels: db(3.8 / 5) = −1.19.
  const db = ratio => (ratio > 0 ? 10 * lg(ratio) : -Infinity);

  function gammaFromSwr(s) {
    if (!(s >= 1)) return null;
    if (!Number.isFinite(s)) return 1;
    return (s - 1) / (s + 1);
  }
  function swrFromGamma(g) {
    if (!(g >= 0)) return null;
    if (g >= 1) return Infinity;
    return (1 + g) / (1 - g);
  }
  // |Γ| from the two powers a meter reads: the reflected wave's voltage over
  // the forward wave's, and power goes as voltage squared.
  function gammaFromPowers(fwd, ref) {
    if (!(fwd > 0) || !(ref >= 0)) return null;
    return Math.sqrt(ref / fwd);
  }
  // How far down the reflection is (bigger is better; a perfect match is ∞).
  const returnLossDb = g => (g >= 1 ? 0 : g > 0 ? -20 * lg(g) : Infinity);
  // What the reflection costs the antenna, in decibels (1.5:1 is 0.18 dB).
  const mismatchLossDb = g => (g >= 1 ? Infinity : g > 0 ? -10 * lg(1 - g * g) : 0);

  const swrBand = s => (Number.isFinite(s) || s === Infinity ? SWR_BANDS.find(b => b.test(s)) : null);

  // ── Feeders ───────────────────────────────────────────────────────────────
  // Loss at 150 MHz, dB per 100 m. Times Microwave's figures via Raveon's
  // table (LMR-400 1.5, LMR-240 2.93, RG-213 2.75 and RG-58 5.94 dB/100 ft),
  // and Andrew's LDF4-50A (0.823 dB/100 ft).
  const CABLES = {
    ldf4:   { label: '½″ foam heliax (LDF4-50A)', short: '½″ heliax', db100: 2.7 },
    lmr400: { label: 'LMR-400',                    short: 'LMR-400',   db100: 4.8 },
    rg213:  { label: 'RG-213',                     short: 'RG-213',    db100: 9.0 },
    lmr240: { label: 'LMR-240',                    short: 'LMR-240',   db100: 9.6 },
    rg58:   { label: 'RG-58',                      short: 'RG-58',     db100: 19.5 },
  };
  function cableLossDb(id, m) {
    const c = CABLES[id];
    return c && m > 0 ? c.db100 * m / 100 : 0;
  }

  // ── The meters ────────────────────────────────────────────────────────────
  // `ports` is what is printed beside each socket: the radio goes to the
  // first, the antenna (or a dummy load) to the second.
  const METERS = {
    sw102: {
      name: 'Surecom SW-102', short: 'SW-102', kind: 'digital',
      bandMHz: [125, 525], maxW: 120, minW: 0.5,
      ports: ['TX', 'ANT'], connectors: 'N-type (SO-239 on some)',
      accuracy: 'about ±5% (a seller\'s figure; the manual gives none)',
      reads: 'forward and reflected watts, SWR, "Trans%" and the frequency',
      bursts: false,
      notes: [
        'Its manual: “TX: connect to radio RF output · ANT: connect to antenna or 50 Ω dummy load.”',
        'It works out its power calibration from the frequency it counts: if the frequency line does not show about 151.5 MHz, do not trust the watts (its manual says so).',
        'Its manual warns it is “not for DMR”: it is not built to read short bursts, and the A2\'s TEST button sends one. Watch the screen during the burst, press TEST several times and go by the highest reading that repeats — one low reading means check again, not a fault. The A2\'s tones setting, if it will stay on, reads steadily.',
        'Reads from 0.5 W, by its manual; reviewers find it happiest above about 3 W.',
        'Its menu (blue button) holds a VHF power offset, item 4, that scales every reading by up to ±99%. It should read 0 — off, hold the red button to restore the defaults.',
      ],
      source: 'Surecom SW-102 user\'s manual (to firmware V2.02); Radioddity and G4NSJ',
    },
    sw102hf: {
      name: 'Surecom SW-102HF', short: 'SW-102HF', kind: 'digital', wrongBand: true,
      bandMHz: [1.5, 70], maxW: 120, minW: 0.5,
      ports: ['TX', 'ANT'], connectors: 'SO-239',
      accuracy: 'not specified at 151.5 MHz — it is outside its band',
      reads: 'the same screen as the SW-102',
      bursts: false,
      notes: [
        'The HF model: 1.5–70 MHz, printed on its screen. It looks just like the SW-102 and cannot measure a 151.5 MHz radio — whatever it shows is not a measurement.',
        'Check the band on the screen or the label before you trust any meter: the SW-102 says 125–525 MHz.',
      ],
      source: 'Surecom SW-102HF listing (1.5–70 MHz)',
    },
    swr400: {
      name: 'Moonraker SWR-400', short: 'SWR-400', kind: 'needle',
      bandMHz: [140, 525], maxW: 400, ranges: [5, 20, 200], calMinW: 3,
      ports: ['TX', 'ANT'], connectors: 'on the back panel',
      accuracy: '±5% of full scale on the 5 W range, ±7.5% on 20 W, ±10% on 200 W (Moonraker\'s listing)',
      reads: 'forward or reflected watts on a needle, and SWR once it is calibrated',
      bursts: false,
      notes: [
        'Power is read with FUNCTION on POWER: FWD for forward, REF for reflected, with RANGE at the smallest full scale above the reading.',
        'SWR needs calibrating every time: FUNCTION to CAL, FWD, transmit, turn CAL up until the needle sits on the CAL mark, then — still transmitting — FUNCTION to SWR.',
        'It needs a few watts to reach the CAL mark at all. If CAL at MAX cannot get the needle there, there is not enough power for an SWR reading on this meter.',
        'A needle takes a moment to swing: on the A2\'s TEST burst it never gets all the way, and reads low. PEP MONI holds the top of the burst, which helps.',
        'Calibrating means turning the CAL knob while the radio transmits, so SWR needs the A2 held on by its tones setting. If the tones will not stay on, read SWR on the SW-102 or the 3030, which need no calibrating.',
        'The lamp wants 13.8 V DC; the readings do not.',
      ],
      source: 'Moonraker SWR-400 listing; Diamond SX-series instructions for the same controls',
    },
    cc3030: {
      name: 'Comm-connect 3030', short: '3030', kind: 'digital',
      bandMHz: [30, 500], maxW: 100, minW: 0.0015,
      ports: ['INPUT', 'LOAD'], connectors: 'N-type female',
      accuracy: 'calibrated against its own table for the frequency it counts',
      reads: 'forward and reverse power (to milliwatts), SWR or return loss, and the frequency',
      bursts: true,
      notes: [
        'INPUT to the radio, LOAD to the antenna or a dummy load — the words are printed beside the sockets.',
        'Counts the frequency and applies its calibration for it; outside the counter\'s range it can be set to a manual frequency.',
        'PEAK and HOLD catch a short burst and keep it on the screen — the right setting for the A2\'s TEST button, and why this is the meter built for it.',
        'Can show return loss in place of SWR: 20 dB of return loss is an SWR of 1.22.',
      ],
      source: 'Comm-connect 3030 product listings',
    },
  };

  // ── Made-up stations, one fault each ──────────────────────────────────────
  // setW: what the radio is set to. radio: its real output as a share of that.
  // upDb: loss between the radio and where the meter would go at the radio
  // end (a jumper, an adaptor). cable/m: the feeder. extraDb: loss on top of
  // the feeder's own (water). antSwr: the SWR at the antenna's feed point.
  // flicker: an SWR that will not sit still. backwards: TX and ANT swapped.
  const SCENARIOS = {
    healthy: {
      label: 'A healthy station', setW: 5, radio: 1, upDb: 0.1, cable: 'lmr400', m: 15, extraDb: 0, antSwr: 1.3,
      story: 'A 3 dB collinear on a mast, 15 m of LMR-400 and a short jumper at the radio. Almost all of the power reaches the antenna and almost none comes back.',
    },
    dummy: {
      label: 'A dummy load in place of the antenna', setW: 5, radio: 1, upDb: 0.05, cable: '', m: 0, extraDb: 0, antSwr: 1.03,
      story: 'The meter straight on the radio with a short jumper, and a 50 Ω dummy load on its antenna side. This is how to measure what the radio itself puts out: nothing past the meter can confuse it.',
    },
    thin: {
      label: 'A long run of thin cable', setW: 5, radio: 1, upDb: 0.1, cable: 'rg58', m: 30, extraDb: 0, antSwr: 1.6,
      story: '30 m of RG-58 loses nearly 6 dB at 150 MHz — three-quarters of the power warms the cable. Read at the radio, the SWR looks excellent, because the reflection is weakened twice on its way back.',
    },
    water: {
      label: 'Water in the coax', setW: 5, radio: 1, upDb: 0.1, cable: 'lmr400', m: 15, extraDb: 3, antSwr: 1.9,
      story: 'Water wicked in at a badly sealed connector: the feeder loses three decibels more than it should and the antenna end no longer looks like 50 Ω. Read at the radio, it can look better than a dry, healthy line.',
    },
    loose: {
      label: 'A loose N-type at the antenna', setW: 5, radio: 1, upDb: 0.1, cable: 'lmr400', m: 15, extraDb: 0.3, antSwr: 2.4, flicker: true,
      story: 'Done up by hand but not seated: the centre pin barely touching. The SWR is high and will not sit still — and moving the cable moves it.',
    },
    open: {
      label: 'An antenna broken off, or a cable open', setW: 5, radio: 0.6, upDb: 0.1, cable: 'lmr400', m: 15, extraDb: 0, antSwr: 20,
      story: 'Nearly everything comes back. Many radios turn their own power down when this much is reflected, to protect themselves — so the forward power falls as well.',
    },
    upstream: {
      label: 'A bad jumper or adaptor before the meter', setW: 5, radio: 1, upDb: 1.2, cable: 'lmr400', m: 15, extraDb: 0, antSwr: 1.25,
      story: 'A tired jumper and an adaptor between the radio and the meter lose 1.2 dB. The meter cannot see anything on its TX side: it shows a good SWR and simply less power.',
    },
    supply: {
      label: 'A battery sagging under transmit', setW: 5, radio: 0.76, upDb: 0.1, cable: 'lmr400', m: 15, extraDb: 0, antSwr: 1.25,
      story: 'The battery or its leads cannot hold the voltage up while the radio transmits, and the radio puts out less than it is set to. The line is fine; the radio is short of volts.',
    },
    backwards: {
      label: 'The meter in backwards', setW: 5, radio: 1, upDb: 0.1, cable: 'lmr400', m: 15, extraDb: 0, antSwr: 1.3, backwards: true,
      story: 'The radio on the ANT side and the antenna on TX. The meter calls the power going out "reflected" and the little coming back "forward".',
    },
  };

  // ── The line ──────────────────────────────────────────────────────────────
  // A radio, a jumper, the feeder, the antenna — and a meter put in at the
  // radio end or at the antenna end of the feeder. Single reflections only:
  // at these losses the wave that re-reflects off the radio is a rounding
  // error. Every power is in watts.
  //
  //   radioW  what the radio puts out
  //   fwd     forward power at the meter
  //   ref     reflected power at the meter
  //   gamma   |Γ| at the meter, and swr from it
  //   antGamma, antSwr   at the antenna's feed point
  //   atAnt   forward power reaching the antenna
  //   radiated  what the antenna takes (atAnt less what it reflects)
  //   feedDb  the feeder's loss, with any extra
  function line(o) {
    const setW = o.setW > 0 ? o.setW : 5;
    const radioW = setW * (o.radio > 0 ? o.radio : 1);
    const upDb = Math.max(0, o.upDb || 0);
    const feedDb = cableLossDb(o.cable, o.m) + Math.max(0, o.extraDb || 0);
    const antGamma = gammaFromSwr(o.antSwr >= 1 ? o.antSwr : 1);
    const atRadioEnd = o.where !== 'antenna';
    const up = Math.pow(10, -upDb / 10), feed = Math.pow(10, -feedDb / 10);
    const atAnt = radioW * up * feed;
    const backAtAnt = atAnt * antGamma * antGamma;
    let fwd, ref;
    if (atRadioEnd) { fwd = radioW * up; ref = backAtAnt * feed; }
    else { fwd = atAnt; ref = backAtAnt; }
    const backAtRadio = backAtAnt * feed * up;
    const out = {
      setW, radioW, upDb, feedDb, fwd, ref, atAnt, radiated: atAnt - backAtAnt, backAtRadio,
      antGamma, antSwr: swrFromGamma(antGamma), where: atRadioEnd ? 'radio' : 'antenna',
    };
    if (o.backwards) { const t = out.fwd; out.fwd = out.ref; out.ref = t; }
    out.gamma = gammaFromPowers(out.fwd, out.ref);
    out.swr = out.gamma == null ? null : swrFromGamma(out.gamma);
    return out;
  }

  // ── The cliff ─────────────────────────────────────────────────────────────
  // BitModel.ber, restated so this file loads alone (test/swr.mjs holds the
  // two equal): non-coherent FSK, ½·e^(−SNR/2).
  const ber = snrDb => Math.min(0.5, 0.5 * Math.exp(-0.5 * Math.pow(10, snrDb / 10)));
  const FRAME_BITS = 40;
  // The signal-to-noise at which half of all 40-bit frames arrive whole —
  // where a fade-margin test calls the margin nought. 8.29 dB.
  const SNR_EDGE = 10 * lg(-2 * Math.log(2 * (1 - Math.pow(0.5, 1 / FRAME_BITS))));

  // The share of messages lost at a margin, with no fading.
  const frameLoss = marginDb => 1 - Math.pow(1 - ber(SNR_EDGE + marginDb), FRAME_BITS);

  // …and averaged over flutter: a normal spread of σ decibels around the
  // margin, summed in steps of a twentieth of σ out to five σ either side.
  function missed(marginDb, sigma = FLUTTER_DB) {
    if (!(sigma > 0)) return frameLoss(marginDb);
    let sum = 0, wsum = 0;
    for (let z = -5; z <= 5.0001; z += 0.05) {
      const w = Math.exp(-z * z / 2);
      sum += w * frameLoss(marginDb + z * sigma);
      wsum += w;
    }
    return sum / wsum;
  }

  // What losing `lossDb` does to a station with `marginDb` of fade margin.
  function marginCost(marginDb, lossDb, sigma = FLUTTER_DB) {
    const before = missed(marginDb, sigma), after = missed(marginDb - lossDb, sigma);
    return { before, after, times: before > 0 ? after / before : Infinity, marginAfter: marginDb - lossDb };
  }

  // ── Reading the readings ──────────────────────────────────────────────────
  // inp: { fwd, ref, swr — any two of the three, as read; setW — what the
  //        radio is set to; where — 'radio' | 'antenna'; cable, m — the
  //        feeder, if known; meter — a METERS key; steady — the reading
  //        caught the whole signal: the A2 held on by its tones, or a meter
  //        that holds a TEST burst's peak, rather than a TEST burst caught
  //        partly }
  //
  // Returns the numbers worked out from them and a list of findings, worst
  // first. Each finding: { id, cls ('ok' | 'warn' | 'bad' | 'info'), title,
  // text, do: [what to do, in order] }.
  function interpret(inp) {
    const n = v => (v === '' || v == null ? null : Number(v));
    let fwd = n(inp.fwd), ref = n(inp.ref), swr = n(inp.swr);
    const setW = n(inp.setW) > 0 ? n(inp.setW) : null;
    const where = inp.where === 'antenna' ? 'antenna' : 'radio';
    const feedDb = cableLossDb(inp.cable, n(inp.m));
    const meter = METERS[inp.meter] || null;
    const out = { ok: false, findings: [], where, feedDb, setW, meter: inp.meter || '' };
    const bad = x => x != null && !(Number.isFinite(x) && x >= 0);
    if (bad(fwd) || bad(ref) || (swr != null && !(swr >= 1))) {
      out.error = 'Watts are zero or more, and an SWR is 1 or more (1.00 is a perfect match).';
      return out;
    }
    const typedSwr = swr;
    // Any two make the third.
    if (fwd != null && ref != null) {
      if (fwd === 0 && ref === 0) { out.error = 'Both powers are nought: was the radio transmitting?'; return out; }
      if (fwd === 0) swr = Infinity;
      else swr = ref >= fwd ? Infinity : swrFromGamma(gammaFromPowers(fwd, ref));
    } else if (fwd != null && swr != null) {
      const g = gammaFromSwr(swr); ref = fwd * g * g;
    } else if (ref != null && swr != null) {
      const g = gammaFromSwr(swr);
      fwd = g > 0 ? ref / (g * g) : null;
    }
    if (fwd == null && swr != null) {
      out.ok = true; out.swr = swr; out.gamma = gammaFromSwr(swr);
    } else if (fwd == null || swr == null) {
      out.error = 'Type the forward power, and the reflected power or the SWR.';
      return out;
    } else {
      out.ok = true;
      out.fwd = fwd; out.ref = ref; out.swr = swr;
      out.gamma = fwd > 0 ? Math.min(1, Math.sqrt(ref / fwd)) : 1;
    }
    const g = out.gamma;
    out.rlDb = returnLossDb(g);
    out.reflPct = 100 * g * g;
    out.mmDb = mismatchLossDb(g);
    out.band = swrBand(out.swr);
    if (out.fwd != null) {
      out.dbm = wToDbm(out.fwd);
      out.passW = out.fwd - out.ref;
      if (setW) out.vsSetDb = db(out.fwd / setW);
      if (where === 'radio' && feedDb > 0) {
        out.atAnt = out.fwd * Math.pow(10, -feedDb / 10);
        // The reflection was weakened by the feeder up and back — 2 × feedDb
        // in power, so |Γ| by 10^(−feedDb/10): undo it to see the antenna's
        // own match.
        out.antGamma = Math.min(1, g * Math.pow(10, feedDb / 10));
        out.antSwr = swrFromGamma(out.antGamma);
      }
      if (where === 'antenna' && setW && feedDb > 0) out.expectAtAnt = setW * Math.pow(10, -feedDb / 10);
      // The decibels this station is down on: against its setting at the
      // radio, against what should reach it at the antenna end.
      if (where === 'radio' && setW) out.downDb = db(out.fwd / setW);
      else if (out.expectAtAnt) out.downDb = db(out.fwd / out.expectAtAnt);
    }
    // All three typed, and they disagree.
    if (typedSwr != null && n(inp.fwd) != null && n(inp.ref) != null && Number.isFinite(out.swr)) {
      const gt = gammaFromSwr(typedSwr), gw = out.gamma;
      if (Math.abs(gt - gw) > 0.05 && Math.abs(typedSwr - out.swr) > 0.1) out.disagree = { typed: typedSwr, fromPowers: out.swr };
    }
    out.findings = findings(out, inp, meter);
    return out;
  }

  const r2 = x => (Math.round(x * 100) / 100).toFixed(2);
  const r1 = x => (Math.round(x * 10) / 10).toFixed(1);
  function wTxt(w) {
    if (!(w > 0)) return '0 W';
    if (w >= 10) return `${r1(w)} W`;
    if (w >= 0.1) return `${r2(w)} W`;
    const mw = w * 1000;
    return `${mw >= 1 ? Math.round(mw) : r1(mw)} mW`;
  }
  const sTxt = s => (Number.isFinite(s) ? r2(s) : '∞');

  function findings(o, inp, meter) {
    const F = [];
    const add = (id, cls, title, text, todo) => F.push({ id, cls, title, text, do: todo || [] });
    const steady = inp.steady !== false;

    if (meter && meter.wrongBand) {
      add('band', 'bad', `The ${meter.short} cannot measure this radio`,
        `It covers ${meter.bandMHz[0]}–${meter.bandMHz[1]} MHz, and the network is on ${F_MHZ} MHz. Nothing it shows here is a measurement — not the watts, not the SWR.`,
        ['Use a VHF meter: the SW-102 (125–525 MHz), the SWR-400 (140–525 MHz) or the 3030 (30–500 MHz).', 'Measure again and book the new readings.']);
    }

    // Reflected more than forward: the meter is in backwards.
    if (o.fwd != null && o.ref > o.fwd) {
      add('backwards', 'bad', 'The meter looks to be in backwards',
        `It reads more coming back (${wTxt(o.ref)}) than going out (${wTxt(o.fwd)}). No antenna does that: the meter is calling the outgoing power "reflected".`,
        [`Swap the cables: the radio to ${meter ? meter.ports[0] : 'TX / INPUT'}, the antenna or dummy load to ${meter ? meter.ports[1] : 'ANT / LOAD'}.`,
          'Read again. The forward reading should be the big one.']);
      return F;
    }

    if (o.disagree) {
      add('disagree', 'warn', 'The SWR and the two powers do not agree',
        `The powers make it ${sTxt(o.disagree.fromPowers)}; the SWR typed is ${sTxt(o.disagree.typed)}. The powers are worked from below.`,
        ['Read all three again off the same TEST press — the 3030 with HOLD keeps them together.',
          'On a needle meter, calibrate first, with the A2 held on by its tones: CAL to the mark, then SWR — an SWR read without calibrating is not a reading.']);
    }

    // The SWR, in the form's own bands.
    const b = o.band;
    if (b) {
      const s = o.swr;
      if (!Number.isFinite(s) || s >= 10) {
        add('swr', 'bad', 'Nearly everything is coming back',
          `An SWR of ${sTxt(s)} means about ${Math.round(o.reflPct)}% of the power returns to the radio. Something past the meter is open or shorted: a broken or unplugged cable, a centre pin pushed back, a crushed or flooded run, or the antenna itself.`,
          ['Stop transmitting into it: it can damage the radio.',
            'Look along the line from the meter outwards: every connector undone, inspected (centre pin height, water, corrosion) and remade.',
            'Put a dummy load where the antenna connects. A good SWR there means the antenna is the fault; a bad one, the cable.',
            'Book it in the inspection form, and a work order for the antenna or feeder.']);
      } else if (b.id === 'poor') {
        add('swr', 'bad', `SWR ${sTxt(s)} — Poor`,
          `About ${r1(o.reflPct)}% of the power comes back (return loss ${r1(o.rlDb)} dB). Over 2.0 the inspection form calls it Poor: there is a fault in the line or the antenna.`,
          ['Check every connector past the meter: done up finger-tight and seated, no water, no green corrosion, the centre pin at the right height.',
            'Look at the antenna: bent, cracked, a radome full of water, a loose element, metal (a new bracket, a gutter) right beside it.',
            'Wiggle the feeder near each connector while transmitting: a reading that jumps is a bad joint.',
            'Move the meter to the top of the feeder, or put a dummy load at the antenna end, to split cable from antenna.']);
      } else if (b.id === 'fair') {
        add('swr', 'warn', `SWR ${sTxt(s)} — Fair`,
          `About ${r1(o.reflPct)}% of the power comes back — ${r2(o.mmDb)} dB of mismatch loss, which on its own is small. The form calls 1.5–2.0 Fair: worth finding out why, before it gets worse.`,
          ['Remake and re-weatherproof the outdoor connectors — water is the usual reason an SWR creeps up.',
            'Compare it with the last visit\'s reading in Inspection History: a rise is what matters.',
            'Check nothing metal has been put up close to the antenna.']);
      } else {
        add('swr', 'ok', `SWR ${sTxt(s)} — Good`,
          `${s < 1.1 ? 'Almost nothing' : `About ${r1(o.reflPct)}%`} of the power comes back (return loss ${Number.isFinite(o.rlDb) ? r1(o.rlDb) + ' dB' : '∞'}). Under 1.5 is Good on the inspection form.`, []);
      }
    }

    // A good SWR read through a lossy feeder hides the antenna's.
    if (o.where === 'radio' && o.antSwr != null && o.feedDb >= 1 && Number.isFinite(o.swr) && o.swr < 10) {
      const worse = o.antSwr - o.swr > 0.15;
      add('hidden', worse && o.antSwr > 1.5 ? 'warn' : 'info',
        `At the antenna it is nearer ${Number.isFinite(o.antSwr) && o.antGamma < 0.99 ? sTxt(o.antSwr) : '∞'}`,
        `The feeder loses ${r1(o.feedDb)} dB. A reflection loses that twice — up and back — so the meter at the radio sees a better SWR than the antenna has. ` +
        (o.atAnt != null ? `Of the ${wTxt(o.fwd)} going up, about ${wTxt(o.atAnt)} reaches the antenna.` : ''),
        worse ? ['Read it again at the top of the feeder, with the meter at the antenna, before calling the antenna good.'] : []);
    }

    // The power, against what the radio is set to.
    if (o.fwd != null && o.setW) {
      const dB = o.vsSetDb;
      const lowTxt = `${wTxt(o.fwd)} against ${wTxt(o.setW)} set is ${r2(Math.abs(dB))} dB ${dB < 0 ? 'down' : 'up'} — ${Math.round(100 * o.fwd / o.setW)}% of the watts.`;
      const upstream = ['Is the meter at the radio? At the top of the feeder it reads less by the feeder\'s loss — 25 m of LMR-400 is 1.2 dB, and 3.8 W of 5.',
        steady ? null : 'How did the meter catch the A2\'s TEST burst? The SW-102 and a needle under-read a short burst: press TEST several times and go by the highest reading that repeats, or use the 3030 with PEAK and HOLD.',
        'Is the meter right for the job? Check its band (an HF meter cannot read 151.5 MHz) and, on the SW-102, that menu item 4 (VHF power offset) is 0.',
        'Swap the jumper and any adaptor between the radio and the meter for a short, known-good one: the meter cannot see a bad joint on its TX side.',
        'Measure the supply voltage at the radio while it transmits, not at rest: a sagging battery or thin leads take power off the top.',
        'Then put the meter straight on the radio with a dummy load on its other side. If that reads low too, it is the radio (or its setting), not the line.',
      ].filter(Boolean);
      if (o.where === 'antenna' && o.expectAtAnt != null) {
        const vsExp = db(o.fwd / o.expectAtAnt);
        add('power', Math.abs(vsExp) <= 1 ? 'ok' : vsExp < -1 ? 'warn' : 'info',
          `${wTxt(o.fwd)} at the antenna; about ${wTxt(o.expectAtAnt)} expected`,
          `At the top of the feeder the meter reads what is left after the feeder's ${r1(o.feedDb)} dB, so less than the radio's ${wTxt(o.setW)} is expected. ${Math.abs(vsExp) <= 1 ? 'This is within a decibel of it.' : `This is ${r2(Math.abs(vsExp))} dB ${vsExp < 0 ? 'under' : 'over'} it.`}`,
          vsExp < -1 ? ['Read it again at the radio end. If the radio end reads right, the feeder is losing more than it should — water, a damaged run, a bad joint.'] : []);
      } else if (dB < -2) {
        add('power', 'bad', 'Well down on power', lowTxt + (o.band && o.band.id !== 'good' ? ' With the SWR up as well, the radio may be turning itself down to protect itself.' : ' With a good SWR, look at the radio side of the meter, and at the meter.'), upstream);
      } else if (dB < -1) {
        add('power', 'warn', 'A little down on power', lowTxt + ' Small — but more than a meter and a radio usually disagree by. Rule out the easy explanations before touching the radio.', upstream);
      } else if (dB > 1) {
        add('power', 'warn', 'More power than it is set to', lowTxt + ' Check the meter\'s range (a needle on the wrong range reads nothing useful) and what the radio is really set to.',
          ['On a needle meter, read on the smallest range above the reading.', 'Check the radio\'s configuration, and the licensed power for the site in RF Environment.']);
      } else {
        add('power', 'ok', 'Power as set', `${lowTxt} Within a decibel — about as close as a field meter and a radio's own tolerance can tell apart.`, []);
      }
    }
    // What it costs, in fade margin.
    if (o.downDb != null && o.downDb < -0.5) {
      const d = r1(Math.abs(o.downDb));
      add('margin', 'info', `${d} dB off every link this station has`,
        `Losing ${d} dB takes ${d} dB off the station's fade margin. With 10 dB or more in hand that changes almost nothing; within a few decibels of the edge, a decibel can double the messages lost. Look up the station's fade margin before deciding how much this matters.`, []);
    }

    if (o.fwd != null && meter && meter.minW && o.fwd < meter.minW) {
      add('weak', 'warn', `Under what the ${meter.short} reads`, `The ${meter.short} reads from about ${wTxt(meter.minW)}; below that its numbers are not to be trusted.`, []);
    }
    if (o.fwd != null && meter && meter.calMinW && o.fwd < meter.calMinW && o.band) {
      add('cal', 'info', 'Too little power to calibrate this needle', `The ${meter.short} needs roughly ${meter.calMinW} W or more to reach its CAL mark. If CAL at MAX does not get there, its SWR scale cannot be read.`, []);
    }

    const order = { bad: 0, warn: 1, info: 2, ok: 3 };
    return F.sort((a, b2) => order[a.cls] - order[b2.cls]);
  }

  return {
    F_MHZ, SWR_BANDS, MARGIN_GOOD, MARGIN_FLOOR, FLUTTER_DB, CABLES, METERS, SCENARIOS, SNR_EDGE, FRAME_BITS,
    wToDbm, dbmToW, db, gammaFromSwr, swrFromGamma, gammaFromPowers, returnLossDb, mismatchLossDb, swrBand,
    cableLossDb, line, interpret, ber, frameLoss, missed, marginCost,
  };
})();

if (typeof window !== 'undefined') window.SwrModel = SwrModel;
