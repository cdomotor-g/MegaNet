// MegaNet — repeaters.js
//
//   Repeaters   🔁 Repeaters, under Stations & networks: every repeater on
//               file in one place. A map of the links between them — two
//               repeaters whose pass ranges share an address, close enough to
//               hear each other — and from each to the base stations in reach;
//               then a table, sortable by any column, of each repeater's
//               station number, network, channel, the addresses and field
//               stations its pass ranges carry, its links, its pass ranges set
//               against what the base stations hear it relaying, its carrier
//               offset and its delay. A row opens to list the stations it
//               passes on, each a link to the Stations tab, with its links,
//               what it was heard relaying and its carrier. A link pressed
//               on the map — or "profile & budget" beside one in an opened
//               row — opens the ground between its two ends and its link
//               budget, each way it carries traffic, under the map.
//
// It began as the By Repeater card on the ALERT IDs tab (pass-ranges.js),
// which listed the first ten stations a repeater carries and sent a click on
// the row to the Stations tab. October 2026 gave it a tab of its own: the row
// opens in place instead, the stations are all there, the card can be opened
// to the full list, and the CSV goes with it.
//
// ── Where each column comes from ─────────────────────────────────────────────
//   the register        name, number, networks, channel, pass ranges and
//                       exclusions, recorded delay — the loaded station file.
//   app.js              the addresses and field stations each repeater's
//                       ranges carry (passRelationIndex), and the shared
//                       filter rules the ALERT IDs box runs (prepareSearch,
//                       passRangeRepeaterMatch from pass-ranges.js).
//   map-backbone.js     the links: backboneLinks(km), the same pairs the
//                       Stations map draws as backbone paths, at a distance
//                       set here; suggestedRepeaterDelays() for a delay not
//                       recorded — ⏳ Repeater Delays' plan, worked out a beat
//                       after the page is drawn, since it takes half a second.
//   transmitter_summary its carrier offset against the fleet over the last
//   (0077, public)      week, as the server judges it hourly — the
//                       fingerprint every burst it relays carries. Read when
//                       the tab opens, again after fifteen minutes.
//   signal-routes.js    its pass ranges as heard: which addresses the base
//                       stations heard on its carrier (SignalRoutes.analyse).
//                       The receptions are an editor's (0047), and reading a
//                       week of them takes a minute, so they are read when
//                       asked — or taken as they are when Signal Routes or 🗼
//                       Backbone has read them already this session.
//
// ── A link's ground and budget ───────────────────────────────────────────────
// The Stations map's elevation profile and link budget, for the link pressed:
// the same ground (pathGround — the tiles, or LiDAR where that setting is
// on), the same model over it (pathAnalyse), the same radio at each end
// (radioKey/radioVal, so a figure typed over a station on the Stations map's
// cards is priced here too) and the same frequency rule (radioFreq), so the
// figure here and the figure there are one figure. The path loss is the same
// both ways, so a link between two repeaters is priced both ways from one
// profile, as the fade-margin map prices it; a repeater to its base, one way.
// The chart is drawn here, not borrowed: the profile card's own (PathProfile)
// is wired to the Stations map's drawn line, its cursor and its full screen.
// What this card leaves out — changing a figure, the cursor, the second
// opinion, a copy for a report — is a press away on the Stations map
// (MapBackbone.openOnStations), the hand-off the Network View popup makes.
//
// ── The map's overlays ───────────────────────────────────────────────────────
// The map's 🗺️ Layers carries the base maps and four of the Stations map's
// overlays — ground height, council areas (with their shading), maintenance
// hubs and drainage basins — drawn by those layers' own modules on this map,
// remembered on the device apart from the Stations map's. "The map's
// overlays", below, says which were left out and why.
//
// After core.js, datastore.js (dbSelect), app.js, pass-ranges.js,
// map-backbone.js, map-controls.js (addBaseLayers, MapChrome), map-elevation.js,
// map-councils.js, map-hubs.js, map-catchments.js, signal-routes.js,
// terrain.js, land-cover.js, path-profile.js and link-budget.js (LB_MARGIN,
// lbMarginClass), all read at call time; before init.js. Nothing runs at load: app.js's
// renderMain() calls render() and init(); auth.js calls authChanged().

const Repeaters = (() => {

  const REFRESH_MS = 15 * 60e3;    // carriers and what was heard read again after this, if the tab is opened
  const AIR_DAYS = 7;              // the receptions read for the pass ranges as heard, before 0092
  const KM_DEFAULT = 100;          // the Stations map's Max TX distance default
  const KM_MAX = 300;
  const WARN_PPM = 2.5;            // the server's off-channel line (tx_offset_warn_ppm)
  const RUNS_SHOWN = 8;            // heard runs in a cell; the rest when the row opens
  const LIST_SHOWN = 24;           // addresses listed in a detail line before "and N more"
  const LS_SORT = 'mn-rpt-sort', LS_FULL = 'mn-rpt-full', LS_KM = 'mn-rpt-km', LS_LAYERS = 'mn-rpt-layers';
  // The frame and the transmitter's coming up, the Repeater Delays plan's own
  // figures (delay-plan.js), taken off a measured turnaround to leave the delay.
  const FRAME_MS = 133, LEAD_MS = 300;
  const frameMs = () => (typeof DelayPlan !== 'undefined' && DelayPlan.DEFAULTS ? DelayPlan.DEFAULTS.frameMs : FRAME_MS);
  const leadMs = () => (typeof DelayPlan !== 'undefined' && DelayPlan.DEFAULTS ? DelayPlan.DEFAULTS.leadMs : LEAD_MS);

  // ── The words this page uses in its own sense ──────────────────────────────
  // Every heading, chip and figure whose word means something particular here
  // carries its meaning on hover (core.js termHtml), from this one list; the
  // same list is the "What the words on this page mean" fold, for a finger or
  // a keyboard, which never hover. The distances follow the setting.
  function words() {
    const km = `${S.km} km`;
    return {
      repeater: 'A station that listens for ALERT messages and sends them on again, so a reading reaches a base station its own radio cannot. Which messages it sends on is set by its pass ranges.',
      stn: 'The station number the register holds for the site — the Bureau\'s number for it.',
      network: 'The radio network (or networks) the register puts the repeater in.',
      channel: 'The frequency the repeater listens on, then the one it sends on, in MHz — one number when they are the same.',
      addresses: 'How many of the network\'s ALERT addresses on file fall inside this repeater\'s pass ranges, exclusions taken out: the readings it should pass on.',
      stations: 'Field stations with at least one ALERT address inside this repeater\'s pass ranges — the stations it should pass on. Open the row to list them.',
      links: `Other repeaters within ${km} whose pass ranges let through at least one of the same ALERT addresses, so one would pass on what the other sends. "base" means a base station is within ${km} as well.`,
      set: 'The ALERT address windows on record for this repeater — what it should be programmed to pass on. Exclusions on record are taken out of them.',
      heard: 'The addresses the base stations heard this repeater relaying, on its own carrier, over the last week — written as runs of addresses on file, a run ending where an address was heard coming in another way. Set it beside the pass ranges on record. Worked out hourly from every burst the base stations decode.',
      offrec: 'Heard relayed on this repeater\'s carrier, but in none of its pass ranges on record: the record or the radio wants correcting.',
      elsewhere: 'In its pass ranges on record, and heard on days its carrier was found, but never on its carrier: it does not seem to relay these.',
      notFound: 'Its carrier was not picked out at any base station over the last week. It may have been quiet, out of the receivers\' reach, or relaying too few addresses to pick out.',
      cfo: `How far this repeater's transmitter frequency sits from the other transmitters the same base stations hear, over the last week: the median of every burst it relayed, in hertz and parts per million. 0 is "like the rest", not "exactly on frequency"; past ±${WARN_PPM} ppm decodes start to suffer. Sorted by its size, either side of the rest.`,
      actual: `How long the repeater really waits after hearing a reading before sending it on: the delay recorded on its station when there is one, else measured — its turnaround (below) less the ${frameMs()} ms frame and the ${leadMs()} ms the app takes its transmitter to need to come up, which nobody has timed on these radios.`,
      recorded: 'The delay recorded on the repeater\'s station, as it was set in the field.',
      turnaround: 'Measured on the air: how long after a station\'s own burst the same base station hears this repeater\'s copy of it — the same address and value, the receiver\'s clock the same for both. The median over the last week, with the middle half of the gaps and how many there were. It is the repeater\'s delay, its transmitter coming up and the frame.',
      measuredDelay: `Its turnaround less the ${frameMs()} ms frame and an assumed ${leadMs()} ms for its transmitter to come up: what is left is its delay, give or take how long this radio really takes to key up.`,
      plan: 'The delay ⏳ Repeater Delays plans for this repeater, so repeaters relaying the same reading do not send their copies on top of each other. A plan, not what it is set to.',
      linkKm: 'How far apart two sites may be and still count as hearing each other. A distance, not a coverage model: a hill can break a link drawn here, and a long clear path can make one it leaves out.',
      rrLink: `Two repeaters within ${km} of each other whose pass ranges both let at least one ALERT address through — a message one sends on, the other would take and send on again.`,
      baseLink: `A repeater within ${km} of a base station: where what it relays can be received.`,
      isolated: `No repeater within ${km} shares an address with it and no base station is within ${km}: what it relays may have nowhere to go — or its real link is longer than ${km}.`,
      measured: 'Repeaters whose carrier the base stations measured in the last week, against the fleet — the server judges it hourly.',
      found: 'Repeaters whose carrier was picked out at a base station over the last week, so what they relay is known.',
      timed: 'Repeaters whose turnaround was measured over the last week: a station\'s own burst and the repeater\'s copy of it, both heard at one base station.',
      // The map's overlay layers (🗺️ Layers on the map).
      layElev: 'The ground itself as colour, in the Radio Mobile colour file\'s height bands (the key is under the switch), from ~30 m terrain tiles, above the EGM96 geoid — the Stations map\'s elevation shading. A picture of the ground: a link\'s own ground is read when it is pressed.',
      layCouncils: 'Council areas: each local government area (LGA) — the area one council governs — outlined, and named once the map is close enough for the name to fit. The Australian Bureau of Statistics\' set (2026), an approximation of the legal boundaries.',
      layShade: 'Each council area filled with a soft tint of its own, so the areas read at a glance. The tints only tell neighbours apart — no two councils that share a border have the same one — and mean nothing else.',
      layHubs: 'The Bureau\'s eight field maintenance hubs, as at May 2018, each in its own colour: whose hub a repeater is in, and so who drives out to it.',
      layBasins: 'The 77 Queensland drainage basins, coloured by which way the water goes and named from zoom 7: which basin a repeater\'s stations are in.',
      // A link pressed on the map: its ground and its budget.
      pathCard: 'The ground between the two sites, cut along the straight line joining them with the curve of the earth added, and what the signal gains and loses on its way from one antenna to the other. A model of the path, not a measurement of it.',
      verdict: 'Read off the picture, and a description of the geometry rather than a verdict on the link — the fade margin is that. Clear: nothing on the ground reaches the 60% Fresnel zone the whole way. Partly clear: ground or trees reach into it but stay under the line of sight, as on most long VHF paths. Obstructed: they rise above the line of sight, and the signal bends over them. The path loss counts what either costs.',
      fresnel: 'The space round the straight line between the two antennas that the signal needs clear to arrive at full strength — fattest half way along. Ground or trees reaching into 60% of it start to cost signal.',
      beyond: typeof PATH_BEYOND_MEANING !== 'undefined' ? PATH_BEYOND_MEANING
        : 'The ground for a short way past each antenna, on along the same line, so you can see what each end stands on. Drawn faded: no figure on the card is worked out from it.',
      fade: `How far the signal arriving is above the weakest the receiver can decode (its RX threshold), in decibels, by the model. ${fadeGood()} dB or more is good; ${fadeOk()} to ${fadeGood()} is marginal — growth, rain or a season could eat it; under ${fadeOk()} is poor.`,
      eirp: 'The power leaving the transmitting antenna: the radio\'s TX power, plus the antenna\'s gain, less what the cable up to it loses.',
      fspl: 'What the signal loses spreading out over the distance, as though nothing stood in the way.',
      terrain: 'What the hills and the curve of the earth cost on top of free space, by Longley–Rice — the model Radio Mobile runs — over the ground drawn above.',
      stats: 'The model\'s allowance for the path having a worse day than its middle one, set by how much of the time, the places and the situations the figure must hold for (the propagation settings on the Stations map\'s link budget).',
      floor: 'The line of sight is cut, but the model priced the path lighter than one knife edge over the worst ridge would cost — so the loss is held up to that knife edge.',
      allowance: `What the model over bare ground was found to read above margins measured on site with an attenuator — trees and roofs round the masts, cables and connectors, receivers at busy sites: ${fieldAllowance()} dB, taken off every path.`,
      clutter: 'What an antenna standing lower than the trees or buildings round it loses to them (ITU-R P.2108), wherever the land-cover model finds an end so.',
      pathLoss: 'Everything the signal loses between the two antennas: the rows above it, added up.',
      received: 'The signal arriving at the receiver once every gain and loss above is counted, in dBm.',
      threshold: 'The weakest signal the receiving radio can still decode: its station\'s radio system on file, or what has been typed over it on the Stations map\'s cards this session.',
    };
  }
  let W = null;
  const word = k => (W || (W = words()))[k];
  const term = (k, text) => termHtml(text, word(k));
  const GLOSSARY = [
    ['repeater', 'Repeater'], ['stn', 'Stn #'], ['network', 'Network'], ['channel', 'Channel'], ['addresses', 'Addresses'],
    ['stations', 'Stations'], ['links', 'Links'], ['set', 'Pass ranges (set)'], ['heard', 'Pass ranges (heard)'],
    ['offrec', 'Off record'], ['elsewhere', 'Only another way'], ['notFound', 'Not picked out'], ['cfo', 'Carrier offset'],
    ['actual', 'Delay (actual)'], ['recorded', 'Recorded'], ['turnaround', 'Turnaround'], ['measuredDelay', 'Measured'],
    ['plan', 'Delay (planned)'], ['linkKm', 'Link distance'], ['rrLink', 'Repeater to repeater'],
    ['baseLink', 'Repeater to base station'], ['isolated', 'Linked to nothing'],
    ['layElev', 'Ground height as colour'], ['layCouncils', 'Council areas (LGA boundaries)'], ['layShade', 'Shade each council area'],
    ['layHubs', 'Maintenance hubs'], ['layBasins', 'River catchments'],
    ['pathCard', 'Ground profile and link budget'], ['verdict', 'Clear, Partly clear, Obstructed'], ['fresnel', '60% Fresnel zone'],
    ['beyond', 'Ground past each end'],
    ['fade', 'Fade margin'], ['eirp', 'EIRP'], ['fspl', 'Free-space loss'], ['terrain', 'Terrain'], ['stats', 'Statistics'],
    ['floor', 'Obstruction floor'], ['allowance', 'Field allowance'], ['clutter', 'Ground cover'], ['pathLoss', 'Path loss'],
    ['received', 'Received signal'], ['threshold', 'RX threshold'],
  ];
  // The bands and the allowance the words quote, read from the files that set
  // them (link-budget.js, path-profile.js) when the words are written.
  const fadeGood = () => (typeof LB_MARGIN !== 'undefined' ? LB_MARGIN[0].min : 10);
  const fadeOk = () => (typeof LB_MARGIN !== 'undefined' ? LB_MARGIN[1].min : 3);
  const fieldAllowance = () => (typeof pathPropOf === 'function' ? pathPropOf().allowance : 12);

  // The columns: key, heading, its word, whether it is text (sorted A→Z on
  // the first press, the rest biggest first), whether a phone drops it, and
  // its share of the width (the shared table is laid out fixed on a desk).
  const COLS = [
    { key: 'name',    label: 'Repeater',            w: 'repeater',  text: true, pc: 13 },
    { key: 'num',     label: 'Stn #',               w: 'stn',       text: true, opt: true, pc: 6 },
    { key: 'net',     label: 'Network',             w: 'network',   text: true, opt: true, pc: 8 },
    { key: 'chan',    label: 'Channel',             w: 'channel',   opt: true, pc: 7 },
    { key: 'addr',    label: 'Addresses',           w: 'addresses', pc: 8 },
    { key: 'stns',    label: 'Stations',            w: 'stations',  pc: 7 },
    { key: 'links',   label: 'Links',               w: 'links',     opt: true, pc: 5 },
    { key: 'ranges',  label: 'Pass ranges (set)',   w: 'set',       pc: 12 },
    { key: 'heard',   label: 'Pass ranges (heard)', w: 'heard',     pc: 12 },
    { key: 'cfo',     label: 'Carrier offset',      w: 'cfo',       pc: 8 },
    { key: 'delay',   label: 'Delay (actual)',      w: 'actual',    opt: true, pc: 7 },
    { key: 'plan',    label: 'Delay (planned)',     w: 'plan',      opt: true, pc: 7 },
  ];
  const SORT_SAID = { name: 'name', num: 'station number', net: 'network', chan: 'channel', addr: 'addresses', stns: 'stations',
    links: 'links', ranges: 'pass ranges', heard: 'addresses heard', cfo: 'size of carrier offset', delay: 'actual delay', plan: 'planned delay' };

  const S = {
    q: '',
    sort: { key: 'name', dir: 1 },
    open: new Set(),     // rows opened
    pick: null,          // the repeater picked on the map
    full: false,         // the card shows the whole list
    km: KM_DEFAULT,
    read: false,         // this device's settings read
    tsum: null, tsumPhase: 'idle', tsumErr: '', tsumAt: 0,
    // relay_summary (0092): what each repeater was heard relaying and its
    // turnaround, a row a repeater. `missing` is a database before 0092.
    relay: null, relayPhase: 'idle', relayErr: '', relayAt: 0, relayMissing: false,
    air: '',             // '' | 'loading'
    planReady: false, planTimer: null,
    map: null, layer: null, fitted: false,
    fmap: null, flayer: null,   // the map full screen, while it is open
    // The overlays both maps draw (🗺️ Layers on the map), remembered on this
    // device apart from the Stations map's own; what each map has drawn of
    // them (a handle per layer, per map); and which files could not be read.
    lay: { elev: false, elevOp: 0.6, councils: false, shade: false, shadeOp: 0.22, hubs: false, basins: false },
    lh: new Map(), layFail: {},
    M: null, key: null,
    // The link whose ground and budget are open under the map: { a, b } the
    // two station ids, A first, and what was worked out for them (computePath).
    path: null, pathGen: 0, pathOpener: null, pathShown: '', pathW: 0, pathResize: null,
  };

  const num = n => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString());
  const plural = (n, one, many) => `${num(n)} ${Number(n) === 1 ? one : (many || one + 's')}`;
  const sgn = (v, d) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`;
  const fin = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const stations = () => (typeof state !== 'undefined' && state.data && state.data.stations) || [];
  const signedIn = () => typeof Auth !== 'undefined' && Auth.isSignedIn();
  const active = () => typeof state !== 'undefined' && state.activeTab === 'repeaters';
  const placed = s => s && s.lat != null && s.lon != null;
  const isRep = s => (s.roles || []).includes('repeater') && !!s.repeater;
  const rangeText = p => (p.low === p.high ? `${p.low}` : `${p.low}–${p.high}`);
  const clock = t => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  function readLS(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function writeLS(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } }

  function readSettings() {
    if (S.read) return;
    S.read = true;
    try {
      const s = JSON.parse(readLS(LS_SORT) || 'null');
      if (s && COLS.some(c => c.key === s.key) && (s.dir === 1 || s.dir === -1)) S.sort = { key: s.key, dir: s.dir };
    } catch (_) { /* a hand-edited store */ }
    S.full = readLS(LS_FULL) === '1';
    const km = Number(readLS(LS_KM));
    if (Number.isFinite(km) && km >= 10 && km <= KM_MAX) S.km = km;
    try {
      const l = JSON.parse(readLS(LS_LAYERS) || 'null');
      if (l && typeof l === 'object') {
        for (const k of ['elev', 'councils', 'shade', 'hubs', 'basins']) if (typeof l[k] === 'boolean') S.lay[k] = l[k];
        if (Number.isFinite(l.elevOp)) S.lay.elevOp = clampOp('elevOp', l.elevOp);
        if (Number.isFinite(l.shadeOp)) S.lay.shadeOp = clampOp('shadeOp', l.shadeOp);
      }
    } catch (_) { /* a hand-edited store */ }
  }

  // ── What is known ─────────────────────────────────────────────────────────

  // What was heard, the server's way (0092): relay_summary's row, put in the
  // shape Signal Routes' analysis gives a repeater, so one drawing serves
  // both. Its off-record addresses are weighed as Signal Routes weighs them —
  // two copies or more on its carrier is it relaying the address; one copy,
  // or nearly every burst of it on its carrier, may be; less is a stray.
  function relayX(row) {
    const arr = k => (Array.isArray(row[k]) ? row[k].map(Number) : []);
    const relayed = arr('relayed'), rn = arr('relayed_n');
    const off = arr('off_record'), dup = arr('off_dup'), own = arr('off_own'), all = arr('off_all');
    const offrec = off.map((a, i) => {
      const d = dup[i] || 0, o = own[i] || 0, n = all[i] || 0;
      const evidence = d >= 2 ? 'copies' : d === 1 || (o >= 3 && o >= 0.8 * Math.max(1, n)) ? 'possible' : 'stray';
      return { a, dup: d, own: o, all: n, evidence };
    }).filter(o => o.evidence !== 'stray');
    return {
      confirmed: new Map(relayed.map((a, i) => [a, rn[i] || 0])),
      offrec,
      elsewhere: new Map(arr('elsewhere').map(a => [a, { n: 0 }])),
      days: fin(row.days) || 0,
      n: fin(row.bursts) || 0,
    };
  }

  // The turnaround measured on the air (0092), or null.
  function gapOf(row) {
    if (!row || !fin(row.gap_n) || fin(row.gap_ms) == null) return null;
    return { ms: fin(row.gap_ms), lo: fin(row.gap_lo_ms), hi: fin(row.gap_hi_ms), n: fin(row.gap_n), days: fin(row.gap_days) };
  }

  // Where the heard column comes from: the server's week when the database
  // keeps it, else Signal Routes' analysis of the receptions read in the
  // browser, for a database before 0092.
  function heardSource() {
    if (S.relay) return { kind: 'server' };
    const A = air();
    return A ? { kind: 'air', A } : null;
  }

  // Signal Routes' analysis of the receptions, when one has been read this
  // session and is real (its demo is made up, and never stands in here).
  function air() {
    if (typeof SignalRoutes === 'undefined' || !SignalRoutes.state) return null;
    const s = SignalRoutes.state();
    return s && s.phase === 'ready' && s.A && !s.A.demo ? s.A : null;
  }
  function airState() {
    return typeof SignalRoutes !== 'undefined' && SignalRoutes.state ? SignalRoutes.state() : null;
  }

  // What the base stations heard a repeater relay, as runs over the addresses
  // on file. An address heard on its carrier joins a run; one heard coming in
  // another way ends it — in its ranges and heard on a day its carrier was
  // found but never on it, or outside its ranges altogether. Its own sensors'
  // addresses, and one in its ranges nobody heard either way, say nothing and
  // neither join nor end a run. Off record (heard on its carrier, in no range
  // of its) is a run of its own, never part of one on record.
  function heardOf(st, x, addrs) {
    const own = new Set(stationAlertIds(st));
    const H = new Map();
    x.confirmed.forEach((_, a) => H.set(a, 'rec'));
    x.offrec.forEach(o => { if (!H.has(o.a)) H.set(o.a, 'off'); });
    const all = [...new Set(addrs.concat([...H.keys()]))].sort((p, q) => p - q);
    const runs = [];
    let cur = null;
    for (const a of all) {
      const kind = H.get(a);
      if (kind) {
        if (cur && cur.kind === kind) { cur.hi = a; cur.n++; } else { if (cur) runs.push(cur); cur = { lo: a, hi: a, kind, n: 1 }; }
        continue;
      }
      if (own.has(a)) continue;
      if (passRangeCoversId(st.repeater, a) && !x.elsewhere.has(a)) continue;
      if (cur) { runs.push(cur); cur = null; }
    }
    if (cur) runs.push(cur);
    return {
      runs, days: x.days, bursts: x.n,
      inRange: x.confirmed.size,
      off: x.offrec.map(o => ({ a: o.a, evidence: o.evidence, copies: o.dup })),
      elsewhere: [...x.elsewhere.keys()].sort((p, q) => p - q),
    };
  }

  // The links at the distance set: each repeater's neighbours, and the bases
  // in reach. A station that is a base as well as a repeater pairs on the
  // repeater rule (map-backbone.js), and counts as a base in reach too.
  function linkIndex(pairs) {
    const by = new Map();
    const of = id => { let x = by.get(id); if (!x) by.set(id, x = { reps: [], bases: [] }); return x; };
    for (const p of pairs) {
      if (p.kind === 'base') { of(p.a.id).bases.push({ st: p.b, km: p.km }); continue; }
      of(p.a.id).reps.push({ st: p.b, km: p.km, overlap: p.overlap });
      of(p.b.id).reps.push({ st: p.a, km: p.km, overlap: p.overlap });
      if ((p.b.roles || []).includes('base')) of(p.a.id).bases.push({ st: p.b, km: p.km });
      if ((p.a.roles || []).includes('base')) of(p.b.id).bases.push({ st: p.a, km: p.km });
    }
    by.forEach(x => { x.reps.sort((p, q) => p.km - q.km); x.bases.sort((p, q) => p.km - q.km); });
    return by;
  }

  // Everything the page draws, worked out once for each state of what it
  // reads — the file, the pass-range and backbone indexes built on it, the
  // receptions, the carriers, the distance and the delay plan — and handed
  // out from there, so a sort, a row opened or a keystroke costs a render.
  function model() {
    if (typeof state === 'undefined' || !state.data) return null;
    const rel = passRelationIndex();
    const bb = backboneIndex();
    const src = heardSource();
    const A = src && src.kind === 'air' ? src.A : null;
    const key = [state.data, rel, bb, S.relay, A, S.tsum, S.km, S.planReady ? (state.delayPlans || 1) : 0];
    if (S.M && S.key && key.every((v, i) => v === S.key[i])) return S.M;
    const pairs = backboneLinks(S.km).filter(p => placed(p.a) && placed(p.b));
    const links = linkIndex(pairs);
    const planned = S.planReady && typeof suggestedRepeaterDelays === 'function' ? suggestedRepeaterDelays() : null;
    const addrSt = new Map();
    stations().forEach(s => stationAlertIds(s).forEach(a => { if (!addrSt.has(a)) addrSt.set(a, []); addrSt.get(a).push(s); }));
    const rows = stations().filter(isRep).map(st => {
      const rep = st.repeater;
      const L = links.get(st.id) || { reps: [], bases: [] };
      const rrow = S.relay ? S.relay.get(st.id) || null : null;
      const x = S.relay ? (rrow && (rrow.relayed || []).length + (rrow.off_record || []).length ? relayX(rrow) : null)
        : A ? A.repById.get(st.id) : null;
      const gap = gapOf(rrow);
      const t = S.tsum ? S.tsum.get('st:' + st.id) || null : null;
      const carried = findStationMatches(st);
      const ranges = (rep.pass_ranges || []).map(p => ({ low: Number(p.low), high: Number(p.high) }));
      return {
        id: st.id, st, name: st.name || st.id, num: st.station_number || '',
        nets: (st.radio_network_ids || []).map(id => netName(id)),
        rx: fin(rep.rx_mhz), tx: fin(rep.tx_mhz),
        addresses: repeaterPassingCount(st), carried,
        ranges, excl: (rep.exclusions || []).map(p => ({ low: Number(p.low), high: Number(p.high) })),
        links: L, linked: L.reps.length, base: L.bases.length > 0, isolated: placed(st) && !L.reps.length && !L.bases.length,
        heard: x ? heardOf(st, x, rel.addresses) : null,
        cfo: t && fin(t.w_ppm) != null ? { ppm: fin(t.w_ppm), hz: fin(t.w_hz), days: fin(t.w_days), freq: fin(t.freq_mhz) } : null,
        tsumRow: t,
        delayRec: fin(rep.delay_ms), delayPlan: planned ? planned.get(st.id) ?? null : null,
        gap, delayMeas: gap ? Math.round(gap.ms - frameMs() - leadMs()) : null,
      };
    });
    const R = S.relay ? [...S.relay.values()][0] || null : null;
    S.M = { rows, byId: new Map(rows.map(r => [r.id, r])), pairs, addrSt,
            src: src ? src.kind : null, A,
            // The period what was heard covers, whichever source said it.
            heardFrom: R ? R.window_from : A ? A.from : null, heardDays: R ? fin(R.window_days) : A ? A.days : null,
            heardAt: R ? R.judged_at : A ? A.to : null };
    S.key = key;
    return S.M;
  }

  function filtered(M) {
    const q = S.q;
    return q ? M.rows.filter(r => passRangeRepeaterMatch(r.st, r.carried, q)) : M.rows.slice();
  }

  function sortVal(r, k) {
    switch (k) {
      case 'name':   return r.name.toLowerCase();
      case 'num':    return r.num ? String(r.num) : null;
      case 'net':    return r.nets.length ? r.nets.join(', ').toLowerCase() : null;
      case 'chan':   return r.rx ?? r.tx;
      case 'addr':   return r.addresses;
      case 'stns':   return r.carried.length;
      case 'links':  return r.linked + (r.base ? 0.5 : 0);
      case 'ranges': return r.ranges.length ? Math.min(...r.ranges.map(p => p.low)) : null;
      case 'heard':  return r.heard ? r.heard.inRange + r.heard.off.length : null;
      case 'cfo':    return r.cfo ? Math.abs(r.cfo.ppm) : null;
      case 'delay':  return r.delayRec ?? r.delayMeas;
      case 'plan':   return r.delayPlan;
      default:       return null;
    }
  }
  // What is not known goes last whichever way the column is sorted; a tie
  // falls back on the name.
  function sorted(list) {
    const { key, dir } = S.sort;
    return list.map(r => ({ r, v: sortVal(r, key) })).sort((a, b) => {
      const an = a.v == null, bn = b.v == null;
      if (an || bn) return an && bn ? a.r.name.localeCompare(b.r.name) : an ? 1 : -1;
      const c = typeof a.v === 'string' ? a.v.localeCompare(b.v, undefined, { numeric: true }) : a.v - b.v;
      return c ? dir * c : a.r.name.localeCompare(b.r.name);
    }).map(x => x.r);
  }

  // ── Drawing: the cells ────────────────────────────────────────────────────

  function stationHref(id) {
    return `?tab=stations&station=${encodeURIComponent(id)}`;
  }
  // A station's name as the link it is: underlined in the link colour, a real
  // address behind it so it opens in a new tab like any other, and the app's
  // own way to the Stations tab for a plain click.
  function stationLink(s, html) {
    return `<a class="rptr-stn" href="${escAttr(stationHref(s.id))}" onclick="return Repeaters.openStation(event,'${escAttr(s.id)}')"
      title="Open ${escAttr(s.name)} on the Stations tab">${html}</a>`;
  }

  function chanHtml(r) {
    if (r.rx == null && r.tx == null) return '<span class="txt-muted">—</span>';
    return r.rx === r.tx || r.tx == null || r.rx == null ? esc(String(r.rx ?? r.tx)) : `${esc(String(r.rx))} → ${esc(String(r.tx))}`;
  }

  function setHtml(r, searchIds, ranges) {
    if (!r.ranges.length) return '<span class="txt-muted">none on record</span>';
    const excl = r.excl.length ? `<br><span class="small txt-muted">less ${r.excl.map(rangeText).join(', ')}</span>` : '';
    return passRangesHtml(r.st.repeater, searchIds, ranges) + excl;
  }

  function runHtml(run, searchIds) {
    const t = run.lo === run.hi ? `${run.lo}` : `${run.lo}–${run.hi}`;
    const hit = searchIds.some(id => id >= run.lo && id <= run.hi);
    const inner = hit ? `<mark class="hit">${t}</mark>` : t;
    return run.kind === 'off' ? `<span class="txt-warn rptr-off">${inner}</span>` : inner;
  }

  function heardHtml(r, searchIds) {
    if (!S.M.src) return `<span class="txt-muted">${S.relayPhase === 'loading' ? '…' : '—'}</span>`;
    const h = r.heard;
    if (!h) return `<span class="txt-muted">${term('notFound', 'not picked out')}</span>`;
    const runs = h.runs.slice(0, RUNS_SHOWN).map(x => runHtml(x, searchIds)).join(', ')
      + (h.runs.length > RUNS_SHOWN ? ` <span class="txt-muted">+${num(h.runs.length - RUNS_SHOWN)} more</span>` : '');
    const of = r.addresses != null ? ` of ${num(r.addresses)}` : '';
    const bits = [`${num(h.inRange)}${of} heard`];
    if (h.off.length) bits.push(`<span class="txt-warn term-chip" title="${escAttr(word('offrec'))}">${num(h.off.length)} off record</span>`);
    if (h.elsewhere.length) bits.push(`<span class="term-chip" title="${escAttr(word('elsewhere'))}">${num(h.elsewhere.length)} only another way</span>`);
    return `${runs || '<span class="txt-muted">nothing</span>'}<br><span class="small txt-muted">${bits.join(' · ')}</span>`;
  }

  function cfoHtml(r) {
    if (S.tsumPhase === 'loading' && !S.tsum) return '<span class="txt-muted">…</span>';
    if (!S.tsum) return '<span class="txt-muted">—</span>';
    const c = r.cfo;
    if (!c) return '<span class="txt-muted">not measured</span>';
    const off = Math.abs(c.ppm) >= WARN_PPM;
    const main = c.hz != null ? `${sgn(c.hz, 0)} Hz` : `${sgn(c.ppm, 2)} ppm`;
    const sub = `${c.hz != null ? `${sgn(c.ppm, 2)} ppm · ` : ''}${c.days != null ? plural(c.days, 'day') : ''}`;
    return `<span class="${off ? 'txt-warn rptr-cfo-off' : ''}">${off ? '<span aria-hidden="true">⚠ </span>' : ''}${main}</span><br><span class="small txt-muted">${sub}</span>`;
  }

  // What it is set to: recorded on its station, or measured on the air — and
  // under it whichever the other is, so the two can be set side by side.
  function actualHtml(r) {
    const g = r.gap;
    // How many pairs it rests on, said beside it: one pair is a hint, not a measurement.
    const turn = g ? `<span class="small ${g.n < 3 ? 'txt-warn' : 'txt-muted'}">${num(Math.round(g.ms))} ms turnaround · ${plural(g.n, 'pair')}</span>` : '';
    if (r.delayRec != null) {
      return `${num(r.delayRec)} ms <span class="small txt-muted">recorded</span>${g ? `<br>${turn}` : ''}`;
    }
    if (g) {
      const d = r.delayMeas;
      return `${d >= 0 ? `≈ ${num(d)} ms` : '≈ 0 ms'} <span class="small txt-muted">measured</span><br>${turn}`;
    }
    if (S.relayPhase === 'loading' && !S.relay) return '<span class="txt-muted">…</span>';
    return '<span class="txt-muted">not known</span>';
  }
  function planHtml(r) {
    if (!S.planReady) return '<span class="txt-muted">…</span>';
    if (r.delayPlan == null) return '<span class="txt-muted">—</span>';
    const now = r.delayRec ?? r.delayMeas;
    const off = now != null && Math.abs(now - r.delayPlan) >= 50;
    return `${num(r.delayPlan)} ms${off ? `<br><span class="small txt-warn term-chip" title="${escAttr('The plan asks for a different delay from the one it has now — at least 50 ms out, the plan\'s own step.')}">change</span>` : ''}`;
  }

  function linksHtml(r) {
    if (!placed(r.st)) return '<span class="txt-muted">no position</span>';
    if (r.isolated) return `<span class="txt-warn">${term('isolated', 'none')}</span>`;
    return `${num(r.linked)}${r.base ? ' <span class="rptr-chip">base</span>' : ''}`;
  }

  function sortTh(c) {
    const on = S.sort.key === c.key;
    const dir = S.sort.dir > 0 ? 'ascending' : 'descending';
    return `<th scope="col"${c.opt ? ' class="col-optional"' : ''}${on ? ` aria-sort="${dir}"` : ''}>
      <button type="button" class="th-sort" data-key="${c.key}" onclick="Repeaters.sort('${c.key}')">${term(c.w, c.label)}${
        on ? `<span class="th-arrow" aria-hidden="true">${S.sort.dir > 0 ? '▲' : '▼'}</span>` : ''}</button></th>`;
  }

  // ── Drawing: a row, and the row opened ────────────────────────────────────

  function rowHtml(r, P) {
    const open = S.open.has(r.id);
    const { terms, res, nums, ranges } = P;
    const searchIds = nums.map(Number);
    const hits = S.q ? r.carried.filter(s => passRangeMatch(s, S.q)).length : 0;
    const opt = c => (COLS.find(x => x.key === c).opt ? ' class="col-optional"' : '');
    return `
      <tr class="row-link rptr-row${open ? ' is-open' : ''}${S.pick === r.id ? ' is-picked' : ''}" id="rptr-r-${escAttr(r.id)}"
          onclick="Repeaters.toggle('${escAttr(r.id)}')">
        <td><button type="button" class="row-open rptr-open" id="rptr-b-${escAttr(r.id)}" aria-expanded="${open}"${open ? ` aria-controls="rptr-d-${escAttr(r.id)}"` : ''}
              onclick="event.stopPropagation();Repeaters.toggle('${escAttr(r.id)}')"
              title="${open ? 'Close' : 'Open'} the list of stations ${escAttr(r.name)} passes on"><span class="rptr-chev" aria-hidden="true">▸</span><span>${markHits(r.name, terms, res)}</span></button></td>
        <td${opt('num')}><span class="small">${r.num ? markHits(String(r.num), terms) : '—'}</span></td>
        <td${opt('net')}><span class="small">${r.nets.length ? r.nets.map(esc).join(', ') : '—'}</span></td>
        <td${opt('chan')}><span class="small">${chanHtml(r)}</span></td>
        <td><span class="badge">${r.addresses == null ? '—' : num(r.addresses)}</span></td>
        <td><span class="badge">${num(r.carried.length)}</span>${hits ? ` <mark class="hit">${num(hits)} match</mark>` : ''}</td>
        <td${opt('links')}><span class="small">${linksHtml(r)}</span></td>
        <td class="small">${setHtml(r, searchIds, ranges)}</td>
        <td class="small">${heardHtml(r, searchIds)}</td>
        <td class="small">${cfoHtml(r)}</td>
        <td${opt('delay')}><span class="small">${actualHtml(r)}</span></td>
        <td${opt('plan')}><span class="small">${planHtml(r)}</span></td>
      </tr>${open ? detailHtml(r, P) : ''}`;
  }

  // Addresses, each with whose it is, up to a count and then how many more.
  function addrList(list, M, fmt = a => `${a}`) {
    const shown = list.slice(0, LIST_SHOWN).map(a => {
      const who = (M.addrSt.get(typeof a === 'object' ? a.a : a) || [])[0];
      return `${fmt(a)}${who ? ` <span class="txt-muted">(${esc(who.name)})</span>` : ''}`;
    });
    return shown.join(', ') + (list.length > LIST_SHOWN ? ` and ${num(list.length - LIST_SHOWN)} more` : '');
  }

  function detailHtml(r, P) {
    const M = S.M;
    const { terms, res } = P;
    // The stations it passes on, by name; with a filter running, the ones it
    // matched first and marked, so the row says why it is in the list.
    const byName = r.carried.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const list = S.q ? byName.filter(s => passRangeMatch(s, S.q)).concat(byName.filter(s => !passRangeMatch(s, S.q))) : byName;
    const stns = list.length
      ? `<ul class="rptr-stns">${list.map(s => `<li>${stationLink(s, markHits(s.name, terms, res))}${s.station_number
          ? ` <span class="small txt-muted">${markHits(String(s.station_number), terms)}</span>` : ''}</li>`).join('')}</ul>`
      : '<p class="small txt-muted">No field station has an address in its pass ranges.</p>';
    const reps = r.links.reps.length
      ? `<ul class="rptr-dl">${r.links.reps.map(n => `<li><button type="button" class="link-btn" onclick="Repeaters.goTo('${escAttr(n.st.id)}')">${esc(n.st.name)}</button>
          <span class="small txt-muted">${num(Math.round(n.km))} km · ${plural(n.overlap, 'address', 'addresses')} in both</span>
          ${pathBtn(r, n.st)}</li>`).join('')}</ul>`
      : `<p class="small txt-muted">None within ${num(S.km)} km.</p>`;
    const bases = r.links.bases.length
      ? `<ul class="rptr-dl">${r.links.bases.map(n => `<li>${stationLink(n.st, esc(n.st.name))} <span class="small txt-muted">${num(Math.round(n.km))} km</span>
          ${pathBtn(r, n.st)}</li>`).join('')}</ul>`
      : `<p class="small txt-muted">None within ${num(S.km)} km.</p>`;
    let airLines;
    if (!M.src) airLines = '<p class="small txt-muted">Not read — see above the table.</p>';
    else if (!r.heard) airLines = `<p class="small">${term('notFound', 'Not picked out')} in the last ${plural(M.heardDays, 'day')}.</p>`;
    else {
      const h = r.heard;
      const lines = [`Found on its carrier on ${plural(h.days, 'day')}, relaying ${plural(h.bursts, 'burst')}: ${plural(h.inRange, 'address', 'addresses')} in its ranges.`];
      lines.push(`Heard: ${h.runs.length ? h.runs.map(x => runHtml(x, [])).join(', ') : 'nothing'}.`);
      if (h.off.length) lines.push(`<span class="txt-warn">${term('offrec', 'Off record')}:</span> ${addrList(h.off, M, o => `${o.a} — ${o.evidence === 'copies' ? `${plural(o.copies, 'copy', 'copies')}` : 'possible'}`)}.`);
      if (h.elsewhere.length) lines.push(`${term('elsewhere', 'In its ranges, heard only another way')}: ${addrList(h.elsewhere, M)}.`);
      airLines = lines.map(l => `<p class="small">${l}</p>`).join('');
    }
    const c = r.cfo;
    const t = r.tsumRow;
    const carrier = c
      ? `<p class="small">${c.hz != null ? `${sgn(c.hz, 0)} Hz, ` : ''}${sgn(c.ppm, 2)} ppm against the rest over the last week${c.days != null ? ` (${plural(c.days, 'day')} measured)` : ''}${
          c.freq != null ? `, heard on ${esc(String(c.freq))} MHz` : ''}.${Math.abs(c.ppm) >= WARN_PPM ? ' <span class="txt-warn">Past the ±2.5 ppm line: decodes suffer.</span>' : ''}</p>`
      : `<p class="small txt-muted">${t ? 'Not measured in the last week.' : S.tsum ? 'Never measured.' : 'Not read.'}</p>`;
    // Every figure there is for its delay, each said for what it is.
    const g = r.gap;
    const delay = [
      r.delayRec != null ? `${term('recorded', 'Recorded')}: ${num(r.delayRec)} ms.` : `${term('recorded', 'Recorded')}: none on its station.`,
      g ? `${term('turnaround', 'Turnaround')}: ${num(Math.round(g.ms))} ms${g.lo != null && g.hi != null ? ` (middle half ${num(Math.round(g.lo))}–${num(Math.round(g.hi))} ms)` : ''},
           from ${plural(g.n, 'pair')} on ${plural(g.days, 'day')} — ${term('measuredDelay', 'a delay of about')} ${num(Math.max(0, r.delayMeas))} ms.`
        : `${term('turnaround', 'Turnaround')}: ${S.relay ? 'not measured this week — no station of its was heard direct and through it at one base station.' : S.relayMissing ? 'not kept by this database yet (0092).' : 'not read.'}`,
      r.delayPlan != null ? `${term('plan', 'Planned')}: ${num(r.delayPlan)} ms, by ⏳ Repeater Delays.` : `${term('plan', 'Planned')}: none.`,
    ];
    return `
      <tr class="rptr-detail" id="rptr-d-${escAttr(r.id)}"><td colspan="${COLS.length}">
        <div class="rptr-d-body">
          <p class="rptr-d-h"><strong>Stations ${esc(r.name)} passes on</strong> <span class="small txt-muted">— ${plural(r.carried.length, 'field station')}, each a link to the Stations tab</span></p>
          ${stns}
          <div class="rptr-d-grid">
            <div><p class="rptr-d-h"><strong>${term('rrLink', 'Linked repeaters')}</strong></p>${reps}</div>
            <div><p class="rptr-d-h"><strong>${term('baseLink', 'Base stations in reach')}</strong></p>${bases}</div>
            <div><p class="rptr-d-h"><strong>${term('heard', 'On the air')}</strong></p>${airLines}</div>
            <div><p class="rptr-d-h"><strong>${term('cfo', 'Carrier')}</strong></p>${carrier}
              <p class="rptr-d-h"><strong>${term('actual', 'Delay')}</strong></p>${delay.map(l => `<p class="small">${l}</p>`).join('')}</div>
          </div>
          <div class="button-group rptr-d-acts">
            <button type="button" class="btn" onclick="Repeaters.openStation(null,'${escAttr(r.id)}')">Open ${esc(r.name)} on the Stations tab</button>
            <button type="button" class="btn" onclick="Repeaters.showOnMap('${escAttr(r.id)}')"${placed(r.st) ? '' : ' disabled'}>Show it on the map</button>
            <button type="button" class="btn" onclick="switchTab('backbone')">Its state on 🗼 Backbone</button>
          </div>
        </div>
      </td></tr>`;
  }

  // ── Drawing: the sections ─────────────────────────────────────────────────

  function tilesHtml(M) {
    const rows = M.rows;
    const rr = M.pairs.filter(p => p.kind === 'repeater').length;
    const tile = (n, label, cls) => `<div class="bk-tile"><span class="bk-tile-n${cls ? ' ' + cls : ''}">${esc(n)}</span> <span class="bk-tile-l">${label}</span></div>`;
    const iso = rows.filter(r => r.isolated).length;
    const out = [
      tile(num(rows.length), `repeaters on file, ${num(rows.filter(r => r.ranges.length).length)} with pass ranges`),
      tile(num(rr), `${term('rrLink', 'links between repeaters')} within ${num(S.km)} km`),
      tile(num(rows.filter(r => r.base).length), `repeaters with a ${term('baseLink', 'base station in reach')}`),
      tile(num(iso), `${term('isolated', 'linked to nothing')}`, iso ? 'txt-warn' : ''),
    ];
    if (S.tsum) out.push(tile(num(rows.filter(r => r.cfo).length), `with their ${term('measured', 'carrier measured')} this week`));
    if (M.src) out.push(tile(num(rows.filter(r => r.heard).length), `${term('found', 'found on the air')} this week`));
    if (S.relay) out.push(tile(num(rows.filter(r => r.gap).length), `with their ${term('timed', 'turnaround measured')}`));
    return `<div class="bk-tiles">${out.join('')}</div>`;
  }

  function airHtml(M) {
    const s = airState();
    const busy = S.air || (s && s.phase === 'loading');
    if (M.src === 'server') {
      const found = M.rows.filter(r => r.heard).length, timed = M.rows.filter(r => r.gap).length;
      const from = M.heardFrom ? new Date(String(M.heardFrom).slice(0, 10) + 'T00:00:00Z') : null;
      return `<p class="small rptr-air"><b>${term('heard', 'Pass ranges as heard')}</b> and the measured delays: the base stations' last
        ${plural(M.heardDays, 'day')}${from ? ` (from ${esc(from.toLocaleDateString([], { day: 'numeric', month: 'short', timeZone: 'UTC' }))})` : ''},
        worked out every hour from every burst they decode — ${plural(found, 'repeater')} found on ${found === 1 ? 'its carrier' : 'their carriers'},
        ${num(timed)} with ${term('turnaround', 'a turnaround measured')}.${M.heardAt ? ` Last worked out ${esc(clock(M.heardAt))}.` : ''}</p>`;
    }
    if (S.relayPhase === 'loading' && !S.relayMissing) {
      return `<p class="small txt-muted rptr-air" role="status">Reading what the base stations heard each repeater relay…</p>`;
    }
    if (M.A) {
      const A = M.A;
      return `<p class="small rptr-air"><b>${term('heard', 'Pass ranges as heard')}:</b> from ${plural(A.days, 'day')} of receptions
        (${esc(new Date(A.from).toLocaleDateString([], { day: 'numeric', month: 'short' }))} to ${esc(clock(A.to))}),
        ${plural(A.reps.length, 'repeater')} found on ${A.reps.length === 1 ? 'its carrier' : 'their carriers'}.
        <button type="button" class="link-btn" onclick="Repeaters.readAir()"${busy ? ' disabled' : ''}>${busy ? 'Reading…' : 'Read again'}</button></p>`;
    }
    if (!signedIn()) {
      return `<p class="small txt-muted rptr-air"><b>${term('heard', 'Pass ranges as heard')}</b> — what each repeater is really relaying,
        found by its carrier — need the receptions, which editors can read. Sign in as one to fill that column.</p>`;
    }
    const err = s && s.phase === 'error' && s.err ? ` <span class="txt-bad">${esc(s.err)}</span>` : '';
    // #sr-status is Signal Routes' own progress line, which it writes into as
    // the pages of receptions arrive, wherever on the page it finds one.
    return `<p class="small rptr-air"><b>${term('heard', 'Pass ranges as heard')}:</b> read the last ${AIR_DAYS} days of receptions to set what
      each repeater is heard relaying, on its own carrier, beside its pass ranges on record. It takes a minute.
      <button type="button" class="btn" onclick="Repeaters.readAir()"${busy ? ' disabled' : ''}>${busy ? 'Reading the receptions…' : 'Read them'}</button>
      <span id="sr-status" class="txt-muted" role="status"></span>${err}</p>`;
  }

  function carriersNote() {
    const out = [];
    if (S.tsumPhase === 'error') out.push(`The carrier offsets could not be read (${esc(S.tsumErr)}).`);
    if (S.relayPhase === 'error' && !S.relayMissing) out.push(`What each repeater was heard relaying could not be read (${esc(S.relayErr)}).`);
    return out.map(t => `<p class="small txt-muted">${t}</p>`).join('');
  }

  function tableHtml(M) {
    const list = sorted(filtered(M));
    const P = prepareSearch(S.q);
    const total = M.rows.length;
    const of = list.length === total ? `${num(total)}` : `${num(list.length)} of ${num(total)}`;
    if (!list.length) return { html: '<p class="small table-empty">No repeater matches this filter.</p>', of, n: 0 };
    const html = `
      <div class="table-wrap${S.full ? ' rptr-full' : ' tall'}" id="rptr-wrap" role="region" tabindex="0" aria-labelledby="rptr-tab-h">
        <table class="rptr-table">
          <caption class="sr-only">Repeaters — ${of} of them, sorted by ${esc(SORT_SAID[S.sort.key])}, ${S.sort.dir > 0 ? 'lowest' : 'highest'} first.
            Each row opens to list the stations the repeater passes on.</caption>
          <colgroup>${COLS.map(c => `<col style="width:${c.pc}%">`).join('')}</colgroup>
          <thead><tr>${COLS.map(sortTh).join('')}</tr></thead>
          <tbody>${list.map(r => rowHtml(r, P)).join('')}</tbody>
        </table>
      </div>
      <p class="rptr-foot" id="rptr-foot"><button type="button" class="link-btn" onclick="Repeaters.setFull(${!S.full})">${S.full
        ? 'Show a shorter list'
        : `Open the full list — all ${plural(list.length, 'repeater')}`}</button></p>`;
    return { html, of, n: list.length };
  }

  function pickHtml(M) {
    const r = S.pick ? M.byId.get(S.pick) : null;
    if (!r) return '<p class="small txt-muted rptr-pick">Press a repeater on the map to pick out its links and open its row in the table; press a link for the ground between its two ends and its link budget. Scroll to zoom.</p>';
    const said = r.isolated ? 'linked to nothing' : `${plural(r.linked, 'linked repeater')}${r.base ? `, ${plural(r.links.bases.length, 'base station')} in reach` : ', no base station in reach'}`;
    return `<p class="small rptr-pick"><strong>${esc(r.name)}</strong> — ${said}.
      <button type="button" class="link-btn" onclick="Repeaters.goTo('${escAttr(r.id)}')">Show its row</button> ·
      <button type="button" class="link-btn" onclick="Repeaters.pick(null)">Let go</button></p>`;
  }

  function keyHtml() {
    return `<ul class="rptr-key small">
      <li><span class="rptr-k rptr-k-rr" aria-hidden="true"></span>${term('rrLink', 'Repeater to repeater')}</li>
      <li><span class="rptr-k rptr-k-rb" aria-hidden="true"></span>${term('baseLink', 'Repeater to base station')}</li>
      <li><span class="rptr-k rptr-k-dot" aria-hidden="true"></span>Repeater</li>
      <li><span class="rptr-k rptr-k-dot rptr-k-iso" aria-hidden="true"></span>${term('isolated', 'Linked to nothing')}</li>
      <li><span class="rptr-k-base" aria-hidden="true">◆&#xFE0E;</span>Base station</li>
      ${S.lay.councils ? `<li><span class="rptr-k rptr-k-council" aria-hidden="true"></span>${term('layCouncils', 'Council area boundary')}</li>` : ''}
      ${S.lay.hubs ? `<li><span class="rptr-k rptr-k-hub" aria-hidden="true"></span>${term('layHubs', 'Maintenance hub boundary')}</li>` : ''}
      ${S.lay.basins ? `<li><span class="rptr-k rptr-k-basin" aria-hidden="true"></span>${term('layBasins', 'Drainage basin')}</li>` : ''}
    </ul>`;
  }

  function glossaryHtml() {
    return `<details class="rd-fold" data-k="words"><summary><h3 class="bk-inline-h" id="rptr-h-words">What the words on this page mean</h3></summary>
      <dl class="rd-words">${GLOSSARY.map(([k, label]) => `<dt>${esc(label)}</dt><dd>${esc(word(k))}</dd>`).join('')}</dl>
    </details>`;
  }

  function howHtml() {
    return `<details class="rd-fold" data-k="how"><summary><h3 class="bk-inline-h" id="rptr-h-how">Where each column comes from</h3></summary>
      <ul class="small">
        <li><strong>The register.</strong> Name, station number, network, channel, pass ranges, exclusions and any recorded delay are the
          station file's, as the Stations tab edits them. <em>Addresses</em> and <em>Stations</em> are what those pass ranges let through,
          counted over every address on file — the same figures as the station's card.</li>
        <li><strong>Links.</strong> Two repeaters are linked when both pass ranges let at least one address through and they are within the
          distance set over the map; a repeater is linked to a base station within that distance. The Stations map draws the same paths with its
          own <em>Max TX distance</em>. A distance is not a coverage model: press a link on the map for the ground between its ends and
          its fade margin each way.</li>
        <li><strong>A link's ground and budget.</strong> The Stations map's elevation profile and link budget, for the link pressed: the
          same ground, the same Longley–Rice model with the same field allowance, the same radio at each end — its station's radio system,
          or whatever was typed over it on the Stations map's cards — and the same frequency, so the fade margin here and there is one
          figure. Between two repeaters it is worked out both ways, since each sends on what the other does; from a repeater to its base,
          the one way the readings go. <em>Open on the Stations map</em> takes the same path to the full card, to change a figure or
          read the ground from LiDAR.</li>
        <li><strong>Pass ranges as heard.</strong> From every burst the base stations decode, each put down to the transmitter that sent it
          by its carrier — the fingerprint every burst a repeater relays carries. The server does it every hour and keeps, for each repeater,
          the addresses on its carrier over the last week, so this tab reads a row a repeater (the same rules as
          <button type="button" class="link-btn" onclick="switchTab('signalroutes')">🛤️ Signal Routes</button>, which reads the receptions
          themselves). A run of addresses ends where one was heard coming in another way.</li>
        <li><strong>Carrier offset.</strong> The server's hourly judgement of every transmitter against the fleet the same receivers hear,
          each receiver's own error taken out (Station Health's <em>Transmitter frequency</em> panel). Public, so it shows signed out.</li>
        <li><strong>Delay (actual).</strong> Recorded on the station when it is known. Otherwise measured: when a base station hears a
          station's own burst and then this repeater's copy of it, the gap between the two is the repeater's turnaround — its delay, its
          transmitter coming up and the ${frameMs()} ms frame — on that receiver's own clock, so no clock has to be right. The median over the
          week, less the frame and the ${leadMs()} ms the app takes a transmitter to need to come up, is its delay. That ${leadMs()} ms nobody
          has timed on these radios: a repeater whose delay is recorded and measured both would time it. A repeater whose stations are never
          heard direct where its copies are has no measurement.</li>
        <li><strong>Delay (planned).</strong> What
          <button type="button" class="link-btn" onclick="switchTab('repdelays')">⏳ Repeater Delays</button> plans for it, so repeaters
          relaying one reading do not send on top of each other; <em>change</em> where that is 50 ms or more from the actual. What is wrong
          with each repeater over a period, ranked, is on
          <button type="button" class="link-btn" onclick="switchTab('backbone')">🗼 Backbone</button>.</li>
      </ul>
    </details>`;
  }

  function render() {
    readSettings();
    W = words();
    const M = model();
    if (!M) return '<div class="page"><p class="small" role="status">The station register is not loaded yet.</p></div>';
    const T = tableHtml(M);
    return `
    <div class="page rptr-page" style="--page-max:1400px">
      <div class="panel">
        <div class="panel-header"><h2>Repeaters</h2></div>
        <p class="small txt-muted">Every repeater on file: the links between them and to the base stations, and for each its pass ranges
          on record beside what the base stations hear it relaying, its carrier, its delay and the stations it passes on. Press a column's
          heading to sort by it; open a row to list its stations. The map's 🗺️ Layers adds ground height, council areas, maintenance
          hubs and catchments under the links.</p>
        <div id="rptr-tiles">${tilesHtml(M)}</div>
        <label class="pr-filter">
          Filter by station number, AlertID, AlertID range or station name
          <input type="search" id="rptr-filter" value="${escAttr(S.q)}" placeholder="e.g. 540123, 6128, 4021-4025 or Amiens…"
                 oninput="Repeaters.filter(this.value)">
        </label>
        <p id="rptr-found" class="sr-only" role="status" aria-live="polite">${esc(foundText(T))}</p>
      </div>

      <div class="panel">
        <div class="panel-header"><h3 id="rptr-map-h">Links between repeaters</h3>
          <div class="button-group">
            ${kmHtml('rptr-km')}
            <button type="button" class="btn" onclick="Repeaters.openFull()" title="Open the map full screen (Esc closes it)">⛶ Full screen</button>
          </div>
        </div>
        <div id="rptr-map" class="rptr-map" role="region" aria-label="Map of the repeaters, the links between them and the base stations in reach"></div>
        <div id="rptr-pick-line">${pickHtml(M)}</div>
        <div data-rptr-key>${keyHtml()}</div>
      </div>

      <div id="rptr-path-slot">${S.pathShown = pathHtml()}</div>

      <div class="panel">
        <div class="panel-header"><h3 id="rptr-tab-h">By repeater</h3>
          <div class="button-group">
            <span class="badge" id="rptr-count">${T.of}</span>
            <button type="button" class="btn" onclick="Repeaters.exportCsv()" title="Save the repeaters this filter leaves, in this order, as a CSV file">⤓ Export CSV</button>
          </div>
        </div>
        <div id="rptr-air">${airHtml(M)}</div>
        <div id="rptr-carriers">${carriersNote()}</div>
        <div id="rptr-table">${T.html}</div>
        ${glossaryHtml()}
        ${howHtml()}
      </div>
    </div>`;
  }

  // The link distance, over the map and again over it full screen; both
  // follow the one setting.
  function kmHtml(id) {
    return `<label class="rptr-km">${term('linkKm', 'Link distance')}
      <input type="range" id="${id}" min="10" max="${KM_MAX}" step="10" value="${S.km}" aria-valuetext="${S.km} kilometres"
             oninput="Repeaters.kmShow(this.value)" onchange="Repeaters.setKm(this.value)">
      <output class="rptr-km-val" for="${id}">${num(S.km)} km</output></label>`;
  }

  function foundText(T) {
    return S.q ? `${T.of} repeaters` : '';
  }

  // Everything but the filter box, the folds and the map itself, drawn again
  // in place: the box keeps its focus and the folds their state, and the map
  // repaints its layer rather than starting over.
  function refresh(opts = {}) {
    if (!active()) return;
    W = words();
    const M = model();
    if (!M) return;
    const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
    const T = tableHtml(M);
    set('rptr-tiles', tilesHtml(M));
    set('rptr-air', airHtml(M));
    set('rptr-carriers', carriersNote());
    set('rptr-pick-line', pickHtml(M));
    set('rptr-full-pick', pickHtml(M));
    const wrap = document.getElementById('rptr-wrap');
    const scroll = wrap ? wrap.scrollTop : 0;
    set('rptr-table', T.html);
    const w2 = document.getElementById('rptr-wrap');
    if (w2 && opts.keepScroll !== false) w2.scrollTop = scroll;
    const count = document.getElementById('rptr-count');
    if (count) count.textContent = T.of;
    const found = document.getElementById('rptr-found');
    if (found) found.textContent = foundText(T);
    footFits();
    if (S.path) computePath();
    drawPath();
    drawMap();
  }

  // The "full list" line is only there while there is more than the card
  // shows, or once the card has been opened to it.
  function footFits() {
    const wrap = document.getElementById('rptr-wrap'), foot = document.getElementById('rptr-foot');
    if (!wrap || !foot) return;
    foot.hidden = !S.full && wrap.scrollHeight <= wrap.clientHeight + 1;
  }

  // ── The map ───────────────────────────────────────────────────────────────

  // Two maps at most: the one on the page, and the same drawn full screen in
  // the dialog shell (modal.js) while that is open. The wheel zooms both —
  // a map that only zoomed with its buttons was the complaint.
  function stopMap() {
    closeFull();
    if (S.map) { dropLayers(S.map); try { removeMap(S.map); } catch (_) { /* gone */ } }
    S.map = null; S.layer = null;
  }
  // `which` is 'p' for the page's map, 'f' for the one full screen: the two
  // flyouts' controls are told apart by it.
  function newMap(id, which) {
    const map = L.map(id, { scrollWheelZoom: true, wheelPxPerZoomLevel: 90 }).setView([-25.5, 151.5], 6);
    if (typeof addBaseLayers === 'function') {
      // The base maps' section at the top of a 🗺️ Layers flyout of this tab's
      // own, the overlays under it — the Stations map's arrangement (app.js,
      // stationsMapPanels), with the overlays this map has.
      addBaseLayers(map, { panel: false });
      if (typeof MapChrome !== 'undefined') {
        MapChrome.panel(map, {
          id: 'display', icon: '🗺️', title: 'Layers',
          btnLabel: 'Layers — base maps, ground height, council areas, maintenance hubs and catchments',
          group: 'show', order: 10,
          html: () => (map.mnBases ? map.mnBases.html() : '') + layersHtml(which),
          onMount: body => { if (map.mnBases) map.mnBases.bind(body); },
        });
      }
    }
    const layer = L.layerGroup().addTo(map);
    syncLayers(map);
    return { map, layer };
  }

  // ── The map's overlays ────────────────────────────────────────────────────
  // Four of the Stations map's layers, the ones that say something about a
  // radio path or the site at its end: the ground (where the hills are), the
  // council areas (whose area a site is in), the maintenance hubs (who drives
  // to it) and the drainage basins (which catchment it serves). Each is the
  // Stations map's own module drawing on this map — MapElevation.drawOn,
  // MapCouncils.view, MapHubs.drawOn, MapCatchments.drawOn — so the colours
  // and the files are one set. Left on the Stations map, as being about
  // stations rather than links or costing a request a view: the rivers and
  // rain, survey marks, contours, roads and lots, photos and cameras, the
  // carriers' coverage, wind regions and the ACMA register.
  const OP_RANGE = { elevOp: [0.1, 1], shadeOp: [0.05, 0.8] };
  function clampOp(k, v) {
    const [lo, hi] = OP_RANGE[k];
    return Math.max(lo, Math.min(hi, Number(v) || lo));
  }
  const pc = v => Math.round(v * 100);

  function layersHtml(sfx) {
    const L_ = S.lay;
    const box = (k, on, w, label, sub) => `
      <label class="filter-check${sub ? ' filter-sub' : ''}">
        <input type="checkbox" id="rptr-lay-${k}-${sfx}" data-rptr-lay="${k}" ${on ? 'checked' : ''}
               onchange="Repeaters.setLayer('${k}', this.checked)">
        ${term(w, label)}
      </label>`;
    const range = (k, label) => `
      <label class="filter-range">
        <span>${label} <strong data-rptr-val="${k}" aria-hidden="true">${pc(L_[k])}%</strong></span>
        <input type="range" min="${OP_RANGE[k][0]}" max="${OP_RANGE[k][1]}" step="0.05" value="${L_[k]}" data-rptr-range="${k}"
               aria-label="${escAttr(label)}" aria-valuetext="${pc(L_[k])} per cent"
               oninput="Repeaters.layOpacity('${k}', this.value)" onchange="Repeaters.layOpacity('${k}', this.value, true)">
      </label>`;
    return `
      <div class="map-display-h">Overlay layers</div>
      ${box('councils', L_.councils, 'layCouncils', 'Council areas (LGA boundaries)')}
      <div data-rptr-sub="councils" ${L_.councils ? '' : 'hidden'}>
        ${box('shade', L_.shade, 'layShade', 'Shade each council area', true)}
        <div data-rptr-sub="shade" ${L_.shade ? '' : 'hidden'}>${range('shadeOp', 'Council shading opacity')}</div>
      </div>
      ${box('hubs', L_.hubs, 'layHubs', 'Maintenance hubs (BoM)')}
      ${box('basins', L_.basins, 'layBasins', 'River catchments (drainage basins)')}
      ${box('elev', L_.elev, 'layElev', 'Ground height as colour')}
      <!-- Last, because its key is a dozen bands long and would push the
           switches under it out of the flyout. -->
      <div data-rptr-sub="elev" ${L_.elev ? '' : 'hidden'}>
        ${range('elevOp', 'Ground height opacity')}
        ${typeof MapElevation !== 'undefined' ? MapElevation.rampHtml() : ''}
      </div>
      <p class="filter-note" data-rptr-lay-note>${layNote()}</p>`;
  }

  const LAY_FILE = { councils: 'Council boundaries', hubs: 'Hub boundaries', basins: 'Drainage basins' };
  function layNote() {
    const failed = Object.keys(LAY_FILE).filter(k => S.lay[k] && S.layFail[k]);
    if (failed.length) {
      return `${failed.map(k => LAY_FILE[k]).join(', ')} could not be read — untick and tick again to try again.`;
    }
    const bits = [];
    if (S.lay.elev) bits.push('Ground height from ~30 m terrain tiles; the relief and the 5 m LiDAR source are on the Stations map\'s Layers.');
    if (S.lay.councils && typeof MapCouncils !== 'undefined') bits.push(`Council areas: ${MapCouncils.PROVENANCE}`);
    return esc(bits.join(' ') || 'Drawn under the links, on this map and full screen; the Stations map keeps its own.');
  }

  function saveLayers() { writeLS(LS_LAYERS, JSON.stringify(S.lay)); }

  // What each map has drawn made to match S.lay: a handle made for a layer
  // turned on, taken down for one turned off, restyled for the rest.
  function syncLayers(map) {
    if (!map) return;
    let h = S.lh.get(map);
    if (!h) S.lh.set(map, h = {});
    const want = S.lay;
    const watch = (k, p) => { if (p && p.catch) p.catch(() => { S.layFail[k] = true; paintLayers(); }); };
    const toggle = (k, on, make) => {
      if (on && !h[k]) h[k] = make();
      else if (!on && h[k]) { h[k].remove(); h[k] = null; }
    };
    if (typeof MapElevation !== 'undefined' && MapElevation.drawOn) {
      toggle('elev', want.elev, () => MapElevation.drawOn(map, want.elevOp));
      if (h.elev) h.elev.setOpacity(want.elevOp);
    }
    if (typeof MapCouncils !== 'undefined') {
      toggle('councils', want.councils, () => {
        watch('councils', MapCouncils.ready());
        return MapCouncils.view(map, { shade: want.shade, opacity: want.shadeOp });
      });
      if (h.councils) { h.councils.setShade(want.shade); h.councils.setOpacity(want.shadeOp); }
    }
    if (typeof MapHubs !== 'undefined' && MapHubs.drawOn) {
      toggle('hubs', want.hubs, () => { watch('hubs', MapHubs.ready()); return MapHubs.drawOn(map); });
    }
    if (typeof MapCatchments !== 'undefined' && MapCatchments.drawOn) {
      toggle('basins', want.basins, () => { watch('basins', MapCatchments.ready()); return MapCatchments.drawOn(map); });
    }
  }
  function dropLayers(map) {
    const h = map && S.lh.get(map);
    if (h) for (const x of Object.values(h)) if (x) { try { x.remove(); } catch (_) { /* map gone */ } }
    if (map) S.lh.delete(map);
  }

  // Both flyouts and both keys brought into line with S.lay, in place — no
  // flyout is rebuilt, so a switch keeps its focus.
  function paintLayers() {
    for (const el of document.querySelectorAll('[data-rptr-lay]')) el.checked = !!S.lay[el.dataset.rptrLay];
    for (const el of document.querySelectorAll('[data-rptr-sub]')) el.hidden = !S.lay[el.dataset.rptrSub];
    for (const el of document.querySelectorAll('[data-rptr-lay-note]')) el.innerHTML = layNote();
    for (const el of document.querySelectorAll('[data-rptr-key]')) el.innerHTML = keyHtml();
  }

  function setLayer(k, on) {
    if (!(k in S.lay) || k.endsWith('Op')) return;
    S.lay[k] = !!on;
    if (on) S.layFail[k] = false;
    saveLayers();
    syncLayers(S.map);
    syncLayers(S.fmap);
    paintLayers();
  }

  // A slider moving: the figure and the other map's slider follow it, and the
  // drawn layers take the new strength in place; stored once it is let go.
  function layOpacity(k, v, commit) {
    if (!OP_RANGE[k]) return;
    S.lay[k] = clampOp(k, v);
    for (const el of document.querySelectorAll(`[data-rptr-val="${k}"]`)) el.textContent = `${pc(S.lay[k])}%`;
    for (const el of document.querySelectorAll(`[data-rptr-range="${k}"]`)) {
      if (Number(el.value) !== S.lay[k]) el.value = S.lay[k];
      el.setAttribute('aria-valuetext', `${pc(S.lay[k])} per cent`);
    }
    for (const h of S.lh.values()) {
      if (k === 'elevOp' && h.elev) h.elev.setOpacity(S.lay.elevOp);
      if (k === 'shadeOp' && h.councils) h.councils.setOpacity(S.lay.shadeOp);
    }
    if (commit) saveLayers();
  }
  function initMap() {
    stopMap();
    const el = document.getElementById('rptr-map');
    if (!el || typeof L === 'undefined' || !S.M) return;
    ({ map: S.map, layer: S.layer } = newMap('rptr-map', 'p'));
    if (typeof registerLiveMap === 'function') registerLiveMap('Repeaters', () => S.map);
    S.fitted = false;
    drawMap();
  }

  // Full screen: the dialog shell made the window less a margin (styles.css,
  // #rptr-mapfull), a map of its own in it at the page map's view, the link
  // distance and the picked repeater under it. Esc, × or the backdrop close it
  // and hand focus back to the button.
  function openFull() {
    if (typeof Modal === 'undefined' || typeof L === 'undefined' || !S.M) return;
    Modal.open({
      title: 'Links between repeaters',
      wide: true,
      onClose: () => {
        if (S.fmap) { dropLayers(S.fmap); try { removeMap(S.fmap); } catch (_) { /* gone */ } }
        S.fmap = null; S.flayer = null;
      },
      html: `<div class="rptr-full">
        <div class="rptr-full-bar">${kmHtml('rptr-km-full')}</div>
        <div id="rptr-mapfull" class="rptr-mapfull" role="region" aria-label="Map of the repeaters, full screen"></div>
        <div id="rptr-full-pick">${pickHtml(S.M)}</div>
        <div data-rptr-key>${keyHtml()}</div>
      </div>`,
    });
    ({ map: S.fmap, layer: S.flayer } = newMap('rptr-mapfull', 'f'));
    drawMap();
    // At the page map's view once the card has its size.
    requestAnimationFrame(() => {
      if (!S.fmap) return;
      S.fmap.invalidateSize();
      if (S.map) S.fmap.fitBounds(S.map.getBounds(), { animate: false });
    });
  }
  function closeFull() {
    if (S.fmap && typeof Modal !== 'undefined') Modal.close();
  }

  function linkTip(p) {
    const a = esc(p.a.name), b = esc(p.b.name), km = `${num(Math.round(p.km))} km`;
    return p.kind === 'base' ? `${a} → ${b} (base station) — ${km}`
      : `${a} ↔ ${b} — ${km}, ${plural(p.overlap || 0, 'address', 'addresses')} open in both`;
  }

  function drawMap() {
    if (S.map && S.layer) drawOn(S.map, S.layer, true);
    if (S.fmap && S.flayer) drawOn(S.fmap, S.flayer, false);
  }
  function drawOn(map, layer, fit) {
    const M = S.M;
    if (!M) return;
    layer.clearLayers();
    const shown = S.q ? new Set(filtered(M).map(r => r.id)) : null;
    const ink = cssVar('--map-backbone', '#000000'), acc = cssVar('--accent', '#0b5cab'), warn = cssVar('--warn', '#9e5e00');
    const repC = cssVar('--role-repeater', '#0b5cab');
    const pick = S.pick && M.byId.has(S.pick) ? S.pick : null;
    const lit = p => (pick ? p.a.id === pick || p.b.id === pick
      : shown ? shown.has(p.a.id) && (p.kind === 'base' || shown.has(p.b.id)) : true);
    // The link whose ground and budget are open, drawn last and heaviest — and
    // drawn even when the distance set has since left it out, since it is what
    // the card under the map is about.
    const open = S.path;
    const isOpen = p => !!open && ((p.a.id === open.a && p.b.id === open.b) || (p.a.id === open.b && p.b.id === open.a));
    let pairs = M.pairs;
    if (open) {
      const extra = M.pairs.some(isOpen) ? [] : [pathPair(open.a, open.b)].filter(p => p && placed(p.a) && placed(p.b));
      pairs = M.pairs.filter(p => !isOpen(p)).concat(M.pairs.filter(isOpen), extra);
    }
    for (const pass of ['casing', 'core']) {
      for (const p of pairs) {
        const sel = isOpen(p), on = sel || lit(p), hi = on && (sel || !!pick);
        const line = L.polyline([[p.a.lat, p.a.lon], [p.b.lat, p.b.lon]], {
          color: pass === 'casing' ? '#ffffff' : hi ? acc : ink,
          weight: pass === 'casing' ? (sel ? 9 : hi ? 6.5 : 4.5) : (sel ? 5 : hi ? 3.5 : 2),
          opacity: on ? (pass === 'casing' ? 0.65 : sel ? 1 : 0.9) : 0.12,
          dashArray: pass === 'core' && p.kind === 'base' ? '6 5' : null,
          interactive: false,
        });
        line.addTo(layer);
      }
    }
    // What a press lands on: a line too thin to hit, widened by one nobody
    // sees. Under the repeaters, which are drawn after it, so a press on a
    // repeater still picks the repeater.
    for (const p of pairs) {
      const hit = L.polyline([[p.a.lat, p.a.lon], [p.b.lat, p.b.lon]], {
        color: '#000000', opacity: 0, weight: 14, interactive: true, bubblingMouseEvents: false,
      });
      hit.mnPath = [p.a.id, p.b.id];
      hit.bindTooltip(`${linkTip(p)}<br><span class="small">${isOpen(p) ? 'Its ground and link budget are open under the map'
        : 'Press for the ground between them and the link budget'}</span>`, { sticky: true });
      // A beat later: from the full-screen map, opening the card closes the
      // dialog the map is in, which is not for the map's own click to do.
      hit.on('click', () => setTimeout(() => openPath(p.a.id, p.b.id), 0));
      hit.addTo(layer);
    }
    stations().filter(s => (s.roles || []).includes('base') && placed(s)).forEach(s => {
      L.marker([s.lat, s.lon], { icon: L.divIcon({ className: 'bk-base-icon', html: '◆', iconSize: [14, 14] }), keyboard: false })
        .bindTooltip(`${esc(s.name)} (base station)`).addTo(layer);
    });
    const pts = [];
    M.rows.filter(r => placed(r.st)).forEach(r => {
      const on = pick ? r.id === pick || r.links.reps.some(n => n.st.id === pick) : shown ? shown.has(r.id) : true;
      const me = r.id === pick;
      const colour = r.isolated ? warn : me ? ink : repC;
      const m = L.circleMarker([r.st.lat, r.st.lon], { radius: me ? 9 : 6, weight: me ? 3 : 1.5, color: colour, fillColor: r.isolated ? warn : repC,
        fillOpacity: on ? 0.85 : 0.2, opacity: on ? 1 : 0.3 });
      m.bindTooltip(`${esc(r.name)} — ${r.isolated ? 'linked to nothing' : `${plural(r.linked, 'linked repeater')}${r.base ? ', base in reach' : ''}`}`);
      m.on('click', () => pickRep(r.id));
      m.addTo(layer);
      pts.push([r.st.lat, r.st.lon]);
    });
    if (fit && pts.length && !S.fitted) { try { map.fitBounds(pts, { padding: [20, 20], maxZoom: 9 }); S.fitted = true; } catch (_) { /* one point */ } }
  }

  // ── A link's ground and budget ────────────────────────────────────────────
  // See the header for what this is and why every figure is the Stations
  // map's. Worked out once per state of what it rests on (pathSig), drawn as
  // often as the page is.

  const PATH_SAMPLES = 256;   // the profile card's, the fade map's and the Network Review's own
  const THIN_AT = 1600;       // past this many samples (a LiDAR ground) the chart keeps the highest per half-pixel
  const stById = id => stations().find(s => s.id === id) || null;
  const dbTxt = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} dB`;

  // The pair a link is: the backbone index's record (map-backbone.js), the
  // ends in the order asked for — or, for two stations it does not pair (the
  // distance set has moved since), what their roles say.
  function pathPair(aId, bId) {
    const a = stById(aId), b = stById(bId);
    if (!a || !b) return null;
    const p = typeof backbonePairFor === 'function' ? backbonePairFor(aId, bId) : null;
    const both = st => (st.roles || []).includes('repeater') && !!st.repeater;
    return { a, b, kind: p ? p.kind : both(a) && both(b) ? 'repeater' : 'base',
             km: placed(a) && placed(b) ? acmaHaversineKm(a.lat, a.lon, b.lat, b.lon) : null,
             overlap: p ? p.overlap || 0 : 0, shared: p && Array.isArray(p.shared) ? p.shared : [] };
  }

  // "profile & budget", beside a linked repeater or base in an opened row.
  function pathBtn(r, st) {
    if (!placed(r.st) || !placed(st)) return '';
    return `<button type="button" class="link-btn small rptr-path-btn" id="rptr-pb-${escAttr(r.id)}-${escAttr(st.id)}"
      onclick="Repeaters.openPath('${escAttr(r.id)}','${escAttr(st.id)}')"
      title="${escAttr(`The ground between ${r.name} and ${st.name}, and the link budget each way`)}">profile &amp; budget</button>`;
  }

  // The radio at one end, as every path tool on the Stations map prices it:
  // its radio system's figures with anything typed over them there.
  function endRadio(st) {
    const key = radioKey(st), def = radioDefaults(st);
    const v = k => { const x = radioVal(key, def, k); return x == null || x === '' || !isFinite(x) ? null : Number(x); };
    return { txW: v('tx_w'), gain: v('gain_dbi'), loss: v('loss_db'), agl: v('agl_m'), thr: v('rx_dbm') };
  }

  // What the ground and the analysis rest on. A change to any of it — a
  // station moved, a mast height or the frequency typed over on the Stations
  // map, a propagation setting, the cover switched — reads them again. The
  // figures that only add and subtract (power, gains, losses, threshold) are
  // read as the card is drawn, so they need no new profile.
  function pathSig(a, b) {
    const ra = endRadio(a), rb = endRadio(b);
    return JSON.stringify([a.id, b.id, a.lat, a.lon, a.elevation_ahd, b.lat, b.lon, b.elevation_ahd, ra.agl, rb.agl,
      radioFreq(a, b), !!(state.path && state.path.cover), pathPropOf()]);
  }

  // A link opened: from the map (either map — full screen is left first, the
  // card being on the page under it) or from a row. A repeater to its base is
  // always priced from the repeater, the way its readings go.
  function openPath(aId, bId) {
    const rec = typeof backbonePairFor === 'function' ? backbonePairFor(aId, bId) : null;
    if (rec && rec.kind === 'base' && rec.a.id === bId) [aId, bId] = [bId, aId];
    const a = stById(aId), b = stById(bId);
    if (!placed(a) || !placed(b) || aId === bId) return;
    closeFull();
    const from = document.activeElement;
    if (from && from !== document.body && !from.closest('#rptr-path')) S.pathOpener = { el: from, id: from.id || '' };
    if (!S.path || S.path.a !== aId || S.path.b !== bId) S.path = { a: aId, b: bId, sig: null, status: 'idle' };
    refresh();
    const el = document.getElementById('rptr-path');
    if (el) {
      try { el.focus({ preventScroll: true }); } catch (_) { el.focus(); }
      if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // Closed: focus back to whatever opened it — the same button drawn again,
  // if the table was — or the map.
  function closePath() {
    if (!S.path) return;
    S.path = null;
    S.pathGen++;
    refresh();
    const o = S.pathOpener;
    S.pathOpener = null;
    const to = (o && document.contains(o.el) && o.el) || (o && o.id && document.getElementById(o.id)) || document.getElementById('rptr-map');
    if (to && typeof to.focus === 'function') { try { to.focus({ preventScroll: true }); } catch (_) { to.focus(); } }
  }

  // Escape on the card closes it — not from a box being typed in.
  function pathKey(e) {
    if (!e || e.key !== 'Escape' || !S.path) return;
    if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    e.stopPropagation();
    closePath();
  }

  // The full card: the path on the Stations map's profile, the budget on it.
  function pathOnStations() {
    const P = S.path;
    if (!P || typeof MapBackbone === 'undefined') return;
    MapBackbone.openOnStations('backbone', P.a, P.b);
  }

  function pathRetry() {
    if (!S.path) return;
    S.path.sig = null;
    computePath();
  }

  // The ground, the cover on it when the profile card would draw it, and the
  // model over both — PathProfile.sync()'s sequence, and map-fade.js's
  // computeOne() for the ground and the ends.
  async function computePath() {
    const P = S.path;
    if (!P || typeof pathGround !== 'function' || typeof pathAnalyse !== 'function') return;
    const a = stById(P.a), b = stById(P.b);
    if (!placed(a) || !placed(b)) { S.path = null; drawPath(); return; }
    const sig = pathSig(a, b);
    if (P.sig === sig) return;
    const mine = ++S.pathGen;
    const stale = () => mine !== S.pathGen || S.path !== P;
    Object.assign(P, { sig, status: 'loading', stage: 'ground', prof: null, an: null, lidar: null, beyond: null, error: '', cover: 'off', coverError: '' });
    drawPath();
    const fMhz = radioFreq(a, b);
    const ra = endRadio(a), rb = endRadio(b);
    const end = (s, r) => ({ lat: s.lat, lon: s.lon, elev: s.elevation_ahd != null ? Number(s.elevation_ahd) : null, agl: r.agl, mast: stationIsMast(s) });
    // The ground a little way past each end, for the chart to show what each
    // end stands on (path-profile.js's pathBeyond) — asked for alongside the
    // path's own and never priced.
    const beyond = typeof pathBeyond === 'function'
      ? pathBeyond([[a.lat, a.lon], [b.lat, b.lon]], PATH_SAMPLES) : Promise.resolve(null);
    let got;
    try { got = await pathGround(end(a, ra), end(b, rb), { samples: PATH_SAMPLES, freqMhz: fMhz }); }
    catch (err) { got = { ok: false, error: (err && err.message) || String(err) }; }
    if (stale()) return;
    P.beyond = got && got.ok ? await beyond : null;
    if (stale()) return;
    if (!got || !got.ok) { Object.assign(P, { status: 'failed', error: (got && got.error) || 'No terrain.' }); drawPath(); return; }
    // The cover as the profile card takes it: when its switch is on, and not
    // over a LiDAR ground, where it would be thousands of points for a model
    // that does not price it.
    const P_ = pathPropOf();
    const lidarGround = !!got.lidar || (P_.ground === 'lidar' && P_.model !== 'cover');
    const coverOn = !!(state.path && state.path.cover);
    let cov = null;
    if (coverOn && !lidarGround && typeof LandCover !== 'undefined' && Array.isArray(got.prof.lat)) {
      P.stage = 'cover';
      drawPath();
      let res;
      try { res = await LandCover.sample(got.prof.lat, got.prof.lon); }
      catch (err) { res = { ok: false, error: (err && err.message) || String(err) }; }
      if (stale()) return;
      cov = res && res.ok ? res : null;
      P.cover = cov ? 'ready' : 'failed';
      P.coverError = cov ? '' : (res && res.error) || '';
      P.coverYear = cov ? cov.year : null;
    } else P.cover = coverOn && lidarGround ? 'lidar' : 'off';
    const an = pathAnalyse(got.prof, {
      elevA: got.ends.a.elev, elevB: got.ends.b.elev, aglA: ra.agl, aglB: rb.agl, freqMhz: fMhz,
      cover: cov ? cov.cls : null, canopy: cov && cov.canopyOk ? cov.canopy : null, coverOff: !coverOn,
    });
    Object.assign(P, { status: an.ok ? 'ready' : 'failed', error: an.ok ? '' : an.error, prof: got.prof, an: an.ok ? an : null, lidar: got.lidar || null });
    drawPath();
  }

  // The card, drawn into its place under the map — only when it has changed,
  // so the page's other repaints leave it (and focus in it) alone. The chart
  // is drawn to the width its box has, measured; a first drawing at a guess
  // is drawn again once the box can be measured.
  function drawPath() {
    const slot = document.getElementById('rptr-path-slot');
    if (!slot) return;
    const box = () => slot.querySelector('.rptr-path-chart');
    const was = S.pathW;
    if (box() && box().clientWidth > 0) S.pathW = box().clientWidth;
    const html = pathHtml();
    if (html !== S.pathShown) {
      const had = slot.contains(document.activeElement) ? document.activeElement.id : null;
      slot.innerHTML = html;
      S.pathShown = html;
      if (had) {
        const el = document.getElementById(had);
        if (el) { try { el.focus({ preventScroll: true }); } catch (_) { el.focus(); } }
      }
    }
    const b = box();
    if (b && b.clientWidth > 0 && Math.abs(b.clientWidth - S.pathW) > 4 && S.pathW === was) {
      S.pathW = b.clientWidth;
      drawPath();
    }
  }

  // One way: from the end that transmits to the end that listens. The path
  // loss is the model's over the profile, the same both ways (map-fade.js's
  // marginFrom); a term not on file is not nought, so a margin that would rest
  // on one is no margin (LinkBudget's compute).
  function budgetOf(an, from, to, dKm) {
    const f = endRadio(from), t = endRadio(to);
    const txDbm = wattsToDbm(f.txW);
    const eirp = txDbm == null || f.gain == null || f.loss == null ? null : txDbm + f.gain - f.loss;
    const itm = an.itm || null;
    const fspl = itm ? itm.A_fs_db : fsplDb(dKm, an.fMhz);
    const proxy = itm ? null : an.diffraction_db || 0;
    const pathLoss = itm ? an.pathLoss_db : fspl + proxy;
    const rx = eirp == null || pathLoss == null || t.gain == null || t.loss == null ? null : eirp - pathLoss + t.gain - t.loss;
    const margin = rx == null || t.thr == null || !(dKm > 0.0005) ? null : rx - t.thr;
    const missing = [[txDbm, 'TX power'], [f.gain, 'TX antenna gain'], [f.loss, 'TX line loss'],
      [t.gain, 'RX antenna gain'], [t.loss, 'RX line loss'], [t.thr, 'RX threshold']].filter(([v]) => v == null).map(([, l]) => l);
    return { from, to, f, t, txDbm, eirp, fspl, proxy, pathLoss, rx, margin, missing };
  }
  // Each way the link carries traffic: both between two repeaters, since each
  // sends on what the other does; from a repeater to its base, one.
  const waysOf = (pp, an) => (pp.kind === 'base' ? [budgetOf(an, pp.a, pp.b, pp.km)]
    : [budgetOf(an, pp.a, pp.b, pp.km), budgetOf(an, pp.b, pp.a, pp.km)]);

  function pathHtml() {
    const P = S.path;
    if (!P) return '';
    const pp = pathPair(P.a, P.b);
    if (!pp || !placed(pp.a) || !placed(pp.b)) return '';
    const { a, b } = pp;
    const both = pp.kind !== 'base';
    const an = P.status === 'ready' ? P.an : null;
    const ways = an ? waysOf(pp, an) : [];
    const ch = typeof MapFreq !== 'undefined' ? MapFreq.pathChannel(a, b) : null;
    const V = an ? PATH_VERDICT[an.verdict] || null : null;
    const tile = (n, label, cls) => `<div class="bk-tile"><span class="bk-tile-n${cls ? ' ' + cls : ''}">${n}</span> <span class="bk-tile-l">${label}</span></div>`;
    const band = m => (m == null ? null : lbMarginClass(m));
    const tiles = [
      tile(esc(fmtKm(pp.km)), `apart — ${both ? term('rrLink', 'repeater to repeater') : term('baseLink', 'repeater to base station')}`),
      tile(ch ? esc(ch.label) : '—', ch ? `channel${ch.far ? `; the far end ${esc(ch.far)}` : ''}` : 'channel — none on file'),
      tile(V ? esc(V.label) : P.status === 'loading' ? '…' : '—', term('verdict', 'line of sight'), V ? `txt-${V.cls}` : ''),
      ...ways.map(w => tile(w.margin == null ? '—' : esc(dbTxt(w.margin)),
        `${term('fade', 'fade margin')}, ${esc(w.from.name)} → ${esc(w.to.name)}${w.margin == null ? ' — not worked out' : ` — ${esc(band(w.margin).label.toLowerCase())}`}`,
        w.margin == null ? '' : `txt-${band(w.margin).cls}`)),
    ];
    let body;
    if (P.status === 'failed') {
      body = `<div class="path-fail">
          <strong>${an === null && P.prof ? 'The model could not run over this ground.' : 'Terrain data unavailable.'}</strong>
          <span class="small">${esc(P.error || '')}</span>
          <span class="small">No profile is drawn rather than a flat one — flat ground would read as a clear path.</span>
          <button type="button" class="btn" id="rptr-path-retry" onclick="Repeaters.pathRetry()">Try again</button>
        </div>`;
    } else if (!an) {
      body = `<p class="small txt-muted" role="status">${P.stage === 'cover' ? 'Reading the land cover along the path…'
        : `Reading the ground along ${esc(fmtKm(pp.km))} of path…`}</p>`;
    } else {
      body = `
        <div class="rptr-path-chart">${pathChartSvg(an, P.prof, a, b, P.beyond)}</div>
        <div class="rptr-path-grid">
          <div>${budgetHtml(an, ways, a, b)}</div>
          <div>${pathFactsHtml(pp, an, P)}</div>
        </div>`;
    }
    return `
      <section class="panel rptr-path" id="rptr-path" tabindex="-1" aria-labelledby="rptr-path-h" onkeydown="Repeaters.pathKey(event)">
        <div class="panel-header"><h3 id="rptr-path-h">${term('pathCard', 'Ground profile and link budget')}:
            ${esc(a.name)} ${both ? '↔' : '→'} ${esc(b.name)}</h3>
          <div class="button-group">
            <button type="button" class="btn" id="rptr-path-stn" onclick="Repeaters.pathOnStations()"
              title="The same path on the Stations map's profile card and link budget, where a figure can be changed, the ground read from LiDAR and a report copied">Open on the Stations map ↗</button>
            <button type="button" class="btn" id="rptr-path-x" onclick="Repeaters.closePath()" title="Close the ground profile and link budget (Esc)">✕ Close</button>
          </div>
        </div>
        <div class="bk-tiles">${tiles.join('')}</div>
        ${body}
      </section>`;
  }

  // The budget, term by term, a column each way. The loss terms are the same
  // in both columns; the ends' figures swap.
  function budgetHtml(an, ways, a, b) {
    const itm = an.itm || null;
    const fmt = (v, signed) => (v == null || !isFinite(v) ? '—' : `${signed && v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`);
    const row = (label, vals, unit, cls, signed = true) => `<tr${cls ? ` class="${cls}"` : ''}><th scope="row">${label}</th>${
      vals.map(v => `<td class="lb-num">${fmt(v, signed)}</td>`).join('')}<td class="lb-unit">${esc(unit)}</td></tr>`;
    const each = f => ways.map(f);
    const same = v => ways.map(() => v);
    const w0 = ways[0];
    const loss = [row(term('fspl', 'Free-space loss'), same(-w0.fspl), 'dB')];
    if (itm) {
      loss.push(row(term('terrain', 'Terrain'), same(-itm.A_ref_db), 'dB'));
      loss.push(row(term('stats', 'Statistics'), same(-itm.A_var_db), 'dB'));
      if (an.floor_db > 0.05) loss.push(row(term('floor', 'Obstruction floor'), same(-an.floor_db), 'dB'));
      if (an.model === 'field') loss.push(row(term('allowance', 'Field allowance'), same(-an.allowance_db), 'dB'));
      else if (an.coverUsed) {
        loss.push(row(`${term('clutter', 'Ground cover')} at ${esc(a.name)}`, same(-an.clutterA_db), 'dB'));
        loss.push(row(`${term('clutter', 'Ground cover')} at ${esc(b.name)}`, same(-an.clutterB_db), 'dB'));
      }
    } else loss.push(row('One knife edge, standing in for the model', same(-w0.proxy), 'dB'));
    const short = ways.filter(w => w.margin == null && w.missing.length).map(w =>
      `<p class="small txt-warn">No fade margin ${esc(w.from.name)} → ${esc(w.to.name)}: there is no ${esc(w.missing.join(', '))} on file,
        and a margin worked out round a missing figure would be an invented one. Set it on the Stations map's link budget.</p>`).join('');
    return `
      <div class="table-wrap">
        <table class="lb-table rptr-lb">
          <caption class="sr-only">The link budget, each way: every gain and loss between the transmitter and the receiver, and the fade margin they add up to</caption>
          <thead><tr><td></td>${ways.map(w => `<th scope="col" class="lb-num">${esc(w.from.name)} → ${esc(w.to.name)}</th>`).join('')}<td></td></tr></thead>
          <tbody>
            ${row('TX power', each(w => w.txDbm), 'dBm', '', false)}
            ${row('TX antenna gain', each(w => w.f.gain), 'dBi')}
            ${row('TX line loss', each(w => (w.f.loss == null ? null : -w.f.loss)), 'dB')}
            ${row(`= ${term('eirp', 'EIRP')}`, each(w => w.eirp), 'dBm', 'lb-sub', false)}
            ${loss.join('')}
            ${row(`= ${term('pathLoss', 'Path loss')}`, same(w0.pathLoss == null ? null : -w0.pathLoss), 'dB', 'lb-sub', false)}
            ${row('RX antenna gain', each(w => w.t.gain), 'dBi')}
            ${row('RX line loss', each(w => (w.t.loss == null ? null : -w.t.loss)), 'dB')}
            ${row(`= ${term('received', 'Received signal')}`, each(w => w.rx), 'dBm', 'lb-sub', false)}
            ${row(term('threshold', 'RX threshold'), each(w => w.t.thr), 'dBm', '', false)}
          </tbody>
          <tfoot>
            <tr class="lb-margin"><th scope="row">${term('fade', 'Fade margin')}</th>${ways.map(w => {
              const m = w.margin == null ? null : lbMarginClass(w.margin);
              return `<td class="lb-num${m ? ` txt-${m.cls}` : ''}">${fmt(w.margin, true)}<br><span class="small">${m ? esc(m.label) : 'not worked out'}</span></td>`;
            }).join('')}<td class="lb-unit">dB</td></tr>
          </tfoot>
        </table>
      </div>
      ${short}`;
  }

  // Beside the budget: what the picture shows in words, what each end is, and
  // where the figures come from.
  function pathFactsHtml(pp, an, P) {
    const { a, b } = pp;
    const both = pp.kind !== 'base';
    const V = PATH_VERDICT[an.verdict] || { label: an.verdict, note: '' };
    const w = an.worst;
    const facts = [];
    facts.push(`<strong class="txt-${V.cls || 'muted'}">${esc(V.label)}</strong>${V.note ? ` — ${esc(V.note[0].toLowerCase() + V.note.slice(1))}` : ''}`);
    if (w && w.clearance != null) {
      const what = w.cover != null ? 'the trees or buildings' : 'the ground';
      facts.push(w.clearance >= 0
        ? `Closest ${what} comes to the line of sight: ${num(Math.round(w.clearance))} m under it, ${esc(fmtKm(w.d1 / 1000))} from ${esc(a.name)}, ${
            w.ratio >= 1 ? `clear of the whole first ${term('fresnel', 'Fresnel zone')}`
              : `where ${num(Math.round(w.ratio * 100))}% of the first ${term('fresnel', 'Fresnel zone')} is clear (60% is the rule)`}.`
        : `${what[0].toUpperCase()}${what.slice(1)} ${w.cover != null ? 'stand' : 'stands'} ${num(Math.round(-w.clearance))} m above the line of sight
           ${esc(fmtKm(w.d1 / 1000))} from ${esc(a.name)}${an.obstructions.length > 1 ? `, one of ${num(an.obstructions.length)} places it is cut` : ''}.`);
    }
    const ends = [[a, an.groundA, an.aglA, an.liftA_m], [b, an.groundB, an.aglB, an.liftB_m]].map(([st, g, h, lift]) =>
      `${esc(st.name)}: antenna ${num(Math.round(h * 10) / 10)} m up, on ground at ${num(Math.round(g))} m${
        lift > 0.5 ? ` (the terrain there is ${num(Math.round(lift))} m above the station's surveyed height, so it stands on the terrain)` : ''}.`);
    facts.push(ends.join(' '));
    if (typeof MapFreq !== 'undefined') {
      const hops = MapFreq.hops(both ? 'repeater' : 'base', a, b);
      facts.push(hops.map(h => `${esc(h.from.name)} sends to ${esc(h.to.name)} on ${h.label ? esc(h.label) : 'a frequency not on file'}${
        h.listens ? ` (${esc(h.to.name)} listens on ${esc(h.listens)})` : ''}`).join('; ') + '.');
    }
    if (both) {
      facts.push(pp.overlap
        ? `${term('set', 'Pass ranges')} open in both: ${plural(pp.overlap, 'address', 'addresses')}, ${num(pp.shared.length)} of them in use${
            pp.shared.length ? ` (${pp.shared.slice(0, 8).map(esc).join(', ')}${pp.shared.length > 8 ? '…' : ''})` : ''}.`
        : 'No ALERT address is open in both pass ranges.');
      const da = a.repeater ? a.repeater.delay_ms : null, db = b.repeater ? b.repeater.delay_ms : null;
      if (da != null && da === db) {
        facts.push(`<span class="txt-bad">Both hold the same delay, ${num(da)} ms: a reading both take is sent on at the same moment, and the two
          copies collide wherever a receiver hears both.</span>`);
      }
    }
    // Where the figures come from, briefly; the full working is the Stations card's.
    const P_ = an.prop || pathPropOf();
    const prof = P.prof;
    const ground = P.lidar ? 'The ground is the ~30 m terrain tiles with 5 m LiDAR spliced in at the ends and the obstacles'
      : `The ground is the ~30 m terrain tiles, read at ${num(prof.distance_m.length)} points`;
    const model = an.model === 'field'
      ? `Longley–Rice over the bare ground, less the ${num(an.allowance_db)} dB ${term('allowance', 'field allowance')}`
      : 'Longley–Rice over the land cover stood on the ground, with what the trees cost an antenna under them';
    const cover = P.cover === 'ready'
      ? (an.model === 'field' ? ' The trees and buildings from the land-cover map are drawn on the ground and read for the line of sight; their cost is in the allowance.' : '')
      : P.cover === 'failed' ? ' The land cover could not be read, so only the bare ground is drawn.'
      : P.cover === 'lidar' ? ' On LiDAR ground the land cover is not drawn.'
      : ' The land cover is switched off on the Stations map\'s profile card.';
    const notes = [
      `Indicative only — a model of the path, not a measurement. ${ground}${prof.partial ? `; ${num(prof.missing)} had no tile and are left as gaps, which the model bridges` : ''}.
       ${model}, at ${an.fMhz.toFixed(3)} MHz, for ${num(P_.location)}% of places and ${num(P_.time)}% of the time.${cover}`,
      'Each end\'s figures are its station\'s radio system, with anything typed over them on the Stations map\'s cards this session. To change one, read the ground from LiDAR, follow the signal along the path or copy a report, open the same path on the Stations map.',
    ];
    if (!an.itm) notes.unshift(`<span class="txt-warn">The model could not run${an.itmError ? ` (${esc(an.itmError)})` : ''}; one knife edge over the worst obstruction stands in for it.</span>`);
    return `<ul class="small rptr-path-facts">${facts.map(f => `<li>${f}</li>`).join('')}</ul>
      ${notes.map(n => `<p class="small txt-muted rptr-path-note">${n}</p>`).join('')}`;
  }

  // The samples a chart this wide draws: all of them, up to a LiDAR ground's
  // thousands, where it keeps the highest per half-pixel — a ridge is never
  // thinned away (PathProfile's chart does the same).
  function thinIdx(all, D, iw) {
    if (all.length <= THIN_AT) return all.map((_, i) => i);
    const buckets = Math.max(1, Math.round(2 * iw)), top = new Map();
    const hOf = p => (p.surfBulged != null ? p.surfBulged : p.bulged);
    all.forEach((p, i) => {
      const k = Math.min(buckets - 1, Math.floor((p.d1 / D) * buckets));
      const j = top.get(k);
      if (j == null || (hOf(p) != null && (hOf(all[j]) == null || hOf(all[j]) < hOf(p)))) top.set(k, i);
    });
    return [...new Set([0, all.length - 1, ...top.values()])].sort((p, q) => p - q);
  }

  // The profile, drawn the way the Stations map's profile card draws it — the
  // ground with the earth's curve added, the land cover stood on it, the line
  // of sight and the 60% Fresnel zone round it, red where something reaches
  // into the zone — in the same colours, at this card's width. The heights
  // are stretched against the distances, and the key says by how much. And,
  // like that card, a little way past each end (`by`, path-profile.js's
  // pathBeyond), faded: the ground each end stands on, for looking at only.
  function pathChartSvg(an, prof, a, b, by) {
    const W = Math.round(Math.max(320, Math.min(1600, S.pathW || 920)));
    const H = Math.round(Math.min(320, Math.max(200, W * 0.3)));
    const fs = 11, L = 52, R = 14, T = 24, B = 30;
    const iw = W - L - R, ih = H - T - B, D = an.D;
    const out = typeof pathBeyondOn === 'function' ? pathBeyondOn(by || null, D, an.k)
      : { a: [], b: [], all: [], padA: 0, padB: 0, sink: 0 };
    const ext = out.all;
    let lo = Infinity, hi = -Infinity;
    for (const p of an.pts) {
      if (p.bulged != null) { lo = Math.min(lo, p.bulged); hi = Math.max(hi, p.bulged); }
      if (p.surfBulged != null) hi = Math.max(hi, p.surfBulged);
      hi = Math.max(hi, p.los + 0.6 * p.r1);
      lo = Math.min(lo, p.los - 0.6 * p.r1);
    }
    for (const p of ext) if (p.bulged != null) { lo = Math.min(lo, p.bulged); hi = Math.max(hi, p.bulged); }
    if (!isFinite(lo) || !isFinite(hi) || !(D > 0)) return '';
    const pad = Math.max(20, (hi - lo) * 0.1);
    // The floor lowered by as far as the earth falls away past the ends, so the
    // curvature arc can follow it down there (pathBeyondOn's `sink`).
    lo -= pad - out.sink; hi += pad;
    // Along, from the far end of the ground past A to the far end of the
    // ground past B: A and B stand a little in from the plot's edges.
    const pxm = iw / (D + out.padA + out.padB);       // pixels per metre along
    const x = d => L + (d + out.padA) * pxm;
    const y = m => T + (1 - (m - lo) / (hi - lo)) * ih;
    const xy = (d, m) => `${x(d).toFixed(1)},${y(m).toFixed(1)}`;
    const base = (T + ih).toFixed(1);
    const xA = x(0), xB = x(D);
    const pts = thinIdx(an.pts, D, xB - xA).map(i => an.pts[i]);

    const sky = `<rect x="${L}" y="${T}" width="${iw}" height="${ih}" fill="var(--profile-sky)" stroke="var(--border)" stroke-width="1"/>`;
    // Gridlines on round heights.
    const span = hi - lo;
    const stepM = span > 1600 ? 400 : span > 800 ? 200 : span > 400 ? 100 : span > 160 ? 50 : 20;
    const grid = [];
    for (let m = Math.ceil(lo / stepM) * stepM; m <= hi; m += stepM) {
      grid.push(`<line x1="${L}" y1="${y(m).toFixed(1)}" x2="${W - R}" y2="${y(m).toFixed(1)}" stroke="var(--border)" stroke-width="1"/>
        <text x="${L - 6}" y="${(y(m) + 3.5).toFixed(1)}" font-size="${fs}" text-anchor="end" style="fill:var(--muted)">${m}</text>`);
    }
    // The ground, as areas down to the axis; a gap where a tile was missing
    // stays a gap.
    const runs = [];
    let run = [];
    for (const p of pts) {
      if (p.bulged == null) { if (run.length) runs.push(run); run = []; } else run.push(p);
    }
    if (run.length) runs.push(run);
    // Filled, with the line along its top drawn on its own: an outline round
    // the whole area would stand a wall at each antenna, now that the plot
    // runs on past them.
    const groundOf = (r, cls) => {
      const top = r.map(p => xy(p.d1, p.bulged));
      return `<path${cls ? ` class="${cls}"` : ''} d="M${x(r[0].d1).toFixed(1)},${base} L${top.join(' L')} L${
        x(r[r.length - 1].d1).toFixed(1)},${base} Z" fill="var(--terrain-fill)" stroke="none"/>
        <polyline points="${top.join(' ')}" fill="none" stroke="var(--terrain-line)" stroke-width="1"/>`;
    };
    const ground = runs.map(r => groundOf(r)).join('');
    // The ground past each end, joined to the path's own end sample so the
    // two meet without a step, and a veil over the plot past each antenna.
    const sideRuns = side => {
      const rs = [];
      let r = [];
      for (const p of side) {
        if (p.bulged == null) { if (r.length) rs.push(r); r = []; } else r.push(p);
      }
      if (r.length) rs.push(r);
      return rs.filter(q => q.length > 1);
    };
    const beyondGround = [
      ...(out.a.length ? sideRuns([...out.a, an.pts[0]]) : []),
      ...(out.b.length ? sideRuns([an.pts[an.pts.length - 1], ...out.b]) : []),
    ].map(r => groundOf(r, 'path-beyond-ground')).join('');
    const veil = !ext.length ? '' : [[L, xA], [xB, L + iw]].filter(([p, q]) => q - p > 1).map(([p, q]) => `
      <rect class="path-beyond" x="${(p + 0.5).toFixed(1)}" y="${T + 0.5}" width="${(q - p - 1).toFixed(1)}" height="${ih - 1}"
            fill="var(--panel)" opacity=".45" pointer-events="none"/>`).join('');
    // What stands on it: a band a class at a time, in the class's colour.
    const bands = [];
    const present = [];
    if (an.coverUsed && typeof LandCover !== 'undefined') {
      let seg = null;
      const flush = () => {
        if (seg && seg.pts.length > 1) {
          const top = seg.pts.map(p => xy(p.d1, p.surfBulged)).join(' L');
          const bot = seg.pts.slice().reverse().map(p => xy(p.d1, p.bulged)).join(' L');
          const c = LandCover.CLASSES[seg.cls];
          bands.push(`<path d="M${top} L${bot} Z" fill="${LandCover.colourVar(seg.cls)}" opacity=".85" stroke="none"><title>${
            esc(c ? c.label : String(seg.cls))}</title></path>`);
        }
        seg = null;
      };
      for (const p of pts) {
        const tall = p.cls != null && p.cover > 0 && p.bulged != null && p.surfBulged != null;
        if (!tall) { flush(); continue; }
        if (!present.includes(p.cls)) present.push(p.cls);
        if (seg && seg.cls !== p.cls) { seg.pts.push(p); flush(); }
        if (!seg) seg = { cls: p.cls, pts: [] };
        seg.pts.push(p);
      }
      flush();
    }
    // The planet's curve along the bottom, drawn to the chart's own scale.
    // Past the ends it carries on down to the floor, which was lowered by just
    // that much, so under the path it stands where it always has.
    const arcPts = [...out.a, ...pts, ...out.b].filter(p => p.bulge != null);
    const arc = arcPts.map(p => xy(p.d1, lo - out.sink + p.bulge));
    const earth = arc.length < 2 ? '' : `<path d="M${x(arcPts[0].d1).toFixed(1)},${base} L${arc.join(' L')} L${x(arcPts[arcPts.length - 1].d1).toFixed(1)},${base} Z"
        fill="var(--profile-earth)" stroke="none"/><polyline points="${arc.join(' ')}" fill="none" stroke="var(--profile-earth-line)" stroke-width="1.5"/>`;
    const sag = pts.reduce((m, p) => (p.bulge > m ? p.bulge : m), 0);
    // Red where the ground or what is on it reaches into the 60% zone.
    const bad = [];
    let br = [];
    for (const p of pts) {
      if (p.surfBulged != null && p.clearance != null && p.clearance < 0.6 * p.r1) br.push(p);
      else if (br.length) { bad.push(br); br = []; }
    }
    if (br.length) bad.push(br);
    const obstruction = bad.map(r => (r.length > 1
      ? `<polyline points="${r.map(p => xy(p.d1, p.surfBulged)).join(' ')}" fill="none" stroke="var(--bad)" stroke-width="2.5"/>`
      : `<circle cx="${x(r[0].d1).toFixed(1)}" cy="${y(r[0].surfBulged).toFixed(1)}" r="2" fill="var(--bad)"/>`)).join('');
    const zone = k => `<polyline points="${pts.map(p => xy(p.d1, p.los + k * 0.6 * p.r1)).join(' ')}" fill="none"
        stroke="var(--accent)" stroke-width="1" stroke-dasharray="4 3" opacity=".7"/>`;
    const radio = `${zone(1)}${zone(-1)}<line x1="${x(0).toFixed(1)}" y1="${y(an.txZ).toFixed(1)}" x2="${x(D).toFixed(1)}" y2="${y(an.rxZ).toFixed(1)}"
        stroke="var(--accent)" stroke-width="1.8"/>`;
    const masts = `<line x1="${x(0).toFixed(1)}" y1="${y(an.groundA).toFixed(1)}" x2="${x(0).toFixed(1)}" y2="${y(an.txZ).toFixed(1)}" stroke="var(--map-repeater)" stroke-width="2"/>
      <line x1="${x(D).toFixed(1)}" y1="${y(an.groundB).toFixed(1)}" x2="${x(D).toFixed(1)}" y2="${y(an.rxZ).toFixed(1)}" stroke="var(--map-repeater)" stroke-width="2"/>`;
    const w = an.worst;
    const marker = w && w.ratio < 0.6 && w.surfBulged != null ? `
      <line x1="${x(w.d1).toFixed(1)}" y1="${y(w.surfBulged).toFixed(1)}" x2="${x(w.d1).toFixed(1)}" y2="${y(w.los).toFixed(1)}"
            stroke="var(--bad)" stroke-width="1.5" stroke-dasharray="3 3"/>
      <circle cx="${x(w.d1).toFixed(1)}" cy="${y(w.surfBulged).toFixed(1)}" r="3.5" fill="var(--bad)"/>` : '';
    const ticks = (iw >= 1100 ? [0, .125, .25, .375, .5, .625, .75, .875, 1] : [0, .25, .5, .75, 1]).map(f => `
      <text x="${x(D * f).toFixed(1)}" y="${H - 10}" font-size="${fs}" text-anchor="${f === 0 && xA - L < 12 ? 'start' : f === 1 && W - xB < 30 ? 'end' : 'middle'}"
            style="fill:var(--muted)">${esc(fmtKm(D * f / 1000))}</text>`).join('');
    // The two ends named over the plot, each kept to its own half.
    const room = Math.max(6, Math.floor((iw / 2 - 10) / (fs * 0.58)));
    const cut = s => (s.length > room ? s.slice(0, room - 1) + '…' : s);
    const names = `<text x="${L}" y="${T - 8}" font-size="${fs}" font-weight="600" text-anchor="start" style="fill:var(--text)">${esc(cut(a.name))}</text>
      <text x="${W - R}" y="${T - 8}" font-size="${fs}" font-weight="600" text-anchor="end" style="fill:var(--text)">${esc(cut(b.name))}</text>`;
    const stretch = (ih / (hi - lo)) / pxm;
    const V = PATH_VERDICT[an.verdict] || { label: an.verdict };
    const said = w && w.clearance != null
      ? (w.clearance >= 0 ? `, worst clearance ${Math.round(w.clearance)} m under the line at ${fmtKm(w.d1 / 1000)}`
        : `, ${w.cover != null ? 'cover' : 'terrain'} ${Math.round(-w.clearance)} m above the line at ${fmtKm(w.d1 / 1000)}`) : '';
    const coverKey = present.map(c => {
      const cl = LandCover.CLASSES[c];
      const h = LandCover.heightOf(c);
      return `<span><i class="path-key-cover" style="--dot:${LandCover.colourVar(c)}"></i> ${esc(cl ? cl.label : String(c))}${h != null ? ` · ${h} m` : ''}</span>`;
    }).join('');
    return `
      <svg viewBox="0 0 ${W} ${H}" class="path-chart" role="img" data-a-x="${xA.toFixed(1)}" data-b-x="${xB.toFixed(1)}"
           aria-label="${escAttr(`Ground profile over ${fmtKm(D / 1000)} from ${a.name} to ${b.name} — ${V.label}${said}${ext.length
             ? `, with the ground for ${fmtKm(Math.max(out.padA, out.padB) / 1000)} past each end drawn faded, for context` : ''}. The figures are listed under the chart.`)}">
        ${sky}${grid.join('')}${radio}${ground}${beyondGround}${bands.join('')}${earth}${veil}${obstruction}${marker}${masts}
        <line x1="${L}" y1="${base}" x2="${W - R}" y2="${base}" stroke="var(--muted)" stroke-width="1"/>
        ${ticks}${names}
      </svg>
      <div class="path-key small">
        <span><i class="path-key-los"></i> Line of sight</span>
        <span><i class="path-key-fres"></i> ${term('fresnel', '60% Fresnel zone')}</span>
        <span><i class="path-key-gnd"></i> Ground (curvature k=${an.k.toFixed(2)} included)</span>
        ${earth ? `<span><i class="path-key-earth"></i> Earth curvature${sag > 0.5 ? ` · ${Math.round(sag)} m at mid-path` : ''}</span>` : ''}
        <span><i class="path-key-obs"></i> Inside the Fresnel zone</span>
        ${ext.length ? `<span><i class="path-key-beyond"></i> ${term('beyond', 'Ground past each end')} · ${
          esc(fmtKm(Math.max(out.padA, out.padB) / 1000))}, for context</span>` : ''}
        <span><i class="path-key-mast"></i> Antennas</span>
        ${coverKey}
        <span>Heights drawn ×${stretch >= 10 ? Math.round(stretch) : stretch.toFixed(1)} against distances</span>
      </div>`;
  }

  // What the card says, as figures — for a check to hold against the
  // Stations map's link budget.
  function pathReport() {
    const P = S.path;
    if (!P) return null;
    const pp = pathPair(P.a, P.b);
    const an = P.status === 'ready' ? P.an : null;
    return {
      a: P.a, b: P.b, kind: pp ? pp.kind : null, status: P.status, error: P.error || '',
      verdict: an ? an.verdict : null, fMhz: an ? an.fMhz : null, dKm: pp ? pp.km : null, model: an ? an.model : null,
      ways: an && pp ? waysOf(pp, an).map(w => ({
        from: w.from.id, to: w.to.id, txDbm: w.txDbm, txGain: w.f.gain, txLoss: w.f.loss, eirp: w.eirp, fspl: w.fspl,
        pathLoss: w.pathLoss, rxGain: w.t.gain, rxLoss: w.t.loss, rx: w.rx, thr: w.t.thr, margin: w.margin,
      })) : [],
    };
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  function focusRow(id) {
    const b = document.getElementById('rptr-b-' + id);
    if (b) { try { b.focus({ preventScroll: true }); } catch (_) { b.focus(); } }
  }
  function scrollRow(id) {
    const tr = document.getElementById('rptr-r-' + id);
    if (tr && tr.scrollIntoView) tr.scrollIntoView({ block: 'nearest' });
  }

  function toggle(id) {
    if (S.open.has(id)) S.open.delete(id); else S.open.add(id);
    refresh();
    focusRow(id);
  }
  function sort(key) {
    if (!COLS.some(c => c.key === key)) return;
    if (S.sort.key === key) S.sort = { key, dir: -S.sort.dir };
    else S.sort = { key, dir: COLS.find(c => c.key === key).text ? 1 : -1 };
    writeLS(LS_SORT, JSON.stringify(S.sort));
    refresh({ keepScroll: false });
    const btn = document.querySelector(`#rptr-table .th-sort[data-key="${key}"]`);
    if (btn) btn.focus();
  }
  function filter(q) {
    S.q = String(q || '');
    refresh({ keepScroll: false });
  }
  function setFull(on) {
    S.full = !!on;
    writeLS(LS_FULL, S.full ? '1' : '0');
    refresh();
    if (!S.full) {
      const card = document.getElementById('rptr-tab-h');
      if (card && card.scrollIntoView) card.scrollIntoView({ block: 'start' });
    }
    const foot = document.querySelector('#rptr-foot button');
    if (foot) foot.focus({ preventScroll: true });
  }
  function kmShow(v) {
    document.querySelectorAll('.rptr-km-val').forEach(out => { out.textContent = `${num(Number(v))} km`; });
  }
  function setKm(v) {
    const km = Math.max(10, Math.min(KM_MAX, Math.round(Number(v) / 10) * 10 || KM_DEFAULT));
    S.km = km;
    writeLS(LS_KM, String(km));
    ['rptr-km', 'rptr-km-full'].forEach(id => {
      const input = document.getElementById(id);
      if (input) { input.value = km; input.setAttribute('aria-valuetext', `${km} kilometres`); }
    });
    kmShow(km);
    refresh();
  }
  // From the map: a second press lets go. A picked repeater's row is opened.
  function pickRep(id) {
    S.pick = id && S.pick !== id ? id : null;
    if (S.pick) S.open.add(S.pick);
    refresh();
  }
  // Its row, open and in view: from the map, and from a linked repeater in
  // another row. A filter that leaves it out is cleared, or there is no row.
  function goTo(id) {
    const M = S.M;
    if (!M || !M.byId.has(id)) return;
    closeFull();
    if (S.q && !filtered(M).some(r => r.id === id)) {
      S.q = '';
      const box = document.getElementById('rptr-filter');
      if (box) box.value = '';
    }
    S.open.add(id);
    S.pick = id;
    refresh();
    scrollRow(id);
    focusRow(id);
  }
  function showOnMap(id) {
    const r = S.M && S.M.byId.get(id);
    if (!r || !placed(r.st)) return;
    S.pick = id;
    refresh();
    if (S.map) {
      const pts = [[r.st.lat, r.st.lon]].concat(r.links.reps.map(n => [n.st.lat, n.st.lon]), r.links.bases.map(n => [n.st.lat, n.st.lon]));
      try { S.map.fitBounds(pts, { padding: [30, 30], maxZoom: 10 }); } catch (_) { /* one point */ }
    }
    const el = document.getElementById('rptr-map');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
  }
  // A plain click goes to the Stations tab the app's way; a click asking for
  // a new tab or window is left to the browser and the link's address.
  function openStation(ev, id) {
    if (ev && (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey || ev.button === 1)) return true;
    if (ev && ev.preventDefault) ev.preventDefault();
    if (typeof goToStation === 'function') goToStation(id);
    return false;
  }

  async function readCarriers() {
    if (S.tsumPhase === 'loading' || typeof dbSelect !== 'function') return;
    S.tsumPhase = 'loading';
    try {
      const rows = await dbSelect('transmitter_summary?select=tx,station_id,freq_mhz,w_days,w_ppm,w_hz,days,judged_at&tx=like.st:*&limit=5000');
      S.tsum = new Map(rows.map(r => [r.tx, r]));
      S.tsumPhase = 'ready';
      S.tsumErr = '';
      S.tsumAt = Date.now();
    } catch (err) {
      S.tsumPhase = 'error';
      S.tsumErr = (err && err.message) || String(err);
    }
    refresh();
  }

  // What each repeater was heard relaying, and its turnaround (0092): a row a
  // repeater, the server's week, one request — public, so it fills signed out
  // too. A database before 0092 has no such table (PostgREST's 404, or 42P01
  // through it): then the receptions are read in the browser as Signal Routes
  // reads them, at once for an editor, which is what the column did before.
  const missingTable = err => !!err && (err.status === 404 || /does not exist|Could not find the table|PGRST205|42P01/.test(String(err.message || err)));
  async function readRelay() {
    if (S.relayPhase === 'loading' || typeof dbSelect !== 'function') return;
    S.relayPhase = 'loading';
    refresh();
    try {
      const rows = await dbSelect('relay_summary?select=*&order=station_id.asc&limit=1000');
      S.relay = new Map(rows.map(r => [r.station_id, r]));
      S.relayPhase = 'ready';
      S.relayErr = '';
      S.relayMissing = false;
      S.relayAt = Date.now();
    } catch (err) {
      S.relayPhase = 'error';
      S.relayErr = (err && err.message) || String(err);
      S.relayMissing = missingTable(err);
    }
    refresh();
    if (!S.relay && S.relayMissing && signedIn() && !air() && active()) readAir();
  }

  async function readAir() {
    if (typeof SignalRoutes === 'undefined' || !signedIn() || S.air) return;
    S.air = 'loading';
    refresh();
    try {
      if (SignalRoutes.loadDays) await SignalRoutes.loadDays(AIR_DAYS);
      else await SignalRoutes.load();
    } catch (_) { /* Signal Routes says what went wrong in its own state */ }
    S.air = '';
    refresh();
  }

  // The delay plan takes half a second the first time, so the page is drawn
  // without it and it is worked out a beat later.
  function wantPlan() {
    if (S.planReady || S.planTimer || typeof RepeaterDelays === 'undefined') return;
    // Off the page's thread where the browser can (RepeaterDelays.planSoon):
    // the half second — two on a laptop busy with a Teams call — was the tab
    // not answering just after it was drawn.
    if (RepeaterDelays.planSoon) {
      const asked = S.planTimer = {};
      RepeaterDelays.planSoon().catch(() => null).then(() => {
        if (S.planTimer !== asked) return;      // the tab was left meanwhile
        S.planTimer = null;
        if (!active()) return;
        S.planReady = true;
        refresh();
      });
      return;
    }
    S.planTimer = setTimeout(() => {
      S.planTimer = null;
      if (!active()) return;
      try { RepeaterDelays.planAtDefaults(); } catch (_) { /* the column says — */ }
      S.planReady = true;
      refresh();
    }, 150);
  }

  function init() {
    if (typeof registerTabTeardown === 'function') {
      registerTabTeardown('Repeaters', () => {
        stopMap();
        if (S.planTimer) { clearTimeout(S.planTimer); S.planTimer = null; }
        if (S.pathResize) { window.removeEventListener('resize', S.pathResize); S.pathResize = null; }
      });
    }
    // The chart is drawn to its box, so a window resized draws it again.
    if (!S.pathResize) {
      let t = null;
      S.pathResize = () => { clearTimeout(t); t = setTimeout(() => { if (active()) drawPath(); }, 150); };
      window.addEventListener('resize', S.pathResize);
    }
    initMap();
    footFits();
    // A link left open last visit: drawn to the width it has now, and read
    // again if what it rests on changed meanwhile on the Stations map.
    if (S.path) computePath();
    drawPath();
    wantPlan();
    if (S.tsumPhase !== 'loading' && (!S.tsum || Date.now() - S.tsumAt > REFRESH_MS)) readCarriers();
    if (S.relayPhase !== 'loading' && (!S.relay || Date.now() - S.relayAt > REFRESH_MS)) readRelay();
  }

  // Signing in or out changes who may read the receptions.
  function authChanged() {
    refresh();
    if (S.relayMissing && signedIn() && !air() && active()) readAir();
  }

  // ── The CSV ───────────────────────────────────────────────────────────────

  // The repeaters the filter leaves, in the table's order. The station list
  // leaving as a file needs a signed-in session — the Export tab's rule.
  function exportCsv() {
    const M = model();
    if (!M) return;
    if (typeof exportMayDownload === 'function' && !exportMayDownload()) {
      if (typeof Toast !== 'undefined') Toast.show('Sign in first — taking the station list away as a file needs a signed-in session (the Export tab\'s rule).', { kind: 'failed' });
      return;
    }
    const list = sorted(filtered(M));
    const ranges = rs => rs.map(rangeText).join('; ');
    const head = ['repeater', 'station_id', 'station_number', 'networks', 'rx_mhz', 'tx_mhz', 'addresses', 'field_stations',
      'linked_repeaters', 'base_stations_in_reach', 'link_distance_km', 'pass_ranges', 'exclusions',
      'pass_ranges_heard', 'heard_in_range', 'heard_off_record', 'in_range_heard_only_another_way', 'carrier_found_days',
      'carrier_offset_hz', 'carrier_offset_ppm', 'carrier_days_measured', 'delay_ms_recorded', 'turnaround_ms_measured',
      'turnaround_ms_q1', 'turnaround_ms_q3', 'turnaround_pairs', 'delay_ms_measured', 'delay_ms_planned',
      'lat', 'lon', 'stations'];
    const lines = [head.join(',')];
    for (const r of list) {
      const h = r.heard;
      lines.push([r.name, r.id, r.num, r.nets.join('; '), r.rx ?? '', r.tx ?? '', r.addresses ?? '', r.carried.length,
        r.links.reps.map(n => n.st.name).join('; '), r.links.bases.map(n => n.st.name).join('; '), S.km,
        ranges(r.ranges), ranges(r.excl),
        h ? h.runs.map(x => (x.kind === 'off' ? '!' : '') + (x.lo === x.hi ? `${x.lo}` : `${x.lo}–${x.hi}`)).join('; ') : '',
        h ? h.inRange : '', h ? h.off.map(o => o.a).join('; ') : '', h ? h.elsewhere.join('; ') : '', h ? h.days : '',
        r.cfo && r.cfo.hz != null ? Math.round(r.cfo.hz) : '', r.cfo ? r.cfo.ppm.toFixed(2) : '', r.cfo && r.cfo.days != null ? r.cfo.days : '',
        r.delayRec ?? '', r.gap ? Math.round(r.gap.ms) : '', r.gap && r.gap.lo != null ? Math.round(r.gap.lo) : '',
        r.gap && r.gap.hi != null ? Math.round(r.gap.hi) : '', r.gap ? r.gap.n : '', r.delayMeas != null ? Math.max(0, r.delayMeas) : '',
        r.delayPlan ?? '', r.st.lat ?? '', r.st.lon ?? '',
        r.carried.map(s => s.name).sort((a, b) => a.localeCompare(b)).join('; ')].map(csvEscape).join(','));
    }
    dlText(`repeaters-${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\n') + '\n');
  }

  return { render, init, refresh, authChanged, toggle, sort, filter, setFull, kmShow, setKm, pick: pickRep, goTo, showOnMap, openFull, closeFull,
           openStation, readAir, exportCsv, model, state: () => S,
           openPath, closePath, pathKey, pathOnStations, pathRetry, pathReport, setLayer, layOpacity };
})();
