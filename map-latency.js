// MegaNet — map-latency.js
//
//   MapLatency   ⏱️ Latency & signal, a tool in the Stations map's side panel.
//                It colours every station pin by how fresh its data is — how
//                long since Flood-Net last heard it, how long its readings
//                take to reach the database, or how many of its timed checks
//                went missing — or by how strongly it is heard (its SNR), and
//                can draw that SNR as signal bars beside each pin under any
//                colouring, so latency and signal show at once. Its pane sums
//                it up for the stations in view, following the map as it
//                moves. Pick a station on the map and the pane is about that
//                station instead: its checks slot by slot, its readings' delay
//                and SNR one by one, and the receivers that carried them.
//
// After core.js (state, esc, escAttr, announce), app.js (refreshMapLayers,
// rerenderMapLegend, rerenderMapDisplayControls, focusStationOnMap,
// stationOwner, MAP_PIN_RING), map-controls.js (MapChrome), map-symbols.js
// (MapSymbols), health-analysis.js (HealthAnalysis), health.js
// (Health.fetchReadings, and the analysis the Station Health tab last made),
// health-glance.js (HealthGlance — when each station was last heard),
// signal-routes.js (SignalRoutes.register and attribute — whose carrier) and
// auth.js (Auth — whether the receptions are worth asking for); before init.js. All of it at call time, so its place among the modules is
// free (`npm run toplevel`). Nothing runs at load: initMap() attaches it,
// refreshMapLayers() calls reset() once per rebuild and pinStyle() per pin,
// renderDock() calls shown() when its pane comes into view, the strip's ⏱️
// calls opened() when it is pressed open, 🗺️ Layers' pointer calls showBars(),
// and the station card calls follow() with the station it is on.
//
// ── What "latency" means here ────────────────────────────────────────────────
// Three measures, because "how late is this station's data" is three
// questions and each has a different fault behind it:
//
//   Age      now − when Flood-Net last heard the station. The one that says a
//            station has gone quiet. Absolute bands, on purpose: Colour pins by
//            health (#218) already judges a silence against the station's own
//            check period; this is the plain clock, which is what somebody
//            asking "how old is the data on this part of the map" means.
//   Delay    received_at − reading_ts for each transmission, the first copy to
//            land: how long a reading takes from the air to the database. A
//            serial-monitor base posts in batches (about a minute, measured
//            when this was written: a median of 52 s, 95% inside 84 s) and the
//            MQTT feed in a second or two, so a station whose delay is
//            minutes is behind a receiver that is queuing.
//   Checks   the share of its timed checks that never arrived while a receiver
//            that hears it was listening — the Station Health tab's own slots,
//            from the same HealthAnalysis.run(), so the two cannot disagree.
//            A check most of the network missed at once is the network's and
//            is not counted against the station (`net`).
//
// ── And how strongly it is heard: SNR ────────────────────────────────────────
// A fourth measure, not a latency but read beside them: the signal over the
// receiver's own noise floor that a base station measured for the copy it
// kept (`snr_db`, 0050) — the Message Log's SNR column, reading by reading.
// A station's figure is the median over the window of each transmission's
// strongest copy. Bands from 0083's numbers (backbone.js SNR_FLOOR, SNR_THIN):
// decodes stop at about 8.5 dB, so under 10 dB is marginal and under 12 thin;
// 18 dB and over has room for a bad day's fade. A relayed copy is heard at the
// repeater's strength, so for a station behind a repeater it is the last hop's
// SNR, not the station's own — Backbone's carrier-checked figure is that one.
//
// ── Signal bars: latency and SNR at once ─────────────────────────────────────
// A pin has one fill, so the SNR also has a mark of its own: four rising bars
// on a white plate at the pin's right (MapSymbols draws them, `mnBars`), as
// many lit as its band's — four strong, one marginal — in the band's colour.
// The count says what the colour says. They sit under any colouring: by
// latency, by health or by role, so Age in the fill and SNR in the bars is
// one map. A station with no SNR in the window has none.
//
// ── What it costs ────────────────────────────────────────────────────────────
// Age costs nothing new: it is HealthGlance's one batch of last-heard times,
// which the Stations tab already asks for its Last heard column. Delay,
// Checks and SNR need the readings themselves — the window, 24 h by default
// (about 27,000 readings when this was written, ~27 pages fetched four at a
// time the way Station Health fetches its week) — fetched when the pane is
// first opened, the pins are coloured by one of them or the signal bars are
// on, kept for WIN_TTL, and asked again
// only by ↻, a new window, or a map rebuilt after that. An analysis the Station
// Health tab made of the same window in the last BORROW_TTL is used instead of
// fetching it again.
//
// ── The pins ─────────────────────────────────────────────────────────────────
// Only the fill changes, and the size with it. The shape (a triangle for a
// river height gauge), the Bureau's solid and dashed pink outlines, a filter's
// ring and the selection's are all left as they are — they say things latency
// does not. Colour is never the only channel: the worse bands are a step or two
// bigger, a station never heard is hollow in a dotted ring, one heard before
// the window but not in it hollow in a maroon one, and the pane says every
// figure in words. A gauge read by hand or a TM station that Flood-Net has
// never heard keeps its grey or black: nothing reports it over the radio, so
// its silence is not latency.
//
// The ramp is literals, in both themes, for ROLE_COLOR's reason (design-system
// §1): a Leaflet path option takes no var(), and the base maps do not go dark
// with the app. Green through gold to maroon, saturated enough to read over
// satellite imagery under the white ring every pin wears, and none of them the
// amber of a filter match, the violet of the selection or the pink of an
// outline.
//
// ── One colouring at a time ──────────────────────────────────────────────────
// Latency and Colour pins by health both want the pin's fill, so turning one on
// turns the other off — MapFreq's rule for the links, applied to the pins. The
// switch is remembered, on Colour pins by health's terms, and the first time the
// pane is opened in a session it turns itself on: opening the tool is asking
// for the view. Turned on from all off — colours, animation and bars — it
// brings the other two with it; each has its own box to turn it off again.
//
// ── Messages landing ─────────────────────────────────────────────────────────
// The second half of the view, in a card of its own in the pane: while it is
// on, the log is asked every LIVE_MS for what has landed since it was last
// asked, and each message is played back on the map a beat later in the order
// it landed — its station flaring green and a green pulse running along its
// links, the loading screen's logo (styles.css, .load-logo) on the network
// itself. It needs no colouring of the pins, so it can run under Colour pins
// by health; it comes on with the view (from all off) and has its own box to
// turn it off, and ⏻ at the head of the pane turns the colouring and the
// animation off together. A typed-in or backfilled reading was not sent by
// anybody just now, and is not played.
//
// A pulse runs along the lines the map draws, so with Show radio paths or
// Backbone links/paths off in 🗺️ Layers it has nothing to run on. Animate
// along hidden links (a box of its own under the animation's, off until
// ticked) has refreshMapLayers hand over the links it would have drawn
// (wantsHiddenLinks, hiddenLinks), and the pulses run along those unseen — a
// dense network can keep its lines off the map and still watch each message
// travel. They are the same links the switches would draw: the length limit,
// the owner choice and the filters cut them the same way.
//
// ── Which way it came: heard, assumed, missed ────────────────────────────────
// The log keeps the receiver, not the hops through the air. So by itself the
// pulse runs the way the map draws — the station's pass-range links to its
// repeaters, then the fewest backbone hops on to a base — in blue: assumed,
// the likeliest way in, not a record of it.
//
// An editor may read more: each copy a receiver took (meganet.reception,
// 0047), with the carrier offset it came on. While the log is watched, so are
// the receptions (a page a beat, by id), and each copy is put to its message
// by address and time. What a copy proves is drawn green, heard:
//
//   ALERT2      its path names every hop, the source to the last repeater, and
//               the base station's receiver heard the last.
//   Legacy      the carrier names the last transmitter only. Each receiver's
//               repeater carriers are found over its last CARRIER_H hours of
//               bursts by 0077's rule (SignalRoutes.register and attribute,
//               step for step), and found again as bursts land. A burst on a
//               repeater's carrier was that repeater's — the hop from it to the
//               base station heard, the way from the station to it assumed —
//               and one on no repeater's carrier is the station's own, heard
//               direct, unless its carrier is one many other addresses share
//               at that receiver (onShared): a relay nobody could name — two
//               repeaters with the same ranges on one carrier, which 0077
//               leaves unnamed, or a transmitter the register does not know —
//               which proves nothing of the way.
//
// A base station posts its copies in batches of their own, often a beat after
// its readings, so while they are read a message whose copies are not in yet
// waits for the next ask of them, and plays then with whatever came.
//
// Heard direct, the pulse does not run its alternate path. Instead each of the
// station's pass-range links to a repeater whose carrier that same receiver
// hears, and which nothing heard pass it on, is lit red — missed — for as long
// as the hop that was heard. One receiver's copies are enough to say so: it
// hears the repeater, and it heard the station without it.
//
// A copy that proves nothing (two repeaters' carriers claim it, a duplicate no
// repeater explains, no carrier measured, an ALERT2 address the register does
// not place) is left out when another copy proves something; when none does,
// the pulse runs the blue way it always has. A hop proved but not drawn on the
// map — a station heard direct by a base station, a repeater heard by one with
// no backbone path between them — is drawn straight, pin to pin.
//
// Exposes: attach, detach, reset, shown, opened, showBars, follow, pinStyle, barsFor,
//          legendHtml, liveLegendHtml, barsLegendHtml, altText, barsAltText,
//          noteText, on, anim, hidden, bars, setOn, setAnim, setThroughHidden,
//          setBars, power, wantsHiddenLinks, hiddenLinks, setMode, setWin,
//          setScope, pickBand, back, focus, refresh, yieldTo, and the rules
//          for test/latency.mjs (classifyValue, quantile, BANDS).
const MapLatency = (() => {
  const SEC = 1000, MIN = 60000, HOUR = 3600000, DAY = 86400000;

  const WINDOWS = [
    ['1d', '24 h', 1],
    ['3d', '3 days', 3],
    ['7d', '7 days', 7],
  ];
  // What HealthAnalysis reads off a reading, and no more — HealthGlance's
  // card asks for the same columns — and the kept copy's SNR, for SNR and the
  // signal bars. The other signal columns and the duplicate bookkeeping are
  // the Station Health tab's, not this pane's.
  const SELECT = 'addr,alert_id,a2_station,a2_sensor,station_number,channel,station_id,'
               + 'reading_ts,received_at,value_raw,protocol,path,snr_db';
  // Station Health's own analysis stands in for a fetch while it is this young.
  const BORROW_TTL = 10 * MIN;
  // …and this pane's window is fetched again after this, by a rebuild of the
  // map or the pane coming back into view.
  const WIN_TTL = 15 * MIN;
  // How many stations a band lists before saying how many more.
  const LIST_N = 12;

  // Messages landing (see the header). The log asked on this clock, at most a
  // page at a time — a full page is a backlog, and the rest is asked for at
  // once. The first ask looks back one beat; the card counts LIVE_KEEP.
  const LIVE_MS = 15 * SEC;
  const LIVE_PAGE = 1000;
  const LIVE_KEEP = 5 * MIN;
  const LIVE_SELECT = 'addr,alert_id,a2_station,a2_sensor,station_number,channel,station_id,'
                    + 'reading_ts,received_at,source,path';
  // Typed in and backfilled (0006's seed): nothing was sent just now.
  const LIVE_SKIP_SOURCE = new Set([3, 4]);
  // A station is flashed only on a resolution that names it: not an address
  // several stations share and nothing here tells apart, nor one far from the
  // receiver that heard it (SensorValues.resolver).
  const LIVE_SURE = new Set(['datastore', 'a2', 'sole', 'resolved', 'likely', 'number']);
  // The logo's pulse, in milliseconds and screen pixels. Its node flare is the
  // first 36% of a 2.4 s cycle — [when, opacity, scale], @keyframes ll-flare —
  // and its spark and trail run at one speed, here a little quicker than the
  // logo's 138 px/s for links far longer than its own, and held between a
  // floor and a ceiling so a short hop still shows and a long one does not
  // crawl. A repeater turns a message round before passing it on.
  const CYCLE = 2400;
  const FLARE = [[0, 0, 0.3], [0.04, 1, 1.15], [0.14, 0.8, 1], [0.36, 0, 0.85]];
  const FLARE_MS = CYCLE * 0.36;
  const SPEED = 170;
  const LEG_MIN = 320, LEG_MAX = 1500;
  const TRAIL_PX = 34, SPARK_PX = 9;
  const HOLD_MS = 120;
  const HOPS_MAX = 4, LEGS_MAX = 10, PULSES_MAX = 300;
  // …and after it, the afterglow: each station and link the pulse lit keeps a
  // soft green glow — a ring round the pin, the link lit along its length —
  // so a station that just reported can still be picked out by somebody who
  // looked away. It comes up as that part's own animation ends, holds, then
  // fades: a minute in all. A station heard again starts its glow again, and
  // a repeater lit by many glows once, at the brightest. While only glows are
  // left the canvas is drawn a few times a second, not every frame.
  const GLOW_IN = 400, GLOW_HOLD = 20 * SEC, GLOW_FADE = 40 * SEC;
  const GLOW_TICK = 250, GLOWS_MAX = 2000;
  // With less motion asked for: nothing runs or grows — the station and its
  // links lit, still, for this long.
  const STILL_MS = 1600;
  // Just over MapArrows' pane (405), so a flare is over the pins and the
  // arrows on the shared canvas, and under the name labels (650).
  const PULSE_PANE = 'mnLatPulse', PULSE_Z = 407;

  // What the receivers heard (see the header). A receiver's carriers are found
  // over this many hours of its legacy bursts — about 4,000 rows when this was
  // written, four pages — and the list of receivers and where each one is, and
  // the window after a pause, asked again after CARRIER_TTL. A copy is a
  // message's when it carries the message's address and was heard within
  // RX_MATCH of its reading (an ALERT2 concentrator sends a minute or more
  // after the reading's own time), and is kept RX_KEEP to be matched.
  const CARRIER_H = 12;
  const CARRIER_TTL = 30 * MIN;
  const RX_MATCH = 3 * MIN, RX_KEEP = 6 * MIN;
  const RX_SELECT = 'id,ingest_token_id,point_id,heard_at,protocol,alert_id,cfo_hz,a2_duplicate,a2_source,a2_path';
  const RX_WARM_SELECT = 'id,ingest_token_id,point_id,heard_at,alert_id,cfo_hz,a2_duplicate';
  // A burst no named repeater claims is called heard direct only when its
  // carrier is not one many addresses share at that receiver: SHARED_MIN other
  // addresses or more within SHARED_HZ of it, over SHARED_MS either side, and
  // at least SHARED_SHARE of every address heard then. Stations' own carriers
  // spread over hundreds of hertz, so a 60 Hz window holds about a tenth of
  // them by chance; a crowded one is a relay — two repeaters 0077 cannot tell
  // apart on one carrier, or a transmitter the register does not know. When
  // this was written that was 62% of one receiver's bursts and all but two of
  // another's. The time window is short because a receiver's dongle drifts
  // 70 – 130 Hz over a day, and a relay's carrier with it.
  const SHARED_HZ = 30, SHARED_MS = 90 * MIN, SHARED_MIN = 4, SHARED_SHARE = 0.3;
  // A leg of a pulse, by what is known of it (see the header): its words and
  // their meanings for the card, the 🔑 legend and the hover, and its colours on
  // the canvas — literals, for the logo's reason. Heard is the logo's green.
  // `rank` decides a link two copies disagree on: heard over assumed over missed.
  // `dash` is the line's pattern, so the colour is not the only thing that
  // tells them apart: heard solid, assumed dashed, missed dotted.
  const HOPS = {
    heard: {
      rank: 3, word: 'Heard', dash: [],
      meaning: 'A hop the message is known to have taken: a base station’s receiver heard it on this transmitter’s own '
        + 'carrier, or its ALERT2 path names the hop. Read from the receivers’ copies, which are for editors.',
      trail: '#2bff6a', spark: '#eaffef', sparkGlow: '#5dff8c', glow: 'rgba(30, 235, 95, .9)',
      halo: ['rgba(225, 255, 232, .95)', 'rgba(70, 255, 120, .9)', 'rgba(25, 230, 90, .45)', 'rgba(25, 230, 90, 0)'],
      core: ['#8dffa9', '#1ee35e'], ring: ['rgba(70, 255, 120, .55)', 'rgba(25, 230, 90, .3)', 'rgba(25, 230, 90, 0)'],
    },
    assumed: {
      rank: 2, word: 'Assumed', dash: [9, 6],
      meaning: 'A hop the message most likely took, from the pass ranges and backbone paths on the map — nothing heard says '
        + 'so. A legacy ALERT carrier names only the last transmitter, so the hops before it are assumed.',
      trail: '#3d9eff', spark: '#eef6ff', sparkGlow: '#7cc0ff', glow: 'rgba(45, 140, 255, .9)',
      halo: ['rgba(228, 241, 255, .95)', 'rgba(90, 170, 255, .9)', 'rgba(40, 135, 255, .45)', 'rgba(40, 135, 255, 0)'],
      core: ['#a6d2ff', '#2f8cff'], ring: ['rgba(90, 170, 255, .55)', 'rgba(40, 135, 255, .3)', 'rgba(40, 135, 255, 0)'],
    },
    missed: {
      rank: 1, word: 'Missed', dash: [1.5, 7],
      meaning: 'A repeater that should have passed this message on and was not heard doing so: a receiver that hears this '
        + 'repeater’s carrier heard the station direct, and not through it. Lit for as long as the hop that was heard.',
      trail: '#ff3b3b', glow: 'rgba(255, 45, 45, .9)',
    },
  };
  const HOP_KEYS = ['heard', 'assumed', 'missed'];

  const MODES = {
    age:    { label: 'Age',    title: 'How long since Flood-Net last heard each station',
              long: 'how long since Flood-Net last heard it',
              head: 'How long since each was heard', worst: 'Longest quiet' },
    delay:  { label: 'Delay',  title: 'How long each station’s readings take to reach the database — the median over the window',
              long: 'how long its readings take to reach the database',
              head: 'How long readings take to arrive', worst: 'Slowest to arrive' },
    checks: { label: 'Checks', title: 'The share of each station’s timed checks that went missing over the window',
              long: 'how many of its timed checks went missing',
              head: 'How many checks went missing', worst: 'Most checks missed' },
    snr:    { label: 'SNR',    title: 'How strongly each station is heard: its signal over the receiver’s noise, in dB — the median over the window',
              long: 'its signal over the noise (SNR)',
              head: 'How strongly each is heard', worst: 'Weakest signal' },
  };
  const MODE_KEYS = Object.keys(MODES);

  // Fresh to stale. See the header for why literals and why these.
  const RAMP = ['#1a7f37', '#57a83a', '#a3b92b', '#e0a21b', '#e8711c', '#c8341f', '#6b1717'];
  // A value at or under `max` is in the band. Age in ms, delay in seconds,
  // checks as the share missed. `grow` is pixels on the pin's radius.
  const BANDS = {
    age: [
      { k: 'a0', max: 15 * MIN, label: 'under 15 min', fill: RAMP[0], grow: 0 },
      { k: 'a1', max: HOUR,     label: '15 min – 1 h', fill: RAMP[1], grow: 0 },
      { k: 'a2', max: 3 * HOUR, label: '1 – 3 h',      fill: RAMP[2], grow: 0 },
      { k: 'a3', max: 6 * HOUR, label: '3 – 6 h',      fill: RAMP[3], grow: 1 },
      { k: 'a4', max: DAY,      label: '6 – 24 h',     fill: RAMP[4], grow: 1 },
      { k: 'a5', max: 7 * DAY,  label: '1 – 7 days',   fill: RAMP[5], grow: 2 },
      { k: 'a6', max: Infinity, label: 'over 7 days',  fill: RAMP[6], grow: 2 },
    ],
    delay: [
      { k: 'd0', max: 10,       label: 'under 10 s',   fill: RAMP[0], grow: 0 },
      { k: 'd1', max: 60,       label: '10 s – 1 min', fill: RAMP[1], grow: 0 },
      { k: 'd2', max: 120,      label: '1 – 2 min',    fill: RAMP[2], grow: 0 },
      { k: 'd3', max: 300,      label: '2 – 5 min',    fill: RAMP[3], grow: 1 },
      { k: 'd4', max: 1800,     label: '5 – 30 min',   fill: RAMP[4], grow: 1 },
      { k: 'd5', max: Infinity, label: 'over 30 min',  fill: RAMP[5], grow: 2 },
    ],
    checks: [
      { k: 'c0', max: 0,        label: 'none missed',  fill: RAMP[0], grow: 0 },
      { k: 'c1', max: 0.1,      label: 'under 10%',    fill: RAMP[1], grow: 0 },
      { k: 'c2', max: 0.25,     label: '10 – 25%',     fill: RAMP[3], grow: 1 },
      { k: 'c3', max: 0.5,      label: '25 – 50%',     fill: RAMP[4], grow: 1 },
      { k: 'c4', max: Infinity, label: 'over half',    fill: RAMP[5], grow: 2 },
    ],
    // SNR runs the other way — more is better — so a band is the least it
    // reaches, strongest first like every list here. `bars` is how many of the
    // four signal bars it lights, and `word` its name, meant in WORDS.
    snr: [
      { k: 's0', min: 18,        label: '18 dB and over', word: 'Strong',   fill: RAMP[0], grow: 0, bars: 4 },
      { k: 's1', min: 12,        label: '12 – 18 dB',     word: 'Fair',     fill: RAMP[2], grow: 0, bars: 3 },
      { k: 's2', min: 10,        label: '10 – 12 dB',     word: 'Thin',     fill: RAMP[4], grow: 1, bars: 2 },
      { k: 's3', min: -Infinity, label: 'under 10 dB',    word: 'Marginal', fill: RAMP[5], grow: 2, bars: 1 },
    ],
  };
  // Where decodes stop, in dB over the noise (0083, backbone.js SNR_FLOOR).
  const SNR_FLOOR = 8.5;
  // The words the SNR half of the pane uses that mean something here, and
  // what each means — on hover where it is used, and in words in the pane's
  // fold (wordsHtml). One list, so a chip and the fold never say it two ways.
  const WORDS = {
    SNR: 'Signal-to-noise ratio: how far a station’s signal stood above the base station receiver’s own background '
      + 'noise, in decibels (dB) — the SNR column of the Message Log. Every 3 dB is twice the power; decodes stop at '
      + `about ${SNR_FLOOR} dB. A station’s figure is the median over the window, each transmission’s strongest copy. `
      + 'For one heard through a repeater it is the repeater’s last hop, not the station’s own signal.',
    Strong: 'Heard 18 dB or more over the noise: room for a bad day’s fade, rain on the path or a noisy neighbour.',
    Fair: 'Heard 12 to 18 dB over the noise: decodes reliably, with a few dB to spare for a fade.',
    Thin: `Heard 10 to 12 dB over the noise — within 3.5 dB of the ${SNR_FLOOR} dB where decodes stop. A fade or rain on `
      + 'the path can take its readings under.',
    Marginal: `Heard under 10 dB over the noise — within 1.5 dB of the ${SNR_FLOOR} dB where decodes stop. Expect lost `
      + 'readings; look at its antenna, cable, connectors and path.',
    'SNR at a receiver': 'The median signal over the noise of the copies this receiver kept, in dB. One station is heard '
      + 'at a different SNR at each base station — it is the path — so compare a receiver with itself.',
    'Signal bars': 'Four rising bars beside a pin, as many lit as its SNR band’s — four strong, three fair, two thin, one '
      + 'marginal — in the band’s colour. They show under any colouring of the pins, so latency and signal read at once.',
  };
  // What is not a band. `fill: null` leaves the pin as the map would draw it
  // without this view (a gauge read by hand keeps its grey). The rings are
  // black-ish rather than white for HealthGlance's reason: a dash has to show
  // against the tiles, and a white one vanished into the topo base.
  const SPECIAL = {
    never:   { label: 'never heard', fill: '#ffffff', ring: '#4f6478', weight: 2, dash: '1,3', grow: -1,
               key: 'never' },
    quiet:   { label: 'heard before the window, not in it', fill: '#ffffff', ring: RAMP[6], weight: 2.5, dash: null, grow: 0,
               key: 'quiet' },
    unknown: { label: null, fill: '#ffffff', ring: '#4f6478', weight: 2, dash: null, grow: 0, key: 'unknown' },
    offair:  { label: 'read by hand or by modem, not heard by radio', fill: null, key: 'offair' },
  };
  // A measure that could not be worked out for a station heard in the window,
  // said for the measure.
  const UNKNOWN_LABEL = {
    age:    'not known',
    delay:  'heard, no arrival times',
    checks: 'heard, no check schedule learned',
    snr:    'heard, no SNR recorded',
  };
  // Which of them a mode can produce: Age is known for every station heard, so
  // it has no "heard, but…" of its own.
  const SPECIAL_ORDER = ['quiet', 'unknown', 'never', 'offair'];
  const specialsFor = mode => (mode === 'age' ? ['never', 'offair'] : SPECIAL_ORDER);

  // The Station Health tab's slot outcomes, its words and its classes, so the
  // strip here reads the same as the strip there.
  const OUTCOME = {
    hit:     { label: 'received',              cls: 'hl-slot--hit' },
    partial: { label: 'received, frames lost', cls: 'hl-slot--partial' },
    miss:    { label: 'missed',                cls: 'hl-slot--miss' },
    net:     { label: 'missed network-wide',   cls: 'hl-slot--net' },
    unknown: { label: 'no receiver listening', cls: 'hl-slot--unknown' },
  };

  const stored = (k, ok, dflt) => {
    try { const v = localStorage.getItem(k); return ok.includes(v) ? v : dflt; } catch (_) { return dflt; }
  };
  const keep = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* private browsing — still works this session */ } };

  // The view's settings. `on`, `anim`, `bars` and the mode and window are
  // remembered; the rest is the session's. The animation and the bars are new
  // since the colouring, so a device that has never said either way gets them
  // with the view as it stands.
  const onAtLoad = stored('mn-map-latency', ['on', 'off'], 'off') === 'on';
  const U = {
    on: onAtLoad,
    anim: stored('mn-latency-anim', ['on', 'off'], onAtLoad ? 'on' : 'off') === 'on',
    hidden: stored('mn-latency-hidden', ['on', 'off'], 'off') === 'on',   // run along hidden links too
    bars: stored('mn-latency-bars', ['on', 'off'], onAtLoad ? 'on' : 'off') === 'on',
    mode: stored('mn-latency-mode', MODE_KEYS, 'age'),
    win: stored('mn-latency-win', WINDOWS.map(w => w[0]), '1d'),
    scope: 'view',           // 'view' | 'all'
    band: null,              // the band whose stations are listed, or null for the worst
    sel: null,               // the station the pane is about, or null for the summary
    lastCard: null,          // the station card's station, as last told (follow)
    autoOn: false,           // the pane has turned the view on once this session
    announce: false,         // the next answer to land is one somebody asked for
  };
  // The window: its readings, worked out.
  const W = {
    key: null, status: 'idle', A: null, t0: null, t1: null, at: 0, rows: 0, fetched: 0,
    capped: false, error: '', denied: false, seq: 0, borrowed: false,
  };

  let map = null;
  let root = null;
  let classes = new Map();     // mode → (station id → classification), this rebuild's
  let classesAt = 0;
  const statMemo = new Map();  // station id → the delay and check figures off W.A
  let pinTimer = null;
  let paintTimer = null;
  let netHooked = false;
  let resizeObs = null;
  let paintedW = 0;

  // The log being watched: where the last ask got to (the newest received_at
  // it saw, as the datastore wrote it, so `gt` cannot see the same row twice),
  // and what landed, a batch an ask, for the card's count.
  const LV = {
    status: 'idle', cursor: null, timer: null, seq: 0, at: 0, since: 0, error: '', fails: 0,
    batches: [], fired: [], firedN: 0, held: new Map(),
  };
  // The receivers' copies being watched beside it (editors only): where the
  // last ask got to (the newest reception id seen), each receiver's place and
  // its window of measured legacy bursts with the repeater carriers found in
  // it, and the copies kept to be matched. `status`: off (nobody here may read
  // them), warming, ok, none (asked, and nothing came back) or error. `fed`:
  // a test laid them (_hear), and they are not asked for.
  const RX = {
    status: 'off', fed: false, seq: 0, cursor: null, first: true, error: '',
    warmAt: 0, triedAt: 0, pointsAt: 0, pausedAt: 0,
    points: new Map(),    // 'token|point' → the station the receiver is at, or null
    bursts: new Map(),    // 'token|point' → [{ id, a, cfo, dup, t, how, rid }]
    kept: new Map(),      // 'token|point' → Map(repeater id → its carrier's centre, Hz)
    copies: [],           // [{ id, pk, t, proto, a, src2, path2, b }]
    played: 0, matched: 0,
  };
  let carrierReg = null, carrierRegFor = null, carrierRegN = 0, carrierRegAt = 0;
  let a2Idx = null, a2IdxFor = null;
  const liveTimers = new Set();  // the plays still to come from the last answer
  let pulses = [];
  let pcanvas = null, pctx = null, praf = null, porigin = null, glowTimer = null;
  let graph = null, graphFor = null;
  // The links the map would draw but is hiding, from refreshMapLayers, while
  // the pulses are to run along them (hiddenLinks).
  let unseen = { field: [], backbone: [] };
  let pinIdx = null, pinIdxFor = null, pinIdxN = 0;
  let visHooked = false;

  const now_ = () => Date.now();
  const num = n => (n == null ? '—' : Number(n).toLocaleString());
  const pct = (a, b) => (b ? Math.round(100 * a / b) : 0);
  const errText = err => (err && err.message) || String(err || 'unknown error');
  const isDenied = err => !!err && (err.status === 401 || err.status === 403 || err.status === 404);
  const stations = () => (state.data && state.data.stations) || [];
  const stationById = id => stations().find(s => s.id === id) || null;
  const winOf = k => WINDOWS.find(w => w[0] === k) || WINDOWS[0];
  const fmtWhen = (t, now) => HealthAnalysis.fmtWhen(t, now);
  const fmtSpan = ms => HealthAnalysis.fmtSpan(ms);
  const p2 = n => String(n).padStart(2, '0');
  const fmtHm = t => { const d = new Date(t); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };
  const fmtHms = t => `${fmtHm(t)}:${p2(new Date(t).getSeconds())}`;
  const calm = () => { try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (_) { return false; } };
  const fmtDay = t => new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  // A receiver as people say it, as Station Health says it.
  const hostLabel = h => String(h || '').replace(/^serial-monitor\//, '').replace(/^meganet\/v1\/([^/]+)\/logger\/reading\//, '$1 · ');

  // A delay in seconds, short: "1.6 s", "52 s", "4.5 min", "2.1 h".
  function fmtDelay(s) {
    if (s == null || !isFinite(s)) return '—';
    const a = Math.abs(s);
    const sign = s < 0 ? '−' : '';
    if (a < 10) return `${sign}${a.toFixed(1)} s`;
    if (a < 90) return `${sign}${Math.round(a)} s`;
    if (a < 90 * 60) return `${sign}${(a / 60).toFixed(a < 600 ? 1 : 0)} min`;
    return `${sign}${(a / 3600).toFixed(1)} h`;
  }
  // An SNR in dB, to a tenth: "11.8 dB".
  const fmtDb = v => (v == null || !isFinite(v) ? '—' : `${Number(v).toFixed(1)} dB`);
  // An SNR band's word, its meaning on hover.
  const wordHtml = b => (b && b.word ? termHtml(b.word, WORDS[b.word]) : '');
  const snrTerm = () => termHtml('SNR', WORDS.SNR);

  // An age in ms, short, as the station list's Last heard column says it.
  function fmtAge(ms) {
    if (ms == null) return '—';
    if (ms < 90 * SEC) return 'just now';
    return `${fmtSpan(ms)} ago`;
  }

  // ── The rules (pure) ───────────────────────────────────────────────────────

  // The value at `q` of a list of numbers, interpolated; null for none.
  function quantile(list, q) {
    const a = (list || []).filter(x => x != null && isFinite(x)).sort((x, y) => x - y);
    if (!a.length) return null;
    const i = (a.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return a[lo] + (a[hi] - a[lo]) * (i - lo);
  }
  // The band a value is in, for a mode. A negative delay — a receiver whose
  // clock runs ahead — is the fastest band: the reading did not arrive before
  // it was heard, but nothing about it was late.
  function classifyValue(mode, v) {
    const list = BANDS[mode] || BANDS.age;
    // SNR the other way: the first band whose least it reaches.
    if (mode === 'snr') return list.find(b => Number(v) >= b.min) || list[list.length - 1];
    const x = Math.max(0, Number(v) || 0);
    return list.find(b => x <= b.max) || list[list.length - 1];
  }

  // ── What is known about one station ───────────────────────────────────────

  // Delay, checks and SNR, off the window's analysis, once per analysis.
  function statsOf(S) {
    const id = S.st.id;
    let m = statMemo.get(id);
    if (m) return m;
    const series = [];             // { t, d } — each transmission's first arrival, seconds
    const snrs = [];               // { t, v } — each transmission's strongest copy, dB
    const byPath = new Map();
    for (const tx of S.txs || []) {
      let rt = Infinity, best = -Infinity;
      for (const c of tx.copies || []) {
        const snr = c.snr != null && isFinite(c.snr) ? c.snr : null;
        if (c.rt == null && snr == null) continue;
        let p = byPath.get(c.path);
        if (!p) byPath.set(c.path, p = { path: c.path, host: c.host, d: [], s: [], last: 0 });
        if (snr != null) { p.s.push(snr); if (snr > best) best = snr; }
        if (c.rt == null) continue;
        if (c.rt < rt) rt = c.rt;
        p.d.push((c.rt - c.t) / SEC);
        if (c.t > p.last) p.last = c.t;
      }
      if (isFinite(rt)) series.push({ t: tx.t, d: (rt - tx.t) / SEC });
      if (isFinite(best)) snrs.push({ t: tx.t, v: best });
    }
    series.sort((a, b) => a.t - b.t);
    snrs.sort((a, b) => a.t - b.t);
    const ds = series.map(x => x.d);
    const vs = snrs.map(x => x.v);
    const sch = S.schedule;
    m = {
      delay: ds.length ? { p50: quantile(ds, 0.5), p95: quantile(ds, 0.95), max: Math.max(...ds), n: ds.length,
                           newest: series[series.length - 1] } : null,
      series,
      snr: vs.length ? { p50: quantile(vs, 0.5), min: Math.min(...vs), max: Math.max(...vs),
                         n: vs.length, newest: snrs[snrs.length - 1] } : null,
      snrs,
      paths: [...byPath.values()]
        .map(p => ({ path: p.path, host: p.host, n: Math.max(p.d.length, p.s.length), p50: quantile(p.d, 0.5), p95: quantile(p.d, 0.95),
                     snr: quantile(p.s, 0.5), last: p.last }))
        .sort((a, b) => b.n - a.n),
      checks: sch && sch.counts ? Object.assign({}, sch.counts, { rate: sch.missRate || 0, P: sch.P }) : null,
    };
    statMemo.set(id, m);
    return m;
  }

  // Whether the last-heard batch has answered, or a card has.
  function netKnown() {
    const c = HealthGlance.counts ? HealthGlance.counts() : null;
    return !!(c && c.okAt);
  }
  function lastHeardOf(s) {
    const k = HealthGlance.known ? HealthGlance.known(s.id) : null;
    let last = k && k.lastHeard != null ? k.lastHeard : null;
    const S = W.A ? W.A.stations.get(s.id) : null;
    if (S && S.lastHeard != null && (last == null || S.lastHeard > last)) last = S.lastHeard;
    return last;
  }
  // Read by hand or a TM station: the radio never hears it, by its record.
  function offAir(s) {
    const k = MapSymbols.kind ? MapSymbols.kind(s) : null;
    return !!(k && (k.manual || k.tm));
  }

  // One station, for one mode: { key, band?, value?, last }. key is a band's
  // `k`, a SPECIAL key, 'asking' (the answer is on its way) or 'proposed'.
  function classify(s, mode, now) {
    if (!s || s.proposed) return { key: 'proposed' };
    const last = lastHeardOf(s);
    const air = offAir(s);
    if (mode === 'age') {
      if (last == null) return { key: !netKnown() && !W.A ? 'asking' : air ? 'offair' : 'never', last };
      const v = Math.max(0, now - last);
      const band = classifyValue('age', v);
      return { key: band.k, band, value: v, last };
    }
    if (!W.A) return { key: 'asking', last };
    const S = W.A.stations.get(s.id);
    const st = S ? statsOf(S) : null;
    if (mode === 'delay' && st && st.delay) {
      const band = classifyValue('delay', st.delay.p50);
      return { key: band.k, band, value: st.delay.p50, last, st };
    }
    if (mode === 'checks' && st && st.checks && st.checks.due > 0) {
      const band = classifyValue('checks', st.checks.rate);
      return { key: band.k, band, value: st.checks.rate, last, st };
    }
    if (mode === 'snr' && st && st.snr) {
      const band = classifyValue('snr', st.snr.p50);
      return { key: band.k, band, value: st.snr.p50, last, st };
    }
    // Heard in the window — through its own readings, or by the ingest's
    // record of an address it shares with another station — and the measure
    // still not worked out.
    if (S || (last != null && last >= W.t0)) return { key: 'unknown', last, st };
    if (last != null) return { key: 'quiet', last };
    return { key: air ? 'offair' : netKnown() ? 'never' : 'asking', last };
  }

  // Every station's class at once, per rebuild and per answer — never per pin.
  // Per measure: the pins can wear one and the signal bars another, on one clock.
  function classOf(s, mode = U.mode) {
    let m = classes.get(mode);
    if (!m) {
      if (!classes.size) classesAt = now_();
      m = new Map();
      for (const x of stations()) m.set(x.id, classify(x, mode, classesAt));
      classes.set(mode, m);
    }
    return m.get(s.id) || classify(s, mode, classesAt || now_());
  }
  function dirty() { classes = new Map(); }

  // ── The pins ──────────────────────────────────────────────────────────────

  // What refreshMapLayers lays over a pin's own style while the view is on:
  // { cls, fill, ring, grow, weight, dash }, or null — the view off, the
  // answer not in yet, or a station this view leaves as it is.
  function pinStyle(s) {
    if (!U.on || !s) return null;
    const c = classOf(s);
    const ring = typeof MAP_PIN_RING !== 'undefined' ? MAP_PIN_RING : '#ffffff';
    if (c.band) return { cls: c.key, fill: c.band.fill, ring, grow: c.band.grow, weight: null, dash: null };
    const sp = SPECIAL[c.key];
    if (!sp || !sp.fill) return null;
    return { cls: c.key, fill: sp.fill, ring: sp.ring, grow: sp.grow, weight: sp.weight, dash: sp.dash };
  }

  // What refreshMapLayers hands MapSymbols to draw beside a pin while the
  // signal bars are on, under whatever colours the pin — { cls, n, fill }: its
  // SNR band, how many of the four bars it lights and their colour. Null with
  // the bars off, the readings not in yet, or no SNR from it in the window.
  function barsFor(s) {
    if (!U.bars || !s || !W.A) return null;
    const c = classOf(s, 'snr');
    return c.band ? { cls: c.key, n: c.band.bars, fill: c.band.fill } : null;
  }

  // The pins again, once, when an answer lands or the mode changes.
  function repins() {
    if (pinTimer) return;
    pinTimer = setTimeout(() => {
      pinTimer = null;
      dirty();
      if ((U.on || U.bars) && state.activeTab === 'stations' && state.map && typeof refreshMapLayers === 'function') {
        refreshMapLayers({ skipFit: true });
      }
      if (typeof rerenderMapLegend === 'function') rerenderMapLegend();
      paint();
    }, 0);
  }

  // Once per map rebuild, from refreshMapLayers: the classes are worked out
  // again (the clock has moved), and whatever the pins need is asked for.
  function reset() {
    dirty();
    // The lines and pins a pulse runs along were all just replaced: the next
    // one finds them again (graphNow, pinFor), and the log is watched if it
    // should be and is not yet.
    if (U.anim) liveSync();
    if (U.bars) ensureWindow(false);
    if (!U.on) return;
    if (HealthGlance.askNet) HealthGlance.askNet();
    if (U.mode !== 'age') ensureWindow(false);
  }

  // ── The switch, the mode, the window ──────────────────────────────────────

  function setOn(on, opts = {}) {
    // Somebody's own choice, made once, is the session's from then on.
    if (!opts.auto) U.autoOn = true;
    const wasOff = !U.on && !U.anim;
    const barsToo = !!on && wasOff && !U.bars;
    U.on = !!on;
    keep('mn-map-latency', U.on ? 'on' : 'off');
    // The view turned on from all off brings the messages animated with it,
    // and the signal bars from everything off — their boxes in the pane are
    // the way to have the colours without them.
    const animToo = U.on && wasOff;
    if (animToo) { U.anim = true; keep('mn-latency-anim', 'on'); liveSync(); }
    if (barsToo) { U.bars = true; keep('mn-latency-bars', 'on'); ensureWindow(false); }
    // One colouring of the pins at a time: health gives way.
    if (U.on && state.mapHealth) {
      state.mapHealth = false;
      keep('mn-map-health', 'off');
      if (typeof rerenderMapDisplayControls === 'function') rerenderMapDisplayControls();
    }
    if (U.on) {
      if (HealthGlance.askNet) HealthGlance.askNet();
      if (U.mode !== 'age') ensureWindow(false);
    }
    dirty();
    if (!opts.quiet) {
      announce(U.on ? `Pins coloured by ${U.mode === 'snr' ? 'signal' : 'latency'} — ${MODES[U.mode].long}.${animToo ? ' Messages flash on the map as they land in the log.' : ''}${barsToo ? ' Signal bars beside the pins say each station’s SNR.' : ''} ${summaryText()}`
                    : 'Pins are back in their roles’ colours.');
    }
    if (typeof refreshMapLayers === 'function' && state.map) refreshMapLayers({ skipFit: true });
    if (typeof rerenderMapLegend === 'function') rerenderMapLegend();
    paint();
  }

  // The message animation's own box. It colours nothing, so it leaves the
  // pins and Colour pins by health as they are.
  function setAnim(on, opts = {}) {
    U.anim = !!on;
    keep('mn-latency-anim', U.anim ? 'on' : 'off');
    liveSync();
    if (U.hidden) refreshForHidden();
    if (!opts.quiet) {
      announce(U.anim ? 'Messages flash on the map as they land in the log.' : 'Messages are no longer animated on the map.');
    }
    if (typeof rerenderMapLegend === 'function') rerenderMapLegend();
    paint();
  }

  // Animate along hidden links: the map is rebuilt so it hands over the links
  // it is hiding (or stops), when there are any.
  function setThroughHidden(on) {
    U.hidden = !!on;
    keep('mn-latency-hidden', U.hidden ? 'on' : 'off');
    refreshForHidden();
    announce(U.hidden ? 'Messages run along the links even where the map hides them.'
                      : 'Messages run only along the links the map draws.');
    paint();
  }
  function refreshForHidden() {
    if ((!state.mapShowLinks || !state.mapShowBackbone) && state.map && typeof refreshMapLayers === 'function') {
      refreshMapLayers({ skipFit: true });
    }
  }
  // For refreshMapLayers: whether to hand over the links it is not drawing,
  // and the handing over — a pass-range link { s, r } per field station and
  // repeater, a backbone path { a, b, kind } per pair.
  const wantsHiddenLinks = () => !!(U.anim && U.hidden);
  function hiddenLinks(field, backbone) {
    unseen = { field: field || [], backbone: backbone || [] };
    graph = null;
  }

  // The signal bars' own box. They colour nothing, so they sit under the
  // latency colours, Colour pins by health or the roles alike.
  function setBars(on, opts = {}) {
    U.bars = !!on;
    keep('mn-latency-bars', U.bars ? 'on' : 'off');
    if (U.bars) ensureWindow(false);
    dirty();
    if (!opts.quiet) {
      announce(U.bars ? `Signal bars beside the pins: each station’s SNR, four bars strong to one marginal. ${W.A ? snrSummaryText() : ''}`
                      : 'Signal bars off.');
    }
    if (typeof refreshMapLayers === 'function' && state.map) refreshMapLayers({ skipFit: true });
    if (typeof rerenderMapLegend === 'function') rerenderMapLegend();
    paint();
  }

  // ⏻ at the head of the pane: everything off at once — the pins' colours,
  // the signal bars and the animation — or, from all off, the view on with all
  // three.
  function power() {
    U.autoOn = true;
    if (!U.on && !U.anim && !U.bars) { setOn(true); return; }
    U.anim = false;
    keep('mn-latency-anim', 'off');
    liveSync();
    const hadBars = U.bars;
    U.bars = false;
    keep('mn-latency-bars', 'off');
    if (U.on) setOn(false, { quiet: true });
    else {
      if (hadBars && typeof refreshMapLayers === 'function' && state.map) refreshMapLayers({ skipFit: true });
      if (typeof rerenderMapLegend === 'function') rerenderMapLegend();
      paint();
    }
    announce('Latency view off — the pins are back in their roles’ colours, with no signal bars, and no messages are animated.');
  }
  // Colour pins by health was turned on: this view gives way, without a word —
  // the switch that was pressed says what the pins are now.
  function yieldTo() {
    if (!U.on) return;
    U.on = false;
    keep('mn-map-latency', 'off');
    dirty();
    paint();
  }

  function setMode(m) {
    if (!MODES[m] || m === U.mode) return;
    U.mode = m;
    U.band = null;
    keep('mn-latency-mode', m);
    dirty();
    if (m !== 'age') { U.announce = W.status !== 'ok'; ensureWindow(false); }
    if (U.on) repins();
    else paint();
    if (W.status === 'ok' || m === 'age') announce(`${MODES[m].label}: ${summaryText()}`);
  }

  function setWin(k) {
    if (!WINDOWS.some(w => w[0] === k)) return;
    const same = k === U.win;
    U.win = k;
    keep('mn-latency-win', k);
    U.announce = true;
    ensureWindow(!same ? false : true);
    paint();
  }

  function setScope(sc) {
    if (sc !== 'view' && sc !== 'all') return;
    U.scope = sc;
    U.band = null;
    paint();
  }

  function pickBand(k) {
    U.band = U.band === k ? null : k;
    paint();
  }

  function refresh() {
    U.announce = true;
    if (HealthGlance.askAgain && U.mode === 'age') HealthGlance.askAgain();
    ensureWindow(true);
    paint();
  }

  // ── The window ────────────────────────────────────────────────────────────

  function ensureWindow(force) {
    if (W.status === 'loading' || W.status === 'working') { if (W.key === U.win && !force) return; }
    const fresh = W.status === 'ok' && W.key === U.win && now_() - W.at < WIN_TTL;
    if (!force && fresh) return;
    if (!force && borrow()) return;
    fetchWindow();
  }

  // The Station Health tab's analysis of the same window, if it made one lately.
  function borrow() {
    if (typeof Health === 'undefined' || !Health.state) return false;
    let hs = null;
    try { hs = Health.state(); } catch (_) { return false; }
    const A = hs && hs.A;
    if (!A || hs.demo || A.now == null || now_() - A.now > BORROW_TTL || A.t0 == null || A.t1 == null) return false;
    if (Math.abs((A.t1 - A.t0) / DAY - winOf(U.win)[2]) > 0.05) return false;
    W.seq++;
    adoptA(A, { t0: A.t0, t1: A.t1, rows: hs.rows ? hs.rows.length : (A.counts ? A.counts.rows : 0), capped: false, borrowed: true });
    return true;
  }

  async function fetchWindow() {
    if (typeof Health === 'undefined' || !Health.fetchReadings) return;
    const seq = ++W.seq;
    const t1 = now_(), t0 = t1 - winOf(U.win)[2] * DAY;
    Object.assign(W, { key: U.win, status: 'loading', fetched: 0, error: '', denied: false });
    paintStatus();
    let got = null;
    try {
      got = await Health.fetchReadings(t0, t1, {
        select: SELECT,
        alive: () => seq === W.seq,
        onPage: n => { W.fetched = n; paintStatusSoon(); },
      });
    } catch (err) {
      if (seq !== W.seq) return;
      Object.assign(W, { status: 'error', at: now_(), error: errText(err), denied: isDenied(err) });
      if (U.announce) { U.announce = false; announce('Latency: the readings could not be fetched.'); }
      paint();
      return;
    }
    if (seq !== W.seq) return;
    W.status = 'working';
    paintStatus();
    // A frame for the status line to say so before the analysis takes the
    // thread for half a second.
    await new Promise(r => setTimeout(r, 30));
    if (seq !== W.seq) return;
    let A = null;
    try {
      A = HealthAnalysis.run(got.rows, { t0, t1, now: t1 });
    } catch (err) {
      Object.assign(W, { status: 'error', at: now_(), error: 'the analysis failed: ' + errText(err), denied: false });
      if (typeof recordError === 'function') recordError({ kind: 'latency', message: W.error, where: '', stack: (err && err.stack) || '' });
      paint();
      return;
    }
    adoptA(A, { t0, t1, rows: got.rows.length, capped: got.capped, borrowed: false });
  }

  function adoptA(A, o) {
    Object.assign(W, { key: U.win, status: 'ok', A, t0: o.t0, t1: o.t1, at: now_(), rows: o.rows || 0,
                       capped: !!o.capped, borrowed: !!o.borrowed, error: '', denied: false });
    statMemo.clear();
    dirty();
    if (U.announce) { U.announce = false; announce(`Latency worked out from ${num(W.rows)} readings over ${winOf(U.win)[1]}. ${summaryText()}`); }
    if ((U.on && U.mode !== 'age') || U.bars) repins();
    else { if (typeof rerenderMapLegend === 'function' && U.on) rerenderMapLegend(); paint(); }
  }

  // ── The stations being summed up ──────────────────────────────────────────

  function scopeList() {
    const b = U.scope === 'view' && map ? map.getBounds() : null;
    return stations().filter(s => s.lat != null && s.lon != null && !s.proposed
      && (!MapSymbols.drawn || MapSymbols.drawn(s))
      && (!b || b.contains([s.lat, s.lon])));
  }

  // Everything the summary says, in one pass over the scope.
  function summary() {
    const list = scopeList();
    const now = classesAt || now_();
    const bands = new Map();
    const ages = [];
    let heard = 0, hour = 0, day = 0, week = 0, never = 0, offair = 0;
    const delays = [];
    let due = 0, got = 0, missed = 0, netMissed = 0, scheduled = 0;
    // Each station's SNR band, whatever the pins wear: the bars' count.
    const snrBands = new Map();
    const snrMeds = [];
    for (const s of list) {
      const c = classOf(s);
      bands.set(c.key, (bands.get(c.key) || 0) + 1);
      if (W.A) {
        const cs = classOf(s, 'snr');
        if (cs.band) { snrBands.set(cs.key, (snrBands.get(cs.key) || 0) + 1); snrMeds.push(cs.value); }
      }
      const last = c.last != null ? c.last : lastHeardOf(s);
      if (last != null) {
        heard++;
        const a = now - last;
        ages.push(a);
        if (a <= HOUR) hour++;
        if (a > DAY) day++;
        if (a > 7 * DAY) week++;
      } else if (offAir(s)) offair++;
      else never++;
      if (W.A) {
        const S = W.A.stations.get(s.id);
        if (S) {
          const st = statsOf(S);
          for (const x of st.series) delays.push(x.d);
          if (st.checks) {
            scheduled++;
            due += st.checks.due;
            got += st.checks.hits + st.checks.partial;
            missed += st.checks.misses;
            netMissed += st.checks.net;
          }
        }
      }
    }
    return {
      list, bands, n: list.length, heard, hour, day, week, never, offair,
      medAge: quantile(ages, 0.5),
      delay: delays.length ? { p50: quantile(delays, 0.5), p95: quantile(delays, 0.95), n: delays.length } : null,
      checks: { due, got, missed, net: netMissed, scheduled },
      snr: { p50: quantile(snrMeds, 0.5), n: snrMeds.length, bands: snrBands,
             thin: snrBands.get('s2') || 0, edge: snrBands.get('s3') || 0 },
    };
  }

  // The stations of one band, or the worst of the scope: worst first.
  function listFor(sum, band) {
    const now = classesAt || now_();
    const rows = sum.list.map(s => ({ s, c: classOf(s) }));
    const keyed = band ? rows.filter(r => r.c.key === band)
      : rows.filter(r => r.c.band);
    // The weakest signal is the worst, where the longest wait is.
    const sign = U.mode === 'snr' ? -1 : 1;
    const score = r => (r.c.value != null ? sign * r.c.value : r.c.last != null ? now - r.c.last : -1);
    keyed.sort((a, b) => score(b) - score(a) || String(a.s.name).localeCompare(String(b.s.name)));
    return keyed;
  }

  function valueText(c, mode, now) {
    if (c.band) {
      if (mode === 'age') return fmtAge(c.value);
      if (mode === 'delay') return fmtDelay(c.value);
      if (mode === 'snr') return fmtDb(c.value);
      const k = c.st && c.st.checks;
      return k ? `${num(k.misses)} of ${num(k.due)} missed` : `${Math.round(100 * c.value)}%`;
    }
    if (c.key === 'quiet' && c.last != null) return `last ${fmtAge(now - c.last)}`;
    if (c.key === 'unknown') return UNKNOWN_LABEL[mode];
    const sp = SPECIAL[c.key];
    return sp && sp.label ? sp.label : '';
  }

  function summaryText() {
    if (U.mode !== 'age' && !W.A) {
      return W.status === 'error' ? 'The readings could not be fetched.' : 'Fetching the readings…';
    }
    const t = summary();
    const where = U.scope === 'view' ? 'in view' : 'on the map';
    const parts = [];
    BANDS[U.mode].forEach(b => { const n = t.bands.get(b.k) || 0; if (n) parts.push(`${num(n)} ${b.label}`); });
    specialsFor(U.mode).forEach(k => {
      const n = t.bands.get(k) || 0;
      if (n) parts.push(`${num(n)} ${k === 'unknown' ? UNKNOWN_LABEL[U.mode] : SPECIAL[k].label}`);
    });
    return `${num(t.n)} stations ${where}: ${parts.join(', ') || 'none'}.`;
  }

  // The signal bars, said: how many stations in scope are in each SNR band.
  function snrSummaryText(t) {
    if (!W.A) return W.status === 'error' ? 'The readings could not be fetched.' : 'Fetching the readings…';
    t = t || summary();
    const where = U.scope === 'view' ? 'in view' : 'on the map';
    const parts = BANDS.snr.map(b => [b, t.snr.bands.get(b.k) || 0]).filter(([, n]) => n)
      .map(([b, n]) => `${num(n)} ${b.word.toLowerCase()} (${b.label})`);
    return parts.length ? `SNR of ${num(t.snr.n)} stations ${where}: ${parts.join(', ')}.` : `No SNR recorded for the stations ${where}.`;
  }

  // ── The pane ──────────────────────────────────────────────────────────────

  // The signal bars as MapSymbols draws them beside a pin — four on a white
  // plate, `n` lit in `fill` — for the pane's and the legend's keys.
  function barsSvg(n, fill) {
    let b = '';
    for (let i = 0; i < 4; i++) {
      const h = 3 + 2 * i;
      b += `<rect x="${1.5 + 3 * i}" y="${10.5 - h}" width="2" height="${h}" fill="${i < n ? escAttr(fill) : 'rgba(79,100,120,.28)'}"/>`;
    }
    return `<svg class="lat-sig" viewBox="0 0 14 12" width="14" height="12" aria-hidden="true" focusable="false">`
      + `<rect x=".5" y=".5" width="13" height="11" rx="2.5" fill="#fff" stroke="rgba(31,41,51,.45)"/>${b}</svg>`;
  }

  const seg = (label, items, cur, fn) => `
    <span class="lat-seg" role="group" aria-label="${escAttr(label)}">${items.map(([k, text, title]) => `
      <button type="button" class="lat-chip${cur === k ? ' is-on' : ''}" aria-pressed="${cur === k}"
              data-lat-f="${escAttr(fn + ':' + k)}" ${title ? `title="${escAttr(title)}"` : ''}
              onclick="MapLatency.${fn}('${escAttr(k)}')">${esc(text)}</button>`).join('')}
    </span>`;

  // ⏻, over everything else in the pane. Pressed while anything here is on.
  const POWER_SVG = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">'
    + '<path d="M5 3.4a5.6 5.6 0 1 0 6 0" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>'
    + '<path d="M8 1.6v5.6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>';
  function powerHtml() {
    const any = U.on || U.anim || U.bars;
    const what = !any ? 'Everything here is off'
      : [U.on ? 'Pins coloured' : 'Pins in their own colours', U.bars ? 'signal bars' : '',
         U.anim ? 'messages animated' : 'animation off'].filter(Boolean).join(' · ');
    return `
      <div class="lat-power-row">
        <button type="button" class="lat-power${any ? ' is-on' : ''}" aria-pressed="${any}" data-lat-f="power"
                onclick="MapLatency.power()"
                title="${escAttr(any ? 'Turn the whole latency view off at once — the pins’ colours, the signal bars and the message animation'
                                     : 'Turn the latency view on — pins coloured by latency, signal bars beside them, and messages animated as they land')}">
          <span class="lat-power-ico">${POWER_SVG}</span>Latency view <span class="lat-power-state">${any ? 'On' : 'Off'}</span>
        </button>
        <span class="small txt-muted">${esc(what)}</span>
      </div>`;
  }

  function controlsHtml() {
    return `
      <div class="lat-controls">
        ${powerHtml()}
        <label class="filter-check lat-switch"
               title="Colour every station pin by latency or by its signal instead of by its role. Its shape and the Bureau's outlines stay as they are.">
          <input type="checkbox" data-lat-f="on" ${U.on ? 'checked' : ''} onchange="MapLatency.setOn(this.checked)">
          Colour pins by latency or signal
        </label>
        <div class="lat-row"><span class="lat-row-h" aria-hidden="true">Colour by</span>
          ${seg('Colour by', MODE_KEYS.map(k => [k, MODES[k].label, MODES[k].title]), U.mode, 'setMode')}</div>
        <label class="filter-check lat-switch"
               title="${escAttr(WORDS['Signal bars'])}">
          <input type="checkbox" data-lat-f="bars" ${U.bars ? 'checked' : ''} onchange="MapLatency.setBars(this.checked)">
          ${barsSvg(3, BANDS.snr[1].fill)} Signal bars beside the pins
        </label>
        <p class="small txt-muted lat-bars-what">Each station’s ${snrTerm()}, four bars strong to one marginal, under any
          colouring — so Age, Delay or Checks in the pins and the signal beside them read at once.</p>
        <div class="lat-row"><span class="lat-row-h" aria-hidden="true">Readings</span>
          ${seg('Readings from the last', WINDOWS.map(([k, label]) => [k, label, `Delay, checks and SNR from the last ${label} of readings`]), U.win, 'setWin')}
          <button type="button" class="link-btn lat-again" data-lat-f="again" onclick="MapLatency.refresh()"
                  title="Ask the datastore again — last-heard times and the window's readings">↻</button></div>
        <p class="small lat-status" id="lat-status" role="status">${statusHtml()}</p>
      </div>`;
  }

  function statusHtml() {
    const w = winOf(U.win)[1];
    if (W.status === 'loading') return `Fetching the last ${esc(w)} of readings… ${W.fetched ? `${num(W.fetched)} so far` : ''}`;
    if (W.status === 'working') return `Working out ${num(W.fetched)} readings…`;
    if (W.status === 'error') {
      return `<span class="txt-warn">${W.denied ? 'The datastore would not let this browser read the readings'
        : `The readings could not be fetched (${esc(W.error)})`}</span> — delay, checks and SNR are not known.
        <button type="button" class="link-btn" data-lat-f="retry" onclick="MapLatency.refresh()">Try again</button>`;
    }
    if (W.status === 'ok') {
      const span = W.t1 && W.t0 ? esc(fmtSpan(W.t1 - W.t0)) : esc(w);
      return `${num(W.rows)} readings over ${span}, to ${esc(fmtWhen(W.t1))}${W.borrowed ? ' — the Station Health tab’s, worked out ' + esc(fmtAge(now_() - W.at)) : ''}${W.capped ? ' <span class="txt-warn">(stopped at the cap)</span>' : ''}.`;
    }
    return 'Delay, checks and SNR come from the readings, fetched when they are first wanted.';
  }

  function paneHtml() {
    const s = U.sel ? stationById(U.sel) : null;
    return controlsHtml() + liveHtml() + `<div class="lat-body" id="lat-body">${s ? stationHtml(s) : summaryHtml()}</div>`;
  }

  // ── The messages card ──

  function liveHtml() {
    return `
      <section class="lat-live${U.anim ? ' is-on' : ''}" aria-labelledby="lat-h-live">
        <div class="lat-live-head"><span class="lat-live-dot" aria-hidden="true"></span>
          <h4 class="lat-h" id="lat-h-live">Messages landing</h4></div>
        <label class="filter-check lat-switch"
               title="Flash each station green on the map as a message from it lands in the log, with a pulse along its links">
          <input type="checkbox" data-lat-f="anim" ${U.anim ? 'checked' : ''} onchange="MapLatency.setAnim(this.checked)">
          Animate messages on the map
        </label>
        <label class="filter-check filter-sub${U.anim ? '' : ' is-off'}"
               title="Run the pulses along the radio links even when Show radio paths or Backbone links/paths is off in 🗺️ Layers — the lines stay off the map, and each message lights its way as it travels">
          <input type="checkbox" data-lat-f="hidden" ${U.hidden ? 'checked' : ''} ${U.anim ? '' : 'disabled'}
                 onchange="MapLatency.setThroughHidden(this.checked)">
          Animate along hidden links
        </label>
        <p class="small txt-muted lat-live-what">As a message lands in the log its station flashes green, and a pulse
          runs along its links — to the repeater that carries it, then on to a base station. Each keeps a glow for a
          minute after, so a station that just reported can still be picked out. Its colour says what is known of
          each hop:</p>
        <ul class="lat-hop-key small">${HOP_KEYS.map(k => `
          <li><span class="lat-hop lat-hop--${k}" aria-hidden="true"></span>
            <span><strong>${termHtml(HOPS[k].word, HOPS[k].meaning)}</strong> — ${esc(HOPS[k].meaning)}</span></li>`).join('')}
        </ul>
        <p class="small lat-live-what"><strong class="txt-bad lat-live-guess">Blue runs the way the map draws the network:
          the likeliest way in, not a record of the hops.</strong></p>
        <p class="small lat-live-status" id="lat-live-status">${liveStatusHtml()}</p>
      </section>`;
  }

  // What the receivers' copies are adding, for the card's status line.
  function rxStatusHtml() {
    if (RX.status === 'off') {
      return 'Every hop is blue: which ones were heard comes from the receivers’ copies, which are for editors — sign in as one to see them.';
    }
    if (RX.status === 'warming') return `Finding the carriers each receiver hears, from its last ${CARRIER_H} h of bursts…`;
    if (RX.status === 'none') return 'Every hop is blue: no receiver’s copies came back for this account — they are for editors.';
    if (RX.status === 'error') {
      return `<span class="txt-warn">The receivers’ copies could not be read (${esc(RX.error)})</span> — every hop is blue until they can.`;
    }
    let reps = 0;
    const rx = new Set();
    RX.kept.forEach((m, pk) => { if (m.size) { reps += m.size; rx.add(pk); } });
    const found = reps
      ? `${num(reps)} repeater carrier${reps === 1 ? '' : 's'} found on ${num(rx.size)} receiver${rx.size === 1 ? '' : 's'}`
      : 'no repeater’s carrier found yet';
    const matched = RX.played
      ? ` ${num(RX.matched)} of the ${num(RX.played)} message${RX.played === 1 ? '' : 's'} played matched to the copies that carried ${RX.played === 1 ? 'it' : 'them'}.`
      : '';
    return `Receivers’ copies read: ${found} over the last ${CARRIER_H} h.${matched}`;
  }

  function liveStatusHtml() {
    if (!U.anim) return 'Off — the log is not being watched.';
    const still = calm() ? ' Shown still: this device asks for less motion.' : '';
    if (LV.status === 'error') {
      return `<span class="txt-warn">The log could not be read (${esc(LV.error)})</span> — asking again shortly.${still}`;
    }
    if (!LV.at) return `Watching the log…${still}<br>${rxStatusHtml()}`;
    const now = now_();
    let n = 0, lost = 0;
    const ids = new Set();
    for (const b of LV.batches) {
      if (now - b.at > LIVE_KEEP) continue;
      n += b.n; lost += b.lost;
      b.ids.forEach(id => ids.add(id));
    }
    const since = now - LV.since >= LIVE_KEEP ? `in the last ${esc(fmtSpan(LIVE_KEEP))}` : `since ${esc(fmtHms(LV.since))}`;
    const head = n
      ? `${num(n)} message${n === 1 ? '' : 's'} from ${num(ids.size)} station${ids.size === 1 ? '' : 's'} ${since}`
        + (lost ? ` · ${num(lost)} not on the map` : '')
      : `Nothing has landed ${since}`;
    return `${head}. Asked at ${esc(fmtHms(LV.at))}, every ${LIVE_MS / SEC} s.${still}<br>${rxStatusHtml()}`;
  }

  // ── The summary ──

  function tile(label, value, sub, cls) {
    return `<div class="adm-kpi lat-kpi${cls ? ' ' + cls : ''}"><div class="adm-kpi-label">${label}</div>
      <div class="adm-kpi-value">${value}</div><div class="adm-kpi-sub">${sub}</div></div>`;
  }

  function swatch(key, mode) {
    const b = (BANDS[mode] || []).find(x => x.k === key);
    if (b) return `<span class="lat-key" style="--dot:${b.fill}" aria-hidden="true"></span>`;
    return `<span class="lat-key lat-key--${esc(key)}" aria-hidden="true"></span>`;
  }

  function summaryHtml() {
    const t = summary();
    const mode = U.mode;
    const now = classesAt || now_();
    const glance = HealthGlance.counts ? HealthGlance.counts() : { status: 'idle' };
    const scope = U.scope === 'view' ? 'in view' : 'on the map';
    const head = `
      <div class="lat-sum-head">
        <h4 class="lat-h" id="lat-h-sum">${num(t.n)} station${t.n === 1 ? '' : 's'} ${scope}</h4>
        ${seg('Which stations', [['view', 'In view', 'The stations in the map’s view — move the map and this follows'], ['all', 'Whole map', 'Every station the map draws']], U.scope, 'setScope')}
      </div>`;
    if (!t.n) {
      return head + `<p class="small lat-empty">No stations ${scope}. Move the map, or look at the whole map.</p>`;
    }
    const ageTiles = !netKnown() && !W.A
      ? tile('Heard in the last hour', '…', glance.status === 'error' ? 'the datastore could not be asked' : 'asking when each was last heard')
        + tile('Quiet over a day', '…', '')
      : tile('Heard in the last hour', `${num(t.hour)} <small>of ${num(t.heard)}</small>`,
          `${pct(t.hour, t.heard)}% of those ever heard${t.never ? ` · ${num(t.never)} never heard` : ''}`,
          t.heard && t.hour / t.heard >= 0.5 ? 'adm-kpi--ok' : '')
        + tile('Quiet over a day', num(t.day),
          t.day ? `${num(t.week)} of them over a week · median age ${esc(t.medAge != null ? fmtSpan(t.medAge) : '—')}`
                : `median age ${esc(t.medAge != null ? fmtSpan(t.medAge) : '—')}`,
          t.day ? 'adm-kpi--warn' : 'adm-kpi--ok');
    const winTiles = W.A
      ? tile('Delay to the database', t.delay ? esc(fmtDelay(t.delay.p50)) : '—',
          t.delay ? `median of ${num(t.delay.n)} transmissions · 95% within ${esc(fmtDelay(t.delay.p95))}` : 'nothing heard in the window',
          t.delay && t.delay.p50 > 120 ? 'adm-kpi--warn' : '')
        + tile('Checks received', t.checks.due ? `${pct(t.checks.got, t.checks.due)}%` : '—',
          t.checks.due ? `${num(t.checks.got)} of ${num(t.checks.due)} · ${num(t.checks.missed)} missed${t.checks.net ? ` · ${num(t.checks.net)} network-wide` : ''}`
                       : 'no check schedule learned here',
          t.checks.due && t.checks.missed / t.checks.due > 0.1 ? 'adm-kpi--warn' : t.checks.due ? 'adm-kpi--ok' : '')
      : tile('Delay to the database', '…', W.status === 'error' ? 'the readings could not be fetched' : 'fetching the readings')
        + tile('Checks received', '…', '');
    const sn = t.snr;
    const snrTiles = W.A
      ? tile(`Signal (${snrTerm()})`, sn.n ? esc(fmtDb(sn.p50)) : '—',
          sn.n ? `the middle of ${num(sn.n)} ${sn.n === 1 ? 'station’s median' : 'stations’ medians'} · decodes stop near ${SNR_FLOOR} dB` : 'no SNR recorded here',
          sn.n && sn.p50 < 12 ? 'adm-kpi--warn' : sn.n ? 'adm-kpi--ok' : '')
        + tile('Weak signal', sn.n ? `${num(sn.thin + sn.edge)} <small>of ${num(sn.n)}</small>` : '—',
          sn.n ? `under 12 dB · ${num(sn.thin)} ${termHtml('thin', WORDS.Thin)}, ${num(sn.edge)} ${termHtml('marginal', WORDS.Marginal)}` : '',
          sn.edge ? 'adm-kpi--warn' : sn.n ? 'adm-kpi--ok' : '')
      : tile(`Signal (${snrTerm()})`, '…', W.status === 'error' ? 'the readings could not be fetched' : 'fetching the readings')
        + tile('Weak signal', '…', '');
    return head + `<div class="adm-kpis lat-kpis">${ageTiles}${winTiles}${snrTiles}</div>` + barsHtml(t, mode, now)
      + receiversHtml() + netEventsHtml() + footHtml(mode) + wordsHtml();
  }

  // The scope by band, for the mode the pins wear — the legend, counted, and
  // each row the way to the stations in it.
  function barsHtml(t, mode, now) {
    if (mode !== 'age' && !W.A) return '';
    const bands = BANDS[mode].map(b => ({ k: b.k, label: b.label, word: b.word, n: t.bands.get(b.k) || 0 }));
    const other = specialsFor(mode).map(k => ({ k, label: k === 'unknown' ? UNKNOWN_LABEL[mode] : SPECIAL[k].label, n: t.bands.get(k) || 0 }))
      .filter(r => r.n);
    // The bars are read against each other, so they are scaled to the bands
    // alone: a thousand stations nobody has heard would make every band a sliver.
    const max = Math.max(1, ...bands.map(r => r.n));
    const h = 'lat-h-bars';
    const list = listFor(t, U.band);
    const pick = U.band ? bands.concat(other).find(r => r.k === U.band) : null;
    const shown = list.slice(0, LIST_N);
    const row = (r, bar) => `
        <li><button type="button" class="lat-bar${U.band === r.k ? ' is-on' : ''}" aria-pressed="${U.band === r.k}"
                data-lat-f="${escAttr('band:' + r.k)}" ${r.n ? '' : 'disabled'}
                onclick="MapLatency.pickBand('${escAttr(r.k)}')"
                title="${escAttr(r.n ? `List the ${r.n} station${r.n === 1 ? '' : 's'} ${r.label}` : `None ${r.label}`)}">
          ${swatch(r.k, mode)}<span class="lat-bar-label">${r.word ? `${wordHtml(r)} · ` : ''}${esc(r.label)}</span>
          ${bar ? `<span class="lat-bar-track" aria-hidden="true"><span class="lat-bar-fill" style="width:${(100 * r.n / max).toFixed(1)}%;--dot:${escAttr(barColour(r.k, mode))}"></span></span>` : ''}
          <span class="lat-bar-n">${num(r.n)}</span></button></li>`;
    return `
      <h4 class="lat-h" id="${h}">${esc(MODES[mode].head)}</h4>
      <ul class="lat-bars" aria-labelledby="${h}">${bands.map(r => row(r, true)).join('')}</ul>
      ${other.length ? `<ul class="lat-bars lat-bars--other" aria-label="Not on that scale">${other.map(r => row(r, false)).join('')}</ul>` : ''}
      <h5 class="lat-h5">${pick ? `${esc(pick.label[0].toUpperCase() + pick.label.slice(1))} — ${num(list.length)}` : `${esc(MODES[mode].worst)} ${esc(scopeWord())}`}</h5>
      ${shown.length ? `<ol class="lat-list">${shown.map(r => `
        <li><button type="button" class="link-btn" data-lat-f="${escAttr('stn:' + r.s.id)}"
                onclick="MapLatency.focus('${escAttr(r.s.id)}')" title="Show ${escAttr(r.s.name || r.s.id)} on the map, and its latency here">${esc(r.s.name || r.s.id)}</button>
          <span class="lat-list-v">${swatch(r.c.key, mode)} ${esc(valueText(r.c, mode, now))}</span></li>`).join('')}</ol>
        ${list.length > shown.length ? `<p class="small txt-muted">…and ${num(list.length - shown.length)} more. Zoom the map in to narrow it down.</p>` : ''}`
        : '<p class="small txt-muted">None.</p>'}`;
  }
  const scopeWord = () => (U.scope === 'view' ? 'in view' : 'on the map');
  function barColour(k, mode) {
    const b = (BANDS[mode] || []).find(x => x.k === k);
    if (b) return b.fill;
    return k === 'quiet' ? RAMP[6] : '#7b8189';
  }

  // The receivers, and how long each takes to deliver — the network's half of
  // delay, where a queue behind one base station shows up as one row.
  function receiversHtml() {
    if (!W.A || !(W.A.receivers || []).length) return '';
    const now = W.t1 || now_();
    const rx = W.A.receivers.slice(0, 12);
    return `
      <h4 class="lat-h" id="lat-h-rx">Receivers over ${esc(fmtSpan(W.t1 - W.t0))}</h4>
      <div class="lat-table-wrap"><table class="lat-table" aria-labelledby="lat-h-rx">
        <thead><tr><th scope="col">Receiver</th><th scope="col" class="num">Readings</th>
          <th scope="col" class="num" title="Median time from being heard to reaching the database">Delay</th>
          <th scope="col" class="num" title="95 in every 100 readings reached the database within this">95%</th>
          <th scope="col" class="num">Last</th></tr></thead>
        <tbody>${rx.map(h => `<tr>
          <td><span class="mono" title="${escAttr(h.host)}">${esc(hostLabel(h.host))}</span></td>
          <td class="num">${num(h.n)}</td>
          <td class="num${h.lag && h.lag.p50 > 120 ? ' txt-warn' : ''}">${esc(fmtDelay(h.lag ? h.lag.p50 : null))}</td>
          <td class="num">${esc(fmtDelay(h.lag ? h.lag.p95 : null))}</td>
          <td class="num${now - h.last > HOUR ? ' txt-warn' : ''}">${esc(now - h.last < 90 * SEC ? 'now' : fmtSpan(now - h.last))}</td></tr>`).join('')}
        </tbody></table></div>`;
  }

  function netEventsHtml() {
    const ev = W.A && W.A.netEvents;
    if (!ev || !ev.length) return '';
    const last = ev.slice(-4).reverse();
    return `<p class="small lat-net"><span aria-hidden="true">⚠</span> ${num(ev.length)} moment${ev.length === 1 ? '' : 's'} when most of the
      network missed its checks at once — the receivers, a channel or interference, not the stations:
      ${last.map(e => `${esc(fmtWhen(e.from))} (${num(e.missed)} of ${num(e.due)})`).join(', ')}.</p>`;
  }

  function footHtml(mode) {
    const what = {
      age: 'Age is how long since Flood-Net last heard each station — from the ingest’s record, so it reaches back further than the window.',
      delay: 'Delay is how long a reading takes from being heard to reaching the database — each transmission’s first copy to land, the median over the window.',
      checks: 'Checks are each station’s timed reports, learned from its own rhythm. A miss counts only while a receiver that hears it was listening, and one most of the network missed at once is the network’s.',
      snr: 'SNR is how far each station’s signal stood above the receiver’s noise, as the base station measured the copy it kept — the Message Log’s SNR column. A station’s figure is the median over the window of each transmission’s strongest copy; one heard through a repeater carries the repeater’s last hop.',
    }[mode];
    return `<p class="small txt-muted lat-foot">${esc(what)} Pick a station on the map to see its checks slot by slot${mode === 'snr' ? ' and its SNR reading by reading' : ''}.</p>`;
  }

  // The signal words with their meanings, for a finger or a keyboard, which
  // never hover: the same list the hovers read (WORDS) — with a station's, the
  // receivers' column too.
  function wordsHtml(rx) {
    const keys = ['SNR', ...BANDS.snr.map(b => b.word), 'Signal bars', ...(rx ? ['SNR at a receiver'] : [])];
    return `
      <details class="lat-words small">
        <summary>What the signal words here mean</summary>
        <dl>${keys.map(k => {
          const b = BANDS.snr.find(x => x.word === k);
          return `<dt>${b ? barsSvg(b.bars, b.fill) + ' ' : ''}${esc(k)}${b ? ` <span class="txt-muted">${esc(b.label)}</span>` : ''}</dt><dd>${esc(WORDS[k])}</dd>`;
        }).join('')}</dl>
      </details>`;
  }

  // ── One station ──

  function stationHtml(s) {
    const now = now_();
    const c = classify(s, U.mode, now);
    const ca = classify(s, 'age', now);
    const last = ca.last;
    const S = W.A ? W.A.stations.get(s.id) : null;
    const st = S ? statsOf(S) : null;
    const sch = S && S.schedule;
    const k = MapSymbols.kind ? MapSymbols.kind(s) : null;
    const what = [
      s.station_number ? `No. ${esc(s.station_number)}` : '',
      k && k.river ? 'river height gauge' : k && k.rain ? 'rain gauge' : '',
      k && k.manual ? 'read by hand' : k && k.tm ? 'TM station' : '',
    ].filter(Boolean).join(' · ');
    const role = k && k.role === 'forecast' ? '<span class="lat-pill lat-pill--forecast">Forecast location</span>'
      : k && k.role === 'information' ? '<span class="lat-pill lat-pill--info">Information location</span>' : '';
    const back = `<button type="button" class="link-btn lat-back" data-lat-f="back" onclick="MapLatency.back()">
      <span aria-hidden="true">←</span> The stations ${esc(scopeWord())}</button>`;
    const head = `${back}
      <div class="lat-stn-head"><h4 class="lat-h" id="lat-h-stn">${esc(s.name || s.id)}</h4>${role}</div>
      ${what ? `<p class="small txt-muted lat-stn-what">${what}</p>` : ''}`;

    // Last heard, against its checks.
    let ageSub = '';
    if (last == null) ageSub = ca.key === 'offair' ? 'read by hand or by modem — the radio does not hear it' : ca.key === 'asking' ? 'asking…' : 'Flood-Net’s receivers have not heard it';
    else {
      ageSub = esc(fmtWhen(last, now));
      const gone = sch ? Math.floor((now - last) / sch.P) : 0;
      if (gone >= 2) ageSub += ` · <span class="txt-warn">${num(gone)} checks gone by</span>`;
    }
    const ai = ca.band ? BANDS.age.indexOf(ca.band) : -1;
    const ageTile = tile('Last heard', last == null ? (ca.key === 'asking' ? '…' : 'never') : esc(fmtAge(now - last)),
      ageSub, ai < 0 ? '' : ai <= 2 ? 'adm-kpi--ok' : ai >= 4 ? 'adm-kpi--warn' : '');
    const delayTile = !W.A ? tile('Delay', '…', W.status === 'error' ? 'the readings could not be fetched' : 'fetching the readings')
      : st && st.delay ? tile('Delay', esc(fmtDelay(st.delay.p50)),
          `median of ${num(st.delay.n)} · 95% within ${esc(fmtDelay(st.delay.p95))} · newest ${esc(fmtDelay(st.delay.newest.d))}`,
          st.delay.p50 > 120 ? 'adm-kpi--warn' : '')
      : tile('Delay', '—', S ? 'no arrival times in the window' : `nothing from it in the last ${esc(winOf(U.win)[1])}`);
    const checkTile = !W.A ? tile('Checks', '…', '')
      : sch ? tile('Checks received', st.checks.due ? `${pct(st.checks.hits + st.checks.partial, st.checks.due)}%` : '—',
          `every ${esc(HealthAnalysis.fmtPeriod(sch.P))} · ${num(st.checks.hits + st.checks.partial)} of ${num(st.checks.due)}, ${num(st.checks.misses)} missed`
            + (st.checks.net ? `, ${num(st.checks.net)} network-wide` : '') + (st.checks.partial ? ` · ${num(st.checks.partial)} with frames lost` : ''),
          st.checks.due && st.checks.misses / st.checks.due > 0.1 ? 'adm-kpi--warn' : st.checks.due ? 'adm-kpi--ok' : '')
      : tile('Checks', '—', S ? `no regular schedule learned from ${num((S.bursts || []).length)} report${(S.bursts || []).length === 1 ? '' : 's'} — it may report on events only`
                              : 'nothing from it in the window');

    // The fourth: when its next check is due, while its schedule is known —
    // the time to watch the map for it — else how many receivers carry it.
    const nextTile = sch ? tile('Next check', esc(fmtHm(nextCheck(sch, now))),
        `in ${esc(nextCheck(sch, now) - now < 90 * SEC ? 'a minute' : fmtSpan(nextCheck(sch, now) - now))} · at ${esc(slotTimes(sch))}`)
      : st && st.paths.length ? tile('Heard through', `${num(st.paths.length)} <small>receiver${st.paths.length === 1 ? '' : 's'}</small>`,
        esc(st.paths.map(p => hostLabel(p.path)).slice(0, 2).join(', ')))
      : '';
    // And how strongly it is heard: its SNR band's bars and word with the figure.
    const cs = classify(s, 'snr', now);
    const snrTile = !W.A ? tile(`Signal (${snrTerm()})`, '…', '')
      : st && st.snr ? tile(`Signal (${snrTerm()})`, `${barsSvg(cs.band.bars, cs.band.fill)} ${esc(fmtDb(st.snr.p50))}`,
          `${wordHtml(cs.band)} · median of ${num(st.snr.n)} · lowest ${esc(fmtDb(st.snr.min))}, newest ${esc(fmtDb(st.snr.newest.v))}`,
          cs.band.bars <= 2 ? 'adm-kpi--warn' : 'adm-kpi--ok')
      : tile(`Signal (${snrTerm()})`, '—', S ? 'its readings carry no SNR — no base station that measures one kept them'
                                            : 'nothing from it in the window');
    let body = `<div class="adm-kpis lat-kpis">${ageTile}${delayTile}${checkTile}${nextTile}${snrTile}</div>`;
    if (c.band || SPECIAL[c.key]) {
      body += `<p class="small lat-stn-band">${swatch(c.key, U.mode)} On the map now: <b>${esc(c.band ? c.band.label
        : c.key === 'unknown' ? UNKNOWN_LABEL[U.mode] : (SPECIAL[c.key].label || ''))}</b> — ${esc(MODES[U.mode].long)}.</p>`;
    }
    if (W.A && !S) {
      const longer = WINDOWS.filter(w => w[2] > winOf(U.win)[2]);
      body += `<p class="small">Nothing from it in the last ${esc(winOf(U.win)[1])}${last != null && last < W.t0 ? `; it was last heard ${esc(fmtWhen(last, now))}` : ''}.
        ${longer.length ? `${longer.map(([kk, label]) => `<button type="button" class="link-btn" data-lat-f="${escAttr('win:' + kk)}" onclick="MapLatency.setWin('${kk}')">Look back ${esc(label)}</button>`).join(' · ')}` : ''}</p>`;
    }
    if (sch && S.slots && S.slots.length) body += stripHtml(S);
    if (st && st.series.length) body += delayChartHtml(s, st);
    if (st && st.snrs.length) body += snrChartHtml(s, st);
    if (st && st.paths.length) body += pathsHtml(st);
    body += `<div class="button-group lat-stn-links">
        <button type="button" class="ghost" data-lat-f="health" onclick="MapLatency.openHealth('${escAttr(s.id)}')"
                title="The Station Health tab on this station — its findings, battery and the network at any missed check">Open in Station Health</button>
      </div>`;
    if (st && st.snr) body += wordsHtml(st.paths.length > 0);
    return head + body;
  }

  function nextCheck(sch, now) {
    return sch.phase + Math.ceil((now - sch.phase) / sch.P) * sch.P;
  }
  // A day's first few slot times, from the phase: "00:27, 00:57, 01:27 …".
  function slotTimes(sch) {
    const day0 = new Date(); day0.setHours(0, 0, 0, 0);
    const base = day0.getTime();
    const out = [];
    for (let t = sch.phase + Math.ceil((base - sch.phase) / sch.P) * sch.P; t < base + DAY && out.length < 3; t += sch.P) out.push(fmtHm(t));
    return out.join(', ') + (DAY / sch.P > 3 ? ' …' : '');
  }

  // The available width for a drawing in the pane: what the pane measures,
  // or the default pane's when it is not on screen to be measured.
  function paneWidth() {
    const w = root ? root.clientWidth : 0;
    return Math.max(260, (w || 450) - 4);
  }

  // Its checks, slot by slot, a row a day — the Station Health tab's strip,
  // fitted to the pane: a column of misses at the same hour every night is a
  // battery, a run of them an outage, scattered ones a path.
  function stripHtml(S) {
    const slots = S.slots;
    const P = S.schedule.P;
    const days = new Map();
    slots.forEach(sl => {
      const d = new Date(sl.t); d.setHours(0, 0, 0, 0);
      const k = d.getTime();
      if (!days.has(k)) days.set(k, []);
      days.get(k).push(sl);
    });
    const perDay = Math.max(1, Math.round(DAY / P));
    const labW = 74, gap = 2;
    const pitch = Math.max(5, Math.min(18, Math.floor((paneWidth() - labW) / perDay)));
    // Square cells while there is room; past that, narrower but never shorter
    // than a finger's worth of target or a row's label.
    const cell = pitch - gap, cellH = Math.max(cell, 10), rowH = Math.max(cellH + 4, 15);
    const W_ = labW + perDay * pitch, H_ = days.size * rowH + 16;
    const rows = [...days.entries()].sort((a, b) => a[0] - b[0]);
    let svg = '';
    // The hours along the top — where in its day a miss fell — as often as
    // there is room for "06:00" between them.
    const every = [3, 6, 12].find(h => (h * HOUR / P) * pitch >= 34);
    for (let h = 0; every && h < 24; h += every) {
      const x = labW + (h * HOUR / P) * pitch;
      svg += `<text class="hl-axis" x="${x.toFixed(1)}" y="10">${p2(h)}:00</text>`;
    }
    rows.forEach(([d0, list], r) => {
      const y = 16 + r * rowH;
      svg += `<text class="hl-axis" x="0" y="${y + cellH - 1}">${esc(fmtDay(d0))}</text>`;
      list.forEach(sl => {
        const i = Math.min(perDay - 1, Math.floor((sl.t - d0) / P));
        const x = labW + i * pitch;
        const o = OUTCOME[sl.outcome] || OUTCOME.unknown;
        svg += `<rect class="hl-slot ${o.cls}" x="${x}" y="${y}" width="${cell}" height="${cellH}" rx="1.5"><title>${esc(fmtWhen(sl.t))} — ${esc(o.label)}${sl.missing && sl.missing.length ? ' (no ' + esc(sl.missing.join(', ')) + ')' : ''}</title></rect>`;
        if (sl.outcome === 'miss' && cell >= 7) {
          svg += `<path class="hl-slot-x" d="M${x + 2} ${y + 2}L${x + cell - 2} ${y + cellH - 2}M${x + cell - 2} ${y + 2}L${x + 2} ${y + cellH - 2}"/>`;
        }
      });
    });
    const c = S.schedule.counts;
    const missed = slots.filter(sl => sl.outcome === 'miss').slice(-10).reverse();
    const nets = slots.filter(sl => sl.outcome === 'net').length;
    return `
      <h4 class="lat-h" id="lat-h-strip">Its checks, slot by slot</h4>
      <div class="hl-strip-wrap lat-strip-wrap">
        <svg class="lat-strip" viewBox="0 0 ${W_} ${H_}" width="${W_}" height="${H_}" role="img"
             aria-label="${escAttr(`${S.st.name}: ${slots.length} check slots, every ${HealthAnalysis.fmtPeriod(P)}, a row a day — ${c.hits} received, ${c.partial} with frames lost, ${c.misses} missed${c.net ? `, ${c.net} missed network-wide` : ''}${c.unknown ? `, ${c.unknown} with no receiver listening` : ''}. The missed ones are listed under it.`)}">${svg}</svg>
      </div>
      <div class="qs-legend">${Object.values(OUTCOME).map(o => `<span><i class="hl-key ${o.cls}" aria-hidden="true"></i>${esc(o.label)}</span>`).join('')}</div>
      <p class="small lat-missed">${missed.length
        ? `Missed while a receiver that hears it was listening${c.misses > missed.length ? ` — the latest ${num(missed.length)} of ${num(c.misses)}` : ''}: ${missed.map(sl => esc(fmtWhen(sl.t))).join(', ')}.`
        : 'No check missed while a receiver that hears it was listening.'}${nets ? ` ${num(nets)} more went when most of the network missed at once.` : ''}</p>`;
  }

  // Its readings' delay, one dot a transmission, on a log scale from a second
  // to an hour: a band along the bottom is a receiver posting as it hears; a
  // band at a minute, a base station posting in batches; dots climbing to an
  // hour, a queue that had to drain.
  function delayChartHtml(s, st) {
    const W_ = paneWidth(), H_ = 132, L = 38, R = 6, T = 8, B = 20;
    const t0 = W.t0, t1 = W.t1;
    const lo = Math.log10(1), hi = Math.log10(3600);
    const x = t => L + (W_ - L - R) * (t - t0) / Math.max(1, t1 - t0);
    const y = d => {
      const v = Math.log10(Math.min(3600, Math.max(1, d)));
      return T + (H_ - T - B) * (1 - (v - lo) / (hi - lo));
    };
    let g = '';
    [[1, '1 s'], [10, '10 s'], [60, '1 min'], [600, '10 min'], [3600, '1 h']].forEach(([v, label]) => {
      const yy = y(v).toFixed(1);
      g += `<line class="lat-grid" x1="${L}" x2="${W_ - R}" y1="${yy}" y2="${yy}"/><text class="hl-axis" x="${L - 4}" y="${(+yy + 3.5).toFixed(1)}" text-anchor="end">${label}</text>`;
    });
    // A tick a day along the bottom.
    const d0 = new Date(t0); d0.setHours(0, 0, 0, 0);
    const step = t1 - t0 > 3 * DAY ? DAY : t1 - t0 > DAY ? 12 * HOUR : 6 * HOUR;
    for (let t = d0.getTime(); t <= t1; t += step) {
      if (t < t0) continue;
      const xx = x(t).toFixed(1);
      const lab = step >= DAY || new Date(t).getHours() === 0 ? fmtDay(t).replace(/,.*$/, '') : fmtHm(t);
      g += `<line class="lat-grid" x1="${xx}" x2="${xx}" y1="${T}" y2="${H_ - B}"/><text class="hl-axis" x="${xx}" y="${H_ - 6}" text-anchor="middle">${esc(lab)}</text>`;
    }
    const pts = st.series;
    // Thousands of dots are one path, not thousands of elements.
    let d = '';
    pts.forEach(p => { const xx = x(p.t).toFixed(1), yy = y(p.d).toFixed(1); d += `M${xx} ${yy}h0.01`; });
    const med = y(st.delay.p50).toFixed(1);
    const lateN = pts.filter(p => p.d > 300).length;
    return `
      <h4 class="lat-h" id="lat-h-delay">Its delay, reading by reading</h4>
      <svg class="lat-delay" viewBox="0 0 ${W_} ${H_}" width="${W_}" height="${H_}" role="img"
           aria-label="${escAttr(`${s.name}: ${pts.length} transmissions over ${fmtSpan(t1 - t0)}; the median reached the database ${fmtDelay(st.delay.p50)} after it was heard, 95% within ${fmtDelay(st.delay.p95)}, the slowest ${fmtDelay(st.delay.max)}${lateN ? `; ${lateN} took over five minutes` : ''}. Its receivers are listed under it.`)}">
        ${g}
        <line class="lat-med" x1="${L}" x2="${W_ - R}" y1="${med}" y2="${med}"/>
        <path class="lat-dots" d="${d}"/>
      </svg>
      <p class="small txt-muted lat-cap">One dot a transmission: from being heard to the database, the first copy to land. The dashed line is the median, ${esc(fmtDelay(st.delay.p50))}${lateN ? `; <span class="txt-warn">${num(lateN)} took over five minutes</span>` : ''}.</p>`;
  }

  // Its SNR, one dot a transmission (the strongest copy), on a scale from 5 to
  // 30 dB with where decodes stop dotted red: a steady
  // band is a steady path; a slide towards the floor, an antenna, a cable or a
  // connector going; a night of dips, rain or a fade.
  function snrChartHtml(s, st) {
    const W_ = paneWidth(), H_ = 132, L = 38, R = 6, T = 8, B = 20;
    const t0 = W.t0, t1 = W.t1;
    const lo = 5, hi = 30;
    const x = t => L + (W_ - L - R) * (t - t0) / Math.max(1, t1 - t0);
    const y = v => T + (H_ - T - B) * (1 - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo));
    let g = '';
    [[10, '10'], [15, '15'], [20, '20'], [25, '25'], [30, '30 dB']].forEach(([v, label]) => {
      const yy = y(v).toFixed(1);
      g += `<line class="lat-grid" x1="${L}" x2="${W_ - R}" y1="${yy}" y2="${yy}"/><text class="hl-axis" x="${L - 4}" y="${(+yy + 3.5).toFixed(1)}" text-anchor="end">${label}</text>`;
    });
    const fy = y(SNR_FLOOR).toFixed(1);
    g += `<line class="lat-floor" x1="${L}" x2="${W_ - R}" y1="${fy}" y2="${fy}"/>`;
    const d0 = new Date(t0); d0.setHours(0, 0, 0, 0);
    const step = t1 - t0 > 3 * DAY ? DAY : t1 - t0 > DAY ? 12 * HOUR : 6 * HOUR;
    for (let t = d0.getTime(); t <= t1; t += step) {
      if (t < t0) continue;
      const xx = x(t).toFixed(1);
      const lab = step >= DAY || new Date(t).getHours() === 0 ? fmtDay(t).replace(/,.*$/, '') : fmtHm(t);
      g += `<line class="lat-grid" x1="${xx}" x2="${xx}" y1="${T}" y2="${H_ - B}"/><text class="hl-axis" x="${xx}" y="${H_ - 6}" text-anchor="middle">${esc(lab)}</text>`;
    }
    const pts = st.snrs;
    let d = '';
    pts.forEach(p => { d += `M${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}h0.01`; });
    const med = y(st.snr.p50).toFixed(1);
    const lowN = pts.filter(p => p.v < 10).length;
    return `
      <h4 class="lat-h" id="lat-h-snr">Its ${snrTerm()}, reading by reading</h4>
      <svg class="lat-delay lat-snr" viewBox="0 0 ${W_} ${H_}" width="${W_}" height="${H_}" role="img"
           aria-label="${escAttr(`${s.name}: ${pts.length} transmissions over ${fmtSpan(t1 - t0)}; the median was heard ${fmtDb(st.snr.p50)} over the noise, the lowest ${fmtDb(st.snr.min)}, the highest ${fmtDb(st.snr.max)}${lowN ? `; ${lowN} under 10 dB` : ''}. Decodes stop near ${SNR_FLOOR} dB.`)}">
        ${g}
        <line class="lat-med" x1="${L}" x2="${W_ - R}" y1="${med}" y2="${med}"/>
        <path class="lat-dots" d="${d}"/>
      </svg>
      <p class="small txt-muted lat-cap">One dot a transmission: its strongest copy’s signal over the noise. The dashed line is the
        median, ${esc(fmtDb(st.snr.p50))}; the red line, ${SNR_FLOOR} dB, is where decodes stop${lowN ? `; <span class="txt-warn">${num(lowN)} under 10 dB</span>` : ''}.</p>`;
  }

  function pathsHtml(st) {
    return `
      <h4 class="lat-h" id="lat-h-paths">Heard through</h4>
      <div class="lat-table-wrap"><table class="lat-table" aria-labelledby="lat-h-paths">
        <thead><tr><th scope="col">Receiver</th><th scope="col" class="num">Copies</th>
          <th scope="col" class="num" title="Median time from being heard to reaching the database, through this receiver">Delay</th>
          <th scope="col" class="num">95%</th>
          <th scope="col" class="num">${termHtml('SNR', WORDS['SNR at a receiver'])}</th></tr></thead>
        <tbody>${st.paths.slice(0, 8).map(p => `<tr>
          <td><span class="mono" title="${escAttr(p.path)}">${esc(hostLabel(p.path))}</span></td>
          <td class="num">${num(p.n)}</td>
          <td class="num${p.p50 > 120 ? ' txt-warn' : ''}">${esc(fmtDelay(p.p50))}</td>
          <td class="num">${esc(fmtDelay(p.p95))}</td>
          <td class="num${p.snr != null && p.snr < 10 ? ' txt-warn' : ''}">${esc(fmtDb(p.snr))}</td></tr>`).join('')}
        </tbody></table></div>`;
  }

  // ── Painting ──────────────────────────────────────────────────────────────

  function rootEl() {
    if (root && document.contains(root)) return root;
    root = document.getElementById('map-latency-panel');
    return root;
  }
  const onScreen = () => { const r = rootEl(); return !!(r && r.getClientRects().length); };

  // The pane again, keeping focus on the same control (data-lat-f) — a
  // repaint replaces every button in it, the pressed one included.
  function paint() {
    const r = rootEl();
    if (!r) return;
    const a = document.activeElement;
    const had = a && r.contains(a) ? (a.dataset && a.dataset.latF) || null : null;
    const scroller = r.closest('.dock-pane') || null;
    const top = scroller ? scroller.scrollTop : 0;
    r.innerHTML = paneHtml();
    paintedW = r.clientWidth;
    if (scroller) scroller.scrollTop = top;
    if (had) {
      const to = r.querySelector(`[data-lat-f="${CSS.escape(had)}"]`) || (had.startsWith('stn:') || had === 'back' ? r.querySelector('#lat-h-stn, #lat-h-sum') : null);
      if (to) {
        if (!to.matches('button, input, a[href], [tabindex]')) to.tabIndex = -1;
        to.focus({ preventScroll: true });
      }
    }
  }
  function paintSoon() {
    if (paintTimer) return;
    paintTimer = setTimeout(() => { paintTimer = null; paint(); }, 120);
  }
  function paintStatus() {
    const el = document.getElementById('lat-status');
    if (el) el.innerHTML = statusHtml();
  }
  let statusTimer = null;
  function paintStatusSoon() {
    if (statusTimer) return;
    statusTimer = setTimeout(() => { statusTimer = null; paintStatus(); }, 150);
  }

  // The map moved: the summary is about what is in view.
  function onMove() {
    if (U.sel || U.scope !== 'view' || !onScreen()) return;
    paintSoon();
  }

  // ── The station on the card ───────────────────────────────────────────────

  // From the station card, every time it is painted or shut: the pane is about
  // the station the card is on. Only a change counts — the card repaints on a
  // save, a filter keystroke, the trail — so "← The stations in view" stays
  // pressed until another station is picked.
  function follow(id) {
    const v = id || null;
    if (v === U.lastCard) return;
    U.lastCard = v;
    U.sel = v;
    if (onScreen()) paint();
  }

  // Back to the summary. The card stays where it is: it is the map's, and
  // this pane only follows it. Focus lands on the summary's heading (paint).
  function back() {
    U.sel = null;
    paint();
  }

  // A station pressed in the pane: on the map with its card, and here.
  function focus(id) {
    const s = stationById(id);
    if (!s) return;
    U.sel = id;
    U.lastCard = id;
    if (typeof focusStationOnMap === 'function' && state.map) focusStationOnMap(s, document.activeElement);
    paint();
    const h = document.getElementById('lat-h-stn');
    if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
  }

  function openHealth(id) {
    if (HealthGlance.open) HealthGlance.open(id, 'checks');
  }

  // ── The pane coming into view ─────────────────────────────────────────────

  // From renderDock(), as the pane is shown: it asks for whatever is stale.
  // Run after the render that showed it — the pane can come into view while the
  // map that owns it is being built, when the side panel puts back the pane it
  // was showing last time.
  function shown() {
    setTimeout(() => {
      if (state.activeTab !== 'stations') return;
      if (HealthGlance.askNet) HealthGlance.askNet();
      ensureWindow(false);
      paint();
    }, 0);
  }

  // From the strip's ⏱️, pressed open: the first time in a session it turns the
  // view on — opening the tool is asking for the view. Not when the side panel
  // merely puts the pane back as a page loads (shown), and not once the switch
  // in the pane has been used: then that is the answer.
  function opened() {
    if (U.autoOn) return;
    U.autoOn = true;
    if (!U.on) setOn(true, { auto: true });
  }

  // From the pointer in 🗺️ Layers (app.js): this pane brought up — the side
  // panel's pane on a wide screen, the flyout in the map's corner otherwise, as
  // 📇 Capabilities opens one — and focus put on Signal bars beside the pins,
  // ticked or not: the choice stays theirs. Not opened(): a jump to one switch
  // is not asking for the pins coloured.
  function showBars() {
    const wrap = document.querySelector('.mn-mapctl[data-panel="latency"]');
    if (!wrap || wrap.classList.contains('is-docked')) {
      if (typeof setDockTab === 'function') setDockTab('map-latency');
    } else if (!wrap.classList.contains('is-open')) {
      const btn = wrap.querySelector('.mn-mapctl-btn');
      if (btn) btn.click();
    }
    let tries = 0;
    const step = () => {
      const box = document.querySelector('#map-latency-panel input[data-lat-f="bars"]');
      if (box && box.getClientRects().length) {
        box.closest('label').scrollIntoView({ block: 'nearest' });
        box.focus();
        return;
      }
      if (++tries < 20) setTimeout(step, 50);
    };
    setTimeout(step, 0);
  }

  // ── Messages landing: the log ─────────────────────────────────────────────

  // Only while somebody could see it: the box ticked, the Stations map up and
  // the page in view.
  const liveWanted = () => !!(U.anim && map && state.activeTab === 'stations'
    && (typeof document === 'undefined' || document.visibilityState !== 'hidden'));

  // Start watching or stop, whichever is wanted; safe to call any time.
  // Stopping forgets where it got to, so a return looks back one beat rather
  // than playing the whole gap.
  function liveSync() {
    // ⏱️ in the side panel's strip glows while the animation is on
    // (styles.css, html[data-lat-anim]) — on the root, because the strip's
    // buttons are made and kept by app.js, not here.
    if (typeof document !== 'undefined') document.documentElement.toggleAttribute('data-lat-anim', !!U.anim);
    if (liveWanted()) {
      ensureCanvas();
      if (!LV.since) LV.since = now_();
      if (!LV.timer && LV.status !== 'asking') livePoll();
    } else {
      if (LV.timer) { clearTimeout(LV.timer); LV.timer = null; }
      LV.seq++;
      Object.assign(LV, { status: 'idle', cursor: null, at: 0, since: 0, error: '', fails: 0, batches: [], held: new Map() });
      rxPause();
      clearPulses();
    }
    paintLive();
  }

  async function livePoll() {
    if (LV.timer) { clearTimeout(LV.timer); LV.timer = null; }
    if (!liveWanted()) return;
    const seq = ++LV.seq;
    const from = LV.cursor || new Date(now_() - LIVE_MS).toISOString();
    LV.status = 'asking';
    rxEnsure();
    let rows;
    try {
      // The receivers' copies beside the log, so a message's copies are in
      // before it plays. rxPoll keeps its own failures to itself.
      [rows] = await Promise.all([
        dbSelect(`reading?select=${LIVE_SELECT}&received_at=gt.${encodeURIComponent(from)}`
          + `&order=received_at.asc&limit=${LIVE_PAGE}`),
        rxPoll(),
      ]);
    } catch (err) {
      if (seq !== LV.seq) return;
      LV.fails++;
      Object.assign(LV, { status: 'error', error: errText(err) });
      paintLive();
      // Asked again later each time it fails, to two minutes apart.
      LV.timer = setTimeout(livePoll, Math.min(8, 2 ** (LV.fails - 1)) * LIVE_MS);
      return;
    }
    if (seq !== LV.seq) return;
    Object.assign(LV, { status: 'ok', at: now_(), error: '', fails: 0 });
    LV.cursor = rows.length ? rows[rows.length - 1].received_at : from;
    land(rows, LV.held);
    paintLive();
    LV.timer = setTimeout(livePoll, rows.length >= LIVE_PAGE ? SEC : LIVE_MS);
  }

  // One answer: each message to its station, and each station played once, at
  // the first of its messages to land — a station's battery and its rain in
  // the same second are one transmission to look at. `held`: the messages the
  // last answer kept back for their copies (below), played now with whatever
  // came, or with this answer's when the station is in it again.
  function land(rows, held) {
    LV.held = new Map();
    const list = rows.filter(r => !LIVE_SKIP_SOURCE.has(Number(r.source)));
    const at = now_();
    LV.batches = LV.batches.filter(b => at - b.at <= LIVE_KEEP);
    if (!list.length) { if (held) playBack(held); return; }
    const resolve = SensorValues.resolver(list);
    // Each station's message: when it first landed, and what its copies would
    // carry — its addresses and when its readings were taken.
    const first = new Map();
    const ids = new Set();
    let lost = 0;
    for (const r of list) {
      const got = resolve(r);
      const st = got && got.st && LIVE_SURE.has(got.conf) ? got.st : null;
      if (!st || !pinFor(st.id)) { lost++; if (st) ids.add(st.id); continue; }
      ids.add(st.id);
      const t = Date.parse(r.received_at);
      let m = first.get(st.id);
      if (!m) first.set(st.id, m = { t, ts0: Infinity, ts1: -Infinity, keys: new Set() });
      if (t < m.t) m.t = t;
      const ts = Date.parse(r.reading_ts);
      if (isFinite(ts)) { m.ts0 = Math.min(m.ts0, ts); m.ts1 = Math.max(m.ts1, ts); }
      if (r.alert_id != null) m.keys.add('a:' + Number(r.alert_id));
      if (r.a2_station != null) m.keys.add('a2:' + Number(r.a2_station));
    }
    LV.batches.push({ at, n: list.length, ids: [...ids], lost });
    if (held) {
      held.forEach((h, id) => {
        const m = first.get(id);
        if (!m) return;
        m.t = Math.min(m.t, h.t); m.ts0 = Math.min(m.ts0, h.ts0); m.ts1 = Math.max(m.ts1, h.ts1);
        h.keys.forEach(k => m.keys.add(k));
        m.waited = true;
        held.delete(id);
      });
      playBack(held);
    }
    // While the receivers' copies are read, a message whose copies are not in
    // yet waits for the next ask of them — a base station posts its copies in
    // batches of their own, often a beat after its readings — and plays then,
    // once, whatever came.
    if (RX.status !== 'ok') { playBack(first); return; }
    const now = new Map();
    first.forEach((m, id) => (m.waited || copiesOf(m) ? now : LV.held).set(id, m));
    playBack(now);
  }

  // A beat behind, in the order they landed: what landed over the last
  // LIVE_MS plays over the next, squeezed to fit when a backlog came at once,
  // and a base's batch posted in one instant goes a station after another
  // rather than all at once — a sweep, not a strobe.
  function playBack(first) {
    if (!first.size) return;
    const list = [...first.entries()].sort((a, b) => a[1].t - b[1].t);
    const t0 = list[0][1].t, span = list[list.length - 1][1].t - t0;
    const room = LIVE_MS - 2500;
    const k = span > room ? room / span : 1;
    const beat = Math.min(90, room / list.length);
    let prev = -Infinity;
    for (const [id, m] of list) {
      const d = Math.min(room, Math.max((m.t - t0) * k, prev + beat));
      prev = d;
      const h = setTimeout(() => { liveTimers.delete(h); fire(id, m); }, d);
      liveTimers.add(h);
    }
  }

  // ── Messages landing: the receivers' copies ───────────────────────────────

  const iso = t => encodeURIComponent(new Date(t).toISOString());
  // Worth asking: signed in, and not an account that may only read. The
  // database decides (reception is editors' only, 0047) — this only spares a
  // visitor the asking.
  const rxMay = () => typeof Auth !== 'undefined' && Auth.isSignedIn() && (!Auth.mayWrite || Auth.mayWrite());

  // Forget everything read: signed out, or nothing to read.
  function rxReset(status) {
    RX.seq++;
    Object.assign(RX, { status, fed: false, cursor: null, first: true, error: '', pausedAt: 0, played: 0, matched: 0,
                        points: new Map(), bursts: new Map(), kept: new Map(), copies: [] });
  }

  // The log stops being watched: the copies kept to be matched go (no message
  // will play to match them), and the next ask after a return looks back one
  // beat, as the log's does. The window and its carriers stay, and are asked
  // for again only after a pause long enough to have left a hole in them.
  function rxPause() {
    RX.seq++;
    RX.copies = [];
    RX.first = true;
    if (RX.status === 'warming') RX.status = 'off';
    if (!RX.pausedAt) RX.pausedAt = now_();
  }

  // At each ask of the log: ask for the window if it is wanted and is not in
  // hand, or has a hole in it; let a failed ask try again a minute on.
  function rxEnsure() {
    if (RX.fed) return;
    if (!rxMay()) { if (RX.status !== 'off' || RX.bursts.size) rxReset('off'); return; }
    if (RX.status === 'warming') return;
    const t = now_();
    const fresh = RX.warmAt && t - RX.warmAt < CARRIER_TTL;
    const paused = RX.pausedAt ? t - RX.pausedAt : 0;
    RX.pausedAt = 0;
    if (RX.status === 'off'
        || (RX.status === 'ok' && paused >= CARRIER_TTL)
        || (RX.status === 'none' && !fresh)
        || (RX.status === 'error' && !RX.bursts.size && t - (RX.triedAt || 0) >= 4 * LIVE_MS)) { rxWarm(); return; }
    if (RX.status === 'error' && RX.bursts.size) RX.status = 'ok';
    if (RX.status === 'ok' && t - (RX.pointsAt || 0) >= CARRIER_TTL) rxPointsAgain();
  }

  async function rxPoints() {
    return dbSelect('ingest_point_latest?select=ingest_token_id,point_id,host_station_id&order=point_id.asc&limit=1000');
  }
  function setPoints(list) {
    RX.points = new Map((list || []).map(p => [p.ingest_token_id + '|' + p.point_id, p.host_station_id || null]));
    RX.pointsAt = now_();
  }
  async function rxPointsAgain() {
    RX.pointsAt = now_();
    const seq = RX.seq;
    try { const list = await rxPoints(); if (seq === RX.seq) setPoints(list); } catch (_) { /* kept as they were */ }
  }

  // The last CARRIER_H hours of measured legacy bursts, every receiver's, a
  // page at a time by id; then each receiver's carriers found in them.
  async function rxWarm() {
    const seq = ++RX.seq;
    const t1 = now_(), t0 = t1 - CARRIER_H * HOUR;
    Object.assign(RX, { status: 'warming', error: '', triedAt: t1 });
    paintLive();
    try {
      const pages = async () => {
        const out = [];
        for (let after = null; ;) {
          const page = await dbSelect(`reception?select=${RX_WARM_SELECT}&protocol=eq.alert&ok=is.true&cfo_hz=not.is.null`
            + `&heard_at=gte.${iso(t0)}${after != null ? `&id=gt.${after}` : ''}&order=id.asc&limit=${LIVE_PAGE}`);
          if (seq !== RX.seq) return out;
          out.push(...page);
          // A fleet much busier than this one: enough to find carriers by.
          if (page.length < LIVE_PAGE || out.length >= 20 * LIVE_PAGE) return out;
          after = page[page.length - 1].id;
        }
      };
      const [points, rows] = await Promise.all([rxPoints(), pages()]);
      if (seq !== RX.seq) return;
      // RLS answers an account that may not read them with nothing at all.
      if (!points.length && !rows.length) { rxReset('none'); RX.warmAt = t1; paintLive(); return; }
      Object.assign(RX, { bursts: new Map(), kept: new Map(), copies: [], cursor: null, first: true });
      setPoints(points);
      for (const r of rows) {
        addBurst(r);
        if (RX.cursor == null || r.id > RX.cursor) RX.cursor = r.id;
      }
      RX.bursts.forEach((_, pk) => findCarriers(pk));
      Object.assign(RX, { status: 'ok', warmAt: t1 });
    } catch (err) {
      if (seq !== RX.seq) return;
      if (isDenied(err)) { rxReset('none'); RX.warmAt = t1; }
      else Object.assign(RX, { status: 'error', error: errText(err) });
    }
    paintLive();
  }

  // What landed since the last ask: the first after a start or a return only
  // back a beat, then by id. Never throws — the log's ask is beside it.
  async function rxPoll() {
    if (RX.status !== 'ok' || RX.fed) return;
    const seq = RX.seq;
    const since = RX.first ? `&heard_at=gt.${iso(now_() - LIVE_MS - MIN)}` : '';
    try {
      const rows = await dbSelect(`reception?select=${RX_SELECT}&ok=is.true${RX.cursor != null ? `&id=gt.${RX.cursor}` : ''}`
        + `${since}&order=id.asc&limit=${LIVE_PAGE}`);
      if (seq !== RX.seq) return;
      // By id from the first copy seen: until then, an id from before a
      // pause would ask for the whole of it.
      if (rows.length) RX.first = false;
      hear(rows);
    } catch (err) {
      if (seq !== RX.seq) return;
      if (isDenied(err)) { rxReset('none'); RX.warmAt = now_(); }
      else Object.assign(RX, { status: 'error', error: errText(err), triedAt: now_() });
    }
  }

  // A measured legacy burst into its receiver's window.
  function addBurst(r) {
    const cfo = Number(r.cfo_hz);
    if (r.alert_id == null || r.cfo_hz == null || !isFinite(cfo)) return null;
    const pk = r.ingest_token_id + '|' + r.point_id;
    const b = { id: r.id, a: Number(r.alert_id), cfo, dup: !!r.a2_duplicate, t: Date.parse(r.heard_at), how: 'unmeasured', rid: null };
    let list = RX.bursts.get(pk);
    if (!list) RX.bursts.set(pk, list = []);
    list.push(b);
    return b;
  }

  // One answer's copies: each kept to be matched to its message, each measured
  // legacy burst into its receiver's window, and the carriers found again in
  // every window that changed.
  function hear(rows) {
    const t = now_();
    const touched = new Set();
    for (const r of rows || []) {
      if (RX.cursor == null || r.id > RX.cursor) RX.cursor = r.id;
      const pk = r.ingest_token_id + '|' + r.point_id;
      const c = { id: r.id, pk, at: t, t: Date.parse(r.heard_at), proto: r.protocol,
                  a: r.alert_id == null ? null : Number(r.alert_id),
                  src2: r.a2_source == null ? null : Number(r.a2_source),
                  path2: Array.isArray(r.a2_path) ? r.a2_path.map(Number) : [], b: null };
      if (c.proto === 'alert') { c.b = addBurst(r); if (c.b) touched.add(pk); }
      RX.copies.push(c);
    }
    RX.copies = RX.copies.filter(c => t - c.at <= RX_KEEP);
    const old = t - CARRIER_H * HOUR;
    RX.bursts.forEach((list, pk) => {
      if (!list.length || list[0].t >= old) return;
      RX.bursts.set(pk, list.filter(b => b.t >= old));
      touched.add(pk);
    });
    touched.forEach(findCarriers);
  }

  // The register as 0077 reads it, once per station file and every so often
  // (a pass range edited in place is the same file).
  function carrierRegNow() {
    if (typeof SignalRoutes === 'undefined' || !SignalRoutes.register) return null;
    const t = now_(), data = state.data, n = stations().length;
    if (!carrierReg || carrierRegFor !== data || carrierRegN !== n || t - carrierRegAt >= CARRIER_TTL) {
      carrierReg = SignalRoutes.register();
      carrierRegFor = data; carrierRegN = n; carrierRegAt = t;
    }
    return carrierReg;
  }

  // A receiver's repeater carriers, found in its window — each burst's `how`
  // (repeater, own, ambiguous, unexplained) and `rid` set as it goes.
  function findCarriers(pk) {
    const reg = carrierRegNow();
    if (!reg) return;
    const kept = SignalRoutes.attribute(RX.bursts.get(pk) || [], reg);
    RX.kept.set(pk, new Map(kept.map(r => [r.rid, r.centre])));
  }

  // The copies that carried a message: its addresses, heard near when its
  // readings were taken.
  const copyKey = c => (c.a != null ? 'a:' + c.a : c.src2 != null ? 'a2:' + c.src2 : null);
  function copiesOf(msg) {
    if (!msg || RX.status !== 'ok' || !msg.keys || !msg.keys.size) return null;
    const lo = (isFinite(msg.ts0) ? msg.ts0 : msg.t) - RX_MATCH;
    const hi = (isFinite(msg.ts1) ? msg.ts1 : msg.t) + RX_MATCH;
    const got = RX.copies.filter(c => c.t >= lo && c.t <= hi && msg.keys.has(copyKey(c)));
    return got.length ? got : null;
  }

  // A message as a test names it ({ keys, t }), as land() makes them.
  const testMsg = m => m && { t: m.t || now_(), ts0: m.t || now_(), ts1: m.t || now_(), keys: new Set(m.keys || []) };

  // A station by its ALERT2 address, once per station file.
  function stationOfA2(addr) {
    const data = state.data;
    if (!a2Idx || a2IdxFor !== data) {
      a2Idx = new Map();
      for (const s of stations()) if (s.alert2_station_id != null) a2Idx.set(Number(s.alert2_station_id), s.id);
      a2IdxFor = data;
    }
    return a2Idx.get(Number(addr)) || null;
  }

  // What one copy proves of the way station `id`'s message came, or null when
  // it proves nothing. { pk, host, direct, passes } heard direct; { pk, host, via }
  // on repeater `via`'s carrier; { pk, host, chain, legacyFirst } an ALERT2
  // path, its hops the station ids in order (null where the register places
  // none), the first assumed when it is a legacy station's concentrator.
  function proofOf(id, c) {
    const host = RX.points.get(c.pk) || null;
    if (c.proto === 'alert2' && c.src2 != null) {
      const a2 = [c.src2].concat(c.path2).map(stationOfA2);
      const legacyFirst = c.a != null;
      if (!legacyFirst && a2[0] !== id) return null;
      const chain = (legacyFirst ? [id] : []).concat(a2);
      const hops = chain.map((x, i) => [x, i + 1 < chain.length ? chain[i + 1] : host]);
      return hops.some(([x, y]) => x && y && x !== y) ? { pk: c.pk, host, chain, legacyFirst } : null;
    }
    const b = c.b;
    if (!b) return null;
    // Heard direct, with the repeaters that pass the address it came on: a
    // station's other address may be in a range this one is not.
    const passes = () => new Set((b.cands || []).filter(x => !x.own).map(x => x.rid));
    if (b.how === 'repeater') return b.rid === id ? { pk: c.pk, host, direct: true, passes: passes() } : { pk: c.pk, host, via: b.rid };
    // No named repeater's: the station's own only off a crowded carrier — on
    // one, a relay nobody could name, which proves nothing of the way.
    if (b.how === 'own') return onShared(c.pk, b) ? null : { pk: c.pk, host, direct: true, passes: passes() };
    return null;
  }

  // Whether a burst sits on a carrier many other addresses share at its
  // receiver around then (SHARED_*): a relay, named or not.
  function onShared(pk, b) {
    const all = new Set(), near = new Set();
    for (const x of RX.bursts.get(pk) || []) {
      if (x.a === b.a || Math.abs(x.t - b.t) > SHARED_MS) continue;
      all.add(x.a);
      if (Math.abs(x.cfo - b.cfo) <= SHARED_HZ) near.add(x.a);
    }
    return near.size >= SHARED_MIN && near.size >= SHARED_SHARE * all.size;
  }

  // ── Messages landing: the pulse ───────────────────────────────────────────

  // Every pin on the map by its station, once per rebuild.
  function pinFor(id) {
    const ms = state.mapMarkers || [];
    if (pinIdxFor !== ms || pinIdxN !== ms.length) {
      pinIdx = new Map();
      for (const m of ms) if (m.mnStationId) pinIdx.set(m.mnStationId, m);
      pinIdxFor = ms; pinIdxN = ms.length;
    }
    return pinIdx.get(id) || null;
  }

  // The links on the map, as the way a message runs: a field station's
  // pass-range link to each repeater, drawn station end first; a backbone path
  // to a base, drawn repeater end first; and a repeater-to-repeater path, either
  // way. Built off the lines refreshMapLayers drew, once per rebuild — a link
  // the map is not drawing is not one a pulse can be seen on — and, with
  // Animate along hidden links ticked, off the links it handed over instead
  // (hiddenLinks): no line, so keyed by their ends.
  function graphNow() {
    const lines = state.mapLines || [];
    if (graph && graphFor === lines && graph.n === lines.length) return graph;
    const field = new Map(), bb = new Map(), base = new Set();
    const add = (m, k, e) => { if (!m.has(k)) m.set(k, []); m.get(k).push(e); };
    for (const l of lines) {
      if (!l.mnArrowDir || !l.getLatLngs) continue;   // the casings and the backbone's dashes
      const ll = l.getLatLngs();
      if (!ll || ll.length < 2) continue;
      if (l.mnLinkRole === 'core') {
        add(field, l.mnLinkStationId, { line: l, fromId: l.mnLinkStationId, toId: l.mnLinkRepeaterId, from: ll[0], to: ll[1] });
      } else if (l.mnLinkRole === 'backbone') {
        const a = l.mnLinkRepeaterId, b = l.mnLinkRepeaterId2;
        add(bb, a, { line: l, fromId: a, toId: b, from: ll[0], to: ll[1] });
        if (l.mnArrowDir === 'both') add(bb, b, { line: l, fromId: b, toId: a, from: ll[1], to: ll[0] });
        else base.add(b);
      }
    }
    const at = s => L.latLng(s.lat, s.lon);
    for (const { s, r } of unseen.field) {
      add(field, s.id, { line: null, key: 'h:' + s.id + '>' + r.id, fromId: s.id, toId: r.id, from: at(s), to: at(r) });
    }
    for (const { a, b, kind } of unseen.backbone) {
      const key = 'h:' + a.id + '>' + b.id;
      add(bb, a.id, { line: null, key, fromId: a.id, toId: b.id, from: at(a), to: at(b) });
      if (kind === 'base') base.add(b.id);
      else add(bb, b.id, { line: null, key, fromId: b.id, toId: a.id, from: at(b), to: at(a) });
    }
    graph = { field, bb, base, n: lines.length };
    graphFor = lines;
    return graph;
  }

  // The fewest backbone hops from a repeater to a base, as the edges to run.
  function toBase(g, from) {
    if (g.base.has(from)) return [];
    const prev = new Map([[from, null]]);
    let frontier = [from];
    for (let hop = 0; hop < HOPS_MAX && frontier.length; hop++) {
      const next = [];
      for (const u of frontier) {
        for (const e of g.bb.get(u) || []) {
          if (prev.has(e.toId)) continue;
          prev.set(e.toId, e);
          if (g.base.has(e.toId)) {
            const path = [];
            for (let x = e; x; x = prev.get(x.fromId)) path.unshift(x);
            return path;
          }
          next.push(e.toId);
        }
      }
      frontier = next;
    }
    return [];
  }

  // A way from a station to a repeater along the links drawn, as the edges to
  // run: one of its pass-range links, then backbone hops — the way to a
  // repeater whose carrier a copy came on. Null when the map draws none.
  function wayTo(g, from, to) {
    const prev = new Map([[from, null]]);
    let frontier = [from];
    for (let hop = 0; hop <= HOPS_MAX && frontier.length; hop++) {
      const next = [];
      for (const u of frontier) {
        for (const e of (hop ? [] : g.field.get(u) || []).concat(g.bb.get(u) || [])) {
          if (prev.has(e.toId)) continue;
          prev.set(e.toId, e);
          if (e.toId === to) {
            const path = [];
            for (let x = e; x; x = prev.get(x.fromId)) path.unshift(x);
            return path;
          }
          next.push(e.toId);
        }
      }
      frontier = next;
    }
    return null;
  }

  // The link drawn between two stations, run from `a` to `b` — the same line
  // run backwards when it is drawn the other way — or null when there is none.
  function edgeOf(g, a, b) {
    for (const e of (g.field.get(a) || []).concat(g.bb.get(a) || [])) if (e.toId === b) return e;
    for (const e of (g.field.get(b) || []).concat(g.bb.get(b) || [])) {
      if (e.toId === a) return Object.assign({}, e, { fromId: a, toId: b, from: e.to, to: e.from });
    }
    return null;
  }

  // One station's pulse: its own flare, then a leg along each hop, each node
  // flaring as the spark lands on it — the logo's rule — in the colour of what
  // is known of the hop (HOPS, and the header). With copies that prove
  // something (copiesOf, proofOf): the hops they prove, the way to them, and
  // the links missed. With none: the way the map draws, all of it assumed.
  // Times are from the start. Where each part is drawn is looked up again
  // every frame (pinAt, legAt): a pan or a zoom mid-pulse keeps it on its
  // links, and a station moved since keeps its glow.
  function route(id, copies) {
    const g = graphNow();
    const m = pinFor(id);
    if (!m || !map) return null;
    const legs = [];
    const byKey = new Map();
    const named = new Set();     // the transmitters a copy names: heard
    // A hop from `a` to `b` from `start`, along the drawn edge `e`, else
    // straight pin to pin; timed `like` another hop when given. Answers where
    // it ends, or null when it cannot be drawn. A hop already in the pulse is
    // not drawn twice: it keeps its time and the better of the two kinds.
    const hop = (a, b, kind, start, e, like) => {
      if (!a || !b || a === b) return null;
      const key = a + '>' + b;
      const had = byKey.get(key);
      if (had) {
        if (HOPS[kind].rank > HOPS[had.kind].rank) had.kind = kind;
        return had.start + had.dur;
      }
      if (legs.length >= LEGS_MAX || (e && e.line && !(e.line.options.opacity > 0.06))) return null;
      const from = e ? e.from : pinAt(a), to = e ? e.to : pinAt(b);
      if (!from || !to) return null;
      const px = map.latLngToLayerPoint(from).distanceTo(map.latLngToLayerPoint(to));
      const dur = like ? like.dur : Math.max(LEG_MIN, Math.min(LEG_MAX, 1000 * px / SPEED));
      // The trail drains into the far node at the spark's speed — on a link
      // shorter than the trail, no longer than the run itself.
      const tail = like ? like.tail : Math.min(dur, dur * TRAIL_PX / Math.max(1, px));
      const l = { a: from, b: to, start: like ? like.start : start, dur, tail, to: b, fromId: a, kind, straight: !e };
      legs.push(l);
      byKey.set(key, l);
      return l.start + dur;
    };
    const after = t => (t ? t + HOLD_MS : 0);
    const proofs = (copies || []).map(c => proofOf(id, c)).filter(Boolean);
    if (proofs.length) {
      const via = new Set(proofs.filter(p => p.via).map(p => p.via));
      let direct = null;
      for (const p of proofs) {
        if (p.direct) {
          // Heard direct: its hop to the base station, and nothing on the way.
          if (hop(id, p.host, 'heard', 0, edgeOf(g, id, p.host)) != null && !direct) direct = byKey.get(id + '>' + p.host);
        } else if (p.via) {
          // On a repeater's carrier: the way to it assumed, the repeater
          // heard, and its hop to the base station heard.
          let t = 0;
          const way = wayTo(g, id, p.via);
          if (way) {
            for (const e of way) {
              const end = hop(e.fromId, e.toId, 'assumed', after(t), e);
              if (end == null) break;
              t = end;
            }
          } else {
            t = hop(id, p.via, 'assumed', 0, null) || 0;
          }
          named.add(p.via);
          hop(p.via, p.host, 'heard', after(t), edgeOf(g, p.via, p.host));
        } else {
          // An ALERT2 path: every hop heard, but a legacy station's own to
          // the concentrator that heard it.
          const chain = p.chain.concat([p.host]);
          let t = 0;
          for (let i = 0; i + 1 < chain.length; i++) {
            const end = hop(chain[i], chain[i + 1], p.legacyFirst && i === 0 ? 'assumed' : 'heard', after(t),
              chain[i] && chain[i + 1] ? edgeOf(g, chain[i], chain[i + 1]) : null);
            if (end != null) t = end;
          }
          p.chain.forEach(x => { if (x && x !== id) named.add(x); });
        }
      }
      // Heard direct by a receiver that hears a repeater the station has a
      // pass-range link to, a repeater that passes the address it came on,
      // and nothing heard that repeater pass it on: the link missed, lit for
      // as long as the hop that was heard.
      for (const p of proofs) {
        const kept = p.direct ? RX.kept.get(p.pk) : null;
        if (!kept || !kept.size) continue;
        for (const e of g.field.get(id) || []) {
          if (kept.has(e.toId) && p.passes.has(e.toId) && !via.has(e.toId)) hop(id, e.toId, 'missed', 0, e, direct);
        }
      }
    } else {
      // The way the map draws: each pass-range link to a repeater, then the
      // fewest backbone hops to a base.
      const via = [];
      for (const e of g.field.get(id) || []) {
        const end = hop(id, e.toId, 'assumed', 0, e);
        if (end != null) via.push([e.toId, end]);
      }
      // A repeater's own sensors start at the repeater.
      if (!via.length && g.bb.has(id)) via.push([id, 0]);
      for (const [rid, t0] of via) {
        let t = t0;
        for (const e of toBase(g, rid)) {
          const end = hop(e.fromId, e.toId, 'assumed', t + HOLD_MS, e);
          if (end == null) break;
          t = end;
        }
      }
    }
    // Each node flares as the first spark lands on it — the station at once —
    // in the colour of what is known of it: the station and every transmitter
    // a copy names heard, the rest as the best hop to them. A missed link's
    // far end does not flare: nothing reached it.
    const nodes = [{ id, ll: m.getLatLng(), r: m.options.radius || 6, start: 0, kind: 'heard' }];
    const nodeAt = new Map([[id, nodes[0]]]);
    for (const l of legs) {
      if (l.kind === 'missed') continue;
      const end = l.start + l.dur;
      let n = nodeAt.get(l.to);
      if (!n) {
        const mt = pinFor(l.to);
        nodeAt.set(l.to, n = { id: l.to, ll: l.b, r: mt ? mt.options.radius || 6 : 6, start: end, kind: l.kind });
        nodes.push(n);
      } else if (n.id !== id && end < n.start) n.start = end;
      if (HOPS[l.kind].rank > HOPS[n.kind].rank) n.kind = l.kind;
    }
    nodes.forEach(n => { if (named.has(n.id)) n.kind = 'heard'; });
    const still = calm();
    // Where each part's animation ends, and its afterglow begins.
    nodes.forEach(n => { n.end = still ? STILL_MS : n.start + FLARE_MS; });
    legs.forEach(l => { l.end = still ? STILL_MS : l.start + l.dur + l.tail; });
    const anim = Math.max(still ? STILL_MS : FLARE_MS, ...nodes.map(n => n.end), ...legs.map(l => l.end));
    return { id, nodes, legs, anim, life: anim + GLOW_HOLD + GLOW_FADE, still, proved: proofs.length > 0 };
  }

  // Where a pulse's station or link is drawn now, or null once it is not. A
  // pulse keeps the ids it ran between, not only where they stood when the
  // message landed: a rebuild since can have moved a station (Move pin) or
  // fanned its pin out of a stack, and its ring and its links' glow belong
  // round the pin as drawn, not on the spot it left. A hop drawn straight runs
  // pin to pin, and is keyed by its ends where a link is keyed by its line.
  function pinAt(id) { const m = pinFor(id); return m ? m.getLatLng() : null; }
  function legAt(l) {
    if (!l.straight) { const e = edgeOf(graphNow(), l.fromId, l.to); return e && Object.assign({ key: e.line }, e); }
    const a = pinAt(l.fromId), b = pinAt(l.to);
    return a && b ? { key: l.fromId + '>' + l.to, fromId: l.fromId, toId: l.to, from: a, to: b } : null;
  }

  function fire(id, msg) {
    if (!pctx || !map) return;
    const t = performance.now();
    if (pulses.filter(p => t - p.t0 < p.anim).length >= PULSES_MAX) return;
    // Still flaring from its last message: not flared again on top of it.
    if (pulses.some(p => p.id === id && t - p.t0 < FLARE_MS)) return;
    const p = route(id, copiesOf(msg));
    if (!p) return;
    if (msg && RX.status === 'ok') { RX.played++; if (p.proved) RX.matched++; }
    p.t0 = t;
    // Its last message's glow gives way to this one's, which starts afresh.
    pulses = pulses.filter(q => q.id !== id || t - q.t0 < q.anim);
    if (pulses.length >= GLOWS_MAX) pulses.shift();
    pulses.push(p);
    LV.fired.push(id);
    LV.firedN++;
    if (LV.fired.length > 50) LV.fired.shift();
    kick();
  }

  function clearPulses() {
    liveTimers.forEach(h => clearTimeout(h));
    liveTimers.clear();
    pulses = [];
    if (praf) { cancelAnimationFrame(praf); praf = null; }
    if (glowTimer) { clearTimeout(glowTimer); glowTimer = null; }
    drawPulses(0);
  }

  // ── Messages landing: the canvas ──────────────────────────────────────────
  // One canvas over the view in a pane of its own, MapArrows' way: placed when
  // the view settles, drawn in layer pixels so a drag carries it with the map,
  // and hidden through a zoom's animation (the pulses keep their time and are
  // back where they belong when it ends). Frames are asked for only while a
  // pulse is running.

  function ensureCanvas() {
    if (!map || pcanvas || typeof L === 'undefined') return;
    if (!map.getPane(PULSE_PANE)) {
      const pane = map.createPane(PULSE_PANE);
      pane.style.zIndex = PULSE_Z;
      pane.style.pointerEvents = 'none';
    }
    pcanvas = L.DomUtil.create('canvas', 'lat-pulse-canvas', map.getPane(PULSE_PANE));
    pcanvas.setAttribute('aria-hidden', 'true');
    pctx = pcanvas.getContext('2d');
    map.on('moveend zoomend resize viewreset', placeCanvas);
    map.on('zoomstart', hideCanvas);
    placeCanvas();
  }
  function dropCanvas() {
    if (map) {
      map.off('moveend zoomend resize viewreset', placeCanvas);
      map.off('zoomstart', hideCanvas);
    }
    if (pcanvas && pcanvas.parentNode) pcanvas.parentNode.removeChild(pcanvas);
    pcanvas = null; pctx = null; porigin = null;
  }
  function hideCanvas() { if (pcanvas) pcanvas.style.visibility = 'hidden'; }
  function placeCanvas() {
    if (!map || !pcanvas) return;
    const size = map.getSize();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(size.x * dpr)), h = Math.max(1, Math.round(size.y * dpr));
    if (pcanvas.width !== w || pcanvas.height !== h) {
      pcanvas.width = w; pcanvas.height = h;
      pcanvas.style.width = `${size.x}px`; pcanvas.style.height = `${size.y}px`;
    }
    porigin = map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(pcanvas, porigin);
    pcanvas.style.visibility = '';
    drawPulses(performance.now());
  }

  function kick() {
    if (glowTimer) { clearTimeout(glowTimer); glowTimer = null; }
    if (!praf && pulses.length && pctx) praf = requestAnimationFrame(frame);
  }
  function frame(t) {
    praf = null;
    drawPulses(t);
    if (!pulses.length) return;
    if (pulses.some(p => t - p.t0 < p.anim)) praf = requestAnimationFrame(frame);
    else glowTimer = setTimeout(() => { glowTimer = null; praf = requestAnimationFrame(frame); }, GLOW_TICK);
  }

  // How bright a part's afterglow is, ms after its animation ended: up over
  // GLOW_IN, held, then down to nothing.
  function glowAt(e) {
    if (e < 0 || e >= GLOW_HOLD + GLOW_FADE) return 0;
    const up = Math.min(1, e / GLOW_IN);
    return e < GLOW_HOLD ? up : up * (1 - (e - GLOW_HOLD) / GLOW_FADE);
  }

  // CSS's ease-out, near enough for a flare.
  const easeOut = u => 1 - (1 - u) * (1 - u);
  // Where a flare is, e ms in: [opacity, scale], or null once it is out.
  function flareAt(e) {
    const f = e / CYCLE;
    if (f < 0 || f >= FLARE[FLARE.length - 1][0]) return null;
    for (let i = 1; i < FLARE.length; i++) {
      const [ta, oa, sa] = FLARE[i - 1], [tb, ob, sb] = FLARE[i];
      if (f <= tb) {
        const u = easeOut((f - ta) / (tb - ta));
        return [oa + (ob - oa) * u, sa + (sb - sa) * u];
      }
    }
    return null;
  }

  function drawPulses(t) {
    if (!pctx || !map) return;
    const size = map.getSize();
    const dpr = window.devicePixelRatio || 1;
    pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    pctx.clearRect(0, 0, size.x, size.y);
    pulses = pulses.filter(p => t - p.t0 < p.life);
    if (!pulses.length || !porigin) return;
    const at = ll => { const q = map.latLngToLayerPoint(ll); return [q.x - porigin.x, q.y - porigin.y]; };
    pctx.lineCap = 'round';
    // The afterglow under everything: each link and node once, at the
    // brightest any pulse leaves it, in that pulse's colour for it — a link by
    // the line drawn for it now, so one lit before a rebuild and again after
    // it glows once.
    const legGlow = new Map(), nodeGlow = new Map();
    for (const p of pulses) {
      const e0 = t - p.t0;
      for (const l of p.legs) {
        const g = glowAt(e0 - l.end);
        const e = g > 0 ? legAt(l) : null;
        if (e && g > (legGlow.has(e.key) ? legGlow.get(e.key).g : 0)) legGlow.set(e.key, { e, g, kind: l.kind });
      }
      for (const n of p.nodes) {
        const g = glowAt(e0 - n.end);
        if (g > (nodeGlow.has(n.id) ? nodeGlow.get(n.id).g : 0)) nodeGlow.set(n.id, { n, g, kind: n.kind });
      }
    }
    // Off the pins and links as they are now: a rebuild since can have hidden
    // one (a filter), resized it (a band) or moved it (Move pin), and a glow
    // round nothing, or round where a station used to stand, says nothing.
    const radius = id => { const m = pinFor(id); return m ? m.options.radius || 6 : null; };
    // A link's length on screen, short of the pins at both ends — what a glow
    // and a missed link light, so neither paints over a pin.
    const span = (e, fn) => {
      const ra = radius(e.fromId), rb = radius(e.toId);
      if (ra == null || rb == null) return;
      const [ax, ay] = at(e.from), [bx, by] = at(e.to);
      const len = Math.hypot(bx - ax, by - ay);
      if (len > 1) fn(ax, ay, bx, by, len, ra + 3, len - rb - 3);
    };
    legGlow.forEach(({ e, g, kind }) => span(e, (ax, ay, bx, by, len, a, b) => stroke(ax, ay, bx, by, len, a, b, 'glow', g, kind)));
    nodeGlow.forEach(({ n, g, kind }) => {
      const r = radius(n.id);
      if (r == null) return;
      const [x, y] = at(pinAt(n.id));
      ring(x, y, r, g, kind);
    });
    // The links first and the nodes over them, as the logo stacks them. A
    // missed link does not run: it is lit, pin to pin, for its time.
    for (const p of pulses) {
      const e0 = t - p.t0;
      if (p.still && e0 >= STILL_MS) continue;
      for (const l of p.legs) {
        const e = p.still ? 0 : e0 - l.start;
        if (e < 0 || e > l.dur + l.tail) continue;
        const now = legAt(l);
        if (l.kind === 'missed') {
          if (now) span(now, (ax, ay, bx, by, len, a, b) => stroke(ax, ay, bx, by, len, a, b, 'trail', 1, l.kind));
          continue;
        }
        const [ax, ay] = at(now ? now.from : l.a), [bx, by] = at(now ? now.to : l.b);
        const len = Math.hypot(bx - ax, by - ay);
        if (len < 1) continue;
        if (p.still) { stroke(ax, ay, bx, by, len, 0, len, 'trail', 1, l.kind); continue; }
        const head = (e / l.dur) * len;        // run on past the end, so the trail drains into the node
        stroke(ax, ay, bx, by, len, head - TRAIL_PX, head, 'trail', 1, l.kind);
        stroke(ax, ay, bx, by, len, head - SPARK_PX, head, 'spark', 1, l.kind);
      }
    }
    for (const p of pulses) {
      const e0 = t - p.t0;
      for (const n of p.nodes) {
        const f = p.still ? (e0 >= 0 && e0 < STILL_MS ? [0.9, 1] : null) : flareAt(e0 - n.start);
        if (!f) continue;
        const [x, y] = at(pinAt(n.id) || n.ll);
        flare(x, y, n.r, f[0], f[1], n.kind);
      }
    }
    pctx.globalAlpha = 1;
    pctx.shadowBlur = 0;
    pctx.setLineDash([]);
  }

  // A stretch of a link, from `from` to `to` px along it (clipped to the
  // link), in the colours of what is known of the hop (`tone`, HOPS): the
  // trail fainter, the spark white-hot, both glowing; the afterglow the
  // trail's colour, softer, at `g` of its brightness. Colour is not the only
  // channel: a hop heard is solid, one assumed dashed, one missed dotted.
  function stroke(ax, ay, bx, by, len, from, to, kind, g, tone) {
    const a = Math.max(0, from), b = Math.min(len, to);
    if (b <= a) return;
    const T = HOPS[tone] || HOPS.heard;
    const ux = (bx - ax) / len, uy = (by - ay) / len;
    pctx.beginPath();
    pctx.moveTo(ax + ux * a, ay + uy * a);
    pctx.lineTo(ax + ux * b, ay + uy * b);
    pctx.setLineDash(kind === 'spark' ? [] : T.dash);
    if (kind === 'spark') {
      pctx.globalAlpha = 1; pctx.strokeStyle = T.spark; pctx.lineWidth = 4.5;
      pctx.shadowColor = T.sparkGlow; pctx.shadowBlur = 6;
    } else if (kind === 'glow') {
      pctx.globalAlpha = 0.6 * g; pctx.strokeStyle = T.trail; pctx.lineWidth = 3.5;
      pctx.shadowColor = T.glow; pctx.shadowBlur = 9;
    } else {
      pctx.globalAlpha = 0.85; pctx.strokeStyle = T.trail; pctx.lineWidth = 4;
      pctx.shadowColor = T.glow; pctx.shadowBlur = 10;
    }
    pctx.stroke();
  }

  // A node's flare over a pin of radius r: the logo's halo and hot core
  // (.load-logo i::before, ::after), sized to the pin as the logo sizes them to
  // its node, in the colours of what is known of it.
  function flare(x, y, r, op, sc, tone) {
    const T = HOPS[tone] && HOPS[tone].halo ? HOPS[tone] : HOPS.heard;
    const s = Math.max(14, 2 * r + 2);
    const halo = 2.4 * s * sc, core = 0.62 * s * sc;
    pctx.globalAlpha = Math.max(0, Math.min(1, op));
    pctx.shadowBlur = 0;
    let g = pctx.createRadialGradient(x, y, 0, x, y, halo);
    g.addColorStop(0, T.halo[0]);
    g.addColorStop(0.12, T.halo[0]);
    g.addColorStop(0.24, T.halo[1]);
    g.addColorStop(0.42, T.halo[2]);
    g.addColorStop(0.68, T.halo[3]);
    pctx.fillStyle = g;
    pctx.beginPath(); pctx.arc(x, y, halo, 0, 2 * Math.PI); pctx.fill();
    g = pctx.createRadialGradient(x, y, 0, x, y, core);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.22, '#ffffff');
    g.addColorStop(0.45, T.core[0]);
    g.addColorStop(0.8, T.core[1]);
    g.addColorStop(1, T.core[1]);
    pctx.fillStyle = g;
    pctx.shadowColor = T.glow;
    pctx.shadowBlur = 8;
    pctx.beginPath(); pctx.arc(x, y, core, 0, 2 * Math.PI); pctx.fill();
    pctx.shadowBlur = 0;
  }

  // A node's afterglow: a ring round the pin with a soft halo outside it, the
  // pin itself left clear so its own colour still reads. Clipped to outside
  // the ring's inner edge: the stroke's shadow blurs inward too, and round a
  // radius-4 pin it washed the whole pin a quarter green.
  function ring(x, y, r, g, tone) {
    const T = HOPS[tone] && HOPS[tone].ring ? HOPS[tone] : HOPS.heard;
    const R = r + 3;
    pctx.save();
    pctx.beginPath();
    pctx.rect(0, 0, pctx.canvas.width, pctx.canvas.height);
    pctx.arc(x, y, R - 1.2, 0, 2 * Math.PI);
    pctx.clip('evenodd');
    pctx.globalAlpha = g;
    pctx.shadowBlur = 0;
    pctx.setLineDash([]);
    const h = pctx.createRadialGradient(x, y, R - 1, x, y, R + 11);
    h.addColorStop(0, T.ring[0]);
    h.addColorStop(0.35, T.ring[1]);
    h.addColorStop(1, T.ring[2]);
    pctx.fillStyle = h;
    pctx.beginPath();
    pctx.arc(x, y, R + 11, 0, 2 * Math.PI);
    pctx.arc(x, y, R - 1, 0, 2 * Math.PI, true);
    pctx.fill();
    pctx.strokeStyle = T.trail;
    pctx.lineWidth = 2.4;
    pctx.shadowColor = T.glow;
    pctx.shadowBlur = 8;
    pctx.beginPath(); pctx.arc(x, y, R, 0, 2 * Math.PI); pctx.stroke();
    pctx.restore();
  }

  // The card's line again, in place — a repaint of the pane would take the
  // focus off whatever somebody was pressing.
  function paintLive() {
    const el = document.getElementById('lat-live-status');
    if (el) el.innerHTML = liveStatusHtml();
  }

  // ── The legend, the map's name, Map display's note ────────────────────────

  function legendHtml() {
    if (!U.on) return '';
    const mode = U.mode;
    const t = (mode === 'age' && (netKnown() || W.A)) || (mode !== 'age' && W.A) ? summary() : null;
    const by = mode === 'snr' ? 'signal' : 'latency';
    const rows = BANDS[mode].map(b => ({ k: b.k, label: b.label, word: b.word }))
      .concat(specialsFor(mode).map(k => ({ k, label: k === 'unknown' ? UNKNOWN_LABEL[mode] : SPECIAL[k].label })));
    return `<span class="legend-item legend-lat-h"><span class="small"><strong>⏱️ ${mode === 'snr' ? 'Signal' : 'Latency'} — ${esc(MODES[mode].long)}</strong></span></span>`
      + rows.map(r => `
      <span class="legend-item">
        ${swatch(r.k, mode)}
        <span class="small">${r.word ? `${wordHtml(r)} · ${esc(r.label)}` : esc(r.label[0].toUpperCase() + r.label.slice(1))}${t ? ` <span class="txt-muted">(${num(t.bands.get(r.k) || 0)})</span>` : ''}</span>
      </span>`).join('') + `
      <span class="legend-item legend-off">
        <span class="small txt-muted">Pins are coloured by ${by}, not by role${t && U.scope === 'view' ? ' — counted in view' : ''}. The worse bands are a step bigger.
          Shapes and the forecast and information outlines are as always. ⏱️ Latency &amp; signal in the side panel says more.</span>
      </span>`;
  }

  // The signal bars' key in the 🔑 legend, while they are on — under any
  // colouring of the pins.
  function barsLegendHtml() {
    if (!U.bars) return '';
    const t = W.A ? summary() : null;
    return `<span class="legend-item legend-lat-h"><span class="small"><strong>${termHtml('Signal bars', WORDS['Signal bars'])} — each station’s ${snrTerm()}</strong></span></span>`
      + BANDS.snr.map(b => `
      <span class="legend-item">
        ${barsSvg(b.bars, b.fill)}
        <span class="small">${wordHtml(b)} · ${esc(b.label)}${t ? ` <span class="txt-muted">(${num(t.snr.bands.get(b.k) || 0)})</span>` : ''}</span>
      </span>`).join('') + `
      <span class="legend-item legend-off">
        <span class="small txt-muted">${t ? 'No bars: no SNR from it in the window.' : 'Fetching the readings for the bars…'} Decodes stop near ${SNR_FLOOR} dB.</span>
      </span>`;
  }

  // The animation's line in the 🔑 legend, while it runs — with the pins in
  // their roles' colours, health's or latency's alike.
  function liveLegendHtml() {
    if (!U.anim) return '';
    return `
      <span class="legend-item">
        <span class="lat-live-dot" aria-hidden="true"></span>
        <span class="small">Flashing green: a message from it just landed in the log${calm() ? '' : ', a pulse running along its links'};
          glowing green: it reported in the last minute</span>
      </span>` + HOP_KEYS.map(k => `
      <span class="legend-item">
        <span class="lat-hop lat-hop--${k}" aria-hidden="true"></span>
        <span class="small">${termHtml(HOPS[k].word, HOPS[k].meaning)} ${k === 'heard' ? 'hop (solid)' : k === 'assumed' ? 'hop (dashed)' : 'link (dotted)'}</span>
      </span>`).join('');
  }

  // A clause for the map's accessible name while the pins wear it.
  function altText() {
    if (!U.on) return '';
    const by = U.mode === 'snr' ? 'signal' : 'latency';
    if (U.mode !== 'age' && !W.A) return `pins coloured by ${by} (${MODES[U.mode].label}) once the readings are in`;
    return `pins coloured by ${by}, ${MODES[U.mode].long} — ${summaryText().replace(/\.$/, '')}`;
  }
  // …and one for the signal bars beside them.
  function barsAltText() {
    if (!U.bars) return '';
    if (!W.A) return 'signal bars beside the pins once the readings are in';
    return `signal bars beside the pins — ${snrSummaryText().replace(/\.$/, '')}`;
  }

  // What Map display's health switch says while this view has the pins.
  function noteText() {
    return U.on ? `Off — the pins are coloured by ${U.mode === 'snr' ? 'signal' : 'latency'} (⏱️ Latency & signal, in the side panel).` : '';
  }

  // ── The map ───────────────────────────────────────────────────────────────

  function attach(m) {
    map = m;
    root = null;
    MapChrome.panel(m, {
      id: 'latency', icon: '⏱️', dockIcon: Glyphs.rail('latency'), title: 'Latency & signal',
      btnLabel: 'Latency & signal — colour the pins by how fresh each station’s data is or by its SNR, show its SNR as signal bars beside each pin, and see its checks slot by slot',
      group: 'show', order: 40,
      html: () => `<div class="lat-pane" id="map-latency-panel">${paneHtml()}</div>`,
      onMount(el) { root = el.querySelector('#map-latency-panel'); },
    });
    m.on('moveend', onMove);
    // Last-heard times landing repaint the pins the age colouring is made of.
    if (!netHooked && HealthGlance.onNet) {
      netHooked = true;
      HealthGlance.onNet(() => { dirty(); if (U.on && U.mode === 'age') repins(); else paintSoon(); });
    }
    // A pane made wider or narrower draws its strip and chart again at the new
    // width, so their text stays the size it says.
    if (!resizeObs && typeof ResizeObserver !== 'undefined') {
      resizeObs = new ResizeObserver(() => {
        const r = rootEl();
        if (!r || !U.sel || !r.clientWidth) return;
        if (Math.abs(r.clientWidth - paintedW) > 24) paintSoon();
      });
    }
    setTimeout(() => { const r = rootEl(); if (r && resizeObs) resizeObs.observe(r); }, 0);
    // The log watched again on a map built new, if the box is ticked — after
    // this turn, when the Stations tab is the active one; and paused while the
    // page is out of sight.
    if (!visHooked && typeof document !== 'undefined') {
      visHooked = true;
      document.addEventListener('visibilitychange', () => { if (U.anim) liveSync(); });
    }
    setTimeout(() => { if (map === m) liveSync(); }, 0);
  }

  function detach() {
    if (map) { try { map.off('moveend', onMove); } catch (_) {} }
    if (resizeObs) resizeObs.disconnect();
    // The log stops being watched with the map gone (liveWanted), and every
    // pulse with it.
    dropCanvas();
    map = null;
    liveSync();
    graph = null; graphFor = null; pinIdx = null; pinIdxFor = null;
    root = null;
    if (paintTimer) { clearTimeout(paintTimer); paintTimer = null; }
    if (pinTimer) { clearTimeout(pinTimer); pinTimer = null; }
  }

  return {
    attach, detach, reset, shown, opened, showBars, follow, pinStyle, barsFor,
    legendHtml, liveLegendHtml, barsLegendHtml, altText, barsAltText, noteText,
    on: () => U.on,
    anim: () => U.anim,
    hidden: () => U.hidden,
    bars: () => U.bars,
    mode: () => U.mode,
    wantsHiddenLinks, hiddenLinks,
    setOn, setAnim, setThroughHidden, setBars, power, setMode, setWin, setScope, pickBand, back, focus, refresh, openHealth, yieldTo,
    // The rules, for test/latency.mjs.
    classifyValue, quantile, BANDS, SPECIAL, fmtDelay,
    classOf: (id, mode) => { const s = stationById(id); return s ? classOf(s, mode) : null; },
    _state: () => ({ on: U.on, anim: U.anim, bars: U.bars, mode: U.mode, win: U.win, scope: U.scope, sel: U.sel, band: U.band,
                     window: { key: W.key, status: W.status, rows: W.rows, borrowed: W.borrowed, error: W.error } }),
    // The log being watched, the pulses running and the way one would run,
    // for test/latency.mjs — the canvas has nothing else to ask.
    _live: () => ({ status: LV.status, watching: !!LV.timer, cursor: LV.cursor, fired: LV.fired.slice(), firedN: LV.firedN,
                    pulses: pulses.length, canvas: !!pcanvas, held: [...LV.held.keys()],
                    glowing: pulses.filter(p => performance.now() - p.t0 >= p.anim).map(p => p.id),
                    batches: LV.batches.map(b => ({ n: b.n, ids: b.ids.length, lost: b.lost })) }),
    // A route for a message — { keys: ['a:<address>' | 'a2:<address>'], t } —
    // and the copies a test lays in place of the receivers' (warm: the window
    // of measured legacy bursts the carriers are found in; live: what landed),
    // with where each receiver is. Fed so, the receptions are not asked for.
    _route: (id, msg) => {
      const p = route(id, copiesOf(testMsg(msg)));
      return p && { nodes: p.nodes.map(n => ({ id: n.id, start: n.start, kind: n.kind })),
                    legs: p.legs.map(l => ({ from: l.fromId, to: l.to, start: l.start, dur: l.dur, tail: l.tail, kind: l.kind, straight: l.straight })),
                    anim: p.anim, life: p.life, proved: p.proved };
    },
    _hear: ({ points = [], warm = [], live = [] } = {}) => {
      rxReset('ok');
      RX.fed = true;
      setPoints(points);
      warm.forEach(addBurst);
      RX.bursts.forEach((_, pk) => findCarriers(pk));
      RX.warmAt = now_();
      hear(live);
      paintLive();
      return { kept: [...RX.kept].map(([pk, k]) => [pk, [...k.keys()]]), copies: RX.copies.length,
               how: RX.copies.map(c => c.b && { how: c.b.how, rid: c.b.rid }) };
    },
    _rx: () => ({ status: RX.status, cursor: RX.cursor, copies: RX.copies.length, played: RX.played, matched: RX.matched,
                  kept: [...RX.kept].map(([pk, k]) => [pk, [...k.keys()]]) }),
    _askNow: () => livePoll(),
    _fire: (id, msg) => fire(id, testMsg(msg)),
  };
})();

if (typeof window !== 'undefined') window.MapLatency = MapLatency;
