// MegaNet — core.js
//
// The bottom of the app.js lineage (#129 M1 / #132). Everything the feature
// modules reach *backwards* for, gathered into one file so that nothing else
// has to. Load order is the contract and it is set in index.html:
//
//   leaflet → maps-data.js → core.js → …modules… → init.js
//
// Nothing above this file may be assumed; nothing below it may be depended on
// at load time. Concretely, that means core.js never calls into a tab module —
// if you find yourself wanting to, the thing you want probably belongs here.
//
//   TABS, TAB_LIST      the left-hand nav, and the only description of it
//   HELP                per-tab help panel copy
//   APP_VERSION         read from this file's own ?v= — so keep the stamp on it
//   GITHUB_REPO, GITHUB_* , ARRO_*, AUTH_URL, DB_*   endpoints and identifiers
//   recordError, _errorLog                           uncaught-error ring buffer
//   SPLIT_MIN / SPLIT_MAX, state                     every mutable thing there is
//   esc, escAttr, csvEscape, netName, pFloat, pInt, parseRangeLines, slug, dlText
//   KM_PER_DEG_LAT, kmPerDegLon, bearingDeg, destPoint, fmtKm, acmaHaversineKm
//   ACMA_MECH           interference-mechanism labels and colours
//   stationSensors, buildSensorIndex, buildArroUrl   ALERT address ↔ sensor lookup
//   registerTabTeardown, runTabTeardowns, registerLiveMap, liveMaps, removeMap
//                       the module registries (#142) and the one correct way to
//                       take a Leaflet map down (#143)
//
// The last three groups are the six helpers #129 found misfiled — each defined
// inside one feature and read by five to seven others. They live here now
// precisely so that the tab modules can be moved out in any order (#133–#135)
// without one of them having to load before another.
//
// This file is also the only sensible home for the Leaflet canvas guard at the
// bottom, which has to be installed before the first L.map() call.

// ── Constants ─────────────────────────────────────────────────────────────────

// The left-hand nav, and the only description of it. Grouped so the sidebar can
// say what a flat row of eleven buttons never did — that RF Environment, RF
// Changes, the Workbench and Bit Flipper are one investigation approached four
// ways. Each tab carries an icon because the nav collapses to an icon rail, and
// a rail with nothing but tooltips is a guessing game.
//
// The packet tools sit in the same group rather than under a "Live tools"
// heading of their own: reading what a station actually transmitted is part of
// the same investigation as looking at who could be stepping on it, and the
// split only ever forced a second scan of the sidebar to find the decoder.
const TABS = [
  { group: 'Network', tabs: [
    { id: 'stations',   label: 'Stations',               icon: '📡' },
    { id: 'maps',       label: 'Network Maps',           icon: '🗺️' },
    { id: 'networks',   label: 'Networks',               icon: '🕸️' },
    { id: 'passranges', label: 'Pass Ranges',            icon: '🔗' },
  ] },
  { group: 'Radio investigation', tabs: [
    { id: 'rf',         label: 'RF Environment',         icon: '📶' },
    { id: 'rfchanges',  label: 'RF Changes',             icon: '📈' },
    { id: 'workbench',  label: 'Interference Workbench', icon: '🔬' },
    { id: 'bitflipper', label: 'Bit Flipper',            icon: '🔀' },
    { id: 'network',    label: 'Network View',           icon: '🧬' },
    { id: 'packets',    label: 'ALERT Packets',          icon: '📦' },
    { id: 'alert2',     label: 'ALERT2 / ERT-A2',        icon: '🛰️' },
    { id: 'serial',     label: 'Serial Monitor',         icon: '🔌' },
  ] },
  { group: 'Data & admin', tabs: [
    { id: 'arro',       label: 'ARRO Launcher',          icon: '🚀' },
    { id: 'arrodata',   label: 'ARRO Data',              icon: '📊' },
    { id: 'field',      label: 'Field Data',             icon: '🌡️' },
    { id: 'inspections', label: 'Inspections',           icon: '🩺' },
    { id: 'maintenance', label: 'Site Maintenance',      icon: '🧰' },
    { id: 'export',     label: 'Export',                 icon: '📤' },
  ] },
];

// Flattened, for the lookups that only care which tab is open (the bug
// reporter) and don't want to know how the nav happens to be grouped.
const TAB_LIST = TABS.flatMap(g => g.tabs);

// What the help panel says, keyed by the same tab ids TABS uses. Kept beside
// TABS rather than folded into it: TABS is the nav's description and reads as
// one screen of icons and labels, which prose would bury.
//
// Every field is optional but `summary`, and the renderer omits the heading for
// anything absent — so this can be filled in a tab at a time.
//
//   summary  a sentence or two: what this tab is for
//   watch    the things found out the hard way otherwise
//   related  other tab ids, for the "one investigation, four ways" groupings
//   links    { label, href } out to docs/ — href through docUrl()
//
// `summary` and `watch` are authored HTML, not user input: they are written
// here and nowhere else, so they may carry <code>, <strong> and links, and the
// renderer deliberately does not escape them. Anything read from stations.json
// or typed by a user must not be interpolated into them.
//
// Issue #105 owns finishing this — the "watch out for" lines beyond the three
// the README already names as traps, the visual walkthroughs, and the decision
// about which existing embedded help moves in here versus stays where it is.
const HELP = {
  stations: {
    summary: 'The station list and the map, side by side. The <strong>Filters</strong> pane on the '
           + 'left drives both at once, and is built from whatever <code>stations.json</code> holds '
           + '— every option carries the number of stations behind it, and nothing is offered that '
           + 'no station uses. Draw, measure and terrain tools sit under the map. Selecting a '
           + 'station opens <strong>Repeaters listening</strong> between the list and the editor: '
           + 'every repeater with a pass range open to that station\'s addresses, nearest first. '
           + 'Clicking one puts the map on it and dims everything off its paths — the filters, the '
           + 'picked selection and the station being edited all stay where they are.',
    watch: [
      '<strong>Kill spaghetti</strong> caps how long a signal link may be before it stops being '
      + 'drawn — it culls the <em>drawing</em>, never the data. A hop you expected to see and '
      + 'cannot may simply be past the <em>Max TX distance</em> slider; the sidebar says how many '
      + 'links were drawn and how many were culled, so check that before concluding the path '
      + 'isn\'t there.',
      '<strong>Include related repeaters</strong> widens the match itself rather than the drawing: '
      + 'repeaters whose pass ranges cover a matched station are pulled in even though they don\'t '
      + 'match the filter text. That is why the station count can exceed the number of rows your '
      + 'search would explain.',
    ],
    related: ['passranges', 'maps'],
  },

  maps: {
    summary: 'Browses the bundled Radio-path PDF maps by region, and suggests the relevant map for '
           + 'a given station. The Queensland basin drawing is clickable — pick a basin, or a '
           + 'region chip, to filter the list down to it.',
    related: ['stations'],
  },

  networks: {
    summary: 'The named radio-network clusters in the loaded file — usually named after their '
           + 'primary repeater or ingest point — with the repeater and field-station counts behind '
           + 'each one. Ticking networks here is what scopes the Export tab.',
    related: ['export'],
  },

  passranges: {
    summary: 'Which repeaters have a pass range covering a station\'s AlertIDs, and the hop chain '
           + 'that follows: field → repeater(s) → base. Stations no repeater covers are flagged as '
           + 'orphans, and AlertIDs that fall between every window are flagged as gaps.',
    related: ['stations', 'bitflipper'],
  },

  rf: {
    summary: 'Licensed transmitters near each repeater that could be stepping on it, read out of '
           + 'the ACMA register. Pick a repeater and the candidates are ranked against it.',
    related: ['rfchanges', 'workbench'],
  },

  rfchanges: {
    summary: 'What changed on the air, and when, from the same ACMA register. Use it to line a '
           + 'station going bad up against something new appearing near it.',
    watch: [
      'Register dates are <strong>administrative</strong>. An authorisation date is an upper bound '
      + 'on when a transmitter could have come on air, not the day it did — licences are often '
      + 'authorised well before anything is switched on.',
    ],
    related: ['rf', 'workbench'],
  },

  workbench: {
    summary: 'Works one interference case end to end. Name the affected stations and the analysis, '
           + 'the candidate transmitters and a suggested next check are assembled around them.',
    related: ['rf', 'rfchanges'],
  },

  bitflipper: {
    summary: 'What else could this ALERT address have been? Flips one bit up to N bits of a decimal '
           + 'address and cross-references every variant against the station file, live as you type.',
    watch: [
      'Flipping more bits is combinatorial — <code>C(16, N)</code> variants. Past two or three bits '
      + 'the useful view is <em>show only matched addresses</em>; the render cap is there to stop '
      + 'the table, not to tell you the search finished.',
    ],
    related: ['network', 'packets', 'passranges'],
  },

  network: {
    summary: 'The Bit Flipper\'s question asked of the whole file at once: ALERT addresses are '
           + 'nodes, a ghosting relationship between two of them is an edge, and the answer is '
           + 'drawn as a force layout with a geographical map beside it.',
    related: ['bitflipper', 'stations'],
  },

  packets: {
    summary: 'Decodes and encodes ALERT / ERTS messages against the Bureau\'s <em>ERTS Data '
           + 'Formats</em> specification. Paste a 40-bit framed message, a 32-bit payload or eight '
           + 'hex digits and it is tried against every known format, with check bits and CRC '
           + 'validated and framing polarity detected.',
    related: ['bitflipper', 'alert2', 'serial'],
  },

  alert2: {
    summary: 'Decodes what an ELPRO ERT-A2 puts on its serial ports. The unit emits two different '
           + 'things on two different ports and they do not carry the same information, so the tab '
           + 'sniffs which of the two it has been handed rather than asking.',
    watch: [
      'Rainfall in millimetres is <code>raw × mm per tip</code>. A station\'s recorded '
      + '<code>TBRGbucketSize</code> wins where there is one, and the per-capture <em>mm per '
      + 'tip</em> box (0.2 by default) is the fallback everywhere else — which today is '
      + 'everywhere, since no station carries a recorded bucket size yet. The rule beside each '
      + 'converted value says which of the two it used; a millimetre figure headed for a report '
      + 'should be read with that.',
    ],
    related: ['serial', 'packets'],
  },

  serial: {
    summary: 'Streams live output from serial devices over the browser\'s Web Serial API — as many '
           + 'ports at once as the machine has, each an independent card with its own settings.',
    watch: [
      'Web Serial is a Chromium-only API, and it is refused outright on a page that is not '
      + 'HTTPS or localhost. A managed browser can also have it switched off by policy, in which '
      + 'case nothing on this tab will work until IT changes that — the linked page is written to '
      + 'be forwarded to them.',
    ],
    links: [{ label: 'Serial Monitor — what to ask IT for', href: 'docs/serial-help.html' }],
    related: ['alert2', 'packets'],
  },

  arro: {
    summary: 'Opens a station\'s page in ARRO (Contrail), where its telemetry actually lives. '
           + 'Search by name or number, or paste a raw id if you already have one.',
    watch: [
      'The two ids are not the same number. ARRO only accepts <code>site.db_id</code>, an arbitrary '
      + 'database index; <code>site.number</code> is the BoM station number. Handing ARRO the '
      + 'station number is the most common mistake here, and it fails by opening somebody else\'s '
      + 'station rather than by erroring.',
    ],
    related: ['arrodata', 'stations'],
  },

  arrodata: {
    summary: 'Reads ARRO\'s per-sensor CSV exports in the browser, links each one back to its '
           + 'station, runs the Bureau\'s 3-5-7 continuity filter over it and plots the result with '
           + 'a chart built for finding noise rather than presenting a trend. Nothing is uploaded — '
           + 'files are read in the tab and stay there.',
    watch: [
      'This tab is <strong>ARRO\'s</strong> numbers. Readings our own field stations sent us live '
      + 'next door on <strong>Field Data</strong>, and the two are never combined — different '
      + 'source of truth, different retention, different trust.',
    ],
    related: ['arro', 'field', 'stations'],
  },

  field: {
    summary: 'Plots readings that field stations sent us, out of the MegaNet datastore, using the '
           + 'same chart and the same 3-5-7 filter as the ARRO Data tab. Pick a station, its '
           + 'sensors and a window; the readings are fetched and drawn.',
    watch: [
      '<strong>This is not ARRO data and is never mixed with it.</strong> The chart says which '
      + 'datastore it came from and at what resolution, and every export carries both in its '
      + 'filename and in a column on every row.',
      'Wide windows are drawn from hourly or daily rollups rather than raw readings, and the '
      + 'header says which. Each rollup point is the counter <em>at the end of</em> its bucket, so '
      + 'an accumulator still accumulates — but the spread inside the bucket is hidden, and it is '
      + 'in the inspector and the export when you need it. Force <strong>Raw</strong> to see every '
      + 'reading.',
      'A silence longer than the station\'s own reporting interval is drawn as a gap, not ruled '
      + 'across. Missing data is the normal condition of a radio network.',
      'Readings arrive as <strong>counts</strong>, so the 3/5/7 thresholds are counts too. Any '
      + 'conversion the datastore recorded is shown beside the count, never instead of it.',
      'A window with nothing in it says so rather than drawing an empty axis — silence and a run '
      + 'of zeroes are different claims.',
    ],
    related: ['arrodata', 'stations', 'alert2'],
  },

  inspections: {
    summary: 'The six paper station-inspection sheets, digitised — pick a station, pick which of the '
           + 'six forms its configuration prints, and fill it in. There is <strong>one</strong> form '
           + 'rather than six: which sections a configuration prints comes from '
           + '<code>meganet.inspection_form</code> in the database, so "this site has no gas bubbler" '
           + 'is a fact the schema holds rather than a section somebody left blank. Drafts save to '
           + 'this device, which is the point — the form is meant to be filled in on a tablet at a '
           + 'site with no signal.',
    watch: [
      'A section a form does not print is listed under <strong>Not on this form</strong> at the '
      + 'bottom rather than hidden. That is deliberate: a missing row in a section table means '
      + '<em>nobody recorded it</em>, a section missing from the form means <em>this site has no '
      + 'such thing</em>, and the database refuses the first dressed up as the second.',
      'Past visits are <strong>editors-only</strong> — an inspection\'s remarks carry site access '
      + 'notes, and the key this app ships with is published. The form itself, and every pick-list '
      + 'on it, renders signed out; the recent-visits list and Save do not.',
      'A <strong>draft is only on this device</strong>. It is never uploaded on its own, and it is '
      + 'cleared once the visit it holds saves — so a draft that is still in the list is a visit '
      + 'that has not reached the database.',
      'The <strong>6% rule</strong> printed on four of the sheets is computed here rather than left '
      + 'to whoever reads the numbers later, and the threshold is stored per visit — changing it '
      + 'never rewrites what a past visit was judged against.',
      '<strong>Photos</strong> attach to a visit once it has been saved. The tick beside "Photos" in '
      + 'the admin block records the <em>claim</em> that photos were taken; the panel under it holds '
      + 'the photos themselves. They go into a private bucket and are shown through a link that '
      + 'expires, so a site photograph never becomes a public URL.',
    ],
    related: ['stations', 'maintenance', 'export'],
  },

  maintenance: {
    summary: 'The <code>Council Maintenance Tasks</code> sheet, digitised. A different form from the '
           + 'six on the Inspections tab and a different question: not "is the calibration still '
           + 'good" but <strong>who owns this, what condition is it in, and who do we ring about '
           + 'it</strong>. Every pick-list on it is the same row in the same table the inspection '
           + 'form reads — one source of truth, not a parallel list — and the 22 councils come from '
           + '<code>meganet.council</code>.',
    watch: [
      'Every inspection sheet prints "sites on departure that are poor or have issues please '
      + 'complete Flood Warning Council Maintenance Project form". <strong>Visits waiting for one '
      + 'of these</strong> is that sentence as a list — the visits it was printed for and nobody '
      + 'followed. Starting a form from one carries the link back to the inspection with it.',
      'This family is <strong>editors-only, and more so than the inspections one</strong>: it '
      + 'carries named contacts\' phone numbers and the "Assess and WHS" site-access notes. The '
      + 'blank form and its pick-lists render signed out; the two lists and Save do not.',
      'The <strong>Comms and Power panel prints a Condition and an Owner under each of its three '
      + 'sub-columns</strong> and the schema carries one pair for the panel. The form says so on '
      + 'the panel rather than losing it quietly — issue #148.',
      'The <strong>canister-configuration screenshot and the benchmark photo can be attached</strong> '
      + 'once the form has been saved — the file hangs off the record by foreign key, so there has '
      + 'to be a saved row for it to belong to. Files go into a <strong>private</strong> bucket and '
      + 'are only ever shown through a link that expires; nothing attached here is on the open web.',
    ],
    related: ['inspections', 'stations'],
  },

  export: {
    summary: 'Builds the full set of CSV files Radio Mobile needs, scoped to the networks ticked in '
           + 'the sidebar. The station file itself can also be exported here as the escape hatch '
           + 'from the database.',
    related: ['networks'],
  },
};

// Matches the width transition in styles.css. Measuring a map mid-slide is
// worse than not measuring it at all, so the invalidate that follows a collapse
// waits the transition out rather than racing it.
const NAV_TRANSITION_MS = 160;

// Below this the nav starts collapsed, on first visit only. The Stations tab
// already gives a permanent column to its resizable filter pane, and on a
// laptop a second permanent column is one too many.
const NAV_AUTO_COLLAPSE_PX = 900;

// The help panel's own width transition, and it plays exactly the role
// NAV_TRANSITION_MS does: the maps are re-measured once the slide has finished
// rather than part-way through it. Kept in step with styles.css.
const HELP_TRANSITION_MS = 160;

const ROLE_COLOR = {
  field:    '#107c10',
  repeater: '#0b5cab',
  base:     '#c7401a',
  satcom:   '#7c35a3',
};

const ROLE_LABEL = {
  field:    'Field Station',
  repeater: 'Repeater',
  base:     'Base Station',
  satcom:   'Satcom',
};

// ── ARRO ──────────────────────────────────────────────────────────────────────
// ARRO (Contrail) is where a station's telemetry actually lives, and the only
// key it accepts is `site.db_id` — an arbitrary database index, *not* the BoM
// station number in `site.number`. Every link the app builds is assembled from
// the constants below, in one place, because three hard-coded copies of a host
// drift the moment one of them is edited.
const ARRO_HOST         = 'https://contrail-bom.onerain.au';
const ARRO_PATH_GRAPH   = '/graph/';
const ARRO_PATH_SITE    = '/administration/site/details/';
const ARRO_PATH_SENSOR  = '/administration/sensor/details/';
const ARRO_DEFAULT_BASE = ARRO_HOST + ARRO_PATH_GRAPH;

// The host every ARRO link is hung off. The Bit Flipper's "ARRO base URL" box
// writes a full graph URL into state.bfArroBase; that override is taken to mean
// "this whole app talks to that ARRO", so the admin links follow it too — one
// box, not one per placement. A base that won't parse falls back to the default
// rather than producing a broken link.
function arroHost() {
  const raw = (state.bfArroBase || '').trim();
  if (!raw) return ARRO_HOST;
  try { return new URL(raw).origin; } catch (_) { return ARRO_HOST; }
}

// Admin page for a site. `dbId` is site.db_id; null/undefined means the station
// has no ARRO record and callers must render nothing rather than a dead link.
function arroSiteUrl(dbId) {
  return dbId == null ? null : `${arroHost()}${ARRO_PATH_SITE}?site_id=${encodeURIComponent(dbId)}`;
}

// Admin page for one sensor. ARRO needs both keys — the site and the device
// within it — so a sensor with no device_id has no admin page.
function arroSensorUrl(dbId, deviceId) {
  if (dbId == null || deviceId == null || deviceId === '') return null;
  return `${arroHost()}${ARRO_PATH_SENSOR}?site_id=${encodeURIComponent(dbId)}`
       + `&device_id=${encodeURIComponent(deviceId)}`;
}

// A station's ARRO site id, or null. 2,784 of 3,174 stations carry one.
function arroSiteId(s) {
  const id = s && s.site && s.site.db_id;
  return id == null ? null : id;
}

// mm per tip for a station, and whether it is a recorded fact or our default.
// No station carries TBRGbucketSize today and there is no authoritative source
// to backfill from, so 0.2 mm/tip is a fallback, not a measurement — every
// consumer of the result must say which one it got via `recorded`.
function bucketSizeMm(s) {
  const v = s && s.TBRGbucketSize;
  return (typeof v === 'number' && v > 0)
    ? { mm: v,   recorded: true }
    : { mm: 0.2, recorded: false };
}

// "2,784 of 3,174 stations carry one" — same honesty as arroSiteId's gap, for
// an empty field with no authoritative source to backfill it from.
function bucketSizeGapNote() {
  const all = state.data?.stations || [];
  if (!all.length) return '';
  const missing = all.filter(s => !bucketSizeMm(s).recorded).length;
  return `${missing.toLocaleString()} of ${all.length.toLocaleString()} stations carry no recorded bucket size.`;
}

// Street View / Apple Maps links for a station's coordinates, or null when it
// has none. Google's Maps URLs API drops the viewer on the nearest available
// panorama — on farm tracks and hilltops with no coverage it lands on the map
// instead, which is why the link's title spells that out. Apple publishes no
// URL scheme for opening Look Around at a coordinate, so the Apple link is a
// map pin, not a panorama, and is labelled "Apple Maps" rather than
// "Apple Street View" because it isn't one.
function stationMapLinkUrls(s) {
  if (s == null || s.lat == null || s.lon == null) return null;
  const coord = `${s.lat},${s.lon}`;
  return {
    google: `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${encodeURIComponent(coord)}`,
    apple:  `https://maps.apple.com/?ll=${encodeURIComponent(coord)}&q=${encodeURIComponent(s.name || '')}`,
  };
}

// The two links above, rendered as the anchors used in both the map popup
// and the station editor card — one place a URL shape is written, not two.
function mapLinksHtml(s) {
  const urls = stationMapLinkUrls(s);
  if (!urls) return '';
  return `<a href="${esc(urls.google)}" target="_blank" rel="noopener"
       title="Opens the nearest Google Street View panorama; sites with no coverage open the map at this location instead">Google Street View ↗</a>
    <a href="${esc(urls.apple)}" target="_blank" rel="noopener"
       title="Opens Apple Maps at this location; Look Around is one tap away where Apple has coverage">Apple Maps ↗</a>`;
}

// ── Datastore ─────────────────────────────────────────────────────────────────
// Postgres on Supabase, reached over PostgREST — which is plain HTTP, so this
// costs no library and index.html gains no <script> tag. One constants block for
// the same reason as the ARRO one above: three copies of a host drift the moment
// one of them is edited.
//
// DB_ANON_KEY is public and committed on purpose. It names the project, it does
// not authorise anything — row level security is what decides what an anonymous
// caller may read, and every table is created with RLS on and an explicit policy
// in the same migration that creates it (see db/README.md). The rule that keeps
// that true is worth stating plainly: nothing goes in a table that its policy
// would not hand to a stranger.
const DB_URL      = 'https://jjprlritvhdqpvphfrnu.supabase.co/rest/v1';
const DB_ANON_KEY = 'sb_publishable_PV9VjCM8NQeGAJMuwa5TKA_yX9GWacY';

// Supabase Auth (GoTrue) lives beside the Data API on the same project host.
// Derived rather than written out again so the two cannot end up pointed at
// different projects — the failure that produces is a token that verifies as
// valid and authorises nothing, which is a long afternoon.
const AUTH_URL = DB_URL.replace(/\/rest\/v1\/?$/, '/auth/v1');

// MegaNet's tables live in their own schema rather than in `public`, so every
// request has to name it. Reads carry Accept-Profile; writes, when there are
// any, carry Content-Profile.
const DB_SCHEMA = 'meganet';

// The schema this build of the app is written against, checked on connect
// against meganet.app_meta.schema_version. Bump it in the same commit as the
// migration that raises the database's. A mismatch is reported rather than
// papered over — an app newer than its database is the failure that otherwise
// shows up as columns quietly reading as undefined.
const DB_SCHEMA_VERSION = 11;

// Host without the /rest/v1, for showing the operator where they are pointed.
function dbHostLabel() {
  try { return new URL(DB_URL).host; } catch (_) { return DB_URL; }
}

// Round-trip timing, for the Data source panel and the load path. Defined up
// here with the rest of the datastore's furniture rather than next to dbPing()
// nine thousand lines below, because init() runs autoLoad() while this file is
// still being evaluated — a `const` further down is in its temporal dead zone at
// that point, and the first load of the app would throw before drawing anything.
const _dbClock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ── Station filter vocabulary ─────────────────────────────────────────────────
// The grouped filters on the Stations tab (role, sensor type, radio network,
// region…) are built from whatever the loaded stations.json actually contains.
// That database is only partly populated — at the time of writing 3086 of 3174
// stations carry no radio_network_ids and 2171 carry no catchment — so a group
// needs two reserved option values to stay honest about the gaps:
//
//   FILTER_NONE   the "not recorded yet" bucket. Every station whose field is
//                 empty lands here, and it is ticked like any other option, so
//                 the default (nothing ticked = no constraint) shows the whole
//                 network rather than only the fraction that has been mapped.
//   FILTER_EMPTY  the marker for "the operator un-ticked everything". An empty
//                 Set already means "no constraint", so a group that has been
//                 emptied by hand holds this instead — it matches no station,
//                 which is what un-ticking everything should do.
const FILTER_NONE  = '__none__';
const FILTER_EMPTY = '__empty__';
const FILTER_NONE_LABEL = 'Not recorded yet';

const RM_NET_DEFAULTS = {
  Visible: 1, 'Minimum fx': 151, 'Max Fx': 152,
  Refractivity: 301, Conductivity: 0.005, Permittivity: 15,
  Polarization: 1, Climate: 2, 'Stat. mode': 0,
  '%Time': 50, '%Location': 50, '%Situation': 70,
  Topology: 1, 'Max Rebro': 0, '%Urban or Tree': 0,
};

// ── Diagnostics & error capture ─────────────────────────────────────────────────
// Registered as early as possible so a bug report can carry what actually went
// wrong (recent runtime errors), not just what the user managed to describe.
// MegaNet has no backend, so this is the only record of a failure that exists.

// App build, read from this script's own ?v= cache-buster in index.html so it
// always matches the deployed file without a second constant to keep in sync.
const APP_VERSION = (function () {
  try {
    const m = ((document.currentScript && document.currentScript.src) || '').match(/[?&]v=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : 'dev';
  } catch (_) { return 'dev'; }
})();

const GITHUB_REPO = 'cdomotor-g/MegaNet';   // owner/repo that bug reports open against

// Ring buffer of the most recent uncaught errors, capped so a long session
// can't grow it without bound.
const _errorLog = [];
const ERROR_LOG_MAX = 20;

function recordError(entry) {
  _errorLog.push({ at: new Date().toISOString(), ...entry });
  while (_errorLog.length > ERROR_LOG_MAX) _errorLog.shift();
}

function _errWhere(url, line, col) {
  const file = String(url || '').split('/').pop() || '';
  return file ? `${file}:${line}:${col}` : '';
}

function _errStack(stack, n) {
  return stack ? String(stack).split('\n').slice(0, n).map(l => l.trim()).join('\n') : '';
}

if (typeof window !== 'undefined') {
  window.addEventListener('error', e => {
    recordError({
      kind:    'error',
      message: (e && e.message) || String((e && e.error) || 'unknown error'),
      where:   e && e.filename ? _errWhere(e.filename, e.lineno, e.colno) : '',
      stack:   _errStack(e && e.error && e.error.stack, 4),
    });
  });
  window.addEventListener('unhandledrejection', e => {
    const r = e && e.reason;
    recordError({
      kind:    'unhandledrejection',
      message: (r && r.message) ? r.message : String(r),
      where:   '',
      stack:   _errStack(r && r.stack, 4),
    });
  });
}

// ── State ──────────────────────────────────────────────────────────────────────

// Bounds on the Stations tab's column split. Up here because the opening
// render reads a stored width through setSplitWidth before the map code runs.
const SPLIT_MIN = 240, SPLIT_MAX = 720;

const state = {
  data:       null,   // parsed stations.json
  // Byte sizes recorded at load/fetch time — see MemMeter. Free to keep:
  // JSON.stringify(x).length on the parsed object is not cheap at these
  // sizes, but the raw text is already in hand at the point each file lands,
  // so its length costs nothing extra.
  memBytes: {
    stationsJson: 0,
    files: {},   // 'acma-threats.json' etc. → text.length, set by acmaFetchJson
  },
  activeTab:  'stations',
  filters: {
    search:       '',
    // Grouped filters. An empty Set is the default and means "no constraint":
    // every station passes, including the ones whose field has never been
    // filled in. See FILTER_NONE / FILTER_EMPTY above.
    roles:        new Set(),
    sensors:      new Set(),
    networks:     new Set(),
    regions:      new Set(),
    catchments:   new Set(),
    sensorsAll:   false,   // sensor group: station must carry ALL ticked types, not any
    // Single-value filters. '' = any; FILTER_NONE = only stations missing the field.
    basin:        '',
    lga:          '',
    hasCoords:    '',      // '' | 'yes' | 'no'
    hasAlertId:   '',      // '' | 'yes' | 'no'
    enabledOnly:  false,
    acma: {
      show:        true,                        // on by default; the ~1.4 MB core
                                                // data is fetched the first time
                                                // the map tab opens, not at page load
      mechanisms:  new Set(['co_channel', 'adjacent', 'imd3', 'harmonic', 'cosite_desense']),
      minScore:    20,   // scores carry a ×0.7 unknown-LOS discount, so they cluster low
      losOnly:     false,
      activeOnly:  true,
      hideMeganet: false,
      radiusKm:    60,
      showBeams:   false,
      showLinks:   true,
    },
  },
  // Which filter groups are expanded, and the option lists (with per-option
  // station counts) built from the loaded file — rebuilt on load, not per render.
  filterOpen:     { sensors: false, networks: false, regions: false, area: false, data: false },
  filterOpts:     null,
  searchIdx:      null,    // flat name / number / address corpus, for pasted-list reporting
  repeaterIdx:    null,    // cached repeater-only subset, for pass-range matching
  stationsShowAll: false,  // operator opted past the station-table row cap
  selectedId:     null,
  map:            null,
  mapMarkers:     [],
  mapLines:       [],
  // Stations picked off the map (by shape or by modifier-click). A third thing
  // alongside `filters` and `selectedId`: see the Map selection section below.
  mapSelection:   new Set(),
  // The repeater a plain click last landed on, or null. While set, every
  // marker/link not on that repeater's own paths is dimmed — see
  // applyMapFocusStyles. A display overlay like mapSelection, not a filter.
  mapFocusRepeaterId: null,
  mapShowLinks:   true,
  mapHideOthers:  false,   // filter box: highlight matches (default) vs hide the rest
  mapKillSpaghetti: true,  // drop pass-range links longer than mapMaxLinkKm
  mapMaxLinkKm:   120,     // km; about as far as a VHF hop plausibly reaches
  mapLinkOpacity: 0.8,     // pass-range lines: 0.1–1.0, applied over their casing
  mapLabelMode:   'auto',  // station name labels: 'auto' (fit the viewport) | 'on' | 'off'
  mapRelated:     true,    // pull pass-range-related repeaters in with the matches
  // Light up watercourses whose name matches the filter box (see MapRivers).
  // The one map display switch that is remembered between visits: it is the only
  // one that costs a network request, so an operator who turns it off means it.
  mapRivers:      localStorage.getItem('mn-rivers') !== 'off',
  mapMatchLabels: new Set(),  // ids the current filter earned a label (see mapLabelIds)
  mapLinkCount:   { drawn: 0, culled: 0 },   // last refresh, for the sidebar note
  mapFitKey:      null,    // extent the map was last auto-fitted to (re-fit only on change)
  mapSearchTimer: null,    // debounce for the search box → marker rebuild
  passRelIdx:     null,    // both directions of the pass-range relation, per loaded file
  splitW:         +(localStorage.getItem('mn-split') || 0) || 320,  // Stations tab column split, px
  // Left nav: an icon rail, or icons plus labels. Kept under 'mn-nav' the same
  // way the theme and the split width are. With nothing stored the window's
  // width decides, so a first visit on a laptop isn't handed two sidebars.
  navCollapsed:   (localStorage.getItem('mn-nav')
                   || (window.innerWidth < NAV_AUTO_COLLAPSE_PX ? 'collapsed' : 'expanded')) === 'collapsed',
  // Right-hand help panel: a strip, or a strip plus what it has to say about
  // the open tab. Kept under 'mn-help', in the same family as the three above.
  // Deliberately *not* given the nav's width test: it starts collapsed at every
  // width, because a reference surface that opens itself on every load is one
  // people learn to close rather than read, and because it is the third column
  // on a page that already budgets carefully for two. A stored preference wins,
  // exactly as it does for the nav.
  helpCollapsed:  (localStorage.getItem('mn-help') || 'collapsed') === 'collapsed',
  // Draw & measure overlay (Stations map). Plain geometry only — the Leaflet
  // layers are rebuilt from it whenever the map is, so a tab switch doesn't
  // throw the sketch away. Deliberately not persisted: see MapDraw.
  draw: {
    tool:       '',        // '' | 'pin' | 'line' | 'circle' | 'rect' | 'text'
    shapes:     [],
    seq:        0,
    selectedId: null,
    showLabels: true,
    snap:       true,      // land clicks on the station pin under the cursor
    // The picked colour for new shapes. Empty means "whatever the theme's
    // --draw is". The choice is worth keeping across a reload even though the
    // shapes themselves deliberately are not.
    colour:     localStorage.getItem('mn-draw-colour') || '',
  },
  // Elevation profile under the map. Only the operator's overrides live here —
  // the terrain itself is cached in Terrain, and the profile is recomputed from
  // whichever line is current rather than stored.
  path: {
    open:    false,
    aglA:    null,   // m AGL override; null = the station's rm_systems height
    aglB:    null,
    freqMhz: null,   // null = the repeater on either end, else PATH_DEFAULT_MHZ
  },
  // Link budget card. The endpoints have to outlive a tab switch — half an hour
  // of what-ifs should not be thrown away by looking at the Pass Ranges tab.
  link: {
    open:    false,
    picking: false,  // map clicks are setting endpoints
    a:       null,   // { kind:'station'|'point', …, def:{}, over:{} } — see LinkBudget
    b:       null,
    freqMhz: null,
  },
  exportNets:     null,
  // Last datastore round trip, as returned by dbPing(): null before the first
  // one, { checking:true } while one is in flight. Kept here rather than in the
  // panel so that re-rendering the Export tab — which every checkbox on it does
  // — redraws the last result instead of firing another request.
  dbStatus:       null,
  // Where the station list on screen actually came from — see loadJson(). Null
  // until something loads. The one failure this exists to prevent is the quiet
  // one: a fallback to yesterday's committed file, looking exactly like the
  // database, with nobody told.
  dataSource:     null,
  // Why the datastore was not used, when it was not. Kept after a fallback so
  // the Export tab can say what went wrong rather than only that something did.
  loadError:      null,
  bfInput:        '',
  bfBits:         '1',
  bfOnlyMatches:  false,
  bfArroBase:     ARRO_DEFAULT_BASE,   // graph base; its host drives every ARRO link (see arroHost)
  bfSensorFilter: '',
  bfMap:          null,
  bfMapLayer:     null,
  bfMapTimer:     null,
  // Network View's geo panel — a Leaflet instance of its own, in the same
  // lazily-created, torn-down-on-tab-away shape as bfMap/a2.map/wb.map.
  nvMap:          null,
  nvMapMarkers:   [],
  nvMapLines:     [],
  nvMapArrows:    [],   // direction markers on confirmed links — see refreshNvMap
  nvMapRepeaters: [],   // pass-range repeater pins + their lines — see refreshNvMap
  prFilter:       '',      // Pass Ranges tab: station number / AlertID / name filter
  // ARRO launcher. `search` drives the station lookup, `siteId`/`deviceId` are
  // the ids actually opened — a search result writes into them rather than
  // opening straight away, so a mis-click is visible before it costs a tab.
  arro: { search: '', siteId: '', deviceId: '', note: '' },
  pkt: {
    decInput:  '',
    lastDecode: null,   // last decoded input string (for replay after re-render)
    lastEncode: false,  // whether an encode result should be replayed
    enc: { format: 'eif', id: 2784, data: 1599, polarity: 'negative', b: 0, hd: 0, bs: 0, vco: 0, de: 0 },
  },
  // ALERT2 / ERT-A2 tab. The capture text is the only thing worth keeping across
  // a tab switch — everything derived from it is recomputed by parse(), which is
  // cheap enough (a 100k-line log parses in well under a second) that caching the
  // decode would cost more in staleness than it saves.
  a2: {
    text:      '',          // pasted / loaded capture, verbatim
    source:    '',          // where it came from, for the summary line
    parsed:    null,        // last Alert2.parse() result
    parsedKey: '',          // text + mode the cached parse was made from
    // Which of the two wire formats the capture is read as. 'auto' sniffs, and
    // is right for everything an operator actually pastes; the explicit modes
    // exist for the case where a file holds both and only one is wanted.
    mode:      'auto',      // auto | ascii | bin
    view:      'readings',  // readings | frames | stations | reference
    frameIdx:  0,           // frame open in the anatomy panel
    onlyErrors: false,
    hideUnknown: false,     // drop records whose ALERT id matches no station
    eng:       true,        // show engineering values beside the raw counts
    mmPerTip:  bucketSizeMm(null).mm, // fallback only — a resolved station's TBRGbucketSize wins (see engValue)
    battDiv:   10,
    picks:     {},          // alert id -> chosen station id, when the capture can't tell
    limit:     400,         // rows drawn before "show more"; a day's log is ~15k readings
    watch:     null,        // { handle, timer, name } — File System Access polling
    watchMs:   5000,
    watchErr:  '',          // why the last Watch attempt failed, if it did
    // The table and the map are two views of one selection: a station id when
    // the address resolved to one, otherwise the bare ALERT address.
    sel:       null,
    map:       null,        // Leaflet map on this tab
    mapLayer:  null,
    mapMarks:  null,        // selection key -> marker, for the two-way highlight
    mapView:   null,        // { center, zoom } — survives the re-render a filter causes
  },
  editorId:       null,
  editorDraft:    {},
  // The `updated_at` the open station was loaded with, fetched from the database
  // when it is selected and sent back with the save. The database refuses the
  // write if the row has moved since — see meganet.save_station() in
  // db/migrations/0004_station_writes.sql. Null means "not known", which is
  // itself a refusal for an existing station: an editor that cannot say which
  // version it started from has no business overwriting one.
  editorStamp:    null,
  editorStampFor: null,      // which id the stamp above belongs to
  editorBusy:     false,     // a save or delete is in flight; the buttons are disabled
  // What the editor is currently saying about itself: { kind:'ok'|'error'|'busy', text }.
  // Held in state rather than written straight to the DOM so it survives the
  // re-render a successful save causes.
  editorMsg:      null,
  // ACMA RRL interference layer (all lazy — untouched until the toggle is on
  // or the RF Environment tab is opened)
  acma: {
    loaded: false, loading: false, loadPromise: null, error: null,
    threats: null, dicts: null,
    flat: [], siteById: {}, anchorById: {}, pairsByDevice: {}, mechCounts: {},
    devLoaded: false, devPromise: null,
    deviceById: {}, devicesBySite: {}, licById: {}, clientById: {}, antById: {}, texts: [],
    layer: null, beamLayer: null, linkLayer: null, hiLayer: null,
    selectedAnchorId: null, cardDeviceId: null, cardAnchorId: null,
    uiOpen: false,
  },
  rf: { anchorId: '', sortKey: 'score', sortDir: -1, corrText: '' },
  // RF Changes tab (lazy — nothing fetched until the tab is opened)
  rfc: {
    loaded: false, loading: false, loadPromise: null, error: null,
    timeline: null, changes: null, snapshots: null,
    anchorSel: new Set(),      // empty = all repeaters
    onset: '', windowDays: 90, minScore: 10, radiusKm: 60,
    pairIdx: -1,               // index into changes.pairs; -1 = newest
    sortKey: 'coin', sortDir: -1,
    corrText: '', corrSeries: null, corrSteps: null,
    pickerOpen: false,
  },
  // Interference Workbench (lazy — nothing computed or fetched until the tab is
  // opened; ACMA/RFC data loads only once an investigation names a candidate)
  wb: {
    affected: [],        // ALERT addresses flagged affected
    good: [],            // ALERT addresses explicitly marked known-good
    onset: '', onsetEnd: '',
    symptom: '',         // key into WB_SYMPTOMS ('' = unknown)
    caseName: '',
    pickQuery: '',
    map: null,
    lastAnalysis: null,
    concepts: null, conceptsPromise: null, drawerId: null,
  },
  // Inspections (#116 — lazy; the form matrix and the pick-lists are fetched
  // the first time the tab is opened, and kept for the session)
  insp: {
    refs: null,          // the matrix, the fourteen sections, the vocabularies
    refsLoading: false,
    refsError: null,
    query: '',           // the station picker's search box
    doc: null,           // the visit on screen, shaped as inspection_doc() returns it
    stamp: null,         // updated_at the form loaded it with; the 409 contract
    draftKey: null,      // which localStorage draft this form writes to
    suggestion: null,    // why a configuration was pre-selected, or null
    dirty: false,
    busy: false,
    msg: null,
    recent: null,        // last 25 visits, editors only
    recentBusy: false,
    recentError: null,
  },
  // Site Maintenance (#117 — lazy, same as the Inspections tab: the pick-lists
  // are fetched the first time the tab is opened and kept for the session)
  maint: {
    refs: null,          // the ten vocabularies, nine of them shared with insp
    refsLoading: false,
    refsError: null,
    query: '',           // the station picker's search box
    doc: null,           // the form on screen, shaped as maintenance_activity_doc() returns it
    stamp: null,         // updated_at the form loaded it with; the 409 contract
    draftKey: null,      // which localStorage draft this form writes to
    from: null,          // the inspection row this form was raised against, if any
    dirty: false,
    busy: false,
    msg: null,
    recent: null,        // last 25 maintenance forms, editors only
    recentBusy: false,
    recentError: null,
    outstanding: null,   // meganet.inspection_needs_maintenance, editors only
    outstandingBusy: false,
    outstandingError: null,
  },
  // Attachments (#149 — shared by the two form tabs above; see attachments.js
  // for why one file rather than a panel copied into each). One record's worth
  // at a time: both tabs can hold a document at once, and the slot re-fetches
  // when the other one asks, which is also the honest behaviour because someone
  // else may have added a photo since.
  attach: {
    types: null,         // meganet.attachment_type — what may be uploaded, and how large
    typesLoading: false,
    typesError: null,
    ownerKey: null,      // 'inspection:<id>' or 'maintenance:<id>' the list belongs to
    list: null,          // that record's meganet.attachment rows, or null while loading
    listLoading: false,
    error: null,
    busy: false,         // an upload is in flight; the file pickers disable
    msg: null,           // { role, kind, text } — rendered on the panel that asked
    urls: {},            // storage_path → signed URL, for this session only
  },
  theme: localStorage.getItem('mn-theme') || 'light',
};

// ── Module registries ─────────────────────────────────────────────────────────
// Two things the app shell does on behalf of whichever modules are live: stop
// them when the tab they own is left, and re-measure their Leaflet maps when
// the layout takes a column from them or gives one back.
//
// Both used to be lists of module names hardcoded in app.js — switchTab()'s
// three stop() calls and invalidateMapSizes()'s five maps — and by the end of
// #129 every one of those names lived in a different file. That is the failure
// this replaces (#142): the list was in a file the module's author had no
// reason to open, so a new tab that forgot to add itself **under-reported in
// silence**. A map missing from the list renders at the wrong size after a nav
// collapse; a loop missing from the stop-list keeps ticking behind whatever tab
// replaced it, costing a frame's work every frame. Neither throws, neither
// shows up in `npm run all`, and neither is visible in the module's own file.
// Same shape as MemMeter's three lists, fixed the same way — a module now says
// so in its own file, and adding a tab with a map or a teardown means editing
// only that tab's file.
//
// Registration is a call made from the module's init(), or from the line that
// creates the map — never a statement at a module's top level. `init.js` is the
// only file that executes at load (#132), and that property is what makes a
// module's position in the load order not matter; a bare push here would take
// it back. Registering from init() has a second effect worth having: the
// registry only ever holds modules that have actually run, which is precisely
// what the old `if (m)` guard was doing by hand for maps, and what made three
// unconditional stop() calls on every tab switch a no-op most of the time.
//
// Keyed by module name so re-entering a tab replaces its entry rather than
// stacking another copy — registration has to be safe to repeat, because init()
// runs on every render of its tab. Iteration order is registration order (first
// time each tab was opened) and **nothing may depend on it**: a teardown that
// only works after some other teardown has run is a bug in that teardown, not a
// reason to fix the order.
const _tabTeardowns = new Map();   // name → () => void
const _liveMaps     = new Map();   // name → () => (L.Map | null)

function registerTabTeardown(name, fn) { _tabTeardowns.set(name, fn); }
function registerLiveMap(name, getMap) { _liveMaps.set(name, getMap); }

// Run every registered teardown on the way out of a tab. One that throws must
// not take the rest of the switch with it — the tab is changing either way, and
// a half-torn-down app is worse than a module that failed to stop. The failure
// still lands in the error log, so a bug report carries it.
function runTabTeardowns() {
  _tabTeardowns.forEach((fn, name) => {
    try { fn(); }
    catch (e) {
      recordError({
        kind:    'teardown',
        message: `${name} teardown threw: ${(e && e.message) || e}`,
        where:   '',
        stack:   _errStack(e && e.stack, 4),
      });
    }
  });
}

// Take a Leaflet map down. Always this, never `map.remove()` on its own.
//
// A zoom is a 250 ms CSS transition that Leaflet finishes from a timer, and
// that callback reads `this._mapPane` — which `remove()` has already deleted.
// It throws, uncaught, because a timer is nobody's call stack: no try/catch
// around remove() can see it, and runTabTeardowns() below cannot either. Only
// the console shows it, which is why it went unnoticed for as long as it did.
//
// It needs a zoom in flight at the moment the map goes, which used to mean a
// re-render inside the tab and now also means leaving it (#143 moved the
// removal onto that path — zoom, change your mind, click another tab). There
// is no public API for cancelling a zoom mid-transition; `map.stop()` covers
// pan and fly and stops short of it. What does work is the callback's own first
// line, which returns early unless `_animatingZoom` is set — so clearing the
// flag turns the pending call into the no-op it should have been.
//
// Returns null, so the caller reads `state.map = removeMap(state.map)` and the
// slot cannot be left pointing at a dead map.
function removeMap(map) {
  if (!map) return null;
  try {
    map.stop();                  // pan and fly, the half with an API
    map._animatingZoom = false;  // and the zoom transition, the half without one
    map.remove();
  } catch (_) {
    // remove() can also throw when the container went first — a lazy data load
    // that re-rendered the tab out from under it. Nothing left to clean up.
  }
  return null;
}

// Every Leaflet map currently on the page. They are created lazily per tab, so
// most of these getters return null most of the time — a module registers once
// and the getter answers for the map's whole lifetime, including the stretches
// where its own teardown has set it back to null.
function liveMaps() {
  const out = [];
  _liveMaps.forEach(get => {
    let m = null;
    try { m = get(); } catch (_) {}
    if (m) out.push(m);
  });
  return out;
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Escape a value for use inside a single-quoted JS string embedded in a
// double-quoted HTML attribute (e.g. onclick="fn('${escAttr(x)}')"). JS-escapes
// backslash/quote first, then HTML-escapes so map filenames containing spaces,
// commas or "&" survive both parsing layers intact.
function escAttr(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function csvEscape(s) {
  s = String(s ?? '');
  return (s.includes(',') || s.includes('"') || s.includes('\n'))
    ? `"${s.replace(/"/g,'""')}"` : s;
}

function netName(id) {
  return (state.data?.radio_networks || []).find(n => n.id === id)?.name ?? id;
}

function pFloat(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }
function pInt(v)   { const n = parseInt(v, 10); return isNaN(n) ? null : n; }

function parseRangeLines(text) {
  return text.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const m = l.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    return m ? { low: parseInt(m[1]), high: parseInt(m[2]) } : null;
  }).filter(Boolean);
}

function slug(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'').slice(0, 64);
}

function dlText(name, content) {
  const a = Object.assign(document.createElement('a'), {
    href:     URL.createObjectURL(new Blob([content], { type: 'text/csv' })),
    download: name,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Geometry on the ground ────────────────────────────────────────────────────
// Lived in Draw & measure until #132; read by Terrain, Link budget, the path
// profile and the ACMA beam polygons as well, which is why they are here.

const KM_PER_DEG_LAT = 110.574;                                  // as in acmaBeamPolygon
function kmPerDegLon(lat) { return 111.320 * Math.cos(lat * Math.PI / 180); }

function bearingDeg(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * rad) * Math.cos(lat2 * rad);
  const x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad) -
            Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos((lon2 - lon1) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

// Where you end up starting at a point and travelling a distance on a bearing —
// the "from this repeater, 12 km on 045°" form of drawing a line.
function destPoint(lat, lon, brg, km) {
  const R = 6371.0088, rad = Math.PI / 180;
  const d = km / R, b = brg * rad, p1 = lat * rad, l1 = lon * rad;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1),
                             Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [p2 / rad, ((l2 / rad + 540) % 360) - 180];
}

function fmtKm(km) {
  if (!isFinite(km)) return '—';
  if (km < 1)   return `${Math.round(km * 1000)} m`;
  if (km < 10)  return `${km.toFixed(2)} km`;
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

// ── Interference mechanisms ───────────────────────────────────────────────────
// How one licensed service can sit on top of another, with the colour each is
// drawn in. Lived in the ACMA section until #132; seven other sections read it
// — the RF Environment and RF Changes tabs, the Interference Workbench, the map
// layer, its legend, the transmitter card and the ACMA draft-letter export.
// acmaHaversineKm below it is the same story: six consumers, one of them the
// ACMA section itself.

const ACMA_MECH = {
  co_channel:     { label: 'Co-channel',          color: '#d32f2f' },
  adjacent:       { label: 'Adjacent channel',    color: '#f57c00' },
  imd3:           { label: 'Intermod IMD3',       color: '#7b1fa2' },
  imd5:           { label: 'Intermod IMD5',       color: '#ce93d8' },
  imd3_triple:    { label: 'Intermod 3-signal',   color: '#9575cd' },
  harmonic:       { label: 'Harmonic',            color: '#0288d1' },
  cosite_desense: { label: 'Co-site desense',     color: '#6d4c41' },
};

function acmaHaversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0088, rad = Math.PI / 180;
  const dp = (lat2 - lat1) * rad, dl = (lon2 - lon1) * rad;
  const a = Math.sin(dp / 2) ** 2 +
            Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ── ALERT addresses ↔ sensors ─────────────────────────────────────────────────
// Turning a station into its sensor list, the whole network into an address
// index, and a set of {station, sensor} pairs into an ARRO graph URL. Lived in
// the Bit Flipper until #132; five other sections read them. BF_TYPE_LABEL and
// formatArroLocal came with them because each has exactly one caller and it is
// one of these — leaving them behind would have made core.js reach forward into
// a tab module.

const BF_TYPE_LABEL     = { battery: 'Battery', rainfall: 'Rainfall', water_level: 'Water Level', primary: 'Primary' };

// Normalized sensor list for a station. Prefers the enriched `sensors` array
// (from the national sensor database) and falls back to synthesizing minimal
// records from legacy `alert_ids` when a station has not been enriched.
function stationSensors(s) {
  if (Array.isArray(s.sensors) && s.sensors.length) return s.sensors;
  const out = [];
  const a = s.alert_ids || {};
  ['battery', 'rainfall', 'water_level', 'primary'].forEach(k => {
    const v = a[k];
    if (v == null) return;
    (Array.isArray(v) ? v : [v]).forEach(id =>
      out.push({ alert_id: id, type: BF_TYPE_LABEL[k] || k, sensor_id: '', device_id: null }));
  });
  return out;
}

// Build an ALERT-address → [{ station, sensor }] index across all stations.
function buildSensorIndex() {
  const idx = new Map();
  state.data.stations.forEach(s => {
    stationSensors(s).forEach(sensor => {
      const id = sensor.alert_id;
      if (id == null) return;
      if (!idx.has(id)) idx.set(id, []);
      idx.get(id).push({ station: s, sensor });
    });
  });
  return idx;
}

function formatArroLocal(d) {
  const p = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
       + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Build an ARRO graph URL for the given {station,sensor} pairs. Returns
// { url, count } or null when no pair carries the site/device ids ARRO needs.
function buildArroUrl(pairs) {
  const base = (state.bfArroBase || ARRO_DEFAULT_BASE).trim();
  const now = new Date(), start = new Date(now.getTime() - 7 * 86400e3);
  const p = new URLSearchParams({
    refresh: 'off', markers: 'false', legend: 'true', bin: '86400',
    time_zone: 'Australia/Brisbane', invalid: 'true',
    has_regular_sensors: 'true', has_forecast_sensors: 'false',
    for_forecast: 'false', hidden_devices: 'none',
    data_start: formatArroLocal(start), data_end: formatArroLocal(now),
  });
  const seen = new Set();
  pairs.forEach(({ station, sensor }) => {
    const dbId = station.site && station.site.db_id;
    const dev  = sensor.device_id;
    if (dbId == null || dev == null) return;
    const key = `${dbId}|${dev}`;
    if (!seen.has(key)) { seen.add(key); p.append('devices[]', key); }
  });
  if (!seen.size) return null;
  return { url: base.replace(/\?+$/, '') + '?' + p.toString(), count: seen.size };
}

// ── Leaflet: drop canvas redraws that outlive their canvas ─────────────────────
//
// Leaflet 1.9.4 can leave an animation frame scheduled against a canvas
// renderer it has already torn down. Removing a map removes its layers in stamp
// order, and the shared canvas renderer is a layer like any other — so it can be
// destroyed while paths that draw on it are still coming off. The frame those
// late removals leave behind fires after the map is gone, finds `this._ctx`
// deleted, and throws an uncaught TypeError out of `Canvas._clear`.
//
// On the Stations map that is ~7,000 paths coming off at once, and the crash
// lands roughly half the times you leave and re-enter the tab. It is harmless in
// itself — the canvas it wanted to paint was thrown away on purpose — but it is
// an uncaught exception in the console of anyone who opens dev tools, and it
// makes "the console is clean" untestable, which is the whole premise of the
// smoke test in test/ (#130).
//
// Cancelling the pending frame during teardown does *not* fix it: the frame that
// survives is not reliably the one the renderer still holds an id for, so there
// is nothing dependable to cancel. Neutralising the callback is, because the
// condition is unambiguous — a redraw with no context has nothing to draw on.
//
// This must stay above the first L.map() call. Since #132 that is what putting
// it at the bottom of core.js buys — core.js loads before every module and
// before init.js, and init.js is the only thing that renders a tab at load. Do
// not move it into a module file in M2–M4: any file that can be reordered
// relative to the map modules can reintroduce the crash.
if (typeof L !== 'undefined' && L.Canvas) {
  const _leafletCanvasRedraw = L.Canvas.prototype._redraw;
  L.Canvas.prototype._redraw = function () {
    if (!this._ctx) { this._redrawRequest = null; return; }
    return _leafletCanvasRedraw.call(this);
  };
}

