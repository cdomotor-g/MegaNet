// MegaNet — alert-dsp.js
//
//   AlertDsp   the off-air ALERT decoder behind the Serial Monitor's RTL-SDR
//              card. Raw 8-bit IQ in; ALERT Binary, Enhanced iFLOWS or ALERT
//              ASCII readings out. Also the spectrum, FM audio, tone energy,
//              ADC histogram and burst gate the card draws.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches for nothing: no DOM, no `state`, no other module. That is what lets
// one source run three ways — in a Web Worker built from this function's own
// text (workerSource), on the main thread when no Worker can be made, and
// under Node, where test/alertdsp.mjs requires it and decodes a real off-air
// capture with it. The guarded module.exports at the foot is the Node door.
//
// ── Where the decoder comes from ─────────────────────────────────────────────
//
// A port of agmurf/sdr-alert-decoder (MIT, © 2026 Adam Murphy): the Android
// app's AlertDsp.kt and Alert1Formats.kt, themselves a line-for-line port of
// that project's proven desktop chain. Its HANDOVER.md is the reason for
// nearly every constant below. The ones that matter most:
//
//   * AFSK over narrowband FM — mark 1300.8 Hz, space 2109.4 Hz, 300 baud.
//     Not direct carrier FSK; believing that cost the original a week.
//   * 240 ksps in, ÷20 to 12 kHz: exactly 40 samples a symbol. A non-integer
//     rate drifts the timing and wrecks the vote counts.
//   * A four-sideband matched filter. Under FM an audio tone appears at ±f, so
//     both lines of each tone are summed — ~8 dB over one sideband.
//   * ONE frame format at a time. Enhanced iFLOWS has 8 bits of constraint
//     against Binary's 16, so a strong Binary burst makes CRC-valid Enhanced
//     iFLOWS ghosts that no vote threshold removes. There is no "both".
//   * Station 5461 is the 0x55 preamble parsing as a Binary frame. Dropped.
//   * Vote thresholds belong to the sweep that produced them. 4 and 4 are the
//     phone's, and this is the phone's sweep. The desktop's 6/10/35 are not
//     transferable — copying 35 here silently decodes nothing.
//
// Where this departs from the Kotlin it says so at the spot. Two matter: the
// carrier search reads the whole window rather than its first 34 ms, and the
// tone filter is a sliding DFT — the same numbers, a fortieth of the work.
//
// The 4078 test rig's real off-air burst (testrig_burst_240k.iq8, copied from
// that repo into test/fixtures/sdr/) is the regression vector: it must decode
// to 4079 = 420 and 4080 = 121 (12.1 V) under Enhanced iFLOWS, as the Kotlin's
// own unit test requires, and noise must decode to nothing.

const AlertDsp = (function alertDspModule() {
  const FS_IN = 240000;            // what the decoder wants: 240k ÷ 20 = 12k exactly
  const DECIM = 20;
  const FS_BB = FS_IN / DECIM;     // 12 000 Hz
  const BAUD = 300;
  const SPB = FS_BB / BAUD;        // 40 samples a symbol — integer, so no timing drift
  const AFSK_F1 = 1300.8;          // mark / idle tone
  const AFSK_F2 = 2109.4;          // space tone
  const SEARCH_HZ = 10000;         // carrier search, either side of the channel centre
  const DC_NOTCH_HZ = 200;         // the dongle's DC spike is never a carrier
  const SEG = 8192;                // carrier-search FFT length

  const BINARY = 'BINARY', ASCII = 'ASCII', ENHANCED_IFLOWS = 'ENHANCED_IFLOWS';

  // Named for the frame format, never the network: NSW operators call their
  // network "iFLOWS", and its frames are ALERT Binary. HANDOVER §5's trap.
  const FORMATS = [
    { key: BINARY, label: 'ALERT Binary',
      hint: 'All four bytes marked, no checksum. What the live 151.5 MHz network sends.' },
    { key: ENHANCED_IFLOWS, label: 'Enhanced iFLOWS',
      hint: 'Only byte 0 marked, plus a 6-bit CRC. What an ERT-A2 set to it sends (the 4078 test rig).' },
    { key: ASCII, label: 'ALERT ASCII',
      hint: 'Four ASCII digits: address and value 0–99. Rare.' },
  ];

  // ── filters ─────────────────────────────────────────────────────────────────

  // Windowed-sinc lowpass, Hamming window; cutoffNorm is a fraction of Nyquist.
  // Unity DC gain.
  function firwin(numTaps, cutoffNorm) {
    const m = numTaps - 1;
    const tmp = new Float64Array(numTaps);
    let sum = 0;
    for (let i = 0; i < numTaps; i++) {
      const n = i - m / 2;
      const sinc = n === 0 ? cutoffNorm : Math.sin(Math.PI * cutoffNorm * n) / (Math.PI * n);
      const w = m > 0 ? 0.54 - 0.46 * Math.cos(2 * Math.PI * i / m) : 1;
      tmp[i] = sinc * w;
      sum += tmp[i];
    }
    const h = new Float32Array(numTaps);
    for (let i = 0; i < numTaps; i++) h[i] = tmp[i] / sum;
    return h;
  }

  // Anti-alias lowpass for the ÷20 (5 kHz of 120 kHz Nyquist) — the Kotlin's.
  const LPF = firwin(121, 5000 / (FS_IN / 2));

  // ── FFT ─────────────────────────────────────────────────────────────────────

  const fftTables = {};
  function fftTable(n) {
    if (fftTables[n]) return fftTables[n];
    let bits = 0;
    while ((1 << bits) < n) bits++;
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0, x = i;
      for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
      rev[i] = r;
    }
    const cos = new Float64Array(n >> 1), sin = new Float64Array(n >> 1);
    for (let i = 0; i < n >> 1; i++) {
      cos[i] = Math.cos(-2 * Math.PI * i / n);
      sin[i] = Math.sin(-2 * Math.PI * i / n);
    }
    fftTables[n] = { rev, cos, sin };
    return fftTables[n];
  }

  // In-place iterative radix-2 FFT. re/im must be a power of two long.
  function fft(re, im) {
    const n = re.length;
    const t = fftTable(n), rev = t.rev, cs = t.cos, sn = t.sin;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (i < j) {
        let x = re[i]; re[i] = re[j]; re[j] = x;
        x = im[i]; im[i] = im[j]; im[j] = x;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1, step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0, w = 0; k < half; k++, w += step) {
          const a = i + k, b = a + half;
          const wr = cs[w], wi = sn[w];
          const vr = re[b] * wr - im[b] * wi;
          const vi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - vr; im[b] = im[a] - vi;
          re[a] += vr; im[a] += vi;
        }
      }
    }
  }

  // ── the three 40-bit frame formats (Alert1Formats.kt) ───────────────────────
  //
  // All four 10-bit UART bytes — start bit, 8 data bits LSB first, stop bit —
  // differing only in how the 32 data bits are used (ALERT2 Application Layer
  // Spec v1.3, Appendix 2):
  //
  //   ALERT Binary (5.1)      markers 01/01/11/11, A12 in byte 2 bit 0, no check
  //   ALERT ASCII (5.2)       four ASCII digits, address and value 0–99
  //   Enhanced iFLOWS (5.3)   byte 0 alone marked (both bits set), A12 in byte 1
  //                           bit 6, CRC-6 in byte 3, x^6 + x^4 + x^3 + 1

  const UART = [0, 9, 10, 19, 20, 29, 30, 39];
  const UART_VAL = [0, 1, 0, 1, 0, 1, 0, 1];
  const MARK = [7, 8, 17, 18, 27, 28, 37, 38];
  const MARK_VAL = [1, 0, 1, 0, 1, 1, 1, 1];
  const CRC6_POLY = 0b011001;

  function uartOk(bits, p) {
    for (let i = 0; i < 8; i++) if (bits[p + UART[i]] !== UART_VAL[i]) return false;
    return true;
  }

  // Four data bytes; bits go out LSB first within a byte.
  function frameBytes(bits, p) {
    const w = [0, 0, 0, 0];
    for (let k = 0; k < 4; k++) {
      let b = 0;
      for (let j = 0; j < 8; j++) if (bits[p + k * 10 + 1 + j]) b |= 1 << j;
      w[k] = b;
    }
    return w;
  }

  // CRC over bytes 0-2 plus D9/D10, LSB first, reflected output. The spec names
  // only the polynomial; this convention was settled against five real 4078
  // frames and validates all of them.
  function crc6Enhanced(b0, b1, b2, b3) {
    let reg = 0;
    const feed = bit => {
      const fb = ((reg >> 5) & 1) ^ bit;
      reg = (reg << 1) & 0x3f;
      if (fb) reg ^= CRC6_POLY;
    };
    [b0, b1, b2].forEach(b => { for (let i = 0; i < 8; i++) feed((b >> i) & 1); });
    feed(b3 & 1);              // D9
    feed((b3 >> 1) & 1);       // D10
    let refl = 0;
    for (let i = 0; i < 6; i++) if ((reg >> i) & 1) refl |= 1 << (5 - i);
    return refl;
  }

  function parseBinaryBytes(w) {
    const sid = (w[0] & 63) + 64 * (w[1] & 63) + 4096 * (w[2] & 1);
    const v = (w[3] & 63) * 32 + ((w[2] & 62) >> 1);
    return { format: BINARY, sensorId: sid, value: v, crcOk: null, fixed: 16, bytes: w };
  }

  function parseAsciiBytes(w) {
    const d = [];
    for (let i = 0; i < 4; i++) {
      if ((w[i] & 0x70) !== 0x30) return null;
      const dig = w[i] & 0x0f;
      if (dig > 9) return null;
      d.push(dig);
    }
    return { format: ASCII, sensorId: d[0] + 10 * d[1], value: d[2] + 10 * d[3], crcOk: null, fixed: 16, bytes: w };
  }

  function parseEnhancedBytes(w) {
    const b0 = w[0], b1 = w[1], b2 = w[2], b3 = w[3];
    if ((b0 >> 6) !== 0b11) return null;
    const sid = (b0 & 63) | ((b1 & 63) << 6) | (((b1 >> 6) & 1) << 12);
    let v = (b1 >> 7) & 1;                                          // D0
    for (let k = 0; k < 8; k++) v |= ((b2 >> k) & 1) << (k + 1);    // D1..D8
    v |= (b3 & 1) << 9;                                             // D9
    v |= ((b3 >> 1) & 1) << 10;                                     // D10
    let crc = 0;
    for (let j = 0; j < 6; j++) crc |= ((b3 >> (2 + j)) & 1) << j;  // C0 at bit 7 … C5 at bit 2, reflected
    const ok = crc6Enhanced(b0, b1, b2, b3) === crc;
    return { format: ENHANCED_IFLOWS, sensorId: sid, value: v, crcOk: ok, fixed: ok ? 16 : 8, bytes: w };
  }

  function parseBytes(w, format) {
    if (format === BINARY) {
      if ((w[0] & 0xc0) !== 0x40 || (w[1] & 0xc0) !== 0x40 || (w[2] & 0xc0) !== 0xc0 || (w[3] & 0xc0) !== 0xc0) return null;
      return parseBinaryBytes(w);
    }
    if (format === ASCII) return parseAsciiBytes(w);
    if (format === ENHANCED_IFLOWS) return parseEnhancedBytes(w);
    return null;
  }

  // A 40-bit frame at bits[p…p+39] under the one enabled format, or null.
  function parseFrame(bits, p, format) {
    if (!uartOk(bits, p)) return null;
    if (format === BINARY) {
      for (let i = 0; i < 8; i++) if (bits[p + MARK[i]] !== MARK_VAL[i]) return null;
    }
    const r = parseBytes(frameBytes(bits, p), format);
    if (!r) return null;
    if (r.value < 0 || r.value > 2047 || r.sensorId < 0 || r.sensorId > 8191) return null;
    return r;
  }

  // The inverse, for the synthesiser and the tests: four data bytes for an
  // address and value under a format.
  function encodeFrame(format, id, value) {
    if (format === BINARY) {
      return [(id & 63) | 0x40, ((id >> 6) & 63) | 0x40,
              ((id >> 12) & 1) | ((value & 31) << 1) | 0xc0, ((value >> 5) & 63) | 0xc0];
    }
    if (format === ASCII) {
      return [0x30 | (id % 10), 0x30 | (Math.floor(id / 10) % 10),
              0x30 | (value % 10), 0x30 | (Math.floor(value / 10) % 10)];
    }
    const b0 = 0xc0 | (id & 63);
    const b1 = ((id >> 6) & 63) | (((id >> 12) & 1) << 6) | ((value & 1) << 7);
    const b2 = (value >> 1) & 0xff;
    let b3 = ((value >> 9) & 1) | (((value >> 10) & 1) << 1);
    const crc = crc6Enhanced(b0, b1, b2, b3);
    for (let j = 0; j < 6; j++) b3 |= ((crc >> j) & 1) << (2 + j);
    return [b0, b1, b2, b3];
  }

  // ── the receive chain ──────────────────────────────────────────────────────

  function u8ToFloat(iq) {
    const n = iq.length >> 1;
    const ir = new Float32Array(n), ii = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 2) { ir[i] = iq[j] - 127.5; ii[i] = iq[j + 1] - 127.5; }
    return { ir, ii };
  }

  // Carrier-offset candidates within ±SEARCH_HZ, DC notched, plus the extent
  // of the window that holds a signal at all.
  //
  // DEPARTS FROM THE KOTLIN, which FFTs the window's first 8192 samples and
  // nothing else. That is right for its test vector, which opens on the burst,
  // and wrong for a 3 s window whose burst starts 2 s in: the first 34 ms is
  // noise, the peaks it offers are noise, and the burst is never looked at.
  // This walks the window in 8192-sample segments, calls a segment "hot" when
  // its 9-bin-smoothed in-band peak clears 10 dB over its median (the
  // desktop's _find_bursts bar — the Kotlin's unsmoothed 6× is cleared by
  // plain noise, the maximum of 680 exponential bins being ~9× their median),
  // and picks candidates from the average of the hot segments by the Kotlin's
  // own rule: ≥ 6× the median, 600 Hz apart, at most three. No hot segment, no
  // candidates — and so no decode of a window that is only noise.
  function carrierSearch(ir, ii, maxCands) {
    maxCands = maxCands || 3;
    const n = SEG;
    const nseg = Math.floor(ir.length / n);
    if (nseg < 1) return { cands: [], hot: null };
    const binHz = FS_IN / n;
    const bins = [], freqs = [];
    for (let i = 0; i < n; i++) {
      const f = i <= n / 2 ? i * binHz : (i - n) * binHz;
      if (Math.abs(f) > SEARCH_HZ || Math.abs(f) <= DC_NOTCH_HZ) continue;
      bins.push(i); freqs.push(f);
    }
    // in frequency order, so the smoothing runs along the spectrum
    const order = bins.map((b, k) => k).sort((a, b) => freqs[a] - freqs[b]);
    const nb = bins.length;
    const re = new Float32Array(n), im = new Float32Array(n);
    const p = new Float64Array(nb), sm = new Float64Array(nb), srt = new Float64Array(nb);
    const acc = new Float64Array(nb);
    let first = -1, last = -1, hot = 0;
    for (let s = 0; s < nseg; s++) {
      re.set(ir.subarray(s * n, s * n + n));
      im.set(ii.subarray(s * n, s * n + n));
      fft(re, im);
      for (let k = 0; k < nb; k++) { const i = bins[order[k]]; p[k] = re[i] * re[i] + im[i] * im[i]; }
      let run = 0, mx = 0;
      for (let k = 0; k < nb; k++) {
        run += p[k];
        if (k >= 9) run -= p[k - 9];
        if (k >= 8) { sm[k] = run / 9; if (sm[k] > mx) mx = sm[k]; } else sm[k] = 0;
      }
      srt.set(p); srt.sort();
      const med = srt[nb >> 1];
      if (mx >= 10 * med) {
        hot++;
        if (first < 0) first = s;
        last = s;
        for (let k = 0; k < nb; k++) acc[k] += p[k];
      }
    }
    if (!hot) return { cands: [], hot: null };
    srt.set(acc); srt.sort();
    const med = srt[nb >> 1];
    const idx = Array.from({ length: nb }, (_, k) => k).sort((a, b) => acc[b] - acc[a]);
    const cands = [];
    for (const k of idx) {
      if (acc[k] < 6 * med) break;
      const f = freqs[order[k]];
      if (cands.every(c => Math.abs(c - f) >= 600)) cands.push(f);
      if (cands.length >= maxCands) break;
    }
    return { cands, hot: [first * n, (last + 1) * n] };
  }

  // Tune to centerHz and decimate ÷20 to 12 kHz with the polyphase lowpass —
  // only the kept samples are computed. The Kotlin's, with its scratch reused.
  let mixR = new Float32Array(0), mixI = new Float32Array(0);
  function mixDecimate(ir, ii, centerHz) {
    const n = ir.length, taps = LPF.length;
    if (mixR.length < n) { mixR = new Float32Array(n); mixI = new Float32Array(n); }
    const w = -2 * Math.PI * centerHz / FS_IN;
    const dr = Math.cos(w), di = Math.sin(w);
    let pr = 1, pi = 0;
    for (let i = 0; i < n; i++) {
      const xr = ir[i], xi = ii[i];
      mixR[i] = xr * pr - xi * pi;
      mixI[i] = xr * pi + xi * pr;
      const nr = pr * dr - pi * di;
      pi = pr * di + pi * dr;
      pr = nr;
      if ((i & 0x3ff) === 0) {             // renormalise so rounding cannot shrink the phasor
        const m = Math.sqrt(pr * pr + pi * pi);
        if (m > 1e-9) { pr /= m; pi /= m; }
      }
    }
    const outN = Math.floor((n - taps) / DECIM);
    if (outN <= 0) return { br: new Float32Array(0), bi: new Float32Array(0) };
    const br = new Float32Array(outN), bi = new Float32Array(outN);
    for (let o = 0, k = taps - 1; o < outN; o++, k += DECIM) {
      let ar = 0, ai = 0;
      for (let t = 0; t < taps; t++) {
        const h = LPF[t], idx = k - t;
        ar += mixR[idx] * h;
        ai += mixI[idx] * h;
      }
      br[o] = ar; bi[o] = ai;
    }
    return { br, bi };
  }

  // The four-sideband soft decision, normalised to zero mean, unit deviation:
  //   d = (|MF(+f1)| + |MF(−f1)|) − (|MF(+f2)| + |MF(−f2)|)
  // Positive is mark (1), negative is space (0).
  //
  // DEPARTS FROM THE KOTLIN in arithmetic only. It correlates every output
  // against each tone over a full symbol, 40 multiplies a sample a tone; this
  // slides the same correlation one sample at a time,
  //   y[i+1] = e^{−jω}·(y[i] − x[i] + x[i+40]·e^{jω·40}),
  // and recomputes it outright every 512 outputs so rounding cannot build up.
  function afskSoft(br, bi) {
    const n = br.length;
    if (n < SPB * 4) return new Float32Array(0);
    const outN = n - SPB + 1;
    const d = new Float64Array(outN);
    const tones = [AFSK_F1, -AFSK_F1, AFSK_F2, -AFSK_F2];
    for (let t = 0; t < 4; t++) {
      const w = 2 * Math.PI * tones[t] / FS_BB;
      const cr = Math.cos(-w), ci = Math.sin(-w);
      const er = Math.cos(w * SPB), ei = Math.sin(w * SPB);
      const sign = t < 2 ? 1 : -1;
      let yr = 0, yi = 0;
      for (let i = 0; i < outN; i++) {
        if ((i & 511) === 0) {
          yr = 0; yi = 0;
          for (let s = 0; s < SPB; s++) {
            const c = Math.cos(w * s), sn = Math.sin(w * s);
            const xr = br[i + s], xi = bi[i + s];
            yr += xr * c - xi * sn;
            yi += xr * sn + xi * c;
          }
        } else {
          const j = i - 1, q = j + SPB;
          const ar = yr - br[j] + (br[q] * er - bi[q] * ei);
          const ai = yi - bi[j] + (br[q] * ei + bi[q] * er);
          yr = ar * cr - ai * ci;
          yi = ar * ci + ai * cr;
        }
        d[i] += sign * Math.sqrt(yr * yr + yi * yi);
      }
    }
    let mean = 0;
    for (let i = 0; i < outN; i++) mean += d[i];
    mean /= outN;
    let sd = 0;
    for (let i = 0; i < outN; i++) { const z = d[i] - mean; sd += z * z; }
    sd = Math.sqrt(sd / outN) + 1e-9;
    const out = new Float32Array(outN);
    for (let i = 0; i < outN; i++) out[i] = (d[i] - mean) / sd;
    return out;
  }

  // Gardner timing recovery — a PI loop steering the sampling instant.
  function gardner(d, sps, kp, ki) {
    kp = kp == null ? 0.02 : kp;
    ki = ki == null ? 0.001 : ki;
    const n = d.length;
    if (n < sps * 4) return new Float32Array(0);
    const interp = pos => {
      const k = Math.floor(pos);
      if (k < 0 || k + 1 >= n) return 0;
      const f = pos - k;
      return d[k] * (1 - f) + d[k + 1] * f;
    };
    const out = [];
    let period = sps, p = sps;
    let prev = interp(p - period);
    let integ = 0;
    while (p < n - 1) {
      const curr = interp(p);
      const mid = interp(p - period / 2);
      let e = mid * (curr - prev);
      e /= (Math.abs(curr) + Math.abs(prev) + 1e-9);
      integ += e;
      const corr = kp * e + ki * integ;
      out.push(curr);
      prev = curr;
      p += period - corr * period;
      period = Math.min(Math.max(period, sps * 0.95), sps * 1.05);
    }
    return Float32Array.from(out);
  }

  // Slice a symbol stream, both polarities, into frames of the chosen format.
  function framesFrom(soft, format, out) {
    const n = soft.length;
    if (n < 40) return;
    const bits = new Uint8Array(n);
    for (let inv = 0; inv < 2; inv++) {
      for (let i = 0; i < n; i++) bits[i] = (inv ? -soft[i] : soft[i]) > 0 ? 1 : 0;
      for (let p = 0; p <= n - 40; p++) {
        const r = parseFrame(bits, p, format);
        if (!r) continue;
        if (r.sensorId === 5461 && r.format === BINARY) continue;   // the 0x55 preamble, never a station
        if (r.crcOk === false) continue;
        r.pos = p; r.inv = inv;
        out.push(r);
      }
    }
  }

  function hex2(b) { return (b < 16 ? '0' : '') + b.toString(16).toUpperCase(); }
  function nowMs() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

  // Decode one window of 240 ksps IQ (two Float32Arrays, DC-centred around 0).
  // Returns the readings that cleared the vote bar, sorted by votes, and a
  // trace of the symbol stream that carried them for the card to draw.
  //
  //   minVotes      bar for frames with no checksum (Binary, ASCII)
  //   minVotesCrc   bar for CRC-bearing frames (Enhanced iFLOWS). A 6-bit CRC is
  //                 a 1-in-64 filter and thousands of bit positions are tried
  //                 per burst, so it lowers the bar; it never replaces consensus.
  //   trim          false decodes the whole window, as the Kotlin did
  function decodeWindow(ir, ii, opts) {
    opts = opts || {};
    const format = opts.format || BINARY;
    const minVotes = opts.minVotes != null ? opts.minVotes : 4;
    const minVotesCrc = opts.minVotesCrc != null ? opts.minVotesCrc : 4;
    const t0 = nowMs();
    const result = { readings: [], candidates: [], trace: null, combos: 0, ms: 0, format };
    if (ir.length < FS_IN / 2) { result.ms = nowMs() - t0; return result; }

    // opts.candidates skips the search — the tests use it to hold the vote bar
    // against noise, which the search would otherwise never let through.
    const search = opts.candidates ? { cands: opts.candidates, hot: null } : carrierSearch(ir, ii);
    result.candidates = search.cands;
    if (!search.cands.length) { result.ms = nowMs() - t0; return result; }

    // Trim to the hot extent, with the desktop's margins (0.25 s before, 0.35
    // s after). The Kotlin decoded the whole window; noise either side only
    // offers the framer more chances to find a frame that is not there.
    let wr = ir, wi = ii;
    if (opts.trim !== false && search.hot) {
      const a = Math.max(0, search.hot[0] - Math.round(0.25 * FS_IN));
      const z = Math.min(ir.length, search.hot[1] + Math.round(0.35 * FS_IN));
      wr = ir.subarray(a, z); wi = ii.subarray(a, z);
    }

    const votes = new Map();
    const best = new Map();
    const traces = [];
    for (const c of search.cands) {
      // The FFT peak is usually a tone line, not the carrier: try c, c−f1, c+f1.
      for (const hyp of [c, c - AFSK_F1, c + AFSK_F1]) {
        // …and a little either side of each. Too few combinations and real
        // frames sit under the bar — that is what made the rig's battery
        // frame drop out on the phone.
        for (const dc of [-150, -75, 0, 75, 150]) {
          const bb = mixDecimate(wr, wi, hyp + dc);
          const d = afskSoft(bb.br, bb.bi);
          if (d.length < SPB * 20) continue;
          result.combos++;
          const frames = [];
          framesFrom(gardner(d, SPB), format, frames);
          // Brute-force symbol phases too: Gardner can fail to lock at low SNR.
          const scores = [];
          for (let ph = 0; ph < SPB; ph++) {
            let s = 0;
            for (let i = ph; i < d.length; i += SPB) s += Math.abs(d[i]);
            scores.push([ph, s]);
          }
          scores.sort((a, b) => b[1] - a[1]);
          let trace = null;
          for (const [ph] of scores.slice(0, 6)) {
            const strideN = Math.floor((d.length - ph + SPB - 1) / SPB);
            if (strideN < 40) continue;
            const s = new Float32Array(strideN);
            for (let k = 0; k < strideN; k++) s[k] = d[ph + k * SPB];
            const from = frames.length;
            framesFrom(s, format, frames);
            if (!trace) trace = { symbols: s, frames: frames.slice(from), energy: scores[0][1] / d.length, carrier: hyp + dc };
          }
          if (trace) traces.push(trace);
          const seen = new Set();
          for (const f of frames) {
            const key = f.sensorId * 4096 + f.value;
            if (!seen.has(key)) { seen.add(key); votes.set(key, (votes.get(key) || 0) + 1); }
            const prev = best.get(key);
            if (!prev || f.fixed > prev.fixed) best.set(key, { fixed: f.fixed, crc: f.crcOk === true, bytes: f.bytes, inv: f.inv, carrier: hyp + dc });
          }
        }
      }
    }

    const accepted = new Set();
    for (const [key, v] of votes) {
      const meta = best.get(key);
      const need = meta.crc ? minVotesCrc : minVotes;
      if (v < need) continue;
      accepted.add(key);
      result.readings.push({
        sensorId: Math.floor(key / 4096), value: key % 4096, votes: v,
        fixed: meta.fixed, crcOk: format === ENHANCED_IFLOWS ? meta.crc : null, format,
        bytes: meta.bytes.slice(), hex: meta.bytes.map(hex2).join(' '),
        polarity: meta.inv ? 'NEG' : 'STD', carrierHz: Math.round(meta.carrier),
      });
    }
    result.readings.sort((a, b) => b.votes - a.votes);

    // Bit-flip shadows. ALERT Binary carries no check, so a strong burst whose
    // symbols slip in a few of the 45 combinations hands the vote a frame one
    // or two bits from the real one — 2080 = 143 at 4 votes riding on 2088 =
    // 143 at 26, in the demo band. A reading within two bits of one with three
    // times its votes is that, and is reported as a shadow rather than as a
    // station (the Bit Flipper tab is about exactly this ghosting). Two real
    // stations in one burst score alike, so the ratio never separates them.
    // ADDED HERE; the Kotlin has no such rule.
    const bitsApart = (a, b) => {
      let n = 0;
      for (let k = 0; k < 4; k++) { let x = a[k] ^ b[k]; while (x) { n += x & 1; x >>= 1; } }
      return n;
    };
    result.shadows = [];
    result.readings = result.readings.filter(r => {
      const big = result.readings.find(o => o !== r && o.votes >= 3 * r.votes && bitsApart(o.bytes, r.bytes) <= 2);
      if (!big) return true;
      result.shadows.push({ sensorId: r.sensorId, value: r.value, votes: r.votes, of: big.sensorId + '=' + big.value });
      accepted.delete(r.sensorId * 4096 + r.value);
      return false;
    });

    // The stream to draw: the one carrying the most accepted frames, else the
    // most energetic — a burst heard but not decoded is still worth seeing.
    let pick = null, pickScore = -1;
    for (const t of traces) {
      const hits = t.frames.filter(f => accepted.has(f.sensorId * 4096 + f.value)).length;
      const score = hits * 1000 + t.energy;
      if (score > pickScore) { pickScore = score; pick = t; }
    }
    if (pick) {
      result.trace = {
        symbols: pick.symbols, carrierHz: Math.round(pick.carrier),
        frames: pick.frames.filter(f => accepted.has(f.sensorId * 4096 + f.value))
          .map(f => ({ pos: f.pos, inv: f.inv, sensorId: f.sensorId, value: f.value })),
      };
    }
    result.ms = nowMs() - t0;
    return result;
  }

  // The Kotlin's entry point: interleaved u8 IQ, as rtl_tcp and the dongle deliver it.
  function decodeU8(iq, opts) {
    const f = u8ToFloat(iq);
    return decodeWindow(f.ir, f.ii, opts);
  }

  // ── synthesiser ──────────────────────────────────────────────────────────────
  //
  // An ALERT burst as the dongle would hand it over: AFSK on narrowband FM,
  // noise, quantised to u8 IQ. For the demo connection (so the card shows what
  // a real burst looks like with nothing plugged in) and for the tests' round
  // trip. Not a model of any particular transmitter.

  function rng(seed) {
    let a = (seed >>> 0) || 0x9e3779b9;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  //   frames     [[b0,b1,b2,b3], …] data bytes, sent back to back
  //   seconds    total length; the burst starts at startSec
  //   snrDb      in a 12 kHz channel, for the burst at amplitude `amp`
  //   bursts     several bursts instead: [{ startSec, frames, cfoHz, amp, polarity }]
  //   carriers   other signals: [{ hz, amp, fmHz, fmDev }] — a carrier, FM'd by a
  //              slow tone if fmHz is given (an interferer for the demo's spectrum)
  function bitsFor(frames, neg, leadSec, tailSec) {
    const bits = [];
    const lead = Math.round((leadSec != null ? leadSec : 0.12) * BAUD);
    for (let i = 0; i < lead; i++) bits.push(neg ? 0 : 1);
    (frames || []).forEach(w => {
      w.forEach(b => {
        bits.push(neg ? 1 : 0);
        for (let j = 0; j < 8; j++) { const v = (b >> j) & 1; bits.push(neg ? 1 - v : v); }
        bits.push(neg ? 0 : 1);
      });
    });
    const tail = Math.round((tailSec != null ? tailSec : 0.05) * BAUD);
    for (let i = 0; i < tail; i++) bits.push(neg ? 0 : 1);
    return bits;
  }

  function synthIq(o) {
    o = o || {};
    const fs = o.fs || FS_IN;
    const seconds = o.seconds || 1;
    const dev = o.devHz || 3000;
    const amp0 = o.amp || 40;
    const snrDb = o.snrDb != null ? o.snrDb : 30;
    const rand = rng(o.seed || 1);
    const bursts = (o.bursts || [{ startSec: o.startSec != null ? o.startSec : 0.2, frames: o.frames, cfoHz: o.cfoHz, amp: amp0, polarity: o.polarity }])
      .map(b => {
        const bits = bitsFor(b.frames, b.polarity === 'NEG', o.leadSec, o.tailSec);
        const s0 = Math.round((b.startSec || 0) * fs);
        return { bits, s0, s1: s0 + Math.round(bits.length * fs / BAUD), cfo: b.cfoHz || 0, amp: b.amp || amp0, tone: 0, ph: 0 };
      });
    const carriers = (o.carriers || []).map(c => Object.assign({ ph: 0, mph: 0 }, c));
    const n = Math.round(seconds * fs);
    const out = new Uint8Array(n * 2);
    const sigma = amp0 / Math.sqrt(2 * Math.pow(10, snrDb / 10) * (FS_BB / fs));
    let spare = null;
    const gauss = () => {
      if (spare != null) { const s = spare; spare = null; return s; }
      let u = 0;
      while (u === 0) u = rand();
      const v = rand(), m = Math.sqrt(-2 * Math.log(u));
      spare = m * Math.sin(2 * Math.PI * v);
      return m * Math.cos(2 * Math.PI * v);
    };
    for (let i = 0; i < n; i++) {
      let re = sigma * gauss(), im = sigma * gauss();
      for (const b of bursts) {
        if (i < b.s0 || i >= b.s1) continue;
        const bit = b.bits[Math.min(b.bits.length - 1, Math.floor((i - b.s0) * BAUD / fs))];
        b.tone += 2 * Math.PI * (bit ? AFSK_F1 : AFSK_F2) / fs;
        b.ph += 2 * Math.PI * (b.cfo + dev * Math.sin(b.tone)) / fs;
        re += b.amp * Math.cos(b.ph);
        im += b.amp * Math.sin(b.ph);
      }
      for (const c of carriers) {
        c.mph += 2 * Math.PI * (c.fmHz || 0) / fs;
        c.ph += 2 * Math.PI * (c.hz + (c.fmDev || 0) * Math.sin(c.mph)) / fs;
        re += c.amp * Math.cos(c.ph);
        im += c.amp * Math.sin(c.ph);
      }
      out[2 * i] = Math.max(0, Math.min(255, Math.round(127.5 + re)));
      out[2 * i + 1] = Math.max(0, Math.min(255, Math.round(127.5 + im)));
    }
    return out;
  }

  // The demo band: twelve seconds at 240 ksps, looped. Three stations at
  // three strengths — one comfortably decodable, one middling, one at the
  // edge — on the channel centre, and two other users of the band for the
  // spectrum and waterfall to show. The station addresses are the Quansheng
  // firmware's own examples.
  function demoBand() {
    const B = (id, v) => encodeFrame(BINARY, id, v);
    return synthIq({
      fs: FS_IN, seconds: 12, amp: 30, snrDb: 30, seed: 11,
      bursts: [
        { startSec: 1.2, frames: [B(2088, 143)], cfoHz: 350, amp: 30 },
        { startSec: 5.0, frames: [B(2443, 142), B(2442, 23)], cfoHz: -220, amp: 14 },
        { startSec: 8.6, frames: [B(4109, 1290), B(4110, 12)], cfoHz: 120, amp: 6 },
      ],
      carriers: [{ hz: 62500, amp: 5 }, { hz: -37500, amp: 3, fmHz: 0.7, fmDev: 2500 }, { hz: 100000, amp: 1.5 }],
    });
  }

  // ── streaming pieces for the live card ───────────────────────────────────────

  // Mix by −offset and FIR-decimate by `factor`, keeping filter history across
  // chunks so a stream cut into USB transfers filters as one signal.
  class Decimator {
    constructor(inRate, factor, cutoffHz, taps) {
      this.inRate = inRate;
      this.factor = Math.max(1, factor | 0);
      this.h = this.factor > 1 ? firwin(taps | 1, Math.min(0.95, cutoffHz / (inRate / 2))) : new Float32Array([1]);
      const H = this.h.length - 1;
      this.hr = new Float32Array(H);
      this.hi = new Float32Array(H);
      this.next = H;
      this.pr = 1; this.pi = 0;
      this.setOffset(0);
      this.er = new Float32Array(0); this.ei = new Float32Array(0);
      this.count = 0;
    }
    setOffset(hz) {
      this.offset = hz || 0;
      const w = -2 * Math.PI * this.offset / this.inRate;
      this.dr = Math.cos(w); this.di = Math.sin(w);
    }
    process(ir, ii) {
      const h = this.h, L = h.length, H = L - 1, n = ir.length, F = this.factor;
      const mix = this.offset !== 0;
      if (F === 1 && !mix) return { r: ir, i: ii };
      if (this.er.length < H + n) { this.er = new Float32Array(H + n); this.ei = new Float32Array(H + n); }
      const er = this.er, ei = this.ei;
      er.set(this.hr); ei.set(this.hi);
      let pr = this.pr, pi = this.pi;
      const dr = this.dr, di = this.di;
      for (let i = 0; i < n; i++) {
        const xr = ir[i], xi = ii[i];
        if (mix) {
          er[H + i] = xr * pr - xi * pi;
          ei[H + i] = xr * pi + xi * pr;
          const nr = pr * dr - pi * di;
          pi = pr * di + pi * dr;
          pr = nr;
          if ((++this.count & 0x3ff) === 0) {
            const m = Math.sqrt(pr * pr + pi * pi);
            if (m > 1e-9) { pr /= m; pi /= m; }
          }
        } else {
          er[H + i] = xr; ei[H + i] = xi;
        }
      }
      this.pr = pr; this.pi = pi;
      const total = H + n;
      let k = this.next;
      const count = k < total ? Math.floor((total - 1 - k) / F) + 1 : 0;
      const outR = new Float32Array(count), outI = new Float32Array(count);
      for (let o = 0; o < count; o++, k += F) {
        let ar = 0, ai = 0;
        for (let t = 0; t < L; t++) { const c = h[t]; ar += er[k - t] * c; ai += ei[k - t] * c; }
        outR[o] = ar; outI[o] = ai;
      }
      this.next = k - n;
      if (H) { this.hr.set(er.subarray(n, n + H)); this.hi.set(ei.subarray(n, n + H)); }
      return { r: outR, i: outI };
    }
  }

  // Goertzel power of one tone over the last `len` samples of a ring.
  function goertzel(buf, start, len, freq, fs) {
    const w = 2 * Math.PI * freq / fs, c = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    const n = buf.length;
    for (let k = 0; k < len; k++) {
      const x = buf[(start + k) % n];
      const s = x + c * s1 - s2;
      s2 = s1; s1 = s;
    }
    return (s1 * s1 + s2 * s2 - c * s1 * s2) / (len * len);
  }

  function db(p) { return 10 * Math.log10(p + 1e-20); }

  // Sample rates the card offers: every one an integer multiple of 240k, so
  // the channel decimates to the decoder's rate exactly. All are inside the
  // RTL2832U's two valid bands (225–300 k and 0.9–3.2 M).
  const DEVICE_RATES = [240000, 960000, 1200000, 1920000, 2400000];

  // The live receive pipeline: device-rate u8 chunks in, posted messages out.
  // The worker wraps one; so does the main-thread fallback. `post(msg,
  // transfer)` is the only way out.
  class Pipeline {
    constructor(post) {
      this.post = post;
      this.cfg = {
        deviceRate: FS_IN, channelOffsetHz: 0, format: BINARY, minVotes: 4, minVotesCrc: 4,
        gate: true, squelchDb: 8, fftSize: 2048, specHz: 20, scopeHz: 15, audio: false,
      };
      this.reset();
    }

    configure(c) {
      const before = this.cfg;
      this.cfg = Object.assign({}, this.cfg, c || {});
      if (before.deviceRate !== this.cfg.deviceRate || before.fftSize !== this.cfg.fftSize) this.reset();
      else if (before.channelOffsetHz !== this.cfg.channelOffsetHz) this.dec1.setOffset(this.cfg.channelOffsetHz);
    }

    reset() {
      const c = this.cfg;
      const factor = Math.max(1, Math.round(c.deviceRate / FS_IN));
      // Device rate → 240k: keep ±60 kHz flat, stop by ±120 kHz.
      const taps = factor > 1 ? Math.min(255, 2 * Math.floor(1.65 * c.deviceRate / 60000) + 1) : 1;
      this.dec1 = new Decimator(c.deviceRate, factor, 60000, taps);
      this.dec1.setOffset(c.channelOffsetHz);
      // 240k → 12k channel, the decoder's own lowpass, for the gate, the audio
      // and the scope.
      this.dec2 = new Decimator(FS_IN, DECIM, 5000, 121);
      const CAP = FS_IN * 8;                       // 8 s of 240k IQ for decode windows
      this.ringR = new Float32Array(CAP);
      this.ringI = new Float32Array(CAP);
      this.capU8 = new Uint8Array(FS_IN * 2 * 10); // 10 s for "capture IQ"
      this.total = 0;                              // 240k samples ever written
      // spectrum
      const N = c.fftSize;
      this.specR = new Float32Array(N); this.specI = new Float32Array(N);
      this.specFill = 0; this.specPos = 0;
      this.specAvg = new Float64Array(N); this.specAvgN = 0;
      this.sinceFft = 0; this.sincePost = 0;
      this.win = new Float32Array(N);
      let wsum = 0;
      for (let i = 0; i < N; i++) {                // Blackman–Harris
        const x = 2 * Math.PI * i / (N - 1);
        this.win[i] = 0.35875 - 0.48829 * Math.cos(x) + 0.14128 * Math.cos(2 * x) - 0.01168 * Math.cos(3 * x);
        wsum += this.win[i];
      }
      this.specNorm = 1 / (wsum * wsum * 127.5 * 127.5);
      // ADC
      this.hist = new Uint32Array(32); this.clip = 0; this.bytes = 0; this.pwr = 0; this.sinceLevel = 0;
      // channel, gate, audio
      this.audio = new Float32Array(4096); this.audioPos = 0;
      this.lastR = 0; this.lastI = 0;
      this.blkP = 0; this.blkN = 0;
      this.nf = null; this.nfInit = []; this.chDb = -200;
      this.open = false; this.openRun = 0; this.closeRun = 0;
      this.burst = null; this.pending = [];
      this.sinceScope = 0; this.sinceDecode = 0;
      this.audioOut = []; this.audioOutN = 0;
      this.recent = new Map();
      this.bursts = 0; this.decodes = 0;
    }

    feed(u8) {
      const c = this.cfg;
      const n = u8.length >> 1;
      if (!n) return;
      const ir = new Float32Array(n), ii = new Float32Array(n);
      let pw = 0, clip = 0;
      const hist = this.hist;
      for (let i = 0, j = 0; i < n; i++, j += 2) {
        const a = u8[j], b = u8[j + 1];
        hist[a >> 3]++; hist[b >> 3]++;
        if (a <= 1 || a >= 254) clip++;
        if (b <= 1 || b >= 254) clip++;
        const x = a - 127.5, y = b - 127.5;
        ir[i] = x; ii[i] = y;
        pw += x * x + y * y;
      }
      this.clip += clip; this.bytes += 2 * n; this.pwr += pw;

      this.feedSpectrum(ir, ii, n);

      // device rate → 240k channel
      const ch = this.dec1.process(ir, ii);
      const m = ch.r.length;
      const CAP = this.ringR.length;
      const passthrough = this.dec1.factor === 1 && !this.dec1.offset;
      for (let k = 0; k < m; k++) {
        const pos = (this.total + k) % CAP;
        this.ringR[pos] = ch.r[k]; this.ringI[pos] = ch.i[k];
        const cp = ((this.total + k) % (this.capU8.length >> 1)) * 2;
        if (passthrough) { this.capU8[cp] = u8[2 * k]; this.capU8[cp + 1] = u8[2 * k + 1]; }
        else {
          this.capU8[cp] = Math.max(0, Math.min(255, Math.round(ch.r[k] + 127.5)));
          this.capU8[cp + 1] = Math.max(0, Math.min(255, Math.round(ch.i[k] + 127.5)));
        }
      }
      this.total += m;

      // 240k → 12k channel: FM audio, the gate, the scope
      const bb = this.dec2.process(ch.r, ch.i);
      this.feedChannel(bb.r, bb.i);

      // level report, ~10 a second
      this.sinceLevel += n;
      if (this.sinceLevel >= c.deviceRate / 10) {
        const msg = {
          type: 'level',
          dbfs: db(this.pwr / Math.max(1, this.bytes / 2) / (2 * 127.5 * 127.5)),
          clipPct: 100 * this.clip / Math.max(1, this.bytes),
          hist: Array.from(this.hist),
          chDb: this.chDb, nfDb: this.nf, open: this.open, squelchDb: c.squelchDb,
          bursts: this.bursts, decodes: this.decodes,
        };
        this.post(msg);
        this.hist.fill(0); this.clip = 0; this.bytes = 0; this.pwr = 0; this.sinceLevel = 0;
      }

      // ungated: decode the last 3 s every 1.5 s, as the desktop does
      if (!c.gate) {
        this.sinceDecode += m;
        if (this.sinceDecode >= FS_IN * 1.5 && this.total >= FS_IN * 3) {
          this.sinceDecode = 0;
          this.decodeRange(this.total - FS_IN * 3, this.total, null);
        }
      }
      // gated: a closed burst's window once the margin after it has arrived
      while (this.pending.length && this.total >= this.pending[0].decodeAt) {
        const b = this.pending.shift();
        this.decodeRange(b.from, Math.min(b.to, this.total), b);
      }
    }

    feedSpectrum(ir, ii, n) {
      const c = this.cfg, N = c.fftSize;
      for (let i = 0; i < n; i++) {
        this.specR[this.specPos] = ir[i]; this.specI[this.specPos] = ii[i];
        this.specPos = (this.specPos + 1) % N;
      }
      this.specFill = Math.min(N, this.specFill + n);
      this.sinceFft += n; this.sincePost += n;
      if (this.specFill >= N && this.sinceFft >= c.deviceRate / (c.specHz * 4)) {
        this.sinceFft = 0;
        const re = new Float32Array(N), im = new Float32Array(N);
        for (let k = 0; k < N; k++) {
          const p = (this.specPos + k) % N, w = this.win[k];
          re[k] = this.specR[p] * w; im[k] = this.specI[p] * w;
        }
        fft(re, im);
        for (let k = 0; k < N; k++) this.specAvg[k] += (re[k] * re[k] + im[k] * im[k]);
        this.specAvgN++;
      }
      if (this.sincePost >= c.deviceRate / c.specHz && this.specAvgN) {
        this.sincePost = 0;
        const out = new Float32Array(N);
        const half = N >> 1;
        for (let k = 0; k < N; k++) {
          const src = (k + half) % N;               // fftshift: negative frequencies first
          out[k] = db(this.specAvg[src] / this.specAvgN * this.specNorm);
        }
        this.specAvg.fill(0); this.specAvgN = 0;
        const sorted = Float32Array.from(out).sort();
        const floorDb = sorted[Math.floor(N * 0.3)];
        this.post({ type: 'spectrum', db: out, floorDb, peakDb: sorted[N - 1], rate: c.deviceRate }, [out.buffer]);
      }
    }

    feedChannel(br, bi) {
      const c = this.cfg, n = br.length;
      if (!n) return;
      const A = this.audio, AN = A.length;
      let lr = this.lastR, li = this.lastI;
      const out = c.audio ? new Float32Array(n) : null;
      for (let i = 0; i < n; i++) {
        const xr = br[i], xi = bi[i];
        // FM discriminator: the angle between successive samples, in Hz
        const re = xr * lr + xi * li, im = xi * lr - xr * li;
        const hz = Math.atan2(im, re) * FS_BB / (2 * Math.PI);
        lr = xr; li = xi;
        A[this.audioPos] = hz;
        this.audioPos = (this.audioPos + 1) % AN;
        if (out) out[i] = Math.max(-1, Math.min(1, hz / 5000));
        // the gate: 10 ms blocks of channel power
        this.blkP += xr * xr + xi * xi;
        if (++this.blkN === FS_BB / 100) this.gateBlock();
      }
      this.lastR = lr; this.lastI = li;
      if (out) this.post({ type: 'audio', pcm: out, rate: FS_BB }, [out.buffer]);
      this.sinceScope += n;
      if (this.sinceScope >= FS_BB / c.scopeHz) {
        this.sinceScope = 0;
        const L = 1024, scope = new Float32Array(L);
        for (let k = 0; k < L; k++) scope[k] = A[(this.audioPos - L + k + AN) % AN];
        const g = 480;   // 40 ms: 12 symbols
        const st = (this.audioPos - g + AN) % AN;
        const mark = goertzel(A, st, g, AFSK_F1, FS_BB);
        const space = goertzel(A, st, g, AFSK_F2, FS_BB);
        const ref = goertzel(A, st, g, 3600, FS_BB);
        // the audio's own spectrum, 0–6 kHz in 128 bins: where the two tones show
        const N = 256, re = new Float32Array(N), im = new Float32Array(N);
        for (let k = 0; k < N; k++) re[k] = A[(this.audioPos - N + k + AN) % AN] * (0.5 - 0.5 * Math.cos(2 * Math.PI * k / (N - 1)));
        fft(re, im);
        const aspec = new Float32Array(N / 2);
        for (let k = 0; k < N / 2; k++) aspec[k] = db((re[k] * re[k] + im[k] * im[k]) / (N * N));
        this.post({ type: 'scope', audio: scope, aspec, rate: FS_BB, mark, space, ref, open: this.open }, [scope.buffer, aspec.buffer]);
      }
    }

    gateBlock() {
      const c = this.cfg;
      const p = db(this.blkP / this.blkN / (2 * 127.5 * 127.5));
      this.blkP = 0; this.blkN = 0;
      this.chDb = p;
      if (this.nf == null) {
        this.nfInit.push(p);
        if (this.nfInit.length >= 30) { this.nf = Math.min.apply(null, this.nfInit); this.nfInit = []; }
        return;
      }
      const thr = this.nf + c.squelchDb;
      if (!this.open) {
        // A ~30 s average of the closed channel, like the radio's own; quick
        // to follow it down, slow to follow it up.
        this.nf += (p - this.nf) * (p < this.nf ? 0.05 : 1 / 3000);
        if (p >= thr) {
          if (++this.openRun >= 2) {
            this.open = true; this.closeRun = 0;
            this.burst = { from: this.total - 2 * (FS_IN / 100), peak: p, nf: this.nf, t: Date.now() };
          }
        } else this.openRun = 0;
        return;
      }
      if (p > this.burst.peak) this.burst.peak = p;
      const long = this.total - this.burst.from >= FS_IN * 3;
      if (p < thr - 3) this.closeRun++; else this.closeRun = 0;
      if (this.closeRun >= 10 || long) {
        this.open = false; this.openRun = 0;
        const b = this.burst;
        b.to = this.total - (long ? 0 : this.closeRun * (FS_IN / 100));
        b.ms = Math.round((b.to - b.from) / FS_IN * 1000);
        this.burst = null;
        if (b.ms < 60) return;
        this.bursts++;
        const pad = Math.round(0.4 * FS_IN);
        let from = b.from - pad, to = b.to + pad;
        const minLen = FS_IN * 1.2;
        if (to - from < minLen) { const grow = (minLen - (to - from)) / 2; from -= grow; to += grow; }
        b.from = Math.max(Math.max(0, this.total - this.ringR.length + FS_IN / 10), Math.round(from));
        b.to = Math.round(to);
        b.decodeAt = b.to;
        this.post({ type: 'burst', ms: b.ms, peakDb: b.peak, nfDb: b.nf, t: b.t });
        this.pending.push(b);
      }
    }

    decodeRange(from, to, burst) {
      const c = this.cfg, CAP = this.ringR.length;
      from = Math.max(from, this.total - CAP + 1, 0);
      const len = to - from;
      if (len < FS_IN / 2) return;
      const wr = new Float32Array(len), wi = new Float32Array(len);
      for (let k = 0; k < len; k++) { const p = (from + k) % CAP; wr[k] = this.ringR[p]; wi[k] = this.ringI[p]; }
      const r = decodeWindow(wr, wi, { format: c.format, minVotes: c.minVotes, minVotesCrc: c.minVotesCrc });
      // the same reading from overlapping windows is one reading
      const now = Date.now();
      for (const [k, t] of this.recent) if (now - t > 10000) this.recent.delete(k);
      const fresh = r.readings.filter(x => {
        const k = x.sensorId * 4096 + x.value;
        const dup = this.recent.has(k);
        this.recent.set(k, now);
        return !dup;
      });
      this.decodes += fresh.length;
      const trace = r.trace;
      const transfer = trace ? [trace.symbols.buffer] : [];
      this.post({
        type: 'decode', readings: fresh, all: r.readings.length, shadows: r.shadows || [], candidates: r.candidates,
        ms: Math.round(r.ms), combos: r.combos, seconds: len / FS_IN, format: c.format,
        burst: burst ? { ms: burst.ms, peakDb: burst.peak, nfDb: burst.nf, t: burst.t } : null, trace,
      }, transfer);
    }

    decodeNow(seconds) {
      const len = Math.round(Math.min(8, seconds || 3) * FS_IN);
      this.decodeRange(this.total - len, this.total, null);
    }

    // A source with no dongle: the demo band, looped in real time. The worker
    // runs it, so a demo costs the page nothing.
    demo(on) {
      clearInterval(this.demoTimer);
      this.demoTimer = null;
      if (!on) return;
      if (!this.demoBuf) this.demoBuf = demoBand();
      this.configure({ deviceRate: FS_IN, channelOffsetHz: 0 });
      let pos = 0;
      const chunk = FS_IN / 10 * 2;
      this.demoTimer = setInterval(() => {
        const buf = this.demoBuf;
        const end = Math.min(buf.length, pos + chunk);
        this.feed(buf.subarray(pos, end));
        pos = end >= buf.length ? 0 : end;
      }, 100);
    }

    capture(seconds) {
      const per = this.capU8.length >> 1;
      const len = Math.min(per, this.total, Math.round((seconds || 3) * FS_IN));
      const out = new Uint8Array(len * 2);
      const start = this.total - len;
      for (let k = 0; k < len; k++) {
        const p = ((start + k) % per) * 2;
        out[2 * k] = this.capU8[p]; out[2 * k + 1] = this.capU8[p + 1];
      }
      this.post({ type: 'capture', buf: out.buffer, rate: FS_IN, seconds: len / FS_IN }, [out.buffer]);
    }
  }

  // The worker's whole program. Runs inside the Worker, where AlertDsp is the
  // copy of this module workerSource() put in front of it.
  function workerMain() {
    /* global self, AlertDsp */
    const pipe = new AlertDsp.Pipeline((msg, transfer) => self.postMessage(msg, transfer || []));
    self.onmessage = e => {
      const m = e.data || {};
      try {
        if (m.type === 'iq') pipe.feed(new Uint8Array(m.buf));
        else if (m.type === 'config') pipe.configure(m.cfg);
        else if (m.type === 'reset') pipe.reset();
        else if (m.type === 'capture') pipe.capture(m.seconds);
        else if (m.type === 'decodeNow') pipe.decodeNow(m.seconds);
        else if (m.type === 'demo') pipe.demo(m.on);
      } catch (err) {
        self.postMessage({ type: 'error', message: String((err && err.message) || err) });
      }
    };
    self.postMessage({ type: 'ready' });
  }

  // Source for a Blob-URL Worker: this module rebuilt from its own text, then
  // the worker program. No second file, so nothing to keep in step and
  // nothing the load-order contract has to know about.
  function workerSource() {
    return 'const AlertDsp = (' + alertDspModule.toString() + ')();\n(' + workerMain.toString() + ')();\n';
  }

  return {
    FS_IN, FS_BB, DECIM, BAUD, SPB, AFSK_F1, AFSK_F2, FORMATS, DEVICE_RATES,
    BINARY, ASCII, ENHANCED_IFLOWS,
    firwin, fft, crc6Enhanced, parseBytes, parseFrame, encodeFrame, frameBytes,
    carrierSearch, mixDecimate, afskSoft, gardner, decodeWindow, decodeU8, u8ToFloat,
    synthIq, demoBand, Decimator, Pipeline, workerSource,
  };
})();

// test/alertdsp.mjs requires this same file and decodes a real off-air burst
// with it, so the decoder the browser runs is the decoder the check runs.
// Guarded so the browser, where `module` is undefined, never runs it.
// Constrains nothing below it.
if (typeof module !== 'undefined' && module.exports) module.exports = AlertDsp;
