// MegaNet — methodology.js
//
//   Methodology   ⚖️ the Methodology tab, last in Network health: how the
//                 network's health is judged — what the regular assessments
//                 look for, the data they read and how each one decides.
//                 Bit flips most of all: how a corrupted copy is caught, how
//                 we know it is a flip and not a reading, and how it is put
//                 down to the transmitter that made it.
//
// The page restates rules that live elsewhere, so it reads the numbers it can
// from where they are kept rather than typing them again: health-analysis.js's
// constants (HealthAnalysis.LIMITS) and the frame arithmetic of bit-model.js
// (BitModel.passShare). The rest are written here as their homes set them —
// the thresholds inline in HealthAnalysis.run(), the database's hourly jobs
// (0077 carriers, 0078 flips, 0079 Bit-Flip Sources, 0075 drift) and the
// Backbone's weights — so a change to one of those is a change to this page,
// in the same push.
//
// The page's words that mean something particular here carry their meaning
// on hover (core.js termHtml) from WORDS below, and the same list is the
// "What the words on this page mean" fold at the end, for a finger or a
// keyboard.
//
// After core.js (esc, termHtml), bit-model.js and health-analysis.js, all read
// at call time; app.js (switchTab). Nothing runs at load: renderMain() calls
// render() and init().

const Methodology = (function () {
  const TAB = 'methodology';
  let pending = null;

  // The analysis' own numbers, with what they were when this page was written
  // standing in should the analysis not be loaded.
  const FALLBACK = {
    COPY_WINDOW: 12000, BURST_WINDOW: 90000, RAPID_MS: 120000, RAPID_STEP: 8, REACH_KM: 400, FIT_TOL: 5,
    BIN: 600000, LISTEN_PAD: 2, ARRIVAL_GRACE: 120000, NET_BIN: 900000, NET_MIN_DUE: 5, NET_MISS_FRAC: 0.6,
    BATT_WARN_V: 12.2, BATT_CRIT_V: 11.8, BATT_OVER_V: 15.0, BATT_FALL_V_PER_DAY: -0.04, BATT_SWING_MIN_V: 0.15,
    RAIN_NEAR_KM: 30, RAIN_BIG_STEP: 50, AREA_KM: 30,
    PERIODS_MIN: [15, 30, 60, 120, 180, 240, 360, 720, 1440],
  };
  function limits() {
    const L = typeof HealthAnalysis !== 'undefined' && HealthAnalysis.LIMITS;
    return Object.assign({}, FALLBACK, L || {});
  }
  // Of every frame with k random bits flipped, the share that still passes the
  // frame's guards (bit-model.js): 24 unguarded bits of 40.
  function passShare(k) {
    if (typeof BitModel !== 'undefined' && BitModel.passShare) return BitModel.passShare(k);
    let r = 1;
    for (let i = 0; i < k; i++) r *= (24 - i) / (40 - i);
    return r;
  }

  const s = ms => `${Math.round(ms / 1000)} s`;
  const min = ms => `${Math.round(ms / 60000)} minutes`;
  const pc = x => `${Math.round(x * 100)}%`;
  const hrs = m => (m < 60 ? `${m} min` : m % 60 ? `${(m / 60).toFixed(1)} h` : `${m / 60} h`);

  // ── The words this page uses in its own sense ──────────────────────────────
  // One list: each word's first use on the page, and the glossary fold, read
  // their meanings from here.
  function words(L) {
    return {
      reading: 'One value a station sent — one sensor at one moment — as the database stores it: the sensor\'s address, the time, and the raw count.',
      address: 'The number a legacy ALERT frame carries to say which sensor sent it, from 0 to 8191. Each sensor of each station has its own, recorded in the register.',
      count: 'The raw value a frame carries, from 0 to 2047, before it is turned into millimetres, metres or volts.',
      copy: 'One receiver\'s hearing of one transmission. A frame is heard direct and again each time a repeater re-sends it, so one transmission usually arrives as several copies a few seconds apart.',
      transmission: `What the station actually sent, once: every copy of one address heard within ${s(L.COPY_WINDOW)} of the first, and the value most of them agree on.`,
      corrupted: 'A copy whose value differs from its transmission\'s by a few bits: the same frame with bits flipped somewhere between the station and our receiver, stored as a reading of its own.',
      ghost: 'A corrupted copy whose address bits flipped, so it was stored under another sensor\'s address — often one no station uses.',
      bits: 'How many of the 24 bits that carry the address and the value differ between two frames. A flip is always a bit or two; two readings a station really sent seldom are.',
      inLine: `Within ${L.FIT_TOL} counts of the same address's own reports just before or after it — what that sensor has been saying.`,
      unfiled: 'An address that no station in the register uses.',
      passRange: 'The addresses a repeater is set to re-send, as the register records them, less its exclusions. A repeater can only have relayed a reading whose address is in its pass ranges.',
      carrier: 'How far a transmitter\'s radio frequency sits from its channel, in hertz, measured on every burst by our receiver\'s decoder. Every transmitter\'s crystal sits a little differently, so the offset tells transmitters apart like a fingerprint.',
      clear: 'A corrupted copy that arrived as strong as the clean one, within 6 dB. The transmitter sent the wrong bits; one much weaker could be our receiver mishearing a faint burst.',
      rate: 'A repeater\'s share of the corrupted copies, set against its share of everything heard from the addresses it passes. It stops a repeater that passes many stations looking guilty just for passing them.',
      check: 'The timed report an ALERT station sends from every sensor at a fixed interval — every three hours at most of our stations — between whatever events it reports.',
      slot: 'A moment the station\'s learned schedule says a check is due. Each slot is judged: received, received with a sensor missing, missed, or unknown.',
      listening: `A receiver that has heard this station delivered other traffic within ${min(L.LISTEN_PAD * L.BIN)} before the moment and within ${min(L.LISTEN_PAD * L.BIN)} after it — proof it was working then.`,
      unknown: 'A slot when no receiver that hears the station was shown to be listening. It is never counted against the station.',
      spell: 'Four or more checks missed in a row while the receivers were listening: the station, or its path, gone for a while.',
      solar: 'Clock time shifted by the station\'s longitude, so that noon is when the sun is highest there. A battery\'s day and night are judged in it.',
      swing: 'How far a solar station\'s battery rises from its night-time low to its daytime high. No swing means no charge is arriving.',
      theilSen: 'A trend taken as the median of the slopes between every pair of points, so that one bad night cannot bend it the way it bends an ordinary straight-line fit.',
      snr: 'Signal-to-noise ratio: how far a burst stood above the receiver\'s background noise, in decibels. Most bursts here arrive 5 to 15 dB above it.',
      ppm: 'Parts per million of the channel frequency: at 151.5 MHz one part per million is about 152 Hz.',
      fleet: 'The other transmitters the same receiver hears that day. A carrier offset is measured against their median, so a receiver\'s own error cancels out.',
      together: 'Two different stations\' frames stamped within 3 seconds of each other at one receiver\'s channel — close enough that they could have been on the air at once.',
      onlyIt: 'A repeater\'s stations that no other repeater passes: if it goes off the air, nothing else brings them in.',
      register: 'Flood-Net\'s list of stations: each one\'s position and sensors with their addresses, and each repeater\'s channels and pass ranges.',
      finding: 'One judgement about a station, a repeater, a receiver or the register, with its evidence as numbers and a suggested action.',
    };
  }
  // The glossary fold's order, and the label each is listed under.
  const GLOSSARY = [
    ['reading', 'Reading'], ['address', 'Address'], ['count', 'Count'], ['copy', 'Copy'], ['transmission', 'Transmission'],
    ['corrupted', 'Corrupted copy'], ['ghost', 'Ghost'], ['bits', 'Bits apart'], ['inLine', 'In line'], ['unfiled', 'Unfiled address'],
    ['passRange', 'Pass range'], ['carrier', 'Carrier offset'], ['clear', 'Clear (corrupted copy)'], ['rate', 'Rate (a repeater\'s)'],
    ['check', 'Check'], ['slot', 'Slot'], ['listening', 'Listening'], ['unknown', 'Unknown (slot)'], ['spell', 'Spell'],
    ['solar', 'Solar time'], ['swing', 'Daily swing'], ['theilSen', 'Theil–Sen trend'], ['snr', 'SNR'], ['ppm', 'ppm'],
    ['fleet', 'The fleet'], ['together', 'Together (airtime)'], ['onlyIt', 'Only-it stations'],
    ['register', 'The register'], ['finding', 'Finding'],
  ];

  let W = null;
  const term = (k, text) => termHtml(text, W[k]);
  const go = (tab, label) => `<button type="button" class="link-btn" onclick="switchTab('${tab}')">${label}</button>`;

  // [id, title, html] — authored here, not user input.
  function sections() {
    const L = limits();
    W = words(L);
    const p1 = passShare(1), p2 = passShare(2), p3 = passShare(3);
    const periods = (L.PERIODS_MIN || FALLBACK.PERIODS_MIN).map(hrs).join(', ');
    return [
      ['approach', 'What the assessments look for, and the rules they keep', `
        <p>Network health asks the questions the upkeep of a field station asks, and answers each one from the data alone:</p>
        <ul>
          <li><strong>Is it still reporting?</strong> Did each station send the timed reports it is set to send, and if not, was it the
            station, the path, or our receiver?</li>
          <li><strong>Is what arrived real?</strong> Which stored readings are a station's own, and which are copies with bits flipped on
            the way — and who flipped them?</li>
          <li><strong>Is it going to stop?</strong> A battery sliding night by night, a solar panel no longer charging, checks missed more
            often each day, a radio's frequency walking.</li>
          <li><strong>Is the sensor right?</strong> A rain gauge silent through a storm its neighbours recorded, a river level that never
            moved through rain.</li>
          <li><strong>Which repeaters need attention first?</strong> The backbone ranked by what has gone wrong with each.</li>
          <li><strong>Is the register right?</strong> Addresses heard on the air that no station on file carries, or that are filed
            hundreds of kilometres away.</li>
        </ul>
        <h4>The rules the methods keep</h4>
        <ul>
          <li><strong>Every reading is judged in its context.</strong> In time, against the same sensor's own series; in space, against
            the stations around it; and against the network at that moment — which receivers were working, and what else was heard.
            A value that is odd on its own is often plain once you see what was heard in the same seconds.</li>
          <li><strong>Absence is only evidence when someone was listening.</strong> A check is counted as missed only if a receiver
            that hears that station was shown to be working at the time. Otherwise it is <em>unknown</em>, and never counted.</li>
          <li><strong>Corrupted data is set aside first.</strong> Corrupted copies and ghosts are found before anything else is worked
            out, so a flipped bit is never counted as a check, a battery reading or rain.</li>
          <li><strong>Like is compared with like.</strong> A battery is trended on its lowest reading each night, in the station's own
            solar day, not on whatever time the readings happened to land.</li>
          <li><strong>Robust arithmetic.</strong> Medians rather than means, and ${term('theilSen', 'Theil–Sen')} trends rather than
            straight-line fits, so that one wild value cannot carry a conclusion.</li>
          <li><strong>Undecided is an answer.</strong> Where the evidence cannot say which of two readings is the corrupted one, the
            pair is left undecided and counted as such — never guessed.</li>
          <li><strong>Every ${term('finding', 'finding')} carries its evidence.</strong> The numbers it was decided on, and a
            suggested action in a technician's words. A red badge that cannot say why is one nobody acts on.</li>
          <li><strong>It narrows; it does not convict.</strong> The methods say where to look first. A site visit or a field test
            settles it.</li>
        </ul>`],

      ['data', 'The data, and how it reaches us', `
        <p>Every assessment reads the same few things, and nothing else.</p>
        <h4>What a station sends</h4>
        <p>A legacy ALERT field station sends a short radio burst for each sensor: a rain gauge's tip counter, a river level, its battery.
          It sends one when something happens (a tip, a change in level) and one from every sensor on a fixed timer, the
          ${term('check', 'check')}. Each burst carries only two things: the sensor's ${term('address', 'address')} and its
          ${term('count', 'count')}. It carries no time, no station name and no record of which repeater passed it on.</p>
        <p>Repeaters on hilltops hear the burst and send it on, unchanged, on the same or another channel, after a short delay. A
          repeater re-sends only the addresses in its ${term('passRange', 'pass ranges')}. So one burst usually reaches a base station
          several times: once direct if the station is close enough, and once by each repeater that heard it and passes it — each
          one a ${term('copy', 'copy')}, seconds apart.</p>
        <h4>What our receivers record</h4>
        <p>Flood-Net's own base stations — Raspberry Pis running the RPi ALERT decoder on RTL-SDR radio sticks, one per channel —
          report every frame they hear, good or bad, as a <em>reception</em>: the receiver and stick, the moment it was heard, the
          address and count, the protocol (legacy ALERT or ALERT2), the channel, how strong it was (its level against the stick's
          own full scale, and its ${term('snr', 'SNR')} over the stick's noise floor) and — since RPi ALERT 0.14 for legacy bursts,
          and 19 October 2026 for ALERT2 — its ${term('carrier', 'carrier offset')}. Receptions are kept 90 days. Other ways in
          (the MQTT bridge, a logger at a base reading an ERT-A2, the browser's Serial Monitor, the HTTP ingest) record less:
          usually just the address, count and time.</p>
        <p>Those hearings are also stored as ${term('reading', 'readings')}: one row per address, moment and value. A legacy frame
          carries no time, so its moment is when the receiver heard it, and the copies that agree at one moment share a row, counted
          with the paths they came by. That last detail matters: a copy that arrives with a different value is a different row, so a
          corrupted copy is <em>stored as a reading</em> unless something sets it aside. Finding those is the first job of every
          assessment below.</p>
        <h4>What we know about the network</h4>
        <p>The ${term('register', 'register')} (the Stations tab): where each station is, which addresses its sensors use and what
          each measures, the bucket size of each rain gauge, and for each repeater its channels, pass ranges and exclusions. The
          register is what lets an address be turned into a station, and what says which repeaters could have carried it.</p>
        <h4>Where each assessment runs, and how often</h4>
        <div class="table-wrap" role="region" aria-label="Where each assessment runs" tabindex="0"><table class="mt-table">
          <caption>Where each assessment runs</caption>
          <thead><tr><th scope="col">Assessment</th><th scope="col">Runs</th><th scope="col">Over</th></tr></thead>
          <tbody>
            <tr><th scope="row">Station Health's findings</th><td>In your browser, each time the tab loads or refreshes</td><td>The last 3, 7 or 14 days of readings</td></tr>
            <tr><th scope="row">What is wrong now (silent, repeater down, battery)</th><td>The same code on a server, every 15 minutes, with nobody's browser open; the station cards and pins read it</td><td>The last 7 days</td></tr>
            <tr><th scope="row">A base station gone deaf</th><td>The database, every 5 minutes</td><td>The last day</td></tr>
            <tr><th scope="row">Corrupted copies, and whose carrier each came on</th><td>The database, every hour</td><td>The last three days' receptions; each one found is kept forever</td></tr>
            <tr><th scope="row">Carrier offsets, drift, signal and who corrupts</th><td>The database, every hour</td><td>Each transmitter's last week against the weeks and months before</td></tr>
            <tr><th scope="row">Bit-Flip Sources</th><td>The database, every hour</td><td>The last 7 and 30 days</td></tr>
            <tr><th scope="row">Airtime and logger clocks</th><td>In your browser, from Station Health's result</td><td>Station Health's window</td></tr>
            <tr><th scope="row">Backbone's ranking</th><td>In your browser, from the stored findings and summaries</td><td>A period you pick: 7, 14, 30, 60 or 90 days</td></tr>
            <tr><th scope="row">Network Weather bulletin</th><td>A scheduled Claude task, each morning and each Monday</td><td>The last day, or week</td></tr>
          </tbody></table></div>`],

      ['frame', 'What one ALERT frame can and cannot tell us', `
        <p>A legacy ALERT frame (ALERT Binary) is 40 bits: four words of ten, each a start bit, eight data bits and a stop bit, sent at
          300 baud. Sixteen of those bits are guards — the start and stop bits, and eight check bits with fixed values — and a flip in any
          of them makes the receiver throw the frame away. The other 24 carry the reading: 13 bits of address (0 to 8191) and 11 bits of
          count (0 to 2047). <strong>Nothing checks those 24.</strong> There is no CRC.</p>
        <p>So when a bit flips at random, the frame survives ${pc(p1)} of the time — the flip landed in the reading, and the receiver
          cannot tell. With two flips it survives ${pc(p2)} of the time; with three, ${pc(p3)}. A fault that takes many bits makes a
          station go <em>quiet</em>; a fault that takes one bit now and then makes it go <em>wrong</em>. A flip in the count gives a
          wrong value on the right address. A flip in the address files the reading under another sensor altogether.</p>
        <p>The frame cannot vouch for itself, so every method on this page works from what is around it instead: the other copies of the
          same transmission, what that sensor has been saying, what the stations nearby were doing, and — where we have it — the
          carrier the burst arrived on. ${go('biterrors', '⚡ Bit Errors')} goes through every cause of a flip and the fingerprint
          each leaves; the ${go('bitbench', '🧪 Bit Bench')} lets you try them.</p>`],

      ['copies', 'Bit flips, step 1: copies that disagree', `
        <p>The commonest flip we see is a repeater relaying a frame with a bit or two wrong. It leaves a clear mark: the clean copy arrives
          (direct, or through another repeater), and a second, different copy of the same address lands a second or two after it. On the
          stored readings a corrupted copy arrives a median 2.7 s after the clean one, and never more than 10 s. A battery heard as 135
          and then, two seconds later, as 151 and 1175 has not changed — those are corrupted copies. About 2% of what our first receiver
          stored in its first days was exactly this.</p>
        <h4>How Station Health finds them</h4>
        <ol>
          <li><strong>Group the copies.</strong> For each address, every copy heard within ${s(L.COPY_WINDOW)} of the first is one
            ${term('transmission', 'transmission')}. The window is a little wider than the slowest corrupted copy measured.</li>
          <li><strong>Choose what was sent.</strong> The value most copies agree on. On a tie, the one nearest the address's previous
            transmission — a battery does not jump 1.6 V and back in two seconds. Failing that, the first heard: the direct copy lands
            before any repeater's.</li>
          <li><strong>Mark the rest.</strong> Each copy with a different value is a ${term('corrupted', 'corrupted copy')}, and the number
            of ${term('bits', 'bits')} it differs by is counted (the two counts compared bit for bit). Only legacy ALERT frames are
            treated this way: two different values at one instant from anything else are two readings, and stay so.</li>
          <li><strong>Give back the station's own next report.</strong> A rain gauge tipping every six to eleven seconds through a storm
            puts two real values inside one copy window, and the second would look like a corrupted copy of the first. So a
            "corrupted" copy within ${L.RAPID_STEP} counts of the transmission, that falls between it and the address's next or last
            transmission (within ${min(L.RAPID_MS)}) or carries on the run they started, is the station's own report and is given back.
            In a week of stored readings, 29 of the 33 one-to-three-tip "corruptions" on rain gauges were this.</li>
        </ol>
        <p>Every corrupted copy is set aside before anything else is worked out. A station gets the finding <em>corrupted copies</em> when
          there were at least 5 of them, and at least 8 for every 100 of its transmissions; it says the median number of bits flipped.</p>`],

      ['ghosts', 'Bit flips, step 2: ghosts — flips in the address', `
        <p>When the flip lands in the address bits, the corrupted copy is stored under another address: a ${term('ghost', 'ghost')}. It
          has no clean twin on its own address to disagree with, so it is found by looking across addresses instead. A transmission is a
          ghost when it is within three ${term('bits', 'bits')} — address and value together — of a transmission heard on another address
          within ${s(L.COPY_WINDOW)}, and nothing else explains it:</p>
        <ul>
          <li><strong>On an ${term('unfiled', 'unfiled address')}:</strong> always. Of the 8,192 possible addresses, 5,122 are on file
            nationally; an unfiled one heard in the same seconds as a near-twin is that twin.</li>
          <li><strong>On a station's own address:</strong> only when its value is out of line with that address's own reports and its
            twin is ${term('inLine', 'in line')} with its own. An example from a week of stored readings: 4803 = 51 arrived two seconds
            after 4801 = 51. Address 4801 read 50-odd all week; 4803 read in the thousands. 4803 = 51 is 4801's frame with one address
            bit flipped. Two stations whose frames only look alike are each in line with their own reports, and both stay readings.</li>
          <li><strong>Never</strong> between two sensors of the same station, whose frames go out seconds apart in one check.</li>
        </ul>
        <p>It can run the other way. Address 1772 reads 90-odd every minute on 151.575 MHz, and is not yet on file. One 1772 = 94 was
          heard as 4076 = 94 in the same instant — which would be a station's battery at 9.4 V between two readings of 12.8. The unfiled
          frame is the real one and fits its own series, so the filed one is the ghost, not the other way round.</p>
        <p>Ghosts are set aside from their address's station before anything else is worked out, so they neither count as checks nor
          bend a battery trend, and each counts as evidence against the repeaters that could have carried its twin.</p>`],

      ['proof', 'Bit flips, step 3: how we know a flip is a flip', `
        <p>Two readings a few seconds apart and a bit or two different could, in principle, both be real. Three pieces of evidence say
          they are not.</p>
        <h4>1. One bit apart is far too common to be chance</h4>
        <p>The database takes every legacy burst each of our receivers heard, and every pair of them on the same receiver within five
          seconds of each other, and counts how many of the 24 reading bits differ. Of all the ways two frames can differ, there are 24
          ways to differ by one bit and 10,626 ways to differ by four — 443 times as many. If pairs were coincidences, four-bit pairs
          would far outnumber one-bit pairs. On the live receptions of 18 to 21 October 2026 they were about as common as each other.
          The excess at one and two bits is corruption: about 140 a day, a median 1.7 s apart, 60% of them in the address.</p>
        <h4>2. Which of the pair is the corrupted one — the first rule that decides</h4>
        <ol>
          <li><strong>Same station</strong> — both addresses belong to one station and the values differ: its sensors reporting in one
            burst. <em>Not a flip.</em></li>
          <li><strong>Rapid</strong> — one address, and both values within 8 counts of its last reading: two real reports, a gauge tipping
            twice. <em>Not a flip.</em></li>
          <li><strong>Ghost</strong> — one address is on a station and the other on none: the unfiled one is corrupted.</li>
          <li><strong>Silent address</strong> — both on stations, one not heard at all in the week before: that one is corrupted.</li>
          <li><strong>Fit</strong> — one value within 8 counts of its address's last reading, the other more than 32 from its own: the
            other is corrupted.</li>
          <li><strong>Copies</strong> — the version heard more often, by any receiver within 12 s, is the true one.</li>
          <li>Otherwise <strong>undecided</strong>, and counted as undecided.</li>
        </ol>
        <p>A burst judged corrupted in one pair and true in another cannot be both, so every pair it is in is set aside as
          <em>unsure</em>. On those same three days: 247 pairs decided, 83 undecided, 73 found not to be flips.</p>
        <h4>3. The corrupted copy came on a particular transmitter's carrier</h4>
        <p>Since RPi ALERT 0.14 our receivers measure every legacy burst's ${term('carrier', 'carrier offset')}. A corrupted copy that arrives on the
          carrier of a repeater, as strong as the clean copy, was sent by that repeater with the wrong bits in it — see <em>Who flipped
          it</em> below.</p>
        <h4>What this cannot catch</h4>
        <ul>
          <li>A flip in a low bit of a slowly changing value looks like two real reports, and is not counted.</li>
          <li>A rain counter wrapping past 2047 back to 0 can fool the <em>fit</em> rule.</li>
          <li>A corrupted copy whose clean twin never reached any receiver has nothing to disagree with. Step 4 below catches some of
            these in the series itself.</li>
        </ul>`],

      ['series', 'Bit flips, step 4: in a sensor\'s own series', `
        <p>Some corrupted frames arrive alone. They are found by what a flip does to a series, which a real change seldom does.</p>
        <h4>Rain gauges</h4>
        <p>A tipping-bucket gauge sends a running count of tips. It only ever goes up — until it wraps from 2047 back to 0, or the logger is
          reset. The stored counts carry three kinds of number that are not rain:</p>
        <ul>
          <li><strong>Garbage</strong> — frames on the address that are not the gauge at all: 1220, 16, 14, 1220 at Beachmere (St Smith
            Rd); 9, 1183, 12 at Springfield Lakes between two real tips.</li>
          <li><strong>Flips</strong> — a jump of 64 tips or more that is two bits or fewer from the count before it. 265 → 1801 at
            Torridon is 1,536 tips, 307 mm, and exactly two bits: a corrupted frame, not a storm.</li>
          <li><strong>Resets</strong> — a drop of more than 50 that the next two counts confirm by staying down.</li>
        </ul>
        <p>So the wraps are undone, the series is split at confirmed resets, and in each piece the longest run that never goes down is kept
          (the lower one, when two are as long). Everything off that run is garbage; flips are dropped; a single step of
          ${L.RAIN_BIG_STEP} tips or more that is not a flip is held as unconfirmed and never counted as rain on its own word. What is
          left is the rain.</p>
        <h4>Batteries and levels</h4>
        <p>A one-reading spike is a value far from both its neighbours while the neighbours agree with each other — and within three bits
          of the reading before it, which is what a flip is and a real change seldom is. For a battery, "far" is 0.6 V. It is only judged
          between readings at most 3.5 hours apart: a station checking every six hours legitimately reads 12.9, 14.0, 13.0 V across a
          sunny day. Spikes are taken out before the battery is trended, and reported as <em>value spikes</em>.</p>`],

      ['blame', 'Who flipped it: pass ranges and carrier fingerprints', `
        <p>A legacy burst does not say who sent it — a repeater re-sends the frame exactly as it heard it. So two kinds of evidence are
          weighed, one circumstantial and one direct.</p>
        <h4>By pass range — circumstantial, but always available</h4>
        <p>A corrupted copy of an address can only have been relayed by a repeater whose ${term('passRange', 'pass ranges')} include
          that address, and that is within ${L.REACH_KM} km of the station. Station Health splits each corrupted copy evenly between
          those repeaters. A repeater is flagged as <em>relaying with bit errors</em> when its share is at least 5 corrupted copies, out
          of at least 20 transmissions it could have carried, at a ${term('rate', 'rate')} of at least 3% and at least three times the
          median repeater's.</p>
        <p>Split evenly, the repeaters with the broadest pass ranges top any list just by passing the most stations. On the live fortnight
          that built ${go('flipsources', '🔎 Bit-Flip Sources')}, Hillcrest (Wine Glass) and Constitution Hill each "carried" 250 of the
          corrupted stations. What separates a suspect is its rate and how many corrupted copies <em>only it</em> could have carried. On
          that fortnight Schultz Lookout (8.0%), Toowoomba (6.1%, with 135 only it could have carried) and Mt Petersen (5.8%) stood at
          two to three times the rest.</p>
        <h4>By carrier fingerprint — direct</h4>
        <p>Every burst arrives on the carrier of the transmitter that put it on the air, and every transmitter's crystal sits a little off
          its channel in its own way. The decoder measures each burst's offset to tens of hertz. Every hour, for each receiver and each
          day, the database learns where each transmitter's carrier sits (see <em>The radio itself</em> below for how a clean burst is
          put down to a station or a repeater): the day's offsets, with any more than 60 Hz from the day's median left out as strays, and
          a day with too many strays or a spread wider than 35 Hz set aside as two carriers too close to tell apart.</p>
        <p>A corrupted copy's carrier is then matched against the transmitters that could have sent the true reading — its own station,
          the repeaters that pass it, a repeater whose own sensor it is — using only carriers that receiver heard that day from at least
          3 bursts. The nearest within 40 Hz is the one that sent it. If two candidates are within 15 Hz of each other's distance the
          carrier cannot say which, and it is left <em>ambiguous</em>. A carrier no candidate has is <em>unmatched</em>, and a burst
          heard before carriers were measured is <em>no carrier</em>. Corrupted copies are kept out of the carrier learning itself, where
          they would count under the wrong address.</p>
        <h4>Sent wrong, or heard wrong?</h4>
        <p>A corrupted copy on a repeater's carrier could mean the repeater sent the wrong bits, or that our receiver misheard a faint
          burst. Strength separates them. A ${term('clear', 'clear')} copy arrived within 6 dB of the clean copy's SNR: the repeater sent
          it that way. Most bursts here arrive 5 to 15 dB above the noise, so a fixed level would not do; the comparison is with the clean
          copy of the same reading. A copy that also reached us clean from someone else, while the corrupted one did not come from the
          station itself, had its corruption <em>enter</em> at this transmitter: its own receiver, or its own radio.</p>
        <p>A transmitter gets the finding <em>corrupting</em> when, over the last 7 days, at least 5 of its corrupted copies were clear and
          its clear rate is at least 2% and three times the typical transmitter's (the median of those that sent 30 bursts or more). It
          is critical at 10%.</p>
        <h4>Hours of the day</h4>
        <p>Bit-Flip Sources also counts corrupted copies by hour of day, Brisbane time. Interference keeps hours — a pump, a fence, a
          neighbour's transmitter. A failing radio does not.</p>
        <p class="small">Even a clear fingerprint narrows rather than convicts: a repeater whose own receiver hears interference passes on
          what it heard. The corruption entered at its site, which is where to look — but its radio may be fine.</p>`],

      ['checks', 'Is it still reporting? Checks, slots and silences', `
        <h4>Learning each station's schedule</h4>
        <p>A station's check interval is learned from its own transmissions, not assumed. The interval is chosen from the ones an ALERT
          logger can be set to (${periods}), because a free fit to a station that missed every other check finds six hours when the
          station is set to three. It is learned from the gaps between reports: an interval explains a gap that is a whole number of
          intervals long. The one chosen must explain at least 70% of the gaps (and at least four), half of them in a single step; of the
          ones that pass, the longest wins, since every divisor of the true interval explains its gaps too. The phase is then the centre
          of the densest cluster of report times.</p>
        <p>It is learned from the battery's reports where it can be — a battery reports on the check and nothing else, where a rain gauge
          reports every tip — failing that from bursts carrying two or more sensors (a check is all of them; an event is one). If the
          battery looks six-hourly but the other sensors keep three hours, the shorter wins: a battery frame lost on every other check
          is not a six-hour station.</p>
        <h4>Judging each slot</h4>
        <p>Every ${term('slot', 'slot')} in the window is then judged against the sensors a check normally carries (those in at least 55%
          of the checks):</p>
        <ul>
          <li><strong>Received</strong> — a burst near the slot carrying every one of them;</li>
          <li><strong>Incomplete</strong> — carrying some of them (frames lost one at a time on a marginal path come before whole checks
            are lost);</li>
          <li><strong>Missed</strong> — nothing that counts as a check, while a receiver that hears the station was
            ${term('listening', 'listening')};</li>
          <li><strong>${term('unknown', 'Unknown')}</strong> — nothing, and no such receiver was shown to be working.</li>
        </ul>
        <p>Listening needs traffic on <em>both</em> sides of the moment: a receiver that died at 02:03 delivered plenty at 01:55, and a
          check due at 02:10 it could not hear would otherwise count against the station. Only receivers that heard the station at least
          three times count, and each radio stick counts on its own: a stick retuned or unplugged stops hearing while its siblings carry
          on. A check is given ${min(L.ARRIVAL_GRACE)} to arrive before it can be missed.</p>
        <h4>Taking out what the whole network missed</h4>
        <p>In any ${min(L.NET_BIN)} where at least ${L.NET_MIN_DUE} checks were due from stations that were otherwise reporting normally,
          and ${pc(L.NET_MISS_FRAC)} or more of them were missed, the misses are the network's — a receiver, the channel, a burst of
          interference — and are counted apart, not against each station.</p>
        <h4>The verdicts</h4>
        <ul>
          <li><strong>Silent</strong> — its last two or more checks missed and nothing heard for at least 90 minutes and two intervals.
            Critical at four checks or a day.</li>
          <li><strong>Missed checks rising</strong> — at least 20 points more of its checks missed in the last day than before, two or
            more of them; or a daily share of misses climbing 8 points a day.</li>
          <li><strong>Misses its checks</strong> — 10% or more missed here and there, of at least eight due outside its spells: a marginal
            path rather than a dead station.</li>
          <li><strong>Went silent, then came back</strong> — a ${term('spell', 'spell')} of six hours or more. When it went between 4 pm
            and 4 am ${term('solar', 'solar time')} and came back between 8 am and 4 pm, within 30 hours, it is said to look like a solar
            site whose battery cannot carry it through the night.</li>
          <li><strong>Incomplete checks</strong> — a quarter or more arriving without every sensor's frame, naming the sensor most often
            missing.</li>
          <li><strong>Clock drift</strong> — checks landing 30 s or more later (or earlier) each day: a logger clock left to run.</li>
        </ul>`],

      ['shared', 'Failures that are shared: repeaters, areas and receivers', `
        <p>When several stations fall silent, the question is what they have in common.</p>
        <ul>
          <li><strong>A repeater down.</strong> A repeater that fails at one moment silences each station behind it at that station's
            next check, so their last checks fall within one check interval of each other, not at one instant. When at least three
            stations whose addresses a repeater passes went silent inside one interval (at least three hours, or 1.25 times the longest
            interval among them), and they are at least 60% of its stations that were being heard, the repeater is named. Two repeaters
            carrying the same stations are named together, the likelier first.</li>
          <li><strong>An area gone quiet.</strong> Silent stations no repeater explains, within ${L.AREA_KM} km of each other: something
            they share — a link, a hill, local interference.</li>
          <li><strong>A receiver.</strong> One of our base stations that has stopped delivering for an hour or more; an outage longer
            than 45 minutes and four times its usual longest gap; uploads queuing for more than two minutes; or a clock running ahead of
            the database. Separately, the database calls a receiver <em>deaf</em> when it is still checking in but has decoded nothing
            for 6 hours (an RTL-SDR or ERT-A2 receiver) or 12 (anything else); critical after a day.</li>
          <li><strong>Not heard.</strong> Stations on file whose repeaters were relaying others, but which were never heard: decommissioned,
            or worth a check.</li>
        </ul>`],

      ['power', 'Batteries and charging', `
        <p>A solar station's battery swings through the day: lowest just before dawn, highest in the afternoon, by half a volt or more. A
          trend is only a trend measured like for like, so it is the <em>night-time minimum</em> that is trended — the lowest reading
          between 6 pm and 9 am in the station's own ${term('solar', 'solar time')} (its longitude, not the clock). The day's high is the
          highest between 9 am and 5 pm.</p>
        <ul>
          <li><strong>Critical</strong> — last night's low at or below ${L.BATT_CRIT_V} V, past which a station's radio starts to brown
            out.</li>
          <li><strong>Low</strong> — at or below ${L.BATT_WARN_V} V: a lead-acid battery at roughly half charge at rest.</li>
          <li><strong>Falling</strong> — the night-time low trending down ${Math.abs(L.BATT_FALL_V_PER_DAY)} V a day or faster
            (${term('theilSen', 'Theil–Sen')}, over four nights or more, at least 0.15 V lower overall), with the days left until
            ${L.BATT_CRIT_V} V at that rate.</li>
          <li><strong>No charge</strong> — a ${term('swing', 'daily swing')} under about ${(L.BATT_SWING_MIN_V - 0.03).toFixed(2)} V over
            three nights or more. If it sits at 13.3 V or above, it is more likely held at float by a mains charger, or a stuck reading.</li>
          <li><strong>Overcharging</strong> — three or more readings at ${L.BATT_OVER_V} V or above on two or more days. Held high, not
            touched high once: one reading at 15.6 V is far likelier a flipped bit than a regulator fault.</li>
        </ul>
        <p>Corrupted copies, ghosts and one-reading spikes are out of the series before any of this is worked out.</p>`],

      ['sensors', 'Sensors judged against their neighbours', `
        <p>A sensor's own series cannot say whether it missed a storm. Its neighbours can.</p>
        <ul>
          <li><strong>Rain gauge blocked</strong> — it recorded nothing while at least two gauges within ${L.RAIN_NEAR_KM} km recorded a
            median of 10 mm or more, and it was still sending its checks through the rain. A silent station is not a blocked gauge.</li>
          <li><strong>Rain recorded alone</strong> — 10 mm or more in some six hours, counted only from steps the gauge itself carried on
            from, when no gauge within ${L.RAIN_NEAR_KM} km recorded more than 1 mm. Was it tipped — a visit, wildlife, vandalism?</li>
          <li><strong>Rain counter reset</strong> — the counter went backwards and stayed there: a logger restart. Worth a look at its power.</li>
          <li><strong>Level stuck</strong> — every level reading the same, at least 8 of them over two days or more, while gauges within
            ${L.RAIN_NEAR_KM} km recorded a median of 15 mm or more.</li>
          <li><strong>Level reads zero</strong> — every reading 0: a dry pool, or a sensor disconnected.</li>
        </ul>`],

      ['radio', 'The radio itself: carrier, drift and signal', `
        <h4>Whose carrier a clean burst came on</h4>
        <p>An ALERT2 burst names its path, so a relayed copy is on the last repeater's carrier. A legacy burst names nobody, so each day,
          for each receiver, the database works it out. A repeater's carrier is the ±30 Hz window (in 5 Hz steps) that holds the most
          different addresses it passes. That window is accepted when the repeater's own sensors were heard in it, or when at least 4
          of the addresses it passes were — and at least half of those its pass ranges actually brought in that day. Two repeaters
          within 60 Hz of each other cannot be told apart and count as one. A burst within 30 Hz of a repeater's carrier, on an
          address that repeater passes, is that repeater's; anything else is the station's own. A burst whose squelch stayed open across
          two transmitters (a repeater keying up as the station lets go) has no single offset, and is not used.</p>
        <h4>Taking out our own receivers' error</h4>
        <p>Our receivers' crystals are off too, by −16 to +20 Hz, and they move. So each day each receiver's own error is taken as the
          median of how far its transmitters sit from their usual (at least 2 of them), and removed; each transmitter is then measured
          against the median of the ${term('fleet', 'fleet')} that receiver hears (at least 3), and receivers are combined weighted by
          bursts. A legacy transmitter needs 3 bursts on a receiver-day to count, an ALERT2 one 20. The result is in
          ${term('ppm', 'ppm')} and is relative: 0 ppm means "like the rest", not exactly on frequency. On the live data it holds to
          about 15 Hz day to day.</p>
        <ul>
          <li><strong>Off channel</strong> — 2.5 ppm or more from the fleet (about 380 Hz at 151.5 MHz) on at least two days of the last
            week; critical at 5 ppm.</li>
          <li><strong>Drifting</strong> — the last week against the 30 days before it (at least 3 days and 5 days measured): a move of
            1 ppm or more; critical at 2 ppm. A crystal moving that fast is ageing or failing, or the site is running hot or cold. It
            tends to end in silence.</li>
        </ul>
        <h4>Signal</h4>
        <p>A stick's level is only comparable with itself at one gain, so signal is judged on ${term('snr', 'SNR')}, the burst over that
          stick's own noise floor. It is measured per link — one receiver hearing one transmitter — on days of at least 3 clean bursts.
          Each day each receiver's own shift (the median of its links' changes, from at least 3 links) is taken out, so an antenna or gain
          change at our end is not blamed on every station it hears. Then each link's last week is set against the 30 days before, and
          its last 30 days against the same 30 days two months earlier (for the seasons — trees in leaf, wet ground).</p>
        <ul>
          <li><strong>Signal falling</strong> — down 3 dB or more in either comparison; critical at 6 dB when more than half the base
            stations hearing it saw the fall. On the live data a direct link's daily mean moves a median 1.0 dB day to day, and decodes
            stop at about 8.5 dB.</li>
          <li><strong>Little margin</strong> — an SNR under 12 dB, close enough to that 8.5 dB edge to lose frames on a bad day.</li>
          <li>A station heard only through its repeater has no SNR of its own to us: what we measure is the repeater's link.</li>
        </ul>`],

      ['airtime', 'Airtime: reports landing on each other', `
        <p>Legacy ALERT has no time slots. Every station sends when it must, on a shared channel, and two frames on the air together can
          corrupt each other or be lost. Airtime (in Station Health) looks for stations whose checks keep landing together, and asks
          whether it is doing harm.</p>
        <ul>
          <li><strong>${term('together', 'Together')}</strong> — two stations' frames stamped within 3 s of each other at one receiver's
            channel. A frame is only 133 ms long, but an SDR base station stamps it 0.5 to 3 s after it was on the air, so nothing finer
            can be claimed.</li>
          <li><strong>Does it hurt?</strong> A transmission is damaged if it came with a corrupted copy or a ghost. The damage rate of
            transmissions that landed together is set against those that landed alone — with at least 20 on each side and 3 damaged.
            Twice the rate or more reads as crowding corrupting frames.</li>
          <li><strong>How steady each station's checks are</strong> — from how far each check lands from its slot, the spread taken as
            1.4826 times the median absolute deviation (a standard deviation one wild check cannot inflate): steady at 15 s or less,
            jittered over 45 s; drifting at 5 s a day or more; jumped at a sudden step.</li>
          <li><strong>A clash</strong> — two stations sharing a receiver's channel or a repeater, neither jittered, whose check intervals
            bring them round together, closer than 3 s plus both their spreads. It <em>hurts</em> when they were due together at least
            4 times, at least 2 of those were damaged (incomplete, missed, or with a corrupted copy or ghost), and that rate is at least
            twice, and 10 points above, every other check's.</li>
          <li><strong>What to change</strong> — a check moved to the nearest 30 s step that clears every other by five minutes (or an
            eighth of its interval); a logger clock set before its drift reaches another station's check; or two repeaters on one
            channel, with the same delay or none recorded, re-sending at least two of the same stations and damaging at least 3% of what
            they carry and twice the network's rate, given different delays.</li>
        </ul>`],

      ['backbone', 'Ranking the backbone', `
        <p>${go('backbone', '🗼 Backbone')} turns everything above into one list: the repeaters, worst first, over a period you pick. A
          repeater's stations are the field stations whose addresses its pass ranges take, within 150 km; its
          ${term('onlyIt', 'only-it')} stations are those no other repeater passes.</p>
        <p>Each thing wrong with a repeater is an <em>issue</em> in one of seven kinds — off air, corrupted relays, signal, dropping out,
          power, carrier, pass ranges — and scored:</p>
        <p class="mt-eq">score = severity × impact × persistence × kind × strength</p>
        <ul>
          <li><strong>Severity</strong> — critical 10, warning 4, note 1.</li>
          <li><strong>Impact</strong> — how much of the network leans on it: 1 + log₁₀(1 + n) ÷ 1.3, at most 2.5, where n is its only-it
            stations plus a quarter of the rest. Pass-range issues take 1, and power half the excess.</li>
          <li><strong>Persistence</strong> — 1 if it is still going on, ½ if it cleared during the period, ¾ for dropouts.</li>
          <li><strong>Kind</strong> — off air 1.2, corrupted relays 1.0, signal 0.9, dropping out and power 0.8, carrier 0.7, pass ranges
            0.5. Off the air loses every station behind it; a pass range written wrong loses a few.</li>
          <li><strong>Strength</strong> — for corrupted relays, 1 + the corrupted copies ÷ 200, at most 1.5.</li>
        </ul>
        <p>A repeater's score is the sum of its issues', and its state the worst one still going on. The issues come from the findings
          above: <strong>off air</strong> when its own station is silent or a repeater-down finding names it (critical when it leads that
          finding, when 3 or more only-it stations are quiet, or 40% of 5 or more); <strong>corrupted relays</strong> critical at a clear rate of 10% with 10
          clear copies, a warning at 2% with 5, and a note on pass-range evidence alone (twice the network's rate with a share of 10,
          or 1.3 times with 5 only it could have carried); <strong>carrier</strong> from its median offset with one far-off day
          dropped; <strong>dropping out</strong> a warning at 3 shared spells or a day in all; <strong>pass ranges</strong> a warning when
          it is heard relaying addresses its record does not pass.</p>`],

      ['register', 'The register against the air', `
        <p>Every address heard is looked up in the ${term('register', 'register')}. An address on file but more than
          ${L.REACH_KM} km from the receiver that heard it is not "heard here": the same address numbers recur across the country.</p>
        <ul>
          <li><strong>Unknown address</strong> — heard at least four times, not a ghost, and no station on file carries it. Stronger when
            it keeps a check schedule like a station's: a station not yet in Flood-Net, or one whose address changed.</li>
          <li><strong>Filed far away</strong> — the only station on file with it is too far for this receiver to hear: a station nearby is
            using the address.</li>
          <li><strong>Shared</strong> — two stations nearby carry the same address, so its readings cannot be put down to either.</li>
          <li><strong>Wrong kind</strong> — the register calls the address a battery, but half or more of its readings are not a 12 V
            battery: another sensor, or another station, is on that address here.</li>
        </ul>
        <p>${go('backbone', '🗼 Backbone')} also sets each repeater's pass ranges against what it was actually heard relaying.</p>`],

      ['beyond', 'Beyond the rules: the briefing, the bulletin and the write-ups', `
        <p>The rules are each sound and each blind to the others. They can say twenty stations went silent; they cannot say that fourteen
          share a repeater, two had batteries that sagged for three nights first, and the rest are far-off stations only heard on a good
          night. That is a person's job with the tab open — and it is where the AI comes in, after the rules, never instead of them.</p>
        <ul>
          <li><strong>The maintenance briefing</strong> (Station Health) hands Claude the findings and read-only tools over the same
            readings — a station's detail, its readings with the corrupted copies beside them, the network at one moment, up to 30 days
            of history, the stations nearby. It writes which stations to visit first and why, and what it could not tell. It cannot
            change anything.</li>
          <li><strong>📺 Network Weather</strong> is written by a scheduled Claude task each morning and each Monday, from the same
            analysis, the server's findings and the carrier fingerprints, looking for what several findings have in common.</li>
          <li><strong>${go('investigations', '🕵️ Investigations')}</strong> are write-ups of strange data, each dated, saying what is
            established, what is likely and what is still open, with the exports and the script behind every figure kept in the
            repository so anyone can check them.</li>
        </ul>`],

      ['limits', 'What these methods cannot see', `
        <ul>
          <li><strong>Only what reaches a receiver.</strong> A station no receiver hears is unknown, not silent — and so is every check
            due while its receivers were down.</li>
          <li><strong>Legacy frames do not name their sender.</strong> Without a measured carrier, attribution is by pass range, and
            circumstantial. Carriers were measured only from decoder version 0.14 on, and only by Flood-Net's own receivers.</li>
          <li><strong>Some flips look like readings.</strong> A low-bit flip on a slowly changing value, a corrupted copy whose clean
            twin was lost, a counter wrapping — some get through.</li>
          <li><strong>The register is trusted.</strong> A pass range or an address recorded wrongly sends the reasoning the wrong way;
            the register findings exist to catch that.</li>
          <li><strong>Thresholds are judgements.</strong> Each number on this page was set against the network's own data — and is said
            here so it can be argued with.</li>
        </ul>`],
    ];
  }

  // Every word above with a meaning on hover, listed with it: hover is for a
  // mouse, and this is the same explanation for a finger or a keyboard.
  function glossaryHtml() {
    return `<details class="panel mt-section" id="mt-words"><summary><h3>What the words on this page mean</h3></summary>
      <dl class="rd-words">${GLOSSARY.map(([k, label]) => `<dt>${esc(label)}</dt><dd>${esc(W[k])}</dd>`).join('')}</dl>
    </details>`;
  }

  function render() {
    const list = sections();
    return `<div class="page mt-page" style="--page-max:900px"><h2 class="sr-only">Methodology</h2><div class="stack">
      <section class="panel mt-intro">
        <h3>⚖️ How we judge the network</h3>
        <p>What the regular network health assessments look for, the data they read, and how each one decides — down to how a flipped
          bit is caught, how we know it is a flip, and how it is put down to the transmitter that made it. The numbers are the ones the
          checks use. Words with a dotted underline have their meaning on hover, and in the list at the end.</p>
        <nav aria-label="Methodology sections"><ol class="sg-toc">${list.map(([id, title]) =>
          `<li><button type="button" class="link-btn" onclick="Methodology.show('${id}')">${esc(title)}</button></li>`).join('')}
          <li><button type="button" class="link-btn" onclick="Methodology.show('words')">What the words on this page mean</button></li></ol></nav>
        <div class="button-row"><button type="button" onclick="switchTab('health')">🚦 Station Health</button>
          <button type="button" onclick="switchTab('backbone')">🗼 Backbone</button>
          <button type="button" onclick="switchTab('flipsources')">🔎 Bit-Flip Sources</button></div>
      </section>
      ${list.map(([id, title, html]) => `<details class="panel mt-section" id="mt-${id}"><summary><h3>${esc(title)}</h3></summary><div class="mt-body">${html}</div></details>`).join('')}
      ${glossaryHtml()}
    </div></div>`;
  }

  // Open a section — from the list above, or from another tab.
  function show(id) {
    pending = id;
    if (typeof state !== 'undefined' && state.activeTab === TAB) { reveal(); return; }
    switchTab(TAB);
  }
  function reveal() {
    const id = pending;
    pending = null;
    if (!id) return;
    const el = document.getElementById(`mt-${id}`);
    if (!el) return;
    el.open = true;
    const sm = el.querySelector('summary');
    if (el.scrollIntoView) el.scrollIntoView({ block: 'start' });
    if (sm) sm.focus({ preventScroll: true });
  }
  function init() { reveal(); }

  return { render, init, show, sections, words: () => (sections(), W) };
})();

if (typeof window !== 'undefined') window.Methodology = Methodology;
