// MegaNet — propagation-physics.js
//
//   PropPhysics   the arithmetic behind the 🎓 Radio Propagation tab: the
//                 handful of formulas a radio planner carries in their head,
//                 written once so that every drawing on the tab — the 3-D
//                 scene, the interference strip, the side-on path, the bit
//                 lanes and the repeater timeline — quotes the same numbers.
//
// After core.js, before propagation-scene.js and propagation.js, which call it.
// Reaches for nothing: no DOM, no `state`, no other module — which is what lets
// test/propagation.mjs load it into Node's vm and hold every figure on the tab
// to a value worked by hand.
//
// ── What is exact, and what is illustrative ──────────────────────────────────
//
// Exact (textbook physics, no fitted constants):
//   wavelength, flight delay, free-space loss, Fresnel zones, the Earth's bulge
//   and the radio horizon (k = 4/3), the knife-edge diffraction parameter and
//   ITU-R P.526's approximation to its loss, and the sum of copies as phasors.
//
// Illustrative (a published model, used to show a trend rather than to price a
// path — the link budget card on the Stations tab does that, calibrated):
//   foliage loss, after ITU-R P.833's woodland model: a specific attenuation
//   that grows with frequency, and a ceiling on the excess loss because a wave
//   that cannot go through the canopy goes over it. At 150 MHz the leaves are a
//   fifteenth of a wavelength across and the ceiling is a few decibels; at
//   2.4 GHz the same wood costs tens of decibels. The calibration behind the
//   app's own fade margins (FN_MODEL_DEFAULTS, core.js) found the network more
//   transparent still than a model that stood the trees up as solid edges.
//
//   the receiver: FM's capture effect at 6 dB, and a bit-error chance that
//   rises as two signals approach the same strength. Real receivers differ by
//   a few decibels; the shape — the stronger wins outright, the even match
//   spoils both — is the part that holds.
//
// ── ALERT on the air ─────────────────────────────────────────────────────────
//
// The numbers are the ones the rest of the app already uses: AFSK over
// narrowband FM at 300 baud (alert-dsp.js); a legacy frame of four 10-bit
// words, 40 bits, 133 ms; a keying with its lead-in about half a second
// (airtime-analysis.js's AIR_MS); and the ALERT Binary Format's bit layout,
// the same map packets.js decodes with — 13 address bits, 11 value bits and
// eight fixed check bits, no CRC. That last fact is why a flipped address bit
// is so dangerous: the frame still passes, on somebody else's address.
//
// Exposes: constants (C_KM_PER_US, F_MHZ, BAUD, FRAME_BITS, BIT_MS, FRAME_MS,
//          LEAD_MS, TAIL_MS, KEYING_MS, CAPTURE_DB, SENS_DBM, K_FACTOR,
//          R_EARTH_KM), wavelengthM, delayUs, fsplDb, fresnelM, earthBulgeM,
//          horizonKm, knifeNu, knifeDb, foliageGamma, foliageMax, foliageDb,
//          phasorSum, twoPathDb, dbm, mw, encodeAbf, decodeAbf, ABF_MAP,
//          onAirBits, receive, rng.

const PropPhysics = (function () {
  const C = 299792458;                     // m/s
  const C_KM_PER_US = C / 1e9;             // 0.2998 km in a microsecond
  const F_MHZ = 151.5;                     // the live network's channel (alert-dsp.js)
  const BAUD = 300;
  const FRAME_BITS = 40;                   // four 10-bit words: start, eight bits, stop
  const BIT_MS = 1000 / BAUD;              // 3.33 ms
  const FRAME_MS = FRAME_BITS * BIT_MS;    // 133 ms
  // The rest of a keying, which nobody times to the millisecond: the
  // transmitter coming up and the preamble the receivers lock on to, then a
  // short tail. Sized so the whole is airtime-analysis.js's half second.
  const LEAD_MS = 300;
  const TAIL_MS = 500 - LEAD_MS - FRAME_MS;
  const KEYING_MS = LEAD_MS + FRAME_MS + TAIL_MS;
  const CAPTURE_DB = 6;                    // FM capture: this far ahead, the stronger wins
  const SENS_DBM = -117;                   // a good VHF receiver at 300 baud, roughly
  const K_FACTOR = 4 / 3;                  // the standard atmosphere bends radio over the bulge
  const R_EARTH_KM = 6371;

  const log10 = Math.log10;

  // ── Distances, times, losses ──────────────────────────────────────────────

  function wavelengthM(fMHz = F_MHZ) { return C / (fMHz * 1e6); }

  // Flight time over a distance, in microseconds.
  function delayUs(km) { return km / C_KM_PER_US; }

  // Free-space path loss, dB, between isotropic antennas.
  function fsplDb(km, fMHz = F_MHZ) {
    return 32.45 + 20 * log10(Math.max(km, 1e-6)) + 20 * log10(fMHz);
  }

  // Radius of the nth Fresnel zone, m, at d1 km from one end and d2 km from
  // the other: sqrt(n λ d1 d2 / (d1 + d2)).
  function fresnelM(d1Km, d2Km, fMHz = F_MHZ, n = 1) {
    const d1 = d1Km * 1000, d2 = d2Km * 1000;
    if (d1 <= 0 || d2 <= 0) return 0;
    return Math.sqrt(n * wavelengthM(fMHz) * d1 * d2 / (d1 + d2));
  }

  // How far the Earth stands up into a path, m, at d1/d2 km from its ends,
  // with the atmosphere's bending folded into an effective radius k·R.
  function earthBulgeM(d1Km, d2Km, k = K_FACTOR) {
    return d1Km * d2Km / (2 * k * R_EARTH_KM) * 1000;
  }

  // The radio horizon of an antenna h m up, km.
  function horizonKm(hM, k = K_FACTOR) {
    return Math.sqrt(2 * k * R_EARTH_KM * Math.max(hM, 0) / 1000);
  }

  // The knife-edge diffraction parameter ν for an edge h m above (positive)
  // or below (negative) the straight line, d1/d2 km from the ends.
  function knifeNu(hM, d1Km, d2Km, fMHz = F_MHZ) {
    const d1 = d1Km * 1000, d2 = d2Km * 1000;
    if (d1 <= 0 || d2 <= 0) return -Infinity;
    return hM * Math.sqrt(2 * (d1 + d2) / (wavelengthM(fMHz) * d1 * d2));
  }

  // ITU-R P.526's approximation to the knife-edge loss, dB. 6 dB with the
  // edge exactly on the line; nothing once it is well clear (ν ≤ −0.78).
  function knifeDb(nu) {
    if (!(nu > -0.78)) return 0;
    return 6.9 + 20 * log10(Math.sqrt((nu - 0.1) ** 2 + 1) + nu - 0.1);
  }

  // Foliage, after ITU-R P.833 (illustrative — see the header). γ in dB/m,
  // the ceiling in dB, and the excess loss through `depthM` of canopy.
  function foliageGamma(fMHz = F_MHZ) { return 0.25 * Math.pow(fMHz / 1000, 0.7); }
  function foliageMax(fMHz = F_MHZ)   { return 0.18 * Math.pow(fMHz, 0.752); }
  function foliageDb(depthM, fMHz = F_MHZ) {
    if (!(depthM > 0)) return 0;
    const am = foliageMax(fMHz);
    return am * (1 - Math.exp(-foliageGamma(fMHz) * depthM / am));
  }

  const mw  = dBm => Math.pow(10, dBm / 10);
  const dbm = m => (m > 0 ? 10 * log10(m) : -Infinity);

  // Copies of one carrier, each { db, phase } (amplitude in dB against a
  // common reference, phase in radians), added as arrows tip to tail.
  // Returns the resultant { re, im, amp, db, phase } and the arrows' path.
  function phasorSum(copies) {
    let re = 0, im = 0;
    const path = [{ re: 0, im: 0 }];
    for (const c of copies) {
      const a = Math.pow(10, c.db / 20);
      re += a * Math.cos(c.phase);
      im += a * Math.sin(c.phase);
      path.push({ re, im });
    }
    const amp = Math.hypot(re, im);
    return { re, im, amp, db: amp > 0 ? 20 * log10(amp) : -Infinity, phase: Math.atan2(im, re), path };
  }

  // A direct wave and one echo `deltaM` longer and `echoDb` weaker (≤ 0):
  // what the pair adds to, dB against the direct wave alone. +6 dB at most
  // for an equal echo in step; minus infinity for one exactly half a
  // wavelength behind it.
  function twoPathDb(deltaM, echoDb = 0, fMHz = F_MHZ, extraPhase = 0) {
    const ph = -2 * Math.PI * deltaM / wavelengthM(fMHz) + extraPhase;
    return phasorSum([{ db: 0, phase: 0 }, { db: echoDb, phase: ph }]).db;
  }

  // ── The ALERT Binary Format ───────────────────────────────────────────────
  // packets.js's ABF map, bit for bit: [kind, index] in transmission order,
  // 'A' an address bit, 'D' a value bit, 'K' a fixed check bit with the value
  // it must hold.
  const ABF_MAP = [
    ['A', 0], ['A', 1], ['A', 2], ['A', 3], ['A', 4], ['A', 5], ['K', 1], ['K', 0],
    ['A', 6], ['A', 7], ['A', 8], ['A', 9], ['A', 10], ['A', 11], ['K', 1], ['K', 0],
    ['A', 12], ['D', 0], ['D', 1], ['D', 2], ['D', 3], ['D', 4], ['K', 1], ['K', 1],
    ['D', 5], ['D', 6], ['D', 7], ['D', 8], ['D', 9], ['D', 10], ['K', 1], ['K', 1],
  ];

  // An address (0–8191) and a value (0–2047) as the 32 bits of a frame.
  function encodeAbf(addr, value) {
    return ABF_MAP.map(([k, i]) =>
      k === 'A' ? (addr >> i) & 1 : k === 'D' ? (value >> i) & 1 : i);
  }

  // 32 bits back to { addr, value, ok, badChecks } — `ok` is the only test an
  // ABF frame has: its eight check bits holding their fixed values.
  function decodeAbf(bits) {
    let addr = 0, value = 0;
    const badChecks = [];
    ABF_MAP.forEach(([k, i], j) => {
      const b = bits[j] ? 1 : 0;
      if (k === 'A') addr |= b << i;
      else if (k === 'D') value |= b << i;
      else if (b !== i) badChecks.push(j);
    });
    return { addr, value, ok: badChecks.length === 0, badChecks };
  }

  // The 40 bits on the air: each 8-bit word between a start bit (0) and a
  // stop bit (1). Returned as { bit, data } with data the index into the 32,
  // or -1 for framing.
  function onAirBits(bits32) {
    const out = [];
    for (let w = 0; w < 4; w++) {
      out.push({ bit: 0, data: -1 });
      for (let i = 0; i < 8; i++) out.push({ bit: bits32[w * 8 + i], data: w * 8 + i });
      out.push({ bit: 1, data: -1 });
    }
    return out;
  }

  // A small seeded generator (mulberry32), so a picture drawn from the same
  // settings is always the same picture.
  function rng(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ── A receiver hearing several keyings at once ────────────────────────────
  // keyings: [{ id, startMs, dbm, bits }] — bits the 32 of its frame. Each is
  // on the air for KEYING_MS from startMs, its frame LEAD_MS in. Every bit of
  // every frame is weighed against everything else on the air during it:
  //
  //   ahead by CAPTURE_DB or more   the bit is clean — FM hears the stronger
  //   behind by CAPTURE_DB or more  the receiver is captured by the other
  //                                 signal and this frame is lost
  //   in between                    the bit may flip, more often the closer
  //                                 the two are; less often when the other is
  //                                 itself sending the same bit
  //
  // Returns one result per keying: { id, status, bits, flips, decoded, worstSir,
  // overlap } — status 'weak' (under the receiver's floor), 'lost', 'clean',
  // 'flipped' (bits changed but the frame still passes its checks: a ghost or
  // a wrong value) or 'rejected' (its check bits caught it).
  function receive(keyings, { seed = 1, captureDb = CAPTURE_DB, sensDbm = SENS_DBM } = {}) {
    const rand = rng(seed);
    const heard = keyings.filter(k => k.dbm >= sensDbm);
    return keyings.map(k => {
      const base = { id: k.id, bits: k.bits.slice(), flips: [], worstSir: Infinity, overlap: null };
      if (k.dbm < sensDbm) return { ...base, status: 'weak', decoded: null };
      const air = onAirBits(k.bits);
      const f0 = k.startMs + LEAD_MS;
      let lost = false;
      for (let j = 0; j < air.length; j++) {
        const t0 = f0 + j * BIT_MS, t1 = t0 + BIT_MS;
        let other = 0, sameBit = true, anyFrame = false;
        for (const o of heard) {
          if (o === k) continue;
          const s = o.startMs, e = o.startMs + KEYING_MS;
          if (e <= t0 || s >= t1) continue;
          other += mw(o.dbm);
          // Is the other in its own frame at this moment, and sending what?
          const oj = Math.floor((t0 + BIT_MS / 2 - (s + LEAD_MS)) / BIT_MS);
          if (oj >= 0 && oj < FRAME_BITS) {
            anyFrame = true;
            if (onAirBits(o.bits)[oj].bit !== air[j].bit) sameBit = false;
          } else {
            sameBit = false;
          }
        }
        if (!other) continue;
        const sir = k.dbm - dbm(other);
        if (sir < base.worstSir) base.worstSir = sir;
        if (!base.overlap || base.overlap === 'carrier') base.overlap = anyFrame ? 'bits' : 'carrier';
        if (sir >= captureDb) continue;
        if (sir <= -captureDb) { lost = true; break; }
        let p = 0.5 * (1 - Math.abs(sir) / captureDb);
        if (sameBit) p *= 0.25;
        if (rand() < p && air[j].data >= 0) {
          base.bits[air[j].data] ^= 1;
          base.flips.push(air[j].data);
        }
      }
      if (lost) return { ...base, bits: k.bits.slice(), flips: [], status: 'lost', decoded: null };
      const decoded = decodeAbf(base.bits);
      const status = !base.flips.length ? 'clean' : decoded.ok ? 'flipped' : 'rejected';
      return { ...base, status, decoded };
    });
  }

  return {
    C_KM_PER_US, F_MHZ, BAUD, FRAME_BITS, BIT_MS, FRAME_MS, LEAD_MS, TAIL_MS, KEYING_MS,
    CAPTURE_DB, SENS_DBM, K_FACTOR, R_EARTH_KM,
    wavelengthM, delayUs, fsplDb, fresnelM, earthBulgeM, horizonKm, knifeNu, knifeDb,
    foliageGamma, foliageMax, foliageDb, phasorSum, twoPathDb, dbm, mw,
    ABF_MAP, encodeAbf, decodeAbf, onAirBits, receive, rng,
  };
})();
