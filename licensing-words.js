// MegaNet — licensing-words.js
//
//   LicensingWords   the words of radio licensing, each in plain words and each
//                    taken apart into the words it is built from — the one list
//                    behind every hover note on the Knowledge base's 🪪 Radio
//                    Licensing tab (kb-licensing.js) and the fold there that
//                    says them without a hover (docs/design-system.md, "Words
//                    that mean something here").
//
// An entry is id → { t: the word as written, g: its group, m: what it means
// here (a sentence or two, with the numbers that decide it), parts: the ids of
// the words it is made of or leans on }. `parts` is what lets a reader follow
// "EIRP" down to "isotropic" and "isotropic" down to "antenna" without leaving
// the page: the glossary draws each as a link to its own entry.
//
// Authored here; nothing in it comes from a user or a file. After core.js
// (esc, escAttr, termHtml), before kb-licensing.js. Nothing runs at load.
//
// Exposes: WORDS, GROUPS, meaning, term, chip, glossaryHtml, filter, go.

const LicensingWords = (function () {
  const GROUPS = [
    ['who', 'Who is who'],
    ['licence', 'Kinds of licence, and the paperwork'],
    ['roles', 'The stations in a point-to-multipoint system'],
    ['plan', 'How ACMA plans a channel'],
    ['power', 'Power, and the ways it is counted'],
    ['antenna', 'Antennas'],
    ['signal', 'The signal itself'],
  ];

  const WORDS = {
    // ── Who is who ────────────────────────────────────────────────────────────
    acma: { t: 'ACMA', g: 'who', m: 'The Australian Communications and Media Authority: the Commonwealth regulator that decides who may transmit on which frequency, issues the licences and keeps the public register of them.' },
    licensee: { t: 'Licensee', g: 'who', m: 'The person or organisation a licence is issued to — the Bureau of Meteorology, a council, a water authority. Also called the holder. Only the licensee, and people it has authorised in writing, may transmit under the licence.', parts: ['authorisation'] },
    authorisation: { t: 'Third-party authorisation', g: 'who', m: 'A licensee’s written permission for somebody else to operate transmitters under its licence. A council’s gauge on a Bureau channel needs the Bureau’s, and the agreement must be kept.', parts: ['licensee'] },
    accredited: { t: 'Accredited person', g: 'who', m: 'A frequency assigner ACMA has accredited — usually a radio engineering firm. They work out a channel that will not interfere, certify it, and lodge the licence application for you.', parts: ['fac', 'coordination'] },

    // ── Licences and paperwork ────────────────────────────────────────────────
    act: { t: 'The Act', g: 'licence', m: 'The Radiocommunications Act 1992: the Commonwealth law that makes it an offence to operate a transmitter without a licence, and gives ACMA its powers.' },
    apparatus: { t: 'Apparatus licence', g: 'licence', m: 'A licence for particular equipment at a particular place: one holder, a named site, a frequency and a power. Every licence in ACMA’s register for this network is one. Usually issued a year at a time.', parts: ['licensee', 'register'] },
    classlic: { t: 'Class licence', g: 'licence', m: 'A standing permission nobody applies for or pays for: anyone may use a device that keeps to its limits. For this band the limit is 100 mW EIRP — far below a gauge’s watt or more — and it gives no protection from interference.', parts: ['eirp'] },
    spectrumlic: { t: 'Spectrum licence', g: 'licence', m: 'A licence for a block of frequencies across a whole region, sold at auction, mostly to mobile phone carriers. Flood telemetry does not use one.' },
    txlic: { t: 'Transmitter licence', g: 'licence', m: 'An apparatus licence to operate a transmitter. A fixed licence is one type. The other family, receiver licences, is optional.', parts: ['apparatus', 'fixed', 'rxlic'] },
    rxlic: { t: 'Receiver licence', g: 'licence', m: 'An apparatus licence for a station that only listens. Nobody needs one to receive; it is bought to have the receiver written into ACMA’s planning so later transmitters are kept from interfering with it. The fixed receive licence is the type for a fixed site.', parts: ['protection', 'coordination'] },
    fixed: { t: 'Fixed licence', g: 'licence', m: 'A transmitter licence for stations that stay in one place and talk to other stations that stay in one place. Its two common forms are point to multipoint and point to point.', parts: ['pmp', 'ptp'] },
    pmp: { t: 'Point to multipoint (PMP)', g: 'licence', m: 'One licence for a hub and its spokes: a base station at a site named on the licence, and any number of remote stations that talk to it. Only the base is named and listed in the register.', parts: ['base', 'remote'] },
    ptp: { t: 'Point to point (PTP)', g: 'licence', m: 'A licence for one radio link between two named sites. Both ends are on the licence, each is planned and protected, and it covers nothing else.', parts: ['protection'] },
    determination: { t: 'Licence conditions determination', g: 'licence', m: 'A legislative instrument ACMA makes under the Act that writes conditions into every licence of a type at once. For fixed licences it is the Radiocommunications Licence Conditions (Fixed Licence) Determination 2025. It is law: breaking a condition is a contravention.', parts: ['act', 'condition'] },
    condition: { t: 'Licence condition', g: 'licence', m: 'A rule the licence holder must keep. Some come from the Act, some from the determination, and some are written on the one licence. Transmitting outside a condition is transmitting without authority.', parts: ['special', 'determination'] },
    special: { t: 'Special condition', g: 'licence', m: 'A condition ACMA wrote on one particular licence, such as “a service area of 20 km” or “no protection from licence X”. Where it differs from the determination, the special condition is the one that applies.', parts: ['condition'] },
    advisory: { t: 'Advisory note', g: 'licence', m: 'A note printed on the licence that points the holder to rules or warns of something. It informs; it is not itself a condition.' },
    rali: { t: 'RALI', g: 'licence', m: 'Radiocommunications Assignment and Licensing Instruction: ACMA’s written policy for the people who assign frequencies, one per kind of service. FX16 is the one for point-to-multipoint telemetry. It decides what you are licensed for and what is protected; it is policy, not legislation.', parts: ['accredited', 'coordination'] },
    fac: { t: 'Frequency assignment certificate', g: 'licence', m: 'An accredited person’s certificate that a transmitter on this frequency, at this site, with these settings fits the rules and the relevant RALI. ACMA issues the licence on the strength of it.', parts: ['accredited', 'rali'] },
    es: { t: 'Explanatory statement', g: 'licence', m: 'The plain account ACMA must publish with each legislative instrument, saying what every section is meant to do. Not law itself, but the first place to look when the law’s words leave a question open.', parts: ['determination'] },
    register: { t: 'The register (RRL)', g: 'licence', m: 'ACMA’s Register of Radiocommunications Licences: the public list of every apparatus licence — who holds it, where its base is, its frequency and power. Remote stations are not in it.', parts: ['apparatus', 'remote'] },
    callsign: { t: 'Call sign', g: 'licence', m: 'The identifier ACMA gives a licensed station, such as VZ4MET, printed on its licence.' },
    fan: { t: 'Frequency assignment number', g: 'licence', m: 'ACMA’s number for one use of a channel by one transmitter or receiver — “Freq. assign. ID” on the licence document, ten digits such as 0001167088. A licence with a transmitter and a receiver has two. It is what a transmitter’s label must show.', parts: ['register', 'label'] },
    label: { t: 'Transmitter label', g: 'licence', m: 'A label fixed to a licensed transmitter of more than 2 W EIRP at a shared site, giving its frequency assignment number and the words “Do Not Remove”. Required by the Radiocommunications (Labelling) Determination 2023.', parts: ['fan', 'communal', 'eirp'] },
    communal: { t: 'Communal site', g: 'licence', m: 'A shared site: a place where two or more fixed transmitters work on assigned frequencies within 200 metres of each other, in the same broad band (30 to 300 MHz for this network). A hut on a hill with several services’ radios is one; a gauge alone on a riverbank is not.', parts: ['label'] },

    // ── Roles ────────────────────────────────────────────────────────────────
    station: { t: 'Station', g: 'roles', m: 'In the law’s words, any installation that includes a transmitter, a receiver or both. A rain gauge with a radio is a station; so is a repeater on a hill.' },
    base: { t: 'Base station', g: 'roles', m: 'The hub of a point-to-multipoint licence: the one station whose site is written on the licence. RALI FX16 calls it the master station. In this network it is a repeater or a receiving base that also transmits.', parts: ['pmp', 'station'] },
    remote: { t: 'Remote station', g: 'roles', m: 'A fixed station that talks to a base station under the base’s licence. Its location is not on the licence or in the register. A rain or river gauge reporting to a licensed repeater is one. It may send data only, briefly and at low power.', parts: ['base', 'duty', 'antinput'] },
    fillin: { t: 'Supplementary base station', g: 'roles', m: 'A second transmitter, at a site not named on the licence, that repeats the base’s signal into a pocket the base cannot reach — behind a hill, say. It may fill a gap inside the base’s coverage; it may never be used to stretch that coverage further.', parts: ['base', 'coverage'] },
    rcs: { t: 'Remote control station', g: 'roles', m: 'A fixed station used to control a base station from somewhere else, at no more than 1 W. Flood-warning networks rarely have one.', parts: ['base'] },
    repeater: { t: 'Repeater', g: 'roles', m: 'A station that hears a gauge’s message and sends it on. Because it transmits to carry other stations’ traffic, it is a base station in licensing terms and needs a licence naming its own site.', parts: ['base'] },

    // ── Planning ─────────────────────────────────────────────────────────────
    servicearea: { t: 'Service area', g: 'plan', m: 'The circle round a base station that ACMA plans the licence to serve: 30 km for a high-power system, 2 km for a low-power one. Inside it the channel is kept clear of other users; outside it nothing is promised. It comes from RALI FX16, not from the law.', parts: ['base', 'rali', 'model'] },
    coverage: { t: 'Coverage area', g: 'plan', m: 'The area a base station’s signal actually reaches. The law uses the phrase for where a fill-in transmitter may work, without giving it a size; ACMA’s explanation calls it the area “notionally covered” by the base.', parts: ['fillin'] },
    model: { t: 'Service model', g: 'plan', m: 'The standard system ACMA assumes when it plans a channel: so much power, antennas so high, stations so far apart. FX16 has two — high power (40 W base, 30 km) and low power (8.3 W base, 2 km). A real system that fits the model is protected by the plan.', parts: ['servicearea', 'eirp'] },
    coordination: { t: 'Frequency coordination', g: 'plan', m: 'The checking done before a licence is issued, to make sure a new transmitter will neither interfere with stations already licensed nor suffer from them. For point to multipoint it is done for the base station only.', parts: ['accredited', 'reuse'] },
    cochannel: { t: 'Co-channel', g: 'plan', m: 'On the same frequency. Two co-channel stations close enough together garble each other.' },
    reuse: { t: 'Re-use distance', g: 'plan', m: 'The least distance ACMA keeps between two base stations on the same channel: 100 km for high-power systems, 10 km for low-power ones.', parts: ['cochannel', 'base'] },
    protection: { t: 'Protection', g: 'plan', m: 'ACMA’s undertaking to keep later licences from interfering with a station it has already planned for. A named, coordinated station has it. A remote station has only what follows from being inside its base’s service area.', parts: ['coordination', 'servicearea'] },
    harmful: { t: 'Harmful interference', g: 'plan', m: 'Interference that endangers a safety service, or obstructs, repeatedly interrupts or seriously degrades another licensed service. A remote station that causes it must stop transmitting — that is a condition of the licence.' },
    nointerference: { t: 'No interference, no protection', g: 'plan', m: 'The footing a station is on when it is outside what ACMA planned for: it must not disturb anybody else, and nobody is kept from disturbing it.', parts: ['harmful', 'protection'] },

    // ── Power ────────────────────────────────────────────────────────────────
    watt: { t: 'Watt (W)', g: 'power', m: 'The unit of power. A gauge’s radio is typically 1 to 5 W; a milliwatt (mW) is a thousandth of one.' },
    txpower: { t: 'Transmitter power', g: 'power', m: 'The power the radio itself puts out at its socket, before any cable. The figure on the radio’s label.', parts: ['watt'] },
    feeder: { t: 'Cable loss', g: 'power', m: 'The power that turns to heat in the coaxial cable and connectors between the radio and the antenna, in decibels. Three decibels of loss halves the power that arrives.', parts: ['db'] },
    antinput: { t: 'Power at the antenna input', g: 'power', m: 'What is left of the transmitter’s power after the cable: the power actually delivered to the antenna. The law’s 1 W limit for a gauge is measured here.', parts: ['txpower', 'feeder'] },
    gain: { t: 'Antenna gain', g: 'power', m: 'How much stronger an antenna makes the signal in its best direction than a reference antenna would, in decibels. It adds no power: it squeezes the same power into a narrower shape.', parts: ['dbi', 'dbd', 'isotropic'] },
    eirp: { t: 'EIRP', g: 'power', m: 'Equivalent isotropically radiated power: the power you would have to feed an isotropic antenna to be as strong as this station is in its best direction. In practice: transmitter power, less cable loss, plus antenna gain in dBi. It is the figure a licence limits.', parts: ['equivalent', 'isotropic', 'radiated', 'txpower', 'feeder', 'gain', 'dbi'] },
    equivalent: { t: 'Equivalent', g: 'power', m: 'In “EIRP”: a comparison, not a measurement. The station does not radiate that much power; it is as strong, in one direction, as an isotropic antenna fed that much would be. Older texts say “effective” for the same thing.', parts: ['eirp'] },
    radiated: { t: 'Radiated', g: 'power', m: 'Sent out from the antenna as radio waves — as opposed to power still in the radio or lost in the cable.' },
    erp: { t: 'ERP', g: 'power', m: 'Effective radiated power: the same idea as EIRP but compared with a half-wave dipole instead of an isotropic antenna. ERP is always 2.15 dB less than EIRP for the same station (EIRP ÷ 1.64).', parts: ['eirp', 'dipole', 'dbd'] },
    db: { t: 'Decibel (dB)', g: 'power', m: 'A way of writing a ratio so that multiplying becomes adding. +3 dB is twice the power, +10 dB is ten times, −3 dB is half, 0 dB is no change. Gains and losses along a radio’s path are simply added up.' },
    dbm: { t: 'dBm', g: 'power', m: 'Power written in decibels relative to one milliwatt. 0 dBm is 1 mW, 30 dBm is 1 W, 37 dBm is 5 W, 46 dBm is 40 W.', parts: ['db', 'watt'] },
    dbw: { t: 'dBW', g: 'power', m: 'Power in decibels relative to one watt. 0 dBW is 1 W; it is always 30 less than the same power in dBm.', parts: ['db', 'dbm'] },
    dbi: { t: 'dBi', g: 'power', m: 'Antenna gain in decibels compared with an isotropic antenna. The “i” is for isotropic. A half-wave dipole is 2.15 dBi. Licences and ACMA’s rules use dBi.', parts: ['db', 'isotropic', 'gain'] },
    dbd: { t: 'dBd', g: 'power', m: 'Antenna gain in decibels compared with a half-wave dipole. The “d” is for dipole. Add 2.15 to turn dBd into dBi — a “3 dBd” antenna is 5.15 dBi. Antenna makers often quote dBd.', parts: ['db', 'dipole', 'dbi'] },
    px: { t: 'pX (peak envelope power)', g: 'power', m: 'The power at the top of the signal’s strongest peak, used for transmitters whose power rises and falls with speech. It appears in the rules for HF; an FM data burst is the same power throughout.' },

    // ── Antennas ─────────────────────────────────────────────────────────────
    antenna: { t: 'Antenna', g: 'antenna', m: 'The metal that turns the radio’s electrical power into radio waves, and waves back into a signal. Its shape decides which directions the power goes.' },
    isotropic: { t: 'Isotropic antenna', g: 'antenna', m: 'An imaginary antenna: a single point that radiates exactly equally in every direction — up, down and all round, like a bare light bulb. From Greek isos, equal, and tropos, a turning or direction. None can be built; it is the yardstick every real antenna is measured against (0 dBi).', parts: ['antenna', 'dbi'] },
    omni: { t: 'Omnidirectional', g: 'antenna', m: 'Radiating equally all the way round the compass, though not up and down — the shape of a doughnut lying flat. Right for a base that hears gauges on every side.', parts: ['pattern'] },
    directional: { t: 'Directional', g: 'antenna', m: 'Radiating mostly one way, like a torch. Right for a gauge that only ever talks to one repeater: more of its power arrives, and less goes where it could bother somebody else.', parts: ['pattern', 'beamwidth', 'fb'] },
    dipole: { t: 'Half-wave dipole', g: 'antenna', m: 'The simplest real antenna: a straight rod half a wavelength long (about a metre at 151.5 MHz), fed in the middle. Mounted upright it is omnidirectional. Gain 2.15 dBi, which is 0 dBd — it is the other yardstick.', parts: ['omni', 'dbd', 'wavelength'] },
    whip: { t: 'Whip (ground plane)', g: 'antenna', m: 'A single upright rod a quarter of a wavelength long over a metal surface or a set of radial rods. Omnidirectional, about 2 dBi. The usual antenna on a small gauge.', parts: ['omni', 'wavelength'] },
    collinear: { t: 'Collinear', g: 'antenna', m: 'Several dipoles stacked end to end in one upright tube. Still omnidirectional, but the doughnut is squashed flatter so more power goes out towards the horizon: 5 to 8 dBi. The Bureau’s base licences list a “Colinear Vertical”.', parts: ['dipole', 'omni', 'gain'] },
    yagi: { t: 'Yagi', g: 'antenna', m: 'A directional antenna: a row of parallel rods on a boom, like an old TV aerial. One rod is fed by the radio; one behind it reflects and those in front of it direct the signal forwards. More elements, more gain and a narrower beam — 3 elements about 6 dBi, 6 elements about 12 dBi at VHF.', parts: ['directional', 'element', 'beamwidth', 'fb'] },
    element: { t: 'Element', g: 'antenna', m: 'One rod of a Yagi. The driven element is connected to the cable; the reflector sits behind it, slightly longer; the directors sit in front, each slightly shorter. A “6 element Yagi” has one driven, one reflector and four directors.', parts: ['yagi'] },
    pattern: { t: 'Radiation pattern', g: 'antenna', m: 'A drawing of how strongly an antenna radiates in each direction, usually seen from above. A circle is omnidirectional; a long bulge one way is a beam.' },
    lobe: { t: 'Lobe', g: 'antenna', m: 'A bulge in the radiation pattern. The main lobe is where the antenna points; the back lobe is what leaks out behind; side lobes are the smaller bulges between.', parts: ['pattern'] },
    beamwidth: { t: 'Beamwidth', g: 'antenna', m: 'How wide the main lobe is, in degrees, measured between the two directions where the power has dropped to half of its peak (the half-power points, 3 dB down). A 44° beam covers about an eighth of the compass.', parts: ['lobe', 'halfpower'] },
    halfpower: { t: 'Half-power points', g: 'antenna', m: 'The two directions either side of an antenna’s aim where it radiates half the power it does straight ahead — 3 dB down. The angle between them is the beamwidth.', parts: ['db', 'beamwidth'] },
    fb: { t: 'Front-to-back ratio', g: 'antenna', m: 'How much weaker a directional antenna is behind than in front, in decibels. 20 dB means one-hundredth of the forward power goes backwards. ACMA cares because the back of a gauge’s antenna faces everybody else.', parts: ['db', 'lobe'] },
    polarisation: { t: 'Polarisation', g: 'antenna', m: 'The direction the radio wave’s electric field swings: up and down (vertical) when the antenna’s rods stand upright, side to side (horizontal) when they lie flat. Both ends of a link must match; this network is vertical.', parts: ['eplane'] },
    eplane: { t: 'E-plane', g: 'antenna', m: 'The plane the wave’s electric field lies in — for an upright (vertically polarised) antenna, the vertical plane through its aim. ACMA’s beamwidth figures are “in the plane of the electric field”.', parts: ['polarisation', 'beamwidth'] },
    midband: { t: 'Mid-band gain', g: 'antenna', m: 'An antenna’s gain at the middle of the frequency band it is used in. Gain varies a little across a band; this is the figure the rules quote.', parts: ['gain'] },
    eah: { t: 'Effective antenna height', g: 'antenna', m: 'How high the antenna is above the average level of the country around it, not above its own ground. FX16 assumes 200 m for a base on a hill and 5 m for a gauge.' },
    azimuth: { t: 'Azimuth', g: 'antenna', m: 'A compass bearing in degrees clockwise from true north — the direction a directional antenna is aimed. Blank on a licence for an omnidirectional antenna.' },

    // ── The signal ───────────────────────────────────────────────────────────
    frequency: { t: 'Frequency', g: 'signal', m: 'How many times a second the radio wave swings, in megahertz (MHz, millions a second). Most of this network transmits on 151.5 MHz. A licence fixes it exactly.', parts: ['vhf'] },
    wavelength: { t: 'Wavelength', g: 'signal', m: 'The length of one swing of the wave as it travels: 300 divided by the frequency in MHz gives metres. At 151.5 MHz it is 1.98 m, which is why antennas for it are about a metre long.', parts: ['frequency'] },
    vhf: { t: 'VHF', g: 'signal', m: 'Very high frequency: 30 to 300 MHz. The “VHF high band”, 148 to 174 MHz, is where flood telemetry lives. UHF, ultra high frequency, is 300 to 3,000 MHz.' },
    channel: { t: 'Channel', g: 'signal', m: 'A numbered slot of frequencies set aside for one signal, 12.5 kHz wide in these bands. A licence assigns one, or a pair.', parts: ['bandwidth'] },
    bandwidth: { t: 'Bandwidth', g: 'signal', m: 'How wide a slice of frequencies a signal takes up, in kilohertz (kHz). The licence states it; the transmitter must stay inside it.' },
    emission: { t: 'Emission designator', g: 'signal', m: 'A code on the licence for exactly what kind of signal may be sent: four characters for its bandwidth, then three for how it is modulated and what it carries. 7K50F2D is 7.5 kHz wide, FM, digital tones, data.', parts: ['bandwidth'] },
    burst: { t: 'Transmission', g: 'signal', m: 'One keying of the transmitter: a gauge’s short burst carrying a reading. An ALERT message lasts well under a second.' },
    interval: { t: 'Repetition interval', g: 'signal', m: 'The time from the start of one transmission to the start of the next. A gauge under somebody’s point-to-multipoint licence must leave at least 10 seconds.', parts: ['burst'] },
    duty: { t: 'Duty cycle', g: 'signal', m: 'The share of time a transmitter is on the air: time transmitting divided by total time. A gauge may not exceed 1 in 30 — two seconds in every minute.', parts: ['burst', 'interval'] },
    telemetry: { t: 'Telemetry', g: 'signal', m: 'Measurements sent automatically by radio from somewhere remote — a rain gauge reporting each tip of its bucket. Telecommand is the reverse: an instruction sent out to a device.' },
    simplex: { t: 'Single frequency', g: 'signal', m: 'Sending and receiving on the same frequency, taking turns. The Bureau’s 151.5 MHz licences are like this. Two-frequency working uses one frequency out from the base and another back.', parts: ['frequency'] },
  };

  const meaning = id => (WORDS[id] ? WORDS[id].m : '');
  // The word marked, with its meaning on hover.
  function term(id, text) {
    const w = WORDS[id];
    return w ? termHtml(text || w.t, w.m) : esc(text || id);
  }
  function chip(id, text, cls) {
    const w = WORDS[id];
    return `<span class="term-chip rlc-chip${cls ? ` ${cls}` : ''}" title="${escAttr(w ? w.m : '')}">${esc(text || (w ? w.t : id))}</span>`;
  }

  // The fold that says every word without a hover, grouped, with a box to
  // narrow it and each word's parts as links to their own entries.
  function entryHtml(id) {
    const w = WORDS[id];
    const parts = (w.parts || []).filter(p => WORDS[p]);
    return `<div class="rlc-word" id="rlc-word-${id}" data-word="${id}" data-find="${escAttr(`${w.t} ${w.m}`.toLowerCase())}">
        <dt tabindex="-1">${esc(w.t)}</dt>
        <dd>${esc(w.m)}${parts.length ? `<span class="rlc-word-parts">Built from: ${parts.map(p =>
          `<button type="button" class="link-btn" onclick="LicensingWords.go('${p}')">${esc(WORDS[p].t)}</button>`).join(', ')}</span>` : ''}</dd>
      </div>`;
  }
  function glossaryHtml() {
    const n = Object.keys(WORDS).length;
    return `<div class="rlc-words" id="rlc-words">
        <label class="rlc-words-find">Find a word
          <input type="search" id="rlc-words-q" autocomplete="off" spellcheck="false" placeholder="EIRP, isotropic, service area…"
                 oninput="LicensingWords.filter(this.value)"></label>
        <p class="small txt-muted" id="rlc-words-n" aria-live="polite">${n} words, each with the words it is built from.</p>
        ${GROUPS.map(([g, label]) => `<section class="rlc-words-g" data-group="${g}">
            <h4>${esc(label)}</h4>
            <dl>${Object.keys(WORDS).filter(id => WORDS[id].g === g).map(entryHtml).join('')}</dl>
          </section>`).join('')}
      </div>`;
  }
  function filter(q) {
    const root = document.getElementById('rlc-words');
    if (!root) return;
    const s = String(q || '').trim().toLowerCase();
    let shown = 0;
    for (const el of root.querySelectorAll('.rlc-word')) {
      const hit = !s || el.dataset.find.includes(s);
      el.hidden = !hit;
      if (hit) shown++;
    }
    for (const g of root.querySelectorAll('.rlc-words-g')) g.hidden = !g.querySelector('.rlc-word:not([hidden])');
    const n = document.getElementById('rlc-words-n');
    if (n) n.textContent = s ? `${shown} of ${Object.keys(WORDS).length} words match “${q.trim()}”.` : `${Object.keys(WORDS).length} words, each with the words it is built from.`;
  }
  // Open the fold at one word, and show which.
  function go(id) {
    const fold = document.getElementById('rlc-glossary');
    if (fold && !fold.open) fold.open = true;
    const box = document.getElementById('rlc-words-q');
    if (box && box.value) { box.value = ''; filter(''); }
    const el = document.getElementById(`rlc-word-${id}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.remove('is-lit');
    void el.offsetWidth;
    el.classList.add('is-lit');
    const dt = el.querySelector('dt');
    if (dt) dt.focus({ preventScroll: true });
  }

  return { WORDS, GROUPS, meaning, term, chip, glossaryHtml, filter, go };
})();

if (typeof window !== 'undefined') window.LicensingWords = LicensingWords;
