// The per-tab Definition of Done (EPIC #107's six U-issues).
//
// The twelfth check, added by #137 — the first of the six per-tab issues to
// land. It exists for the reason the other eleven do, and the reason is sharper
// here than anywhere else on the board: `npm run shell` holds #109's system,
// but it holds it against *the shell and one tab*, deliberately and by its own
// comment. Nothing was holding the other eighteen. Six issues are converting
// nineteen tabs in parallel, each told "use the tokens, wrap the tables, name
// the landmarks, don't scroll the page sideways" — and every one of those
// instructions was worth exactly as much as the reviewer's attention until now.
//
// The shape is a list, not a sweep. CONVERTED below names the tabs that claim
// to have been through a U-issue; everything in this file is asserted against
// those and against nothing else. A U-issue's last commit adds its tab ids to
// that list, which is the point: the check grows tab by tab with the epic, and
// a tab nobody has converted yet does not fail a check for work nobody has done.
//
// Eight things are checked per tab:
//
//   Inline styles.  None, except a `--token: value` override (that *is* the
//                   system — see .page's --page-max) and a <col> width, which
//                   is what #109's own proving-ground check exempts and why.
//
//   Tables.         Wrapped in .table-wrap, captioned, and every thead th
//                   scoped. Pattern 1 and 6.
//
//   Scroll regions. A .table-wrap that caps its height (.tall / .medium) is
//                   role="region" + tabindex="0" + a name. Pattern 7a: a div
//                   with overflow:auto is keyboard-scrollable in Firefox and
//                   nowhere else, so the content below the fold of one was
//                   unreachable without a mouse.
//
//   Clickable rows. A <tr> with an onclick contains a focusable control.
//                   Pattern 7b. The row is a mouse convenience; the button in
//                   its first cell is the part a keyboard can reach.
//
//   Landmarks.      An <aside> inside <main> is a complementary landmark in
//                   every screen reader's landmark list. Five tabs render one.
//                   It carries an aria-label or it is not a landmark — the rule
//                   shell.mjs §4 states and hands to the U-issues.
//
//   Names.          Every visible interactive element has an accessible name.
//                   "Open" ×40 and a bare "↗" both count as *having* one, so
//                   this is a floor rather than a ceiling — but it is the floor
//                   the audit behind #111 found the app below.
//
//   Headings.       h1 → h2 → h3 with no step skipped, counting the shell's own
//                   h1. A tab that opens at h3 tells a screen reader it is a
//                   subsection of something that is not there.
//
//                   Measured over the shell's h1 plus the headings inside
//                   #main-content, and *not* over the whole document (#141).
//                   Reading the document in order gave every tab five free h2s
//                   before it started: #108's five nav group headings sit ahead
//                   of <main> in the DOM, so a tab opening at h3 followed an h2
//                   and passed. Three of the four tabs #141 converted were doing
//                   exactly that, and this check said nothing about any of them.
//
//   Scope.          Every check above reads #main-content **plus the side
//                   panel's pane on screen**, if one is. Since the side panel
//                   (the dock) took the Stations cards out of <main> — the
//                   filters, the station table, the link budget, the editor —
//                   a check scoped to <main> alone passed all three Stations
//                   entries while measuring nothing but the map. The pane's
//                   headings follow <main>'s in the outline, which is the order
//                   the document reads them in.
//
//   Overflow.       No sideways scroll of the document at 375, 768 and 1440, in
//                   both themes. Same assertion shell.mjs makes about the shell,
//                   made about each converted tab — which is where the wide
//                   thing actually lives.
//
// Plus one that belongs to a pattern rather than to a tab:
//
//   Pattern 8.      A graphic marked role="img" that is a *shortcut* for
//                   controls beside it must have a name, and every operation it
//                   offers must be on one of those controls. Radio Path Maps'
//                   basin drawing is the first instance: a hundred clickable
//                   polygons, none of them a tab stop, and eight region buttons
//                   underneath that do the same thing. The check is that the
//                   claim holds — every region on the drawing has a chip.
//
// Run:  npm run tabs
//       npm run tabs -- -v    also print what passed

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

// ── Seeds ───────────────────────────────────────────────────────────────────
// A `seed` on a CONVERTED entry is source for a function run in the page
// immediately after switchTab(), for a tab whose interesting state does not
// exist until something is loaded (#141). Three of the twenty are like that —
// ARRO Data draws nothing until a CSV is dropped on it, and Field Data and the
// Message Log draw nothing until the datastore answers — which under this
// harness it never does, because the network policy blocks it. Checked as
// they arrive, both tabs are an empty state and a paragraph, and the toolbar,
// the chart, the legend, the readout and the readings table — every surface
// #141 actually converted — went unmeasured. Seeded, ARRO Data goes from one
// visible control and no tables to 61 and two.
//
// The series seed goes through the module's own boundary (`seriesData` →
// `adoptSeries`, the door #114 added and documented) rather than reaching into
// its internals, so a series this check can draw is a series the app can draw.
// It is deliberately not a fixture file: a file would be a second statement of
// the shape, and the shape is what the boundary is for.

// The Launcher's results table only exists once something has been typed, and
// the table is most of what there is to check on that tab.
const SEED_ARRO_SEARCH = `() => {
  state.arro.search = 'a';
  renderMain();
}`;

// Two series, because one series is the case where the dash patterns are
// deliberately off and the chart's name says "1 series" — neither of which is
// the case worth holding. Both <details> are opened, because a closed one is
// display:none and everything inside it would be filtered out as invisible:
// the readings table is the chart pattern's part 3 and the whole reason this
// seed exists.
function seedSeries(source) {
  return `() => {
    const mk = (n, t0, step, spike) => {
      const t = new Float64Array(n), tr = new Float64Array(n);
      const v = new Float64Array(n), raw = new Float64Array(n), q = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        t[i]  = t0 + i * step;
        tr[i] = t[i] + 5000;
        v[i]  = i * 0.4 + (i % 53 === 0 ? spike : 0);
        raw[i] = v[i];
        q[i] = 0;
      }
      return { n, t, tr, v, raw, q, qcodes: ['Good'], unit: 'mm', warn: [], hasRaw: true };
    };
    const t0 = Date.UTC(2026, 2, 1, 0, 0, 0);
    const field = ${source === 'field' ? 'true' : 'false'};
    const prov = i => field ? {
      host: 'seed.meganet.test', res: 'raw', addr: 'a:612' + i,
      t0, t1: t0 + 400 * 900000, capped: false,
    } : null;
    ArroData.adoptSeries(ArroData.seriesData(mk(400, t0, 900000, 900)), {
      fileName: 'seed-a.csv', label: 'Seed A · Rainfall', kind: 'RA', prov: prov(8),
    });
    ArroData.adoptSeries(ArroData.seriesData(mk(400, t0, 900000, -400)), {
      fileName: 'seed-b.csv', label: 'Seed B · Water level', kind: 'WL', prov: prov(9),
    });
    ArroData.ad.tableOpen = true;
    ArroData.ad.compare = true;
    renderMain();
  }`;
}

// ── The two RF tabs, and why they need four entries between them (#138) ──────
// Both are lazy: nothing is fetched until the tab is opened, and neither draws
// anything but "Loading ACMA interference data…" until ~2 MB of JSON has
// parsed. Two animation frames is nowhere near that, so checked as they arrive
// both tabs are a heading and a paragraph — the #141 empty-state problem again,
// with a different cause. Their seeds therefore *await*, which is what the
// `await` on the seed call below is for.
//
// And each of them has two views that cannot both be on screen at once, so each
// gets two entries. That is not padding: the pair is where the interesting
// markup lives, and the default is the half with less of it.
//
//   RF Environment  with no repeater chosen, it draws the by-repeater summary
//                   table; with one chosen, that table is *replaced* by the
//                   strip plot and its carrier table. The correlation helper
//                   draws nothing at all until timestamps have been analysed —
//                   an hour histogram, a 24-row table and a <details>, none of
//                   which any earlier state can reach.
//   RF Changes      with no onset date the coincidence table has two fewer
//                   columns and the timeline has no shaded band; with an onset
//                   and a pasted series it also grows a legend, a lower band, a
//                   row of step buttons and the repeater-grouping table.
//
// The repeater picker is opened in both RF Changes seeds on purpose. It is 89
// checkboxes inside a closed <details>, which is `display: none` — so every one
// of them is invisible, and the check filters invisible elements out. Closed, it
// is 89 controls nobody measured; open, it is also the thing that used to
// scroll the page sideways by 520 px on a phone, because an absolutely
// positioned list still counts toward its container's scrollWidth.
const SEED_ACMA = `
  await acmaEnsureCore().catch(() => {});
  if (typeof RfChanges !== 'undefined') await RfChanges.ensureData().catch(() => {});`;

// A dated series with a step in it, so the detector finds something and the
// grouping table below it has rows. Two series rather than one, because one is
// the case where the dash patterns are deliberately off.
const RFC_CORR = [
  'Bluff Ck, 2026-03-25, 0', 'Bluff Ck, 2026-03-26, 1', 'Bluff Ck, 2026-03-27, 0',
  'Bluff Ck, 2026-03-28, 1', 'Bluff Ck, 2026-03-29, 0', 'Bluff Ck, 2026-03-30, 2',
  'Bluff Ck, 2026-03-31, 1', 'Bluff Ck, 2026-04-01, 0', 'Bluff Ck, 2026-04-02, 1',
  'Bluff Ck, 2026-04-03, 14', 'Bluff Ck, 2026-04-04, 16', 'Bluff Ck, 2026-04-05, 12',
  'Bluff Ck, 2026-04-06, 15', 'Bluff Ck, 2026-04-07, 18', 'Bluff Ck, 2026-04-08, 13',
  'Amiens, 2026-03-25, 1', 'Amiens, 2026-03-26, 0', 'Amiens, 2026-03-27, 2',
  'Amiens, 2026-03-28, 1', 'Amiens, 2026-03-29, 0', 'Amiens, 2026-03-30, 1',
  'Amiens, 2026-03-31, 2', 'Amiens, 2026-04-01, 1', 'Amiens, 2026-04-02, 0',
  'Amiens, 2026-04-03, 11', 'Amiens, 2026-04-04, 13', 'Amiens, 2026-04-05, 9',
  'Amiens, 2026-04-06, 12', 'Amiens, 2026-04-07, 14', 'Amiens, 2026-04-08, 10',
].join('\\n');

const SEED_RF_ALL = `async () => {${SEED_ACMA}
  state.rf.anchorId = '';
  state.rf.corrText = '2026-07-12 09:41\\n2026-07-13 10:05\\n2026-07-14 22:40\\n2026-07-15 09:15';
  renderMain();
  rfCorrelate();
  for (const d of document.querySelectorAll('#main-content details')) d.open = true;
}`;

const SEED_RF_ONE = `async () => {${SEED_ACMA}
  // The first repeater that actually has candidates — an empty one draws no
  // ticks and no carrier table, which is the state this entry exists to avoid.
  const withThreats = state.acma.threats.anchors.filter(a => a.threats.length);
  state.rf.anchorId = (withThreats[0] || {}).station_id || '';
  renderMain();
  for (const d of document.querySelectorAll('#main-content details')) d.open = true;
}`;

const SEED_RFC_PLAIN = `async () => {${SEED_ACMA}
  state.rfc.onset = '';
  state.rfc.corrText = '';
  state.rfc.corrSeries = null;
  state.rfc.corrSteps = null;
  state.rfc.pickerOpen = true;
  renderMain();
}`;

const SEED_RFC_ONSET = `async () => {${SEED_ACMA}
  state.rfc.onset = '2026-04-03';
  state.rfc.pickerOpen = true;
  state.rfc.corrText = \`${RFC_CORR}\`;
  renderMain();
  RfChanges.analyseCorr();
  for (const d of document.querySelectorAll('#main-content details')) d.open = true;
}`;

// The tabs that have been through a U-issue. Add yours here when you land it —
// that is how this check grows with the epic. The label is the nav label, so a
// failure names the tab the way the app does. Add a `seed` above and name it
// here if your tab has a state the harness cannot reach on its own.
// The Message Log renders its table from whatever the datastore returned, and
// under this harness the datastore never answers — so, like ARRO Data above,
// the unseeded tab is an error note and a filter rail. Seeded through the
// module's own boundary (adoptRows, the documented door: rows exactly as
// meganet.reading returns them), the table, the selection column and an open
// detail drawer are all on screen to be measured. Two addresses, one of them
// station-number-addressed, so the channel column and the "no ALERT id" cell
// are both exercised; toggleRow opens the drawer the way a click would. The
// opened row and a Raspberry Pi's say how they were heard (0050) — dBm from a
// radio, dBFS from an RTL-SDR — so the Freq, Signal and SNR cells and the
// drawer's Heard line are measured with something in them.
const SEED_MSGLOG = `() => {
  MessageLog.adoptRows([
    { addr: 'a:6128', alert_id: 6128, station_number: null, channel: '',
      station_id: null, reading_ts: '2026-03-01T04:15:00+00:00',
      received_at: '2026-03-01T04:15:32+00:00', value_raw: 12, value: 2.4,
      unit: 'mm', conversion: 'raw x 0.2 mm per tip', quality: 0, protocol: 1,
      source: 2, path: 'MOUNT_TABLETOP', dup_count: 2,
      dup_paths: ['DURIKAI', 'direct'], last_dup_at: '2026-03-01T04:15:40+00:00',
      raw_id: 41, freq_mhz: 151.5125, rssi_dbm: -97.5, level_dbfs: null, snr_db: 21.5 },
    { addr: 'a:4160', alert_id: 4160, station_number: null, channel: '',
      station_id: null, reading_ts: '2026-03-01T04:12:00+00:00',
      received_at: '2026-03-01T04:12:01+00:00', value_raw: 24, value: null,
      unit: null, conversion: null, quality: 0, protocol: 1, source: 5,
      path: 'serial-monitor/rpi-83071968-sdr1-152.400', dup_count: 0, dup_paths: [],
      last_dup_at: null, raw_id: 42, freq_mhz: 152.4, rssi_dbm: null,
      level_dbfs: -57.6, snr_db: 11 },
    { addr: 's:541155/level', alert_id: null, station_number: '541155',
      channel: 'level', station_id: null, reading_ts: '2026-03-01T04:10:00+00:00',
      received_at: '2026-03-01T04:10:05+00:00', value_raw: 1.842, value: null,
      unit: 'm', conversion: null, quality: 1, protocol: 0, source: 1,
      path: null, dup_count: 0, dup_paths: [], last_dup_at: null, raw_id: null },
    // A relayed ALERT2 pair (#172) — the third address shape, so the AlertID
    // cell's a2 rendering and the unresolved drawer's claim affordance are both
    // on screen for the eight per-tab checks rather than only in the one place
    // that seeds them deliberately.
    { addr: 'a2:1003/13', alert_id: null, a2_station: 1003, a2_sensor: 13,
      station_number: null, channel: '', station_id: null,
      reading_ts: '2026-03-01T04:05:00+00:00', received_at: '2026-03-01T04:05:03+00:00',
      value_raw: 155.6, value: null, unit: null, conversion: null,
      quality: 0, protocol: 5, source: 2,
      path: 'meganet/v1/elpro_test/logger/reading/elpro/Station 1003',
      dup_count: 0, dup_paths: [], last_dup_at: null, raw_id: null },
  ]);
  MessageLog.toggleRow('a:6128|2026-03-01T04:15:00+00:00|12');
}`;

// The Bit Flipper draws an ask-me state until an address is typed, and the
// table, the ARRO link and the map markers all hang off the address. The seed
// types one through the tab's own handler — an alert id read out of the loaded
// data, so the variants genuinely match stations — and waits out the 250 ms
// map-refresh debounce so the overflow pass measures a populated tab.
const SEED_BITFLIPPER = `async () => {
  const addr = String(state.data.stations
    .flatMap(s => (s.sensors || []).map(x => x.alert_id))
    .find(a => Number.isInteger(a) && a > 0 && a < 65536));
  const input = document.getElementById('bf-addr');
  if (input) input.value = addr;
  onBfAddrInput(addr);
  await new Promise(r => setTimeout(r, 300));
}`;

// The Workbench draws an intro panel until a case exists, and everything else
// — verdict, ranking, matrix, map, timeline, both right-rail panels — only
// once one does. The seed drives the tab's own worked-example loader, which
// picks the best-served repeater out of the loaded data and builds a real
// five-affected/two-good case through the same path the intro button takes.
// The ACMA and RFC lazy loads then fire and fail (the harness blocks the
// network), so their panels are checked in their honest failed state; the
// wait lets those rejections re-render before anything is measured.
const SEED_WORKBENCH = `async () => {
  Workbench.loadExample();
  await new Promise(r => setTimeout(r, 400));
}`;

// The ALERT Packets tab renders its decoder and encoder shells with no result
// cards until something decodes. The seed drives the tab's own example button,
// which runs the real message through the real codec — the result cards, the
// bit grids and the field tables are then the ones an operator sees.
const SEED_PACKETS = `() => { Packets.loadExample(); }`;

// The Serial Monitor's live card only exists with a connection, and a headless
// browser has no serial hardware. Serial.addDemo() is the tab's own "Show a
// demo connection" button (#140): the sample bytes run through the real
// pipeline — handleChunk, the three mode framers, the shared Packets codec —
// so the card being held to the Definition of Done is the live view, not a
// mock-up of it.
const SEED_SERIAL_DEMO = `() => { Serial.addDemo(); }`;

// The two device cards, demoed the same way: the Quansheng dashboard (the
// firmware's own example lines through the real parser, with its settings,
// log, station table, screen and console sections opened so their controls
// are measured too) and the RTL-SDR card (the demo band through the real
// decoder, its controls open by default).
const SEED_RADIO_DEMO = `() => {
  Serial.addDemo('quansheng');
  document.querySelectorAll('.ser-radio details').forEach(d => { d.open = true; });
}`;
// The ERT-A2 card, on the tab's own demo button: real frames off a test unit's
// USB port through the live decoder, so its chips, both tables (with RSSI and
// station links) and the raw stream are all populated. And a card set to
// follow a log file, for the source choice and the drop zone a managed
// computer is left with.
const SEED_ERT_DEMO = `() => { Serial.addDemo('ert'); }`;
const SEED_SERIAL_FOLLOW = `() => {
  Serial.addConnection('ert');
  const c = Serial.list()[Serial.list().length - 1];
  Serial.setSource(c.id, 'file');
}`;
// The Reception Map, on its own demo drive: the map, the suspects table and
// the bad copies all populated.
const SEED_RECEPTION_DEMO = `async () => { Reception.loadDemo(); await new Promise(r => setTimeout(r, 300)); }`;
const SEED_SDR_DEMO = `async () => {
  Serial.addDemo('sdr');
  await new Promise(r => setTimeout(r, 1500));
}`;

// The ALERT2 tab, twice, on the tab's own sample-capture button — real binary
// frames off a test ERT-A2's USB port, so the RSSI columns, the coverage map
// and the ambiguity panel all populate. The two entries split on the view
// toggle: Readings is the table half, Frame anatomy is the byte-by-byte half
// with the TLV chips, payload strips and per-reading maths — mutually
// exclusive views, so one entry cannot check both (design-system §6).
const SEED_ALERT2 = `async () => {
  Alert2.loadSample('bin');
  await new Promise(r => setTimeout(r, 50));
}`;
const SEED_ALERT2_FRAMES = `async () => {
  Alert2.loadSample('bin');
  Alert2.setView('frames');
  await new Promise(r => setTimeout(r, 50));
}`;

// The Ghosting Graph starts from the confirmed relationships in
// data/ghosting-links.json, which is fetched after init() returns — a seed
// that does not wait for it measures an empty stage. Searching for an address
// out of the loaded file gives the graph a starting point of its own either
// way, so the check holds whether or not that file is there.
const SEED_NETWORK = `async () => {
  const addr = String(state.data.stations
    .flatMap(s => (s.sensors || []).map(x => x.alert_id))
    .find(a => Number.isInteger(a) && a > 0 && a < 65536));
  const box = document.getElementById('nv-search');
  if (box) box.value = addr;
  NetworkView.onSearch(addr);
  await new Promise(r => setTimeout(r, 500));
}`;

// The Stations tab draws three things the harness never reaches on its own,
// and each is most of a surface: the ACMA transmitter layer and its options
// (lazily fetched, so an unseeded visit measures the master toggle and nothing
// under it), a selected station (the editor card and the "repeaters listening"
// table below the map), and a map selection (the selection bar above the
// table). This seed produces all three, through the tab's own handlers.
const SEED_STATIONS = `async () => {${SEED_ACMA}
  // A station with an ALERT address, so the carriers card has rows to draw
  // rather than its no-address note — and, where one exists, one the Bureau's
  // river height station lists name (0031), so the editor's flood classes,
  // crossings and gauge survey are drawn with rows in them. One row of each is
  // opened: a shut <details> is display:none inside, and its boxes would be
  // filtered out of every check below as invisible.
  const hasId = s => s.lat != null && (s.sensors || []).some(x => Number.isInteger(x.alert_id));
  const withId = state.data.stations.find(s => hasId(s)
      && ['flood_classes', 'crossings', 'gauge_survey'].every(k => (s[k] || []).length))
    || state.data.stations.find(hasId);
  if (withId) selectStation(withId.id);
  addToMapSelection(state.data.stations.slice(0, 3).map(s => s.id));
  rerenderStations();
  // The filter card itself since #165 — the filters are a collapsible under the
  // map now, and a shut card takes every control in it out of this check. It is
  // shut on arrival since #181, and it is a button-and-panel disclosure rather
  // than a <details>, so it opens through its own handler rather than by having
  // an attribute set on it.
  setStationFiltersOpen(true);
  for (const d of document.querySelectorAll(
    '#station-filters details, #acma-filter-block details')) d.open = true;
  // Last, because the re-renders above draw the editor afresh, shut.
  for (const d of document.querySelectorAll('.rhs-list .rhs-row:first-child')) d.open = true;
  await new Promise(r => setTimeout(r, 350));
}`;

// The Stations tab's third state, and the one nothing else reaches: a radio
// path. Draw & measure, the terrain profile and the link budget all hang off a
// two-point line, and the harness has no way to draw one with a mouse. The
// seed puts a real line between two located stations through MapDraw's own
// public seam — the same call the link budget's "Profile this path" makes —
// and then asks the budget to adopt it, which is the tab's own button. Terrain
// tiles are blocked here, so the two panels are checked in their honest
// no-terrain state, the way #139 checked the Workbench's ACMA panels.
const SEED_STATIONS_PATH = `async () => {
  const located = state.data.stations.filter(s => s.lat != null && s.lon != null);
  const a = located.find(s => s.roles.includes('repeater')) || located[0];
  const b = located.find(s => s !== a && Math.abs(s.lat - a.lat) + Math.abs(s.lon - a.lon) > 0.05);
  MapDraw.addLine([[a.lat, a.lon], [b.lat, b.lon]], [a.id, b.id]);
  PathProfile.setOpen(true);
  LinkBudget.fromProfile();
  await new Promise(r => setTimeout(r, 500));
}`;

// The HFEM tab (#154) — the first tab in this repo born converted rather than
// brought to the system later, so it joins CONVERTED in its own first commit.
// Two entries because it has two states worth holding, and they are not
// mutually exclusive so much as empty-and-full: the paste box with the builder
// and the reference under it, and the same page with a capture decoded — which
// is where the summary, the measurements table and the per-message cards live.
// The capture is the spec's own ten worked examples, so what the check measures
// is what test/hfem.mjs holds the codec to.
const SEED_HFEM = `() => {
  HfemTab.loadSample('spec');
  for (const d of document.querySelectorAll('#main-content details')) d.open = true;
}`;

// The digital twin: the 🧊 pane of the Stations side panel (what was the
// Digital Twin tab's left column), and the twin itself inside the map. Under
// this harness the twin draws nothing: its renderer arrives from disk, but
// every elevation and imagery host is blocked, so the stage says so and the
// panels round it — the finder, the settings, the Ground truth list, the
// empty table, the help at the foot — are what is measured here. The built
// scene, with its ground and its canvas name, is `npm run twin`'s to hold.
// Two entries: the pane with no twin open, and a station's twin opened on the
// map, its ground unreachable, with the pane beside it.
const SEED_TWIN_NONE = `async () => {
  setDockTab('twin');
  for (const d of document.querySelectorAll('#main-content details, #dock-pane-twin details')) d.open = true;
}`;

// The 🔭 AR station finder's pane (station-ar.js): the way in, the distance and
// the types, with "How it works" opened so what is inside it is measured too.
// The view the pane opens is the whole screen and wants a camera, a GPS and a
// compass this harness does not give it; `npm run ar` drives that.
const SEED_AR_PANE = `async () => {
  setDockTab('ar');
  for (const d of document.querySelectorAll('#main-content details, #dock-pane-ar details')) d.open = true;
}`;

const SEED_TWIN = `async () => {
  const s = state.data.stations.find(x => isFinite(x.lat) && isFinite(x.lon));
  DigitalTwin.pick(s.id);
  setDockTab('twin');
  // The build ends — with a scene, or with a status that says why not — in a
  // sentence that does not trail off. Bounded, so a harness with no WebGL is
  // still measured rather than hung.
  await new Promise(res => {
    const t0 = Date.now();
    const tick = () => (!DigitalTwin.debug().status.endsWith('…') || Date.now() - t0 > 20000) ? res() : setTimeout(tick, 100);
    tick();
  });
  for (const d of document.querySelectorAll('#main-content details, #dock-pane-twin details')) d.open = true;
}`;

// The Field Photos tab, born converted. Signed out it is a sentence and a
// button; signed in it is the drop zone, a queue table, the library's grid and
// the sync's report — none of which exists until the datastore answers, which
// under this harness it never does. So its three tables, and only those, are
// answered by a route below (PHOTO_FIXTURE), and the queue is set as state: a
// photo read off its overlay with the place editor open under it, and one
// refused. Reading a photo is `npm run photos`'s to prove; this measures what
// the tab draws once one has been read.
const SEED_PHOTOS_OUT = `() => {
  dbSetAccessToken(null);
  FieldPhotos.authChanged();
}`;

const SEED_PHOTOS = `async () => {
  dbSetAccessToken('tabs-check');
  state.photos.queue = [
    { key: 't1', name: 'solocator-gatton-sw.jpg', size: 208184, status: 'ready', note: 'Ready.',
      pos: { lat: -27.554294, lon: 152.274116, placement: 'ocr', accuracy: 4, confidence: 'high' },
      heading: { deg: 242, ref: 'T' }, taken: { local: '2026-06-24T12:26:08', zone: 'printed' },
      station: { id: 'gatton', auto: true, m: 117 }, editing: true },
    { key: 't2', name: 'IMG_1188.HEIC', size: 2400000, status: 'refused',
      note: 'Refused — the HEIC could not be decoded — no picture in it could be read; it may be damaged or cut short.' },
  ];
  FieldPhotos.authChanged();
  await new Promise(res => {
    const t0 = Date.now();
    const tick = () => (state.photos.lib && state.photos.sync && state.photos.types) || Date.now() - t0 > 5000
      ? res() : setTimeout(tick, 50);
    tick();
  });
  for (const d of document.querySelectorAll('#main-content details')) d.open = true;
}`;

// 📸 The Field Camera, born converted. As it opens it is a Start button on a
// dark stage, the station and caption sections and an empty list. With photos
// kept on the device — two through the camera app's door, signed out, since
// the harness has no camera and no fix — it is the waiting list with every
// action a photo has, the sign-in it waits for, and a station search's hits.
// test/camera.mjs holds what the tab does; this holds how it is built.
const SEED_CAMERA = `async () => {
  dbSetAccessToken(null);
  const make = async name => {
    const cv = document.createElement('canvas');
    cv.width = 1200; cv.height = 900;
    const cx = cv.getContext('2d');
    cx.fillStyle = '#6b7b55'; cx.fillRect(0, 0, 1200, 900);
    const b = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.8));
    return new File([b], name, { type: 'image/jpeg' });
  };
  const n0 = FieldCamera._debug().shots.length;
  await FieldCamera.fromFiles([await make('IMG_0001.jpg'), await make('IMG_0002.jpg')]);
  await new Promise(res => {
    const t0 = Date.now();
    const tick = () => (FieldCamera._debug().shots.length >= n0 + 2 || Date.now() - t0 > 5000 ? res() : setTimeout(tick, 50));
    tick();
  });
  FieldCamera.findStation('Gatton');
  for (const d of document.querySelectorAll('#main-content details')) d.open = true;
}`;

const PHOTO_FIXTURE = {
  attachment_type: [{ content_type: 'image/jpeg', ord: 1, label: 'JPEG photo', extensions: ['jpg', 'jpeg'], max_bytes: 25165824 }],
  field_photo: [
    { id: '00000000-0000-4000-8000-00000000f001', storage_path: 'photo/00000000-0000-4000-8000-00000000f001.jpg',
      thumb_path: 'photo/00000000-0000-4000-8000-00000000f001.thumb.jpg', content_type: 'image/jpeg', byte_size: 208184,
      width: 1545, height: 1159, title: 'solocator-gatton-sw.jpg', caption: 'The staff gauge from the bridge',
      taken_at: '2026-06-24T02:26:08Z', taken_local: '2026-06-24T12:26:08', taken_source: 'ocr',
      lat: -27.554294, lon: 152.274116, placement: 'ocr', accuracy_m: 4, altitude_m: 134, altitude_ref: 'HAE',
      heading_deg: 242, heading_ref: 'T', pitch_deg: null, fov_deg: null, station_id: 'gatton', station_auto: true,
      origin: 'upload', uploaded_by: 'tabs@example.test', created_at: '2026-06-24T05:00:00Z', updated_at: '2026-06-24T05:00:00Z',
      ocr_confidence: 'high', zone_source: 'printed' },
    { id: '00000000-0000-4000-8000-00000000f002', storage_path: 'photo/00000000-0000-4000-8000-00000000f002.jpg',
      thumb_path: 'photo/00000000-0000-4000-8000-00000000f002.thumb.jpg', content_type: 'image/jpeg', byte_size: 32669,
      width: 1200, height: 900, title: 'paddock-2.jpg', caption: '', taken_at: null, taken_local: null, taken_source: null,
      lat: null, lon: null, placement: null, accuracy_m: null, altitude_m: null, altitude_ref: null,
      heading_deg: null, heading_ref: null, pitch_deg: null, fov_deg: null, station_id: null, station_auto: false,
      origin: 'dropbox', uploaded_by: 'Dropbox — Flood Crew', created_at: '2026-06-24T05:01:00Z', updated_at: '2026-06-24T05:01:00Z',
      ocr_confidence: null, zone_source: null },
  ],
  field_photo_sync: [{ source: 'dropbox', folder: '/Field photos', account: 'Flood Crew', last_run_at: '2026-06-24T05:01:00Z',
    last_ok_at: '2026-06-24T05:01:00Z', last_error: null, runs: 12, seen: 3, imported: 2, unplaced: 1, skipped: 0, failed: 0 }],
};

// The Base Stations tab (0049), born converted. Signed out it is a paragraph
// and a button; as an administrator it is the list, a station's panel and the
// team keys — none of which exists until the database answers, so its four
// reads are answered by a route below (BS_FIXTURE), and the panel is opened
// through the tab's own Open. "Administrator" is stood in for only while this
// tab is the one on screen, so no other entry here is measured signed in.
// test/basestations.mjs holds what the tab does; this holds how it is built.
// 📲 Offline & Install with the browser's install prompt held (a stand-in
// for Chromium's beforeinstallprompt), the other browsers' steps unfolded and
// Get ready's four steps on the page — every surface the tab draws at once.
const SEED_OFFLINE = `async () => {
  const e = new Event('beforeinstallprompt', { cancelable: true });
  e.prompt = async () => {};
  e.userChoice = Promise.resolve({ outcome: 'dismissed' });
  window.dispatchEvent(e);
  await OfflineTab.refresh();
  document.querySelectorAll('#ot-page details').forEach(d => { d.open = true; });
}`;

const SEED_BS_OUT = `() => {
  if (window.__bsAuth) { Object.assign(Auth, window.__bsAuth); delete window.__bsAuth; }
  BaseStations.authChanged();
}`;

const SEED_BS = `async () => {
  if (!window.__bsAuth) {
    const real = { isSignedIn: Auth.isSignedIn, isAdmin: Auth.isAdmin, role: Auth.role };
    window.__bsAuth = real;
    const here = () => state.activeTab === 'basestations';
    Auth.isSignedIn = () => here() || real.isSignedIn();
    Auth.isAdmin = () => here() || (real.isAdmin ? real.isAdmin() : false);
    Auth.role = () => here() ? 'admin' : real.role();
  }
  BaseStations.authChanged();
  const until = async (fn, ms) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 50)); };
  await until(() => document.querySelector('#bs-list table') && document.querySelector('#bs-keys table'), 5000);
  BaseStations.open(11);
  await until(() => document.querySelector('#bs-settings #bs-f-name') && document.querySelector('#bs-requests table'), 5000);
  for (const d of document.querySelectorAll('#main-content details')) d.open = true;
}`;

const BS_AGO = s => new Date(Date.now() - s * 1000).toISOString();
const BS_STATUS = {
  name: 'Mt Stuart base',
  host: { hostname: 'mt-stuart', model: 'Model B Rev 1.5', os: 'Debian GNU/Linux 12 (bookworm)', arch: 'arm64', node: 'v20.18.0',
    cores: 4, mem_mb: 3796, disk_mb: 29000, addresses: [{ iface: 'eth0', address: '192.168.1.40' }, { iface: 'wlan0', address: '10.20.30.40' }] },
  clock: { trusted: true, source: 'ntp', timezone: 'Australia/Brisbane' },
  location: { source: 'gps', lat: -19.35123, lon: 146.78456, accuracy_m: 4 },
  meganet: { enabled: true, receptions: true, label: 'Mt Stuart base', endpoint: 'https://floodwarning.net/api/db/rest/v1', token_refused: false,
    error: 'HTTP 503 from https://floodwarning.net/api/db/rest/v1/rpc/ingest_http — retrying in 30 s' },
  receivers: [
    { key: 'sdr:00000001', name: 'RTL-SDR 1 with a long name for a narrow screen', kind: 'sdr', state: 'running', freq_hz: 151500000, format: 'BINARY',
      gain_db: 29.7, model: 'RTL-SDR Blog V4', usb_port: '1-1.3' },
    { key: 'sdr:00000002', name: 'RTL-SDR 2', kind: 'sdr', state: 'unplugged', freq_hz: 160250000, format: 'ENHANCED_IFLOWS', gain_db: null, usb_port: '1-1.4' },
    { key: 'ert:/dev/serial/by-id/usb-FTDI_FT232R_USB_UART_A10KXYZW-if00-port0', name: 'ERT-A2', kind: 'ert-a2', state: 'error',
      error: 'no frames for 10 minutes', port: '/dev/serial/by-id/usb-FTDI_FT232R_USB_UART_A10KXYZW-if00-port0', baud: 115200, firmware: '2.1' },
    { key: 'gps:ttyACM0', name: 'GPS', kind: 'gps', state: 'running', port: '/dev/ttyACM0', baud: 9600 },
  ],
  update: { available: true, auto: true, running: false, last: { state: 'rolled-back', at: Math.round(Date.now() / 1000) - 3600,
    message: 'the new version did not start, so 0.5.2 was put back — see its update log' } },
  access: { available: true, account: { name: 'alert', exists: true, password: 'set', keys: 3 },
    ssh: { enabled: true, active: true, passwordLogin: false, port: 22 }, policy: { meganetKeys: true, github: ['jo-bloggs', 'sam-field'] },
    logins: [{ user: 'pi', password: 'empty', keys: 1 }, { user: 'alert', password: 'set', keys: 3 }],
    keys: [{ fingerprint: 'SHA256:VeBIQNSQYe0Ge+JIoXnjKbfB0gSWAJChLuItuhNNFew', comment: 'jo@a-very-long-laptop-name.example.org', source: 'github', restricted: true },
           { fingerprint: 'SHA256:RknIRqux7NWt85Wr0wnUI0GZOtVaVIIGAxKdQwI8OEU', comment: 'Sam Field', source: 'meganet', restricted: true },
           { fingerprint: 'SHA256:ST5vehZy5UfLDnjvsU9mbYVfaSPQlCgvu9WdYYqm760', comment: 'console@site', source: 'local', restricted: false }],
    keys_total: 4 },
  remote: { mode: 'manage', idle_s: 60 },
  config: { name: 'Mt Stuart base', meganet: { enabled: true, receptions: true },
    receivers: { sdr: { enabled: true, freqHz: 151500000, sampleRate: 0, gainDb: 29.7, ppm: 0, format: 'BINARY', squelchDb: 8 },
      sdrDevices: [{ key: 'sdr:00000002', name: 'RTL-SDR 2', freqHz: 160250000, format: 'ENHANCED_IFLOWS', gainDb: null }] },
    audio: { enabled: true, mode: 'auto', device: 'default', volume: 80 }, kiosk: { mode: 'auto' }, system: { timezone: 'Australia/Brisbane' } },
};
const BS_ROW = (o) => Object.assign({ host_station_id: null, host_station: null, revoked_at: null, managed: true, app: 'base station agent',
  version: '0.6.0', mode: 'manage', idle_s: 60, last_seen_at: BS_AGO(20), status_at: BS_AGO(300), last_used_at: BS_AGO(30),
  watch_until: null, keys_hash: 'h1', waiting: 0, receivers: [] }, o);
const BS_FIXTURE = {
  admin_base_stations: () => ({ now: new Date().toISOString(), keys_hash: 'h2', stations: [
    BS_ROW({ id: 11, label: 'Mt Stuart base', host_station: 'Mt Stuart', status: BS_STATUS, keys_hash: 'h1',
      beat: { up: 400000, agent_up: 3600, temp: 66, load: 0.42, mem_free: 2900, disk_free: 400, uv: false, uv_boot: true, throttled: true,
        clock: true, q: 640, hold: 12, rxq: 40, stored: 18233, refused: 2, last_ok: BS_AGO(600),
        rx: [['sdr:00000001', 'running', 412, 15], ['sdr:00000002', 'unplugged', 0, null]] } }),
    BS_ROW({ id: 12, label: 'Hut reporter', mode: 'report', status: { name: 'The hut on the ridge', receivers: [] }, beat: { temp: 40 } }),
    BS_ROW({ id: 14, label: 'Creek gauge base', last_seen_at: BS_AGO(7200), status: { name: 'Creek gauge base', meganet: { token_refused: true }, receivers: [] },
      beat: { uv: true, temp: 80, clock: false }, revoked_at: BS_AGO(3600) }),
    BS_ROW({ id: 13, label: 'Serial laptop', managed: false, app: null, version: null, mode: null, last_seen_at: null, status: null, beat: null,
      receivers: [{ point_id: 'sm-1', name: 'Quansheng radio', receiver: 'quansheng', last_seen_at: BS_AGO(300) }] }),
  ] }),
  admin_base_station: () => ({ now: new Date().toISOString(), keys_hash: 'h2',
    station: BS_FIXTURE.admin_base_stations().stations[0],
    commands: [
      { id: 3, verb: 'config.set', args: { patch: { receivers: { sdr: { freqHz: 151625000 } }, name: 'Mt Stuart base' } }, status: 'queued',
        created_at: BS_AGO(5), created_by: 'admin@example.test', expires_at: BS_AGO(-595) },
      { id: 2, verb: 'log', args: { lines: 200 }, status: 'done', created_at: BS_AGO(60), created_by: 'admin@example.test', sent_at: BS_AGO(58),
        done_at: BS_AGO(57), result: { lines: [{ t: Date.now() - 60000, level: 'info', tag: 'remote',
          msg: 'MegaNet asks: show its log — a long line that has to wrap rather than push the page sideways on a phone' }] } },
      { id: 1, verb: 'update.install', args: {}, status: 'failed', created_at: BS_AGO(7200), created_by: 'admin@example.test', error: 'no published release found' },
    ] }),
  admin_base_station_watch: () => ({ id: 11, watch_until: new Date(Date.now() + 180000).toISOString(), want_status: true }),
  admin_base_station_keys: () => ({ hash: 'h2', keys: [
    { id: 5, key_type: 'ssh-ed25519', fingerprint: 'SHA256:VeBIQNSQYe0Ge+JIoXnjKbfB0gSWAJChLuItuhNNFew', owner: 'Jo Bloggs', comment: 'jo@laptop',
      added_at: BS_AGO(864000), added_by: 'admin@example.test' },
    { id: 4, key_type: 'ssh-rsa', fingerprint: 'SHA256:ST5vehZy5UfLDnjvsU9mbYVfaSPQlCgvu9WdYYqm760', owner: 'Former Staff', comment: null,
      added_at: BS_AGO(8640000), added_by: 'admin@example.test', removed_at: BS_AGO(86400), removed_by: 'admin@example.test' },
  ] }),
};

// The Station Health tab, born converted. It draws nothing but its status
// line until the datastore answers, which under this harness it never does, so
// its seed is the tab's own Demo week — real stations, a made-up week with one
// of every fault planted — waited for: the analysis takes a frame to start and
// a few hundred milliseconds to run. Two entries: the board (what needs
// attention, the map, the checks matrix, the network, the agent's key form),
// and a station open with a missed check put in context, which is where the
// slot strip, the battery chart and the context lens live. test/health.mjs
// holds what the tab does; this holds how it is built.
const SEED_HEALTH = `async () => {
  const st = Health.state();
  if (!(st.A && st.demo)) Health.demo();
  for (let i = 0; i < 200 && !(Health.state().A && document.querySelector('.hl-ftable')); i++) await new Promise(r => setTimeout(r, 25));
  if (Health.state().sel) Health.close();
}`;
const SEED_HEALTH_STATION = `async () => {
  const st = Health.state();
  if (!(st.A && st.demo)) Health.demo();
  for (let i = 0; i < 200 && !(Health.state().A && document.querySelector('.hl-ftable')); i++) await new Promise(r => setTimeout(r, 25));
  const A = Health.state().A;
  const f = A.findings.find(x => x.kind === 'silent');
  if (Health.state().sel !== f.stationId) Health.select(f.stationId);
  const miss = A.stations.get(f.stationId).slots.filter(sl => sl.outcome === 'miss').pop();
  Health.lensAt(f.stationId, miss.t, 'slot');
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
}`;

const CONVERTED = [
  { id: 'networks',   label: 'Networks',        issue: '#109 (proving ground) / #137' },
  { id: 'passranges', label: 'Pass Ranges',     issue: '#137' },
  { id: 'maps',       label: 'Radio Path Maps', issue: '#137' },
  { id: 'arro',       label: 'ARRO Launcher',   issue: '#141', seed: SEED_ARRO_SEARCH },
  { id: 'arrodata',   label: 'ARRO Data',       issue: '#141', seed: seedSeries('arro') },
  { id: 'field',      label: 'Field Data',      issue: '#141', seed: seedSeries('field') },
  { id: 'export',     label: 'Export',          issue: '#141' },
  { id: 'rf',         label: 'RF Environment — all repeaters', issue: '#138', seed: SEED_RF_ALL },
  { id: 'rf',         label: 'RF Environment — one repeater',  issue: '#138', seed: SEED_RF_ONE },
  { id: 'rfchanges',  label: 'RF Changes — no onset',          issue: '#138', seed: SEED_RFC_PLAIN },
  { id: 'rfchanges',  label: 'RF Changes — onset and a series', issue: '#138', seed: SEED_RFC_ONSET },
  { id: 'msglog',     label: 'Message Log',     issue: 'new with the tab', seed: SEED_MSGLOG },
  { id: 'mapgen',     label: 'Map Generator',   issue: 'new with the tab' },
  { id: 'bitflipper', label: 'Bit Flipper',     issue: '#139', seed: SEED_BITFLIPPER },
  { id: 'workbench',  label: 'Interference Workbench — intro',       issue: '#139' },
  { id: 'workbench',  label: 'Interference Workbench — worked case', issue: '#139', seed: SEED_WORKBENCH },
  { id: 'packets',    label: 'ALERT Packets',   issue: '#140', seed: SEED_PACKETS },
  { id: 'serial',     label: 'Serial Monitor — no connection', issue: '#140' },
  { id: 'serial',     label: 'Serial Monitor — demo stream',   issue: '#140', seed: SEED_SERIAL_DEMO },
  { id: 'serial',     label: 'Serial Monitor — Quansheng radio demo', issue: '#140', seed: SEED_RADIO_DEMO },
  { id: 'serial',     label: 'Serial Monitor — RTL-SDR demo',  issue: '#140', seed: SEED_SDR_DEMO },
  { id: 'serial',     label: 'Serial Monitor — ERT-A2 demo',   issue: '#140', seed: SEED_ERT_DEMO },
  { id: 'reception',  label: 'Reception Map — demo drive',     issue: '#140', seed: SEED_RECEPTION_DEMO },
  { id: 'serial',     label: 'Serial Monitor — following a log file (setup)', issue: '#140', seed: SEED_SERIAL_FOLLOW },
  { id: 'alert2',     label: 'ALERT2 Decoder — readings and map',  issue: '#140', seed: SEED_ALERT2 },
  { id: 'alert2',     label: 'ALERT2 Decoder — frame anatomy',     issue: '#140', seed: SEED_ALERT2_FRAMES },
  { id: 'network',    label: 'Ghosting Graph',  issue: '#140', seed: SEED_NETWORK },
  { id: 'stations',   label: 'Stations — empty of everything the harness cannot reach', issue: '#136' },
  { id: 'stations',   label: 'Stations — ACMA on, a station selected, a map selection', issue: '#136', seed: SEED_STATIONS },
  { id: 'stations',   label: 'Stations — a drawn path, its profile and its link budget', issue: '#136', seed: SEED_STATIONS_PATH },
  { id: 'hfem',       label: 'HFEM Messages — empty, with the builder and the reference', issue: 'born converted at #154' },
  { id: 'hfem',       label: 'HFEM Messages — the spec\'s ten examples decoded', issue: 'born converted at #154', seed: SEED_HFEM },
  { id: 'stations',   label: 'Stations — the 🧊 digital twin pane, no twin open', issue: 'the Digital Twin tab, folded in', seed: SEED_TWIN_NONE },
  { id: 'stations',   label: 'Stations — a station\'s twin on the map, its ground unreachable, the pane beside it', issue: 'the Digital Twin tab, folded in', seed: SEED_TWIN },
  { id: 'stations',   label: 'Stations — the 🔭 AR station finder pane', issue: 'new with the tool', seed: SEED_AR_PANE },
  { id: 'photos',     label: 'Field Photos — signed out', issue: 'born converted', seed: SEED_PHOTOS_OUT },
  { id: 'photos',     label: 'Field Photos — a queue, the place editor, the library and the sync', issue: 'born converted', seed: SEED_PHOTOS },
  { id: 'camera',     label: 'Field Camera — as it opens', issue: 'born converted' },
  { id: 'camera',     label: 'Field Camera — photos kept on the device, a station search', issue: 'born converted', seed: SEED_CAMERA },
  { id: 'basestations', label: 'Base Stations — signed out', issue: 'born converted', seed: SEED_BS_OUT },
  { id: 'basestations', label: 'Base Stations — the list, a station open, and the team keys', issue: 'born converted', seed: SEED_BS },
  { id: 'health',     label: 'Station Health — the demo week\'s board', issue: 'born converted', seed: SEED_HEALTH },
  { id: 'health',     label: 'Station Health — a station open, a missed check in context', issue: 'born converted', seed: SEED_HEALTH_STATION },
  { id: 'sitemap',    label: 'Site Map',        issue: 'born converted' },
  { id: 'offline',    label: 'Offline & Install — as it opens', issue: 'born converted' },
  { id: 'offline',    label: 'Offline & Install — an install prompt held, every browser\'s steps open', issue: 'born converted', seed: SEED_OFFLINE },
];


const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  if (!pass || VERBOSE) console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

// The accessible-name rules that matter for the controls this app builds, in
// specificity order. Not a full accname implementation — this is a floor check,
// and the cases it does not model (aria-labelledby chains through shadow roots,
// <label> wrapping something that is not its control) do not occur here.
const NAME_FN = `el => {
  const byIds = ids => (ids || '').split(/\\s+/).filter(Boolean)
    .map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
  const labelled = byIds(el.getAttribute('aria-labelledby'));
  if (labelled) return labelled;
  const aria = (el.getAttribute('aria-label') || '').trim();
  if (aria) return aria;
  if (el.id) {
    const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    if (lab && lab.textContent.trim()) return lab.textContent.trim();
  }
  const wrapping = el.closest('label');
  if (wrapping && wrapping.textContent.trim()) return wrapping.textContent.trim();
  const text = (el.textContent || '').trim();
  if (text) return text;
  const alt = (el.getAttribute('alt') || '').trim();
  if (alt) return alt;
  const title = (el.getAttribute('title') || '').trim();
  if (title) return title;
  const ph = (el.getAttribute('placeholder') || '').trim();
  return ph;
}`;

const server  = await startServer();
const browser = await launchBrowser();
const errors  = [];

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  // The Field Photos tab's three tables, answered from PHOTO_FIXTURE (see
  // SEED_PHOTOS); every other request to the project falls through to the
  // policy and is aborted as before.
  await page.route('**://*.supabase.co/rest/v1/**', route => {
    const table = new URL(route.request().url()).pathname.replace(/^.*\/rest\/v1\//, '');
    const rows = PHOTO_FIXTURE[table];
    if (route.request().method() !== 'GET' || !rows) return route.fallback();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
  });
  // The Base Stations tab's calls, answered from BS_FIXTURE (see SEED_BS).
  await page.route('**://*.supabase.co/rest/v1/rpc/*base_station*', route => {
    const fn = new URL(route.request().url()).pathname.split('/').pop();
    const answer = BS_FIXTURE[fn];
    if (!answer) return route.fallback();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answer()) });
  });
  page.on('pageerror', e => errors.push(e.message));

  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });

  for (const tab of CONVERTED) {
    console.log(`\n${tab.label} — converted by ${tab.issue}\n`);

    const found = await page.evaluate(async ([id, nameSrc, seedSrc]) => {
      const accName = eval('(' + nameSrc + ')');
      switchTab(id);
      // Awaited since #138: two of the four seeds have to load ~2 MB of ACMA
      // JSON before the tab draws anything but "Loading…", and a seed that is
      // called and not waited for is a seed that checks the loading state.
      if (seedSrc) await eval('(' + seedSrc + ')')();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const main = document.getElementById('main-content');
      const visible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      // <main>, and the side panel's pane on screen — see "Scope" above.
      const roots = [main, ...[...document.querySelectorAll('#help-panel .dock-pane')]
        .filter(p => !p.hidden && visible(p))];
      const all = sel => roots.flatMap(r => [...r.querySelectorAll(sel)]);

      // A <col> carries a width and nothing else, and a declaration block that
      // is *only* custom properties is a token override rather than a decision
      // — the two exemptions #109's own proving-ground check makes, made here
      // for the same reasons. The second is what a hundred basin polygons and
      // eight chip dots rely on: `--basin: var(--maps-region-seqld)` on the
      // element is the token reaching it, whereas `fill: #9b5de5` was the
      // element deciding, which is the thing being replaced.
      const tokenOnly = s => s.split(';').map(d => d.trim()).filter(Boolean)
        .every(d => /^--[\w-]+\s*:/.test(d));
      // Leaflet positions every pane, tile and marker with inline styles
      // inside the container it owns; that is the library's decision, not the
      // tab's, so its subtree is outside the rule (design-system.md §6 — first
      // needed by the Map Generator, whose view-picker map is always up).
      const inline = all('[style]')
        .filter(el => el.tagName !== 'COL')
        .filter(el => !el.closest('.leaflet-container'))
        .filter(el => !tokenOnly(el.getAttribute('style') || ''))
        .map(el => el.tagName.toLowerCase() + '[style="' + el.getAttribute('style') + '"]');

      const tables = all('table');
      const unwrapped = tables.filter(t => !t.closest('.table-wrap'));
      const uncaptioned = tables.filter(t => !(t.caption?.textContent || '').trim());
      const unscoped = tables.filter(t =>
        [...t.querySelectorAll('thead th')].some(h => h.getAttribute('scope') !== 'col'));

      // Pattern 7a applies to the wrappers that can scroll — the ones that cap
      // their own height. A plain wrapper around a short table is not a region
      // and must not become a tab stop for nothing.
      const capped = all('.table-wrap.tall, .table-wrap.medium');
      const unregioned = capped.filter(w =>
        w.getAttribute('role') !== 'region'
        || w.getAttribute('tabindex') !== '0'
        || !accName(w));

      // Pattern 7b.
      const clickRows = all('tr[onclick]');
      const deadRows = clickRows.filter(tr =>
        !tr.querySelector('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'));

      const asides = all('aside').filter(a => !accName(a));

      const controls = all(
        'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])')
        .filter(visible);
      const unnamed = controls.filter(el => !accName(el))
        .map(el => el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(/\s+/)[0] : ''));

      // The shell's own h1, then the tab's headings — the outline a screen
      // reader gets for *this tab*, which is the thing being asserted. The nav's
      // group headings are deliberately not in it: they belong to the nav, they
      // are the same five on every tab, and counting them handed every tab in
      // the app an h2 it had not written (#141).
      const levels = [
        ...[...document.querySelectorAll('header h1')].filter(visible).map(() => 1),
        ...all('h1, h2, h3, h4, h5, h6').filter(visible)
          .map(h => Number(h.tagName[1])),
      ];
      const skips = [];
      for (let i = 1; i < levels.length; i++) {
        if (levels[i] > levels[i - 1] + 1) skips.push(`h${levels[i - 1]} → h${levels[i]}`);
      }

      return {
        inline, unwrapped: unwrapped.length, uncaptioned: uncaptioned.length,
        unscoped: unscoped.length, tables: tables.length,
        capped: capped.length, unregioned: unregioned.length,
        clickRows: clickRows.length, deadRows: deadRows.length,
        asides: asides.length, controls: controls.length, unnamed,
        skips, levels: levels.join(' '),
      };
    }, [tab.id, NAME_FN, tab.seed || null]);

    check(`${tab.label}: no inline style but a token override`,
      found.inline.length === 0, found.inline.slice(0, 3).join(' · '));
    check(`${tab.label}: every table wrapped, captioned and scoped (${found.tables})`,
      found.unwrapped + found.uncaptioned + found.unscoped === 0,
      `unwrapped:${found.unwrapped} uncaptioned:${found.uncaptioned} unscoped:${found.unscoped}`);
    check(`${tab.label}: every capped .table-wrap is a named region (${found.capped})`,
      found.unregioned === 0, `${found.unregioned} without role/tabindex/name`);
    check(`${tab.label}: every clickable row holds a focusable control (${found.clickRows})`,
      found.deadRows === 0, `${found.deadRows} reachable by mouse only`);
    check(`${tab.label}: every <aside> in main is labelled`,
      found.asides === 0, `${found.asides} unnamed complementary landmark(s)`);
    check(`${tab.label}: every visible control has a name (${found.controls})`,
      found.unnamed.length === 0, [...new Set(found.unnamed)].slice(0, 5).join(', '));
    check(`${tab.label}: headings step by one`,
      found.skips.length === 0, `${found.skips.join(', ')} (${found.levels})`);
  }

  // ── No sideways scroll, per tab, per width, per theme ──────────────────────
  console.log('\nNo sideways scroll — each converted tab, three widths, both themes\n');

  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    // The rails cross `xs` between 375 and 768 and take .16s to do it; measured
    // inside that the nav is whatever fraction of 236 px it had reached. The
    // app waits exactly this long before re-measuring its own maps.
    await page.waitForTimeout(250);
    for (const tab of CONVERTED) {
      for (const theme of ['light', 'dark']) {
        // Seeded here too, since #138. Without it this loop measured whatever
        // the tab shows on arrival, which for the two RF tabs is a one-line
        // "Loading…" panel that could not overflow anything — and the widest
        // thing on either of them, the 89-checkbox repeater picker, only exists
        // once something has opened it. Re-running a seed is cheap: the JSON is
        // already parsed and cached by the pass above.
        const over = await page.evaluate(async ([id, t, seedSrc]) => {
          document.documentElement.setAttribute('data-theme', t);
          switchTab(id);
          if (seedSrc) await eval('(' + seedSrc + ')')();
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          const d = document.documentElement;
          return { scroll: d.scrollWidth, client: d.clientWidth };
        }, [tab.id, theme, tab.seed || null]);
        check(`${tab.label} at ${width}px, ${theme}`,
          over.scroll <= over.client + 1, `${over.scroll}px of content in ${over.client}px`);
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));

  // ── Pattern 8: a graphic that is a shortcut for the controls beside it ─────
  console.log('\nPattern 8 — the basin drawing is a shortcut, and the chips are the path\n');

  const shortcut = await page.evaluate(async () => {
    switchTab('maps');
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const svg = document.querySelector('.maps-basin-svg');
    if (!svg) return { present: false };
    const polys = [...svg.querySelectorAll('polygon')];
    const drawn = [...new Set(polys.map(p => p.dataset.region).filter(Boolean))];
    const chips = [...document.querySelectorAll('#maps-region-chips .maps-chip')]
      .map(b => b.dataset.region);
    return {
      present: true,
      named: (svg.getAttribute('aria-label') || '').trim(),
      role: svg.getAttribute('role'),
      // The condition the pattern rests on: nothing the drawing can do is only
      // on the drawing. If a region ever appears on a basin with no chip, the
      // drawing has become the sole route to it and role="img" is a lie.
      orphanRegions: drawn.filter(r => !chips.includes(r)),
      polys: polys.length,
      // …and the other half: no polygon is a tab stop. A hundred of them would
      // be a hundred stops for an operation that is on eight buttons.
      stops: polys.filter(p => p.hasAttribute('tabindex')).length,
      // The name has to carry the headline number, not be a fixed string
      // (pattern part 1). Cheapest honest test: it contains a figure.
      hasFigure: /\d/.test(svg.getAttribute('aria-label') || ''),
      pressed: [...document.querySelectorAll('#maps-region-chips .maps-chip')]
        .filter(b => b.getAttribute('aria-pressed') === 'true').length,
    };
  });

  check('the basin drawing is present', shortcut.present);
  check('and it is one role="img" rather than a hundred unnamed shapes',
    shortcut.role === 'img' && shortcut.stops === 0,
    `role:${shortcut.role} tabbable polygons:${shortcut.stops} of ${shortcut.polys}`);
  check('and its name carries the headline number', !!shortcut.named && shortcut.hasFigure,
    shortcut.named.slice(0, 80));
  check('and every region it draws has a button of its own',
    (shortcut.orphanRegions || []).length === 0, (shortcut.orphanRegions || []).join(', '));
  check('and exactly one region chip reads as pressed', shortcut.pressed === 1,
    String(shortcut.pressed));

  // ── The map catalogue: the right pane is the list until a map is opened ────
  // Every catalogued map gets a row and a thumbnail that loads, and the left
  // pane's filters are what the right pane lists — the claim the catalogue
  // makes. A map added without rerunning tools/build_map_thumbs.py fails here.
  console.log('\nThe map catalogue — every map listed with its thumbnail, filtered by the left pane\n');

  const catalogue = await page.evaluate(async () => {
    switchTab('maps');
    Maps.clearFilters();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const M = window.MegaNetMaps;
    const files = Object.keys(M.FILE_PATH);
    const shown = el => !!el && el.getClientRects().length > 0;
    const rows = [...document.querySelectorAll('#maps-cat-list .maps-cat-open')].map(b => b.dataset.file);
    const noMeta = files.filter(f => !(M.FILE_META[f] || {}).thumb);
    const broken = [];
    for (const f of files) {
      const t = (M.FILE_META[f] || {}).thumb;
      if (!t) continue;
      const ok = await new Promise(res => {
        const img = new Image();
        img.onload = () => res(img.naturalWidth > 0);
        img.onerror = () => res(false);
        img.src = './' + t.split('/').map(encodeURIComponent).join('/');
      });
      if (!ok) broken.push(t);
    }
    const listShown = shown(document.getElementById('maps-catalogue'))
      && !shown(document.getElementById('maps-viewer'));
    Maps.setRegion('Far North');
    const farNorth = [...document.querySelectorAll('#maps-cat-list .maps-cat-open')].map(b => b.dataset.file);
    const farNorthWant = Object.values(M.MAP_CATALOG['Far North']).flat();
    Maps.openFile(farNorth[0], false);
    const viewing = shown(document.getElementById('maps-viewer')) && !shown(document.getElementById('maps-catalogue'));
    Maps.setRegion('SE QLD');          // a filter change goes back to the list
    const backOnFilter = shown(document.getElementById('maps-catalogue'));
    Maps.clearFilters();
    return { files: files.length, rows, noMeta, broken, listShown, farNorth, farNorthWant, viewing, backOnFilter };
  });

  check('the right pane opens on the catalogue, not a blank viewer', catalogue.listShown);
  check(`and lists every catalogued map (${catalogue.files})`,
    catalogue.rows.length === catalogue.files, `${catalogue.rows.length} rows`);
  check('and every map has a thumbnail in FILE_META', catalogue.noMeta.length === 0,
    catalogue.noMeta.slice(0, 3).join(', ') + ' — run tools/build_map_thumbs.py');
  check('and every thumbnail loads', catalogue.broken.length === 0, catalogue.broken.slice(0, 3).join(', '));
  check('a region chip filters the catalogue to that region',
    catalogue.farNorth.length === catalogue.farNorthWant.length
      && catalogue.farNorth.every(f => catalogue.farNorthWant.includes(f)),
    catalogue.farNorth.join(', '));
  check('opening a map swaps the list for the viewer', catalogue.viewing);
  check('and changing a filter while one is open goes back to the list', catalogue.backOnFilter);

  // ── A chart's palette belongs to the document, not to a script ─────────────
  // The second pattern-level check, added by #141 for the same reason #137
  // added the first: the claim is about a pattern rather than about a tab, and
  // without this nothing holds it.
  //
  // For most of this app's life the ARRO chart drew twelve hex literals typed
  // into arro-data.js. They could not follow the theme, so the top of
  // styles.css carried a warning that a palette change did not reach this
  // chart, and #113 listed it as a thing #141 would have to do by hand. It is
  // --ad-series-1…12 now, resolved off the document at draw time — which means
  // the *next* palette change is only free if this stays true. Three claims:
  // the twelve tokens exist in both themes and differ, the series take the
  // values the tokens resolve to, and the SVG still carries literals so the PNG
  // export has something to render.
  console.log('\nThe chart palette — the document\'s, in both themes, and still literal in the SVG\n');

  const palette = await page.evaluate(async () => {
    document.documentElement.setAttribute('data-theme', 'light');
    switchTab('arrodata');
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (!ArroData.ad.series.length) return { seeded: false };

    const tok = n => getComputedStyle(document.documentElement)
      .getPropertyValue(`--ad-series-${n}`).trim();
    const colours = () => ArroData.ad.series.map(s => s.color);
    const svgSrc  = () => document.getElementById('ad-svg').innerHTML;

    ArroData.repaint();
    const light = colours(), lightTok = [1, 2].map(tok), lightSvg = svgSrc();

    document.documentElement.setAttribute('data-theme', 'dark');
    ArroData.repaint();
    const dark = colours(), darkTok = [1, 2].map(tok), darkSvg = svgSrc();

    // …and a colour the operator chose is not the theme's to take back.
    ArroData.setColor(ArroData.ad.series[0].key, '#ff00ff');
    document.documentElement.setAttribute('data-theme', 'light');
    ArroData.repaint();
    const held = ArroData.ad.series[0].color;

    document.documentElement.setAttribute('data-theme', 'light');
    return {
      seeded: true, light, dark, lightTok, darkTok, held,
      tracksToken: light.slice(0, 2).join() === lightTok.join()
                && dark.slice(0, 2).join() === darkTok.join(),
      literal: /stroke="#[0-9a-f]{3,8}"/i.test(lightSvg) && /stroke="#[0-9a-f]{3,8}"/i.test(darkSvg),
      noVar: !/var\(--/.test(lightSvg) && !/var\(--/.test(darkSvg),
      dashed: /stroke-dasharray/.test(lightSvg),
    };
  });

  check('the seeded chart has series to colour', palette.seeded !== false);
  check('the twelve tokens have a dark set, and it is a different one',
    palette.light && palette.light.join() !== palette.dark.join(),
    `${(palette.light || []).slice(0, 2).join(' ')} → ${(palette.dark || []).slice(0, 2).join(' ')}`);
  check('each series is the colour its token resolves to, in both themes',
    !!palette.tracksToken, `${(palette.lightTok || []).join(' ')} / ${(palette.darkTok || []).join(' ')}`);
  check('and the SVG still carries literals rather than var(), so a PNG can render it',
    !!palette.literal && !!palette.noVar);
  check('a colour chosen by hand survives a theme change', palette.held === '#ff00ff',
    String(palette.held));
  check('two series are told apart by more than hue', !!palette.dashed,
    'stroke-dasharray on the second series');

  if (errors.length) check('no uncaught page errors', false, errors.join(' | '));
} finally {
  await browser.close();
  await server.close();
}

const failed = results.filter(r => !r.pass);
console.log('');
console.log(`  ${results.length} assertion(s) across ${CONVERTED.length} converted tab(s).`);
console.log('');
if (failed.length) {
  console.log(`FAIL — ${failed.length} of ${results.length}:\n`);
  for (const f of failed) console.log(`  ${f.name}`);
  console.log('\n  This is EPIC #107\'s per-tab Definition of Done, checked. The patterns');
  console.log('  are in docs/design-system.md — sections 3 (tables, patterns 1-8) and 4');
  console.log('  (landmarks, names, headings). If you need something that is not there,');
  console.log('  add it there and write down why; a decision made inside one tab is a');
  console.log('  decision the next five cannot find.\n');
  process.exit(1);
}
console.log('PASS — every converted tab uses the system, names what it draws, and stays');
console.log('       inside the screen at 375, 768 and 1440 in both themes.');
