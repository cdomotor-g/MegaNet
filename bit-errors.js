// MegaNet — bit-errors.js
//
//   BitErrors   the ⚡ Bit Errors tab, in the Knowledge base: why a station's
//               readings arrive wrong, and how to tell the causes apart. The
//               🧪 Bit Bench shows each fault in a paragraph and lets you play
//               with it; this is where each is taken in depth — the physics,
//               what it does to the bits and why, the fingerprint it leaves,
//               how to confirm it in the field and what fixes it.
//
//                 1  from a sensor to a database: where in the chain each
//                    fault lives
//                 2  reading the fingerprint: the three questions that split
//                    most cases, and a field guide from symptom to cause
//                 3  why some flips get through: ALERT Binary's guard bits,
//                    and what a CRC would have caught
//                 4–13  the faults, one section each: weak signal, impulse
//                    noise, reflections, collisions, intermodulation, crystal
//                    drift, the PLL at key-up, clock drift, tone twist, and
//                    the wiring and decoder faults
//                 14 when it is not a fault at all
//                 15 where each shows up in Flood-Net
//
// After bit-model.js (BitModel — every figure on the page is its) and
// bit-bench.js (BitBench.ink, the drawing kit, and BitBench.open, which each
// section's "Try it" button calls); across to core.js (esc,
// registerTabTeardown) and app.js (switchTab) at call time. Nothing runs at
// load: renderMain() calls render() and init().
//
// Flood-Net's own lesson, not an adaptation: no credit panel. Its drawings are
// canvases drawn at the size they are shown, still — the bench is where things
// move — and each carries its numbers in a name and in the words beside it.
//
// Exposes: render, init, open, go, im, bench, tab.

const BitErrors = (function () {
  const BM = () => BitModel;
  const K = () => BitBench.ink;
  const S = { f1: 152.0, f2: 152.5021 };
  let wired = null;

  // Each fault's section, for the bench's "in depth" buttons.
  const SECTION = {
    noise: 'be-noise', impulse: 'be-impulse', multipath: 'be-multipath', collision: 'be-collision',
    intermod: 'be-intermod', crystal: 'be-crystal', pll: 'be-pll', clock: 'be-clock', twist: 'be-twist',
    stuck: 'be-wiring', shift: 'be-wiring', invert: 'be-wiring', reverse: 'be-wiring', gray: 'be-wiring',
  };

  const num = (x, d = 0) => (Number.isFinite(x) ? Number(x).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
  const sgn = (x, d = 0) => (x > 0 ? '+' : x < 0 ? '−' : '±') + num(Math.abs(x), d);
  const pct = (x, d = 0) => `${num(x * 100, d)}%`;
  const hz = x => (Math.abs(x) >= 1000 ? `${sgn(x / 1000, 2)} kHz` : `${sgn(x)} Hz`);

  // ── Pieces every section uses ──────────────────────────────────────────────

  function head(id, n, icon, title, short) {
    return `<h3 id="${id}-h" tabindex="-1"><span aria-hidden="true">${icon}</span> ${n} · ${esc(title)}</h3>
      ${short ? `<p class="be-short">${short}</p>` : ''}`;
  }
  // The four parts of a fault's section, each under its own heading.
  function parts(id, p) {
    return `
      <div class="be-parts">
        <div><h4>What it does to the bits</h4>${p.bits}</div>
        <div><h4>Its fingerprint</h4><ul class="be-list">${p.print.map(x => `<li>${x}</li>`).join('')}</ul></div>
        <div><h4>How to confirm it</h4><ul class="be-list">${p.confirm.map(x => `<li>${x}</li>`).join('')}</ul></div>
        <div><h4>What fixes it</h4><ul class="be-list">${p.fix.map(x => `<li>${x}</li>`).join('')}</ul></div>
      </div>
      <p class="be-try button-group">${(p.bench || []).map(([fx, label]) => `<button type="button" class="btn btn-primary" onclick="BitErrors.bench('${fx}')">🧪 ${esc(label)} on the bench</button>`).join('')}
        ${(p.see || []).map(([tab, label, sec]) => `<button type="button" class="btn" onclick="BitErrors.tab('${tab}'${sec ? `, '${sec}'` : ''})">${esc(label)}</button>`).join('')}</p>`;
  }
  function figure(id, cls, label, caption) {
    return `<figure class="be-fig">
      <canvas class="be-cv ${cls}" id="${id}" data-draw="${id}" role="img" aria-label="${escAttr(label)}"></canvas>
      ${caption ? `<figcaption class="be-cap">${caption}</figcaption>` : ''}
    </figure>`;
  }
  const sec = (id, html) => `<section class="panel be-sec" id="${id}" aria-labelledby="${id}-h">${html}</section>`;

  // ── The hero ───────────────────────────────────────────────────────────────

  function factsHtml() {
    const M = BM();
    const facts = [
      ['🧮', '24 of 40', 'bits carry the reading', 'and nothing checks them: ALERT Binary has no CRC. Flip one and the frame still passes.'],
      ['⏱️', `${num(M.bitMs(), 2)} ms`, 'one bit, at 300 baud', 'An echo a few microseconds late is a thousandth of that. Reflections fade a signal; they do not shift bits.'],
      ['💎', `${num(M.hzPerPpm(), 1)} Hz`, 'one part per million', `of 151.5 MHz. Flood-Net flags a transmitter ${num(2.5, 1)} ppm out — ${num(2.5 * M.hzPerPpm())} Hz.`],
      ['⏲️', '±5%', 'a UART\'s clock budget', 'over a ten-bit word, before the stop bit is read in the wrong place. Real ones need margin inside that.'],
      ['🧲', `${PropPhysics.CAPTURE_DB} dB`, 'FM\'s capture effect', 'Ahead by about this much, the stronger of two signals is heard cleanly; closer, both suffer.'],
      ['🔀', '2f₁ − f₂', 'an intermodulation product', 'Two strong transmitters mixed in anything non-linear land a third signal here.'],
      ['🎚️', `${num(20 * Math.log10(M.SPACE_HZ / M.MARK_HZ), 1)} dB`, 'pre-emphasis twist', 'between ALERT\'s two tones, when a radio\'s data input is boosted for voice and nothing undoes it.'],
    ];
    return `<ul class="be-facts" aria-label="Numbers worth knowing">${facts.map(([i, big, what, why]) => `
      <li class="be-fact"><span class="be-fact-icon" aria-hidden="true">${i}</span>
        <span class="be-fact-big">${big}</span><span class="be-fact-what">${what}</span>
        <span class="be-fact-why">${why}</span></li>`).join('')}</ul>`;
  }

  const TOC = [
    ['be-chain', '1 · Where it goes wrong'], ['be-guide', '2 · Reading the fingerprint'], ['be-guard', '3 · Why flips get through'],
    ['be-noise', '4 · Weak signal'], ['be-impulse', '5 · Impulse noise'], ['be-multipath', '6 · Reflections'],
    ['be-collision', '7 · Collisions'], ['be-intermod', '8 · Intermodulation'], ['be-crystal', '9 · Crystal drift'],
    ['be-pll', '10 · PLL at key-up'], ['be-clock', '11 · Clock drift'], ['be-twist', '12 · Tone twist'],
    ['be-wiring', '13 · Wiring and decoders'], ['be-notfault', '14 · Not a fault'], ['be-more', '15 · In Flood-Net'],
  ];
  const tocHtml = () => `<nav class="be-toc" aria-label="On this page">${TOC.map(([id, t]) =>
    `<button type="button" class="be-toc-btn" onclick="BitErrors.go('${id}')">${t}</button>`).join('')}</nav>`;

  // ── 1 · From a sensor to a database ────────────────────────────────────────

  const STAGES = [
    { name: 'The sensor and the logger', what: 'A shaft encoder, a tipping bucket or a pressure transducer, read by the logger into a number.',
      faults: [['be-wiring', '📌 Stuck, shifted, inverted or reversed lines'], ['be-wiring', '🌀 Gray code read as binary']] },
    { name: 'The encoder', what: 'The number becomes 40 bits — address, value, check bits, start and stop — clocked out at 300 baud by the logger\'s own clock.',
      faults: [['be-clock', '⏲️ Clock drift']] },
    { name: 'The transmitter', what: 'Each bit becomes a tone, the tones swing the carrier, and a synthesiser holds the carrier on 151.5 MHz from a quartz crystal.',
      faults: [['be-pll', '🔒 PLL slow to lock at key-up'], ['be-crystal', '💎 Crystal drift'], ['be-twist', '🎚️ Tones out of balance']] },
    { name: 'The air', what: 'The signal crosses kilometres of country, weakening, bouncing and meeting everything else on the air.',
      faults: [['be-noise', '📶 Too weak over the noise'], ['be-impulse', '⚡ Bursts of noise'], ['be-multipath', '🪞 Echoes that cancel'],
        ['be-collision', '💥 Another station at once'], ['be-intermod', '🔀 Intermodulation']] },
    { name: 'The receiver', what: 'A repeater or base filters out one channel, recovers the tones and decides each bit — 1 or 0.',
      faults: [['be-intermod', '🔀 Its own front end overloaded'], ['be-twist', '🎚️ Tones it hears unequally'], ['be-crystal', '💎 Its own crystal drifting']] },
    { name: 'The decoder', what: 'The bits are checked — start, stop, the eight check bits — and an address and value read out, or the frame thrown away.',
      faults: [['be-wiring', '🔁 Bit order, polarity or field set wrong'], ['be-guard', '🧮 No CRC: 24 bits unguarded']] },
  ];

  function chainHtml() {
    return sec('be-chain', `
      ${head('be-chain', 1, '🧭', 'From a sensor to a database', 'Every fault lives somewhere along the way. Knowing where is half of finding it.')}
      <p>A reading leaves a gauge as a number and arrives at a database as a number. Between the two it is bits, then tones, then a radio
        signal crossing country, then tones and bits again — and each step can change it. The faults that change it most are listed under
        the step they live in; press one to read about it.</p>
      <ol class="be-chain">${STAGES.map((st, i) => `
        <li class="be-stage"><span class="be-stage-n" aria-hidden="true">${i + 1}</span>
          <h4>${esc(st.name)}</h4><p>${esc(st.what)}</p>
          <ul class="be-stage-faults">${st.faults.map(([id, t]) => `<li><button type="button" class="be-chip" onclick="BitErrors.go('${id}')">${esc(t)}</button></li>`).join('')}</ul>
        </li>`).join('')}
      </ol>
      <p class="be-key"><strong>A symptom is not a cause.</strong> A <em>flipped bit</em>, a <em>shifted bit</em>, a <em>stuck bit</em>, a
        frame <em>thrown out</em> and a reading on a <em>ghost address</em> are what you see; noise, a drifting crystal or a wire on the wrong
        pin are what did it. Several causes make the same symptom, so one bad reading proves little — but many bad readings, read together,
        leave a pattern only some causes can make.</p>`);
  }

  // ── 2 · Reading the fingerprint ────────────────────────────────────────────

  const GUIDE = [
    ['Flips scattered over every bit, both ways, worse when the signal is low', 'How much fade margin does the path have?', 'be-noise', 'Weak signal'],
    ['Runs of two to four neighbouring bits, at random places', 'Lightning about? A fence, a pump, a solar regulator near the receiver?', 'be-impulse', 'Impulse noise'],
    ['Whole frames lost now and then, others perfect, from one path', 'Anything moving near either antenna? Does the level jump if the antenna moves a metre?', 'be-multipath', 'Reflections'],
    ['A ghost one or two bits from a real station, a moment after it', 'Did two transmitters key up together? Two repeaters with the same delay?', 'be-collision', 'Collisions'],
    ['Many stations at one receiver, on someone else\'s schedule', 'Strong transmitters near that receiver? Does an attenuator in its feeder cut the trouble by more than its own loss?', 'be-intermod', 'Intermodulation'],
    ['One station, worst at one end of the day', 'Is its carrier offset moving with the temperature?', 'be-crystal', 'Crystal drift'],
    ['The first bits sent — ghosts within the same block of 64 addresses', 'How long is its key-up delay? How is the battery when it transmits?', 'be-pll', 'PLL at key-up'],
    ['The ends of words; frames thrown out more than misread', 'Is the logger\'s bit clock right? Does it change with temperature?', 'be-clock', 'Clock drift'],
    ['Flips nearly all one way — readings that only read low, or only high', 'Are the two tones arriving at the same level?', 'be-twist', 'Tone twist'],
    ['One bit, one way, every time — jumps of exactly 2ⁿ', 'A wire, an input, an encoder track?', 'be-wiring', 'Stuck bit'],
    ['Every reading changed by the same rule — doubled, mirrored, scrambled', 'Wiring offset, polarity, bit order or Gray code?', 'be-wiring', 'Wiring and decoder faults'],
  ];

  function guideHtml() {
    const rows = GUIDE.map(([see, ask, id, name]) => `<tr><td>${esc(see)}</td><td>${esc(ask)}</td>
      <td><button type="button" class="link-btn" onclick="BitErrors.go('${id}')">${esc(name)}</button></td></tr>`).join('');
    return sec('be-guide', `
      ${head('be-guide', 2, '🔍', 'Reading the fingerprint', 'One bad reading proves little. A pattern in many is evidence.')}
      <p>Three questions split most cases before a single bit is looked at:</p>
      <ol class="be-q">
        <li><strong>One station, or many?</strong> A fault in a transmitter, a logger or its wiring corrupts one station's readings wherever they
          are heard. A fault at a receiver — noise there, an intermodulation product, its own front end — corrupts every station it hears.</li>
        <li><strong>One receiver, or every receiver?</strong> If a second base heard the same reading cleanly, the trouble was on the path to the
          first, or at the first. If every base heard it wrong, it left the station wrong.</li>
        <li><strong>Always, or at certain times?</strong> Hours that follow the temperature point to a crystal or a clock; hours that follow
          someone else's working day, to intermodulation; a storm, to collisions — every event-reporting station talking at once — or to
          lightning.</li>
      </ol>
      <p>Then the bits themselves: <strong>where</strong> in the frame they go wrong, <strong>which way</strong> they go (1 → 0, or 0 → 1),
        and whether the damaged frames are <strong>thrown out</strong> by the receiver or <strong>get through</strong> as ghosts and wrong
        values. The 🧪 Bit Bench reads exactly this from a batch, and from readings you paste in.</p>
      <div class="table-wrap"><table class="be-table">
        <caption>A field guide: what you see, what to ask, and where it points</caption>
        <thead><tr><th scope="col">What you see</th><th scope="col">What to ask</th><th scope="col">Points to</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
      <h4>From the network's own readings</h4>
      <p>Station Health's rain arithmetic has met all of these in Flood-Net's own data, and sets each aside before it adds up the rain:</p>
      <ul class="be-list">
        <li><strong>265 → 1,801 tips at Torridon</strong> — 1,536 tips, 307 mm of rain in one report, and the two numbers exactly two bits apart
          (bits 9 and 10). A corrupted frame, not a storm.</li>
        <li><strong>525 at Harding St</strong>, where 1,050 was due: 1,050 with its last bit lost and the rest slipped one place right — a bit slip.</li>
        <li><strong>1,220, 16, 14</strong> on Beachmere (St Smith Rd)'s rain address: frames decoded onto it that were never the gauge at all.</li>
      </ul>`);
  }

  // ── 3 · Why some flips get through ─────────────────────────────────────────

  function guardHtml() {
    const M = BM();
    const pass = [1, 2, 3].map(k => M.passShare(k));
    const crc = [1, 2, 3, 4].map(k => M.crcCatches(k));
    const L = M.layout();
    const cells = [0, 1, 2, 3].map(w => `<tr><th scope="row">Word ${w + 1}</th>${Array.from({ length: 10 }, (_, k) => {
      const c = L[w * 10 + k];
      const guarded = c.kind === 'start' || c.kind === 'stop' || c.kind === 'K';
      const lab = c.kind === 'start' ? 'S' : c.kind === 'stop' ? 'P' : c.kind === 'K' ? 'K' : `${c.kind}${c.i}`;
      return `<td class="be-g ${guarded ? 'be-g--caught' : 'be-g--pass'}" title="${guarded ? 'a flip here is caught' : 'a flip here gets through'}">${lab}</td>`;
    }).join('')}</tr>`).join('');
    return sec('be-guard', `
      ${head('be-guard', 3, '🧮', 'Why some flips get through', 'ALERT Binary guards 16 of its 40 bits and leaves the 24 that carry the reading to chance.')}
      <p>A frame's guards are its framing — a start bit that must be 0 and a stop bit that must be 1 on every word — and eight check bits with
        fixed values, two at the end of each word. A flip in any of those sixteen and the receiver throws the frame away. The other 24 carry
        the address and the value, and <strong>nothing checks them</strong>: flip one and the frame still passes, on another station's
        address or with another value.</p>
      <div class="table-wrap"><table class="be-guards">
        <caption>The 40 bits: guarded (a flip is caught) and unguarded (a flip gets through)</caption>
        <colgroup><col style="width:4.6rem"><col span="10"></colgroup>
        <thead><tr><th scope="col">Word</th><th scope="col">Start</th>${[0, 1, 2, 3, 4, 5, 6, 7].map(b => `<th scope="col">Bit ${b}</th>`).join('')}<th scope="col">Stop</th></tr></thead>
        <tbody>${cells}</tbody></table></div>
      <ul class="be-key-list" aria-label="What the shading means">
        <li><span class="be-sw be-sw--caught" aria-hidden="true"></span> guarded — a flip is caught</li>
        <li><span class="be-sw be-sw--pass" aria-hidden="true"></span> unguarded — a flip gets through</li>
      </ul>
      <p>So when bits flip at random, <strong>${pct(pass[0])}</strong> of one-flip frames get through, <strong>${pct(pass[1])}</strong> of
        two-flip frames and <strong>${pct(pass[2])}</strong> of three-flip ones: the more bits a fault takes, the likelier the frame is to be
        caught. That is why a fault that wipes a run of bits mostly makes a station <em>go quiet</em>, while one that takes a single bit now and
        then makes it <em>go wrong</em> — and why it matters <em>where</em> a fault strikes: the check bits sit at the ends of words, exactly
        where a timing error strikes first.</p>
      <p>A CRC changes all of this. If those 24 bits carried a six-bit CRC on x⁶ + x⁴ + x³ + 1, as Enhanced iFLOWS frames do, every pattern of
        one, two or three flipped bits would be caught (${crc.slice(0, 3).map(x => pct(x)).join(', ')}), and ${pct(crc[3], 1)} of four. The
        live 151.5 MHz network sends ALERT Binary, so the decoders lean on the next best things: two copies by two paths, and rules that set
        aside a reading one or two bits from a stronger one heard at the same moment.</p>`);
  }

  // ── 4 · Weak signal ────────────────────────────────────────────────────────

  function noiseHtml() {
    const M = BM();
    const at = d => M.ber(d);
    return sec('be-noise', `
      ${head('be-noise', 4, '📶', 'Weak signal and noise', 'Below a few decibels of margin, bits go at random — and the fall-off is a cliff.')}
      <p>Every receiver hears noise — the hiss of its own electronics and of the country around it. A receiver decides each bit by which of the
        two tones is stronger, and while the signal stands well above the noise the answer is never in doubt. As the signal sinks towards the
        noise, the noise now and then makes the wrong tone look stronger, and a bit is misread. FM makes the fall-off steep: above its
        threshold it holds the noise down, and below it lets it all through.</p>
      ${figure('be-cv-ber', 'be-cv--wide', `How often a bit is misread against the signal over the noise: ${pct(at(6), 1)} at 6 dB, ${pct(at(9), 2)} at 9 dB, ${pct(at(12), 4)} at 12 dB — a cliff.`,
        `A bit misread ${pct(at(6), 1)} of the time at 6 dB over the noise, ${pct(at(9), 2)} at 9 dB and ${pct(at(12), 4)} at 12 dB — and a whole frame, 40 bits,
        through untouched ${pct(Math.pow(1 - at(6), 40))}, ${pct(Math.pow(1 - at(9), 40))} and ${pct(Math.pow(1 - at(12), 40), 1)} of the time. The curve is non-coherent FSK's,
        ½·e^(−γ/2): a textbook model, not any one radio's figures.`)}
      ${parts('noise', {
        bits: `<p>Single bits, anywhere in the frame, either way — a frame holds a few more 1s than 0s, so even noise leans slightly towards
          1 → 0. Most damaged frames have one flip, and ${pct(M.passShare(1))} of those get through.</p>`,
        print: ['Flips spread evenly across all 40 bits.', 'Rare and scattered, not in runs.', 'One path: the same reading heard cleanly by a receiver with a better path.',
          'Worse as the margin shrinks — a battery low enough to cut the transmitter\'s power, trees in leaf, a mast leaning, a feeder taking water.'],
        confirm: ['Measure the path\'s fade margin: an attenuator in the station\'s feeder, stepped up until the receiver stops decoding — the 🎓 Radio Propagation lesson\'s fade-margin test.',
          'Compare with the link budget for the path and with Network Review\'s margins for the network.', 'Check the transmitter\'s output and the feeder and connectors for loss.'],
        fix: ['More margin: a higher or better antenna, a shorter or better feeder, sound connectors.', 'A different repeater, or a new one, for a path that cannot be helped.',
          'A battery and charging that hold the transmitter\'s power up.'],
        bench: [['noise', 'Weak signal']],
        see: [['propagation', 'The fade-margin test', 'rp-fade'], ['review', 'Network Review']],
      })}`);
  }

  // ── 5 · Impulse noise ──────────────────────────────────────────────────────

  function impulseHtml() {
    const M = BM();
    return sec('be-impulse', `
      ${head('be-impulse', 5, '⚡', 'Impulse noise', 'Short, loud bursts that wipe a few bits and leave the rest alone.')}
      <p>Some noise comes in bursts: lightning, a car's ignition, an electric fence's pulse — and the arcing of a cracked fence insulator, which
        radiates every time the pulse fires — a pump motor starting, a switching power supply, a solar charge controller chopping its current
        thousands of times a second. Each burst is far louder than the signal for a few milliseconds, and whatever bits it lands on are a coin
        toss. At 300 baud a burst of 8 ms covers three or four bits.</p>
      ${figure('be-cv-imp', 'be-cv--short', 'A burst of noise 8 ms long landing on four bits of a frame: those four are a coin toss, the bits either side clean.',
        'A burst covers whatever bits it overlaps. A frame that meets one usually loses two or three neighbouring bits, so most such frames are caught at a check or framing bit.')}
      ${parts('impulse', {
        bits: `<p>Runs of neighbouring bits, at random places in the frame. With two or three bits lost at once, most damaged frames are caught —
          ${pct(M.passShare(2))} of two-flip frames get through, ${pct(M.passShare(3))} of three — so impulse noise mostly makes stations drop
          out, and now and then sends a wrong value.</p>`,
        print: ['Flips in runs of two to four neighbouring bits.', 'Even across the frame — a burst can land anywhere.',
          '<strong>At the receiver, not the station:</strong> noise matters where a signal is heard, so a noise source beside a repeater corrupts every station that repeater hears, and one beside a field station corrupts nothing.',
          'Its own timetable: storms for lightning; daylight for a solar regulator; a fence pulses about once a second; machinery runs in working hours.'],
        confirm: ['Listen at the receiver: an SDR on the Serial Monitor, or a scanner, tuned to the channel — a buzz, a tick a second, crackle in the wind.',
          'Walk the site with a portable receiver: the noise gets louder towards its source.', 'Line the bad readings up against the weather and the time of day.'],
        fix: ['Fix the source: a fence insulator, a regulator\'s filtering, ferrites on its leads, a better-bonded earth.', 'Move the receiving antenna away from it, or above it.',
          'A noise blanker, where the receiver has one.'],
        bench: [['impulse', 'Impulse noise']],
        see: [['serial', 'Serial Monitor — listen off the air']],
      })}`);
  }

  // ── 6 · Reflections ────────────────────────────────────────────────────────

  function multipathHtml() {
    const lam = PropPhysics.wavelengthM();
    return sec('be-multipath', `
      ${head('be-multipath', 6, '🪞', 'Reflections and fading', 'At 300 baud an echo never shifts a bit. It changes how strong the signal is.')}
      <p>A signal reaches a receiver by more than one path: straight, and bounced off a hill, a shed, a silo, the ground or the water. Each echo
        has further to go, so it arrives later — but only by microseconds. A bit lasts ${num(BM().bitMs(), 2)} ms, so an echo 9 µs late is
        three-thousandths of a bit: it cannot smear one bit into the next, which is what reflections do to fast data. What it does instead is
        <strong>add to the direct wave or cancel it</strong>, depending on where in its cycle it arrives. A wavelength at 151.5 MHz is
        ${num(lam, 2)} m, so a change of ${num(lam / 2, 2)} m in a path's length turns adding into cancelling.</p>
      ${figure('be-cv-fade', 'be-cv--wide', 'How strong a direct wave and one echo are together, as the echo\'s phase goes round: in step they add, opposed they cancel — completely, for an echo as strong as the direct wave.',
        'The direct wave and an echo, added, as the echo\'s phase goes round. An echo half as strong swings the total from +3.5 dB to −6 dB; one nearly as strong, from +5.6 dB to a deep null.')}
      ${parts('multipath', {
        bits: `<p>A still path sits at one point of the pattern for good: in a null, it is simply weak, and fails as a weak signal does. When
          anything moves — a vehicle, a truck parked by the hut, trees in the wind, a gate, the water — the pattern sweeps past and the signal
          <em>fades</em> in and out, a few times a second. A fade wipes a run of bits, or a whole frame; between fades nothing goes wrong.</p>`,
        print: ['Runs of bits, and whole frames lost, among frames that are perfect.', 'One path: another receiver, or the same one with its antenna moved a metre, sees something different.',
          'With what moves: wind, traffic, machinery, the river.', 'Not shifted bits — fading strength.'],
        confirm: ['Watch the received level over time: a fading path swings by tens of decibels while a weak one stays steady.',
          'Move the antenna half a metre, or up a metre, and see whether the level jumps.', 'A drive survey on the Reception Map shows where along a road the copies arrive damaged.'],
        fix: ['Raise or move the antenna out of the null — often a metre is enough.', 'A directional antenna (a Yagi) aimed down the direct path, turned away from the reflector.',
          'Two antennas some wavelengths apart (space diversity), where the receiver can use them.', 'More margin, so the fades stay above the noise.'],
        bench: [['multipath', 'Reflections']],
        see: [['propagation', 'Waves adding up or cancelling', 'rp-waves'], ['reception', 'Reception Map']],
      })}`);
  }

  // ── 7 · Collisions ─────────────────────────────────────────────────────────

  function collisionHtml() {
    const cap = PropPhysics.CAPTURE_DB;
    return sec('be-collision', `
      ${head('be-collision', 7, '💥', 'Collisions and capture', 'Two transmitters at once: the stronger wins if it is far enough ahead.')}
      <p>ALERT is ALOHA: a station transmits when it has something to say, without listening first, and repeaters store each reading and send it
        on after a delay of their own. Most of the time the channel is clear. Sometimes two transmissions overlap — and then FM's
        <strong>capture effect</strong> decides: a signal about ${cap} dB stronger than the other is heard cleanly, as if the weaker were not
        there; closer than that, both are spoilt, bits flipping wherever the two are sending different bits; and a receiver captured by a much
        stronger signal hears that one and loses ours.</p>
      ${figure('be-cv-cap', 'be-cv--wide', `What happens to our frame as its strength over the other goes from −12 to +12 dB: lost below −${cap}, bits flipping between, clean above +${cap}.`,
        `Our signal against the other's. ${cap} dB ahead, capture keeps ours clean; within ${cap} dB, bits flip — most often when the two are equal, a quarter as often where both send the same bit; ${cap} dB behind, the receiver hears only the other. A model of the shape real receivers follow, not any one radio's figures.`)}
      ${parts('collision', {
        bits: `<p>From the moment the other keys up to the moment it stops, bits flip where the two frames differ. A flip in one of the 13
          address bits and the frame passes as a <strong>ghost</strong>: a reading filed under another station's address, usually one or two
          bits away. Two repeaters set to the same delay make the worst case: their copies of the same reading land bit on bit at a base that
          hears both at nearly the same strength.</p>`,
        print: ['Ghosts one or two bits from a real station\'s address, arriving a moment after its real reading.',
          'Flips from a definite point in the frame onwards, where another transmission began.', 'With the traffic: a storm sets every event-reporting station talking at once — so collisions rise exactly when the readings matter most.',
          'At the receivers that hear both transmitters about equally.'],
        confirm: ['Bit-Flip Sources puts each corrupted copy down to the transmitter whose carrier it came on.', 'Station Health\'s Airtime panel shows who lands on top of whom at each receiver, and when.',
          'The Bit Flipper lists the stations a ghost address could have come from.'],
        fix: ['Give each repeater a delay of its own, so their copies never overlap.', 'Spread stations\' timed reports so they do not fall together.',
          'Fewer, larger event thresholds where a sensor chatters.', 'ALERT2 shares the channel by time slot (TDMA) instead of by chance.'],
        bench: [['collision', 'A collision']],
        see: [['flipsources', 'Bit-Flip Sources'], ['health', 'Station Health'], ['propagation', 'Collisions, in Radio Propagation', 'rp-bits']],
      })}`);
  }

  // ── 8 · Intermodulation ────────────────────────────────────────────────────

  function imReadout() {
    const M = BM();
    const prods = M.imProducts(S.f1, S.f2);
    const rows = prods.map(x => {
      const inside = Math.abs(x.offsetHz) <= M.IF_HALF_HZ;
      return `<tr><th scope="row">${x.key === '2f1-f2' ? '2f₁ − f₂' : '2f₂ − f₁'}</th><td>${num(x.mhz, 4)} MHz</td><td>${hz(x.offsetHz)}</td>
        <td class="${inside ? 'txt-bad' : 'txt-ok'}">${inside ? 'inside the filter — it gets in' : 'outside — no harm here'}</td></tr>`;
    }).join('');
    return `<div class="table-wrap"><table class="be-table be-table--im"><caption>The third-order products of ${num(S.f1, 4)} and ${num(S.f2, 4)} MHz, against our channel at 151.5 MHz</caption>
      <thead><tr><th scope="col">Product</th><th scope="col">Lands at</th><th scope="col">From our channel</th><th scope="col">With a ±${num(M.IF_HALF_HZ / 1000)} kHz filter</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  function intermodHtml() {
    return sec('be-intermod', `
      ${head('be-intermod', 8, '🔀', 'Intermodulation', 'Two strong signals, mixed in something non-linear, make a third — sometimes on our channel.')}
      <p>Anything that does not pass a signal in exact proportion mixes the signals going through it. Two strong transmitters near a receiver — a
        pager, a phone tower, a broadcaster, another radio network on the same mast — mixed in that receiver's overloaded front end, or in a
        corroded joint, a loose connector or a rusty bolt on the tower (the "rusty bolt effect"), produce new signals at sums and differences
        of their frequencies. The ones that matter are the <strong>third-order products</strong>, at <strong>2f₁ − f₂</strong> and
        <strong>2f₂ − f₁</strong>, because they land close to the two that made them. One that lands in our channel is interference whenever
        both transmitters are on the air — and a third-order product grows <strong>3 dB for every 1 dB</strong> the two signals grow, so a small
        change in them makes a big change in it.</p>
      <div class="be-im">
        <div class="be-im-in control-row">
          <label for="be-f1">Transmitter 1 (MHz) <input type="number" id="be-f1" step="0.0001" min="148" max="174" value="${S.f1}" oninput="BitErrors.im('f1', this.value)"></label>
          <label for="be-f2">Transmitter 2 (MHz) <input type="number" id="be-f2" step="0.0001" min="148" max="174" value="${S.f2}" oninput="BitErrors.im('f2', this.value)"></label>
        </div>
        <div id="be-im-out">${imReadout()}</div>
        ${figure('be-cv-imd', 'be-cv--wide', 'The two transmitters, their third-order products and our channel, on one frequency scale.', 'Type any two frequencies: the products move with them. The two here put 2f₁ − f₂ 2.1 kHz below our channel — inside the receiver\'s filter.')}
      </div>
      ${parts('intermod', {
        bits: `<p>While both transmitters are on, the product sits in our channel like another station's carrier: within ${PropPhysics.CAPTURE_DB} dB
          of our signal, bits flip all through the frame; stronger than ours, and the receiver hears nothing of ours at all. When either
          transmitter stops, the product stops. So frames are wrecked whole, or untouched.</p>`,
        print: ['Whole frames wrecked, the rest perfect.', '<strong>Every station that receiver hears</strong>, strong or weak, at the same moments.',
          'On someone else\'s schedule — business hours, a paging burst on the hour — not the stations\'.', 'In a corroded joint, with the weather: wind shaking it, heat expanding it, rain.'],
        confirm: ['List the transmitters near the receiver — RF Environment does this from the ACMA register, intermodulation candidates included — and work out their products here.',
          '<strong>The attenuator test:</strong> put 10 dB of attenuation in the receiver\'s feeder. A real signal on the channel drops 10 dB; a product made in the receiver\'s own front end drops about 30 dB, because it grows three times as fast. A product made before the attenuator — in a joint on the mast — drops 10 dB like any real signal, so the test also tells the two apart.',
          'An SDR at the site: does the interference come and go with the two transmitters?'],
        fix: ['A band-pass or cavity filter in front of the receiver, to keep the strong signals out of its front end.', 'Clean, tight, corrosion-free joints and connectors on the mast; no rusty hardware near the antennas.',
          'Move the antenna, or the receiver, away from the strong transmitters; coordinate frequencies with their owners.'],
        bench: [['intermod', 'Intermodulation']],
        see: [['rf', 'RF Environment'], ['workbench', 'Interference Workbench']],
      })}`);
  }

  // ── 9 · Crystal drift ──────────────────────────────────────────────────────

  function crystalHtml() {
    const M = BM();
    const edge = M.IF_HALF_HZ - M.DEV_HZ;
    return sec('be-crystal', `
      ${head('be-crystal', 9, '💎', 'Crystal drift', 'A transmitter\'s frequency moves with age and temperature; past a point, its signal falls out of the receiver.')}
      <p>A transmitter holds its frequency against a quartz crystal, and a crystal is not perfect: it starts a few parts per million out, it
        ages — a few ppm in its first year, less after — and it changes with temperature. A plain crystal's error with temperature follows an
        S-shaped curve, a few ppm across a good one's working range and many more across a poor one's; a temperature-compensated oscillator
        (a TCXO) holds it within about ±2.5 ppm. On this channel <strong>one ppm is ${num(M.hzPerPpm(), 1)} Hz</strong>.</p>
      ${figure('be-cv-xtal', 'be-cv--wide', `A crystal's frequency error against temperature: a good cut within a few ppm, a poor one far more, a TCXO within ±2.5 ppm; the swing reaches the receiver's filter ${num(edge / M.hzPerPpm(), 1)} ppm out.`,
        `A good crystal, a poor one and a TCXO across a year's temperatures. Flood-Net's off-channel line is ${num(2.5, 1)} ppm (${num(2.5 * M.hzPerPpm())} Hz) — a warning, far inside the
        ${num(edge / M.hzPerPpm(), 1)} ppm (${num(edge)} Hz) where a 12.5 kHz receiver's filter starts to clip the signal. Illustrative curves, not any one part's datasheet.`)}
      ${parts('crystal', {
        bits: `<p>The tones swing the carrier about ${num(M.DEV_HZ / 1000)} kHz each way, and a 12.5 kHz receiver's filter passes about
          ±${num(M.IF_HALF_HZ / 1000)} kHz. An offset costs nothing until the swing reaches the filter's edge, ${num(edge)} Hz out; past it, the
          peaks of the swing are clipped, the tones distort and the signal sinks into the noise within a few hundred hertz. The bits go at
          random, as for a weak signal — the difference is in <em>when</em>, and <em>who</em>.</p>`,
        print: ['One transmitter, wherever it is heard: every receiver sees its readings go wrong together.', 'With the temperature: hot afternoons in a sun-baked box, or cold mornings — and with the seasons.',
          'Its carrier offset, which Flood-Net\'s base stations measure on every burst, moving as it goes wrong.', 'Random bits, evenly spread — the same marks as a weak signal.'],
        confirm: ['Station Health\'s Transmitter frequency panel: the station\'s offset from the rest of the fleet, day by day, its drift and off-channel findings.',
          'Line the bad readings up against the time of day and the temperature at the site.', 'A frequency counter or service monitor on the transmitter, warm and cold.'],
        fix: ['Re-net the transmitter onto the channel.', 'A radio with a TCXO, where the old one\'s crystal cannot be held.', 'Shade and ventilate an enclosure that cooks in the sun.'],
        bench: [['crystal', 'Crystal drift']],
        see: [['health', 'Station Health'], ['flipsources', 'Bit-Flip Sources']],
      })}
      <p class="be-aside">A receiver has a crystal too. One that drifts shifts every station it hears by the same amount — so Flood-Net takes each
        receiver's own error out, day by day, and measures every transmitter against the median of the fleet that receiver hears.</p>`);
  }

  // ── 10 · PLL at key-up ─────────────────────────────────────────────────────

  function pllRows() {
    const M = BM();
    const T = M.bitMs();
    return [[300, 30], [100, 30], [50, 30], [25, 30], [25, 60]].map(([lead, tau]) => {
      const p = { lead, tau, kick: 10, ring: false };
      let lost = 0;
      for (let j = 0; j < 40; j++) {
        const pen = M.edgePenaltyDb(M.pllHz(lead + (j + 0.5) * T, p), false);
        if (!Number.isFinite(pen) || M.ber(16 - pen) > 0.01) lost++;
      }
      return `<tr><td>${num(lead)} ms</td><td>${num(tau)} ms</td><td>${lost ? `${lost} — ${lost >= 7 ? 'word 1 and more' : 'the start of word 1'}` : 'none'}</td></tr>`;
    }).join('');
  }

  function pllHtml() {
    return sec('be-pll', `
      ${head('be-pll', 10, '🔒', 'The PLL at key-up', 'A synthesiser needs a moment to settle; data sent before it has goes out off frequency.')}
      <p>A synthesised transmitter makes its frequency with a <strong>phase-locked loop</strong>: an oscillator steered, many times a second,
        until it matches a multiple of the crystal's. Each time the transmitter keys up, the loop has to pull the oscillator onto frequency, and
        that takes time — milliseconds in a good one, tens in a slow one, longer still when the battery sags under the sudden load of
        transmitting and the oscillator runs short of the voltage it tunes with. Loggers and ALERT transmitters send a lead-in for exactly this
        reason, and the receivers settle on it too. If the data starts before the loop has settled, the first bits go out off frequency.</p>
      ${figure('be-cv-pll', 'be-cv--wide', 'The transmitter\'s frequency error after key-up, settling, with the frame starting 300, 50 and 25 ms in: the later the frame, the cleaner its first bits.',
        'The loop settling from 10 kHz off, by e every 30 ms. A frame starting 300 ms in goes out clean; one starting 25 ms in sends its first bits while the swing is still past the filter\'s edge.')}
      <div class="table-wrap"><table class="be-table be-table--pll"><caption>Bits sent before the loop has settled (a 1-in-100 chance of misreading or worse), from 10 kHz off at key-up — a model</caption>
        <thead><tr><th scope="col">Key-up to the first bit</th><th scope="col">The loop settles by e every</th><th scope="col">Bits at risk</th></tr></thead>
        <tbody>${pllRows()}</tbody></table></div>
      ${parts('pll', {
        bits: `<p>The first bits sent: word 1's start bit, address bits 0–5 and word 1's check bits. A frame whose start bit or check bits were hit
          is thrown out; one where only address bits 0–5 changed passes — as a <strong>ghost within the same block of 64 addresses</strong>,
          since bits 6–12 went out after the loop had settled.</p>`,
        print: ['Flips in the first word sent, and almost nowhere else.', 'Ghosts that differ from the true address only in its lowest six bits.',
          'Worse when the battery is low — at night, after cloudy days — and in the cold.', 'One station, at every receiver.'],
        confirm: ['Lengthen the key-up delay (the lead-in, the TX delay — loggers name it differently) and see whether it stops.',
          'Measure the battery under transmit load, not at rest.', 'ALERT\'s check message in the BCC format carries a VCO error flag — the transmitter reporting a loop that would not lock. ALERT Packets decodes it.'],
        fix: ['A longer key-up delay.', 'A battery and charging system that hold their voltage when the transmitter keys.', 'Service or replace a radio whose loop has become slow.'],
        bench: [['pll', 'The PLL at key-up']],
        see: [['packets', 'ALERT Packets'], ['bitflipper', 'Bit Flipper']],
      })}`);
  }

  // ── 11 · Clock drift ───────────────────────────────────────────────────────

  function clockHtml() {
    return sec('be-clock', `
      ${head('be-clock', 11, '⏲️', 'Clock drift and bit slips', 'Two clocks, the sender\'s and the receiver\'s, counting bits in step — until they are not.')}
      <p>Each word goes out as a start bit, eight data bits and a stop bit, timed by the logger's own clock. The receiver has no copy of that
        clock: it waits for the falling edge of a start bit, then reads each bit by counting its own — the first data bit 1½ bits after the edge,
        the next 2½, and so on to the stop bit at 9½. If the two clocks differ by a fraction <em>e</em>, every bit is read <em>e</em> of a bit further
        from its middle than the one before. By the stop bit the reading point has moved 9½ × <em>e</em> bits, and once that passes half a bit
        it reads the neighbour instead — so a UART can stand at most about <strong>±5%</strong>, and less once the edge's own uncertainty is
        counted. Every new start bit sets the count back to nought.</p>
      ${figure('be-cv-uart', 'be-cv--wide', 'One word read by a UART with the sender\'s clock exact, 4% fast and 6% fast: at 6% the stop bit is read in the next word\'s start bit.',
        'Where a UART reads the ten bits of a word, with the sender\'s clock exact, 4% fast and 6% fast. The error builds up across the word; at 6% the stop bit is read in the next start bit, and the word is thrown out.')}
      ${parts('clock', {
        bits: `<p>The last bits of each word go first — and in ALERT Binary those are each word's two check bits and its stop bit. So a sender
          whose clock is off mostly has its frames <strong>thrown out</strong> rather than misread: the station goes quiet, intermittently at
          first, as the error grows past the receiver's tolerance. Once a stop bit is misread the receiver can lose its place and read the rest
          of the frame from the wrong edge. A decoder that times the whole frame from its first edge, rather than every word, is far less
          tolerant: the error builds up over all 40 bits, and the last word goes first. Software decoders steer their timing to follow a
          steady error, but can still slip a bit — Flood-Net's own off-air decoder sets aside a reading one or two bits from a stronger one
          heard in the same burst for exactly that reason.</p>`,
        print: ['Damage that starts at the ends of words.', 'Frames thrown out at the stop bit far more often than wrong readings — dropouts.',
          'One station, at every receiver.', 'With the temperature, where the logger\'s clock is a cheap oscillator.'],
        confirm: ['Measure the bit rate: an SDR capture of the station — samples per bit — or a scope on the logger\'s data line.',
          'Line the dropouts up against the temperature at the site.', 'Swap the logger, or its clock setting, and watch.'],
        fix: ['Correct the logger\'s baud setting or clock divisor.', 'A logger whose bit clock comes from a crystal rather than a resistor and capacitor.'],
        bench: [['clock', 'Clock drift']],
        see: [['packets', 'ALERT Packets'], ['serial', 'Serial Monitor']],
      })}`);
  }

  // ── 12 · Tone twist ────────────────────────────────────────────────────────

  function twistRows() {
    const M = BM();
    const pre = 20 * Math.log10(M.SPACE_HZ / M.MARK_HZ);
    return [[0, 'Matched: flat in, flat out (or boosted and undone)'], [pre, 'Pre-emphasised, and nothing undoes it'], [-pre, 'De-emphasised at the receiver, never boosted']].map(([tw, what]) => {
      const g = Math.pow(10, 10 / 10), k = Math.pow(10, tw / 10);
      const em = M.ber(10 * Math.log10(g * 2 / (1 + k))), es = M.ber(10 * Math.log10(g * 2 * k / (1 + k)));
      return `<tr><td>${esc(what)}</td><td>${sgn(tw, 1)} dB</td><td>${pct(em, 2)}</td><td>${pct(es, 2)}</td><td>${tw === 0 ? 'both ways' : tw > 0 ? 'nearly all 1 → 0' : 'nearly all 0 → 1'}</td></tr>`;
    }).join('');
  }

  function twistHtml() {
    const M = BM();
    return sec('be-twist', `
      ${head('be-twist', 12, '🎚️', 'Tone twist', 'Two tones that should arrive equal, and do not: the weaker one\'s bits go first, all one way.')}
      <p>ALERT's two tones, ${num(M.MARK_HZ, 1)} Hz for a 1 and ${num(M.SPACE_HZ, 1)} Hz for a 0, should reach the detector equally strong. FM
        radios boost higher audio frequencies on the way out — <strong>pre-emphasis</strong>, 6 dB an octave, for voice — and cut them again on
        the way in. A data path that is flat at one end and emphasised at the other leaves the boost, or the cut, in place: the space tone
        arrives ${num(20 * Math.log10(M.SPACE_HZ / M.MARK_HZ), 1)} dB stronger, or weaker, than the mark. A modem's tones set unequal, or a
        transmitter swung too hard so one tone clips, do the same. The difference is called <strong>twist</strong>.</p>
      ${figure('be-cv-twist', 'be-cv--wide', 'Each tone detector\'s response across the audio band: the mark detector peaks at 1300.8 Hz, the space detector at 2109.4 Hz, each hearing a tenth of the other tone.',
        'Each detector listens for one tone for one bit, and hears a little of the other — a tenth, because 808.6 Hz is not a whole number of cycles in 3.33 ms. Twist does not move the peaks; it makes one tone weaker than the other, nearer the noise.')}
      <div class="table-wrap"><table class="be-table"><caption>The same signal, 10 dB over the noise on average, with the tones matched and twisted — a model</caption>
        <thead><tr><th scope="col">The radios</th><th scope="col">Space over mark</th><th scope="col">A 1 misread</th><th scope="col">A 0 misread</th><th scope="col">Flips go</th></tr></thead>
        <tbody>${twistRows()}</tbody></table></div>
      ${parts('twist', {
        bits: `<p>The total power is the same; it is shared unequally. Noise then misreads the weaker tone's bits far more often than the other's,
          so <strong>nearly every flip goes the same way</strong>. With the mark tone weak, 1s become 0s: stop bits and the check bits that should
          be 1 fail, and the readings that get through have only ever lost bits — they read low. With the space tone weak it is the other way
          round, and start bits fail.</p>`,
        print: ['Flips nearly all one way.', 'Readings that only read low, or only high.', 'Worse as the signal weakens, like noise — but one-sided.',
          'Every station through the radio with the mismatch: a station\'s own radio for its readings, a receiver\'s for all it hears.'],
        confirm: ['Look at the two tones\' levels at the receiver\'s detector — the Serial Monitor\'s RTL-SDR card draws the energy in each.',
          'Check how each radio\'s data port is set: flat, or pre- and de-emphasised.', 'Measure the transmitter\'s deviation with each tone.'],
        fix: ['Set the data ports to match: flat into flat, or emphasised and de-emphasised together.', 'Set the modem\'s two tones to equal levels, and the deviation to the radio\'s figure.'],
        bench: [['twist', 'Tone twist']],
        see: [['serial', 'Serial Monitor']],
      })}`);
  }

  // ── 13 · Wiring and decoder faults ─────────────────────────────────────────

  function wiringHtml() {
    const M = BM();
    const ex = [
      ['📌', 'A stuck bit', 'stuck', 'bit 1 stuck at 1', v => v | 2],
      ['↔️', 'Shifted one place', 'shift', 'shifted left', v => M.shl(v, 11)],
      ['🔃', 'Inverted', 'invert', 'every bit inverted', v => M.invert(v, 11)],
      ['🔁', 'Reversed bit order', 'reverse', 'least significant bit first, read as most', v => M.reverse(v, 11)],
      ['🌀', 'Gray code read as binary', 'gray', 'n XOR (n ÷ 2)', v => M.toGray(v)],
    ];
    const vals = [600, 601, 602, 603, 604];
    const rows = ex.map(([icon, name, , rule, f]) => `<tr><th scope="row"><span aria-hidden="true">${icon}</span> ${esc(name)}</th><td>${esc(rule)}</td>${vals.map(v => {
      const r = f(v);
      return `<td class="${r === v ? '' : 'txt-bad'}">${num(r)}</td>`;
    }).join('')}</tr>`).join('');
    return sec('be-wiring', `
      ${head('be-wiring', 13, '📌', 'Wiring and decoder faults', 'Not radio at all: the frame is perfect, and carries the wrong number.')}
      <p>Some faults happen before a bit reaches the radio, or after it leaves the receiver: in the wires from a sensor to the logger, in the
        logger's inputs, or in how a decoder has been told to read the field. The radio carries the frame faithfully — so nothing is thrown
        out and nothing looks damaged — and the number in it is wrong <strong>every time, by the same rule</strong>. That is the fingerprint
        that tells these from every radio fault: radio faults are random in which bits they take; these never are.</p>
      <div class="table-wrap"><table class="be-table be-table--wire"><caption>A river rising one step at a time — 600, 601, 602, 603, 604 — through each fault</caption>
        <colgroup><col class="be-col-name"><col class="be-col-rule"><col span="5"></colgroup>
        <thead><tr><th scope="col">Fault</th><th scope="col">Rule</th>${vals.map(v => `<th scope="col">${num(v)}</th>`).join('')}</tr></thead>
        <tbody>${rows}</tbody></table></div>
      ${figure('be-cv-gray', 'be-cv--short', 'A level rising steadily from 0 to 32 through a Gray-coded encoder read as plain binary: the reading zig-zags between 0 and 48 around the true line.',
        'Shaft encoders print their discs in Gray code, where each step changes one bit, so a reading taken mid-step is never far out. Read as plain binary, a steady rise zig-zags.')}
      <div class="be-wire-grid">
        <div><h4>📌 A stuck bit</h4><p>A broken or shorted wire, a corroded pin, a failed input, a dirty track on an encoder's disc: one bit always
          reads the same. Readings that already had it right come through right; the rest are out by exactly that bit's weight — a level that
          jumps by exactly 16 or 32 or 64 units, one way.</p></div>
        <div><h4>↔️ Shifted by one</h4><p>Wired one line over, or a decoder told the field starts a bit early or late: every reading doubled (and
          even), or halved (losing its last bit).</p></div>
        <div><h4>🔃 Inverted</h4><p>An active-low output read as active-high, or the wrong polarity set: every reading is its mirror image, 2,047
          less the true one. (A whole frame inverted — start bit 1, stop bit 0 — is ALERT's "negative logic", and decoders try both.)</p></div>
        <div><h4>🔁 Reversed</h4><p>Bits sent least significant first and read most significant first, or wired backwards: 1 reads as 1,024. A
          value that reads the same both ways round reads right, which can hide it for a while.</p></div>
        <div><h4>🌀 Gray code</h4><p>An encoder's Gray code read as plain binary, or binary read as Gray: readings that jump about while the river
          rises smoothly.</p></div>
      </div>
      ${parts('wiring', {
        bits: '<p>Nothing on the air is wrong, so no frame is thrown out. Every reading is changed by one fixed rule.</p>',
        print: ['One rule explains every wrong reading — the Bit Bench\'s Your readings section finds it from pairs.', 'Nothing is ever thrown out or lost.',
          'One station, at every receiver, every time — weather and time of day make no difference.', 'For a stuck bit: one bit, one way, jumps of exactly 2ⁿ.'],
        confirm: ['Step the sensor through known positions — an encoder by hand, a known level — and watch each bit.',
          'Check the wiring against the logger\'s input map, and the decoder\'s field settings against the sensor\'s.', 'Paste true and reported readings into the Bit Bench and let it name the rule.'],
        fix: ['Rewire or repair the line; replace a failed input or encoder.', 'Set the decoder\'s format, polarity, bit order and Gray/binary setting to the sensor\'s.'],
        bench: [['stuck', 'A stuck bit'], ['gray', 'Gray code']],
        see: [['field', 'Field Data — a sensor\'s readings']],
      })}`);
  }

  // ── 14 · Not a fault ───────────────────────────────────────────────────────

  function notFaultHtml() {
    return sec('be-notfault', `
      ${head('be-notfault', 14, '🙃', 'When it is not a fault at all', 'Some readings look corrupted and are not.')}
      <ul class="be-list">
        <li><strong>A counter wrapping.</strong> A rain gauge's tip count is an 11-bit number: after 2,047 comes 0. A fall of exactly 2,048 tips is
          the counter starting again, not a bit gone wrong — Station Health undoes the wraps before it adds up the rain, and HFEM Messages flags
          a counter within 5% of its ceiling.</li>
        <li><strong>A reading pinned at the top or the bottom.</strong> 0 or 2,047, again and again, is a sensor out of range or failed, not the radio.</li>
        <li><strong>Two stations on one address.</strong> An ALERT address is only unique within a region — 614 of the file's 5,122 are shared — so a
          base that hears both regions files both under one address. The Bit Flipper and the Ghosting Graph show who shares.</li>
        <li><strong>Test and maintenance transmissions</strong>, and a sensor genuinely knocked, flooded or fouled by debris.</li>
        <li><strong>A wrong conversion.</strong> A value scaled with the wrong factor or offset is wrong in proportion, by a rule that is not about
          bits at all.</li>
      </ul>
      ${figure('be-cv-roll', 'be-cv--short', 'A rain counter counting up to 2,047 and starting again at 0: the drop is the counter wrapping, not corruption.', '')}`);
  }

  // ── 15 · In Flood-Net ──────────────────────────────────────────────────────

  function moreHtml() {
    const link = (tab, icon, name, why, secId) => `<li><button type="button" class="link-btn be-link" onclick="BitErrors.tab('${tab}'${secId ? `, '${secId}'` : ''})"><span aria-hidden="true">${icon}</span> ${esc(name)}</button><span class="be-aside">${esc(why)}</span></li>`;
    return sec('be-more', `
      ${head('be-more', 15, '🧰', 'Where each shows up in Flood-Net', '')}
      <ul class="be-links">
        ${link('bitbench', '🧪', 'Bit Bench', 'Try every fault here on a real frame, read a batch\'s fingerprint, play whodunnit, and paste in readings of your own.')}
        ${link('flipsources', '🔎', 'Bit-Flip Sources', 'The network\'s own corrupted copies, put down to the transmitter whose carrier they came on.')}
        ${link('health', '🚦', 'Station Health', 'Corrupted copies, transmitter frequency drift and the Airtime panel — and a rain counter\'s wraps undone before the rain is added up.')}
        ${link('bitflipper', '🔀', 'Bit Flipper', 'The addresses one or two bits from a station\'s, and the stations a ghost would land on.')}
        ${link('network', '🧬', 'Ghosting Graph', 'Every address that can ghost onto another, and the ghosts actually seen.')}
        ${link('rf', '📶', 'RF Environment', 'The licensed transmitters near a site, intermodulation candidates among them.')}
        ${link('propagation', '🎓', 'Radio Propagation', 'Echoes, shadows, collisions and the fade-margin test, in pictures that move.')}
        ${link('packets', '📦', 'ALERT Packets', 'A frame decoded bit by bit — framing, check bits and the check message\'s flags.')}
      </ul>`);
  }

  // ── The page ───────────────────────────────────────────────────────────────

  function render() {
    return `
    <div class="page be-page" id="be-page" style="--page-max:1100px">
      <div class="be-hero">
        <h2 class="be-title" id="be-h"><span aria-hidden="true">⚡</span> Bit errors</h2>
        <p class="be-lede">Why a station's readings arrive wrong — a ghost on an address nobody owns, a level that jumps by exactly 64, a station
          that goes quiet every hot afternoon — and how to tell the causes apart. Each fault here is taken in depth: what it is, what it does to
          the bits and why, the fingerprint it leaves, how to confirm it in the field and what fixes it. The 🧪 Bit Bench is where to try each
          one; this is where to understand it.</p>
        ${factsHtml()}
        ${tocHtml()}
      </div>
      ${chainHtml()}
      ${guideHtml()}
      ${guardHtml()}
      ${noiseHtml()}
      ${impulseHtml()}
      ${multipathHtml()}
      ${collisionHtml()}
      ${intermodHtml()}
      ${crystalHtml()}
      ${pllHtml()}
      ${clockHtml()}
      ${twistHtml()}
      ${wiringHtml()}
      ${notFaultHtml()}
      ${moreHtml()}
    </div>`;
  }

  // ── The drawings ───────────────────────────────────────────────────────────
  // Still pictures, drawn at the size they are shown and again when that
  // changes. Every figure in them is BitModel's.

  // A plotting frame: margins, the plot box and its scales.
  function frame(ctx, w, h, C, o) {
    const L = o.left || 52, R = o.right || 12, T = o.top || 14, B = o.bottom || 30;
    const box = { x: L, y: T, w: w - L - R, h: h - T - B };
    const X = v => box.x + (v - o.x0) / (o.x1 - o.x0) * box.w;
    const Y = o.log
      ? v => box.y + box.h - (Math.log10(Math.max(o.y0, v)) - Math.log10(o.y0)) / (Math.log10(o.y1) - Math.log10(o.y0)) * box.h
      : v => box.y + box.h - (v - o.y0) / (o.y1 - o.y0) * box.h;
    K().line(ctx, box.x, box.y + box.h, box.x + box.w, box.y + box.h, C.border, 1);
    K().line(ctx, box.x, box.y, box.x, box.y + box.h, C.border, 1);
    return { box, X, Y };
  }
  function path(ctx, pts, color, width, dash) {
    ctx.beginPath();
    ctx.setLineDash(dash || []);
    ctx.strokeStyle = color;
    ctx.lineWidth = width || 2;
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const DRAW = {
    'be-cv-ber'(ctx, w, h, C) {
      const M = BM(), k = K();
      const f = frame(ctx, w, h, C, { x0: 0, x1: 16, y0: 1e-7, y1: 0.5, log: true, left: 94, right: 46 });
      for (const v of [1e-6, 1e-4, 1e-2, 0.5]) {
        k.line(ctx, f.box.x, f.Y(v), f.box.x + f.box.w, f.Y(v), C.border, 1, [2, 3]);
        k.text(ctx, v >= 0.01 ? pct(v) : `1 in ${num(1 / v)}`, f.box.x - 4, f.Y(v) + 4, C.muted, { align: 'right' });
      }
      for (let d = 0; d <= 16; d += 2) k.text(ctx, `${d}`, f.X(d), f.box.y + f.box.h + 14, C.muted, { align: 'center' });
      k.text(ctx, 'signal over the noise, dB', f.box.x + f.box.w / 2, h - 3, C.muted, { align: 'center' });
      ctx.fillStyle = k.alpha(C.warn, 0.1);
      ctx.fillRect(f.X(8), f.box.y, f.X(13) - f.X(8), f.box.h);
      k.text(ctx, 'the cliff', (f.X(8) + f.X(13)) / 2, f.box.y + 12, C.warn, { font: k.FONT_B, align: 'center' });
      const pts = [], fr = [];
      for (let d = 0; d <= 16; d += 0.1) {
        pts.push([f.X(d), f.Y(Math.max(1e-7, M.ber(d)))]);
        fr.push([f.X(d), f.box.y + f.box.h - Math.pow(1 - M.ber(d), 40) * f.box.h]);
      }
      path(ctx, pts, C.bad, 2.5);
      path(ctx, fr, C.ok, 2, [5, 3]);
      k.text(ctx, 'a bit misread (left scale)', f.X(1), f.Y(M.ber(1)) - 8, C.bad, { font: k.FONT_B });
      k.text(ctx, 'a frame untouched (right scale)', f.X(16) - 4, f.box.y + 26, C.ok, { font: k.FONT_B, align: 'right' });
      for (const v of [0, 0.5, 1]) k.text(ctx, pct(v), f.box.x + f.box.w + 4, f.box.y + f.box.h - v * f.box.h + 4, C.ok);
    },

    'be-cv-imp'(ctx, w, h, C) {
      const M = BM(), k = K();
      const L = M.layout();
      const x0 = 12, cw = (w - 24) / 40, y = h / 2 - 12;
      const T = M.bitMs(), burst = [14.5 * T, 14.5 * T + 8];
      const bx0 = x0 + burst[0] / T * cw, bx1 = x0 + burst[1] / T * cw;
      ctx.fillStyle = k.alpha(C.warn, 0.25);
      ctx.fillRect(bx0, y - 18, bx1 - bx0, 54);
      ctx.beginPath(); ctx.strokeStyle = C.warn; ctx.lineWidth = 1.2;
      for (let x = bx0; x <= bx1; x += 2) { const yy = y - 14 + Math.abs(Math.sin(x * 1.7) * Math.cos(x * 0.37)) * 46; if (x === bx0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy); }
      ctx.stroke();
      for (let j = 0; j < 40; j++) {
        const hit = (j + 1) * T > burst[0] && j * T < burst[1];
        ctx.fillStyle = hit ? C.bad : k.alpha(C[{ start: 'frm', stop: 'frm', A: 'addr', D: 'val', K: 'chk' }[L[j].kind]], 0.8);
        ctx.fillRect(x0 + j * cw + 0.5, y, cw - 1, 20);
      }
      k.text(ctx, 'a burst, 8 ms', (bx0 + bx1) / 2, y - 24, C.warn, { font: k.FONT_B, align: 'center' });
      k.text(ctx, 'the 40 bits of a frame — red: the four the burst lands on', x0, y + 40, C.muted);
    },

    'be-cv-fade'(ctx, w, h, C) {
      const M = BM(), k = K();
      const f = frame(ctx, w, h, C, { x0: 0, x1: 360, y0: -30, y1: 8 });
      for (const v of [-30, -20, -10, 0, 6]) {
        k.line(ctx, f.box.x, f.Y(v), f.box.x + f.box.w, f.Y(v), C.border, 1, [2, 3]);
        k.text(ctx, `${sgn(v)} dB`, f.box.x - 4, f.Y(v) + 4, C.muted, { align: 'right' });
      }
      for (let d = 0; d <= 360; d += 90) k.text(ctx, `${d}°`, f.X(d), f.box.y + f.box.h + 14, C.muted, { align: 'center' });
      k.text(ctx, 'where the echo arrives in its cycle, against the direct wave', f.box.x + f.box.w / 2, h - 3, C.muted, { align: 'center' });
      for (const [rho, color, lab] of [[0.5, C.wave, 'echo half as strong'], [0.95, C.echo, 'echo nearly as strong']]) {
        const pts = [];
        for (let d = 0; d <= 360; d += 1) pts.push([f.X(d), f.Y(Math.max(-30, 20 * Math.log10(Math.max(1e-4, M.fadeAmp(rho, d * Math.PI / 180) * Math.sqrt(1 + rho * rho)))))]);
        path(ctx, pts, color, 2.5);
        k.text(ctx, lab, f.X(rho > 0.9 ? 205 : 300), f.Y(rho > 0.9 ? -24 : -6), color, { font: k.FONT_B });
      }
      k.text(ctx, 'in step: they add', f.X(6), f.Y(-9), C.muted);
      k.text(ctx, 'opposed: they cancel', f.X(180), f.box.y + 12, C.muted, { align: 'center' });
    },

    'be-cv-cap'(ctx, w, h, C) {
      const k = K(), cap = PropPhysics.CAPTURE_DB;
      const f = frame(ctx, w, h, C, { x0: -12, x1: 12, y0: 0, y1: 0.55 });
      ctx.fillStyle = k.alpha(C.muted, 0.15);
      ctx.fillRect(f.X(-12), f.box.y, f.X(-cap) - f.X(-12), f.box.h);
      ctx.fillStyle = k.alpha(C.bad, 0.1);
      ctx.fillRect(f.X(-cap), f.box.y, f.X(cap) - f.X(-cap), f.box.h);
      ctx.fillStyle = k.alpha(C.ok, 0.12);
      ctx.fillRect(f.X(cap), f.box.y, f.X(12) - f.X(cap), f.box.h);
      k.text(ctx, 'ours lost', (f.X(-12) + f.X(-cap)) / 2, f.box.y + 14, C.muted, { font: k.FONT_B, align: 'center' });
      k.text(ctx, 'bits flip', 0 + f.X(0), f.box.y + 14, C.bad, { font: k.FONT_B, align: 'center' });
      k.text(ctx, 'ours clean', (f.X(cap) + f.X(12)) / 2, f.box.y + 14, C.ok, { font: k.FONT_B, align: 'center' });
      const pts = [], same = [];
      for (let d = -cap; d <= cap; d += 0.1) {
        const p = 0.5 * (1 - Math.abs(d) / cap);
        pts.push([f.X(d), f.Y(p)]); same.push([f.X(d), f.Y(p * 0.25)]);
      }
      path(ctx, pts, C.bad, 2.5);
      path(ctx, same, C.bad, 1.5, [4, 3]);
      k.text(ctx, 'where the two bits differ', f.X(-1.5), f.Y(0.5) + 4, C.bad, { align: 'right' });
      k.text(ctx, 'where they agree', f.X(0), f.Y(0.16), C.bad, { align: 'center' });
      for (let d = -12; d <= 12; d += 3) k.text(ctx, `${sgn(d)}`, f.X(d), f.box.y + f.box.h + 14, C.muted, { align: 'center' });
      k.text(ctx, 'ours against the other, dB', f.box.x + f.box.w / 2, h - 3, C.muted, { align: 'center' });
      for (const v of [0, 0.25, 0.5]) k.text(ctx, pct(v), f.box.x - 4, f.Y(v) + 4, C.muted, { align: 'right' });
    },

    'be-cv-imd'(ctx, w, h, C) {
      const M = BM(), k = K();
      const prods = M.imProducts(S.f1, S.f2);
      const fs = [S.f1, S.f2, M.fMhz(), ...prods.map(x => x.mhz)];
      let lo = Math.min(...fs), hi = Math.max(...fs);
      const pad = Math.max(0.05, (hi - lo) * 0.1);
      lo -= pad; hi += pad;
      const base = h - 30;
      const X = v => 14 + (v - lo) / (hi - lo) * (w - 28);
      k.line(ctx, 8, base, w - 8, base, C.border, 1);
      const bar = (f, ht, color, lab, sub) => {
        k.line(ctx, X(f), base, X(f), base - ht, color, 4);
        k.text(ctx, lab, X(f), base - ht - 16, color, { font: k.FONT_B, align: 'center' });
        k.text(ctx, sub, X(f), base - ht - 4, C.muted, { align: 'center' });
      };
      bar(S.f1, h * 0.5, C.accent, 'f₁', num(S.f1, 4));
      bar(S.f2, h * 0.5, C.accent, 'f₂', num(S.f2, 4));
      prods.forEach(x => bar(x.mhz, h * 0.22, Math.abs(x.offsetHz) <= M.IF_HALF_HZ ? C.bad : C.echo, x.key === '2f1-f2' ? '2f₁ − f₂' : '2f₂ − f₁', num(x.mhz, 4)));
      k.line(ctx, X(M.fMhz()), base + 6, X(M.fMhz()), base - h * 0.62, C.ok, 1.5, [3, 2]);
      k.text(ctx, 'our channel, 151.5', X(M.fMhz()), base + 18, C.ok, { font: k.FONT_B, align: 'center' });
      k.text(ctx, 'MHz', w - 10, base + 18, C.muted, { align: 'right' });
    },

    'be-cv-xtal'(ctx, w, h, C) {
      const M = BM(), k = K();
      const f = frame(ctx, w, h, C, { x0: -20, x1: 70, y0: -18, y1: 18, right: 64 });
      const edge = (M.IF_HALF_HZ - M.DEV_HZ) / M.hzPerPpm();
      ctx.fillStyle = k.alpha(C.bad, 0.08);
      ctx.fillRect(f.box.x, f.box.y, f.box.w, f.Y(edge) - f.box.y);
      ctx.fillRect(f.box.x, f.Y(-edge), f.box.w, f.box.y + f.box.h - f.Y(-edge));
      ctx.fillStyle = k.alpha(C.ok, 0.1);
      ctx.fillRect(f.box.x, f.Y(2.5), f.box.w, f.Y(-2.5) - f.Y(2.5));
      for (const v of [edge, -edge]) k.line(ctx, f.box.x, f.Y(v), f.box.x + f.box.w, f.Y(v), C.bad, 1, [4, 3]);
      for (const v of [2.5, -2.5]) k.line(ctx, f.box.x, f.Y(v), f.box.x + f.box.w, f.Y(v), C.warn, 1, [2, 3]);
      k.line(ctx, f.box.x, f.Y(0), f.box.x + f.box.w, f.Y(0), C.border, 1);
      // An AT-cut crystal's cubic, turning ±30 °C from 25 °C; a poorer cut three times as steep.
      const at = (T, a) => a * (Math.pow(T - 25, 3) - 2700 * (T - 25));
      const good = [], poor = [];
      for (let T = -20; T <= 70; T += 0.5) { good.push([f.X(T), f.Y(at(T, 1e-4))]); poor.push([f.X(T), f.Y(at(T, 2.4e-4) + 1.5)]); }
      path(ctx, poor, C.echo, 2.5);
      path(ctx, good, C.accent, 2.5);
      for (const v of [-15, -10, -5, 0, 5, 10, 15]) {
        k.text(ctx, `${sgn(v)}`, f.box.x - 4, f.Y(v) + 4, C.muted, { align: 'right' });
        k.text(ctx, hz(v * M.hzPerPpm()), f.box.x + f.box.w + 4, f.Y(v) + 4, C.muted);
      }
      for (let T = -20; T <= 70; T += 10) k.text(ctx, `${T}°`, f.X(T), f.box.y + f.box.h + 14, C.muted, { align: 'center' });
      k.text(ctx, 'temperature, °C — ppm on the left, Hz at 151.5 MHz on the right', f.box.x + f.box.w / 2, h - 3, C.muted, { align: 'center' });
      k.text(ctx, 'a good crystal', f.X(-5), f.Y(at(-5, 1e-4)) - 8, C.accent, { font: k.FONT_B });
      k.text(ctx, 'a poorer one', f.X(52), f.Y(at(52, 2.4e-4) + 1.5) + 16, C.echo, { font: k.FONT_B });
      k.text(ctx, 'a TCXO stays in here', f.X(66), f.Y(-0.6), C.ok, { align: 'right' });
      k.text(ctx, 'the swing reaches the filter', f.X(66), f.Y(edge) - 4, C.bad, { align: 'right' });
    },

    'be-cv-pll'(ctx, w, h, C) {
      const M = BM(), k = K();
      const tEnd = 460;
      const f = frame(ctx, w, h, C, { x0: 0, x1: tEnd, y0: 0, y1: 10.5 });
      const edge = (M.IF_HALF_HZ - M.DEV_HZ) / 1000, out = (M.IF_HALF_HZ + M.DEV_HZ) / 1000;
      ctx.fillStyle = k.alpha(C.bad, 0.07);
      ctx.fillRect(f.box.x, f.box.y, f.box.w, f.Y(edge) - f.box.y);
      k.line(ctx, f.box.x, f.Y(edge), f.box.x + f.box.w, f.Y(edge), C.warn, 1, [4, 3]);
      k.line(ctx, f.box.x, f.Y(out), f.box.x + f.box.w, f.Y(out), C.bad, 1, [2, 3]);
      k.text(ctx, 'the swing reaches the filter', f.box.x + f.box.w - 4, f.Y(edge) - 4, C.warn, { align: 'right' });
      k.text(ctx, 'wholly outside', f.box.x + f.box.w - 4, f.Y(out) - 4, C.bad, { align: 'right' });
      const p = { tau: 30, kick: 10, ring: false };
      const pts = [];
      for (let t = 0; t <= tEnd; t += 1) pts.push([f.X(t), f.Y(Math.abs(M.pllHz(t, p)) / 1000)]);
      path(ctx, pts, C.accent, 2.5);
      const T = M.bitMs();
      [[300, C.ok], [50, C.warn], [25, C.bad]].forEach(([lead, color], i) => {
        const y = f.box.y + f.box.h - 10 - i * 12;
        ctx.fillStyle = k.alpha(color, 0.85);
        ctx.fillRect(f.X(lead), y, f.X(lead + 40 * T) - f.X(lead), 8);
        const lab = `frame at ${lead} ms`;
        ctx.font = k.FONT;
        const fits = f.X(lead + 40 * T) + 6 + ctx.measureText(lab).width <= w - 4;
        k.text(ctx, lab, fits ? f.X(lead + 40 * T) + 4 : f.X(lead) - 4, y + 8, color, { align: fits ? 'left' : 'right' });
      });
      for (let t = 0; t <= tEnd; t += 50) k.text(ctx, `${t}`, f.X(t), f.box.y + f.box.h + 14, C.muted, { align: 'center' });
      for (const v of [0, 2, 4, 6, 8, 10]) k.text(ctx, `${v} kHz`, f.box.x - 4, f.Y(v) + 4, C.muted, { align: 'right' });
      k.text(ctx, 'ms after key-up', f.box.x + f.box.w / 2, h - 3, C.muted, { align: 'center' });
    },

    'be-cv-uart'(ctx, w, h, C) {
      const M = BM(), k = K();
      const word = M.air(4021, 1263).slice(0, 10);
      const rows = [[0, 'exact'], [4, '4% fast'], [6, '6% fast']];
      const left = 70, cw0 = (w - left - 16) / 11;
      const rh = (h - 40) / rows.length;
      rows.forEach(([err, lab], r) => {
        const y = 16 + r * rh;
        const cw = cw0 / (1 + err / 100);
        k.text(ctx, lab, 6, y + 20, C.text, { font: k.FONT_B });
        for (let j = 0; j < 11; j++) {
          const bit = j < 10 ? word[j] : 0;
          const x = left + j * cw;
          ctx.fillStyle = j === 10 ? k.alpha(C.muted, 0.25) : k.alpha(j === 0 || j === 9 ? C.frm : C.addr, bit ? 0.75 : 0.3);
          ctx.fillRect(x + 0.5, y + 4, cw - 1, 22);
          k.text(ctx, j === 0 ? 'S' : j === 9 ? 'P' : j === 10 ? 'S′' : `b${j - 1}`, x + cw / 2, y + 19, C.text, { align: 'center' });
        }
        for (let s = 0; s < 10; s++) {
          const t = (s + 0.5) * cw0;
          const lands = Math.floor(t / cw);
          const ok = lands === s;
          const x = left + t;
          k.line(ctx, x, y + 28, x, y + 40, ok ? C.ok : C.bad, ok ? 1.5 : 2.5);
          ctx.fillStyle = ok ? C.ok : C.bad;
          ctx.beginPath(); ctx.moveTo(x, y + 27); ctx.lineTo(x - 4, y + 34); ctx.lineTo(x + 4, y + 34); ctx.closePath(); ctx.fill();
        }
      });
      k.text(ctx, 'the receiver reads at the arrows, counting its own bits from the start edge — S′ is the next word\'s start bit', 6, h - 6, C.muted);
    },

    'be-cv-twist'(ctx, w, h, C) {
      const M = BM(), k = K();
      const f = frame(ctx, w, h, C, { x0: 500, x1: 3000, y0: 0, y1: 1.05 });
      for (const [f0, color, lab] of [[M.MARK_HZ, C.addr, `mark detector · ${num(M.MARK_HZ, 1)} Hz`], [M.SPACE_HZ, C.val, `space detector · ${num(M.SPACE_HZ, 1)} Hz`]]) {
        const pts = [];
        for (let x = 500; x <= 3000; x += 5) pts.push([f.X(x), f.Y(M.toneResp(x - f0))]);
        path(ctx, pts, color, 2.5);
        k.text(ctx, lab, f.X(f0), f.Y(1) - 4, color, { font: k.FONT_B, align: 'center' });
      }
      const leak = M.toneResp(M.SPACE_HZ - M.MARK_HZ);
      k.line(ctx, f.X(M.SPACE_HZ), f.Y(leak), f.X(M.SPACE_HZ) + 40, f.Y(leak) - 18, C.muted, 1);
      k.text(ctx, `${pct(leak)} of the other tone`, f.X(M.SPACE_HZ) + 44, f.Y(leak) - 20, C.muted);
      for (let x = 500; x <= 3000; x += 500) k.text(ctx, `${num(x)}`, f.X(x), f.box.y + f.box.h + 14, C.muted, { align: 'center' });
      k.text(ctx, 'audio frequency, Hz', f.box.x + f.box.w / 2, h - 3, C.muted, { align: 'center' });
      for (const v of [0, 0.5, 1]) k.text(ctx, pct(v), f.box.x - 4, f.Y(v) + 4, C.muted, { align: 'right' });
    },

    'be-cv-gray'(ctx, w, h, C) {
      const M = BM(), k = K();
      const pts = Array.from({ length: 33 }, (_, i) => ({ t: i, a: i, b: M.toGray(i) }));
      const lo = Math.min(...pts.map(p => Math.min(p.a, p.b))), hi = Math.max(...pts.map(p => Math.max(p.a, p.b)));
      const f = frame(ctx, w, h, C, { x0: 0, x1: 32, y0: lo - 20, y1: hi + 20 });
      path(ctx, pts.map(p => [f.X(p.t), f.Y(p.a)]), C.ok, 2, [5, 3]);
      path(ctx, pts.map(p => [f.X(p.t), f.Y(p.b)]), C.bad, 2);
      k.text(ctx, 'true level', f.X(1), f.Y(pts[1].a) - 6, C.ok, { font: k.FONT_B });
      k.text(ctx, 'read as binary', f.X(31), f.Y(pts[31].b) - 6, C.bad, { font: k.FONT_B, align: 'right' });
      k.text(ctx, num(hi), f.box.x - 4, f.Y(hi) + 4, C.muted, { align: 'right' });
      k.text(ctx, num(lo), f.box.x - 4, f.Y(lo) + 4, C.muted, { align: 'right' });
      k.text(ctx, 'steps, one reading each', f.box.x + f.box.w / 2, h - 3, C.muted, { align: 'center' });
    },

    'be-cv-roll'(ctx, w, h, C) {
      const k = K();
      const f = frame(ctx, w, h, C, { x0: 0, x1: 100, y0: 0, y1: 2200 });
      const pts = [];
      for (let t = 0; t <= 100; t += 0.5) pts.push([f.X(t), f.Y((1400 + t * 14) % 2048)]);
      for (let i = 1; i < pts.length; i++) if (pts[i][1] > pts[i - 1][1] + 20) pts[i - 1].brk = true;
      ctx.beginPath(); ctx.strokeStyle = C.accent; ctx.lineWidth = 2;
      pts.forEach(([x, y], i) => (i && !pts[i - 1].brk ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
      k.line(ctx, f.box.x, f.Y(2047), f.box.x + f.box.w, f.Y(2047), C.warn, 1, [4, 3]);
      k.text(ctx, '2,047 — the most 11 bits hold', f.box.x + 4, f.Y(2047) - 4, C.warn);
      k.text(ctx, '…then 0, and on', f.X(50), f.Y(150), C.muted);
      k.text(ctx, 'tips counted', f.box.x + 4, f.box.y + f.box.h - 6, C.muted);
      k.text(ctx, 'time', f.box.x + f.box.w / 2, h - 3, C.muted, { align: 'center' });
    },
  };

  function drawAll() {
    if (typeof BitBench === 'undefined' || !BitBench.ink) return;
    const C = K().pal();
    document.querySelectorAll('#be-page canvas[data-draw]').forEach(cv => {
      const f = K().fit(cv);
      const d = DRAW[cv.dataset.draw];
      if (f && d) d(f.ctx, f.w, f.h, C);
    });
  }

  function unwire() {
    if (!wired) return;
    wired.ro && wired.ro.disconnect();
    wired = null;
  }

  function init() {
    unwire();
    registerTabTeardown('BitErrors', unwire);
    if (!document.getElementById('be-page')) return;
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => requestAnimationFrame(drawAll)) : null;
    if (ro) document.querySelectorAll('#be-page canvas[data-draw]').forEach(cv => ro.observe(cv));
    wired = { ro };
    requestAnimationFrame(drawAll);
  }

  // ── Controls ───────────────────────────────────────────────────────────────

  function im(which, raw) {
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 100 || v > 1000) return;
    if (which === 'f1') S.f1 = v; else if (which === 'f2') S.f2 = v; else return;
    const out = document.getElementById('be-im-out');
    if (out) out.innerHTML = imReadout();
    const cv = document.getElementById('be-cv-imd');
    const f = cv && K().fit(cv);
    if (f) DRAW['be-cv-imd'](f.ctx, f.w, f.h, K().pal());
  }

  function go(id) {
    const s = document.getElementById(id);
    if (!s) return;
    const h = s.querySelector('h3');
    let still = false;
    try { still = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (_) { still = false; }
    s.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
    if (h) h.focus({ preventScroll: true });
  }

  // Open the lesson at a fault's section — what the bench's "in depth"
  // buttons call.
  function open(id) {
    if (typeof switchTab === 'function') switchTab('biterrors');
    go(SECTION[id] || id);
  }

  function bench(id) {
    if (typeof BitBench !== 'undefined' && BitBench.open) BitBench.open(id);
  }

  function tab(t, secId) {
    if (typeof switchTab === 'function') switchTab(t);
    if (secId && t === 'propagation' && typeof Propagation !== 'undefined' && Propagation.go) Propagation.go(secId);
  }

  return { render, init, open, go, im, bench, tab };
})();
