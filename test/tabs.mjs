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
// are both exercised; toggleRow opens the drawer the way a click would.
const SEED_MSGLOG = `() => {
  MessageLog.adoptRows([
    { addr: 'a:6128', alert_id: 6128, station_number: null, channel: '',
      station_id: null, reading_ts: '2026-03-01T04:15:00+00:00',
      received_at: '2026-03-01T04:15:32+00:00', value_raw: 12, value: 2.4,
      unit: 'mm', conversion: 'raw x 0.2 mm per tip', quality: 0, protocol: 1,
      source: 2, path: 'MOUNT_TABLETOP', dup_count: 2,
      dup_paths: ['DURIKAI', 'direct'], last_dup_at: '2026-03-01T04:15:40+00:00',
      raw_id: 41 },
    { addr: 's:541155/level', alert_id: null, station_number: '541155',
      channel: 'level', station_id: null, reading_ts: '2026-03-01T04:10:00+00:00',
      received_at: '2026-03-01T04:10:05+00:00', value_raw: 1.842, value: null,
      unit: 'm', conversion: null, quality: 1, protocol: 0, source: 1,
      path: null, dup_count: 0, dup_paths: [], last_dup_at: null, raw_id: null },
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
  // rather than its no-address note.
  const withId = state.data.stations.find(s =>
    s.lat != null && (s.sensors || []).some(x => Number.isInteger(x.alert_id)));
  if (withId) selectStation(withId.id);
  addToMapSelection(state.data.stations.slice(0, 3).map(s => s.id));
  rerenderStations();
  // The filter card itself since #165 — the filters are a collapsible under the
  // map now, and a shut <details> takes every control in it out of this check.
  for (const d of document.querySelectorAll(
    '#stations-filter-card details, #station-filters details, #acma-filter-block details')) d.open = true;
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
  { id: 'alert2',     label: 'ALERT2 Decoder — readings and map',  issue: '#140', seed: SEED_ALERT2 },
  { id: 'alert2',     label: 'ALERT2 Decoder — frame anatomy',     issue: '#140', seed: SEED_ALERT2_FRAMES },
  { id: 'network',    label: 'Ghosting Graph',  issue: '#140', seed: SEED_NETWORK },
  { id: 'stations',   label: 'Stations — empty of everything the harness cannot reach', issue: '#136' },
  { id: 'stations',   label: 'Stations — ACMA on, a station selected, a map selection', issue: '#136', seed: SEED_STATIONS },
  { id: 'stations',   label: 'Stations — a drawn path, its profile and its link budget', issue: '#136', seed: SEED_STATIONS_PATH },
  { id: 'hfem',       label: 'HFEM Messages — empty, with the builder and the reference', issue: 'born converted at #154' },
  { id: 'hfem',       label: 'HFEM Messages — the spec\'s ten examples decoded', issue: 'born converted at #154', seed: SEED_HFEM },
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
      const inline = [...main.querySelectorAll('[style]')]
        .filter(el => el.tagName !== 'COL')
        .filter(el => !el.closest('.leaflet-container'))
        .filter(el => !tokenOnly(el.getAttribute('style') || ''))
        .map(el => el.tagName.toLowerCase() + '[style="' + el.getAttribute('style') + '"]');

      const tables = [...main.querySelectorAll('table')];
      const unwrapped = tables.filter(t => !t.closest('.table-wrap'));
      const uncaptioned = tables.filter(t => !(t.caption?.textContent || '').trim());
      const unscoped = tables.filter(t =>
        [...t.querySelectorAll('thead th')].some(h => h.getAttribute('scope') !== 'col'));

      // Pattern 7a applies to the wrappers that can scroll — the ones that cap
      // their own height. A plain wrapper around a short table is not a region
      // and must not become a tab stop for nothing.
      const capped = [...main.querySelectorAll('.table-wrap.tall, .table-wrap.medium')];
      const unregioned = capped.filter(w =>
        w.getAttribute('role') !== 'region'
        || w.getAttribute('tabindex') !== '0'
        || !accName(w));

      // Pattern 7b.
      const clickRows = [...main.querySelectorAll('tr[onclick]')];
      const deadRows = clickRows.filter(tr =>
        !tr.querySelector('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'));

      const asides = [...main.querySelectorAll('aside')].filter(a => !accName(a));

      const controls = [...main.querySelectorAll(
        'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])')]
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
        ...[...main.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter(visible)
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
