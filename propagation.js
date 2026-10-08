// MegaNet — propagation.js
//
//   Propagation   the 🎓 Radio Propagation tab: how a reading gets from a gauge
//                 in a gully to a base station in town, taught with pictures
//                 that move. Six sections, each a drawing you can change:
//
//                   1  the network in three dimensions (PropScene) — waves
//                      spreading, shadows, echoes, repeaters relaying, ghosts
//                   2  waves adding up or cancelling — a direct wave and an
//                      echo, and the standing pattern in front of a wall
//                   3  over hills and through trees — the side-on path with
//                      its Fresnel zone, at four frequencies
//                   4  collisions, capture and flipped bits — two keyings on
//                      top of each other, bit by bit
//                   5  why repeaters wait — the delays, on a timeline
//                   6  where all of this shows up in the rest of Flood-Net
//
// After propagation-physics.js and propagation-scene.js, before init.js.
// Reaches back to core.js for esc, registerTabTeardown, cssVar and announce,
// and to app.js for switchTab (from the links in section 6, at click time).
// Nothing runs at load: renderMain() calls render() and init().
//
// ── How it is drawn ──────────────────────────────────────────────────────────
// Every drawing is a <canvas> sized by CSS and given a backing store to match
// in init() and on resize; nothing sets an inline style but a custom property.
// The 3-D scene runs its own animation loop (propagation-scene.js); the four
// 2-D drawings share one here, which only draws what is on screen and stops
// the moment the tab is left. A device asking for reduced motion gets every
// drawing still, at its most telling moment, with ▶ to run it.
//
// Every number on the tab is PropPhysics's, so the sentences, the tables and
// the pictures cannot disagree; the text around them is written for somebody
// who has never been taught any of it.
//
// Exposes: render, init, scenario, layer, delay, mast, play, replay, seekEnd,
//          cam, staggerB, set, walk, freq, reseed, go, open, state.

const Propagation = (function () {
  // The page's own settings, kept for the session so a redraw (a list
  // arriving, a theme) does not reset what somebody was looking at.
  const S = {
    sc: 'home',
    layers: { waves: true, rays: true, labels: true, fresnel: false, drape: false },
    delays: null,
    mast: 15,
    sum:    { delta: 0.5, echo: -2 },
    field:  { angle: 55, refl: 0.7, mode: 'waves', rx: 0.42, walking: false },
    prof:   { f: 151.5, clear: -10, forest: 400, km: 20, curve: true },
    bits:   { rel: -3, offset: 60, seed: 3 },
    timing: { dA: 0, dB: 0, rel: -3, seed: 4 },
  };
  let loop = 0, last = 0;
  let wired = null;            // listeners and observers, undone on the way out
  let onScreen = new Set();    // which 2-D canvases are in view
  let field = null;            // the interference field, computed once per setting
  let storyNow = -1;           // which line of the story is lit

  const PH = () => PropPhysics;
  const f1 = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '—');
  const sign = (x, d = 1) => (x > 0 ? '+' : x < 0 ? '−' : '±') + Math.abs(x).toFixed(d);
  const dbm = x => (Number.isFinite(x) ? `${x < 0 ? '−' : ''}${Math.abs(x).toFixed(0)} dBm` : '—');
  const num = (x, d = 1) => (Number.isFinite(x) ? (x < 0 ? '−' : '') + Math.abs(x).toFixed(d) : '—');
  const dbTxt = x => (Number.isFinite(x) ? `${sign(x)} dB` : 'nothing (a perfect null)');
  const stillPreferred = () => {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch (_) { return false; }
  };
  const tok = (name, fb) => (typeof cssVar === 'function' ? cssVar(name, fb) : fb);
  const stn = id => PropScene.STATIONS.find(s => s.id === id);
  function fmtT(ms) {
    if (ms < 1) return `${(ms * 1000).toFixed(ms * 1000 < 10 ? 1 : 0)} µs`;
    if (ms < 1000) return `${Math.round(ms)} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
  }

  // ── The page ───────────────────────────────────────────────────────────────

  const SCENARIO_TEXT = {
    home: 'The creek gauge, down in a forested gully, sends its river height. Watch the wave leave in every '
      + 'direction at once — up, along the valley, into the hills — and the shadow Mt Ridge throws. Hill A hears it '
      + 'plainly through the trees; Hill B only just, from the part of the wave that bends over the mountain. Each '
      + 'repeater relays it after its own delay, so the bases end up with two clean copies by two different paths.',
    same: 'The rain gauge reports and both repeaters hear it. Both are set to the same delay, so both re-transmit '
      + 'at the same instant — and at the Town base, which hears the two within a few decibels of each other, the '
      + 'copies land bit on bit. A bit flips, the frame still passes its checks, and the reading is filed under an '
      + 'address one bit away: a ghost. Give Hill B its own delay and run it again.',
    both: 'Nobody listens before they talk: ALERT is ALOHA. The creek and the rain gauge key up 90 ms apart, and '
      + 'Hill A hears the two within about 4 dB of each other. The creek\'s frame is spoilt and caught by its check '
      + 'bits; the rain gauge\'s comes through with one bit flipped — and Hill A, which stores and forwards whatever '
      + 'it decoded, relays the ghost to every base. Hill B hears the rain gauge far ahead of the creek, and the '
      + 'capture effect gives it a clean copy.',
    echo: 'Hill A sends its own check, and the Town base hears it four ways: straight, off the ground just in front '
      + 'of it, off the grain silos behind it and off the southern scarp. Each echo has further to go — the '
      + 'scarp\'s is 2.7 km and 9 µs behind — and arrives at a different point in the wave\'s cycle. Added together '
      + 'they make the signal stronger or weaker. Change the base\'s mast below and watch the total swing.',
  };

  function radio(name, value, label, checked, handler) {
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

  function factsHtml() {
    const P = PH();
    const facts = [
      ['📏', `${f1(P.wavelengthM(), 2)} m`, 'one wavelength at 151.5 MHz', 'The size of everything that matters below — a ridge, a gap, an echo half a wavelength late.'],
      ['⚡', '300 m', 'every microsecond', 'Radio crosses this whole 30 km scene in a tenth of a millisecond.'],
      ['⏱️', `${f1(P.BIT_MS, 2)} ms`, 'one ALERT bit, at 300 baud', 'As long as radio takes to travel a thousand kilometres.'],
      ['📦', `${Math.round(P.FRAME_MS)} ms`, 'one frame, 40 bits', 'An address, a value and eight fixed check bits — and no CRC.'],
      ['📡', '≈ 0.5 s', 'one keying', 'Lead-in, frame, tail. Nobody listens before they talk.'],
      ['🧲', `${P.CAPTURE_DB} dB`, 'FM\'s capture effect', 'Ahead by about this much, the stronger of two signals is heard cleanly.'],
    ];
    return `<ul class="rp-facts" aria-label="Numbers worth knowing">${facts.map(([i, big, what, why]) => `
      <li class="rp-fact"><span class="rp-fact-icon" aria-hidden="true">${i}</span>
        <span class="rp-fact-big">${big}</span><span class="rp-fact-what">${what}</span>
        <span class="rp-fact-why">${why}</span></li>`).join('')}</ul>`;
  }

  function tocHtml() {
    const items = [['rp-3d', '1 · In three dimensions'], ['rp-waves', '2 · Adding up or cancelling'],
                   ['rp-path', '3 · Hills and trees'], ['rp-bits', '4 · Flipped bits'],
                   ['rp-timing', '5 · Why repeaters wait'], ['rp-more', '6 · In Flood-Net']];
    return `<nav class="rp-toc" aria-label="On this page">${items.map(([id, t]) =>
      `<button type="button" class="rp-toc-btn" onclick="Propagation.go('${id}')">${t}</button>`).join('')}</nav>`;
  }

  function sceneHtml() {
    const d = S.delays || PropScene.SCENARIOS[S.sc].delays;
    const L = S.layers;
    const box = (k, label) => `<label class="rp-check" for="rp-l-${k}"><input type="checkbox" id="rp-l-${k}"
      ${L[k] ? 'checked' : ''} onchange="Propagation.layer('${k}', this.checked)">${label}</label>`;
    const from = stn(PropScene.SCENARIOS[S.sc].drapeFrom);
    return `
    <section class="panel rp-sec" id="rp-3d" aria-labelledby="rp-3d-h">
      <h3 id="rp-3d-h" tabindex="-1">1 · The network in three dimensions</h3>
      <p>A made-up catchment thirty kilometres across, with the parts every Flood-Net network has: <strong class="rp-k-field">field
        stations</strong> that measure, <strong class="rp-k-repeater">repeaters</strong> on hilltops that pass readings on, and
        <strong class="rp-k-base">base stations</strong> that receive them. Pick a story, then drag the picture to turn it
        (or use the buttons, or the arrow keys once it has focus). The radio here is worked out properly — distances,
        the mountain\'s shadow, the trees, the echoes — and only the heights are drawn taller than they are.</p>
      <fieldset class="rp-chips">
        <legend>Story</legend>
        ${Object.entries(PropScene.SCENARIOS).map(([id, sc]) =>
          radio('sc', id, sc.title, id === S.sc, 'Propagation.scenario(this.value)')).join('')}
      </fieldset>
      <p class="rp-blurb" id="rp-sc-blurb">${SCENARIO_TEXT[S.sc]}</p>
      <div class="button-group rp-sc-action" id="rp-sc-action">${scenarioAction()}</div>
      <div class="rp-stage">
        <canvas class="rp-scene" id="rp-scene" tabindex="0" role="img"
          aria-label="The catchment in three dimensions: two field stations, two hilltop repeaters and two base stations, with the radio waves and paths between them. The story is told in words under the picture."></canvas>
        <div class="rp-legend" aria-hidden="true">
          <span><i class="rp-sw rp-sw--field"></i>Field station</span>
          <span><i class="rp-sw rp-sw--repeater"></i>Repeater</span>
          <span><i class="rp-sw rp-sw--base"></i>Base</span>
          <span><i class="rp-sw rp-sw--wave"></i>Wavefront</span>
          <span><i class="rp-sw rp-sw--echo"></i>Echo</span>
          <span><i class="rp-sw rp-sw--leaves"></i>Through trees</span>
          <span><i class="rp-sw rp-sw--dash"></i>Bent over a ridge</span>
        </div>
      </div>
      <div class="rp-controls">
        <div class="button-group" role="group" aria-label="Playback">
          <button type="button" class="primary" id="rp-play" onclick="Propagation.play()">⏸ Pause</button>
          <button type="button" onclick="Propagation.replay()">↺ From the start</button>
          <button type="button" onclick="Propagation.seekEnd()">⏭ Show the outcome</button>
        </div>
        <div class="button-group rp-cam" role="group" aria-label="View">
          <button type="button" onclick="Propagation.cam('left')" aria-label="Turn the view left">⟲</button>
          <button type="button" onclick="Propagation.cam('right')" aria-label="Turn the view right">⟳</button>
          <button type="button" onclick="Propagation.cam('up')" aria-label="Look down more steeply">⤒</button>
          <button type="button" onclick="Propagation.cam('down')" aria-label="Look across, lower">⤓</button>
          <button type="button" onclick="Propagation.cam('in')" aria-label="Closer">＋</button>
          <button type="button" onclick="Propagation.cam('out')" aria-label="Further away">－</button>
          <button type="button" onclick="Propagation.cam('top')" aria-label="Straight down, like a map">🗺️</button>
          <button type="button" onclick="Propagation.cam('reset')" aria-label="Back to the starting view">⌂</button>
        </div>
      </div>
      <div class="rp-controls rp-controls--wrap">
        <fieldset class="rp-checks">
          <legend>Show</legend>
          ${box('waves', 'Wavefronts')} ${box('rays', 'Radio paths')} ${box('labels', 'Labels')}
          ${box('fresnel', 'First Fresnel zone')}
          <label class="rp-check" for="rp-l-drape"><input type="checkbox" id="rp-l-drape" ${L.drape ? 'checked' : ''}
            onchange="Propagation.layer('drape', this.checked)">Coverage from <span id="rp-drape-from">${esc(from.name)}</span></label>
        </fieldset>
        <div class="rp-ranges">
          ${range('rp-d-r1', 'Hill A waits', 0, 990, 30, d.r1, "Propagation.delay('r1', this.value)", `${d.r1} ms`)}
          ${range('rp-d-r2', 'Hill B waits', 0, 990, 30, d.r2, "Propagation.delay('r2', this.value)", `${d.r2} ms`)}
          ${range('rp-mast', 'Town base mast', 2, 40, 0.5, S.mast, 'Propagation.mast(this.value)', `${f1(S.mast)} m`)}
        </div>
      </div>
      <div class="rp-drape-key" id="rp-drape-key" ${L.drape ? '' : 'hidden'}>
        <span><i class="rp-sw rp-sw--cov-strong"></i>Strong (above −90 dBm)</span>
        <span><i class="rp-sw rp-sw--cov-good"></i>Good</span>
        <span><i class="rp-sw rp-sw--cov-weak"></i>Only just</span>
        <span><i class="rp-sw rp-sw--cov-none"></i>Not heard (below −117 dBm)</span>
        <span class="rp-aside">— at a field station\'s 4 m, from the story\'s first transmitter</span>
      </div>
      <h4>What happens</h4>
      <ol class="rp-story" id="rp-story"></ol>
      <h4>On a timeline</h4>
      <p class="rp-aside">Each row is a station. A filled bar is a keying — pale for the lead-in and tail, solid for the
        133 ms frame that carries the bits; an outline is a frame heard, in the colour of what became of it. The blue line
        is now. The flights between stations take microseconds — far thinner than a pixel here.</p>
      <canvas class="rp-lanes" id="rp-lanes" role="img" aria-label="Timeline of every keying and reception in this story; the same events are listed above."></canvas>
      <h4>What each receiver made of it</h4>
      <div class="rp-rx" id="rp-rx"></div>
      <div id="rp-echo" class="rp-echo" ${PropScene.SCENARIOS[S.sc].echoes ? '' : 'hidden'}></div>
    </section>`;
  }

  function scenarioAction() {
    if (S.sc === 'same') {
      return `<button type="button" onclick="Propagation.staggerB()">⏱️ Give Hill B a delay of its own (600 ms)</button>`;
    }
    if (S.sc === 'echo') {
      return `<button type="button" onclick="Propagation.go('rp-waves')">➡️ Why echoes add up or cancel</button>`;
    }
    if (S.sc === 'both') {
      return `<button type="button" onclick="Propagation.go('rp-bits')">➡️ The same collision, bit by bit</button>`;
    }
    return `<button type="button" onclick="Propagation.layer('drape', true)">🗺️ Show the creek gauge\'s coverage</button>`;
  }

  function wavesHtml() {
    const s = S.sum, fl = S.field;
    return `
    <section class="panel rp-sec" id="rp-waves" aria-labelledby="rp-waves-h">
      <h3 id="rp-waves-h" tabindex="-1">2 · Waves add up — or cancel</h3>
      <p>A radio wave is a ripple that repeats every <strong>${f1(PH().wavelengthM(), 2)} m</strong> at 151.5 MHz. When two copies of
        it arrive together — one straight from the transmitter, one bounced off something — the receiver gets their
        <em>sum</em>. If the echo has travelled a whole number of wavelengths further, the crests line up and the copies
        reinforce (up to twice as strong: +6 dB). If it has travelled half a wavelength further — <strong>one metre</strong> —
        a crest meets a trough and they cancel. Nothing about the echo has to be weak or far away for this to happen:
        a metre is enough.</p>
      <h4>Two copies of one wave</h4>
      <div class="rp-ranges">
        ${range('rp-sum-d', 'The echo\'s extra path', 0, 4, 0.05, s.delta, "Propagation.set('sum.delta', this.value)", sumOut())}
        ${range('rp-sum-e', 'The echo\'s strength', -20, 0, 1, s.echo, "Propagation.set('sum.echo', this.value)", `${s.echo} dB`)}
      </div>
      <canvas class="rp-sum" id="rp-sum" role="img" aria-label="Three waves drawn one above the other: the direct wave, the echo, and their sum. The figures beside the sliders say the same in numbers."></canvas>
      <p class="rp-readout" id="rp-sum-read">${sumRead()}</p>
      <h4>Standing in front of a wall</h4>
      <p>Now the whole picture, seen from above: a wave arriving from the left meets a wall along the top and bounces
        back. Direct and reflected waves cross everywhere, and the sum makes stripes — bands where they reinforce, and
        <em>nulls</em> where they cancel, about a metre apart. Drag the receiver (or focus it and use the arrow keys), or
        let it walk towards the wall, and watch the meter: that flicker is what <strong>fading</strong> is. It is why moving
        an antenna a metre can turn a bad site good, and why a car driving past a station can make its signal stutter.</p>
      <fieldset class="rp-chips">
        <legend>Show</legend>
        ${radio('fm', 'waves', 'The waves moving', fl.mode === 'waves', "Propagation.set('field.mode', this.value)")}
        ${radio('fm', 'strength', 'Strength only', fl.mode === 'strength', "Propagation.set('field.mode', this.value)")}
      </fieldset>
      <div class="rp-ranges">
        ${range('rp-f-angle', 'Wave arrives at', 15, 90, 1, fl.angle, "Propagation.set('field.angle', this.value)", `${fl.angle}° to the wall`)}
        ${range('rp-f-refl', 'The wall reflects', 0, 1, 0.05, fl.refl, "Propagation.set('field.refl', this.value)", reflOut())}
      </div>
      <div class="rp-field-wrap">
        <canvas class="rp-field" id="rp-field" tabindex="0" role="img"
          aria-label="Top-down view of a wave and its reflection from a wall, with a receiver you can move with the arrow keys. Its signal is read out beside the picture."></canvas>
        <div class="rp-meter" aria-hidden="true"><span class="rp-meter-fill" id="rp-meter-fill"></span></div>
      </div>
      <div class="button-group">
        <button type="button" id="rp-walk" onclick="Propagation.walk()">🚶 Walk towards the wall</button>
      </div>
      <p class="rp-readout" id="rp-field-read">${fieldRead()}</p>
      <canvas class="rp-trace" id="rp-trace" role="img" aria-label="The signal along the walk, from the bottom of the picture to the wall: peaks and nulls about a metre apart."></canvas>
      <details class="rp-more">
        <summary>Why this matters less for ALERT than for a phone — and where it still bites</summary>
        <p>A phone's data runs at millions of bits a second, so an echo a few microseconds late smears one bit into the
          next. ALERT sends 300 bits a second: one bit lasts 3.33 ms, a thousand times longer than any echo in a
          catchment is late (the southern scarp's, in the 3-D scene, is 9 µs). So ALERT's echoes never smear bits — they
          only make the whole signal stronger or weaker at that spot, and the spot is fixed: a field station that sits in
          a null stays in it until something moves. That is why a station can be poor on one mast height and fine a metre
          higher, and why a survey with a hand-held receiver is worth walking a few metres around the proposed mast.</p>
        <p>Two <em>repeaters</em> re-transmitting the same reading are a different matter: they are separate transmitters,
          milliseconds apart and slightly off each other\'s frequency, and their copies collide rather than add. Sections
          4 and 5 are about that.</p>
      </details>
    </section>`;
  }

  function sumOut() {
    const lam = PH().wavelengthM();
    return `${f1(S.sum.delta, 2)} m = ${f1(S.sum.delta / lam, 2)} λ`;
  }
  function sumRead() {
    const db = PH().twoPathDb(S.sum.delta, S.sum.echo);
    const cyc = S.sum.delta / PH().wavelengthM();
    const frac = cyc - Math.floor(cyc);
    const how = Math.abs(frac - 0.5) < 0.12 ? 'half a cycle out of step: they cancel'
      : (frac < 0.12 || frac > 0.88) ? 'in step: they reinforce'
      : 'partly out of step';
    return `The echo arrives ${f1(cyc, 2)} cycles behind — ${how}. Together: <strong>${dbTxt(db)}</strong> against the direct wave alone.`;
  }
  function reflOut() {
    const r = S.field.refl;
    return r <= 0 ? 'nothing' : `${Math.round(r * 100)} % (${f1(20 * Math.log10(r))} dB)`;
  }

  function pathHtml() {
    const p = S.prof;
    const fr = [[151.5, '151.5 MHz — ALERT'], [450, '450 MHz — UHF'], [900, '900 MHz'], [2400, '2.4 GHz — Wi-Fi']];
    return `
    <section class="panel rp-sec" id="rp-path" aria-labelledby="rp-path-h">
      <h3 id="rp-path-h" tabindex="-1">3 · Over hills, through trees</h3>
      <p>Line of sight is not a laser beam. The wave that matters fills a long, fat <strong>Fresnel zone</strong> round
        the straight line — at 151.5 MHz over 20 km it is about <strong>${f1(PH().fresnelM(10, 10), 0)} m</strong> in radius at the middle.
        A ridge that pokes into it costs signal even though you can still see the far antenna; a ridge that blocks the
        line entirely does not stop the signal dead either: the wave <strong>bends over the edge</strong> (diffraction),
        weaker for every metre the edge stands above the line. Low frequencies bend further, which is one reason VHF
        was chosen for flood warning in hilly country.</p>
      <p>Trees are mostly water, and they do absorb radio — but at 151.5 MHz a leaf is a fifteenth of a wavelength across,
        and a wave that cannot get through a canopy goes over it. A forest costs an ALERT link a few decibels. The same
        forest at 2.4 GHz costs tens of decibels. Flood-Net learnt this the hard way: its first fade-margin model stood the
        land cover up as solid walls and read tens of decibels too pessimistic against what the attenuator found on
        site — the link budget card now uses a model calibrated against those field tests.</p>
      <fieldset class="rp-chips">
        <legend>Frequency</legend>
        ${fr.map(([f, label]) => radio('pf', String(f), label, p.f === f, 'Propagation.freq(this.value)')).join('')}
      </fieldset>
      <div class="rp-ranges">
        ${range('rp-p-clear', 'Ridge top, against the line', -120, 120, 2, p.clear, "Propagation.set('prof.clear', this.value)", clearOut())}
        ${range('rp-p-forest', 'Forest at the gauge', 0, 1500, 50, p.forest, "Propagation.set('prof.forest', this.value)", `${p.forest} m deep`)}
        ${range('rp-p-km', 'Path length', 5, 60, 1, p.km, "Propagation.set('prof.km', this.value)", `${p.km} km`)}
      </div>
      <label class="rp-check" for="rp-p-curve"><input type="checkbox" id="rp-p-curve" ${p.curve ? 'checked' : ''}
        onchange="Propagation.set('prof.curve', this.checked)">Draw the Earth's curve</label>
      <canvas class="rp-prof" id="rp-prof" role="img" aria-label="A side view of the path: the repeater on its hill at the left, the gauge in a forest at the right, a ridge between them and the Fresnel zone round the line. The table below gives the numbers."></canvas>
      <div class="table-wrap">
        <table class="rp-table" id="rp-prof-table">${profTable()}</table>
      </div>
      <details class="rp-more">
        <summary>The Earth gets in the way too, on long paths</summary>
        <p>Over a long path the ground itself bulges up between the ends — ${f1(PH().earthBulgeM(20, 20), 0)} m at the middle
          of a 40 km path, after the atmosphere has bent radio a little way round the curve (the usual allowance makes the
          Earth look a third bigger than it is). A 20 m mast sees a radio horizon about ${f1(PH().horizonKm(20), 0)} km
          away over flat ground; a repeater 500 m up a hill, about ${f1(PH().horizonKm(500), 0)} km. That is why repeaters
          go on hills.</p>
      </details>
    </section>`;
  }

  function clearOut() {
    const c = S.prof.clear;
    return c > 0 ? `${c} m above — blocked` : c < 0 ? `${-c} m below — clear` : 'on the line';
  }

  // The geometry of section 3's path, in metres.
  function profGeom(fMHz = S.prof.f) {
    const P = PH();
    const L = S.prof.km;
    const d1 = L * 0.6, d2 = L * 0.4;
    const zT = 520, zR = 44;            // the repeater's antenna, the gauge's
    const lineAt = d => zT + (zR - zT) * d / L;
    const h = S.prof.clear;             // the ridge top against the line
    const nu = P.knifeNu(h, d1, d2, fMHz);
    const slope = (zT - zR) / (L * 1000);
    const canopy = Math.min(S.prof.forest, (20 - 4) / slope);
    return {
      L, d1, d2, zT, zR, lineAt, h, nu, slope, canopy,
      f1m: P.fresnelM(d1, d2, fMHz),
      diff: P.knifeDb(nu),
      trees: P.foliageDb(canopy, fMHz),
      fspl: P.fsplDb(L, fMHz),
      bulge: P.earthBulgeM(L / 2, L / 2),
    };
  }

  function profTable() {
    const rows = [151.5, 450, 900, 2400].map(f => {
      const g = profGeom(f);
      const on = f === S.prof.f;
      return `<tr${on ? ' class="rp-row-on"' : ''}><th scope="row">${f < 1000 ? f + ' MHz' : f / 1000 + ' GHz'}${on ? ' ◀' : ''}</th>
        <td>${f1(PH().wavelengthM(f), 2)} m</td><td>${f1(g.f1m, 0)} m</td><td>${num(g.h / g.f1m, 2)}</td>
        <td>${f1(g.diff)} dB</td><td>${f1(g.trees)} dB</td><td>${f1(g.fspl)} dB</td>
        <td><strong>${f1(g.fspl + g.diff + g.trees)} dB</strong></td></tr>`;
    }).join('');
    return `<caption>The same path at four frequencies — ${S.prof.km} km, a ridge ${num(S.prof.clear, 0)} m against the line,
        ${f1(profGeom().canopy, 0)} m of canopy on the way in</caption>
      <thead><tr><th scope="col">Frequency</th><th scope="col">Wavelength</th><th scope="col">Fresnel zone at the ridge</th>
        <th scope="col">Ridge in zones</th><th scope="col">Bending over</th><th scope="col">Trees</th>
        <th scope="col">Spreading out</th><th scope="col">All three</th></tr></thead>
      <tbody>${rows}</tbody>`;
  }

  function bitsHtml() {
    const b = S.bits;
    return `
    <section class="panel rp-sec" id="rp-bits" aria-labelledby="rp-bits-h">
      <h3 id="rp-bits-h" tabindex="-1">4 · Collisions, capture and flipped bits</h3>
      <p>A receiver tuned to one channel hears everything on it at once. When two stations key up together, FM does
        something useful: if one is <strong>about ${PH().CAPTURE_DB} dB stronger</strong>, the receiver locks onto it and the weaker one
        simply disappears — the <strong>capture effect</strong>. The stronger frame is decoded cleanly; the weaker is lost.
        It is when the two are close in strength that bits go wrong: each bit can come out as either station's, or
        neither's.</p>
      <p>An ALERT Binary frame has no CRC. Its only test is eight check bits that must hold fixed values. A flip in a
        check bit is caught and the frame thrown away; a flip in an <strong>address bit</strong> is not — the frame passes,
        and the reading is filed under an address one bit away. That is a <strong>ghost</strong>, and the Bit Flipper and
        Ghosting Graph tabs exist to find them.</p>
      <div class="rp-ranges">
        ${range('rp-b-rel', 'Rain gauge, against the creek', -15, 15, 1, b.rel, "Propagation.set('bits.rel', this.value)", `${sign(b.rel, 0)} dB`)}
        ${range('rp-b-off', 'Rain gauge keys up', -700, 700, 10, b.offset, "Propagation.set('bits.offset', this.value)", offOut())}
      </div>
      <canvas class="rp-bitcv" id="rp-bitcv" role="img" aria-label="The two keyings on a timeline, then each frame's 40 bits: what was sent, what was on the air on top of it, and what the receiver decoded, with flipped bits marked. The outcome is written out below."></canvas>
      <div class="rp-bit-key" aria-hidden="true">
        <span><i class="rp-sw rp-sw--addr"></i>Address bit</span><span><i class="rp-sw rp-sw--val"></i>Value bit</span>
        <span><i class="rp-sw rp-sw--chk"></i>Check bit</span><span><i class="rp-sw rp-sw--frm"></i>Start / stop</span>
        <span><i class="rp-sw rp-sw--flip"></i>Flipped</span>
      </div>
      <div class="rp-bit-out" id="rp-bit-out">${bitsOut()}</div>
      <div class="button-group">
        <button type="button" onclick="Propagation.reseed()">🎲 The same collision, another moment</button>
        <button type="button" onclick="Propagation.open('bitflipper')">🔀 Bit Flipper</button>
        <button type="button" onclick="Propagation.open('network')">🧬 Ghosting Graph</button>
      </div>
    </section>`;
  }

  function offOut() {
    const o = S.bits.offset;
    return o === 0 ? 'at the same instant' : o > 0 ? `${o} ms after the creek` : `${-o} ms before the creek`;
  }

  const MSG_A = () => stn('fs1').msg, MSG_B = () => stn('fs2').msg;
  function bitsResult() {
    const P = PH();
    const a = MSG_A(), b = MSG_B();
    const ks = [
      { id: 'A', startMs: 0, dbm: -90, bits: P.encodeAbf(a.addr, a.value) },
      { id: 'B', startMs: S.bits.offset, dbm: -90 + S.bits.rel, bits: P.encodeAbf(b.addr, b.value) },
    ];
    return { ks, res: P.receive(ks, { seed: S.bits.seed }) };
  }

  function outcomeLine(name, msg, r) {
    const P = PH();
    const sent = `${msg.addr} = ${msg.value}`;
    const who = `<strong>${esc(name)}</strong> (sent ${sent})`;
    switch (r.status) {
      case 'clean':
        return `${who}: ✓ decoded cleanly${r.overlap ? ' — it was the stronger, by enough' : ''}.`;
      case 'flipped': {
        const what = r.flips.map(j => { const [k, i] = P.ABF_MAP[j]; return k === 'A' ? `address bit ${i}` : `value bit ${i}`; });
        const ghost = r.decoded.addr !== msg.addr;
        return `${who}: ⚡ decoded as <strong>${r.decoded.addr} = ${r.decoded.value}</strong> — ${what.join(', ')}
          flipped and all eight check bits still right, so it passes. ${ghost
            ? `The reading is filed under ${r.decoded.addr}, an address ${esc(name)} does not own: a ghost.`
            : 'Right address, wrong value: a reading that looks real and is not.'}`;
      }
      case 'rejected':
        return `${who}: ✗ thrown away — check bit${r.decoded.badChecks.length > 1 ? 's' : ''}
          ${r.decoded.badChecks.map(j => j + 1).join(', ')} of 32 came out wrong, so the receiver knew the frame was spoilt.`;
      case 'lost':
        return `${who}: ✗ lost — the other station was more than ${P.CAPTURE_DB} dB stronger, and the
          receiver followed it (capture).`;
      default:
        return `${who}: too weak to hear.`;
    }
  }

  function bitsOut() {
    const { res } = bitsResult();
    const [ra, rb] = res;
    const apart = !ra.overlap;
    return `${apart ? '<p>The two keyings do not touch: both frames are heard on their own.</p>' : ''}
      <ul class="rp-outcomes"><li>${outcomeLine('Creek gauge', MSG_A(), ra)}</li>
      <li>${outcomeLine('Rain gauge', MSG_B(), rb)}</li></ul>`;
  }

  function timingHtml() {
    const t = S.timing;
    return `
    <section class="panel rp-sec" id="rp-timing" aria-labelledby="rp-timing-h">
      <h3 id="rp-timing-h" tabindex="-1">5 · Why repeaters wait</h3>
      <p>A repeater stores and forwards: it hears the whole keying, decodes the frame, and only then transmits it again.
        Two repeaters that both hear a station would re-transmit at the same moment — and every receiver that hears
        both gets them on top of each other. So each repeater waits its own <strong>delay</strong> before it keys up.
        The radio flight itself does not matter here: ${f1(PH().delayUs(15), 0)} µs over 15 km is a sixtieth of one bit. What matters
        is milliseconds.</p>
      <div class="rp-ranges">
        ${range('rp-t-a', 'Hill A waits', 0, 990, 10, t.dA, "Propagation.set('timing.dA', this.value)", `${t.dA} ms`)}
        ${range('rp-t-b', 'Hill B waits', 0, 990, 10, t.dB, "Propagation.set('timing.dB', this.value)", `${t.dB} ms`)}
        ${range('rp-t-rel', 'Hill B at the base, against Hill A', -12, 12, 1, t.rel, "Propagation.set('timing.rel', this.value)", `${sign(t.rel, 0)} dB`)}
      </div>
      <canvas class="rp-timecv" id="rp-timecv" role="img" aria-label="Timeline: the field station's keying, the two repeaters' keyings after their delays, and the two copies arriving at the base, with any overlap marked. The outcome is written out below."></canvas>
      <div id="rp-t-out" class="rp-bit-out">${timingOut()}</div>
      <p>Where one repeater is clearly the stronger at a receiver, capture saves its copy even when the two touch. Where
        they are close in strength — as at the Town base in the 3-D scene — only a gap longer than a whole keying keeps
        every bit safe. The Stations map's radio-path card warns when two repeaters that share stations hold the same
        delay. ALERT2 does away with the guessing: its stations and repeaters each transmit in their own time slot.</p>
    </section>`;
  }

  function timingResult() {
    const P = PH();
    const m = MSG_B();
    const bits = P.encodeAbf(m.addr, m.value);
    const start = P.KEYING_MS;
    const ks = [
      { id: 'A', startMs: start + S.timing.dA, dbm: -84, bits },
      { id: 'B', startMs: start + S.timing.dB, dbm: -84 + S.timing.rel, bits },
    ];
    return { ks, res: P.receive(ks, { seed: S.timing.seed }) };
  }

  function timingOut() {
    const P = PH();
    const { ks, res } = timingResult();
    const [a, b] = ks;
    const frameOf = k => [k.startMs + P.LEAD_MS, k.startMs + P.LEAD_MS + P.FRAME_MS];
    const [fa0, fa1] = frameOf(a), [fb0, fb1] = frameOf(b);
    const frames = Math.max(0, Math.min(fa1, fb1) - Math.max(fa0, fb0));
    const keyings = Math.max(0, Math.min(a.startMs, b.startMs) + P.KEYING_MS - Math.max(a.startMs, b.startMs));
    const gap = Math.abs(a.startMs - b.startMs);
    let what;
    if (frames > 0) what = `The two frames overlap by ${Math.round(frames)} ms: bits land on bits.`;
    else if (keyings > 0) what = `The frames are ${Math.round(gap - P.FRAME_MS)} ms clear of each other, but each keying's lead-in or tail still lands on the other's frame.`;
    else what = `The keyings are ${Math.round(gap - P.KEYING_MS)} ms apart: nothing touches.`;
    const line = (name, r) => {
      const o = PropScene.outcomeMark(r);
      return `<li><strong>${name}</strong>: ${o.mark.replace(/\s.*$/, '')} ${o.word}${r.decoded && r.status !== 'clean' ? ` — ${r.decoded.addr} = ${r.decoded.value}` : ''}</li>`;
    };
    return `<p>${what}</p><ul class="rp-outcomes">${line('Hill A\'s copy', res[0])}${line('Hill B\'s copy', res[1])}</ul>`;
  }

  function moreHtml() {
    const link = (id, icon, label, why) => `<li><button type="button" class="rp-link" onclick="Propagation.open('${id}')">
      <span aria-hidden="true">${icon}</span> ${label}</button><span class="rp-aside">${why}</span></li>`;
    return `
    <section class="panel rp-sec" id="rp-more" aria-labelledby="rp-more-h">
      <h3 id="rp-more-h" tabindex="-1">6 · Where this shows up in Flood-Net</h3>
      <ul class="rp-ideas">
        <li><strong>Radio goes everywhere at once</strong>, and weakens as it spreads — every doubling of the distance costs 6 dB.</li>
        <li><strong>Hills cast shadows</strong>, but the wave bends over their edges; the further it has to bend, the weaker it gets.</li>
        <li><strong>Trees are half transparent at 150 MHz</strong> — a few decibels, not a wall.</li>
        <li><strong>Echoes add up or cancel</strong>, and a metre decides which: move the antenna, not the station.</li>
        <li><strong>Collisions flip bits</strong>, and ALERT Binary's check bits do not catch a flipped address: that is a ghost.</li>
        <li><strong>Delays keep repeaters apart</strong>; capture rescues the stronger copy when they are not.</li>
      </ul>
      <ul class="rp-links">
        ${link('stations', '📍', 'Stations', 'Draw a line between two sites for its elevation profile, Fresnel zone and link budget; the 3-D view; the radio-path card with each repeater\'s delay.')}
        ${link('bitflipper', '🔀', 'Bit Flipper', 'Every address one bit away from a station\'s, and which of them a ghost would land on.')}
        ${link('network', '🧬', 'Ghosting Graph', 'The ghosts the network has actually seen, as a graph of addresses.')}
        ${link('reception', '📡', 'Reception Map', 'A drive survey: where a repeater\'s copies arrive with bits flipped.')}
        ${link('health', '🚦', 'Station Health', 'Corrupted copies, ghosts and the Airtime panel — who lands on top of whom.')}
        ${link('review', '📐', 'Network Review', 'Every station\'s fade margin to every repeater, beside what the attenuator found.')}
      </ul>
    </section>`;
  }

  function render() {
    return `
    <div class="page rp-page" id="rp-page" style="--page-max:1180px">
      <div class="rp-hero">
        <h2 class="rp-title" id="rp-h"><span aria-hidden="true">🎓</span> Radio propagation</h2>
        <p class="rp-lede">How a reading gets from a gauge in a gully to a base station in town — and the ways it goes
          wrong on the way. Every picture here moves and every one can be changed; the numbers under them are worked out,
          not made up. Nothing on this page needs a signal.</p>
        ${factsHtml()}
        ${tocHtml()}
      </div>
      ${sceneHtml()}
      ${wavesHtml()}
      ${pathHtml()}
      ${bitsHtml()}
      ${timingHtml()}
      ${moreHtml()}
    </div>`;
  }

  // ── Section 1: the story in words, and the receivers ───────────────────────

  function storyLines(story) {
    const P = PH();
    const lines = [];
    const name = id => stn(id).name;
    const keyed = story.keyings.slice().sort((a, b) => a.startMs - b.startMs);
    for (const k of keyed) {
      const s = stn(k.who);
      const m = P.decodeAbf(k.bits);
      const what = k.via
        ? `relays ${esc(name(k.origin))}'s reading${m.addr !== k.msg.addr ? ` — as it heard it, <strong>${m.addr} = ${m.value}</strong>` : ` (${m.addr} = ${m.value})`}`
        : `keys up with ${s.role === 'field' ? 'its reading' : 'its own check'}, ${m.addr} = ${m.value} (${esc(k.msg.says)})`;
      const wait = k.via ? ` after waiting ${Math.round(story.delays[k.who] || 0)} ms` : '';
      lines.push({ t: k.startMs, html: `<strong>${esc(s.name)}</strong> ${what}${wait}. The wave leaves in every direction at once.` });
      const heard = [];
      let first = Infinity;
      for (const [rx, list] of Object.entries(story.receptions)) {
        const r = list.find(x => x.key === k.key);
        if (!r) continue;
        const ps = PropScene.paths(k.who, rx);
        const p = ps[0];
        const notes = [];
        if (p.kind === 'diffracted') notes.push(`bent over a ridge, −${f1(p.losses.diffraction, 0)} dB`);
        if (p.losses.foliage > 0.5) notes.push(`through ${f1(p.canopyM, 0)} m of trees, −${f1(p.losses.foliage, 0)} dB`);
        heard.push(r.result.status === 'weak'
          ? `${esc(name(rx))} (too weak: ${dbm(r.dbm)})`
          : `${esc(name(rx))} after ${f1(PH().delayUs(p.km), 0)} µs at ${dbm(r.dbm)}${notes.length ? ' — ' + notes.join(', ') : ''}`);
        first = Math.min(first, r.arriveMs);
      }
      if (heard.length) lines.push({ t: Number.isFinite(first) ? first : k.startMs, html: `Heard by ${heard.join('; ')}.` });
      const outs = [];
      for (const [rx, list] of Object.entries(story.receptions)) {
        const r = list.find(x => x.key === k.key);
        if (!r || r.result.status === 'weak') continue;
        const o = PropScene.outcomeMark(r.result);
        const dec = r.result.decoded ? ` ${r.result.decoded.addr} = ${r.result.decoded.value}` : '';
        outs.push(`${esc(name(rx))}: ${o.mark.split(' ')[0]} ${o.word}${r.result.status === 'clean' || r.result.status === 'flipped' ? dec : ''}`);
      }
      if (outs.length) lines.push({ t: k.startMs + P.LEAD_MS + P.FRAME_MS, html: `When the frame ends — ${outs.join('; ')}.` });
    }
    return lines.sort((a, b) => a.t - b.t);
  }

  function bitStrip(bits, flips) {
    const P = PH();
    const flip = new Set(flips);
    let html = '';
    for (let w = 0; w < 4; w++) {
      html += '<span class="rp-byte">';
      for (let j = w * 8; j < w * 8 + 8; j++) {
        const k = P.ABF_MAP[j][0];
        const cls = k === 'A' ? 'addr' : k === 'D' ? 'val' : 'chk';
        html += `<span class="rp-bit rp-bit--${cls}${flip.has(j) ? ' rp-bit--flip' : ''}">${bits[j]}</span>`;
      }
      html += '</span>';
    }
    return `<span class="rp-bits" aria-hidden="true">${html}</span>`;
  }

  function rxCards(story) {
    const P = PH();
    const cards = [];
    for (const s of PropScene.STATIONS) {
      const list = story.receptions[s.id];
      if (!list || !list.length) continue;
      const rows = list.map(r => {
        const k = story.keyings.find(x => x.key === r.key);
        const o = PropScene.outcomeMark(r.result);
        const from = k.via ? `${esc(stn(k.origin).name)} via ${esc(stn(k.via).short)}` : esc(stn(k.who).name);
        const dec = r.result.decoded;
        const flipsTxt = r.result.flips.length
          ? ` Bits flipped: ${r.result.flips.map(j => { const [kk, i] = P.ABF_MAP[j]; return kk === 'A' ? `address bit ${i}` : kk === 'D' ? `value bit ${i}` : `check bit at ${j + 1}`; }).join(', ')}.`
          : '';
        return `<li class="rp-rx-row rp-rx-row--${r.result.status}">
          <span class="rp-rx-from">${from}</span>
          <span class="rp-rx-db">${dbm(r.dbm)}</span>
          <span class="rp-rx-out">${o.mark.split(' ')[0]} ${o.word}${dec && (r.result.status === 'clean' || r.result.status === 'flipped') ? ` — <strong>${dec.addr} = ${dec.value}</strong>` : ''}</span>
          ${r.result.status !== 'weak' && r.result.status !== 'lost' ? bitStrip(r.result.bits, r.result.flips) : ''}
          ${flipsTxt ? `<span class="sr-only">${flipsTxt}</span>` : ''}
        </li>`;
      }).join('');
      cards.push(`<div class="rp-rx-card rp-rx-card--${s.role}"><p class="rp-rx-name"><strong>${esc(s.name)}</strong>
        <span class="rp-aside">${s.role}</span></p><ul class="rp-rx-list">${rows}</ul></div>`);
    }
    return cards.join('') || '<p class="rp-aside">Nothing heard yet.</p>';
  }

  function echoPanel() {
    const ps = PropScene.paths('r1', 'b1', { echoes: true });
    const P = PH();
    const sum = P.phasorSum(ps.map(p => ({ db: p.dbm, phase: p.rel })));
    const deg = r => { let d = (r * 180 / Math.PI) % 360; if (d < 0) d += 360; return Math.round(d); };
    const rows = ps.map(p => `<tr><th scope="row">${esc(p.label)}</th>
      <td>${f1(p.km, 3)} km</td><td>${p.dKm > 0 ? '+' + f1(p.dKm * 1000, p.dKm < 0.01 ? 2 : 0) + ' m' : '—'}</td>
      <td>${p.dUs > 0 ? '+' + f1(p.dUs, p.dUs < 0.1 ? 4 : 2) + ' µs' : '—'}</td>
      <td>${num(p.dbm)} dBm</td><td>${p === ps[0] ? '0°' : deg(p.rel) + '°'}</td></tr>`).join('');
    const gain = sum.db - ps[0].dbm;
    return `
      <h4>The Town base's four copies</h4>
      <div class="rp-echo-grid">
        <div class="table-wrap">
          <table class="rp-table">
            <caption>Hill A to the Town base, with its mast at ${f1(S.mast)} m</caption>
            <thead><tr><th scope="col">Copy</th><th scope="col">Path</th><th scope="col">Further</th>
              <th scope="col">Later</th><th scope="col">Strength</th><th scope="col">Phase</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <canvas class="rp-phasor" id="rp-phasor" role="img" aria-label="The four copies drawn as arrows added tip to tail; the long arrow from the centre is their sum. ${gain >= 0 ? 'Stronger' : 'Weaker'} than the direct copy by ${f1(Math.abs(gain))} dB."></canvas>
      </div>
      <p class="rp-readout">Added together, the copies make <strong>${num(sum.db)} dBm</strong> —
        <strong>${dbTxt(gain)}</strong> against the direct copy alone. Every echo is microseconds late at most, a
        thousandth of one ALERT bit, so this is a change of strength, not a smear: the bits still arrive whole.
        The ground bounce is only ${f1(ps.find(p => p.kind === 'ground') ? ps.find(p => p.kind === 'ground').dKm * 1000 : 0, 2)} m
        longer than the direct path, so a change of mast height of a few metres moves it through a whole cycle.</p>`;
  }

  function onStory(story) {
    const list = document.getElementById('rp-story');
    if (list) {
      list.innerHTML = storyLines(story).map(l =>
        `<li data-t="${l.t}"><span class="rp-story-t">${fmtT(l.t)}</span> <span>${l.html}</span></li>`).join('');
      storyNow = -1;
    }
    const rx = document.getElementById('rp-rx');
    if (rx) rx.innerHTML = rxCards(story);
    const echo = document.getElementById('rp-echo');
    if (echo) {
      const on = !!PropScene.SCENARIOS[S.sc].echoes;
      echo.hidden = !on;
      echo.innerHTML = on ? echoPanel() : '';
      if (on) requestAnimationFrame(drawPhasor);
    }
  }

  function onTick({ t }) {
    const list = document.getElementById('rp-story');
    if (!list) return;
    const items = list.children;
    let idx = -1;
    for (let i = 0; i < items.length; i++) if (Number(items[i].dataset.t) <= t) idx = i;
    if (idx !== storyNow) {
      storyNow = idx;
      for (let i = 0; i < items.length; i++) {
        items[i].classList.toggle('is-past', i < idx);
        items[i].classList.toggle('is-now', i === idx);
      }
    }
    const btn = document.getElementById('rp-play');
    const want = PropScene.playing() ? '⏸ Pause' : '▶ Play';
    if (btn && btn.textContent !== want) btn.textContent = want;
  }

  // ── Canvases ──────────────────────────────────────────────────────────────

  // A canvas's backing store matched to its CSS box. Returns the 2-D context
  // in CSS pixels, with w and h, or null if it is not laid out.
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

  // The tokens, read once per theme rather than every frame.
  let palCache = null, palTheme = null;
  function pal() {
    const theme = document.documentElement.getAttribute('data-theme');
    if (palCache && palTheme === theme) return palCache;
    palTheme = theme;
    palCache = readPal();
    return palCache;
  }
  function readPal() {
    return {
      text: tok('--text', '#16202a'), muted: tok('--muted', '#4f6478'), border: tok('--border', '#dde5ee'),
      panel: tok('--panel', '#fff'), subtle: tok('--subtle', '#f7fafc'),
      wave: tok('--rp-wave', '#0097c4'), echo: tok('--rp-echo', '#e07b00'), sum: tok('--rp-sum', '#7c35a3'),
      ok: tok('--ok', '#107c10'), bad: tok('--bad', '#c7401a'), warn: tok('--warn', '#9e5e00'),
      addr: tok('--rp-bit-addr', '#0b5cab'), val: tok('--rp-bit-val', '#107c10'), chk: tok('--rp-bit-chk', '#7c35a3'),
      frm: tok('--rp-bit-frm', '#8a96a3'), leaves: tok('--rp-leaves', '#2e7d32'), ground: tok('--rp-ground', '#b9a27a'),
      sky: tok('--rp-sky', '#cfe3f6'), fresnel: tok('--rp-fresnel', '#7c35a3'),
      field: tok('--role-field', '#107c10'), repeater: tok('--role-repeater', '#0b5cab'), base: tok('--role-base', '#c7401a'),
    };
  }

  function drawSum(time) {
    const g = fit(document.getElementById('rp-sum'));
    if (!g) return;
    const { ctx, w, h } = g;
    const C = pal();
    const P = PH();
    const lam = P.wavelengthM();
    const a2 = Math.pow(10, S.sum.echo / 20);
    const ph = -2 * Math.PI * S.sum.delta / lam;
    const plotW = w - (w > 520 ? 150 : 0);
    const rowH = h / 3;
    const wl = Math.max(70, plotW / 4.2);              // pixels per wavelength on screen
    const om = time / 700;                             // how far the waves have moved
    const rows = [
      { label: 'Direct', amp: 1, ph: 0, col: C.wave },
      { label: 'Echo', amp: a2, ph, col: C.echo },
      { label: 'Sum', amp: null, ph: 0, col: C.sum },
    ];
    ctx.font = '12px system-ui, -apple-system, Segoe UI, sans-serif';
    rows.forEach((r, i) => {
      const y0 = rowH * i + rowH / 2;
      const amp = rowH * 0.2;
      ctx.strokeStyle = C.border;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(56, y0);
      ctx.lineTo(plotW - 6, y0);
      ctx.stroke();
      ctx.fillStyle = C.muted;
      ctx.fillText(r.label, 6, y0 + 4);
      ctx.beginPath();
      for (let x = 56; x <= plotW - 6; x += 2) {
        const k = 2 * Math.PI * (x - 56) / wl - om;
        const v = r.amp == null ? Math.cos(k) + a2 * Math.cos(k + ph) : r.amp * Math.cos(k + r.ph);
        const y = y0 - v * amp;
        if (x === 56) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = r.col;
      ctx.lineWidth = i === 2 ? 2.6 : 1.8;
      ctx.stroke();
    });
    if (w > 520) {
      // The phasor clock: two arrows and their sum.
      const cx = w - 72, cy = h / 2, R = Math.min(56, h / 4);
      ctx.strokeStyle = C.border;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.stroke();
      const arrow = (x0, y0, x1, y1, col, width) => {
        ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = width;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        const an = Math.atan2(y1 - y0, x1 - x0);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 - 8 * Math.cos(an - 0.4), y1 - 8 * Math.sin(an - 0.4));
        ctx.lineTo(x1 - 8 * Math.cos(an + 0.4), y1 - 8 * Math.sin(an + 0.4));
        ctx.closePath(); ctx.fill();
      };
      const spin = -om;
      const x1 = cx + R * Math.cos(spin), y1 = cy - R * Math.sin(spin);
      const x2 = x1 + R * a2 * Math.cos(spin + ph), y2 = y1 - R * a2 * Math.sin(spin + ph);
      arrow(cx, cy, x1, y1, C.wave, 2);
      arrow(x1, y1, x2, y2, C.echo, 2);
      arrow(cx, cy, x2, y2, C.sum, 3);
      ctx.fillStyle = C.muted;
      ctx.fillText('as arrows', cx - 26, cy + R + 18);
    }
  }

  // The field in front of a wall: a plane wave arriving at `angle` to the
  // wall (along the top edge) and its reflection, as complex amplitudes on a
  // grid of cells. The picture is 24 m across.
  const FIELD_W = 24, FIELD_COLS = 192;
  function fieldGrid(rows) {
    const key = [S.field.angle, S.field.refl, rows].join('|');
    if (field && field.key === key) return field;
    const lam = PH().wavelengthM();
    const k = 2 * Math.PI / lam;
    const th = S.field.angle * Math.PI / 180;
    const cols = FIELD_COLS, cell = FIELD_W / cols;
    const re = new Float32Array(cols * rows), im = new Float32Array(cols * rows);
    // The wall is at y = 0 (top); y grows down, away from it. The incoming
    // wave travels right and up (towards the wall); the reflection right and down.
    const kx = k * Math.cos(th), ky = k * Math.sin(th);
    const G = S.field.refl;
    let max = 0;
    for (let j = 0; j < rows; j++) {
      const y = (j + 0.5) * cell;
      for (let i = 0; i < cols; i++) {
        const x = (i + 0.5) * cell;
        // incoming e^{i(kx x - ky y)}, reflected −G e^{i(kx x + ky y)}
        const p1 = kx * x + ky * y, p2 = kx * x - ky * y;
        const r = Math.cos(p1) - G * Math.cos(p2), m = Math.sin(p1) - G * Math.sin(p2);
        re[j * cols + i] = r; im[j * cols + i] = m;
        const a = Math.hypot(r, m);
        if (a > max) max = a;
      }
    }
    field = { key, re, im, cols, rows, cell, max, img: null };
    return field;
  }
  function fieldAt(yFrac) {
    // The strength at the receiver, against the direct wave alone, dB.
    const lam = PH().wavelengthM();
    const k = 2 * Math.PI / lam;
    const th = S.field.angle * Math.PI / 180;
    const H = FIELD_W / 2;
    const ph = 2 * k * Math.sin(th) * yFrac * H;
    const amp = Math.hypot(1 - S.field.refl * Math.cos(ph), S.field.refl * Math.sin(ph));
    return amp > 1e-9 ? 20 * Math.log10(amp) : -Infinity;
  }
  function fieldRead() {
    const db = fieldAt(S.field.rx);
    const m = S.field.rx * FIELD_W / 2;
    return `The receiver is ${f1(m, 2)} m from the wall: ${dbTxt(db)} against the direct wave alone.
      Nulls come every ${f1(PH().wavelengthM() / (2 * Math.sin(S.field.angle * Math.PI / 180)), 2)} m.`;
  }

  function drawField(time) {
    const cv = document.getElementById('rp-field');
    const g = fit(cv);
    if (!g) return;
    const { ctx, w, h } = g;
    const C = pal();
    const rows = Math.round(FIELD_COLS * (h / w));
    const F = fieldGrid(rows);
    // Paint the cells into a small image, then stretch it.
    if (!F.img || F.img.height !== rows) {
      F.cv = document.createElement('canvas');
      F.cv.width = F.cols; F.cv.height = rows;
      F.img = F.cv.getContext('2d').createImageData(F.cols, rows);
    }
    const d = F.img.data;
    const wv = rgbOf(C.wave), wall = rgbOf(C.text);
    const bg = rgbOf(C.panel);
    const om = time / 260;
    const c = Math.cos(om), s = Math.sin(om);
    for (let q = 0; q < F.cols * rows; q++) {
      let v;
      if (S.field.mode === 'waves') v = (F.re[q] * c - F.im[q] * s) / (1 + S.field.refl) * 0.5 + 0.5;
      else v = Math.hypot(F.re[q], F.im[q]) / (1 + S.field.refl);
      v = Math.max(0, Math.min(1, v));
      d[q * 4]     = bg[0] + (wv[0] - bg[0]) * v;
      d[q * 4 + 1] = bg[1] + (wv[1] - bg[1]) * v;
      d[q * 4 + 2] = bg[2] + (wv[2] - bg[2]) * v;
      d[q * 4 + 3] = 255;
    }
    F.cv.getContext('2d').putImageData(F.img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(F.cv, 0, 0, w, h);
    // The wall.
    ctx.fillStyle = `rgb(${wall.join(',')})`;
    ctx.fillRect(0, 0, w, 5);
    ctx.font = '12px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillStyle = C.text;
    ctx.fillText('wall', 6, 18);
    // Where the wave comes from.
    const th = S.field.angle * Math.PI / 180;
    ctx.strokeStyle = C.text; ctx.lineWidth = 2;
    const ax = 16, ay = h - 16, L = 44;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax + L * Math.cos(th), ay - L * Math.sin(th)); ctx.stroke();
    ctx.fillText('from the transmitter', ax + 4, ay + 12 > h - 2 ? ay - 4 : ay + 12);
    // The receiver, and its path when walking.
    const rx = w * 0.5, ry = S.field.rx * h;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = C.muted; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(rx, h); ctx.lineTo(rx, 6); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(rx, ry, 8, 0, Math.PI * 2);
    ctx.fillStyle = C.base; ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
    // A metre, for scale.
    const px = w / FIELD_W;
    ctx.fillStyle = C.text;
    ctx.fillRect(w - 12 - px * 2, h - 14, px * 2, 3);
    ctx.fillText('2 m', w - 12 - px * 2, h - 20);
    // The meter beside it.
    const db = fieldAt(S.field.rx);
    const fill = document.getElementById('rp-meter-fill');
    if (fill) {
      const pct = Math.max(0, Math.min(100, (Math.max(db, -30) + 30) / 36 * 100));
      fill.style.setProperty('--rp-level', pct.toFixed(1) + '%');
      fill.classList.toggle('is-null', db < -10);
    }
  }

  function drawTrace() {
    const g = fit(document.getElementById('rp-trace'));
    if (!g) return;
    const { ctx, w, h } = g;
    const C = pal();
    const pad = 30;
    ctx.font = '11px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.strokeStyle = C.border;
    ctx.beginPath(); ctx.moveTo(pad, h - 18); ctx.lineTo(w - 6, h - 18); ctx.stroke();
    const y = db => 8 + (h - 30) * (1 - (Math.max(db, -30) + 30) / 36);
    ctx.fillStyle = C.muted;
    for (const db of [6, 0, -10, -20]) {
      ctx.fillText(`${db > 0 ? '+' : ''}${db}`, 2, y(db) + 4);
      ctx.strokeStyle = C.border; ctx.beginPath(); ctx.moveTo(pad, y(db)); ctx.lineTo(w - 6, y(db)); ctx.stroke();
    }
    ctx.fillText('at the wall', w - 70, h - 4);
    ctx.fillText(`${FIELD_W / 2} m out`, pad, h - 4);
    ctx.beginPath();
    for (let x = pad; x <= w - 6; x++) {
      const frac = 1 - (x - pad) / (w - 6 - pad);
      const v = y(fieldAt(frac));
      if (x === pad) ctx.moveTo(x, v); else ctx.lineTo(x, v);
    }
    ctx.strokeStyle = C.sum; ctx.lineWidth = 2; ctx.stroke();
    const xr = pad + (1 - S.field.rx) * (w - 6 - pad);
    ctx.beginPath(); ctx.arc(xr, y(fieldAt(S.field.rx)), 5, 0, Math.PI * 2);
    ctx.fillStyle = C.base; ctx.fill();
  }

  function rgbOf(c) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(c).trim());
    if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
    const r = /rgba?\(([^)]+)\)/.exec(c);
    if (r) return r[1].split(',').slice(0, 3).map(Number);
    return [128, 128, 128];
  }

  function drawProfile(time) {
    const g = fit(document.getElementById('rp-prof'));
    if (!g) return;
    const { ctx, w, h } = g;
    const C = pal();
    const G = profGeom();
    const P = PH();
    const padL = 10, padR = 10, top = 16, bot = 22;
    const zMax = 680;
    const X = km => padL + (w - padL - padR) * km / G.L;
    const Y = m => top + (h - top - bot) * (1 - m / zMax);
    const bulge = km => (S.prof.curve ? P.earthBulgeM(km, G.L - km) : 0);
    // The ground: the repeater's hill, the valley, the ridge, the gauge's flat.
    const ridgeKm = G.d1;
    const ridgeTop = G.lineAt(ridgeKm) + G.h;
    const groundAt = km => {
      const hill = 500 * Math.exp(-Math.pow(km / (G.L * 0.18), 2));
      const ridgeW = G.L * 0.08;
      const ridge = Math.max(0, (ridgeTop - bulge(ridgeKm) - 40) * (1 - Math.abs(km - ridgeKm) / ridgeW));
      return Math.max(40, 40 + Math.max(hill - 40, 0), ridge > 0 ? 40 + ridge : 0) + bulge(km);
    };
    // Sky.
    ctx.fillStyle = C.subtle;
    ctx.fillRect(0, 0, w, h);
    // Ground.
    ctx.beginPath();
    ctx.moveTo(X(0), Y(0));
    for (let i = 0; i <= 200; i++) { const km = G.L * i / 200; ctx.lineTo(X(km), Y(groundAt(km))); }
    ctx.lineTo(X(G.L), Y(0));
    ctx.closePath();
    ctx.fillStyle = C.ground;
    ctx.fill();
    // The forest at the gauge.
    if (S.prof.forest > 0) {
      const f0 = G.L - S.prof.forest / 1000;
      ctx.fillStyle = C.leaves;
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.moveTo(X(f0), Y(groundAt(f0)));
      for (let i = 0; i <= 40; i++) { const km = f0 + (G.L - f0) * i / 40; ctx.lineTo(X(km), Y(groundAt(km) + 20 + 4 * Math.sin(km * 40))); }
      ctx.lineTo(X(G.L), Y(groundAt(G.L)));
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    // The Fresnel zone, and the line.
    ctx.beginPath();
    for (let i = 0; i <= 100; i++) {
      const km = G.L * i / 100;
      const r = P.fresnelM(km, G.L - km, S.prof.f);
      const y = Y(G.lineAt(km) + r);
      if (i === 0) ctx.moveTo(X(km), y); else ctx.lineTo(X(km), y);
    }
    for (let i = 100; i >= 0; i--) {
      const km = G.L * i / 100;
      const r = P.fresnelM(km, G.L - km, S.prof.f);
      ctx.lineTo(X(km), Y(G.lineAt(km) - r));
    }
    ctx.closePath();
    ctx.fillStyle = C.fresnel;
    ctx.globalAlpha = 0.14;
    ctx.fill();
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = C.fresnel;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(X(0), Y(G.zT)); ctx.lineTo(X(G.L), Y(G.zR));
    ctx.strokeStyle = C.muted; ctx.stroke();
    ctx.setLineDash([]);
    // Wave crests travelling down the path: dimmer past the ridge by its
    // loss, dimmer again through the trees; bent round the ridge top when it
    // blocks the line.
    const spacing = { 151.5: 34, 450: 20, 900: 14, 2400: 9 }[S.prof.f] || 20;
    const pxLen = X(G.L) - X(0);
    const shift = (time / 18) % spacing;
    const afterRidge = Math.pow(10, -G.diff / 20);
    for (let s = shift; s < pxLen; s += spacing) {
      const km = G.L * s / pxLen;
      let a = 1;
      if (km > ridgeKm) a *= afterRidge;
      const f0 = G.L - S.prof.forest / 1000;
      if (km > f0 && S.prof.forest > 0) {
        const into = Math.min((km - f0) * 1000, G.canopy);
        a *= Math.pow(10, -P.foliageDb(into, S.prof.f) / 20);
      }
      const r = Math.max(P.fresnelM(km, G.L - km, S.prof.f), 6);
      const yc = G.lineAt(km);
      ctx.strokeStyle = C.wave;
      ctx.globalAlpha = Math.max(0.08, a);
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (G.h > 0 && km > ridgeKm) {
        // Round the ridge top: arcs centred on the edge.
        const cx = X(ridgeKm), cy = Y(ridgeTop);
        const rad = X(km) - cx;
        ctx.arc(cx, cy, Math.max(rad, 1), -0.35, 0.9);
      } else {
        ctx.moveTo(X(km), Y(yc + r));
        ctx.lineTo(X(km), Y(yc - r));
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // The two antennas.
    const mast = (km, zTop, col, label) => {
      ctx.strokeStyle = C.text; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(X(km), Y(groundAt(km))); ctx.lineTo(X(km), Y(zTop)); ctx.stroke();
      ctx.beginPath(); ctx.arc(X(km), Y(zTop), 5, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
      ctx.font = '600 12px system-ui, -apple-system, Segoe UI, sans-serif';
      ctx.fillStyle = C.text;
      const tw = ctx.measureText(label).width;
      ctx.fillText(label, Math.max(4, Math.min(w - tw - 4, X(km) - tw / 2)), Y(zTop) - 10);
    };
    mast(0, G.zT, C.repeater, 'Repeater');
    mast(G.L, G.zR, C.field, 'Gauge');
    ctx.font = '11px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillStyle = C.muted;
    ctx.fillText(`${G.L} km · heights ×${Math.round((G.L * 1000 / zMax) * ((h - top - bot) / (w - padL - padR)))}`, padL, h - 6);
    const crestLabel = 'wave crests, drawn far apart';
    ctx.fillText(crestLabel, w - padR - ctx.measureText(crestLabel).width, h - 6);
  }

  function drawBits(time) {
    const g = fit(document.getElementById('rp-bitcv'));
    if (!g) return;
    const { ctx, w, h } = g;
    const C = pal();
    const P = PH();
    const { ks, res } = bitsResult();
    const [A, B] = ks;
    // The timeline.
    const t0 = Math.min(A.startMs, B.startMs) - 40, t1 = Math.max(A.startMs, B.startMs) + P.KEYING_MS + 40;
    const left = 92, right = 8;
    const X = t => left + (w - left - right) * (t - t0) / (t1 - t0);
    ctx.font = '12px system-ui, -apple-system, Segoe UI, sans-serif';
    const lane = (k, y, col, name) => {
      ctx.fillStyle = C.text; ctx.fillText(name, 6, y + 13);
      ctx.fillStyle = col; ctx.globalAlpha = 0.3;
      ctx.fillRect(X(k.startMs), y, X(k.startMs + P.KEYING_MS) - X(k.startMs), 18);
      ctx.globalAlpha = 1;
      ctx.fillRect(X(k.startMs + P.LEAD_MS), y, X(k.startMs + P.LEAD_MS + P.FRAME_MS) - X(k.startMs + P.LEAD_MS), 18);
    };
    lane(A, 6, C.field, 'Creek');
    lane(B, 28, C.base, 'Rain');
    const o0 = Math.max(A.startMs, B.startMs), o1 = Math.min(A.startMs, B.startMs) + P.KEYING_MS;
    if (o1 > o0) {
      ctx.fillStyle = C.bad; ctx.globalAlpha = 0.12;
      ctx.fillRect(X(o0), 2, X(o1) - X(o0), 48);
      ctx.globalAlpha = 1;
    }
    // Each frame, bit by bit.
    const cellW = (w - left - right) / 40;
    const showDigits = cellW >= 12;
    const blocks = [[A, res[0], 'Creek', B], [B, res[1], 'Rain', A]];
    const playhead = stillPreferred() ? 40 : Math.floor((time / 45) % 56);
    let y = 64;
    for (const [k, r, name, other] of blocks) {
      const air = P.onAirBits(k.bits);
      const got = r.status === 'lost' || r.status === 'weak' ? null : P.onAirBits(r.bits);
      const flips = new Set(r.flips);
      const rowsDef = [
        [`${name} sent`, j => ({ b: air[j].bit, kind: air[j].data < 0 ? 'frm' : P.ABF_MAP[air[j].data][0] })],
        ['on top', j => {
          const tm = k.startMs + P.LEAD_MS + (j + 0.5) * P.BIT_MS;
          const oj = Math.floor((tm - (other.startMs + P.LEAD_MS)) / P.BIT_MS);
          if (tm < other.startMs || tm > other.startMs + P.KEYING_MS) return null;
          if (oj >= 0 && oj < 40) return { b: P.onAirBits(other.bits)[oj].bit, kind: 'other' };
          return { b: '~', kind: 'other' };
        }],
        ['received', j => (got ? { b: got[j].bit, kind: air[j].data >= 0 && flips.has(air[j].data) ? 'flip' : 'got' } : null)],
      ];
      rowsDef.forEach(([label, fn], ri) => {
        ctx.fillStyle = C.muted;
        ctx.fillText(label, 6, y + 13);
        for (let j = 0; j < 40; j++) {
          if (ri === 2 && j > playhead) continue;
          const c = fn(j);
          const x = left + j * cellW;
          if (!c) {
            ctx.strokeStyle = C.border; ctx.strokeRect(x + 0.5, y + 0.5, cellW - 1, 17);
            continue;
          }
          const col = c.kind === 'A' ? C.addr : c.kind === 'D' ? C.val : c.kind === 'K' ? C.chk
            : c.kind === 'frm' ? C.frm : c.kind === 'flip' ? C.bad : c.kind === 'other' ? C.muted : C.text;
          ctx.fillStyle = col;
          ctx.globalAlpha = c.kind === 'got' ? 0.18 : c.kind === 'other' ? 0.25 : 0.85;
          ctx.fillRect(x + 0.5, y + 0.5, cellW - 1, 17);
          ctx.globalAlpha = 1;
          if (showDigits) {
            ctx.fillStyle = c.kind === 'got' || c.kind === 'other' ? C.text : '#fff';
            ctx.fillText(String(c.b), x + cellW / 2 - 3.5, y + 13);
          }
        }
        y += 20;
      });
      if (r.status === 'lost') {
        ctx.fillStyle = C.bad;
        ctx.fillText('lost — the receiver followed the stronger signal', left + 4, y - 7);
      }
      y += 10;
    }
  }

  function drawTiming() {
    const g = fit(document.getElementById('rp-timecv'));
    if (!g) return;
    const { ctx, w, h } = g;
    const C = pal();
    const P = PH();
    const { ks, res } = timingResult();
    const [a, b] = ks;
    const left = 96, right = 10;
    const span = Math.max(2200, Math.max(a.startMs, b.startMs) + P.KEYING_MS + 100);
    const X = t => left + (w - left - right) * t / span;
    ctx.font = '12px system-ui, -apple-system, Segoe UI, sans-serif';
    const bar = (s, y, col, hgt = 16) => {
      ctx.fillStyle = col; ctx.globalAlpha = 0.3;
      ctx.fillRect(X(s), y, X(s + P.KEYING_MS) - X(s), hgt);
      ctx.globalAlpha = 1;
      ctx.fillRect(X(s + P.LEAD_MS), y, X(s + P.LEAD_MS + P.FRAME_MS) - X(s + P.LEAD_MS), hgt);
    };
    const rows = [['Rain gauge', 10], ['Hill A', 36], ['Hill B', 62], ['Base, from A', 98], ['Base, from B', 120]];
    for (const [label, y] of rows) { ctx.fillStyle = C.text; ctx.fillText(label, 6, y + 12); }
    // Ticks.
    ctx.fillStyle = C.muted;
    ctx.strokeStyle = C.border;
    const every = w < 560 ? 1000 : 500;
    for (let ms = 0; ms <= span; ms += 250) {
      ctx.beginPath(); ctx.moveTo(X(ms), 4); ctx.lineTo(X(ms), 140); ctx.stroke();
      if (ms % every === 0) ctx.fillText(ms === 0 ? '0' : `${ms / 1000} s`, X(ms) - 6, 156);
    }
    bar(0, 10, C.field);
    // Store and forward: each repeater keys once the field station is done, plus its delay.
    ctx.strokeStyle = C.muted; ctx.setLineDash([3, 3]);
    for (const [k, y] of [[a, 36], [b, 62]]) {
      ctx.beginPath(); ctx.moveTo(X(P.KEYING_MS), y + 8); ctx.lineTo(X(k.startMs), y + 8); ctx.stroke();
    }
    ctx.setLineDash([]);
    bar(a.startMs, 36, C.repeater);
    bar(b.startMs, 62, C.repeater);
    bar(a.startMs, 98, C.repeater, 14);
    bar(b.startMs, 120, C.repeater, 14);
    // Overlap: frame on frame red, a carrier on a frame amber.
    const frame = k => [k.startMs + P.LEAD_MS, k.startMs + P.LEAD_MS + P.FRAME_MS];
    const key = k => [k.startMs, k.startMs + P.KEYING_MS];
    const inter = (p, q) => [Math.max(p[0], q[0]), Math.min(p[1], q[1])];
    for (const [p, q] of [[frame(a), key(b)], [frame(b), key(a)]]) {
      const [s, e] = inter(p, q);
      if (e > s) { ctx.fillStyle = C.warn; ctx.globalAlpha = 0.35; ctx.fillRect(X(s), 94, X(e) - X(s), 44); ctx.globalAlpha = 1; }
    }
    const [s, e] = inter(frame(a), frame(b));
    if (e > s) { ctx.fillStyle = C.bad; ctx.globalAlpha = 0.45; ctx.fillRect(X(s), 94, X(e) - X(s), 44); ctx.globalAlpha = 1; }
    // Outcome marks at the end of each base row.
    res.forEach((r, i) => {
      const k = ks[i];
      const o = PropScene.outcomeMark(r);
      ctx.fillStyle = r.status === 'clean' ? C.ok : r.status === 'flipped' ? C.bad : C.muted;
      ctx.fillText(o.mark.split(' ')[0], X(k.startMs + P.KEYING_MS) + 4, (i ? 120 : 98) + 12);
    });
    ctx.fillStyle = C.muted;
    ctx.fillText(w < 560 ? `flight ≈ ${f1(P.delayUs(15), 0)} µs: too thin to draw`
      : `flight from a repeater to the base ≈ ${f1(P.delayUs(15), 0)} µs — too thin to draw`, w < 560 ? 6 : left, 174);
  }

  function drawPhasor() {
    const g = fit(document.getElementById('rp-phasor'));
    if (!g) return;
    const { ctx, w, h } = g;
    const C = pal();
    const ps = PropScene.paths('r1', 'b1', { echoes: true });
    const P = PH();
    const refDb = ps[0].dbm;
    const sum = P.phasorSum(ps.map(p => ({ db: p.dbm - refDb, phase: p.rel })));
    const cx = w / 2, cy = h / 2;
    const maxA = Math.max(...sum.path.map(q => Math.hypot(q.re, q.im)), 1);
    const R = Math.min(w, h) / 2 - 14;
    const k = R / maxA;
    ctx.strokeStyle = C.border;
    ctx.beginPath(); ctx.arc(cx, cy, k, 0, Math.PI * 2); ctx.stroke();
    const cols = { direct: C.wave, diffracted: C.wave, ground: C.echo, building: C.echo, mountain: C.echo };
    for (let i = 1; i < sum.path.length; i++) {
      const p0 = sum.path[i - 1], p1 = sum.path[i];
      ctx.strokeStyle = cols[ps[i - 1].kind] || C.echo;
      ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.moveTo(cx + p0.re * k, cy - p0.im * k); ctx.lineTo(cx + p1.re * k, cy - p1.im * k); ctx.stroke();
    }
    ctx.strokeStyle = C.sum; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + sum.re * k, cy - sum.im * k); ctx.stroke();
    ctx.fillStyle = C.sum;
    ctx.beginPath(); ctx.arc(cx + sum.re * k, cy - sum.im * k, 4, 0, Math.PI * 2); ctx.fill();
    ctx.font = '11px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillStyle = C.muted;
    ctx.fillText('circle: the direct copy alone', 6, h - 6);
  }

  // ── The shared 2-D loop ────────────────────────────────────────────────────
  function tick(ts) {
    loop = 0;
    if (!document.getElementById('rp-page')) return;
    const time = stillPreferred() ? 0 : ts;
    if (S.field.walking) {
      const dt = last ? Math.min(80, ts - last) : 0;
      S.field.rx = Math.max(0.02, S.field.rx - dt / 9000);
      if (S.field.rx <= 0.02) S.field.walking = false;
      const out = document.getElementById('rp-field-read');
      if (out) out.innerHTML = fieldRead();
      drawTrace();
      const btn = document.getElementById('rp-walk');
      if (btn && !S.field.walking) btn.textContent = '🚶 Walk towards the wall';
    }
    last = ts;
    if (onScreen.has('rp-sum')) drawSum(time);
    if (onScreen.has('rp-field')) drawField(time);
    if (onScreen.has('rp-prof')) drawProfile(time);
    if (onScreen.has('rp-bitcv')) drawBits(time);
    if (!stillPreferred() || S.field.walking) loop = requestAnimationFrame(tick);
  }
  function kick() { if (!loop && document.getElementById('rp-page')) loop = requestAnimationFrame(tick); }

  function drawAll() {
    drawSum(0); drawField(0); drawTrace(); drawProfile(0); drawBits(1e9); drawTiming(); drawPhasor();
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────
  function unwire() {
    if (loop) cancelAnimationFrame(loop);
    loop = 0; last = 0;
    S.field.walking = false;
    if (typeof PropScene !== 'undefined') PropScene.unmount();
    if (!wired) return;
    wired.io && wired.io.disconnect();
    wired.ro && wired.ro.disconnect();
    wired.fieldCv && wired.fieldCv.removeEventListener('pointerdown', wired.down);
    wired.fieldCv && wired.fieldCv.removeEventListener('pointermove', wired.move);
    wired.fieldCv && wired.fieldCv.removeEventListener('keydown', wired.key);
    window.removeEventListener('pointerup', wired.up);
    wired = null;
  }

  function init() {
    unwire();
    registerTabTeardown('Propagation', unwire);
    const scene = document.getElementById('rp-scene');
    if (!scene) return;
    PropScene.setBaseHeight(S.mast);
    PropScene.mount({
      canvas: scene, lanes: document.getElementById('rp-lanes'), scenario: S.sc,
      layers: S.layers, delays: S.delays, onStory, onTick,
    });
    // The interference field: drag the receiver, or arrow keys.
    const fieldCv = document.getElementById('rp-field');
    let dragging = false;
    const setRx = e => {
      const r = fieldCv.getBoundingClientRect();
      S.field.rx = Math.max(0.02, Math.min(0.98, (e.clientY - r.top) / r.height));
      S.field.walking = false;
      const out = document.getElementById('rp-field-read');
      if (out) out.innerHTML = fieldRead();
      drawTrace();
      if (stillPreferred()) drawField(0);
    };
    const down = e => { dragging = true; setRx(e); };
    const move = e => { if (dragging) setRx(e); };
    const up = () => { dragging = false; };
    const key = e => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      S.field.rx = Math.max(0.02, Math.min(0.98, S.field.rx + (e.key === 'ArrowUp' ? -0.01 : 0.01)));
      const out = document.getElementById('rp-field-read');
      if (out) out.innerHTML = fieldRead();
      drawTrace();
      if (stillPreferred()) drawField(0);
    };
    if (fieldCv) {
      fieldCv.addEventListener('pointerdown', down);
      fieldCv.addEventListener('pointermove', move);
      fieldCv.addEventListener('keydown', key);
    }
    window.addEventListener('pointerup', up);
    const ids = ['rp-sum', 'rp-field', 'rp-prof', 'rp-bitcv'];
    onScreen = new Set(ids);
    const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(es => {
      for (const e of es) { if (e.isIntersecting) onScreen.add(e.target.id); else onScreen.delete(e.target.id); }
      kick();
    }) : null;
    if (io) ids.forEach(id => { const el = document.getElementById(id); if (el) io.observe(el); });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
      drawTrace(); drawTiming(); drawPhasor();
      if (stillPreferred()) drawAll();
    }) : null;
    if (ro) ['rp-trace', 'rp-timecv', 'rp-phasor', 'rp-field'].forEach(id => { const el = document.getElementById(id); if (el) ro.observe(el); });
    wired = { io, ro, fieldCv, down, move, up, key };
    requestAnimationFrame(() => { drawAll(); kick(); });
  }

  // ── The controls ───────────────────────────────────────────────────────────

  function scenario(id) {
    if (!PropScene.SCENARIOS[id]) return;
    S.sc = id;
    S.delays = null;
    PropScene.setScenario(id);
    const d = PropScene.delays();
    for (const r of ['r1', 'r2']) {
      const el = document.getElementById('rp-d-' + r);
      if (el) el.value = d[r];
      const out = document.getElementById(`rp-d-${r}-out`);
      if (out) out.textContent = `${d[r]} ms`;
    }
    const radioEl = document.getElementById('rp-sc-' + id);
    if (radioEl) radioEl.checked = true;
    const blurb = document.getElementById('rp-sc-blurb');
    if (blurb) blurb.textContent = SCENARIO_TEXT[id];
    const act = document.getElementById('rp-sc-action');
    if (act) act.innerHTML = scenarioAction();
    const from = document.getElementById('rp-drape-from');
    if (from) from.textContent = stn(PropScene.SCENARIOS[id].drapeFrom).name;
  }

  function layer(name, on) {
    if (!(name in S.layers)) return;
    S.layers[name] = !!on;
    PropScene.setLayer(name, on);
    const box = document.getElementById('rp-l-' + name);
    if (box) box.checked = !!on;
    if (name === 'drape') {
      const key = document.getElementById('rp-drape-key');
      if (key) key.hidden = !on;
    }
  }

  function delay(rid, ms) {
    const v = Math.round(Number(ms) || 0);
    PropScene.setDelay(rid, v);
    S.delays = PropScene.delays();
    const out = document.getElementById(`rp-d-${rid}-out`);
    if (out) out.textContent = `${v} ms`;
  }

  function staggerB() {
    delay('r2', 600);
    const el = document.getElementById('rp-d-r2');
    if (el) el.value = 600;
    PropScene.replay();
    if (typeof announce === 'function') announce('Hill B now waits 600 ms. Playing the story again.');
  }

  function mast(m) {
    S.mast = Math.max(2, Math.min(40, Number(m) || 15));
    PropScene.setBaseHeight(S.mast);
    const out = document.getElementById('rp-mast-out');
    if (out) out.textContent = `${f1(S.mast)} m`;
  }

  function play() { PropScene.toggle(); }
  function replay() { PropScene.replay(); }
  function seekEnd() { PropScene.seekEnd(); }
  function cam(a) { PropScene.cam(a); }

  // A setting on one of the 2-D drawings, by its path: 'sum.delta' and so on.
  function set(path, value) {
    const [grp, key] = path.split('.');
    if (!S[grp] || !(key in S[grp])) return;
    const v = typeof S[grp][key] === 'number' ? Number(value)
      : typeof S[grp][key] === 'boolean' ? !!value : String(value);
    if (typeof v === 'number' && !Number.isFinite(v)) return;
    S[grp][key] = v;
    const out = id => document.getElementById(id);
    if (grp === 'sum') {
      if (out('rp-sum-d-out')) out('rp-sum-d-out').textContent = sumOut();
      if (out('rp-sum-e-out')) out('rp-sum-e-out').textContent = `${S.sum.echo} dB`;
      if (out('rp-sum-read')) out('rp-sum-read').innerHTML = sumRead();
      drawSum(stillPreferred() ? 0 : performance.now());
    } else if (grp === 'field') {
      field = null;
      if (out('rp-f-angle-out')) out('rp-f-angle-out').textContent = `${S.field.angle}° to the wall`;
      if (out('rp-f-refl-out')) out('rp-f-refl-out').textContent = reflOut();
      if (out('rp-field-read')) out('rp-field-read').innerHTML = fieldRead();
      drawField(stillPreferred() ? 0 : performance.now());
      drawTrace();
    } else if (grp === 'prof') {
      if (out('rp-p-clear-out')) out('rp-p-clear-out').textContent = clearOut();
      if (out('rp-p-forest-out')) out('rp-p-forest-out').textContent = `${S.prof.forest} m deep`;
      if (out('rp-p-km-out')) out('rp-p-km-out').textContent = `${S.prof.km} km`;
      if (out('rp-prof-table')) out('rp-prof-table').innerHTML = profTable();
      drawProfile(stillPreferred() ? 0 : performance.now());
    } else if (grp === 'bits') {
      if (out('rp-b-rel-out')) out('rp-b-rel-out').textContent = `${sign(S.bits.rel, 0)} dB`;
      if (out('rp-b-off-out')) out('rp-b-off-out').textContent = offOut();
      if (out('rp-bit-out')) out('rp-bit-out').innerHTML = bitsOut();
      drawBits(stillPreferred() ? 1e9 : performance.now());
    } else if (grp === 'timing') {
      if (out('rp-t-a-out')) out('rp-t-a-out').textContent = `${S.timing.dA} ms`;
      if (out('rp-t-b-out')) out('rp-t-b-out').textContent = `${S.timing.dB} ms`;
      if (out('rp-t-rel-out')) out('rp-t-rel-out').textContent = `${sign(S.timing.rel, 0)} dB`;
      if (out('rp-t-out')) out('rp-t-out').innerHTML = timingOut();
      drawTiming();
    }
    kick();
  }

  function freq(v) {
    const f = Number(v);
    if (![151.5, 450, 900, 2400].includes(f)) return;
    S.prof.f = f;
    set('prof.f', f);
  }

  function walk() {
    S.field.walking = !S.field.walking;
    if (S.field.walking && S.field.rx <= 0.03) S.field.rx = 0.98;
    const btn = document.getElementById('rp-walk');
    if (btn) btn.textContent = S.field.walking ? '⏹ Stop walking' : '🚶 Walk towards the wall';
    last = 0;
    kick();
  }

  function reseed() {
    S.bits.seed = (S.bits.seed % 997) + 1;
    set('bits.seed', S.bits.seed);
  }

  // Scroll a section into view and put focus on its heading.
  function go(id) {
    const sec = document.getElementById(id);
    if (!sec) return;
    const h = sec.querySelector('h3');
    sec.scrollIntoView({ behavior: stillPreferred() ? 'auto' : 'smooth', block: 'start' });
    if (h) h.focus({ preventScroll: true });
  }

  function open(tab) {
    if (typeof switchTab === 'function') switchTab(tab);
  }

  return {
    render, init, scenario, layer, delay, staggerB, mast, play, replay, seekEnd, cam, set, freq, walk, reseed,
    go, open, state: () => JSON.parse(JSON.stringify(S)),
  };
})();
