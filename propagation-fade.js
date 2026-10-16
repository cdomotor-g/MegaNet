// MegaNet — propagation-fade.js
//
//   PropFade   section 6 of the 🎓 Radio Propagation tab: the fade-margin test,
//              as a bench you can run. A field station's radio sends its test
//              transmission through a step attenuator (0–30 dB in 1 dB clicks)
//              to a repeater on a hill. Auto runs the test the way it is run on
//              site, one step at a time, and starts again when it is done;
//              Manual hands over the attenuator, the test button and every
//              setting. Around the bench: where the decibels go (in decibels,
//              and in watts to show why nobody uses watts), the same 3 dB at
//              1, 5 and 25 W, how far each reaches, and what testing in 3 dB
//              steps rather than 5 dB steps does to the reading.
//
// After propagation-physics.js (the horizon, free space, the seeded rng),
// before propagation.js, which puts render() in its page and calls mount()
// from its init() and unmount() from its teardown. Reaches back to core.js for
// esc, cssVar and announce, at call time. Nothing runs at load.
//
// ── What is exact, and what is a model ──────────────────────────────────────
// Exact: watts to dBm, the attenuator, antenna gains (a dBd is 2.15 dB more in
// dBi), the sum the budget is, the radio horizon (k = 4/3, PropPhysics), and
// what a test in steps reads for a given margin — which is the whole of the
// 3 dB / 5 dB comparison, and needs no propagation model at all.
//
// A model, to show the trend and not to price a path: the path loss. It is
// Okumura–Hata, the land-mobile planning model fitted at 150–1500 MHz, with
// its open, suburban and urban classes standing in for open country, rolling
// country under light timber, and hills under dense timber; never less than
// free space; and past the radio horizon, ITU-R P.526's smooth-Earth slope
// (about half a decibel a kilometre at 151.5 MHz). The link budget card on the
// Stations map prices a real path over its real terrain; this one is a place
// to try things.
//
// The receiver is the link budget card's −117 dBm, the feeders its
// LB_DEFAULT_LOSS_DB, the bands its LB_MARGIN, the field station's antenna
// PATH_DEFAULT_AGL up and the attenuator's limit the Network Review's
// ATTEN_MAX — restated here so the model loads into Node with no app around
// it, and held to those files by test/propagation.mjs.
//
// ── How it runs ─────────────────────────────────────────────────────────────
// One animation loop, only while the bench is on screen and something is
// moving (Auto playing, a transmission in flight, the meter's needle settling);
// Auto's clock is that loop's, so it pauses when the bench is scrolled away.
// A device asking for reduced motion gets Auto still, at its outcome — every
// step tested and the reading booked — with ▶ to run it.
//
// Exposes: the model (POWERS, ANTENNAS, COUNTRY, STEPS, F_MHZ, RX_DBM,
//          FEED_DB, FIELD_AGL, RX_GAIN_DBI, DIPOLE_DBI, ATTEN_MAX, GOOD_DB,
//          FLOOR_DB, FLUTTER_DB, wattsToDbm, dbmToWatts, hataDb, hataSlope,
//          horizonKm, shadowDbPerKm, pathLossDb, budget, band, reading,
//          coarseFine, rangeKm, fmtW, zerosW) and the page (render, mount,
//          unmount, mode, power, antenna, country, step, set, atten, bump,
//          send, play, restart, clearLog, flutter, view, stationMargin, state).

const PropFade = (function () {
  const PH = () => PropPhysics;
  const lg = Math.log10;

  // ── The model ──────────────────────────────────────────────────────────────

  const F_MHZ = 151.5;
  const RX_DBM = -117;            // the link budget card's receiver (PropPhysics.SENS_DBM)
  const FEED_DB = 0.5;            // LB_DEFAULT_LOSS_DB: a few metres of LMR-400, at each end
  const FIELD_AGL = 4;            // m, PATH_DEFAULT_AGL: the field station's antenna
  const RX_GAIN_DBI = 5.15;       // the repeater's 3 dBd collinear
  const DIPOLE_DBI = 2.15;        // a dBd is a decibel over a half-wave dipole, itself 2.15 dBi
  const ATTEN_MAX = 30;           // network-review.js: most field attenuators stop here
  const GOOD_DB = 10;             // LB_MARGIN: Good from 10 dB …
  const FLOOR_DB = 3;             // … Marginal from 3, Poor under it
  const FLUTTER_DB = 2;           // σ of the fading "Real-world flutter" adds to each transmission

  const POWERS = [
    { w: 1, label: '1 W' },
    { w: 5, label: '5 W' },
    { w: 25, label: '25 W' },
  ];
  const ANTENNAS = {
    unity: { label: 'Unity-gain whip', lower: 'a unity-gain whip', short: 'Unity (0 dBd)', dbd: 0, beam: false },
    col3:  { label: '3 dB collinear', lower: 'a 3 dB collinear', short: '3 dB collinear', dbd: 3, beam: false },
    yagi:  { label: 'Yagi', lower: 'a Yagi', short: 'Yagi (9 dBd)', dbd: 9, beam: true },
  };
  const COUNTRY = {
    open:  { label: 'Open country', hata: 'open' },
    light: { label: 'Rolling, light timber', hata: 'suburban' },
    dense: { label: 'Hills, dense timber', hata: 'urban' },
  };
  const STEPS = [3, 5];

  const wattsToDbm = w => 10 * lg(w * 1000);
  const dbmToWatts = d => Math.pow(10, (d - 30) / 10);

  // Okumura–Hata, dB, between a field station hmM up and a repeater hbM up
  // (its height above the country around it), dKm apart. `cls` is Hata's
  // 'open', 'suburban' or 'urban' — the corrections are Hata's own.
  function hataDb(dKm, cls, hbM, hmM = FIELD_AGL, fMHz = F_MHZ) {
    const lf = lg(fMHz), lh = lg(hbM);
    const ahm = (1.1 * lf - 0.7) * hmM - (1.56 * lf - 0.8);
    const urban = 69.55 + 26.16 * lf - 13.82 * lh - ahm + (44.9 - 6.55 * lh) * lg(dKm);
    if (cls === 'urban') return urban;
    if (cls === 'suburban') return urban - 2 * lg(fMHz / 28) ** 2 - 5.4;
    return urban - 4.78 * lf * lf + 18.33 * lf - 40.94;
  }
  // What ten times the distance costs in Hata, dB — "a doubling costs" is 0.3 of it.
  const hataSlope = hbM => 44.9 - 6.55 * lg(hbM);

  // The radio horizon between the field station's antenna and the repeater's.
  function horizonKm(hbM) { return PH().horizonKm(FIELD_AGL) + PH().horizonKm(hbM); }

  // ITU-R P.526's smooth Earth in its shadow: F(X) = 11 + 10 log X − 17.6 X,
  // X = 2.188 f^⅓ aₑ^−⅔ d. The −17.6 X is what each kilometre past the
  // horizon adds, dB/km.
  function shadowDbPerKm(fMHz = F_MHZ) {
    const ae = PH().K_FACTOR * PH().R_EARTH_KM;
    return 17.6 * 2.188 * Math.cbrt(fMHz) * Math.pow(ae, -2 / 3);
  }

  function pathLossDb(dKm, country, hbM) {
    const c = COUNTRY[country] || COUNTRY.light;
    const d = Math.max(dKm, 0.1);
    const near = Math.max(hataDb(d, c.hata, hbM), PH().fsplDb(d, F_MHZ));
    return near + Math.max(0, d - horizonKm(hbM)) * shadowDbPerKm();
  }

  // The link budget, stage by stage: o is { w, ant, country, km, hb, atten }.
  // Each stage carries what it adds and the level after it, so the ladder,
  // the tiles and the tables all read one list.
  function budget(o) {
    const ptx = wattsToDbm(o.w);
    const gtx = (ANTENNAS[o.ant] || ANTENNAS.col3).dbd + DIPOLE_DBI;
    const pl = pathLossDb(o.km, o.country, o.hb);
    const atten = Math.max(0, Number(o.atten) || 0);
    const parts = [
      ['tx', 'Transmitter', ptx],
      ['att', 'Attenuator', -atten],
      ['feed', 'Feeder', -FEED_DB],
      ['ant', 'Antenna', gtx],
      ['path', 'The path', -pl],
      ['rxant', 'Repeater antenna', RX_GAIN_DBI],
      ['rxfeed', 'Feeder', -FEED_DB],
    ];
    let level = 0;
    const stages = parts.map(([id, label, delta], i) => {
      const from = i ? level : null;
      level = i ? level + delta : delta;
      return { id, label, delta, from, level };
    });
    const intoAnt = ptx - atten - FEED_DB;
    return { ptx, gtx, pl, atten, intoAnt, eirp: intoAnt + gtx, rx: level, margin: level - RX_DBM, stages };
  }

  // The band a margin falls in — LB_MARGIN's, with "not heard" split off the
  // bottom of Poor, because on a bench the difference is the whole point.
  function band(m) {
    if (!(m >= 0)) return { id: 'miss', label: 'Not heard', cls: 'bad' };
    if (m >= GOOD_DB) return { id: 'good', label: 'Good', cls: 'ok' };
    if (m >= FLOOR_DB) return { id: 'marginal', label: 'Marginal', cls: 'warn' };
    return { id: 'poor', label: 'Poor', cls: 'bad' };
  }

  // What a test in `step` dB steps from 0 dB reads for a link whose margin is
  // M dB with the attenuator out, fading left out: the largest setting the link
  // still carried. The truth lies from there to the next setting up (hi) — or,
  // when the attenuator's last setting still got through, it is "at least".
  // `sent` counts the transmissions, the first miss included.
  function reading(M, step, max = ATTEN_MAX) {
    const points = [];
    for (let a = 0; a <= max + 1e-9; a += step) points.push(a);
    let last = null, sent = 0;
    for (const a of points) {
      sent++;
      if (M - a >= 0) last = a; else break;
    }
    if (last === null) return { step, points, sent, reading: null, lo: null, hi: 0, atLeast: false };
    const atLeast = last === points[points.length - 1];
    return { step, points, sent, reading: last, lo: last, hi: atLeast ? null : last + step, atLeast };
  }

  // The third way: `coarse` steps to the first miss, then `fine` steps up from
  // the last setting that got through.
  function coarseFine(M, coarse = 5, fine = 1, max = ATTEN_MAX) {
    const c = reading(M, coarse, max);
    if (c.reading === null || c.atLeast) return { ...c, step: fine, coarse };
    let sent = c.sent, last = c.reading;
    for (let a = c.reading + fine; a < c.hi - 1e-9; a += fine) {
      sent++;
      if (M - a >= 0) last = a; else break;
    }
    return { step: fine, coarse, sent, reading: last, lo: last, hi: last + fine, atLeast: false };
  }

  // How far the station, attenuator out, still has `need` dB to spare: the
  // distance where its margin falls to that, found by halving. The margin
  // falls with distance everywhere in this model, so there is one.
  function rangeKm(o, need) {
    const m = km => budget({ ...o, km, atten: 0 }).margin;
    let lo = 0.5, hi = 1000;
    if (m(lo) < need) return 0;
    for (let i = 0; i < 60; i++) {
      const mid = Math.sqrt(lo * hi);
      if (m(mid) >= need) lo = mid; else hi = mid;
    }
    return lo;
  }

  // Watts in the unit that keeps them readable: 25 W, 790 mW, 2 fW.
  function fmtW(w) {
    if (!(w > 0)) return '0 W';
    const U = [[1, 'W'], [1e-3, 'mW'], [1e-6, 'µW'], [1e-9, 'nW'], [1e-12, 'pW'], [1e-15, 'fW'], [1e-18, 'aW']];
    for (const [u, name] of U) {
      if (w >= u * 0.9995 || u === 1e-18) return `${+(w / u).toPrecision(3)} ${name}`;
    }
    return '0 W';
  }
  // …and written out in full, zeros and all, for the moment the zeros are the lesson.
  function zerosW(w) {
    if (!(w > 0)) return '0 W';
    if (w >= 0.01) return fmtW(w);
    let e = Math.floor(lg(w));
    let digit = Math.round(w / Math.pow(10, e));
    if (digit >= 10) { digit = 1; e += 1; }
    const frac = '0'.repeat(-e - 1) + digit;
    return `0.${frac.replace(/(\d{3})(?=\d)/g, '$1 ')} W`;
  }

  // ── The page's settings, kept for the session ─────────────────────────────

  const S = {
    mode: 'auto',        // 'auto' | 'manual'
    w: 5,
    ant: 'col3',
    country: 'light',
    km: 30,
    hb: 100,
    atten: 0,
    step: 3,
    flutter: false,
    view: 'db',          // the ladder: 'db' | 'w'
    log: [],             // [{ a, rx, fade, pass }], the tests sent with this set-up
    seed: 7,
  };

  // Timing, in ms of the loop's own clock.
  const FLY_MS = 950;    // a transmission crossing (drawn slow: the real flight is 100 µs)
  const SHOW_MS = 850;   // the outcome on the meter before the next step
  const DONE_MS = 4800;  // Auto's booked reading, before it starts again
  const turnDur = (a, b) => Math.min(1100, 260 + 45 * Math.abs(b - a));

  let run = { playing: false, phase: 'turn', i: 0, t: 0, from: 0, dur: 260 };
  let tx = null;         // the transmission on screen: { a, rx, fade, pass, eirp, t, logged, done }
  let disp = 0;          // the knob's position, between clicks while it turns
  let needle = -135;     // the meter's needle, dBm
  let rand = null;
  let loop = 0, last = 0, visible = true, wired = null;

  const METER_LO = -135, METER_HI = -55;
  const MINUS = '−';
  const num = (x, d = 1) => (Number.isFinite(x) ? (x < 0 ? MINUS : '') + Math.abs(x).toFixed(d) : '—');
  const sign = (x, d = 1) => (x > 0 ? '+' : x < 0 ? MINUS : '±') + Math.abs(x).toFixed(d);
  // A stage's decibels as few figures as they need: −0.5, +5.15, −24, −135.
  const sgnTrim = x => (x > 0 ? '+' : x < 0 ? MINUS : '±') + String(+Math.abs(x).toFixed(Math.abs(x) < 10 ? 2 : 0));
  const f0 = x => (Number.isFinite(x) ? String(Math.round(x)) : '—');
  const pct = v => `${v >= 10 ? Math.round(v) : +v.toPrecision(2)} %`;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ease = k => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
  const say = m => { if (typeof announce === 'function') announce(m); };
  const e_ = s => (typeof esc === 'function' ? esc(s) : String(s));
  const stillPreferred = () => {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch (_) { return false; }
  };
  const $ = id => document.getElementById(id);
  const cur = () => ({ w: S.w, ant: S.ant, country: S.country, km: S.km, hb: S.hb, atten: S.atten });
  const stationMargin = (o = cur()) => budget({ ...o, atten: 0 }).margin;
  function points(step = S.step) {
    const p = [];
    for (let a = 0; a <= ATTEN_MAX; a += step) p.push(a);
    return p;
  }
  const bookTxt = best => (best === null ? 'no margin' : best >= ATTEN_MAX ? `≥${ATTEN_MAX} dB` : `${best} dB`);

  // ── The page ───────────────────────────────────────────────────────────────

  function chip(name, value, label, checked, handler) {
    const id = `rp-${name}-${value}`;
    return `<label class="rp-chip" for="${id}"><input type="radio" name="rp-${name}" id="${id}" value="${value}"
      ${checked ? 'checked' : ''} onchange="${handler}">${label}</label>`;
  }

  function range(id, label, min, max, step, value, handler, out) {
    return `<div class="rp-range">
      <label for="${id}">${label}</label>
      <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}" oninput="${handler}">
      <output for="${id}" id="${id}-out">${out}</output>
    </div>`;
  }

  const PROC = [
    ['Before you start', 'Tell the base — or whoever watches the receiving end — that a test is coming, and check the '
      + 'attenuator is rated for the transmitter: with 30 dB in, almost all of a 25 W radio\'s power turns to heat inside '
      + 'it, and a small step attenuator may be rated for only a watt or two.'],
    ['Fit the attenuator at 0 dB', 'In the feeder, between the radio\'s antenna socket and the cable up to the antenna.'],
    ['Send a test', 'Key a test transmission and have the base confirm it arrived clean: the right address, the right value.'],
    ['Heard? Add a step', 'Turn the attenuator up one step and send again. Each step throws that many decibels of the '
      + 'signal away on purpose.'],
    ['Missed? Make sure', 'A transmission that does not arrive, or arrives wrong, is a miss. A fade can drop one on its '
      + 'own, so many testers send a missed step again before calling it.'],
    ['Book the last pass', 'The largest setting that still got through is the fade margin. Write the step size down with '
      + 'it — and ≥30 if it got through at the attenuator\'s limit.'],
    ['Put it back', 'Take the attenuator out, reconnect the antenna and send one last test at full power, to prove the '
      + 'station is back to normal.'],
  ];

  function procHtml() {
    const now = procIdx();
    return PROC.map(([t, d], i) => `<li${i === now ? ' class="is-now"' : ''}><strong>${t}.</strong> ${d}</li>`).join('');
  }

  const DB_FACTS = [
    ['+3 dB', '× 2', 'double the power — and −3 dB halves it'],
    ['+6 dB', '× 4', 'two doublings'],
    ['+7 dB', '× 5', '1 W to 5 W, or 5 W to 25 W'],
    ['+10 dB', '× 10', 'ten times the power'],
    ['+14 dB', '× 25', '1 W to 25 W'],
    ['+20 dB', '× 100', 'a hundred times'],
    ['−30 dB', '÷ 1000', 'the attenuator at full: 25 W in, 25 mW out'],
  ];

  function render() {
    const o = cur();
    const rx = num(RX_DBM, 0);
    return `
    <section class="panel rp-sec" id="rp-fade" aria-labelledby="rp-fade-h">
      <h3 id="rp-fade-h" tabindex="-1">6 · The fade-margin test</h3>
      <p>A link's <strong>fade margin</strong> is how many decibels its signal could lose and still be heard: the gap
        between what arrives at the receiver and the weakest signal the receiver can decode. Rain on the leaves, a
        season's growth, a feeder going bad, a cold morning's inversion — each of them takes decibels away, and the margin
        is what is left to pay for them. Flood-Net's models estimate it; the <strong>fade-margin test</strong> measures
        it, by throwing decibels away on purpose, with a step attenuator in the feeder, until the link fails.</p>
      <div class="rp-fm-how">
        <div>
          <h4>On site, step by step</h4>
          <ol class="rp-fm-proc" id="rp-fm-proc">${procHtml()}</ol>
        </div>
        <div class="rp-fm-note">
          <p><strong>What the number means.</strong> A 24 dB margin says the signal reaching the repeater is about 250 times
            stronger than the receiver needs: it could fade to a two-hundred-and-fiftieth of itself before the link fails.
            The link budget card calls ${GOOD_DB} dB and more <em>Good</em> and ${FLOOR_DB}–${GOOD_DB} dB <em>Marginal</em>.</p>
          <p><strong>What it measures.</strong> The attenuator weakens only what the station sends — a repeater re-sends at
            full strength — so the reading is the margin of the station's best way into the network: whichever receiver
            hears it longest.</p>
        </div>
      </div>

      <h4>The test bench</h4>
      <p>A field station's radio sends its test through a step attenuator — 0 to ${ATTEN_MAX} dB, in 1 dB clicks — to a
        repeater on a hill. <strong>Auto</strong> runs the test as it is run on site, one step at a time, and starts again
        when it is done. Switch to <strong>Manual</strong>, or touch the attenuator, and the attenuator, the test button
        and everything else are yours. Change the radio, the antenna or the country in either mode and watch the numbers move.</p>
      <fieldset class="rp-chips">
        <legend>Run it</legend>
        ${chip('fmmode', 'auto', 'Auto — it runs the test', S.mode === 'auto', 'PropFade.mode(this.value)')}
        ${chip('fmmode', 'manual', 'Manual — you have the controls', S.mode === 'manual', 'PropFade.mode(this.value)')}
      </fieldset>
      <p class="rp-fm-status" id="rp-fm-status">${statusText()}</p>
      <canvas class="rp-fm-bench" id="rp-fm-bench" role="img"
        aria-label="The test bench: a field station's radio, a step attenuator and an antenna on the left, and a repeater on a hill on the right with a signal meter. Each test transmission travels across and is heard or missed. The settings, the signal and every test are written out beside the picture."></canvas>
      <div class="rp-controls">
        <div class="button-group" role="group" aria-label="The test">
          <button type="button" class="primary" id="rp-fm-play" onclick="PropFade.play()">${playLabel()}</button>
          <button type="button" onclick="PropFade.restart()">↺ From 0 dB</button>
          <button type="button" id="rp-fm-send" onclick="PropFade.send()">📡 Send a test</button>
          <button type="button" id="rp-fm-down" onclick="PropFade.bump(-1)">− one step</button>
          <button type="button" id="rp-fm-up" onclick="PropFade.bump(1)">+ one step</button>
          <button type="button" id="rp-fm-clear" onclick="PropFade.clearLog()">🧹 Clear the tests</button>
        </div>
      </div>
      <div class="rp-ranges rp-fm-ranges">
        ${range('rp-fm-att', 'Attenuator', 0, ATTEN_MAX, 1, S.atten, 'PropFade.atten(this.value)', `${S.atten} dB`)}
        ${range('rp-fm-km', 'Distance to the repeater', 2, 120, 1, S.km, "PropFade.set('km', this.value)", `${S.km} km`)}
        ${range('rp-fm-hb', 'Repeater above the country', 30, 200, 5, S.hb, "PropFade.set('hb', this.value)", `${S.hb} m`)}
      </div>
      <div class="rp-fm-pickers">
        <fieldset class="rp-chips">
          <legend>Transmitter</legend>
          ${POWERS.map(p => chip('fmw', String(p.w), p.label, p.w === o.w, 'PropFade.power(this.value)')).join('')}
        </fieldset>
        <fieldset class="rp-chips">
          <legend>Antenna at the station</legend>
          ${Object.entries(ANTENNAS).map(([id, a]) => chip('fmant', id, a.short, id === o.ant, 'PropFade.antenna(this.value)')).join('')}
        </fieldset>
        <fieldset class="rp-chips">
          <legend>Country between</legend>
          ${Object.entries(COUNTRY).map(([id, c]) => chip('fmcty', id, c.label, id === o.country, 'PropFade.country(this.value)')).join('')}
        </fieldset>
        <fieldset class="rp-chips">
          <legend>Attenuator steps</legend>
          ${STEPS.map(s => chip('fmstep', String(s), `${s} dB`, s === S.step, 'PropFade.step(this.value)')).join('')}
        </fieldset>
      </div>
      <label class="rp-check" for="rp-fm-flutter"><input type="checkbox" id="rp-fm-flutter" ${S.flutter ? 'checked' : ''}
        onchange="PropFade.flutter(this.checked)">Real-world flutter — each transmission fades or lifts by a couple of
        decibels, at random</label>
      <div class="rp-fm-tiles" id="rp-fm-tiles">${tilesHtml()}</div>
      <p class="rp-readout" id="rp-fm-reading">${readingHtml()}</p>
      <ol class="rp-fm-log" id="rp-fm-log" aria-label="The tests sent" ${S.log.length ? '' : 'hidden'}>${logHtml()}</ol>
      <p class="rp-aside">The antennas: a unity-gain whip radiates the same every way (0 dBd); a 3 dB collinear stacks
        elements to squash its pattern flatter, towards the horizon, still the same all the way round; a six-element Yagi
        is a beam — about 9 dBd straight ahead, and it has to be pointed at the repeater. The repeater listens on a 3 dB
        collinear, with ${FEED_DB} dB of feeder at each end and a receiver that needs ${rx} dBm.</p>

      <h4>Where the decibels go</h4>
      <p>A link budget is a sum. Start with the transmitter's power, take off what the attenuator and the feeder throw
        away, add the antenna's gain, take off what the path loses, add the repeater antenna's gain and take off its
        feeder — then compare what is left with the weakest signal the receiver can decode (${rx} dBm here). The gap is the
        fade margin. In decibels the sum is adding and taking away. Draw it in watts, to scale, to see why nobody works
        in watts: everything after the path is too small to see.</p>
      <fieldset class="rp-chips">
        <legend>Draw it in</legend>
        ${chip('fmview', 'db', 'Decibels', S.view === 'db', 'PropFade.view(this.value)')}
        ${chip('fmview', 'w', 'Watts, to scale', S.view === 'w', 'PropFade.view(this.value)')}
      </fieldset>
      <canvas class="rp-fm-ladder" id="rp-fm-ladder" role="img"
        aria-label="The link budget as a staircase of bars: the transmitter's power, then each loss and gain in turn, down to what arrives at the receiver, against the level it needs. The same figures are written out under it."></canvas>
      <p class="rp-readout" id="rp-fm-ladder-read">${ladderRead()}</p>

      <h4>Decibels, and the same 3 dB at 1, 5 and 25 W</h4>
      <p>Radio power runs over an enormous range: a transmitter's watts at one end, and at the other a receiver that
        works with ${rx} dBm — ${zerosW(dbmToWatts(RX_DBM))}. Decibels are a logarithm. They count how many times the
        power has been multiplied or divided by ten, in tenths, which turns the budget's multiplying into adding — and
        means one step of the attenuator is the same step whatever goes into it.</p>
      <ul class="rp-fm-db" aria-label="Decibels worth knowing">${DB_FACTS.map(([db, x, why]) => `
        <li><span class="rp-fm-db-big">${db} = ${x}</span><span class="rp-fm-db-why">${why}</span></li>`).join('')}</ul>
      <p>Each 3 dB step halves the power. At 25 W the first step throws away 12.5 W; at 1 W, half a watt — and to the
        receiver both are the same 3 dB. What a bigger transmitter buys is a head start: 5 W starts 7 dB above 1 W (a
        little over two 3 dB steps) and 25 W starts 14 dB above it (nearly five). So in the table every row is one step
        below the row above it, in all three columns, and every column is 7 dB above the one to its left.</p>
      <div class="table-wrap">
        <table class="rp-table rp-fm-matrix" id="rp-fm-matrix">${matrixHtml()}</table>
      </div>

      <h4>How far will it reach?</h4>
      <p>In free space every 6 dB doubles the range. Over real country radio weakens faster than that, so decibels buy
        less distance — and past the <strong>radio horizon</strong> the curve of the Earth itself is in the way. The bars
        are this station at each power, attenuator out: <em>Good</em> while it has ${GOOD_DB} dB to spare,
        <em>Marginal</em> to ${FLOOR_DB} dB, <em>only just</em> to nothing.</p>
      <div class="rp-fm-range" id="rp-fm-range">${rangeHtml()}</div>
      <p class="rp-readout" id="rp-fm-range-read">${rangeRead()}</p>
      <div class="table-wrap">
        <table class="rp-table" id="rp-fm-rtable">${rangeTable()}</table>
      </div>

      <h4>3 dB steps or 5 dB steps?</h4>
      <p>A test reads the last setting that got through, so a reading is a <strong>step, not a point</strong>: the truth
        is somewhere between it and the next setting up. Steps of 3 dB pin the margin within 3 dB; steps of 5 dB within 5
        — and on average a test reads half a step short. Where the steps fall matters as much as how big they are:
        inside <em>Marginal</em> (${FLOOR_DB}–${GOOD_DB} dB), where the decision to fix a station or leave it is made, 3 dB
        steps can read 3, 6 or 9, and 5 dB steps only 5. Move the bench's settings and watch both tests below.</p>
      <canvas class="rp-fm-steps" id="rp-fm-steps" role="img"
        aria-label="A line from 0 to 30 dB with this link's true fade margin marked, and the settings a 3 dB test and a 5 dB test go through: those that got through, the first miss, and the range each reading leaves. The table below gives the same."></canvas>
      <canvas class="rp-fm-stair" id="rp-fm-stair" role="img"
        aria-label="What a test reads against the true fade margin, from 0 to 33 dB: a straight line for a perfect test, and the staircases a 3 dB and a 5 dB attenuator make of it."></canvas>
      <div class="table-wrap">
        <table class="rp-table" id="rp-fm-cmp">${cmpTable()}</table>
      </div>
      <p class="rp-readout" id="rp-fm-cmp-read">${cmpRead()}</p>
      <details class="rp-more">
        <summary>The case for each — and a third way</summary>
        <p><strong>For 3 dB steps.</strong> Readings within 3 dB rather than 5, and half a step short on average is 1.5 dB
          rather than 2.5. Three readings inside Marginal (3, 6 and 9) where 5 dB steps have one. Every step is a clean
          halving of the power, which is easy to reason about. And it is what Flood-Net's records already hold: the
          Network Review reads the tests on file as 3 dB steps and calibrated the network's model against them.</p>
        <p><strong>For 5 dB steps.</strong> Fewer transmissions — seven settings from 0 to 30 dB against eleven — so a
          quicker test, and less time keyed up on a channel other stations share. The <em>Good</em> line at ${GOOD_DB} dB is
          one of its settings, so "is this link Good?" gets an exact yes or no; 3 dB steps read 9 for anything from 9 to
          12 and cannot say. A fade moves a 5 dB reading less often, too — though by a whole 5 dB when it does.</p>
        <p><strong>Each grid answers the questions on it.</strong> 3 dB steps settle the ${FLOOR_DB} dB floor exactly and
          blur the ${GOOD_DB} dB line; 5 dB steps settle ${GOOD_DB} dB and blur the floor (a reading of 0 is anything from 0 to 5).</p>
        <p><strong>A third way.</strong> Coarse to find it, fine to pin it: 5 dB steps until a miss, then back to the last
          setting that got through and up in 1 dB clicks. It costs about as many transmissions as 3 dB steps and reads
          within 1 dB — the line under the table works it for this link.</p>
      </details>
      <details class="rp-more">
        <summary>Whichever step you use, book it</summary>
        <p>The Network Review reads each test on file as the step it came from: a figure on the 3 dB grid (3, 6 … 27) as a
          3 dB step, a figure off it (22, 25) as a 1 dB step from a 1 dB attenuator, and ${ATTEN_MAX} as "at least ${ATTEN_MAX}".
          A 5 dB attenuator's 5, 10, 20 and 25 are off the 3 dB grid, so they would be read as 1 dB steps — far narrower than
          they are — and its 15 as 15 to 18 rather than 15 to 20. If tests move to 5 dB steps, the record needs to say so.</p>
      </details>
    </section>`;
  }

  function playLabel() { return S.mode === 'auto' && run.playing ? '⏸ Pause' : '▶ Run the test'; }

  function statusText() {
    if (S.mode === 'manual') {
      return `<strong>Manual</strong> — the attenuator is at ${S.atten} dB. Send a test at any setting; ± moves it one
        ${S.step} dB step.`;
    }
    const pts = points();
    if (run.phase === 'done') {
      return `<strong>Auto</strong> — done: book ${bookTxt(logFacts().best)}.${run.playing ? ' Starting again in a moment.' : ''}`;
    }
    return `<strong>Auto</strong> — ${S.step} dB steps: setting ${run.i + 1} of ${pts.length}, ${pts[run.i]} dB${run.playing ? '' : ' (paused)'}.`;
  }

  function tilesHtml() {
    const o = cur(), B = budget(o), M = stationMargin(o);
    const bn = band(B.margin), bs = band(M);
    const tiles = [
      ['📻', 'Transmitter', `${o.w} W`, `${num(B.ptx)} dBm`],
      ['🎚️', 'Attenuator', `${B.atten} dB`, `lets ${pct(100 * Math.pow(10, -B.atten / 10))} of the power through`],
      ['🔌', 'Into the antenna', fmtW(dbmToWatts(B.intoAnt)), `${num(B.intoAnt)} dBm, after the feeder`],
      ['📡', 'Radiated', `${num(B.eirp)} dBm`, `${fmtW(dbmToWatts(B.eirp))} EIRP, with the antenna's ${B.gtx.toFixed(2)} dBi`],
      ['🏞️', 'Lost on the way', `${B.pl.toFixed(1)} dB`, `${o.km} km, ${e_(COUNTRY[o.country].label.toLowerCase())}`],
      ['📶', 'At the receiver', `${num(B.rx)} dBm`, `${fmtW(dbmToWatts(B.rx))} — it needs ${num(RX_DBM, 0)} dBm`],
      ['🛟', 'Margin left', `${sign(B.margin)} dB`, B.atten ? `with ${B.atten} dB in: ${bn.label}` : bn.label, bn.cls],
      ['🎯', 'Fade margin', `${num(M)} dB`, `attenuator out: ${bs.label}`, bs.cls],
    ];
    return tiles.map(([i, what, big, small, cls]) => `<div class="rp-fm-tile${cls ? ` rp-fm-tile--${cls}` : ''}">
      <span class="rp-fm-tile-icon" aria-hidden="true">${i}</span><span class="rp-fm-tile-what">${what}</span>
      <span class="rp-fm-tile-big">${big}</span><span class="rp-fm-tile-small">${small}</span></div>`).join('');
  }

  // The largest setting that got through, and the smallest above it that did not.
  function logFacts(log = S.log) {
    const passes = log.filter(t => t.pass).map(t => t.a);
    const best = passes.length ? Math.max(...passes) : null;
    const misses = log.filter(t => !t.pass && (best === null || t.a > best)).map(t => t.a);
    return { best, miss: misses.length ? Math.min(...misses) : null };
  }

  function readingHtml() {
    const M = stationMargin();
    if (!S.log.length) {
      return S.mode === 'auto'
        ? 'The test is about to start, at 0 dB.'
        : 'Nothing sent yet. Set the attenuator and press <strong>📡 Send a test</strong> — start at 0 dB, as on site.';
    }
    const { best, miss } = logFacts();
    const truth = ` The model puts this link's fade margin at <strong>${num(M)} dB</strong>.`;
    if (best === null) {
      return `Nothing has got through${miss != null ? ` — missed at ${miss} dB` : ''}. ${M < 0
        ? `At 0 dB this link is ${num(-M)} dB short: there is no margin to measure.`
        : 'Turn the attenuator down and send again.'}`;
    }
    if (miss === null) {
      if (best >= ATTEN_MAX) {
        return `Got through at the attenuator's ${ATTEN_MAX} dB limit: book it as <strong>≥${ATTEN_MAX} dB</strong> — the
          test cannot say how much more.${truth}`;
      }
      return `Got through at ${best} dB and nothing has missed above it yet: the margin is at least ${best} dB. Keep going.`;
    }
    const n = S.log.length;
    return `Got through at ${best} dB, missed at ${miss} dB: book a fade margin of <strong>${best} dB</strong> — the truth
      is somewhere from ${best} to ${miss} dB. ${n} transmission${n === 1 ? '' : 's'}.${truth}`;
  }

  function logHtml() {
    return S.log.map(t => {
      const spare = t.rx - RX_DBM;
      const fade = t.fade ? ` (${t.fade < 0 ? 'faded' : 'lifted'} ${Math.abs(t.fade).toFixed(1)} dB)` : '';
      return `<li class="rp-fm-log-${t.pass ? 'pass' : 'miss'}"><span class="rp-fm-log-a">${t.a} dB</span>
        ${t.pass ? '✓ heard' : '✗ missed'} — ${num(t.rx)} dBm, ${t.pass
          ? `${spare.toFixed(1)} dB to spare` : `${(-spare).toFixed(1)} dB short`}${fade}</li>`;
    }).join('');
  }

  function ladderRead() {
    const o = cur(), B = budget(o);
    const loss = B.pl;
    return `${o.w} W is ${num(B.ptx)} dBm. ${B.atten ? `${MINUS}${B.atten} dB at the attenuator, ` : 'Nothing off at the attenuator, '}
      ${MINUS}${FEED_DB} dB of feeder and +${B.gtx.toFixed(2)} dBi of antenna: <strong>${num(B.eirp)} dBm</strong> radiated.
      The path takes ${loss.toFixed(1)} dB, the repeater's antenna gives back ${RX_GAIN_DBI} and its feeder takes ${FEED_DB}:
      <strong>${num(B.rx)} dBm</strong> arrives, ${B.margin >= 0 ? `${B.margin.toFixed(1)} dB above` : `${(-B.margin).toFixed(1)} dB short of`}
      the ${num(RX_DBM, 0)} dBm the receiver needs. In watts that is ${fmtW(o.w)} in and ${zerosW(dbmToWatts(B.rx))} out:
      the path alone divides the power by ${sci(Math.pow(10, loss / 10))}.`;
  }

  // 3.4 × 10¹³, with the superscript the eye expects.
  function sci(x) {
    if (!(x > 0) || !Number.isFinite(x)) return '—';
    const e = Math.floor(lg(x));
    const m = x / Math.pow(10, e);
    const sup = String(e).replace(/-/g, '⁻').replace(/\d/g, d => '⁰¹²³⁴⁵⁶⁷⁸⁹'[d]);
    return `${m.toFixed(1)} × 10${sup}`;
  }

  function matrixHtml() {
    const o = cur();
    const body = points().map(a => {
      const on = a === S.atten;
      const cells = POWERS.map(p => {
        const B = budget({ ...o, w: p.w, atten: a });
        const bn = band(B.margin);
        const here = on && p.w === o.w;
        return `<td class="rp-fm-c rp-fm-c--${bn.id}${here ? ' rp-fm-c--here' : ''}"><strong>${num(B.rx)} dBm</strong>
          <span>${B.margin >= 0 ? `${B.margin.toFixed(1)} dB to spare` : `✗ ${(-B.margin).toFixed(1)} dB short`}</span>
          <span class="rp-aside">${fmtW(p.w * Math.pow(10, -a / 10))} through</span></td>`;
      }).join('');
      return `<tr${on ? ' class="rp-row-on"' : ''}><th scope="row">${a} dB<span class="rp-aside">${pct(100 * Math.pow(10, -a / 10))} left</span></th>${cells}</tr>`;
    }).join('');
    return `<caption>What reaches the repeater at each ${S.step} dB step — ${e_(ANTENNAS[o.ant].lower)},
        ${o.km} km of ${e_(COUNTRY[o.country].label.toLowerCase())}, a repeater ${o.hb} m up</caption>
      <thead><tr><th scope="col">Attenuator</th>${POWERS.map(p =>
        `<th scope="col">${p.label}<span class="rp-aside">${num(wattsToDbm(p.w))} dBm</span></th>`).join('')}</tr></thead>
      <tbody>${body}</tbody>`;
  }

  function ranges(o = cur()) {
    return POWERS.map(p => {
      const q = { ...o, w: p.w };
      return { p, good: rangeKm(q, GOOD_DB), floor: rangeKm(q, FLOOR_DB), edge: rangeKm(q, 0) };
    });
  }

  function rangeHtml() {
    const o = cur();
    const H = horizonKm(o.hb);
    const rs = ranges(o);
    const scale = Math.ceil(Math.max(H, o.km, ...rs.map(r => r.edge)) * 1.06 / 20) * 20;
    const at = km => `${clamp(km / scale * 100, 0, 100).toFixed(2)}%`;
    const rows = rs.map(r => `<li class="rp-fm-rrow${r.p.w === o.w ? ' is-on' : ''}">
        <span class="rp-fm-rname">${r.p.label}</span>
        <span class="rp-fm-bar" aria-hidden="true">
          <span class="rp-fm-seg rp-fm-seg--edge" style="--w:${at(r.edge)}"></span>
          <span class="rp-fm-seg rp-fm-seg--floor" style="--w:${at(r.floor)}"></span>
          <span class="rp-fm-seg rp-fm-seg--good" style="--w:${at(r.good)}"></span>
          <span class="rp-fm-hz" style="--at:${at(H)}"></span>
          <span class="rp-fm-at" style="--at:${at(o.km)}"></span>
        </span>
        <span class="rp-fm-rtxt">Good to <strong>${f0(r.good)} km</strong>, Marginal to ${f0(r.floor)} km, heard to
          ${f0(r.edge)} km</span>
      </li>`).join('');
    return `<ul class="rp-fm-rlist" aria-label="How far each transmitter reaches">${rows}</ul>
      <div class="rp-fm-rkey" aria-hidden="true">
        <span><i class="rp-sw rp-sw--fm-good"></i>Good</span>
        <span><i class="rp-sw rp-sw--fm-floor"></i>Marginal</span>
        <span><i class="rp-sw rp-sw--fm-edge"></i>Only just</span>
        <span><i class="rp-sw rp-sw--fm-hz"></i>Radio horizon, ${f0(H)} km</span>
        <span><i class="rp-sw rp-sw--fm-at"></i>This station, ${o.km} km</span>
        <span class="rp-aside">— the bar is 0 to ${scale} km</span>
      </div>`;
  }

  function rangeRead() {
    const o = cur();
    const H = horizonKm(o.hb);
    const [r1, r5, r25] = ranges(o);
    const perDoubling = hataSlope(o.hb) * lg(2);
    return `From 5 W to 25 W — five times the power, 7 dB — the Good range goes from ${f0(r5.good)} to
      ${f0(r25.good)} km: <strong>× ${(r25.good / Math.max(r5.good, 0.1)).toFixed(2)}</strong>, not × 5. Over this country
      each doubling of the distance costs about ${perDoubling.toFixed(1)} dB (in free space, 6), and past the radio horizon —
      ${f0(H)} km from a ${FIELD_AGL} m whip to a repeater ${o.hb} m up — the Earth's curve takes another
      ${shadowDbPerKm().toFixed(2)} dB every kilometre. Height beats power: raise the repeater and watch the horizon move.
      (1 W is Good to ${f0(r1.good)} km.)`;
  }

  function rangeTable() {
    const o = cur();
    const H = horizonKm(o.hb);
    const rows = POWERS.map(p => `<tr${p.w === o.w ? ' class="rp-row-on"' : ''}><th scope="row">${p.label}</th>${
      Object.entries(ANTENNAS).map(([id]) => {
        const km = rangeKm({ ...o, w: p.w, ant: id }, GOOD_DB);
        const here = p.w === o.w && id === o.ant;
        return `<td${here ? ' class="rp-fm-c--here"' : ''}>${f0(km)} km${km > H ? '<span class="rp-aside"> past the horizon</span>' : ''}</td>`;
      }).join('')}</tr>`).join('');
    return `<caption>Good range — ${GOOD_DB} dB of fade margin to spare — over ${e_(COUNTRY[o.country].label.toLowerCase())},
        a repeater ${o.hb} m up (radio horizon ${f0(H)} km)</caption>
      <thead><tr><th scope="col">Transmitter</th>${Object.values(ANTENNAS).map(a => `<th scope="col">${a.short}</th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody>`;
  }

  function cmpTable() {
    const M = stationMargin();
    const r3 = reading(M, 3), r5 = reading(M, 5);
    const read = r => (r.reading === null ? 'nothing — it misses at 0 dB' : r.atLeast ? `≥${r.reading} dB` : `${r.reading} dB`);
    const between = r => (r.reading === null ? '—' : r.atLeast ? `${r.reading} dB or more` : `${r.reading} and ${r.hi} dB`);
    const short = r => (r.reading === null || r.atLeast ? '—' : `${(M - r.reading).toFixed(1)} dB`);
    const inMarginal = s => points(s).filter(a => a >= FLOOR_DB && a < GOOD_DB);
    const list = v => (v.length > 1 ? `${v.slice(0, -1).join(', ')} and ${v[v.length - 1]}` : v.length ? `${v[0]} only` : 'none');
    const books = r => (r.reading === null ? 'Not heard' : band(r.reading).label);
    const row = (label, a, b) => `<tr><th scope="row">${label}</th><td>${a}</td><td>${b}</td></tr>`;
    return `<caption>This link tested both ways — its fade margin is ${num(M)} dB with the attenuator out (${band(M).label})</caption>
      <thead><tr><th scope="col">For this link</th><th scope="col">3 dB steps</th><th scope="col">5 dB steps</th></tr></thead>
      <tbody>
        ${row('Settings from 0 to 30 dB', r3.points.length, r5.points.length)}
        ${row('Transmissions this test takes', r3.sent, r5.sent)}
        ${row('It reads', read(r3), read(r5))}
        ${row('So the margin is between', between(r3), between(r5))}
        ${row('Short of the truth, this link', short(r3), short(r5))}
        ${row('Short of the truth, on average', '1.5 dB', '2.5 dB')}
        ${row('Short of the truth, at worst', 'just under 3 dB', 'just under 5 dB')}
        ${row(`Readings inside Marginal (${FLOOR_DB}–${GOOD_DB} dB)`, list(inMarginal(3)), list(inMarginal(5)))}
        ${row(`Says exactly whether it is Good (≥${GOOD_DB} dB)`, 'no — 9 means 9 to 12', `yes — ${GOOD_DB} is a setting`)}
        ${row(`Says exactly whether it clears the ${FLOOR_DB} dB floor`, `yes — ${FLOOR_DB} is a setting`, 'no — 0 means 0 to 5')}
        ${row('Books this link as', books(r3), books(r5))}
        ${row('One step leaves', 'half the power (50 %)', 'a third of it (32 %)')}
      </tbody>`;
  }

  function cmpRead() {
    const M = stationMargin();
    const r3 = reading(M, 3), r5 = reading(M, 5), cf = coarseFine(M, 5, 1);
    if (r3.reading === null) return `This link misses at 0 dB, so neither test has anything to read. Shorten the path, raise the repeater or add power.`;
    const gap = r3.atLeast && r5.atLeast ? 'both run off the end of the attenuator'
      : r3.reading === r5.reading ? 'the same reading, this time'
      : `${Math.abs(r3.reading - r5.reading)} dB apart`;
    const third = cf.atLeast ? `5 dB steps then 1 dB clicks would read ≥${cf.reading} dB too`
      : `5 dB steps to the first miss and then 1 dB clicks up from the last pass would take ${cf.sent} transmissions and
        read <strong>${cf.reading} dB</strong> (${cf.reading}–${cf.hi})`;
    return `For this link 3 dB steps read ${bookTxt(r3.reading)} and 5 dB steps ${bookTxt(r5.reading)} — ${gap}. ${
      third[0].toUpperCase() + third.slice(1)}. Any link from 5 to 10 dB reads 5 in 5 dB steps: one 9.9 dB strong and one
      5.1 dB strong book the same.`;
  }

  // ── Updating the page ──────────────────────────────────────────────────────

  function html(id, s) { const el = $(id); if (el) el.innerHTML = s; }

  function procIdx() {
    if (S.mode !== 'auto') return -1;
    if (run.phase === 'done') return !run.playing || run.t < DONE_MS * 0.6 ? 5 : 6;
    if (run.phase === 'turn') return run.i === 0 ? 1 : 3;
    if (tx && tx.logged && !tx.pass) return 4;
    return run.i === 0 ? 2 : 3;
  }
  let procShown = -2;
  function updateProc() {
    const now = procIdx();
    if (now === procShown) return;
    procShown = now;
    const list = $('rp-fm-proc');
    if (!list) return;
    [...list.children].forEach((li, i) => li.classList.toggle('is-now', i === now));
  }

  // The test's own outputs: the status, the reading, the log, the procedure.
  function updateOut() {
    html('rp-fm-status', statusText());
    html('rp-fm-reading', readingHtml());
    const log = $('rp-fm-log');
    if (log) { log.innerHTML = logHtml(); log.hidden = !S.log.length; }
    const btn = $('rp-fm-play');
    if (btn && btn.textContent !== playLabel()) btn.textContent = playLabel();
    updateProc();
  }

  // Everything that follows the attenuator.
  function onAtten() {
    const el = $('rp-fm-att');
    if (el && Number(el.value) !== S.atten) el.value = S.atten;
    const out = $('rp-fm-att-out');
    if (out) out.textContent = `${S.atten} dB`;
    html('rp-fm-tiles', tilesHtml());
    html('rp-fm-ladder-read', ladderRead());
    html('rp-fm-matrix', matrixHtml());
    drawLadder();
    if (S.mode === 'manual') html('rp-fm-status', statusText());
  }

  function setAtten(a) {
    const v = clamp(Math.round(Number(a) || 0), 0, ATTEN_MAX);
    if (v === S.atten) return;
    S.atten = v;
    onAtten();
  }

  // Everything, after the set-up changed.
  function refreshAll() {
    onAtten();
    updateOut();
    html('rp-fm-range', rangeHtml());
    html('rp-fm-range-read', rangeRead());
    html('rp-fm-rtable', rangeTable());
    html('rp-fm-cmp', cmpTable());
    html('rp-fm-cmp-read', cmpRead());
    drawSteps();
    drawStair();
    drawBench(performance.now());
  }

  function syncControls() {
    const pick = (name, value) => { const el = $(`rp-${name}-${value}`); if (el) el.checked = true; };
    pick('fmmode', S.mode); pick('fmw', String(S.w)); pick('fmant', S.ant); pick('fmcty', S.country);
    pick('fmstep', String(S.step)); pick('fmview', S.view);
    for (const [id, v, txt] of [['rp-fm-km', S.km, `${S.km} km`], ['rp-fm-hb', S.hb, `${S.hb} m`]]) {
      const el = $(id); if (el && Number(el.value) !== v) el.value = v;
      const out = $(`${id}-out`); if (out) out.textContent = txt;
    }
    const fl = $('rp-fm-flutter'); if (fl) fl.checked = S.flutter;
  }

  // The set-up changed: the tests sent belong to the old one.
  function onSetup() {
    syncControls();
    tx = null;
    S.log = [];
    if (S.mode === 'auto') {
      autoReset();
      if (!run.playing && stillPreferred()) runInstant();
    }
    refreshAll();
    kick();
  }

  // ── The test itself ────────────────────────────────────────────────────────

  function gauss() {
    if (!rand) rand = PH().rng(S.seed);
    const u = Math.max(1e-9, rand()), v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function startTx(a) {
    const B = budget({ ...cur(), atten: a });
    const fade = S.flutter ? gauss() * FLUTTER_DB : 0;
    const rx = B.rx + fade;
    tx = { a, rx, fade, pass: rx >= RX_DBM, eirp: B.eirp, t: 0, logged: false, done: false };
  }
  function logTx() {
    tx.logged = true;
    S.log.push({ a: tx.a, rx: tx.rx, fade: tx.fade, pass: tx.pass });
    updateOut();
  }
  function advanceTx(dt) {
    if (!tx || tx.done) return;
    tx.t += dt;
    if (!tx.logged && tx.t >= FLY_MS) logTx();
    if (tx.t >= FLY_MS + SHOW_MS) tx.done = true;
  }

  function autoReset() {
    S.log = [];
    S.seed = (S.seed % 9973) + 1;
    rand = PH().rng(S.seed);
    tx = null;
    run = { playing: run.playing, phase: 'turn', i: 0, t: 0, from: disp, dur: turnDur(disp, 0) };
    updateOut();
  }

  function advanceAuto(dt) {
    const pts = points();
    run.t += dt;
    if (run.phase === 'turn') {
      const to = pts[run.i];
      const k = Math.min(1, run.t / run.dur);
      disp = run.from + (to - run.from) * ease(k);
      setAtten(Math.round(disp));
      if (k >= 1) {
        disp = to;
        setAtten(to);
        run.phase = 'tx';
        run.t = 0;
        startTx(to);
        updateOut();
      }
    } else if (run.phase === 'tx') {
      advanceTx(dt);
      if (tx && tx.done) {
        if (tx.pass && run.i + 1 < pts.length) {
          run.from = pts[run.i];
          run.i++;
          run.dur = turnDur(run.from, pts[run.i]);
          run.phase = 'turn';
        } else {
          run.phase = 'done';
        }
        run.t = 0;
        updateOut();
      }
    } else if (run.t >= DONE_MS) {
      autoReset();
    } else {
      updateProc();
    }
  }

  // The whole sweep at once, for a device that asked for stillness: every
  // setting tested to the first miss, the last transmission on the meter.
  function runInstant() {
    run.playing = false;
    autoReset();
    const pts = points();
    for (let i = 0; i < pts.length; i++) {
      run.i = i;
      startTx(pts[i]);
      tx.t = FLY_MS;
      tx.logged = true;
      tx.done = true;
      S.log.push({ a: tx.a, rx: tx.rx, fade: tx.fade, pass: tx.pass });
      disp = pts[i];
      setAtten(pts[i]);
      if (!tx.pass) break;
    }
    run.phase = 'done';
    run.t = 0;
    needle = clamp(tx.rx, METER_LO, METER_HI);
    updateOut();
  }

  // ── The controls ───────────────────────────────────────────────────────────

  function takeOver() {
    if (S.mode !== 'auto') return;
    S.mode = 'manual';
    run.playing = false;
    if (tx && !tx.done) { tx = null; }
    syncControls();
    say('Manual: the attenuator and the test button are yours.');
  }

  function mode(m) {
    if ((m !== 'auto' && m !== 'manual') || m === S.mode) return;
    if (m === 'manual') {
      takeOver();
    } else {
      S.mode = 'auto';
      run.playing = !stillPreferred();
      autoReset();
      if (!run.playing) runInstant();
      say(`Auto: testing in ${S.step} dB steps from 0 dB.`);
    }
    syncControls();
    updateOut();
    onAtten();
    kick();
  }

  function atten(v) {
    takeOver();
    disp = clamp(Math.round(Number(v) || 0), 0, ATTEN_MAX);
    setAtten(disp);
    updateOut();
    kick();
  }

  function bump(dir) {
    takeOver();
    disp = clamp(S.atten + (dir < 0 ? -1 : 1) * S.step, 0, ATTEN_MAX);
    setAtten(disp);
    updateOut();
    kick();
  }

  function send() {
    takeOver();
    if (tx && !tx.logged && !stillPreferred()) return;   // one in the air at a time, as on site
    startTx(S.atten);
    if (stillPreferred()) { tx.t = FLY_MS; logTx(); tx.done = true; needle = clamp(tx.rx, METER_LO, METER_HI); drawBench(0); }
    kick();
  }

  function play() {
    if (S.mode !== 'auto') {
      S.mode = 'auto';
      run.playing = true;
      autoReset();
    } else if (run.phase === 'done' && !run.playing) {
      run.playing = true;
      autoReset();
    } else {
      run.playing = !run.playing;
    }
    syncControls();
    updateOut();
    kick();
  }

  function restart() {
    S.mode = 'auto';
    run.playing = true;
    autoReset();
    syncControls();
    updateOut();
    kick();
  }

  function clearLog() {
    S.log = [];
    if (S.mode === 'auto') autoReset();
    updateOut();
    kick();
  }

  function power(v) { const w = Number(v); if (!POWERS.some(p => p.w === w) || w === S.w) return; S.w = w; onSetup(); }
  function antenna(id) { if (!ANTENNAS[id] || id === S.ant) return; S.ant = id; onSetup(); }
  function country(id) { if (!COUNTRY[id] || id === S.country) return; S.country = id; onSetup(); }
  function step(v) { const s = Number(v); if (!STEPS.includes(s) || s === S.step) return; S.step = s; onSetup(); }
  function flutter(on) { S.flutter = !!on; onSetup(); }
  function set(key, v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    if (key === 'km') S.km = clamp(Math.round(n), 2, 120);
    else if (key === 'hb') S.hb = clamp(Math.round(n), 30, 200);
    else return;
    onSetup();
  }
  function view(v) {
    if (v !== 'db' && v !== 'w') return;
    S.view = v;
    syncControls();
    drawLadder();
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
    const t = (n, fb) => (typeof cssVar === 'function' ? cssVar(n, fb) : fb);
    palCache = {
      text: t('--text', '#16202a'), muted: t('--muted', '#4f6478'), border: t('--border', '#dde5ee'),
      panel: t('--panel', '#fff'), subtle: t('--subtle', '#f7fafc'), accent: t('--accent', '#0b5cab'),
      ok: t('--ok', '#107c10'), warn: t('--warn', '#9e5e00'), bad: t('--bad', '#c7401a'),
      wave: t('--rp-wave', '#0088b8'), echo: t('--rp-echo', '#d26a00'), sum: t('--rp-sum', '#7c35a3'),
      sky: t('--rp-sky', '#cfe3f6'), sky2: t('--rp-sky-2', '#f2f7fc'), grass: t('--rp-grass', '#b5cf8f'),
      tree: t('--rp-tree', '#2f6b35'), repeater: t('--role-repeater', '#0b5cab'),
    };
    return palCache;
  }

  const FONT = (px, wt = 400) => `${wt} ${px}px system-ui, -apple-system, Segoe UI, sans-serif`;

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // A label on a pale pill, so it reads over the sky and the ground.
  function pill(ctx, C, text, x, y, align = 'left', col = C.text) {
    const tw = ctx.measureText(text).width;
    const x0 = align === 'center' ? x - tw / 2 : align === 'right' ? x - tw : x;
    ctx.fillStyle = C.panel;
    ctx.globalAlpha = 0.85;
    roundRect(ctx, x0 - 4, y - 12, tw + 8, 16, 4);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = col;
    ctx.fillText(text, x0, y);
  }

  function needleTarget() {
    if (tx && tx.t >= FLY_MS && (!tx.done || stillPreferred())) return clamp(tx.rx, METER_LO, METER_HI);
    return METER_LO;
  }

  function drawBench(time) {
    const g = fit($('rp-fm-bench'));
    if (!g) return;
    const { ctx, w, h } = g;
    const C = pal();
    const o = cur();
    const B = budget(o);
    const small = w < 560;
    const still = stillPreferred();

    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, C.sky);
    sky.addColorStop(1, C.sky2);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    // Left to right: the radio, the attenuator, the mast; the country; the
    // repeater's hill, with the meter in the corner above it.
    const groundY = h - (small ? 28 : 36);
    const radio = { x: 8, w: small ? 50 : 70, h: small ? 32 : 40 };
    radio.y = groundY - radio.h - 8;
    const att = { w: small ? 64 : 88, h: small ? 60 : 74 };
    att.x = radio.x + radio.w + (small ? 12 : 24);
    att.y = groundY - att.h - (small ? 30 : 40);
    const mastX = att.x + att.w + (small ? 18 : 32);
    const antY = groundY - Math.min(small ? 110 : 150, h * 0.5);
    const rptX = w - (small ? 34 : 58);
    const hillW = small ? 44 : 70;
    const rMast = small ? 24 : 32;
    const mr = small ? 30 : 42;
    const mcx = w - mr - (small ? 10 : 18), mcy = mr + (small ? 10 : 14);
    const mBottom = mcy + (small ? 32 : 40);
    // The hill stands taller for a higher repeater, but never up into the meter.
    const hillH = Math.min((small ? 16 : 24) + (o.hb - 30) / 170 * h * 0.3, groundY - rMast - 36 - mBottom);
    const x0 = mastX + 16, x1 = rptX - hillW * 0.9;
    const amp = { open: 0, light: small ? 6 : 9, dense: small ? 14 : 24 }[o.country] || 0;
    const groundAt = x => {
      let y = groundY;
      if (x > x0 && x < x1) {
        const u = (x - x0) / (x1 - x0);
        y -= Math.sin(Math.PI * u) * amp * (0.55 + 0.45 * Math.sin(u * 9.3) * Math.sin(u * 3.1 + 1));
      }
      const dx = (x - rptX) / hillW;
      return y - hillH * Math.exp(-dx * dx);
    };
    const rTop = groundAt(rptX) - rMast;

    const ant = ANTENNAS[o.ant];
    const antPt = ant.beam ? { x: mastX + 20, y: antY - 6 } : { x: mastX, y: antY - 22 };
    const rxPt = { x: rptX, y: rTop - 18 };

    // The transmission: wavefronts leaving the antenna, and the frame itself.
    if (tx) {
      const p = still ? 0.62 : Math.min(1, tx.t / FLY_MS);
      if (p < 1 || still) {
        const D = Math.hypot(rxPt.x - antPt.x, rxPt.y - antPt.y);
        const strength = clamp((tx.eirp + 8) / 62, 0.18, 1);
        ctx.strokeStyle = C.wave;
        for (let k = 0; k < 3; k++) {
          const r = p * D - k * 15;
          if (r <= 4) continue;
          ctx.globalAlpha = Math.max(0.07, strength * (1 - 0.7 * r / D) * (1 - k * 0.3));
          ctx.lineWidth = ant.beam ? 3 : 2;
          ctx.beginPath();
          if (ant.beam) ctx.arc(antPt.x, antPt.y, r, -0.42, 0.3);
          else ctx.arc(antPt.x, antPt.y, r, -2.5, 0.42);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        const fx = antPt.x + (rxPt.x - antPt.x) * p, fy = antPt.y + (rxPt.y - antPt.y) * p;
        ctx.fillStyle = C.wave;
        ctx.globalAlpha = 0.25;
        ctx.beginPath(); ctx.arc(fx, fy, 9, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
        ctx.beginPath(); ctx.arc(fx, fy, 4, 0, Math.PI * 2); ctx.fill();
      }
    }

    // The ground, the trees, the repeater's hill.
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += 3) ctx.lineTo(x, groundAt(x));
    ctx.lineTo(w, groundAt(w));
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = C.grass;
    ctx.fill();
    const trees = { open: 0, light: 7, dense: 24 }[o.country] || 0;
    for (let k = 0; k < trees; k++) {
      const jitter = Math.sin((k + 1) * 12.9898) * 43758.5453;
      const u = (k + 0.5 + 0.6 * (jitter - Math.floor(jitter) - 0.5)) / trees;
      const x = x0 + (x1 - x0) * u;
      const y = groundAt(x);
      const r = o.country === 'dense' ? (small ? 5 : 7) : (small ? 4 : 6);
      ctx.strokeStyle = C.tree; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - r); ctx.stroke();
      ctx.fillStyle = C.tree;
      ctx.beginPath(); ctx.arc(x, y - r - r * 0.7, r, 0, Math.PI * 2); ctx.fill();
    }

    // The repeater: a hut, a mast and a collinear on the hilltop.
    ctx.fillStyle = C.panel; ctx.strokeStyle = C.text; ctx.lineWidth = 1.5;
    roundRect(ctx, rptX - 12, groundAt(rptX) - 12, 16, 12, 2);
    ctx.fill(); ctx.stroke();
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(rptX + 2, groundAt(rptX)); ctx.lineTo(rptX + 2, rTop); ctx.stroke();
    ctx.fillStyle = C.panel; ctx.lineWidth = 1.5;
    roundRect(ctx, rptX, rTop - 30, 4, 30, 2);
    ctx.fill(); ctx.stroke();
    if (tx && tx.logged) {
      const k = still ? 0.4 : clamp((tx.t - FLY_MS) / SHOW_MS, 0, 1);
      if (k < 1) {
        ctx.strokeStyle = tx.pass ? C.ok : C.bad;
        ctx.globalAlpha = 1 - k;
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(rxPt.x + 2, rxPt.y, 8 + 18 * k, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
    ctx.font = FONT(small ? 11 : 12, 600);
    pill(ctx, C, small ? 'Repeater' : `Repeater, ${o.hb} m up`, rptX - 10, rTop - 8, 'right');

    // The field station: radio → attenuator → feeder up the mast → antenna.
    const radioMid = radio.y + radio.h / 2, attMid = att.y + att.h / 2;
    ctx.strokeStyle = C.text; ctx.lineWidth = 3; ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(radio.x + radio.w, radioMid);
    ctx.lineTo(att.x - 8, radioMid);
    ctx.lineTo(att.x - 8, attMid);
    ctx.lineTo(att.x, attMid);
    ctx.moveTo(att.x + att.w, attMid);
    ctx.lineTo(mastX - 5, attMid);
    ctx.lineTo(mastX - 5, antY + 4);
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(mastX, groundY); ctx.lineTo(mastX, antY); ctx.stroke();
    // The antenna, as it is.
    ctx.lineWidth = 1.5;
    if (o.ant === 'unity') {
      ctx.beginPath(); ctx.moveTo(mastX, antY); ctx.lineTo(mastX, antY - 30); ctx.stroke();
      ctx.fillStyle = C.text; ctx.beginPath(); ctx.arc(mastX, antY - 31, 2, 0, Math.PI * 2); ctx.fill();
      for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(mastX, antY); ctx.lineTo(mastX + s * 10, antY + 6); ctx.stroke(); }
    } else if (o.ant === 'col3') {
      ctx.fillStyle = C.panel;
      roundRect(ctx, mastX - 3, antY - 46, 6, 46, 3);
      ctx.fill(); ctx.stroke();
      for (const y of [antY - 30, antY - 16]) { ctx.beginPath(); ctx.moveTo(mastX - 3, y); ctx.lineTo(mastX + 3, y + 3); ctx.stroke(); }
    } else {
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(mastX - 6, antY - 6); ctx.lineTo(mastX + 44, antY - 6); ctx.stroke();
      ctx.lineWidth = 1.5;
      [26, 23, 21, 20, 19, 18].forEach((len, i) => {
        const x = mastX - 4 + i * 9.4;
        ctx.beginPath(); ctx.moveTo(x, antY - 6 - len / 2); ctx.lineTo(x, antY - 6 + len / 2); ctx.stroke();
      });
    }
    // The radio.
    ctx.fillStyle = C.panel; ctx.strokeStyle = C.text; ctx.lineWidth = 1.5;
    roundRect(ctx, radio.x, radio.y, radio.w, radio.h, 5);
    ctx.fill(); ctx.stroke();
    const keyed = tx && (still ? true : tx.t < FLY_MS);
    ctx.fillStyle = keyed ? C.bad : C.muted;
    ctx.globalAlpha = keyed ? 1 : 0.35;
    ctx.beginPath(); ctx.arc(radio.x + radio.w - 8, radio.y + 8, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = C.text;
    ctx.font = FONT(small ? 12 : 14, 700);
    ctx.fillText(`${o.w} W`, radio.x + 7, radio.y + radio.h - (small ? 9 : 11));
    ctx.font = FONT(small ? 9 : 10, 600);
    ctx.fillStyle = C.muted;
    ctx.fillText('RADIO', radio.x + 7, radio.y + (small ? 11 : 13));
    // The attenuator: a knob through 270°, and its setting in figures.
    ctx.fillStyle = C.panel; ctx.strokeStyle = C.text; ctx.lineWidth = 1.5;
    roundRect(ctx, att.x, att.y, att.w, att.h, 6);
    ctx.fill(); ctx.stroke();
    ctx.font = FONT(small ? 10 : 11, 600);
    pill(ctx, C, small ? 'Attenuator' : 'Step attenuator', att.x + att.w / 2, att.y - 6, 'center');
    const kx = att.x + att.w / 2, ky = att.y + att.h * 0.42, kr = att.h * 0.25;
    const A0 = Math.PI * 0.75, A1 = Math.PI * 2.25;
    const angOf = v => A0 + (A1 - A0) * clamp(v, 0, ATTEN_MAX) / ATTEN_MAX;
    ctx.strokeStyle = C.muted; ctx.lineWidth = 1;
    for (let v = 0; v <= ATTEN_MAX; v += 3) {
      const an = angOf(v), long = v % 15 === 0;
      ctx.beginPath();
      ctx.moveTo(kx + Math.cos(an) * (kr + 2), ky + Math.sin(an) * (kr + 2));
      ctx.lineTo(kx + Math.cos(an) * (kr + (long ? 7 : 4.5)), ky + Math.sin(an) * (kr + (long ? 7 : 4.5)));
      ctx.stroke();
    }
    ctx.fillStyle = C.subtle; ctx.strokeStyle = C.text; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(kx, ky, kr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    const an = angOf(disp);
    ctx.strokeStyle = C.bad; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(kx, ky); ctx.lineTo(kx + Math.cos(an) * kr * 0.85, ky + Math.sin(an) * kr * 0.85); ctx.stroke();
    ctx.lineCap = 'butt';
    ctx.fillStyle = C.text;
    ctx.font = FONT(small ? 12 : 14, 700);
    const at = `${S.atten} dB`;
    ctx.fillText(at, kx - ctx.measureText(at).width / 2, att.y + att.h - (small ? 6 : 8));

    // The distance, and the station's name.
    ctx.font = FONT(small ? 11 : 12, 600);
    const yd = groundY + (small ? 17 : 22);
    ctx.strokeStyle = C.text; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(mastX, yd - 4); ctx.lineTo(rptX, yd - 4); ctx.stroke();
    for (const [x, s] of [[mastX, 1], [rptX, -1]]) {
      ctx.beginPath(); ctx.moveTo(x, yd - 4); ctx.lineTo(x + s * 6, yd - 8); ctx.moveTo(x, yd - 4); ctx.lineTo(x + s * 6, yd); ctx.stroke();
    }
    pill(ctx, C, `${o.km} km — ${COUNTRY[o.country].label.toLowerCase()}`, (mastX + rptX) / 2, yd, 'center');
    pill(ctx, C, small ? 'Station' : 'Field station', radio.x + 2, yd);

    // The meter: a semicircle from METER_LO to METER_HI dBm.
    const mAng = v => Math.PI + Math.PI * (clamp(v, METER_LO, METER_HI) - METER_LO) / (METER_HI - METER_LO);
    ctx.fillStyle = C.panel;
    ctx.globalAlpha = 0.9;
    roundRect(ctx, mcx - mr - 8, mcy - mr - 8, mr * 2 + 16, mr + (small ? 40 : 48), 8);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = C.border; ctx.lineWidth = 1; ctx.stroke();
    ctx.lineWidth = small ? 5 : 7;
    for (const [a, b, col] of [[METER_LO, RX_DBM, C.bad], [RX_DBM, RX_DBM + GOOD_DB, C.warn], [RX_DBM + GOOD_DB, METER_HI, C.ok]]) {
      ctx.strokeStyle = col; ctx.globalAlpha = 0.65;
      ctx.beginPath(); ctx.arc(mcx, mcy, mr, mAng(a), mAng(b)); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // where the needle would go, with the attenuator where it is now
    const ga = mAng(B.rx);
    ctx.fillStyle = C.text;
    ctx.beginPath();
    ctx.moveTo(mcx + Math.cos(ga) * (mr + 5), mcy + Math.sin(ga) * (mr + 5));
    ctx.lineTo(mcx + Math.cos(ga - 0.07) * (mr + 11), mcy + Math.sin(ga - 0.07) * (mr + 11));
    ctx.lineTo(mcx + Math.cos(ga + 0.07) * (mr + 11), mcy + Math.sin(ga + 0.07) * (mr + 11));
    ctx.closePath(); ctx.fill();
    const na = mAng(still ? needleTarget() : needle);
    ctx.strokeStyle = C.text; ctx.lineWidth = 2; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(mcx, mcy); ctx.lineTo(mcx + Math.cos(na) * (mr - 4), mcy + Math.sin(na) * (mr - 4)); ctx.stroke();
    ctx.lineCap = 'butt';
    ctx.beginPath(); ctx.arc(mcx, mcy, 3, 0, Math.PI * 2); ctx.fill();
    ctx.font = FONT(small ? 11 : 13, 700);
    const showing = tx && tx.logged;
    const val = showing ? `${num(tx.rx)} dBm` : `${num(B.rx)} dBm`;
    ctx.fillStyle = C.text;
    ctx.fillText(val, mcx - ctx.measureText(val).width / 2, mcy + (small ? 14 : 17));
    ctx.font = FONT(small ? 9 : 11, 600);
    const verdict = showing ? (tx.pass ? '✓ Heard' : '✗ Missed') : `needs ${num(RX_DBM, 0)}`;
    ctx.fillStyle = showing ? (tx.pass ? C.ok : C.bad) : C.muted;
    ctx.fillText(verdict, mcx - ctx.measureText(verdict).width / 2, mcy + (small ? 26 : 32));

    // Which mode, top left.
    ctx.font = FONT(small ? 11 : 12, 600);
    const head = S.mode === 'auto'
      ? (run.phase === 'done' ? `Auto · book ${bookTxt(logFacts().best)}` : `Auto · ${S.step} dB steps`)
      : 'Manual';
    pill(ctx, C, head, 10, 20);
  }

  function drawLadder() {
    const g = fit($('rp-fm-ladder'));
    if (!g) return;
    const { ctx, w, h } = g;
    const C = pal();
    const o = cur(), B = budget(o);
    const small = w < 560;
    const watts = S.view === 'w';
    const narrow = w < 760;
    const left = small ? 40 : 58, right = small ? 54 : narrow ? 92 : 150, top = 16, bot = narrow ? 30 : 26;
    const cols = B.stages.map(s => ({ ...s })).concat([{ id: 'rx', label: 'At the receiver', delta: 0, from: null, level: B.rx, end: true }]);
    const SHORT = { tx: 'Radio', att: 'Atten.', feed: 'Feed', ant: 'Ant.', path: 'Path', rxant: 'Rx ant.', rxfeed: 'Feed', rx: 'Rx' };
    const LONG = { tx: 'Radio', att: 'Attenuator', feed: 'Feeder', ant: 'Antenna', path: 'The path', rxant: 'Rpt antenna', rxfeed: 'Feeder', rx: 'Receiver' };
    const n = cols.length;
    const cw = (w - left - right) / n;
    const plotH = h - top - bot;
    const LO = -140, HI = 60;
    const maxW = dbmToWatts(Math.max(...cols.map(c => c.level))) * 1.08;
    const Y = watts ? v => top + plotH * (1 - dbmToWatts(v) / maxW) : v => top + plotH * (HI - v) / (HI - LO);
    const floorY = top + plotH;
    ctx.font = FONT(11);
    // The grid.
    ctx.strokeStyle = C.border; ctx.fillStyle = C.muted; ctx.lineWidth = 1;
    if (!watts) {
      for (let v = HI; v >= LO; v -= 20) {
        ctx.beginPath(); ctx.moveTo(left, Y(v)); ctx.lineTo(w - right + 6, Y(v)); ctx.stroke();
        ctx.fillText(`${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.abs(v)}`, 4, Y(v) + 4);
      }
      ctx.fillText('dBm', 4, top - 4);
      if (!narrow) {
        for (const [v, t] of [[30, '1 W'], [0, '1 mW'], [-30, '1 µW'], [-60, '1 nW'], [-90, '1 pW'], [-120, '1 fW']]) {
          ctx.fillText(`= ${t}`, w - 50, Y(v) + 4);
          ctx.beginPath(); ctx.moveTo(w - 68, Y(v)); ctx.lineTo(w - 54, Y(v)); ctx.stroke();
        }
      }
    } else {
      const raw = maxW / 4, mag = Math.pow(10, Math.floor(lg(raw)));
      const stepW = [1, 2, 2.5, 5, 10].map(k => k * mag).find(k => k >= raw) || raw;
      for (let v = 0; v <= maxW + 1e-12; v += stepW) {
        const y = top + plotH * (1 - v / maxW);
        ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(w - right + 6, y); ctx.stroke();
        ctx.fillText(fmtW(v), 4, y + 4);
      }
    }
    // The bars.
    let prev = null;
    cols.forEach((c, i) => {
      const x = left + i * cw + cw * 0.17, bw = cw * 0.66;
      const yTo = Y(c.level);
      const yFrom = i === 0 || c.end ? floorY : Y(c.from);
      const col = i === 0 ? C.accent : c.end ? (B.margin >= GOOD_DB ? C.ok : B.margin >= FLOOR_DB ? C.warn : C.bad)
        : c.delta < 0 ? C.bad : C.ok;
      ctx.fillStyle = col;
      ctx.globalAlpha = i === 0 || c.end ? 0.85 : 0.7;
      const y0 = Math.min(yFrom, yTo), bh = Math.max(1.5, Math.abs(yTo - yFrom));
      ctx.fillRect(x, y0, bw, bh);
      ctx.globalAlpha = 1;
      if (prev) {
        ctx.strokeStyle = C.muted; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(prev.x + prev.bw, Y(prev.level)); ctx.lineTo(c.end ? x + bw : x, Y(prev.level)); ctx.stroke();
        ctx.setLineDash([]);
      }
      // What each bar says: the two ends inside their bars, the stages over
      // theirs — all but the feeders and the repeater's antenna on a phone,
      // where the readout under the drawing says them.
      ctx.font = FONT(small ? 10 : 11, 600);
      const lab = watts ? fmtW(dbmToWatts(c.level))
        : i === 0 || c.end ? `${num(c.level)}` : sgnTrim(c.delta);
      const tw = ctx.measureText(lab).width;
      const inside = !watts && (i === 0 || c.end) && bh > 18 && tw < bw - 2;
      if (inside) {
        ctx.fillStyle = '#fff';
        ctx.fillText(lab, x + bw / 2 - tw / 2, y0 + 13);
      } else if (!(small && ['feed', 'rxant', 'rxfeed'].includes(c.id))) {
        ctx.fillStyle = C.text;
        const ly = y0 - 4 < top + 8 ? y0 + 12 : y0 - 4;
        ctx.fillText(lab, clamp(x + bw / 2 - tw / 2, 2, w - tw - 2), ly);
      }
      ctx.font = FONT(small ? 9 : 11);
      ctx.fillStyle = C.muted;
      const name = (narrow ? SHORT : LONG)[c.id];
      const nw = ctx.measureText(name).width;
      ctx.fillText(name, x + bw / 2 - nw / 2, h - (narrow ? 16 : 8));
      if (narrow && (i === 0 || c.end || c.id === 'att')) {
        const sub = c.id === 'att' ? `${B.atten} dB` : c.end ? 'dBm' : `${o.w} W`;
        const sw = ctx.measureText(sub).width;
        ctx.fillText(sub, x + bw / 2 - sw / 2, h - 5);
      }
      prev = { x, bw, level: c.level };
    });
    const endX = left + (n - 1) * cw + cw * 0.17, endW = cw * 0.66;
    if (!watts) {
      // What the receiver needs, and the margin above it.
      const yt = Y(RX_DBM);
      ctx.strokeStyle = C.bad; ctx.setLineDash([6, 4]); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(left, yt); ctx.lineTo(w - right + 6, yt); ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = FONT(small ? 10 : 11, 600);
      ctx.fillStyle = C.bad;
      const need = small ? `needs ${num(RX_DBM, 0)}` : `the receiver needs ${num(RX_DBM, 0)} dBm`;
      ctx.fillText(need, left + cw * 1.1, yt + 14);
      const yr = Y(B.rx), bx = endX + endW + 5;
      ctx.strokeStyle = C.text; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(bx, yr); ctx.lineTo(bx + 5, yr); ctx.lineTo(bx + 5, yt); ctx.lineTo(bx, yt); ctx.stroke();
      ctx.fillStyle = C.text;
      ctx.font = FONT(small ? 10 : 12, 700);
      const m = `${sign(B.margin)} dB`;
      ctx.fillText(m, bx + 9, (yr + yt) / 2 + 4);
      if (!small) {
        ctx.font = FONT(10);
        ctx.fillStyle = C.muted;
        ctx.fillText(B.margin >= 0 ? 'fade margin' : 'short', bx + 9, (yr + yt) / 2 + 16);
      }
      // The other two transmitters, at the receiver: 7 dB a step.
      ctx.font = FONT(10);
      for (const p of POWERS) {
        if (p.w === o.w) continue;
        const y = Y(B.rx + wattsToDbm(p.w) - B.ptx);
        ctx.strokeStyle = C.muted; ctx.setLineDash([2, 2]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(endX - 4, y); ctx.lineTo(endX + endW, y); ctx.stroke();
        ctx.setLineDash([]);
        if (small) continue;
        ctx.fillStyle = C.muted;
        const t = p.label;
        ctx.fillText(t, endX - 6 - ctx.measureText(t).width, y + 3);
      }
    } else {
      const px = dbmToWatts(B.rx) / maxW * plotH;
      ctx.font = FONT(small ? 10 : 12, 600);
      ctx.fillStyle = C.text;
      const lines = [
        'After the path, every bar is too small to see.',
        `At this scale the receiver's ${fmtW(dbmToWatts(B.rx))} is ${sci(px)} of a pixel.`,
      ];
      const xx = left + cw * 3.4;
      lines.forEach((t, i) => pill(ctx, C, t, Math.min(xx, w - right - ctx.measureText(t).width), top + 30 + i * 20));
    }
  }

  function drawSteps() {
    const g = fit($('rp-fm-steps'));
    if (!g) return;
    const { ctx, w, h } = g;
    const C = pal();
    const M = stationMargin();
    const small = w < 560;
    const left = small ? 62 : 92, right = 14;
    const X = db => left + (w - left - right) * (db + 1) / 35;
    // Behind everything: the bands.
    const yb = 4, hb = 16;
    ctx.font = FONT(small ? 10 : 11, 600);
    for (const [a, b, col, t] of [[-1, FLOOR_DB, C.bad, 'Poor'], [FLOOR_DB, GOOD_DB, C.warn, 'Marginal'], [GOOD_DB, 34, C.ok, 'Good']]) {
      ctx.fillStyle = col; ctx.globalAlpha = 0.16;
      ctx.fillRect(X(a), yb, X(b) - X(a), h - yb - 4);
      ctx.globalAlpha = 1;
      ctx.fillStyle = col;
      if (!(small && t === 'Poor')) ctx.fillText(t, X(a) + 3, yb + 12);
    }
    const rows = [[3, h * 0.43, C.wave], [5, h * 0.76, C.echo]];
    for (const [step, y, col] of rows) {
      const r = reading(M, step);
      ctx.font = FONT(small ? 11 : 12, 600);
      ctx.fillStyle = C.text;
      ctx.fillText(`${step} dB steps`, 4, y + 4);
      ctx.strokeStyle = C.border; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(X(0), y); ctx.lineTo(X(ATTEN_MAX), y); ctx.stroke();
      if (r.reading !== null) {
        const hi = r.atLeast ? 34 : r.hi;
        ctx.fillStyle = col; ctx.globalAlpha = 0.25;
        ctx.fillRect(X(r.lo), y - 10, X(hi) - X(r.lo), 20);
        ctx.globalAlpha = 1;
        ctx.font = FONT(small ? 10 : 11, 600);
        const t = r.atLeast ? `reads ≥${r.reading}` : `reads ${r.reading}: ${r.lo}–${r.hi} dB`;
        pill(ctx, C, t, clamp(X(r.lo), left, w - right - ctx.measureText(t).width - 4), y - 14, 'left', C.text);
      }
      const rad = small ? 4.5 : 6;
      r.points.forEach((a, i) => {
        const sent = i < r.sent, pass = sent && M - a >= 0;
        ctx.beginPath(); ctx.arc(X(a), y, rad, 0, Math.PI * 2);
        if (pass) { ctx.fillStyle = C.ok; ctx.fill(); }
        else if (sent) { ctx.fillStyle = C.bad; ctx.fill(); }
        else { ctx.fillStyle = C.panel; ctx.fill(); ctx.strokeStyle = C.muted; ctx.lineWidth = 1.2; ctx.stroke(); }
        ctx.font = FONT(small ? 9 : 10);
        ctx.fillStyle = C.muted;
        const t = String(a);
        ctx.fillText(t, X(a) - ctx.measureText(t).width / 2, y + rad + 11);
      });
    }
    // This link's margin.
    const xm = X(clamp(M, -1, 34));
    ctx.strokeStyle = C.text; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(xm, yb + hb + 4); ctx.lineTo(xm, h - 4); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = FONT(small ? 10 : 11, 700);
    const t = M > 34 ? `this link ${num(M)} dB →` : `this link ${num(M)} dB`;
    pill(ctx, C, t, clamp(xm + 5, left, w - right - ctx.measureText(t).width - 4), yb + hb + 16);
  }

  function drawStair() {
    const g = fit($('rp-fm-stair'));
    if (!g) return;
    const { ctx, w, h } = g;
    const C = pal();
    const M = stationMargin();
    const small = w < 560;
    const left = small ? 30 : 46, right = 12, top = 14, bot = 32;
    const XM = 33, YM = 31;
    const X = db => left + (w - left - right) * db / XM;
    const Y = db => top + (h - top - bot) * (1 - db / YM);
    ctx.font = FONT(small ? 10 : 11);
    ctx.strokeStyle = C.border; ctx.fillStyle = C.muted; ctx.lineWidth = 1;
    for (let v = 0; v <= 30; v += 5) {
      ctx.beginPath(); ctx.moveTo(left, Y(v)); ctx.lineTo(w - right, Y(v)); ctx.stroke();
      ctx.fillText(String(v), 4, Y(v) + 4);
      ctx.beginPath(); ctx.moveTo(X(v), top); ctx.lineTo(X(v), h - bot); ctx.stroke();
      ctx.fillText(String(v), X(v) - 5, h - bot + 13);
    }
    const xt = 'true fade margin, dB →';
    ctx.fillText(xt, w - right - ctx.measureText(xt).width, h - 4);
    ctx.fillText('what the test reads', left + 4, top + 2);
    // A perfect test, 1 : 1 to the attenuator's limit.
    ctx.strokeStyle = C.muted; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(X(0), Y(0)); ctx.lineTo(X(30), Y(30)); ctx.lineTo(X(XM), Y(30)); ctx.stroke();
    ctx.setLineDash([]);
    const stair = s => {
      const pts = [[0, 0]];
      for (let a = 0; a < XM; a += s) {
        const r = Math.min(a, 30), nx = Math.min(a + s, XM);
        pts.push([a, r], [nx, r]);
      }
      return pts;
    };
    for (const [s, col] of [[5, C.echo], [3, C.wave]]) {
      const pts = stair(s);
      // the gap between the test and the truth
      ctx.beginPath();
      ctx.moveTo(X(0), Y(0));
      pts.forEach(([x, y]) => ctx.lineTo(X(x), Y(y)));
      ctx.lineTo(X(XM), Y(30)); ctx.lineTo(X(30), Y(30)); ctx.closePath();
      ctx.fillStyle = col; ctx.globalAlpha = 0.1; ctx.fill(); ctx.globalAlpha = 1;
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
      ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.stroke();
    }
    // This link.
    if (M >= 0 && M <= XM) {
      ctx.strokeStyle = C.text; ctx.setLineDash([3, 3]); ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(X(M), top); ctx.lineTo(X(M), h - bot); ctx.stroke();
      ctx.setLineDash([]);
      for (const [s, col] of [[3, C.wave], [5, C.echo]]) {
        const r = reading(M, s);
        if (r.reading === null) continue;
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(X(M), Y(r.reading), 5, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = C.text;
      ctx.beginPath(); ctx.arc(X(M), Y(Math.min(M, 30)), 4, 0, Math.PI * 2); ctx.fill();
    }
    // The key.
    ctx.font = FONT(small ? 10 : 11, 600);
    // The key, stacked in the corner the staircases never reach.
    const key = [[C.muted, 'a perfect test', true], [C.wave, '3 dB steps'], [C.echo, '5 dB steps']];
    const kw = 26 + Math.max(...key.map(([, t]) => ctx.measureText(t).width));
    const kx = w - right - kw - 4;
    key.forEach(([col, t, dash], i) => {
      const ky = Y(9) + i * 16;
      ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.setLineDash(dash ? [5, 4] : []);
      ctx.beginPath(); ctx.moveTo(kx, ky - 4); ctx.lineTo(kx + 18, ky - 4); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = C.text;
      ctx.fillText(t, kx + 24, ky);
    });
  }

  // ── The loop ───────────────────────────────────────────────────────────────

  function tick(ts) {
    loop = 0;
    if (!$('rp-fm-bench')) return;
    const dt = last ? Math.min(80, ts - last) : 0;
    last = ts;
    if (S.mode === 'auto' && run.playing) advanceAuto(dt); else advanceTx(dt);
    const target = needleTarget();
    needle += (target - needle) * Math.min(1, dt / 110);
    drawBench(ts);
    const moving = (S.mode === 'auto' && run.playing) || (tx && !tx.done) || Math.abs(needle - target) > 0.2;
    if (visible && moving) loop = requestAnimationFrame(tick);
    else last = 0;
  }
  function kick() { if (!loop && visible && $('rp-fm-bench')) loop = requestAnimationFrame(tick); }

  function mount() {
    unmount();
    const bench = $('rp-fm-bench');
    if (!bench) return;
    disp = S.atten;
    procShown = -2;
    if (S.mode === 'auto') {
      if (stillPreferred()) runInstant();
      else { run.playing = true; autoReset(); }
    }
    const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(es => {
      for (const e of es) visible = e.isIntersecting;
      kick();
    }) : null;
    if (io) io.observe(bench);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
      drawBench(performance.now()); drawLadder(); drawSteps(); drawStair();
    }) : null;
    if (ro) ['rp-fm-bench', 'rp-fm-ladder', 'rp-fm-steps', 'rp-fm-stair'].forEach(id => { const el = $(id); if (el) ro.observe(el); });
    wired = { io, ro };
    requestAnimationFrame(() => { refreshAll(); kick(); });
  }

  function unmount() {
    if (loop) cancelAnimationFrame(loop);
    loop = 0; last = 0;
    if (wired) {
      if (wired.io) wired.io.disconnect();
      if (wired.ro) wired.ro.disconnect();
      wired = null;
    }
    run.playing = false;
    tx = null;
    visible = true;
  }

  function state() {
    return { ...JSON.parse(JSON.stringify(S)), phase: run.phase, playing: run.playing, margin: stationMargin() };
  }

  return {
    POWERS, ANTENNAS, COUNTRY, STEPS, F_MHZ, RX_DBM, FEED_DB, FIELD_AGL, RX_GAIN_DBI, DIPOLE_DBI, ATTEN_MAX,
    GOOD_DB, FLOOR_DB, FLUTTER_DB,
    wattsToDbm, dbmToWatts, hataDb, hataSlope, horizonKm, shadowDbPerKm, pathLossDb, budget, band, reading,
    coarseFine, rangeKm, fmtW, zerosW,
    render, mount, unmount, mode, power, antenna, country, step, set, atten, bump, send, play, restart, clearLog,
    flutter, view, stationMargin, state,
  };
})();
