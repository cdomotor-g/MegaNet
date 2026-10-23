// MegaNet — swr-meter.js
//
//   SwrMeter   the 📟 SWR Meter tab, in the Knowledge base: the through-line
//              power and SWR meters in the field kit — how to put one in the
//              antenna line, what it is measuring, and what its readings mean
//              at a site. Pick the meter, then either a made-up station with
//              one fault or the readings off your own meter, and the line
//              runs: power leaving the radio, through the meter, up the feeder
//              and out of the antenna, and whatever comes back — with the
//              meter's own face showing what it would read, and what to do.
//
//                 1  the meter in the line: the bench (all of the above)
//                 2  hooking it up — the steps for the meter picked
//                 3  what it is measuring: forward and reflected waves, the
//                    standing wave they make, and the coupler that tells
//                    them apart
//                 4  watts, decibels and the fade margin: what a decibel
//                    costs a station, and when it matters
//                 5  reading the readings: symptom to cause, in a table
//                 6  a case: down on power after a remediation
//                 7  where each shows up in Flood-Net
//
// After swr-model.js (SwrModel — every number on the page is its); across to
// core.js (esc, escAttr, announce, dlText, registerTabTeardown) and app.js
// (switchTab) at call time. Nothing runs at load: renderMain() calls render()
// and init().
//
// The meters are drawn, not photographed: SVG after each meter's real layout —
// its sockets, its screen, its buttons and switches — so the readings can be
// written onto its screen and its controls worked. They are close to the real
// thing, not copies of it; a firmware's screen may differ in detail.
//
// The radio transmits the way it does on site: a short burst each time the
// TEST button on the A2's front panel is pressed — the animation presses it
// every few seconds, and 📡 Press TEST (or the button drawn on the radio)
// presses it now — or held on by its tones setting, which can be coaxed on
// but rarely stays on. How each meter copes with a burst is most of what goes
// wrong with a reading, so it is modelled: the needle swings with a lag, the
// SW-102 catches each burst late and partly, the 3030's PEAK and HOLD keep it.
//
// One animation loop, only while a moving drawing is on screen and the tab is
// open; a device asking for reduced motion starts still, settled, with ▶ to
// run it. Every control on a drawing is also a real control beside it.
//
// Exposes: render, init, open, set, pick, scenario, source, type, tx, test, where,
//          dev, play, sw, go, tab, exportTxt, state.

const SwrMeter = (function () {
  const M = () => SwrModel;
  const KEY = 'mn-swr-meter';
  const T_LINE = 2.6;                    // s: a particle from the radio to the antenna
  const BURST = { on: 0.22, every: 2.6 };     // s: a TEST burst, and how often the animation presses TEST
  const TAU = 0.3;                       // s: a needle's swing
  const HOLD_TAU = 2.2;                  // s: a PEP monitor letting go

  // ── The session's settings ─────────────────────────────────────────────────
  const S = {
    meter: 'sw102',
    source: 'scenario',             // 'scenario' | 'yours'
    scenario: 'healthy',
    where: 'radio',                  // 'radio' | 'antenna'
    tx: 'test',                      // 'off' | 'test' (the A2's TEST button) | 'tones' (held on)
    yours: { fwd: '', ref: '', swr: '', setW: '5', cable: '', m: '' },
    sw: { on: true, menu: false, offset: 0 },
    mn: { range: 20, func: 'power', dir: 'fwd', pep: false, cal: 0 },
    cc: { peak: true, hold: true, rl: false },
    playing: true,
    sgGamma: 0.2,                    // the standing-wave drawing's |Γ|
    margin: 6, lossDb: 1.19,         // the fade-margin calculator
    from: '',                        // 'inspections' when it opened us
  };
  let live = null;                   // the running page: loop, observers, needle

  const num = (x, d = 0) => (Number.isFinite(x) ? Number(x).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
  const sTxt = s => (s == null ? '—' : Number.isFinite(s) ? s.toFixed(2) : '∞');
  function W(w) {
    if (w == null || !Number.isFinite(w)) return '—';
    if (w <= 0) return '0 W';
    if (w >= 10) return `${num(w, 1)} W`;
    if (w >= 0.1) return `${num(w, 2)} W`;
    const mw = w * 1000;
    return `${mw >= 10 ? num(mw, 0) : mw >= 1 ? num(mw, 1) : num(mw, 2)} mW`;
  }
  const dB = (x, d = 1) => (Number.isFinite(x) ? `${x > 0 ? '+' : x < 0 ? '−' : ''}${num(Math.abs(x), d)} dB` : '∞ dB');
  const pct = (x, d = 0) => `${num(x, d)}%`;
  const $ = id => document.getElementById(id);
  function still() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (_) { return false; }
  }
  function readLS() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) { return null; } }
  function writeLS() { try { localStorage.setItem(KEY, JSON.stringify({ meter: S.meter })); } catch (_) { /* private mode */ } }

  // A small seeded generator, so the flicker of a loose joint and a meter
  // catching a burst late look random and replay the same.
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

  // ── What is on the line, and what the meter reads ─────────────────────────

  // The station as it really is: the scenario's line, or one built around the
  // readings typed. `flick` scales the antenna's reflection (a loose joint).
  function truth(flick = 1) {
    const m = M();
    if (S.source === 'scenario') {
      const sc = m.SCENARIOS[S.scenario] || m.SCENARIOS.healthy;
      let antSwr = sc.antSwr;
      if (flick !== 1) antSwr = m.swrFromGamma(Math.min(0.97, m.gammaFromSwr(antSwr) * flick));
      const l = m.line({ ...sc, antSwr, where: S.where });
      return { ...l, sc, cable: sc.cable, mLen: sc.m, extraDb: sc.extraDb, ok: true };
    }
    const r = m.interpret({ ...S.yours, where: S.where, meter: S.meter, steady: caught() });
    const setW = Number(S.yours.setW) > 0 ? Number(S.yours.setW) : null;
    if (!r.ok || r.fwd == null) {
      return { ok: false, r, setW, fwd: 0, ref: 0, gamma: 0, swr: null, feedDb: r.feedDb || 0, upDb: 0,
        radioW: setW || 0, atAnt: 0, radiated: 0, antGamma: 0, antSwr: null, cable: S.yours.cable, mLen: Number(S.yours.m) || 0, extraDb: 0 };
    }
    const feedDb = r.feedDb || 0;
    const loss = Math.pow(10, -feedDb / 10);
    const atRadio = S.where === 'radio';
    const atAnt = atRadio ? r.fwd * loss : r.fwd;
    const antGamma = atRadio ? (r.antGamma != null ? r.antGamma : r.gamma) : r.gamma;
    return {
      ok: true, r, setW, fwd: r.fwd, ref: r.ref, gamma: r.gamma, swr: r.swr, feedDb, upDb: 0,
      radioW: atRadio ? r.fwd : (feedDb > 0 ? r.fwd / loss : r.fwd), atAnt, radiated: atAnt * (1 - antGamma * antGamma),
      antGamma, antSwr: M().swrFromGamma(antGamma), cable: S.yours.cable, mLen: Number(S.yours.m) || 0, extraDb: 0,
    };
  }

  // The readings a technician would book from it: what the interpretation is
  // run on in scenario mode.
  function bookable(t) {
    const meter = M().METERS[S.meter];
    let { fwd, ref } = t;
    if (meter.wrongBand) { fwd *= 0.35; ref *= 2.6; }
    if (S.meter === 'sw102' && S.sw.offset) { fwd *= 1 + S.sw.offset / 100; ref *= 1 + S.sw.offset / 100; }
    return { fwd, ref, swr: fwd > 0 ? (ref >= fwd ? Infinity : M().swrFromGamma(Math.sqrt(ref / fwd))) : null };
  }

  function verdictInput() {
    if (S.source === 'yours') return { ...S.yours, where: S.where, meter: S.meter, steady: caught() };
    const t = truth();
    const b = bookable(t);
    return { fwd: b.fwd, ref: b.ref, setW: t.setW, where: S.where, cable: t.cable, m: t.mLen, meter: S.meter, steady: caught() };
  }

  // Is the radio transmitting at this moment? Held on by its tones, never
  // when off, and on TEST for a burst after each press.
  function txOn(time) {
    if (S.tx === 'tones') return true;
    if (S.tx !== 'test' || !live) return false;
    return live.presses.some(p => time >= p && time - p < BURST.on);
  }
  // Does the reading catch the whole signal? Held on, yes; on a TEST burst,
  // only a meter built to hold one — the 3030 with PEAK on.
  const caught = () => S.tx !== 'test' || (S.meter === 'cc3030' && S.cc.peak);

  // ── The facts at the top ───────────────────────────────────────────────────

  function factsHtml() {
    const m = M();
    const facts = [
      ['📉', dB(m.db(3.8 / 5), 1), '3.8 W against 5 W', 'A quarter of the watts gone sounds a lot. In decibels it is 1.2 — an eighth of a 10 dB fade margin.'],
      ['↩️', '4%', 'comes back at SWR 1.5', 'The edge of Good on the inspection form. At 2.0 it is 11%; at 3.0, a quarter.'],
      ['🧵', '× 2', 'a feeder\'s loss, on a reflection', 'Up the cable and back down: so the SWR read at the radio looks better than the antenna\'s.'],
      ['🔌', 'TX → ANT', 'radio in, antenna out', 'Or INPUT → LOAD. In backwards, the meter calls the outgoing power "reflected".'],
      ['📏', `${num(m.CABLES.lmr400.db100, 1)} dB`, 'per 100 m of LMR-400 at 150 MHz', `RG-58 loses ${num(m.CABLES.rg58.db100, 1)}: thirty metres of it eats three-quarters of the power.`],
      ['➗', '÷ 2', 'for every 3 dB', 'Half the watts for 3 dB, a tenth for 10. Decibels add up along a line; watts multiply.'],
    ];
    return `<ul class="swm-facts" aria-label="Numbers worth knowing">${facts.map(([i, big, what, why]) => `
      <li class="swm-fact"><span class="swm-fact-icon" aria-hidden="true">${i}</span>
        <span class="swm-fact-big">${big}</span><span class="swm-fact-what">${what}</span>
        <span class="swm-fact-why">${why}</span></li>`).join('')}</ul>`;
  }

  const TOC = [
    ['swm-bench', '1 · The meter in the line'], ['swm-hook', '2 · Hooking it up'], ['swm-waves', '3 · What it measures'],
    ['swm-db', '4 · Watts, decibels, fade margin'], ['swm-field', '5 · Reading the readings'], ['swm-case', '6 · A case'],
    ['swm-more', '7 · In Flood-Net'],
  ];
  const tocHtml = () => `<nav class="swm-toc" aria-label="On this page">${TOC.map(([id, t]) =>
    `<button type="button" class="swm-toc-btn" onclick="SwrMeter.go('${id}')">${t}</button>`).join('')}</nav>`;

  function head(id, n, icon, title, short) {
    return `<h3 id="${id}-h" tabindex="-1"><span aria-hidden="true">${icon}</span> ${n} · ${esc(title)}</h3>
      ${short ? `<p class="swm-short">${short}</p>` : ''}`;
  }
  const sec = (id, html) => `<section class="panel swm-sec" id="${id}" aria-labelledby="${id}-h">${html}</section>`;

  // ── 1 · The bench ──────────────────────────────────────────────────────────

  // The four meters as a row of buttons, each with a thumbnail of its face.
  function thumb(id) {
    if (id === 'swr400') return `<svg viewBox="0 0 64 40" aria-hidden="true" focusable="false"><rect x="2" y="6" width="60" height="30" rx="3" fill="#1d1e21"/><rect x="6" y="10" width="26" height="16" fill="#f4ead8"/><path d="M9 24 A16 16 0 0 1 29 24" fill="none" stroke="#333" stroke-width="1"/><path d="M19 30 L25 14" stroke="#b22" stroke-width="1.4"/><circle cx="50" cy="18" r="7" fill="#111" stroke="#555"/><rect x="36" y="28" width="4" height="6" fill="#444"/><rect x="44" y="28" width="4" height="6" fill="#444"/><rect x="52" y="28" width="4" height="6" fill="#444"/></svg>`;
    if (id === 'cc3030') return `<svg viewBox="0 0 64 40" aria-hidden="true" focusable="false"><rect x="4" y="18" width="10" height="5" fill="#c9ccd1"/><rect x="50" y="18" width="10" height="5" fill="#c9ccd1"/><rect x="14" y="2" width="36" height="36" rx="6" fill="#2c3a8c"/><rect x="17" y="6" width="30" height="28" rx="4" fill="#f1eee6"/><rect x="20" y="10" width="24" height="13" fill="#c5d3de"/><path d="M22 14h10M22 18h8" stroke="#1d2a6b" stroke-width="1.5"/><rect x="20" y="26" width="5" height="4" fill="#ddd" stroke="#777" stroke-width=".5"/><rect x="27" y="26" width="5" height="4" fill="#ddd" stroke="#777" stroke-width=".5"/><rect x="34" y="26" width="5" height="4" fill="#ddd" stroke="#777" stroke-width=".5"/></svg>`;
    return `<svg viewBox="0 0 64 40" aria-hidden="true" focusable="false"><rect x="2" y="15" width="12" height="7" fill="#c9ccd1"/><rect x="50" y="15" width="12" height="7" fill="#c9ccd1"/><rect x="14" y="2" width="36" height="36" rx="4" fill="#24262a"/><rect x="19" y="7" width="26" height="15" fill="${id === 'sw102hf' ? '#c9b8b0' : '#b8c6d3'}" stroke="#d9772b"/><text x="32" y="19" font-size="8" text-anchor="middle" fill="#24303c" font-family="monospace">1.15</text><circle cx="23" cy="30" r="3.5" fill="#e8452c"/><circle cx="32" cy="30" r="3.5" fill="#2f7fd8"/><circle cx="41" cy="30" r="3.5" fill="#f2d21b"/></svg>`;
  }

  function pickerHtml() {
    const m = M();
    return `<div class="swm-pick" role="group" aria-label="Your meter">${Object.entries(m.METERS).map(([id, d]) => `
      <button type="button" class="swm-pick-btn${d.wrongBand ? ' swm-pick-btn--wrong' : ''}" aria-pressed="${S.meter === id}" onclick="SwrMeter.pick('${id}')">
        ${thumb(id)}<span class="swm-pick-name">${esc(d.name)}</span>
        <span class="swm-pick-band">${d.bandMHz[0]}–${d.bandMHz[1]} MHz${d.wrongBand ? ' · the wrong band' : d.kind === 'needle' ? ' · needle' : ' · digital'}</span>
      </button>`).join('')}</div>`;
  }

  function radios(name, label, opts, cur, call) {
    return `<fieldset class="swm-fs"><legend>${label}</legend><div class="swm-radios">${opts.map(([v, t]) => `
      <label class="swm-radio"><input type="radio" name="${name}" value="${v}"${String(cur) === String(v) ? ' checked' : ''}
        onchange="${call}('${v}')"> <span>${t}</span></label>`).join('')}</div></fieldset>`;
  }

  function sourceHtml() {
    const m = M();
    const y = S.yours;
    const scnOpts = Object.entries(m.SCENARIOS).map(([k, s]) => `<option value="${k}"${S.scenario === k ? ' selected' : ''}>${esc(s.label)}</option>`).join('');
    const cableOpts = `<option value=""${y.cable ? '' : ' selected'}>Not known</option>` + Object.entries(m.CABLES).map(([k, c]) =>
      `<option value="${k}"${y.cable === k ? ' selected' : ''}>${esc(c.label)} — ${num(c.db100, 1)} dB/100 m</option>`).join('');
    const field = (k, lab, unit, hint) => `<label class="swm-in"><span>${lab}</span>
      <span class="swm-in-row"><input id="swm-y-${k}" inputmode="decimal" autocomplete="off" value="${escAttr(y[k])}" oninput="SwrMeter.type('${k}', this.value)"
        aria-describedby="swm-y-${k}-u"><span class="swm-unit" id="swm-y-${k}-u">${unit}</span></span>${hint ? `<span class="swm-hint">${hint}</span>` : ''}</label>`;
    return `
      ${radios('swm-src', 'What is on the line', [['scenario', 'A made-up station, with one fault'], ['yours', 'Your own readings']], S.source, 'SwrMeter.source')}
      <div class="swm-src-body" id="swm-src-body">
        ${S.source === 'scenario' ? `
          <label class="swm-in swm-in--wide"><span>The station</span>
            <select id="swm-scn" onchange="SwrMeter.scenario(this.value)">${scnOpts}</select></label>
          <p class="swm-story" id="swm-story">${esc((m.SCENARIOS[S.scenario] || {}).story || '')}</p>` : `
          <p class="swm-hint">Type what your meter shows: the forward power, and the reflected power or the SWR — any two make the third.</p>
          <div class="swm-in-grid">
            ${field('fwd', 'Forward', 'W', 'FW · FWD')}
            ${field('ref', 'Reflected', 'W', 'RW · REF · REV')}
            ${field('swr', 'SWR', ': 1', 'VSWR')}
            ${field('setW', 'The radio is set to', 'W', 'from its configuration')}
          </div>
          <div class="swm-in-grid swm-in-grid--2">
            <label class="swm-in"><span>The feeder</span><select id="swm-y-cable" onchange="SwrMeter.type('cable', this.value)">${cableOpts}</select></label>
            ${field('m', 'Its length', 'm', 'radio to antenna')}
          </div>`}
      </div>
      ${radios('swm-where', 'Where the meter is', [['radio', 'At the radio'], ['antenna', 'At the antenna end of the feeder']], S.where, 'SwrMeter.where')}
      ${radios('swm-tx', 'How the A2 is transmitting', [['off', 'Not transmitting'], ['test', 'Its TEST button — a short burst each press'], ['tones', 'Its tones setting — held on, if it will stay on']], S.tx, 'SwrMeter.tx')}
      <p class="swm-test-row"><button type="button" class="btn btn-primary" id="swm-test" onclick="SwrMeter.test()"${S.tx === 'test' ? '' : ' disabled'}>📡 Press TEST</button>
        <span class="swm-hint">One burst, as the button on the A2's front panel sends. Watch what each meter makes of it.</span></p>`;
  }

  // The meter's own controls, beside its drawing: every one the drawing
  // offers, as a real control.
  function devControlsHtml() {
    if (S.meter === 'swr400') {
      const mn = S.mn;
      return `
        ${radios('swm-mn-range', 'RANGE', [[200, '200 W'], [20, '20 W'], [5, '5 W']], mn.range, 'SwrMeter.dev.range')}
        ${radios('swm-mn-func', 'FUNCTION', [['power', 'POWER'], ['cal', 'CAL'], ['swr', 'SWR']], mn.func, 'SwrMeter.dev.func')}
        ${radios('swm-mn-dir', 'POWER (direction)', [['ref', 'REF'], ['fwd', 'FWD'], ['off', 'OFF']], mn.dir, 'SwrMeter.dev.dir')}
        ${radios('swm-mn-pep', 'AVG / PEP MONI', [['avg', 'AVG'], ['pep', 'PEP MONI']], mn.pep ? 'pep' : 'avg', 'SwrMeter.dev.pep')}
        <div class="swm-fs swm-cal"><label for="swm-mn-cal">CAL knob</label>
          <div class="swm-cal-row"><button type="button" class="btn swm-sm" onclick="SwrMeter.dev.calStep(-1)" aria-label="Turn CAL down">−</button>
            <input type="range" id="swm-mn-cal" min="0" max="100" step="1" value="${Math.round(mn.cal * 100)}" oninput="SwrMeter.dev.cal(this.value)"
              aria-valuetext="${Math.round(mn.cal * 100)}% of the way from MIN to MAX">
            <button type="button" class="btn swm-sm" onclick="SwrMeter.dev.calStep(1)" aria-label="Turn CAL up">+</button></div>
        </div>
        <p class="swm-dev-status" id="swm-mn-status">${mnStatus()}</p>`;
    }
    if (S.meter === 'cc3030') {
      const c = S.cc;
      const box = (k, t) => `<label class="swm-check"><input type="checkbox" id="swm-cc-${k}-in"${c[k] ? ' checked' : ''} onchange="SwrMeter.dev.cc('${k}', this.checked)"> ${t}</label>`;
      return `<fieldset class="swm-fs"><legend>The 3030's settings</legend>
          ${box('peak', 'PEAK — catch the top of each burst')}${box('hold', 'HOLD — keep it on the screen afterwards')}${box('rl', 'Show return loss in place of SWR')}
        </fieldset>
        <p class="swm-dev-status">On the meter these are in its MENU, chosen with ▽ △ and ENTER.</p>`;
    }
    const sw = S.sw;
    return `<fieldset class="swm-fs"><legend>The ${esc(M().METERS[S.meter].short)}'s buttons</legend>
        <div class="button-group">
          <button type="button" class="btn" id="swm-sw-pow" aria-pressed="${sw.on}" onclick="SwrMeter.dev.swPower()">🔴 POWER — ${sw.on ? 'on' : 'off'}</button>
          <button type="button" class="btn" id="swm-sw-menu-btn" aria-pressed="${sw.menu}" onclick="SwrMeter.dev.swMenu()"${sw.on ? '' : ' disabled'}>🔵 MENU</button>
        </div>
        ${S.meter === 'sw102' ? `<label class="swm-in"><span>Menu item 4 — VHF power offset</span>
          <span class="swm-in-row"><input type="number" id="swm-sw-off" min="-99" max="99" step="1" value="${sw.offset}" oninput="SwrMeter.dev.swOffset(this.value)"
            aria-describedby="swm-sw-off-u"><span class="swm-unit" id="swm-sw-off-u">%</span></span>
          <span class="swm-hint">Should be 0. Every reading is scaled by it.</span></label>` : ''}
      </fieldset>`;
  }

  function benchHtml() {
    const playing = S.playing;
    return sec('swm-bench', `
      ${head('swm-bench', 1, '📟', 'The meter in the line', 'Pick your meter, then a station — or type your own readings — and watch the power go up the line and come back.')}
      ${pickerHtml()}
      <div class="swm-bench-grid">
        <div class="swm-stage" id="swm-stage">
          <figure class="swm-fig swm-fig--line">
            <div class="swm-line-wrap" id="swm-line-wrap"></div>
            <figcaption class="swm-cap">The line: <span class="swm-key swm-key--f">●</span> power going out, <span class="swm-key swm-key--r">●</span> power coming back, fainter where it is weaker.</figcaption>
          </figure>
          <figure class="swm-fig swm-fig--meter">
            <div class="swm-meter-wrap" id="swm-meter-wrap"></div>
            <figcaption class="swm-cap" id="swm-meter-cap"></figcaption>
          </figure>
        </div>
        <div class="swm-controls">
          ${sourceHtml()}
          <div id="swm-dev">${devControlsHtml()}</div>
          <p><button type="button" class="btn" id="swm-play" aria-pressed="${playing}" onclick="SwrMeter.play()">${playing ? '⏸ Pause' : '▶ Animate'}</button></p>
        </div>
      </div>
      <div class="swm-verdict" id="swm-verdict" aria-live="polite"></div>`);
  }

  // ── The verdict ────────────────────────────────────────────────────────────

  function verdictHtml() {
    const m = M();
    const inp = verdictInput();
    const r = m.interpret(inp);
    const meter = m.METERS[S.meter];
    const back = S.from === 'inspections'
      ? `<p><button type="button" class="btn" onclick="SwrMeter.tab('inspections')">← Back to the inspection</button></p>` : '';
    if (S.tx === 'off' && S.source === 'scenario') {
      return `<h4>What it means</h4><p class="swm-muted">The radio is not transmitting, so there is nothing to read. Press TEST on the A2, or hold it on with its tones setting.</p>${back}`;
    }
    if (!r.ok) {
      return `<h4>What it means</h4><p class="swm-muted">${esc(r.error || 'Type the forward power, and the reflected power or the SWR.')}</p>${back}`;
    }
    const row = (k, v, note) => `<tr><th scope="row">${k}</th><td>${v}</td><td class="swm-muted">${note || ''}</td></tr>`;
    const rows = [];
    if (r.fwd != null) rows.push(row('Forward', W(r.fwd), r.dbm != null ? `${num(r.dbm, 1)} dBm` : ''));
    if (r.ref != null) rows.push(row('Reflected', W(r.ref), ''));
    rows.push(row('SWR', `${sTxt(r.swr)} : 1`, r.band ? `<span class="swm-badge swm-badge--${r.band.cls}">${r.band.label}</span>` : ''));
    rows.push(row('Coming back', pct(r.reflPct, r.reflPct < 1 ? 2 : 1), `|Γ| = ${num(r.gamma, 3)}`));
    rows.push(row('Return loss', Number.isFinite(r.rlDb) ? `${num(r.rlDb, 1)} dB` : '∞', 'bigger is better'));
    rows.push(row('Mismatch loss', Number.isFinite(r.mmDb) ? `${num(r.mmDb, 2)} dB` : '∞', 'what the reflection costs'));
    if (r.where === 'radio' && r.vsSetDb != null) rows.push(row('Against the setting', dB(r.vsSetDb, 2), `${pct(100 * r.fwd / r.setW)} of ${W(r.setW)}`));
    if (r.where === 'antenna' && r.expectAtAnt != null) rows.push(row('Expected here', W(r.expectAtAnt), `${W(r.setW)} less the feeder's ${num(r.feedDb, 1)} dB`));
    if (r.atAnt != null) rows.push(row('Reaching the antenna', W(r.atAnt), `after the feeder's ${num(r.feedDb, 1)} dB`));
    if (r.antSwr != null && r.where === 'radio' && r.feedDb > 0) rows.push(row('The antenna\'s own SWR', `about ${sTxt(r.antSwr)} : 1`, 'the reflection, before the feeder weakened it'));
    let behind = '';
    if (S.source === 'scenario') {
      const t = truth();
      const sc = t.sc;
      const bits = [`the radio puts out ${W(t.radioW)} (set to ${W(t.setW)})`];
      if (t.upDb >= 0.3) bits.push(`the jumper and adaptor before the meter lose ${num(t.upDb, 1)} dB`);
      if (t.feedDb > 0) bits.push(`${sc.m} m of ${m.CABLES[sc.cable].short}${sc.extraDb ? `, wet,` : ''} loses ${num(t.feedDb, 1)} dB`);
      bits.push(`the antenna's SWR is ${sTxt(t.antSwr)}`, `${W(t.radiated)} leaves the antenna`);
      behind = `<p class="swm-behind"><strong>Behind the scenes:</strong> ${esc(bits.join('; '))}.${sc.flicker ? ' The joint is loose, so the reflection keeps changing.' : ''}${S.meter === 'sw102' && S.sw.offset ? ` The meter's menu offset of ${S.sw.offset > 0 ? '+' : ''}${S.sw.offset}% is scaling its readings.` : ''}</p>`;
    }
    const cards = r.findings.map(f => `
      <li class="swm-find swm-find--${f.cls}">
        <h5>${f.cls === 'bad' ? '⛔' : f.cls === 'warn' ? '⚠️' : f.cls === 'ok' ? '✅' : 'ℹ️'} ${esc(f.title)}</h5>
        <p>${esc(f.text)}</p>
        ${f.do.length ? `<p class="swm-do-h">What to do</p><ol class="swm-do">${f.do.map(x => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}
      </li>`).join('');
    const bursts = S.tx !== 'test' ? '' : burstNote(meter);
    return `<h4>What it means</h4>
      ${behind}${bursts}
      <div class="swm-verdict-grid">
        <div class="table-wrap"><table class="swm-table"><caption>What the readings work out to${S.source === 'scenario' ? `, as the ${esc(meter.short)} would book them` : ''}</caption>
          <tbody>${rows.join('')}</tbody></table></div>
        <ul class="swm-finds">${cards}</ul>
      </div>
      <p class="button-group"><button type="button" class="btn" onclick="SwrMeter.exportTxt()">⤓ Save this check — text</button></p>
      ${back}`;
  }

  // What a TEST burst does to a reading on the meter picked.
  function burstNote(meter) {
    if (S.meter === 'cc3030') {
      return S.cc.peak
        ? `<p class="swm-note swm-note--ok">✅ Read on a TEST burst with PEAK${S.cc.hold ? ' and HOLD' : ''}: the 3030 catches the top of the burst${S.cc.hold ? ' and keeps it on the screen' : ''}. Of the three meters, this is the one built for the A2's TEST button.</p>`
        : `<p class="swm-note">⚠️ Read on a TEST burst without PEAK: the 3030 may catch the burst partway. Turn PEAK${S.cc.hold ? '' : ' and HOLD'} on. The numbers here are what the whole burst would show.</p>`;
    }
    if (S.meter === 'swr400') {
      return `<p class="swm-note">⚠️ Read on a TEST burst: a needle cannot swing all the way in a burst that short, so it reads low${S.mn.pep ? ' — PEP MONI holds the top of it, which helps' : '; PEP MONI holds the top of it better'}. And CAL needs a signal held on while you turn the knob, so an SWR reading needs the tones setting — or the SW-102 or the 3030, which read SWR without calibrating. The numbers here are what a held signal would show.</p>`;
    }
    return `<p class="swm-note">⚠️ Read on a TEST burst: the ${esc(meter.short)} is not built for bursts (its manual: "not for DMR"), so each one can read low, and differently each press. Press TEST several times and go by the highest reading that repeats; one low reading means check again, not a fault. The numbers here are what the whole burst would show.</p>`;
  }

  // ── The line ───────────────────────────────────────────────────────────────
  // Two layouts — across, and up a mast for a narrow screen — from one list
  // of points. Each segment knows what it is, so a particle knows how much
  // power it carries wherever it is.

  function layout() {
    const wrap = $('swm-line-wrap');
    const w = wrap ? wrap.clientWidth : 800;
    return w < 560 ? 'tall' : 'wide';
  }

  function geometry(kind) {
    const atRadio = S.where !== 'antenna';
    if (kind === 'tall') {
      const x = 160;
      const radio = { x: 12, y: 506, w: 124, h: 82 };
      const start = [radio.x + radio.w, 550];
      const feedTop = 112;
      const meter = atRadio ? { cx: x, y0: 476, y1: 410 } : { cx: x, y0: 212, y1: 146 };
      const pts = atRadio
        ? [[...start, 'up'], [x, 550, 'up'], [x, meter.y0, 'meter'], [x, meter.y1, 'feed'], [x, feedTop, 'end']]
        : [[...start, 'up'], [x, 550, 'feed'], [x, meter.y0, 'meter'], [x, meter.y1, 'lead'], [x, feedTop, 'end']];
      return { kind, vb: [0, 0, 380, 600], radio, pts, meter, ant: { x, top: 30, feed: feedTop }, mast: [x + 16, 600] };
    }
    const y = 214;
    const radio = { x: 12, y: 172, w: 132, h: 84 };
    const ax = 744;
    const meter = atRadio ? { x0: 176, x1: 290, y } : { x0: 586, x1: 700, y };
    const pts = atRadio
      ? [[radio.x + radio.w, y, 'up'], [meter.x0, y, 'meter'], [meter.x1, y, 'feed'], [ax, y, 'feed'], [ax, 112, 'end']]
      : [[radio.x + radio.w, y, 'up'], [166, y, 'feed'], [meter.x0, y, 'meter'], [meter.x1, y, 'lead'], [ax, y, 'lead'], [ax, 112, 'end']];
    return { kind, vb: [0, 0, 820, 300], radio, pts, meter, ant: { x: ax, top: 30, feed: 112 }, mast: [ax + 16, 300] };
  }

  // Lengths along the path, and where the feeder starts and stops.
  function measure(g) {
    const segs = [];
    let total = 0;
    for (let i = 0; i < g.pts.length - 1; i++) {
      const [x0, y0, kind] = g.pts[i], [x1, y1] = g.pts[i + 1];
      const len = Math.hypot(x1 - x0, y1 - y0);
      segs.push({ x0, y0, x1, y1, kind, len, at: total });
      total += len;
    }
    return { segs, total };
  }
  function pointAt(P, s) {
    let d = s * P.total;
    for (const sg of P.segs) {
      if (d <= sg.len || sg === P.segs[P.segs.length - 1]) {
        const f = sg.len ? Math.min(1, d / sg.len) : 0;
        return { x: sg.x0 + (sg.x1 - sg.x0) * f, y: sg.y0 + (sg.y1 - sg.y0) * f, sg, f };
      }
      d -= sg.len;
    }
    return { x: 0, y: 0, sg: P.segs[0], f: 0 };
  }
  // The forward power at a point, as a share of what the radio puts out.
  function fwdShare(t, at) {
    const up = Math.pow(10, -(t.upDb || 0) / 10), feed = Math.pow(10, -(t.feedDb || 0) / 10);
    let share = 1;
    for (const sg of live.P.segs) {
      if (sg === at.sg) {
        if (sg.kind === 'up') return share * Math.pow(up, at.f);
        if (sg.kind === 'feed') return share * Math.pow(feed, feedFrac(sg, at.f));
        return share;
      }
      if (sg.kind === 'up') share *= up;
      if (sg.kind === 'feed') share *= Math.pow(feed, feedFrac(sg, 1));
    }
    return share;
  }
  // A feeder drawn as more than one segment shares its loss by length.
  function feedFrac(sg, f) {
    const feeds = live.P.segs.filter(s => s.kind === 'feed');
    const all = feeds.reduce((a, s) => a + s.len, 0) || 1;
    return (sg.len * f) / all;
  }
  // Out on one side of the cable, back on the other, so the two streams are
  // told apart where they share a cable.
  function side(sg, dir) {
    const len = sg.len || 1, d = 4.5 * dir;
    return [-(sg.y1 - sg.y0) / len * d, (sg.x1 - sg.x0) / len * d];
  }
  // How strong a dot is drawn for a share of the radio's power: visible
  // down to a hundredth of a percent, and never a guess at nothing.
  const vis = r => (r <= 1e-5 ? 0 : Math.min(1, 0.18 + 0.82 * Math.pow(r, 0.35)));

  const NF = 22;
  function lineSvg() {
    const g = geometry(layout());
    const P = measure(g);
    live.g = g; live.P = P;
    const m = M();
    const meter = m.METERS[S.meter];
    const t = truth();
    const [, , vw, vh] = g.vb;
    const coax = P.segs.map(sg => `<line class="swm-coax${sg.kind === 'feed' ? ' swm-coax--feed' : ''}" x1="${sg.x0}" y1="${sg.y0}" x2="${sg.x1}" y2="${sg.y1}"/>`).join('');
    const core = P.segs.filter(sg => sg.kind !== 'meter').map(sg => `<line class="swm-core${sg.kind === 'feed' && t.extraDb ? ' swm-core--wet' : ''}" x1="${sg.x0}" y1="${sg.y0}" x2="${sg.x1}" y2="${sg.y1}"/>`).join('');
    const r = g.radio;
    const radio = `<g class="swm-radio">
        <rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="8" class="swm-radio-box"/>
        <text x="${r.x + 12}" y="${r.y + 24}" class="swm-t swm-t--b">ALERT2 radio</text>
        <text x="${r.x + 12}" y="${r.y + 44}" class="swm-t swm-t--s" id="swm-ln-set">${t.setW ? `set to ${W(t.setW)}` : 'setting not typed'}</text>
        <circle cx="${r.x + r.w - 14}" cy="${r.y + r.h - 14}" r="5" class="swm-led" id="swm-ln-led"/>
        <g data-act="test" class="swm-hot"><rect x="${r.x + 10}" y="${r.y + r.h - 26}" width="48" height="18" rx="4" class="swm-testbtn"/>
          <text x="${r.x + 34}" y="${r.y + r.h - 13}" class="swm-testbtn-t" text-anchor="middle">TEST</text></g>
      </g>`;
    // The meter, as a box with its two sockets named.
    let mtr;
    const [pIn, pOut] = meter.ports;
    if (g.kind === 'tall') {
      const mm = g.meter;
      mtr = `<g class="swm-ln-meter"><rect x="${mm.cx - 48}" y="${mm.y1}" width="96" height="${mm.y0 - mm.y1}" rx="7" class="swm-ln-mbox"/>
        <rect x="${mm.cx - 40}" y="${mm.y1 + 8}" width="80" height="44" rx="3" class="swm-ln-lcd"/>
        <text x="${mm.cx}" y="${mm.y1 + 27}" class="swm-ln-lcdt" text-anchor="middle" id="swm-ln-m1">—</text>
        <text x="${mm.cx}" y="${mm.y1 + 45}" class="swm-ln-lcdt" text-anchor="middle" id="swm-ln-m2">—</text>
        <text x="${mm.cx - 56}" y="${mm.y0 - 2}" class="swm-t swm-t--s" text-anchor="end">${pIn}</text>
        <text x="${mm.cx - 56}" y="${mm.y1 + 12}" class="swm-t swm-t--s" text-anchor="end">${pOut}</text></g>`;
    } else {
      const mm = g.meter, mx = (mm.x0 + mm.x1) / 2;
      mtr = `<g class="swm-ln-meter"><rect x="${mm.x0}" y="${mm.y - 40}" width="${mm.x1 - mm.x0}" height="76" rx="8" class="swm-ln-mbox"/>
        <rect x="${mm.x0 + 8}" y="${mm.y - 32}" width="${mm.x1 - mm.x0 - 16}" height="48" rx="3" class="swm-ln-lcd"/>
        <text x="${mx}" y="${mm.y - 12}" class="swm-ln-lcdt" text-anchor="middle" id="swm-ln-m1">—</text>
        <text x="${mx}" y="${mm.y + 9}" class="swm-ln-lcdt" text-anchor="middle" id="swm-ln-m2">—</text>
        <text x="${mm.x0 + 2}" y="${mm.y + 54}" class="swm-t swm-t--s">${pIn}</text>
        <text x="${mm.x1 - 2}" y="${mm.y + 54}" class="swm-t swm-t--s" text-anchor="end">${pOut}</text>
        <text x="${mx}" y="${mm.y - 50}" class="swm-t swm-t--s" text-anchor="middle">${esc(meter.short)}</text></g>`;
    }
    const a = g.ant;
    // A dummy load in place of the antenna: a finned resistor that turns the
    // power into heat, and sends nothing into the air.
    const dummy = S.source === 'scenario' && S.scenario === 'dummy';
    const ant = dummy ? `<g class="swm-ant">
        <rect x="${a.x - 16}" y="${a.feed - 64}" width="32" height="64" rx="4" class="swm-dummy"/>
        ${[0, 1, 2, 3, 4].map(i => `<line x1="${a.x - 24}" y1="${a.feed - 56 + i * 12}" x2="${a.x + 24}" y2="${a.feed - 56 + i * 12}" class="swm-dummy-fin"/>`).join('')}
        <circle cx="${a.x}" cy="${a.feed}" r="4" class="swm-feedpt"/>
      </g>` : `<g class="swm-ant">
        <line x1="${g.mast[0]}" y1="${a.feed - 6}" x2="${g.mast[0]}" y2="${g.mast[1]}" class="swm-mast"/>
        <line x1="${g.mast[0] - 10}" y1="${a.feed + 10}" x2="${g.mast[0]}" y2="${a.feed + 10}" class="swm-mast swm-mast--thin"/>
        <rect x="${a.x - 6}" y="${a.top}" width="12" height="${a.feed - a.top}" rx="6" class="swm-radome"/>
        <circle cx="${a.x}" cy="${a.feed}" r="4" class="swm-feedpt"/>
        ${[0, 1, 2].map(i => `<path id="swm-ln-arc${i}" class="swm-arc" d="M ${a.x - 18} ${a.top + 10} A 26 34 0 0 0 ${a.x - 18} ${a.feed - 10} M ${a.x + 18} ${a.top + 10} A 26 34 0 0 1 ${a.x + 18} ${a.feed - 10}" opacity="0"/>`).join('')}
      </g>`;
    // Words: the feeder, the antenna, and the watts at the meter and the top.
    const cableTxt = t.cable && m.CABLES[t.cable] && t.mLen > 0
      ? `${t.mLen} m of ${m.CABLES[t.cable].short}${t.extraDb ? ', wet' : ''}`
      : dummy ? 'no feeder:' : 'the feeder';
    const lossTxt = dummy ? 'a short jumper' : t.feedDb > 0 ? `loses ${num(t.feedDb, 1)} dB` : (t.cable ? '' : 'type and length not given');
    const antTxt = dummy ? `50 Ω dummy load · SWR ${sTxt(t.antSwr)}` : t.antSwr != null ? `antenna · SWR ${sTxt(t.antSwr)}` : 'antenna';
    let words;
    if (g.kind === 'tall') {
      const tx = g.meter.cx + 58;
      const fy = S.where === 'radio' ? 260 : 360;
      words = `<text x="${tx}" y="${fy}" class="swm-t swm-t--s">${esc(cableTxt)}</text>
        <text x="${tx}" y="${fy + 18}" class="swm-t swm-t--s">${esc(lossTxt)}</text>
        <text x="${a.x + 34}" y="${a.top + 14}" class="swm-t swm-t--s">${esc(antTxt)}</text>
        <text x="${a.x + 34}" y="${a.top + 34}" class="swm-t swm-t--f" id="swm-ln-wa">—</text>
        <text x="${a.x + 34}" y="${a.top + 54}" class="swm-t swm-t--r" id="swm-ln-wr">—</text>
        <text x="${tx}" y="${g.meter.y1 + 26}" class="swm-t swm-t--f" id="swm-ln-wf">—</text>
        <text x="${tx}" y="${g.meter.y1 + 46}" class="swm-t swm-t--r" id="swm-ln-wb">—</text>`;
    } else {
      const fx = S.where === 'radio' ? (g.meter.x1 + a.x) / 2 : (166 + g.meter.x0) / 2;
      const mx = (g.meter.x0 + g.meter.x1) / 2;
      words = `<text x="${fx}" y="${g.pts[0][1] + 36}" class="swm-t swm-t--s" text-anchor="middle">${esc(cableTxt)}</text>
        <text x="${fx}" y="${g.pts[0][1] + 56}" class="swm-t swm-t--s" text-anchor="middle">${esc(lossTxt)}</text>
        <text x="${a.x - 110}" y="${a.top + 8}" class="swm-t swm-t--s" text-anchor="end">${esc(antTxt)}</text>
        <text x="${a.x - 110}" y="${a.top + 30}" class="swm-t swm-t--f" text-anchor="end" id="swm-ln-wa">—</text>
        <text x="${a.x - 110}" y="${a.top + 52}" class="swm-t swm-t--r" text-anchor="end" id="swm-ln-wr">—</text>
        <text x="${mx}" y="${g.meter.y + 78}" class="swm-t swm-t--f" text-anchor="end" id="swm-ln-wf">—</text>
        <text x="${mx + 10}" y="${g.meter.y + 78}" class="swm-t swm-t--r" id="swm-ln-wb">—</text>`;
    }
    const dots = Array.from({ length: NF }, (_, i) => `<circle id="swm-pf${i}" class="swm-pf" r="${g.kind === 'tall' ? 5 : 4.5}" cx="-20" cy="-20"/><circle id="swm-pr${i}" class="swm-pr" r="${g.kind === 'tall' ? 4.5 : 4}" cx="-20" cy="-20"/>`).join('');
    return `<svg class="swm-line swm-line--${g.kind}" viewBox="0 0 ${vw} ${vh}" role="img" aria-labelledby="swm-line-name" id="swm-line">
        <title id="swm-line-name">${esc(lineName(t))}</title>
        ${coax}${core}${ant}${radio}${mtr}${words}<g class="swm-dots">${dots}</g>
      </svg>`;
  }

  function lineName(t) {
    const m = M();
    const meter = m.METERS[S.meter];
    if (!t.ok) return `The antenna line with the ${meter.short} ${S.where === 'radio' ? 'at the radio' : 'at the antenna end of the feeder'}. No readings yet.`;
    return `The antenna line: the radio, the ${meter.short} ${S.where === 'radio' ? 'at the radio' : 'at the antenna end of the feeder'}, the feeder and the antenna. `
      + `The meter sees ${W(t.fwd)} going out and ${W(t.ref)} coming back; ${W(t.atAnt)} reaches the antenna.`;
  }

  // ── The meters, drawn ──────────────────────────────────────────────────────

  // An N socket, sideways: a flange, a threaded barrel and its hex.
  function nSocket(x, y, dir) {
    const s = dir < 0 ? -1 : 1;
    const bx = s > 0 ? x : x - 56;
    const threads = Array.from({ length: 9 }, (_, i) => `<line x1="${bx + 6 + i * 5}" y1="${y - 24}" x2="${bx + 6 + i * 5}" y2="${y + 24}" stroke="#8d939a" stroke-width="1.4"/>`).join('');
    return `<g class="swm-nsock">
      <rect x="${bx}" y="${y - 26}" width="56" height="52" rx="6" fill="#cfd3d8" stroke="#7d838a"/>${threads}
      <rect x="${s > 0 ? x + 50 : x - 76}" y="${y - 34}" width="26" height="68" rx="4" fill="#b9bec4" stroke="#7d838a"/>
      <circle cx="${s > 0 ? x + 10 : x - 10}" cy="${y}" r="5" fill="#d9b44a"/>
    </g>`;
  }
  const cable = (x0, x1, y) => `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" class="swm-mcoax"/><line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" class="swm-mcore"/>`;
  // The arrows along a meter's own cables: out on the left, back on the right.
  function flowMarks(x0, x1, y, id) {
    return `<g id="${id}" class="swm-flow"><text x="${x0}" y="${y - 16}" class="swm-t swm-t--f" id="${id}-f">→</text><text x="${x1}" y="${y + 30}" class="swm-t swm-t--r" text-anchor="end" id="${id}-r">←</text></g>`;
  }

  function sw102Svg(hf) {
    const ribs = side => Array.from({ length: 50 }, (_, i) => `<line x1="${side}" y1="${120 + i * 6.4}" x2="${side + 22}" y2="${120 + i * 6.4}" stroke="#3b3e43" stroke-width="2"/>`).join('');
    return `<svg class="swm-dev" viewBox="0 0 600 500" role="img" aria-labelledby="swm-dev-name" id="swm-dev-svg">
      <title id="swm-dev-name">The ${hf ? 'Surecom SW-102HF' : 'Surecom SW-102'}</title>
      ${cable(0, 80, 175)}${cable(520, 600, 175)}
      ${nSocket(80, 175, 1)}${nSocket(520, 175, -1)}
      <text x="96" y="118" class="swm-t swm-t--b" text-anchor="middle">TX</text>
      <text x="504" y="118" class="swm-t swm-t--b" text-anchor="middle">ANT</text>
      <text x="6" y="222" class="swm-t swm-t--s">from the radio</text>
      <text x="594" y="222" class="swm-t swm-t--s" text-anchor="end">to the antenna</text>
      ${flowMarks(14, 586, 175, 'swm-dev-flow')}
      <rect x="144" y="44" width="312" height="440" rx="16" fill="#26282c" stroke="#0e0f11" stroke-width="2"/>
      ${ribs(150)}${ribs(428)}
      <rect x="176" y="66" width="248" height="404" rx="14" fill="#15171a" stroke="#2c2f33"/>
      <text x="190" y="108" fill="#8e959d" font-size="25" font-style="italic" font-weight="800" letter-spacing="1">SURECOM</text>
      <text x="412" y="132" fill="#e6e8ea" font-size="13" font-weight="700" text-anchor="end">${hf ? 'SW-102HF' : 'SW-102'}</text>
      <rect x="192" y="140" width="216" height="168" rx="8" fill="none" stroke="#d9772b" stroke-width="3"/>
      <rect x="198" y="146" width="204" height="156" rx="4" class="swm-lcd${hf ? ' swm-lcd--hf' : ''}" id="swm-sw-lcd" data-act="sw-screen"/>
      <g id="swm-sw-main" class="swm-lcd-ink" font-family="ui-monospace, Menlo, Consolas, monospace">
        <rect x="206" y="153" width="20" height="11" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="226" y="156" width="3" height="5" fill="currentColor"/>
        <rect x="208" y="155" width="11" height="7" fill="currentColor"/>
        <text x="236" y="163" font-size="12">B:</text>
        <text x="396" y="177" font-size="22" text-anchor="end" id="swm-sw-pwr">0.00W</text>
        <text x="206" y="182" font-size="12">${hf ? 'SW102HF' : 'SW102'} v2.5</text>
        <text x="206" y="199" font-size="12" id="swm-sw-band">${hf ? '1.5-70' : '125-525'}</text>
        <text x="396" y="199" font-size="12" text-anchor="end" id="swm-sw-trans">Trans% --.--%</text>
        <text x="206" y="215" font-size="12" id="swm-sw-freq">${hf ? '  MHz' : '---.---MHz'}</text>
        <text x="206" y="240" font-size="13">VSWR:</text>
        <text x="330" y="276" font-size="50" text-anchor="middle" id="swm-sw-vswr">-.--</text>
        <text x="206" y="296" font-size="12" id="swm-sw-fw">FW:0.00W</text>
        <text x="396" y="296" font-size="12" text-anchor="end" id="swm-sw-rw">RW:0.000W</text>
      </g>
      <g id="swm-sw-menu" class="swm-lcd-ink" font-family="ui-monospace, Menlo, Consolas, monospace" display="none">
        <text x="206" y="166" font-size="13" font-weight="700">MENU</text>
        ${['1 LCD DIM', '2 POWER OFF', '3 FREQ ADJ', '4 VHF PWR', '5 UHF PWR', '6 VHF LOW', '7 UHF LOW'].map((l, i) => `
          <text x="206" y="${186 + i * 16}" font-size="12">${l}</text><text x="396" y="${186 + i * 16}" font-size="12" text-anchor="end" id="swm-sw-mv${i + 1}">${[1, 3, 0, 0, 0, 0, 0][i]}</text>`).join('')}
      </g>
      <circle cx="206" cy="330" r="6" fill="#55595e" id="swm-sw-led"/>
      <text x="408" y="336" fill="#b9bec4" font-size="13" font-weight="700" text-anchor="end">SWR METER</text>
      <text x="224" y="368" fill="#e0533a" font-size="15" font-weight="700" text-anchor="middle">POWER</text>
      <text x="300" y="368" fill="#e0533a" font-size="16" text-anchor="middle">◀</text>
      <text x="376" y="368" fill="#e0533a" font-size="16" text-anchor="middle">▶</text>
      <g data-act="sw-power" class="swm-hot"><circle cx="224" cy="406" r="27" fill="#e8452c" stroke="#9c2a16" stroke-width="2"/><ellipse cx="216" cy="396" rx="9" ry="5" fill="#fff" opacity=".25"/></g>
      <g data-act="sw-menu" class="swm-hot"><circle cx="300" cy="406" r="27" fill="#2f7fd8" stroke="#1b4f8a" stroke-width="2"/><ellipse cx="292" cy="396" rx="9" ry="5" fill="#fff" opacity=".25"/></g>
      <g data-act="sw-plus" class="swm-hot"><circle cx="376" cy="406" r="27" fill="#f2d21b" stroke="#a88f09" stroke-width="2"/><ellipse cx="368" cy="396" rx="9" ry="5" fill="#fff" opacity=".35"/></g>
      <text x="224" y="458" fill="#b9bec4" font-size="13" text-anchor="middle">ENTER</text>
      <text x="300" y="458" fill="#b9bec4" font-size="18" text-anchor="middle">−</text>
      <text x="376" y="458" fill="#b9bec4" font-size="18" text-anchor="middle">+</text>
      ${hf ? `<g class="swm-warnflag"><rect x="150" y="10" width="300" height="26" rx="6"/><text x="300" y="28" text-anchor="middle">1.5–70 MHz: it cannot read 151.5 MHz</text></g>` : ''}
    </svg>`;
  }

  // The SWR-400's scales: arcs about a pivot below the window, the SWR scale
  // at |Γ| (so ∞ meets CAL), the power scales square-law, as the meter's are.
  const MN = { px: 181, py: 300, span: 37 };
  const mnAng = f => -MN.span + 2 * MN.span * f;
  function mnPt(r, f) {
    const a = mnAng(f) * Math.PI / 180;
    return [MN.px + r * Math.sin(a), MN.py - r * Math.cos(a)];
  }
  function mnArc(r, f0, f1, cls) {
    const [x0, y0] = mnPt(r, f0), [x1, y1] = mnPt(r, f1);
    return `<path d="M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}" class="${cls}"/>`;
  }
  function mnScale(r, marks, lab, out) {
    const ticks = marks.map(([f, t]) => {
      const [a, b] = mnPt(r, f), [c, d] = mnPt(r + (out ? 7 : -7), f), [lx, ly] = mnPt(r + (out ? 15 : -15), f);
      return `<line x1="${a.toFixed(1)}" y1="${b.toFixed(1)}" x2="${c.toFixed(1)}" y2="${d.toFixed(1)}" class="swm-mn-tick"/>
        <text x="${lx.toFixed(1)}" y="${(ly + 3).toFixed(1)}" class="swm-mn-lab" text-anchor="middle">${t}</text>`;
    }).join('');
    return mnArc(r, 0, 1, 'swm-mn-arc') + ticks + (lab || '');
  }
  function sw400Svg() {
    const m = M();
    const swrMarks = [1, 1.5, 2, 3, 4, 5, 10].map(s => [m.gammaFromSwr(s), String(s)]).concat([[1, '∞']]);
    const sq = (fs, list) => list.map(p => [Math.sqrt(p / fs), String(p)]);
    const sw = (x, label, opts, act, cap) => {
      const ys = [282, 299, 316];
      return `<g data-act="${act}" class="swm-hot">
        <rect x="${x}" y="268" width="${label}" height="60" rx="3" fill="#17181a" stroke="#2f3134"/>
        <rect x="${x + 7}" y="274" width="16" height="50" rx="3" fill="#0b0b0c"/>
        <rect x="${x + 8}" y="275" width="14" height="14" rx="2" fill="#4a4d52" id="swm-mn-${act}-lever"/>
        ${opts.map((o, i) => `<text x="${x + 30}" y="${ys[i] + 4}" fill="#e6e6e6" font-size="11">${o}</text>`).join('')}
        <text x="${x + label / 2}" y="344" fill="#f0f0f0" font-size="12" font-weight="700" text-anchor="middle">${cap}</text>
      </g>`;
    };
    return `<svg class="swm-dev" viewBox="0 0 760 480" role="img" aria-labelledby="swm-dev-name" id="swm-dev-svg">
      <title id="swm-dev-name">The Moonraker SWR-400</title>
      <defs><clipPath id="swm-mn-clip"><rect x="62" y="88" width="238" height="164"/></clipPath></defs>
      <rect x="30" y="40" width="700" height="312" rx="12" fill="#1d1e21" stroke="#0b0b0c" stroke-width="2"/>
      <rect x="30" y="40" width="700" height="14" rx="7" fill="#2a2c30"/>
      <rect x="90" y="352" width="60" height="10" rx="2" fill="#111"/><rect x="610" y="352" width="60" height="10" rx="2" fill="#111"/>
      <rect x="50" y="62" width="372" height="198" rx="4" fill="#0e0f10"/>
      <text x="62" y="80" fill="#e9e9e9" font-size="10" font-weight="700">SWR &amp; POWER METER</text>
      <rect x="62" y="88" width="238" height="164" fill="#f4ead8" class="swm-mn-face"/>
      <g clip-path="url(#swm-mn-clip)">
        <text x="70" y="104" class="swm-mn-swr">S.W.R</text>
        ${mnArc(172, m.gammaFromSwr(3), 1, 'swm-mn-red')}
        ${mnScale(168, swrMarks, '', true)}
        ${mnScale(152, sq(200, [50, 100, 200]), '', false)}
        ${mnScale(126, sq(20, [5, 10, 15, 20]), '', false)}
        ${mnScale(100, sq(5, [0.5, 1, 2, 3, 4, 5]), '', false)}
        <text x="${(mnPt(176, 1)[0] - 6).toFixed(1)}" y="${(mnPt(176, 1)[1] + 13).toFixed(1)}" class="swm-mn-cal" text-anchor="end">CAL ▼</text>
        <text x="${MN.px}" y="246" class="swm-mn-lab swm-mn-lab--b" text-anchor="middle">POWER (W)</text>
        <line id="swm-mn-needle" x1="${MN.px}" y1="${MN.py}" x2="${MN.px}" y2="${MN.py - 192}" class="swm-mn-needle" transform="rotate(${-MN.span} ${MN.px} ${MN.py})"/>
      </g>
      <rect x="306" y="88" width="104" height="164" fill="#2b2e33"/>
      <rect x="316" y="132" width="84" height="76" rx="3" fill="#4b5058"/>
      <text x="358" y="160" fill="#eee" font-size="12" text-anchor="middle">140MHz</text>
      <text x="358" y="176" fill="#eee" font-size="12" text-anchor="middle">|</text>
      <text x="358" y="192" fill="#eee" font-size="12" text-anchor="middle">525MHz</text>
      <g data-act="mn-pep" class="swm-hot">
        <rect x="440" y="84" width="96" height="112" fill="transparent"/>
        <text x="476" y="98" fill="#e6e6e6" font-size="12">⎍ AVG</text>
        <rect x="448" y="104" width="18" height="78" rx="9" fill="#0b0b0c"/>
        <rect x="450" y="106" width="14" height="36" rx="7" fill="#3aa0e6" id="swm-mn-pep-lever"/>
        <text x="472" y="190" fill="#e6e6e6" font-size="11">⎽ PEP MONI</text>
      </g>
      <text x="620" y="84" fill="#f0f0f0" font-size="17" font-weight="700" text-anchor="middle">CAL</text>
      ${Array.from({ length: 11 }, (_, i) => { const a = (-135 + 27 * i) * Math.PI / 180; return `<line x1="${(620 + 50 * Math.sin(a)).toFixed(1)}" y1="${(150 - 50 * Math.cos(a)).toFixed(1)}" x2="${(620 + 57 * Math.sin(a)).toFixed(1)}" y2="${(150 - 57 * Math.cos(a)).toFixed(1)}" stroke="#ddd" stroke-width="1.6"/>`; }).join('')}
      <circle cx="620" cy="150" r="44" fill="#121314" stroke="#3a3c40" stroke-width="3" stroke-dasharray="3 2"/>
      <circle cx="620" cy="150" r="36" fill="#1b1c1e"/>
      <line id="swm-mn-knob" x1="620" y1="150" x2="620" y2="118" stroke="#e8e8e8" stroke-width="3" stroke-linecap="round" transform="rotate(-135 620 150)"/>
      <g data-act="mn-cal-down" class="swm-hot"><rect x="566" y="96" width="54" height="110" fill="transparent"/></g>
      <g data-act="mn-cal-up" class="swm-hot"><rect x="620" y="96" width="54" height="110" fill="transparent"/></g>
      <text x="572" y="222" fill="#e6e6e6" font-size="11" text-anchor="middle">MIN</text>
      <text x="668" y="222" fill="#e6e6e6" font-size="11" text-anchor="middle">MAX</text>
      <rect x="50" y="282" width="118" height="26" rx="3" fill="#222" stroke="#888"/>
      <text x="109" y="300" fill="#e6e6e6" font-size="11" font-weight="700" text-anchor="middle" letter-spacing="1">MOONRAKER</text>
      <text x="228" y="280" fill="#ccc" font-size="9" text-anchor="middle">METER ADJUST</text>
      <circle cx="228" cy="300" r="7" fill="#b8862f" stroke="#6d4f17"/><line x1="223" y1="300" x2="233" y2="300" stroke="#6d4f17" stroke-width="1.5"/>
      <text x="408" y="282" fill="#e6e6e6" font-size="11" text-anchor="end">400W</text>
      <text x="270" y="326" fill="#f2f2f2" font-size="34" font-weight="600">SWR 400</text>
      ${sw(432, 82, ['200W', '20W', '5W'], 'mn-range', 'RANGE')}
      ${sw(522, 92, ['POWER', 'CAL', 'SWR'], 'mn-func', 'FUNCTION')}
      ${sw(622, 92, ['REF', 'FWD', 'OFF'], 'mn-dir', 'POWER')}
      <rect x="200" y="380" width="360" height="62" rx="6" fill="#1d1e21" stroke="#0b0b0c"/>
      <text x="380" y="396" fill="#bbb" font-size="10" text-anchor="middle" letter-spacing="1">BACK PANEL</text>
      ${cable(0, 256, 418)}${cable(504, 760, 418)}
      <circle cx="270" cy="418" r="14" fill="#c9ccd1" stroke="#7d838a"/><circle cx="270" cy="418" r="5" fill="#d9b44a"/>
      <circle cx="490" cy="418" r="14" fill="#c9ccd1" stroke="#7d838a"/><circle cx="490" cy="418" r="5" fill="#d9b44a"/>
      <text x="294" y="423" fill="#f0f0f0" font-size="13" font-weight="700">TX</text>
      <text x="466" y="423" fill="#f0f0f0" font-size="13" font-weight="700" text-anchor="end">ANT</text>
      <text x="6" y="460" class="swm-t swm-t--s">from the radio</text>
      <text x="754" y="460" class="swm-t swm-t--s" text-anchor="end">to the antenna</text>
      ${flowMarks(14, 746, 418, 'swm-dev-flow')}
    </svg>`;
  }

  function cc3030Svg() {
    const letters = (word, x, y0) => word.split('').map((ch, i) => `<text x="${x}" y="${y0 + i * 17}" fill="#3a3a3a" font-size="13" text-anchor="middle">${ch}</text>`).join('');
    const key = (x, label, act, fs) => `<g data-act="${act}" class="swm-hot"><rect x="${x}" y="384" width="56" height="44" rx="9" fill="#f7f5ef" stroke="#6b6b6b" stroke-width="1.5"/>
      <text x="${x + 28}" y="${410 + (fs > 12 ? 2 : 0)}" fill="#2a2a2a" font-size="${fs}" text-anchor="middle">${label}</text></g>`;
    return `<svg class="swm-dev" viewBox="0 0 600 540" role="img" aria-labelledby="swm-dev-name" id="swm-dev-svg">
      <title id="swm-dev-name">The Comm-connect 3030</title>
      ${cable(0, 84, 270)}${cable(516, 600, 270)}
      ${nSocket(84, 270, 1)}${nSocket(516, 270, -1)}
      <text x="6" y="318" class="swm-t swm-t--s">from the radio</text>
      <text x="594" y="318" class="swm-t swm-t--s" text-anchor="end">to the antenna</text>
      ${flowMarks(14, 586, 270, 'swm-dev-flow')}
      <rect x="132" y="56" width="336" height="428" rx="22" fill="#c9ccd0" stroke="#8d939a"/>
      <rect x="116" y="34" width="368" height="88" rx="34" fill="#2c3a8c"/>
      <rect x="116" y="436" width="368" height="78" rx="34" fill="#2c3a8c"/>
      <rect x="150" y="62" width="300" height="416" rx="26" fill="#f1eee6" stroke="#c8c3b5"/>
      <rect x="170" y="86" width="18" height="22" fill="none" stroke="#666" stroke-width="1.5"/><text x="179" y="103" fill="#444" font-size="13" text-anchor="middle">I</text>
      <text x="226" y="106" fill="#2c3a8c" font-size="16" font-weight="800" font-style="italic" text-anchor="middle">COMM</text>
      <ellipse cx="312" cy="100" rx="58" ry="16" fill="#2c3a8c"/><text x="312" y="106" fill="#fff" font-size="15" font-style="italic" text-anchor="middle">connect</text>
      <rect x="408" y="86" width="14" height="14" rx="2" fill="#8a6b5a" id="swm-cc-led"/><text x="415" y="114" fill="#555" font-size="8" text-anchor="middle">Charge</text>
      ${letters('INPUT', 166, 210)}${letters('LOAD', 434, 220)}
      <rect x="186" y="132" width="228" height="196" rx="6" fill="#2e3135"/>
      <rect x="194" y="140" width="212" height="180" class="swm-lcd swm-lcd--cc" id="swm-cc-lcd"/>
      <g class="swm-cc-ink" font-family="ui-monospace, Menlo, Consolas, monospace" font-weight="700">
        <rect x="244" y="148" width="16" height="9" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="246" y="150" width="9" height="5" fill="currentColor"/>
        <path d="M382 157 l6 -10 l6 10 z" fill="none" stroke="currentColor" stroke-width="1.3"/>
        <text x="204" y="188" font-size="21">FWD</text><text x="358" y="188" font-size="21" text-anchor="end" id="swm-cc-fwd">0.00</text><text x="366" y="188" font-size="21" id="swm-cc-fu">W</text>
        <text x="204" y="218" font-size="21">REV</text><text x="358" y="218" font-size="21" text-anchor="end" id="swm-cc-rev">0.00</text><text x="366" y="218" font-size="21" id="swm-cc-ru">W</text>
        <text x="204" y="248" font-size="21" id="swm-cc-sl">SWR</text><text x="396" y="248" font-size="21" text-anchor="end" id="swm-cc-swr">-.--:1</text>
        <text x="204" y="276" font-size="13" font-weight="400" id="swm-cc-freq">Frequency ------ KHz</text>
        <text x="228" y="300" font-size="13" font-weight="400" id="swm-cc-hold">HOLD</text>
        <text x="282" y="300" font-size="13" font-weight="400" id="swm-cc-peak">PEAK</text>
      </g>
      <text x="300" y="362" fill="#2a2a2a" font-size="19" font-weight="700" text-anchor="middle" letter-spacing=".5">3030 POWER METER</text>
      ${key(164, 'MENU', 'cc-menu', 11)}${key(236, '▽', 'cc-down', 20)}${key(308, '△', 'cc-up', 20)}${key(380, 'ENTER', 'cc-enter', 10)}
    </svg>`;
  }

  function meterSvg() {
    if (S.meter === 'swr400') return sw400Svg();
    if (S.meter === 'cc3030') return cc3030Svg();
    return sw102Svg(S.meter === 'sw102hf');
  }

  // ── What each meter shows, moment to moment ───────────────────────────────

  function mnStatus() {
    const mn = S.mn;
    const t = truth();
    if (S.tx === 'off') return 'Nothing is transmitting: the needle rests on 0.';
    if (S.tx === 'test' && mn.func !== 'power') {
      return 'CAL and SWR need a signal held on while you turn the knob — the A2\'s tones setting. On TEST bursts the needle flicks up and falls back: read SWR on the SW-102 or the 3030 instead.';
    }
    if (mn.func === 'power') {
      if (mn.dir === 'off') return 'POWER is at OFF: the needle reads nothing. FWD for forward power, REF for reflected.';
      const p = mn.dir === 'fwd' ? t.fwd : t.ref;
      const over = p > mn.range * 1.02;
      return `${mn.dir === 'fwd' ? 'Forward' : 'Reflected'} power on the ${mn.range} W scale${over ? ' — off the end of it: pick a bigger RANGE' : p < mn.range / 16 && mn.range > 5 ? ' — barely moving it: a smaller RANGE reads it better' : ''}.`;
    }
    const k = mn.cal;
    const calMin = M().METERS.swr400.calMinW;
    const d = k * Math.sqrt(Math.max(0, t.fwd) / calMin);
    if (mn.func === 'cal') {
      if (d > 1.03) return `Past the CAL mark (${Math.round(d * 100)}%): turn CAL down until the needle sits on it.`;
      if (d < 0.97) return k >= 0.999 ? `CAL at MAX and the needle at ${Math.round(d * 100)}%: not enough power to calibrate this meter. Its SWR cannot be read.` : `Turn CAL up until the needle sits on the CAL mark — it is at ${Math.round(d * 100)}%.`;
      return 'On the CAL mark. Keep transmitting and switch FUNCTION to SWR.';
    }
    if (d < 0.97 || d > 1.03) return `Not calibrated (CAL would read ${Math.round(d * 100)}%): this SWR is not a reading. Calibrate on CAL first.`;
    const g = Math.min(1, k * Math.sqrt(Math.max(0, t.ref) / calMin));
    return `Calibrated: the needle reads SWR ${sTxt(M().swrFromGamma(g))} on the SWR scale.`;
  }

  // The needle's target, 0–1 of full scale (past 1 it is pinned).
  function mnTarget(fwd, ref) {
    const mn = S.mn;
    const calMin = M().METERS.swr400.calMinW;
    let d = 0;
    if (mn.func === 'power') d = mn.dir === 'off' ? 0 : Math.sqrt(Math.max(0, mn.dir === 'fwd' ? fwd : ref) / mn.range);
    else if (mn.func === 'cal') d = mn.cal * Math.sqrt(Math.max(0, fwd) / calMin);
    else d = mn.cal * Math.sqrt(Math.max(0, ref) / calMin);
    return Math.min(1.06, d);
  }

  const swFmt = w => (w >= 100 ? w.toFixed(1) : w >= 1 ? w.toFixed(2) : w.toFixed(3));
  function ccPow(w) {
    if (w >= 1) return [w >= 10 ? w.toFixed(1) : w.toFixed(2), 'W'];
    const mw = w * 1000;
    return [mw >= 100 ? mw.toFixed(0) : mw >= 10 ? mw.toFixed(1) : mw.toFixed(2), 'mW'];
  }
  const setT = (id, txt) => { const el = $(id); if (el && el.textContent !== txt) el.textContent = txt; };
  const setA = (id, k, v) => { const el = $(id); if (el && el.getAttribute(k) !== String(v)) el.setAttribute(k, v); };

  // One moment of the bench: the dots, the meter's face, the words.
  function draw(time, dt) {
    if (!live || !live.P) return;
    // On TEST, somebody keeps pressing it: every few seconds, unless a real
    // press came lately. Old presses are let go once their dots are home.
    if (S.tx === 'test' && dt > 0 && time - live.lastPress >= BURST.every) press(time);
    if (live.presses.length > 4) live.presses = live.presses.filter(p => time - p < 2 * T_LINE + 1);
    const m = M();
    // A loose joint's reflection, changing a few times a second.
    const sc = S.source === 'scenario' ? m.SCENARIOS[S.scenario] : null;
    if (sc && sc.flicker) {
      if (time - live.flickAt > 0.28 || time < live.flickAt) { live.flick = 0.55 + 0.8 * rnd(); live.flickAt = time; }
    } else live.flick = 1;
    const t = truth(live.flick);
    const P = live.P;
    // Everything is drawn as a share of what the radio is set to, so a radio
    // short of its setting draws fainter from the start.
    const atR = t.radioW > 0 ? t.radioW / Math.max(t.radioW, t.setW || 0) : 0;
    const g2 = t.antGamma * t.antGamma;
    const atTop = fwdShare(t, pointAt(P, 0.999)) * atR;
    // Forward dots: each left the radio s·T ago; it is drawn if the radio
    // was transmitting then.
    for (let i = 0; i < NF; i++) {
      const s = ((i / NF + time / T_LINE) % 1 + 1) % 1;
      const p = pointAt(P, s);
      const on = t.ok && txOn(time - s * T_LINE);
      const [ox, oy] = side(p.sg, -1);
      setA(`swm-pf${i}`, 'cx', (p.x + ox).toFixed(1)); setA(`swm-pf${i}`, 'cy', (p.y + oy).toFixed(1));
      setA(`swm-pf${i}`, 'opacity', on ? vis(fwdShare(t, p) * atR).toFixed(2) : '0');
      // Reflected dots run the other way: they left the antenna s·T ago, from
      // forward power that left the radio a line's length before that, and
      // weaken again on the way down by whatever lies between.
      const pr = pointAt(P, 1 - s);
      const onR = t.ok && txOn(time - s * T_LINE - T_LINE);
      const rShare = atTop * g2 * atTop / Math.max(fwdShare(t, pr) * atR, 1e-12);
      const [rx, ry] = side(pr.sg, 1);
      setA(`swm-pr${i}`, 'cx', (pr.x + rx).toFixed(1)); setA(`swm-pr${i}`, 'cy', (pr.y + ry).toFixed(1));
      setA(`swm-pr${i}`, 'opacity', onR ? vis(Math.min(1, rShare)).toFixed(2) : '0');
    }
    // Waves off the antenna.
    const radOn = t.ok && txOn(time - T_LINE) && !(S.source === 'scenario' && S.scenario === 'dummy');
    const radShare = t.radioW > 0 ? t.radiated / Math.max(t.radioW, t.setW || 0) : 0;
    for (let k = 0; k < 3; k++) {
      const ph = ((time / 1.2 + k / 3) % 1);
      const el = $(`swm-ln-arc${k}`);
      if (!el) continue;
      const sc2 = 1 + ph * 1.2;
      const a = live.g.ant;
      el.setAttribute('transform', `translate(${a.x} ${(a.top + a.feed) / 2}) scale(${sc2.toFixed(3)}) translate(${-a.x} ${-(a.top + a.feed) / 2})`);
      el.setAttribute('opacity', radOn ? (vis(radShare) * (1 - ph)).toFixed(2) : '0');
    }
    setA('swm-ln-led', 'class', `swm-led${txOn(time) ? ' swm-led--on' : ''}`);

    // What the meter would read just now, as it would show it.
    const present = t.ok && txOn(time);
    if (present && !live.wasOn) { live.burstAt = time; live.burstF = 0.55 + 0.45 * rnd(); live.burstJ = 0.8 + 0.4 * rnd(); live.burstFcc = 0.85 + 0.15 * rnd(); }
    live.wasOn = present;
    const sinceOff = present ? 0 : time - (live.burstAt + BURST.on);
    const meter = m.METERS[S.meter];
    const b = bookable(t);
    let fwd = b.fwd, ref = b.ref;
    // The words on the line.
    setT('swm-ln-wf', t.ok ? `→ ${W(t.fwd)}` : '');
    setT('swm-ln-wb', t.ok ? `← ${W(t.ref)}` : '');
    setT('swm-ln-wa', t.ok ? `→ ${W(t.atAnt)} ${S.source === 'scenario' && S.scenario === 'dummy' ? 'warms it' : 'reaches it'}` : '');
    setT('swm-ln-wr', t.ok ? `← ${W(t.atAnt * g2)} comes back` : '');
    const m1 = !t.ok || S.tx === 'off' ? '—' : `${W(fwd)}`;
    const m2 = !t.ok || S.tx === 'off' ? '' : `SWR ${sTxt(b.swr)}`;
    setT('swm-ln-m1', m1); setT('swm-ln-m2', m2);
    setT('swm-dev-flow-f', present ? `→ ${W(t.fwd)}` : '→');
    setT('swm-dev-flow-r', present ? `← ${W(t.ref)}` : '←');

    if (S.meter === 'swr400') {
      let target = present ? mnTarget(t.fwd, t.ref) : 0;
      if (S.mn.pep) { live.held = Math.max(live.held * Math.exp(-dt / HOLD_TAU), target); target = live.held; }
      live.needle += (target - live.needle) * (1 - Math.exp(-dt / TAU));
      const n = Math.max(0, Math.min(1.06, live.needle));
      setA('swm-mn-needle', 'transform', `rotate(${mnAng(n).toFixed(2)} ${MN.px} ${MN.py})`);
      return;
    }
    const steadyShow = present || (S.meter === 'cc3030' && S.cc.hold && live.burstAt > -1) || (S.tx === 'test' && sinceOff < 0.35);
    // A meter not built for bursts catches each one late and partly: low,
    // and different every time.
    if (S.tx === 'test' && !meter.bursts) { fwd *= live.burstF; ref *= live.burstF * live.burstJ; }
    if (S.meter === 'cc3030') {
      if (S.tx === 'test' && !S.cc.peak) { fwd *= live.burstFcc; ref *= live.burstFcc; }
      const show = t.ok && S.tx !== 'off' && steadyShow;
      const [fv, fu] = show ? ccPow(fwd) : ['0.00', 'W'];
      const [rv, ru] = show ? ccPow(ref) : ['0.00', 'W'];
      setT('swm-cc-fwd', fv); setT('swm-cc-fu', fu); setT('swm-cc-rev', rv); setT('swm-cc-ru', ru);
      const swr = show && fwd > 0 ? (ref >= fwd ? Infinity : m.swrFromGamma(Math.sqrt(ref / fwd))) : null;
      if (S.cc.rl) {
        setT('swm-cc-sl', 'R.L');
        setT('swm-cc-swr', swr == null ? '--.- dB' : `${Number.isFinite(swr) ? m.returnLossDb(m.gammaFromSwr(swr)).toFixed(1) : '0.0'} dB`);
      } else {
        setT('swm-cc-sl', 'SWR');
        setT('swm-cc-swr', swr == null ? '-.--:1' : `${Number.isFinite(swr) ? swr.toFixed(2) : '>20'}:1`);
      }
      setT('swm-cc-freq', show ? `Frequency ${Math.round(m.F_MHZ * 1000)} KHz` : 'Frequency ------ KHz');
      setA('swm-cc-hold', 'opacity', S.cc.hold ? '1' : '0');
      setA('swm-cc-peak', 'opacity', S.cc.peak ? '1' : '0');
      return;
    }
    // The SW-102 (and its HF twin).
    const on = S.sw.on;
    setA('swm-sw-lcd', 'class', `swm-lcd${S.meter === 'sw102hf' ? ' swm-lcd--hf' : ''}${on ? '' : ' swm-lcd--off'}`);
    setA('swm-sw-main', 'display', on && !S.sw.menu ? 'inline' : 'none');
    setA('swm-sw-menu', 'display', on && S.sw.menu ? 'inline' : 'none');
    setA('swm-sw-led', 'fill', on && present ? '#3ecf5e' : '#55595e');
    if (!on) return;
    setT('swm-sw-mv4', String(S.sw.offset));
    const show = t.ok && S.tx !== 'off' && (present || (S.tx === 'test' && sinceOff < 0.35));
    const low = Math.max(fwd, ref) < meter.minW;
    const fw = show && !low ? fwd : 0, rw = show && !low ? ref : 0;
    setT('swm-sw-pwr', `${swFmt(fw)}W`);
    setT('swm-sw-fw', `FW:${swFmt(fw)}W`);
    setT('swm-sw-rw', `RW:${swFmt(rw)}W`);
    const swr = fw > 0 ? (rw >= fw ? 19.99 : Math.min(19.99, m.swrFromGamma(Math.sqrt(rw / fw)))) : null;
    setT('swm-sw-vswr', swr == null ? '-.--' : swr.toFixed(2));
    setT('swm-sw-trans', fw > 0 ? `Trans% ${(100 * Math.max(0, fw - rw) / fw).toFixed(2)}%` : 'Trans% --.--%');
    if (S.meter === 'sw102') setT('swm-sw-freq', fw > 0 ? `${m.F_MHZ.toFixed(3)}MHz` : '---.---MHz');
  }

  // The caption under the meter: what it is and what it is showing.
  function meterCap() {
    const d = M().METERS[S.meter];
    const how = S.meter === 'swr400'
      ? 'Work its switches and CAL knob — on the drawing, or with the controls beside it.'
      : S.meter === 'cc3030' ? 'PEAK and HOLD are beside it.' : 'Its red button switches it on and off; blue opens its menu.';
    return `${esc(d.name)}: ${esc(d.bandMHz[0] + '–' + d.bandMHz[1])} MHz. The radio goes to <strong>${d.ports[0]}</strong>, the antenna or a dummy load to <strong>${d.ports[1]}</strong>. ${how} Drawn after the real meter; your firmware's screen may differ in detail.`;
  }

  // ── 2 · Hooking it up ──────────────────────────────────────────────────────

  function hookSteps(id) {
    const d = M().METERS[id];
    const [pIn, pOut] = d.ports;
    if (id === 'swr400') return [
      'With nothing transmitting, the needle should rest on 0. If it does not, set it with the METER ADJUST screw.',
      `On the back panel: the radio to <strong>${pIn}</strong>, the antenna or a dummy load to <strong>${pOut}</strong>.`,
      'AVG/PEP MONI on AVG. (On FM the two read the same; PEP MONI helps a needle catch a short burst.)',
      '<strong>Forward power:</strong> RANGE 20 W, FUNCTION POWER, POWER FWD. Press TEST on the A2 and read the 20 W scale; if it reads under 5, drop RANGE to 5 W. A burst is too short for the needle to swing all the way: switch to PEP MONI, press TEST a few times, and go by the highest swing.',
      '<strong>Reflected power:</strong> still on POWER, flick FWD to REF. A small reflection needs the 5 W range to read at all.',
      '<strong>SWR:</strong> FUNCTION to CAL and the CAL knob right down to MIN. With the radio held on, turn CAL up until the needle sits exactly on the CAL ▼ mark; still transmitting, switch FUNCTION to SWR and read the SWR scale. That needs the A2\'s tones setting — a TEST burst is over before the knob has moved. If the tones will not stay on, read SWR on the SW-102 or the 3030.',
      'Stop transmitting. FUNCTION back to POWER, POWER to OFF.',
    ];
    if (id === 'cc3030') return [
      'Switch it on and check the battery mark on its screen.',
      `The radio to <strong>${pIn}</strong>, the antenna or a dummy load to <strong>${pOut}</strong>.`,
      'Turn on <strong>PEAK</strong> and <strong>HOLD</strong> in its MENU (▽ △ to choose, ENTER to set). They catch the top of the A2\'s TEST burst and keep it on the screen — this is the meter built for it.',
      'Press TEST on the A2, and read <strong>FWD</strong>, <strong>REV</strong> and <strong>SWR</strong> (or return loss, if it is set to show that) off the held screen.',
      'Check the <strong>Frequency</strong> line reads about 151500 kHz: the meter picks its calibration from it.',
      'Stop transmitting. Clear HOLD before the next reading, or the screen keeps the last one.',
    ];
    return [
      id === 'sw102hf'
        ? '<strong>Stop: check the screen.</strong> This one says 1.5–70 MHz. It is the HF model and cannot read a 151.5 MHz radio. Swap it for a VHF meter.'
        : 'Check the screen says 125–525 MHz. The HF model looks identical and says 1.5–70 MHz — it cannot read this radio.',
      'Hold the red POWER button to switch it on. "B" on the screen means it is on its battery, "E" on USB power; charge it the night before.',
      `The radio to <strong>${pIn}</strong>, the antenna or a dummy load to <strong>${pOut}</strong>.`,
      'Press TEST on the A2 and watch the screen during the burst: <strong>FW</strong> (forward watts), <strong>RW</strong> (reflected watts) and the big <strong>VSWR</strong>. Trans% is the share going on past the meter.',
      'Press TEST several times. Its manual says it is "not for DMR" — not built for short bursts — so a burst can read low, and differently each press: go by the highest reading that repeats. The tones setting, if it will stay on, reads steadily.',
      'Check the frequency line shows about 151.500 MHz: it works its watts out from the frequency it counts.',
      'Stop transmitting, and hold the red button to switch it off.',
    ];
  }

  function hookHtml() {
    const d = M().METERS[S.meter];
    return `
      <div class="swm-hook-grid">
        <div>
          <h4>Before you start</h4>
          <ol class="swm-steps">
            <li>Know what you expect: the power the radio is set to (its configuration, or the install report) and the feeder — type and length.</li>
            <li>Know how you will make it transmit. The <strong>TEST</strong> button on the A2's front panel sends a short burst — the usual way. Its <strong>tones</strong> setting can hold the transmitter on, which every meter reads more easily, but it does not always stay on.</li>
            <li><strong>Never transmit into nothing.</strong> Something is always on the meter's ${d.ports[1]} side: the antenna, or a 50 Ω dummy load rated for the radio's power.</li>
            <li>Choose where it goes. <strong>At the radio</strong> it measures what the radio sends up the line, and the whole line's match. <strong>With a dummy load and no antenna</strong>, the radio alone. <strong>At the top of the feeder</strong>, the antenna alone.</li>
            <li>Undo one joint and put the meter in with short, good jumpers. Do N-types up by hand, straight on: firm, never a spanner, never cross-threaded. If one feels gritty or stops short, back it off and start it again.</li>
          </ol>
          <h4>On the ${esc(d.short)}</h4>
          <ol class="swm-steps">${hookSteps(S.meter).map(x => `<li>${x}</li>`).join('')}</ol>
          <h4>After</h4>
          <ol class="swm-steps">
            <li>Book forward, reflected and SWR in the inspection form's <strong>Antenna Tests</strong>, and say in its comments where the meter was.</li>
            <li>Take the meter out and remake the joint you undid. It is now the newest joint in the line: seated, firm by hand, and wrapped again if it is outdoors.</li>
            <li>If anything was changed, measure again — a fix that has not been measured is a guess.</li>
          </ol>
        </div>
        <div>
          <h4>Worth knowing about the ${esc(d.short)}</h4>
          <ul class="swm-list">${d.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>
          <dl class="swm-spec">
            <dt>Band</dt><dd>${d.bandMHz[0]}–${d.bandMHz[1]} MHz</dd>
            <dt>Reads</dt><dd>${esc(d.reads)}</dd>
            <dt>Sockets</dt><dd>${esc(d.ports.join(' and '))} — ${esc(d.connectors)}</dd>
            <dt>Accuracy</dt><dd>${esc(d.accuracy)}</dd>
          </dl>
          <p class="swm-src">From: ${esc(d.source)}.</p>
        </div>
      </div>`;
  }

  // ── 3 · What it measures ───────────────────────────────────────────────────

  function couplerSvg() {
    return `<svg class="swm-coupler" viewBox="0 0 640 220" role="img" aria-labelledby="swm-coupler-name">
      <title id="swm-coupler-name">Inside a through-line meter: the cable's centre conductor runs straight through, with two small pick-up lines beside it. One is terminated at the antenna end and hears only the forward wave; the other is terminated at the radio end and hears only the reflected wave. Each feeds a diode, and the two voltages are the forward and reflected readings.</title>
      <rect x="10" y="70" width="620" height="44" rx="6" class="swm-cp-body"/>
      <line x1="0" y1="92" x2="640" y2="92" class="swm-cp-main"/>
      <text x="14" y="62" class="swm-t swm-t--s">${'TX — from the radio'}</text>
      <text x="626" y="62" class="swm-t swm-t--s" text-anchor="end">ANT — to the antenna</text>
      <line x1="150" y1="128" x2="290" y2="128" class="swm-cp-pick"/>
      <line x1="350" y1="128" x2="490" y2="128" class="swm-cp-pick"/>
      <rect x="282" y="122" width="16" height="12" class="swm-cp-load"/><text x="290" y="152" class="swm-t swm-t--s" text-anchor="middle">50 Ω</text>
      <rect x="342" y="122" width="16" height="12" class="swm-cp-load"/><text x="350" y="152" class="swm-t swm-t--s" text-anchor="middle">50 Ω</text>
      <path d="M 150 128 L 150 170 L 140 170 L 150 184 L 160 170 L 150 170" class="swm-cp-diode"/>
      <path d="M 490 128 L 490 170 L 480 170 L 490 184 L 500 170 L 490 170" class="swm-cp-diode"/>
      <text x="150" y="208" class="swm-t swm-t--f" text-anchor="middle">FORWARD reading</text>
      <text x="490" y="208" class="swm-t swm-t--r" text-anchor="middle">REFLECTED reading</text>
      <text x="220" y="84" class="swm-t swm-t--f" text-anchor="middle">→ forward wave</text>
      <text x="420" y="110" class="swm-t swm-t--r" text-anchor="middle">← reflected wave</text>
    </svg>`;
  }

  function wavesHtml() {
    const m = M();
    const g = S.sgGamma;
    const s = m.swrFromGamma(g);
    return `
      <p>A radio sends its power up the cable as a wave. If the antenna looks to the cable exactly like the 50 Ω it was built for, the wave
        goes into the antenna and out into the air. If it does not — a mismatch, a fault, water — part of the wave bounces off it and runs
        back down the cable to the radio. A through-line meter sits in the cable and measures both.</p>
      <figure class="swm-fig">${couplerSvg()}
        <figcaption class="swm-cap">Inside the meter. A pick-up line beside the centre conductor couples a sliver of each wave; terminated at one
          end, it hears only the wave travelling one way. One feeds the forward reading, the other the reflected one. That is why the meter
          has a way round — and why it cannot see anything on its radio side: a fault there sends nothing back past it.</figcaption></figure>
      <h4>The standing wave</h4>
      <p>Going out and coming back, the two waves pass through each other along the cable. Where they are in step they add; half a
        wavelength along, they oppose — so the voltage on the cable swells and shrinks in a fixed pattern, the <em>standing wave</em>.
        Its <strong>ratio</strong> — the biggest swell over the smallest — is the SWR. A perfect match sends nothing back: no pattern, SWR 1.
        An open or shorted end sends everything back: the pattern goes to nothing at its narrowest, SWR ∞.</p>
      <figure class="swm-fig">
        <canvas class="swm-cv" id="swm-cv-sw" role="img" aria-label="${escAttr(sgName())}"></canvas>
        <figcaption class="swm-cap">Two wavelengths of cable, the radio on the left and the antenna on the right: <span class="swm-key swm-key--f">—</span> the wave
          going out, <span class="swm-key swm-key--r">—</span> the wave coming back, and <strong>the sum</strong> between its dashed envelope.</figcaption>
      </figure>
      <div class="swm-sg-ctl">
        <label for="swm-sg">What the antenna sends back</label>
        <input type="range" id="swm-sg" min="0" max="100" step="1" value="${Math.round(g * 100)}" oninput="SwrMeter.set('sgGamma', this.value / 100)" aria-valuetext="${escAttr(sgText(g))}">
        <div class="button-group">${[[1, 'Matched'], [1.5, '1.5'], [2, '2.0'], [3, '3.0'], [Infinity, 'Open end']].map(([v, l]) =>
          `<button type="button" class="btn swm-sm" onclick="SwrMeter.set('sgGamma', ${Number.isFinite(v) ? m.gammaFromSwr(v) : 1})">${l}</button>`).join('')}</div>
        <p class="swm-sg-out" id="swm-sg-out">${esc(sgText(g))}</p>
      </div>
      <p>The meter does not see the pattern; it measures the two waves and works the ratio out from them:
        <strong>SWR = (1 + |Γ|) / (1 − |Γ|)</strong>, where |Γ| — the reflection coefficient — is √(reflected ÷ forward). At SWR ${sTxt(s)} that is
        |Γ| ${num(g, 2)}.</p>
      <div class="swm-key-box">
        <p><strong>Where the meter sits matters.</strong> A reflection that comes back through a lossy cable is weakened twice — once on the way
          up, once on the way down — so a meter at the radio end of a long feeder reads a <em>better</em> SWR than the antenna has. With enough
          loss, even an open antenna can read like a fair one. And nothing between the radio and the meter's TX socket can show up as reflected
          power at all: a bad jumper there just makes the forward reading smaller.</p>
      </div>`;
  }

  function sgText(g) {
    const m = M();
    const s = m.swrFromGamma(g);
    return `SWR ${sTxt(s)} · |Γ| ${num(g, 2)} · ${num(100 * g * g, g < 0.1 ? 2 : 1)}% comes back · return loss ${Number.isFinite(m.returnLossDb(g)) ? num(m.returnLossDb(g), 1) + ' dB' : '∞'}`;
  }
  function sgName() { return `A standing wave on the cable. ${sgText(S.sgGamma)}: the voltage swings between ${num(1 + S.sgGamma, 2)} and ${num(1 - S.sgGamma, 2)} of the forward wave's.`; }

  function drawStanding(time) {
    const cv = $('swm-cv-sw');
    if (!cv) return;
    const f = fit(cv);
    if (!f) return;
    const { ctx, w, h } = f;
    const C = pal();
    ctx.clearRect(0, 0, w, h);
    const g = S.sgGamma;
    const L = 2;                      // wavelengths
    const x0 = 34, x1 = w - 26, mid = h / 2, A = (h / 2 - 22) / 2.05;
    const X = u => x0 + (x1 - x0) * u / L;
    ctx.strokeStyle = C.border; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, mid); ctx.lineTo(x1, mid); ctx.stroke();
    // Radio and antenna marks.
    ctx.fillStyle = C.muted; ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.fillText('radio', x0 - 2, h - 6);
    ctx.textAlign = 'right'; ctx.fillText('antenna', x1 + 2, h - 6);
    const wt = 2 * Math.PI * time / 1.6;
    const k = 2 * Math.PI;
    const path = (fn, color, width, dash) => {
      ctx.beginPath(); ctx.setLineDash(dash || []); ctx.strokeStyle = color; ctx.lineWidth = width;
      for (let i = 0; i <= 240; i++) { const u = L * i / 240; const y = mid - A * fn(u); if (i) ctx.lineTo(X(u), y); else ctx.moveTo(X(u), y); }
      ctx.stroke(); ctx.setLineDash([]);
    };
    // Forward: cos(ωt − kx). Reflected off a real load at x = L: Γ·cos(ωt + kx − 2kL).
    const fwd = u => Math.cos(wt - k * u);
    const ref = u => g * Math.cos(wt + k * u - 2 * k * L);
    const env = u => Math.sqrt(1 + g * g + 2 * g * Math.cos(2 * k * (u - L)));
    path(env, C.muted, 1.2, [5, 4]);
    path(u => -env(u), C.muted, 1.2, [5, 4]);
    path(fwd, alpha(C.accent, 0.75), 1.6);
    if (g > 0) path(ref, alpha(C.bad, 0.85), 1.6);
    path(u => fwd(u) + ref(u), C.text, 2.6);
    // Vmax and Vmin, read off the envelope.
    if (g > 0.02) {
      ctx.fillStyle = C.text; ctx.textAlign = 'center'; ctx.font = '600 12px system-ui, sans-serif';
      ctx.fillText(`Vmax ${num(1 + g, 2)}`, X(L - 1), mid - A * (1 + g) - 6);
      ctx.fillText(`Vmin ${num(1 - g, 2)}`, X(L - 0.75), mid + A * (1 - g) + 16);
    }
    ctx.textAlign = 'left'; ctx.fillStyle = C.text; ctx.font = '600 13px system-ui, sans-serif';
    ctx.fillText(`SWR = Vmax ÷ Vmin = ${sTxt(M().swrFromGamma(g))}`, x0, 16);
  }

  // A canvas sized to its box, at the device's pixel ratio.
  function fit(cv) {
    const r = cv.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(r.width), h = Math.round(r.height);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const ctx = cv.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }
  function pal() {
    const v = (n, d) => (typeof cssVar === 'function' ? cssVar(n, d) : d);
    return { text: v('--text', '#16202a'), muted: v('--muted', '#4f6478'), border: v('--border', '#dde5ee'), accent: v('--accent', '#0b5cab'),
      ok: v('--ok', '#107c10'), warn: v('--warn', '#9e5e00'), bad: v('--bad', '#c7401a'), panel: v('--panel', '#fff') };
  }
  function alpha(c, a) {
    const m = /^#([0-9a-f]{6})$/i.exec(String(c).trim());
    if (!m) return c;
    const n = parseInt(m[1], 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  // ── 4 · Watts, decibels and the fade margin ────────────────────────────────

  function dbHtml() {
    const m = M();
    const swrs = [1.0, 1.1, 1.2, 1.3, 1.5, 2.0, 2.5, 3.0, 5.0, 10, Infinity];
    const swrRows = swrs.map(s => {
      const g = m.gammaFromSwr(s), b = m.swrBand(s);
      return `<tr><th scope="row">${sTxt(s)}</th><td>${num(g, 3)}</td><td>${num(100 * g * g, g * g < 0.01 ? 2 : 1)}%</td>
        <td>${Number.isFinite(m.returnLossDb(g)) ? num(m.returnLossDb(g), 1) + ' dB' : '∞'}</td><td>${Number.isFinite(m.mismatchLossDb(g)) ? num(m.mismatchLossDb(g), 2) + ' dB' : '∞'}</td>
        <td>${W(5 * (1 - g * g))}</td><td><span class="swm-badge swm-badge--${b.cls}">${b.label}</span></td></tr>`;
    }).join('');
    const ws = [5, 4.5, 4, 3.8, 3.5, 3, 2.5, 1.25, 0.5];
    const wRows = ws.map(w => `<tr><th scope="row">${W(w)}</th><td>${num(m.wToDbm(w), 1)} dBm</td><td>${dB(m.db(w / 5), 2)}</td><td>${pct(100 * w / 5)}</td></tr>`).join('');
    return `
      <p>Watts are what a meter shows; decibels are what a radio link is built from. A decibel is a ratio: every 3 dB halves (or doubles) the
        watts, every 10 dB is a factor of ten. Losses along a line simply add up in decibels — a jumper, a feeder, a connector — where in watts
        they multiply. And a fade margin, the decibels a link has in hand, comes straight off any loss in the line.</p>
      <div class="swm-two">
        <div class="table-wrap"><table class="swm-table swm-table--num"><caption>Watts against the 5 W a radio is set to</caption>
          <thead><tr><th scope="col">Forward</th><th scope="col">dBm</th><th scope="col">Against 5 W</th><th scope="col">Of the watts</th></tr></thead>
          <tbody>${wRows}</tbody></table></div>
        <div class="table-wrap"><table class="swm-table swm-table--num"><caption>What an SWR means</caption>
          <thead><tr><th scope="col">SWR</th><th scope="col">|Γ|</th><th scope="col">Back</th><th scope="col">Return loss</th><th scope="col">Mismatch loss</th><th scope="col">Of 5 W, goes on</th><th scope="col">Form</th></tr></thead>
          <tbody>${swrRows}</tbody></table></div>
      </div>
      <p>Two things stand out. An SWR of 1.5 — the edge of Good — costs less than a fifth of a decibel: the antenna still takes 96%. And 3.8 W
        instead of 5 W, which looks like a quarter of the power gone, is 1.2 dB.</p>
      <h4>Does a decibel matter? Only near the edge</h4>
      <p>A link does not fail a little at a time. Well above the noise every message gets through; a few decibels from the edge, messages
        start to go; at the edge, half do. So the same decibel costs nothing to a station with 10 dB in hand and a lot to one with 2. Type a
        station's fade margin — from its last fade-margin test, or the Network Review — and the loss.</p>
      <div class="swm-mc">
        <label class="swm-in"><span>Fade margin</span><span class="swm-in-row"><input id="swm-mc-m" inputmode="decimal" value="${escAttr(String(S.margin))}" oninput="SwrMeter.set('margin', this.value)" aria-describedby="swm-mc-mu"><span class="swm-unit" id="swm-mc-mu">dB</span></span></label>
        <label class="swm-in"><span>Loss</span><span class="swm-in-row"><input id="swm-mc-l" inputmode="decimal" value="${escAttr(String(S.lossDb))}" oninput="SwrMeter.set('lossDb', this.value)" aria-describedby="swm-mc-lu"><span class="swm-unit" id="swm-mc-lu">dB</span></span>
          <span class="swm-hint">1.19 dB is 3.8 W of 5</span></label>
        <p class="swm-mc-out" id="swm-mc-out">${esc(mcText())}</p>
      </div>
      <figure class="swm-fig">
        <canvas class="swm-cv swm-cv--cliff" id="swm-cv-cliff" role="img" aria-label="${escAttr(cliffName())}"></canvas>
        <figcaption class="swm-cap">Messages lost against fade margin — a model, to show the shape: the Bit Bench's receiver over a 40-bit frame,
          set so that 0 dB loses half (where a fade-margin test stops), with ${M().FLUTTER_DB} dB of real-world flutter. ALERT2's coding and receiver
          differ; the cliff does not. Shaded as the link budget card does: Poor under ${M().MARGIN_FLOOR} dB, Marginal to ${M().MARGIN_GOOD}, Good above.</figcaption>
      </figure>`;
  }

  function mcText() {
    const m = M();
    const mg = Number(S.margin), l = Number(S.lossDb);
    if (!Number.isFinite(mg) || !Number.isFinite(l) || l < 0 || mg < -5 || mg > 40) return 'Type a fade margin (dB) and a loss (dB, 0 or more).';
    const c = m.marginCost(mg, l);
    const p = x => (x < 0.0001 ? 'almost none' : x < 0.01 ? `${num(100 * x, 2)}%` : `${num(100 * x, 1)}%`);
    const times = c.before >= 0.005 && c.after > c.before * 1.05 ? ` — ${num(c.times, 1)} times as many` : '';
    return `With ${num(mg, 1)} dB of margin, about ${p(c.before)} of messages are lost. ${num(l, 2)} dB less leaves ${num(c.marginAfter, 1)} dB, and about ${p(c.after)}${times}.`;
  }
  function cliffName() { return `A curve of messages lost against fade margin, steep between about 0 and 6 dB and flat above 8. ${mcText()}`; }

  function drawCliff() {
    const cv = $('swm-cv-cliff');
    if (!cv) return;
    const f = fit(cv);
    if (!f) return;
    const { ctx, w, h } = f;
    const C = pal();
    const m = M();
    ctx.clearRect(0, 0, w, h);
    const L = 46, R = 12, T = 14, B = 30;
    const x0 = -2, x1 = 14;
    const X = v => L + (v - x0) / (x1 - x0) * (w - L - R);
    const Y = v => T + (1 - v) * (h - T - B);
    // Bands.
    for (const [a, b, col] of [[x0, m.MARGIN_FLOOR, C.bad], [m.MARGIN_FLOOR, m.MARGIN_GOOD, C.warn], [m.MARGIN_GOOD, x1, C.ok]]) {
      ctx.fillStyle = alpha(col, 0.08); ctx.fillRect(X(a), T, X(b) - X(a), h - T - B);
    }
    ctx.strokeStyle = C.border; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(L, T); ctx.lineTo(L, h - B); ctx.lineTo(w - R, h - B); ctx.stroke();
    ctx.fillStyle = C.muted; ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'right';
    for (const v of [0, 0.25, 0.5, 0.75, 1]) { ctx.fillText(`${Math.round(v * 100)}%`, L - 6, Y(v) + 4); }
    ctx.textAlign = 'center';
    for (let v = 0; v <= 14; v += 2) ctx.fillText(`${v}`, X(v), h - B + 15);
    ctx.fillText('fade margin, dB', (L + w - R) / 2, h - 3);
    ctx.beginPath(); ctx.strokeStyle = C.bad; ctx.lineWidth = 2.5;
    for (let i = 0; i <= 160; i++) { const v = x0 + (x1 - x0) * i / 160; const y = Y(m.missed(v)); if (i) ctx.lineTo(X(v), y); else ctx.moveTo(X(v), y); }
    ctx.stroke();
    const mg = Number(S.margin), l = Number(S.lossDb);
    if (Number.isFinite(mg) && Number.isFinite(l) && l >= 0 && mg >= x0 - 5 && mg <= 40) {
      const a = Math.max(x0, Math.min(x1, mg)), b = Math.max(x0, Math.min(x1, mg - l));
      const ya = Y(m.missed(mg)), yb = Y(m.missed(mg - l));
      ctx.strokeStyle = C.text; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(X(a), ya); ctx.lineTo(X(b), yb); ctx.stroke(); ctx.setLineDash([]);
      for (const [x, y, c] of [[a, ya, C.accent], [b, yb, C.bad]]) { ctx.beginPath(); ctx.fillStyle = c; ctx.arc(X(x), y, 5, 0, 2 * Math.PI); ctx.fill(); }
      ctx.fillStyle = C.text; ctx.textAlign = 'left'; ctx.font = '600 12px system-ui, sans-serif';
      ctx.fillText(`${num(mg, 1)} dB`, X(a) + 8, ya - 8);
    }
  }

  // ── 5 · Reading the readings ───────────────────────────────────────────────

  function fieldHtml() {
    const rows = [
      ['SWR under 1.5, forward close to the setting', 'A healthy line and radio.', 'Book it. Compare with the last visit: a rise matters more than the number.'],
      ['SWR 1.00–1.05, at the radio end of a long feeder', 'Too good to be true: a lossy feeder hides the antenna (the reflection is weakened twice).', 'Read again at the top of the feeder, or work out the antenna\'s own SWR from the feeder\'s loss (section 1 does).'],
      ['SWR 1.5–2.0', 'Fair: a joint letting water in, an antenna aging, metal close by.', 'Remake and re-wrap the outdoor joints; look at the antenna and what is near it.'],
      ['SWR over 2', 'Poor: a fault past the meter.', 'Every joint past the meter; the antenna; a dummy load at the antenna end splits cable from antenna.'],
      ['SWR off the scale, reflected near forward', 'Open or short: broken cable, a centre pin pushed back, a flooded or crushed run, the antenna gone.', 'Stop transmitting into it. Walk the line from the meter outwards.'],
      ['Reflected bigger than forward', 'The meter is in backwards.', 'Swap its cables: radio to TX / INPUT.'],
      ['Forward low, SWR good', 'The trouble is on the radio side of the meter — or is the meter.', 'Meter position, how it caught the TEST burst, meter band and offset, the jumper and adaptors, the supply under transmit, then the radio on a dummy load.'],
      ['Forward low, SWR high', 'A fault past the meter, and the radio turning itself down to protect itself.', 'Find the fault first; the power usually comes back with it.'],
      ['Readings change from one TEST press to the next', 'A meter not built for bursts catching each one partly — or a loose joint.', 'The 3030 with PEAK and HOLD, or the highest reading that repeats over several presses. If it still jumps, wiggle each joint while pressing TEST.'],
      ['SWR changes when the cable is moved', 'A bad joint or a damaged cable at that spot.', 'Remake the joint; replace the cable if the jacket is crushed or cut.'],
      ['Good when dry, poor after rain', 'Water getting in: an unsealed joint, a cracked radome, a split jacket.', 'Seal with self-amalgamating tape over the joint, and cut back past any wet cable.'],
      ['Forward more than the setting', 'The wrong range on a needle, a meter out of calibration, or the radio set higher than thought.', 'Smallest range above the reading; check the configuration and the licensed power.'],
    ];
    return `<div class="table-wrap"><table class="swm-table swm-table--field"><caption>From what the meter shows to what to do</caption>
      <thead><tr><th scope="col">The meter shows</th><th scope="col">Most likely</th><th scope="col">Do</th></tr></thead>
      <tbody>${rows.map(([a, b, c]) => `<tr><th scope="row">${esc(a)}</th><td>${esc(b)}</td><td>${esc(c)}</td></tr>`).join('')}</tbody></table></div>
      <p class="swm-muted">A meter checks the line. It cannot see the path: a station with a perfect SWR and its full power can still miss messages
        because of what lies between it and the repeater — trees grown up, a new building, a repeater moved — or because of its timing.
        Station Health and the fade-margin test are how those show.</p>`;
  }

  // ── 6 · A case ─────────────────────────────────────────────────────────────

  function caseHtml() {
    const m = M();
    const lmr = m.CABLES.lmr400.db100;
    const metres = 100 * 1.19 / lmr;
    return `
      <p class="swm-case-q">A station has been missing more check-ins since it was remediated. The install photo shows an SW-102 reading about
        <strong>3.8 W</strong> forward at an SWR of <strong>1.01</strong>, on a radio whose configuration says 5 W. Should the installer turn the radio up
        until the meter shows a true 5 W?</p>
      <p><button type="button" class="btn btn-primary" onclick="SwrMeter.loadCase()">📟 Put these readings on the bench</button></p>
      <h4>What the numbers say</h4>
      <ul class="swm-list">
        <li><strong>3.8 W of 5 W is 1.2 dB.</strong> Real, but small: it takes 1.2 dB off every link the station has.</li>
        <li><strong>An SWR of 1.01 says the line past the meter is well matched</strong> (or too lossy to show a reflection — see below). It
          does not point at the antenna.</li>
        <li>A good SWR with low forward power points <strong>before the meter</strong> — or at the meter, or the reading.</li>
      </ul>
      <h4>Explanations, cheapest to rule out first</h4>
      <ol class="swm-steps">
        <li><strong>Where the meter was.</strong> At the top of the feeder it reads what is left after the feeder: about ${num(metres, 0)} m of LMR-400
          (at ${num(lmr, 1)} dB/100 m) is 1.2 dB, so 3.8 W there is a radio putting out 5 W. The photo should show which joint was undone.</li>
        <li><strong>How it was read.</strong> On an A2 that is almost always the TEST button: a short burst. The SW-102's manual says it is
          "not for DMR" — not built for short bursts — so one press reading under the set power is not proof of anything. Several presses, the
          highest that repeats, or the 3030 with PEAK and HOLD, settle it.</li>
        <li><strong>The meter.</strong> Is it the SW-102 (125–525 MHz) and not the identical-looking SW-102HF (1.5–70 MHz)? Is its menu item 4,
          the VHF power offset, at 0? Did its frequency line read 151.5 MHz? Seller figures put it within about 5%; ±1 dB between two
          instruments is ordinary.</li>
        <li><strong>The jumper and adaptor between the radio and the meter.</strong> The meter cannot see a bad joint on its TX side — it shows a
          good SWR and less power, exactly this picture. An N-type that feels done up but is not seated is a classic.</li>
        <li><strong>The supply.</strong> A radio's output falls when its supply sags under transmit: measure the volts at the radio while it
          transmits.</li>
        <li><strong>The radio.</strong> Only once the above are out: the meter straight on the radio with a short, known-good jumper and a 50 Ω
          dummy load. If that reads low too, the radio is low.</li>
      </ol>
      <h4>Turning it up</h4>
      <p>Turning the radio up until a meter reads 5 W treats the reading, not the cause — and if the meter was at the top of the feeder, it
        turns a correct 5 W radio into more than 5 W. A transmitter's power is normally stated at its own socket, into 50 Ω — so
        measure that first, with the meter on the radio and a dummy load, and check the specification says the same. Any change of power has to stay inside the site's licence (RF Environment shows the licensed figures), and
        it has to be booked so the next visit knows.</p>
      <h4>Is 1.2 dB enough to explain more missed check-ins?</h4>
      <p>Only if the station was already close to the edge. With 10 dB of fade margin, 1.2 dB changes almost nothing; with 3 dB, it can
        double the messages lost (section 4 works it out). So the station's fade margin — measured before and after the remediation — is the
        number that decides it. If the margin was healthy, look elsewhere for what the remediation changed: the antenna, its height or
        aim, the feeder, the repeater the station now reaches, and — for an ALERT2 station — its time slot and clock, which no SWR meter
        can see.</p>
      <p><button type="button" class="btn" onclick="SwrMeter.go('swm-db')">Work out the cost for a margin</button>
        <button type="button" class="btn" onclick="SwrMeter.tab('health')">🚦 Station Health — missed checks</button></p>`;
  }

  // ── 7 · In Flood-Net ───────────────────────────────────────────────────────

  function moreHtml() {
    const link = (t, icon, name, why, secId) => `<li><button type="button" class="link-btn swm-link" onclick="SwrMeter.tab('${t}'${secId ? `, '${secId}'` : ''})"><span aria-hidden="true">${icon}</span> ${esc(name)}</button><span class="swm-aside">${esc(why)}</span></li>`;
    return `<ul class="swm-links">
      ${link('inspections', '🩺', 'Inspections', 'Antenna Tests: TX size, forward, reflected and SWR for the antenna found and any replacement — and the path margin.')}
      ${link('history', '📋', 'Inspection History', 'Last visit\'s readings, to compare with. A rise is what matters.')}
      ${link('propagation', '🎓', 'Radio Propagation', 'The fade-margin test as a bench: what a decibel is worth, and how a test in steps reads.', 'rp-fade')}
      ${link('health', '🚦', 'Station Health', 'Missed checks and timed reports — whether a station is getting through at all.')}
      ${link('review', '📐', 'Network Review', 'Every link\'s fade margin across the network.')}
      ${link('stations', '📍', 'Stations', 'The link budget card: TX power and line loss at each end of a path.')}
      ${link('rf', '📶', 'RF Environment', 'The licensed transmitters near a site, with their power.')}
    </ul>`;
  }

  // ── The page ───────────────────────────────────────────────────────────────

  function render() {
    const saved = readLS();
    if (saved && M().METERS[saved.meter]) S.meter = saved.meter;
    if (!live) S.playing = !still();
    return `
    <div class="page swm-page" id="swm-page" style="--page-max:1180px">
      <div class="swm-hero">
        <h2 class="swm-title" id="swm-h"><span aria-hidden="true">📟</span> SWR and power meters</h2>
        <p class="swm-lede">How to put a through-line meter into a station's antenna line, what it is measuring, and what its readings mean on site.
          Pick the meter in your kit and a station — or type what your meter says — and watch the power go up the line and come back, with the
          meter's own face showing the readings and what to do about them.</p>
        ${factsHtml()}
        ${tocHtml()}
      </div>
      ${benchHtml()}
      ${sec('swm-hook', `${head('swm-hook', 2, '🔧', 'Hooking it up', 'The steps follow the meter picked above.')}<div id="swm-hook-body">${hookHtml()}</div>`)}
      ${sec('swm-waves', `${head('swm-waves', 3, '〰️', 'What the meter is measuring', '')}${wavesHtml()}`)}
      ${sec('swm-db', `${head('swm-db', 4, '🎚️', 'Watts, decibels and the fade margin', '')}${dbHtml()}`)}
      ${sec('swm-field', `${head('swm-field', 5, '🧭', 'Reading the readings in the field', 'Symptom to cause, for when you are standing at the mast.')}${fieldHtml()}`)}
      ${sec('swm-case', `${head('swm-case', 6, '🔍', 'A case: down on power after a remediation', '')}${caseHtml()}`)}
      ${sec('swm-more', `${head('swm-more', 7, '🧰', 'Where each shows up in Flood-Net', '')}${moreHtml()}`)}
    </div>`;
  }

  // ── Running it ─────────────────────────────────────────────────────────────

  function paintLine() {
    const wrap = $('swm-line-wrap');
    if (!wrap || !live) return;
    wrap.innerHTML = lineSvg();
    live.lay = live.g.kind;
  }
  function paintMeter() {
    const wrap = $('swm-meter-wrap');
    if (!wrap || !live) return;
    wrap.innerHTML = meterSvg();
    const cap = $('swm-meter-cap');
    if (cap) cap.innerHTML = meterCap();
    paintLevers();
  }
  function paintVerdict() {
    const el = $('swm-verdict');
    if (el) el.innerHTML = verdictHtml();
  }
  // The SWR-400's switches and knob, where the settings put them.
  function paintLevers() {
    if (S.meter !== 'swr400') return;
    const mn = S.mn;
    const pos = (act, i) => setA(`swm-mn-${act}-lever`, 'y', String(275 + i * 17 - (i === 2 ? 1 : 0)));
    pos('mn-range', [200, 20, 5].indexOf(Number(mn.range)));
    pos('mn-func', ['power', 'cal', 'swr'].indexOf(mn.func));
    pos('mn-dir', ['ref', 'fwd', 'off'].indexOf(mn.dir));
    setA('swm-mn-pep-lever', 'y', mn.pep ? '144' : '106');
    setA('swm-mn-knob', 'transform', `rotate(${(-135 + 270 * mn.cal).toFixed(1)} 620 150)`);
  }
  function paintDev() {
    const el = $('swm-dev');
    if (el) el.innerHTML = devControlsHtml();
  }
  function paintStatus() {
    const el = $('swm-mn-status');
    if (el) el.textContent = mnStatus();
  }
  // Everything that depends on the readings, without rebuilding a control
  // that may have focus.
  function refresh(full) {
    if (!live) return;
    syncRadios();
    if (full) paintLine();
    else {
      const t = truth();
      const name = $('swm-line-name');
      if (name) name.textContent = lineName(t);
    }
    paintStatus();
    paintVerdict();
    settle();
  }

  // Run a few seconds of the bench at once: how a still drawing is put at its
  // settled state, and how a change shows at once when paused.
  function settle() {
    if (!live) return;
    if (S.playing && live.running) return;
    const steps = 150;
    for (let i = 0; i < steps; i++) { live.t += 1 / 50; draw(live.t, 1 / 50); }
    // A still picture lands a moment into a burst, so the meter shows what it
    // made of it and the dots show what a burst looks like.
    if (S.tx === 'test') { press(live.t); for (let i = 0; i < 9; i++) { live.t += 0.02; draw(live.t, 0.02); } }
    drawStanding(live.t);
  }

  function loop(ts) {
    if (!live) return;
    live.raf = 0;
    const dt = live.last ? Math.min(0.1, (ts - live.last) / 1000) : 0;
    live.last = ts;
    live.t += dt;
    if (live.vis.bench) draw(live.t, dt);
    if (live.vis.waves) drawStanding(live.t);
    schedule();
  }
  function schedule() {
    if (!live) return;
    const want = S.playing && (live.vis.bench || live.vis.waves) && !!$('swm-page');
    live.running = want;
    if (want && !live.raf) live.raf = requestAnimationFrame(loop);
    if (!want) { if (live.raf) cancelAnimationFrame(live.raf); live.raf = 0; live.last = 0; }
  }

  // A click on a drawing's button or switch: the same as its control beside.
  function onHot(e) {
    const hot = e.target && e.target.closest && e.target.closest('[data-act]');
    if (!hot) return;
    const act = hot.getAttribute('data-act');
    const d = dev;
    const cycle = (list, cur) => list[(list.indexOf(cur) + 1) % list.length];
    switch (act) {
      case 'test': test(); break;
      case 'sw-power': d.swPower(); break;
      case 'sw-menu': d.swMenu(); break;
      case 'sw-plus': if (S.sw.menu) d.swOffset(S.sw.offset + 1); break;
      case 'mn-range': d.range(cycle([200, 20, 5], Number(S.mn.range))); break;
      case 'mn-func': d.func(cycle(['power', 'cal', 'swr'], S.mn.func)); break;
      case 'mn-dir': d.dir(cycle(['ref', 'fwd', 'off'], S.mn.dir)); break;
      case 'mn-pep': d.pep(S.mn.pep ? 'avg' : 'pep'); break;
      case 'mn-cal-down': d.calStep(-1); break;
      case 'mn-cal-up': d.calStep(1); break;
      case 'cc-menu': d.cc('rl', !S.cc.rl); break;
      case 'cc-up': d.cc('peak', !S.cc.peak); break;
      case 'cc-down': d.cc('hold', !S.cc.hold); break;
      default: break;
    }
  }
  function onWheel(e) {
    if (S.meter !== 'swr400') return;
    const hot = e.target && e.target.closest && e.target.closest('[data-act^="mn-cal"]');
    if (!hot) return;
    e.preventDefault();
    dev.calStep(e.deltaY < 0 ? 1 : -1);
  }

  function unwire() {
    if (!live) return;
    if (live.raf) cancelAnimationFrame(live.raf);
    live.io && live.io.disconnect();
    live.ro && live.ro.disconnect();
    live = null;
  }

  function init() {
    unwire();
    registerTabTeardown('SwrMeter', unwire);
    if (!$('swm-page')) return;
    live = { raf: 0, last: 0, t: 0, needle: 0, held: 0, flick: 1, flickAt: -1, wasOn: false, burstAt: -10, burstF: 1, burstJ: 1, burstFcc: 1, presses: [], lastPress: -10,
      vis: { bench: true, waves: false }, running: false, g: null, P: null, lay: '' };
    paintLine();
    paintMeter();
    paintVerdict();
    const stage = $('swm-stage');
    if (stage) { stage.addEventListener('click', onHot); stage.addEventListener('wheel', onWheel, { passive: false }); }
    if (typeof IntersectionObserver !== 'undefined') {
      live.io = new IntersectionObserver(es => {
        for (const e of es) {
          if (e.target.id === 'swm-stage') live.vis.bench = e.isIntersecting;
          if (e.target.id === 'swm-cv-sw') live.vis.waves = e.isIntersecting;
        }
        schedule();
      });
      if (stage) live.io.observe(stage);
      const sw = $('swm-cv-sw');
      if (sw) live.io.observe(sw);
    }
    if (typeof ResizeObserver !== 'undefined') {
      live.ro = new ResizeObserver(() => requestAnimationFrame(() => {
        if (!live) return;
        if (layout() !== live.lay) { paintLine(); settle(); }
        drawStanding(live.t); drawCliff();
      }));
      const wrap = $('swm-line-wrap');
      if (wrap) live.ro.observe(wrap);
      for (const id of ['swm-cv-sw', 'swm-cv-cliff']) { const c = $(id); if (c) live.ro.observe(c); }
    }
    settle();
    requestAnimationFrame(() => { drawStanding(live ? live.t : 0); drawCliff(); });
    schedule();
  }

  // ── Controls ───────────────────────────────────────────────────────────────

  function pick(id) {
    if (!M().METERS[id] || S.meter === id) return;
    S.meter = id;
    writeLS();
    if (!live) return;
    document.querySelectorAll('.swm-pick-btn').forEach(b => b.setAttribute('aria-pressed', String(b.getAttribute('onclick').includes(`'${id}'`))));
    live.needle = 0; live.held = 0;
    paintLine(); paintMeter(); paintDev();
    const hook = $('swm-hook-body');
    if (hook) hook.innerHTML = hookHtml();
    paintVerdict();
    settle();
    announce(`${M().METERS[id].name} picked.`);
  }

  function source(v) {
    if (v !== 'scenario' && v !== 'yours') return;
    S.source = v;
    const body = $('swm-src-body');
    if (body && live) {
      const tmp = document.createElement('div');
      tmp.innerHTML = sourceHtml();
      const nb = tmp.querySelector('#swm-src-body');
      if (nb) body.innerHTML = nb.innerHTML;
    }
    refresh(true);
  }

  // A radio group or a select set from code — a case loaded, a click on a
  // drawing — put back in step with the settings.
  function syncRadios() {
    const radio = (name, v) => document.querySelectorAll(`#swm-bench input[name="${name}"]`).forEach(i => { i.checked = String(i.value) === String(v); });
    radio('swm-src', S.source); radio('swm-where', S.where); radio('swm-tx', S.tx);
    const sel = $('swm-scn');
    if (sel && sel.value !== S.scenario) sel.value = S.scenario;
  }

  function scenario(k) {
    if (!M().SCENARIOS[k]) return;
    S.scenario = k;
    if (S.source !== 'scenario') { source('scenario'); }
    const st = $('swm-story');
    if (st) st.textContent = M().SCENARIOS[k].story;
    if (live) { live.needle = 0; live.held = 0; }
    refresh(true);
  }

  function type(k, v) {
    if (!(k in S.yours)) return;
    S.yours[k] = String(v == null ? '' : v).trim().replace(',', '.');
    refresh(k === 'cable' || k === 'm' || k === 'setW');
  }

  function where(v) {
    if (v !== 'radio' && v !== 'antenna') return;
    S.where = v;
    refresh(true);
  }

  function tx(v) {
    if (!['off', 'test', 'tones'].includes(v)) return;
    S.tx = v;
    if (live) { live.held = 0; live.presses = []; live.lastPress = -10; }
    const b = $('swm-test');
    if (b) b.disabled = v !== 'test';
    refresh(false);
  }

  // A burst now, as the A2's TEST button sends.
  function press(time) {
    if (!live) return;
    live.presses.push(time);
    live.lastPress = time;
  }
  function test() {
    if (!live) return;
    if (S.tx !== 'test') tx('test');
    press(live.t);
    // Paused, the bench runs just long enough to show what the meter made of it.
    if (!(S.playing && live.running)) { for (let i = 0; i < 9; i++) { live.t += 0.02; draw(live.t, 0.02); } }
  }

  function play() {
    S.playing = !S.playing;
    const b = $('swm-play');
    if (b) { b.setAttribute('aria-pressed', String(S.playing)); b.textContent = S.playing ? '⏸ Pause' : '▶ Animate'; }
    if (live) { live.last = 0; schedule(); if (!S.playing) settle(); }
  }

  // The meters' own controls.
  const dev = {
    range(v) { const n = Number(v); if (![5, 20, 200].includes(n)) return; S.mn.range = n; devChanged(); },
    func(v) { if (!['power', 'cal', 'swr'].includes(v)) return; S.mn.func = v; devChanged(); },
    dir(v) { if (!['ref', 'fwd', 'off'].includes(v)) return; S.mn.dir = v; devChanged(); },
    pep(v) { S.mn.pep = v === 'pep'; if (live) live.held = 0; devChanged(); },
    cal(v) { const n = Number(v); if (!Number.isFinite(n)) return; S.mn.cal = Math.max(0, Math.min(1, n / 100)); devChanged(); },
    calStep(d) {
      S.mn.cal = Math.max(0, Math.min(1, Math.round((S.mn.cal + d * 0.02) * 100) / 100));
      devChanged();
    },
    cc(k, on) { if (!(k in S.cc)) return; S.cc[k] = !!on; devChanged(); },
    swPower() { S.sw.on = !S.sw.on; if (!S.sw.on) S.sw.menu = false; devChanged(); },
    swMenu() { if (!S.sw.on) return; S.sw.menu = !S.sw.menu; devChanged(); },
    swOffset(v) {
      const n = Math.round(Number(v));
      if (!Number.isFinite(n)) return;
      S.sw.offset = Math.max(-99, Math.min(99, n));
      const el = $('swm-sw-off');
      if (el && document.activeElement !== el) el.value = String(S.sw.offset);
      if (live) { paintVerdict(); settle(); }
    },
  };
  // A control changed — beside the drawing or on it: put the drawing's levers
  // and the controls beside it in step, in place, so whichever has focus
  // keeps it.
  function devChanged() {
    if (!live) return;
    paintLevers();
    syncDev();
    paintStatus();
    paintVerdict();
    settle();
  }
  function syncDev() {
    const radio = (name, v) => document.querySelectorAll(`#swm-dev input[name="${name}"]`).forEach(i => { i.checked = String(i.value) === String(v); });
    if (S.meter === 'swr400') {
      radio('swm-mn-range', S.mn.range); radio('swm-mn-func', S.mn.func); radio('swm-mn-dir', S.mn.dir); radio('swm-mn-pep', S.mn.pep ? 'pep' : 'avg');
      const r = $('swm-mn-cal');
      if (r) {
        if (document.activeElement !== r) r.value = String(Math.round(S.mn.cal * 100));
        r.setAttribute('aria-valuetext', `${Math.round(S.mn.cal * 100)}% of the way from MIN to MAX`);
      }
    } else if (S.meter === 'cc3030') {
      for (const k of ['peak', 'hold', 'rl']) { const c = $(`swm-cc-${k}-in`); if (c) c.checked = !!S.cc[k]; }
    } else {
      const p = $('swm-sw-pow'), mb = $('swm-sw-menu-btn');
      if (p) { p.setAttribute('aria-pressed', String(S.sw.on)); p.textContent = `🔴 POWER — ${S.sw.on ? 'on' : 'off'}`; }
      if (mb) { mb.setAttribute('aria-pressed', String(S.sw.menu)); mb.disabled = !S.sw.on; }
    }
  }

  function set(k, v) {
    if (k === 'sgGamma') {
      const g = Math.max(0, Math.min(1, Number(v)));
      if (!Number.isFinite(g)) return;
      S.sgGamma = g;
      const r = $('swm-sg');
      if (r) { if (document.activeElement !== r) r.value = String(Math.round(g * 100)); r.setAttribute('aria-valuetext', sgText(g)); }
      const out = $('swm-sg-out');
      if (out) out.textContent = sgText(g);
      const cv = $('swm-cv-sw');
      if (cv) cv.setAttribute('aria-label', sgName());
      drawStanding(live ? live.t : 0);
      return;
    }
    if (k === 'margin' || k === 'lossDb') {
      S[k] = String(v).trim().replace(',', '.');
      const out = $('swm-mc-out');
      if (out) out.textContent = mcText();
      const cv = $('swm-cv-cliff');
      if (cv) cv.setAttribute('aria-label', cliffName());
      drawCliff();
    }
  }

  // The case in section 6, on the bench.
  function loadCase() {
    S.meter = 'sw102'; writeLS();
    S.source = 'yours';
    S.yours = { fwd: '3.8', ref: '', swr: '1.01', setW: '5', cable: '', m: '' };
    S.where = 'radio'; S.tx = 'test'; S.sw.offset = 0; S.sw.on = true; S.sw.menu = false;
    if (typeof switchTab === 'function') switchTab('swr');
    go('swm-bench');
  }

  // Opened from elsewhere — the inspection form's Antenna Tests — with its
  // readings.
  function open(o) {
    const v = x => (x == null || x === '' || !Number.isFinite(Number(x)) ? '' : String(Number(x)));
    if (o && (o.fwd != null || o.ref != null || o.swr != null)) {
      S.source = 'yours';
      S.yours = { ...S.yours, fwd: v(o.fwd), ref: v(o.ref), swr: v(o.swr), setW: v(o.setW) || S.yours.setW };
      S.where = 'radio'; S.tx = 'test';
    }
    S.from = o && o.from ? String(o.from) : '';
    if (typeof switchTab === 'function') switchTab('swr');
    go('swm-bench');
  }

  function go(id) {
    const s = $(id);
    if (!s) return;
    const h = s.querySelector('h3');
    s.scrollIntoView({ behavior: still() ? 'auto' : 'smooth', block: 'start' });
    if (h) h.focus({ preventScroll: true });
  }

  function tab(t, secId) {
    if (typeof switchTab === 'function') switchTab(t);
    if (secId && t === 'propagation' && typeof Propagation !== 'undefined' && Propagation.go) Propagation.go(secId);
  }

  // The check as words, to paste into a report or a work order.
  function checkText() {
    const m = M();
    const d = m.METERS[S.meter];
    const inp = verdictInput();
    const r = m.interpret(inp);
    const lines = ['Flood-Net — SWR check', ''];
    lines.push(`Meter: ${d.name} (${d.bandMHz[0]}–${d.bandMHz[1]} MHz), ${S.where === 'radio' ? 'at the radio' : 'at the antenna end of the feeder'}`);
    lines.push(`Read on: ${S.tx === 'test' ? 'the A2\'s TEST button (a short burst)' : S.tx === 'off' ? 'nothing (not transmitting)' : 'the A2\'s tones setting (held on)'}`);
    if (S.source === 'scenario') lines.push(`Station: ${m.SCENARIOS[S.scenario].label} (a made-up example)`);
    if (r.ok) {
      lines.push('', `Forward: ${W(r.fwd)}${r.dbm != null ? ` (${num(r.dbm, 1)} dBm)` : ''}`, `Reflected: ${W(r.ref)}`, `SWR: ${sTxt(r.swr)} : 1${r.band ? ` — ${r.band.label}` : ''}`,
        `Coming back: ${num(r.reflPct, 2)}%   Return loss: ${Number.isFinite(r.rlDb) ? num(r.rlDb, 1) + ' dB' : '∞'}   Mismatch loss: ${Number.isFinite(r.mmDb) ? num(r.mmDb, 2) + ' dB' : '∞'}`);
      if (r.setW) lines.push(`Radio set to: ${W(r.setW)} — forward is ${dB(r.vsSetDb, 2)}`);
      if (r.atAnt != null) lines.push(`Reaching the antenna: about ${W(r.atAnt)} (feeder ${num(r.feedDb, 1)} dB)`);
      lines.push('', 'What it means:');
      for (const f of r.findings) {
        lines.push(`- ${f.title}`, `  ${f.text}`);
        f.do.forEach((x, i) => lines.push(`  ${i + 1}. ${x}`));
      }
    } else lines.push('', r.error || 'No readings.');
    lines.push('', 'Worked out by Flood-Net\'s SWR Meter tab: a guide to the readings, not a calibration of the meter.');
    return lines.join('\n');
  }
  function exportTxt() {
    if (typeof dlText === 'function') dlText('swr-check.txt', checkText(), 'text/plain');
    if (typeof announce === 'function') announce('Saved the check as floodnet-swr-check.txt.');
  }

  function state() {
    return { ...S, yours: { ...S.yours }, sw: { ...S.sw }, mn: { ...S.mn }, cc: { ...S.cc }, running: !!(live && live.running), needle: live ? live.needle : 0, lay: live ? live.lay : '' };
  }

  return { render, init, open, set, pick, scenario, source, type, tx, test, where, dev, play, go, tab, loadCase, exportTxt, checkText, state };
})();
