// MegaNet — app.js

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
    { id: 'export',     label: 'Export',                 icon: '📤' },
  ] },
];

// Flattened, for the lookups that only care which tab is open (the bug
// reporter) and don't want to know how the nav happens to be grouped.
const TAB_LIST = TABS.flatMap(g => g.tabs);

// Matches the width transition in styles.css. Measuring a map mid-slide is
// worse than not measuring it at all, so the invalidate that follows a collapse
// waits the transition out rather than racing it.
const NAV_TRANSITION_MS = 160;

// Below this the nav starts collapsed, on first visit only. The Stations tab
// already gives a permanent column to its resizable filter pane, and on a
// laptop a second permanent column is one too many.
const NAV_AUTO_COLLAPSE_PX = 900;

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
const DB_SCHEMA_VERSION = 6;

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
  theme: localStorage.getItem('mn-theme') || 'light',
};

// ── Memory meter ─────────────────────────────────────────────────────────────
// A thin bar under the header, and a panel behind it, answering "how much is
// this page holding, and can I give some back" — see issue #79. This is our
// own accounting, not a walk of the object graph: array/string lengths and
// byte counts recorded at load time (loadJson, acmaFetchJson), which is free.
// performance.memory (Chromium-only) and navigator.storage.estimate() are
// shown alongside where the browser actually offers them.
//
// Deliberately defined ahead of the Init section below: `init()` runs
// immediately, at its position in this file, and calls MemMeter.start() — so
// the MemMeter binding has to exist by then. Terrain and ArroData, which its
// functions reach into, are declared later in the file; that's fine, because
// nothing here touches them until a click or the sampling timer calls in,
// long after the whole script has finished loading.
const MemMeter = (function () {
  // Holders shown in the bar and the panel, in the order they're listed. Each
  // maps to one of the state slots the issue's table calls out; `color` is an
  // existing CSS custom property so the bar reuses the app's palette rather
  // than inventing one. `releasable` holders get a Release button — the three
  // the issue judges safe to drop and re-lazy-load or re-fetch.
  const HOLDERS = [
    { key: 'stations', label: 'stations.json',           color: '--role-repeater', releasable: false },
    { key: 'acma',      label: 'ACMA / RF Changes data',  color: '--role-satcom',   releasable: true  },
    { key: 'terrain',   label: 'Terrain tile cache',      color: '--role-base',     releasable: true  },
    { key: 'arro',      label: 'ARRO Data series',        color: '--role-field',    releasable: true  },
    { key: 'a2',        label: 'ALERT2 capture',          color: '--draw',         releasable: false },
    { key: 'storage',   label: 'localStorage',            color: '--muted',        releasable: false },
  ];

  const ACMA_FILES = ['acma-threats.json', 'acma-sites.json', 'acma-dictionaries.json',
                       'acma-devices.json', 'acma-timeline.json', 'acma-changes.json',
                       'acma-snapshots.json'];

  // Bytes per ARRO row: t, tr, v, raw are Float64Array (8 B each), q is
  // Uint8Array (1 B) — see ArroData's parseCsv. Length × this, not a walk.
  const ARRO_BYTES_PER_ROW = 8 * 4 + 1;
  const TERRAIN_TILE_BYTES = 65536 * 2;   // Int16Array(65536), 2 B/element

  const WARN_BYTES = 60  * 1024 * 1024;
  const BAD_BYTES  = 100 * 1024 * 1024;
  const BAR_CAP    = 130 * 1024 * 1024;   // segment widths scale against this

  let panelOpen = false;
  let storageEstimate = null;   // {usage, quota}, fetched once per panel open

  function fmtBytes(n) {
    if (!n) return '0 B';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function acmaFileBytes() {
    const F = state.memBytes.files;
    return ACMA_FILES.reduce((sum, k) => sum + (F[k] || 0), 0);
  }

  function arroBytes() {
    return ArroData.ad.series.reduce((sum, s) => sum + (s.n || 0) * ARRO_BYTES_PER_ROW, 0);
  }

  function localStorageBytes() {
    let sum = 0;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        sum += (k.length + (localStorage.getItem(k) || '').length) * 2;   // UTF-16
      }
    } catch (_) { /* storage disabled — not worth surfacing here */ }
    return sum;
  }

  function heapInfo() {
    const m = performance && performance.memory;
    return m ? { used: m.usedJSHeapSize, limit: m.jsHeapSizeLimit } : null;
  }

  function memoryReport() {
    const bytes = {
      stations: state.memBytes.stationsJson,
      acma:     acmaFileBytes(),
      terrain:  Terrain.cached() * TERRAIN_TILE_BYTES,
      arro:     arroBytes(),
      a2:       (state.a2.text || '').length * 2,
      storage:  localStorageBytes(),
    };
    const holders = HOLDERS.map(h => ({ ...h, bytes: bytes[h.key] }));
    return { holders, total: holders.reduce((s, h) => s + h.bytes, 0), heap: heapInfo() };
  }

  // ── the bar ──

  function render() {
    const bar = document.getElementById('mem-bar');
    if (!bar) return;
    if (!state.data) { bar.hidden = true; return; }
    const wasHidden = bar.hidden;
    bar.hidden = false;
    const { holders, total } = memoryReport();
    bar.classList.toggle('mem-warn', total >= WARN_BYTES && total < BAD_BYTES);
    bar.classList.toggle('mem-bad', total >= BAD_BYTES);
    bar.title = `Memory this page is holding: ~${fmtBytes(total)} (our accounting) — click for details`;
    bar.innerHTML = holders.filter(h => h.bytes > 0).map(h => {
      const pct = Math.max(0.4, Math.min(100, h.bytes / BAR_CAP * 100));
      return `<span class="mem-seg" style="width:${pct}%;background:var(${h.color})" `
           + `title="${esc(h.label)}: ${fmtBytes(h.bytes)}"></span>`;
    }).join('');
    if (wasHidden !== bar.hidden) updateChromeHeight();   // the bar just entered/left the layout
    if (panelOpen) renderPanel();
  }

  let timer = null;
  function start() {
    if (timer) return;
    // Never in a render path, and never while the tab is hidden — a memory
    // meter that costs memory (or wakes a backgrounded tab) is the joke.
    timer = setInterval(() => { if (document.visibilityState === 'visible') render(); }, 5000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') render();
    });
  }

  // ── the panel ──

  function togglePanel() { if (panelOpen) closePanel(); else openPanel(); }

  function openPanel() {
    panelOpen = true;
    let root = document.getElementById('mem-modal');
    if (!root) {
      root = document.createElement('div');
      root.id = 'mem-modal';
      root.className = 'modal-overlay';
      root.onclick = closePanel;
      document.body.appendChild(root);
    }
    root.style.display = 'flex';
    renderPanel();
    document.addEventListener('keydown', onKey);
    if (!storageEstimate && navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(e => { storageEstimate = e; renderPanel(); }).catch(() => {});
    }
  }

  function onKey(e) { if (e.key === 'Escape') closePanel(); }

  function closePanel() {
    panelOpen = false;
    const root = document.getElementById('mem-modal');
    if (root) { root.style.display = 'none'; root.innerHTML = ''; }
    document.removeEventListener('keydown', onKey);
  }

  function renderPanel() {
    const root = document.getElementById('mem-modal');
    if (!root || !panelOpen) return;
    const { holders, total, heap } = memoryReport();
    const rows = holders.map(h => `
      <tr>
        <td><span class="mem-swatch" style="background:var(${h.color})"></span>${esc(h.label)}</td>
        <td class="mem-bytes">${fmtBytes(h.bytes)}</td>
        <td>${h.releasable && h.bytes > 0
              ? `<button class="mem-release" onclick="MemMeter.release('${h.key}')">Release</button>`
              : ''}</td>
      </tr>`).join('');
    root.innerHTML = `
      <div class="modal-card mem-card" role="dialog" aria-modal="true" aria-labelledby="mem-title"
           onclick="event.stopPropagation()">
        <div class="modal-head">
          <h2 id="mem-title">Memory this page is holding</h2>
          <button class="modal-x" title="Close (Esc)" onclick="MemMeter.closePanel()">×</button>
        </div>
        <p class="sub">Our own accounting of what MegaNet is keeping in memory — cheap to compute
           (lengths recorded when each piece loaded), not a walk of the object graph. Estimates,
           not exact byte counts.</p>
        <table class="mem-table">
          <thead><tr><th>Holder</th><th>Estimate</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr><td>Total (our accounting)</td><td class="mem-bytes">${fmtBytes(total)}</td><td></td></tr></tfoot>
        </table>
        <p class="mem-heap">
          ${heap ? `Browser JS heap: ${fmtBytes(heap.used)} of ${fmtBytes(heap.limit)} limit.`
                 : `Browser JS heap: not available in this browser.`}<br>
          ${storageEstimate
              ? `Persisted storage: ${fmtBytes(storageEstimate.usage || 0)} of ${fmtBytes(storageEstimate.quota || 0)} quota.`
              : `Persisted storage: checking…`}
        </p>
        <div class="modal-foot">
          <button onclick="MemMeter.closePanel()">Close</button>
        </div>
      </div>`;
  }

  // ── release ──
  // Terrain and ARRO have their own reset logic already (Terrain.clear(),
  // ArroData.clearAll()); ACMA/RFC's is here because nothing else needed a
  // "drop everything and let it re-lazy-load" reset before now.

  function releaseAcma() {
    const A = state.acma, R = state.rfc;
    Object.assign(A, {
      loaded: false, loading: false, loadPromise: null, error: null,
      threats: null, dicts: null,
      flat: [], siteById: {}, anchorById: {}, pairsByDevice: {}, mechCounts: {},
      devLoaded: false, devPromise: null,
      deviceById: {}, devicesBySite: {}, licById: {}, clientById: {}, antById: {}, texts: [],
    });
    Object.assign(R, {
      loaded: false, loading: false, loadPromise: null, error: null,
      timeline: null, changes: null, snapshots: null,
    });
    ACMA_FILES.forEach(k => delete state.memBytes.files[k]);
    if (state.map) refreshAcmaLayer();   // drops the map markers rather than leaving them orphaned
    renderMain();                        // RF Environment / RF Changes, if open, show "not loaded"
  }

  function releaseTerrain() {
    Terrain.clear();
    render();
  }

  function releaseArro() {
    if (!ArroData.ad.series.length) return;
    ArroData.clearAll();   // confirms before dropping more than one import
  }

  function release(key) {
    if (key === 'acma') releaseAcma();
    else if (key === 'terrain') releaseTerrain();
    else if (key === 'arro') releaseArro();
    render();
    renderPanel();
  }

  return { start, render, togglePanel, closePanel, release };
})();
if (typeof window !== 'undefined') window.MemMeter = MemMeter;

// ── Sign-in ──────────────────────────────────────────────────────────────────
// The browser half of #B8. Supabase Auth (GoTrue) issues the token; this module
// obtains one, keeps it alive, hands it to the datastore layer, and makes the
// signed-out state something the app renders rather than something it fails at.
//
// Read this before changing anything here:
//
// **This is not what keeps people out.** Cloudflare Access sits in front of the
// site and is the perimeter (docs/access.md); meganet.is_editor() sits in front
// of every write and is the enforcement. This module is the middle — it turns a
// person into a token so the database has something to check. Deleting all of it
// would make the app read-only, not open.
//
// **No library.** GoTrue is four HTTP endpoints and index.html gains no <script>
// tag for them, the same trade the Data API section above makes.
//
// **Two ways in, because the email decides which.** Supabase's default template
// sends a magic link; add {{ .Token }} to it and the same email also carries a
// six-digit code. The link lands back here with the session in the URL fragment;
// the code is typed into the panel. Both are supported because which one an
// operator gets depends on a template in a dashboard, and an app that only
// handles one of them is an app that breaks when somebody edits it.
//
// **sessionStorage, not localStorage.** #B8 said localStorage, matching the
// mn-theme pattern; 0004 had already chosen sessionStorage for the access token
// with a reason that still holds — a token that outlives the tab it was obtained
// in is a token left behind on a shared machine, and these are shared machines.
// The cost is a fresh sign-in per tab, which behind Access is a keystroke. If
// that is ever judged the wrong trade, this is the only place it is decided.
const Auth = (function () {

  // The whole session, not just the token: the refresh token and the expiry are
  // what make this survive a reload, and dbSetAccessToken() only knows about the
  // one field it needs.
  const KEY = 'meganet.session';

  // Refresh this long before the token actually expires. GoTrue's default is an
  // hour; a minute of margin covers a slow request and a clock that disagrees.
  const REFRESH_MARGIN_MS = 60 * 1000;

  let session = null;      // { access_token, refresh_token, expires_at, email }
  let who     = null;      // last meganet.whoami() answer, or null
  let timer   = null;
  // `email` and `code` are mirrored here rather than left in the DOM because
  // every state change repaints the panel: a message that arrives while somebody
  // is mid-type would otherwise take the typing with it.
  let ui      = { step: 'email', email: '', code: '', busy: false, msg: null };

  // ── session plumbing ──

  function load() {
    try {
      const raw = sessionStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }

  function store(s) {
    try {
      if (s) sessionStorage.setItem(KEY, JSON.stringify(s));
      else sessionStorage.removeItem(KEY);
    } catch (_) { /* private mode; this session lives in memory only */ }
  }

  // Everything that has to happen for a token to count as adopted, in one place
  // so no path can adopt half of it.
  function adopt(s) {
    session = s;
    store(s);
    dbSetAccessToken(s ? s.access_token : null);
    scheduleRefresh();
  }

  function fromTokenResponse(body, email) {
    return {
      access_token:  body.access_token,
      refresh_token: body.refresh_token,
      // Absolute rather than a duration, because a duration is only meaningful
      // at the instant it was issued and this gets written to storage.
      expires_at:    Date.now() + (Number(body.expires_in) || 3600) * 1000,
      email:         (body.user && body.user.email) || email || null,
    };
  }

  function scheduleRefresh() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!session) return;
    const due = session.expires_at - Date.now() - REFRESH_MARGIN_MS;
    // Already past it — refresh on the next tick rather than never, which is
    // what a negative setTimeout would otherwise quietly mean.
    timer = setTimeout(refresh, Math.max(0, due));
  }

  async function refresh() {
    if (!session || !session.refresh_token) return false;
    try {
      const body = await post(`token?grant_type=refresh_token`,
                              { refresh_token: session.refresh_token });
      adopt(fromTokenResponse(body, session.email));
      return true;
    } catch (_) {
      // A refresh token is single-use and expires; a failure here means the
      // session is over, and pretending otherwise leaves the app showing a name
      // for someone the database will refuse. Sign out quietly — nobody asked
      // for this request, so nobody is waiting for an error about it.
      await signOut({ announce: false });
      return false;
    }
  }

  // ── the four endpoints ──

  async function post(path, body, opts = {}) {
    const res = await fetch(`${AUTH_URL}/${path}`, {
      method: 'POST',
      headers: {
        apikey: DB_ANON_KEY,
        'Content-Type': 'application/json',
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }
    if (!res.ok) {
      const err = new Error(
        (parsed && (parsed.error_description || parsed.msg || parsed.message))
        || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return parsed;
  }

  // What the database makes of the token we are holding. Called after every
  // adoption because it is the only check that is not self-assessment: the token
  // could be well-formed, unexpired and still refused.
  async function whoami() {
    try {
      const res = await fetch(`${DB_URL}/rpc/whoami`, {
        method: 'POST',
        headers: {
          apikey: DB_ANON_KEY,
          ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
          'Content-Profile': DB_SCHEMA,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: '{}',
        cache: 'no-store',
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (_) {
      // Offline, or a database that has not had 0005 applied yet. Neither is
      // worth an error in the operator's face: the app still reads, and the
      // header simply does not claim to know who they are.
      return null;
    }
  }

  // ── sign in ──

  // Refuse in the browser what the database is going to refuse anyway, so an
  // address that was never going to be let in does not cost a round trip to a
  // mailbox and a wait. Not a security check — meganet.auth_user_gate() is —
  // and it deliberately fails open: if this call itself fails, the sign-in goes
  // ahead and the server gets to answer.
  async function maySignIn(email) {
    try {
      const res = await fetch(`${DB_URL}/rpc/email_may_sign_in`, {
        method: 'POST',
        headers: {
          apikey: DB_ANON_KEY,
          'Content-Profile': DB_SCHEMA,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ p_email: email }),
        cache: 'no-store',
      });
      if (!res.ok) return true;
      return (await res.json()) !== false;
    } catch (_) { return true; }
  }

  async function requestCode() {
    const email = (document.getElementById('au-email')?.value || '').trim();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return setMsg('error', 'That does not look like an email address.');
    }

    ui.email = email;
    setBusy(true, 'Checking…');

    if (!await maySignIn(email)) {
      setBusy(false);
      return setMsg('error',
        `${email} is not on the access list, so no code was sent. Access is open to any `
        + `verified @bom.gov.au address; anyone else has to be added by an administrator `
        + `— see docs/access.md.`);
    }

    setBusy(true, 'Sending…');
    try {
      // create_user true is what makes this a sign-in and a signup at once. The
      // database decides whether that signup is allowed, so "anyone can create
      // an account" is not what this line means.
      await post('otp', { email, create_user: true });
    } catch (err) {
      setBusy(false);
      return setMsg('error', signInErrorText(err, email));
    }
    setBusy(false);
    ui.step = 'code';
    ui.code = '';
    setMsg('ok', `Sent. Check ${email} — click the link, or type the six-digit code below.`);
    document.getElementById('au-code')?.focus();
  }

  async function verifyCode() {
    const token = (document.getElementById('au-code')?.value || '').trim();
    ui.code = token;
    if (!token) return setMsg('error', 'Enter the code from the email.');

    setBusy(true, 'Verifying…');
    let body;
    try {
      body = await post('verify', { email: ui.email, token, type: 'email' });
    } catch (err) {
      setBusy(false);
      return setMsg('error',
        err.status === 401 || err.status === 403
          ? 'That code was not accepted. Codes expire — send a new one if this keeps happening.'
          : signInErrorText(err, ui.email));
    }

    adopt(fromTokenResponse(body, ui.email));
    who = await whoami();
    setBusy(false);
    ui.step = 'in';
    ui.msg  = null;

    // Signed in and still refused is a real state — an address on auth but not
    // on editor_allow — and the header would otherwise imply write access that
    // the first save would deny.
    if (who && who.may_write === false) {
      setMsg('error', 'Signed in, but this address may not edit stations. An administrator has to add it.');
    }

    syncHeader();
    render();
    // The editor's status line says "not signed in" until something tells it
    // otherwise, and it is on screen behind this panel.
    if (typeof rerenderStationEditorCard === 'function') rerenderStationEditorCard();
  }

  // GoTrue does not pass a trigger's message through, so a refused signup
  // arrives as a generic database error. Recognising it here is what turns
  // "unexpected_failure" into the one thing the person needs to know.
  function signInErrorText(err, email) {
    const m = String(err && err.message || '');
    if (/database error|unexpected_failure/i.test(m)) {
      return `${email} was refused by the database, which is what happens to an address that `
           + `is not on the access list. If it should be, an administrator has to add it — see docs/access.md.`;
    }
    if (err.status === 429) {
      return 'Too many attempts in a row. Wait a minute and try again.';
    }
    return `Could not send the code — ${m}`;
  }

  async function signOut({ announce = true } = {}) {
    const token = session && session.access_token;
    adopt(null);
    who = null;
    ui  = { step: 'email', email: '', code: '', busy: false, msg: null };
    // Best effort, and deliberately after the local state is already gone: if
    // this fails the token is still forgotten here, which is the part that
    // matters to the person at the keyboard.
    if (token) { try { await post('logout', {}, { token }); } catch (_) { /* already gone */ } }
    syncHeader();
    if (announce && document.getElementById('auth-modal')?.style.display === 'flex') render();
    if (typeof rerenderStationEditorCard === 'function') rerenderStationEditorCard();
  }

  // ── the magic link landing ──
  // A link from the email returns here with the session in the URL *fragment* —
  // which never reaches a server, and is why GoTrue uses it. Consuming it means
  // taking the tokens and then removing them from the address bar, so a copied
  // URL or a screenshot is not a copied session.
  function consumeHash() {
    const raw = location.hash || '';
    if (!raw.includes('access_token=') && !raw.includes('error=')) return false;

    const p = new URLSearchParams(raw.replace(/^#/, ''));
    // replaceState rather than clearing location.hash, which would leave a bare
    // '#' and push a history entry.
    history.replaceState(null, '', location.pathname + location.search);

    if (p.get('error') || p.get('error_description')) {
      ui.msg = { kind: 'error', text: p.get('error_description') || p.get('error') };
      return false;
    }
    const access = p.get('access_token');
    if (!access) return false;

    adopt({
      access_token:  access,
      refresh_token: p.get('refresh_token'),
      expires_at:    Date.now() + (Number(p.get('expires_in')) || 3600) * 1000,
      email:         null,          // filled in by whoami() below
    });
    return true;
  }

  // ── header ──

  function label() {
    if (!session) return 'Sign in';
    const email = (who && who.email) || session.email;
    if (!email) return 'Signed in';
    // The local part is enough to say "you are you" and fits the header; the
    // full address is in the panel and the title attribute.
    return email.split('@')[0];
  }

  function syncHeader() {
    setHeaderLabel('btn-auth', label());
    const btn = document.getElementById('btn-auth');
    if (!btn) return;
    const email = (who && who.email) || (session && session.email);
    btn.title = session
      ? `Signed in${email ? ` as ${email}` : ''}${who && who.may_write === false ? ' — read only' : ''}`
      : 'Sign in to edit stations';
    btn.classList.toggle('is-in', !!session);
  }

  // ── panel ──

  function template() {
    const busy = ui.busy;
    const msg  = ui.msg
      ? `<p class="small" style="color:${ui.msg.kind === 'error' ? 'var(--bad)'
                                      : ui.msg.kind === 'ok' ? 'var(--ok)' : 'var(--muted)'}">${esc(ui.msg.text)}</p>`
      : '';

    let body;
    if (ui.step === 'in') {
      const email = (who && who.email) || session?.email || '';
      const write = who ? who.may_write : null;
      body = `
        <div class="modal-form">
          <p>Signed in${email ? ` as <strong>${esc(email)}</strong>` : ''}.</p>
          <p class="small">${
            write === false
              ? 'This address may sign in but may not edit stations — an administrator has to add it to the editors list.'
              : write === true
                ? 'Edits to stations will be saved to the database and attributed to this address.'
                : 'The database did not answer when asked what this session may do; saving will tell you.'
          }</p>
          <p class="small">This session ends when this tab is closed.</p>
        </div>
        <div class="modal-foot">
          <button onclick="Auth.close()">Close</button>
          <button class="primary" onclick="Auth.signOut()">Sign out</button>
        </div>`;
    } else if (ui.step === 'code') {
      body = `
        <div class="modal-form">
          <label>Six-digit code from the email
            <input type="text" id="au-code" inputmode="numeric" autocomplete="one-time-code"
                   placeholder="123456" value="${esc(ui.code)}" ${busy ? 'disabled' : ''}
                   onkeydown="if(event.key==='Enter'){event.preventDefault();Auth.verifyCode();}">
          </label>
          <p class="small">The email also contains a link. Clicking it signs you in in whichever
             tab it opens, and you can ignore this box.</p>
          ${msg}
        </div>
        <div class="modal-foot">
          <button onclick="Auth.back()" ${busy ? 'disabled' : ''}>Use a different address</button>
          <button class="primary" onclick="Auth.verifyCode()" ${busy ? 'disabled' : ''}>Sign in</button>
        </div>`;
    } else {
      body = `
        <div class="modal-form">
          <label>Work email address
            <input type="email" id="au-email" autocomplete="email" placeholder="you@bom.gov.au"
                   value="${esc(ui.email)}" ${busy ? 'disabled' : ''}
                   onkeydown="if(event.key==='Enter'){event.preventDefault();Auth.requestCode();}">
          </label>
          <p class="small">Any verified <strong>@bom.gov.au</strong> address can sign in with no
             approval step. Other addresses have to be added first — see <code>docs/access.md</code>.
             There is no password: an email arrives with a link and a code.</p>
          ${msg}
        </div>
        <div class="modal-foot">
          <button onclick="Auth.close()" ${busy ? 'disabled' : ''}>Cancel</button>
          <button class="primary" onclick="Auth.requestCode()" ${busy ? 'disabled' : ''}>Email me a code</button>
        </div>`;
    }

    return `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="au-title"
           onclick="event.stopPropagation()">
        <div class="modal-head">
          <h2 id="au-title">${ui.step === 'in' ? 'Your session' : 'Sign in to MegaNet'}</h2>
          <button class="modal-x" title="Close (Esc)" onclick="Auth.close()">×</button>
        </div>
        <p class="sub">Signing in is only needed to <em>edit</em>. The station list, the maps and every
           tool read without it.</p>
        ${body}
      </div>`;
  }

  function render() {
    const root = document.getElementById('auth-modal');
    if (!root || root.style.display !== 'flex') return;
    root.innerHTML = template();
  }

  function open() {
    let root = document.getElementById('auth-modal');
    if (!root) {
      root = document.createElement('div');
      root.id = 'auth-modal';
      root.className = 'modal-overlay';
      root.onclick = close;
      document.body.appendChild(root);
    }
    if (session && ui.step !== 'in') { ui.step = 'in'; ui.msg = null; }
    root.style.display = 'flex';
    root.innerHTML = template();
    document.addEventListener('keydown', onKey);
    document.getElementById(ui.step === 'code' ? 'au-code' : 'au-email')?.focus();
  }

  function onKey(e) { if (e.key === 'Escape') close(); }

  function close() {
    const root = document.getElementById('auth-modal');
    if (root) root.style.display = 'none';
    document.removeEventListener('keydown', onKey);
    ui.busy = false;
  }

  function back() {
    ui.step = 'email'; ui.code = ''; ui.msg = null;
    render();
    document.getElementById('au-email')?.focus();
  }

  function setMsg(kind, text) { ui.msg = { kind, text }; render(); }
  function setBusy(on, text) {
    ui.busy = on;
    if (text) ui.msg = { kind: 'busy', text };
    render();
  }

  // ── start ──
  // Called from init(). Everything here is best-effort and none of it blocks the
  // app drawing: a person who never signs in must not wait on an auth server to
  // see the station list.
  function start() {
    const landed = consumeHash();
    if (!landed) {
      const s = load();
      // Expired while the tab was closed. Keep it only if there is a refresh
      // token to redeem — otherwise it is just a string that will 401.
      if (s && (s.expires_at > Date.now() || s.refresh_token)) adopt(s);
      else if (s) store(null);
    }
    syncHeader();
    if (!session) return;

    (async () => {
      if (session.expires_at <= Date.now() && !await refresh()) return;
      who = await whoami();
      // A token the database will not honour is worse than no token: the editor
      // would offer to save and the save would be refused.
      if (who && who.signed_in === false) { await signOut({ announce: false }); return; }
      syncHeader();
      render();
      if (typeof rerenderStationEditorCard === 'function') rerenderStationEditorCard();
    })();
  }

  return {
    start, open, close, back, requestCode, verifyCode, signOut, render,
    // Read by the editor and the Data source panel. Both ask the database in the
    // end; these only decide what to say before that round trip.
    isSignedIn: () => !!session,
    mayWrite:   () => !!session && (who ? who.may_write !== false : true),
    email:      () => (who && who.email) || (session && session.email) || null,
    role:       () => (who && who.role) || null,
  };
})();
if (typeof window !== 'undefined') window.Auth = Auth;

// ── Init ───────────────────────────────────────────────────────────────────────

(function init() {
  document.documentElement.setAttribute('data-theme', state.theme);
  setHeaderLabel('btn-theme', state.theme === 'dark' ? 'Light' : 'Dark');
  setSplitWidth(state.splitW);          // also clamps whatever was stored
  renderTabs();
  renderMain();
  // The header's height and the nav's shape both depend on the width, so both
  // are re-checked when it changes — crossing the phone breakpoint with the
  // drawer open would otherwise leave the backdrop behind.
  window.addEventListener('resize', () => {
    updateChromeHeight();
    syncNavChrome(state.navCollapsed);
  });
  // Crossing the phone breakpoint changes what the nav *is* — a rail or a
  // drawer — and so what its toggle should say. Re-rendered on the crossing
  // itself rather than on every resize event: the nav is rebuilt wholesale.
  window.matchMedia('(max-width: 560px)').addEventListener('change', renderTabs);
  // On a phone the nav is a drawer laid over the page, and a drawer that only
  // closes by picking a tab is a trap — Escape backs out of it too.
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !state.navCollapsed && isPhoneNav()) setNavCollapsed(true);
  });
  MemMeter.start();
  // Before autoLoad(), so that a tab returning from a magic link has taken the
  // session out of the URL fragment before anything else reads location.
  Auth.start();
  autoLoad();
})();

// Header buttons are icon + label, so the label is a span inside the button and
// not the button's own text. Writing textContent would throw the icon away.
function setHeaderLabel(id, text) {
  const btn = document.getElementById(id);
  if (!btn) return;
  const label = btn.querySelector('.hdr-label');
  if (label) label.textContent = text;
  else btn.textContent = text;
}

// ── Theme ──────────────────────────────────────────────────────────────────────

function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', state.theme);
  localStorage.setItem('mn-theme', state.theme);
  setHeaderLabel('btn-theme', state.theme === 'dark' ? 'Light' : 'Dark');
  if (state.map) { refreshMapLayers(); MapDraw.render(); MapRivers.repaint(); }
  // The ARRO chart writes real colour values into its SVG rather than `var(…)`,
  // so that the PNG export has something to resolve. That is the trade: the
  // chart has to be told the palette moved.
  if (state.activeTab === 'arrodata') ArroData.repaint();
}

// ── File loading ───────────────────────────────────────────────────────────────

const GITHUB_RAW_URL = 'https://raw.githubusercontent.com/cdomotor-g/MegaNet/main/stations.json';

// Where a station list can come from, worst-to-best-understood. The label is
// what the operator reads in the header and on the Export tab; being able to
// answer "is this the database or a file?" at a glance is the whole point.
const SOURCE_LABELS = {
  api:     'the datastore',
  bundled: 'stations.json (this site)',
  github:  'stations.json (GitHub)',
  file:    'a file on this device',
};

function onFileLoad(input) {
  const f = input.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      loadJson(e.target.result, { kind: 'file', detail: f.name });
    } catch (err) {
      alert(`Failed to load stations.json: ${err.message}`);
    }
  };
  reader.readAsText(f);
  input.value = '';
}

// Returns true when the load succeeded. `announce` is what separates a button
// press — where silence would be baffling — from a step in the automatic
// fallback chain, where an alert for each source that did not answer would be
// three dialogs before the app has drawn anything.
async function loadFromUrl(url, { kind = 'github', announce = true } = {}) {
  const btn = document.getElementById('btn-load-gh');
  if (announce && btn) btn.disabled = true;
  if (announce) setHeaderLabel('btn-load-gh', 'Loading…');
  const t0 = _dbClock();
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    applyStationDoc(text, { kind, ms: Math.round(_dbClock() - t0) });
  } catch (err) {
    if (announce) alert(`Failed to load from URL: ${err.message}`);
    state.loadError = `${SOURCE_LABELS[kind] || url}: ${err && err.message || err}`;
    return false;
  } finally {
    if (announce && btn) btn.disabled = false;
    if (announce) setHeaderLabel('btn-load-gh', 'Load from GitHub');
  }
  // Outside the catch on purpose: the data has landed, so this call succeeded.
  // A failure in here is a rendering bug and belongs in the console as one.
  renderAfterLoad();
  return true;
}

function loadFromGitHub() {
  loadFromUrl(GITHUB_RAW_URL, { kind: 'github' });
}

// The station list out of Postgres, assembled by meganet.stations_doc() into the
// exact document this app has always parsed — see db/migrations/0002_stations.sql
// and tools/check_stations_doc.py, which is what makes "exact" a checked claim
// rather than a hopeful one. Nothing downstream of loadJson() knows the
// difference, which is the design: the API returns the file's shape, so the
// other ~17,000 lines never had to care.
//
// It is an RPC rather than a select on the view because PostgREST returns a
// scalar function's result as the response body itself. Selecting the view would
// wrap it as {"doc": …} and cost a 2.3 MB parse-and-restringify in the browser
// purely to unwrap it.
//
// Compression is not negotiated here on purpose: Accept-Encoding is a forbidden
// header name, so fetch() will not let this code set it. Every browser sends it
// anyway and PostgREST honours it, so the document arrives gzipped without
// anyone asking — roughly 2.3 MB becoming a few hundred KB.
async function loadFromApi({ announce = true } = {}) {
  const t0 = _dbClock();
  try {
    const res = await fetch(`${DB_URL}/rpc/stations_doc`, {
      headers: {
        apikey: DB_ANON_KEY,
        'Accept-Profile': DB_SCHEMA,
        Accept: 'application/json',
      },
      cache: 'no-store',
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body && body.message) detail = body.message;
      } catch (_) { /* not JSON; the status line stands */ }
      throw new Error(detail);
    }
    const text = await res.text();
    applyStationDoc(text, { kind: 'api', ms: Math.round(_dbClock() - t0) });
  } catch (err) {
    // Same rejection for DNS failure, CORS refusal, no network, and a project
    // paused for inactivity — the browser deliberately does not distinguish
    // them. Record what is known and let the caller fall back.
    state.loadError = `the datastore: ${err && err.message || err}`;
    if (announce) alert(`Failed to load from the datastore: ${err && err.message || err}`);
    return false;
  }
  renderAfterLoad();
  return true;
}

// The datastore first, then the file — in that order, and saying which one won.
//
// The fallback is not defensive padding. A free-tier Supabase project pauses
// after about a week of inactivity, and a paused project *fails* the read rather
// than slowing it down; MegaNet is exactly the burst-shaped tool that gets
// paused. Falling back to the committed stations.json turns that from "no data"
// into "yesterday's data" — which is only acceptable because the header then
// says so rather than letting a stale file pass for the database.
async function autoLoad() {
  if (await loadFromApi({ announce: false })) return;

  // The copy committed next to the app. Same file as GitHub raw, one less hop,
  // and it is what this app loaded from before there was a datastore. No such
  // thing over file://, where there is no server to ask.
  if (location.protocol !== 'file:'
      && await loadFromUrl('stations.json', { kind: 'bundled', announce: false })) return;

  await loadFromUrl(GITHUB_RAW_URL, { kind: 'github', announce: false });
}

// Loading and drawing are deliberately two functions, and the seam between them
// is where "did this work?" gets decided.
//
// Everything here can fail only because the *document* is bad. Drawing it is a
// separate step that can fail for its own reasons — a tab with a bug in it, a
// map library that did not load — and those must not be reported as the source
// having failed. Folded together, a render that threw would send the loader down
// its fallback chain: replacing the database's data with an older file, blaming
// the datastore for a fault in the browser, and then throwing again on the way
// back out. The data being in hand is the success condition.
function applyStationDoc(text, source) {
  const data = JSON.parse(text);
  if (!Array.isArray(data.stations)) throw new Error('Missing "stations" array');
  state.data       = data;
  state.dataSource = {
    kind:  (source && source.kind) || 'file',
    detail: source && source.detail,
    ms:    source && source.ms,
    at:    new Date(),
    // The document's own date, which is the one that answers "how old is this
    // data?" — as opposed to `at`, which only says when it was fetched. A file
    // from GitHub is fresh and its contents may be a month old.
    dated: (data.meta && data.meta.updated) || null,
  };
  // Cleared on success: whatever failed on the way to here has been superseded
  // by something that worked, and a stale error under a good load reads as a
  // current problem.
  if (source && source.kind === 'api') state.loadError = null;
  state.memBytes.stationsJson = text.length;
  state.exportNets = null;
  state.filterOpts  = null;         // option lists and the search corpus are
  state.searchIdx   = null;         // both derived from the file
  state.repeaterIdx = null;         // so is the cached repeater-only subset
  state.passRelIdx  = null;         // and so is the pass-range relation
  NetworkView.invalidate();         // every node in the graph was a row in the old file
  resetStationFilters();
  state.selectedId = null;
  state.mapSelection.clear();       // the picked ids belonged to the old file
}

// Draw whatever was just loaded. Kept separate from applyStationDoc() — see the
// note there — and called after it in every path.
function renderAfterLoad() {
  updateHeaderStats();
  MemMeter.render();
  renderTabs();
  renderMain();
}

// Parse-and-draw, as it always was. onFileLoad() and anything outside this file
// still get one call that does the whole job.
function loadJson(text, source) {
  applyStationDoc(text, source);
  renderAfterLoad();
}

function updateHeaderStats() {
  const el = document.getElementById('hdr-stats');
  if (!el || !state.data) return;
  const s = state.data.stations;
  const src = state.dataSource;
  // The source rides along with the counts because this line is on screen on
  // every tab. "3174 stations · 88 repeaters" is identical whether it came from
  // the database or from a file committed a month ago, and telling those apart
  // should not require opening a tab and pressing a button.
  const from = src ? ` · from ${SOURCE_LABELS[src.kind] || src.kind}` : '';
  el.textContent =
    `${s.length} stations · ${s.filter(x => x.roles.includes('repeater')).length} repeaters${from}`;
  el.title = src ? dataSourceSummary() : '';
}

// One line of plain English about the loaded document: where it came from, when
// it was fetched, and the date the data itself carries. That last one is the
// number that matters — a file fetched a second ago can hold month-old data.
function dataSourceSummary() {
  const src = state.dataSource;
  if (!src) return 'Nothing loaded yet.';
  const bits = [`Loaded from ${SOURCE_LABELS[src.kind] || src.kind}`];
  if (src.detail) bits.push(src.detail);
  if (src.ms != null) bits.push(`${src.ms} ms`);
  bits.push(`at ${src.at.toLocaleTimeString()}`);
  if (src.dated) bits.push(`data dated ${src.dated}`);
  return bits.join(' · ');
}

// ── Data helpers ───────────────────────────────────────────────────────────────

// Does the search box's text match this station? Names and station numbers
// match on any substring; a purely numeric query is also tried against the
// station's ALERT addresses, so an operator holding an id from a packet or an
// alarm can type it straight in instead of having to know the site name. Ids
// match from the start (6128 → 6128, 61 → 6128) — a mid-number substring match
// would pull in unrelated addresses that merely share a digit run.
function stationMatchesQuery(s, q) {
  if (!q) return true;
  if (s.name.toLowerCase().includes(q)) return true;
  if ((s.station_number || '').toLowerCase().includes(q)) return true;
  if (/^\d+$/.test(q) && stationAlertIds(s).some(id => String(id).startsWith(q))) return true;
  return false;
}

// The search box takes a list, not just one term: an operator watching a
// telemetry log copies the addresses coming in, pastes the lot straight into
// the box and sees where those sites are. Commas, semicolons, pipes, tabs and
// new lines all separate, so a spreadsheet column, a CSV row and a log excerpt
// all work as pasted. A run of bare numbers separated by spaces splits too —
// "6128 6129" is two addresses, while "Mt Stuart" is one name, so spaces only
// separate when every piece is a number. Terms are matched with OR: a station
// answering any one of them is in.
function parseSearchTerms(text) {
  const terms = [];
  String(text || '').split(/[,;|\t\r\n]+/).forEach(chunk => {
    const term  = chunk.trim();
    if (!term) return;
    const parts = term.split(/\s+/);
    if (parts.length > 1 && parts.every(p => /^\d+$/.test(p))) terms.push(...parts);
    else terms.push(term);
  });
  return [...new Set(terms.map(t => t.toLowerCase()))];
}

// Prepared form of the box's contents: the terms, plus the numeric ones on
// their own. Splitting and testing them per station per term is what made a
// 120-address paste take most of a second; this is done once per pass and
// memoised on the raw text, since a filter pass asks for the same string
// several times over (table, map, match note).
let _searchPrep = { text: null, prep: null };
function prepareSearch(text) {
  const raw = String(text || '');
  if (_searchPrep.text !== raw) {
    const terms = parseSearchTerms(raw);
    _searchPrep = { text: raw, prep: { terms, nums: terms.filter(t => /^\d+$/.test(t)) } };
  }
  return _searchPrep.prep;
}

// Any one term is enough. A station's ALERT addresses are derived once here,
// not once per numeric term — deriving them is the expensive part.
function stationMatchesSearch(s, prep) {
  const { terms, nums } = prep;
  if (!terms.length) return true;
  const name = s.name.toLowerCase();
  const num  = (s.station_number || '').toLowerCase();
  if (terms.some(t => name.includes(t) || num.includes(t))) return true;
  if (!nums.length) return false;
  const ids = stationAlertIds(s).map(String);
  return nums.some(t => ids.some(id => id.startsWith(t)));
}

// ── Marking where a search term landed ───────────────────────────────────────
// Which stations matched is only half the answer: a filter of "491" hits a
// station number, an ALERT address and a name three different ways, and the
// row on its own doesn't say which. The table marks the exact characters that
// matched, following stationMatchesSearch's rules to the letter — substring
// for names and station numbers, leading digits for ALERT addresses — so the
// highlight can never claim a match the filter didn't make.

// Every place a term occurs in an already-lowercased string, as merged
// [start, end) pairs. Overlapping terms ("61" and "6128") become one run
// rather than nested markup.
function searchHitRanges(lower, terms) {
  const spans = [];
  for (const t of terms) {
    if (!t) continue;
    for (let i = lower.indexOf(t); i !== -1; i = lower.indexOf(t, i + 1)) {
      spans.push([i, i + t.length]);
    }
  }
  if (spans.length < 2) return spans;
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [spans[0]];
  for (let i = 1; i < spans.length; i++) {
    const last = merged[merged.length - 1];
    if (spans[i][0] <= last[1]) last[1] = Math.max(last[1], spans[i][1]);
    else merged.push(spans[i]);
  }
  return merged;
}

// HTML for a field with its matched runs wrapped in <mark>. Escaping happens
// per slice, so the markup can't be spoofed by a station name containing tags.
function markHits(text, terms) {
  const str = String(text ?? '');
  if (!str || !terms || !terms.length) return esc(str);
  const spans = searchHitRanges(str.toLowerCase(), terms);
  if (!spans.length) return esc(str);
  let out = '', at = 0;
  for (const [a, b] of spans) {
    out += esc(str.slice(at, a)) + `<mark class="hit">${esc(str.slice(a, b))}</mark>`;
    at = b;
  }
  return out + esc(str.slice(at));
}

// ALERT addresses are matched from the start (6128 is found by "61", not by
// "12"), so only that leading run is marked — the longest one that matches.
function markAlertId(id, nums) {
  const str = String(id);
  let len = 0;
  for (const t of nums) if (t.length > len && str.startsWith(t)) len = t.length;
  return len ? `<mark class="hit">${str.slice(0, len)}</mark>${str.slice(len)}` : str;
}

// Names, station numbers and ALERT addresses as flat strings, built once per
// load. Used to answer "did this pasted term match anything at all?" without
// re-deriving every station's sensor list once per term on every keystroke.
function searchCorpus() {
  if (state.searchIdx) return state.searchIdx;
  const names = [], numbers = [], idPrefixes = new Set();
  (state.data?.stations || []).forEach(s => {
    names.push(s.name.toLowerCase());
    if (s.station_number) numbers.push(String(s.station_number).toLowerCase());
    // Every prefix of every address, so "is any address starting with 61 on
    // file?" is one lookup instead of a scan — a pasted log is mostly ids that
    // are on file, and those then cost nothing to confirm.
    stationAlertIds(s).forEach(id => {
      const str = String(id);
      for (let i = 1; i <= str.length; i++) idPrefixes.add(str.slice(0, i));
    });
  });
  state.searchIdx = { names, numbers, idPrefixes };
  return state.searchIdx;
}

// Which of the pasted terms are in no station's name, number or addresses?
// Pasting 40 ids off a log and being told 3 of them aren't in the database is
// the point of the exercise — a silently shorter list is not an answer. Only
// asked for an actual list (one term is just a search that found nothing, which
// the match note already says). Mirrors stationMatchesQuery's rules exactly.
function unmatchedSearchTerms(terms) {
  if (terms.length < 2 || !state.data) return [];
  const { names, numbers, idPrefixes } = searchCorpus();
  return terms.filter(t =>
    !(/^\d+$/.test(t) && idPrefixes.has(t)) &&
    !names.some(n => n.includes(t)) &&
    !numbers.some(n => n.includes(t)));
}

// The values a station offers to a grouped filter. A station with nothing
// recorded for the field answers with the FILTER_NONE bucket rather than an
// empty list, so "not recorded yet" is something the operator can tick, see a
// count for and deliberately exclude — instead of a silent disappearance.
function groupKeys(list) {
  return (Array.isArray(list) && list.length) ? list : [FILTER_NONE];
}

function stationRoleKeys(s)    { return groupKeys(s.roles); }
function stationNetworkKeys(s) { return groupKeys(s.radio_network_ids); }

function stationRegionKeys(s) {
  const regions = new Set();
  (s.catchment_ids || []).forEach(id => {
    const region = catchmentById(id)?.region;
    if (region) regions.add(region);
  });
  return regions.size ? [...regions] : [FILTER_NONE];
}

function stationSensorTypeKeys(s) {
  const types = new Set();
  stationSensors(s).forEach(se => { if (se && se.type) types.add(se.type); });
  return types.size ? [...types] : [FILTER_NONE];
}

// Does a station clear one grouped filter? An empty Set is the default and
// constrains nothing. `matchAll` is the sensor group's "must carry all of
// these" mode — otherwise any one ticked value is enough. FILTER_EMPTY is never
// among a station's keys, so a hand-emptied group matches nothing either way.
function groupMatches(set, keys, matchAll) {
  if (!set.size) return true;
  if (matchAll)  return [...set].every(v => keys.includes(v));
  return keys.some(k => set.has(k));
}

// A single-value filter ('' = any) against a field that may be blank; blank
// fields are only matched by the explicit FILTER_NONE option.
function valueMatches(want, value) {
  return !want || (value || FILTER_NONE) === want;
}

// filteredStations() is called several times per refresh (map layers, the
// table, the match-note chrome) — cheap to re-run once, wasteful across
// 3,000+ stations three times over. Cached against a signature of the
// filter selections themselves (not the stations), so the cache is only as
// large as what the operator has ticked, and stays correct across whichever
// function happens to mutate state.filters next.
let _filteredCache = null, _filteredCacheSig = null, _filteredCacheData = null;

function filtersSignature(f) {
  return JSON.stringify([
    f.search, f.enabledOnly, f.sensorsAll, f.basin, f.lga, f.hasCoords, f.hasAlertId,
    [...f.roles].sort(), [...f.networks].sort(), [...f.regions].sort(),
    [...f.catchments].sort(), [...f.sensors].sort(),
  ]);
}

function filteredStations() {
  if (!state.data) return [];
  const sig = filtersSignature(state.filters);
  if (_filteredCache && _filteredCacheData === state.data && _filteredCacheSig === sig) {
    return _filteredCache;
  }
  _filteredCache    = computeFilteredStations();
  _filteredCacheSig = sig;
  _filteredCacheData = state.data;
  return _filteredCache;
}

function computeFilteredStations() {
  const f = state.filters;
  const search = prepareSearch(f.search);
  return state.data.stations.filter(s => {
    if (f.enabledOnly && !s.enabled) return false;
    if (!stationMatchesSearch(s, search)) return false;
    // Each group is skipped outright when it isn't filtering — deriving a
    // station's regions or sensor types is not free across 3000+ stations on
    // every keystroke.
    if (f.roles.size      && !groupMatches(f.roles,      stationRoleKeys(s)))         return false;
    if (f.networks.size   && !groupMatches(f.networks,   stationNetworkKeys(s)))      return false;
    if (f.regions.size    && !groupMatches(f.regions,    stationRegionKeys(s)))       return false;
    if (f.catchments.size && !groupMatches(f.catchments, groupKeys(s.catchment_ids))) return false;
    if (f.sensors.size    && !groupMatches(f.sensors, stationSensorTypeKeys(s), f.sensorsAll)) return false;
    if (!valueMatches(f.basin, s.basin)) return false;
    if (!valueMatches(f.lga,   s.lga))   return false;
    if (f.hasCoords) {
      const located = s.lat != null && s.lon != null;
      if (located !== (f.hasCoords === 'yes')) return false;
    }
    if (f.hasAlertId) {
      const addressed = stationAlertIds(s).length > 0;
      if (addressed !== (f.hasAlertId === 'yes')) return false;
    }
    return true;
  });
}

// Catchment lookup, indexed once per loaded file — the region filter asks for
// one on every station on every keystroke, so a linear scan would show.
let _catchmentIdx = null, _catchmentIdxFor = null;
function catchmentById(id) {
  if (_catchmentIdxFor !== state.data) {
    _catchmentIdxFor = state.data;
    _catchmentIdx    = new Map((state.data?.catchments || []).map(c => [c.id, c]));
  }
  return _catchmentIdx.get(id);
}

// Every distinct ALERT id for a station, sorted ascending. Derived from the
// normalized sensor list (the enriched `sensors[]` when present, otherwise
// synthesized from the legacy `alert_ids` object — see stationSensors) so all
// of a station's addresses are shown, not just the single legacy value.
function stationAlertIds(s) {
  const ids = new Set();
  stationSensors(s).forEach(se => {
    if (se && se.alert_id != null) ids.add(se.alert_id);
  });
  return [...ids].sort((a, b) => a - b);
}

// ALERT ids grouped with their sensor type(s), sorted by id — for displays
// where the reading kind matters (e.g. map popups: "Rainfall — 6128"). Uses the
// normalized sensor list so battery / rainfall / water-level labels come through.
function stationAlertIdTypes(s) {
  const byId = new Map();
  stationSensors(s).forEach(se => {
    if (!se || se.alert_id == null) return;
    if (!byId.has(se.alert_id)) byId.set(se.alert_id, []);
    const types = byId.get(se.alert_id);
    if (se.type && !types.includes(se.type)) types.push(se.type);
  });
  return [...byId.entries()].sort((a, b) => a[0] - b[0]).map(([id, types]) => ({ id, types }));
}

// Kept as one fused loop on purpose: passRangeOrphans() runs this over every
// station × repeater × address on each keystroke of the Pass Ranges filter, and
// splitting the per-range test into its own function — however tidy — costs the
// tab ~70% more render time at this call volume. See passRangesHtml() for how
// the table names a single range without a second copy of this rule.
function passRangeCoversId(repeater, alertId) {
  if (!repeater || !Array.isArray(repeater.pass_ranges)) return false;
  const excl = repeater.exclusions || [];
  return repeater.pass_ranges.some(r =>
    alertId >= r.low && alertId <= r.high &&
    !excl.some(e => alertId >= e.low && alertId <= e.high)
  );
}

function primaryRole(s) {
  if (s.roles.includes('base'))     return 'base';
  if (s.roles.includes('repeater')) return 'repeater';
  return 'field';
}

// Repeaters are ~2-3% of the station list, but findRepeaterMatches used to be
// called once per field station and rescan every station each time. Caching
// the repeater-only subset (invalidated everywhere state.filterOpts is)
// turns that O(stations) scan into an O(repeaters) one.
function repeaterList(allStations) {
  if (!state.repeaterIdx) {
    state.repeaterIdx = allStations.filter(s => s.roles.includes('repeater') && s.repeater);
  }
  return state.repeaterIdx;
}

// Both directions of the pass-range relation, resolved in one pass over the
// station list and cached until the file changes (see refreshFilterOptions).
//
// Every caller used to rescan for itself: "which repeaters carry this station"
// was an O(repeaters) scan run once per station, and "which stations does this
// repeater carry" an O(stations) scan run once per repeater. Both walk the same
// AlertID-against-pass-range comparison, so one pass builds both lookups and
// every later question is a Map hit.
function passRelationIndex() {
  if (state.passRelIdx) return state.passRelIdx;
  // Nothing loaded yet: answer empty without caching, so the index (and the
  // repeater subset it builds on) is still built from the real file later.
  if (!state.data) return { byStation: new Map(), byRepeater: new Map(), addresses: [], passingAddr: new Map() };
  const stations  = state.data.stations;
  const repeaters = repeaterList(stations);
  const byStation  = new Map();   // station id  → repeaters carrying it
  const byRepeater = new Map();   // repeater id → field stations it carries
  const addrSet    = new Set();   // every distinct ALERT address in the network
  for (const r of repeaters) byRepeater.set(r.id, []);
  for (const s of stations) {
    const ids = stationAlertIds(s);
    if (!ids.length) continue;
    ids.forEach(id => addrSet.add(id));
    const isField = s.roles.includes('field');
    let carriers = null;
    for (const r of repeaters) {
      if (r.id === s.id) continue;
      if (!ids.some(id => passRangeCoversId(r.repeater, id))) continue;
      (carriers || (carriers = [])).push(r);
      if (isField) byRepeater.get(r.id).push(s);
    }
    if (carriers) byStation.set(s.id, carriers);
  }
  const addresses = [...addrSet].sort((a, b) => a - b);
  // Addresses carried per repeater: how many of the network's addresses fall
  // inside its open pass ranges (post-exclusion), regardless of which station
  // role owns the address. Distinct from byRepeater above, which counts field
  // *stations* — a station can own several addresses, so the two numbers
  // legitimately differ. Built here, once per file, for the same reason the
  // rest of this index exists (see the comment above).
  const passingAddr = new Map();
  for (const r of repeaters) {
    let n = 0;
    for (const id of addresses) if (passRangeCoversId(r.repeater, id)) n++;
    passingAddr.set(r.id, n);
  }
  state.passRelIdx = { byStation, byRepeater, addresses, passingAddr };
  return state.passRelIdx;
}

// Addresses a repeater carries — the primary "passing N" count shown wherever
// a repeater appears (see #83). Null when the repeater has no pass ranges
// recorded at all, so callers can tell "nothing configured" (show nothing)
// from "configured but carrying nothing" (show "passing 0" — a finding).
function repeaterPassingCount(station) {
  if (!station || !station.repeater) return null;
  const ranges = station.repeater.pass_ranges;
  if (!Array.isArray(ranges) || !ranges.length) return null;
  return passRelationIndex().passingAddr.get(station.id) ?? 0;
}

// Total addresses the repeater's ranges could carry (Σ high − low + 1), before
// exclusions and before any overlap with other repeaters — the denominator for
// the "how full is this repeater" utilisation figure on its editor card.
function repeaterPassRangeSpan(station) {
  return (station?.repeater?.pass_ranges || [])
    .reduce((sum, r) => sum + Math.max(0, r.high - r.low + 1), 0);
}

// The lists handed out below are the index's own arrays. Callers only read
// them, and copying ~3,100 of them per map refresh is exactly the cost the
// index exists to remove — so they are shared, not cloned.
function findRepeaterMatches(station) {
  return passRelationIndex().byStation.get(station.id) || [];
}

// Every pass-range path out of a set of field stations, with the length of each
// one. The map needs the same list twice — to draw the paths, and to work out
// which repeaters have to stay visible when the rest are hidden — so it is
// resolved once here. Stations without a position are skipped: a path needs two
// ends, and the same pair is never emitted twice however the sources overlap.
function passRangeLinks(sources) {
  const pairs = [];
  const seen  = new Set();
  for (const s of sources) {
    if (!s.roles.includes('field') || s.lat == null || s.lon == null) continue;
    for (const r of findRepeaterMatches(s)) {
      if (r.lat == null || r.lon == null) continue;
      const key = `${s.id}|${r.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ s, r, km: acmaHaversineKm(s.lat, s.lon, r.lat, r.lon) });
    }
  }
  return pairs;
}

function findStationMatches(repeater) {
  if (!repeater.repeater) return [];
  return passRelationIndex().byRepeater.get(repeater.id) || [];
}

// ── Related-by-pass-range stations ───────────────────────────────────────────
// Filtering for a station answers "where is it"; the question behind it is
// usually "who carries it". So while a filter is running the result set is
// extended with everything on the other end of a pass range: the repeaters
// carrying a matched field station, and the field stations carried by a matched
// repeater. The map and the table below it both read this one list, or they
// would disagree about what is on screen.
//
// Cached on the same terms as filteredStations(), plus the identity of the
// relation index — so an edited pass range drops it too.
const NO_RELATED = [];
let _relatedCache = null, _relatedCacheSig = null, _relatedCacheIdx = null;

function relatedStations() {
  if (!state.data || !state.mapRelated || !mapFilterActive()) return NO_RELATED;
  const idx = passRelationIndex();
  const sig = filtersSignature(state.filters);
  if (_relatedCache && _relatedCacheIdx === idx && _relatedCacheSig === sig) {
    return _relatedCache;
  }
  const matches = filteredStations();
  const already = new Set(matches.map(s => s.id));
  const out = [];
  for (const s of matches) {
    const related = s.roles.includes('repeater')
      ? findStationMatches(s).concat(findRepeaterMatches(s))
      : findRepeaterMatches(s);
    for (const r of related) {
      if (already.has(r.id)) continue;
      already.add(r.id);
      out.push(r);
    }
  }
  _relatedCache    = out;
  _relatedCacheSig = sig;
  _relatedCacheIdx = idx;
  return out;
}

// The same list as a Set, for the "is this row/pin related?" question the table
// and the map both ask per station. Rebuilt only when the list itself changes.
const _relatedIdSet = { list: null, ids: new Set() };

function relatedIdSet() {
  const related = relatedStations();
  if (_relatedIdSet.list !== related) {
    _relatedIdSet.list = related;
    _relatedIdSet.ids  = new Set(related.map(s => s.id));
  }
  return _relatedIdSet.ids;
}

// The list under the map: the filter's own matches, then what the pass ranges
// pulled in behind them — unless stations have been picked off the map, which
// overrides the lot until it is cleared (see the Map selection section).
function tableStations() {
  if (state.mapSelection.size) return selectedStations();
  const matches = filteredStations();
  const related = relatedStations();
  return related.length ? matches.concat(related) : matches;
}

// ── Side nav ───────────────────────────────────────────────────────────────────
// Everything that touches the nav lives here: the render, the tab switch, the
// collapse and its keyboard equivalent. Nothing else in the file reaches into
// #tab-nav.

function renderTabs() {
  const nav = document.getElementById('tab-nav');
  if (!nav) return;
  const collapsed = state.navCollapsed;
  nav.classList.toggle('collapsed', collapsed);
  syncNavChrome(collapsed);

  // The width transition must not run on the opening render. A tab builds its
  // Leaflet map the moment it renders, and a nav still sliding in from its
  // expanded default hands the map a container width that is wrong by however
  // far the slide had got — which Leaflet then caches. So the nav starts with
  // no transition, the collapsed width is forced to settle, and only then is
  // the animation allowed for the toggles that follow. The class is its own
  // flag — it survives every re-render, and needs no state of its own.
  if (!nav.classList.contains('nav-ready')) {
    void nav.offsetWidth;
    nav.classList.add('nav-ready');
  }

  // On a phone the nav is a drawer over the page, not a column beside it, so
  // the toggle at its top closes a menu rather than narrowing a rail — and has
  // to say so. Collapsed it is never seen there at all: the rail is gone and
  // the header's ☰ is what re-opens the drawer.
  const toggleWord = isPhoneNav()
    ? { icon: '✕', label: 'Close',                title: 'Close the menu' }
    : collapsed
      ? { icon: '»', label: 'Expand',   title: 'Expand the navigation' }
      : { icon: '«', label: 'Collapse', title: 'Collapse the navigation' };

  // Collapsed, the labels are clipped rather than removed: the button keeps its
  // accessible name, and the title attribute gives the sighted user a tooltip.
  const groups = TABS.map(g => `
    <div class="nav-group">
      <h2 class="nav-heading">${esc(g.group)}</h2>
      <ul class="nav-list">
        ${g.tabs.map(t => {
          const on = state.activeTab === t.id;
          return `
        <li>
          <button class="tab-btn${on ? ' active' : ''}" onclick="switchTab('${t.id}')"
                  ${on ? 'aria-current="page"' : ''} title="${esc(t.label)}">
            <span class="nav-icon" aria-hidden="true">${t.icon}</span>
            <span class="nav-label">${esc(t.label)}</span>
          </button>
        </li>`;
        }).join('')}
      </ul>
    </div>`).join('');

  nav.innerHTML = `
    <div class="nav-inner" onkeydown="navKey(event)">
      <button class="nav-toggle" onclick="toggleNav()" aria-controls="tab-nav"
              aria-expanded="${collapsed ? 'false' : 'true'}"
              title="${toggleWord.title}">
        <span class="nav-icon" aria-hidden="true">${toggleWord.icon}</span>
        <span class="nav-label">${toggleWord.label}</span>
      </button>
      ${groups}
    </div>`;
}

function switchTab(id) {
  // The Network View runs a force layout on an animation frame loop. Leaving the
  // tab is the moment it has to stop — a simulation ticking away behind another
  // tab is invisible, useless and costs a frame's work every frame. Its own init
  // starts it again when the tab comes back, so this is unconditional.
  NetworkView.stop();
  // The ARRO Data chart keeps a ResizeObserver on its stage, which the next
  // render replaces wholesale. Dropping it here stops the observer outliving
  // the element it was watching.
  ArroData.stop();
  // Same for the ALERT2 tab's coverage map: the div it was built on is about to
  // be discarded, and a Leaflet map holding a detached node keeps its tile
  // requests and window listeners alive behind whatever tab replaces it.
  Alert2.stop();
  state.activeTab = id;
  // On a phone the expanded nav is a drawer laid over the content rather than
  // a column beside it (see styles.css). Picking a tab is the end of that
  // errand, so the drawer closes behind you instead of covering what you came
  // for. No map to re-measure: the drawer never took the width in the first
  // place.
  if (!state.navCollapsed && isPhoneNav()) {
    state.navCollapsed = true;
    localStorage.setItem('mn-nav', 'collapsed');
  }
  renderTabs();
  renderMain();
}

// Below this width the icon rail is gone from the layout entirely and the nav
// is a drawer opened from the header — 56 px of permanent rail is a seventh of
// a 390 px screen, and the tables and maps need it more than the icons do.
// Kept in step with the matching breakpoint in styles.css.
function isPhoneNav() {
  return window.matchMedia('(max-width: 560px)').matches;
}

// The two bits of chrome that live outside #tab-nav and have to agree with it:
// the header's hamburger (the only way to open the drawer once the rail is
// gone) and the backdrop that closes it again.
function syncNavChrome(collapsed) {
  const burger = document.getElementById('btn-nav');
  if (burger) {
    burger.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    burger.classList.toggle('on', !collapsed);
  }
  const backdrop = document.getElementById('nav-backdrop');
  if (backdrop) backdrop.hidden = collapsed || !isPhoneNav();
}

function toggleNav() {
  setNavCollapsed(!state.navCollapsed);
}

function setNavCollapsed(collapsed) {
  state.navCollapsed = !!collapsed;
  localStorage.setItem('mn-nav', state.navCollapsed ? 'collapsed' : 'expanded');
  renderTabs();
  // The nav just took a column from the main area, or gave one back. Leaflet
  // only watches the window, so a map left unmeasured renders grey tiles and
  // hands back click coordinates offset by however much the width moved.
  // (Not on a phone — there the drawer floats and the main area never moves.)
  if (!isPhoneNav()) invalidateMapSizes(NAV_TRANSITION_MS + 40);
  // Focus follows the button through the re-render, or a keyboard collapse
  // drops the user back at the top of the page. Closing the phone drawer sends
  // focus back to the hamburger that opened it — the drawer's own toggle has
  // just gone off-screen with the rail.
  const btn = (isPhoneNav() && state.navCollapsed)
    ? document.getElementById('btn-nav')
    : document.querySelector('#tab-nav .nav-toggle');
  if (btn) btn.focus();
}

// Every Leaflet map the app holds open. They are created lazily per tab, so
// most of these are null most of the time.
function invalidateMapSizes(delay) {
  setTimeout(() => {
    [state.map, state.bfMap, state.a2.map, state.wb && state.wb.map].forEach(m => {
      if (m) { try { m.invalidateSize(); } catch (_) {} }
    });
  }, delay || 0);
}

// Up and down walk the tabs, ignoring the group headings — the list reads as
// one column, so it should drive as one column.
function navKey(e) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const btns = [...document.querySelectorAll('#tab-nav .tab-btn')];
  const i    = btns.indexOf(document.activeElement);
  if (i < 0) return;
  const next = btns[(i + (e.key === 'ArrowDown' ? 1 : btns.length - 1)) % btns.length];
  if (next) { next.focus(); e.preventDefault(); }
}

// ── Main content dispatcher ────────────────────────────────────────────────────

function renderMain() {
  const el = document.getElementById('main-content');
  if (!el) return;
  // The ARRO launcher joins these because its raw-id box works with no file
  // loaded at all — only the station search needs stations.json, and it says so.
  // ARRO Data joins them too: a dropped CSV parses and plots on its own, and
  // only the link back to a station needs the station file.
  const noDataTabs = ['packets', 'alert2', 'maps', 'serial', 'arro', 'arrodata'];
  if (!state.data && !noDataTabs.includes(state.activeTab)) { el.innerHTML = renderEmpty(); return; }
  switch (state.activeTab) {
    case 'stations':   el.innerHTML = renderStationsHtml();  initStationFilters(); initMap(); break;
    case 'maps':       el.innerHTML = Maps.render();          Maps.init();         break;
    case 'networks':   el.innerHTML = renderNetworksHtml();               break;
    case 'passranges': el.innerHTML = renderPassRangesHtml();             break;
    case 'rf':         el.innerHTML = renderRfHtml();        initRf();    break;
    case 'rfchanges':  el.innerHTML = renderRfcHtml();       initRfc();   break;
    case 'workbench':  el.innerHTML = renderWorkbenchHtml(); initWb();    break;
    case 'bitflipper': el.innerHTML = renderBitFlipperHtml(); initBitFlipperMap(); break;
    case 'network':    el.innerHTML = NetworkView.render();  NetworkView.init();  break;
    case 'packets':    el.innerHTML = Packets.render();       Packets.init();      break;
    case 'alert2':     el.innerHTML = Alert2.render();        Alert2.init();       break;
    case 'serial':     el.innerHTML = Serial.render();        Serial.init();       break;
    case 'arro':       el.innerHTML = renderArroHtml();      initArro();  break;
    case 'arrodata':   el.innerHTML = ArroData.render();     ArroData.init();     break;
    case 'export':     el.innerHTML = renderExportHtml();     initExport();     break;
    default:           el.innerHTML = '<p style="padding:1rem">Unknown tab</p>';
  }
  updateChromeHeight();     // the Stations panes size themselves off it
}

// ── Empty state ────────────────────────────────────────────────────────────────

function renderEmpty() {
  return `
    <div style="max-width:600px;margin:3rem auto;padding:1rem">
      <div class="panel" style="text-align:center;padding:2.5rem 2rem">
        <h2 style="margin:0 0 .75rem">No data loaded</h2>
        <p style="color:var(--muted)">Load a <strong>stations.json</strong> file to get started.
          If you haven't created one yet, use the
          <a href="migrate.html">Migration Tool</a> to convert your existing CSVs.</p>
        <div style="margin-top:1.25rem">
          <button class="primary" onclick="document.getElementById('file-input').click()">
            Load stations.json
          </button>
        </div>
      </div>
    </div>`;
}

// ── STATIONS tab (map + station list + editor) ─────────────────────────────────
// One page: the filter pane on the left drives both the map at the top and the
// station table underneath it, so a filter narrows what is plotted and what is
// listed in the same action.

function renderStationsHtml() {
  const stations = tableStations();
  return `
    <div class="layout map-layout">
      <aside class="sidebar stack map-pane" id="stations-left">
        <div class="panel filter-panel" id="station-filters">
          ${stationFiltersHtml()}
        </div>
        <div class="panel">
          <div class="panel-header"><h3>Map display</h3></div>
          <div class="filter-block" id="map-display-block">
            ${mapDisplayControlsHtml()}
          </div>
          <div class="filter-block">
            ${acmaFilterBlockHtml()}
          </div>
        </div>
        <div class="panel" id="map-draw-panel">
          ${MapDraw.panelHtml()}
        </div>
        <div class="panel">
          <div class="map-legend" id="map-legend">${mapLegendHtml()}</div>
        </div>
      </aside>
      <div class="map-split" id="stations-split" role="separator" aria-orientation="vertical"
           aria-label="Resize the filter pane" tabindex="0" title="Drag to resize · double-click to reset"
           onpointerdown="splitDragStart(event)" ondblclick="setSplitWidth(320,true)"
           onkeydown="splitKey(event)"></div>
      <div class="stack map-pane" id="stations-right">
        <div class="panel" style="padding:.6rem;position:relative">
          <div id="leaflet-map"></div>
          <div id="map-note" class="map-note" hidden></div>
          <div id="acma-card" class="acma-card" hidden></div>
        </div>
        <div class="panel" id="path-profile-panel" hidden></div>
        <div class="panel" id="link-budget-panel">${LinkBudget.panelHtml()}</div>
        <div class="panel">
          <div class="panel-header">
            <h2>Stations <span class="badge" id="st-count">${stations.length}</span></h2>
            <button onclick="editorNew()">+ New</button>
          </div>
          <div class="table-wrap tall" id="stations-table-wrap">
            ${stationsTable(stations)}
          </div>
        </div>
        <div class="panel" id="stations-editor-card">
          ${renderStationEditorCard()}
        </div>
      </div>
    </div>`;
}

// ── Stations tab: the two panes ──────────────────────────────────────────────
// The filter pane and the map/table column are both taller than the screen, and
// while the page scrolled as one piece, reaching a filter at the bottom of the
// sidebar scrolled the map out of sight. Each column now fills the space under
// the header and scrolls inside itself, and the divider between them drags to
// re-split the width.

// How much vertical room the header takes. Measured rather than assumed: its
// title and its row of buttons wrap on a narrow window, and the panes size
// themselves off what's left. The nav used to be counted here too; it sits
// beside the main area now, so it costs the panes no height at all.
function updateChromeHeight() {
  const hdr = document.querySelector('header');
  const bar = document.getElementById('mem-bar');
  const h = (hdr ? hdr.offsetHeight : 0) + (bar && !bar.hidden ? bar.offsetHeight : 0);
  document.documentElement.style.setProperty('--mn-chrome', `${h}px`);
}

// `save` is left off while a drag is in flight — the width is written once the
// operator lets go, not sixty times a second.
function setSplitWidth(px, save) {
  state.splitW = Math.round(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, px)));
  document.documentElement.style.setProperty('--mn-split', `${state.splitW}px`);
  if (save) localStorage.setItem('mn-split', state.splitW);
}

function splitDragStart(e) {
  const bar    = e.currentTarget;
  const layout = bar.parentElement;
  if (!layout) return;
  const left = layout.getBoundingClientRect().left;
  bar.classList.add('dragging');
  bar.setPointerCapture(e.pointerId);
  const move = ev => setSplitWidth(ev.clientX - left);
  const done = () => {
    bar.classList.remove('dragging');
    bar.removeEventListener('pointermove', move);
    bar.removeEventListener('pointerup', done);
    bar.removeEventListener('pointercancel', done);
    setSplitWidth(state.splitW, true);
    // The map just changed width underneath Leaflet, which only watches the window.
    if (state.map) state.map.invalidateSize();
  };
  bar.addEventListener('pointermove', move);
  bar.addEventListener('pointerup', done);
  bar.addEventListener('pointercancel', done);
  e.preventDefault();
}

// Keyboard equivalent of the drag, so the split isn't mouse-only.
function splitKey(e) {
  const step = e.shiftKey ? 48 : 16;
  if (e.key === 'ArrowLeft')       setSplitWidth(state.splitW - step, true);
  else if (e.key === 'ArrowRight') setSplitWidth(state.splitW + step, true);
  else if (e.key === 'Home')       setSplitWidth(320, true);
  else return;
  e.preventDefault();
  if (state.map) state.map.invalidateSize();
}

// ── Map display block ────────────────────────────────────────────────────────

// Past this the slider is measuring nothing real — no pass-range hop on this
// network reaches it. "Kill spaghetti" off is the escape hatch for the operator
// who wants every path drawn however absurd, so the cap can stay this tight.
const MAX_LINK_KM_CAP = 600;

function mapDisplayControlsHtml() {
  const on = state.mapKillSpaghetti;
  return `
    <label class="filter-check">
      <input type="checkbox" ${state.mapHideOthers ? 'checked' : ''}
             onchange="state.mapHideOthers=this.checked;refreshMapLayers()">
      Hide stations that don't match
    </label>
    <label class="filter-check">
      <input type="checkbox" ${state.mapRelated ? 'checked' : ''}
             onchange="state.mapRelated=this.checked;stationsFilterChanged()">
      Include related repeaters
    </label>
    <label class="filter-check">
      <input type="checkbox" ${state.mapShowLinks ? 'checked' : ''}
             onchange="state.mapShowLinks=this.checked;rerenderMapDisplayControls();refreshMapLayers()">
      Show signal links
    </label>
    <label class="filter-range${state.mapShowLinks ? '' : ' is-off'}">
      <span>Link opacity <strong id="link-opacity-val">${Math.round(state.mapLinkOpacity * 100)}%</strong></span>
      <input type="range" min="0.1" max="1" step="0.05" value="${state.mapLinkOpacity}"
             ${state.mapShowLinks ? '' : 'disabled'}
             oninput="document.getElementById('link-opacity-val').textContent=Math.round(this.value*100)+'%'"
             onchange="setMapLinkOpacity(+this.value)">
    </label>
    <label class="filter-check">
      <input type="checkbox" ${on ? 'checked' : ''}
             onchange="state.mapKillSpaghetti=this.checked;rerenderMapDisplayControls();refreshMapLayers()">
      Kill spaghetti
    </label>
    <label class="filter-range${on ? '' : ' is-off'}">
      <span>Max TX distance <strong id="max-tx-val">${state.mapMaxLinkKm} km</strong></span>
      <input type="range" min="0" max="${MAX_LINK_KM_CAP}" step="10" value="${state.mapMaxLinkKm}"
             ${on ? '' : 'disabled'}
             oninput="document.getElementById('max-tx-val').textContent=this.value+' km'"
             onchange="state.mapMaxLinkKm=+this.value;refreshMapLayers()">
    </label>
    <label class="filter-check">
      <input type="checkbox" ${state.mapRivers ? 'checked' : ''}
             onchange="MapRivers.setEnabled(this.checked)">
      Highlight matching rivers
    </label>
    <p class="filter-note" id="map-river-note">${MapRivers.noteHtml()}</p>
    <label class="filter-field" style="margin-top:.5rem">
      <span>Station names</span>
      <select onchange="setMapLabelMode(this.value)">
        ${[['auto', 'Auto — when few enough are in view'],
           ['on',   'On'],
           ['off',  'Off']].map(([v, l]) =>
          `<option value="${v}" ${state.mapLabelMode === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </label>
    <p class="filter-note" id="map-link-note">${mapLinkNoteHtml()}</p>`;
}

function rerenderMapDisplayControls() {
  const el = document.getElementById('map-display-block');
  if (el) el.innerHTML = mapDisplayControlsHtml();
}

// What the link controls are actually doing. Counted on the last refresh so the
// note survives a re-render of the pane.
function mapLinkNoteHtml() {
  const { drawn, culled } = state.mapLinkCount;
  if (!state.mapShowLinks) return 'Signal links are hidden.';
  const links = n => `${n} link${n === 1 ? '' : 's'}`;
  if (!state.mapKillSpaghetti) {
    return `${links(drawn)} drawn — every pass-range path, however long.`;
  }
  return culled
    ? `${links(drawn)} drawn · <strong>${culled}</strong> over ${state.mapMaxLinkKm} km hidden.`
    : `${links(drawn)} drawn · none over ${state.mapMaxLinkKm} km.`;
}

function mapLegendHtml() {
  return `
    ${Object.entries(ROLE_LABEL).map(([k, v]) => `
      <span class="legend-item">
        <span class="legend-dot" style="background:${ROLE_COLOR[k]}"></span>
        <span class="small">${v}</span>
      </span>`).join('')}
    <span class="legend-item">
      <span class="legend-dot legend-dot-hit" style="background:${ROLE_COLOR.field}"></span>
      <span class="small">Matches filter</span>
    </span>
    <span class="legend-item">
      <span class="legend-dot legend-dot-rel" style="background:${ROLE_COLOR.repeater}"></span>
      <span class="small">Related by pass range</span>
    </span>
    <span class="legend-item">
      <span class="legend-line"></span>
      <span class="small">Pass-range link</span>
    </span>
    ${MapRivers.active() ? `
    <span class="legend-item">
      <span class="legend-line legend-line-river"></span>
      <span class="small">Matching watercourse (OpenStreetMap)</span>
    </span>` : ''}
    ${state.filters.acma.show ? Object.entries(ACMA_MECH).map(([k, m]) => `
      <span class="legend-item">
        <span class="legend-sq" style="background:${m.color}"></span>
        <span class="small">${m.label}</span>
      </span>`).join('') + `
    <span class="legend-item"><span class="small" style="color:var(--muted)">ACMA RRL data (CC BY 4.0)${state.acma.threats ? ' · ' + esc(state.acma.threats.meta.source_date) : ''}</span></span>` : ''}`;
}

function rerenderMapLegend() {
  const el = document.getElementById('map-legend');
  if (el) el.innerHTML = mapLegendHtml();
}

// A short-lived note over the map (location errors, label caps). Empty clears it.
function mapNote(msg, ms) {
  const el = document.getElementById('map-note');
  if (!el) return;
  clearTimeout(mapNote._t);
  if (!msg) { el.hidden = true; el.textContent = ''; return; }
  el.textContent = msg;
  el.hidden = false;
  if (ms) mapNote._t = setTimeout(() => { el.hidden = true; el.textContent = ''; }, ms);
}

// A filter change on the Stations tab drives both halves of the page: the map
// re-highlights (or re-hides) its pins and the table below it re-lists. The
// filter panel's own summaries follow, so it always says what it is doing.
function stationsFilterChanged() {
  state.stationsShowAll = false;   // a changed filter earns a fresh row cap
  refreshMapLayers();
  MapRivers.sync();                // additive: rivers never touch what matched
  rerenderStations();
  updateFilterChrome();
}

// Typing in the search box rebuilds every marker and every table row, so hold
// off until the user pauses. The sidebar is never re-rendered from here — the
// input keeps focus.
function mapSearchInput(value) {
  state.filters.search = value;
  clearTimeout(state.mapSearchTimer);
  state.mapSearchTimer = setTimeout(stationsFilterChanged, 160);
}

// ── Base map layers ─────────────────────────────────────────────────────────
// Fresh tile-layer instances for the shared base-map set. A Leaflet layer can
// only live on one map at a time, so every map gets its own instances. The
// first entry (OSM-Topo) is the default base layer.
function makeBaseLayers() {
  return {
    'OSM-Topo': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      attribution: 'Map data: © OpenStreetMap contributors, SRTM | Style: © OpenTopoMap (CC-BY-SA)',
      maxZoom: 17,
    }),
    'OpenStreetMap': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors', maxZoom: 19,
    }),
    'Satellite': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
      maxZoom: 19,
    }),
  };
}

// Add the shared base-layer set to a map, switch it to the default (OSM-Topo)
// and drop a base-map picker in the top-right corner.
function addBaseLayers(map) {
  const layers = makeBaseLayers();
  const [, defaultLayer] = Object.entries(layers)[0];
  defaultLayer.addTo(map);
  L.control.layers(layers, null, { position: 'topright' }).addTo(map);
  return layers;
}

function initMap() {
  if (state.map) { state.map.remove(); state.map = null; state.mapMarkers = []; state.mapLines = []; }
  // The old map (if any) owned these layer groups — they die with it.
  state.acma.layer = state.acma.beamLayer = state.acma.linkLayer = state.acma.hiLayer = null;
  MapLocate.detach();
  MapDraw.detach();
  LinkBudget.detach();
  MapRivers.detach();
  const el = document.getElementById('leaflet-map');
  if (!el) return;
  // preferCanvas: with ~3,174 station pins and ~3,141 pass-range link lines,
  // the default SVG renderer means ~6,300 SVG nodes rebuilt on every refresh.
  // A single canvas element instead.
  state.map = L.map('leaflet-map', { preferCanvas: true });
  // A view before anything is added to the map. Leaflet defers every layer add
  // until the map has one, and the deferred adds then run in an order nothing
  // controls: a path registers the shared SVG renderer as it is queued, so a
  // layer group queued earlier can be drawn against a renderer that has not
  // been set up yet. It is replaced by the fit below on the same tick.
  state.map.setView(MAP_HOME, 4);
  state.mapFitKey = null;              // a fresh map always fits its contents once
  addBaseLayers(state.map);
  MapSpider.attach(state.map);
  MapLocate.attach(state.map);
  MapDraw.attach(state.map);
  LinkBudget.attach(state.map);
  // Before the first refresh, so the fit that refresh performs is the view the
  // first river lookup is bounded by.
  MapRivers.attach(state.map);
  // Shapes survive a tab switch, so a line drawn earlier still has a profile to
  // show on the map that has just been rebuilt.
  PathProfile.sync();
  state.map.on('click', () => acmaClearHighlight());
  // Auto/On name labels are picked from what is in view, so they are re-picked
  // whenever the view changes rather than only when the layers are rebuilt.
  state.map.on('moveend zoomend', applyMapLabels);
  refreshMapLayers();
  refreshAcmaLayer();
  // ACMA transmitters are on by default, so the first visit to the map pulls the
  // core data in. Panels that gain content once it lands are refreshed in place
  // rather than by re-rendering the tab, which would throw away the map view.
  if (state.filters.acma.show && !state.acma.loaded && !state.acma.loading) {
    acmaEnsureCore()
      .then(() => { if (state.activeTab === 'stations' && state.map) acmaAfterLoad(); })
      .catch(() => rerenderAcmaFilterBlock());
  }
}

// Panels that depend on loaded ACMA data, refreshed without rebuilding the tab.
function acmaAfterLoad() {
  refreshAcmaLayer();
  rerenderAcmaFilterBlock();
  rerenderMapLegend();
}

// ── Map filter behaviour ─────────────────────────────────────────────────────
// The filter box no longer removes anything: every station stays on the map and
// the ones that match are ringed, labelled and zoomed to. "Hide stations that
// don't match" puts the old subtractive behaviour back.

const MAP_LABEL_CAP = 60;     // permanent name labels beyond this are unreadable
const MAP_PIN_RING  = '#ffffff';
const MAP_PIN_HIT   = '#ffc400';
const MAP_PIN_REL   = '#00b8d4';   // dashed ring: on the map by relation, not by name
const MAP_PIN_SEL   = '#7c4dff';   // heavy ring: hand-picked into the map selection.
                                   // Violet is none of the role fills, none of the
                                   // ACMA colours, and neither the amber of a filter
                                   // match nor the cyan of a pass-range relation.
const MAP_HOME      = [-25.6, 134.3];   // middle of Australia — the opening view,
                                        // replaced by a fit to whatever is plotted

// Is any station filter narrowing things down? Every grouped filter keeps its
// Set canonical (empty when everything is ticked), so "not empty" already means
// "narrowing" — see toggleGroupFilter.
function mapFilterActive() {
  return anyStationFilterActive();
}

function mapMatchNoteHtml() {
  if (!state.data) return '';
  const total = state.data.stations.length;
  if (!mapFilterActive()) return `Showing all <strong>${total}</strong> stations.`;
  const matched = filteredStations();
  if (!matched.length) return 'No stations match — all pins shown unhighlighted.';
  const located = matched.filter(s => s.lat != null && s.lon != null).length;
  const related = relatedStations().length;
  return `<strong>${matched.length}</strong> of ${total} stations match` +
         (related ? ` · <strong>${related}</strong> more via pass range` : '') +
         (located < matched.length ? ` · ${matched.length - located} without a position` : '') +
         (located > MAP_LABEL_CAP ? ` · labels on the closest ${MAP_LABEL_CAP}` : '');
}

function updateMapMatchNote() {
  const el = document.getElementById('map-match-note');
  if (el) el.innerHTML = mapMatchNoteHtml();
}

function updateMapLinkNote() {
  const el = document.getElementById('map-link-note');
  if (el) el.innerHTML = mapLinkNoteHtml();
}

// Signature of the extent last auto-fitted. Refreshes that don't change what
// the map should be looking at (theme switch, link toggle, ACMA options) leave
// the operator's pan and zoom alone.
function mapFitKey(points) {
  if (!points.length) return 'none';
  let n = Infinity, s = -Infinity, w = Infinity, e = -Infinity;
  for (const [lat, lon] of points) {
    if (lat < n) n = lat; if (lat > s) s = lat;
    if (lon < w) w = lon; if (lon > e) e = lon;
  }
  return [points.length, n, s, w, e].map(v => Number(v).toFixed(4)).join(',');
}

// A pass-range line is drawn twice: a wide white casing underneath and the
// coloured line on top. On satellite and topo tiles a single 1.5 px orange line
// disappears into the imagery; the casing is what carries it on every basemap.
const MAP_LINK_CASING_W  = 3.5;
const MAP_LINK_CORE_W    = 1.5;
const MAP_LINK_CASING_MIX = 0.75;   // casing opacity, as a fraction of the core's

// `skipFit` clears the fit for this refresh while still recording the extent it
// would have fitted, so the map holds the operator's pan and zoom and the next
// genuine change still moves it. See clearStationFilters.
function refreshMapLayers({ skipFit = false } = {}) {
  const map = state.map;
  if (!map || !state.data) return;
  MapSpider.reset();                       // pins go home before any are replaced
  state.mapMarkers.forEach(m => m.remove());
  state.mapLines.forEach(l => l.remove());
  state.mapMarkers = [];
  state.mapLines   = [];

  const located  = state.data.stations.filter(s => s.lat != null && s.lon != null);
  const active   = mapFilterActive();
  const matchIds = active ? new Set(filteredStations().map(s => s.id)) : null;
  const matched  = active ? located.filter(s => matchIds.has(s.id)) : [];
  // Stations on the map because a pass range links them to a match, not because
  // they matched the filter themselves. Drawn as hits, ringed differently.
  const relIds   = active ? relatedIdSet() : null;
  const related  = active ? located.filter(s => relIds.has(s.id)) : [];

  // Links follow the highlight: with a filter running, only the matched and
  // related stations draw theirs, so the lines don't bury the pins they're meant
  // to explain. They are resolved before the pins because in hide mode they
  // decide which repeaters have to stay on the map.
  const allLinks = state.mapShowLinks
    ? passRangeLinks(active ? matched.concat(related) : located) : [];
  const maxKm = state.mapKillSpaghetti ? state.mapMaxLinkKm : Infinity;
  const links = allLinks.filter(l => l.km <= maxKm);
  state.mapLinkCount = { drawn: links.length, culled: allLinks.length - links.length };
  updateMapLinkNote();

  // Highlight mode keeps every pin on the map; hide mode drops the rest —
  // except the repeaters at the far end of a drawn path. Hiding those left the
  // TX path on screen with nothing at the end of it: the one station the
  // operator most wants to see is the one the signal is going to.
  let stations = (active && state.mapHideOthers) ? matched.concat(related) : located;
  if (active && state.mapHideOthers && links.length) {
    const shown = new Set(stations.map(s => s.id));
    const kept  = [];
    for (const l of links) if (!shown.has(l.r.id)) { shown.add(l.r.id); kept.push(l.r); }
    if (kept.length) stations = stations.concat(kept);
  }
  updateMapMatchNote();
  if (!stations.length) { MapSpider.setPins('stations', []); state.mapMatchLabels = new Set(); return; }

  // A filter's matches are always named — that is what the filter was for —
  // while the set is small enough to read; the nearest to the matched extent
  // win. Everything else is named off the viewport, in applyMapLabels.
  state.mapMatchLabels = new Set(
    active && matched.length
      ? (matched.length <= MAP_LABEL_CAP ? matched : mapNearestToCentre(matched, MAP_LABEL_CAP))
          .map(s => s.id)
      : []);

  const lineColor = getComputedStyle(document.documentElement)
    .getPropertyValue('--map-line').trim() || '#ff6f00';
  const coreOp   = state.mapLinkOpacity;
  const casingOp = coreOp * MAP_LINK_CASING_MIX;

  // Every casing first, then every core: pairing them per link would let one
  // link's white casing paint over another link's coloured line where they cross.
  for (const pass of ['casing', 'core']) {
    const casing = pass === 'casing';
    for (const l of links) {
      const line = L.polyline([[l.s.lat, l.s.lon], [l.r.lat, l.r.lon]], {
        color:   casing ? '#ffffff' : lineColor,
        weight:  casing ? MAP_LINK_CASING_W : MAP_LINK_CORE_W,
        opacity: casing ? casingOp : coreOp,
      }).addTo(map);
      line.mnLinkRole = pass;              // lets the opacity slider restyle in place
      state.mapLines.push(line);
    }
  }

  for (const s of stations) {
    const role   = primaryRole(s);
    const color  = ROLE_COLOR[role] || ROLE_COLOR.field;
    const isRpt  = s.roles.includes('repeater');
    const hit    = active && matchIds.has(s.id);
    const rel    = active && !hit && relIds.has(s.id);
    const dim    = active && !hit && !rel;
    const radius = (isRpt ? 8 : 5) + (hit || rel ? 1 : 0);
    // Every pin carries a white ring so it separates from the base map and from
    // its neighbours; matches swap it for amber, and stations pulled in by a
    // pass range for a dashed cyan one — full opacity either way, but you can
    // still tell which of them the filter actually named.
    //
    // That style is kept on the marker as well, so the map selection's own ring
    // can be put on and taken off with setStyle rather than by rebuilding
    // ~3,174 markers — and so it survives the canvas renderer, which draws no
    // DOM node for a className to land on.
    const base = {
      radius,
      color:       hit ? MAP_PIN_HIT : rel ? MAP_PIN_REL : MAP_PIN_RING,
      weight:      hit || rel ? 3 : 2,
      dashArray:   rel ? '4,3' : null,
      opacity:     dim ? 0.6 : 1,
      fillOpacity: dim ? 0.45 : 1,
    };
    const marker = L.circleMarker([s.lat, s.lon], {
      ...base,
      fillColor:   color,
      className:   hit ? 'mn-pin mn-pin-hit' : rel ? 'mn-pin mn-pin-rel' : 'mn-pin',
      bubblingMouseEvents: false,          // a pin click is not an empty-map click
    }).addTo(map);
    marker.mnStationId = s.id;             // lets the table below find its pin
    marker.mnStation   = s;                // and lets labels be re-picked on pan
    marker.mnRadius    = radius;
    marker.mnBaseStyle = base;

    // bindPopup takes a function so the HTML is built when the popup opens,
    // not for all ~3,174 markers on every refresh.
    marker.bindPopup(() => {
      const idTypes = stationAlertIdTypes(s);
      const arroUrl = arroSiteUrl(arroSiteId(s));
      return `
      <strong>${esc(s.name)}</strong><br>
      ${s.roles.map(r => `<span style="background:${ROLE_COLOR[r]};color:#fff;padding:1px 5px;border-radius:999px;font-size:.78rem;margin-right:2px">${r}</span>`).join('')}<br>
      ${s.roles.includes('repeater') && repeaterPassingCount(s) != null
        ? `<span style="font-size:.83rem">passing ${repeaterPassingCount(s)}</span><br>` : ''}
      ${s.station_number ? `<span style="font-size:.83rem">Stn #${esc(s.station_number)}</span><br>` : ''}
      ${idTypes.length ? `<span style="font-size:.83rem">AlertID:</span><br>${idTypes.map(t =>
        `<span style="font-size:.82rem">&nbsp;&nbsp;${t.types.length ? esc(t.types.join(' / ')) + ' — ' : ''}${t.id}</span>`).join('<br>')}<br>` : ''}
      ${s.elevation_ahd != null ? `<span style="font-size:.83rem">Elev: ${s.elevation_ahd} m AHD</span>` : ''}
      ${acmaRepeaterPopupExtra(s)}
      <div class="mn-popup-actions">
        <a href="#" onclick="focusStation('${escAttr(s.id)}');return false"
           title="Select this station in the list under the map">Show in the list below ↓</a>
        ${arroUrl ? `<a href="${esc(arroUrl)}" target="_blank" rel="noopener"
           title="ARRO site ${esc(arroSiteId(s))} — the telemetry admin page for this station"
           >Open in ARRO admin ↗</a>` : ''}
        ${mapLinksHtml(s)}
      </div>
    `;
    });
    // Leaflet opens a bound popup on every click of its layer. Take that over,
    // so a modifier-click can mean "put this in the selection" without a popup
    // opening and closing again — a closed popup leaves its container fading
    // over the map for another 200 ms, which is long enough to swallow the next
    // click. Removing the handler leaves the binding itself intact, so
    // openPopup() and isPopupOpen() go on working everywhere else.
    marker.off('click', marker._openPopup);
    marker.on('click', onStationPinClick);
    state.mapMarkers.push(marker);
  }

  applyMapSelectionStyles();
  MapSpider.setPins('stations', state.mapMarkers);

  // Zoom to the matches (all of them, not just the first) and to the repeaters
  // pulled in behind them — a path with its far end off-screen explains
  // nothing. Or to everything, when no filter is running.
  const fitSet = active && matched.length ? matched.concat(related) : stations;
  const fitTo  = fitSet.map(s => [s.lat, s.lon]);
  const key    = mapFitKey(fitTo);
  if (fitTo.length && key !== state.mapFitKey) {
    state.mapFitKey = key;
    // The extent is recorded either way, so a suppressed fit is skipped once
    // rather than deferred to the next refresh that happens along.
    if (!skipFit) map.fitBounds(fitTo, { padding: [24, 24], maxZoom: fitTo.length === 1 ? 14 : 12 });
  }
  applyMapLabels();
}

// ── Map selection ────────────────────────────────────────────────────────────
// A set of stations picked off the map, by drawing a shape around them or by
// modifier-clicking their pins. It is a third thing alongside the filters and
// `state.selectedId`: the filters decide what the map highlights, `selectedId`
// is the single station the editor card is on, and this is the operator's own
// pick. While it is non-empty it overrides what the table lists — a display
// override, not a filter mutation, so clearing it hands the list straight back
// to the filter.
//
// Session state, like the drawings: nothing is saved and nothing goes in the URL.

function selectedStations() {
  if (!state.data || !state.mapSelection.size) return [];
  return state.data.stations.filter(s => state.mapSelection.has(s.id));
}

// Put the selected ring on, or take it off, in place. Only the pins whose
// membership actually changed are restyled.
function applyMapSelectionStyles() {
  for (const m of state.mapMarkers) {
    const base = m.mnBaseStyle;
    if (!base) continue;
    const on = state.mapSelection.has(m.mnStationId);
    if (on === !!m.mnSelected) continue;
    m.mnSelected = on;
    m.mnRadius   = on ? base.radius + 3 : base.radius;
    m.setStyle(on
      ? { radius: m.mnRadius, color: MAP_PIN_SEL, weight: 4,
          dashArray: null, opacity: 1, fillOpacity: 1 }
      : { ...base });
  }
}

// Everything that changes the selection ends here: the pins, the list under the
// map and its header all move together.
function mapSelectionChanged() {
  applyMapSelectionStyles();
  rerenderStations();
}

function toggleMapSelection(id) {
  if (state.mapSelection.has(id)) state.mapSelection.delete(id);
  else                            state.mapSelection.add(id);
  mapSelectionChanged();
}

// Additive: two boxes drawn over two regions give one selection holding both.
// Returns how many ids were new, which is what the caller reports.
function addToMapSelection(ids) {
  let added = 0;
  for (const id of ids) if (!state.mapSelection.has(id)) { state.mapSelection.add(id); added++; }
  mapSelectionChanged();
  return added;
}

function clearMapSelection() {
  if (!state.mapSelection.size) return;
  state.mapSelection.clear();
  mapSelectionChanged();
}

// Every click on a station pin: shift / ctrl / ⌘ adds or removes it from the
// selection, and a plain click opens the popup, as it always did. Both live
// here because refreshMapLayers takes Leaflet's own click-to-open off the
// marker — see the note there.
function onStationPinClick(e) {
  const oe = e.originalEvent;
  if (oe && (oe.shiftKey || oe.ctrlKey || oe.metaKey)) {
    L.DomEvent.stop(e);
    toggleMapSelection(e.target.mnStationId);
    return;
  }
  L.DomEvent.stopPropagation(e);      // as Leaflet's own handler did
  e.target.openPopup(e.latlng);
}

// The selection as a file — the same columns the table shows, plus the station
// id, so the picked set can leave the page for a spreadsheet.
function exportMapSelection() {
  const rows = selectedStations();
  if (!rows.length) return;
  const lines = ['id,name,station_number,roles,networks,alert_ids,lat,lon,elevation_ahd,enabled'];
  for (const s of rows) {
    lines.push([
      csvEscape(s.id),
      csvEscape(s.name),
      csvEscape(s.station_number || ''),
      csvEscape(s.roles.join(' ')),
      csvEscape((s.radio_network_ids || []).map(id => netName(id)).join(' | ')),
      csvEscape(stationAlertIds(s).join(' ')),
      s.lat ?? '', s.lon ?? '', s.elevation_ahd ?? '', s.enabled ? 1 : 0,
    ].join(','));
  }
  dlText(`meganet-selection-${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\n'));
}

// ── Station name labels ──────────────────────────────────────────────────────
// Which pins carry a permanent name, for the current mode and viewport. Auto
// shows them once the view holds few enough to read — at the national view that
// is ~3,100 stations, so they stay off until you zoom into a region.

// Whether the cap was reported last time, so panning around a dense region
// doesn't re-announce it on every moveend.
let _labelCapNoted = false;

function mapLabelIds() {
  const wanted = new Set();
  // Off means off: the operator asked for a clean map, and a filter's matches
  // are still ringed and still zoomed to without a name hanging off them.
  if (state.mapLabelMode === 'off') return wanted;
  for (const id of state.mapMatchLabels) wanted.add(id);

  const map = state.map;
  if (!map || !state.mapMarkers.length) return wanted;
  const bounds = map.getBounds();
  const inView = [];
  for (const m of state.mapMarkers) {
    if (m.mnStation && bounds.contains(m.getLatLng())) inView.push(m.mnStation);
  }

  let capped = false, pick;
  if (state.mapLabelMode === 'on') {
    capped = inView.length > MAP_LABEL_CAP;
    pick   = capped ? mapNearestToCentre(inView, MAP_LABEL_CAP) : inView;
  } else {
    pick = inView.length <= MAP_LABEL_CAP ? inView : [];
  }
  if (capped && !_labelCapNoted) {
    mapNote(`${inView.length} stations in view — naming the ${MAP_LABEL_CAP} closest to the centre.`, 3500);
  }
  _labelCapNoted = capped;

  for (const s of pick) wanted.add(s.id);
  return wanted;
}

// Bind or unbind the name tooltips in place. Called after a rebuild and on
// every pan and zoom, so it only touches the pins whose label actually changed
// — rebuilding ~3,100 markers to add a name is not a pan.
function applyMapLabels() {
  if (!state.map) return;
  const wanted = mapLabelIds();
  for (const m of state.mapMarkers) {
    const s = m.mnStation;
    if (!s) continue;
    const want = wanted.has(s.id);
    const has  = !!m.getTooltip();
    if (want && !has) {
      m.bindTooltip(esc(s.name), {
        permanent: true, direction: 'bottom', offset: [0, m.mnRadius || 6], className: 'mn-pin-label',
      });
    } else if (!want && has) {
      m.unbindTooltip();
    }
  }
}

function setMapLabelMode(mode) {
  state.mapLabelMode = mode;
  _labelCapNoted = false;      // a mode change is worth re-reporting the cap for
  applyMapLabels();
}

// Restyling the polylines already on the map beats rebuilding every layer to
// change one number.
function setMapLinkOpacity(v) {
  state.mapLinkOpacity = v;
  const label = document.getElementById('link-opacity-val');
  if (label) label.textContent = `${Math.round(v * 100)}%`;
  for (const l of state.mapLines) {
    if (l.mnLinkRole === 'casing')    l.setStyle({ opacity: v * MAP_LINK_CASING_MIX });
    else if (l.mnLinkRole === 'core') l.setStyle({ opacity: v });
  }
}

// The `n` stations closest to the centre of their own bounding box — used to
// pick which matches get a name label when there are too many to show.
function mapNearestToCentre(stations, n) {
  const lat = stations.map(s => s.lat), lon = stations.map(s => s.lon);
  const cLat = (Math.min(...lat) + Math.max(...lat)) / 2;
  const cLon = (Math.min(...lon) + Math.max(...lon)) / 2;
  return stations
    .map(s => ({ s, d: (s.lat - cLat) ** 2 + (s.lon - cLon) ** 2 }))
    .sort((a, b) => a.d - b.d)
    .slice(0, n)
    .map(x => x.s);
}

// ── River highlighting ───────────────────────────────────────────────────────
// Half this network is named after the river it sits on, so typing "burdekin"
// into the filter box lights up the Burdekin as well as the stations on it.
// Rivers are context, never matches: they draw beneath the pins, they never move
// the map, and they have no say in what the filter selects. Turn the switch off
// and the Stations tab behaves exactly as it did before this existed.
//
// The geometry comes from OpenStreetMap over Overpass — national, live, named,
// and in real coordinates. The bundled `assets/geo/Qld Major Streams_reduced.svg`
// is deliberately *not* used: inverting `BASIN_GEOREF` (maps-data.js) puts its
// features 100–150 km from the actual watercourse, consistently west and south.
// That is accurate enough for its own job — point-in-polygon against 65 basins
// the size of small countries — and useless for drawing a line over a
// topographic basemap, where 100 km off is worse than drawing nothing. No affine
// fixes it either: the source is a projected map. See issue #84.
//
// Overpass is a free public service, so every request has to earn itself: a
// name-ish term only (a bare number in that box is an ALERT address, not a
// river), debounced past the marker rebuild, bounded by the current view, capped,
// and cached by term and rounded bbox so a small pan or a retyped word costs
// nothing. Failure is silent and non-blocking — no network, no rivers, and the
// station filter behaves exactly as it does with the switch off.
const MapRivers = (function () {
  // Both of these serve `Access-Control-Allow-Origin: *`. The list is a list
  // because CORS from the deployed origin is the one thing that can sink this
  // (see #66, and the README on BoM/ACMA), and a second endpoint costs a line.
  const ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];
  const PANE        = 'mnRivers';
  const MIN_TERM    = 3;      // two letters matches half the watercourses in Queensland
  const DEBOUNCE_MS = 450;    // longer than the 160 ms marker rebuild: this one costs a request
  const TIMEOUT_MS  = 20000;
  const MAX_WAYS    = 250;    // ways drawn per query — a long river is many ways
  const BBOX_STEP   = 0.25;   // deg; the bbox is rounded out to this for the cache key,
                              // so nudging the map re-uses the answer it already has
  const BBOX_MAX    = 12;     // deg; a continent-wide view is not a fair thing to ask for
  const CACHE_MAX   = 40;     // (term, bbox) answers kept — a session's worth of searching
  const FAIL_TTL    = 60000;  // how long a failure is remembered before another attempt

  let map = null, layer = null, timer = null, seq = 0, failedAt = 0;
  const cache = new Map();    // 'terms|s,w,n,e' → { ways: [{name, coords}], capped, total }
  let note = { kind: 'idle', drawn: 0, total: 0, capped: false };

  // What in the box is worth asking Overpass about. `parseSearchTerms` has
  // already split and lower-cased them; a term with no letter in it is an ALERT
  // address or a station number, and the app already treats it that way.
  function riverTerms() {
    if (!state.mapRivers) return [];
    return prepareSearch(state.filters.search).terms
      .filter(t => t.length >= MIN_TERM && /[a-z]/.test(t));
  }

  // Rounded *outward*, so the box asked for always contains the box on screen.
  function roundedBbox(b) {
    const down = v => Math.floor(v / BBOX_STEP) * BBOX_STEP;
    const up   = v => Math.ceil(v / BBOX_STEP) * BBOX_STEP;
    return {
      s: Math.max(-90,  down(b.getSouth())), w: Math.max(-180, down(b.getWest())),
      n: Math.min(90,   up(b.getNorth())),   e: Math.min(180,  up(b.getEast())),
    };
  }

  function reEscape(t) { return t.replace(/[\\^$.*+?()[\]{}|"]/g, '\\$&'); }

  // `out geom;` returns the coordinates inline, so this is one request with no
  // recursion behind it.
  function overpassQl(terms, b) {
    const re = terms.map(reEscape).join('|');
    const box = [b.s, b.w, b.n, b.e].map(v => v.toFixed(4)).join(',');
    return `[out:json][timeout:25];\n` +
           `way["waterway"~"^(river|stream)$"]["name"~"${re}",i](${box});\n` +
           `out geom;`;
  }

  async function ask(ql) {
    let last = null;
    for (const url of ENDPOINTS) {
      const ctl = new AbortController();
      const t   = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method:  'POST',
          signal:  ctl.signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body:    'data=' + encodeURIComponent(ql),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (err) {
        last = err;                     // try the mirror before giving up
      } finally {
        clearTimeout(t);
      }
    }
    throw last || new Error('no Overpass endpoint answered');
  }

  function waysFrom(json) {
    const out = [];
    for (const el of (json && json.elements) || []) {
      const coords = [];
      for (const p of el.geometry || []) {
        if (p && p.lat != null && p.lon != null) coords.push([p.lat, p.lon]);
      }
      if (coords.length < 2) continue;
      out.push({ name: (el.tags && el.tags.name) || 'Unnamed watercourse', coords });
    }
    return out;
  }

  // Insertion order is the whole of the LRU: re-inserting on read moves an entry
  // to the young end, and the oldest key is the first one out.
  function cacheGet(key) {
    if (!cache.has(key)) return null;
    const v = cache.get(key);
    cache.delete(key);
    cache.set(key, v);
    return v;
  }

  function cachePut(key, v) {
    cache.set(key, v);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  // The legend only claims a river line while one is on the map, so it is
  // re-rendered whenever the layer appears or goes — the same deal the ACMA
  // colours have with it.
  function clearLayer() {
    if (!layer) return;
    layer.remove();
    layer = null;
    rerenderMapLegend();
  }

  function draw(ways) {
    clearLayer();
    if (!map || !ways.length) return;
    const colour = getComputedStyle(document.documentElement)
      .getPropertyValue('--map-river').trim() || '#1565c0';
    // An explicit SVG renderer rather than the map's shared canvas. A canvas in
    // this pane would cover the whole map and swallow pointer events that reach
    // it today (the map's own click, MapDraw); an SVG path only takes the pointer
    // on its own stroke, which is exactly what a hover label wants. A few hundred
    // thin paths is nothing beside the pins.
    const renderer = L.svg({ pane: PANE });
    layer = L.layerGroup().addTo(map);
    // Same two-pass trick as the pass-range links: every white casing first, then
    // every coloured core, so one river's casing can't paint over another's line
    // where they meet. A 2.5 px blue line vanishes into satellite imagery and
    // into the blue the topo tiles already draw water in; the casing is what
    // carries it on every basemap.
    for (const pass of ['casing', 'core']) {
      const casing = pass === 'casing';
      for (const w of ways) {
        const line = L.polyline(w.coords, {
          renderer, pane: PANE,
          color:       casing ? '#ffffff' : colour,
          weight:      casing ? 5 : 2.5,
          opacity:     casing ? 0.45 : 0.9,
          interactive: !casing,
        }).addTo(layer);
        if (!casing) line.bindTooltip(w.name, { sticky: true, className: 'mn-river-label' });
      }
    }
    rerenderMapLegend();
  }

  function setNote(kind, entry) {
    note = {
      kind,
      drawn:  entry ? entry.ways.length : 0,
      total:  entry ? entry.total : 0,
      capped: !!(entry && entry.capped),
    };
    const el = document.getElementById('map-river-note');
    if (el) el.innerHTML = noteHtml();
  }

  function noteHtml() {
    switch (note.kind) {
      case 'off':     return 'Rivers are hidden.';
      case 'wide':    return 'Zoom in to look up rivers — this view is too wide to ask for.';
      case 'loading': return 'Looking up rivers…';
      case 'fail':    return 'Rivers unavailable — OpenStreetMap could not be reached.';
      case 'ok':
        if (!note.drawn) return 'No named watercourse in view matches the filter.';
        return `<strong>${note.drawn}</strong> river segment${note.drawn === 1 ? '' : 's'} drawn` +
               (note.capped ? ` · ${note.total - note.drawn} more in view not drawn` : '') + '.';
      default:        return 'Type a name in the filter box to light up matching rivers.';
    }
  }

  function run() {
    if (!map) return;
    const terms = riverTerms();
    if (!terms.length) { clearLayer(); setNote(state.mapRivers ? 'idle' : 'off'); return; }
    const b = roundedBbox(map.getBounds());
    if (b.n - b.s > BBOX_MAX || b.e - b.w > BBOX_MAX) { clearLayer(); setNote('wide'); return; }

    const key = terms.join('+') + '|' + [b.s, b.w, b.n, b.e].map(v => v.toFixed(2)).join(',');
    const hit = cacheGet(key);
    if (hit) { draw(hit.ways); setNote('ok', hit); return; }
    if (Date.now() - failedAt < FAIL_TTL) { clearLayer(); setNote('fail'); return; }

    // Only the newest query may draw: typing "bur" then "burdekin" leaves two
    // requests in flight, and the slower one is the wrong answer.
    const mine = ++seq;
    setNote('loading');
    ask(overpassQl(terms, b)).then(json => {
      if (mine !== seq || !map) return;
      const all    = waysFrom(json);
      const capped = all.length > MAX_WAYS;
      const entry  = { ways: capped ? all.slice(0, MAX_WAYS) : all, capped, total: all.length };
      cachePut(key, entry);
      draw(entry.ways);
      setNote('ok', entry);
    }).catch(() => {
      if (mine !== seq || !map) return;
      failedAt = Date.now();            // don't hammer a service that just said no
      clearLayer();
      setNote('fail');
    });
  }

  // Held off until the typing pauses: a search rebuilds every marker already, and
  // this one also spends a request.
  function sync() {
    clearTimeout(timer);
    timer = setTimeout(run, DEBOUNCE_MS);
  }

  return {
    // Wire a freshly built map. The pane sits under the leader lines (350), the
    // pass-range links (overlayPane, 400) and the pins (markerPane, 600), so a
    // river never draws over the network it is context for.
    attach(m) {
      map = m;
      if (!m.getPane(PANE)) m.createPane(PANE).style.zIndex = 340;
      // Rivers are bounded by the view, so a pan or a zoom is a new question.
      // Usually a cached one: the bbox is rounded before it becomes a key.
      m.on('moveend', sync);
      sync();
    },

    detach() {
      clearTimeout(timer);
      if (map) map.off('moveend', sync);
      clearLayer();
      map = null;
      seq++;                            // a request in flight has nothing to draw on
    },

    // The filter box changed, or the switch did.
    sync,

    // Theme switch. The colour is read at draw time, so this re-draws what is
    // already there — off the cache, with no request.
    repaint() { if (layer) run(); },

    // Are there rivers on the map right now? The legend asks before claiming a
    // river line, the way it does for the ACMA colours.
    active() { return !!layer; },

    noteHtml,

    setEnabled(on) {
      state.mapRivers = on;
      try { localStorage.setItem('mn-rivers', on ? 'on' : 'off'); } catch (_) {}
      if (!on) { clearTimeout(timer); clearLayer(); setNote('off'); return; }
      setNote(riverTerms().length ? 'loading' : 'idle');   // don't leave "hidden" up for the debounce
      sync();
    },
  };
})();

// ── Overlapping pins: fan-out ("spiderfy") ───────────────────────────────────
// Co-sited stations and ACMA sites carrying a dozen licensed devices land on the
// same few pixels, and whatever is underneath is unreachable. Hovering a stack
// (mouse) or tapping it (touch) fans its members out around the stack centre on
// leader lines so each one can be seen and clicked; they snap back when the
// pointer leaves, the map zooms, or the markers are rebuilt.
//
// Works on any marker with getLatLng/setLatLng, so MegaNet station circles and
// ACMA transmitter squares fan out together.
const MapSpider = (function () {
  const NEAR_PX   = 20;  // pins within this screen distance form one stack
  const MAX_FAN   = 16;  // a fan bigger than this stops being readable
  const HOVER_MAX = 10;  // bigger stacks need a deliberate click, so that panning
                         // across a zoomed-out map doesn't fan pins constantly
  const LEAVE_PX  = 70;  // pointer this far outside the fan closes it
  const HOVER_MS  = 70;  // settle time, so sweeping across a stack doesn't fan it

  const buckets = { stations: [], acma: [] };
  let map = null;
  let open = null;       // { members, centre, radius, legs }
  let cache = null;      // { list, pts } projected at the current zoom
  let hoverTimer = null;

  function canHover() {
    return !L.Browser.mobile && window.matchMedia('(hover: hover)').matches;
  }

  function pins() { return buckets.stations.concat(buckets.acma); }

  // Where a pin belongs — its own position unless it is currently fanned out.
  function home(m) { return m._mnHome || m.getLatLng(); }

  function invalidate() { cache = null; }

  function points() {
    if (cache) return cache;
    const zoom = map.getZoom();
    const list = pins();
    cache = { list, pts: list.map(m => map.project(home(m), zoom)) };
    return cache;
  }

  // Every pin sitting within NEAR_PX of the given one, nearest first.
  function stackFor(marker) {
    const { list, pts } = points();
    const i = list.indexOf(marker);
    if (i < 0) return [];
    const c = pts[i];
    return list
      .map((m, j) => ({ m, d: Math.hypot(pts[j].x - c.x, pts[j].y - c.y) }))
      .filter(x => x.d <= NEAR_PX)
      .sort((a, b) => a.d - b.d)
      .map(x => x.m);
  }

  // Pixel offsets for n fanned pins: concentric rings at ~26 px spacing, so a
  // pair sits tight and a 30-device ACMA site still reads.
  function fanOffsets(n) {
    const out = [];
    let placed = 0, ring = 0;
    while (placed < n) {
      const r   = 30 + ring * 26;
      const cap = Math.max(3, Math.floor((2 * Math.PI * r) / 26));
      const k   = Math.min(cap, n - placed);
      for (let i = 0; i < k; i++) {
        const a = -Math.PI / 2 + (2 * Math.PI * i) / k + (ring % 2 ? Math.PI / k : 0);
        out.push({ x: Math.cos(a) * r, y: Math.sin(a) * r, r });
      }
      placed += k;
      ring++;
    }
    return out;
  }

  function isOpen(marker) { return !!open && open.members.indexOf(marker) >= 0; }

  function spiderfy(marker) {
    if (!map) return false;
    const stack = stackFor(marker);
    if (stack.length < 2) { unspiderfy(); return false; }
    // Co-located ACMA devices share exact coordinates and never separate by
    // zooming, so an oversized stack still fans — it just says what it left out.
    const members = stack.slice(0, MAX_FAN);
    if (open && open.members.length === members.length &&
        members.every(m => open.members.indexOf(m) >= 0)) return true;
    unspiderfy();
    if (stack.length > MAX_FAN) {
      mapNote(`${members.length} of ${stack.length} pins fanned out — zoom in for the rest`, 4000);
    }

    const zoom = map.getZoom();
    const { list, pts } = points();
    let sx = 0, sy = 0;
    members.forEach(m => { const p = pts[list.indexOf(m)]; sx += p.x; sy += p.y; });
    const centre = map.unproject(L.point(sx / members.length, sy / members.length), zoom);
    const cLp    = map.latLngToLayerPoint(centre);
    const offs   = fanOffsets(members.length);
    const legs   = L.layerGroup().addTo(map);
    let radius   = 0;

    members.forEach((m, i) => {
      const o    = offs[i];
      const from = home(m);
      const to   = map.layerPointToLatLng(cLp.add(L.point(o.x, o.y)));
      radius = Math.max(radius, o.r);
      m._mnHome = from;
      // White casing under a dark line: legible over topo, imagery and dark mode.
      L.polyline([from, to], { pane: 'mnSpiderLegs', color: '#fff',     weight: 4,   opacity: .9,  interactive: false }).addTo(legs);
      L.polyline([from, to], { pane: 'mnSpiderLegs', color: '#4a5560', weight: 1.5, opacity: .95, interactive: false }).addTo(legs);
      m.setLatLng(to);
      if (m.setZIndexOffset) m.setZIndexOffset(1000);
      if (m.bringToFront)    m.bringToFront();
    });
    L.circleMarker(centre, {
      pane: 'mnSpiderLegs', radius: 2.5, color: '#4a5560', weight: 1,
      fillColor: '#fff', fillOpacity: 1, interactive: false,
    }).addTo(legs);

    open = { members, centre, radius, legs };
    map.on('mousemove', onMapMove);
    return true;
  }

  function unspiderfy() {
    clearTimeout(hoverTimer);
    if (!open) return;
    open.members.forEach(m => {
      if (m._mnHome) { m.setLatLng(m._mnHome); delete m._mnHome; }
      if (m.setZIndexOffset) m.setZIndexOffset(0);
    });
    open.legs.remove();
    if (map) map.off('mousemove', onMapMove);
    open = null;
  }

  function onMapMove(e) {
    if (!open) return;
    // A popup open on one of the fanned pins is the user reading it — hold.
    if (open.members.some(m => m.isPopupOpen && m.isPopupOpen())) return;
    if (e.layerPoint.distanceTo(map.latLngToLayerPoint(open.centre)) > open.radius + LEAVE_PX) {
      unspiderfy();
    }
  }

  function onPinOver(e) {
    if (!map || isOpen(e.target)) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      // Hover only opens small stacks; a zoomed-out map where everything
      // overlaps would otherwise fan pins under every pass of the mouse.
      if (stackFor(e.target).length <= HOVER_MAX) spiderfy(e.target);
    }, HOVER_MS);
  }

  function onPinClick(e) {
    if (!map || isOpen(e.target)) return;   // already fanned → let the popup open
    // A modifier-click is the map selection talking, not "show me this stack".
    const oe = e.originalEvent;
    if (oe && (oe.shiftKey || oe.ctrlKey || oe.metaKey)) return;
    // First tap on a stack fans it instead of opening whichever pin was on top.
    if (spiderfy(e.target)) e.target.closePopup();
  }

  return {
    // Wire a freshly built map. Leader lines get their own pane below the
    // overlay pane so they never draw over the pins they point at.
    attach(m) {
      map = m;
      open = null; cache = null;
      buckets.stations = []; buckets.acma = [];
      clearTimeout(hoverTimer);
      if (!m.getPane('mnSpiderLegs')) {
        const pane = m.createPane('mnSpiderLegs');
        pane.style.zIndex = 350;
        pane.style.pointerEvents = 'none';
      }
      m.on('zoomstart', unspiderfy);
      m.on('zoomend viewreset', invalidate);
      m.on('click', unspiderfy);          // pin clicks don't bubble to the map
    },

    // Hand over a rebuilt set of markers for one layer.
    setPins(kind, markers) {
      unspiderfy();
      buckets[kind] = markers || [];
      invalidate();
      (markers || []).forEach(m => {
        if (m._mnSpiderWired) return;
        m._mnSpiderWired = true;
        m.on('click', onPinClick);
        if (canHover()) m.on('mouseover', onPinOver);
      });
    },

    // Send every fanned pin home — call before markers are removed or replaced.
    reset() { unspiderfy(); invalidate(); },

    detach() { unspiderfy(); map = null; buckets.stations = []; buckets.acma = []; },
  };
})();

// ── Where am I? (mobile) ─────────────────────────────────────────────────────
// Off by default and only offered on touch devices: a button below the zoom
// control puts a dot at the phone's GPS position with an accuracy ring, plus a
// cone pointing the way the phone is facing when a compass is available.
// iOS only hands out orientation events after a permission request made from a
// user gesture, which is why that request lives in the button's click handler.
const MapLocate = (function () {
  let map = null, btn = null;
  let on = false, watchId = null, marker = null, ring = null;
  let heading = null, orientEvent = null, gotCompass = false, followed = false;

  function isMobile() {
    return L.Browser.mobile || window.matchMedia('(pointer: coarse)').matches;
  }

  function icon() {
    return L.divIcon({
      className: 'mn-loc-icon',
      html: '<div class="mn-loc"><i class="mn-loc-cone"></i><i class="mn-loc-dot"></i></div>',
      iconSize: [46, 46], iconAnchor: [23, 23],
    });
  }

  function applyHeading() {
    const el   = marker && marker.getElement();
    const cone = el && el.querySelector('.mn-loc-cone');
    if (!cone) return;
    cone.style.display   = heading == null ? 'none' : '';
    cone.style.transform = `rotate(${heading || 0}deg)`;
  }

  function onOrient(e) {
    let h = null;
    if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
      h = e.webkitCompassHeading;                                  // iOS: clockwise from north
    } else if (e.alpha != null && (e.absolute || e.type === 'deviceorientationabsolute')) {
      h = 360 - e.alpha;                                           // spec alpha runs anticlockwise
    }
    if (h == null) return;      // relative-only sensor: no compass, leave it to GPS course
    // Compass readings are relative to the device's natural orientation; add the
    // screen rotation so the cone still points the right way in landscape.
    const screenAngle = (window.screen.orientation && window.screen.orientation.angle) ||
                        window.orientation || 0;
    gotCompass = true;
    heading = (h + screenAngle + 360) % 360;
    applyHeading();
  }

  function listenOrientation() {
    orientEvent = ('ondeviceorientationabsolute' in window)
      ? 'deviceorientationabsolute' : 'deviceorientation';
    window.addEventListener(orientEvent, onOrient, true);
  }

  function startOrientation() {
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) return;
    if (typeof DOE.requestPermission === 'function') {
      DOE.requestPermission()
        .then(res => { if (res === 'granted') listenOrientation(); })
        .catch(() => {});
    } else {
      listenOrientation();
    }
  }

  function onPos(p) {
    if (!on || !map) return;
    const ll  = [p.coords.latitude, p.coords.longitude];
    const acc = p.coords.accuracy || 0;
    // No compass readings arriving? Fall back to GPS course, which is only
    // meaningful on the move.
    if (!gotCompass && p.coords.heading != null && !isNaN(p.coords.heading) &&
        p.coords.speed > 0.5) {
      heading = p.coords.heading;
    }
    if (!marker) {
      ring   = L.circle(ll, { radius: acc, color: '#1e88e5', weight: 1,
                              fillColor: '#1e88e5', fillOpacity: .12, interactive: false }).addTo(map);
      marker = L.marker(ll, { icon: icon(), interactive: false, keyboard: false,
                              zIndexOffset: 2000 }).addTo(map);
    } else {
      marker.setLatLng(ll);
      ring.setLatLng(ll).setRadius(acc);
    }
    applyHeading();
    if (!followed) {                          // centre on the first fix only
      followed = true;
      map.setView(ll, Math.max(map.getZoom(), 14));
      mapNote('', 0);
    }
  }

  function onErr(e) {
    mapNote(`Location unavailable — ${e.message || 'no fix'}`, 6000);
    if (e.code === 1) stop();                 // permission denied: don't keep trying
  }

  function stop() {
    on = false;
    if (btn) btn.classList.remove('on');
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    if (orientEvent) window.removeEventListener(orientEvent, onOrient, true);
    orientEvent = null;
    heading = null;
    gotCompass = false;
    if (marker) marker.remove();
    if (ring)   ring.remove();
    marker = ring = null;
  }

  function toggle() {
    if (on) { stop(); mapNote('', 0); return; }
    on = true;
    followed = false;
    if (btn) btn.classList.add('on');
    mapNote('Locating…', 8000);
    startOrientation();
    watchId = navigator.geolocation.watchPosition(onPos, onErr, {
      enableHighAccuracy: true, maximumAge: 2000, timeout: 20000,
    });
  }

  return {
    attach(m) {
      map = m;
      if (!('geolocation' in navigator) || !isMobile()) return;
      const ctl = L.control({ position: 'topleft' });
      ctl.onAdd = () => {
        const div = L.DomUtil.create('div', 'leaflet-bar mn-locate');
        const a   = L.DomUtil.create('a', '', div);
        a.href = '#';
        a.title = 'Show my location and heading';
        a.setAttribute('role', 'button');
        a.setAttribute('aria-label', 'Show my location and heading');
        a.innerHTML = '➤';
        L.DomEvent.on(a, 'click', L.DomEvent.stop).on(a, 'click', toggle);
        btn = a;
        return div;
      };
      ctl.addTo(m);
    },

    // The map is being torn down (tab switch or re-render): drop the GPS watch
    // and the compass listener rather than leaving them running unseen.
    detach() { if (on) stop(); map = null; btn = null; },
  };
})();

// ── Terrain elevation ────────────────────────────────────────────────────────
// Ground height along a line — what both the elevation profile and the link
// budget are built on. MegaNet is a static page: there is no backend to ask and
// no key can live in the repo, so elevation comes from open terrarium-encoded
// PNG tiles, decoded in a canvas here in the browser.
//
// AWS Terrain Tiles (elevation-tiles-prod) is the source: open data, no key,
// `Access-Control-Allow-Origin: *`, and ~30 m SRTM over Australia. It rides the
// same XYZ scheme Leaflet already fetches base maps on (see makeBaseLayers), so
// the lat/lon → tile maths is the standard Web Mercator pair and nothing more.
//
//   elevation_m = (R * 256 + G + B / 256) - 32768
//
// Tiles are cached decoded, so a second profile over the same country costs no
// network at all. That is the reason for tiles over an elevation API: the API
// would be one rate-limited request per profile with nothing kept between them,
// and a handful of tiles already covers a whole VHF hop.
//
// DATUM — terrarium heights are above the EGM96 geoid; a station's
// `elevation_ahd` is Australian Height Datum. Over Australia the two agree to
// about a metre, well inside the ~30 m sampling error, but they are not the
// same datum and neither one is ellipsoidal height. So where a station's own
// elevation_ahd exists it wins for that *endpoint*, and tiles only ever supply
// the ground *between* the ends. Everything drawn from this says so on screen.
//
// Every failure here is loud. A caller that cannot get terrain has to say so:
// a flat profile reads as a clear path, which is the one wrong answer that
// actually costs someone a site visit.

const Terrain = (function () {
  const TILE_URL  = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
  const TILE_PX   = 256;
  // The source is ~30 m SRTM. Past z12 (~33 m/px at Queensland latitudes) the
  // tiles are resampling their own pixels — four times the tiles for no more
  // terrain.
  const MAX_ZOOM  = 12;
  const MIN_ZOOM  = 7;
  const MAX_TILES = 48;      // per profile; the zoom drops until the path fits
  const CACHE_MAX = 128;     // × 128 KB decoded ≈ 16 MB — the bound on a long session
  const FETCH_MS  = 12000;   // a tile that hasn't arrived by now has failed
  const FAIL_TTL  = 60000;   // how long a failed tile is remembered before a retry

  // Decoded tiles, oldest first: a Map iterates in insertion order, so re-inserting
  // on read is the whole of the LRU.
  const cache    = new Map();   // 'z/x/y' → Int16Array(65536) of metres
  const failedAt = new Map();   // 'z/x/y' → timestamp of the last failure
  const inflight = new Map();   // 'z/x/y' → Promise<Int16Array|null>
  let canvas = null;

  const ATTRIB = 'Elevation: AWS Terrain Tiles (SRTM/GMTED, ~30 m), height above the EGM96 geoid';

  // ── Web Mercator ──
  // Fractional tile coordinates: the integer part is the tile, the fraction
  // times 256 is the pixel inside it.
  function tileX(lon, z) { return (lon + 180) / 360 * Math.pow(2, z); }

  function tileY(lat, z) {
    const r = Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180;
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z);
  }

  // Ground distance one tile pixel covers, which is what picks the zoom.
  function metresPerPixel(lat, z) {
    return 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, z);
  }

  // ── tiles ──

  function sharedCanvas() {
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.width = canvas.height = TILE_PX;
    }
    return canvas;
  }

  // RGB → metres, once per tile, into an Int16Array. Holding the raw RGBA
  // instead would be 256 KB a tile; metre resolution is far finer than the
  // ~30 m the source actually resolves, and it halves the cache.
  function decode(img) {
    const cv = sharedCanvas();
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.clearRect(0, 0, TILE_PX, TILE_PX);
    cx.drawImage(img, 0, 0, TILE_PX, TILE_PX);
    // Throws if the image tainted the canvas — i.e. the CORS headers went away.
    // That is a failure like any other, and the caller turns it into one.
    const d = cx.getImageData(0, 0, TILE_PX, TILE_PX).data;
    const out = new Int16Array(TILE_PX * TILE_PX);
    for (let i = 0, j = 0; i < out.length; i++, j += 4) {
      out[i] = Math.round(d[j] * 256 + d[j + 1] + d[j + 2] / 256 - 32768);
    }
    return out;
  }

  function remember(key, px) {
    cache.set(key, px);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  // Resolves to the decoded tile, or to null for every kind of failure there is
  // — offline, blocked, rate-limited, 404 over the ocean, CORS withdrawn. It
  // never rejects: one missing tile is a gap in a profile, not a dead panel.
  function loadTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (cache.has(key)) {
      const px = cache.get(key);
      cache.delete(key); cache.set(key, px);        // most recently used
      return Promise.resolve(px);
    }
    if (inflight.has(key)) return inflight.get(key);
    // A tile that just failed is not retried on every mouse-driven re-profile;
    // after the TTL it gets another chance, so a dropped connection heals.
    const fa = failedAt.get(key);
    if (fa != null && Date.now() - fa < FAIL_TTL) return Promise.resolve(null);

    const url = TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    const p = new Promise(resolve => {
      const img = new Image();
      img.crossOrigin = 'anonymous';               // required before getImageData
      let settled = false;
      const finish = v => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => finish(null), FETCH_MS);
      img.onload  = () => { try { finish(decode(img)); } catch (_) { finish(null); } };
      img.onerror = () => finish(null);
      img.src = url;
    }).then(px => {
      inflight.delete(key);
      if (px) { failedAt.delete(key); remember(key, px); }
      else    { failedAt.set(key, Date.now()); }
      return px;
    });
    inflight.set(key, p);
    return p;
  }

  // Nearest pixel, deliberately: interpolating between samples of a ~30 m grid
  // invents detail the source does not have, and across a tile edge it would
  // need the neighbour fetched as well.
  function readTile(px, fx, fy, tx, ty) {
    const ix = Math.min(TILE_PX - 1, Math.max(0, Math.floor((fx - tx) * TILE_PX)));
    const iy = Math.min(TILE_PX - 1, Math.max(0, Math.floor((fy - ty) * TILE_PX)));
    return px[iy * TILE_PX + ix];
  }

  // ── path sampling ──

  // n points evenly spaced by distance along the polyline, each carried back as
  // a real lat/lon so the caller can name and re-use them. Great-circle within
  // each leg, via the geodesy the map already uses.
  function walk(pts, n) {
    const legs = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const km = acmaHaversineKm(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
      legs.push({ from: pts[i - 1], to: pts[i], km, at: total,
                  brg: bearingDeg(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) });
      total += km;
    }
    const out = [];
    let leg = 0;
    for (let i = 0; i < n; i++) {
      const km = total * i / (n - 1);
      while (leg < legs.length - 1 && km > legs[leg].at + legs[leg].km) leg++;
      const L = legs[leg];
      // The ends are the vertices themselves, not a destPoint approximation of
      // them — a snapped endpoint has to stay exactly on its station.
      const ll = i === 0 ? pts[0]
               : i === n - 1 ? pts[pts.length - 1]
               : destPoint(L.from[0], L.from[1], L.brg, Math.max(0, km - L.at));
      out.push({ km, lat: ll[0], lon: ll[1] });
    }
    return { samples: out, totalKm: total };
  }

  // The coarsest zoom whose pixels are still finer than the gap between
  // samples, then backed off further if the path won't fit in the tile budget.
  //
  // Going coarser than the sample spacing is the expensive mistake: adjacent
  // samples start landing on the same pixel and a ridge narrower than a pixel
  // simply stops existing — and a ridge that stops existing is a path that
  // reports clear. Going finer only costs tiles. So: fine enough that no sample
  // is wasted, and no finer. A 5 km hop lands on z12, a 120 km hop on z9.
  function pickZoom(samples, totalKm, n) {
    const midLat = samples[Math.floor(samples.length / 2)].lat;
    const spacing = Math.max(1, totalKm * 1000 / Math.max(1, n - 1));
    let z = MIN_ZOOM;
    while (z < MAX_ZOOM && metresPerPixel(midLat, z) > spacing) z++;
    let capped = false;
    for (;;) {
      const keys = new Set();
      for (const s of samples) keys.add(`${Math.floor(tileX(s.lon, z))}/${Math.floor(tileY(s.lat, z))}`);
      if (keys.size <= MAX_TILES || z <= MIN_ZOOM) return { z, tiles: keys.size, capped };
      z--; capped = true;
    }
  }

  return {
    // Ground height at one point, or null if the tile for it can't be had.
    sample(lat, lon, zoom) {
      const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom || MAX_ZOOM));
      const fx = tileX(lon, z), fy = tileY(lat, z);
      const tx = Math.floor(fx), ty = Math.floor(fy);
      return loadTile(z, tx, ty).then(px => (px ? readTile(px, fx, fy, tx, ty) : null));
    },

    // n evenly-spaced ground samples along a polyline.
    //
    // Resolves — never rejects — to one of two shapes, so a caller has to look
    // at `ok` before it can draw anything:
    //   { ok: false, error }                      nothing usable; say so
    //   { ok: true, distance_m[], terrain_m[], …} terrain_m holds null wherever
    //                                             a tile was missing, and
    //                                             `partial` says it happened
    profile(pts, n) {
      const count = Math.max(2, Math.min(1024, n || 256));
      if (!pts || pts.length < 2) {
        return Promise.resolve({ ok: false, error: 'A path needs at least two points.' });
      }
      const { samples, totalKm } = walk(pts, count);
      if (!(totalKm > 0)) {
        return Promise.resolve({ ok: false, error: 'The two ends are in the same place.' });
      }
      const { z, tiles, capped } = pickZoom(samples, totalKm, count);

      const need = new Map();
      for (const s of samples) {
        s.fx = tileX(s.lon, z); s.fy = tileY(s.lat, z);
        s.tx = Math.floor(s.fx); s.ty = Math.floor(s.fy);
        need.set(`${s.tx}/${s.ty}`, [s.tx, s.ty]);
      }
      const keys = [...need.keys()];
      return Promise.all([...need.values()].map(([x, y]) => loadTile(z, x, y))).then(got => {
        const byKey = {};
        keys.forEach((k, i) => { byKey[k] = got[i]; });
        const distance_m = [], terrain_m = [], lat = [], lon = [];
        let missing = 0;
        for (const s of samples) {
          const px = byKey[`${s.tx}/${s.ty}`];
          distance_m.push(s.km * 1000);
          lat.push(s.lat); lon.push(s.lon);
          if (px) terrain_m.push(readTile(px, s.fx, s.fy, s.tx, s.ty));
          else { terrain_m.push(null); missing++; }
        }
        if (missing === samples.length) {
          return { ok: false,
                   error: 'Terrain tiles could not be fetched — offline, blocked, or the tile service is unavailable.' };
        }
        return { ok: true, distance_m, terrain_m, lat, lon,
                 totalKm, zoom: z, tiles, capped, missing, partial: missing > 0,
                 resolution_m: Math.round(metresPerPixel(samples[Math.floor(samples.length / 2)].lat, z)),
                 attribution: ATTRIB };
      });
    },

    attribution: ATTRIB,
    maxTiles: MAX_TILES,
    // For the panel footer: how much of a session's terrain is already in hand.
    cached() { return cache.size; },
    // MemMeter's Release button. Costs a re-fetch of whatever profile is drawn
    // next — nothing currently on screen depends on the cache staying warm.
    clear() { cache.clear(); failedAt.clear(); },
  };
})();

// ── Draw & measure ───────────────────────────────────────────────────────────
// Sketching over the network map: a coverage circle round a repeater, a
// proposed path, a box round the part of a catchment that went quiet, and a
// note saying what the picture is about. Every shape can be drawn by clicking
// on the map *or* typed in as coordinates and real-world dimensions, and
// either way it reduces to the same few numbers — which the pane then shows,
// and lets you edit. So a circle dropped roughly by hand becomes exactly
// 25.0 km by typing over its radius.
//
// Shapes carry their own measurements (length, radius, area) on the map, which
// is the "measure" half: drop a two-point line between two sites and it says
// how far apart they are and on what bearing.
//
// Nothing is saved. The shapes live as long as the page does — a tab switch
// rebuilds them from state.draw.shapes, a reload clears them — and the export
// is the operating system's screen-clipping tool.

const DRAW_TOOLS = {
  pin:    { icon: '📍', label: 'Pin',       hint: 'Click the map to drop a pin. Keeps going until you pick another tool.' },
  line:   { icon: '╱',  label: 'Line',      hint: 'Click each corner; double-click (or Finish) to end. Shows length and bearing.' },
  circle: { icon: '◯',  label: 'Circle',    hint: 'Click the centre, then click again at the radius.' },
  rect:   { icon: '▭',  label: 'Rectangle', hint: 'Click one corner, then the opposite one.' },
  text:   { icon: 'T',  label: 'Text',      hint: 'Click where the note goes, then type it.' },
};

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

function fmtArea(km2) {
  if (!isFinite(km2)) return '—';
  if (km2 < 10)   return `${km2.toFixed(2)} km²`;
  if (km2 < 1000) return `${km2.toFixed(1)} km²`;
  return `${Math.round(km2).toLocaleString()} km²`;
}

// Six presets that stay legible on street, topo and satellite tiles alike, plus
// a native picker behind them for anything else.
const DRAW_COLOURS = [
  ['#e91e63', 'Pink'],  ['#ff6d00', 'Orange'], ['#ffd600', 'Yellow'],
  ['#00c853', 'Green'], ['#00b0ff', 'Blue'],   ['#aa00ff', 'Purple'],
];

const MapDraw = (function () {
  let map = null, group = null, ghost = null;
  let pending = null;      // shape being clicked out: { kind, pts: [[lat,lon], …], sids: […] }
  let keyHandler = null;
  let snapHint = null;     // ring round the station the next click would land on
  let snapCache = null;    // station pins projected once per zoom (see snapPoints)

  // How close to a station pin a click has to be to land on it. Screen pixels,
  // not kilometres: a km threshold would snap wildly at the national view and
  // never at street level.
  const SNAP_PX = 15;

  const D = () => state.draw;

  // ── colour ──
  // The theme's own drawing colour: the fallback for shapes drawn before a
  // colour was ever picked, and what "no choice" means in the picker.
  function themeColour() {
    return getComputedStyle(document.documentElement).getPropertyValue('--draw').trim() || '#c2185b';
  }

  // Only a hex literal is ever let through: these values go into inline style
  // attributes on the divIcon markers.
  function safeColour(c) {
    const v = String(c || '').trim();
    return /^#[0-9a-f]{3}([0-9a-f]{3}([0-9a-f]{2})?)?$/i.test(v) ? v : '';
  }

  // What new shapes get.
  function colour() { return safeColour(D().colour) || themeColour(); }

  // What an existing shape is drawn in — its own colour, or the theme's.
  function colourOf(sh) { return safeColour(sh.colour) || themeColour(); }

  function setColour(c) {
    const v = safeColour(c);
    D().colour = v;
    try { localStorage.setItem('mn-draw-colour', v); } catch (_) {}
    // With a shape picked, the control is colouring that shape — the natural
    // reading, and it saves needing a separate "edit colour" affordance.
    const sh = D().shapes.find(s => s.id === D().selectedId);
    if (sh) { sh.colour = v; render(); }
    rerenderPanel();
  }

  // ── geometry → numbers ──
  // Rectangles are held as a centre plus real-world width and height, not as a
  // pair of corners: "8 km across" is the thing being asked for, and it is what
  // survives being typed over.
  function rectBounds(sh) {
    const dLat = (sh.heightKm / 2) / KM_PER_DEG_LAT;
    const dLon = (sh.widthKm  / 2) / kmPerDegLon(sh.lat);
    return [[sh.lat - dLat, sh.lon - dLon], [sh.lat + dLat, sh.lon + dLon]];
  }

  function rectFromCorners(a, b) {
    const lat = (a[0] + b[0]) / 2, lon = (a[1] + b[1]) / 2;
    return {
      kind: 'rect', lat, lon,
      widthKm:  Math.abs(a[1] - b[1]) * kmPerDegLon(lat),
      heightKm: Math.abs(a[0] - b[0]) * KM_PER_DEG_LAT,
    };
  }

  function lineKm(pts) {
    let km = 0;
    for (let i = 1; i < pts.length; i++) {
      km += acmaHaversineKm(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    }
    return km;
  }

  // The one-line measurement a shape carries, on the map and in the list.
  function measure(sh) {
    switch (sh.kind) {
      // A pin dropped on a site is that site — the name beats the coordinates
      // both in the list and on the map.
      case 'pin':  return snapLabel(sh) || `${sh.lat.toFixed(4)}, ${sh.lon.toFixed(4)}`;
      case 'text': return sh.text;
      case 'circle': {
        const a = Math.PI * sh.radiusKm ** 2;
        return `r ${fmtKm(sh.radiusKm)} · ${fmtArea(a)}`;
      }
      case 'rect':
        return `${fmtKm(sh.widthKm)} × ${fmtKm(sh.heightKm)} · ${fmtArea(sh.widthKm * sh.heightKm)}`;
      case 'line': {
        const km = lineKm(sh.pts);
        if (sh.pts.length === 2) {
          const b = bearingDeg(sh.pts[0][0], sh.pts[0][1], sh.pts[1][0], sh.pts[1][1]);
          return `${fmtKm(km)} @ ${String(Math.round(b)).padStart(3, '0')}°`;
        }
        return `${fmtKm(km)} over ${sh.pts.length - 1} legs`;
      }
      default: return '';
    }
  }

  // ── snap to stations ──
  // Station pins projected at the current zoom. Comparing projected pixels is
  // the same comparison as container pixels, and doing it from a cache keeps
  // ~3,174 projections off every mousemove.
  function snapPoints() {
    const zoom = map.getZoom();
    if (snapCache && snapCache.zoom === zoom && snapCache.list === state.mapMarkers) return snapCache;
    snapCache = {
      zoom,
      list: state.mapMarkers,
      // A fanned-out pin's own latlng is where it was flung to, not where the
      // station is; mnStation is the real position.
      pts:  state.mapMarkers.map(m => map.project([m.mnStation.lat, m.mnStation.lon], zoom)),
    };
    return snapCache;
  }

  // The station pin a click at this position would land on, or null.
  function snapTarget(latlng) {
    if (!D().snap || !map || !state.mapMarkers.length) return null;
    const { list, pts } = snapPoints();
    const c = map.project(latlng, map.getZoom());
    let best = null, bestD = SNAP_PX;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.hypot(pts[i].x - c.x, pts[i].y - c.y);
      if (d <= bestD) { bestD = d; best = list[i]; }
    }
    return best;
  }

  // Without this the operator cannot tell whether a click snapped or not.
  function showSnapHint(marker) {
    if (snapHint && snapHint._mnFor === marker) return;
    clearSnapHint();
    if (!marker || !map) return;
    const s = marker.mnStation;
    snapHint = L.circleMarker([s.lat, s.lon], {
      radius: (marker.mnBaseStyle ? marker.mnBaseStyle.radius : 6) + 5,
      color: colour(), weight: 2, dashArray: '4,3', fill: false, interactive: false,
    }).addTo(map);
    snapHint._mnFor = marker;
    snapHint.bindTooltip(esc(s.name), {
      permanent: true, direction: 'top', className: 'mn-draw-label', offset: [0, -6],
    }).openTooltip();
  }

  function clearSnapHint() {
    if (snapHint) { snapHint.remove(); snapHint = null; }
  }

  // Resolve a map click to the point the shape should actually use, and to the
  // station it came from when it snapped.
  function resolve(latlng) {
    const t = snapTarget(latlng);
    return t
      ? { ll: [t.mnStation.lat, t.mnStation.lon], sid: t.mnStationId }
      : { ll: [latlng.lat, latlng.lng], sid: null };
  }

  function stationName(id) {
    if (!id || !state.data) return '';
    const s = state.data.stations.find(x => x.id === id);
    return s ? s.name : '';
  }

  // What a shape's snapped ends are called. "Mt Stuart → Durikai" is the thing
  // a drawn path means; two lat/lon pairs are not. Points are held in the same
  // order the shape defines them, so a line's ends are the first and the last.
  function snapLabel(sh) {
    const t = sh.snappedTo;
    if (!t || !t.length) return '';
    if (sh.kind !== 'line') return stationName(t[0]);
    const a = stationName(t[0]), b = stationName(t[t.length - 1]);
    if (a && b) return `${a} → ${b}`;
    return a ? `from ${a}` : b ? `to ${b}` : '';
  }

  // The shape's line in the draw list: its measurement, led by the sites it was
  // snapped to. A pin's measurement is already its name when it has one.
  function rowText(sh) {
    const nm = snapLabel(sh);
    return (!nm || sh.kind === 'pin') ? measure(sh) : `${nm} · ${measure(sh)}`;
  }

  function centreOf(sh) {
    if (sh.kind === 'line') {
      const lat = sh.pts.reduce((a, p) => a + p[0], 0) / sh.pts.length;
      const lon = sh.pts.reduce((a, p) => a + p[1], 0) / sh.pts.length;
      return [lat, lon];
    }
    return [sh.lat, sh.lon];
  }

  // ── layers ──

  function layerFor(sh) {
    const c   = colourOf(sh);
    const sel = sh.id === D().selectedId;
    const path = { color: c, weight: sel ? 4 : 2.5, opacity: 1, fillColor: c, fillOpacity: .12 };
    switch (sh.kind) {
      // The divIcon shapes are styled in CSS off --draw, so a per-shape colour
      // has to be written onto the element itself. safeColour has already
      // established that `c` is a hex literal.
      case 'pin':
        return L.marker([sh.lat, sh.lon], {
          icon: L.divIcon({ className: `mn-draw-pin${sel ? ' sel' : ''}`,
                            html: `<i style="background:${c};outline-color:${c}"></i>`,
                            iconSize: [16, 16], iconAnchor: [8, 16] }),
        });
      case 'text':
        return L.marker([sh.lat, sh.lon], {
          icon: L.divIcon({ className: `mn-draw-textbox${sel ? ' sel' : ''}`,
                            html: `<span style="border-color:${c}">${esc(sh.text)}</span>`,
                            iconSize: null }),
        });
      case 'line':   return L.polyline(sh.pts, { ...path, fill: false });
      case 'circle': return L.circle([sh.lat, sh.lon], { ...path, radius: sh.radiusKm * 1000 });
      case 'rect':   return L.rectangle(rectBounds(sh), path);
      default:       return null;
    }
  }

  function draw(sh) {
    const layer = layerFor(sh);
    if (!layer) return;
    sh._layer = layer;
    layer.addTo(group);
    // Text annotations already read as their own label; everything else gets
    // its measurement written next to it.
    if (D().showLabels && sh.kind !== 'text') {
      const anchor = sh.kind === 'pin' ? 'top' : 'center';
      layer.bindTooltip(measure(sh), {
        permanent: true, direction: anchor, className: 'mn-draw-label',
        offset: sh.kind === 'pin' ? [0, -18] : [0, 0],
      });
      // A permanent tooltip on a layer already added to the map is open right
      // away, so its element exists to be given the shape's own colour.
      const tt = layer.getTooltip();
      const el = tt && tt.getElement();
      if (el) el.style.borderColor = colourOf(sh);
    }
    layer.on('click', e => {
      if (D().tool) return;                 // a tool is armed: the click is a draw click
      L.DomEvent.stop(e);
      select(sh.id);
    });
  }

  function render() {
    if (!group) return;
    group.clearLayers();
    D().shapes.forEach(draw);
  }

  function clearGhost() { if (ghost) { ghost.remove(); ghost = null; } }

  // Dashed preview of the shape being clicked out, following the cursor.
  function showGhost(to) {
    clearGhost();
    if (!pending || !map) return;
    const c = colour(), a = pending.pts[0];
    const opts = { color: c, weight: 2, dashArray: '5,5', fill: false, interactive: false };
    if (pending.kind === 'line') {
      const pts = to ? pending.pts.concat([to]) : pending.pts;
      if (pts.length < 2) return;
      ghost = L.polyline(pts, opts);
    } else if (to && pending.kind === 'circle') {
      ghost = L.circle(a, { ...opts, radius: acmaHaversineKm(a[0], a[1], to[0], to[1]) * 1000 });
    } else if (to && pending.kind === 'rect') {
      ghost = L.rectangle([a, to], opts);
    }
    if (ghost) ghost.addTo(map);
  }

  // ── shape list ──

  function add(shape) {
    shape.id = `d${++D().seq}`;
    // Stamped at birth: changing the picker later moves what comes next, not
    // what is already on the map.
    shape.colour = safeColour(D().colour);
    D().shapes.push(shape);
    D().selectedId = shape.id;
    render();
    rerenderPanel();
    return shape;
  }

  function select(id) {
    D().selectedId = D().selectedId === id ? null : id;
    render();
    rerenderPanel();
    const sh = D().shapes.find(s => s.id === D().selectedId);
    if (sh && map) map.panTo(centreOf(sh));
  }

  function remove(id) {
    D().shapes = D().shapes.filter(s => s.id !== id);
    if (D().selectedId === id) D().selectedId = null;
    render();
    rerenderPanel();
  }

  function clearAll() {
    if (D().shapes.length > 1 &&
        !confirm(`Remove all ${D().shapes.length} drawings?`)) return;
    D().shapes = [];
    D().selectedId = null;
    cancelPending();
    render();
    rerenderPanel();
  }

  // ── click-to-draw ──

  function cancelPending() {
    pending = null;
    clearGhost();
    clearSnapHint();
    updateFinishButton();
  }

  function finishLine() {
    if (pending && pending.kind === 'line' && pending.pts.length >= 2) {
      add({ kind: 'line', pts: pending.pts, snappedTo: pending.sids.slice() });
    }
    cancelPending();
  }

  function onClick(e) {
    const tool = D().tool;
    if (!tool || !map) return;
    const { ll, sid } = resolve(e.latlng);
    if (tool === 'pin') { add({ kind: 'pin', lat: ll[0], lon: ll[1], snappedTo: [sid] }); return; }
    if (tool === 'text') {
      const t = prompt('Annotation text');
      if (t && t.trim()) add({ kind: 'text', lat: ll[0], lon: ll[1], text: t.trim(), snappedTo: [sid] });
      return;
    }
    if (!pending || pending.kind !== tool) {
      pending = { kind: tool, pts: [ll], sids: [sid] };
      updateFinishButton();
      showGhost(null);
      return;
    }
    if (tool === 'line') {
      pending.pts.push(ll); pending.sids.push(sid);
      showGhost(null); updateFinishButton(); return;
    }
    const a = pending.pts[0], aSid = pending.sids[0];
    if (tool === 'circle') {
      const r = acmaHaversineKm(a[0], a[1], ll[0], ll[1]);
      if (r > 0) add({ kind: 'circle', lat: a[0], lon: a[1], radiusKm: r, snappedTo: [aSid, sid] });
    } else if (tool === 'rect') {
      const rect = rectFromCorners(a, ll);
      if (rect.widthKm > 0 && rect.heightKm > 0) add({ ...rect, snappedTo: [aSid, sid] });
    }
    cancelPending();
  }

  function onMove(e) {
    if (!map) return;
    // The ghost follows the point the click would actually use, so the preview
    // and the result are the same thing.
    const t = D().tool ? snapTarget(e.latlng) : null;
    showSnapHint(t);
    if (pending) showGhost(t ? [t.mnStation.lat, t.mnStation.lon] : [e.latlng.lat, e.latlng.lng]);
  }

  function onDblClick(e) {
    if (D().tool === 'line' && pending) { L.DomEvent.stop(e); finishLine(); }
  }

  function onKey(e) {
    if (e.key === 'Escape') { if (pending) cancelPending(); else setTool(''); }
    else if (e.key === 'Enter' && pending && pending.kind === 'line') finishLine();
  }

  function setTool(tool) {
    const D_ = D();
    cancelPending();
    snapCache = null;                 // the pins may have been rebuilt since
    D_.tool = D_.tool === tool ? '' : tool;
    if (map) {
      // While a tool is armed, clicks have to reach the map: station pins and
      // ACMA squares would otherwise swallow the one near the site you are
      // trying to draw around.
      map.getContainer().classList.toggle('mn-drawing', !!D_.tool);
      if (D_.tool === 'line') map.doubleClickZoom.disable();
      else                    map.doubleClickZoom.enable();
    }
    if (D_.tool && !keyHandler) {
      keyHandler = onKey;
      document.addEventListener('keydown', keyHandler);
    } else if (!D_.tool && keyHandler) {
      document.removeEventListener('keydown', keyHandler);
      keyHandler = null;
    }
    mapNote(D_.tool ? DRAW_TOOLS[D_.tool].hint : '', 0);
    rerenderPanel();
  }

  // ── typed-in shapes ──

  function num(id) {
    const el = document.getElementById(id);
    if (!el || el.value.trim() === '') return null;
    const v = Number(el.value);
    return isFinite(v) ? v : null;
  }

  function centreLatLon() {
    return map ? [map.getCenter().lat, map.getCenter().lng] : [0, 0];
  }

  // Fill the lat/lon boxes of whichever form is on screen with the middle of
  // the current view — the usual starting point for "about here, 20 km across".
  function useMapCentre(prefix) {
    const [lat, lon] = centreLatLon();
    const a = document.getElementById(`${prefix}-lat`);
    const b = document.getElementById(`${prefix}-lon`);
    if (a) a.value = lat.toFixed(5);
    if (b) b.value = lon.toFixed(5);
  }

  // Build a shape from the "place by numbers" form for the armed tool. Returns
  // null (with a note over the map) when the numbers don't describe anything.
  function shapeFromForm(kind) {
    const lat = num('dr-lat'), lon = num('dr-lon');
    if (lat == null || lon == null) { mapNote('Enter a latitude and longitude first', 3500); return null; }
    if (kind === 'pin')  return { kind: 'pin', lat, lon };
    if (kind === 'text') {
      const el = document.getElementById('dr-text');
      const t  = el ? el.value.trim() : '';
      if (!t) { mapNote('Enter the text of the annotation', 3500); return null; }
      return { kind: 'text', lat, lon, text: t };
    }
    if (kind === 'circle') {
      const r = num('dr-radius');
      if (!r || r <= 0) { mapNote('Enter a radius in km', 3500); return null; }
      return { kind: 'circle', lat, lon, radiusKm: r };
    }
    if (kind === 'rect') {
      const w = num('dr-width'), h = num('dr-height');
      if (!w || !h || w <= 0 || h <= 0) { mapNote('Enter a width and height in km', 3500); return null; }
      return { kind: 'rect', lat, lon, widthKm: w, heightKm: h };
    }
    // A line's far end can be given either way round: a second coordinate, or
    // a bearing and a distance from the first.
    const lat2 = num('dr-lat2'), lon2 = num('dr-lon2');
    if (lat2 != null && lon2 != null) return { kind: 'line', pts: [[lat, lon], [lat2, lon2]] };
    const brg = num('dr-bearing'), dist = num('dr-dist');
    if (dist != null && dist > 0) {
      return { kind: 'line', pts: [[lat, lon], destPoint(lat, lon, brg || 0, dist)] };
    }
    mapNote('Give the far end as a lat/lon, or as a bearing and distance', 4000);
    return null;
  }

  function addFromForm() {
    const kind  = D().tool || 'pin';
    const shape = shapeFromForm(kind);
    if (!shape) return;
    add(shape);
    if (map) map.panTo(centreOf(shape));
  }

  // Typing over a drawn shape's numbers — the other half of "draw it roughly,
  // then make it exact".
  function applyEdit(id) {
    const sh = D().shapes.find(s => s.id === id);
    if (!sh) return;
    const v = k => {
      const el = document.getElementById(`de-${k}`);
      if (!el) return null;
      if (k === 'text') return el.value.trim();
      const n = Number(el.value);
      return el.value.trim() === '' || !isFinite(n) ? null : n;
    };
    if (sh.kind === 'line') {
      const a = [v('lat'), v('lon')], b = [v('lat2'), v('lon2')];
      if (a.some(x => x == null) || b.some(x => x == null)) { mapNote('Both ends need a lat and lon', 3500); return; }
      sh.pts = [a, b];
    } else {
      const lat = v('lat'), lon = v('lon');
      if (lat == null || lon == null) { mapNote('Enter a latitude and longitude', 3500); return; }
      sh.lat = lat; sh.lon = lon;
      if (sh.kind === 'circle') sh.radiusKm = Math.max(v('radius') || 0, 0.001);
      if (sh.kind === 'rect')   { sh.widthKm = Math.max(v('width') || 0, 0.001);
                                  sh.heightKm = Math.max(v('height') || 0, 0.001); }
      if (sh.kind === 'text')   sh.text = v('text') || sh.text;
    }
    // Numbers typed over a snapped point are the operator overruling the snap:
    // whatever station it used to sit on, it does not any more. Cleared only
    // once the edit has actually been taken — a rejected one changes nothing.
    sh.snappedTo = null;
    render();
    rerenderPanel();
  }

  function toggleLabels(on) {
    D().showLabels = on;
    render();
  }

  // Sometimes the pin is the correct location and the station is not, so this
  // has to be switchable rather than always on.
  function toggleSnap(on) {
    D().snap = on;
    if (!on) clearSnapHint();
    rerenderPanel();
  }

  // ── shape → station selection ──
  // The candidates are the markers actually on the map, so "the stations inside
  // this shape" means the ones the operator can see inside it: with "hide
  // stations that don't match" on, the hidden ones are not in the box.
  function stationsInside(sh) {
    const out = [];
    if (sh.kind === 'circle') {
      for (const m of state.mapMarkers) {
        const s = m.mnStation;
        if (s && acmaHaversineKm(sh.lat, sh.lon, s.lat, s.lon) <= sh.radiusKm) out.push(s.id);
      }
    } else if (sh.kind === 'rect') {
      const [[latMin, lonMin], [latMax, lonMax]] = rectBounds(sh);
      for (const m of state.mapMarkers) {
        const s = m.mnStation;
        if (s && s.lat >= latMin && s.lat <= latMax && s.lon >= lonMin && s.lon <= lonMax) out.push(s.id);
      }
    }
    return out;
  }

  // Additive, so two boxes combine; shift replaces instead, for starting again
  // without going via Clear.
  function selectInside(id, ev) {
    const sh = D().shapes.find(s => s.id === id);
    if (!sh) return;
    const ids = stationsInside(sh);
    if (!ids.length) { mapNote('No stations inside that shape', 3000); return; }
    if (ev && ev.shiftKey) state.mapSelection.clear();
    const added = addToMapSelection(ids);
    const total = state.mapSelection.size;
    mapNote(added
      ? `${added} station${added === 1 ? '' : 's'} added — ${total} selected`
      : `Already in the selection — ${total} selected`, 3500);
  }

  function updateFinishButton() {
    const btn = document.getElementById('draw-finish');
    if (btn) btn.hidden = !(pending && pending.kind === 'line' && pending.pts.length >= 2);
  }

  // ── the pane ──

  function field(id, label, value, step, placeholder) {
    return `
      <label class="draw-field">
        <span>${esc(label)}</span>
        <input type="number" id="${id}" step="${step}" value="${value ?? ''}"
               placeholder="${placeholder || ''}" inputmode="decimal">
      </label>`;
  }

  function newFormHtml(kind) {
    const rows = [field('dr-lat', kind === 'line' ? 'From lat' : 'Latitude', '', 'any'),
                  field('dr-lon', kind === 'line' ? 'From lon' : 'Longitude', '', 'any')];
    if (kind === 'circle') rows.push(field('dr-radius', 'Radius (km)', '', '0.1'));
    if (kind === 'rect')   rows.push(field('dr-width', 'Width (km)', '', '0.1'),
                                     field('dr-height', 'Height (km)', '', '0.1'));
    if (kind === 'line')   rows.push(field('dr-lat2', 'To lat', '', 'any'),
                                     field('dr-lon2', 'To lon', '', 'any'),
                                     field('dr-bearing', 'or bearing (°)', '', '1'),
                                     field('dr-dist', 'and distance (km)', '', '0.1'));
    return `
      <div class="draw-form">${rows.join('')}</div>
      ${kind === 'text' ? `
        <label class="draw-field draw-field-wide">
          <span>Text</span>
          <input type="text" id="dr-text" placeholder="e.g. flood watch area">
        </label>` : ''}
      <div class="draw-actions">
        <button onclick="MapDraw.useMapCentre('dr')">Map centre</button>
        <button class="primary" onclick="MapDraw.addFromForm()">Add ${esc(DRAW_TOOLS[kind].label.toLowerCase())}</button>
      </div>`;
  }

  function editFormHtml(sh) {
    const rows = [];
    if (sh.kind === 'line') {
      rows.push(field('de-lat', 'From lat', sh.pts[0][0].toFixed(5), 'any'),
                field('de-lon', 'From lon', sh.pts[0][1].toFixed(5), 'any'),
                field('de-lat2', 'To lat', sh.pts[1][0].toFixed(5), 'any'),
                field('de-lon2', 'To lon', sh.pts[1][1].toFixed(5), 'any'));
    } else {
      rows.push(field('de-lat', 'Latitude',  sh.lat.toFixed(5), 'any'),
                field('de-lon', 'Longitude', sh.lon.toFixed(5), 'any'));
      if (sh.kind === 'circle') rows.push(field('de-radius', 'Radius (km)', +sh.radiusKm.toFixed(3), '0.1'));
      if (sh.kind === 'rect')   rows.push(field('de-width', 'Width (km)',  +sh.widthKm.toFixed(3), '0.1'),
                                          field('de-height', 'Height (km)', +sh.heightKm.toFixed(3), '0.1'));
    }
    return `
      <div class="draw-edit">
        <div class="draw-form">${rows.join('')}</div>
        ${sh.kind === 'text' ? `
          <label class="draw-field draw-field-wide">
            <span>Text</span>
            <input type="text" id="de-text" value="${esc(sh.text)}">
          </label>` : ''}
        <div class="draw-actions">
          <button onclick="MapDraw.applyEdit('${escAttr(sh.id)}')">Apply</button>
        </div>
      </div>`;
  }

  function listHtml() {
    const D_ = D();
    if (!D_.shapes.length) return '<p class="filter-note">Nothing drawn yet.</p>';
    return `<div class="draw-list">${D_.shapes.map(sh => {
      const sel = sh.id === D_.selectedId;
      // A hand-drawn multi-leg line has no small set of numbers to type over,
      // so it lists its length and leaves it there; everything else opens its
      // measurements for editing when picked.
      const editable = sel && (sh.kind !== 'line' || sh.pts.length === 2);
      // Circles and rectangles have an inside, so they can hand it to the map
      // selection. Reusing the drawn shape rather than a separate "selection
      // tool" means a selection box can be typed to exact dimensions like
      // everything else in this panel.
      const canPick = sh.kind === 'circle' || sh.kind === 'rect';
      return `
        <div class="draw-row${sel ? ' sel' : ''}">
          <button class="draw-row-main" onclick="MapDraw.select('${escAttr(sh.id)}')"
                  title="Select and centre on it">
            <span class="draw-row-icon" style="color:${colourOf(sh)}">${DRAW_TOOLS[sh.kind].icon}</span>
            <span class="draw-row-text">${esc(rowText(sh))}</span>
          </button>
          ${canPick ? `
            <button class="draw-pick"
                    title="Select the stations inside this shape into the list below the map (shift-click to replace the current selection)"
                    onclick="MapDraw.selectInside('${escAttr(sh.id)}',event)">Select inside</button>` : ''}
          <button class="draw-del" title="Delete"
                  onclick="MapDraw.remove('${escAttr(sh.id)}')">✕</button>
        </div>
        ${editable ? editFormHtml(sh) : ''}`;
    }).join('')}</div>`;
  }

  function colourHtml() {
    const cur = colour();
    const picked = safeColour(D().colour).toLowerCase();
    return `
      <div class="draw-colour">
        <span class="draw-colour-label">Colour</span>
        <div class="draw-swatches">
          ${DRAW_COLOURS.map(([c, name]) => `
            <button class="draw-swatch${picked === c ? ' on' : ''}" style="--sw:${c}"
                    title="${esc(name)}" aria-label="${esc(name)}"
                    onclick="MapDraw.setColour('${c}')"></button>`).join('')}
          <input type="color" class="draw-colour-input" value="${escAttr(cur)}"
                 title="Any other colour" aria-label="Pick any colour"
                 onchange="MapDraw.setColour(this.value)">
        </div>
      </div>`;
  }

  function panelHtml() {
    const D_ = D();
    return `
      <div class="panel-header">
        <h3>Draw &amp; measure</h3>
        <button class="filter-reset" onclick="MapDraw.clearAll()"
                ${D_.shapes.length ? '' : 'disabled'}>Clear all</button>
      </div>
      <div class="draw-tools">
        ${Object.entries(DRAW_TOOLS).map(([k, t]) => `
          <button class="draw-tool${D_.tool === k ? ' on' : ''}" title="${esc(t.hint)}"
                  onclick="MapDraw.setTool('${k}')">
            <span class="draw-tool-icon">${t.icon}</span>${esc(t.label)}
          </button>`).join('')}
      </div>
      <p class="filter-hint">${D_.tool
        ? esc(DRAW_TOOLS[D_.tool].hint) + ' Esc stops.'
        : 'Pick a tool, then draw on the map or type the numbers in. Nothing is saved — clip the screen to keep it.'}</p>
      <button id="draw-finish" hidden onclick="MapDraw.finishLine()">Finish line</button>
      ${colourHtml()}
      ${D_.tool ? `
        <details class="draw-numeric" open>
          <summary class="small">Place by numbers</summary>
          ${newFormHtml(D_.tool)}
        </details>` : ''}
      <label class="filter-check">
        <input type="checkbox" ${D_.snap ? 'checked' : ''}
               onchange="MapDraw.toggleSnap(this.checked)">
        Snap to stations
      </label>
      <p class="filter-hint">${D_.snap
        ? 'Clicks within about 15 px of a station pin land on that station, and the shape is named after it.'
        : 'Points land exactly where you click.'}</p>
      <label class="filter-check">
        <input type="checkbox" ${D_.showLabels ? 'checked' : ''}
               onchange="MapDraw.toggleLabels(this.checked)">
        Show measurements on the map
      </label>
      ${listHtml()}`;
  }

  function rerenderPanel() {
    const el = document.getElementById('map-draw-panel');
    if (el) { el.innerHTML = panelHtml(); updateFinishButton(); }
    // The elevation profile hangs off whichever line is current, and this is the
    // one place that changes: a shape added, selected, edited or deleted. A line
    // being dragged out never gets here, which is the debounce — PathProfile
    // compares the geometry itself and only fetches when it actually moved.
    PathProfile.sync();
  }

  return {
    attach(m) {
      map   = m;
      group = L.layerGroup().addTo(m);
      pending = null; ghost = null; snapHint = null; snapCache = null;
      m.on('click', onClick);
      m.on('mousemove', onMove);
      m.on('dblclick', onDblClick);
      // A tool left armed from a previous visit to the tab stays armed, so the
      // new map has to be put back into drawing mode — including the hint,
      // which went with the old map's note strip.
      if (D().tool) {
        m.getContainer().classList.add('mn-drawing');
        if (D().tool === 'line') m.doubleClickZoom.disable();
        if (!keyHandler) { keyHandler = onKey; document.addEventListener('keydown', keyHandler); }
        mapNote(DRAW_TOOLS[D().tool].hint, 0);
      }
      render();
    },

    // The map is going away (tab switch, re-render). The shapes themselves are
    // plain numbers in state and are redrawn on the next attach.
    detach() {
      if (keyHandler) { document.removeEventListener('keydown', keyHandler); keyHandler = null; }
      clearGhost();
      clearSnapHint();
      pending = null; snapCache = null;
      map = null; group = null;
    },

    panelHtml, rerenderPanel, render, setTool, select, remove, clearAll,
    finishLine, addFromForm, applyEdit, useMapCentre, toggleLabels, measure,
    setColour, toggleSnap, selectInside, lineKm,

    // Where a map click actually lands, snapping included — so the link budget
    // picks endpoints by the same rule the draw tools do rather than growing a
    // second, subtly different one.
    resolveClick(latlng) { return resolve(latlng); },

    // Drop a two-point line in programmatically (the link budget asking for a
    // profile of its own path). Same shape, same list, same everything.
    addLine(pts, sids) {
      return add({ kind: 'line', pts: pts.map(p => p.slice()), snappedTo: (sids || []).slice() });
    },
  };
})();

// ── Path physics ─────────────────────────────────────────────────────────────
// The maths shared by the elevation profile and the link budget. Deliberately
// small and deliberately visible: every term below turns up as its own line in
// the budget table, because a single predicted number is exactly the thing this
// feature must not become.

const PATH_DEFAULT_MHZ = 151.5;   // the network's own VHF band — RM_NET_DEFAULTS is 151–152
const PATH_DEFAULT_AGL = 4;       // m, the Field Station 1W antenna height in rm_systems
const EARTH_R_M        = 6371008.8;
// Standard-atmosphere effective earth radius. "Simplified" in the comparison
// table against Radio Mobile means exactly this: one fixed k, no climate.
const PATH_K_FACTOR    = 4 / 3;

// First Fresnel zone radius at a point d1 from one end and d2 from the other.
//
//   r1 = sqrt(λ·d1·d2 / (d1 + d2))
//
// which in the field units is r1 = 17.32·sqrt(d1_km·d2_km / (f_GHz·D_km)). Note
// that this is *not* the 8.657 coefficient quoted in the ticket: 8.657 is the
// same formula already specialised to the path midpoint with the total distance
// as its argument (17.32/2 = 8.66). Using 8.657 against d1·d2/(f·D) would halve
// the zone everywhere, and a half-size Fresnel zone reports clearance that is
// not there — the one direction this must never err in.
function fresnelR1(d1_m, d2_m, fMhz) {
  const d = d1_m + d2_m;
  if (!(d > 0) || !(fMhz > 0) || d1_m < 0 || d2_m < 0) return 0;
  const lambda = 299.792458 / fMhz;                 // metres
  return Math.sqrt(lambda * d1_m * d2_m / d);
}

// How much the earth rises between the two ends. Added to the ground rather
// than bent into the line of sight, so the plot keeps a straight LOS and reads
// the way a Radio Mobile profile does.
function earthBulge(d1_m, d2_m) {
  return (d1_m * d2_m) / (2 * PATH_K_FACTOR * EARTH_R_M);
}

// Fresnel-Kirchhoff diffraction parameter. h is the obstruction height above
// the line of sight — positive when terrain is actually blocking.
function fresnelV(h_m, d1_m, d2_m, fMhz) {
  const r1 = fresnelR1(d1_m, d2_m, fMhz);
  return r1 > 0 ? Math.SQRT2 * h_m / r1 : 0;
}

// Single knife-edge diffraction loss, the ITU-R P.526 approximation. ~6 dB at
// grazing (v = 0), which is the number that makes a "just touching" path read
// as already costing something.
function knifeEdgeDb(v) {
  if (v <= -0.78) return 0;
  return 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1);
}

function fsplDb(dKm, fMhz) {
  if (!(dKm > 0) || !(fMhz > 0)) return 0;
  return 32.44 + 20 * Math.log10(fMhz) + 20 * Math.log10(dKm);
}

function wattsToDbm(w) { return w > 0 ? 10 * Math.log10(w * 1000) : null; }

// The Radio Mobile system a station is configured with — where its transmit
// power, feeder loss, antenna gain and height, and receiver threshold all
// already live. Every station carries an rm_system_id, so a link budget between
// two stations needs nothing typed in at all.
function rmSystemOf(st) {
  if (!st || st.rm_system_id == null || !state.data) return null;
  return (state.data.rm_systems || []).find(r => r.id === st.rm_system_id) || null;
}

// Turn a terrain profile into the geometry both features read off: line of
// sight from antenna to antenna, the 60% Fresnel envelope around it, and where
// the ground gets into that envelope.
//
// `elevA`/`elevB` override the sampled ground at the ends — a snapped station's
// own elevation_ahd beats a tile pixel, and mixing them is the datum compromise
// the UI declares rather than hides.
function pathAnalyse(prof, opt) {
  const o = opt || {};
  const fMhz = o.freqMhz > 0 ? o.freqMhz : PATH_DEFAULT_MHZ;
  const D    = prof.distance_m[prof.distance_m.length - 1];
  const g    = prof.terrain_m.slice();
  const last = g.length - 1;

  // The ends: a station's surveyed height where we have one, the tile otherwise.
  const groundA = o.elevA != null ? o.elevA : g[0];
  const groundB = o.elevB != null ? o.elevB : g[last];
  if (groundA != null) g[0] = groundA;
  if (groundB != null) g[last] = groundB;
  if (groundA == null || groundB == null) {
    return { ok: false, error: 'No ground height at one or both ends of the path.' };
  }

  const aglA = o.aglA != null ? o.aglA : PATH_DEFAULT_AGL;
  const aglB = o.aglB != null ? o.aglB : PATH_DEFAULT_AGL;
  const txZ  = groundA + aglA, rxZ = groundB + aglB;

  const pts = [];
  let worst = null, maxIntrusion = 0, maxV = -Infinity;
  for (let i = 0; i < g.length; i++) {
    const d1 = prof.distance_m[i], d2 = D - d1;
    const los = txZ + (rxZ - txZ) * (D > 0 ? d1 / D : 0);
    const r1  = fresnelR1(d1, d2, fMhz);
    const bulge = earthBulge(d1, d2);
    const ground = g[i];
    const p = { d1, los, r1, bulge, ground,
                bulged: ground == null ? null : ground + bulge,
                clearance: null, ratio: null };
    if (ground != null) {
      p.clearance = los - p.bulged;                  // metres of air under the line
      if (r1 > 0) {
        p.ratio = p.clearance / r1;                  // in first-Fresnel radii
        if (worst == null || p.ratio < worst.ratio) worst = { ...p, i };
        const intrusion = 0.6 * r1 - p.clearance;    // into the 60% zone
        if (intrusion > maxIntrusion) maxIntrusion = intrusion;
        const v = fresnelV(-p.clearance, d1, d2, fMhz);
        if (v > maxV) maxV = v;
      }
    }
    pts.push(p);
  }
  if (!worst) return { ok: false, error: 'No usable terrain samples along this path.' };

  // The dominant edge, treated as a single knife edge. A proxy, and labelled as
  // one wherever it is shown.
  const diffractionDb = isFinite(maxV) ? knifeEdgeDb(maxV) : 0;
  const verdict = worst.ratio >= 0.6 ? 'clear' : worst.ratio >= 0 ? 'marginal' : 'obstructed';

  return {
    ok: true, pts, worst, verdict, fMhz,
    D, txZ, rxZ, groundA, groundB, aglA, aglB,
    intrusion_m: Math.max(0, maxIntrusion),
    diffraction_db: diffractionDb,
    v: isFinite(maxV) ? maxV : null,
    partial: !!prof.partial,
  };
}

const PATH_VERDICT = {
  clear:      { label: 'Clear',      cls: 'ok',
                note: 'Ground stays clear of the 60% Fresnel zone the whole way.' },
  marginal:   { label: 'Marginal',   cls: 'warn',
                note: 'Ground intrudes into the 60% Fresnel zone but stays below line of sight.' },
  obstructed: { label: 'Obstructed', cls: 'bad',
                note: 'Ground rises above the line of sight — this path is blocked.' },
};

// ── Elevation profile (Stations map) ─────────────────────────────────────────
// Draw a line on the map and see the ground under it. The quickest read there
// is on whether a path is plausible, before anyone opens Radio Mobile.
//
// The chart is inline SVG built the same way rfStripPlotHtml and rfcChartHtml
// build theirs — no charting library, and nothing fetched to draw it.
//
// The profile is recomputed when the line is finished, selected or typed over,
// never while it is being dragged out: MapDraw.rerenderPanel is the one hook,
// and a geometry signature stops a repeat of the same path re-fetching.

const PathProfile = (function () {
  const SAMPLES = 256;
  let cur = { sig: null, status: 'idle', prof: null, error: '' };

  const P = () => state.path;

  // The line being profiled: the selected one, or failing that the last one
  // drawn — drawing a line selects it, so in practice this is "the line you
  // just made" without the panel going blank the moment you click elsewhere.
  function target() {
    const lines = state.draw.shapes.filter(s => s.kind === 'line');
    if (!lines.length) return null;
    const sel = lines.find(s => s.id === state.draw.selectedId);
    return sel || lines[lines.length - 1];
  }

  function sigOf(sh) {
    return sh ? sh.id + ':' + sh.pts.map(p => p[0].toFixed(5) + ',' + p[1].toFixed(5)).join(';') : null;
  }

  function stationOf(sh, end) {
    const t = sh.snappedTo;
    if (!t || !t.length || !state.data) return null;
    const id = end === 0 ? t[0] : t[t.length - 1];
    return id ? state.data.stations.find(s => s.id === id) || null : null;
  }

  // What each end of the line is: a station (with its surveyed height and its
  // radio system) or just a point on the ground.
  function endpoint(sh, end) {
    const i = end === 0 ? 0 : sh.pts.length - 1;
    const st = stationOf(sh, end);
    const sys = st ? rmSystemOf(st) : null;
    return {
      station: st, sys,
      name: st ? st.name : `${sh.pts[i][0].toFixed(4)}, ${sh.pts[i][1].toFixed(4)}`,
      isStation: !!st,
      elev: st && st.elevation_ahd != null ? st.elevation_ahd : null,
      agl: sys && sys.antenna_height_m != null ? sys.antenna_height_m : PATH_DEFAULT_AGL,
    };
  }

  // The frequency to run the Fresnel maths at: whatever repeater is on either
  // end of this path, else the band the network lives in.
  function freqFor(a, b) {
    if (P().freqMhz > 0) return P().freqMhz;
    for (const e of [a, b]) {
      const r = e.station && e.station.repeater;
      if (r && r.rx_mhz > 0) return r.rx_mhz;
    }
    return PATH_DEFAULT_MHZ;
  }

  // Called on every draw-panel re-render. Cheap when nothing moved: the
  // signature is the debounce, so dragging a line out costs nothing and only a
  // finished (or edited, or re-selected) line fetches terrain.
  function sync() {
    const sh = target();
    const sig = sigOf(sh);
    if (sig === cur.sig) { rerender(); return; }
    cur = { sig, status: sh ? 'loading' : 'idle', prof: null, error: '' };
    rerender();
    if (!sh) return;
    const mine = sig;
    Terrain.profile(sh.pts, SAMPLES).then(res => {
      if (cur.sig !== mine) return;                 // the line moved on while we fetched
      cur.status = res.ok ? 'ready' : 'failed';
      cur.prof   = res.ok ? res : null;
      cur.error  = res.ok ? '' : res.error;
      rerender();
      // The budget quotes this profile's diffraction term, so it follows it.
      LinkBudget.profileChanged();
    });
  }

  // ── the chart ──

  // `flat` draws the ground and nothing else — the multi-leg case, where there
  // is a distance profile but no single radio path to put a line of sight on.
  function chartSvg(an, prof, flat) {
    const W = 920, H = 300;
    const L = 52, R = 14, T = 14, B = 30;
    const iw = W - L - R, ih = H - T - B;
    const D  = an.D;

    // Everything that has to fit: ground with its curvature bulge, both
    // antennas, and the top of the Fresnel envelope.
    let lo = Infinity, hi = -Infinity;
    for (const p of an.pts) {
      if (p.bulged != null) { lo = Math.min(lo, p.bulged); hi = Math.max(hi, p.bulged); }
      if (!flat) {
        hi = Math.max(hi, p.los + 0.6 * p.r1);
        lo = Math.min(lo, p.los - 0.6 * p.r1);
      }
    }
    if (!isFinite(lo) || !isFinite(hi)) return '';
    const pad = Math.max(20, (hi - lo) * 0.1);
    lo -= pad; hi += pad;

    const x = d => L + (D > 0 ? d / D : 0) * iw;
    const y = m => T + (1 - (m - lo) / (hi - lo)) * ih;

    // Ground, as an area down to the axis. Gaps where a tile was missing are
    // left as gaps — a bridged gap would be invented ground.
    const runs = [];
    let run = [];
    for (const p of an.pts) {
      if (p.bulged == null) { if (run.length) runs.push(run); run = []; }
      else run.push(p);
    }
    if (run.length) runs.push(run);
    const ground = runs.map(r => {
      const top = r.map(p => `${x(p.d1).toFixed(1)},${y(p.bulged).toFixed(1)}`).join(' L');
      return `<path d="M${x(r[0].d1).toFixed(1)},${(T + ih).toFixed(1)} L${top} L${x(r[r.length - 1].d1).toFixed(1)},${(T + ih).toFixed(1)} Z"
                    fill="var(--terrain-fill)" stroke="var(--terrain-line)" stroke-width="1"/>`;
    }).join('');

    // Where the ground is inside the 60% zone, drawn over the top of it.
    const bad = [];
    let seg = [];
    for (const p of an.pts) {
      const intruding = p.bulged != null && p.clearance != null && p.clearance < 0.6 * p.r1;
      if (intruding) seg.push(p);
      else if (seg.length) { bad.push(seg); seg = []; }
    }
    if (seg.length) bad.push(seg);
    const obstruction = bad.map(r => `<polyline points="${
      r.map(p => `${x(p.d1).toFixed(1)},${y(p.bulged).toFixed(1)}`).join(' ')
    }" fill="none" stroke="var(--bad)" stroke-width="2.5"/>`).join('');

    const radio = flat ? '' : `
      <polyline points="${an.pts.map(p => `${x(p.d1).toFixed(1)},${y(p.los + 0.6 * p.r1).toFixed(1)}`).join(' ')}"
                fill="none" stroke="var(--accent)" stroke-width="1" stroke-dasharray="4 3" opacity=".7"/>
      <polyline points="${an.pts.map(p => `${x(p.d1).toFixed(1)},${y(p.los - 0.6 * p.r1).toFixed(1)}`).join(' ')}"
                fill="none" stroke="var(--accent)" stroke-width="1" stroke-dasharray="4 3" opacity=".7"/>
      <line x1="${x(0)}" y1="${y(an.txZ).toFixed(1)}" x2="${x(D).toFixed(1)}" y2="${y(an.rxZ).toFixed(1)}"
            stroke="var(--accent)" stroke-width="1.8"/>`;

    // The masts themselves, so an antenna height reads as a height.
    const masts = flat ? '' : `
      <line x1="${x(0)}" y1="${y(an.groundA).toFixed(1)}" x2="${x(0)}" y2="${y(an.txZ).toFixed(1)}"
            stroke="var(--map-repeater)" stroke-width="2"/>
      <line x1="${x(D).toFixed(1)}" y1="${y(an.groundB).toFixed(1)}" x2="${x(D).toFixed(1)}" y2="${y(an.rxZ).toFixed(1)}"
            stroke="var(--map-repeater)" stroke-width="2"/>`;

    // Elevation gridlines on rounded values, so the axis reads in whole metres.
    const span = hi - lo;
    const stepM = span > 1600 ? 400 : span > 800 ? 200 : span > 400 ? 100 : span > 160 ? 50 : 20;
    const grid = [];
    for (let m = Math.ceil(lo / stepM) * stepM; m <= hi; m += stepM) {
      grid.push(`<line x1="${L}" y1="${y(m).toFixed(1)}" x2="${W - R}" y2="${y(m).toFixed(1)}"
                       stroke="var(--border)" stroke-width="1"/>
                 <text x="${L - 6}" y="${(y(m) + 3.5).toFixed(1)}" font-size="10" text-anchor="end"
                       style="fill:var(--muted)">${m}</text>`);
    }
    // The end labels are anchored inwards so neither runs off the viewBox.
    const xticks = [0, .25, .5, .75, 1].map(f => `
      <text x="${x(D * f).toFixed(1)}" y="${H - 10}" font-size="10"
            text-anchor="${f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}"
            style="fill:var(--muted)">${fmtKm(D * f / 1000)}</text>`).join('');

    const w = an.worst;
    const marker = !flat && w && w.ratio < 0.6 ? `
      <line x1="${x(w.d1).toFixed(1)}" y1="${y(w.bulged).toFixed(1)}"
            x2="${x(w.d1).toFixed(1)}" y2="${y(w.los).toFixed(1)}"
            stroke="var(--bad)" stroke-width="1.5" stroke-dasharray="3 3"/>
      <circle cx="${x(w.d1).toFixed(1)}" cy="${y(w.bulged).toFixed(1)}" r="3.5" fill="var(--bad)"/>` : '';

    return `
      <div class="path-chart-wrap">
        <svg viewBox="0 0 ${W} ${H}" class="path-chart" role="img"
             aria-label="Terrain profile with line of sight and 60% Fresnel zone">
          ${grid.join('')}
          ${radio}
          ${ground}
          ${flat ? '' : obstruction}
          ${marker}
          ${masts}
          <line x1="${L}" y1="${T + ih}" x2="${W - R}" y2="${T + ih}" stroke="var(--muted)" stroke-width="1"/>
          ${xticks}
        </svg>
        <div class="path-key small">
          ${flat ? '' : `
            <span><i class="path-key-los"></i> Line of sight</span>
            <span><i class="path-key-fres"></i> 60% Fresnel zone</span>`}
          <span><i class="path-key-gnd"></i> Ground (curvature k=4/3 included)</span>
          ${flat ? '' : '<span><i class="path-key-obs"></i> Inside the Fresnel zone</span>'}
        </div>
        <p class="filter-hint">${esc(prof.attribution)} · sampled every
          ~${prof.resolution_m} m at zoom ${prof.zoom} over ${prof.tiles} tile${prof.tiles === 1 ? '' : 's'}${
          prof.capped ? ', zoom reduced to stay inside the tile budget for a path this long' : ''}.</p>
      </div>`;
  }

  // ── the panel ──

  function readoutHtml(an, a, b) {
    const v = PATH_VERDICT[an.verdict];
    const w = an.worst;
    return `
      <div class="path-readout">
        <div class="path-verdict ${v.cls}">
          <strong>${v.label}</strong>
          <span class="small">${esc(v.note)}</span>
        </div>
        <dl class="path-stats">
          <div><dt>Path</dt><dd>${esc(a.name)} → ${esc(b.name)}</dd></div>
          <div><dt>Distance</dt><dd>${fmtKm(an.D / 1000)}</dd></div>
          <div><dt>Frequency</dt><dd>${an.fMhz.toFixed(3)} MHz</dd></div>
          <div><dt>Worst clearance</dt><dd>${w.clearance >= 0
            ? `${Math.round(w.clearance)} m under the line · ${w.ratio.toFixed(2)}&nbsp;F1`
            : `<span style="color:var(--bad)">${Math.round(-w.clearance)} m above the line</span>`}
            <span class="small" style="color:var(--muted)">at ${fmtKm(w.d1 / 1000)}</span></dd></div>
          <div><dt>Into 60% zone</dt><dd>${an.intrusion_m > 0
            ? `${Math.round(an.intrusion_m)} m` : 'nothing'}</dd></div>
          <div><dt>Diffraction proxy</dt><dd>${an.diffraction_db > 0.05
            ? `${an.diffraction_db.toFixed(1)} dB` : '0 dB'}</dd></div>
        </dl>
      </div>`;
  }

  function endsFormHtml(a, b, an) {
    // Where a value came from, under the box it is in — so an antenna height
    // that arrived from the station's own system says so, and one that was
    // typed doesn't pretend to have.
    const src = (e, over) => `<b class="path-src">${
      over != null ? 'edited'
        : e.isStation && e.sys ? `default · ${esc(e.sys.name)}`
        : 'default'}</b>`;
    return `
      <div class="path-form">
        <label class="draw-field">
          <span>${esc(a.name)} antenna (m AGL)</span>
          <input type="number" step="0.5" min="0" value="${an.aglA}"
                 onchange="PathProfile.setAgl('A', this.value)">
          ${src(a, P().aglA)}
        </label>
        <label class="draw-field">
          <span>${esc(b.name)} antenna (m AGL)</span>
          <input type="number" step="0.5" min="0" value="${an.aglB}"
                 onchange="PathProfile.setAgl('B', this.value)">
          ${src(b, P().aglB)}
        </label>
        <label class="draw-field">
          <span>Frequency (MHz)</span>
          <input type="number" step="0.1" min="1" value="${an.fMhz}"
                 onchange="PathProfile.setFreq(this.value)">
          <b class="path-src">${P().freqMhz != null ? 'edited'
            : (a.station && a.station.repeater) || (b.station && b.station.repeater)
              ? 'default · repeater channel' : 'default · network band'}</b>
        </label>
      </div>`;
  }

  function bodyHtml() {
    const sh = target();
    if (!sh) return '';
    const a = endpoint(sh, 0), b = endpoint(sh, 1);
    const multi = sh.pts.length > 2;

    if (cur.status === 'loading') {
      return `<p class="filter-note">Sampling terrain along ${fmtKm(MapDraw.lineKm(sh.pts))} of path…</p>`;
    }
    if (cur.status === 'failed') {
      return `
        <div class="path-fail">
          <strong>Terrain data unavailable.</strong>
          <span class="small">${esc(cur.error)}</span>
          <span class="small">No profile is drawn rather than a flat one — flat ground would read as a clear path.</span>
          <button onclick="PathProfile.refresh()">Try again</button>
        </div>`;
    }
    if (cur.status !== 'ready' || !cur.prof) return '';

    const prof = cur.prof;
    const warn = prof.partial ? `
      <p class="path-warn small">${prof.missing} of ${prof.terrain_m.length} samples had no tile —
        the profile is drawn with gaps rather than guessed through them.</p>` : '';

    // A dog-leg is a distance profile and nothing more. Drawing a line of sight
    // end to end across a corner would be describing a radio path that isn't
    // the one drawn.
    if (multi) {
      const an = pathAnalyse(prof, { elevA: a.elev, elevB: b.elev, aglA: 0, aglB: 0 });
      return `
        <p class="path-warn small">This line has ${sh.pts.length - 1} legs, so it is a
          <strong>distance profile only</strong> — no line of sight and no Fresnel zone.
          A dog-leg is not a radio path. Draw a two-point line to analyse a hop.</p>
        ${warn}
        ${an.ok ? chartSvg(an, prof, true) : `<p class="filter-note">${esc(an.error)}</p>`}`;
    }

    const an = pathAnalyse(prof, {
      elevA: a.elev, elevB: b.elev,
      aglA: P().aglA != null ? P().aglA : a.agl,
      aglB: P().aglB != null ? P().aglB : b.agl,
      freqMhz: freqFor(a, b),
    });
    if (!an.ok) return `<p class="filter-note">${esc(an.error)}</p>`;

    const datum = (a.elev != null || b.elev != null) ? `
      <p class="filter-hint">Ends use the station's surveyed <code>elevation_ahd</code> (AHD);
        the ground between comes from tiles referenced to the EGM96 geoid. The two agree to
        about a metre over Australia — inside the ~${prof.resolution_m} m sampling error, but not the
        same datum. Treat every height here as indicative.</p>` : `
      <p class="filter-hint">All heights are sampled from tiles (EGM96 geoid, not AHD) — neither
        end is snapped to a station with a surveyed elevation.</p>`;

    return `
      ${readoutHtml(an, a, b)}
      ${warn}
      ${chartSvg(an, prof)}
      ${endsFormHtml(a, b, an)}
      ${datum}
      <div class="path-actions">
        <button onclick="LinkBudget.fromProfile()">Link budget for this path →</button>
      </div>`;
  }

  function panelHtml() {
    const sh = target();
    if (!sh) return '';
    return `
      <details class="path-panel" ${P().open ? 'open' : ''}
               ontoggle="PathProfile.setOpen(this.open)">
        <summary>
          <h3>Elevation profile</h3>
          <span class="small">${esc(MapDraw.measure(sh))}</span>
        </summary>
        <div class="path-body">${bodyHtml()}</div>
      </details>`;
  }

  function rerender() {
    const el = document.getElementById('path-profile-panel');
    if (!el) return;
    const sh = target();
    el.hidden = !sh;                       // no line drawn: the panel isn't there at all
    el.innerHTML = sh ? panelHtml() : '';
  }

  return {
    sync, rerender,
    setOpen(v) { P().open = !!v; },
    setAgl(which, v) {
      const n = v.trim() === '' ? null : Number(v);
      P()[which === 'A' ? 'aglA' : 'aglB'] = isFinite(n) ? n : null;
      rerender();
      LinkBudget.profileChanged();
    },
    setFreq(v) {
      const n = Number(v);
      P().freqMhz = isFinite(n) && n > 0 ? n : null;
      rerender();
      LinkBudget.profileChanged();
    },
    refresh() { cur.sig = null; sync(); },
    // What the link budget quotes for its diffraction line: the analysis of the
    // same two points, or null when there isn't one.
    analysisFor(latA, lonA, latB, lonB, opt) {
      if (cur.status !== 'ready' || !cur.prof) return null;
      const sh = target();
      if (!sh || sh.pts.length !== 2) return null;
      const near = (p, lat, lon) => Math.abs(p[0] - lat) < 1e-4 && Math.abs(p[1] - lon) < 1e-4;
      const same = near(sh.pts[0], latA, lonA) && near(sh.pts[1], latB, lonB);
      // The line may have been drawn the other way round to the way the budget
      // named its ends; the profile runs along the line, so the ends' heights
      // and antennas swap with it rather than being applied to the wrong end.
      const flipped = near(sh.pts[0], latB, lonB) && near(sh.pts[1], latA, lonA);
      if (!same && !flipped) return null;
      const an = pathAnalyse(cur.prof, flipped
        ? { ...opt, elevA: opt.elevB, elevB: opt.elevA, aglA: opt.aglB, aglB: opt.aglA }
        : opt);
      return an.ok ? an : null;
    },
    target,
  };
})();

// ── Link budget ──────────────────────────────────────────────────────────────
// Pick two points on the map, get a fade margin. Either end can be a station —
// which fills itself in from rm_systems — or an arbitrary point on the ground,
// which is what makes this useful for a proposed relocation: drop an end on a
// hilltop nobody has been to yet and see what the path would do.
//
// The number this produces is INDICATIVE and mostly OPTIMISTIC. Free-space path
// loss plus a single knife-edge diffraction proxy leaves out clutter, climate,
// multipath, real antenna patterns and every statistical allowance Radio Mobile
// makes — and nearly all of those *reduce* real margin. Hence the red banner
// that cannot be dismissed and the comparison table underneath it: the card is
// built so the figure cannot be read as more than it is.

const LB_MARGIN = [
  { min: 20,       label: 'Good',     cls: 'ok',   note: 'Comfortable margin — still confirm in Radio Mobile.' },
  { min: 10,       label: 'Marginal', cls: 'warn', note: 'Would not survive much rain, growth or a bad day.' },
  { min: -Infinity, label: 'Poor',    cls: 'bad',  note: 'Not a link you would build on this figure.' },
];

function lbMarginClass(db) { return LB_MARGIN.find(m => db >= m.min); }

const LinkBudget = (function () {
  let map = null, layer = null, clickHandler = null;

  const S = () => state.link;

  // ── endpoints ──

  function stationEndpoint(st) {
    const sys = rmSystemOf(st);
    const rep = st.repeater || null;
    return {
      kind: 'station', sid: st.id, name: st.name,
      lat: st.lat, lon: st.lon,
      ground: st.elevation_ahd != null ? st.elevation_ahd : null,
      groundSrc: st.elevation_ahd != null ? 'elevation_ahd (AHD)' : null,
      sysName: sys ? sys.name : null,
      freq: rep && rep.rx_mhz > 0 ? rep.rx_mhz : null,
      def: {
        tx_w:     sys && sys.tx_power_w != null ? sys.tx_power_w : null,
        loss_db:  sys && sys.line_loss_db != null ? sys.line_loss_db : null,
        gain_dbi: sys && sys.antenna_gain_dbi != null ? sys.antenna_gain_dbi : null,
        agl_m:    sys && sys.antenna_height_m != null ? sys.antenna_height_m : PATH_DEFAULT_AGL,
        rx_dbm:   sys && sys.rx_threshold_dbm != null ? sys.rx_threshold_dbm : null,
      },
      over: {},
    };
  }

  function pointEndpoint(lat, lon) {
    return {
      kind: 'point', sid: null,
      name: `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
      lat, lon, ground: null, groundSrc: null, sysName: null, freq: null,
      // A hypothetical site has to start from something; the 1 W field station
      // is what most of this network actually is.
      def: { tx_w: 1, loss_db: 1, gain_dbi: 5.15, agl_m: PATH_DEFAULT_AGL, rx_dbm: -117 },
      over: {},
    };
  }

  // The value in play, and whether the operator put it there.
  function val(e, k) { return e.over[k] != null ? e.over[k] : e.def[k]; }
  function isOver(e, k) { return e.over[k] != null; }

  // A hypothetical point has no surveyed height, so its ground comes from the
  // terrain tiles — asynchronously, and the card redraws when it lands.
  function fillGround(e) {
    if (e.ground != null || e.kind !== 'point' || e._pending) return;
    e._pending = true;
    Terrain.sample(e.lat, e.lon).then(m => {
      e._pending = false;
      if (m != null) { e.ground = m; e.groundSrc = 'terrain tile (EGM96 geoid)'; }
      else e.groundSrc = 'unavailable';
      rerender();
    });
  }

  // ── map pick ──

  function setEnd(which, e) {
    S()[which] = e;
    fillGround(e);
    drawMarkers();
    rerender();
  }

  function onMapClick(ev) {
    // A draw tool owns its own clicks; this only takes the ones nothing else
    // wanted.
    if (!S().picking || state.draw.tool) return;
    const { ll, sid } = MapDraw.resolveClick(ev.latlng);
    const st = sid && state.data ? state.data.stations.find(s => s.id === sid) : null;
    const e = st ? stationEndpoint(st) : pointEndpoint(ll[0], ll[1]);
    // Fill whichever end is empty; once both are set, start again from A.
    const which = !S().a ? 'a' : !S().b ? 'b' : 'a';
    if (which === 'a' && S().a && S().b) S().b = null;
    setEnd(which, e);
    mapNote(S().a && S().b
      ? 'Both ends set — click again to start a new path.'
      : 'Now click the other end of the path.', 3000);
  }

  function drawMarkers() {
    if (!layer) return;
    layer.clearLayers();
    const { a, b } = S();
    [['A', a], ['B', b]].forEach(([tag, e]) => {
      if (!e) return;
      L.circleMarker([e.lat, e.lon], {
        radius: 8, color: '#c62828', weight: 3, fillColor: '#fff', fillOpacity: 1,
      }).addTo(layer).bindTooltip(`${tag} · ${esc(e.name)}`, {
        permanent: true, direction: 'top', className: 'mn-draw-label', offset: [0, -8],
      });
    });
    if (a && b) {
      L.polyline([[a.lat, a.lon], [b.lat, b.lon]],
                 { color: '#c62828', weight: 2.5, dashArray: '6 4' }).addTo(layer);
    }
  }

  // ── the budget ──

  // The profile for exactly these two ends, when the elevation panel happens to
  // be showing it. It is the evidence for the diffraction term, so the card
  // only claims one when it can point at the profile it came from.
  function analysisFor(a, b) {
    return PathProfile.analysisFor(a.lat, a.lon, b.lat, b.lon, {
      elevA: a.ground, elevB: b.ground,
      aglA: val(a, 'agl_m'), aglB: val(b, 'agl_m'),
      freqMhz: freqOf(),
    });
  }

  function freqOf() {
    const S_ = S();
    if (S_.freqMhz > 0) return S_.freqMhz;
    for (const e of [S_.a, S_.b]) if (e && e.freq > 0) return e.freq;
    return PATH_DEFAULT_MHZ;
  }

  function compute() {
    const { a, b } = S();
    if (!a || !b) return null;
    const dKm  = acmaHaversineKm(a.lat, a.lon, b.lat, b.lon);
    const fMhz = freqOf();
    const txW  = val(a, 'tx_w');
    const txDbm = wattsToDbm(txW);
    const an = analysisFor(a, b);

    const eirp = txDbm == null ? null : txDbm + (val(a, 'gain_dbi') || 0) - (val(a, 'loss_db') || 0);
    const fspl = fsplDb(dKm, fMhz);
    const diff = an ? an.diffraction_db : null;
    const rxDbm = eirp == null ? null
      : eirp - fspl - (diff || 0) + (val(b, 'gain_dbi') || 0) - (val(b, 'loss_db') || 0);
    const thr = val(b, 'rx_dbm');
    const margin = rxDbm == null || thr == null ? null : rxDbm - thr;

    return { dKm, fMhz, txW, txDbm, eirp, fspl, diff, rxDbm, thr, margin, an,
             fsplOnly: an == null };
  }

  // ── rendering ──

  function endpointCard(which, e) {
    const tag = which === 'a' ? 'A' : 'B';
    if (!e) {
      return `
        <div class="lb-end lb-end-empty">
          <div class="lb-end-head"><span class="lb-tag">${tag}</span> <em>not set</em></div>
          <p class="small">${S().picking
            ? 'Click a station or any point on the map.'
            : 'Turn on “Pick two points” and click the map.'}</p>
        </div>`;
    }
    const f = (k, label, step, unit) => {
      const over = isOver(e, k);
      const v = val(e, k);
      return `
        <label class="lb-field${over ? ' is-over' : ''}">
          <span>${esc(label)}${unit ? ` <em>${esc(unit)}</em>` : ''}</span>
          <input type="number" step="${step}" value="${v == null ? '' : v}"
                 placeholder="not set"
                 onchange="LinkBudget.setField('${which}','${k}',this.value)">
          <b class="lb-flag">${over ? 'edited'
            : e.def[k] == null ? ''
            : e.kind === 'station' ? 'default'
            // A hypothetical site's figures came from nowhere but this code, so
            // they are marked as the guesses they are rather than borrowing the
            // authority of a "default" read out of the station data.
            : 'assumed'}</b>
        </label>`;
    };
    return `
      <div class="lb-end">
        <div class="lb-end-head">
          <span class="lb-tag">${tag}</span>
          <strong>${esc(e.name)}</strong>
          <button class="draw-del" title="Clear this end"
                  onclick="LinkBudget.clearEnd('${which}')">✕</button>
        </div>
        <p class="small lb-src">${e.kind === 'station'
          ? `Station${e.sysName ? ` · ${esc(e.sysName)}` : ''}${e.freq ? ` · repeater ${e.freq} MHz` : ''}`
          : 'Hypothetical point — nothing is written back to the station data'}</p>
        <p class="small lb-src">Ground ${e.ground != null
          ? `${e.ground.toFixed(1)} m <span style="color:var(--muted)">${esc(e.groundSrc || '')}</span>`
          : (e.groundSrc === 'unavailable'
              ? '<span style="color:var(--bad)">unavailable — no terrain tile for this point</span>'
              : '<span style="color:var(--muted)">sampling…</span>')}</p>
        <div class="lb-fields">
          ${f('tx_w',     'TX power',        '0.1',  'W')}
          ${f('gain_dbi', 'Antenna gain',    '0.05', 'dBi')}
          ${f('loss_db',  'Line loss',       '0.1',  'dB')}
          ${f('agl_m',    'Antenna height',  '0.5',  'm AGL')}
          ${f('rx_dbm',   'RX threshold',    '0.1',  'dBm')}
        </div>
      </div>`;
  }

  // Every term is signed, so the column reads as an addition that visibly comes
  // out at the received level — subtotals excepted, which are the running
  // result rather than something being added.
  function budgetRow(label, value, unit, note, cls) {
    const sub = /^=/.test(label);
    return `
      <tr class="${cls || ''}">
        <th>${esc(label)}</th>
        <td class="lb-num">${value == null ? '—'
          : (value > 0 && !sub ? '+' : '') + value.toFixed(2)}</td>
        <td class="lb-unit">${esc(unit || '')}</td>
        <td class="small lb-note">${note || ''}</td>
      </tr>`;
  }

  function budgetHtml(r) {
    const a = S().a, b = S().b;
    const m = r.margin == null ? null : lbMarginClass(r.margin);
    // A blocked path can still show a fat margin: the single knife edge that
    // stands in for the terrain is the most optimistic diffraction model there
    // is, and it is standing in for a ridge above the line of sight. The number
    // stays as computed — but it does not get to read "Good".
    const blocked = !!(r.an && r.an.verdict === 'obstructed') && r.margin != null;
    return `
      <table class="lb-table">
        <tbody>
          ${budgetRow('TX power', r.txDbm, 'dBm', r.txW != null ? `${r.txW} W at ${esc(a.name)}` : 'no TX power set')}
          ${budgetRow('TX antenna gain', val(a, 'gain_dbi'), 'dBi', '')}
          ${budgetRow('TX line loss', val(a, 'loss_db') == null ? null : -val(a, 'loss_db'), 'dB', '')}
          ${budgetRow('= EIRP', r.eirp, 'dBm', '', 'lb-sub')}
          ${budgetRow('Free-space path loss', -r.fspl, 'dB',
            `${r.fMhz.toFixed(3)} MHz over ${fmtKm(r.dKm)}`)}
          ${r.diff == null
            ? `<tr class="lb-missing"><th>Diffraction proxy</th><td class="lb-num">—</td><td class="lb-unit">dB</td>
                 <td class="small lb-note">No terrain profile for these two points —
                 <strong>this result is free-space only</strong> and ignores the ground entirely.
                 ${S().a && S().b ? '<button class="lb-link" onclick="LinkBudget.profileThis()">Profile this path</button>' : ''}</td></tr>`
            : budgetRow('Diffraction proxy', -r.diff, 'dB',
                `single knife edge${r.an.v != null ? `, v=${r.an.v.toFixed(2)}` : ''} — a proxy, not a propagation model`)}
          ${budgetRow('RX antenna gain', val(b, 'gain_dbi'), 'dBi', '')}
          ${budgetRow('RX line loss', val(b, 'loss_db') == null ? null : -val(b, 'loss_db'), 'dB', '')}
          ${budgetRow('= Received signal', r.rxDbm, 'dBm', `at ${esc(b.name)}`, 'lb-sub')}
          ${budgetRow('RX threshold', r.thr, 'dBm', 'receiver sensitivity')}
        </tbody>
        <tfoot>
          <tr class="lb-margin ${blocked ? 'bad' : (m ? m.cls : '')}">
            <th>Fade margin</th>
            <td class="lb-num">${r.margin == null ? '—' : (r.margin > 0 ? '+' : '') + r.margin.toFixed(1)}</td>
            <td class="lb-unit">dB</td>
            <td class="lb-note"><strong>${blocked ? 'Obstructed' : (m ? m.label : '')}</strong>
              <span class="small">${r.margin == null
                ? 'Fill in TX power and RX threshold for a margin.'
                : blocked
                  ? `Terrain rises above the line of sight, so this margin is not trustworthy${
                      m ? ` however “${m.label.toLowerCase()}” it looks` : ''}: one knife edge stands in for a
                      blocked path, and it understates it badly. Model this one properly before going near it.`
                  : esc(m.note)}</span></td>
          </tr>
        </tfoot>
      </table>
      ${r.an ? `
        <p class="small lb-eval">Terrain says <strong>${PATH_VERDICT[r.an.verdict].label.toLowerCase()}</strong>:
          ${esc(PATH_VERDICT[r.an.verdict].note)}
          ${r.an.intrusion_m > 0 ? `Worst intrusion ${Math.round(r.an.intrusion_m)} m into the 60% zone.` : ''}</p>` : ''}`;
  }

  function comparisonHtml() {
    const N = RM_NET_DEFAULTS;
    const rows = [
      ['Propagation model', 'FSPL + single knife-edge diffraction proxy', 'Longley–Rice ITM over irregular terrain'],
      ['Terrain', `Direct line sampled from ~30 m tiles`, 'Full DEM (landheight.dat), terrain-following'],
      ['Land cover / clutter', '<em>Not modelled</em>', `Urban / tree percentage (${N['%Urban or Tree']}%)`],
      ['Climate &amp; refractivity', '<em>Not modelled</em>',
       `Climate class ${N.Climate}, refractivity ${N.Refractivity}, permittivity ${N.Permittivity}, conductivity ${N.Conductivity}`],
      ['Statistical reliability', 'One deterministic figure',
       `%time ${N['%Time']} / %location ${N['%Location']} / %situation ${N['%Situation']}`],
      ['Antenna patterns', 'One gain figure, isotropic', 'Real .ant patterns, azimuth and downtilt'],
      ['Earth curvature', `Simplified — fixed k = 4/3`, 'Modelled'],
      ['Multipath, ducting, fading', '<em>Not modelled</em>', 'Statistical allowance'],
      ['Polarisation', 'Ignored', `Modelled (polarization ${N.Polarization})`],
      ['Interference / noise floor', '<em>Not modelled</em>', '— see the RF Environment tab for ACMA co-channel risk'],
    ];
    return `
      <details class="lb-compare">
        <summary>Why this is not a propagation study — what it leaves out</summary>
        <p class="small">Almost everything in the left column that is missing would <strong>reduce</strong>
          real-world margin. That is why “indicative” here mostly means <strong>optimistic</strong>:
          treat a good margin as permission to model the path properly, never as a result.</p>
        <div class="table-wrap">
          <table class="lb-compare-table">
            <thead><tr><th></th><th>MegaNet indicative</th><th>Radio Mobile (ITM / Longley–Rice)</th></tr></thead>
            <tbody>${rows.map(([k, mine, rm]) =>
              `<tr><th>${k}</th><td>${mine}</td><td>${rm}</td></tr>`).join('')}</tbody>
          </table>
        </div>
      </details>`;
  }

  function bodyHtml() {
    const S_ = S();
    const r = compute();
    return `
      <div class="lb-disclaimer" role="alert">
        ⚠️ <strong>Indicative only.</strong> This is a first-pass sanity check, not a propagation
        study. Always confirm against Radio Mobile before making a decision.
      </div>
      <div class="lb-controls">
        <label class="filter-check">
          <input type="checkbox" ${S_.picking ? 'checked' : ''}
                 onchange="LinkBudget.setPicking(this.checked)">
          Pick two points on the map
        </label>
        <label class="draw-field">
          <span>Frequency (MHz)</span>
          <input type="number" step="0.1" min="1" value="${freqOf()}"
                 onchange="LinkBudget.setFreq(this.value)">
        </label>
        <button onclick="LinkBudget.reset()">Clear both ends</button>
      </div>
      <p class="filter-hint">${S_.picking
        ? 'Click a station to fill it in from its Radio Mobile system, or click empty ground for a hypothetical site. Every value below can be overridden.'
        : 'Ends can also be set from a line drawn in Draw &amp; measure.'}</p>
      <div class="lb-ends">
        ${endpointCard('a', S_.a)}
        ${endpointCard('b', S_.b)}
      </div>
      ${r ? budgetHtml(r) : '<p class="filter-note">Set both ends to see a budget.</p>'}
      ${comparisonHtml()}`;
  }

  function panelHtml() {
    return `
      <details class="lb-panel" ${S().open ? 'open' : ''}
               ontoggle="LinkBudget.setOpen(this.open)">
        <summary>
          <h3>Link budget <span class="lb-badge">indicative</span></h3>
          <span class="small">Fade margin between two points</span>
        </summary>
        <div class="lb-body">${S().open ? bodyHtml() : ''}</div>
      </details>`;
  }

  function rerender() {
    const el = document.getElementById('link-budget-panel');
    if (el) el.innerHTML = panelHtml();
  }

  return {
    attach(m) {
      map = m;
      layer = L.layerGroup().addTo(m);
      clickHandler = onMapClick;
      m.on('click', clickHandler);
      drawMarkers();
    },
    detach() {
      if (map && clickHandler) map.off('click', clickHandler);
      map = null; layer = null; clickHandler = null;
    },

    panelHtml, rerender,

    setOpen(v) {
      S().open = !!v;
      // Expanding the card arms the pick; collapsing it disarms, so a stray map
      // click doesn't quietly move an endpoint on a card nobody is looking at.
      S().picking = !!v;
      rerender();
    },
    setPicking(v) { S().picking = !!v; rerender(); },
    setFreq(v) {
      const n = Number(v);
      S().freqMhz = isFinite(n) && n > 0 ? n : null;
      rerender();
    },
    setField(which, k, v) {
      const e = S()[which];
      if (!e) return;
      const n = v.trim() === '' ? null : Number(v);
      // Blanking a box puts the default back rather than leaving a hole.
      e.over[k] = n != null && isFinite(n) ? n : null;
      if (e.over[k] == null) delete e.over[k];
      rerender();
    },
    clearEnd(which) { S()[which] = null; drawMarkers(); rerender(); },
    reset() { S().a = null; S().b = null; drawMarkers(); rerender(); },

    // The profile panel finished (or failed) — the diffraction line follows it.
    profileChanged() { if (S().open) rerender(); },

    // "Link budget for this path →" on the profile panel: take the drawn line's
    // two ends as the budget's endpoints.
    fromProfile() {
      const sh = PathProfile.target();
      if (!sh || sh.pts.length !== 2) { mapNote('Draw a two-point line first', 3000); return; }
      const pick = i => {
        const ids = sh.snappedTo || [];
        const sid = i === 0 ? ids[0] : ids[ids.length - 1];
        const st = sid && state.data ? state.data.stations.find(s => s.id === sid) : null;
        return st ? stationEndpoint(st) : pointEndpoint(sh.pts[i][0], sh.pts[i][1]);
      };
      S().open = true;
      S().a = pick(0); S().b = pick(1);
      fillGround(S().a); fillGround(S().b);
      drawMarkers();
      rerender();
      const el = document.getElementById('link-budget-panel');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    },

    // The other direction: draw the budget's two ends as a line so the profile
    // panel picks them up and the diffraction term can be filled in.
    profileThis() {
      const { a, b } = S();
      if (!a || !b) return;
      MapDraw.addLine([[a.lat, a.lon], [b.lat, b.lon]], [a.sid || null, b.sid || null]);
      state.path.open = true;
      const el = document.getElementById('path-profile-panel');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    },
  };
})();

// ── Station table (lower half of the Stations tab) ─────────────────────────────

// Unfiltered, the table would emit ~28,500 cells (3,174 rows × 9) as one
// innerHTML string on every keystroke. Cap what's rendered; the footer link
// lets the operator pull the rest in when they actually want it.
const STATIONS_ROW_CAP = 500;

// What the table says when it is listing a map selection rather than a filter
// result — including the way back to the filter, which is the only way back.
function selectionBarHtml() {
  const n = state.mapSelection.size;
  if (!n) return '';
  return `
    <div class="sel-bar">
      <span class="sel-bar-count"><strong>${n}</strong> station${n === 1 ? '' : 's'} selected</span>
      <span class="sel-bar-note">Picked off the map — not saved, and not part of the filter.</span>
      <span class="sel-bar-actions">
        <button onclick="exportMapSelection()" title="Download these stations as a CSV">Export CSV</button>
        <button class="filter-reset" onclick="clearMapSelection()"
                title="Go back to listing the filter result">Clear selection</button>
      </span>
    </div>`;
}

function stationsTable(allStations) {
  const selBar = selectionBarHtml();
  if (!allStations.length) {
    return selBar + `<p style="padding:.75rem;color:var(--muted)">${selBar
      ? 'None of the selected stations are in the loaded file.'
      : 'No stations match current filters.'}</p>`;
  }
  const capped    = !state.stationsShowAll && allStations.length > STATIONS_ROW_CAP;
  const stations  = capped ? allStations.slice(0, STATIONS_ROW_CAP) : allStations;
  // Same prepared terms the filter itself ran on, so the marks land exactly
  // where the match was made.
  const { terms, nums } = prepareSearch(state.filters.search);
  // Rows the filter didn't name — they are here because a pass range ties them
  // to one that did, and the badge is what says so.
  const relIds = relatedIdSet();
  return `
    ${selBar}
    ${capped ? `
      <p class="filter-note">Showing ${STATIONS_ROW_CAP} of ${allStations.length} —
        narrow the filter or <a href="#" onclick="state.stationsShowAll=true;rerenderStations();return false">show all</a>.</p>
    ` : ''}
    <table>
      <colgroup>
        <col style="width:22%"><col style="width:8%"><col style="width:13%"><col style="width:13%">
        <col style="width:12%"><col style="width:9%"><col style="width:9%"><col style="width:8%"><col style="width:6%">
      </colgroup>
      <thead>
        <tr>
          <th>Name</th><th>Stn #</th><th>Roles</th><th>Network</th>
          <th>AlertID</th><th>Lat</th><th>Lon</th><th>Elev (AHD)</th><th>On</th>
        </tr>
      </thead>
      <tbody>
        ${stations.map(s => {
          const aids = stationAlertIds(s);
          return `
            <tr class="${state.selectedId === s.id ? 'selected' : ''}" data-sid="${escAttr(s.id)}"
                onclick="selectStation('${escAttr(s.id)}')" style="cursor:pointer">
              <td title="${esc(s.id)}"><span class="stn-name role-${primaryRole(s)}">${markHits(s.name, terms)}</span></td>
              <td class="small">${markHits(s.station_number || '', terms)}</td>
              <td>${s.roles.map(r => `<span class="badge">${r}</span>`).join(' ')}${
                s.roles.includes('repeater') && repeaterPassingCount(s) != null
                  ? ` <span class="badge" title="ALERT addresses carried, in this repeater's open pass ranges">passing ${repeaterPassingCount(s)}</span>`
                  : ''}${
                relIds.has(s.id)
                  ? ' <span class="badge badge--rel" title="Not a filter match — a pass range ties it to one">via pass range</span>'
                  : ''}</td>
              <td class="small">${s.radio_network_ids.map(id => netName(id)).join(', ')}</td>
              <td class="small">${aids.map(id => markAlertId(id, nums)).join(', ')}</td>
              <td class="small">${s.lat != null ? s.lat.toFixed(4) : ''}</td>
              <td class="small">${s.lon != null ? s.lon.toFixed(4) : ''}</td>
              <td class="small">${s.elevation_ahd != null ? s.elevation_ahd : ''}</td>
              <td>${s.enabled ? '✓' : ''}</td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

function rerenderStations() {
  const stations = tableStations();
  const wrap = document.getElementById('stations-table-wrap');
  if (wrap) wrap.innerHTML = stationsTable(stations);
  const cnt = document.getElementById('st-count');
  if (cnt) cnt.textContent = stations.length;
}

function selectStation(id) {
  if (state.selectedId === id) {
    // Toggle off: clear the highlight and close the editor card below.
    state.selectedId  = null;
    state.editorId    = null;
    state.editorDraft = {};
    state.editorMsg   = null;
    fetchEditorStamp(null);
    rerenderStations();
    rerenderStationEditorCard();
    return;
  }
  // Select the row and load it into the editor card. A deep copy becomes the
  // draft so fields not exposed by the form (catchments, satcom, RM metadata)
  // survive a save.
  const s = state.data.stations.find(x => x.id === id);
  state.selectedId  = id;
  state.editorId    = id;
  state.editorDraft = JSON.parse(JSON.stringify(s || {}));
  state.editorMsg   = null;
  fetchEditorStamp(id);        // the version this edit starts from — see #B3
  rerenderStations();
  rerenderStationEditorCard();
  if (s) focusStationOnMap(s);
}

// Pan the map above the table to a station and open its pin. Called whenever a
// row is picked, so the list and the map stay talking about the same site.
function focusStationOnMap(s) {
  if (!state.map || s.lat == null || s.lon == null) return;
  state.map.setView([s.lat, s.lon], Math.max(state.map.getZoom() || 0, 11));
  const marker = state.mapMarkers.find(m => m.mnStationId === s.id);
  if (marker) marker.openPopup();
}

// Scroll a station's row into the middle of the table viewport, so a station
// arrived at from another tab isn't left somewhere in 1300 rows.
function scrollStationRowIntoView(id) {
  const wrap = document.getElementById('stations-table-wrap');
  if (!wrap) return;
  const row = [...wrap.querySelectorAll('tr[data-sid]')].find(tr => tr.dataset.sid === id);
  if (row) row.scrollIntoView({ block: 'center' });
}

// Select a station and load it into the editor card, without touching the DOM.
// The filter driving the table is the same one driving the map, so a station
// the current filter excludes would be selected into a list it isn't in; in
// that case the filters are narrowed to the station's own name instead — the
// table then contains it, and the search box visibly says why the list changed.
// A repeater the pass ranges pulled in is already a row, so it counts as listed
// even though the filter never named it.
// Returns true when the filters moved, so the caller knows the sidebar has to
// be re-rendered and not just the table.
function selectStationState(s) {
  state.selectedId  = s.id;
  state.editorId    = s.id;
  // Same deep copy as selectStation: fields the form doesn't expose survive a save.
  state.editorDraft = JSON.parse(JSON.stringify(s));
  state.editorMsg   = null;
  fetchEditorStamp(s.id);
  // A map selection is what the table is listing, so a station asked for from
  // outside it has no row to be scrolled to. Adding it is the least destructive
  // answer — the picked set survives, and the count in the header says it grew.
  if (state.mapSelection.size) {
    if (!state.mapSelection.has(s.id)) {
      state.mapSelection.add(s.id);
      applyMapSelectionStyles();
    }
    return false;
  }
  if (relatedIdSet().has(s.id)) return false;
  // Being in the filter result is not enough: the table only draws the first
  // STATIONS_ROW_CAP of it, so an unfiltered list contains all 3,174 stations
  // and renders 500. A station past that has no row to select or scroll to, and
  // arriving from another tab to a table that visibly does not contain what you
  // asked for is the same failure as the filter excluding it — so it gets the
  // same answer.
  const at = filteredStations().findIndex(x => x.id === s.id);
  if (at >= 0 && (state.stationsShowAll || at < STATIONS_ROW_CAP)) return false;
  resetStationFilters();
  state.filters.search = s.name;
  return true;
}

// "Show in the list below ↓" from a map popup. The map and the list share this
// page, so there is no tab to switch to — the row is selected, scrolled to and
// loaded into the editor beneath the map the operator is already looking at.
function focusStation(id) {
  const s = state.data && state.data.stations.find(x => x.id === id);
  if (!s) return;
  if (selectStationState(s)) {
    renderMain();               // filters moved — the sidebar has to show it
  } else {
    rerenderStations();
    rerenderStationEditorCard();
  }
  scrollStationRowIntoView(id);
}

// Open the Stations tab focused on one station. Used by the Pass Ranges tables,
// where every row names a station the operator will want to look at in full.
function goToStation(id) {
  const s = state.data && state.data.stations.find(x => x.id === id);
  if (!s) return;
  selectStationState(s);
  switchTab('stations');        // renders the page, table and map included
  scrollStationRowIntoView(id);
  focusStationOnMap(s);
}

// True when the editor card should show a form (an existing station is selected
// or a new one is being created), rather than the placeholder prompt.
function editorActive() {
  return state.editorDraft && Object.keys(state.editorDraft).length > 0;
}

function renderStationEditorCard() {
  if (!editorActive()) {
    return `
      <div class="panel-header"><h2>Station Editor</h2></div>
      <p style="color:var(--muted);padding:.5rem 0">
        Select a station in the list above to view and edit it, or click
        <em>+ New</em> to add one.
      </p>`;
  }
  // Existing station → render from the live record; new station → from the draft.
  const s = state.editorId
    ? (state.data.stations.find(x => x.id === state.editorId) || state.editorDraft)
    : state.editorDraft;
  return editorForm(s);
}

function rerenderStationEditorCard() {
  const el = document.getElementById('stations-editor-card');
  if (el) el.innerHTML = renderStationEditorCard();
}

// ── NETWORKS tab ───────────────────────────────────────────────────────────────

function renderNetworksHtml() {
  const nets = state.data.radio_networks || [];
  const all  = state.data.stations;
  return `
    <div style="max-width:960px;margin:auto;padding:1rem;display:grid;gap:1rem">
      <div class="panel">
        <div class="panel-header">
          <h2>Radio Networks</h2>
          <span class="badge">${nets.length}</span>
        </div>
        <div class="table-wrap tall" style="margin-top:.75rem">
          <table>
            <colgroup>
              <col style="width:20%"><col style="width:28%"><col style="width:12%">
              <col style="width:12%"><col style="width:28%">
            </colgroup>
            <thead><tr><th>ID</th><th>Name</th><th>Repeaters</th><th>Field stns</th><th>Description</th></tr></thead>
            <tbody>
              ${nets.map(n => {
                const rpts = all.filter(s => s.roles.includes('repeater') && s.radio_network_ids.includes(n.id));
                const flds = all.filter(s => s.roles.includes('field')    && s.radio_network_ids.includes(n.id));
                return `<tr>
                  <td class="small">${esc(n.id)}</td>
                  <td>${esc(n.name)}</td>
                  <td>${rpts.length}</td>
                  <td>${flds.length}</td>
                  <td class="small">${esc(n.description || '')}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
      <div class="panel">
        <div class="panel-header">
          <h2>Catchments</h2>
          <span class="badge">${(state.data.catchments || []).length}</span>
        </div>
        ${!(state.data.catchments || []).length
          ? '<p class="small" style="color:var(--muted);margin:.75rem 0">No catchments defined yet.</p>'
          : `<div class="table-wrap medium" style="margin-top:.75rem">
               <table>
                 <thead><tr><th>ID</th><th>Name</th></tr></thead>
                 <tbody>
                   ${state.data.catchments.map(c =>
                     `<tr><td class="small">${esc(c.id)}</td><td>${esc(c.name)}</td></tr>`
                   ).join('')}
                 </tbody>
               </table>
             </div>`}
      </div>
    </div>`;
}

// ── PASS RANGES tab ────────────────────────────────────────────────────────────

// Does a station answer to the page's filter box? The box takes a station
// number, an ALERT id or part of a station name and does not ask which — an
// operator holding one of the three shouldn't have to say which one it is.
// Shares the Stations search box's matching rules, pasted lists included, so
// the same text typed into either box picks the same stations.
function passRangeMatch(s, q) {
  return stationMatchesSearch(s, prepareSearch(q));
}

// A repeater row survives the filter if the repeater itself matches, if one of
// the stations it serves matches, or if the query is an ALERT id its pass
// ranges cover — the last one answers "which repeater carries this address?".
function passRangeRepeaterMatch(r, matched, q) {
  if (!q) return true;
  if (passRangeMatch(r, q)) return true;
  if (matched.some(s => passRangeMatch(s, q))) return true;
  // Every address in the box is tried, not just the first — a pasted list is
  // the case where "which repeater carries these?" is actually being asked.
  return parseSearchTerms(q)
    .filter(t => /^\d+$/.test(t))
    .some(t => passRangeCoversId(r.repeater, Number(t)));
}

// Static shell — the filter box lives out here and is never re-rendered on a
// keystroke, so it keeps focus while only #pr-tables refreshes below it.
function renderPassRangesHtml() {
  const all       = state.data.stations;
  const repeaters = all.filter(s => s.roles.includes('repeater') && s.repeater);
  const fields    = all.filter(s => s.roles.includes('field'));
  const noAid     = fields.filter(s => !stationAlertIds(s).length).length;
  const orphans   = passRangeOrphans();

  return `
    <div style="max-width:1100px;margin:auto;padding:1rem;display:grid;gap:1rem">
      <div class="panel">
        <div class="panel-header"><h2>Pass Ranges</h2></div>
        <div class="stats" style="display:flex;flex-wrap:wrap;gap:1.5rem;margin-top:.75rem">
          <div>Repeaters with pass ranges: <strong>${repeaters.length}</strong></div>
          <div>Field stations with AlertID: <strong>${fields.length - noAid}</strong></div>
          <div>No AlertID (telemetry): <strong>${noAid}</strong></div>
          <div style="${orphans.length ? 'color:#c7401a' : ''}">
            Orphaned (no matching repeater): <strong>${orphans.length}</strong>
          </div>
        </div>
        <label style="display:block;font-size:.88rem;color:var(--muted);margin-top:.9rem;max-width:420px">
          Filter by station number, AlertID or station name
          <input type="search" id="pr-filter" value="${esc(state.prFilter)}"
                 placeholder="e.g. 540123, 6128 or Amiens…"
                 style="width:100%;margin-top:.3rem;display:block"
                 oninput="onPassRangeFilter(this.value)">
        </label>
        <p class="small" style="color:var(--muted);margin:.5rem 0 0">
          Click any row to open that station on the Stations tab.
        </p>
      </div>

      <div id="pr-tables" style="display:grid;gap:1rem">${passRangeTablesHtml()}</div>
    </div>`;
}

// Field stations carrying an AlertID that no repeater's pass ranges cover.
function passRangeOrphans() {
  const all       = state.data.stations;
  const repeaters = all.filter(s => s.roles.includes('repeater') && s.repeater);
  return all.filter(s => {
    if (!s.roles.includes('field')) return false;
    const ids = stationAlertIds(s);
    if (!ids.length) return false;
    return !repeaters.some(r => ids.some(id => passRangeCoversId(r.repeater, id)));
  });
}

// The repeater's ranges, with any range carrying a searched address marked.
// That mark answers "which range picked this station up?" — the question the
// tab is usually open for.
//
// The rule is passRangeRepeaterMatch's own, not a second one: passRangeCoversId
// still decides whether the repeater carries the address, and the bounds test
// only says which of its ranges is the one to point at. The two compose exactly
// because exclusions belong to the repeater rather than to a range — so an
// address inside this range that survives passRangeCoversId cannot have been
// excluded, and one that was excluded fails it everywhere. Range bounds are
// numbers, so there is nothing here to escape.
function passRangesHtml(repeater, searchIds) {
  return (repeater.pass_ranges || []).map(p => {
    const label = `${p.low}–${p.high}`;
    return searchIds.some(id => id >= p.low && id <= p.high && passRangeCoversId(repeater, id))
      ? `<mark class="hit">${label}</mark>` : label;
  }).join(', ');
}

// Dynamic half — recomputed into #pr-tables on every keystroke in the filter box.
function passRangeTablesHtml() {
  const all       = state.data.stations;
  const q         = state.prFilter;
  const repeaters = all.filter(s => s.roles.includes('repeater') && s.repeater);
  // The same prepared terms the filter itself ran on, so every mark below sits
  // where the match was actually made — as on the Stations tab. The numeric
  // terms are the addresses the range column is asked about, so they are
  // converted once here rather than once per range per repeater.
  const { terms, nums } = prepareSearch(q);
  const searchIds = nums.map(Number);

  const rptData = repeaters
    .map(r => ({ r, matched: findStationMatches(r) }))
    .filter(({ r, matched }) => passRangeRepeaterMatch(r, matched, q));

  const allOrphans = passRangeOrphans();
  const orphans    = allOrphans.filter(s => passRangeMatch(s, q));

  const of = (shown, total) => shown === total ? `${total}` : `${shown} of ${total}`;
  const noMatch = msg => `<p class="small" style="color:var(--muted);padding:.75rem">${msg}</p>`;

  // A repeater usually survives the filter because one of the ~100 stations it
  // carries matched — and that station is as likely to be 84th in the list as
  // 4th, so a cell showing the first ten would mark nothing and the row would
  // look like it matched for no reason. The matches go to the front; the order
  // is otherwise untouched, and the "+N more" count behind it is unchanged.
  const firstTen = matched => {
    if (!q) return matched;
    const hit = [], rest = [];
    for (const s of matched) (passRangeMatch(s, q) ? hit : rest).push(s);
    return hit.concat(rest);
  };

  return `
      <div class="panel">
        <div class="panel-header"><h2>By Repeater</h2>
          <span class="badge">${of(rptData.length, repeaters.length)}</span>
        </div>
        <div class="table-wrap tall">
          ${!rptData.length ? noMatch('No repeater matches this filter.') : `
          <table>
            <colgroup>
              <col style="width:18%"><col style="width:14%"><col style="width:10%"><col style="width:8%">
              <col style="width:16%"><col style="width:34%">
            </colgroup>
            <thead><tr><th>Repeater</th><th>Network</th><th>Addresses</th><th>Matched</th><th>Pass ranges</th><th>Stations (first 10)</th></tr></thead>
            <tbody>
              ${rptData.map(({ r, matched }) => `
                <tr onclick="goToStation('${escAttr(r.id)}')" style="cursor:pointer"
                    title="Open ${escAttr(r.name)} on the Stations tab">
                  <td>${markHits(r.name, terms)}</td>
                  <td class="small">${r.radio_network_ids.map(id => netName(id)).join(', ')}</td>
                  <td><span class="badge" title="ALERT addresses carried, post-exclusion">${repeaterPassingCount(r) ?? 0}</span></td>
                  <td><span class="badge" title="Field stations matched">${matched.length}</span></td>
                  <td class="small">${passRangesHtml(r.repeater, searchIds)}</td>
                  <td class="small">${firstTen(matched).slice(0, 10).map(s => markHits(s.name, terms)).join(', ')}${matched.length > 10 ? ` +${matched.length - 10} more` : ''}</td>
                </tr>`).join('')}
            </tbody>
          </table>`}
        </div>
      </div>

      ${allOrphans.length ? `
        <div class="panel">
          <div class="panel-header">
            <h2 style="color:#c7401a">Orphaned Stations</h2>
            <span class="badge">${of(orphans.length, allOrphans.length)}</span>
          </div>
          <p class="small" style="color:var(--muted);margin:.5rem 0">
            These stations have an AlertID but no repeater's pass ranges cover it.
          </p>
          <div class="table-wrap medium">
            ${!orphans.length ? noMatch('No orphaned station matches this filter.') : `
            <table>
              <thead><tr><th>Name</th><th>Stn #</th><th>AlertID(s)</th><th>Network</th></tr></thead>
              <tbody>
                ${orphans.map(s => `
                  <tr onclick="goToStation('${escAttr(s.id)}')" style="cursor:pointer"
                      title="Open ${escAttr(s.name)} on the Stations tab">
                    <td>${markHits(s.name, terms)}</td>
                    <td class="small">${markHits(s.station_number || '', terms)}</td>
                    <td class="small">${stationAlertIds(s).map(id => markAlertId(id, nums)).join(', ')}</td>
                    <td class="small">${s.radio_network_ids.map(id => netName(id)).join(', ')}</td>
                  </tr>`).join('')}
              </tbody>
            </table>`}
          </div>
        </div>` : ''}`;
}

function onPassRangeFilter(value) {
  state.prFilter = value;
  const el = document.getElementById('pr-tables');
  if (el) el.innerHTML = passRangeTablesHtml();
}

// ── BIT FLIPPER tab ────────────────────────────────────────────────────────────

const BF_TYPE_LABEL     = { battery: 'Battery', rainfall: 'Rainfall', water_level: 'Water Level', primary: 'Primary' };
const BF_MAX_RENDER_ROWS = 2000;   // safety cap for very large N-bit expansions
// Station of interest — the entered address. Ties the pinned table row (see
// .bf-row-base in styles.css) to its highlighted pin on the map below.
const BF_BASE_COLOR      = '#ff8c00';

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

// All combinations of `k` bit positions chosen from 0..width-1 (lexicographic).
function bitCombos(width, k) {
  const res = [];
  (function rec(start, combo) {
    if (combo.length === k) { res.push(combo.slice()); return; }
    for (let i = start; i < width; i++) { combo.push(i); rec(i + 1, combo); combo.pop(); }
  })(0, []);
  return res;
}

function bfBaseId() {
  const id = parseInt(state.bfInput, 10);
  return (!isNaN(id) && id > 0 && id < 65536) ? id : null;
}

function bfBitsToFlip() {
  const n = parseInt(state.bfBits, 10);
  if (isNaN(n) || n < 1) return 1;
  return Math.min(n, 16);
}

// Compute flip variants for the current input:
// [{ bits:[...], value, binary, matches:[{station,sensor}] }] in bit-combo order.
function bfComputeVariants(idx) {
  const base = bfBaseId();
  if (base == null) return [];
  idx = idx || buildSensorIndex();
  const variants = [];
  for (const combo of bitCombos(16, bfBitsToFlip())) {
    let v = base;
    for (const b of combo) v ^= (1 << b);
    if (v <= 0 || v >= 65536 || v === base) continue;
    variants.push({ bits: combo, value: v, binary: v.toString(2).padStart(16, '0'), matches: idx.get(v) || [] });
  }
  return variants;
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

// Collapse duplicate matches so a sensor isn't repeated once per duplicate
// stations.json entry that shares a name (some sites appear twice in the data).
function dedupeMatches(matches) {
  const seen = new Set();
  const out = [];
  for (const m of matches) {
    const k = `${m.station.name}|${m.sensor.type}|${m.sensor.sensor_id}|${m.sensor.device_id}|${m.sensor.alert_id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(m);
  }
  return out;
}

// Static shell — rendered once when the tab opens. Control inputs live here and
// are NOT re-rendered on keystrokes, so focus is never stolen; only #bf-results
// updates as the user types.
function renderBitFlipperHtml() {
  return `
    <div style="max-width:1000px;margin:auto;padding:1rem;display:grid;gap:1rem">
      <div class="panel">
        <div class="panel-header"><h2>Bit Flipper</h2></div>
        <p class="small" style="color:var(--muted);margin:.5rem 0">
          Enter an ALERT decimal address to see its bit-flip variants and cross-reference them
          against the station database. Sensor type, Sensor ID and ARRO graph links are sourced
          from the enriched station data.
        </p>
        <div id="bf-controls" style="display:flex;flex-wrap:wrap;gap:1rem 1.25rem;align-items:flex-end;margin-top:.5rem">
          <label style="font-size:.9rem;color:var(--muted)">
            ALERT decimal address
            <input id="bf-addr" type="number" min="1" max="65535" value="${esc(state.bfInput)}" placeholder="e.g. 6129"
                   style="width:170px;margin-top:.3rem;display:block"
                   oninput="onBfAddrInput(this.value)">
          </label>
          <label style="font-size:.9rem;color:var(--muted)">
            Bits to flip
            <input id="bf-bits" type="number" min="1" max="16" value="${esc(String(bfBitsToFlip()))}"
                   style="width:100px;margin-top:.3rem;display:block"
                   oninput="onBfBitsInput(this.value)">
          </label>
          <label style="font-size:.9rem;color:var(--muted);display:flex;gap:.4rem;align-items:center;padding-bottom:.4rem">
            <input id="bf-only" type="checkbox" ${state.bfOnlyMatches ? 'checked' : ''}
                   onchange="onBfOnlyMatches(this.checked)">
            Show only matched addresses
          </label>
          <label style="font-size:.9rem;color:var(--muted);flex:1;min-width:240px"
                 title="Its host is what every ARRO link in the app is built on — map popups, the station editor and the ARRO Launcher tab included">
            ARRO base URL <span style="font-weight:400">— sets the host app-wide</span>
            <input id="bf-arro" type="text" value="${esc(state.bfArroBase || ARRO_DEFAULT_BASE)}"
                   style="width:100%;margin-top:.3rem;display:block"
                   oninput="onBfArroInput(this.value)">
          </label>
        </div>
      </div>

      <div id="bf-results">${renderBitFlipperResults()}</div>

      <div class="panel">
        <div class="panel-header"><h3>Map</h3></div>
        <div id="bf-map" style="height:420px;border-radius:6px;margin-top:.5rem"></div>
      </div>
    </div>`;
}

// Dynamic output — recomputed and re-rendered into #bf-results on every input.
function renderBitFlipperResults() {
  const base = bfBaseId();
  if (base == null) {
    return `<div class="panel"><p class="small" style="color:var(--muted)">Enter a valid ALERT address (1–65535) above.</p></div>`;
  }

  const idx      = buildSensorIndex();
  const variants = bfComputeVariants(idx);
  const filter   = state.bfSensorFilter || '';
  const matchPasses = m => !filter || m.sensor.type === filter;
  const rowMatches  = v => v.matches.filter(matchPasses);

  // Station of interest: the exact match on the entered address (no bits
  // flipped). Pinned to the top of the table and always ARRO-linked so the
  // owning station is shown alongside its bit-flip neighbours.
  const baseRow = {
    isBase: true, bits: null, value: base,
    binary: base.toString(2).padStart(16, '0'),
    matches: idx.get(base) || [],
  };

  // sensor types present among matches (for the filter dropdown)
  const types = [...new Set([baseRow, ...variants].flatMap(v => v.matches.map(m => m.sensor.type)))].sort();

  // rows to display
  let rows;
  if (filter)                    rows = variants.filter(v => rowMatches(v).length);
  else if (state.bfOnlyMatches)  rows = variants.filter(v => v.matches.length);
  else                           rows = variants;

  const totalToShow = rows.length;
  const truncated   = rows.length > BF_MAX_RENDER_ROWS;
  if (truncated) rows = rows.slice(0, BF_MAX_RENDER_ROWS);

  // Pin the station-of-interest row at the top. It is exempt from the sensor
  // filter — that filter narrows the flip variants being compared against the
  // entered address, not the address itself — so it stays listed, and fully
  // populated, alongside the ARRO link that always graphs it. With no station
  // behind the address at all there is nothing to pin but the bits, so the
  // "only matched" rule still applies.
  const showBase = baseRow.matches.length ? true : !state.bfOnlyMatches && !filter;
  if (showBase) rows = [baseRow, ...rows];

  const matchedCount = variants.filter(v => v.matches.length).length;

  // ARRO link across the station of interest plus every matched flip-variant
  // sensor that passes the current filter. The station of interest is never
  // filtered out — the sensor filter narrows what you compare it against, not
  // the address you actually asked about.
  const arroPairs = [...baseRow.matches, ...variants.flatMap(v => v.matches.filter(matchPasses))];
  const arro = buildArroUrl(arroPairs);

  const rowsHtml = rows.map(v => {
    const ms  = dedupeMatches(v.isBase ? v.matches : rowMatches(v));
    const hit = ms.length > 0;
    const dash = '<span style="color:var(--muted)">—</span>';
    const stationBadges = hit
      ? [...new Set(ms.map(m => m.station.name))].map(n => `<span class="badge">${esc(n)}</span>`).join(' ')
      : dash;
    const sensorTypes = hit ? ms.map(m => esc(m.sensor.type)).join('<br>') : dash;
    const sensorIds   = hit ? ms.map(m => esc(m.sensor.sensor_id || '—')).join('<br>') : dash;
    const reps = hit
      ? [...new Map(ms.flatMap(m => findRepeaterMatches(m.station)).map(r => [r.id, r])).values()]
      : [];
    const repHtml = reps.length
      ? reps.map(r => {
          const n = repeaterPassingCount(r);
          return `<span class="badge badge--repeater" title="${n != null ? `passing ${n} ALERT addresses` : 'no pass ranges recorded'}">${esc(r.name)}</span>`;
        }).join(' ')
      : dash;
    // The pinned, tinted row is the station of interest — it says so in the
    // tooltip rather than in the cell, which otherwise steals width from the
    // station, sensor and repeater columns that need it.
    const bitsCell = v.isBase
      ? `<span title="Station of interest — the ALERT address you entered">NA</span>`
      : v.bits.join(', ');
    return `
      <tr${v.isBase ? ' class="bf-row-base"' : ''}>
        <td class="small mono">${bitsCell}</td>
        <td>${v.value}</td>
        <td class="small mono">${v.binary}</td>
        <td style="text-align:center">${hit ? '✓' : ''}</td>
        <td>${stationBadges}</td>
        <td class="small">${sensorTypes}</td>
        <td class="small mono">${sensorIds}</td>
        <td>${repHtml}</td>
      </tr>`;
  }).join('');

  return `
    <div class="panel">
      <div class="panel-header" style="flex-wrap:wrap;gap:.5rem">
        <h3>Bit-Flip Variants</h3>
        <span class="small" style="color:var(--muted)">
          ${variants.length} variant${variants.length === 1 ? '' : 's'} · ${matchedCount} matched
        </span>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:1rem;align-items:center;margin:.5rem 0">
        ${types.length ? `
          <label class="small" style="color:var(--muted)">Filter by sensor:
            <select onchange="onBfSensorFilter(this.value)" style="margin-left:.3rem">
              <option value=""${!filter ? ' selected' : ''}>All sensors</option>
              ${types.map(t => `<option value="${esc(t)}"${filter === t ? ' selected' : ''}>${esc(t)}</option>`).join('')}
            </select>
          </label>` : ''}
        <span id="bf-arro-link">${arro
          ? `<a href="${esc(arro.url)}" target="_blank" rel="noopener">Open ARRO graph (${arro.count} sensor${arro.count === 1 ? '' : 's'})</a>`
          : `<span class="small" style="color:var(--muted)">No ARRO-linkable sensors in current matches</span>`}</span>
      </div>
      ${truncated ? `<p class="small" style="color:#b8860b">Showing first ${BF_MAX_RENDER_ROWS} of ${totalToShow} rows — reduce the bit count or use the sensor filter to narrow.</p>` : ''}
      ${rows.length ? `
        <div class="table-wrap tall">
          <table class="bf-table">
            <colgroup>
              <col style="width:8%"><col style="width:8%"><col style="width:13%"><col style="width:5%">
              <col style="width:24%"><col style="width:10%"><col style="width:15%"><col style="width:17%">
            </colgroup>
            <thead><tr>
              <th>Bit(s)</th><th>Decimal</th><th>Binary</th><th>Match</th>
              <th>Station(s)</th><th>Sensor</th><th>Sensor ID</th><th>Repeater(s)</th>
            </tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>`
      : `<p class="small" style="color:var(--muted)">No ${filter ? esc(filter) + ' ' : ''}matches for these variants.</p>`}
    </div>`;
}

// ── Bit Flipper event handlers ──────────────────────────────────────────────
// Each handler updates only #bf-results (never the control it fired from), so
// the focused input keeps focus and the caret while results refresh live.

function refreshBfResults() {
  const el = document.getElementById('bf-results');
  if (el) el.innerHTML = renderBitFlipperResults();
}

function scheduleBfMapRefresh() {
  if (state.bfMapTimer) clearTimeout(state.bfMapTimer);
  state.bfMapTimer = setTimeout(() => { state.bfMapTimer = null; refreshBitFlipperMap(); }, 250);
}

function onBfAddrInput(val) {
  state.bfInput = val;
  state.bfSensorFilter = '';
  refreshBfResults();
  scheduleBfMapRefresh();
}

function onBfBitsInput(val) {
  state.bfBits = val;
  state.bfSensorFilter = '';
  refreshBfResults();
  scheduleBfMapRefresh();
}

function onBfOnlyMatches(checked) {
  state.bfOnlyMatches = checked;
  refreshBfResults();
}

function onBfArroInput(val) {
  state.bfArroBase = val;
  refreshBfResults();
}

function onBfSensorFilter(val) {
  state.bfSensorFilter = val;
  refreshBfResults();
}

// Create the Leaflet map once per tab render, then draw the current variants.
function initBitFlipperMap() {
  if (state.bfMap) { state.bfMap.remove(); state.bfMap = null; }
  state.bfMapLayer = null;
  const el = document.getElementById('bf-map');
  if (!el || !state.data || typeof L === 'undefined') return;

  state.bfMap = L.map('bf-map').setView([-28, 134], 4);
  addBaseLayers(state.bfMap);
  state.bfMapLayer = L.layerGroup().addTo(state.bfMap);
  refreshBitFlipperMap();
}

// Redraw the matched-station markers, repeater markers and links for the
// current address + bit count. Reuses the existing map (no full rebuild).
function refreshBitFlipperMap() {
  if (!state.bfMap || !state.bfMapLayer || !state.data) return;
  const layer = state.bfMapLayer;
  layer.clearLayers();

  const base = bfBaseId();
  if (base == null) return;

  const idx = buildSensorIndex();

  // Collect stations matching any flip variant (across all N-bit combos)
  const stationInfo = new Map(); // station id → { station, addrs:Set, bits:Set, isBase }
  for (const combo of bitCombos(16, bfBitsToFlip())) {
    let v = base;
    for (const b of combo) v ^= (1 << b);
    if (v <= 0 || v >= 65536 || v === base) continue;
    (idx.get(v) || []).forEach(({ station: s }) => {
      if (!stationInfo.has(s.id)) stationInfo.set(s.id, { station: s, addrs: new Set(), bits: new Set() });
      const info = stationInfo.get(s.id);
      info.addrs.add(v);
      info.bits.add(combo.join('+'));
    });
  }

  // The station of interest — whoever owns the address as entered. Always
  // plotted and always highlighted, including when it also turns up as a
  // flip-variant match (which would otherwise paint it like any other hit).
  (idx.get(base) || []).forEach(({ station: s }) => {
    if (!stationInfo.has(s.id)) stationInfo.set(s.id, { station: s, addrs: new Set(), bits: new Set() });
    const info = stationInfo.get(s.id);
    info.addrs.add(base);
    info.isBase = true;
  });

  // Collect repeaters open to the matched field stations
  const repeaterInfo = new Map(); // repeater id → { station: r, fieldStations: [] }
  for (const { station: s } of stationInfo.values()) {
    findRepeaterMatches(s).forEach(r => {
      if (!repeaterInfo.has(r.id)) repeaterInfo.set(r.id, { station: r, fieldStations: [] });
      repeaterInfo.get(r.id).fieldStations.push(s);
    });
  }

  const bounds = [];
  const baseMarkers = [];
  for (const { station: s, addrs, bits, isBase } of stationInfo.values()) {
    if (s.lat == null || s.lon == null) continue;
    const role  = primaryRole(s);
    const color = isBase ? BF_BASE_COLOR : (ROLE_COLOR[role] || ROLE_COLOR.field);

    // The station of interest gets a halo behind its pin and its name on the
    // map, so it can be picked out of a scatter of flip matches at a glance.
    if (isBase) {
      L.circleMarker([s.lat, s.lon], {
        radius: 17, color: BF_BASE_COLOR, weight: 2, opacity: 0.9,
        fillColor: BF_BASE_COLOR, fillOpacity: 0.18, interactive: false,
      }).addTo(layer);
    }

    const marker = L.circleMarker([s.lat, s.lon], {
      radius: isBase ? 10 : (s.roles.includes('repeater') ? 9 : 6),
      color: isBase ? '#ffffff' : color,
      fillColor: color, fillOpacity: 0.9,
      weight: isBase ? 3 : 1.5,
    }).addTo(layer);

    const bitsLabel = bits.size
      ? `<br><span style="font-size:.82rem">Flipped bits: ${[...bits].join(', ')}</span>`
      : '';
    const baseLabel = isBase
      ? `<span style="background:${BF_BASE_COLOR};color:#fff;padding:1px 5px;border-radius:999px;font-size:.76rem;margin-left:4px">station of interest</span>`
      : '';
    marker.bindPopup(`
      <strong>${esc(s.name)}</strong>${baseLabel}<br>
      ${s.roles.map(r => `<span style="background:${ROLE_COLOR[r]};color:#fff;padding:1px 5px;border-radius:999px;font-size:.76rem;margin-right:2px">${r}</span>`).join('')}
      ${bitsLabel}
      <br><span style="font-size:.82rem">AlertID: ${[...addrs].sort((a, b) => a - b).join(', ')}</span>
    `);
    if (isBase) {
      marker.bindTooltip(esc(s.name), {
        permanent: true, direction: 'top', offset: [0, -12], className: 'mn-pin-label',
      });
      baseMarkers.push(marker);
    }
    bounds.push([s.lat, s.lon]);
  }

  // Draw repeaters open to matched field stations, plus lines to those stations
  for (const { station: r, fieldStations } of repeaterInfo.values()) {
    if (r.lat == null || r.lon == null) continue;

    // Only add a marker if this repeater isn't already shown as a matched station
    if (!stationInfo.has(r.id)) {
      const rMarker = L.circleMarker([r.lat, r.lon], {
        radius: 9,
        color: ROLE_COLOR.repeater,
        fillColor: ROLE_COLOR.repeater,
        fillOpacity: 0.85,
        weight: 1.5,
      }).addTo(layer);
      const served = fieldStations.map(fs => esc(fs.name)).join(', ');
      rMarker.bindPopup(`
        <strong>${esc(r.name)}</strong><br>
        <span style="background:${ROLE_COLOR.repeater};color:#fff;padding:1px 5px;border-radius:999px;font-size:.76rem">repeater</span>
        <br><span style="font-size:.82rem;margin-top:4px;display:block">Open to: ${served}</span>
      `);
      bounds.push([r.lat, r.lon]);
    }

    // Draw a dashed line from the repeater to each matched field station it serves
    for (const fs of fieldStations) {
      if (fs.lat == null || fs.lon == null) continue;
      L.polyline([[r.lat, r.lon], [fs.lat, fs.lon]], {
        color: ROLE_COLOR.repeater,
        weight: 1.5,
        opacity: 0.5,
        dashArray: '5 6',
      }).addTo(layer);
    }
  }

  // Repeater pins and link lines were added after the station pins, so lift the
  // station of interest back above them.
  baseMarkers.forEach(m => m.bringToFront());

  if (bounds.length) state.bfMap.fitBounds(bounds, { padding: [30, 30], maxZoom: 12 });
}

// ── NETWORK VIEW tab ───────────────────────────────────────────────────────────
// The ghosting knowledge graph. A node is one ALERT address as transmitted by
// one station; an edge is a relationship between two of them, and there are
// exactly two kinds:
//
//   computed   the two addresses are one bit apart. Arithmetic over the loaded
//              file — the same question the Bit Flipper asks about a single
//              address, asked about every address at once. XOR is symmetric, so
//              a computed edge has no direction and carries no arrowhead.
//   confirmed  the relationship was observed, candidate → target, with an
//              evidence file behind it. Directed, and comparatively rare.
//
// They share one graph rather than getting a view each, because the question
// worth asking is which bit-adjacent pairs were ever *seen* ghosting — and that
// is only answerable when a confirmed edge can sit on top of a computed one.
// Every confirmed relationship shipped in data/ghosting-links.json is exactly one
// bit apart, so in practice the confirmed set is a subset of the computed one.
//
// Ported from the standalone BitFlipper_Network_View build (own palette, own
// full-viewport grid, its data hard-coded in the page). What survived: search and
// focus, the cluster and sensor filters, reciprocal-only, same-site-only, labels,
// spread, group-by-site, export, and the drag/pan/zoom feel. What changed: the
// graph is built from the loaded stations.json instead of a baked-in blob, the
// filters are generated from the data rather than fixed at four sensor types, and
// the nodes are wired through to the Stations map.
const NetworkView = (function () {

  // Rendered-node cap, in the spirit of MAP_LABEL_CAP and BF_MAX_RENDER_ROWS.
  // The full computed graph over the shipped file is ~23,700 edges across 5,122
  // addresses, which is not a picture. Past this the best-connected nodes are
  // kept and the note under the graph says how many were left out.
  //
  // The number is set by drawing cost, not by arithmetic: the force loop is about
  // 1.3 ms a frame even at several hundred nodes, while rasterising the edges it
  // produces is an order of magnitude more. Edge count grows with the node count,
  // so capping nodes is what keeps a frame affordable.
  const NV_MAX_NODES = 400;

  // Permanent name labels beyond this are a grey smear rather than a reading, so
  // past it only the best-connected nodes (and anything searched for) keep one.
  // The ceiling is MAP_LABEL_CAP itself rather than a number of its own: this is
  // the same question the Stations map answers about its pins, and two different
  // answers to it in one app would only be two things to tune. The labels toggle
  // still turns the lot off; this decides what "on" means when it is crowded.
  const NV_LABEL_CAP = MAP_LABEL_CAP;

  // …but a graph has to answer it per stage, not per app. Labels hold a fixed
  // size on screen however far the view is zoomed out, so what they collide with
  // is the room the stage has: sixty names are comfortable across a desktop pane
  // and illegible stacked in a phone's. One name per this much area, capped above
  // by NV_LABEL_CAP.
  const NV_LABEL_AREA = 9000;   // px² of stage per labelled node

  function labelBudget() {
    return Math.max(8, Math.min(NV_LABEL_CAP, Math.floor((nv.w * nv.h) / NV_LABEL_AREA)));
  }

  // Neighbour expansion is the expensive direction — one click can pull in
  // sixteen new addresses per node — so it stops here regardless of the cap.
  const NV_EXPAND_MAX = 900;

  // Force layout. The original ran 140 synchronous iterations per interaction;
  // these run a couple per animation frame with a cooling alpha instead, so the
  // graph settles visibly and then stops burning frames on its own.
  const NV_REPULSION  = 1900;
  const NV_SPRING     = 0.012;
  const NV_CENTRING   = 0.0008;
  const NV_DAMPING    = 0.84;
  const NV_ALPHA_DECAY = 0.985;
  const NV_ALPHA_MIN   = 0.03;

  // Sensor-type colours. The four the standalone build knew are kept so a ported
  // graph still reads the same; everything else — and there are 22 sensor types
  // in the shipped file, not 4 — draws from the generic palette below.
  const NV_TYPE_COLOR = {
    'Rainfall':    '#2563eb',
    'Battery':     '#d97706',
    'Water Level': '#0891b2',
    'Repeater':    '#7c35a3',
  };

  // Categorical palette for every other facet value. Chosen to stay legible on
  // both themes — the graph background follows --panel, which flips.
  const NV_PALETTE = [
    '#2563eb', '#d97706', '#0891b2', '#7c3aed', '#16a34a', '#e11d48',
    '#0ea5e9', '#b45309', '#65a30d', '#be185d', '#0d9488', '#6d28d9',
  ];
  const NV_GREY = '#8b98a8';   // the "not recorded" bucket, on every facet

  // Which sensor type speaks for an address when several share it. Loudoun Br's
  // 6128 is both "Rainfall" and "Rainfall Increment"; the increment is derived
  // from the reading, so the reading is what the node is called.
  const NV_TYPE_RANK = ['Water Level', 'Rainfall', 'Battery', 'Repeater'];

  // The facets. Adding an attribute to the graph means adding one entry here:
  // it becomes a filter group in the sidebar and an option in "Colour by", with
  // no other change. This is the extensibility the fixed four-checkbox original
  // could not offer — see the note on the data model in the header above.
  //
  //   values(n)  every value the node carries for this facet. An empty list is
  //              the "not recorded" bucket, which is a value like any other so
  //              that un-mapped stations stay visible instead of silently
  //              dropping out (same reasoning as FILTER_NONE on the Stations tab).
  const NV_FACETS = [
    { key: 'type',    label: 'Sensor type',   values: n => n.types },
    { key: 'role',    label: 'Station role',  values: n => (n.role ? [ROLE_LABEL[n.role] || n.role] : []) },
    { key: 'network', label: 'Radio network', values: n => n.networks },
    { key: 'basin',   label: 'Basin',         values: n => (n.basin ? [n.basin] : []) },
    { key: 'cluster', label: 'Confirmed cluster', values: n => (n.cluster ? ['Cluster ' + n.cluster] : []) },
  ];

  const NV_NONE_LABEL = 'Not recorded';

  // ── module state ──────────────────────────────────────────────────────────────
  // Session-scoped and deliberately not in `state`: none of it belongs in a saved
  // file, and node positions in particular are a property of this screen, not of
  // the network. They do outlive a tab switch, so coming back finds the graph
  // where it was left rather than re-scattering it.
  const nv = {
    graph:     null,     // { nodes:Map(key→node), byAddr:Map(addr→[node]) }  built from state.data
    confirmed: null,     // parsed data/ghosting-links.json, plus anything imported
    confState: 'idle',   // idle | loading | ready | error
    confError: '',
    confSources: [],     // where the confirmed links came from, for the sidebar

    search:      '',
    facetOff:    {},     // facet key → Set of un-ticked values (empty Set = no constraint)
    colourBy:    'type',
    showConfirmed: true,
    showComputed:  true,
    expand:      false,  // pull 1-bit neighbours of the seed in with it
    reciprocalOnly: false,
    sameSiteOnly:   false,
    labels:      true,
    siteMode:    false,
    spread:      105,

    pos:  new Map(),     // node key → { x, y, vx, vy }   survives re-renders
    vis:  null,          // last computed visible set
    els:  null,          // live SVG elements, paired with their nodes
    view: { scale: 1, tx: 0, ty: 0 },
    userMoved: false,    // panned or zoomed since the last filter change: stop auto-framing
    w: 1200, h: 800,

    sel:  null,          // node key the detail card is open on
    raf:  null,
    alpha: 0,
    drag: null,
    pan:  null,
    ro:   null,          // ResizeObserver on the stage
  };

  // ── graph construction ────────────────────────────────────────────────────────

  // Thrown away whenever a new stations.json is loaded — every node in the graph
  // is a fact about that file.
  function invalidate() {
    nv.graph = null;
    nv.pos.clear();
    nv.vis = null;
    nv.sel = null;
    nv.facetOff = {};    // its values were vocabulary from the file just replaced
  }

  function typeRank(t) {
    const i = NV_TYPE_RANK.indexOf(t);
    return i < 0 ? NV_TYPE_RANK.length : i;
  }

  // One node per (station, ALERT address). Not per sensor, as the standalone
  // build had it: ghosting happens to an address on the air, and a station that
  // reports rainfall and rainfall-increment on the same address transmits one
  // thing, not two. Not per address either — 614 addresses in the shipped file
  // are claimed by more than one station, and collapsing those would invent a
  // relationship between sites that have never heard of each other.
  function buildGraph() {
    if (nv.graph) return nv.graph;
    const nodes  = new Map();
    const byAddr = new Map();
    const byName = new Map();    // "name|addr" → node, for the duplicate fold below
    if (!state.data) { nv.graph = { nodes, byAddr }; return nv.graph; }

    const nets = new Map((state.data.radio_networks || []).map(n => [n.id, n.name]));
    for (const s of state.data.stations) {
      const role     = primaryRole(s);
      const networks = (s.radio_network_ids || []).map(id => nets.get(id) || id);
      const perAddr  = new Map();
      for (const sensor of stationSensors(s)) {
        const addr = parseInt(sensor.alert_id, 10);
        if (isNaN(addr) || addr <= 0 || addr >= 65536) continue;
        if (!perAddr.has(addr)) perAddr.set(addr, []);
        perAddr.get(addr).push(sensor);
      }
      for (const [addr, sensors] of perAddr) {
        const types = [...new Set(sensors.map(x => x.type).filter(Boolean))]
          .sort((a, b) => typeRank(a) - typeRank(b) || a.localeCompare(b));
        const sensorIds = [...new Set(sensors.map(x => x.sensor_id).filter(Boolean))];

        // Seven sites in the shipped file appear twice — same name, same ARRO
        // db_id, same sensor ids, different station records. dedupeMatches folds
        // those together for the Bit Flipper's table and the graph has to fold
        // them too, or a duplicated site becomes two nodes with the same name,
        // twice the edges and a relationship to itself. Name plus address is the
        // same identity dedupeMatches keys on.
        const dupeKey = s.name + '|' + addr;
        const twin = byName.get(dupeKey);
        if (twin) {
          twin.stationIds.push(s.id);
          twin.types     = [...new Set([...twin.types, ...types])]
            .sort((a, b) => typeRank(a) - typeRank(b) || a.localeCompare(b));
          twin.type      = twin.types[0] || '';
          twin.sensorIds = [...new Set([...twin.sensorIds, ...sensorIds])];
          twin.sensors   = twin.sensors.concat(sensors);
          // The record carrying a station number and a position is the one worth
          // sending to the map; the stub duplicate is not.
          const number = s.station_number || (s.site && s.site.number) || '';
          if (!twin.number && number && s.lat != null) {
            twin.stationId = s.id;
            twin.number    = number;
          }
          continue;
        }

        const key = s.id + '|' + addr;
        const node = {
          key, addr,
          stationId: s.id,          // the record the map is sent to
          stationIds: [s.id],       // every record folded into this node
          name:      s.name,
          number:    s.station_number || (s.site && s.site.number) || '',
          sensorIds,
          sensors,
          types:     types.length ? types : [],
          type:      types[0] || '',
          role, networks,
          basin:     s.basin || '',
          dbId:      arroSiteId(s),
          cluster:   0,     // filled in from the confirmed graph, below
          unresolved: false,
        };
        nodes.set(key, node);
        byName.set(dupeKey, node);
        if (!byAddr.has(addr)) byAddr.set(addr, []);
        byAddr.get(addr).push(node);
      }
    }
    nv.graph = { nodes, byAddr };
    linkConfirmed();
    return nv.graph;
  }

  // Every station+address one bit away from this node's address. The Bit Flipper
  // asks this of one address through bfComputeVariants; here it is the edge
  // relation of the whole graph, so it is answered straight off the address index
  // rather than by expanding 16 variant rows per node.
  function computedNeighbours(node) {
    const g = buildGraph();
    const out = [];
    for (let b = 0; b < 16; b++) {
      const v = node.addr ^ (1 << b);
      if (v <= 0 || v >= 65536) continue;
      for (const other of g.byAddr.get(v) || []) out.push(other);
    }
    return out;
  }

  // ── confirmed relationships ───────────────────────────────────────────────────
  // Shipped as data, not baked into this file: they are a snapshot of an evidence
  // review that happens outside the app, and CSV import below is how the next
  // review gets in. Fetched the same lazy way the ACMA layer is.

  function ensureConfirmed() {
    if (nv.confState === 'ready' || nv.confState === 'loading') return;
    nv.confState = 'loading';
    fetch('data/ghosting-links.json')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => {
        nv.confirmed = { sensors: d.sensors || [], links: (d.links || []).map(normaliseLink) };
        nv.confSources = [`${nv.confirmed.links.length} from data/ghosting-links.json`];
        nv.confState = 'ready';
        linkConfirmed();
        renderFacets();
        renderLegend();
        refresh(true);
      })
      .catch(err => {
        // A file:// open has no server to fetch from. The computed graph is
        // whole without this, so the tab keeps working and says what is missing.
        nv.confState = 'error';
        nv.confError = err.message;
        nv.confirmed = { sensors: [], links: [] };
        refresh(false);
      });
  }

  function normaliseLink(l) {
    return {
      source: String(l.source || ''),
      target: String(l.target || ''),
      sourceSite: String(l.source_site || ''),
      targetSite: String(l.target_site || ''),
      sourceAlert: parseInt(l.source_alert, 10),
      targetAlert: parseInt(l.target_alert, 10),
      reciprocal: !!l.reciprocal,
      sameSite:   !!l.same_site,
      evidence:   Array.isArray(l.evidence) ? l.evidence : (l.evidence ? [String(l.evidence)] : []),
      origin:     l.origin || 'ghosting-links.json',
    };
  }

  // Resolve each confirmed link's two ends onto graph nodes, and hang the result
  // off the nodes themselves. Resolution is by sensor id first (exact — 144 of
  // the 147 shipped ends match one outright) and by address second, which is
  // enough for the rest. An end that resolves to nothing is kept as its own node
  // and flagged: the issue this ports asks for unresolved nodes to be *reported*,
  // not quietly dropped, because a confirmed relationship pointing at an address
  // the station file has never heard of is a finding in itself.
  function linkConfirmed() {
    if (!nv.graph || !nv.confirmed) return;
    const g = nv.graph;
    // Clear anything a previous pass hung on the nodes — an import re-runs this,
    // and the placeholders it made last time have to go with it or a re-resolved
    // end would keep its old stand-in as well as its new node.
    for (const n of g.nodes.values()) { n.confirmed = null; n.cluster = 0; }
    for (const [k, n] of [...g.nodes]) if (n.unresolved) g.nodes.delete(k);
    for (const [addr, list] of g.byAddr) {
      const kept = list.filter(n => !n.unresolved);
      if (kept.length !== list.length) g.byAddr.set(addr, kept);
    }

    const bySensorId = new Map();
    for (const n of g.nodes.values()) for (const sid of n.sensorIds) {
      if (!bySensorId.has(sid)) bySensorId.set(sid, n);
    }

    const resolve = (sensorId, addr, siteNumber) => {
      const exact = bySensorId.get(sensorId);
      if (exact) return exact;
      const cands = g.byAddr.get(addr) || [];
      // One station transmits the address: that is who the link is about, whatever
      // site number the evidence file carries. Those numbers are not always the
      // station_number in this database — one shipped end says site 140024 for a
      // station numbered 85289 — so a mismatch is not evidence of the wrong station
      // when there is only one to choose from.
      if (cands.length === 1) return cands[0];
      // Several do claim it, and now the site number is the only thing that can
      // tell them apart.
      const bySite = cands.find(c => c.number && String(c.number) === String(siteNumber));
      if (bySite) return bySite;
      // It named none of them. Picking the first would attribute an observed
      // relationship to a station that may have nothing to do with it, which is
      // worse than saying so — this end is reported unresolved instead.
      return placeholder(sensorId, addr, siteNumber);
    };

    // A node for an end the station file cannot account for. It draws like any
    // other node so the relationship stays visible, but it is grey, it says
    // "not in stations.json", and it is excluded from anything that needs a real
    // station — the map hand-off above all.
    const placeholder = (sensorId, addr, siteNumber) => {
      const key = '?|' + (sensorId || addr);
      if (g.nodes.has(key)) return g.nodes.get(key);
      const meta = (nv.confirmed.sensors || []).find(s => s.sensor_id === sensorId) || {};
      const node = {
        key, addr: isNaN(addr) ? 0 : addr,
        stationId: null,
        stationIds: [],
        name:   meta.site_name || `Unknown site ${siteNumber || ''}`.trim(),
        number: String(meta.site_id || siteNumber || ''),
        sensorIds: sensorId ? [sensorId] : [],
        sensors: [],
        types:  meta.type ? [meta.type] : [],
        type:   meta.type || '',
        role: '', networks: [], basin: '', dbId: null,
        cluster: 0, unresolved: true,
      };
      g.nodes.set(key, node);
      if (!g.byAddr.has(node.addr)) g.byAddr.set(node.addr, []);
      g.byAddr.get(node.addr).push(node);
      return node;
    };

    const links = [];
    for (const l of nv.confirmed.links) {
      const a = resolve(l.source, l.sourceAlert, l.sourceSite);
      const b = resolve(l.target, l.targetAlert, l.targetSite);
      if (!a || !b || a === b) continue;
      const rec = { ...l, a, b };
      links.push(rec);
      (a.confirmed || (a.confirmed = [])).push(rec);
      (b.confirmed || (b.confirmed = [])).push(rec);
    }
    nv.confirmed.resolved = links;
    clusterConfirmed(links);
  }

  // Connected components of the confirmed graph only. The standalone build shipped
  // a cluster number per node and a "cluster" dropdown built from it; computing
  // them over the *visible* graph instead would give a filter whose own options
  // moved every time it was used, so they are pinned to the confirmed set — which
  // is the stable, evidence-backed part — and everything else is unclustered.
  function clusterConfirmed(links) {
    const adj = new Map();
    const add = (a, b) => {
      if (!adj.has(a)) adj.set(a, []);
      adj.get(a).push(b);
    };
    for (const l of links) { add(l.a, l.b); add(l.b, l.a); }
    let c = 0;
    for (const start of adj.keys()) {
      if (start.cluster) continue;
      c++;
      const queue = [start];
      start.cluster = c;
      while (queue.length) {
        const n = queue.pop();
        for (const m of adj.get(n) || []) if (!m.cluster) { m.cluster = c; queue.push(m); }
      }
    }
  }

  // ── facet vocabulary ──────────────────────────────────────────────────────────

  // Every value each facet actually takes, with a count, built from the graph.
  // Same shape as the Stations tab's filter options, and the same rule: an empty
  // un-ticked set means "no constraint", so the default shows everything.
  function facetOptions() {
    const g = buildGraph();
    const out = {};
    for (const f of NV_FACETS) out[f.key] = new Map();
    for (const n of g.nodes.values()) {
      for (const f of NV_FACETS) {
        const vals = f.values(n);
        const list = vals && vals.length ? vals : [NV_NONE_LABEL];
        for (const v of list) out[f.key].set(v, (out[f.key].get(v) || 0) + 1);
      }
    }
    const sorted = {};
    for (const f of NV_FACETS) {
      sorted[f.key] = [...out[f.key].entries()]
        .sort((a, b) => (a[0] === NV_NONE_LABEL) - (b[0] === NV_NONE_LABEL) || b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
    }
    return sorted;
  }

  function facetValues(node, key) {
    const f = NV_FACETS.find(x => x.key === key);
    if (!f) return [NV_NONE_LABEL];
    const v = f.values(node);
    return v && v.length ? v : [NV_NONE_LABEL];
  }

  function nodePasses(node) {
    for (const f of NV_FACETS) {
      const off = nv.facetOff[f.key];
      if (!off || !off.size) continue;
      if (facetValues(node, f.key).every(v => off.has(v))) return false;
    }
    return true;
  }

  // Stable colour for a facet value: the four known sensor types keep the
  // standalone build's palette, everything else is assigned by position in the
  // facet's own sorted vocabulary so a value does not change colour between
  // renders.
  const colourCache = new Map();
  function colourFor(value, facetKey) {
    if (value === NV_NONE_LABEL) return NV_GREY;
    if (facetKey === 'type' && NV_TYPE_COLOR[value]) return NV_TYPE_COLOR[value];
    const ck = facetKey + ' ' + value;
    if (colourCache.has(ck)) return colourCache.get(ck);
    let h = 0;
    for (let i = 0; i < ck.length; i++) h = (h * 31 + ck.charCodeAt(i)) >>> 0;
    const c = NV_PALETTE[h % NV_PALETTE.length];
    colourCache.set(ck, c);
    return c;
  }

  function nodeColour(n) {
    if (n.unresolved) return NV_GREY;
    return colourFor(facetValues(n, nv.colourBy)[0], nv.colourBy);
  }

  // ── the visible set ───────────────────────────────────────────────────────────
  // Built in one pass so nothing downstream has to recompute it. The original
  // called its equivalent from inside the per-frame tick, which meant re-deriving
  // the whole filtered graph sixty times a second; here the result is cached on
  // nv.vis and only rebuilt when a control moves.

  function searchTokens() {
    return (nv.search || '').toLowerCase().split(/[\s,;]+/).filter(Boolean);
  }

  function matchesSearch(n, tokens) {
    if (!tokens.length) return false;
    const hay = `${n.name} ${n.number} ${n.addr} ${n.sensorIds.join(' ')} ${n.types.join(' ')}`.toLowerCase();
    return tokens.some(t => hay.includes(t));
  }

  function computeVisible() {
    const g = buildGraph();
    const tokens = searchTokens();

    // Seed. A search names the nodes it hits; without one the confirmed graph is
    // the starting point, because the whole computed graph is every address in
    // the file and says nothing on its own.
    const seed = new Set();
    const hits = new Set();
    if (tokens.length) {
      for (const n of g.nodes.values()) if (matchesSearch(n, tokens)) { seed.add(n); hits.add(n); }
    } else if (nv.showConfirmed && nv.confirmed && nv.confirmed.resolved) {
      for (const l of nv.confirmed.resolved) { seed.add(l.a); seed.add(l.b); }
    }

    // Expansion pulls each seed node's 1-bit neighbours in with it — the graph
    // equivalent of running the Bit Flipper on everything on screen at once.
    let expandCapped = false;
    if (nv.expand && nv.showComputed) {
      for (const n of [...seed]) {
        if (seed.size >= NV_EXPAND_MAX) { expandCapped = true; break; }
        for (const m of computedNeighbours(n)) seed.add(m);
      }
    }

    // Facets apply to the seed, not to the edges: a node the operator has filtered
    // out should take its links with it.
    let nodes = [...seed].filter(nodePasses);

    // Edges among the survivors. Computed adjacency is looked up per node rather
    // than materialised for the whole file — 16 map hits a node beats holding
    // 23,700 edge objects that mostly are not on screen.
    const present = new Set(nodes.map(n => n.key));
    const edges = new Map();   // unordered pair key → edge record
    const pairKey = (a, b) => (a.key < b.key ? a.key + ' ' + b.key : b.key + ' ' + a.key);

    if (nv.showComputed) {
      for (const n of nodes) {
        for (const m of computedNeighbours(n)) {
          if (!present.has(m.key) || m === n) continue;
          const k = pairKey(n, m);
          if (edges.has(k)) continue;
          edges.set(k, {
            a: n.key < m.key ? n : m, b: n.key < m.key ? m : n,
            computed: true, confirmed: false, dirs: [],
            sameSite: !!(n.stationId && n.stationId === m.stationId),
            reciprocal: false, evidence: [],
          });
        }
      }
    }
    if (nv.showConfirmed && nv.confirmed && nv.confirmed.resolved) {
      for (const l of nv.confirmed.resolved) {
        if (!present.has(l.a.key) || !present.has(l.b.key)) continue;
        const k = pairKey(l.a, l.b);
        let e = edges.get(k);
        if (!e) {
          e = { a: l.a.key < l.b.key ? l.a : l.b, b: l.a.key < l.b.key ? l.b : l.a,
                computed: false, confirmed: false, dirs: [], sameSite: l.sameSite,
                reciprocal: false, evidence: [] };
          edges.set(k, e);
        }
        e.confirmed  = true;
        e.reciprocal = e.reciprocal || l.reciprocal;
        e.sameSite   = e.sameSite || l.sameSite;
        e.evidence   = [...new Set([...e.evidence, ...l.evidence])];
        e.dirs.push({ from: l.a, to: l.b });
      }
    }

    let list = [...edges.values()];
    if (nv.reciprocalOnly) list = list.filter(e => e.reciprocal);
    if (nv.sameSiteOnly)   list = list.filter(e => e.sameSite);

    // Degree, for the cap and for node sizing.
    const deg = new Map();
    for (const e of list) {
      deg.set(e.a.key, (deg.get(e.a.key) || 0) + 1);
      deg.set(e.b.key, (deg.get(e.b.key) || 0) + 1);
    }

    // Isolated nodes go, except the ones the operator explicitly searched for —
    // an address with no bit-neighbours in the file is a real answer, and it
    // should be visible rather than vanish into an empty canvas.
    nodes = nodes.filter(n => deg.get(n.key) || hits.has(n));

    // The cap. Highest degree first, with search hits pinned in front so a
    // deliberate query is never the thing that gets trimmed.
    const total = nodes.length;
    let capped = false;
    if (nodes.length > NV_MAX_NODES) {
      capped = true;
      nodes.sort((a, b) =>
        (hits.has(b) - hits.has(a)) || ((deg.get(b.key) || 0) - (deg.get(a.key) || 0)));
      nodes = nodes.slice(0, NV_MAX_NODES);
      const keep = new Set(nodes.map(n => n.key));
      list = list.filter(e => keep.has(e.a.key) && keep.has(e.b.key));
    }

    // Which nodes earn a name. Under the cap, everything; over it, the search
    // hits and then the best-connected, because a hub is the node whose identity
    // a reader actually needs to place the cluster around it.
    const budget = labelBudget();
    const labelled = new Set();
    if (nodes.length <= budget) {
      for (const n of nodes) labelled.add(n.key);
    } else {
      [...nodes]
        .sort((a, b) => (hits.has(b) - hits.has(a)) || ((deg.get(b.key) || 0) - (deg.get(a.key) || 0)))
        .slice(0, budget)
        .forEach(n => labelled.add(n.key));
    }

    const unresolved = nodes.filter(n => n.unresolved).length;
    nv.vis = { nodes, edges: list, deg, hits, total, capped, expandCapped, unresolved, labelled, budget };
    return nv.vis;
  }

  // ── layout ────────────────────────────────────────────────────────────────────

  function posFor(node, i) {
    let p = nv.pos.get(node.key);
    if (p) return p;
    // New nodes land on a phyllotaxis spiral around the centre, as in the
    // original — an even scatter with no two nodes on top of each other, which a
    // random placement cannot promise. The spacing follows the spread control
    // rather than the original's fixed 8px: a starting arrangement packed tighter
    // than the layout wants costs the grid above its whole advantage on the first
    // few frames, when every node is still in one cell.
    const a = i * 2.399, r = 40 + nv.spread * 0.2 * Math.sqrt(i);
    p = { x: nv.w / 2 + Math.cos(a) * r, y: nv.h / 2 + Math.sin(a) * r, vx: 0, vy: 0 };
    nv.pos.set(node.key, p);
    return p;
  }

  // Every pair, as the original had it. A spatial grid was tried here to make it
  // O(n · neighbours) and measured slower — at the cap this loop is 1.3 ms a
  // frame, and the Map lookups a grid needs cost more than the square roots it
  // saves at that size. What actually costs a frame is rasterising the result,
  // which is why the cap above is on what gets drawn.
  function iterate(nodes, edges) {
    const cx = nv.w / 2, cy = nv.h / 2;
    const ps = nodes.map(n => n.p);
    for (let i = 0; i < ps.length; i++) {
      const u = ps[i];
      for (let j = i + 1; j < ps.length; j++) {
        const v = ps[j];
        const dx = v.x - u.x, dy = v.y - u.y;
        const d2 = dx * dx + dy * dy + 0.1, d = Math.sqrt(d2), f = NV_REPULSION / d2;
        u.vx -= dx / d * f; u.vy -= dy / d * f;
        v.vx += dx / d * f; v.vy += dy / d * f;
      }
    }
    for (const e of edges) {
      const u = e.pa, v = e.pb;
      const dx = v.x - u.x, dy = v.y - u.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      // Group-by-site pulls same-station addresses into a tight knot, so a site
      // reads as one thing with its neighbours hanging off it.
      const want = (nv.siteMode && e.sameSite) ? 34 : nv.spread;
      const f = (d - want) * NV_SPRING;
      u.vx += dx / d * f; u.vy += dy / d * f;
      v.vx -= dx / d * f; v.vy -= dy / d * f;
    }
    for (const p of ps) {
      p.vx += (cx - p.x) * NV_CENTRING;
      p.vy += (cy - p.y) * NV_CENTRING;
      p.vx *= NV_DAMPING; p.vy *= NV_DAMPING;
      p.x += p.vx; p.y += p.vy;
    }
  }

  // Site mode gets a deterministic starting arrangement — one ring of addresses
  // per station, laid out on a grid — rather than asking the force layout to
  // discover the grouping it has been told about.
  function siteLayout() {
    const V = nv.vis; if (!V) return;
    const groups = new Map();
    for (const n of V.nodes) {
      const k = n.stationId || n.key;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(n);
    }
    const gs = [...groups.values()];
    const cols = Math.max(1, Math.ceil(Math.sqrt(gs.length)));
    const rows = Math.max(1, Math.ceil(gs.length / cols));
    const stepX = nv.w / (cols + 1), stepY = nv.h / (rows + 1);
    const f = nv.spread / 105;
    gs.forEach((g, i) => {
      const x = nv.w / 2 + (stepX * (1 + i % cols) - nv.w / 2) * f;
      const y = nv.h / 2 + (stepY * (1 + Math.floor(i / cols)) - nv.h / 2) * f;
      g.forEach((n, j) => {
        const a = 2 * Math.PI * j / g.length;
        n.p.x = x + Math.cos(a) * (g.length > 1 ? 22 : 0);
        n.p.y = y + Math.sin(a) * (g.length > 1 ? 22 : 0);
        n.p.vx = n.p.vy = 0;
      });
    });
    tick();
  }

  // ── the animation loop ────────────────────────────────────────────────────────
  // One place decides whether the simulation runs, and it checks that the tab is
  // still the open one every frame. A force layout left ticking behind another
  // tab is exactly the sort of idle CPU the performance pass went looking for.

  function start(energy) {
    nv.alpha = Math.max(nv.alpha, energy == null ? 1 : energy);
    if (!nv.raf) nv.raf = requestAnimationFrame(frame);
  }

  function stop() {
    if (nv.raf) cancelAnimationFrame(nv.raf);
    nv.raf = null;
    nv.alpha = 0;
  }

  function frame() {
    nv.raf = null;
    // Belt and braces: switchTab stops us on the way out, and this catches every
    // other way the tab can stop being on screen (a file load, a re-render, the
    // window going to the background).
    if (state.activeTab !== 'network' || !document.getElementById('nv-svg') || document.hidden) {
      nv.alpha = 0;
      return;
    }
    const V = nv.vis;
    if (!V || !V.nodes.length) return;
    // Fewer passes as the graph grows, so a frame costs about the same either way.
    const n = V.nodes.length;
    const passes = n > 300 ? 1 : n > 120 ? 2 : 3;
    for (let i = 0; i < passes; i++) iterate(V.nodes, V.edges);
    tick();
    // Keep the whole graph framed as it relaxes, not just once it has stopped.
    // A layout that settles over four seconds spends those four seconds walking
    // off the edges of the stage if the view is only fitted at the end, and the
    // snap back when it finishes is worse than the sprawl. Fitting every frame
    // tracks it smoothly, because the layout itself moves smoothly. Someone who
    // has panned or zoomed since the last filter change has said where they want
    // to be looking, and is left there.
    if (!nv.userMoved) fit();
    nv.alpha *= NV_ALPHA_DECAY;
    if (nv.alpha > NV_ALPHA_MIN) nv.raf = requestAnimationFrame(frame);
    else nv.alpha = 0;
  }

  // ── drawing ───────────────────────────────────────────────────────────────────

  function radius(n) {
    const V = nv.vis;
    const d = (V && V.deg.get(n.key)) || 0;
    return 5 + Math.min(10, Math.sqrt(d) * 2.5);
  }

  // Build the SVG once per visible-set change. Positions are then written by
  // tick() on every frame, and nothing else touches the DOM — the original
  // re-ran querySelectorAll for every node and label on every tick.
  function draw() {
    const svg = document.getElementById('nv-svg');
    if (!svg) return;
    const V = nv.vis || computeVisible();
    V.nodes.forEach((n, i) => { n.p = posFor(n, i); });
    for (const e of V.edges) { e.pa = nv.pos.get(e.a.key); e.pb = nv.pos.get(e.b.key); }

    const world = svg.querySelector('#nv-world');
    const eg = svg.querySelector('#nv-edges');
    const cg = svg.querySelector('#nv-confirmed');
    const ng = svg.querySelector('#nv-nodes');

    // Computed edges are symmetric and there can be thousands, so they are merged
    // into one <path> per style bucket: four attribute writes a frame instead of
    // four per edge. Confirmed edges stay individual <line>s because they are
    // directed — an arrowhead only renders at the end of a path, so a merged path
    // would lose every arrow but the last.
    const buckets = [
      { cls: 'nv-edge nv-edge--same',  test: e => e.sameSite },
      { cls: 'nv-edge',                test: e => !e.sameSite },
    ];
    const computed = V.edges.filter(e => e.computed && !e.confirmed);
    eg.innerHTML = buckets.map((b, i) => `<path class="${b.cls}" data-b="${i}"/>`).join('');
    const paths = buckets.map((b, i) => ({
      el: eg.querySelector(`[data-b="${i}"]`),
      edges: computed.filter(b.test),
    }));

    const confirmed = V.edges.filter(e => e.confirmed);
    cg.innerHTML = confirmed.map((e, i) => {
      const cls = 'nv-conf' + (e.reciprocal ? ' nv-conf--recip' : '') + (e.sameSite ? ' nv-conf--same' : '');
      return `<line class="${cls}" data-c="${i}" marker-end="url(#nv-arrow)"/>`;
    }).join('');
    const lines = confirmed.map((e, i) => ({ el: cg.querySelector(`[data-c="${i}"]`), e }));

    ng.innerHTML = V.nodes.map(n => {
      const r   = radius(n);
      const hit = V.hits.has(n) ? ' nv-node--hit' : '';
      const un  = n.unresolved ? ' nv-node--unresolved' : '';
      const label = V.labelled.has(n.key)
        ? `<text class="nv-label" x="${(r + 5).toFixed(1)}" y="-8">${esc(n.name)} · ${n.addr}</text>`
        : '';
      return `<g class="nv-node${hit}${un}" data-k="${escAttr(n.key)}" tabindex="0" role="button"
                 aria-label="${escAttr(n.name + ' address ' + n.addr)}">
                <circle r="${r.toFixed(1)}" fill="${nodeColour(n)}"/>${label}
              </g>`;
    }).join('');
    const nodeEls = [...ng.children].map((el, i) => ({ el, n: V.nodes[i] }));

    nv.els = { paths, lines, nodes: nodeEls, world };
    svg.classList.toggle('nv-hide-labels', !nv.labels);
    applyView();
    bind();
    tick();
    updateChrome();
  }

  // Per-frame position write. Every node is one transform, every computed bucket
  // one path, and only the handful of confirmed lines cost four attributes each.
  function tick() {
    const els = nv.els; if (!els) return;
    for (const item of els.nodes) {
      const p = item.n.p;
      item.el.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`);
    }
    for (const b of els.paths) {
      let d = '';
      for (const e of b.edges) {
        d += `M${e.pa.x.toFixed(1)} ${e.pa.y.toFixed(1)}L${e.pb.x.toFixed(1)} ${e.pb.y.toFixed(1)}`;
      }
      b.el.setAttribute('d', d);
    }
    for (const item of els.lines) {
      const e = item.e;
      // Direction: the first observed candidate → target ordering. Reciprocal
      // pairs are drawn as one line and flagged, rather than as two overlapping.
      const dir = e.dirs[0];
      const from = dir ? nv.pos.get(dir.from.key) : e.pa;
      const to   = dir ? nv.pos.get(dir.to.key)   : e.pb;
      // Stop the line short of the target so the arrowhead lands on the rim of
      // the circle rather than inside it.
      const dx = to.x - from.x, dy = to.y - from.y;
      const d  = Math.sqrt(dx * dx + dy * dy) || 1;
      const back = radius(dir ? dir.to : e.b) + 7;
      item.el.setAttribute('x1', from.x.toFixed(1));
      item.el.setAttribute('y1', from.y.toFixed(1));
      item.el.setAttribute('x2', (to.x - dx / d * back).toFixed(1));
      item.el.setAttribute('y2', (to.y - dy / d * back).toFixed(1));
    }
  }

  function applyView() {
    const w = nv.els && nv.els.world;
    if (!w) return;
    w.setAttribute('transform', `translate(${nv.view.tx} ${nv.view.ty}) scale(${nv.view.scale})`);
    // Text and stroke widths are in world units, so a view fitted to 146 nodes
    // renders 10px labels at four. The scale goes to CSS, which divides the label
    // size back out and holds the edges to a screen width (see --nv-scale in
    // styles.css) — the graph stays readable at whatever zoom it is framed at.
    const svg = w.ownerSVGElement || document.getElementById('nv-svg');
    if (svg) svg.style.setProperty('--nv-scale', nv.view.scale.toFixed(4));
  }

  // ── interaction ───────────────────────────────────────────────────────────────

  function svgPoint(ev, el) {
    const svg = document.getElementById('nv-svg');
    if (!svg || !svg.createSVGPoint) return { x: 0, y: 0 };
    const p = svg.createSVGPoint();
    p.x = ev.clientX; p.y = ev.clientY;
    const ctm = (el || svg).getScreenCTM();
    return ctm ? p.matrixTransform(ctm.inverse()) : { x: 0, y: 0 };
  }

  function bind() {
    const els = nv.els; if (!els) return;
    for (const item of els.nodes) {
      const el = item.el, n = item.n;
      el.onpointerdown = ev => {
        ev.preventDefault(); ev.stopPropagation();
        // Dragging a node brings its neighbourhood with it, three hops out and
        // weakening as it goes — the standalone build's nicest touch, and the
        // one that makes a hairball explorable by hand.
        const dist = new Map([[n.key, 0]]);
        const queue = [n];
        while (queue.length) {
          const x = queue.shift(), z = dist.get(x.key);
          if (z >= 3) continue;
          for (const e of (nv.vis ? nv.vis.edges : [])) {
            const y = e.a === x ? e.b : e.b === x ? e.a : null;
            if (y && !dist.has(y.key)) { dist.set(y.key, z + 1); queue.push(y); }
          }
        }
        const start = svgPoint(ev, els.world);
        nv.drag = {
          key: n.key, start,
          items: [...dist].map(([k, z]) => {
            const p = nv.pos.get(k);
            return p ? { p, z, x0: p.x, y0: p.y } : null;
          }).filter(Boolean),
        };
        try { el.setPointerCapture(ev.pointerId); } catch (_) {}
      };
      el.onpointermove = ev => {
        if (!nv.drag || nv.drag.key !== n.key) return;
        const p = svgPoint(ev, els.world);
        const dx = p.x - nv.drag.start.x, dy = p.y - nv.drag.start.y;
        for (const o of nv.drag.items) {
          const f = o.z ? Math.pow(0.55, o.z) : 1;
          o.p.x = o.x0 + dx * f; o.p.y = o.y0 + dy * f;
          o.p.vx = o.p.vy = 0;
        }
        tick();
      };
      el.onpointerup = () => { if (nv.drag) { nv.drag = null; start(0.35); } };
      el.onpointercancel = () => { nv.drag = null; };
      el.onmouseenter = ev => showTip(ev, n);
      el.onmouseleave = hideTip;
      el.onclick = ev => { ev.stopPropagation(); select(n.key); };
      el.onkeydown = ev => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(n.key); }
      };
    }
  }

  function showTip(ev, n) {
    const tip = document.getElementById('nv-tip');
    const stage = document.getElementById('nv-stage');
    if (!tip || !stage) return;
    const deg = (nv.vis && nv.vis.deg.get(n.key)) || 0;
    const conf = (n.confirmed || []).length;
    tip.innerHTML = `<b>${esc(n.name)}</b><br>ALERT ${n.addr}`
      + `<br><span class="small">${esc(n.types.join(' · ') || 'No sensor type')}`
      + `<br>${deg} link${deg === 1 ? '' : 's'} in view`
      + (conf ? ` · ${conf} confirmed` : '')
      + (n.unresolved ? '<br>Not in the loaded station file' : '')
      + '</span>';
    const r = stage.getBoundingClientRect();
    tip.style.left = Math.min(r.width - 220, ev.clientX - r.left + 14) + 'px';
    tip.style.top  = (ev.clientY - r.top + 14) + 'px';
    tip.hidden = false;
  }

  function hideTip() {
    const tip = document.getElementById('nv-tip');
    if (tip) tip.hidden = true;
  }

  function stageBind() {
    const svg = document.getElementById('nv-svg');
    if (!svg) return;
    svg.onpointerdown = ev => {
      if (ev.target !== svg && ev.target.tagName !== 'rect') return;
      nv.pan = { p: svgPoint(ev, svg), tx: nv.view.tx, ty: nv.view.ty };
    };
    svg.onpointermove = ev => {
      if (!nv.pan || nv.drag) return;
      const p = svgPoint(ev, svg);
      nv.view.tx = nv.pan.tx + p.x - nv.pan.p.x;
      nv.view.ty = nv.pan.ty + p.y - nv.pan.p.y;
      nv.userMoved = true;
      applyView();
    };
    svg.onpointerup = () => { nv.pan = null; };
    svg.onpointerleave = () => { nv.pan = null; hideTip(); };
    svg.addEventListener('wheel', ev => {
      ev.preventDefault();
      const z = Math.exp(-ev.deltaY * 0.001);
      const p = svgPoint(ev, svg);
      nv.view.tx = p.x - (p.x - nv.view.tx) * z;
      nv.view.ty = p.y - (p.y - nv.view.ty) * z;
      nv.view.scale *= z;
      nv.userMoved = true;
      applyView();
    }, { passive: false });
    svg.onclick = ev => { if (ev.target === svg) select(null); };
  }

  // ── the detail card, and the way out to the map ───────────────────────────────

  function select(key) {
    nv.sel = key;
    renderDetail();
  }

  function renderDetail() {
    const el = document.getElementById('nv-detail');
    if (!el) return;
    const g = buildGraph();
    const n = nv.sel && g.nodes.get(nv.sel);
    if (!n) { el.hidden = true; el.innerHTML = ''; return; }

    const inbound  = (n.confirmed || []).filter(l => l.b === n);
    const outbound = (n.confirmed || []).filter(l => l.a === n);
    const neigh    = nv.showComputed ? computedNeighbours(n) : [];

    const linkRows = (list, dir) => list.length ? list.map(l => {
      const o = dir === 'in' ? l.a : l.b;
      return `<div class="nv-rel">
        <b>${dir === 'in' ? '←' : '→'} ${esc(o.name)}</b>
        <span class="small">ALERT ${o.addr}${o.types.length ? ' · ' + esc(o.types[0]) : ''}</span>
        ${l.evidence.length ? `<span class="small nv-ev">${esc(l.evidence.join(', '))}</span>` : ''}
      </div>`;
    }).join('') : '<p class="small" style="color:var(--muted);margin:.2rem 0">None</p>';

    const site = (n.stationId && state.data) ? state.data.stations.find(s => s.id === n.stationId) : null;
    const arro = site ? arroSiteUrl(arroSiteId(site)) : null;

    el.hidden = false;
    el.innerHTML = `
      <button class="nv-close" onclick="NetworkView.select(null)" title="Close" aria-label="Close">×</button>
      <h3>${esc(n.name)}</h3>
      <p class="small" style="color:var(--muted);margin:.15rem 0 .6rem">
        ALERT <strong>${n.addr}</strong>${n.number ? ` · Site ${esc(n.number)}` : ''}
        ${n.types.length ? `<br>${esc(n.types.join(' · '))}` : ''}
        ${n.role ? `<br>${esc(ROLE_LABEL[n.role] || n.role)}` : ''}
        ${n.networks.length ? `<br>${esc(n.networks.join(', '))}` : ''}
        ${n.cluster ? `<br>Confirmed cluster ${n.cluster}` : ''}
      </p>
      ${n.unresolved
        ? `<p class="small nv-warn">This end of a confirmed relationship has no match in the loaded
             station file — it can be read here, but it cannot be shown on the map.</p>`
        : `<div class="button-row" style="margin-bottom:.6rem">
             <button class="primary" onclick="NetworkView.showOnMap('${escAttr(n.key)}')">Show on map</button>
             ${arro ? `<a class="nv-link" href="${esc(arro)}" target="_blank" rel="noopener">ARRO site ↗</a>` : ''}
           </div>`}
      <h4>Incoming candidate data</h4>${linkRows(inbound, 'in')}
      <h4>Outgoing to targets</h4>${linkRows(outbound, 'out')}
      <h4>One bit away (${neigh.length})</h4>
      ${neigh.length
        ? `<div class="nv-neigh">${neigh.slice(0, 24).map(o =>
            `<button class="nv-chip" onclick="NetworkView.focus('${escAttr(o.key)}')"
                     title="${escAttr(o.name)}">${o.addr} <span>${esc(o.name)}</span></button>`).join('')}
           ${neigh.length > 24 ? `<p class="small" style="color:var(--muted)">…and ${neigh.length - 24} more</p>` : ''}</div>`
        : '<p class="small" style="color:var(--muted);margin:.2rem 0">No address in the file is one bit from this one.</p>'}`;
  }

  // Jump the graph to another node: select it, and make sure it is on screen by
  // searching for its address if the current view does not already hold it.
  function focus(key) {
    const g = buildGraph();
    const n = g.nodes.get(key);
    if (!n) return;
    const present = nv.vis && nv.vis.nodes.some(x => x.key === key);
    if (!present) {
      nv.search = String(n.addr);
      const box = document.getElementById('nv-search');
      if (box) box.value = nv.search;
      refresh(true);
    }
    select(key);
  }

  // One node → the Stations tab, focused on the station behind it. goToStation
  // already selects, scrolls and pans; there is no second way to do this and this
  // tab should not invent one.
  function showOnMap(key) {
    const g = buildGraph();
    const n = g.nodes.get(key);
    if (!n || !n.stationId) return;
    goToStation(n.stationId);
  }

  // The visible node set → the Stations map as a selection. state.mapSelection is
  // the mechanism the map already has for "these specific stations, whatever the
  // filters say", so the graph hands its answer to that rather than rewriting the
  // search box and hoping.
  function showAllOnMap() {
    const V = nv.vis || computeVisible();
    const ids = new Set();
    let unresolved = 0;
    for (const n of V.nodes) {
      if (n.stationId) ids.add(n.stationId); else unresolved++;
    }
    if (!ids.size) {
      note('Nothing in view resolves to a station in the loaded file.');
      return;
    }
    addToMapSelection([...ids]);
    switchTab('stations');
    // After the tab has rendered, so the note lands on the map that is now there.
    mapNote(`${ids.size} station${ids.size === 1 ? '' : 's'} from the network view selected`
      + (unresolved ? ` · ${unresolved} graph node${unresolved === 1 ? '' : 's'} had no match in this file` : '')
      + '.', 6000);
  }

  // ── import / export ───────────────────────────────────────────────────────────

  function parseCsv(text) {
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    const head = rows.shift();
    if (!head) return [];
    return rows.filter(r => r.some(Boolean))
      .map(r => Object.fromEntries(head.map((k, i) => [k.trim(), (r[i] || '').trim()])));
  }

  // CSV import is an *additional* source of confirmed relationships, not the only
  // one it used to be: the nodes come from stations.json now, so a dropped file
  // only has to say which addresses were observed ghosting into which.
  async function importFiles(files) {
    if (!files || !files.length) return;
    const added = [];
    let skipped = 0;
    for (const f of files) {
      try {
        const buf = await f.arrayBuffer();
        const u = new Uint8Array(buf);
        const enc = (u[0] === 255 && u[1] === 254) ? 'utf-16le' : 'utf-8';
        const rows = parseCsv(new TextDecoder(enc).decode(buf).replace(/^\uFEFF/, ''));
        if (!rows.length || !('source_sensor_id' in rows[0] || 'source_alert' in rows[0])) { skipped++; continue; }
        for (const r of rows) {
          const sa = parseInt(r.source_alert, 10), ta = parseInt(r.target_alert, 10);
          if (isNaN(sa) || isNaN(ta)) continue;
          added.push(normaliseLink({
            source: r.source_sensor_id, target: r.target_sensor_id,
            source_site: r.source_site_id, target_site: r.target_site_id,
            source_alert: sa, target_alert: ta,
            source_type: r.source_type, target_type: r.target_type,
            reciprocal: String(r.reciprocal).toLowerCase() === 'true',
            same_site:  String(r.same_site).toLowerCase() === 'true',
            evidence: (r.evidence_files || r.evidence || '').split(';').map(s => s.trim()).filter(Boolean),
            origin: f.name,
          }));
        }
        nv.confSources.push(`${rows.length} from ${f.name}`);
      } catch (_) { skipped++; }
    }
    if (!nv.confirmed) nv.confirmed = { sensors: [], links: [] };
    if (added.length) {
      nv.confirmed.links = nv.confirmed.links.concat(added);
      linkConfirmed();
    }
    note(added.length
      ? `Imported ${added.length} confirmed relationship${added.length === 1 ? '' : 's'}.`
      : `Nothing imported — a links CSV needs source_alert and target_alert columns.${skipped ? ` ${skipped} file(s) skipped.` : ''}`);
    renderFacets();
    refresh(true);
  }

  // The visible links, as the standalone build exported them, plus the two columns
  // that only exist now: whether the pair was computed, confirmed, or both.
  function exportVisible() {
    const V = nv.vis || computeVisible();
    if (!V.edges.length) { note('No links in view to export.'); return; }
    const cols = ['source_site', 'source_station', 'source_alert', 'source_type',
                  'target_site', 'target_station', 'target_alert', 'target_type',
                  'relationship', 'reciprocal', 'same_site', 'evidence_files'];
    const lines = [cols.join(',')];
    for (const e of V.edges) {
      const dir = e.dirs[0];
      const a = dir ? dir.from : e.a, b = dir ? dir.to : e.b;
      lines.push([
        a.number, a.name, a.addr, a.types[0] || '',
        b.number, b.name, b.addr, b.types[0] || '',
        e.confirmed && e.computed ? 'confirmed+computed' : e.confirmed ? 'confirmed' : 'computed',
        e.reciprocal, e.sameSite, e.evidence.join('; '),
      ].map(csvEscape).join(','));
    }
    dlText('meganet_ghosting_links.csv', lines.join('\n'));
  }

  // ── control handlers ──────────────────────────────────────────────────────────

  function note(msg) {
    const el = document.getElementById('nv-note');
    if (!el) return;
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  // `structure` says whether the visible set has to be rebuilt (a filter moved)
  // or only redrawn (a colour or a label toggle). Rebuilding re-runs the layout.
  function refresh(structure) {
    if (structure) {
      // A different set of nodes is a different picture, so the view goes back to
      // framing itself until the operator says otherwise again.
      nv.userMoved = false;
      computeVisible();
      draw();
      start(0.8);
    } else {
      draw();
    }
  }

  function onSearch(v) {
    nv.search = v;
    clearTimeout(onSearch._t);
    onSearch._t = setTimeout(() => refresh(true), 180);
  }

  function toggleFacet(key, value, on) {
    const off = nv.facetOff[key] || (nv.facetOff[key] = new Set());
    if (on) off.delete(value); else off.add(value);
    refresh(true);
  }

  function setColourBy(v) { nv.colourBy = v; renderLegend(); refresh(false); }
  function setLabels(on)  { nv.labels = !!on; const s = document.getElementById('nv-svg'); if (s) s.classList.toggle('nv-hide-labels', !nv.labels); }
  function setFlag(name, on) {
    nv[name] = !!on;
    refresh(true);
  }
  function setSpread(v) {
    const next = Math.max(55, Math.min(240, Number(v) || 105));
    const ratio = next / nv.spread;
    nv.spread = next;
    const el = document.getElementById('nv-spread-val');
    if (el) el.textContent = next + '%';
    const box = document.getElementById('nv-spread');
    if (box && Number(box.value) !== next) box.value = next;
    // Scale the current arrangement about the centre so the change reads as a
    // zoom of the layout rather than a re-scatter.
    for (const p of nv.pos.values()) {
      p.x = nv.w / 2 + (p.x - nv.w / 2) * ratio;
      p.y = nv.h / 2 + (p.y - nv.h / 2) * ratio;
    }
    if (nv.siteMode) siteLayout(); else start(0.6);
  }
  function nudgeSpread(delta) { setSpread(nv.spread + delta); }

  function toggleSiteMode() {
    nv.siteMode = !nv.siteMode;
    const b = document.getElementById('nv-site');
    if (b) b.textContent = 'Group by site: ' + (nv.siteMode ? 'On' : 'Off');
    if (nv.siteMode) siteLayout(); else start(0.9);
  }

  function reset() {
    nv.search = '';
    nv.facetOff = {};
    nv.showConfirmed = true;
    nv.showComputed = true;
    nv.expand = false;
    nv.reciprocalOnly = nv.sameSiteOnly = false;
    nv.labels = true;
    nv.siteMode = false;
    nv.spread = 105;
    nv.view = { scale: 1, tx: 0, ty: 0 };
    nv.userMoved = false;
    nv.pos.clear();
    nv.sel = null;
    renderMain();
  }

  function fit() {
    const V = nv.vis;
    if (!V || !V.nodes.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of V.nodes) {
      x0 = Math.min(x0, n.p.x); x1 = Math.max(x1, n.p.x);
      y0 = Math.min(y0, n.p.y); y1 = Math.max(y1, n.p.y);
    }
    const pad = 60;
    const s = Math.min(nv.w / Math.max(1, x1 - x0 + pad * 2), nv.h / Math.max(1, y1 - y0 + pad * 2), 2.5);
    nv.view.scale = s;
    nv.view.tx = nv.w / 2 - s * (x0 + x1) / 2;
    nv.view.ty = nv.h / 2 - s * (y0 + y1) / 2;
    nv.userMoved = false;    // asking to be framed is asking to keep being framed
    applyView();
  }

  // ── page ──────────────────────────────────────────────────────────────────────

  function statsHtml() {
    const g = buildGraph();
    const V = nv.vis;
    const conf = (nv.confirmed && nv.confirmed.resolved) ? nv.confirmed.resolved.length : 0;
    const cells = [
      ['Addresses', g.nodes.size],
      ['In view',   V ? V.nodes.length : 0],
      ['Links',     V ? V.edges.length : 0],
      ['Confirmed', conf],
    ];
    return cells.map(([k, v]) =>
      `<div class="nv-stat"><b>${v.toLocaleString()}</b><span>${k}</span></div>`).join('');
  }

  function renderLegend() {
    const el = document.getElementById('nv-legend');
    if (!el) return;
    const opts = facetOptions()[nv.colourBy] || [];
    el.innerHTML = opts.slice(0, 10).map(([v]) =>
      `<span><i class="nv-dot" style="background:${colourFor(v, nv.colourBy)}"></i>${esc(v)}</span>`).join('')
      + (opts.length > 10 ? `<span class="small" style="color:var(--muted)">+${opts.length - 10} more</span>` : '');
  }

  // The confirmed relationships arrive after the page is built, and they bring a
  // facet with them — cluster membership is a property of that file. Rebuilding
  // the panel is the only honest answer: a filter group that never appears
  // because its data was still in flight is a filter that silently does not exist.
  function renderFacets() {
    const el = document.getElementById('nv-facets');
    if (el) el.innerHTML = facetsHtml();
  }

  function facetsHtml() {
    const opts = facetOptions();
    return NV_FACETS.map(f => {
      const list = opts[f.key] || [];
      if (list.length < 2) return '';       // a facet with one value filters nothing
      const off = nv.facetOff[f.key] || new Set();
      const shown = list.slice(0, 12);
      return `
        <details class="nv-facet"${f.key === 'type' ? ' open' : ''}>
          <summary>${esc(f.label)} <span class="small">${list.length}</span></summary>
          ${shown.map(([v, n]) => `
            <label class="nv-check">
              <input type="checkbox" ${off.has(v) ? '' : 'checked'}
                     onchange="NetworkView.toggleFacet('${escAttr(f.key)}','${escAttr(v)}',this.checked)">
              <span>${esc(v)}</span><span class="small">${n}</span>
            </label>`).join('')}
          ${list.length > shown.length
            ? `<p class="small" style="color:var(--muted);margin:.3rem 0 0">
                 ${list.length - shown.length} rarer value${list.length - shown.length === 1 ? '' : 's'} not listed — use the search box.</p>`
            : ''}
        </details>`;
    }).join('');
  }

  // The line under the graph that says what is on screen and what was left off.
  function updateChrome() {
    const V = nv.vis;
    const el = document.getElementById('nv-visible');
    if (el && V) {
      const conf = V.edges.filter(e => e.confirmed).length;
      el.textContent = `${V.nodes.length} addresses · ${V.edges.length} links`
        + (conf ? ` · ${conf} confirmed` : '');
    }
    const cap = document.getElementById('nv-cap');
    if (cap && V) {
      const bits = [];
      // An empty stage needs to say why it is empty. Without a search the graph
      // starts from the confirmed relationships, so turning those off with nothing
      // typed leaves nothing to draw — which looks like a broken tab rather than
      // an answered question unless it says so.
      if (!V.nodes.length) {
        bits.push(searchTokens().length
          ? 'Nothing matches that search.'
          : nv.showConfirmed
            ? 'Nothing to draw. Search for a station or an ALERT address.'
            : 'Confirmed links are switched off, so there is no starting point — search for a station or an ALERT address, or switch them back on.');
      }
      if (V.capped) bits.push(`Showing the ${NV_MAX_NODES} best-connected of ${V.total.toLocaleString()} matching addresses — narrow the filters or search to see the rest.`);
      if (V.expandCapped) bits.push(`Neighbour expansion stopped at ${NV_EXPAND_MAX} addresses.`);
      if (V.unresolved) bits.push(V.unresolved === 1
        ? '1 node in view has no match in the loaded station file and cannot be mapped.'
        : `${V.unresolved} nodes in view have no match in the loaded station file and cannot be mapped.`);
      cap.innerHTML = bits.map(esc).join(' ');
      cap.hidden = !bits.length;
    }
    const st = document.getElementById('nv-stats');
    if (st) st.innerHTML = statsHtml();
    const src = document.getElementById('nv-source-note');
    if (src) {
      src.innerHTML = nv.confState === 'loading' ? 'Loading confirmed relationships…'
        : nv.confState === 'error' ? `Confirmed relationships unavailable (${esc(nv.confError)}) — computed links only.`
        : esc(nv.confSources.join(' · '));
    }
  }

  function render() {
    buildGraph();
    return `
      <div class="nv-layout">
        <aside class="nv-side stack">
          <div class="panel">
            <div class="panel-header"><h2>Network View</h2></div>
            <p class="small" style="color:var(--muted);margin:.4rem 0 0">
              ALERT addresses one bit apart, drawn as a graph. Grey-blue links are
              computed from the loaded file; solid arrows are relationships that were
              actually observed, candidate → target.
            </p>
            <div class="nv-stats" id="nv-stats">${statsHtml()}</div>
            <p class="small nv-src" id="nv-source-note"></p>
          </div>

          <div class="panel">
            <div class="panel-header"><h3>Find and focus</h3></div>
            <input id="nv-search" type="search" placeholder="Station, number or ALERT address"
                   value="${escAttr(nv.search)}" oninput="NetworkView.onSearch(this.value)">
            <p class="small" style="color:var(--muted);margin:.35rem 0 .5rem">
              Several addresses at once: paste them separated by spaces or commas.
            </p>
            <div class="button-row">
              <button onclick="NetworkView.fit()">Fit to view</button>
              <button onclick="NetworkView.reset()">Reset</button>
            </div>
          </div>

          <div class="panel">
            <div class="panel-header"><h3>Links</h3></div>
            <label class="nv-check"><input type="checkbox" ${nv.showConfirmed ? 'checked' : ''}
              onchange="NetworkView.setFlag('showConfirmed',this.checked)"><span>Confirmed (observed)</span></label>
            <label class="nv-check"><input type="checkbox" ${nv.showComputed ? 'checked' : ''}
              onchange="NetworkView.setFlag('showComputed',this.checked)"><span>Computed (one bit apart)</span></label>
            <label class="nv-check"><input type="checkbox" ${nv.expand ? 'checked' : ''}
              onchange="NetworkView.setFlag('expand',this.checked)"><span>Pull in bit-neighbours</span></label>
            <label class="nv-check"><input type="checkbox" ${nv.reciprocalOnly ? 'checked' : ''}
              onchange="NetworkView.setFlag('reciprocalOnly',this.checked)"><span>Reciprocal only</span></label>
            <label class="nv-check"><input type="checkbox" ${nv.sameSiteOnly ? 'checked' : ''}
              onchange="NetworkView.setFlag('sameSiteOnly',this.checked)"><span>Same-site only</span></label>
          </div>

          <div class="panel">
            <div class="panel-header"><h3>Filters</h3></div>
            <div id="nv-facets">${facetsHtml()}</div>
          </div>

          <div class="panel">
            <div class="panel-header"><h3>Layout</h3></div>
            <label class="small" style="color:var(--muted)">Colour by
              <select id="nv-colour" onchange="NetworkView.setColourBy(this.value)" style="margin-top:.3rem">
                ${NV_FACETS.map(f => `<option value="${escAttr(f.key)}" ${nv.colourBy === f.key ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}
              </select>
            </label>
            <div class="nv-legend" id="nv-legend"></div>
            <div class="nv-range">
              <input id="nv-spread" type="range" min="55" max="240" value="${nv.spread}"
                     oninput="NetworkView.setSpread(this.value)" aria-label="Spread">
              <span class="nv-val" id="nv-spread-val">${nv.spread}%</span>
            </div>
            <div class="button-row">
              <button onclick="NetworkView.nudgeSpread(25)">Spread out</button>
              <button onclick="NetworkView.nudgeSpread(-25)">Tighten</button>
            </div>
            <button id="nv-site" onclick="NetworkView.toggleSiteMode()">Group by site: ${nv.siteMode ? 'On' : 'Off'}</button>
            <label class="nv-check"><input type="checkbox" ${nv.labels ? 'checked' : ''}
              onchange="NetworkView.setLabels(this.checked)"><span>Show labels</span></label>
          </div>

          <div class="panel">
            <div class="panel-header"><h3>To the map, and out</h3></div>
            <button class="primary" onclick="NetworkView.showAllOnMap()">Show these on the map</button>
            <p class="small" style="color:var(--muted);margin:.35rem 0 .6rem">
              Hands every address in view to the Stations map as a selection.
            </p>
            <button onclick="NetworkView.exportVisible()">Export visible links</button>
          </div>

          <div class="panel">
            <div class="panel-header"><h3>Import confirmed links</h3></div>
            <div class="nv-drop" id="nv-drop">Drop a links CSV here</div>
            <input id="nv-file" type="file" accept=".csv" multiple hidden
                   onchange="NetworkView.importFiles(this.files)">
            <button onclick="document.getElementById('nv-file').click()">Open CSV file(s)</button>
            <p class="small" style="color:var(--muted);margin:.35rem 0 0">
              Needs <code>source_alert</code> and <code>target_alert</code>; <code>evidence_files</code>,
              <code>reciprocal</code> and <code>same_site</code> are used when present. Station names and
              sensor types come from the loaded file, not the CSV.
            </p>
            <p class="small" id="nv-note" hidden></p>
          </div>
        </aside>

        <div class="panel nv-stage" id="nv-stage">
          <div class="nv-top">
            <span class="nv-pill" id="nv-visible"></span>
            <span class="nv-pill nv-pill--quiet">Arrows point candidate → target</span>
          </div>
          <svg id="nv-svg" role="img" aria-label="Ghosting relationship graph">
            <defs>
              <marker id="nv-arrow" viewBox="0 -5 10 10" refX="4" markerWidth="5" markerHeight="5" orient="auto">
                <path d="M0,-5L10,0L0,5" class="nv-arrowhead"/>
              </marker>
            </defs>
            <g id="nv-world">
              <g id="nv-edges"></g>
              <g id="nv-confirmed"></g>
              <g id="nv-nodes"></g>
            </g>
          </svg>
          <div class="nv-tip" id="nv-tip" hidden></div>
          <aside class="nv-detail" id="nv-detail" hidden></aside>
          <p class="nv-cap small" id="nv-cap" hidden></p>
        </div>
      </div>`;
  }

  function measure() {
    const stage = document.getElementById('nv-stage');
    const svg   = document.getElementById('nv-svg');
    if (!stage || !svg) return false;
    const r = stage.getBoundingClientRect();
    const w = Math.max(320, Math.round(r.width));
    const h = Math.max(280, Math.round(r.height));
    const same = (w === nv.w && h === nv.h);
    nv.w = w; nv.h = h;
    // The attribute is written even when the size has not moved, because a
    // re-render hands back a brand new <svg> that has never had one. Only the
    // return value is conditional — that is what decides whether the layout needs
    // re-energising, and an unchanged stage does not.
    // The world is drawn in the same units as the pixels it covers, so a resize
    // is a bigger window onto the same graph rather than a rescale of it. The
    // standalone build's fixed 1400×900 viewBox stretched everything the moment
    // the nav collapsed.
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    return !same;
  }

  function init() {
    stop();
    if (!state.data) return;
    ensureConfirmed();
    measure();
    computeVisible();
    draw();
    renderLegend();
    stageBind();
    dropBind();
    fit();
    start(1);

    // The stage changes width when the nav collapses and height when the header
    // wraps. Re-measuring keeps the graph's coordinate space honest; the layout
    // is only re-centred, never re-scattered.
    if (nv.ro) nv.ro.disconnect();
    if (typeof ResizeObserver !== 'undefined') {
      nv.ro = new ResizeObserver(() => {
        if (!measure()) return;
        // A resize that crosses a label-budget boundary changes which nodes are
        // named, and that needs the graph rebuilt rather than just re-framed.
        // Every other resize is a new window onto the same picture, so it only
        // re-energises the layout enough to settle into the new shape.
        if (nv.vis && nv.vis.budget !== labelBudget()) refresh(true);
        else start(0.3);
      });
      const stage = document.getElementById('nv-stage');
      if (stage) nv.ro.observe(stage);
    }
  }

  function dropBind() {
    const drop = document.getElementById('nv-drop');
    if (!drop) return;
    for (const ev of ['dragover', 'dragenter']) {
      drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('nv-drop--active'); });
    }
    for (const ev of ['dragleave', 'drop']) {
      drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('nv-drop--active'); });
    }
    drop.addEventListener('drop', e => importFiles(e.dataTransfer && e.dataTransfer.files));
  }

  return {
    render, init, stop, invalidate,
    onSearch, toggleFacet, setColourBy, setLabels, setFlag, setSpread, nudgeSpread,
    toggleSiteMode, reset, fit, select, focus, showOnMap, showAllOnMap,
    importFiles, exportVisible,
  };
})();

// ── ARRO LAUNCHER tab ──────────────────────────────────────────────────────────
// A jump box for ARRO's administration pages. The standalone launcher this
// replaces could only take an id you already knew; the whole reason to bring it
// in-app is the station search — `site.db_id` is an arbitrary database index and
// nobody carries 2,784 of them in their head, but everybody knows the station by
// name, by number or by one of its ALERT addresses.

const ARRO_RECENT_KEY = 'mn-arro-recent';
const ARRO_RECENT_MAX = 12;
const ARRO_RESULT_MAX = 40;   // station search results shown before "narrow it down"

function arroRecents() {
  try {
    const v = JSON.parse(localStorage.getItem(ARRO_RECENT_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch (_) { return []; }
}

// Most recent first, deduped on the (site, device) pair the entry actually opens
// so re-opening the same page reorders rather than accumulates.
function arroSaveRecent(site, device, label) {
  const key  = `${site}|${device || ''}`;
  const list = arroRecents().filter(r => `${r.site}|${r.device || ''}` !== key);
  list.unshift({ site, device: device || '', label: label || '', ts: Date.now() });
  try { localStorage.setItem(ARRO_RECENT_KEY, JSON.stringify(list.slice(0, ARRO_RECENT_MAX))); }
  catch (_) { /* private mode, or the quota — recents are a convenience, not state */ }
}

function arroClearRecents() {
  try { localStorage.removeItem(ARRO_RECENT_KEY); } catch (_) {}
  rerenderArroRecents();
}

// Pull the ids out of whatever was pasted. Handles a full ARRO URL of either
// shape, the `devices[]=site|device` pair the graph pages use, and a bare id.
// Returns { site, device } with either field null when it isn't there.
function arroParseIds(text) {
  const raw = String(text || '').trim();
  if (!raw) return { site: null, device: null };

  const num = s => (s != null && /^\d+$/.test(String(s).trim()) ? String(s).trim() : null);

  // `site_id=…` / `device_id=…`, whether or not the rest parses as a URL.
  const site   = num((raw.match(/[?&]site_id=(\d+)/i)   || [])[1]);
  const device = num((raw.match(/[?&]device_id=(\d+)/i) || [])[1]);
  if (site) return { site, device };

  // Graph form: devices[]=3318|2 (URL-encoded or not).
  const pair = raw.match(/devices(?:\[\]|%5B%5D)=(\d+)(?:\||%7C)(\d+)/i);
  if (pair) return { site: pair[1], device: pair[2] };

  // Bare "3318|2", or a lone id.
  const bare = raw.match(/^(\d+)\s*[|/,\s]\s*(\d+)$/);
  if (bare) return { site: bare[1], device: bare[2] };
  return { site: num(raw), device: device };
}

// Stations matching the search box, resolved to their ARRO site id. Stations
// with no db_id are still listed — saying "this one has no ARRO record" is more
// use than silently dropping it and leaving the operator to wonder.
function arroSearchResults() {
  if (!state.data) return [];
  const text = state.arro.search.trim();
  if (!text) return [];
  const prep = prepareSearch(text);
  if (!prep.terms.length) return [];
  const out = [];
  for (const s of state.data.stations) {
    if (!stationMatchesSearch(s, prep)) continue;
    out.push(s);
    if (out.length > ARRO_RESULT_MAX) break;
  }
  return out;
}

function renderArroHtml() {
  const a = state.arro;
  return `
    <div style="max-width:1000px;margin:auto;padding:1rem;display:grid;gap:1rem">
      <div class="panel">
        <div class="panel-header"><h2>ARRO Launcher</h2></div>
        <p class="small" style="color:var(--muted);margin:.5rem 0 0">
          Opens ARRO's <strong>administration</strong> pages. Find the station by name, number or
          ALERT address and the site id is filled in for you — or paste an ARRO URL and the ids are
          read out of it. Everything opens in a new tab.
        </p>
        <p class="small" style="color:var(--muted);margin:.35rem 0 0">
          Host: <code>${esc(arroHost())}</code> — set by the ARRO base URL on the Bit Flipper tab.
        </p>
      </div>

      <div class="panel">
        <div class="panel-header"><h3>Find a station</h3></div>
        ${state.data ? `
          <input type="search" id="arro-search" value="${esc(a.search)}"
                 placeholder="Station name, station number or ALERT address — e.g. Loudoun, 541155, 6128"
                 style="margin-top:.6rem" oninput="onArroSearch(this.value)">
          <div id="arro-results" style="margin-top:.6rem">${arroResultsHtml()}</div>
        ` : `
          <p class="small" style="color:var(--muted);margin:.6rem 0 0">
            No <strong>stations.json</strong> loaded, so there is nothing to search. The raw id box
            below still works — load a file to look site ids up by name instead.
          </p>`}
      </div>

      <div class="panel">
        <div class="panel-header"><h3>Open by id</h3></div>
        <div style="display:flex;flex-wrap:wrap;gap:.75rem;align-items:flex-end;margin-top:.6rem">
          <label style="font-size:.9rem;color:var(--muted);flex:0 0 12rem">
            ARRO site id
            <input type="text" id="arro-site" value="${esc(a.siteId)}" placeholder="e.g. 3318"
                   style="margin-top:.3rem" oninput="onArroIdInput('siteId',this.value)"
                   onkeydown="onArroKey(event)">
          </label>
          <label style="font-size:.9rem;color:var(--muted);flex:0 0 12rem">
            Device id <span style="font-weight:400">(optional)</span>
            <input type="text" id="arro-device" value="${esc(a.deviceId)}" placeholder="e.g. 2"
                   style="margin-top:.3rem" oninput="onArroIdInput('deviceId',this.value)"
                   onkeydown="onArroKey(event)">
          </label>
          <label style="font-size:.9rem;color:var(--muted);flex:1 1 18rem;min-width:14rem">
            …or paste an ARRO URL
            <input type="text" id="arro-paste" placeholder="https://…/administration/site/details/?site_id=3318"
                   style="margin-top:.3rem" oninput="onArroPaste(this.value)"
                   onkeydown="onArroKey(event)">
          </label>
        </div>
        <div id="arro-actions" style="margin-top:.75rem">${arroActionsHtml()}</div>
      </div>

      <div class="panel">
        <div class="panel-header">
          <h3>Recent</h3>
          <button onclick="arroClearRecents()" style="padding:.25rem .5rem;font-size:.8rem">Clear</button>
        </div>
        <div id="arro-recents" style="margin-top:.6rem">${arroRecentsHtml()}</div>
      </div>
    </div>`;
}

// The action row: what the ids currently in the boxes would open.
function arroActionsHtml() {
  const a       = state.arro;
  const site    = a.siteId.trim();
  const device  = a.deviceId.trim();
  const siteUrl = /^\d+$/.test(site) ? arroSiteUrl(site) : null;
  const devUrl  = /^\d+$/.test(device) ? arroSensorUrl(site, device) : null;

  if (!siteUrl) {
    return `<p class="small" style="color:var(--muted);margin:0">
      Enter a numeric site id — or pick a station above — to open its ARRO pages.
      ${a.note ? `<br>${esc(a.note)}` : ''}</p>`;
  }
  return `
    <div style="display:flex;flex-wrap:wrap;gap:.5rem;align-items:center">
      <a class="btn-link" href="${esc(siteUrl)}" target="_blank" rel="noopener"
         onclick="arroRemember()">Open site admin ↗</a>
      ${devUrl
        ? `<a class="btn-link" href="${esc(devUrl)}" target="_blank" rel="noopener"
             onclick="arroRemember()">Open sensor admin ↗</a>`
        : `<span class="btn-link disabled" title="Add a device id to open a sensor page">Open sensor admin ↗</span>`}
      <span class="small" style="color:var(--muted)">
        site <code>${esc(site)}</code>${device ? ` · device <code>${esc(device)}</code>` : ''}
        ${a.note ? ` · ${esc(a.note)}` : ''}
        · press <kbd>Enter</kbd> in any box above
      </span>
    </div>`;
}

function arroResultsHtml() {
  if (!state.data) return '';
  const text = state.arro.search.trim();
  if (!text) {
    return `<p class="small" style="color:var(--muted);margin:0">
      Type to search ${state.data.stations.length.toLocaleString()} stations.</p>`;
  }
  const hits = arroSearchResults();
  if (!hits.length) {
    return `<p class="small" style="color:var(--muted);margin:0">No station matches that.</p>`;
  }
  const more  = hits.length > ARRO_RESULT_MAX;
  const shown = more ? hits.slice(0, ARRO_RESULT_MAX) : hits;
  return `
    <div class="table-wrap" style="max-height:320px">
      <table>
        <thead><tr>
          <th style="width:40%">Station</th><th style="width:13%">Stn #</th>
          <th style="width:16%">ARRO site id</th><th style="width:11%">Sensors</th>
          <th style="width:20%"></th>
        </tr></thead>
        <tbody>
          ${shown.map(s => {
            const dbId = arroSiteId(s);
            const url  = arroSiteUrl(dbId);
            const devs = stationSensors(s).filter(se => se.device_id != null).length;
            return `
              <tr>
                <td>${esc(s.name)}</td>
                <td class="small">${esc(s.station_number || '—')}</td>
                <td class="small">${dbId == null
                  ? `<span style="color:var(--muted)">none recorded</span>`
                  : `<code>${esc(dbId)}</code>`}</td>
                <td class="small">${devs || '—'}</td>
                <td class="small" style="white-space:nowrap">${dbId == null ? '' : `
                  <button onclick="arroPickStation('${escAttr(s.id)}')"
                          style="padding:.2rem .5rem;font-size:.8rem">Use</button>
                  <a href="${esc(url)}" target="_blank" rel="noopener"
                     onclick="arroRememberStation('${escAttr(s.id)}')">admin ↗</a>`}</td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    ${more ? `<p class="small" style="color:var(--muted);margin:.4rem 0 0">
      Showing the first ${ARRO_RESULT_MAX} — narrow the search to see the rest.</p>` : ''}`;
}

function arroRecentsHtml() {
  const list = arroRecents();
  if (!list.length) {
    return `<p class="small" style="color:var(--muted);margin:0">
      Nothing yet. Pages you open from here are listed for next time.</p>`;
  }
  return `
    <div style="display:grid;gap:.3rem">
      ${list.map(r => {
        const url = r.device ? arroSensorUrl(r.site, r.device) : arroSiteUrl(r.site);
        return `
          <div style="display:flex;gap:.5rem;align-items:baseline;flex-wrap:wrap">
            <a href="${esc(url)}" target="_blank" rel="noopener" style="font-weight:600">
              ${esc(r.label || `Site ${r.site}`)}</a>
            <span class="small" style="color:var(--muted)">
              site <code>${esc(r.site)}</code>${r.device ? ` · device <code>${esc(r.device)}</code>` : ''}
              · ${esc(r.device ? 'sensor admin' : 'site admin')}</span>
            <button onclick="arroUseRecent('${escAttr(r.site)}','${escAttr(r.device || '')}')"
                    style="padding:.1rem .45rem;font-size:.78rem">Use</button>
          </div>`;
      }).join('')}
    </div>`;
}

function initArro() {
  const el = document.getElementById(state.data ? 'arro-search' : 'arro-site');
  if (el) el.focus();
}

function rerenderArroResults() {
  const el = document.getElementById('arro-results');
  if (el) el.innerHTML = arroResultsHtml();
}

function rerenderArroActions() {
  const el = document.getElementById('arro-actions');
  if (el) el.innerHTML = arroActionsHtml();
}

function rerenderArroRecents() {
  const el = document.getElementById('arro-recents');
  if (el) el.innerHTML = arroRecentsHtml();
}

function onArroSearch(v) {
  state.arro.search = v;
  rerenderArroResults();
}

function onArroIdInput(field, v) {
  state.arro[field] = v;
  state.arro.note = '';
  rerenderArroActions();
}

// Pasting a URL fills the id boxes rather than navigating: the ids are the thing
// worth keeping, and seeing them land is what tells you the paste was understood.
function onArroPaste(v) {
  if (!v.trim()) return;
  const { site, device } = arroParseIds(v);
  if (!site && !device) { state.arro.note = 'No site id found in that.'; rerenderArroActions(); return; }
  if (site)   state.arro.siteId   = site;
  if (device) state.arro.deviceId = device;
  state.arro.note = 'read from the pasted URL';
  const siteEl = document.getElementById('arro-site');
  const devEl  = document.getElementById('arro-device');
  if (siteEl) siteEl.value = state.arro.siteId;
  if (devEl)  devEl.value  = state.arro.deviceId;
  rerenderArroActions();
}

// Enter opens the most specific page the boxes describe — the sensor if a device
// id is there, the site otherwise.
function onArroKey(ev) {
  if (ev.key !== 'Enter') return;
  ev.preventDefault();
  const site   = state.arro.siteId.trim();
  const device = state.arro.deviceId.trim();
  if (!/^\d+$/.test(site)) return;
  const url = /^\d+$/.test(device) ? arroSensorUrl(site, device) : arroSiteUrl(site);
  arroRemember();
  window.open(url, '_blank', 'noopener');
}

// Record whatever the boxes currently point at. Called from the anchors' onclick
// as well as from Enter, so a middle-click that never fires it simply isn't
// remembered — better than remembering a page that was never opened.
function arroRemember() {
  const site   = state.arro.siteId.trim();
  const device = state.arro.deviceId.trim();
  if (!/^\d+$/.test(site)) return;
  arroSaveRecent(site, /^\d+$/.test(device) ? device : '', arroLabelForSite(site));
  rerenderArroRecents();
}

// The station name behind a site id, when we happen to know it, so the recents
// list reads as stations rather than as a column of database keys.
function arroLabelForSite(site) {
  if (!state.data) return '';
  const n = parseInt(site, 10);
  const s = state.data.stations.find(x => arroSiteId(x) === n);
  return s ? s.name : '';
}

function arroPickStation(id) {
  const s = state.data && state.data.stations.find(x => x.id === id);
  if (!s) return;
  const dbId = arroSiteId(s);
  if (dbId == null) return;
  state.arro.siteId   = String(dbId);
  state.arro.deviceId = '';
  state.arro.note     = s.name;
  const siteEl = document.getElementById('arro-site');
  const devEl  = document.getElementById('arro-device');
  if (siteEl) siteEl.value = state.arro.siteId;
  if (devEl)  devEl.value  = '';
  rerenderArroActions();
  document.getElementById('arro-actions')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function arroRememberStation(id) {
  const s = state.data && state.data.stations.find(x => x.id === id);
  const dbId = s && arroSiteId(s);
  if (dbId == null) return;
  arroSaveRecent(String(dbId), '', s.name);
  rerenderArroRecents();
}

function arroUseRecent(site, device) {
  state.arro.siteId   = String(site || '');
  state.arro.deviceId = String(device || '');
  state.arro.note     = arroLabelForSite(site);
  const siteEl = document.getElementById('arro-site');
  const devEl  = document.getElementById('arro-device');
  if (siteEl) siteEl.value = state.arro.siteId;
  if (devEl)  devEl.value  = state.arro.deviceId;
  rerenderArroActions();
}

// ── ARRO DATA tab (CSV import, 357 filter, plotting) ───────────────────────────
// ARRO exports one CSV per sensor. This tab reads them in the browser — nothing
// is uploaded — links each file back to the station that produced it, runs the
// Bureau's 3-5-7 continuity filter over it, and draws the result.
//
// The whole point is *seeing what the filter removed*, so raw and filtered are
// kept as two views of one immutable import: the parsed arrays are never
// written to after import, and filtering only ever produces a parallel status
// array. A filter you cannot inspect is worse than no filter.
//
// Reference: "Hydrology Raw Data Filtering Program Specification" v2.1,
// Commonwealth Bureau of Meteorology, May 2009 (and the 1998 first edition).

const AD_COLORS = ['#0b5cab', '#c7401a', '#107c10', '#7c35a3',
                   '#b8860b', '#00838f', '#ad1457', '#5d4037',
                   '#3949ab', '#ef6c00', '#2e7d32', '#6a1b9a'];

// Point status. Ordered so that "kept" is < BAD and the drawing code can test
// with a single comparison. RANGE and RATE are removals by the two limit
// filters, which run before the 357 walk and are not part of the spec — they
// are kept distinct from BAD so a rejected reading can always say which filter
// rejected it.
const AD_UNKNOWN = 0, AD_GOOD = 1, AD_SUSPECT = 2, AD_BAD = 3, AD_OOS = 4,
      AD_RANGE = 5, AD_RATE = 6;

const AD_STATUS_LABEL = {
  [AD_UNKNOWN]: 'untested',
  [AD_GOOD]:    'good',
  [AD_SUSPECT]: 'suspect',
  [AD_BAD]:     'bad',
  [AD_OOS]:     'out of sequence',
  [AD_RANGE]:   'out of range',
  [AD_RATE]:    'rose too fast',
};

// Every status that means "this reading is not in the filtered series".
const adCut = st => st === AD_BAD || st === AD_OOS || st === AD_RANGE || st === AD_RATE;

// Spec defaults, all overridable from the panel — the ticket asks for the steps,
// the rollover ceiling and the continuity break to be configurable.
//
// Each filter also carries its own on/off flag, so any of them can be taken out
// of the pipeline and the effect seen immediately. The 357 test is one of them:
// `use357` off leaves the pre-filters running and nothing tested for continuity,
// which is the honest way to ask "how much of this is the 357 test's doing?"
const AD_CFG_DEFAULT = {
  use357:     true,   // the 3-5-7 continuity walk itself
  small:      3,      // <= 3 against the next data
  medium:     5,      // <= 5 against the next-next
  large:      7,      // <= 7 against the next-next-next
  cycle:      2048,   // accumulator counts 0..2047, so it wraps at 2048
  breakCount: 4,      // four consecutive failures break continuity
  startTests: 4,      // start-continuity test budget (spec flowchart: testCount > 4)
  rolloverOn: true,
  oosOn:      true,   // drop out-of-sequence / duplicate timestamps
  dedupeOn:   true,
  minGapSec:  0,      // collapse readings closer together than this (0 = off)
  rateOn:     false,  // rate-of-rise limit
  rateMax:    50,     // fastest believable rise, in Value units per hour
  rangeOn:    false,  // minimum / maximum limits
  rangeMin:   '',     // blank = no floor
  rangeMax:   '',     // blank = no ceiling
};

const AD_DAY = 86400000;

// ── module ──

const ArroData = (function () {

  const ad = {
    series:    [],
    seq:       0,
    cfg:       { ...AD_CFG_DEFAULT },
    view:      null,           // {t0,t1} visible window, ms; null = full extent
    mode:      'both',         // raw | filtered | both
    transform: 'value',        // value | increment | rate
    chartType: 'line',
    yMode:     'auto',         // auto | zero | manual
    yMin:      '', yMax: '',
    showRemoved:  true,
    showRollover: true,
    compare:      false,       // side-by-side raw/filtered panes, folded away
    showPoints:   'auto',      // auto | on | off
    normalise:    false,
    hover:     null,           // {x,y,t,rows:[]}
    pin:       null,           // clicked point: {key,i}
    drag:      null,
    brush:     false,          // brush-to-zoom armed (else drag pans)
    ovDrag:    null,
    w: 900, h: 380,
    ro:        null,
    sensorIdx: null,
    sensorIdxFor: null,
    busy:      0,
  };

  // ── CSV parsing ────────────────────────────────────────────────────────────

  // Splits one CSV line, honouring quotes. ARRO does not quote anything, but a
  // hand-edited file might, and mis-parsing a quoted field is silent corruption.
  function splitLine(line) {
    if (line.indexOf('"') < 0) return line.split(',');
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',')  { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  }

  // ARRO writes thousands separators into Value without quoting them, so
  // `1,613.0` arrives as two fields and the row is one wider than the header.
  // The columns either side of Value are fixed-width, so the surplus can only
  // belong to Value: anchor the head and the tail, and glue the middle back
  // together. 395 of the 14,942 rows in the sample export need this.
  function reconcile(fields, nHead, valueIdx) {
    if (fields.length === nHead) return fields;
    if (fields.length < nHead || valueIdx < 0) return null;
    const tail = nHead - valueIdx - 1;
    const glued = fields.slice(valueIdx, fields.length - tail).join('').replace(/,/g, '');
    return [...fields.slice(0, valueIdx), glued, ...fields.slice(fields.length - tail)];
  }

  // "2026-08-07 15:38:13" — ARRO exports station local time with no zone, and
  // reads it back the same way, so it is parsed as local rather than shifted
  // into UTC. Also accepts ISO with a T, and dd/mm/yyyy.
  function parseTs(s) {
    s = (s || '').trim();
    if (!s) return NaN;
    let m = s.match(/^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)(?::(\d\d))?/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
    m = s.match(/^(\d\d?)\/(\d\d?)\/(\d{4})[ T](\d\d):(\d\d)(?::(\d\d))?/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)).getTime();
    const t = Date.parse(s);
    return isNaN(t) ? NaN : t;
  }

  function parseCsv(text) {
    const warn = [];
    const lines = text.split(/\r?\n/);
    let h = 0;
    while (h < lines.length && !lines[h].trim()) h++;
    if (h >= lines.length) return { error: 'The file is empty.' };

    const head  = splitLine(lines[h]).map(s => s.trim().toLowerCase().replace(/^﻿/, ''));
    const col   = name => head.findIndex(c => c === name);
    const iRead = col('reading'), iVal = col('value');
    if (iRead < 0 || iVal < 0) {
      return { error: 'Not an ARRO sensor export — expected "Reading" and "Value" columns, '
                    + `got: ${head.join(', ') || '(no header)'}` };
    }
    const iRecv = col('receive'), iUnit = col('unit');
    const iQual = col('data quality'), iRaw = col('raw value');

    const n0 = lines.length - h - 1;
    const t = new Float64Array(n0), tr = new Float64Array(n0);
    const v = new Float64Array(n0), raw = new Float64Array(n0);
    const q = new Uint8Array(n0);
    const qcodes = [], qmap = new Map();
    const units = new Map();
    let n = 0, skipped = 0, ragged = 0;

    for (let li = h + 1; li < lines.length; li++) {
      const line = lines[li];
      if (!line.trim()) continue;
      let f = splitLine(line);
      if (f.length !== head.length) {
        const fixed = reconcile(f, head.length, iVal);
        if (!fixed) { skipped++; continue; }
        ragged++; f = fixed;
      }
      const ts = parseTs(f[iRead]);
      const val = parseFloat(f[iVal]);
      if (isNaN(ts) || isNaN(val)) { skipped++; continue; }

      t[n]  = ts;
      tr[n] = iRecv >= 0 ? (parseTs(f[iRecv]) || ts) : ts;
      v[n]  = val;
      raw[n] = iRaw >= 0 ? (parseFloat(String(f[iRaw]).replace(/,/g, '')) ?? val) : val;
      if (isNaN(raw[n])) raw[n] = val;

      const code = iQual >= 0 ? (f[iQual] || '').trim() : '';
      let qi = qmap.get(code);
      if (qi === undefined) { qi = qcodes.length; qcodes.push(code); qmap.set(code, qi); }
      q[n] = qi;

      if (iUnit >= 0) {
        const u = (f[iUnit] || '').trim();
        if (u) units.set(u, (units.get(u) || 0) + 1);
      }
      n++;
    }

    if (!n) return { error: 'No readable rows — every line failed to parse.' };
    if (ragged)  warn.push(`${ragged} row${ragged === 1 ? '' : 's'} carried an unquoted thousands separator in Value and were re-joined.`);
    if (skipped) warn.push(`${skipped} row${skipped === 1 ? '' : 's'} could not be parsed and were dropped.`);

    // Ascending in time, latest last — the 357 algorithm depends on it, and
    // ARRO exports newest-first. A stable sort keeps same-timestamp rows in
    // file order so the duplicate that survives de-duplication is predictable.
    const ord = Array.from({ length: n }, (_, i) => i)
      .sort((a, b) => t[a] - t[b] || a - b);
    const desc = n > 1 && t[ord[0]] !== t[0];

    const T = new Float64Array(n), TR = new Float64Array(n);
    const V = new Float64Array(n), RAW = new Float64Array(n), Q = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const j = ord[i];
      T[i] = t[j]; TR[i] = tr[j]; V[i] = v[j]; RAW[i] = raw[j]; Q[i] = q[j];
    }

    let unit = '';
    let best = 0;
    for (const [u, c] of units) if (c > best) { best = c; unit = u; }

    return { n, t: T, tr: TR, v: V, raw: RAW, q: Q, qcodes, unit, warn, desc, hasRaw: iRaw >= 0 };
  }

  // ── filename → sensor id → station ─────────────────────────────────────────

  // `aem_Durikai_AL_541134_Rainfall_541134_0_R_5758.csv`
  //  └ prefix └ site name  └ number └ sensor  └── sensor id, dots as underscores
  //
  // The tail is the thing worth having: `541134_0_R_5758` is `541134.0.R.5758`,
  // which is exactly the `sensor_id` already carried in stations.json. Parse it
  // and the station is known without anyone choosing it from a list.
  function parseName(fileName) {
    const base = fileName.replace(/\.csv$/i, '');
    const out = { fileName, siteName: '', siteNumber: '', sensorLabel: '', sensorId: null };

    const m = base.match(/^(.*?)_(\d+)_(\d+)_([A-Za-z]+)_(\d+)$/);
    if (m) {
      out.sensorId = `${m[2]}.${m[3]}.${m[4].toUpperCase()}.${m[5]}`;
      let headPart = m[1];
      const m2 = headPart.match(/^(.*)_(\d+)_([^_]+)$/);
      if (m2) { headPart = m2[1]; out.siteNumber = m2[2]; out.sensorLabel = m2[3].replace(/_/g, ' '); }
      out.siteName = headPart.replace(/^aem_/i, '').replace(/_/g, ' ').trim();
    } else {
      out.siteName = base.replace(/^aem_/i, '').replace(/_/g, ' ').trim();
    }
    return out;
  }

  // sensor_id → {station, sensor}, rebuilt whenever a different station file is
  // loaded. 3,174 stations is a linear scan worth doing once, not per import.
  function sensorIndex() {
    if (ad.sensorIdx && ad.sensorIdxFor === state.data) return ad.sensorIdx;
    const idx = new Map();
    for (const s of (state.data?.stations || [])) {
      for (const sen of (s.sensors || [])) {
        if (sen.sensor_id && !idx.has(sen.sensor_id)) idx.set(sen.sensor_id, { station: s, sensor: sen });
      }
    }
    ad.sensorIdx = idx;
    ad.sensorIdxFor = state.data;
    return idx;
  }

  function linkStation(meta) {
    if (!state.data) return { station: null, sensor: null, how: 'no station file loaded' };
    if (meta.sensorId) {
      const hit = sensorIndex().get(meta.sensorId);
      if (hit) return { ...hit, how: 'sensor id' };
    }
    const num = meta.siteNumber || (meta.sensorId || '').split('.')[0];
    if (num) {
      const st = state.data.stations.find(s => String(s.station_number) === String(num)
                                            || String(s.site?.number) === String(num));
      if (st) {
        const sen = (st.sensors || []).find(x => x.sensor_id === meta.sensorId)
                 || (st.sensors || []).find(x => (x.type || '').toLowerCase() === (meta.sensorLabel || '').toLowerCase());
        return { station: st, sensor: sen || null, how: 'station number' };
      }
    }
    return { station: null, sensor: null, how: 'no match' };
  }

  // RainAccum and WaterLevel differ only in how diff() compares two readings, so
  // the guess only has to pick between two rules — and the series list lets it
  // be corrected when the guess is wrong.
  function guessKind(meta, sensor) {
    const s = `${sensor?.type || ''} ${meta.sensorLabel || ''}`.toLowerCase();
    if (/rain|precip|accum/.test(s)) return 'RA';
    if (/level|height|stage|water|depth/.test(s)) return 'WL';
    return 'RA';
  }

  // ── the 3-5-7 filter ───────────────────────────────────────────────────────
  // Faithful to the spec's two components. Nothing here writes to the imported
  // arrays: the result is a parallel status array plus the rollover-adjusted
  // values, so raw and filtered stay side by side for as long as the import
  // lives.

  function cfgKey(cfg, kind) {
    return [kind, cfg.use357 ? 1 : 0, cfg.small, cfg.medium, cfg.large, cfg.cycle, cfg.breakCount,
            cfg.startTests, cfg.rolloverOn ? 1 : 0, cfg.oosOn ? 1 : 0, cfg.dedupeOn ? 1 : 0,
            cfg.minGapSec, cfg.rateOn ? 1 : 0, cfg.rateMax,
            cfg.rangeOn ? 1 : 0, cfg.rangeMin, cfg.rangeMax].join('|');
  }

  // A blank limit means "no limit". Parsed here rather than at the input, so a
  // range with only one end filled in still works.
  const bound = x => { const f = parseFloat(x); return isFinite(f) ? f : null; };

  // The 357 walk itself, over the `live` positions of one series against one
  // set of values. Returns a fresh status array; it reads `adj` and writes
  // nothing else, so it can be run twice with different rollover offsets.
  function walk357(live, adj, n, isRA, cfg) {
    const status = new Uint8Array(n);          // AD_UNKNOWN everywhere

    // diff() — "calculate different value of the two data according to data
    // type". `a` is the earlier reading (current), `b` the later one (next).
    // A rain accumulator only ever climbs, so its difference is signed and a
    // fall is a failure by construction; a water level may move either way.
    const diff = (a, b) => isRA ? (adj[live[b]] - adj[live[a]]) : Math.abs(adj[live[b]] - adj[live[a]]);
    const verify = (d, step) => isRA ? (d >= 0 && d <= step) : (d <= step);

    // Cursors walk `live` positions, skipping anything already marked Bad —
    // getPreviousCursor()/getNextCursor() in the spec.
    const prevCur = p => { for (let k = p - 1; k >= 0; k--) if (status[live[k]] !== AD_BAD) return k; return -1; };
    const nextCur = p => { for (let k = p + 1; k < live.length; k++) if (status[live[k]] !== AD_BAD) return k; return -1; };

    const mark   = (p, st) => { status[live[p]] = st; };
    // reject() — everything still Suspect between two positions failed for good.
    const reject = (from, to) => {
      for (let k = Math.max(0, from); k <= Math.min(live.length - 1, to); k++) {
        if (status[live[k]] === AD_SUSPECT) status[live[k]] = AD_BAD;
      }
    };

    const L = live.length;
    // Continuity needs four readings to exist at all. A series shorter than
    // that cannot be tested, and deleting it outright — which is where the
    // algorithm lands if it is allowed to run — would be an answer the data
    // does not support. It is kept, and the panel says it went untested.
    if (L < 4) {
      for (let k = 0; k < L; k++) status[live[k]] = AD_GOOD;
      return status;
    }

    let guard = L * 8 + 1000;    // the walk only ever moves backwards; this is
                                 // belt and braces against a malformed series
    if (L >= 2) {
      let phase = 'start';
      let start = L - 1;                       // Establish Start Continuity begins at the end
      let cur = start - 1;
      let testCount = 0, passCount = 0, lastDiff = 0;
      let lastGood = -1, next = -1, contTest = 0, restart = -1;

      while (guard-- > 0) {
        if (phase === 'start') {
          if (cur < 0) { mark(start, AD_GOOD); break; }
          const step = passCount === 0 ? cfg.small : passCount === 1 ? cfg.medium : cfg.large;
          const d = diff(cur, start);
          // For a rain accumulator the comparison is against a fixed start
          // while `cur` walks backwards, so each difference must be at least
          // the last — the `diffVal >= lastDiffVal` arm of the spec flowchart.
          const ok = verify(d, step) && (!isRA || d >= lastDiff);
          if (ok) {
            mark(cur, AD_GOOD);
            passCount++; lastDiff = d;
            if (passCount > 2) {
              // Four consecutive good readings: the series has begun.
              mark(start, AD_GOOD);
              lastGood = cur; next = lastGood;
              cur = prevCur(cur); testCount = 0; contTest = 0; restart = -1;
              phase = 'cont';
              continue;
            }
            cur = prevCur(cur);
          } else {
            mark(cur, AD_SUSPECT);
            cur = prevCur(cur);
          }
          testCount++;
          if (testCount > cfg.startTests || cur < 0) {
            // The window could not be filled. The start itself is the problem:
            // discard it, step back one, and try to begin the series there.
            mark(start, AD_BAD);
            for (let k = start - 1; k >= 0 && k > start - cfg.startTests - 3; k--) {
              if (status[live[k]] === AD_SUSPECT) status[live[k]] = AD_UNKNOWN;
            }
            start = prevCur(start);
            if (start < 0) break;
            cur = prevCur(start);
            testCount = 0; passCount = 0; lastDiff = 0;
            if (cur < 0) { mark(start, AD_GOOD); break; }
          }
          continue;
        }

        // Establish Continuity.
        if (cur < 0) { reject(0, lastGood); break; }
        const step = testCount === 0 ? cfg.small : testCount === 1 ? cfg.medium : cfg.large;
        const d = next < 0 ? Infinity : diff(cur, next);
        if (next >= 0 && verify(d, step)) {
          // fil357Pass() — the reading stands, and everything left hanging
          // between it and the last good reading is settled as Bad.
          mark(cur, AD_GOOD);
          reject(cur + 1, lastGood - 1);
          lastGood = cur; next = lastGood;
          cur = prevCur(cur);
          testCount = 0; contTest = 0; restart = -1;
        } else if (testCount < 2) {
          // Retest the same reading against the next-next, then next-next-next.
          testCount++;
          const nn = next < 0 ? -1 : nextCur(next);
          next = nn;
        } else {
          mark(cur, AD_SUSPECT);
          if (restart < 0) restart = cur;
          contTest++;
          testCount = 0;
          next = lastGood;
          cur = prevCur(cur);
          if (contTest >= cfg.breakCount) {
            // Four in a row failed: this is not noise, it is a break. The
            // suspects become the opening of a new series rather than casualties
            // of the old one.
            for (let k = Math.max(0, cur + 1); k <= restart; k++) {
              if (status[live[k]] === AD_SUSPECT) status[live[k]] = AD_UNKNOWN;
            }
            start = restart;
            cur = prevCur(start);
            testCount = 0; passCount = 0; lastDiff = 0;
            contTest = 0; restart = -1;
            phase = 'start';
            if (cur < 0) { mark(start, AD_GOOD); break; }
          }
        }
      }
    }

    // Anything still Suspect or never reached failed to earn its place.
    for (let k = 0; k < L; k++) {
      const i = live[k];
      if (status[i] === AD_SUSPECT || status[i] === AD_UNKNOWN) status[i] = AD_BAD;
    }
    return status;
  }

  function runFilter(s, cfg) {
    const key = cfgKey(cfg, s.kind);
    if (s.filt && s.filt.key === key) return s.filt;

    // `v` is ARRO's own "Value" column, filtered exactly as exported. The
    // 3/5/7 steps and the 2048 rollover ceiling below are counts-domain
    // constants from the Bureau's spec — never multiply this by
    // bucketSizeMm() (or anything else per-station) before it reaches
    // walk357(). That would rescale every threshold by the bucket size and
    // the failure mode is silent: a filter that still runs, still looks
    // right, and quietly keeps or drops the wrong readings. Bucket size is a
    // display-time conversion only — see pinHtml()'s Raw row.
    const n = s.n, t = s.t, v = s.v;
    const isRA = s.kind === 'RA';

    // 1. filterOutOfSyncDate() — the list must be strictly ascending. After the
    //    import sort the only offenders left are repeats of a timestamp, which
    //    the sample export is full of (6,111 distinct stamps across 14,942
    //    rows): the same reading re-sent, or re-graded, on a later packet.
    //    `minGapSec` widens that from "same second" to "same observation".
    //    ARRO re-sends a reading several times — the sample export carries the
    //    same value at :12, :13, :14 and :18 past the minute — and four
    //    re-sends of one corrupt packet are enough to satisfy the spec's "any
    //    four consecutive data form a continuous set" and survive as a series
    //    of their own. Off by default, because collapsing them is a departure
    //    from the spec rather than part of it.
    const gapMs = Math.max(0, +cfg.minGapSec || 0) * 1000;
    const oosFlag = new Uint8Array(n);
    const cutFlag = new Uint8Array(n);      // AD_RANGE / AD_RATE, or 0
    let live = [];
    let lastT = -Infinity;
    for (let i = 0; i < n; i++) {
      const tooClose = gapMs ? (t[i] - lastT < gapMs) : (t[i] <= lastT);
      if (tooClose && (cfg.oosOn || cfg.dedupeOn)) { oosFlag[i] = 1; continue; }
      lastT = t[i];
      live.push(i);
    }

    // 1a. Limits. Neither of these is in the Bureau's spec: they are gates on
    //     what a sensor can physically report, and they run *before* the 357
    //     walk so that a reading nothing could have produced never gets a vote
    //     on continuity. A single 2014 mm packet is enough to be tested against
    //     — and to drag three neighbours down with it — long before the walk
    //     decides it is noise.
    if (cfg.rangeOn) {
      const lo = bound(cfg.rangeMin), hi = bound(cfg.rangeMax);
      if (lo !== null || hi !== null) {
        live = live.filter(i => {
          if ((lo !== null && v[i] < lo) || (hi !== null && v[i] > hi)) { cutFlag[i] = AD_RANGE; return false; }
          return true;
        });
      }
    }

    // 1b. Rate of rise: is the *step* between two readings one this sensor could
    //     have made? Each reading is compared with the one before it in the
    //     list, and the comparison holds whether or not that neighbour was
    //     itself rejected. Anchoring to the last *surviving* reading instead is
    //     the obvious-looking alternative and it is a trap: a gauge that
    //     genuinely steps up and stays there is then measured against a value
    //     it will never return to, and the whole record after the step is lost.
    //
    //     So this filter only ever claims the step. A corrupt plateau costs its
    //     first reading here and the rest is the 357 walk's business — which is
    //     the right division of labour, because breaking and re-establishing
    //     continuity is exactly what that walk is for.
    //
    //     A rain accumulator is only tested upwards. It cannot fall except by
    //     wrapping or by corruption, and both of those already have an owner. A
    //     water level is tested in both directions, so a single dropout costs
    //     two readings: the fall into it and the climb back out.
    if (cfg.rateOn && +cfg.rateMax > 0) {
      const max = +cfg.rateMax;
      const kept = [];
      for (let k = 0; k < live.length; k++) {
        const i = live[k];
        if (k > 0) {
          const p = live[k - 1];
          const hrs = (t[i] - t[p]) / 3600000;
          const d = v[i] - v[p];
          const move = isRA ? d : Math.abs(d);
          if (hrs > 0 && move / hrs > max) { cutFlag[i] = AD_RATE; continue; }
        }
        kept.push(i);
      }
      live = kept;
    }

    // 2. The walk, then adjustRolloverData(), then the walk again.
    //
    //    Order matters more than the spec lets on. A rain accumulator that
    //    wraps and a rain accumulator hit by a corrupt packet both look like a
    //    long fall, and the sample export is full of the second kind: 72 mm
    //    jumps to 1234 for one reading and drops straight back. Detecting
    //    rollovers on the raw series reads all 82 of those spikes as wraps and
    //    shifts every later reading by 2048 apiece.
    //
    //    So the spikes go first. The 357 walk removes them without any rollover
    //    help — a wrap simply breaks continuity, which is the spec's own
    //    behaviour — and only then is a fall between two *surviving* readings
    //    trustworthy enough to call a rollover. With the offsets known, the
    //    walk runs once more so continuity carries across the wrap and the
    //    output is a single climbing accumulation rather than two series.
    const adj = new Float64Array(n);
    for (let i = 0; i < n; i++) adj[i] = v[i];

    // With the 357 test switched off the pre-filters still run and nothing is
    // tested for continuity, so everything they left standing is kept.
    const walk = () => {
      if (cfg.use357) return walk357(live, adj, n, isRA, cfg);
      const st = new Uint8Array(n);
      for (const i of live) st[i] = AD_GOOD;
      return st;
    };

    let status = walk();
    const rolls = [];

    if (cfg.rolloverOn) {
      // What makes a fall a rollover is not its size but what it leaves behind:
      // wrap the counter once and the step across the seam should be an
      // ordinary one. So the test is the 357 test itself, applied to the
      // wrapped difference — 2045 → 2 is a rollover because it is really a
      // step of 5, while 1976 → 125 is not, because it would be a step of 197.
      // Size alone cannot tell the two apart: a corrupt packet reading 1976
      // sits just as close to the ceiling as a genuine wrap does.
      const kept = live.filter(i => status[i] === AD_GOOD);
      for (let k = 1; k < kept.length; k++) {
        const prev = v[kept[k - 1]], now = v[kept[k]];
        if (now >= prev) continue;
        const wrapped = now + cfg.cycle - prev;
        if (wrapped >= 0 && wrapped <= cfg.large) rolls.push(kept[k]);
      }
      if (rolls.length) {
        // Re-lay the offsets over every reading, so a point removed inside a
        // wrapped stretch still reports a sensible adjusted value when it is
        // inspected. Repeats keep their raw value: they were never part of the
        // sequence the offsets were counted along.
        const rollSet = new Set(rolls);
        let offset = 0;
        for (let i = 0; i < n; i++) {
          if (oosFlag[i]) { adj[i] = v[i]; continue; }
          if (rollSet.has(i)) offset += cfg.cycle;
          adj[i] = v[i] + offset;
        }
        status = walk();
      }
    }

    // The pre-filter verdicts go on last so they survive the walk, which knows
    // nothing about them — it was only ever handed what they left behind.
    for (let i = 0; i < n; i++) {
      if (oosFlag[i]) status[i] = AD_OOS;
      else if (cutFlag[i]) status[i] = cutFlag[i];
    }

    let good = 0, bad = 0, oos = 0, range = 0, rate = 0;
    for (let i = 0; i < n; i++) {
      const st = status[i];
      if (st === AD_GOOD)       good++;
      else if (st === AD_OOS)   oos++;
      else if (st === AD_RANGE) range++;
      else if (st === AD_RATE)  rate++;
      else bad++;
    }

    s.filt = { key, status, adj, rolls,
               stats: { good, bad, oos, range, rate, rollovers: rolls.length, total: n } };
    return s.filt;
  }

  // ── tracks: what actually gets drawn ───────────────────────────────────────
  // One import feeds two curves — everything as recorded, and what survived the
  // filter — and three readings of each: the accumulator itself, the step
  // between readings, and that step as a rate. Building them once per change
  // and caching keeps the draw path down to arithmetic on typed arrays.

  function trackKey(s, cfg) {
    return `${cfgKey(cfg, s.kind)}|${ad.transform}`;
  }

  function buildTrack(s, idx, vals) {
    const m = idx.length;
    const t = new Float64Array(m), y = new Float64Array(m);
    const ref = new Int32Array(m);
    for (let k = 0; k < m; k++) { ref[k] = idx[k]; t[k] = s.t[idx[k]]; y[k] = vals[idx[k]]; }

    if (ad.transform !== 'value') {
      const d = new Float64Array(m);
      for (let k = 1; k < m; k++) {
        const step = y[k] - y[k - 1];
        if (ad.transform === 'rate') {
          const hrs = (t[k] - t[k - 1]) / 3600000;
          d[k] = hrs > 0 ? step / hrs : 0;
        } else d[k] = step;
      }
      d[0] = 0;
      return { n: m, t, y: d, ref };
    }
    return { n: m, t, y, ref };
  }

  function tracks(s) {
    const key = trackKey(s, ad.cfg);
    if (s.tracks && s.tracks.key === key) return s.tracks;
    const f = runFilter(s, ad.cfg);
    const all = new Int32Array(s.n);
    for (let i = 0; i < s.n; i++) all[i] = i;
    const kept = [];
    for (let i = 0; i < s.n; i++) if (f.status[i] === AD_GOOD) kept.push(i);
    s.tracks = { key, raw: buildTrack(s, all, s.v), filt: buildTrack(s, kept, f.adj), f };
    return s.tracks;
  }

  const shown = () => ad.series.filter(s => s.visible);

  function extent() {
    let t0 = Infinity, t1 = -Infinity;
    for (const s of ad.series) {
      if (!s.n) continue;
      if (s.t[0] < t0) t0 = s.t[0];
      if (s.t[s.n - 1] > t1) t1 = s.t[s.n - 1];
    }
    if (!isFinite(t0)) return null;
    if (t1 <= t0) t1 = t0 + 3600000;
    return { t0, t1 };
  }

  function view() {
    const ex = extent();
    if (!ex) return null;
    if (!ad.view) return ex;
    const t0 = Math.max(ex.t0 - (ex.t1 - ex.t0), ad.view.t0);
    const t1 = Math.min(ex.t1 + (ex.t1 - ex.t0), ad.view.t1);
    return t1 - t0 < 1000 ? { t0, t1: t0 + 1000 } : { t0, t1 };
  }

  // first index with t >= target
  function lower(arr, n, target) {
    let lo = 0, hi = n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < target) lo = m + 1; else hi = m; }
    return lo;
  }

  // Which curves are live given the raw/filtered/both switch.
  function layers(s) {
    const tr = tracks(s);
    if (ad.mode === 'raw')      return [{ track: tr.raw,  kind: 'raw' }];
    if (ad.mode === 'filtered') return [{ track: tr.filt, kind: 'filt' }];
    return [{ track: tr.raw, kind: 'raw' }, { track: tr.filt, kind: 'filt' }];
  }

  function yRange(v) {
    let lo = Infinity, hi = -Infinity;
    for (const s of shown()) {
      // "Kept" scales to the surviving readings alone. A single corrupt packet
      // reading 2014 mm against a gauge sitting at 300 flattens the real trace
      // into the bottom eighth of the chart, and the removals are still drawn —
      // they simply run off the top, which is a fair description of them.
      const ls = ad.yMode === 'kept' ? [{ track: tracks(s).filt, kind: 'filt' }] : layers(s);
      for (const { track } of ls) {
        const i0 = Math.max(0, lower(track.t, track.n, v.t0) - 1);
        const i1 = Math.min(track.n, lower(track.t, track.n, v.t1) + 1);
        for (let k = i0; k < i1; k++) {
          const y = track.y[k];
          if (y < lo) lo = y;
          if (y > hi) hi = y;
        }
      }
    }
    if (!isFinite(lo)) return { lo: 0, hi: 1 };
    if (ad.yMode === 'manual') {
      const a = parseFloat(ad.yMin), b = parseFloat(ad.yMax);
      if (!isNaN(a) && !isNaN(b) && b > a) return { lo: a, hi: b };
    }
    if (ad.yMode === 'zero' && lo > 0) lo = 0;
    if (hi === lo) { hi = lo + 1; lo -= 1; }
    const pad = (hi - lo) * 0.06;
    return { lo: lo - pad, hi: hi + pad };
  }

  // ── axes ──

  const TIME_STEPS = [1e3, 5e3, 15e3, 30e3, 6e4, 3e5, 9e5, 18e5, 36e5, 108e5, 216e5, 432e5,
                      AD_DAY, 2 * AD_DAY, 7 * AD_DAY, 14 * AD_DAY, 30 * AD_DAY, 91 * AD_DAY,
                      182 * AD_DAY, 365 * AD_DAY];

  function timeTicks(t0, t1, want) {
    const span = t1 - t0;
    let step = TIME_STEPS[TIME_STEPS.length - 1];
    for (const s of TIME_STEPS) if (span / s <= want) { step = s; break; }
    const out = [];
    if (step >= 30 * AD_DAY) {
      // Month-aligned, so a long window labels the first of the month rather
      // than an arbitrary 30-day drift.
      const months = Math.max(1, Math.round(step / (30 * AD_DAY)));
      const d = new Date(t0);
      let y = d.getFullYear(), m = d.getMonth();
      for (let i = 0; i < 400; i++) {
        const tt = new Date(y, m, 1).getTime();
        if (tt > t1) break;
        if (tt >= t0) out.push(tt);
        m += months; while (m > 11) { m -= 12; y++; }
      }
    } else {
      const first = Math.ceil(t0 / step) * step;
      for (let tt = first; tt <= t1 && out.length < 400; tt += step) out.push(tt);
    }
    return { ticks: out, step };
  }

  const P2 = n => String(n).padStart(2, '0');

  function fmtTick(t, step) {
    const d = new Date(t);
    if (step < 6e4)          return `${P2(d.getHours())}:${P2(d.getMinutes())}:${P2(d.getSeconds())}`;
    if (step < 36e5)         return `${P2(d.getHours())}:${P2(d.getMinutes())}`;
    if (step < AD_DAY)       return `${d.getDate()}/${d.getMonth() + 1} ${P2(d.getHours())}:${P2(d.getMinutes())}`;
    if (step < 30 * AD_DAY)  return `${d.getDate()}/${d.getMonth() + 1}`;
    if (step < 365 * AD_DAY) return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
    return String(d.getFullYear());
  }

  function fmtFull(t) {
    const d = new Date(t);
    return `${d.getFullYear()}-${P2(d.getMonth() + 1)}-${P2(d.getDate())} `
         + `${P2(d.getHours())}:${P2(d.getMinutes())}:${P2(d.getSeconds())}`;
  }

  function niceTicks(lo, hi, want) {
    const span = hi - lo;
    if (!(span > 0)) return [lo];
    const raw = span / want;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi && out.length < 40; v += step) out.push(v);
    return out;
  }

  function fmtVal(v) {
    const a = Math.abs(v);
    if (a >= 1000) return v.toFixed(0);
    if (a >= 10)   return v.toFixed(1);
    if (a >= 1)    return v.toFixed(2);
    return v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  }

  // ── downsampling ───────────────────────────────────────────────────────────
  // Hundreds of thousands of readings cannot each become an SVG coordinate, and
  // averaging them away would hide exactly what this tool exists to find. So
  // each pixel column keeps its first, min, max and last value: the spike that
  // the filter is hunting survives at any zoom level, and the point count stops
  // growing with the data.

  function densify(track, i0, i1, x, xw) {
    const m = i1 - i0;
    const pts = [];
    if (m <= 0) return pts;
    if (m <= xw * 2) {
      for (let k = i0; k < i1; k++) pts.push([x(track.t[k]), track.y[k], k]);
      return pts;
    }
    let col = -1, first = 0, last = 0, min = 0, max = 0, fk = 0, mnk = 0, mxk = 0, lk = 0;
    const flush = () => {
      if (col < 0) return;
      pts.push([col, first, fk]);
      if (min !== first) pts.push([col, min, mnk]);
      if (max !== min)   pts.push([col, max, mxk]);
      if (last !== max)  pts.push([col, last, lk]);
    };
    for (let k = i0; k < i1; k++) {
      const px = Math.round(x(track.t[k]));
      const y = track.y[k];
      if (px !== col) { flush(); col = px; first = min = max = last = y; fk = mnk = mxk = lk = k; }
      else {
        if (y < min) { min = y; mnk = k; }
        if (y > max) { max = y; mxk = k; }
        last = y; lk = k;
      }
    }
    flush();
    return pts;
  }

  function pathFrom(pts, y, step) {
    if (!pts.length) return '';
    let d = '';
    for (let i = 0; i < pts.length; i++) {
      const px = pts[i][0].toFixed(1), py = y(pts[i][1]).toFixed(1);
      if (i === 0) d += `M${px} ${py}`;
      else if (step) d += `H${px}V${py}`;
      else d += `L${px} ${py}`;
    }
    return d;
  }

  // ── import ─────────────────────────────────────────────────────────────────

  function importFiles(files) {
    const list = [...(files || [])].filter(f => /\.csv$/i.test(f.name));
    if (!list.length) { note('Nothing to import — ARRO exports are .csv files.', true); return; }
    ad.busy += list.length;
    renderSide();
    let done = 0;
    const problems = [];
    for (const file of list) {
      const reader = new FileReader();
      reader.onload = e => {
        try { addSeries(file.name, String(e.target.result), problems); }
        catch (err) { problems.push(`${file.name}: ${err.message}`); }
        finally { if (++done === list.length) finish(); }
      };
      reader.onerror = () => { problems.push(`${file.name}: could not be read.`); if (++done === list.length) finish(); };
      reader.readAsText(file);
    }
    function finish() {
      ad.busy = Math.max(0, ad.busy - list.length);
      ad.view = null;
      renderAll();
      note(problems.length ? problems.join(' ') : `Imported ${list.length} file${list.length === 1 ? '' : 's'}.`, !!problems.length);
    }
  }

  function addSeries(fileName, text, problems) {
    const parsed = parseCsv(text);
    if (parsed.error) { problems.push(`${fileName}: ${parsed.error}`); return; }
    const meta = parseName(fileName);
    const link = linkStation(meta);
    const sensor = link.sensor;
    const label = [link.station?.name || meta.siteName || fileName,
                   sensor?.type || meta.sensorLabel].filter(Boolean).join(' · ');

    ad.series.push({
      key:      `ad${++ad.seq}`,
      fileName, meta, label,
      station:  link.station, sensor, linkHow: link.how,
      sensorId: meta.sensorId || sensor?.sensor_id || null,
      kind:     guessKind(meta, sensor),
      unit:     parsed.unit,
      color:    AD_COLORS[(ad.series.length) % AD_COLORS.length],
      visible:  true,
      n: parsed.n, t: parsed.t, tr: parsed.tr, v: parsed.v, raw: parsed.raw, hasRaw: parsed.hasRaw,
      q: parsed.q, qcodes: parsed.qcodes,
      warn:     parsed.warn, wasDescending: parsed.desc,
      filt: null, tracks: null,
    });
  }

  function note(msg, bad) {
    const el = document.getElementById('ad-note');
    if (!el) return;
    el.textContent = msg;
    el.className = 'small ad-note' + (bad ? ' ad-note--bad' : '');
    clearTimeout(ad.noteTimer);
    ad.noteTimer = setTimeout(() => { if (el) { el.textContent = ''; el.className = 'small ad-note'; } }, 9000);
  }

  // ── render ─────────────────────────────────────────────────────────────────

  function render() {
    return `
      <div class="ad-wrap">
        <div class="ad-layout">
          <aside class="ad-side" id="ad-side">${sideHtml()}</aside>
          <section class="ad-main">${mainHtml()}</section>
        </div>
      </div>`;
  }

  function sideHtml() {
    return `
      <div class="ad-drop" id="ad-drop">
        <input type="file" id="ad-file" accept=".csv,text/csv" multiple hidden
               onchange="ArroData.pick(this)">
        <div><strong>Drop ARRO sensor CSVs here</strong></div>
        <div class="small" style="margin:.3rem 0 .5rem">
          Read in your browser — nothing is uploaded.</div>
        <button onclick="document.getElementById('ad-file').click()">Choose files…</button>
        ${ad.busy ? `<div class="small" style="margin-top:.4rem">Reading ${ad.busy} file${ad.busy === 1 ? '' : 's'}…</div>` : ''}
      </div>
      <div id="ad-note" class="small ad-note"></div>
      ${seriesHtml()}
      ${cfgHtml()}`;
  }

  function seriesHtml() {
    if (!ad.series.length) return '';
    const rows = ad.series.map(s => {
      const f = runFilter(s, ad.cfg);
      const st = f.stats;
      const linkTxt = s.station
        ? `<a class="btn-link" href="#" onclick="ArroData.showStation('${escAttr(s.station.id)}');return false"
             title="Open this station on the Stations tab">${esc(s.station.name)}</a>`
        : `<span class="ad-unlinked" title="${escAttr(s.meta.sensorId
              ? 'No station in the loaded file carries sensor ' + s.meta.sensorId
              : 'The filename did not contain a sensor id')}">not linked</span>`;
      const arro = s.station && arroSensorUrl(arroSiteId(s.station), s.sensor?.device_id);
      return `
        <div class="ad-series${ad.sel === s.key ? ' ad-series--sel' : ''}">
          <div class="ad-series-top">
            <input type="checkbox" ${s.visible ? 'checked' : ''} title="Show on the chart"
                   onchange="ArroData.toggle('${s.key}')">
            <input type="color" class="ad-swatch" value="${escAttr(s.color)}" title="Series colour"
                   onchange="ArroData.setColor('${s.key}', this.value)">
            <b class="ad-series-name" title="${escAttr(s.fileName)}">${esc(s.label)}</b>
            <button class="ad-x" title="Remove this import" onclick="ArroData.remove('${s.key}')">✕</button>
          </div>
          <div class="small ad-series-meta">
            ${linkTxt}
            ${s.sensorId ? ` · <span class="mono">${esc(s.sensorId)}</span>` : ''}
            ${arro ? ` · <a class="btn-link" href="${escAttr(arro)}" target="_blank" rel="noopener">ARRO ↗</a>` : ''}
          </div>
          <div class="small ad-series-meta">
            <span title="Readings kept by the filters">${st.good.toLocaleString()} kept</span> ·
            <button class="ad-inline-link ad-bad-txt" onclick="ArroData.explain()"
                    title="Readings the 357 test rejected — click for what the test does">${st.bad.toLocaleString()} removed</button> ·
            <span title="Repeat or out-of-sequence timestamps, excluded before filtering">${st.oos.toLocaleString()} repeats</span>
            ${st.range ? ` · <span class="ad-warn-txt" title="Readings outside the minimum / maximum you set">${st.range.toLocaleString()} out of range</span>` : ''}
            ${st.rate ? ` · <span class="ad-warn-txt" title="Readings that climbed faster than the rate limit">${st.rate.toLocaleString()} too fast</span>` : ''}
            ${st.rollovers ? ` · <span title="Accumulator wraps corrected">${st.rollovers} rollover${st.rollovers === 1 ? '' : 's'}</span>` : ''}
          </div>
          <div class="small ad-series-meta">
            <label title="How diff() compares two readings. A rain accumulator only climbs; a water level may move either way.">reads as
              <select onchange="ArroData.setKind('${s.key}', this.value)">
                <option value="RA" ${s.kind === 'RA' ? 'selected' : ''}>RainAccum</option>
                <option value="WL" ${s.kind === 'WL' ? 'selected' : ''}>WaterLevel</option>
              </select></label>
            <button class="btn-link" onclick="ArroData.solo('${s.key}')" title="Show only this series">solo</button>
            <button class="btn-link" onclick="ArroData.zoomTo('${s.key}')" title="Zoom the chart to this series">fit</button>
          </div>
          ${(s.warn || []).map(w => `<div class="small ad-warn">${esc(w)}</div>`).join('')}
        </div>`;
    }).join('');

    return `
      <div class="panel ad-panel">
        <div class="panel-header"><h3>Imports</h3>
          <button class="btn-link" onclick="ArroData.clearAll()">clear all</button></div>
        ${rows}
      </div>`;
  }

  // Every filter is a block with its own switch. Turning one off greys and
  // disables its settings rather than hiding them, so the panel reads the same
  // whichever way the switches are set — and so "what would this look like
  // without the rate limit?" is one click and one click back.
  function cfgHtml() {
    if (!ad.series.length) return '';
    const c = ad.cfg;
    const num = (k, label, tip, min, max, on) => `
      <label class="ad-cfg-row" title="${escAttr(tip)}">
        <span>${label}</span>
        <input type="number" value="${escAttr(c[k])}" min="${min}" max="${max}" ${on ? '' : 'disabled'}
               onchange="ArroData.setCfg('${k}', this.value)">
      </label>`;
    // Blank means "no limit", so this one must not be a number input with a
    // forced value — an empty string has to survive the round trip.
    const lim = (k, label, tip, on) => `
      <label class="ad-cfg-row" title="${escAttr(tip)}">
        <span>${label}</span>
        <input type="number" value="${escAttr(c[k])}" placeholder="none" ${on ? '' : 'disabled'}
               onchange="ArroData.setCfg('${k}', this.value)">
      </label>`;
    // A filter's own switch, and the body it governs.
    const block = (k, label, tip, body, note) => `
      <div class="ad-filt${c[k] ? '' : ' ad-filt--off'}">
        <label class="ad-filt-head" title="${escAttr(tip)}">
          <input type="checkbox" ${c[k] ? 'checked' : ''}
                 onchange="ArroData.setCfg('${k}', this.checked)">
          <span>${esc(label)}</span></label>
        <div class="ad-filt-body">${body}${note ? `<p class="small ad-cfg-note">${note}</p>` : ''}</div>
      </div>`;

    const unit = ad.series[0]?.unit || 'units';

    return `
      <div class="panel ad-panel">
        <div class="panel-header"><h3>Filters</h3>
          <span class="ad-panel-acts">
            <button class="btn-link" onclick="ArroData.explain()"
                    title="What the 3-5-7 continuity test does, and why it removed what it did">How the 357 filter works</button>
            <button class="btn-link" onclick="ArroData.resetCfg()">defaults</button>
          </span></div>

        ${block('use357', '3-5-7 continuity test',
          'The Bureau\'s continuity filter. Off leaves every reading the other filters kept.',
          `<p class="small" style="color:var(--muted);margin:.1rem 0 .4rem">
             A reading passes if it is within <b>${esc(c.small)}</b> of the next, or <b>${esc(c.medium)}</b> of the
             next-next, or <b>${esc(c.large)}</b> of the one after that. Bureau spec, May 2009.</p>
           ${num('small', 'Small step', 'Difference allowed against the next reading (spec: 3)', 0, 10000, c.use357)}
           ${num('medium', 'Medium step', 'Difference allowed against the next-next reading (spec: 5)', 0, 10000, c.use357)}
           ${num('large', 'Large step', 'Difference allowed against the next-next-next reading (spec: 7)', 0, 10000, c.use357)}
           ${num('breakCount', 'Break after', 'Consecutive failures that break continuity and start a new series (spec: 4)', 1, 100, c.use357)}
           ${num('startTests', 'Start window', 'Tests allowed to establish the start of a series (spec flowchart: 4)', 1, 100, c.use357)}`)}

        ${block('rolloverOn', 'Correct rollovers',
          'Detect accumulator wraps and carry the count across them',
          num('cycle', 'Rollover at', 'Accumulator cycle size — the device counts 0 to cycle−1 (spec: 2048)', 2, 1e9, c.rolloverOn),
          c.use357 ? '' : 'With the 357 test off, nothing has removed the corrupt packets a wrap is '
                        + 'easily confused with — expect spikes to be read as rollovers.')}

        ${block('oosOn', 'Drop repeat timestamps',
          'Remove readings that do not advance the clock, before filtering',
          num('minGapSec', 'Min gap (s)', 'Collapse readings closer together than this. 0 keeps the spec behaviour.', 0, 86400, c.oosOn),
          'Repeats are ARRO re-sending one observation. Four re-sends of a corrupt '
          + 'packet satisfy the spec\'s "four consecutive readings make a series" and '
          + 'survive as one — set a minimum gap to collapse them.')}

        ${block('rateOn', 'Rate of rise',
          'Remove readings that climb faster than a gauge plausibly can',
          num('rateMax', `Max rise (${esc(unit)}/h)`,
              'Fastest believable change per hour between one reading and the next', 0, 1e9, c.rateOn),
          `Each reading against the one before it, so this filter only ever claims the
           step — a corrupt plateau costs its first reading here and the rest is the 357
           test's business.
           ${ad.series.some(s => s.kind === 'RA')
              ? 'An accumulator is only tested upwards; falls belong to the rollover and 357 tests.' : ''}`)}

        ${block('rangeOn', 'Minimum / maximum',
          'Remove readings outside what this sensor can physically report',
          `${lim('rangeMin', 'Minimum', 'Readings below this are removed. Blank for no floor.', c.rangeOn)}
           ${lim('rangeMax', 'Maximum', 'Readings above this are removed. Blank for no ceiling.', c.rangeOn)}`,
          `Compared against <b>Value</b> as exported, in ${esc(unit)}, before any rollover
           correction. Leave an end blank to bound only the other one.`)}
      </div>`;
  }

  // ── the filter, explained (issue #80) ──────────────────────────────────────
  // The panel could say what it removed and never what the test was, which
  // leaves "why did that reading go?" answerable only by opening a PDF. This is
  // the answer in the app: the spec's two components as a flowchart, and a
  // worked example whose verdicts come out of the same walk357() every import
  // goes through — so the diagram cannot drift away from the code.
  //
  // Both drawings use the theme's custom properties rather than hex, so they
  // follow light and dark without being redrawn.

  const F357_ARROW = `
    <defs>
      <marker id="f357-arr" viewBox="0 0 8 8" refX="7.5" refY="4"
              markerWidth="7" markerHeight="7" orient="auto">
        <path d="M0 0 L8 4 L0 8 Z" fill="var(--muted)"/>
      </marker>
    </defs>`;

  // Centred lines inside a shape. A plain string is a heading line; ['x', 1] is
  // a smaller muted one.
  function f357Lines(cx, y, h, lines) {
    const lh = 13;
    const top = y + h / 2 - (lines.length - 1) * lh / 2 + 4;
    return lines.map((ln, i) => {
      const [txt, small] = Array.isArray(ln) ? ln : [ln, false];
      return `<text x="${cx}" y="${(top + i * lh).toFixed(1)}" text-anchor="middle"
                    font-size="${small ? 10 : 11.5}" fill="var(--${small ? 'muted' : 'text'})"
                    ${small ? '' : 'font-weight="600"'}>${esc(txt)}</text>`;
    }).join('');
  }

  const f357Box = (x, y, w, h, lines, strong) => `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="7" fill="var(--panel-sub)"
          stroke="var(--${strong ? 'accent' : 'border'})" stroke-width="${strong ? 1.6 : 1}"/>
    ${f357Lines(x + w / 2, y, h, lines)}`;

  const f357Pill = (x, y, w, h, lines) => `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="var(--subtle)"
          stroke="var(--border)"/>
    ${f357Lines(x + w / 2, y, h, lines)}`;

  const f357Diamond = (cx, cy, rx, ry, lines) => `
    <polygon points="${cx},${cy - ry} ${cx + rx},${cy} ${cx},${cy + ry} ${cx - rx},${cy}"
             fill="var(--panel-sub)" stroke="var(--border)"/>
    ${f357Lines(cx, cy - ry, ry * 2, lines)}`;

  const f357Arrow = (d, dashed) => `
    <path d="${d}" fill="none" stroke="var(--muted)" stroke-width="1.3"
          ${dashed ? 'stroke-dasharray="4 3"' : ''} marker-end="url(#f357-arr)"/>`;

  const f357Tag = (x, y, txt, anchor) => `
    <text x="${x}" y="${y}" font-size="9.5" fill="var(--muted)"
          text-anchor="${anchor || 'start'}">${esc(txt)}</text>`;

  // Figures 2, 6 and 9 of the spec, boiled down to the shape of the thing: get
  // a series started, walk it, and start a new one when it breaks.
  function flowSvg() {
    return `
      <svg class="f357-fig" viewBox="0 0 720 660" role="img"
           aria-label="Flowchart: establish start continuity, then establish continuity, restarting a new series when four readings in a row fail">
        ${F357_ARROW}
        ${f357Pill(170, 12, 300, 32, ['Start at the newest reading'])}
        ${f357Arrow('M320 44 V60')}
        ${f357Box(170, 62, 300, 54,
          ['Establish Start Continuity', ['current against a fixed start:', 1], ['≤ 3, then ≤ 5, then ≤ 7', 1]], true)}
        ${f357Arrow('M320 116 V134')}
        ${f357Diamond(320, 170, 118, 34, ['four good in a row?'])}
        ${f357Arrow('M438 170 H498')}
        ${f357Tag(462, 163, 'no')}
        ${f357Box(500, 146, 170, 48, [['drop the start,', 1], ['begin one reading earlier', 1]])}
        ${f357Arrow('M585 146 V88 H474')}
        ${f357Arrow('M320 204 V230')}
        ${f357Tag(328, 222, 'yes')}
        ${f357Box(170, 232, 300, 54,
          ['Establish Continuity', ['current against next ≤ 3,', 1], ['next-next ≤ 5, the third ≤ 7', 1]], true)}
        ${f357Arrow('M320 286 V304')}
        ${f357Diamond(320, 340, 118, 34, ['passes the test?'])}
        ${f357Arrow('M438 340 H498')}
        ${f357Tag(462, 333, 'yes')}
        ${f357Box(500, 312, 170, 56,
          ['mark it Good', ['every Suspect back to the', 1], ['last good becomes Bad', 1]])}
        ${f357Arrow('M585 312 V258 H474')}
        ${f357Arrow('M320 374 V398')}
        ${f357Tag(328, 390, 'no')}
        ${f357Box(170, 400, 300, 40, ['mark Suspect · step back one'])}
        ${f357Arrow('M320 440 V464')}
        ${f357Diamond(320, 500, 118, 34, ['four failures in a row?'])}
        ${f357Arrow('M202 500 H130 V272 H168')}
        ${f357Tag(196, 492, 'no', 'end')}
        ${f357Arrow('M320 534 V564')}
        ${f357Tag(328, 552, 'yes')}
        ${f357Box(170, 566, 300, 44,
          ['continuity broken', ['restart the series at the first failure', 1]])}
        ${f357Arrow('M470 588 H695 V100 H474')}
        ${f357Tag(688, 440, 'and start again there', 'end')}
        ${f357Arrow('M170 244 H85 V594', true)}
        ${f357Pill(20, 596, 130, 40, [['no more data —', 1], ['suspects become Bad', 1]])}
      </svg>`;
  }

  // The same fourteen readings the code sees, with the colours coming back out
  // of walk357() rather than being chosen to look convincing.
  const F357_EX = [12, 14, 15, 17, 18, 60, 20, 21, 0, 23, 24, 26, 27, 29];
  const F357_SPEC = { small: 3, medium: 5, large: 7, cycle: 2048, breakCount: 4, startTests: 4 };

  function exampleSvg() {
    const n = F357_EX.length;
    const st = walk357(F357_EX.map((_, i) => i), Float64Array.from(F357_EX), n, true, F357_SPEC);

    const x  = i => 44 + i * 48;
    const hi = Math.max(...F357_EX), lo = Math.min(...F357_EX);
    const y  = v => 168 - (v - lo) / (hi - lo) * 118;

    // The cursors skip anything already Bad, which is why the third comparison
    // below reaches past the dropout rather than into it.
    const nextLive = k => { for (let j = k + 1; j < n; j++) if (st[j] !== AD_BAD) return j; return -1; };
    const cur = 5;                                     // the spike
    const tgt = [];
    for (let k = 0, at = cur; k < 3; k++) { at = nextLive(at); if (at < 0) break; tgt.push(at); }
    const steps = [F357_SPEC.small, F357_SPEC.medium, F357_SPEC.large];
    const tests = tgt.map((j, k) => {
      const d = F357_EX[j] - F357_EX[cur];
      return { j, d, step: steps[k], ok: d >= 0 && d <= steps[k],
               name: ['the next reading', 'the next-next', 'the one after that'][k] };
    });

    const kept = F357_EX.map((_, i) => i).filter(i => st[i] !== AD_BAD);
    const line = idx => idx.map((i, k) => `${k ? 'L' : 'M'}${x(i)} ${y(F357_EX[i]).toFixed(1)}`).join(' ');

    const dots = F357_EX.map((v, i) => {
      const bad = st[i] === AD_BAD;
      return `<circle cx="${x(i)}" cy="${y(v).toFixed(1)}" r="${i === cur ? 6 : 4.5}"
                      fill="var(--${bad ? 'bad' : 'ok'})"
                      stroke="var(--panel)" stroke-width="${i === cur ? 2 : 1}"/>
              <text x="${x(i)}" y="${(y(v) - 9).toFixed(1)}" font-size="9.5" text-anchor="middle"
                    fill="var(--${bad ? 'bad' : 'muted'})">${v}</text>`;
    }).join('');

    const links = tests.map((t, k) => `
      <path d="M${x(cur)} ${y(F357_EX[cur]).toFixed(1)} L${x(t.j)} ${y(F357_EX[t.j]).toFixed(1)}"
            stroke="var(--bad)" stroke-width="1.1" stroke-dasharray="3 3" opacity=".75" fill="none"/>
      <circle cx="${x(t.j)}" cy="${(y(F357_EX[t.j]) + 15).toFixed(1)}" r="7.5"
              fill="var(--panel)" stroke="var(--bad)"/>
      <text x="${x(t.j)}" y="${(y(F357_EX[t.j]) + 18.5).toFixed(1)}" font-size="9.5"
            text-anchor="middle" fill="var(--bad)">${k + 1}</text>`).join('');

    const rows = tests.map((t, k) => `
      <text x="44" y="${216 + k * 18}" font-size="10.5" fill="var(--text)">
        <tspan fill="var(--bad)">${k + 1}</tspan>
        <tspan dx="6">vs ${esc(t.name)}: ${t.d < 0 ? '−' : ''}${Math.abs(t.d)}, ${
          t.ok ? `inside 0 to ${t.step} — passes` : `outside 0 to ${t.step} — fails`}</tspan>
      </text>`).join('');

    const verdict = tests.every(t => !t.ok)
      ? ['All three fail, so the 60 is marked Suspect — and Bad as soon as a reading behind it passes.',
         'The 0 goes the same way; everything else is within 3 of its neighbour and survives untouched.']
      : ['The comparisons above use the specification\'s own 3, 5 and 7.', ''];

    return `
      <svg class="f357-fig" viewBox="0 0 720 300" role="img"
           aria-label="Fourteen readings: a spike of 60 and a dropout of 0 are removed, the rest kept">
        ${F357_ARROW}
        <circle cx="48" cy="17" r="4.5" fill="var(--ok)"/>
        ${f357Tag(58, 21, 'kept')}
        <circle cx="100" cy="17" r="4.5" fill="var(--bad)"/>
        ${f357Tag(110, 21, 'removed')}
        ${f357Arrow('M668 36 H472')}
        ${f357Tag(464, 40, 'the walk runs this way', 'end')}
        <path d="${line(F357_EX.map((_, i) => i))}" fill="none" stroke="var(--muted)"
              stroke-width="1" opacity=".45" stroke-dasharray="3 3"/>
        <path d="${line(kept)}" fill="none" stroke="var(--ok)" stroke-width="1.8"/>
        ${links}
        ${dots}
        <line x1="34" y1="182" x2="686" y2="182" stroke="var(--border)"/>
        ${f357Tag(44, 196, 'older')}
        ${f357Tag(676, 196, 'newest', 'end')}
        ${rows}
        <text x="44" y="272" font-size="10.5" fill="var(--muted)">
          <tspan x="44">${esc(verdict[0])}</tspan>
          <tspan x="44" dy="14">${esc(verdict[1])}</tspan>
        </text>
      </svg>`;
  }

  function explain() {
    const c = ad.cfg;
    const tweaked = c.small !== 3 || c.medium !== 5 || c.large !== 7;
    Modal.open({
      title: 'How the 357 filter works',
      wide: true,
      html: `
      <div class="f357">
        <p>ERTS packets arrive over radio, and radio loses and mangles them. The Bureau's
           <b>3-5-7 filter</b> does not ask whether a reading looks reasonable on its own — a
           corrupt packet can read 300 mm perfectly plausibly. It asks whether a reading is
           <em>continuous with the ones around it</em>, and throws out what is not.</p>

        <h3>The test</h3>
        <p>A reading passes if it is within <b>3</b> of the next reading, or within <b>5</b> of the
           next-next, or within <b>7</b> of the one after that. Three chances, widening as they
           reach further ahead, so a single lost packet does not condemn its neighbours.
           ${tweaked ? `Your panel is currently set to <b>${esc(c.small)}</b>, <b>${esc(c.medium)}</b>
             and <b>${esc(c.large)}</b> — the diagrams below use the spec's own numbers.` : ''}</p>
        <p>The comparison depends on what the sensor is. A <b>rain accumulator</b> only ever climbs,
           so its difference is signed and any fall is a failure by construction. A <b>water level</b>
           moves both ways, so the size of the change is what counts. That is the one thing the
           <em>reads as</em> selector on each import changes.</p>

        <h3>It walks backwards</h3>
        <p>The list is in ascending time order and the filter starts at the <b>newest</b> reading,
           testing each one against what comes <em>after</em> it. That is not an implementation
           detail: the newest reading is the one you have the most reason to trust as a starting
           point, and it means a reading is judged by the record that followed it rather than the
           one that led up to it.</p>

        <h3>Good, Suspect, Bad</h3>
        <p>Nothing is thrown away on first failure. A reading that fails all three comparisons is
           <b>Suspect</b>, and stays that way until something behind it passes — at which point
           every Suspect between the two is settled as <b>Bad</b>. A reading that passes is
           <b>Good</b>. Suspects that never get resolved are Bad at the end of the walk.</p>

        <h3>Two components</h3>
        <p>Getting a series started is a different problem from keeping it going, so the spec has
           two parts. <b>Establish Start Continuity</b> needs four good readings in a row before it
           will believe a series exists at all; if it cannot find them, the start reading itself is
           the problem and it steps back and tries again. <b>Establish Continuity</b> then walks the
           rest of the record.</p>
        ${flowSvg()}

        <h3>Breaking, and starting again</h3>
        <p>Four consecutive failures are not noise — they are a gap. A dead radio link, a flat
           battery, a site visit. Rather than delete everything that follows, the filter declares
           the continuity broken and hands the run back to Start Continuity to begin a new series at
           the first failure. This is why a record with a week-long outage in it comes through as two
           good series rather than one good one and a week of casualties.</p>

        <h3>A worked example</h3>
        <p>Fourteen readings from an accumulator, with one corrupt spike and one dropout. The
           colours below are not illustrative — they are what <code>walk357()</code> returns when it
           is handed exactly these numbers, from the same code the imports go through.</p>
        ${exampleSvg()}

        <h3>Rollovers</h3>
        <p>The counter in the field only counts to ${esc(c.cycle - 1)}, then wraps to zero. A wrap
           looks exactly like a huge fall, and so does a corrupt packet — so this app removes the
           noise <em>first</em>, and only then treats a fall between two surviving readings as a
           possible wrap. What makes a fall a rollover is not its size but the step it leaves
           behind: 2045 → 2 is a wrap because it is really a step of 5, while 1976 → 125 would be a
           step of 197 and is not.</p>

        <h3>Repeats are not readings</h3>
        <p>ARRO re-sends an observation several times, so the same reading arrives at :12, :13, :14
           and :18 past the minute. Anything that does not advance the clock is set aside before the
           filter runs. Four re-sends of one corrupt packet otherwise satisfy "any four consecutive
           data form a continuous set" and survive as a series of their own — which is what the
           <b>minimum gap</b> setting exists to collapse.</p>

        <h3>The numbers are counts, not millimetres</h3>
        <p>3, 5, 7 and ${esc(c.cycle)} are all in the units ARRO exported in the <b>Value</b> column.
           They are not rescaled by a station's bucket size — doing that would quietly move every
           threshold. Bucket size is a display conversion only, shown against the raw tip count when
           you click a reading.</p>

        <h3>The other filters in this panel</h3>
        <p>Only the 3-5-7 test and the rollover correction come from the spec. The rest are gates
           this app adds, each with its own switch so you can see what it is doing by turning it
           off:</p>
        <ul>
          <li><b>Rate of rise</b> — removes readings that climb faster than a gauge plausibly can,
              each compared with the one before it. It claims the step and nothing more: a corrupt
              plateau costs its first reading here, and the rest is the continuity test's business.
              An accumulator is only tested upwards, since a fall belongs to the rollover and 357
              tests.</li>
          <li><b>Minimum / maximum</b> — removes readings outside what the sensor can physically
              report, before the continuity test runs, so a value nothing could have produced never
              gets a vote on its neighbours.</li>
        </ul>
        <p>Both run before the 357 walk and are marked separately on the chart — a square for out of
           range, a triangle for too fast, a cross for the 357 test itself — so a removal always says
           which filter made the call.</p>

        <p class="f357-src">Hydrology Raw Data Filtering Program Specification v2.1, Commonwealth
           Bureau of Meteorology, May 2009, with the 1998 first edition. Both are in
           <code>docs/</code>.</p>
      </div>`,
    });
  }

  function mainHtml() {
    if (!ad.series.length) return emptyHtml();
    return `
      ${toolbarHtml()}
      <div class="ad-stage" id="ad-stage" tabindex="0"
           aria-label="Sensor readings over time. Drag to pan, scroll to zoom, arrow keys to step.">
        <svg id="ad-svg" role="img"></svg>
        <div class="ad-tip" id="ad-tip" hidden></div>
      </div>
      <svg id="ad-ov" class="ad-ov" role="img"
           aria-label="Whole record, with the visible window shaded"></svg>
      <div id="ad-readout" class="ad-readout">${readoutHtml()}</div>
      ${compareHtml()}`;
  }

  // Raw and filtered on one chart answers "what was removed". Raw and filtered
  // as two charts answers "what shape did the record have before, and after" —
  // which is a different question, and the one somebody asks when deciding
  // whether the settings are right. Folded away by default: it is a second
  // look, not the main one.
  function compareHtml() {
    const vis = shown();
    const tot  = vis.reduce((a, s) => a + s.n, 0);
    const kept = vis.reduce((a, s) => a + runFilter(s, ad.cfg).stats.good, 0);
    return `
      <details class="ad-compare" id="ad-compare" ${ad.compare ? 'open' : ''}
               ontoggle="ArroData.compareToggle(this)">
        <summary>Side by side <span class="small">— as recorded against what the filters kept</span></summary>
        <div class="ad-compare-grid">
          <figure>
            <figcaption>As recorded <span class="small">${tot.toLocaleString()} readings</span></figcaption>
            <svg id="ad-cmp-raw" role="img"
                 aria-label="Every reading as exported, over the visible window"></svg>
          </figure>
          <figure>
            <figcaption>Filtered <span class="small">${kept.toLocaleString()} kept</span></figcaption>
            <svg id="ad-cmp-filt" role="img"
                 aria-label="The readings that survived the filters, over the same window"></svg>
          </figure>
        </div>
        <p class="small ad-cfg-note">Both panes hold the same time window and the same vertical
           scale, so the only difference between them is the filters. Removals are marked on the
           left-hand pane. The scale follows the toolbar's <b>vertical axis</b> setting — with a
           spike in the record, <b>Kept</b> is what stops it flattening the right-hand pane.</p>
      </details>`;
  }

  function emptyHtml() {
    return `
      <div class="ad-empty">
        <h2>Sensor data, filtered and drawn</h2>
        <p>Export a sensor from ARRO as CSV and drop it here. The filename carries
           the sensor id, so the import links itself back to the station without
           you choosing one.</p>
        <p>Every reading is kept exactly as exported. The Bureau's 3-5-7 continuity
           filter runs alongside it, never over it, so you can switch between what
           the gauge sent and what survives the test — and look at whatever it threw
           away.</p>
        <p class="small" style="color:var(--muted)">
          Expected columns: Reading, Receive, Value, Unit, Data Quality, Raw Value.</p>
      </div>`;
  }

  const seg = (group, cur, opts, fn) => `
    <div class="ad-seg" role="group" aria-label="${escAttr(group)}">
      ${opts.map(([v, label, tip]) => `
        <button class="${cur === v ? 'on' : ''}" title="${escAttr(tip || label)}"
                onclick="ArroData.${fn}('${v}')">${esc(label)}</button>`).join('')}
    </div>`;

  function toolbarHtml() {
    const anyFilt = ad.mode !== 'raw';
    return `
      <div class="ad-toolbar">
        ${seg('Which series', ad.mode, [
          ['raw', 'Raw', 'Everything as exported'],
          ['filtered', 'Filtered', 'Only what passed the 357 test'],
          ['both', 'Both', 'Filtered over raw, so removals show'],
        ], 'setMode')}
        ${seg('Reading', ad.transform, [
          ['value', 'Value', 'The reading itself'],
          ['increment', 'Increment', 'Step between consecutive readings'],
          ['rate', 'Rate/h', 'Step divided by the hours between readings'],
        ], 'setTransform')}
        ${seg('Chart style', ad.chartType, [
          ['line', 'Line', 'Straight between readings'],
          ['step', 'Step', 'Hold each reading until the next — how an accumulator behaves'],
          ['dots', 'Points', 'One mark per reading, nothing joined'],
        ], 'setChart')}
        ${seg('Vertical axis', ad.yMode, [
          ['auto', 'Auto', 'Fit everything on screen, spikes included'],
          ['kept', 'Kept', 'Fit the readings that passed the filter — removals run off the top'],
          ['zero', 'Zero', 'Always include zero'],
          ['manual', 'Fixed', 'Type your own range'],
        ], 'setY')}
        ${ad.yMode === 'manual' ? `
          <span class="ad-tool-grp">
            <input type="number" class="ad-num" value="${escAttr(ad.yMin)}" placeholder="min"
                   onchange="ArroData.setYRange('min', this.value)">
            <input type="number" class="ad-num" value="${escAttr(ad.yMax)}" placeholder="max"
                   onchange="ArroData.setYRange('max', this.value)">
          </span>` : ''}
        <span class="ad-tool-grp">
          <label class="ad-chk" title="Mark every reading the filter rejected"
                 style="${anyFilt ? '' : 'opacity:.45'}">
            <input type="checkbox" ${ad.showRemoved ? 'checked' : ''} ${anyFilt ? '' : 'disabled'}
                   onchange="ArroData.setFlag('showRemoved', this.checked)"> removed</label>
          <label class="ad-chk" title="Mark repeat timestamps dropped before filtering">
            <input type="checkbox" ${ad.showDupes ? 'checked' : ''}
                   onchange="ArroData.setFlag('showDupes', this.checked)"> repeats</label>
          <label class="ad-chk" title="Mark where an accumulator wrap was corrected">
            <input type="checkbox" ${ad.showRollover ? 'checked' : ''}
                   onchange="ArroData.setFlag('showRollover', this.checked)"> rollovers</label>
          <label class="ad-chk" title="Drag to select a time range instead of panning">
            <input type="checkbox" ${ad.brush ? 'checked' : ''}
                   onchange="ArroData.setFlag('brush', this.checked)"> drag zooms</label>
        </span>
        <span class="ad-tool-grp">
          ${[['all', 'All'], ['24h', '24h'], ['7d', '7d'], ['30d', '30d'], ['90d', '90d']]
            .map(([k, l]) => `<button onclick="ArroData.preset('${k}')" title="Show the last ${l === 'All' ? 'of everything' : l}">${l}</button>`).join('')}
        </span>
        <span class="ad-tool-grp">
          <button onclick="ArroData.exportCsv('kept')" title="The filtered series, as CSV">Export kept</button>
          <button onclick="ArroData.exportCsv('all')" title="Every reading with the filter's verdict against it">Export + verdict</button>
          <button onclick="ArroData.exportImg('svg')" title="Download the chart as SVG">SVG</button>
          <button onclick="ArroData.exportImg('png')" title="Download the chart as PNG">PNG</button>
        </span>
      </div>`;
  }

  // ── readout / inspector ────────────────────────────────────────────────────

  function statusOf(s, i) {
    const f = runFilter(s, ad.cfg);
    return f.status[i];
  }

  function readoutHtml() {
    if (ad.pin) {
      const s = ad.series.find(x => x.key === ad.pin.key);
      if (s) return pinHtml(s, ad.pin.i);
    }
    if (ad.hover && ad.hover.rows.length) {
      return `
        <div class="ad-read-hover">
          <b>${esc(fmtFull(ad.hover.t))}</b>
          ${ad.hover.rows.map(r => `
            <span class="ad-read-item">
              <span class="ad-dot" style="background:${escAttr(r.color)}"></span>
              ${esc(r.label)} <b>${esc(fmtVal(r.y))}</b>${r.unit ? ' ' + esc(r.unit) : ''}
              <span class="small" style="color:var(--muted)">${esc(r.kindLabel)}${r.q ? ' · ' + esc(r.q) : ''}</span>
            </span>`).join('')}
          <span class="small" style="color:var(--muted)">click to pin a reading</span>
        </div>`;
    }
    return statsHtml();
  }

  // What a raw tip count converts to in mm, for display next to it — never
  // fed back into runFilter/walk357, which stay in the count/Value domain
  // ARRO exported (see the comment on runFilter()). Only offered for a
  // rainfall accumulator with a real "Raw Value" column and a linked
  // station; a water level's raw count isn't a tip count at all.
  function rawBucketNote(s, i) {
    if (s.kind !== 'RA' || !s.hasRaw || !s.station) return '';
    const b = bucketSizeMm(s.station);
    const mm = s.raw[i] * b.mm;
    const note = b.recorded ? `recorded, ${b.mm} mm/tip` : `assumed ${b.mm} mm/tip — not recorded for this site`;
    return ` <span class="small" style="color:var(--muted)">= ${esc(fmtVal(mm))} mm (${esc(note)})</span>`;
  }

  function pinHtml(s, i) {
    const f = runFilter(s, ad.cfg);
    const st = f.status[i];
    const lim = [bound(ad.cfg.rangeMin) !== null ? `below ${ad.cfg.rangeMin}` : '',
                 bound(ad.cfg.rangeMax) !== null ? `above ${ad.cfg.rangeMax}` : ''].filter(Boolean).join(' or ');
    const why = st === AD_GOOD
        ? (ad.cfg.use357 ? 'Passed the 357 test.'
                         : 'Kept — the 357 test is switched off, so nothing here was tested for continuity.')
      : st === AD_OOS ? 'Dropped before filtering — this timestamp does not advance the clock, so it is a repeat of an earlier reading rather than a new observation.'
      : st === AD_RANGE ? `Outside the limits you set — anything ${lim || 'outside the range'} is removed before the 357 test runs.`
      : st === AD_RATE ? `Moved faster than ${ad.cfg.rateMax} ${s.unit}/h from the reading before it, so it was removed before the 357 test ran.`
      : `Failed the 357 test against the readings that follow it — not within ${ad.cfg.small} of the next, ${ad.cfg.medium} of the next-next, or ${ad.cfg.large} of the one after that.`;
    const badge = st === AD_GOOD ? 'ok' : st === AD_OOS ? 'dup'
                : (st === AD_RANGE || st === AD_RATE) ? 'warn' : 'bad';
    const rolled = f.rolls.includes(i);
    return `
      <div class="ad-pin">
        <div class="ad-pin-head">
          <span class="ad-dot" style="background:${escAttr(s.color)}"></span>
          <b>${esc(s.label)}</b>
          <span class="ad-badge ad-badge--${badge}">${esc(AD_STATUS_LABEL[st])}</span>
          <button class="ad-x" onclick="ArroData.unpin()" title="Close">✕</button>
        </div>
        <div class="ad-pin-grid">
          <div><span>Reading</span><b>${esc(fmtFull(s.t[i]))}</b></div>
          <div><span>Received</span><b>${esc(fmtFull(s.tr[i]))}${s.tr[i] !== s.t[i]
              ? ` <span class="small" style="color:var(--warn)">+${Math.round((s.tr[i] - s.t[i]) / 1000)}s</span>` : ''}</b></div>
          <div><span>Value</span><b>${esc(fmtVal(s.v[i]))} ${esc(s.unit)}</b></div>
          <div><span>Raw</span><b>${esc(fmtVal(s.raw[i]))}</b>${rawBucketNote(s, i)}</div>
          <div><span>Adjusted</span><b>${esc(fmtVal(f.adj[i]))}${rolled ? ' <span class="small">(wrap here)</span>' : ''}</b></div>
          <div><span>Quality</span><b>${esc(s.qcodes[s.q[i]] || '—')}</b></div>
        </div>
        <div class="small ad-pin-why">${esc(why)}
          <button class="ad-inline-link" onclick="ArroData.explain()"
                  title="The whole test, with the spec's own diagrams">How the 357 filter works</button>
        </div>
      </div>`;
  }

  function statsHtml() {
    const vis = shown();
    if (!vis.length) return '<span class="small" style="color:var(--muted)">No series shown — tick one on the left.</span>';
    const v = view();
    return `<div class="ad-stats">${vis.map(s => {
      const tr = tracks(s);
      const track = ad.mode === 'raw' ? tr.raw : tr.filt;
      const i0 = lower(track.t, track.n, v.t0), i1 = lower(track.t, track.n, v.t1);
      let lo = Infinity, hi = -Infinity, sum = 0, cnt = 0;
      for (let k = i0; k < i1; k++) { const y = track.y[k]; if (y < lo) lo = y; if (y > hi) hi = y; sum += y; cnt++; }
      const net = cnt && ad.transform === 'value' ? track.y[i1 - 1] - track.y[i0] : sum;
      return `
        <span class="ad-stat">
          <span class="ad-dot" style="background:${escAttr(s.color)}"></span>
          <b>${esc(s.label)}</b>
          <span class="small">${cnt.toLocaleString()} in view${cnt ? ` · ${fmtVal(lo)}–${fmtVal(hi)} ${esc(s.unit)}
            · ${ad.transform === 'value' ? 'net' : 'total'} ${fmtVal(net)}` : ''}</span>
        </span>`;
    }).join('')}</div>`;
  }

  // ── drawing ────────────────────────────────────────────────────────────────
  // Theme colours are read from the document rather than written as `var(...)`
  // into the markup, because the SVG has to survive being pulled out of the
  // page and turned into a PNG, where nothing would resolve them.

  function theme() {
    const cs = getComputedStyle(document.documentElement);
    const pick = (n, fb) => (cs.getPropertyValue(n) || '').trim() || fb;
    return {
      text:   pick('--text', '#16202a'),
      muted:  pick('--muted', '#4f6478'),
      border: pick('--border', '#dde5ee'),
      panel:  pick('--panel', '#ffffff'),
      bad:    pick('--bad', '#c7401a'),
      warn:   pick('--warn', '#a86400'),
      accent: pick('--accent', '#0b5cab'),
    };
  }

  const PADL = 64, PADR = 18, PADT = 14, PADB = 30;
  const MARK_CAP = 2500;      // removed-point markers drawn before we stop

  function measure() {
    const stage = document.getElementById('ad-stage');
    if (!stage) return false;
    const r = stage.getBoundingClientRect();
    const w = Math.max(360, Math.round(r.width));
    const h = Math.max(240, Math.round(r.height));
    const same = w === ad.w && h === ad.h;
    ad.w = w; ad.h = h;
    return !same;
  }

  function geom() {
    const v = view();
    if (!v) return null;
    const w = ad.w, h = ad.h;
    const pw = w - PADL - PADR, ph = h - PADT - PADB;
    const yr = yRange(v);
    const x = t => PADL + (t - v.t0) / (v.t1 - v.t0) * pw;
    const y = val => PADT + (1 - (val - yr.lo) / (yr.hi - yr.lo)) * ph;
    const tOf = px => v.t0 + (px - PADL) / pw * (v.t1 - v.t0);
    return { v, w, h, pw, ph, yr, x, y, tOf };
  }

  function draw() {
    const svg = document.getElementById('ad-svg');
    if (!svg) return;
    const g = geom();
    if (!g) { svg.innerHTML = ''; return; }
    const c = theme();
    svg.setAttribute('viewBox', `0 0 ${g.w} ${g.h}`);
    svg.setAttribute('width', g.w);
    svg.setAttribute('height', g.h);

    const { ticks, step } = timeTicks(g.v.t0, g.v.t1, Math.max(3, Math.round(g.pw / 110)));
    const yt = niceTicks(g.yr.lo, g.yr.hi, Math.max(2, Math.round(g.ph / 46)));

    // Everything data-driven is clipped to the plot rectangle. Without it a
    // fixed or kept-only vertical range lets curves run across the axis labels.
    let out = `<defs><clipPath id="ad-clip"><rect x="${PADL}" y="${PADT}"
                 width="${g.pw}" height="${g.ph}"/></clipPath></defs>
               <rect x="0" y="0" width="${g.w}" height="${g.h}" fill="${c.panel}"/>`;

    out += yt.map(val => `
      <line x1="${PADL}" y1="${g.y(val).toFixed(1)}" x2="${g.w - PADR}" y2="${g.y(val).toFixed(1)}"
            stroke="${c.border}" stroke-width="1"/>
      <text x="${PADL - 6}" y="${(g.y(val) + 3.5).toFixed(1)}" font-size="10" text-anchor="end"
            fill="${c.muted}">${esc(fmtVal(val))}</text>`).join('');

    out += ticks.map(t => `
      <line x1="${g.x(t).toFixed(1)}" y1="${PADT}" x2="${g.x(t).toFixed(1)}" y2="${g.h - PADB}"
            stroke="${c.border}" stroke-width="1" opacity=".7"/>
      <text x="${g.x(t).toFixed(1)}" y="${g.h - PADB + 14}" font-size="10" text-anchor="middle"
            fill="${c.muted}">${esc(fmtTick(t, step))}</text>`).join('');

    // Rollover seams sit under the curves — they explain a step, they are not
    // a reading in their own right.
    if (ad.showRollover) {
      for (const s of shown()) {
        const f = runFilter(s, ad.cfg);
        for (const i of f.rolls) {
          if (s.t[i] < g.v.t0 || s.t[i] > g.v.t1) continue;
          out += `<line x1="${g.x(s.t[i]).toFixed(1)}" y1="${PADT}" x2="${g.x(s.t[i]).toFixed(1)}"
                        y2="${g.h - PADB}" stroke="${c.warn}" stroke-width="1.2" stroke-dasharray="4 3"
                        opacity=".8"><title>Accumulator wrap corrected · ${esc(fmtFull(s.t[i]))}</title></line>`;
        }
      }
    }

    const stepped = ad.chartType === 'step';
    const dots = ad.chartType === 'dots';
    let markers = '', nMark = 0;
    let series = '';

    for (const s of shown()) {
      for (const { track, kind } of layers(s)) {
        const i0 = Math.max(0, lower(track.t, track.n, g.v.t0) - 1);
        const i1 = Math.min(track.n, lower(track.t, track.n, g.v.t1) + 1);
        const pts = densify(track, i0, i1, g.x, g.pw);
        if (!pts.length) continue;
        // In "both", raw sits underneath as a ghost so that what the filter took
        // out reads as a gap in the solid line rather than a second chart.
        const ghost = ad.mode === 'both' && kind === 'raw';
        if (dots) {
          markers += pts.slice(0, 4000).map(p =>
            `<circle cx="${p[0].toFixed(1)}" cy="${g.y(p[1]).toFixed(1)}" r="${ghost ? 1.1 : 1.8}"
                     fill="${escAttr(s.color)}" opacity="${ghost ? .3 : .9}"/>`).join('');
        } else {
          series += `<path d="${pathFrom(pts, g.y, stepped)}" fill="none" stroke="${escAttr(s.color)}"
                        stroke-width="${ghost ? 1 : 1.7}" opacity="${ghost ? .34 : 1}"
                        stroke-linejoin="round" stroke-linecap="round"/>`;
        }
        // Few enough points on screen that each one is a real reading: show them.
        if (!dots && ad.showPoints !== 'off' && (i1 - i0) <= Math.max(40, g.pw / 12) && !ghost) {
          for (let k = i0; k < i1; k++) {
            markers += `<circle cx="${g.x(track.t[k]).toFixed(1)}" cy="${g.y(track.y[k]).toFixed(1)}"
                                r="2.2" fill="${escAttr(s.color)}"/>`;
          }
        }
      }

      // What the filter took out, and what never made it in.
      const f = runFilter(s, ad.cfg);
      const wantBad = ad.showRemoved && ad.mode !== 'raw';
      if (wantBad || ad.showDupes) {
        const i0 = lower(s.t, s.n, g.v.t0), i1 = lower(s.t, s.n, g.v.t1);
        for (let i = i0; i < i1 && nMark < MARK_CAP; i++) {
          const st = f.status[i];
          const isDup = st === AD_OOS;
          const isCut = st === AD_BAD || st === AD_RANGE || st === AD_RATE;
          if (!(isCut && wantBad) && !(isDup && ad.showDupes)) continue;
          if (ad.transform !== 'value') continue;   // a removed step has no meaningful height
          const px = g.x(s.t[i]), py = g.y(s.v[i]);
          // Which filter took it out, told apart by shape as well as colour —
          // at four pixels a colour alone is a guess.
          const col = st === AD_BAD ? c.bad : isDup ? c.muted : c.warn;
          nMark++;
          // A removal above the top of the scale still has to be visible, or
          // "Kept" would quietly hide the very readings it is scaled to exclude.
          if (py < PADT) {
            markers += `<path d="M${px.toFixed(1)} ${PADT}l-4 7h8Z" fill="${col}"
                              opacity=".9"><title>${esc(fmtVal(s.v[i]))} ${esc(s.unit)} — ${esc(AD_STATUS_LABEL[st])}, above the scale</title></path>`;
            continue;
          }
          if (py > g.h - PADB) continue;
          markers += st === AD_BAD
            ? `<path d="M${(px - 3).toFixed(1)} ${(py - 3).toFixed(1)}l6 6M${(px + 3).toFixed(1)} ${(py - 3).toFixed(1)}l-6 6"
                     stroke="${c.bad}" stroke-width="1.4" opacity=".92"><title>failed the 357 test</title></path>`
            : st === AD_RANGE
            ? `<rect x="${(px - 2.8).toFixed(1)}" y="${(py - 2.8).toFixed(1)}" width="5.6" height="5.6"
                     fill="none" stroke="${c.warn}" stroke-width="1.4"><title>outside the range limits</title></rect>`
            : st === AD_RATE
            ? `<path d="M${px.toFixed(1)} ${(py - 3.6).toFixed(1)}l3.4 5.8h-6.8Z" fill="${c.warn}"
                     opacity=".92"><title>rose faster than the rate limit</title></path>`
            : `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="1.6" fill="${c.muted}" opacity=".5"/>`;
        }
      }
    }
    out += `<g clip-path="url(#ad-clip)">${series}${markers}</g>`;

    // Crosshair and the nearest-reading halo.
    if (ad.hover) {
      const hx = g.x(ad.hover.t);
      out += `<line x1="${hx.toFixed(1)}" y1="${PADT}" x2="${hx.toFixed(1)}" y2="${g.h - PADB}"
                    stroke="${c.accent}" stroke-width="1" opacity=".55"/>`;
      for (const r of ad.hover.rows) {
        out += `<circle cx="${g.x(r.t).toFixed(1)}" cy="${g.y(r.y).toFixed(1)}" r="3.6"
                        fill="none" stroke="${escAttr(r.color)}" stroke-width="2"/>`;
      }
    }
    if (ad.pin) {
      const s = ad.series.find(x => x.key === ad.pin.key);
      if (s && ad.transform === 'value') {
        const px = g.x(s.t[ad.pin.i]), py = g.y(s.v[ad.pin.i]);
        out += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="6" fill="none"
                        stroke="${c.accent}" stroke-width="2"/>`;
      }
    }
    if (ad.drag && ad.drag.brush) {
      const a = Math.min(ad.drag.x0, ad.drag.x1), b = Math.max(ad.drag.x0, ad.drag.x1);
      out += `<rect x="${a.toFixed(1)}" y="${PADT}" width="${(b - a).toFixed(1)}" height="${g.ph}"
                    fill="${c.accent}" opacity=".14"/>`;
    }

    out += `<line x1="${PADL}" y1="${g.h - PADB}" x2="${g.w - PADR}" y2="${g.h - PADB}"
                  stroke="${c.muted}" stroke-width="1"/>
            <line x1="${PADL}" y1="${PADT}" x2="${PADL}" y2="${g.h - PADB}"
                  stroke="${c.muted}" stroke-width="1"/>`;

    const unit = shown()[0]?.unit || '';
    const yLabel = ad.transform === 'value' ? unit
                 : ad.transform === 'increment' ? `${unit}/reading` : `${unit}/h`;
    if (yLabel) {
      out += `<text x="6" y="${PADT + 8}" font-size="10" fill="${c.muted}">${esc(yLabel)}</text>`;
    }
    if (nMark >= MARK_CAP) {
      out += `<text x="${g.w - PADR}" y="${PADT + 10}" font-size="10" text-anchor="end" fill="${c.muted}">
                marks capped at ${MARK_CAP} — zoom in for the rest</text>`;
    }
    svg.innerHTML = out;
  }

  // The overview is the whole record at a glance, with the visible window over
  // it — the thing that stops a deep zoom from feeling lost.
  function drawOv() {
    const svg = document.getElementById('ad-ov');
    if (!svg) return;
    const ex = extent();
    if (!ex) { svg.innerHTML = ''; return; }
    const c = theme();
    const w = ad.w, h = 56;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    const pw = w - PADL - PADR;
    const x = t => PADL + (t - ex.t0) / (ex.t1 - ex.t0) * pw;

    let lo = Infinity, hi = -Infinity;
    const vis = shown();
    for (const s of vis) {
      const track = tracks(s)[ad.mode === 'raw' ? 'raw' : 'filt'];
      for (let k = 0; k < track.n; k++) { const y = track.y[k]; if (y < lo) lo = y; if (y > hi) hi = y; }
    }
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (hi === lo) hi = lo + 1;
    const y = val => 6 + (1 - (val - lo) / (hi - lo)) * (h - 18);

    let out = `<rect x="0" y="0" width="${w}" height="${h}" fill="${c.panel}"/>`;
    for (const s of vis) {
      const track = tracks(s)[ad.mode === 'raw' ? 'raw' : 'filt'];
      const pts = densify(track, 0, track.n, x, pw);
      if (pts.length) {
        out += `<path d="${pathFrom(pts, y, false)}" fill="none" stroke="${escAttr(s.color)}"
                      stroke-width="1" opacity=".85"/>`;
      }
    }
    const v = view();
    const a = x(v.t0), b = x(v.t1);
    out += `<rect x="${PADL}" y="4" width="${Math.max(0, a - PADL).toFixed(1)}" height="${h - 16}"
                  fill="${c.muted}" opacity=".22"/>
            <rect x="${b.toFixed(1)}" y="4" width="${Math.max(0, w - PADR - b).toFixed(1)}" height="${h - 16}"
                  fill="${c.muted}" opacity=".22"/>
            <rect x="${a.toFixed(1)}" y="4" width="${Math.max(1, b - a).toFixed(1)}" height="${h - 16}"
                  fill="none" stroke="${c.accent}" stroke-width="1.4"/>
            <text x="${PADL - 6}" y="${h - 5}" font-size="9" text-anchor="end" fill="${c.muted}">whole record</text>
            <text x="${PADL}" y="${h - 5}" font-size="9" fill="${c.muted}">${esc(fmtFull(ex.t0).slice(0, 10))}</text>
            <text x="${w - PADR}" y="${h - 5}" font-size="9" text-anchor="end" fill="${c.muted}">${esc(fmtFull(ex.t1).slice(0, 10))}</text>`;
    svg.innerHTML = out;

    // Every view change redraws the overview, and nothing else does — which
    // makes this the one place the comparison panes can follow the window
    // without also being rebuilt on every mouse move.
    drawCompare();
  }

  // ── side-by-side comparison ────────────────────────────────────────────────

  const CMP_PADL = 46, CMP_PADR = 10, CMP_PADT = 10, CMP_PADB = 20;

  // Redrawing both panes on every mouse move would be work for nothing — the
  // crosshair does not reach them. This is what they actually depend on.
  let cmpSig = '';

  function drawCompare(force) {
    const box = document.getElementById('ad-compare');
    const a = document.getElementById('ad-cmp-raw');
    const b = document.getElementById('ad-cmp-filt');
    if (!box || !box.open || !a || !b) return;
    const vis = shown(), v = view();
    if (!vis.length || !v) { a.innerHTML = ''; b.innerHTML = ''; return; }

    const w = Math.max(240, Math.round(a.parentElement.getBoundingClientRect().width));
    const h = Math.round(Math.max(160, Math.min(300, w * 0.62)));
    const sig = [v.t0, v.t1, w, h, ad.transform, ad.chartType, ad.showRemoved, ad.showDupes,
                 ad.yMode, ad.yMin, ad.yMax,
                 cfgKey(ad.cfg, 'cmp'), vis.map(s => `${s.key}${s.color}${s.kind}`).join(',')].join('|');
    // The childNodes test matters: re-rendering the main column hands back a
    // pair of empty <svg>s whose inputs have not changed, and a signature check
    // on its own would leave them empty.
    if (!force && sig === cmpSig && a.childNodes.length) return;
    cmpSig = sig;

    // One scale across both panes. Let each pane fit its own data and the
    // filtered one would come out looking exactly like the raw one, which is
    // the opposite of what a comparison is for.
    //
    // Which scale is the toolbar's business, not a second control here: fitting
    // everything means one 2014 mm spike flattens the filtered pane into a
    // line, and "Kept" is already how you ask to see its shape instead — the
    // spikes then run off the top of the left-hand pane, which is a fair
    // description of them.
    let lo = Infinity, hi = -Infinity;
    for (const s of vis) {
      const tr = tracks(s);
      for (const track of ad.yMode === 'kept' ? [tr.filt] : [tr.raw, tr.filt]) {
        const i0 = Math.max(0, lower(track.t, track.n, v.t0) - 1);
        const i1 = Math.min(track.n, lower(track.t, track.n, v.t1) + 1);
        for (let k = i0; k < i1; k++) { const y = track.y[k]; if (y < lo) lo = y; if (y > hi) hi = y; }
      }
    }
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (ad.yMode === 'zero' && lo > 0) lo = 0;
    if (hi === lo) { hi = lo + 1; lo -= 1; }
    const pad = (hi - lo) * 0.06;
    let yr = { lo: lo - pad, hi: hi + pad };
    if (ad.yMode === 'manual') {
      const a = parseFloat(ad.yMin), b = parseFloat(ad.yMax);
      if (!isNaN(a) && !isNaN(b) && b > a) yr = { lo: a, hi: b };
    }

    const c = theme();
    for (const [svg, kind] of [[a, 'raw'], [b, 'filt']]) {
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      svg.setAttribute('width', w);
      svg.setAttribute('height', h);
      svg.innerHTML = cmpPane(kind, w, h, v, yr, c);
    }
  }

  function cmpPane(kind, w, h, v, yr, c) {
    const pw = w - CMP_PADL - CMP_PADR, ph = h - CMP_PADT - CMP_PADB;
    const x = t => CMP_PADL + (t - v.t0) / (v.t1 - v.t0) * pw;
    const y = val => CMP_PADT + (1 - (val - yr.lo) / (yr.hi - yr.lo)) * ph;
    const { ticks, step } = timeTicks(v.t0, v.t1, Math.max(2, Math.round(pw / 120)));
    const yt = niceTicks(yr.lo, yr.hi, Math.max(2, Math.round(ph / 44)));
    const clip = `ad-cmp-clip-${kind}`;

    let out = `<defs><clipPath id="${clip}"><rect x="${CMP_PADL}" y="${CMP_PADT}"
                 width="${pw}" height="${ph}"/></clipPath></defs>
               <rect x="0" y="0" width="${w}" height="${h}" fill="${c.panel}"/>`;

    out += yt.map(val => `
      <line x1="${CMP_PADL}" y1="${y(val).toFixed(1)}" x2="${w - CMP_PADR}" y2="${y(val).toFixed(1)}"
            stroke="${c.border}" stroke-width="1"/>
      <text x="${CMP_PADL - 5}" y="${(y(val) + 3.2).toFixed(1)}" font-size="9" text-anchor="end"
            fill="${c.muted}">${esc(fmtVal(val))}</text>`).join('');

    out += ticks.map(t => `
      <line x1="${x(t).toFixed(1)}" y1="${CMP_PADT}" x2="${x(t).toFixed(1)}" y2="${h - CMP_PADB}"
            stroke="${c.border}" stroke-width="1" opacity=".6"/>
      <text x="${x(t).toFixed(1)}" y="${h - CMP_PADB + 12}" font-size="9" text-anchor="middle"
            fill="${c.muted}">${esc(fmtTick(t, step))}</text>`).join('');

    let body = '';
    for (const s of shown()) {
      const track = kind === 'raw' ? tracks(s).raw : tracks(s).filt;
      const i0 = Math.max(0, lower(track.t, track.n, v.t0) - 1);
      const i1 = Math.min(track.n, lower(track.t, track.n, v.t1) + 1);
      const pts = densify(track, i0, i1, x, pw);
      if (pts.length) {
        body += `<path d="${pathFrom(pts, y, ad.chartType === 'step')}" fill="none"
                       stroke="${escAttr(s.color)}" stroke-width="1.4"
                       stroke-linejoin="round" stroke-linecap="round"/>`;
      }
      // The removals belong on the "as recorded" side: that pane is the record
      // they were removed from.
      if (kind === 'raw' && ad.transform === 'value') {
        const f = runFilter(s, ad.cfg);
        const j0 = lower(s.t, s.n, v.t0), j1 = lower(s.t, s.n, v.t1);
        let n = 0;
        for (let i = j0; i < j1 && n < 900; i++) {
          const st = f.status[i];
          if (st === AD_GOOD || (st === AD_OOS && !ad.showDupes)) continue;
          const px = x(s.t[i]), py = y(s.v[i]);
          if (py < CMP_PADT - 4 || py > h - CMP_PADB + 4) continue;
          n++;
          const col = st === AD_BAD ? c.bad : st === AD_OOS ? c.muted : c.warn;
          body += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="2.4" fill="none"
                           stroke="${col}" stroke-width="1.3" opacity=".9"><title>${esc(AD_STATUS_LABEL[st])}
                           · ${esc(fmtVal(s.v[i]))} ${esc(s.unit)}</title></circle>`;
        }
      }
    }
    out += `<g clip-path="url(#${clip})">${body}</g>`;
    out += `<line x1="${CMP_PADL}" y1="${h - CMP_PADB}" x2="${w - CMP_PADR}" y2="${h - CMP_PADB}"
                  stroke="${c.muted}" stroke-width="1"/>
            <line x1="${CMP_PADL}" y1="${CMP_PADT}" x2="${CMP_PADL}" y2="${h - CMP_PADB}"
                  stroke="${c.muted}" stroke-width="1"/>`;
    return out;
  }

  // ── interaction ────────────────────────────────────────────────────────────

  function localX(ev, el) {
    const r = el.getBoundingClientRect();
    return (ev.clientX - r.left) * (ad.w / r.width);
  }

  function hoverAt(px, py) {
    const g = geom();
    if (!g) return null;
    const t = g.tOf(px);
    const rows = [];
    for (const s of shown()) {
      for (const { track, kind } of layers(s)) {
        if (ad.mode === 'both' && kind === 'raw') continue;   // one row per series
        if (!track.n) continue;
        let k = lower(track.t, track.n, t);
        if (k >= track.n) k = track.n - 1;
        if (k > 0 && Math.abs(track.t[k - 1] - t) < Math.abs(track.t[k] - t)) k--;
        const i = track.ref[k];
        rows.push({
          key: s.key, label: s.label, color: s.color, unit: s.unit,
          t: track.t[k], y: track.y[k], i, k,
          q: s.qcodes[s.q[i]] || '',
          kindLabel: ad.mode === 'raw' ? 'raw' : 'kept',
          dist: Math.abs(g.x(track.t[k]) - px) + Math.abs(g.y(track.y[k]) - py) * 0.35,
        });
      }
    }
    rows.sort((a, b) => a.dist - b.dist);
    return { t, x: px, y: py, rows };
  }

  function showTip(ev) {
    const tip = document.getElementById('ad-tip');
    const stage = document.getElementById('ad-stage');
    if (!tip || !stage || !ad.hover || !ad.hover.rows.length) { if (tip) tip.hidden = true; return; }
    tip.innerHTML = `<div class="ad-tip-t">${esc(fmtFull(ad.hover.t))}</div>`
      + ad.hover.rows.slice(0, 6).map(r => `
        <div class="ad-tip-r"><span class="ad-dot" style="background:${escAttr(r.color)}"></span>
          ${esc(r.label)} <b>${esc(fmtVal(r.y))}</b> ${esc(r.unit)}</div>`).join('');
    const r = stage.getBoundingClientRect();
    const lx = ev.clientX - r.left, ly = ev.clientY - r.top;
    tip.hidden = false;
    tip.style.left = Math.min(r.width - tip.offsetWidth - 8, lx + 14) + 'px';
    tip.style.top  = Math.min(r.height - tip.offsetHeight - 8, ly + 14) + 'px';
  }

  function bind() {
    const stage = document.getElementById('ad-stage');
    const svg = document.getElementById('ad-svg');
    if (!stage || !svg) return;

    svg.onpointermove = ev => {
      const px = localX(ev, svg);
      const r = svg.getBoundingClientRect();
      const py = (ev.clientY - r.top) * (ad.h / r.height);
      if (ad.drag) {
        if (ad.drag.brush) { ad.drag.x1 = px; draw(); return; }
        const g = geom();
        if (!g) return;
        const dt = (ad.drag.px - px) / g.pw * (ad.drag.t1 - ad.drag.t0);
        ad.view = { t0: ad.drag.t0 + dt, t1: ad.drag.t1 + dt };
        draw(); drawOv();
        return;
      }
      ad.hover = hoverAt(px, py);
      draw();
      showTip(ev);
      renderReadout();
    };
    svg.onpointerleave = () => {
      ad.hover = null;
      const tip = document.getElementById('ad-tip');
      if (tip) tip.hidden = true;
      draw(); renderReadout();
    };
    svg.onpointerdown = ev => {
      const g = geom();
      if (!g) return;
      svg.setPointerCapture?.(ev.pointerId);
      const px = localX(ev, svg);
      ad.drag = { px, x0: px, x1: px, t0: g.v.t0, t1: g.v.t1, brush: ad.brush || ev.shiftKey, moved: false };
    };
    svg.onpointerup = ev => {
      const d = ad.drag;
      ad.drag = null;
      if (!d) return;
      const px = localX(ev, svg);
      const moved = Math.abs(px - d.x0) > 3;
      if (d.brush && moved) {
        const g = geom();
        const a = g.v.t0 + (Math.min(d.x0, px) - PADL) / g.pw * (g.v.t1 - g.v.t0);
        const b = g.v.t0 + (Math.max(d.x0, px) - PADL) / g.pw * (g.v.t1 - g.v.t0);
        if (b - a > 1000) ad.view = { t0: a, t1: b };
      } else if (!moved) {
        // A click pins the nearest reading, so it can be read in full and
        // its verdict explained.
        const r = svg.getBoundingClientRect();
        const py = (ev.clientY - r.top) * (ad.h / r.height);
        const h = hoverAt(px, py);
        if (h && h.rows.length) ad.pin = { key: h.rows[0].key, i: h.rows[0].i };
        else ad.pin = null;
      }
      draw(); drawOv(); renderReadout();
    };
    svg.addEventListener('wheel', ev => {
      ev.preventDefault();
      const g = geom();
      if (!g) return;
      const t = g.tOf(localX(ev, svg));
      const z = Math.exp(ev.deltaY * 0.0014);
      ad.view = { t0: t - (t - g.v.t0) * z, t1: t + (g.v.t1 - t) * z };
      draw(); drawOv(); renderReadout();
    }, { passive: false });
    svg.ondblclick = () => { ad.view = null; ad.pin = null; draw(); drawOv(); renderReadout(); };

    stage.onkeydown = ev => {
      const g = geom();
      if (!g) return;
      const span = g.v.t1 - g.v.t0;
      const pan = d => { ad.view = { t0: g.v.t0 + d, t1: g.v.t1 + d }; };
      const zoom = f => {
        const mid = (g.v.t0 + g.v.t1) / 2;
        ad.view = { t0: mid - span * f / 2, t1: mid + span * f / 2 };
      };
      switch (ev.key) {
        case 'ArrowLeft':  pan(-span * 0.2); break;
        case 'ArrowRight': pan(span * 0.2);  break;
        case '+': case '=': zoom(0.6); break;
        case '-': case '_': zoom(1.7); break;
        case '0': ad.view = null; break;
        case 'Escape': ad.pin = null; break;
        default: return;
      }
      ev.preventDefault();
      draw(); drawOv(); renderReadout();
    };

    // Overview: drag anywhere on it to centre the window there.
    const ov = document.getElementById('ad-ov');
    if (ov) {
      const jump = ev => {
        const ex = extent();
        if (!ex) return;
        const r = ov.getBoundingClientRect();
        const px = (ev.clientX - r.left) * (ad.w / r.width);
        const t = ex.t0 + (px - PADL) / (ad.w - PADL - PADR) * (ex.t1 - ex.t0);
        const v = view();
        const half = (v.t1 - v.t0) / 2;
        ad.view = { t0: t - half, t1: t + half };
        draw(); drawOv(); renderReadout();
      };
      ov.onpointerdown = ev => { ov.setPointerCapture?.(ev.pointerId); ad.ovDrag = true; jump(ev); };
      ov.onpointermove = ev => { if (ad.ovDrag) jump(ev); };
      ov.onpointerup = () => { ad.ovDrag = false; };
      ov.onpointerleave = () => { ad.ovDrag = false; };
    }

    const drop = document.getElementById('ad-drop');
    if (drop) {
      for (const e of ['dragover', 'dragenter']) {
        drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.add('ad-drop--active'); });
      }
      for (const e of ['dragleave', 'drop']) {
        drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.remove('ad-drop--active'); });
      }
      drop.addEventListener('drop', ev => importFiles(ev.dataTransfer && ev.dataTransfer.files));
    }
  }

  function init() {
    if (ad.ro) { ad.ro.disconnect(); ad.ro = null; }
    measure();
    bind();
    draw();
    drawOv();
    const stage = document.getElementById('ad-stage');
    if (stage && typeof ResizeObserver !== 'undefined') {
      // The comparison panes size themselves off their own column, which the
      // stage's width tracks, so one observer serves both.
      ad.ro = new ResizeObserver(() => { if (measure()) { draw(); drawOv(); } });
      ad.ro.observe(stage);
    }
  }

  function stop() { if (ad.ro) { ad.ro.disconnect(); ad.ro = null; } }

  function renderAll() {
    const side = document.getElementById('ad-side');
    const main = document.querySelector('.ad-main');
    if (!side || !main) { renderMain(); return; }
    side.innerHTML = sideHtml();
    main.innerHTML = mainHtml();
    init();
  }
  function renderSide() {
    const side = document.getElementById('ad-side');
    if (side) side.innerHTML = sideHtml();
    bind();
  }
  function renderReadout() {
    const el = document.getElementById('ad-readout');
    if (el) el.innerHTML = readoutHtml();
  }
  // Config and visibility changes invalidate the drawn curves but not the page.
  function redraw(sideToo) {
    for (const s of ad.series) s.tracks = null;
    if (sideToo) renderSide();
    draw(); drawOv(); renderReadout();
  }

  // ── handlers ───────────────────────────────────────────────────────────────

  const find = key => ad.series.find(s => s.key === key);

  function pick(input) { importFiles(input.files); input.value = ''; }

  function toggle(key) { const s = find(key); if (s) { s.visible = !s.visible; redraw(true); } }
  function setColor(key, v) { const s = find(key); if (s) { s.color = v; draw(); drawOv(); } }
  function setKind(key, v) { const s = find(key); if (s) { s.kind = v; s.filt = null; s.tracks = null; redraw(true); } }
  function solo(key) { ad.series.forEach(s => { s.visible = s.key === key; }); redraw(true); }
  function zoomTo(key) {
    const s = find(key);
    if (!s || !s.n) return;
    ad.view = { t0: s.t[0], t1: s.t[s.n - 1] };
    draw(); drawOv(); renderReadout();
  }
  function remove(key) {
    ad.series = ad.series.filter(s => s.key !== key);
    if (ad.pin && ad.pin.key === key) ad.pin = null;
    ad.view = null;
    renderAll();
  }
  function clearAll() {
    if (ad.series.length > 1 && !confirm(`Remove all ${ad.series.length} imports?`)) return;
    ad.series = []; ad.pin = null; ad.hover = null; ad.view = null;
    renderAll();
  }
  function showStation(id) {
    state.selectedId = id;
    state.activeTab = 'stations';
    renderTabs();
    renderMain();
  }

  // The two range limits are the only settings where blank is itself a value —
  // "no limit" — so they are kept as typed instead of being coerced to 0.
  const AD_BLANKABLE = new Set(['rangeMin', 'rangeMax']);

  function setCfg(k, v) {
    ad.cfg[k] = typeof v === 'boolean' ? v
      : AD_BLANKABLE.has(k) ? (isFinite(parseFloat(v)) ? parseFloat(v) : '')
      : (parseFloat(v) || 0);
    for (const s of ad.series) { s.filt = null; s.tracks = null; }
    redraw(true);
  }
  function resetCfg() {
    ad.cfg = { ...AD_CFG_DEFAULT };
    for (const s of ad.series) { s.filt = null; s.tracks = null; }
    redraw(true);
  }

  function setMode(v)      { ad.mode = v; renderMainOnly(); }
  function setTransform(v) { ad.transform = v; for (const s of ad.series) s.tracks = null; renderMainOnly(); }
  function setChart(v)     { ad.chartType = v; renderMainOnly(); }
  function setY(v)         { ad.yMode = v; renderMainOnly(); }
  function setYRange(which, v) { if (which === 'min') ad.yMin = v; else ad.yMax = v; draw(); }
  function setFlag(k, v)   { ad[k] = v; renderMainOnly(); }
  function unpin()         { ad.pin = null; draw(); renderReadout(); }

  // <details> reports its own state, so this only has to remember it across
  // re-renders and draw the panes the first time they are actually on screen.
  function compareToggle(el) {
    ad.compare = !!el.open;
    if (ad.compare) drawCompare(true);
  }

  function renderMainOnly() {
    const main = document.querySelector('.ad-main');
    if (!main) return;
    main.innerHTML = mainHtml();
    init();
  }

  function preset(k) {
    const ex = extent();
    if (!ex) return;
    if (k === 'all') ad.view = null;
    else {
      const days = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 }[k] || 1;
      ad.view = { t0: ex.t1 - days * AD_DAY, t1: ex.t1 };
    }
    draw(); drawOv(); renderReadout();
  }

  // ── export ─────────────────────────────────────────────────────────────────

  function exportCsv(which) {
    const vis = shown();
    if (!vis.length) { note('Nothing to export — no series is shown.', true); return; }
    const multi = vis.length > 1;
    const head = ['Reading', 'Receive', 'Value', 'Unit', 'Data Quality', 'Raw Value', 'Adjusted Value'];
    if (which === 'all') head.push('Filter Status');
    if (multi) head.unshift('Series', 'Sensor Id');

    const lines = [head.join(',')];
    let rows = 0;
    for (const s of vis) {
      const f = runFilter(s, ad.cfg);
      for (let i = 0; i < s.n; i++) {
        if (which === 'kept' && f.status[i] !== AD_GOOD) continue;
        const r = [fmtFull(s.t[i]), fmtFull(s.tr[i]), s.v[i], s.unit,
                   s.qcodes[s.q[i]] || '', s.raw[i], f.adj[i]];
        if (which === 'all') r.push(AD_STATUS_LABEL[f.status[i]]);
        if (multi) r.unshift(s.label, s.sensorId || '');
        lines.push(r.map(csvEscape).join(','));
        rows++;
      }
    }
    const base = multi ? 'arro_export' : slug(vis[0].label) || 'arro_export';
    dlText(`${base}_${which === 'kept' ? '357filtered' : 'verdict'}.csv`, lines.join('\n'));
    note(`Exported ${rows.toLocaleString()} rows.`);
  }

  function exportImg(fmt) {
    const svg = document.getElementById('ad-svg');
    if (!svg) return;
    const clone = svg.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const text = new XMLSerializer().serializeToString(clone);
    if (fmt === 'svg') {
      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' })),
        download: 'arro-chart.svg',
      });
      a.click();
      URL.revokeObjectURL(a.href);
      return;
    }
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = ad.w * scale; canvas.height = ad.h * scale;
    const img = new Image();
    img.onload = () => {
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      canvas.toBlob(b => {
        if (!b) { note('The browser would not render the chart to PNG — the SVG download works.', true); return; }
        const a = Object.assign(document.createElement('a'), {
          href: URL.createObjectURL(b), download: 'arro-chart.png',
        });
        a.click();
        URL.revokeObjectURL(a.href);
      });
    };
    img.onerror = () => note('The browser would not render the chart to PNG — the SVG download works.', true);
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
  }

  // Called on a theme change, where every colour in both panes is now wrong —
  // so the comparison redraws whether or not its inputs moved.
  function repaint() { draw(); drawOv(); drawCompare(true); }

  return {
    ad, render, init, stop, repaint, importFiles, pick,
    toggle, setColor, setKind, solo, zoomTo, remove, clearAll, showStation,
    setCfg, resetCfg, setMode, setTransform, setChart, setY, setYRange, setFlag,
    preset, unpin, exportCsv, exportImg, explain, compareToggle,
    // exposed for reasoning about the filter outside the UI
    parseCsv, parseName, linkStation, guessKind, runFilter, walk357,
  };
})();
if (typeof window !== 'undefined') window.ArroData = ArroData;

// ── Datastore status ───────────────────────────────────────────────────────────
// The whole client, for now: one timed GET of the smallest row in the database,
// so "is the datastore reachable from a browser, and is it the shape this app
// expects" has an answer on screen rather than in somebody's head.

// Reads meganet.app_meta.schema_version. Returns a result object rather than
// throwing, because every caller wants to render the failure, not catch it:
//   { ok:true,  ms, version }
//   { ok:false, ms, error }
async function dbPing() {
  const t0 = _dbClock();
  const url = `${DB_URL}/app_meta?select=value&key=eq.schema_version`;
  try {
    const res = await fetch(url, {
      headers: {
        apikey: DB_ANON_KEY,
        'Accept-Profile': DB_SCHEMA,
        // Exactly one row, as an object rather than a one-element array. If the
        // version row is missing or duplicated PostgREST says so with a 406,
        // which is a better answer than quietly reading undefined.
        Accept: 'application/vnd.pgrst.object+json',
      },
      cache: 'no-store',
    });
    const ms = Math.round(_dbClock() - t0);

    if (!res.ok) {
      // PostgREST reports failures as JSON — {message, hint, code}. A proxy, or
      // a project paused for inactivity, may answer with something else, so the
      // status line is the fallback rather than the parse being assumed.
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body && body.message) {
          detail = body.message + (body.hint ? ` — ${body.hint}` : '');
        }
      } catch (_) { /* not JSON; the status line stands */ }
      return { ok: false, ms, error: detail };
    }

    const row = await res.json();
    const version = Number(row && row.value);
    return { ok: true, ms, version: Number.isFinite(version) ? version : null };
  } catch (e) {
    // fetch() rejects the same way for DNS failure, TLS failure, CORS refusal
    // and no network at all, and the browser deliberately does not say which.
    // So report what is actually known rather than guessing a cause.
    return { ok: false, ms: Math.round(_dbClock() - t0), error: `unreachable — ${e && e.message || e}` };
  }
}

// Run a check and repaint the panel around it — once for "checking", once for
// the result. Repaints the status node alone, not the tab: the Export tab's
// checkboxes are DOM state, and redrawing them under the operator would reset
// the very selection they had just made.
async function dbCheck() {
  state.dbStatus = { checking: true };
  dbRepaintStatus();
  state.dbStatus = await dbPing();
  dbRepaintStatus();
}

function dbRepaintStatus() {
  const el = document.getElementById('db-status');
  if (el) el.innerHTML = renderDbStatusHtml();
}

// What is loaded, as opposed to what is reachable. These are different questions
// and conflating them is how a stale file passes for the database: the
// connection can be perfectly healthy while the station list on screen came from
// a file, because the fallback ran before the project woke up.
function renderLoadedSourceHtml() {
  const src = state.dataSource;
  if (!src) return '';

  const live = src.kind === 'api';
  const colour = live ? 'var(--ok)' : 'var(--warn)';
  const bits = [];
  if (src.ms != null) bits.push(`${src.ms} ms`);
  if (src.dated) bits.push(`data dated ${esc(src.dated)}`);
  bits.push(`loaded ${src.at.toLocaleTimeString()}`);

  return `
    <div style="margin-bottom:.5rem;padding-bottom:.5rem;border-bottom:1px solid var(--line)">
      <div style="color:${colour}">
        <strong>Showing ${esc(SOURCE_LABELS[src.kind] || src.kind)}</strong>
      </div>
      <div class="small" style="margin-top:.25rem">${bits.join(' · ')}</div>
      ${!live && state.loadError
        ? `<div class="small" style="margin-top:.25rem;color:var(--warn)">
             fell back — ${esc(state.loadError)}
           </div>`
        : ''}
      ${!live
        ? `<button onclick="reloadFromDatastore()" style="padding:.25rem .5rem;font-size:.8rem;margin-top:.4rem">
             Load from the datastore
           </button>`
        : ''}
    </div>`;
}

// Retry the datastore by hand after a fallback — the obvious thing to want when
// the panel has just told you it is showing a file. Announces its failure,
// unlike the automatic attempt: this one was asked for.
async function reloadFromDatastore() {
  if (await loadFromApi({ announce: true })) dbCheck();
  else dbRepaintStatus();
}

// Who the database thinks is asking. This panel is where "what am I connected
// to" is answered, and "as whom" is half of that question — a read that works
// and a write that will not is otherwise indistinguishable from here.
function authLineHtml() {
  if (!Auth.isSignedIn()) {
    return `<div class="small" style="margin-top:.2rem;color:var(--muted)">
      Reading anonymously — <a href="#" onclick="Auth.open();return false">sign in</a> to edit.</div>`;
  }
  const email = Auth.email();
  const ok    = Auth.mayWrite();
  return `<div class="small" style="margin-top:.2rem;color:${ok ? 'var(--ok)' : 'var(--warn)'}">
    Signed in${email ? ` as ${esc(email)}` : ''}${Auth.role() ? ` (${esc(Auth.role())})` : ''} —
    ${ok ? 'edits will be saved and attributed' : 'not on the editors list, so edits will be refused'}.</div>`;
}

function renderDbStatusHtml() {
  const s = state.dbStatus;
  const loaded = renderLoadedSourceHtml();
  const host = `<div class="small" style="margin-top:.35rem">${esc(dbHostLabel())}</div>${authLineHtml()}`;

  if (!s || s.checking) {
    return `${loaded}<div class="small">Checking…</div>${host}`;
  }

  if (!s.ok) {
    return `
      ${loaded}
      <div style="color:var(--bad)"><strong>Not connected</strong></div>
      <div class="small" style="margin-top:.25rem;color:var(--bad)">${esc(s.error)}</div>
      ${host}`;
  }

  // Connected, but against a database that is not the one this build was written
  // against. Worth its own colour: everything still reads, and will keep reading
  // wrongly, until one side or the other is brought up to date.
  if (s.version !== DB_SCHEMA_VERSION) {
    const older = s.version != null && s.version < DB_SCHEMA_VERSION;
    return `
      <div style="color:var(--warn)"><strong>Connected · schema mismatch</strong></div>
      <div class="small" style="margin-top:.25rem;color:var(--warn)">
        database is v${esc(s.version ?? '?')}, this app expects v${DB_SCHEMA_VERSION} —
        ${older ? 'apply the newer migrations in db/migrations/' : 'this copy of the app is out of date'}
      </div>
      <div class="small" style="margin-top:.25rem">${s.ms} ms round trip</div>
      ${host}`;
  }

  return `
    <div style="color:var(--ok)"><strong>Connected · schema v${s.version} · ${s.ms} ms</strong></div>
    ${host}`;
}

// First visit to the tab checks; after that the panel holds what it found until
// Re-test is pressed, so flipping between tabs is not a stream of requests.
function initExport() {
  if (!state.dbStatus) dbCheck();
}

// ── stations.json, from the database ───────────────────────────────────────────
// The escape hatch, kept deliberately. stations.json is the offline copy, the
// backup, and the thing that gets handed to whoever inherits this — and since
// #B3 the database is where edits land, so the file has to be refreshable from
// it rather than left to drift into fiction.
//
// This fetches the document fresh rather than serialising what is in memory: the
// point is a snapshot of the database as it is now, which is not necessarily
// what this tab loaded twenty minutes and three edits ago.
//
// The file committed in the repo is refreshed by .github/workflows/
// stations-snapshot.yml, which runs tools/snapshot_stations_json.py weekly and
// opens a PR. This button is the same snapshot by hand, for the operator who
// wants a copy on a USB stick before going somewhere without a network.
async function snapshotStationsJson() {
  const btn = document.getElementById('btn-snapshot');
  const say = (text, colour) => {
    const el = document.getElementById('snapshot-note');
    if (el) el.innerHTML = `<span style="color:${colour || 'var(--muted)'}">${esc(text)}</span>`;
  };

  if (btn) btn.disabled = true;
  say('Fetching the current document…');
  try {
    const res = await fetch(`${DB_URL}/rpc/stations_doc`, {
      headers: {
        apikey: DB_ANON_KEY,
        'Accept-Profile': DB_SCHEMA,
        Accept: 'application/json',
      },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const doc  = JSON.parse(text);
    if (!Array.isArray(doc.stations)) throw new Error('that is not a stations document');
    // Indented, because a 3.6 MB single line is not something a human can read
    // or a diff can show. The committed file is produced the same way.
    dlText('stations.json', JSON.stringify(doc, null, 2) + '\n');
    say(`Downloaded ${doc.stations.length.toLocaleString()} stations, as at ${new Date().toLocaleString()}.`,
        'var(--ok)');
  } catch (err) {
    say(`Could not snapshot the database — ${err && err.message || err}`, 'var(--bad)');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── EXPORT tab ─────────────────────────────────────────────────────────────────

function renderExportHtml() {
  const nets = state.data.radio_networks || [];
  if (!state.exportNets) state.exportNets = new Set(nets.map(n => n.id));

  const selRpts = state.data.stations.filter(s =>
    s.roles.includes('repeater') && s.repeater &&
    s.radio_network_ids.some(id => state.exportNets.has(id))
  );
  const unitCount = countExportUnits(state.exportNets);

  return `
    <div class="layout">
      <aside class="sidebar stack">
        <div class="panel">
          <div class="panel-header">
            <h3>BoM Networks</h3>
            <span>
              <button onclick="exportSelectAll(true)" style="padding:.25rem .5rem;font-size:.8rem">All</button>
              <button onclick="exportSelectAll(false)" style="padding:.25rem .5rem;font-size:.8rem">None</button>
            </span>
          </div>
          <div class="checklist">
            ${nets.map(n => `
              <label>
                <input type="checkbox" ${state.exportNets.has(n.id) ? 'checked' : ''}
                       onchange="toggleExportNet('${n.id}',this.checked)">
                ${esc(n.name)}
              </label>`).join('')}
          </div>
        </div>
        <div class="panel">
          <div class="small" style="color:var(--muted)">
            <strong>${selRpts.length}</strong> repeater${selRpts.length !== 1 ? 's' : ''} selected<br>
            <strong>${unitCount}</strong> total units in export
          </div>
        </div>

        <!-- The station list itself now comes from the datastore, so this panel
             answers two questions rather than one: what is on screen, and
             whether the database is reachable. They can disagree — a healthy
             connection under a station list that fell back to a file is exactly
             the case worth being able to see. -->
        <div class="panel">
          <div class="panel-header">
            <h3>Data source</h3>
            <button onclick="dbCheck()" style="padding:.25rem .5rem;font-size:.8rem">Re-test</button>
          </div>
          <div id="db-status">${renderDbStatusHtml()}</div>
        </div>

        <!-- The JSON escape hatch. Edits land in the database now, so the file
             has to be refreshable from it — see snapshotStationsJson(). -->
        <div class="panel">
          <div class="panel-header">
            <h3>stations.json</h3>
            <button id="btn-snapshot" onclick="snapshotStationsJson()"
                    style="padding:.25rem .5rem;font-size:.8rem"
                    title="Download the database's current station list as stations.json">Snapshot</button>
          </div>
          <div class="small" style="color:var(--muted)">
            The whole station list as a file — the offline copy, and what this app
            falls back to when the datastore cannot be reached. Taken from the
            database as it is right now, not from what this tab has loaded.
          </div>
          <div id="snapshot-note" class="small" style="margin-top:.35rem"></div>
        </div>
      </aside>

      <div>
        <div class="panel stack" style="gap:.75rem">
          <div class="panel-header">
            <h2>Radio Mobile Export</h2>
            <button class="primary" onclick="runExport()">Generate &amp; Download All</button>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>File</th><th>Contents</th></tr></thead>
              <tbody>
                <tr><td><code>MegaNet.csv</code></td>        <td class="small">Master config — version, map/land paths, $Include list</td></tr>
                <tr><td><code>MegaNet_Network.csv</code></td><td class="small">One row per selected repeater, propagation parameters</td></tr>
                <tr><td><code>MegaNet_Unit.csv</code></td>   <td class="small">All units (repeaters + pass-range matched field stations)</td></tr>
                <tr><td><code>MegaNet_System.csv</code></td> <td class="small">Transmitter/receiver system specs</td></tr>
                <tr><td><code>MegaNet_NetData.csv</code></td><td class="small">Network membership matrix (heights, system IDs, roles)</td></tr>
              </tbody>
            </table>
          </div>
          <div class="note compact">
            RM paths from <code>meta.rm_paths</code>:
            <code>${esc((state.data.meta?.rm_paths?.map) || 'not set')}</code>
          </div>
        </div>

        <div class="panel" style="margin-top:1rem">
          <div class="panel-header"><h2>Selected Repeaters</h2></div>
          <div class="table-wrap medium">
            <table>
              <colgroup>
                <col style="width:28%"><col style="width:20%"><col style="width:13%">
                <col style="width:13%"><col style="width:26%">
              </colgroup>
              <thead><tr><th>Repeater</th><th>Network</th><th>Rx (MHz)</th><th>Tx (MHz)</th><th>Pass ranges</th></tr></thead>
              <tbody>
                ${selRpts.map(r => `
                  <tr>
                    <td>${esc(r.name)}</td>
                    <td class="small">${r.radio_network_ids.map(id => netName(id)).join(', ')}</td>
                    <td class="rx-cell small">${r.repeater.rx_mhz || ''}</td>
                    <td class="tx-cell small">${r.repeater.tx_mhz || ''}</td>
                    <td class="small">${(r.repeater.pass_ranges || []).map(p => `${p.low}–${p.high}`).join(', ')}${
                      repeaterPassingCount(r) != null
                        ? ` <span class="badge" title="ALERT addresses carried, post-exclusion">passing ${repeaterPassingCount(r)}</span>`
                        : ''}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>`;
}

function toggleExportNet(id, checked) {
  if (checked) state.exportNets.add(id); else state.exportNets.delete(id);
  document.getElementById('main-content').innerHTML = renderExportHtml();
}

function exportSelectAll(v) {
  state.exportNets = v
    ? new Set((state.data.radio_networks || []).map(n => n.id))
    : new Set();
  document.getElementById('main-content').innerHTML = renderExportHtml();
}

function countExportUnits(selectedNets) {
  const rpts = state.data.stations.filter(s =>
    s.roles.includes('repeater') && s.repeater &&
    s.radio_network_ids.some(id => selectedNets.has(id))
  );
  const ids = new Set(rpts.map(s => s.id));
  rpts.forEach(r => findStationMatches(r).forEach(s => ids.add(s.id)));
  return ids.size;
}

function runExport() {
  const { data, exportNets } = state;
  const paths   = data.meta?.rm_paths || {};
  const systems = data.rm_systems || [];
  const all     = data.stations;

  const repeaters = all.filter(s =>
    s.roles.includes('repeater') && s.repeater &&
    s.radio_network_ids.some(id => exportNets.has(id))
  );

  // Collect all units: repeaters + their matched field stations
  const unitMap = new Map();
  repeaters.forEach(r => {
    unitMap.set(r.id, r);
    findStationMatches(r).forEach(s => unitMap.set(s.id, s));
  });
  const units    = [...unitMap.values()];
  const unitRmId = new Map(units.map((u, i) => [u.id, i + 1]));

  // MegaNet.csv
  const megaNetCsv = [
    'Radio Mobile', '$Version', '4000', '","',
    '$Map', paths.map || '', '$Picture', paths.jpg || '', paths.jpg || '',
    '$Land', paths.land || '',
    '$Include', 'MegaNet_Network.csv', 'MegaNet_Unit.csv', 'MegaNet_System.csv', 'MegaNet_NetData.csv',
  ].join('\n');

  // MegaNet_Network.csv
  const d = RM_NET_DEFAULTS;
  const networkCsv = [
    'Radio Mobile', '$Style', 'Prop mode,Color 1,Color 2,Color 3', '0,38,40,81',
    '$Coverage',
    'AntAzt,Area,Color area,Contour,Color contour,D min,D max,Azt min,Azt max,Azt inc,Threshold mode,Visual color,Sensor h,Target h',
    '0,1,FFFF,1,0,0.01,50,0,360,1,1,FFFF,2,2',
    '$Net', `Nbr nets,Nbr units,Nbr systems`, `${repeaters.length},${units.length},${Math.max(systems.length, 2)}`,
    'Net ID,Net name,Visible,Minimum fx,Max Fx,Refractivity,Conductivity,Permittivity,Polarization,Climate,Stat. mode,%Time,%Location,%Situation,Topology,Max Rebro,%Urban or Tree',
    ...repeaters.map((r, i) => [
      i + 1, csvEscape(r.name), d.Visible, d['Minimum fx'], d['Max Fx'], d.Refractivity,
      d.Conductivity, d.Permittivity, d.Polarization, d.Climate, d['Stat. mode'],
      d['%Time'], d['%Location'], d['%Situation'], d.Topology, d['Max Rebro'], d['%Urban or Tree'],
    ].join(',')),
  ].join('\n');

  // MegaNet_Unit.csv
  const unitCsv = [
    'Unit ID,Unit name,Enabled,Latitude,Longitude,Elevation,Icon,Forecolor,Style,Backcolor,Text,Locked',
    ...units.map(u => {
      const isRpt = u.roles.includes('repeater');
      const aids  = stationAlertIds(u);
      return [
        unitRmId.get(u.id), csvEscape(u.name), u.enabled ? 1 : 0,
        u.lat ?? '', u.lon ?? '', u.elevation_ahd ?? 0,
        isRpt ? 307 : 243, 'FFFFFF', isRpt ? 0 : 1, 0,
        aids.length ? aids[0].toFixed(1) : '', 0,
      ].join(',');
    }),
  ].join('\n');

  // MegaNet_System.csv
  const sysDefs = systems.length ? systems : [
    { id: 1, name: 'Field Station 1W', tx_power_w: 1, line_loss_db: 1, supp_loss_db_m: 0, antenna_type: 'omni.ant', antenna_gain_dbi: 5.15, antenna_height_m: 4, rx_threshold_dbm: -117.001 },
    { id: 2, name: 'Field Station 5W', tx_power_w: 5, line_loss_db: 1, supp_loss_db_m: 0, antenna_type: 'omni.ant', antenna_gain_dbi: 5.15, antenna_height_m: 2, rx_threshold_dbm: -117.001 },
  ];
  const systemCsv = [
    'Radio Mobile', '$System',
    'System ID,System name,Tx power(W),Line loss(dB),Supplemental Line loss(dB/m),Antenna type,Antenna gain(dBi),Antenna height(m),Rx threshold(dBm)',
    ...sysDefs.map(s => [
      s.id, csvEscape(s.name), s.tx_power_w ?? '', s.line_loss_db ?? '', s.supp_loss_db_m ?? 0,
      s.antenna_type || 'omni.ant', s.antenna_gain_dbi ?? '', s.antenna_height_m ?? '', s.rx_threshold_dbm ?? '',
    ].join(',')),
  ].join('\n');

  // MegaNet_NetData.csv
  // For each repeater row: which units are in its network (1 = repeater itself, 2 = matched field stations)
  const unitIds = units.map(u => u.id);

  function netSection(tag, cellFn) {
    const header = ['', ...units.map(u => csvEscape(u.name))].join(',');
    const rows   = repeaters.map(r => {
      const matched = new Set(findStationMatches(r).map(s => s.id));
      return [csvEscape(r.name), ...unitIds.map(uid => {
        if (uid === r.id)      return cellFn(true,  false);
        if (matched.has(uid))  return cellFn(false, true);
        return 0;
      })].join(',');
    });
    return [tag, header, ...rows].join('\n');
  }

  const netDataCsv = [
    netSection('$NetAntHeight', (isRpt, isFld) => isRpt ? 2 : 4),
    netSection('$NetAntAzt',    (isRpt, isFld) => 0),
    netSection('$NetAntElv',    (isRpt, isFld) => 0),
    netSection('$NetSystem',    (isRpt, isFld) => 1),
    netSection('$NetRole',      (isRpt, isFld) => isRpt ? 1 : 2),
  ].join('\n');

  [
    ['MegaNet.csv',         megaNetCsv ],
    ['MegaNet_Network.csv', networkCsv ],
    ['MegaNet_Unit.csv',    unitCsv    ],
    ['MegaNet_System.csv',  systemCsv  ],
    ['MegaNet_NetData.csv', netDataCsv ],
  ].forEach(([name, content], i) => {
    setTimeout(() => dlText(name, content), i * 180);
  });
}

// ── Datastore writes ───────────────────────────────────────────────────────────
// The other direction. Reads are a GET anyone may make; a write has to say who
// is making it, arrives at exactly two functions, and can be refused — so this
// is a little more than fetch().
//
// Everything goes through meganet.save_station() and meganet.delete_station()
// rather than at the tables, because a station is a row plus its sensors plus
// its repeater plus that repeater's pass ranges, and those have to land together
// or not at all. The database enforces that by being the only thing granted the
// write verbs; see db/migrations/0004_station_writes.sql.

// The access token for the signed-in session, when there is one. #B8 owns
// getting one — verified @bom.gov.au, allowlist for everyone else — and calls
// dbSetAccessToken() with it. Until that lands this is null, every write goes
// out as `anon`, and the database refuses it. That is the write path working
// correctly, not a bug: the gate is server-side, so it does not matter that the
// browser has no sign-in screen yet.
//
// sessionStorage rather than localStorage: a token outliving the tab it was
// obtained in is a token left on a shared machine.
const DB_TOKEN_KEY = 'meganet.access_token';

let _dbToken = (() => {
  try { return sessionStorage.getItem(DB_TOKEN_KEY) || null; } catch (_) { return null; }
})();

function dbSetAccessToken(token) {
  _dbToken = token || null;
  try {
    if (_dbToken) sessionStorage.setItem(DB_TOKEN_KEY, _dbToken);
    else sessionStorage.removeItem(DB_TOKEN_KEY);
  } catch (_) { /* private mode; the token stays in memory for this page */ }
  return dbCanWrite();
}

// Whether this browser holds anything worth sending. Deliberately not a
// permission check — the database decides that, and this only decides whether
// the editor says "sign in first" before spending a round trip finding out.
function dbCanWrite() { return !!_dbToken; }

if (typeof window !== 'undefined') window.dbSetAccessToken = dbSetAccessToken;

// POST to a PostgREST function, with the errors turned into something the caller
// can branch on rather than a string to be pattern-matched:
//
//   err.conflict  somebody else changed the row first (HTTP 409, SQLSTATE PT409)
//   err.denied    not signed in, or signed in as somebody who may not write
//
// PostgREST answers 404 for a function the current role has no EXECUTE on, which
// reads as "no such thing" but means "not for you" — anon holds no grant on
// either of these, so that is the shape a signed-out save comes back in.
async function dbRpc(fn, args) {
  const res = await fetch(`${DB_URL}/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: DB_ANON_KEY,
      // Only when there is one. The publishable key is not a token, and offering
      // it as a bearer would get "invalid JWT" back instead of the honest
      // answer, which is that this request is anonymous.
      ...(_dbToken ? { Authorization: `Bearer ${_dbToken}` } : {}),
      'Content-Profile': DB_SCHEMA,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(args),
    cache: 'no-store',
  });

  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }

  if (!res.ok) {
    const message = (body && (body.message || body.error_description))
      || `HTTP ${res.status}`;
    const err = new Error(body && body.hint ? `${message} — ${body.hint}` : message);
    err.status   = res.status;
    err.conflict = res.status === 409;
    err.denied   = res.status === 401 || res.status === 403 || res.status === 404;
    throw err;
  }
  return body;
}

// The version stamp the editor is holding. Two columns rather than one because
// "deleted while you had it open" is worth telling the operator before they type
// for ten minutes into a form that cannot be saved.
async function dbStationStamp(id) {
  const url = `${DB_URL}/station?id=eq.${encodeURIComponent(id)}&select=updated_at,deleted_at`;
  const res = await fetch(url, {
    headers: {
      apikey: DB_ANON_KEY,
      ...(_dbToken ? { Authorization: `Bearer ${_dbToken}` } : {}),
      'Accept-Profile': DB_SCHEMA,
      Accept: 'application/vnd.pgrst.object+json',
    },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function dbSaveStation(doc, expectedUpdatedAt) {
  return dbRpc('save_station', {
    p_doc: doc,
    p_expected_updated_at: expectedUpdatedAt || null,
  });
}

function dbDeleteStation(id, expectedUpdatedAt) {
  return dbRpc('delete_station', {
    p_id: id,
    p_expected_updated_at: expectedUpdatedAt || null,
  });
}

// Pull the stamp for the station just opened, in the background. Nothing waits
// on it — the operator starts typing immediately — but a save that arrives
// before it does is refused by the database rather than guessed at, which is the
// safe half of that race.
async function fetchEditorStamp(id) {
  state.editorStamp    = null;
  state.editorStampFor = id;
  if (!id) return;
  try {
    const row = await dbStationStamp(id);
    if (state.editorStampFor !== id) return;   // the operator moved on
    state.editorStamp = row && row.updated_at;
    if (row && row.deleted_at) {
      setEditorStatus({ kind: 'error', text: 'This station has been deleted in the database. Saving will bring it back.' });
    }
  } catch (_) {
    // Left null. The save will be refused with a message that says to reload,
    // which is the truthful answer: this editor cannot prove what it started
    // from.
    if (state.editorStampFor === id) state.editorStamp = null;
  }
}

// The editor's own status line. Repainted on its own so a failed save can say
// why without redrawing the form underneath it and throwing away the typing
// that is the entire thing being protected.
function setEditorStatus(msg) {
  state.editorMsg = msg;
  const el = document.getElementById('ef-status');
  if (el) el.innerHTML = editorStatusHtml();
}

function editorStatusHtml() {
  const m = state.editorMsg;
  if (m) {
    const colour = m.kind === 'error' ? 'var(--bad)'
                 : m.kind === 'ok'    ? 'var(--ok)'
                 : 'var(--muted)';
    return `<span style="color:${colour}">${esc(m.text)}</span>`;
  }
  // Nothing has happened yet, so say what will happen when Save is pressed —
  // which is different depending on where the list on screen came from and
  // whether this browser holds a session.
  if (!editorWritesGoToDatabase()) {
    return `<span style="color:var(--warn)">Showing ${esc(SOURCE_LABELS[state.dataSource?.kind] || 'a file')} rather than the datastore —
      <a href="#" onclick="reloadFromDatastore();return false">load from the datastore</a> before editing,
      or Save would write what is on screen over whatever the database now holds.</span>`;
  }
  if (!dbCanWrite()) {
    return `<span style="color:var(--muted)">Not signed in — the database refuses anonymous writes.
      <a href="#" onclick="Auth.open();return false">Sign in</a> to save; everything on this form is kept while you do.</span>`;
  }
  // Signed in, and the database has already said this address may not write.
  // Worth saying here rather than letting Save be the one to find out, because
  // the answer will not change by trying again.
  if (!Auth.mayWrite()) {
    return `<span style="color:var(--warn)">Signed in as ${esc(Auth.email() || 'you')}, but this address is not on the
      editors list — saving will be refused. An administrator has to add it (see <code>docs/access.md</code>).</span>`;
  }
  return '';
}

// Saving is only safe when the station on screen came out of the database this
// session. On the file fallback the form holds values that may be older than the
// row it would overwrite — and the version stamp would not catch it, because the
// stamp is read live and would match.
function editorWritesGoToDatabase() {
  return state.dataSource && state.dataSource.kind === 'api';
}

// ── STATION EDITOR (card on the Stations tab) ────────────────────────────────────
// The editor lives below the stations list on the Stations tab: selecting a row
// loads it here (see selectStation / renderStationEditorCard above). "+ New"
// clears the selection and opens a blank form.

function editorNew() {
  state.selectedId  = null;
  state.editorId    = null;
  state.editorDraft = {
    id: '', name: '', station_number: '', lat: null, lon: null, elevation_ahd: null,
    roles: ['field'], radio_network_ids: [], catchment_ids: [],
    alert_ids: {}, satcom: { enabled: false, provider: '', terminal_id: '' },
    rm_system_id: 1, enabled: true, notes: '',
  };
  // A station that does not exist yet has no version to have started from, and
  // save_station() requires the stamp to be absent for an insert.
  state.editorStamp    = null;
  state.editorStampFor = null;
  state.editorMsg      = null;
  rerenderStations();          // drop any row highlight
  rerenderStationEditorCard(); // show the blank form
}

// Spelled-out "Passing N ALERT addresses across M stations, in R ranges
// spanning S addresses (P% used)." above the Pass Ranges textarea (see #83).
// Empty string when the repeater has no ranges recorded — nothing to spell
// out yet, and the blank textarea below already says so.
function repeaterPassingSummaryHtml(s) {
  const ranges = s.repeater?.pass_ranges || [];
  if (!ranges.length) return '';
  const addr = repeaterPassingCount(s) ?? 0;
  const stns = findStationMatches(s).length;
  const span = repeaterPassRangeSpan(s);
  const pct  = span ? Math.round((addr / span) * 100) : 0;
  return `
        <p class="full small" style="margin:.1rem 0 .5rem">
          <strong>Passing ${addr} ALERT address${addr === 1 ? '' : 'es'} across ${stns} station${stns === 1 ? '' : 's'}</strong>,
          in ${ranges.length} range${ranges.length === 1 ? '' : 's'} spanning ${span.toLocaleString()} address${span === 1 ? '' : 'es'}
          (${pct}% used).
        </p>`;
}

function editorForm(s) {
  const hasRep  = s.roles.includes('repeater');
  const sensors = stationSensors(s).slice().sort((a, b) => (a.alert_id ?? 0) - (b.alert_id ?? 0));
  const dbId    = arroSiteId(s);
  return `
    <div class="panel-header" style="margin-bottom:.35rem">
      <h2>${esc(s.name) || 'New Station'}</h2>
      <div style="display:flex;gap:.5rem">
        <!-- Signed out, the button is not disabled and does not fail at the
             network: it says what is missing and opens the panel that supplies
             it. A greyed-out Save with no explanation is the version of this
             that generates the support email. -->
        ${dbCanWrite()
          ? `<button class="primary" id="ef-save" onclick="editorSave()" ${state.editorBusy ? 'disabled' : ''}>Save</button>`
          : `<button class="primary" id="ef-save" onclick="Auth.open()" title="Saving needs a signed-in session">Sign in to save</button>`}
        ${s.id ? `<button id="ef-delete" onclick="editorDelete()" ${state.editorBusy ? 'disabled' : ''}
                          style="border-color:#c7401a;color:#c7401a">Delete</button>` : ''}
      </div>
    </div>
    <!-- Save writes to the database and waits for it, so this line is where the
         answer arrives: saved and when, refused and why. A failed save leaves
         everything below untouched — the typing is the thing being protected. -->
    <div id="ef-status" class="small" style="margin-bottom:.6rem">${editorStatusHtml()}</div>
    <div class="form-grid">
      <label>Name<input type="text" id="ef-name" value="${esc(s.name)}"></label>
      <label>Station Number<input type="text" id="ef-stnno" value="${esc(s.station_number || '')}"></label>
      <label>Latitude<input type="number" step="any" id="ef-lat" value="${s.lat ?? ''}"></label>
      <label>Longitude<input type="number" step="any" id="ef-lon" value="${s.lon ?? ''}"></label>
      ${stationMapLinkUrls(s) ? `<div class="full small" style="display:flex;gap:1rem;margin-top:-.35rem">${mapLinksHtml(s)}</div>` : ''}
      <label>Elevation AHD (m)<input type="number" step="any" id="ef-elev" value="${s.elevation_ahd ?? ''}"></label>
      <label>RM System ID<input type="number" id="ef-rmsys" value="${s.rm_system_id || 1}"></label>
      <label>TBRG bucket size (mm/tip)
        <input type="number" step="0.1" min="0" id="ef-bucket" value="${s.TBRGbucketSize ?? ''}" placeholder="not recorded">
      </label>
      <div class="full small" style="color:var(--muted);margin-top:-.35rem">
        Blank means not recorded, not zero — the app falls back to an assumed 0.2 mm/tip wherever it
        converts a rain gauge count and says so. ${bucketSizeGapNote()}
      </div>
      <label class="full">Roles
        <div style="display:flex;gap:1rem;flex-wrap:wrap;margin-top:.35rem">
          ${Object.keys(ROLE_LABEL).map(r => `
            <label style="font-weight:normal;display:flex;gap:.35rem;align-items:center">
              <input type="checkbox" name="ef-roles" value="${r}" ${s.roles.includes(r) ? 'checked' : ''}> ${r}
            </label>`).join('')}
        </div>
      </label>
      <div class="full" style="margin-top:.4rem">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:.5rem;margin-bottom:.45rem">
          <div style="font-weight:600">ALERT IDs / Sensors${sensors.length ? ` <span class="small" style="font-weight:400">— ${sensors.length}</span>` : ''}</div>
          <button type="button" onclick="editorAddSensorRow()">+ Add sensor</button>
        </div>
        <div id="ef-sensors">
          ${sensors.map(se => sensorRowHtml(se, dbId)).join('')}
        </div>
        <div class="small" style="color:var(--muted);margin-top:.2rem">
          One row per ALERT address and what it measures — rainfall, water level, battery, etc.${
            dbId != null ? ' Rows whose sensor carries an ARRO device id link straight to its admin page.' : ''}
        </div>
        <datalist id="ef-sensor-types">
          ${['Rainfall', 'Rainfall Increment', 'Water Level', 'Water Level - AHD', 'Battery', 'Air Temperature', 'Relative Humidity', 'Wind Speed', 'Wind Gust', 'Wind Direction', 'pH', 'Conductivity', 'Dissolved Oxygen', 'Water Temperature', 'Turbidity'].map(t => `<option value="${esc(t)}">`).join('')}
        </datalist>
      </div>
      <label style="display:flex;gap:.45rem;align-items:center;grid-column:1">
        <input type="checkbox" id="ef-enabled" ${s.enabled ? 'checked' : ''}> Enabled
      </label>
      <label class="full">Notes<textarea id="ef-notes">${esc(s.notes || '')}</textarea></label>
    </div>
    ${hasRep ? `
      <hr>
      <h3 style="margin:.5rem 0 .75rem">Repeater Configuration</h3>
      <div class="form-grid">
        <label>ACMA Licence<input type="text" id="ef-acma" value="${esc(s.repeater?.acma_licence || '')}"></label>
        <label>RX (MHz)<input type="number" step="any" id="ef-rx" value="${s.repeater?.rx_mhz ?? ''}"></label>
        <label>TX (MHz)<input type="number" step="any" id="ef-tx" value="${s.repeater?.tx_mhz ?? ''}"></label>
        ${repeaterPassingSummaryHtml(s)}
        <label class="full">Pass Ranges (one per line: <em>low-high</em>)
          <textarea id="ef-pass" rows="5">${(s.repeater?.pass_ranges || []).map(r => `${r.low}-${r.high}`).join('\n')}</textarea>
        </label>
        <label class="full">Exclusions (one per line: <em>low-high</em>)
          <textarea id="ef-excl" rows="3">${(s.repeater?.exclusions || []).map(r => `${r.low}-${r.high}`).join('\n')}</textarea>
        </label>
      </div>` : ''}
    ${editorArroSection(s, sensors)}`;
}

// The ARRO block at the foot of the editor. Read-only throughout: these ids come
// from ARRO's own export and editing them here would only desynchronise us from
// it. The site id is spelled out next to the station number precisely because
// the two get confused — the number is BoM's, the site id is ARRO's index, and
// only the latter opens a page.
function editorArroSection(s, sensors) {
  const dbId  = arroSiteId(s);
  const site  = s.site || {};
  const admin = arroSiteUrl(dbId);
  const graph = buildArroUrl(sensors.map(se => ({ station: s, sensor: se })));
  const withDev = sensors.filter(se => se.device_id != null).length;

  if (dbId == null) {
    return `
      <hr>
      <h3 style="margin:.5rem 0 .75rem">ARRO</h3>
      <p class="small" style="color:var(--muted);margin:0">
        <strong>No ARRO site id recorded</strong> for this station, so there is no admin page to
        link to. 390 of 3,174 stations are in the same position — the site id arrives with the
        ARRO sensor export (<code>tools/import_arro_sensors.py</code>) and a station missing from
        that export has no <code>site.db_id</code> here either.
      </p>`;
  }

  return `
    <hr>
    <h3 style="margin:.5rem 0 .75rem">ARRO</h3>
    <div class="form-grid">
      <label>ARRO site id <span class="small" style="font-weight:400">— ARRO's key, not BoM's</span>
        <input type="text" readonly value="${esc(dbId)}" title="site.db_id — the id every ARRO URL takes">
      </label>
      <label>Station number <span class="small" style="font-weight:400">— BoM's</span>
        <input type="text" readonly value="${esc(site.number || s.station_number || '—')}">
      </label>
      <label class="full">Site name in ARRO
        <input type="text" readonly value="${esc(site.name || '—')}">
      </label>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.6rem">
      <a class="btn-link" href="${esc(admin)}" target="_blank" rel="noopener"
         title="Site administration page in ARRO">Open site in ARRO admin ↗</a>
      ${graph ? `<a class="btn-link" href="${esc(graph.url)}" target="_blank" rel="noopener"
         title="Last 7 days for ${graph.count} sensor${graph.count !== 1 ? 's' : ''}">Graph last 7 days ↗</a>` : ''}
    </div>
    <p class="small" style="color:var(--muted);margin:.5rem 0 0">
      ${withDev
        ? `${withDev} of ${sensors.length} sensor${sensors.length !== 1 ? 's' : ''} carry an ARRO device id —
           each of those rows above links to its own sensor admin page.`
        : `None of this station's sensors carry an ARRO device id, so there are no per-sensor
           admin pages to link to.`}
    </p>`;
}

// One editable sensor row: ALERT id + type, with the national-export metadata
// (sensor_id, device_id) preserved on data-attributes so a round-trip keeps it.
//
// `dbId` is the station's ARRO site id, passed in because a sensor record has
// only half of what an ARRO sensor page needs. When both keys are present the
// row carries its own admin link rather than a second list of them below.
function sensorRowHtml(se, dbId) {
  se = se || {};
  const url = arroSensorUrl(dbId, se.device_id);
  return `
    <div class="sensor-row" data-sensor-id="${esc(se.sensor_id || '')}" data-device-id="${se.device_id ?? ''}"
         style="display:flex;gap:.4rem;align-items:center;margin-bottom:.35rem">
      <input type="number" class="sensor-aid" value="${se.alert_id ?? ''}" placeholder="ALERT ID"
             style="flex:0 0 7.5rem;width:7.5rem">
      <input type="text" class="sensor-type" list="ef-sensor-types" value="${esc(se.type || '')}"
             placeholder="Sensor type (e.g. Rainfall)" style="flex:1 1 auto;width:auto;min-width:0">
      <span class="sensor-arro small" style="flex:0 0 4.2rem;text-align:right">${url
        ? `<a href="${esc(url)}" target="_blank" rel="noopener"
             title="ARRO admin for device ${esc(se.device_id)} on site ${esc(dbId)}">ARRO ↗</a>`
        : ''}</span>
      <button type="button" class="sensor-del" title="Remove this sensor"
              onclick="this.closest('.sensor-row').remove()"
              style="flex:0 0 auto;border-color:#c7401a;color:#c7401a;padding:.2rem .55rem;line-height:1">×</button>
    </div>`;
}

function editorAddSensorRow() {
  const box = document.getElementById('ef-sensors');
  if (!box) return;
  box.insertAdjacentHTML('beforeend', sensorRowHtml({}));
  box.querySelector('.sensor-row:last-child .sensor-aid')?.focus();
}

// Best-effort legacy `alert_ids` object derived from the sensor rows, so exports
// and any older consumers still get rainfall/battery/water_level values. The
// `sensors` array is the source of truth for display.
function deriveLegacyAlertIds(sensors) {
  const out = {};
  const wl = [];
  sensors.forEach(se => {
    const t = (se.type || '').toLowerCase();
    if (t.includes('rain'))       { if (out.rainfall == null) out.rainfall = se.alert_id; }
    else if (t.includes('batt'))  { if (out.battery  == null) out.battery  = se.alert_id; }
    else if (t.includes('level')) { if (!wl.includes(se.alert_id)) wl.push(se.alert_id); }
  });
  if (wl.length === 1) out.water_level = wl[0];
  else if (wl.length > 1) out.water_level = wl;
  return out;
}

// Read the form into a station record. Split out of editorSave() because the
// save now happens between reading the form and touching anything else, and a
// function that reads the DOM is worth being able to point at.
function editorReadForm() {
  const stations = state.data.stations;
  const d = { ...state.editorDraft };

  d.name           = document.getElementById('ef-name')?.value.trim()  || d.name;
  d.station_number = document.getElementById('ef-stnno')?.value.trim() || '';
  d.lat            = pFloat(document.getElementById('ef-lat')?.value);
  d.lon            = pFloat(document.getElementById('ef-lon')?.value);
  d.elevation_ahd  = pFloat(document.getElementById('ef-elev')?.value);
  d.rm_system_id   = parseInt(document.getElementById('ef-rmsys')?.value) || 1;
  const bucket = pFloat(document.getElementById('ef-bucket')?.value);
  if (bucket != null && bucket > 0) d.TBRGbucketSize = bucket; else delete d.TBRGbucketSize;
  d.enabled        = document.getElementById('ef-enabled')?.checked ?? true;
  d.notes          = document.getElementById('ef-notes')?.value || '';
  d.roles          = [...document.querySelectorAll('input[name="ef-roles"]:checked')].map(b => b.value);

  // ALERT sensors — read the editable rows, preserving national-export metadata.
  const sensors = [...document.querySelectorAll('#ef-sensors .sensor-row')].map(row => {
    const id = pInt(row.querySelector('.sensor-aid')?.value);
    if (id == null) return null;
    const rec = { alert_id: id, type: row.querySelector('.sensor-type')?.value.trim() || '' };
    const sid = row.getAttribute('data-sensor-id');
    const did = row.getAttribute('data-device-id');
    if (sid) rec.sensor_id = sid;
    if (did) rec.device_id = pInt(did);
    return rec;
  }).filter(Boolean);
  if (sensors.length) d.sensors = sensors;
  else delete d.sensors;
  d.alert_ids = deriveLegacyAlertIds(sensors);

  if (d.roles.includes('repeater')) {
    d.repeater = {
      acma_licence: document.getElementById('ef-acma')?.value.trim() || '',
      rx_mhz:       pFloat(document.getElementById('ef-rx')?.value),
      tx_mhz:       pFloat(document.getElementById('ef-tx')?.value),
      pass_ranges:  parseRangeLines(document.getElementById('ef-pass')?.value || ''),
      exclusions:   parseRangeLines(document.getElementById('ef-excl')?.value || ''),
      notes:        d.repeater?.notes || '',
    };
  }

  // A new station needs an id before it can be saved: it is the primary key, it
  // is what the URL and state.selectedId carry, and the database will not mint
  // one. Uniqueness is checked against what is on screen and again, properly, by
  // the primary key at the other end — two people creating the same slug at the
  // same time is refused there rather than raced here.
  if (!d.id) {
    d.id = slug(d.name) || `stn_${Date.now()}`;
    let uid = d.id, n = 2;
    while (stations.some(s => s.id === uid)) uid = `${d.id}_${n++}`;
    d.id = uid;
  }
  return d;
}

// Save. The order matters and is the whole point of #B3: read the form, write to
// the database, wait, and only then touch what is on screen — updating memory
// from what came back rather than from what was sent, because the server owns
// updated_at and the round trip is what proves the write happened.
//
// Nothing here clears the form on a failure. Somebody has just typed for ten
// minutes; a save that fails and takes the work with it is worse than no save at
// all.
async function editorSave() {
  if (state.editorBusy) return;

  if (!editorWritesGoToDatabase()) {
    setEditorStatus({
      kind: 'error',
      text: 'The station list on screen did not come from the datastore, so saving it would'
          + ' overwrite the database with a copy that may be older. Load from the datastore first.',
    });
    return;
  }

  const d        = editorReadForm();
  const isNew    = !state.editorId;
  const expected = isNew ? null : state.editorStamp;

  state.editorBusy = true;
  setEditorStatus({ kind: 'busy', text: 'Saving…' });
  rerenderEditorButtons();

  let result;
  try {
    result = await dbSaveStation(d, expected);
  } catch (err) {
    state.editorBusy = false;
    rerenderEditorButtons();
    setEditorStatus({ kind: 'error', text: editorSaveErrorText(err) });
    return;                      // the form, and everything typed into it, stands
  }

  state.editorBusy = false;

  // Memory from what came back. The saved record carries whatever the database
  // made of the write — a minted sensor_id, a normalised range list, a
  // repeater dropped because the role went away.
  const saved    = result.station;
  const stations = state.data.stations;
  const i = stations.findIndex(s => s.id === saved.id);
  if (i >= 0) stations[i] = saved; else stations.push(saved);

  state.editorId       = saved.id;
  state.editorDraft    = saved;
  state.selectedId     = saved.id;
  state.editorStamp    = result.updated_at;
  state.editorStampFor = saved.id;

  updateHeaderStats();
  refreshFilterOptions();      // an edited role / network changes the option counts
  rerenderStations();
  rerenderStationEditorCard();
  setEditorStatus({
    kind: 'ok',
    text: `${result.created ? 'Created' : 'Saved'} at ${new Date().toLocaleTimeString()}`
        + ` as ${result.updated_by || 'you'} — in the database, not just this tab.`,
  });
}

// One message per way a save can fail, because "Error" is not an instruction.
function editorSaveErrorText(err) {
  if (err.conflict) return `${err.message} Your edits are still on screen — copy anything you need, then reload from the datastore.`;
  // Two different situations arrive as the same refusal, and the instruction is
  // different for each: one is fixed at the keyboard, the other needs somebody
  // with SQL access. Telling them apart from what this browser knows is the
  // whole reason Auth tracks may_write.
  if (err.denied) {
    return Auth.isSignedIn()
      ? `Refused: ${Auth.email() || 'this address'} is not on the editors list, so the database will not accept`
        + ` edits from it. An administrator has to add it (docs/access.md). Nothing was changed, and your edits are still here.`
      : `Refused: not signed in, and the database does not accept anonymous edits. Sign in and press Save again —`
        + ` nothing was changed, and your edits are still here.`;
  }
  return `Not saved — ${err.message}. Your edits are still here; try again when the datastore is reachable.`;
}

// Repaint just the two buttons, so their disabled state follows a save in flight
// without redrawing the form they sit above.
function rerenderEditorButtons() {
  const save = document.getElementById('ef-save');
  const del  = document.getElementById('ef-delete');
  if (save) save.disabled = state.editorBusy;
  if (del)  del.disabled  = state.editorBusy;
}

// Delete, which is a soft delete at the other end: the row, its sensors, its
// repeater and its ranges all stay, and only the document stops carrying it. The
// confirm still says "delete" because that is what it means to the operator —
// the recoverability is the database's business, and is spelled out in
// db/migrations/0004_station_writes.sql for whoever needs to undo one.
async function editorDelete() {
  if (!state.editorId || state.editorBusy) return;

  const id   = state.editorId;
  const name = state.data.stations.find(s => s.id === id)?.name || id;

  if (!editorWritesGoToDatabase()) {
    setEditorStatus({
      kind: 'error',
      text: 'The station list on screen did not come from the datastore. Load from the datastore before deleting.',
    });
    return;
  }
  if (!confirm(`Delete "${name}"?\n\nIt is removed from the station list. The record is kept and can be restored by whoever administers the database.`)) return;

  state.editorBusy = true;
  setEditorStatus({ kind: 'busy', text: 'Deleting…' });
  rerenderEditorButtons();

  try {
    await dbDeleteStation(id, state.editorStamp);
  } catch (err) {
    state.editorBusy = false;
    rerenderEditorButtons();
    setEditorStatus({ kind: 'error', text: editorSaveErrorText(err) });
    return;
  }

  state.editorBusy     = false;
  state.data.stations  = state.data.stations.filter(s => s.id !== id);
  state.selectedId     = null;
  state.editorId       = null;
  state.editorDraft    = {};
  state.editorStamp    = null;
  state.editorStampFor = null;
  state.editorMsg      = null;
  updateHeaderStats();
  refreshFilterOptions();
  rerenderStations();
  rerenderStationEditorCard();
}

// ── Filter helpers ─────────────────────────────────────────────────────────────

// The grouped filters, in panel order. `alwaysOpen` groups are short enough to
// leave expanded; the rest collapse to a one-line "All / None / 3 of 15" summary
// so the panel stays readable with a dozen networks and twenty sensor types in it.
const FILTER_GROUPS = {
  roles: {
    title: 'Station type',
    alwaysOpen: true,
    dots: true,
  },
  sensors: {
    title: 'Sensor type',
    hint: 'Not every site measures everything — tick the readings you care about.',
    extra: () => `
      <label class="filter-check">
        <input type="checkbox" ${state.filters.sensorsAll ? 'checked' : ''}
               onchange="setSensorsAll(this.checked)">
        Must have <em>all</em> ticked types (not just one)
      </label>`,
  },
  networks: {
    title: 'Radio network',
    hint: `Networks are still being mapped, so most stations sit in "${FILTER_NONE_LABEL}" — ` +
          'they stay visible unless you untick that bucket.',
  },
  regions: {
    title: 'Region',
    hint: 'From the station\'s catchment. Regions are still being assigned.',
  },
};

// Contents of the Filters panel. Search on top, then one block per question the
// operator is actually asking (what kind of site, what does it measure, whose
// network, where), then the data-completeness block for finding gaps.
function stationFiltersHtml() {
  return `
    <div class="panel-header">
      <h3>Filters</h3>
      <span class="filter-resets">
        <button class="filter-reset" onclick="clearStationFilters(false)"
                title="Put every station back at full opacity, without moving the map"
                ${anyStationFilterActive() ? '' : 'disabled'}>Clear filters</button>
        <button class="filter-reset" onclick="clearStationFilters(true)"
                title="Clear the filters and zoom back out to the whole network"
                ${anyStationFilterActive() ? '' : 'disabled'}>Clear &amp; zoom out</button>
      </span>
    </div>
    <div class="filter-block">
      <div class="filter-head">
        <span class="filter-title">Search</span>
        <button class="filter-clear" id="search-clear" onclick="clearSearch()"
                ${state.filters.search.trim() ? '' : 'hidden'}>clear</button>
      </div>
      <p class="filter-hint">Name, station # or ALERT address — or paste a list of them,
        separated by commas, spaces or new lines.</p>
      <textarea id="station-search" class="filter-search" rows="1" spellcheck="false"
                placeholder="e.g. 6128, 6129 — or paste from a telemetry log"
                oninput="mapSearchInput(this.value);autoGrowSearch(this)">${esc(state.filters.search)}</textarea>
      <p class="filter-note" id="search-terms-note">${searchTermsNoteHtml()}</p>
      <p class="filter-note" id="map-match-note">${mapMatchNoteHtml()}</p>
    </div>
    ${Object.keys(FILTER_GROUPS).map(filterGroupHtml).join('')}
    ${filterAreaHtml()}
    ${filterDataHtml()}`;
}

function renderStationFilters() {
  const el = document.getElementById('station-filters');
  if (el) el.innerHTML = stationFiltersHtml();
  initStationFilters();
}

// The search box is a <textarea>, not an <input>: a single-line input strips
// the line breaks out of a pasted column of addresses, gluing 6128 and 6129
// into 61286129. It opens one line tall and grows to fit what was pasted.
function initStationFilters() {
  const el = document.getElementById('station-search');
  if (el) autoGrowSearch(el);
}

const SEARCH_MAX_PX = 170;   // ~8 lines; past that the box scrolls instead

function autoGrowSearch(el) {
  el.style.height = 'auto';
  // Boxes are border-box here but scrollHeight excludes the border, so the
  // frame has to be added back or every growth step clips by a couple of pixels.
  const frame = el.offsetHeight - el.clientHeight;
  el.style.height = Math.min(el.scrollHeight + frame, SEARCH_MAX_PX) + 'px';
}

function clearSearch() {
  state.filters.search = '';
  const el = document.getElementById('station-search');
  if (el) { el.value = ''; autoGrowSearch(el); el.focus(); }
  stationsFilterChanged();
}

// What a pasted list did: how many terms, and which of them are in no station
// on file. Silent about a single term — the match note below already covers it.
function searchTermsNoteHtml() {
  const terms = parseSearchTerms(state.filters.search);
  if (terms.length < 2) return '';
  const missing = unmatchedSearchTerms(terms);
  if (!missing.length) return `${terms.length} search terms · all found.`;
  const shown = missing.slice(0, 8).map(esc).join(', ');
  const rest  = missing.length - 8;
  return `${terms.length} search terms · <strong>${missing.length}</strong> not in this ` +
         `database: ${shown}${rest > 0 ? ` +${rest} more` : ''}`;
}

// Editing or deleting a station moves the per-option counts (and can retire an
// option outright), so the cached lists are dropped and the panel redrawn.
function refreshFilterOptions() {
  state.filterOpts  = null;
  state.searchIdx   = null;
  state.repeaterIdx = null;
  state.passRelIdx  = null;   // an edited pass range re-wires the relation
  if (state.activeTab === 'stations') renderStationFilters();
}

function filterGroupHtml(key) {
  const cfg  = FILTER_GROUPS[key];
  const opts = filterOptions()[key];
  if (!opts.length) return '';
  const head = `
    <span class="filter-title">${esc(cfg.title)}</span>
    <span class="filter-state" id="filter-state-${key}">${filterGroupState(key)}</span>`;
  const body = `
    ${cfg.hint ? `<p class="filter-hint">${cfg.hint}</p>` : ''}
    <div class="filter-actions">
      <button onclick="setGroupFilter('${key}','all')">All</button>
      <button onclick="setGroupFilter('${key}','none')">None</button>
    </div>
    ${cfg.extra ? cfg.extra() : ''}
    <div class="filter-list">${opts.map(o => filterRowHtml(key, o, cfg)).join('')}</div>`;
  return cfg.alwaysOpen
    ? `<div class="filter-block filter-group" id="filter-group-${key}">
         <div class="filter-head">${head}</div>${body}
       </div>`
    : `<details class="filter-block filter-group" id="filter-group-${key}"
                ${state.filterOpen[key] ? 'open' : ''} ontoggle="state.filterOpen['${key}']=this.open">
         <summary class="filter-head">${head}</summary>${body}
       </details>`;
}

// One option row: tick box + label + how many stations it covers, plus "only"
// — one click to narrow to that value alone, which beats un-ticking fourteen.
function filterRowHtml(key, o, cfg) {
  const set  = state.filters[key];
  const on   = !set.size || set.has(o.value);
  const dot  = cfg.dots && ROLE_COLOR[o.value]
    ? `<span class="legend-dot" style="background:${ROLE_COLOR[o.value]}"></span>` : '';
  const none = o.value === FILTER_NONE ? ' filter-row-none' : '';
  return `
    <div class="filter-row">
      <label class="filter-row-label${none}">
        <input type="checkbox" ${on ? 'checked' : ''}
               onchange="toggleGroupFilter('${key}','${escAttr(o.value)}',this.checked)">
        ${dot}<span>${esc(o.label)}</span>
      </label>
      <span class="filter-row-side">
        <span class="filter-count">${o.count}</span>
        <button class="filter-only" title="Show only ${esc(o.label)}"
                onclick="setGroupFilter('${key}','only','${escAttr(o.value)}')">only</button>
      </span>
    </div>`;
}

// Basin and council are long lists (65 basins, 100+ LGAs) and a station has at
// most one of each — a dropdown reads better than a hundred tick boxes.
function filterAreaHtml() {
  const opts = filterOptions();
  if (!opts.basins.length && !opts.lgas.length) return '';
  return `
    <details class="filter-block" id="filter-group-area" ${state.filterOpen.area ? 'open' : ''}
             ontoggle="state.filterOpen.area=this.open">
      <summary class="filter-head">
        <span class="filter-title">Basin &amp; council</span>
        <span class="filter-state" id="filter-state-area">${valueGroupState(['basin', 'lga'])}</span>
      </summary>
      ${filterSelectHtml('basin', 'Drainage basin', opts.basins)}
      ${filterSelectHtml('lga',   'Local government area', opts.lgas)}
    </details>`;
}

// Gap-hunting rather than day-to-day filtering: which sites have no position,
// no ALERT address, or are switched off.
function filterDataHtml() {
  return `
    <details class="filter-block" id="filter-group-data" ${state.filterOpen.data ? 'open' : ''}
             ontoggle="state.filterOpen.data=this.open">
      <summary class="filter-head">
        <span class="filter-title">Data completeness</span>
        <span class="filter-state" id="filter-state-data">${valueGroupState(['hasCoords', 'hasAlertId', 'enabledOnly'])}</span>
      </summary>
      <p class="filter-hint">For finding what still needs filling in.</p>
      ${filterChoiceHtml('hasCoords', 'Position', [
        ['',    'Any'],
        ['yes', 'Has lat/lon'],
        ['no',  'Missing lat/lon'],
      ])}
      ${filterChoiceHtml('hasAlertId', 'ALERT address', [
        ['',    'Any'],
        ['yes', 'Has an address'],
        ['no',  'No address on file'],
      ])}
      <label class="filter-check">
        <input type="checkbox" ${state.filters.enabledOnly ? 'checked' : ''}
               onchange="setValueFilter('enabledOnly',this.checked)">
        Enabled stations only
      </label>
    </details>`;
}

function filterSelectHtml(key, label, opts) {
  if (!opts.length) return '';
  const cur = state.filters[key];
  return `
    <label class="filter-field">
      <span>${esc(label)}</span>
      <select onchange="setValueFilter('${key}',this.value)">
        <option value="">Any</option>
        ${opts.map(o => `
          <option value="${escAttr(o.value)}" ${cur === o.value ? 'selected' : ''}>
            ${esc(o.label)} (${o.count})
          </option>`).join('')}
      </select>
    </label>`;
}

function filterChoiceHtml(key, label, choices) {
  return `
    <label class="filter-field">
      <span>${esc(label)}</span>
      <select onchange="setValueFilter('${key}',this.value)">
        ${choices.map(([v, l]) => `
          <option value="${escAttr(v)}" ${state.filters[key] === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}
      </select>
    </label>`;
}

// Summary for the blocks made of single-value controls: how many are set.
function valueGroupState(keys) {
  const set = keys.filter(k => state.filters[k]).length;
  return set ? `${set} set` : 'Any';
}

// Keep the panel's live bits — group summaries, the match note and the Reset
// button — in step with the filters without rebuilding the whole panel (which
// would take the focus out of whatever the operator is clicking).
function updateFilterChrome() {
  Object.keys(FILTER_GROUPS).forEach(updateFilterGroupState);
  const terms = document.getElementById('search-terms-note');
  if (terms) terms.innerHTML = searchTermsNoteHtml();
  const clear = document.getElementById('search-clear');
  if (clear) clear.hidden = !state.filters.search.trim();
  const area = document.getElementById('filter-state-area');
  if (area) area.textContent = valueGroupState(['basin', 'lga']);
  const data = document.getElementById('filter-state-data');
  if (data) data.textContent = valueGroupState(['hasCoords', 'hasAlertId', 'enabledOnly']);
  const idle = !anyStationFilterActive();
  document.querySelectorAll('#station-filters .filter-reset').forEach(b => { b.disabled = idle; });
  updateMapMatchNote();
}

// Option lists for the grouped filters, each entry { value, label, count }.
// Built from the loaded file (so a station.json with different networks, sensor
// types or regions filters itself correctly) and cached until the next load —
// counting sensor types across 3000+ stations on every keystroke would not be.
// Every group ends with the FILTER_NONE bucket when the file has stations that
// leave the field blank, and options nobody uses are dropped.
function filterOptions() {
  if (state.filterOpts) return state.filterOpts;
  const stations = state.data?.stations || [];

  // key → number of stations offering that key
  const tally = keyFn => {
    const counts = new Map();
    stations.forEach(s => keyFn(s).forEach(k => counts.set(k, (counts.get(k) || 0) + 1)));
    return counts;
  };
  // Named options first (in the order the file lists them), then whatever the
  // stations mention that the file never declared, then the "not recorded" bucket.
  const build = (counts, named, { sort } = {}) => {
    const out  = [];
    const seen = new Set();
    named.forEach(({ value, label }) => {
      seen.add(value);
      out.push({ value, label, count: counts.get(value) || 0 });
    });
    const extra = [...counts.keys()].filter(k => !seen.has(k) && k !== FILTER_NONE)
      .map(value => ({ value, label: value, count: counts.get(value) }));
    if (sort === 'count') extra.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    else                  extra.sort((a, b) => a.label.localeCompare(b.label));
    out.push(...extra);
    if (counts.get(FILTER_NONE)) {
      out.push({ value: FILTER_NONE, label: FILTER_NONE_LABEL, count: counts.get(FILTER_NONE) });
    }
    return out.filter(o => o.count > 0);
  };

  const regionNames = [...new Set((state.data?.catchments || []).map(c => c.region).filter(Boolean))].sort();

  state.filterOpts = {
    roles:    build(tally(stationRoleKeys),
                    Object.entries(ROLE_LABEL).map(([value, label]) => ({ value, label }))),
    sensors:  build(tally(stationSensorTypeKeys), [], { sort: 'count' }),
    networks: build(tally(stationNetworkKeys),
                    (state.data?.radio_networks || []).map(n => ({ value: n.id, label: n.name }))),
    regions:  build(tally(stationRegionKeys), regionNames.map(r => ({ value: r, label: r }))),
    basins:   build(tally(s => groupKeys(s.basin ? [s.basin] : [])), []),
    lgas:     build(tally(s => groupKeys(s.lga   ? [s.lga]   : [])), []),
  };
  return state.filterOpts;
}

function filterGroupValues(key) {
  return filterOptions()[key].map(o => o.value);
}

// One checkbox in a grouped filter. The Set is kept canonical: empty when
// everything is ticked (the default, "no constraint") and holding FILTER_EMPTY
// when nothing is — so what the boxes show and what the filter does can never
// drift apart, which is what made un-ticking a network a no-op before.
function toggleGroupFilter(key, value, checked) {
  const set    = state.filters[key];
  const values = filterGroupValues(key);
  if (!set.size && !checked) values.forEach(v => set.add(v));   // "all" → the real list, minus one
  set.delete(FILTER_EMPTY);
  if (checked) set.add(value);
  else         set.delete(value);
  if (!set.size)                    set.add(FILTER_EMPTY);      // hand-emptied ≠ show everything
  else if (set.size === values.length) set.clear();             // back to the full list → "all"
  stationsFilterChanged();
}

// "All" / "None" / a row's "only" — the whole group re-renders, since these
// move every checkbox at once.
function setGroupFilter(key, mode, value) {
  state.filters[key] = mode === 'all'  ? new Set()
                     : mode === 'none' ? new Set([FILTER_EMPTY])
                     :                   new Set([value]);
  rerenderFilterGroup(key);
  stationsFilterChanged();
}

function setValueFilter(key, value) {
  state.filters[key] = value;
  stationsFilterChanged();
}

function setSensorsAll(checked) {
  state.filters.sensorsAll = checked;
  stationsFilterChanged();
}

// "All" / "None" / "3 of 15" — the at-a-glance state of a collapsed group.
function filterGroupState(key) {
  const set = state.filters[key];
  if (!set.size)              return 'All';
  if (set.has(FILTER_EMPTY))  return 'None';
  return `${set.size} of ${filterGroupValues(key).length}`;
}

function updateFilterGroupState(key) {
  const el = document.getElementById(`filter-state-${key}`);
  if (el) el.textContent = filterGroupState(key);
}

function rerenderFilterGroup(key) {
  const el = document.getElementById(`filter-group-${key}`);
  if (el) el.outerHTML = filterGroupHtml(key, el.dataset.title, el.dataset.hint);
}

// Anything narrowing the station list? Every group is canonical, so a non-empty
// Set is by definition a real constraint.
function anyStationFilterActive() {
  const f = state.filters;
  return !!(f.search.trim() || f.roles.size || f.sensors.size || f.networks.size ||
            f.regions.size || f.catchments.size || f.basin || f.lga ||
            f.hasCoords || f.hasAlertId || f.enabledOnly);
}

function resetStationFilters() {
  // The ACMA block keeps its own state — clearing station filters should not
  // silently drop an RF layer the operator has configured.
  state.filters = {
    search: '', roles: new Set(), sensors: new Set(), networks: new Set(),
    regions: new Set(), catchments: new Set(), sensorsAll: false,
    basin: '', lga: '', hasCoords: '', hasAlertId: '', enabledOnly: false,
    acma: state.filters.acma,
  };
}

// Reset buttons on the Stations tab: clear everything and redraw the panel with
// it (the boxes, the selects and the summaries all move at once).
//
// Clearing a filter is usually the operator saying "put the rest of the network
// back at full opacity" while they carry on looking at the region they had
// zoomed into — springing the map back to the national view throws away the
// thing they were doing. So the default holds the view, and the second button
// is there for when they do want to zoom back out.
function clearStationFilters(zoomOut) {
  resetStationFilters();
  renderStationFilters();
  state.stationsShowAll = false;
  refreshMapLayers({ skipFit: !zoomOut });
  rerenderStations();
  updateFilterChrome();
}

function toggleFilter(key, value, checked) {
  // The ACMA block's mechanism list is a plain Set with no "empty means all"
  // convention — the station groups go through toggleGroupFilter instead.
  const set = key === 'acmaMechanisms' ? state.filters.acma.mechanisms : state.filters[key];
  if (checked) set.add(value);
  else         set.delete(value);
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

// ── Modal shell ────────────────────────────────────────────────────────────────
// One dialog, borrowed by whoever needs one: a title, arbitrary HTML, Esc or ×
// to close, Tab kept inside it, and focus handed back to whatever opened it.
//
// The bug reporter has its own copy of this markup and keeps it. It is the one
// thing people reach for when the app is already misbehaving, so it does not
// get to depend on anything newer than itself.

const Modal = (function () {
  let lastFocus = null;

  const root = () => document.getElementById('app-modal');
  const isOpen = () => { const el = root(); return el && el.style.display !== 'none'; };

  function open({ title, html, wide }) {
    let el = root();
    if (!el) {
      el = document.createElement('div');
      el.id = 'app-modal';
      el.className = 'modal-overlay';
      // Only the backdrop closes — a click that started inside the card and
      // drifted out (selecting text, say) is not a request to close it.
      el.onclick = ev => { if (ev.target === el) close(); };
      document.body.appendChild(el);
    }
    lastFocus = document.activeElement;
    el.innerHTML = `
      <div class="modal-card${wide ? ' modal-card--wide' : ''}" role="dialog" aria-modal="true"
           aria-labelledby="app-modal-title" tabindex="-1">
        <div class="modal-head">
          <h2 id="app-modal-title">${esc(title)}</h2>
          <button class="modal-x" title="Close (Esc)" aria-label="Close" onclick="Modal.close()">×</button>
        </div>
        <div class="modal-body">${html}</div>
      </div>`;
    el.style.display = 'flex';
    document.addEventListener('keydown', onKey, true);
    el.querySelector('.modal-card')?.focus();
  }

  function onKey(e) {
    if (!isOpen()) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    // Tab cycles within the dialog. Without this it walks off into the page
    // behind, which for a keyboard user is a dialog with no walls.
    const items = [...root().querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])')]
      .filter(n => n.offsetParent !== null);
    if (!items.length) return;
    const at = items.indexOf(document.activeElement);
    if (e.shiftKey) { if (at <= 0) { e.preventDefault(); items[items.length - 1].focus(); } }
    else if (at < 0 || at === items.length - 1) { e.preventDefault(); items[0].focus(); }
  }

  function close() {
    const el = root();
    if (el) { el.style.display = 'none'; el.innerHTML = ''; }
    document.removeEventListener('keydown', onKey, true);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    lastFocus = null;
  }

  return { open, close };
})();
if (typeof window !== 'undefined') window.Modal = Modal;

// ── ACMA RRL interference layer ─────────────────────────────────────────────────
// Renders licensed transmitters from the ACMA Register of Radiocommunications
// Licences that could plausibly interfere with MegaNet repeater RX channels.
// All data is precomputed offline by tools/acma_fetch.py into data/acma-*.json;
// nothing here fetches until the master toggle is switched on (or the RF
// Environment tab is opened), so page load is unaffected while the layer is off.
// Contains ACMA RRL data, CC BY 4.0.

const ACMA_MECH = {
  co_channel:     { label: 'Co-channel',          color: '#d32f2f' },
  adjacent:       { label: 'Adjacent channel',    color: '#f57c00' },
  imd3:           { label: 'Intermod IMD3',       color: '#7b1fa2' },
  imd5:           { label: 'Intermod IMD5',       color: '#ce93d8' },
  imd3_triple:    { label: 'Intermod 3-signal',   color: '#9575cd' },
  harmonic:       { label: 'Harmonic',            color: '#0288d1' },
  cosite_desense: { label: 'Co-site desense',     color: '#6d4c41' },
};

// ACMA VHF High Band Frequency Band Plan segments (148–174 MHz). MegaNet's
// 151.5 MHz sits in Segment F "Miscellaneous Service".
const VHF_SEGMENTS = [
  { seg: 'A', lo: 148.00000, hi: 149.25000, alloc: 'Paging Service' },
  { seg: 'B', lo: 149.25000, hi: 149.75625, alloc: 'Land Mobile (two frequency, base transmit)' },
  { seg: 'C', lo: 149.75625, hi: 149.90000, alloc: 'Land Mobile (single frequency)' },
  { seg: 'D', lo: 149.90000, hi: 150.05000, alloc: 'Radionavigation Satellite' },
  { seg: 'E', lo: 150.05000, hi: 151.39375, alloc: 'Land Mobile (two frequency, base transmit); Fixed (rural)' },
  { seg: 'F', lo: 151.39375, hi: 152.49375, alloc: 'Miscellaneous Service' },
  { seg: 'G', lo: 152.49375, hi: 153.85000, alloc: 'Land Mobile (single frequency)' },
  { seg: 'H', lo: 153.85000, hi: 154.35625, alloc: 'Land Mobile (two frequency, base receive)' },
  { seg: 'I', lo: 154.35625, hi: 154.65625, alloc: 'Land Mobile (single frequency)' },
  { seg: 'J', lo: 154.65625, hi: 156.00000, alloc: 'Land Mobile (two frequency, base receive); Fixed (rural)' },
  { seg: 'K', lo: 156.00000, hi: 157.45000, alloc: 'Maritime Mobile' },
  { seg: 'L', lo: 157.45000, hi: 158.29375, alloc: 'Land Mobile (two frequency, base receive) or single frequency' },
  { seg: 'M', lo: 158.29375, hi: 160.60000, alloc: 'Land Mobile (two frequency, base receive)' },
  { seg: 'N', lo: 160.60000, hi: 160.97500, alloc: 'Maritime Mobile' },
  { seg: 'O', lo: 160.97500, hi: 161.47500, alloc: 'Land Mobile (single frequency)' },
  { seg: 'P', lo: 161.47500, hi: 162.05000, alloc: 'Maritime Mobile' },
  { seg: 'Q', lo: 162.05000, hi: 162.89375, alloc: 'Land Mobile (two frequency, base transmit) or single frequency' },
  { seg: 'R', lo: 162.89375, hi: 165.19375, alloc: 'Land Mobile (two frequency, base transmit)' },
  { seg: 'S', lo: 165.19375, hi: 168.19375, alloc: 'Land Mobile (trunked, base transmit)' },
  { seg: 'T', lo: 168.19375, hi: 169.79375, alloc: 'Land Mobile (single frequency)' },
  { seg: 'U', lo: 169.79375, hi: 172.79375, alloc: 'Land Mobile (trunked, base receive)' },
  { seg: 'V', lo: 172.79375, hi: 173.29375, alloc: 'Land Mobile (single frequency)' },
  { seg: 'W', lo: 173.29375, hi: 174.00000, alloc: 'Miscellaneous Service' },
];

const ACMA_MARKER_CAP = 500;
const ACMA_LINK_CAP   = 300;

function vhfSegment(mhz) {
  return VHF_SEGMENTS.find(s => mhz >= s.lo && mhz < s.hi) || null;
}

function acmaHaversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0088, rad = Math.PI / 180;
  const dp = (lat2 - lat1) * rad, dl = (lon2 - lon1) * rad;
  const a = Math.sin(dp / 2) ** 2 +
            Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ── lazy loading ──

function acmaFetchJson(name) {
  return fetch(`data/${name}`).then(r => {
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    return r.text();
  }).then(text => {
    state.memBytes.files[name] = text.length;   // for MemMeter — free, the text is already here
    return JSON.parse(text);
  });
}

function acmaEnsureCore() {
  const A = state.acma;
  if (A.loaded) return Promise.resolve();
  if (A.loadPromise) return A.loadPromise;
  A.loading = true;
  A.loadPromise = Promise.all([
    acmaFetchJson('acma-threats.json'),
    acmaFetchJson('acma-sites.json'),
    acmaFetchJson('acma-dictionaries.json').catch(() => null),   // optional
  ]).then(([threats, sites, dicts]) => {
    A.threats = threats;
    A.dicts   = dicts;
    A.siteById = {};
    sites.sites.forEach(s => { A.siteById[s.id] = s; });
    A.anchorById = {};
    A.flat = [];
    A.pairsByDevice = {};
    threats.anchors.forEach(a => {
      A.anchorById[a.station_id] = a;
      a.threats.forEach(t =>
        A.flat.push({ anchor_id: a.station_id, anchor_name: a.name, rx_mhz: a.rx_mhz, ...t }));
      (a.imd_pairs || []).forEach(p => {
        (A.pairsByDevice[p.a] = A.pairsByDevice[p.a] || []).push(p);
        (A.pairsByDevice[p.b] = A.pairsByDevice[p.b] || []).push(p);
      });
    });
    A.mechCounts = {};
    A.flat.forEach(t => { A.mechCounts[t.mechanism] = (A.mechCounts[t.mechanism] || 0) + 1; });
    A.loaded = true;
    A.loading = false;
    A.error = null;
  }).catch(err => {
    A.loading = false;
    A.loadPromise = null;
    A.error = `ACMA data unavailable (${err.message}). Generate data/acma-*.json with ` +
              `tools/acma_fetch.py; note these optional files cannot be fetched over file://.`;
    state.filters.acma.show = false;
    throw err;
  });
  return A.loadPromise;
}

// Full device/licence/client detail — several MB, loaded on first card open,
// beam-wedge draw or RF strip plot, never at page load.
function acmaEnsureDevices() {
  const A = state.acma;
  if (A.devLoaded) return Promise.resolve();
  if (A.devPromise) return A.devPromise;
  A.devPromise = acmaFetchJson('acma-devices.json').then(d => {
    A.deviceById = {}; A.devicesBySite = {};
    d.devices.forEach(x => {
      A.deviceById[x.id] = x;
      (A.devicesBySite[x.site_id] = A.devicesBySite[x.site_id] || []).push(x);
    });
    A.licById    = d.licences || {};
    A.clientById = d.clients  || {};
    A.antById    = d.antennas || {};
    A.texts      = d.texts    || [];
    A.devLoaded  = true;
  }).catch(err => {
    A.devPromise = null;
    throw err;
  });
  return A.devPromise;
}

// ── filtering ──

function acmaVisibleThreats(ignoreAnchorSel) {
  const A = state.acma, f = state.filters.acma;
  if (!A.loaded) return [];
  return A.flat.filter(t =>
    f.mechanisms.has(t.mechanism) &&
    t.score >= f.minScore &&
    t.distance_km <= f.radiusKm &&
    (!f.losOnly || t.los === true) &&
    (!f.activeOnly || !t.inactive) &&
    (!f.hideMeganet || !t.meganet) &&
    (ignoreAnchorSel || !A.selectedAnchorId || t.anchor_id === A.selectedAnchorId));
}

// ── filters panel block ──

// The master toggle sits outside the collapsible block: ACMA transmitters are
// drawn by default, so the way to turn them off has to be visible without
// hunting through a closed twisty.
function acmaFilterBlockHtml() {
  return `<div id="acma-filter-block">${acmaFilterHeadHtml()}</div>`;
}

function acmaFilterHeadHtml() {
  const A = state.acma, f = state.filters.acma;
  return `
    <label class="filter-check">
      <input type="checkbox" ${f.show ? 'checked' : ''} onchange="toggleAcmaShow(this.checked)">
      Show ACMA licensed transmitters
    </label>
    ${A.error ? `<div class="small" style="color:var(--muted)">${esc(A.error)}</div>` : ''}
    ${A.loading ? `<div class="small" style="color:var(--muted)">Loading ACMA data…</div>` : ''}
    ${f.show && A.loaded ? `
      <details ${A.uiOpen ? 'open' : ''} ontoggle="state.acma.uiOpen=this.open">
        <summary class="small" style="cursor:pointer;color:var(--muted)">ACMA / RF Environment options</summary>
        <div id="acma-filter-body">${acmaFilterBodyHtml()}</div>
      </details>` : ''}`;
}

function acmaFilterBodyHtml() {
  const A = state.acma, f = state.filters.acma;
  if (!f.show || !A.loaded) return '';

  const meta = A.threats.meta;
  const anchorChip = A.selectedAnchorId ? `
    <div class="small" style="margin:.25rem 0">
      Filtering to <strong>${esc((A.anchorById[A.selectedAnchorId] || {}).name || A.selectedAnchorId)}</strong>
      <a href="#" onclick="acmaSelectAnchor('');return false">×&nbsp;clear</a>
    </div>` : '';

  return `
    <div class="small" style="color:var(--muted);margin:.2rem 0">
      ACMA data: ${esc(meta.source_date)} · <span id="acma-shown"></span>
    </div>
    ${anchorChip}
    <div style="margin:.4rem 0">
      ${Object.entries(ACMA_MECH).filter(([k]) => A.mechCounts[k]).map(([k, m]) => `
        <label style="display:flex;gap:.45rem;align-items:center;font-size:.88rem;margin:.15rem 0">
          <input type="checkbox" ${f.mechanisms.has(k) ? 'checked' : ''}
                 onchange="toggleFilter('acmaMechanisms','${k}',this.checked);refreshAcmaLayer()">
          <span class="legend-sq" style="background:${m.color}"></span>
          ${m.label} (${A.mechCounts[k]})
        </label>`).join('')}
    </div>
    <label class="small" style="display:block;margin:.4rem 0">
      Minimum score <strong id="acma-minscore-val">${f.minScore}</strong>
      <input type="range" min="0" max="100" step="5" value="${f.minScore}" style="width:100%"
             oninput="state.filters.acma.minScore=+this.value;document.getElementById('acma-minscore-val').textContent=this.value"
             onchange="refreshAcmaLayer()">
    </label>
    <label style="display:flex;gap:.45rem;align-items:center;font-size:.88rem;margin:.2rem 0">
      <input type="checkbox" ${f.losOnly ? 'checked' : ''}
             onchange="state.filters.acma.losOnly=this.checked;refreshAcmaLayer()">
      Line-of-sight only <span class="small" style="color:var(--muted)">(not yet assessed — hides all)</span>
    </label>
    <label style="display:flex;gap:.45rem;align-items:center;font-size:.88rem;margin:.2rem 0">
      <input type="checkbox" ${f.activeOnly ? 'checked' : ''}
             onchange="state.filters.acma.activeOnly=this.checked;refreshAcmaLayer()">
      Current licences only
    </label>
    <label style="display:flex;gap:.45rem;align-items:center;font-size:.88rem;margin:.2rem 0">
      <input type="checkbox" ${f.hideMeganet ? 'checked' : ''}
             onchange="state.filters.acma.hideMeganet=this.checked;refreshAcmaLayer()">
      Hide MegaNet's own licences
    </label>
    <label class="small" style="display:block;margin:.35rem 0">
      Search radius
      <select onchange="state.filters.acma.radiusKm=+this.value;refreshAcmaLayer()">
        ${[10, 25, 50, 100].map(r => `
          <option value="${r}" ${f.radiusKm === r ? 'selected' : ''}>${r} km</option>`).join('')}
      </select>
      <span style="color:var(--muted)">(data extends to ${meta.radius_km} km)</span>
    </label>
    <label style="display:flex;gap:.45rem;align-items:center;font-size:.88rem;margin:.2rem 0">
      <input type="checkbox" ${f.showBeams ? 'checked' : ''}
             onchange="state.filters.acma.showBeams=this.checked;refreshAcmaLayer()">
      Show antenna beam wedges
    </label>
    <label style="display:flex;gap:.45rem;align-items:center;font-size:.88rem;margin:.2rem 0">
      <input type="checkbox" ${f.showLinks ? 'checked' : ''}
             onchange="state.filters.acma.showLinks=this.checked;refreshAcmaLayer()">
      Show threat links
    </label>
    <details style="margin:.4rem 0">
      <summary class="small" style="cursor:pointer">? What the mechanisms mean</summary>
      <div class="small" style="color:var(--muted);margin-top:.3rem">
        <p><strong>Co-channel</strong>: transmits on the repeater's RX frequency — direct
        collisions and capture. <strong>Adjacent</strong>: within 50 kHz — splatter raises the
        noise floor until marginal packets flip bits. <strong>Harmonic</strong>: a transmitter at
        1/2…1/5 of the RX frequency whose harmonics land on it. <strong>IMD3/IMD5</strong>:
        two transmitters at the same ACMA site whose intermod products (2f1−f2, 3f1−2f2)
        land on the RX channel — the "rusty bolt" effect; the prime suspect when corruption
        clusters behind one repeater. <strong>Co-site desense</strong>: any strong transmitter
        physically at the repeater site overloading the receiver front-end, regardless of
        frequency — the only mechanism where cellular towers matter.</p>
        <p><strong>Not threats</strong>: mobile phone towers (700 MHz+, no spectral path to
        151.5 MHz — co-siting only), LoRa/LoRaWAN (915–928 MHz), UHF CB (477 MHz).</p>
        <p><strong>Blind spots</strong>: amateur radio isn't in the RRL by location (the
        50.5 MHz × 3 harmonic path needs a spectrum sweep, not this database); unlicensed
        or faulty emitters (solar controllers, VMS signs, electric fences, powerline arcing)
        have no licence record; the RRL records what's <em>licensed</em>, not what's
        <em>radiating</em>; IMD detection only sees devices ACMA records at the same site;
        line-of-sight is not yet assessed and would be terrain-only — it cannot model the
        tropospheric ducting that worsens during flood events.</p>
      </div>
    </details>`;
}

function rerenderAcmaFilterBlock() {
  const el = document.getElementById('acma-filter-block');
  if (el) el.innerHTML = acmaFilterHeadHtml();
}

function toggleAcmaShow(checked) {
  state.filters.acma.show = checked;
  if (!checked) {
    closeAcmaCard();
    refreshAcmaLayer();
    rerenderAcmaFilterBlock();
    rerenderMapLegend();
    return;
  }
  // Legend and filter body gain the ACMA entries once the data lands; both are
  // patched in place so the operator keeps their pan and zoom.
  acmaEnsureCore().then(() => {
    if (state.activeTab === 'stations' && state.map) acmaAfterLoad();
  }).catch(() => rerenderAcmaFilterBlock());
  rerenderAcmaFilterBlock();
}

function acmaSelectAnchor(id) {
  state.acma.selectedAnchorId = id || null;
  refreshAcmaLayer();
  rerenderAcmaFilterBlock();
}

// Link appended to MegaNet repeater popups on the map: "N RF threats".
function acmaRepeaterPopupExtra(s) {
  const A = state.acma;
  if (!state.filters.acma.show || !A.loaded) return '';
  const a = A.anchorById[s.id];
  if (!a || !a.threats.length) return '';
  return `<br><a href="#" style="font-size:.83rem"
    onclick="acmaSelectAnchor('${escAttr(s.id)}');return false">⚠ ${a.threats.length} RF threat candidates — filter map</a>`;
}

// ── map layer ──

// Trim to a marker/line budget without letting one mechanism eat the lot.
//
// A flat "top N by score" cut looks fair and isn't: co-site desense outnumbers
// every other mechanism roughly 8:1 in the RRL extract and its scores sit at the
// top of the range (same site ⇒ no distance discount), so the first ~1300 devices
// by score are all co-site. With a 500-pin cap that meant the map only ever drew
// brown squares — co-channel, IMD and harmonic pins were filtered in, ranked, and
// then cut, so ticking their boxes did nothing until co-site desense was ticked
// off. Deal one item per mechanism per round instead, highest score first within
// each: a crowded mechanism loses its tail rather than erasing the rare ones, and
// mechanisms with fewer devices than the budget always draw in full.
//
// `items` must already be sorted best-first; the returned subset keeps that order.
function acmaCapByMechanism(items, cap, mechOf) {
  if (items.length <= cap) return items;
  const queues = new Map();
  items.forEach((it, i) => {
    const k = mechOf(it);
    if (!queues.has(k)) queues.set(k, []);
    queues.get(k).push(i);
  });
  const lists = [...queues.values()];
  const picked = [];
  for (let round = 0; picked.length < cap; round++) {
    let drew = false;
    for (const l of lists) {
      if (round >= l.length) continue;
      picked.push(l[round]);
      drew = true;
      if (picked.length >= cap) break;
    }
    if (!drew) break;             // every queue exhausted
  }
  return picked.sort((a, b) => a - b).map(i => items[i]);
}

function refreshAcmaLayer() {
  const A = state.acma, map = state.map;
  if (!map) return;
  MapSpider.reset();                 // fanned pins go home before any are removed
  ['layer', 'beamLayer', 'linkLayer', 'hiLayer'].forEach(k => {
    if (A[k]) { A[k].remove(); A[k] = null; }
  });
  const f = state.filters.acma;
  if (!f.show || !A.loaded) { MapSpider.setPins('acma', []); acmaUpdateShownNote(0, 0); return; }

  const visible = acmaVisibleThreats();

  // one marker per device, driven by its top-scoring visible threat
  const byDevice = new Map();
  for (const t of visible) {
    const cur = byDevice.get(t.device_id);
    if (!cur || t.score > cur.top.score) {
      byDevice.set(t.device_id, { top: t, all: cur ? cur.all : [] });
    }
    byDevice.get(t.device_id).all.push(t);
  }
  const devices = [...byDevice.values()].sort((a, b) => b.top.score - a.top.score);
  const shown = acmaCapByMechanism(devices, ACMA_MARKER_CAP, d => d.top.mechanism);
  acmaUpdateShownNote(shown.length, devices.length);

  A.layer = L.layerGroup().addTo(map);
  const acmaPins = [];
  for (const d of shown) {
    const t = d.top;
    const site = A.siteById[t.site_id];
    if (!site) continue;
    const mech = ACMA_MECH[t.mechanism] || { label: t.mechanism, color: '#666' };
    const size = Math.round(9 + t.score / 8);
    const icon = L.divIcon({
      className: 'acma-div',
      html: `<div class="acma-sq${t.meganet ? ' mn' : ''}" style="width:${size}px;height:${size}px;background:${mech.color}"></div>`,
      iconSize: [size, size], iconAnchor: [size / 2, size / 2],
    });
    const m = L.marker([site.lat, site.lon], { icon }).addTo(A.layer);
    m.bindPopup(acmaPopupHtml(d, site), { maxWidth: 300 });
    m.on('click', () => acmaHighlightDevice(t.device_id));
    m.bindTooltip(`${esc(t.client || 'Unknown licensee')} · ${mech.label} · ${t.score}`);
    acmaPins.push(m);
  }
  // Several licensed devices commonly share one site, so these are the pins that
  // most need fanning out.
  MapSpider.setPins('acma', acmaPins);

  if (f.showLinks) {
    A.linkLayer = L.layerGroup().addTo(map);
    const links = acmaCapByMechanism(
      visible.slice().sort((a, b) => b.score - a.score), ACMA_LINK_CAP, t => t.mechanism);
    for (const t of links) {
      const site = A.siteById[t.site_id], a = A.anchorById[t.anchor_id];
      if (!site || !a) continue;
      L.polyline([[site.lat, site.lon], [a.lat, a.lon]], {
        color: (ACMA_MECH[t.mechanism] || {}).color || '#666',
        weight: 1.2, dashArray: '4 4',
        opacity: 0.15 + 0.55 * Math.min(1, t.score / 70),
      }).addTo(A.linkLayer);
    }
  }

  if (f.showBeams) {
    if (!A.devLoaded) {
      acmaEnsureDevices().then(() => refreshAcmaLayer()).catch(() => {});
    } else {
      A.beamLayer = L.layerGroup().addTo(map);
      for (const d of shown) {
        const dev = A.deviceById[d.top.device_id];
        const site = A.siteById[d.top.site_id];
        const ant = dev && dev.ant ? A.antById[dev.ant] : null;
        if (!dev || !site || dev.az == null || !ant || !ant.h_bw || ant.h_bw <= 0 || ant.h_bw >= 360) continue;
        const poly = acmaBeamPolygon(site.lat, site.lon, dev.az, Math.min(ant.h_bw, 120),
                                     acmaBeamRangeKm(dev.eirp_w));
        L.polygon(poly, {
          color: (ACMA_MECH[d.top.mechanism] || {}).color || '#666',
          weight: 1, fillOpacity: 0.08, opacity: 0.5,
        }).addTo(A.beamLayer);
      }
    }
  }
}

function acmaUpdateShownNote(shown, total) {
  const el = document.getElementById('acma-shown');
  if (el) el.textContent = total > shown
    ? `showing ${shown} of ${total} transmitters (top by score, shared across mechanisms)`
    : `${total} transmitters shown`;
}

function acmaBeamRangeKm(eirpW) {
  if (!eirpW || eirpW <= 1) return 1.5;
  return Math.max(1.5, Math.min(12, 2 + 2.5 * Math.log10(eirpW)));
}

function acmaBeamPolygon(lat, lon, azDeg, widthDeg, rangeKm) {
  const pts = [[lat, lon]];
  const degLat = rangeKm / 110.574;
  const degLon = rangeKm / (111.320 * Math.cos(lat * Math.PI / 180));
  for (let a = azDeg - widthDeg / 2; a <= azDeg + widthDeg / 2 + 0.01; a += Math.max(2, widthDeg / 12)) {
    const rad = a * Math.PI / 180;
    pts.push([lat + Math.cos(rad) * degLat, lon + Math.sin(rad) * degLon]);
  }
  pts.push([lat, lon]);
  return pts;
}

// Emphasised links from one device to every repeater it threatens.
function acmaHighlightDevice(deviceId) {
  const A = state.acma, map = state.map;
  if (!map || !A.loaded) return;
  acmaClearHighlight();
  A.hiLayer = L.layerGroup().addTo(map);
  for (const t of acmaVisibleThreats()) {
    if (t.device_id !== deviceId) continue;
    const site = A.siteById[t.site_id], a = A.anchorById[t.anchor_id];
    if (!site || !a) continue;
    L.polyline([[site.lat, site.lon], [a.lat, a.lon]], {
      color: (ACMA_MECH[t.mechanism] || {}).color || '#666',
      weight: 3, opacity: 0.9,
    }).addTo(A.hiLayer);
  }
}

function acmaClearHighlight() {
  if (state.acma.hiLayer) { state.acma.hiLayer.remove(); state.acma.hiLayer = null; }
}

// ── popup + transmitter card ──

function acmaPopupHtml(d, site) {
  const t = d.top;
  const mech = ACMA_MECH[t.mechanism] || { label: t.mechanism, color: '#666' };
  const others = d.all.length - 1;
  return `
    <strong>${esc((site && site.name) || 'Unknown site')}</strong><br>
    <span style="font-size:.83rem">${esc(t.client || 'Unknown licensee')} · score ${t.score}</span><br>
    <span style="background:${mech.color};color:#fff;padding:1px 6px;border-radius:999px;font-size:.78rem">${mech.label}</span>
    ${t.meganet ? '<span class="badge">MegaNet licence</span>' : ''}<br>
    <span style="font-size:.83rem">${esc(t.detail)}</span><br>
    <span style="font-size:.83rem">${t.f_mhz != null ? t.f_mhz.toFixed(4) + ' MHz · ' : ''}${t.distance_km} km @ ${t.bearing_deg}° from ${esc(t.anchor_name)}</span><br>
    <span style="font-size:.83rem">Licence ${esc(t.lic || '?')}${t.expiry ? ' · expires ' + esc(t.expiry) : ''}${t.inactive ? ' · <strong>not current</strong>' : ''}</span>
    ${others > 0 ? `<br><span style="font-size:.8rem;color:#888">+${others} more mechanism/repeater match${others > 1 ? 'es' : ''}</span>` : ''}<br>
    <a href="#" onclick="showAcmaCard('${escAttr(t.device_id)}','${escAttr(t.anchor_id)}');return false">Full details →</a>`;
}

function showAcmaCard(deviceId, anchorId) {
  state.acma.cardDeviceId = deviceId;
  state.acma.cardAnchorId = anchorId || null;
  const el = document.getElementById('acma-card');
  if (el) {
    el.hidden = false;
    el.innerHTML = '<div class="small" style="padding:1rem;color:var(--muted)">Loading transmitter details…</div>';
  }
  acmaEnsureDevices().then(() => renderAcmaCard()).catch(err => {
    if (el) el.innerHTML = `<div class="small" style="padding:1rem;color:var(--muted)">
      Device detail unavailable (${esc(err.message)}).</div>`;
  });
  acmaHighlightDevice(deviceId);
}

function closeAcmaCard() {
  state.acma.cardDeviceId = null;
  const el = document.getElementById('acma-card');
  if (el) { el.hidden = true; el.innerHTML = ''; }
  acmaClearHighlight();
}

function acmaCardRow(label, value) {
  return value == null || value === '' ? '' :
    `<div class="acma-row"><span>${label}</span><span>${value}</span></div>`;
}

function renderAcmaCard() {
  const A = state.acma;
  const el = document.getElementById('acma-card');
  const dev = A.deviceById[A.cardDeviceId];
  if (!el || !dev) return;
  const site   = A.siteById[dev.site_id] || {};
  const lic    = A.licById[dev.lic] || {};
  const client = A.clientById[lic.client_no] || {};
  const ant    = dev.ant ? (A.antById[dev.ant] || {}) : {};
  const myThreats = A.flat.filter(t => t.device_id === dev.id);
  const top = myThreats.slice().sort((a, b) => b.score - a.score)[0];
  const seg = dev.f_mhz != null ? vhfSegment(dev.f_mhz) : null;
  const noteIdxs = [...new Set([...(dev.notes || []), ...(lic.notes || [])])];
  const notes = noteIdxs.map(i => A.texts[i]).filter(Boolean);
  const cosited = (A.devicesBySite[dev.site_id] || []).filter(d => d.id !== dev.id);
  const partnerIds = new Set();
  (A.pairsByDevice[dev.id] || []).forEach(p => { partnerIds.add(p.a === dev.id ? p.b : p.a); });
  const anchor = A.cardAnchorId ? A.anchorById[A.cardAnchorId] : null;
  const distLine = anchor && top
    ? `${top.distance_km} km @ ${String(top.bearing_deg).padStart(3, '0')}° from ${esc(anchor.name)}` : null;

  el.hidden = false;
  el.innerHTML = `
    <div class="acma-card-head">
      <span>
        <strong>${esc(site.name || 'Unknown site')}</strong><br>
        <span class="small" style="color:var(--muted)">${esc(client.trading || client.name || 'Unknown licensee')}</span>
      </span>
      <span>${top ? `score ${top.score}` : ''}
        <button onclick="closeAcmaCard()" title="Close">×</button></span>
    </div>
    ${myThreats.length ? `
      <div class="acma-sect">
        ${myThreats.sort((a, b) => b.score - a.score).map(t => {
          const m = ACMA_MECH[t.mechanism] || { label: t.mechanism, color: '#666' };
          return `<div class="small" style="margin:.15rem 0">
            <span class="legend-sq" style="background:${m.color}"></span>
            <strong>${m.label}</strong> ${t.score} vs ${esc(t.anchor_name)}<br>
            <span style="color:var(--muted)">${esc(t.detail)} —
              w ${t.components.mechanism_weight} × dist ${t.components.distance_factor}
              × pwr ${t.components.power_factor} × LOS ${t.components.los_factor}</span>
          </div>`;
        }).join('')}
      </div>` : ''}
    <div class="acma-sect"><h4>RF</h4>
      ${acmaCardRow('Frequency', dev.f_mhz != null ? dev.f_mhz.toFixed(4) + ' MHz' : null)}
      ${acmaCardRow('Bandwidth', dev.bw_khz != null ? dev.bw_khz + ' kHz' : null)}
      ${acmaCardRow('Emission', esc(dev.emission))}
      ${acmaCardRow('TX power', dev.tx_w != null ? dev.tx_w + ' W' : null)}
      ${acmaCardRow('EIRP', dev.eirp_w != null ? dev.eirp_w + ' W' : null)}
      ${acmaCardRow('Segment', seg ? `${seg.seg} — ${esc(seg.alloc)}` : null)}
      ${acmaCardRow('Mode', esc(dev.mode))}
      ${acmaCardRow('Operation hours', esc(dev.hours === '00:00-23:59' ? 'Continuous' : dev.hours))}
      ${acmaCardRow('Station class', esc(dev.station_class))}
      ${acmaCardRow('Authorised', esc(dev.authorised))}
    </div>
    ${Object.keys(ant).length ? `
    <div class="acma-sect"><h4>Antenna</h4>
      ${acmaCardRow('Type / model', esc([ant.type, ant.manufacturer, ant.model].filter(Boolean).join(' · ')))}
      ${acmaCardRow('Height', dev.height_m != null ? dev.height_m + ' m' : null)}
      ${acmaCardRow('Gain', ant.gain_dbi != null ? ant.gain_dbi + ' dBi' : null)}
      ${acmaCardRow('Azimuth / tilt', dev.az != null ? `${dev.az}° / ${dev.tilt != null ? dev.tilt + '°' : '—'}` : null)}
      ${acmaCardRow('H-beamwidth', ant.h_bw ? ant.h_bw + '°' : null)}
      ${acmaCardRow('Polarisation', esc(dev.pol))}
      ${acmaCardRow('Feeder loss', dev.feeder_db != null ? dev.feeder_db + ' dB' : null)}
    </div>` : ''}
    <div class="acma-sect"><h4>Site</h4>
      ${acmaCardRow('Elevation', site.elevation_m != null ? site.elevation_m + ' m' : null)}
      ${acmaCardRow('Coordinate precision', esc(site.precision))}
      ${acmaCardRow('Devices at site', site.device_count)}
      ${acmaCardRow('Distance', distLine)}
      ${acmaCardRow('Line of sight', top ? 'not assessed' : null)}
    </div>
    <div class="acma-sect"><h4>Licence</h4>
      ${acmaCardRow('Licence no.', esc(dev.lic))}
      ${acmaCardRow('Status', esc(lic.status))}
      ${acmaCardRow('Type', esc(lic.type))}
      ${acmaCardRow('Category', esc(lic.category))}
      ${acmaCardRow('Service', esc(dev.service || lic.service))}
      ${acmaCardRow('Subservice', esc(dev.subservice || lic.subservice))}
      ${acmaCardRow('Issued', esc(lic.issued))}
      ${acmaCardRow('Expires', esc(lic.expiry))}
      ${acmaCardRow('Callsign', esc(dev.callsign))}
    </div>
    <div class="acma-sect"><h4>Licensee</h4>
      ${acmaCardRow('Client', esc(client.name))}
      ${acmaCardRow('Trading as', esc(client.trading))}
      ${acmaCardRow('ABN / ACN', esc([client.abn, client.acn].filter(Boolean).join(' / ')))}
      ${acmaCardRow('Industry', esc(client.industry))}
      ${acmaCardRow('Client type', esc(client.type))}
      ${acmaCardRow('Postal', esc(client.postal))}
    </div>
    ${notes.length ? `
    <div class="acma-sect"><h4>Conditions &amp; advisory notes (${notes.length})</h4>
      ${notes.map(n => `
        <details class="small" style="margin:.2rem 0">
          <summary style="cursor:pointer">${esc(n.title || n.cat || 'Note')}</summary>
          <div style="white-space:pre-wrap;color:var(--muted)">${esc(n.text || '')}</div>
        </details>`).join('')}
    </div>` : ''}
    ${cosited.length ? `
    <div class="acma-sect">
      <details>
        <summary style="cursor:pointer"><h4 style="display:inline">Co-sited devices (${cosited.length})</h4></summary>
        ${cosited.sort((a, b) => (a.f_mhz || 0) - (b.f_mhz || 0)).map(d => `
          <div class="small" style="margin:.15rem 0">
            <a href="#" onclick="showAcmaCard('${escAttr(d.id)}','${escAttr(A.cardAnchorId || '')}');return false">
              ${d.f_mhz != null ? d.f_mhz.toFixed(4) + ' MHz' : '?'}</a>
            ${esc(d.emission || '')} ${d.eirp_w != null ? '· ' + d.eirp_w + ' W EIRP' : ''}
            ${partnerIds.has(d.id) ? '<span class="badge">IMD partner</span>' : ''}
          </div>`).join('')}
      </details>
    </div>` : ''}
    <div class="small" style="color:var(--muted);padding:.4rem .6rem">
      ACMA RRL data (CC BY 4.0), extract ${esc((A.threats.meta || {}).source_date || '')}.
      Not to be used for unsolicited contact (Spam Act 2003 / DNCR Act 2006).
    </div>`;
}

// ── RF Environment tab ──

function renderRfHtml() {
  const A = state.acma;
  if (!A.loaded) {
    return `
      <div style="max-width:640px;margin:2.5rem auto;padding:1rem">
        <div class="panel" style="text-align:center;padding:2rem">
          <h2 style="margin:0 0 .6rem">RF Environment</h2>
          <p class="small" style="color:var(--muted)">
            ${A.error ? esc(A.error) : 'Loading ACMA interference data…'}</p>
        </div>
      </div>`;
  }
  const anchors = A.threats.anchors.slice().sort((a, b) => b.threats.length - a.threats.length);
  const sel = state.rf.anchorId;
  return `
    <div class="stack" style="padding:0 .25rem">
      <div class="panel">
        <div class="panel-header"><h2>RF Environment — licensed interference candidates</h2>
          <span class="small" style="color:var(--muted)">ACMA data: ${esc(A.threats.meta.source_date)} · CC BY 4.0</span>
        </div>
        <div style="display:flex;gap:1rem;flex-wrap:wrap;align-items:center;margin:.5rem 0">
          <label class="small">Repeater
            <select onchange="state.rf.anchorId=this.value;renderMain()">
              <option value="">All (${A.flat.length} threat candidates)</option>
              ${anchors.map(a => `
                <option value="${escAttr(a.station_id)}" ${sel === a.station_id ? 'selected' : ''}>
                  ${esc(a.name)} (${a.threats.length})</option>`).join('')}
            </select>
          </label>
          <label class="small">Min score
            <input type="number" min="0" max="100" step="5" value="${state.filters.acma.minScore}"
                   style="width:4.5rem"
                   onchange="state.filters.acma.minScore=+this.value;renderMain()">
          </label>
          <button onclick="rfExportCsv()">Export CSV</button>
        </div>
        ${sel ? rfStripPlotHtml(sel) : rfSummaryHtml(anchors)}
      </div>
      <div class="panel">
        <div class="panel-header"><h3>Threat candidates${sel ? ` — ${esc((A.anchorById[sel] || {}).name || sel)}` : ''}</h3></div>
        <div class="table-wrap tall" id="rf-table-wrap">${rfTableHtml()}</div>
      </div>
      <div class="panel">
        <div class="panel-header"><h3>Corruption-time correlation helper</h3></div>
        <p class="small" style="color:var(--muted)">Paste corruption timestamps (one per line,
          any parseable format). Checks whether they cluster in business hours — licensed
          operators with non-continuous operation tend to transmit 07:00–18:00 weekdays.</p>
        <textarea id="rf-corr" rows="4" style="width:100%"
                  placeholder="2026-07-12 09:41&#10;2026-07-12 10:05&#10;…">${esc(state.rf.corrText)}</textarea>
        <div style="margin:.4rem 0"><button onclick="rfCorrelate()">Analyse</button></div>
        <div id="rf-corr-out" class="small"></div>
      </div>
    </div>`;
}

function initRf() {
  const A = state.acma;
  if (!A.loaded && !A.error) {
    acmaEnsureCore().then(() => { if (state.activeTab === 'rf') renderMain(); })
                    .catch(() => { if (state.activeTab === 'rf') renderMain(); });
  }
  // strip plot carrier ticks want full device detail; refresh once it lands
  if (A.loaded && !A.devLoaded) {
    acmaEnsureDevices().then(() => { if (state.activeTab === 'rf') renderMain(); }).catch(() => {});
  }
}

function rfVisibleRows() {
  const sel = state.rf.anchorId;
  let rows = acmaVisibleThreats(true).filter(t => !sel || t.anchor_id === sel);
  const k = state.rf.sortKey, dir = state.rf.sortDir;
  const val = t => {
    switch (k) {
      case 'anchor':    return t.anchor_name || '';
      case 'mechanism': return t.mechanism;
      case 'f_mhz':     return t.f_mhz || 0;
      case 'delta':     return rfDeltaKhz(t) ?? 1e12;
      case 'distance':  return t.distance_km;
      case 'client':    return t.client || '';
      case 'lic':       return t.lic || '';
      case 'expiry':    return t.expiry || '';
      default:          return t.score;
    }
  };
  rows.sort((a, b) => {
    const va = val(a), vb = val(b);
    return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * dir;
  });
  return rows;
}

function rfDeltaKhz(t) {
  if (t.rx_mhz == null) return null;
  const f = t.product_mhz != null ? t.product_mhz : t.f_mhz;
  if (f == null) return null;
  return (f - t.rx_mhz) * 1000;
}

function rfSort(key) {
  if (state.rf.sortKey === key) state.rf.sortDir *= -1;
  else { state.rf.sortKey = key; state.rf.sortDir = key === 'score' ? -1 : 1; }
  const wrap = document.getElementById('rf-table-wrap');
  if (wrap) wrap.innerHTML = rfTableHtml();
}

function rfTableHtml() {
  const rows = rfVisibleRows();
  if (!rows.length) {
    return `<p style="padding:.75rem;color:var(--muted)">No threat candidates match the current
      filters${state.acma.mechCounts.imd3 ? '' : ' — note: no same-site IMD candidates were found in this extract'}.</p>`;
  }
  const arrow = k => state.rf.sortKey === k ? (state.rf.sortDir > 0 ? ' ▲' : ' ▼') : '';
  const th = (k, label) => `<th style="cursor:pointer" onclick="rfSort('${k}')">${label}${arrow(k)}</th>`;
  return `
    <table class="bf-table">
      <thead><tr>
        ${th('anchor', 'Repeater')}${th('mechanism', 'Mechanism')}${th('score', 'Score')}
        ${th('f_mhz', 'Freq (MHz)')}${th('delta', 'Δ (kHz)')}${th('distance', 'Dist (km)')}
        <th>LOS</th>${th('client', 'Licensee')}${th('lic', 'Licence')}${th('expiry', 'Expiry')}<th></th>
      </tr></thead>
      <tbody>
        ${rows.slice(0, 1000).map(t => {
          const m = ACMA_MECH[t.mechanism] || { label: t.mechanism, color: '#666' };
          const dk = rfDeltaKhz(t);
          return `<tr>
            <td class="small">${esc(t.anchor_name)}</td>
            <td class="small"><span class="legend-sq" style="background:${m.color}"></span> ${m.label}</td>
            <td>${t.score}</td>
            <td class="small">${t.f_mhz != null ? t.f_mhz.toFixed(4) : ''}</td>
            <td class="small" title="${esc(t.detail)}">${dk != null ? dk.toFixed(1) : ''}</td>
            <td class="small">${t.distance_km}</td>
            <td class="small">${t.los === true ? '✓' : t.los === false ? '✗' : '—'}</td>
            <td class="small">${esc(t.client || '')}${t.meganet ? ' <span class="badge">MegaNet</span>' : ''}</td>
            <td class="small">${esc(t.lic || '')}</td>
            <td class="small">${esc(t.expiry || '')}${t.inactive ? ' ⚠' : ''}</td>
            <td><a href="#" onclick="rfShowOnMap('${escAttr(t.device_id)}','${escAttr(t.anchor_id)}');return false">map</a></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    ${rows.length > 1000 ? `<p class="small" style="color:var(--muted);padding:.4rem">Showing 1000 of ${rows.length} — tighten the filters or export the CSV.</p>` : ''}`;
}

function rfSummaryHtml(anchors) {
  const withThreats = anchors.filter(a => a.threats.length);
  return `
    <div class="table-wrap medium">
      <table class="bf-table">
        <thead><tr><th>Repeater</th><th>RX (MHz)</th><th>Total</th>
          ${Object.entries(ACMA_MECH).filter(([k]) => state.acma.mechCounts[k]).map(([, m]) => `<th class="small">${m.label}</th>`).join('')}
          <th>Top score</th></tr></thead>
        <tbody>
          ${withThreats.map(a => {
            const by = {};
            a.threats.forEach(t => { by[t.mechanism] = (by[t.mechanism] || 0) + 1; });
            const top = a.threats.length ? Math.max(...a.threats.map(t => t.score)) : '';
            return `<tr style="cursor:pointer" onclick="state.rf.anchorId='${escAttr(a.station_id)}';renderMain()">
              <td>${esc(a.name)}</td><td class="small">${a.rx_mhz ?? ''}</td>
              <td><strong>${a.threats.length}</strong></td>
              ${Object.keys(ACMA_MECH).filter(k => state.acma.mechCounts[k]).map(k => `<td class="small">${by[k] || ''}</td>`).join('')}
              <td class="small">${top}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

// Frequency-axis strip plot: RX channel centre line, nearby licensed carriers
// as ticks coloured by band-plan segment (threat mechanisms override).
function rfStripPlotHtml(anchorId) {
  const A = state.acma;
  const a = A.anchorById[anchorId];
  if (!a || a.rx_mhz == null) return '';
  const rx = a.rx_mhz, span = 0.6;                     // ±0.6 MHz window
  const lo = rx - span, hi = rx + span;
  const W = 900, H = 90, pad = 30;
  const x = f => pad + (f - lo) / (hi - lo) * (W - 2 * pad);

  const threatsByDev = {};
  a.threats.forEach(t => { threatsByDev[t.device_id] = t; });

  let carriers = [];
  if (A.devLoaded) {
    const seen = new Set();
    for (const d of Object.values(A.deviceById)) {
      if (d.f_mhz == null || d.f_mhz < lo || d.f_mhz > hi) continue;
      const site = A.siteById[d.site_id];
      if (!site) continue;
      const dk = acmaHaversineKm(site.lat, site.lon, a.lat, a.lon);
      if (dk > state.filters.acma.radiusKm) continue;
      const key = d.f_mhz.toFixed(4) + '|' + d.site_id;
      if (seen.has(key)) continue;
      seen.add(key);
      carriers.push({ f: d.f_mhz, id: d.id, dk, client: d.id in threatsByDev ? threatsByDev[d.id].client : null });
    }
  } else {
    carriers = a.threats.filter(t => t.f_mhz != null && t.f_mhz >= lo && t.f_mhz <= hi)
      .map(t => ({ f: t.f_mhz, id: t.device_id, dk: t.distance_km, client: t.client }));
  }

  const segBands = VHF_SEGMENTS.filter(s => s.hi > lo && s.lo < hi).map(s => `
    <rect x="${x(Math.max(s.lo, lo))}" y="20" width="${x(Math.min(s.hi, hi)) - x(Math.max(s.lo, lo))}"
          height="${H - 40}" fill="${s.seg === 'F' ? 'rgba(2,136,209,.08)' : 'rgba(128,128,128,.05)'}">
      <title>Segment ${s.seg}: ${esc(s.alloc)}</title></rect>
    <text x="${x(Math.max(s.lo, lo)) + 3}" y="16" font-size="9" style="fill:var(--muted)">${s.seg}</text>`).join('');

  const ticks = carriers.map(c => {
    const t = threatsByDev[c.id];
    const color = t ? (ACMA_MECH[t.mechanism] || {}).color || '#888' : '#9aa7b3';
    const hgt = t ? 34 : 22;
    return `<line x1="${x(c.f)}" y1="${H - 20}" x2="${x(c.f)}" y2="${H - 20 - hgt}"
      stroke="${color}" stroke-width="${t ? 2.5 : 1.2}">
      <title>${c.f.toFixed(4)} MHz · ${c.dk.toFixed(1)} km${c.client ? ' · ' + esc(c.client) : ''}${t ? ' · ' + (ACMA_MECH[t.mechanism] || {}).label + ' ' + t.score : ''}</title></line>`;
  }).join('');

  return `
    <div style="overflow-x:auto">
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;min-width:640px;height:auto" role="img"
           aria-label="Licensed carriers near ${esc(a.name)} RX channel">
        ${segBands}
        <line x1="${pad}" y1="${H - 20}" x2="${W - pad}" y2="${H - 20}" style="stroke:var(--muted)" stroke-width="1"/>
        ${[lo, rx - 0.3, rx, rx + 0.3, hi].map(f => `
          <text x="${x(f)}" y="${H - 6}" font-size="10" text-anchor="middle" style="fill:var(--muted)">${f.toFixed(3)}</text>`).join('')}
        ${ticks}
        <line x1="${x(rx)}" y1="10" x2="${x(rx)}" y2="${H - 20}" stroke="#d32f2f" stroke-width="1.5" stroke-dasharray="5 3"/>
        <text x="${x(rx)}" y="9" font-size="10" text-anchor="middle" fill="#d32f2f">RX ${rx}</text>
      </svg>
      <div class="small" style="color:var(--muted)">${carriers.length} licensed carriers within
        ±${span} MHz and ${state.filters.acma.radiusKm} km${A.devLoaded ? '' : ' (threat candidates only — full carrier set loads with device detail)'}.
        Tall coloured ticks are classified threats; grey ticks are other licensed users.</div>
    </div>`;
}

function rfShowOnMap(deviceId, anchorId) {
  state.filters.acma.show = true;
  acmaEnsureCore().then(() => {
    switchTab('stations');
    showAcmaCard(deviceId, anchorId);
  }).catch(() => {});
}

function rfExportCsv() {
  const rows = rfVisibleRows();
  const head = ['repeater', 'rx_mhz', 'mechanism', 'score', 'freq_mhz', 'product_mhz', 'delta_khz',
                'distance_km', 'bearing_deg', 'los', 'licensee', 'licence', 'expiry', 'current',
                'meganet_own_licence', 'device_id', 'site_id', 'detail'];
  const lines = [head.join(',')];
  for (const t of rows) {
    const dk = rfDeltaKhz(t);
    lines.push([
      csvEscape(t.anchor_name), t.rx_mhz ?? '', t.mechanism, t.score,
      t.f_mhz ?? '', t.product_mhz ?? '', dk != null ? dk.toFixed(2) : '',
      t.distance_km, t.bearing_deg, t.los == null ? 'not_assessed' : t.los,
      csvEscape(t.client || ''), csvEscape(t.lic || ''), t.expiry || '',
      t.inactive ? 'no' : 'yes', t.meganet ? 'yes' : '',
      t.device_id, t.site_id, csvEscape(t.detail),
    ].join(','));
  }
  dlText(`acma-threats-${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\n'));
}

function rfCorrelate() {
  const el = document.getElementById('rf-corr-out');
  const txt = (document.getElementById('rf-corr') || {}).value || '';
  state.rf.corrText = txt;
  const stamps = txt.split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => new Date(l)).filter(d => !isNaN(d));
  if (!el) return;
  if (!stamps.length) {
    el.innerHTML = '<span style="color:var(--muted)">No parseable timestamps.</span>';
    return;
  }
  const isBiz = d => d.getDay() >= 1 && d.getDay() <= 5 && d.getHours() >= 7 && d.getHours() < 18;
  const biz = stamps.filter(isBiz).length;
  const pct = Math.round(100 * biz / stamps.length);
  // Expected share of a uniform 24×7 distribution that falls in Mon–Fri 07–18: ~33%
  const verdict = pct >= 55
    ? 'Strongly business-hours weighted — consistent with a licensed commercial operator (check non-continuous-hours candidates below).'
    : pct >= 40
      ? 'Mildly business-hours weighted — inconclusive.'
      : 'Not business-hours weighted — points away from office-hours licensees (consider continuous carriers, faulty equipment, or environmental sources).';
  const hourly = new Array(24).fill(0);
  stamps.forEach(d => hourly[d.getHours()]++);
  const maxH = Math.max(...hourly, 1);
  const bars = hourly.map((n, h) => `
    <div title="${String(h).padStart(2, '0')}:00 — ${n}" style="flex:1;display:flex;flex-direction:column;justify-content:end">
      <div style="height:${Math.round(40 * n / maxH)}px;background:var(--map-line, #ff6f00);opacity:.75"></div>
    </div>`).join('');
  const nonCont = acmaVisibleThreats(true).filter(t => {
    const d = state.acma.deviceById[t.device_id];
    return d && d.hours && d.hours !== '00:00-23:59';
  });
  el.innerHTML = `
    <p>${stamps.length} timestamps · <strong>${pct}%</strong> in business hours (Mon–Fri 07:00–18:00;
    a uniform 24×7 source would sit near 33%).<br>${verdict}</p>
    <div style="display:flex;gap:1px;height:44px;align-items:end;max-width:480px">${bars}</div>
    <div style="display:flex;justify-content:space-between;max-width:480px" class="small">
      <span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>
    ${state.acma.devLoaded
      ? (nonCont.length
          ? `<p>Visible threats with recorded non-continuous hours: ${nonCont.map(t =>
              `${esc(t.client || t.lic)} (${esc((state.acma.deviceById[t.device_id] || {}).hours)})`).join('; ')}</p>`
          : '<p style="color:var(--muted)">No visible threat has recorded non-continuous operating hours (most ACMA records leave hours blank).</p>')
      : '<p style="color:var(--muted)">Open a transmitter card once to load device detail, then re-run for per-licensee operating hours.</p>'}`;
}

// ── RF Changes tab ──────────────────────────────────────────────────────────────
// "Did something change on the air near this repeater around the date our data
// went bad?" Two views: a retrospective timeline of AUTHORISATION_DATEs (works
// from a single extract) and diffs between archived monthly snapshots (works
// from the second archive onward — removals and parameter changes are invisible
// in a single snapshot, which is why every month is retained under
// data/acma-raw/<YYYY-MM>/). All inputs precomputed by tools/acma_fetch.py and
// tools/acma_diff.py; nothing fetched until this tab is opened.
//
// Register dates are administrative: an upper bound on when interference could
// have begun, never proof that it did. Every string in this tab is worded as
// "lead", not conclusion — keep it that way.

const RFC_CLASS = {
  cotenant: { label: 'New co-tenant at a repeater site', color: '#d32f2f',
              blurb: 'A transmitter added at a site co-located with a repeater — the highest-severity change: front-end desense plus a new intermod pair with every existing carrier on the mast.' },
  added:    { label: 'Added',                  color: '#c62828',
              blurb: 'Assignment present now, absent in the earlier snapshot — a newly commissioned transmitter.' },
  removed:  { label: 'Removed',                color: '#607d8b',
              blurb: 'Assignment gone from the register — the only way a decommissioning is ever visible.' },
  freq:     { label: 'Frequency changed',      color: '#f57c00',
              blurb: 'May have moved onto or off a MegaNet channel.' },
  power:    { label: 'Power changed',          color: '#7b1fa2',
              blurb: 'TX power or EIRP differs — direct noise-floor impact.' },
  antenna:  { label: 'Antenna changed',        color: '#0288d1',
              blurb: 'Height, azimuth, tilt or antenna model differs — a re-point toward a repeater or extended reach.' },
  site:     { label: 'Site moved',             color: '#6d4c41',
              blurb: 'Assignment relocated to a different site, possibly a repeater mast.' },
  status:   { label: 'Licence status changed', color: '#455a64',
              blurb: 'Lapsed, surrendered or reinstated.' },
};

const RFC_FIELD_LABEL = {
  f_mhz: 'Frequency (MHz)', tx_w: 'TX power (W)', eirp_w: 'EIRP (W)',
  height_m: 'Antenna height (m)', az: 'Azimuth (°)', tilt: 'Tilt (°)',
  ant_id: 'Antenna', site_id: 'Site', status: 'Licence status',
};

const RFC_SERIES_COLORS = ['#0b5cab', '#c7401a', '#107c10', '#7c35a3',
                           '#b8860b', '#00838f', '#ad1457', '#5d4037'];
const RFC_MARK_CAP = 800;
const RFC_DAY = 86400000;

function initRfc() {
  const A = state.acma, R = state.rfc;
  const rerender = () => { if (state.activeTab === 'rfchanges') renderMain(); };
  if (!A.loaded && !A.error) acmaEnsureCore().then(rerender).catch(rerender);
  if (!R.loaded && !R.error) rfcEnsureData().then(rerender).catch(rerender);
}

function rfcEnsureData() {
  const R = state.rfc;
  if (R.loaded) return Promise.resolve();
  if (R.loadPromise) return R.loadPromise;
  R.loading = true;
  R.loadPromise = Promise.all([
    acmaFetchJson('acma-timeline.json'),
    acmaFetchJson('acma-changes.json').catch(() => null),    // optional
    acmaFetchJson('acma-snapshots.json').catch(() => null),  // optional
  ]).then(([tl, ch, sn]) => {
    R.timeline = tl; R.changes = ch; R.snapshots = sn;
    R.loaded = true; R.loading = false; R.error = null;
  }).catch(err => {
    R.loading = false; R.loadPromise = null;
    R.error = `RF change data unavailable (${err.message}). Generate ` +
              `data/acma-timeline.json with tools/acma_fetch.py; these files ` +
              `cannot be fetched over file://.`;
    throw err;
  });
  return R.loadPromise;
}

function rfcAnchorName(id) {
  const a = state.acma.anchorById[id];
  if (a) return a.name;
  const s = (state.data?.stations || []).find(x => x.id === id);
  return s ? s.name : id;
}

// ── event filtering / ranking ──

// Events whose best anchor match passes the current selection, radius and
// minimum-score filters. Returns { e (timeline event), a (best anchor match) }.
function rfcVisibleEvents() {
  const R = state.rfc, out = [];
  if (!R.timeline) return out;
  for (const e of R.timeline.events) {
    let best = null;
    for (const a of e.anchors || []) {
      if (R.anchorSel.size && !R.anchorSel.has(a.id)) continue;
      if (a.km > R.radiusKm || a.score < R.minScore) continue;
      if (!best || a.score > best.score) best = a;
    }
    if (best && e.date) out.push({ e, a: best });
  }
  return out;
}

// Signed days from the onset date (null when no onset is set).
function rfcDaysFromOnset(e) {
  const R = state.rfc;
  if (!R.onset) return null;
  return Math.round((Date.parse(e.date) - Date.parse(R.onset)) / RFC_DAY);
}

// coincidence = interference score × temporal proximity × co-site bonus.
// Proximity decays linearly from 1 at the onset date to 0 at the window edge
// (stated in the UI tooltip — keep the formula and the tooltip in sync).
function rfcCoincidence(row) {
  const R = state.rfc;
  const days = rfcDaysFromOnset(row.e);
  if (days === null || Math.abs(days) > R.windowDays) return null;
  const prox = Math.max(0, 1 - Math.abs(days) / R.windowDays);
  const bonus = row.a.km <= 0.25 ? 1.5 : 1;
  return { days, prox, bonus, value: row.a.score * prox * bonus };
}

// Rows for the coincidence table: windowed to onset ± window when an onset is
// set, otherwise the full visible set sorted by date (newest first).
function rfcTableRows() {
  const R = state.rfc;
  let rows = rfcVisibleEvents().map(r => ({ ...r, coin: rfcCoincidence(r) }));
  if (R.onset) rows = rows.filter(r => r.coin);
  const val = r => {
    switch (R.sortKey) {
      case 'date':   return r.e.date;
      case 'days':   return r.coin ? r.coin.days : 0;
      case 'client': return r.e.client || '';
      case 'f':      return r.e.f_mhz || 0;
      case 'delta':  return rfcDeltaKhz(r) ?? 1e12;
      case 'mech':   return r.a.mech;
      case 'eirp':   return r.e.eirp_w ?? r.e.tx_w ?? 0;
      case 'km':     return r.a.km;
      case 'score':  return r.a.score;
      default:       return r.coin ? r.coin.value : Date.parse(r.e.date);
    }
  };
  rows.sort((a, b) => {
    const va = val(a), vb = val(b);
    return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * R.sortDir;
  });
  return rows;
}

function rfcDeltaKhz(row) {
  if (row.a.mech === 'cosite_desense') return null;   // proximity, not spectrum
  const rx = (state.acma.anchorById[row.a.id] || {}).rx_mhz;
  const f = row.a.product_mhz != null ? row.a.product_mhz : row.e.f_mhz;
  if (rx == null || f == null) return null;
  return (f - rx) * 1000;
}

function rfcSort(key) {
  const R = state.rfc;
  if (R.sortKey === key) R.sortDir *= -1;
  else { R.sortKey = key; R.sortDir = (key === 'coin' || key === 'score' || key === 'date') ? -1 : 1; }
  const wrap = document.getElementById('rfc-table-wrap');
  if (wrap) wrap.innerHTML = rfcTableInnerHtml();
}

// ── selector handlers ──

function rfcSelectAllAnchors() {
  state.rfc.anchorSel = new Set();
  renderMain();
}

function rfcToggleAnchor(id, on) {
  const sel = state.rfc.anchorSel;
  if (on) sel.add(id); else sel.delete(id);
  renderMain();
}

function rfcFocusAnchor(id) {
  state.rfc.anchorSel = new Set([id]);
  renderMain();
}

function rfcUseOnset(date) {
  state.rfc.onset = date;
  renderMain();
}

function rfcCardFor(deviceId, anchorId) {
  showAcmaCard(deviceId, anchorId);
}

// ── page ──

function renderRfcHtml() {
  const A = state.acma, R = state.rfc;
  if (!A.loaded || !R.loaded) {
    const msg = A.error || R.error ||
      'Loading ACMA change-detection data…';
    return `
      <div style="max-width:640px;margin:2.5rem auto;padding:1rem">
        <div class="panel" style="text-align:center;padding:2rem">
          <h2 style="margin:0 0 .6rem">RF Changes</h2>
          <p class="small" style="color:var(--muted)">${esc(msg)}</p>
        </div>
      </div>`;
  }
  return `
    <div class="stack rfc-page" style="padding:0 .25rem;position:relative">
      <div class="panel">
        <div class="panel-header"><h2>RF Changes — what changed on the air, and when</h2>
          <span class="small" style="color:var(--muted)">ACMA data: ${esc(R.timeline.meta.source_date)} · CC BY 4.0</span>
        </div>
        <p class="small" style="color:var(--muted);margin:.3rem 0 .5rem">
          Register dates are <strong>administrative</strong>: an authorisation date is an upper
          bound on when a transmitter could have come on air — licences are often authorised
          before installation (or never installed), and equipment can radiate with no register
          entry at all. A date that lines up with a data-quality step is a
          <strong>lead to investigate</strong>, never a conclusion.</p>
        ${rfcSelectorHtml()}
      </div>
      <div class="panel">
        <div class="panel-header"><h3>Timeline — authorisations vs data quality</h3></div>
        ${rfcChartHtml()}
      </div>
      <div class="panel">
        <div class="panel-header"><h3>${R.onset ? 'Coincidence ranking' : 'Authorisation events'}</h3>
          <span style="display:flex;gap:.5rem;align-items:center">
            <span class="small" style="color:var(--muted)"
                  title="coincidence = interference score × temporal proximity × co-site bonus. Proximity decays linearly from 1 at the onset date to 0 at the window edge; ×1.5 bonus when the transmitter shares the repeater's site (≤250 m).">
              ${R.onset ? 'ranking formula ⓘ' : ''}</span>
            <button onclick="rfcExportCsv()">Export CSV</button>
          </span>
        </div>
        ${R.onset ? '' : `<p class="small" style="color:var(--muted);margin:.2rem 0">
          Set an onset date above (or detect one below) to rank these by coincidence with the
          data-quality step. This table is the evidence you would attach to an ACMA
          interference complaint.</p>`}
        <div class="table-wrap tall" id="rfc-table-wrap">${rfcTableInnerHtml()}</div>
      </div>
      <div class="panel">
        <div class="panel-header"><h3>Snapshot diff — observed register changes</h3></div>
        ${rfcDiffHtml()}
      </div>
      <div class="panel">
        <div class="panel-header"><h3>New intermod products</h3></div>
        ${rfcImdHtml()}
      </div>
      <div class="panel">
        <div class="panel-header"><h3>Onset detection helper</h3></div>
        ${rfcOnsetHelperHtml()}
      </div>
      <div class="panel">${rfcHelpHtml()}</div>
      <div id="acma-card" class="acma-card" hidden></div>
    </div>`;
}

function rfcSelectorHtml() {
  const A = state.acma, R = state.rfc;
  const anchors = A.threats.anchors.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return `
    <div style="display:flex;gap:1rem;flex-wrap:wrap;align-items:flex-start">
      <details class="rfc-picker" ${R.pickerOpen ? 'open' : ''} ontoggle="state.rfc.pickerOpen=this.open">
        <summary class="small" style="cursor:pointer">Repeaters:
          <strong>${R.anchorSel.size ? `${R.anchorSel.size} selected` : 'all'}</strong></summary>
        <div class="rfc-picker-list">
          <label style="display:flex;gap:.4rem;align-items:center">
            <input type="checkbox" ${R.anchorSel.size ? '' : 'checked'}
                   onchange="rfcSelectAllAnchors()"> <em>All repeaters</em></label>
          ${anchors.map(a => `
            <label style="display:flex;gap:.4rem;align-items:center">
              <input type="checkbox" ${R.anchorSel.has(a.station_id) ? 'checked' : ''}
                     onchange="rfcToggleAnchor('${escAttr(a.station_id)}',this.checked)">
              ${esc(a.name)}${a.rx_mhz ? ` <span class="small" style="color:var(--muted)">${a.rx_mhz}</span>` : ''}
            </label>`).join('')}
        </div>
      </details>
      <label class="small">Onset date
        <input type="date" value="${esc(R.onset)}"
               onchange="state.rfc.onset=this.value;renderMain()">
      </label>
      <label class="small">Window
        <select onchange="state.rfc.windowDays=+this.value;renderMain()">
          ${[30, 60, 90, 180].map(w => `
            <option value="${w}" ${R.windowDays === w ? 'selected' : ''}>±${w} days</option>`).join('')}
        </select>
      </label>
      <label class="small">Radius
        <select onchange="state.rfc.radiusKm=+this.value;renderMain()">
          ${[10, 25, 50, 60].map(r => `
            <option value="${r}" ${R.radiusKm === r ? 'selected' : ''}>${r} km</option>`).join('')}
        </select>
      </label>
      <label class="small">Min score
        <input type="number" min="0" max="100" step="5" value="${R.minScore}" style="width:4.5rem"
               onchange="state.rfc.minScore=+this.value;renderMain()">
      </label>
      ${R.onset ? `<button class="small" onclick="state.rfc.onset='';renderMain()">× clear onset</button>` : ''}
    </div>`;
}

// ── timeline chart ──
// Upper band: one mark per device authorisation, one lane per interference
// mechanism, sized by score. Thin lane: licence effect/expiry as lighter marks.
// Lower band: the pasted per-station corruption series, so a coincidence
// between paperwork and data quality is visible at a glance.

function rfcChartHtml() {
  const R = state.rfc;
  const rows = rfcVisibleEvents();
  const onsetMs = R.onset ? Date.parse(R.onset) : null;
  let lo, hi;
  if (onsetMs) {
    lo = onsetMs - R.windowDays * 1.5 * RFC_DAY;
    hi = onsetMs + R.windowDays * 1.5 * RFC_DAY;
  } else {
    hi = Date.now() + 7 * RFC_DAY;
    lo = hi - 730 * RFC_DAY;
  }
  const inSpan = rows.filter(r => {
    const t = Date.parse(r.e.date);
    return t >= lo && t <= hi;
  });

  const mechs = Object.keys(ACMA_MECH).filter(m => inSpan.some(r => r.a.mech === m));
  const lanes = mechs.length ? mechs : ['co_channel'];
  const W = 1000, PADL = 118, PADR = 16, laneH = 24;
  const upperTop = 10;
  const licY = upperTop + lanes.length * laneH;
  const lowerTop = licY + 18 + 14, lowerH = 78;
  const axisY = lowerTop + lowerH + 4;
  const H = axisY + 26;
  const x = t => PADL + (t - lo) / (hi - lo) * (W - PADL - PADR);

  // month gridlines, thinned to roughly a dozen labels
  const ticks = [];
  const d0 = new Date(lo);
  let ty = d0.getUTCFullYear(), tm = d0.getUTCMonth() + 1;
  const totalMonths = Math.max(1, Math.round((hi - lo) / (30.44 * RFC_DAY)));
  const stepM = Math.max(1, Math.ceil(totalMonths / 12));
  for (let i = 0; ; i++) {
    const t = Date.UTC(ty, tm, 1);
    if (t > hi) break;
    if (i % stepM === 0) ticks.push(t);
    tm++; if (tm > 11) { tm = 0; ty++; }
  }
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const tickLabel = t => {
    const d = new Date(t);
    return `${MON[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
  };

  const laneY = m => upperTop + lanes.indexOf(m) * laneH;

  const shade = onsetMs ? `
    <rect x="${x(onsetMs - R.windowDays * RFC_DAY)}" y="0"
          width="${x(onsetMs + R.windowDays * RFC_DAY) - x(onsetMs - R.windowDays * RFC_DAY)}"
          height="${axisY}" fill="rgba(211,47,47,.07)"/>
    <line x1="${x(onsetMs)}" y1="0" x2="${x(onsetMs)}" y2="${axisY}"
          stroke="#d32f2f" stroke-width="1.5" stroke-dasharray="5 3"/>
    <text x="${x(onsetMs)}" y="${axisY + 22}" font-size="10" text-anchor="middle"
          fill="#d32f2f">onset</text>` : '';

  const shown = inSpan.slice(0, RFC_MARK_CAP);
  const marks = shown.map(r => {
    const t = Date.parse(r.e.date);
    const rad = 3 + Math.min(6, r.a.score / 15);
    const c = (ACMA_MECH[r.a.mech] || {}).color || '#666';
    return `<circle cx="${x(t).toFixed(1)}" cy="${laneY(r.a.mech) + laneH / 2}" r="${rad.toFixed(1)}"
      fill="${c}" opacity=".75" style="cursor:pointer"
      onclick="rfcCardFor('${escAttr(r.e.device_id)}','${escAttr(r.a.id)}')">
      <title>${esc(r.e.date)} · ${esc(r.e.client || r.e.lic || '?')} · ${r.e.f_mhz != null ? r.e.f_mhz.toFixed(4) + ' MHz · ' : ''}${esc((ACMA_MECH[r.a.mech] || {}).label || r.a.mech)} ${r.a.score} vs ${esc(rfcAnchorName(r.a.id))} · ${r.a.km} km${r.e.variation ? ' · variation to existing licence' : ''}</title>
    </circle>`;
  }).join('');

  let licMarks = '';
  let nLic = 0;
  for (const r of shown) {
    for (const d of [r.e.lic_effect, r.e.lic_expiry]) {
      const t = d ? Date.parse(d) : NaN;
      if (isNaN(t) || t < lo || t > hi || nLic >= RFC_MARK_CAP) continue;
      nLic++;
      licMarks += `<line x1="${x(t).toFixed(1)}" y1="${licY + 3}" x2="${x(t).toFixed(1)}" y2="${licY + 13}"
        stroke="var(--muted)" stroke-width="1" opacity=".45">
        <title>${esc(d)} · licence ${d === r.e.lic_effect ? 'effect' : 'expiry'} · ${esc(r.e.client || r.e.lic || '')}</title></line>`;
    }
  }

  // lower band — corruption series
  let lower = '';
  const series = Object.entries(R.corrSeries || {}).filter(([, pts]) => pts.length);
  if (series.length) {
    let vmax = 0;
    for (const [, pts] of series) for (const p of pts) vmax = Math.max(vmax, p.v);
    vmax = vmax || 1;
    lower = series.slice(0, RFC_SERIES_COLORS.length).map(([name, pts], i) => {
      const col = RFC_SERIES_COLORS[i];
      const vis = pts.filter(p => p.t >= lo && p.t <= hi);
      const path = vis.map(p =>
        `${x(p.t).toFixed(1)},${(lowerTop + lowerH - 4 - p.v / vmax * (lowerH - 10)).toFixed(1)}`).join(' ');
      return `<polyline points="${path}" fill="none" stroke="${col}" stroke-width="1.6" opacity=".85">
        <title>${esc(name)}</title></polyline>`;
    }).join('');
  } else {
    lower = `<text x="${PADL + 8}" y="${lowerTop + lowerH / 2}" font-size="11"
      style="fill:var(--muted)">No data-quality series loaded — paste per-station corruption
      counts in the onset helper below to see coincidence at a glance.</text>`;
  }

  const legend = series.length ? `
    <div class="small" style="display:flex;gap:1rem;flex-wrap:wrap;margin-top:.2rem">
      ${series.slice(0, RFC_SERIES_COLORS.length).map(([name], i) => `
        <span class="legend-item"><span class="rfc-series-line" style="background:${RFC_SERIES_COLORS[i]}"></span>
        ${esc(name)}</span>`).join('')}
    </div>` : '';

  return `
    <div style="overflow-x:auto">
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;min-width:720px;height:auto" role="img"
           aria-label="ACMA authorisation events and data quality over time">
        ${shade}
        ${ticks.map(t => `
          <line x1="${x(t).toFixed(1)}" y1="0" x2="${x(t).toFixed(1)}" y2="${axisY}"
                stroke="var(--border)" stroke-width="1" opacity=".6"/>
          <text x="${x(t).toFixed(1)}" y="${axisY + 12}" font-size="10" text-anchor="middle"
                style="fill:var(--muted)">${tickLabel(t)}</text>`).join('')}
        ${lanes.map(m => `
          <text x="4" y="${laneY(m) + laneH / 2 + 3}" font-size="10"
                style="fill:${(ACMA_MECH[m] || {}).color || 'var(--muted)'}">${esc((ACMA_MECH[m] || {}).label || m)}</text>
          <line x1="${PADL}" y1="${laneY(m) + laneH}" x2="${W - PADR}" y2="${laneY(m) + laneH}"
                stroke="var(--border)" stroke-width=".5" opacity=".5"/>`).join('')}
        <text x="4" y="${licY + 12}" font-size="10" style="fill:var(--muted)">licence dates</text>
        ${licMarks}
        <text x="4" y="${lowerTop + 10}" font-size="10" style="fill:var(--muted)">data quality</text>
        <line x1="${PADL}" y1="${lowerTop + lowerH}" x2="${W - PADR}" y2="${lowerTop + lowerH}"
              style="stroke:var(--muted)" stroke-width="1"/>
        ${lower}
        ${marks}
      </svg>
      ${legend}
      <div class="small" style="color:var(--muted)">
        ${shown.length}${inSpan.length > shown.length ? ` of ${inSpan.length}` : ''} authorisation
        events in view · mark size = interference score · click a mark for the transmitter card.
        ${onsetMs ? 'Shaded band = the selected onset window.' : 'Showing the last 24 months — set an onset date to zoom.'}</div>
    </div>`;
}

// ── coincidence table ──

function rfcTableInnerHtml() {
  const R = state.rfc;
  const rows = rfcTableRows();
  if (!rows.length) {
    return R.onset ? `
      <div style="padding:.75rem">
        <p><strong>No register events near this onset.</strong></p>
        <p class="small" style="color:var(--muted)">A noise-floor step with no ACMA event nearby
        is itself a finding: it points away from licensed transmitters and toward your own
        infrastructure (corroding mast joints becoming an intermod mixer, a failing PA, water
        in a feeder) or an unlicensed emitter (solar charge controllers, LED signage, electric
        fences, powerline arcing). Widen the window or lower the minimum score to double-check
        before concluding.</p>
      </div>` :
      `<p style="padding:.75rem;color:var(--muted)">No authorisation events match the current
        filters — widen the radius or lower the minimum score.</p>`;
  }
  const arrow = k => R.sortKey === k ? (R.sortDir > 0 ? ' ▲' : ' ▼') : '';
  const th = (k, label, tip) => `<th style="cursor:pointer" ${tip ? `title="${escAttr(tip)}"` : ''}
    onclick="rfcSort('${k}')">${label}${arrow(k)}</th>`;
  return `
    <table class="bf-table">
      <thead><tr>
        ${th('date', 'Authorised', 'DEVICE_DETAILS.AUTHORISATION_DATE — when the frequency assignment was approved (administrative)')}
        ${R.onset ? th('days', 'Δdays') : ''}
        ${th('client', 'Licensee')}${th('f', 'Freq (MHz)')}${th('delta', 'Δf (kHz)')}
        ${th('mech', 'Mechanism')}${th('eirp', 'EIRP (W)')}${th('km', 'Dist (km)')}
        ${th('score', 'Score')}
        ${R.onset ? th('coin', 'Coincidence', 'score × temporal proximity (linear decay to 0 at window edge) × 1.5 co-site bonus') : ''}
      </tr></thead>
      <tbody>
        ${rows.slice(0, 1000).map(r => {
          const m = ACMA_MECH[r.a.mech] || { label: r.a.mech, color: '#666' };
          const dk = rfcDeltaKhz(r);
          return `<tr style="cursor:pointer"
                      onclick="rfcCardFor('${escAttr(r.e.device_id)}','${escAttr(r.a.id)}')">
            <td class="small">${esc(r.e.date)}${r.e.variation ? ' <span class="badge" title="Authorised >30 days after the licence was issued — a variation to an existing licence (added channel, power change, re-point), not a new licence">var</span>' : ''}</td>
            ${R.onset ? `<td class="small">${r.coin.days > 0 ? '+' : ''}${r.coin.days}</td>` : ''}
            <td class="small">${esc(r.e.client || '')}</td>
            <td class="small">${r.e.f_mhz != null ? r.e.f_mhz.toFixed(4) : ''}</td>
            <td class="small">${dk != null ? dk.toFixed(1) : '—'}</td>
            <td class="small"><span class="legend-sq" style="background:${m.color}"></span> ${m.label}</td>
            <td class="small">${r.e.eirp_w ?? r.e.tx_w ?? ''}</td>
            <td class="small">${r.a.km}${r.a.km <= 0.25 ? ' <span class="badge">co-site</span>' : ''}</td>
            <td>${r.a.score}</td>
            ${R.onset ? `<td><strong>${r.coin.value.toFixed(1)}</strong></td>` : ''}
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    ${rows.length > 1000 ? `<p class="small" style="color:var(--muted);padding:.4rem">Showing 1000 of ${rows.length} — tighten the filters or export the CSV.</p>` : ''}`;
}

function rfcExportCsv() {
  const R = state.rfc;
  const rows = rfcTableRows();
  const head = ['authorisation_date', 'days_from_onset', 'repeater', 'rx_mhz', 'licensee',
                'licence', 'licence_type', 'freq_mhz', 'product_mhz', 'delta_khz', 'mechanism',
                'eirp_w', 'tx_w', 'distance_km', 'co_site', 'score', 'temporal_proximity',
                'cosite_bonus', 'coincidence', 'variation_to_existing_licence',
                'licence_issued', 'licence_effect', 'licence_expiry', 'status',
                'device_id', 'site_id', 'stable_key'];
  const lines = [head.join(',')];
  for (const r of rows) {
    const dk = rfcDeltaKhz(r);
    const rx = (state.acma.anchorById[r.a.id] || {}).rx_mhz;
    lines.push([
      r.e.date, r.coin ? r.coin.days : '', csvEscape(rfcAnchorName(r.a.id)), rx ?? '',
      csvEscape(r.e.client || ''), csvEscape(r.e.lic || ''), csvEscape(r.e.lic_type || ''),
      r.e.f_mhz ?? '', r.a.product_mhz ?? '', dk != null ? dk.toFixed(2) : '',
      r.a.mech, r.e.eirp_w ?? '', r.e.tx_w ?? '', r.a.km,
      r.a.km <= 0.25 ? 'yes' : '', r.a.score,
      r.coin ? r.coin.prox.toFixed(3) : '', r.coin ? r.coin.bonus : '',
      r.coin ? r.coin.value.toFixed(2) : '',
      r.e.variation ? 'yes' : '', r.e.lic_issued || '', r.e.lic_effect || '',
      r.e.lic_expiry || '', csvEscape(r.e.status || ''),
      r.e.device_id, r.e.site_id || '', r.e.key || '',
    ].join(','));
  }
  const onset = R.onset ? `-onset-${R.onset}` : '';
  dlText(`acma-rf-changes${onset}-${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\n'));
}

// ── snapshot diff panel ──

function rfcPairs() {
  return (state.rfc.changes || {}).pairs || [];
}

function rfcSelectedPair() {
  const pairs = rfcPairs();
  if (!pairs.length) return null;
  const i = state.rfc.pairIdx;
  return pairs[i >= 0 && i < pairs.length ? i : pairs.length - 1];
}

function rfcChangeVisible(c) {
  const R = state.rfc;
  if (R.anchorSel.size && (!c.anchor || !R.anchorSel.has(c.anchor))) return false;
  if (c.anchor_km != null && c.anchor_km > R.radiusKm) return false;
  return true;
}

function rfcDiffEmptyHtml() {
  const months = ((state.rfc.snapshots || {}).snapshots || []).map(s => s.month);
  const one = months.length === 1;
  return `
    <p class="small" style="color:var(--muted)">
      Change detection compares two archived monthly subsets, and
      ${one ? `only one exists so far (<strong>${esc(months[0])}</strong>)`
            : months.length ? `the archived months (${months.map(esc).join(', ')}) have not been diffed — run tools/acma_diff.py`
            : 'none are archived yet — run tools/acma_diff.py --archive'}.
      The monthly ACMA refresh (2nd of each month, ~06:15 AEST) archives the next snapshot,
      and diffs appear here from then on — improving every month the archive grows.
      Removals and prior parameter values before the first archived month are unrecoverable:
      ACMA publishes a daily snapshot, not a back-catalogue, which is why the archive under
      <code>data/acma-raw/&lt;YYYY-MM&gt;/</code> must never be pruned.
      Until then, the authorisation timeline above is the available change axis.</p>`;
}

function rfcDiffHtml() {
  const R = state.rfc;
  const pairs = rfcPairs();
  if (!pairs.length) return rfcDiffEmptyHtml();
  const p = rfcSelectedPair();
  const latestMonth = (((R.snapshots || {}).snapshots || []).slice(-1)[0] || {}).month;
  const linkable = p.to === latestMonth;   // SDD_IDs only resolve against the current extract
  const vis = (p.changes || []).filter(rfcChangeVisible);

  const groups = [];
  const used = new Set();
  const take = (cls, pred) => {
    const g = vis.filter(c => !used.has(c) && pred(c));
    g.forEach(c => used.add(c));
    if (g.length) groups.push([cls, g]);
  };
  take('cotenant', c => c.cotenant);
  for (const cls of ['added', 'removed', 'freq', 'power', 'antenna', 'site', 'status'])
    take(cls, c => (c.classes || [c.class]).includes(cls));

  const pairSel = `
    <label class="small">Compare
      <select onchange="state.rfc.pairIdx=+this.value;renderMain()">
        ${pairs.map((q, i) => `
          <option value="${i}" ${q === p ? 'selected' : ''}>${esc(q.from)} → ${esc(q.to)}</option>`).join('')}
      </select>
    </label>
    <span class="small" style="color:var(--muted)">extracts ${esc(p.from_date || p.from)} →
      ${esc(p.to_date || p.to)} · grouped by nearest repeater · diff key: EFL_ID /
      device registration id (never SDD_ID)</span>`;

  if (!vis.length) {
    return `<div style="display:flex;gap:1rem;flex-wrap:wrap;align-items:center">${pairSel}</div>
      <p class="small" style="color:var(--muted);margin-top:.5rem">No register changes near the
      selected repeaters in this pair — the RF licensing picture was stable. If the data-quality
      step falls in this period, that points away from licensed transmitters (see the help
      notes below).</p>`;
  }

  return `
    <div style="display:flex;gap:1rem;flex-wrap:wrap;align-items:center">${pairSel}</div>
    ${groups.map(([cls, g]) => {
      const meta = RFC_CLASS[cls];
      return `
        <div style="margin-top:.7rem">
          <h4 style="margin:0 0 .1rem"><span class="legend-sq" style="background:${meta.color}"></span>
            ${meta.label} (${g.length})</h4>
          <p class="small" style="color:var(--muted);margin:.1rem 0 .3rem">${meta.blurb}</p>
          ${g.slice(0, 200).map(c => rfcChangeRowHtml(c, cls, linkable)).join('')}
          ${g.length > 200 ? `<p class="small" style="color:var(--muted)">…and ${g.length - 200} more.</p>` : ''}
        </div>`;
    }).join('')}`;
}

function rfcChangeRowHtml(c, cls, linkable) {
  const fields = c.fields ? Object.entries(c.fields)
    .filter(([k]) => cls === 'status' ? k === 'status' :
                     cls === 'freq' ? k === 'f_mhz' :
                     cls === 'power' ? (k === 'tx_w' || k === 'eirp_w') :
                     cls === 'antenna' ? ['height_m', 'az', 'tilt', 'ant_id'].includes(k) :
                     cls === 'site' ? k === 'site_id' : true)
    .map(([k, [a, b]]) => `<span style="white-space:nowrap">${RFC_FIELD_LABEL[k] || k}:
      <s style="color:var(--muted)">${esc(a ?? '—')}</s> → <strong>${esc(b ?? '—')}</strong></span>`)
    .join(' · ') : '';
  const link = linkable && c.device_id
    ? ` <a href="#" onclick="rfcCardFor('${escAttr(c.device_id)}','${escAttr(c.anchor || '')}');return false">details →</a>`
    : '';
  return `
    <div class="small" style="margin:.25rem 0;padding-left:.9rem">
      <strong>${esc(c.client || 'Unknown licensee')}</strong>
      · ${c.f_mhz != null ? c.f_mhz.toFixed(4) + ' MHz' : 'freq ?'}
      ${c.eirp_w != null ? `· ${c.eirp_w} W EIRP` : ''}
      · lic ${esc(c.lic || '?')}
      ${c.confidence === 'low' ? ' <span class="badge" title="Matched on a composite fingerprint (licence + site + frequency) because both stable identifiers were missing — treat with caution">low-confidence match</span>' : ''}
      ${c.cotenant ? ' <span class="badge" style="color:#d32f2f">co-tenant</span>' : ''}
      ${link}<br>
      <span style="color:var(--muted)">${esc(c.site_name || c.site_id || '')}
        ${c.anchor ? `· ${c.anchor_km != null ? c.anchor_km + ' km from ' : 'near '}${esc(rfcAnchorName(c.anchor))}` : ''}
        ${c.auth ? `· authorised ${esc(c.auth)}` : ''}</span>
      ${fields ? `<br>${fields}` : ''}
    </div>`;
}

// ── new IMD products panel ──

function rfcImdHtml() {
  const p = rfcSelectedPair();
  const intro = `
    <p class="small" style="color:var(--muted);margin:.2rem 0 .5rem">
      Adding one transmitter to a mast creates a third-order product with <em>every</em>
      carrier already there — the offender is often nowhere near the RX frequency itself.
      Listed below are only the products that are <strong>new in this snapshot pair</strong>
      (created by an added or re-tuned device) and land within tolerance of a repeater RX
      channel.</p>`;
  if (!p) {
    return `${intro}<p class="small" style="color:var(--muted)">Needs two archived snapshots —
      see the snapshot diff panel above.</p>`;
  }
  const latestMonth = (((state.rfc.snapshots || {}).snapshots || []).slice(-1)[0] || {}).month;
  const linkable = p.to === latestMonth;
  const R = state.rfc;
  const vis = (p.new_imd || []).filter(i =>
    (!R.anchorSel.size || R.anchorSel.has(i.anchor)) &&
    (i.anchor_km == null || i.anchor_km <= R.radiusKm));
  if (!vis.length) {
    return `${intro}<p class="small" style="color:var(--muted)">No new intermod products land
      on an RX channel in ${esc(p.from)} → ${esc(p.to)} for the selected repeaters.</p>`;
  }
  return `${intro}
    <div class="table-wrap medium">
      <table class="bf-table">
        <thead><tr><th>Product</th><th>Δ (kHz)</th><th>Order</th><th>Repeater</th>
          <th>Site</th><th>New device</th><th>Existing partner</th></tr></thead>
        <tbody>
          ${vis.slice(0, 300).map(i => `
            <tr>
              <td class="small" style="white-space:nowrap">${esc(i.formula)}</td>
              <td class="small">${i.delta_khz}</td>
              <td class="small">IMD${i.order}</td>
              <td class="small">${esc(rfcAnchorName(i.anchor))} (RX ${i.rx_mhz})</td>
              <td class="small">${esc(i.site_name || i.site_id)}</td>
              <td class="small">${linkable && i.device_id
                ? `<a href="#" onclick="rfcCardFor('${escAttr(i.device_id)}','${escAttr(i.anchor)}');return false">${esc(i.client || i.trigger_key)}</a>`
                : esc(i.client || i.trigger_key)}
                <span class="badge">${i.trigger_class === 'added' ? 'added' : 're-tuned'}</span></td>
              <td class="small">${linkable && i.partner_device_id
                ? `<a href="#" onclick="rfcCardFor('${escAttr(i.partner_device_id)}','${escAttr(i.anchor)}');return false">${esc(i.partner_client || i.partner_key)}</a>`
                : esc(i.partner_client || i.partner_key)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

// ── onset detection helper ──

function rfcParseDate(s) {
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return Date.UTC(+m[1], m[2] - 1, +m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);          // dd/mm/yyyy (AU)
  if (m) return Date.UTC(m[3].length === 2 ? 2000 + +m[3] : +m[3], m[2] - 1, +m[1]);
  const d = Date.parse(s);
  return isNaN(d) ? null : d;
}

// Accepts "date,value" (single series) or "station,date,value" per line.
function rfcParseCorr(text) {
  const series = {};
  let bad = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || /^#/.test(t) || /^station\b/i.test(t) || /^date\b/i.test(t)) continue;
    const parts = t.split(/[,;\t]+/).map(s => s.trim()).filter(Boolean);
    let name = '', ds, vs;
    if (parts.length >= 3) [name, ds, vs] = parts;
    else if (parts.length === 2) [ds, vs] = parts;
    else { bad++; continue; }
    const when = rfcParseDate(ds), v = parseFloat(vs);
    if (when == null || isNaN(v)) { bad++; continue; }
    const key = name || 'pasted series';
    (series[key] = series[key] || []).push({ t: when, v });
  }
  for (const k in series) series[k].sort((a, b) => a.t - b.t);
  return { series, bad };
}

// Rolling-median step detector — deliberately simple. A step is a shift in the
// k-point median exceeding 4× the series' robust noise estimate.
function rfcDetectSteps(series) {
  const med = arr => {
    const s = arr.slice().sort((a, b) => a - b), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const steps = [];
  for (const [name, pts] of Object.entries(series)) {
    const v = pts.map(p => p.v), n = v.length;
    const k = Math.max(3, Math.min(7, Math.floor(n / 4)));
    if (n < 2 * k) continue;
    const diffs = [];
    for (let i = 1; i < n; i++) diffs.push(Math.abs(v[i] - v[i - 1]));
    const noise = Math.max(1.4826 * med(diffs), 1e-9);
    const cand = [];
    for (let i = k; i <= n - k; i++) {
      cand.push({ i, jump: med(v.slice(i, i + k)) - med(v.slice(i - k, i)) });
    }
    cand.sort((a, b) => Math.abs(b.jump) - Math.abs(a.jump));
    const picked = [];
    for (const c of cand) {
      if (Math.abs(c.jump) < 4 * noise) break;
      if (picked.some(p => Math.abs(p.i - c.i) < k)) continue;
      picked.push(c);
      if (picked.length >= 3) break;
    }
    for (const c of picked) {
      steps.push({ station: name, date: new Date(pts[c.i].t).toISOString().slice(0, 10),
                   jump: c.jump });
    }
  }
  steps.sort((a, b) => Math.abs(b.jump) - Math.abs(a.jump));
  return steps;
}

function rfcAnalyseCorr() {
  const R = state.rfc;
  const txt = (document.getElementById('rfc-corr') || {}).value || '';
  R.corrText = txt;
  const { series, bad } = rfcParseCorr(txt);
  R.corrSeries = series;
  R.corrBad = bad;
  R.corrSteps = rfcDetectSteps(series);
  renderMain();
}

function rfcMatchStation(name) {
  const stations = state.data?.stations || [];
  const q = name.toLowerCase();
  return stations.find(s => s.id === name || (s.name || '').toLowerCase() === q) ||
         stations.find(s => (s.name || '').toLowerCase().includes(q)) || null;
}

function rfcOnsetHelperHtml() {
  const R = state.rfc;
  return `
    <p class="small" style="color:var(--muted)">Paste a per-station corruption time series —
      one line per day: <code>date, count</code> or <code>station, date, count</code>
      (ISO or dd/mm/yyyy dates). A rolling-median step detector finds sudden onsets; detected
      dates pre-fill the onset selector, and the series plots in the timeline's data-quality
      band above.</p>
    <textarea id="rfc-corr" rows="5" style="width:100%"
      placeholder="Bluff Ck, 2026-04-01, 0&#10;Bluff Ck, 2026-04-02, 1&#10;Bluff Ck, 2026-04-03, 14&#10;…">${esc(R.corrText)}</textarea>
    <div style="margin:.4rem 0"><button onclick="rfcAnalyseCorr()">Detect steps</button></div>
    ${R.corrSteps === null ? '' : rfcStepsHtml()}`;
}

function rfcStepsHtml() {
  const R = state.rfc;
  const nSeries = Object.keys(R.corrSeries || {}).length;
  if (!nSeries) {
    return `<p class="small" style="color:var(--muted)">No parseable lines${R.corrBad ? ` (${R.corrBad} rejected)` : ''}.</p>`;
  }
  const stepsHtml = R.corrSteps.length ? `
    <div class="small" style="margin:.3rem 0">Detected steps (largest first — click to set as onset):</div>
    <div style="display:flex;gap:.4rem;flex-wrap:wrap">
      ${R.corrSteps.map(s => `
        <button class="small" onclick="rfcUseOnset('${escAttr(s.date)}')"
                title="Rolling-median shift of ${s.jump > 0 ? '+' : ''}${s.jump.toFixed(1)} at ${escAttr(s.station)}">
          ${esc(s.date)} · ${esc(s.station)} ${s.jump > 0 ? '▲' : '▼'}${Math.abs(s.jump).toFixed(1)}</button>`).join('')}
    </div>` : `
    <p class="small" style="color:var(--muted)">No step larger than 4× the noise floor found in
      ${nSeries} series${R.corrBad ? ` (${R.corrBad} lines rejected)` : ''} — the change may be
      gradual rather than a step, which points away from a switched-on transmitter.</p>`;
  return stepsHtml + rfcGroupingHtml();
}

// If every affected station reports through the same repeater, the search
// narrows to one site — corruption confined to one repeater's children is
// strong evidence for a specific site rather than a network-wide problem.
function rfcGroupingHtml() {
  const R = state.rfc;
  const names = Object.keys(R.corrSeries || {}).filter(n => n !== 'pasted series');
  if (!names.length || !state.data) return '';
  const rows = names.map(n => {
    const st = rfcMatchStation(n);
    const reps = st ? findRepeaterMatches(st) : [];
    return { n, st, reps };
  });
  const matched = rows.filter(r => r.st && r.reps.length);
  let commonHtml = '';
  if (matched.length > 1) {
    const common = matched[0].reps.filter(r =>
      matched.every(m => m.reps.some(x => x.id === r.id)));
    if (common.length) {
      const c = common[0];
      const isAnchor = !!state.acma.anchorById[c.id];
      commonHtml = `
        <p class="small" style="margin:.4rem 0">
          ⚑ <strong>All ${matched.length} matched stations report through
          ${esc(c.name)}</strong> — corruption confined to one repeater's stations is strong
          evidence for something at or near that specific site.
          ${isAnchor ? `<button class="small" onclick="rfcFocusAnchor('${escAttr(c.id)}')">Focus ${esc(c.name)}</button>`
                     : `<span style="color:var(--muted)">(${esc(c.name)} has no RX frequency recorded, so it is not in the ACMA threat layer — record repeater.rx_mhz to include it.)</span>`}
        </p>`;
    } else {
      commonHtml = `
        <p class="small" style="color:var(--muted);margin:.4rem 0">
          The affected stations do not share a single repeater — that spreads the search across
          sites, or points to something common to the receive side (base station, decoder) rather
          than one repeater's RF environment.</p>`;
    }
  }
  return `
    <div style="margin-top:.5rem">
      <div class="small" style="color:var(--muted)">Which repeater serves each affected station:</div>
      <table class="bf-table" style="margin-top:.2rem">
        <thead><tr><th>Series</th><th>Matched station</th><th>Serving repeater(s)</th></tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td class="small">${esc(r.n)}</td>
              <td class="small">${r.st ? esc(r.st.name) : '<span style="color:var(--muted)">no match in stations.json</span>'}</td>
              <td class="small">${r.reps.length ? r.reps.map(x => esc(x.name)).join(', ')
                : '<span style="color:var(--muted)">—</span>'}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      ${commonHtml}
    </div>`;
}

// ── help ──

function rfcHelpHtml() {
  return `
    <details>
      <summary style="cursor:pointer"><strong>What this page will not catch</strong>
        <span class="small" style="color:var(--muted)">— read before trusting an empty result</span></summary>
      <div class="small" style="color:var(--muted);margin-top:.4rem">
        <p><strong>Anything unlicensed or faulty.</strong> Solar charge controllers, VMS/LED sign
        drivers, electric fence energisers, powerline arcing, out-of-spec or failing equipment —
        the most common sources of a raised noise floor at a remote gauging site — never appear
        in the register.</p>
        <p><strong>Removals and prior values before archiving began.</strong> ACMA publishes a
        daily snapshot with no back-catalogue; history exists only from the first archived month
        onward (see the snapshot index in the diff panel). Nothing recovers earlier months.</p>
        <p><strong>Physical installation dates.</strong> An authorisation date is when the
        paperwork was approved. Transmitters go live months later, or never.</p>
        <p><strong>Amateur transmissions.</strong> Not recorded by location — the
        50.5 MHz × 3 = 151.5 MHz harmonic path needs a spectrum sweep, not this register.</p>
        <p><strong>Degradation with no register event at all.</strong> Corroding mast joints
        maturing into an intermod mixer, a failing PA growing spurious emissions, water in a
        feeder. <strong>A step change in noise floor with no ACMA event nearby is itself a
        finding</strong> — it points at your own infrastructure, and this page says so rather
        than returning a bare empty table.</p>
        <p>Data: ACMA Register of Radiocommunications Licences (CC BY 4.0). Licensee details must
        not be used for unsolicited contact (Spam Act 2003 / DNCR Act 2006).</p>
      </div>
    </details>`;
}

// ── INTERFERENCE WORKBENCH tab ───────────────────────────────────────────────────
// A single investigation surface: select the stations you believe are affected and
// the Workbench assembles the evidence, scores five competing explanations and
// names what to check next. It argues a case rather than showing numbers — every
// score expands to its inputs, confidence is always stated, and a weak or empty
// result is reported as a finding with a next step, never a blank panel.
// Wording discipline: never "cause" — always "most consistent with" / "leading
// hypothesis" / "worth checking first".
// Reuses the Bit Flipper sensor index (H5 misattribution check), the pass-range
// helpers (H1), the ACMA threat data (suspect list, strip plot, map squares) and
// the RF Changes timeline. Nothing is fetched until the tab is opened, and the
// ACMA/RFC files only load once an investigation has a leading candidate.

const WB_HYP = {
  h1: { short: 'H1', label: 'Repeater common-mode' },
  h2: { short: 'H2', label: 'Geographic / regional' },
  h3: { short: 'H3', label: 'Channel-wide' },
  h4: { short: 'H4', label: 'Site-local, independent' },
  h5: { short: 'H5', label: 'Misattribution artefact' },
};

const WB_SYMPTOMS = {
  bitflips:       'Bit flips',
  values:         'Value corruption',
  dropouts:       'Dropouts / missing reports',
  misattribution: 'Cross-station misattribution',
  noise:          'Raised noise floor',
};

// Symptom → hypothesis score multiplier. Deliberately mild (≤1.35): the symptom
// tilts the ranking, the data decides it. Applied multiplicatively, capped at
// 0.99, and shown in every score's expandable arithmetic.
const WB_SYMPTOM_WEIGHT = {
  bitflips:       { h1: 1.10, h3: 1.10 },
  values:         { h1: 1.10, h5: 1.10 },
  dropouts:       { h2: 1.10, h3: 1.10, h4: 1.10 },
  misattribution: { h5: 1.35, h1: 0.85 },
  noise:          { h2: 1.15, h3: 1.15 },
};

const WB_CASES_KEY     = 'mn-wb-cases';
const WB_MATRIX_COLS   = 10;   // routing-matrix column cap (ranked candidates)
const WB_MATRIX_GOOD   = 15;   // known-good rows shown in the matrix
const WB_AFFECTED_COLOR = '#c7401a';
const WB_GOOD_COLOR     = '#107c10';
const WB_DISC_COLOR     = '#ff8c00';

// ── selection ──

function wbParseIds(text) {
  return [...new Set(String(text || '').split(/[\s,;]+/)
    .map(t => parseInt(t, 10))
    .filter(n => !isNaN(n) && n > 0 && n < 65536))];
}

function wbAddFromPaste(list) {
  const el = document.getElementById('wb-paste');
  const ids = wbParseIds(el ? el.value : '');
  if (!ids.length) return;
  wbAddIds(ids, list);
  if (el) el.value = '';
  renderMain();
}

function wbAddIds(ids, list) {
  const other = list === 'affected' ? 'good' : 'affected';
  state.wb[other] = state.wb[other].filter(id => !ids.includes(id));
  state.wb[list]  = [...new Set([...state.wb[list], ...ids])];
}

function wbAddStation(stationId, list) {
  const s = (state.data?.stations || []).find(x => x.id === stationId);
  if (!s) return;
  wbAddIds(stationAlertIds(s), list);
  state.wb.pickQuery = '';
  renderMain();
}

function wbRemoveId(list, id) {
  state.wb[list] = state.wb[list].filter(x => x !== id);
  renderMain();
}

function wbSwapId(list, id) {
  const other = list === 'affected' ? 'good' : 'affected';
  state.wb[list] = state.wb[list].filter(x => x !== id);
  if (!state.wb[other].includes(id)) state.wb[other].push(id);
  renderMain();
}

function wbClearCase() {
  Object.assign(state.wb, { affected: [], good: [], onset: '', onsetEnd: '',
                            symptom: '', caseName: '', lastAnalysis: null });
  renderMain();
}

// Worked example for the intro screen: flag a handful of stations behind the
// busiest documented repeater as affected plus two of its neighbours as
// known-good — a clean H1 pattern that also demonstrates the specificity
// penalty of a heavily-shared repeater.
function wbLoadExample() {
  const all = state.data.stations;
  const reps = all.filter(s => s.roles.includes('repeater') && s.repeater &&
                               (s.repeater.pass_ranges || []).length);
  let best = null, bestServed = [];
  for (const r of reps) {
    const served = all.filter(s => s.id !== r.id && s.roles.includes('field') &&
      stationAlertIds(s).some(id => passRangeCoversId(r.repeater, id)));
    if (served.length > bestServed.length) { best = r; bestServed = served; }
  }
  if (!best || bestServed.length < 7) return;
  state.wb.affected = bestServed.slice(0, 5).map(s => stationAlertIds(s)[0]);
  state.wb.good     = bestServed.slice(5, 7).map(s => stationAlertIds(s)[0]);
  state.wb.symptom  = 'bitflips';
  state.wb.caseName = 'Worked example';
  renderMain();
}

// ── bit arithmetic (shared with the Bit Flipper's mental model) ──

function wbPopcount(x) { let c = 0; while (x) { x &= x - 1; c++; } return c; }

function wbBitsDiff(a, b) {
  const out = []; const x = a ^ b;
  for (let i = 0; i < 16; i++) if (x & (1 << i)) out.push(i);
  return out;
}

// Deep-link into the existing Bit Flipper rather than reimplementing it.
function wbOpenBf(addr) {
  state.bfInput = String(addr);
  state.bfBits = '2';
  state.bfOnlyMatches = true;
  switchTab('bitflipper');
}

// ── analysis core ──

// Resolve ALERT addresses against the sensor index → unique station records
// plus the addresses that matched nothing in the database.
function wbResolve(addrs, idx) {
  const byStation = new Map(), unmatched = [];
  for (const id of addrs) {
    const hits = idx.get(id) || [];
    if (!hits.length) { unmatched.push(id); continue; }
    for (const { station } of hits) {
      if (!byStation.has(station.id)) byStation.set(station.id, { station, addrs: [] });
      const rec = byStation.get(station.id);
      if (!rec.addrs.includes(id)) rec.addrs.push(id);
    }
  }
  return { byStation, stations: [...byStation.values()].map(x => x.station), unmatched };
}

function wbMeanPairKm(stations) {
  const pts = stations.filter(s => s.lat != null && s.lon != null);
  if (pts.length < 2) return null;
  let sum = 0, n = 0;
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) {
      sum += acmaHaversineKm(pts[i].lat, pts[i].lon, pts[j].lat, pts[j].lon); n++;
    }
  return sum / n;
}

// Evaluate all five hypotheses against the current selection. Pure computation
// — no DOM, no fetches — so the same result feeds the verdict card, ranking,
// evidence panels, map and exports within one render.
function wbAnalyse() {
  const wbs = state.wb;
  const idx  = buildSensorIndex();
  const aff  = wbResolve(wbs.affected, idx);
  const goodR = wbResolve(wbs.good, idx);
  const A      = aff.stations;
  const affSet = new Set(A.map(s => s.id));
  const G      = goodR.stations.filter(s => !affSet.has(s.id));
  const goodSet = new Set(G.map(s => s.id));

  const all     = state.data.stations;
  const idsCache = new Map();
  const idsOf = s => {
    if (!idsCache.has(s.id)) idsCache.set(s.id, stationAlertIds(s));
    return idsCache.get(s.id);
  };
  const withIds = all.filter(s => idsOf(s).length);

  // Comparison universe: explicit known-good stations when given, otherwise
  // every station not flagged affected is assumed good (stated in the UI).
  const explicitGood = G.length > 0;
  const U = explicitGood ? G : withIds.filter(s => !affSet.has(s.id));

  const repeaters = all.filter(s => s.roles.includes('repeater') && s.repeater &&
    Array.isArray(s.repeater.pass_ranges) && s.repeater.pass_ranges.length);
  const repeaterRoleCount = all.filter(s => s.roles.includes('repeater')).length;
  const passes = (s, r) => s.id !== r.id && idsOf(s).some(id => passRangeCoversId(r.repeater, id));

  // station.id → repeaters whose pass ranges carry it (A ∪ U only)
  const throughMap = new Map();
  for (const s of [...A, ...U]) {
    const rs = repeaters.filter(r => passes(s, r));
    if (rs.length) throughMap.set(s.id, rs);
  }
  const A_routed = A.filter(s => throughMap.has(s.id));
  const U_routed = U.filter(s => throughMap.has(s.id));
  const A_unrouted = A.filter(s => !throughMap.has(s.id));

  // ── H1: per-repeater explanatory power ──
  const byRep = new Map();
  for (const s of A_routed) for (const r of throughMap.get(s.id)) {
    if (!byRep.has(r.id)) byRep.set(r.id, { r, passA: [], passUn: 0 });
    byRep.get(r.id).passA.push(s);
  }
  for (const s of U_routed) for (const r of throughMap.get(s.id)) {
    if (byRep.has(r.id)) byRep.get(r.id).passUn++;
  }
  const candidates = [...byRep.values()].map(c => {
    const through     = c.passA.length + c.passUn;
    const coverage    = A_routed.length ? c.passA.length / A_routed.length : 0;
    const specificity = through ? 1 - c.passUn / through : 0;
    const power = (coverage + specificity) > 0
      ? 2 * coverage * specificity / (coverage + specificity) : 0;
    return { ...c, through, coverage, specificity, power, chain: [] };
  }).sort((a, b) => b.power - a.power || b.coverage - a.coverage);

  // Two repeaters in series both score highly — flag them as a chain rather
  // than presenting them as competing suspects. R1 feeds R2 when R2's pass
  // ranges carry R1's own ALERT ids.
  const topSlice = candidates.slice(0, 6)
    .filter(c => candidates.length && c.power >= 0.75 * candidates[0].power);
  for (const c1 of topSlice) for (const c2 of topSlice) {
    if (c1 === c2) continue;
    if (idsOf(c1.r).some(id => passRangeCoversId(c2.r.repeater, id))) {
      if (!c1.chain.includes(c2.r.name)) c1.chain.push(c2.r.name);
      if (!c2.chain.includes(c1.r.name)) c2.chain.push(c1.r.name);
    }
  }
  const top = candidates[0] || null;
  const h1base = top ? top.power : 0;

  // ── affected-cluster geometry (shared by H2 and the discriminators) ──
  const affPts = A.filter(s => s.lat != null && s.lon != null);
  let cluster = null;
  if (affPts.length >= 2) {
    const cLat = affPts.reduce((t, s) => t + s.lat, 0) / affPts.length;
    const cLon = affPts.reduce((t, s) => t + s.lon, 0) / affPts.length;
    const dists = affPts.map(s => acmaHaversineKm(cLat, cLon, s.lat, s.lon));
    cluster = { lat: cLat, lon: cLon, radiusKm: Math.max(5, Math.max(...dists)) };
  }

  // ── H2: spatial clustering vs network baseline ──
  // Two terms, mirroring H1's grammar: tightness (are the affected stations
  // closer together than the network at large?) and cluster specificity (how
  // much of the affected area is actually affected? — a tight cluster where 25
  // of 30 neighbours are fine points at shared infrastructure, not geography).
  const dAff = wbMeanPairKm(A);
  const netPts = withIds.filter(s => s.lat != null && s.lon != null);
  const stride = Math.max(1, Math.ceil(netPts.length / 160));   // deterministic sample
  const sample = netPts.filter((_, i) => i % stride === 0);
  const dNet = wbMeanPairKm(sample);
  const h2ratio = (dAff != null && dNet) ? dNet / Math.max(dAff, 0.5) : null;
  const h2tight = (h2ratio == null || affPts.length < 3)
    ? 0 : Math.max(0, Math.min(1, (h2ratio - 1) / 4));
  let h2inCluster = 0, h2spec = 0;
  if (cluster && affPts.length >= 3) {
    const uIn = U.filter(s => s.lat != null && s.lon != null &&
      acmaHaversineKm(cluster.lat, cluster.lon, s.lat, s.lon) <= cluster.radiusKm).length;
    h2inCluster = uIn + affPts.length;
    h2spec = h2inCluster ? affPts.length / h2inCluster : 0;
  }
  const h2base = (h2tight + h2spec) > 0 ? 2 * h2tight * h2spec / (h2tight + h2spec) : 0;

  // ── H3: shared RX channel vs base rate ──
  const freqCount = list => {
    const m = new Map();
    for (const s of list) {
      const fs = new Set((throughMap.get(s.id) || [])
        .map(r => r.repeater.rx_mhz).filter(f => f != null));
      for (const f of fs) m.set(f, (m.get(f) || 0) + 1);
    }
    return m;
  };
  const fA = freqCount(A_routed), fU = freqCount(U_routed);
  const h3rows = [...fA.entries()].map(([f, n]) => {
    const share = A_routed.length ? n / A_routed.length : 0;
    const base  = U_routed.length ? (fU.get(f) || 0) / U_routed.length : 0;
    const lift  = base > 0 ? share / base : (share > 0 ? null : 1);  // null = no base rate
    const liftEff = lift == null ? 3 : Math.min(lift, 4);
    const score = Math.max(0, Math.min(0.9, (liftEff - 1) / 1.5)) * share;
    return { f, n, share, base, lift, score };
  }).sort((a, b) => b.score - a.score);
  const h3best = h3rows[0] || null;
  const h3base = h3best ? h3best.score : 0;

  // ── H5: near-address pairs among the selected ALERT ids ──
  const addrs = [...new Set([...wbs.affected])];
  const h5pairs = [];
  for (let i = 0; i < addrs.length; i++)
    for (let j = i + 1; j < addrs.length; j++) {
      const d = wbPopcount(addrs[i] ^ addrs[j]);
      if (d >= 1 && d <= 2)
        h5pairs.push({ a: addrs[i], b: addrs[j], d, bits: wbBitsDiff(addrs[i], addrs[j]) });
    }
  h5pairs.sort((x, y) => x.d - y.d || x.a - y.a);
  const h5d1 = h5pairs.filter(p => p.d === 1).length;
  const h5base = h5d1 ? Math.min(0.95, 0.8 + 0.05 * h5d1)
               : h5pairs.length ? 0.45 : 0.05;

  // ── H4: the residual — strong only when every shared-cause hypothesis is weak ──
  const h4base = Math.max(0.05, Math.min(0.7, 0.7 * (1 - Math.max(h1base, h2base, h3base))));

  // ── ranking, symptom weights, confidence ──
  const w = WB_SYMPTOM_WEIGHT[wbs.symptom] || {};
  const mk = (key, base) => ({
    key, ...WB_HYP[key], base,
    weight: w[key] || 1,
    score: Math.min(0.99, base * (w[key] || 1)),
  });
  const hyps = [mk('h1', h1base), mk('h2', h2base), mk('h3', h3base),
                mk('h4', h4base), mk('h5', h5base)];
  hyps.sort((a, b) => b.score - a.score);
  const lead = hyps[0], second = hyps[1];
  const gap = lead.score - second.score;

  const hOf = k => hyps.find(h => h.key === k);
  let confidence = lead.score >= 0.6 && gap >= 0.2 ? 'high'
                 : lead.score >= 0.35 && gap >= 0.08 ? 'moderate' : 'low';
  const notes = [];
  if (hOf('h1').score >= 0.45 && hOf('h2').score >= 0.45 &&
      Math.abs(hOf('h1').score - hOf('h2').score) < 0.15) {
    if (confidence === 'high') confidence = 'moderate';
    notes.push('Your affected stations share both a repeater and a location, so H1 and H2 ' +
      'cannot be separated with the current selection — repeaters serve geographic areas. ' +
      'The discriminating stations below are how to break the tie.');
  }
  if (A.length < 3) {
    confidence = 'low';
    notes.push(`Only ${A.length} affected station${A.length === 1 ? '' : 's'} resolved — ` +
      'most patterns need at least three to mean much.');
  }
  if (!explicitGood) {
    notes.push('No known-good stations marked: specificity assumes every unselected station ' +
      'is fine, which overstates it if the event is wider than your selection.');
  }
  if (A_unrouted.length) {
    notes.push(`${A_unrouted.length} affected station${A_unrouted.length === 1 ? ' has' : 's have'} ` +
      'no recorded routing — they can neither support nor refute H1 and are excluded from its arithmetic.');
  }
  if (aff.unmatched.length) {
    notes.push(`Address${aff.unmatched.length === 1 ? '' : 'es'} ${aff.unmatched.join(', ')} ` +
      'matched no station in the database — still included in the misattribution check (H5), invisible everywhere else.');
  }

  // ── discriminating stations: the highest-value observation in the analysis ──
  // Inside the affected cluster, routed via something other than the leading
  // repeater — clean strengthens H1, affected strengthens H2. Also the affected
  // stations the leading repeater does NOT explain.
  let disc = [], unexplained = [];
  if (top && cluster) {
    disc = all
      .filter(s => !affSet.has(s.id) && s.lat != null && s.lon != null && idsOf(s).length &&
                   !s.roles.includes('repeater'))
      .map(s => ({ s, km: acmaHaversineKm(cluster.lat, cluster.lon, s.lat, s.lon) }))
      .filter(x => x.km <= cluster.radiusKm)
      .filter(x => !passes(x.s, top.r))
      .map(x => ({ ...x,
        via: repeaters.filter(r => passes(x.s, r)).map(r => r.name),
        status: goodSet.has(x.s.id) ? 'known-good' : 'unchecked' }))
      .filter(x => x.via.length)
      .sort((a, b) =>
        (a.status === 'unchecked' ? 0 : 1) - (b.status === 'unchecked' ? 0 : 1) || a.km - b.km)
      .slice(0, 5);
    const inTop = new Set(top.passA.map(s => s.id));
    unexplained = A_routed.filter(s => !inTop.has(s.id));
  }

  // ── plain-language statements (kept as text; escaped at render) ──
  const stmt = {};
  stmt.h1 = top
    ? `${top.passA.length} of ${A_routed.length} routed affected stations pass through ` +
      `${top.r.name}; ${top.passUn} of the ${top.through} stations through it are unaffected.` +
      (top.chain.length ? ` In series with ${top.chain.join(', ')} — a chain, not competing suspects.` : '')
    : (A_routed.length
        ? 'No documented repeater carries any of the affected stations — H1 cannot fire.'
        : 'None of the affected stations have recorded pass-range routing, so the repeater ' +
          'hypothesis cannot be evaluated — backfilling pass ranges is the fix.');
  stmt.h2 = (h2ratio != null && affPts.length >= 3)
    ? `Affected stations are ${h2ratio.toFixed(1)}× more tightly clustered than the network ` +
      `baseline (mean spacing ${dAff.toFixed(0)} km vs ${dNet.toFixed(0)} km)` +
      (h2inCluster ? `, but ${affPts.length} of the ${h2inCluster} comparison stations inside ` +
        `that area are affected (${Math.round(h2spec * 100)}%).` : '.') +
      (h2ratio < 1.5 ? ' Not meaningfully tighter — this looks routing- or site-related, not regional.'
        : h2spec < 0.4 ? ' A tight cluster where most neighbours are fine points at shared ' +
          'infrastructure, not a blanket regional source.'
        : ' This looks regional — but repeaters serve regions too; see the confound note.')
    : 'Fewer than three affected stations have coordinates — spatial clustering cannot be assessed.';
  stmt.h3 = h3best
    ? `${Math.round(h3best.share * 100)}% of routed affected stations sit behind ` +
      `${h3best.f} MHz RX, against a ${Math.round(h3best.base * 100)}% base rate` +
      (h3best.lift == null ? ' (no unaffected comparison stations on that channel).'
        : ` — lift ${h3best.lift.toFixed(1)}×.`) +
      (h3best.lift != null && h3best.lift < 1.3
        ? ' Nearly everything shares this channel, so the overlap is uninformative.' : '')
    : 'No shared RX channel among the routed affected stations.';
  stmt.h4 = 'The residual explanation: it strengthens only as the shared-cause hypotheses ' +
    `weaken (currently max ${Math.max(h1base, h2base, h3base).toFixed(2)}). Staggered onsets ` +
    'and no shared pattern point at separate local sources — solar controllers, fences, powerline arcing.';
  stmt.h5 = h5pairs.length
    ? `${h5pairs.length} pair${h5pairs.length === 1 ? '' : 's'} of selected addresses within ` +
      `2 bit flips of each other${h5d1 ? ` (${h5d1} at distance 1)` : ''} — some "affected" ` +
      'stations may be one victim and one ghost of the same corrupted packets.'
    : 'No selected addresses within 2 bit flips of each other — the selection looks independently addressed.';

  return { aff, A, G, U, explicitGood, A_routed, U_routed, A_unrouted,
           unmatched: aff.unmatched, goodUnmatched: goodR.unmatched,
           repeaters, repeaterRoleCount, passes, throughMap,
           candidates, top,
           h2: { dAff, dNet, ratio: h2ratio, nPts: affPts.length, sampleN: sample.length,
                 tight: h2tight, spec: h2spec, inCluster: h2inCluster, base: h2base },
           h3: { rows: h3rows, best: h3best, base: h3base },
           h5: { pairs: h5pairs, d1: h5d1, base: h5base },
           h4: { base: h4base },
           h1: { base: h1base },
           hyps, lead, second, gap, confidence, notes,
           disc, unexplained, cluster,
           stmt, nextCheck: null };  // nextCheck filled below (needs stmt/disc)
}

// The one observation most likely to change the answer, phrased as an action.
function wbNextCheck(an) {
  const lead = an.lead;
  if (lead.key === 'h5' && an.h5.pairs.length) {
    const p = an.h5.pairs[0];
    return `Open addresses ${p.a} and ${p.b} in the Bit Flipper and compare their data ` +
      'series — misattributed readings appear in one series as ghosts of the other. ' +
      'Deselect the victim and re-run before trusting anything else here.';
  }
  const un = an.disc.find(d => d.status === 'unchecked');
  if ((lead.key === 'h1' || lead.key === 'h2') && un) {
    return `Station ${un.s.name} is inside the affected area but routes via ${un.via[0]}. ` +
      'If its data is clean, the repeater explanation strengthens considerably; if it is ' +
      'also affected, the pattern is more likely geographic. Check it, mark it here, re-run.';
  }
  if (lead.key === 'h1') {
    return 'Mark known-good stations — especially any inside the affected area on a ' +
      'different repeater. Specificity is currently assumed, not confirmed.';
  }
  if (lead.key === 'h2') {
    return 'Check the ACMA candidates near the cluster centre and the weather record at ' +
      'onset — a regional pattern with sudden onset suggests ducting or a new local emitter.';
  }
  if (lead.key === 'h3') {
    return 'Check a station behind the same RX channel in a different region: a channel-wide ' +
      'source crosses regions, a repeater fault does not.';
  }
  return 'Run a battery-only power-down test at each affected site (kill mains/solar, watch ' +
    'the noise floor) — the classic separator for independent site-local sources.';
}

// ── saved investigations & shareable URL state ──

function wbCases() {
  try { return JSON.parse(localStorage.getItem(WB_CASES_KEY) || '{}'); }
  catch (_) { return {}; }
}

function wbSaveCase() {
  const el = document.getElementById('wb-case-name');
  const name = ((el && el.value) || state.wb.caseName || '').trim();
  if (!name) { alert('Name the investigation first.'); return; }
  const cases = wbCases();
  cases[name] = { a: state.wb.affected, g: state.wb.good, o: state.wb.onset,
                  e: state.wb.onsetEnd, s: state.wb.symptom, saved: new Date().toISOString() };
  localStorage.setItem(WB_CASES_KEY, JSON.stringify(cases));
  state.wb.caseName = name;
  renderMain();
}

function wbLoadCase(name) {
  const c = wbCases()[name];
  if (!c) return;
  Object.assign(state.wb, { affected: c.a || [], good: c.g || [], onset: c.o || '',
                            onsetEnd: c.e || '', symptom: c.s || '', caseName: name });
  renderMain();
}

function wbDeleteCase() {
  const sel = document.getElementById('wb-case-sel');
  const name = sel && sel.value;
  if (!name) return;
  const cases = wbCases();
  delete cases[name];
  localStorage.setItem(WB_CASES_KEY, JSON.stringify(cases));
  renderMain();
}

function wbHashState() {
  const wbs = state.wb;
  if (!wbs.affected.length && !wbs.good.length) return null;
  const p = new URLSearchParams();
  p.set('a', wbs.affected.join('.'));
  if (wbs.good.length) p.set('g', wbs.good.join('.'));
  if (wbs.onset)       p.set('o', wbs.onset);
  if (wbs.onsetEnd)    p.set('e', wbs.onsetEnd);
  if (wbs.symptom)     p.set('s', wbs.symptom);
  if (wbs.caseName)    p.set('n', wbs.caseName);
  return 'wb&' + p.toString();
}

function wbSyncUrl() {
  try {
    const h = wbHashState();
    const cur = location.hash.replace(/^#/, '');
    if (h) { if (cur !== h) history.replaceState(null, '', '#' + h); }
    else if (cur.startsWith('wb')) history.replaceState(null, '', location.pathname + location.search);
  } catch (_) {}   // history API unavailable over some file:// contexts
}

function wbShareLink(btn) {
  const h = wbHashState();
  if (!h) return;
  const url = location.href.split('#')[0] + '#' + h;
  const done = ok => {
    if (!btn) return;
    const prev = btn.textContent;
    btn.textContent = ok ? 'Copied ✓' : url;
    setTimeout(() => { btn.textContent = prev; }, 2000);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => done(true), () => done(false));
  } else done(false);
}

function wbRestoreFromUrl() {
  const raw = location.hash.replace(/^#/, '');
  if (!raw.startsWith('wb')) return;
  const p = new URLSearchParams(raw.slice(3));
  const nums = v => (v || '').split(/[.,]/).map(x => parseInt(x, 10))
    .filter(n => !isNaN(n) && n > 0 && n < 65536);
  state.wb.affected = nums(p.get('a'));
  state.wb.good     = nums(p.get('g'));
  state.wb.onset    = (p.get('o') || '').slice(0, 10);
  state.wb.onsetEnd = (p.get('e') || '').slice(0, 10);
  state.wb.symptom  = WB_SYMPTOMS[p.get('s')] ? p.get('s') : '';
  state.wb.caseName = (p.get('n') || '').slice(0, 80);
  if (state.wb.affected.length || state.wb.good.length) {
    state.activeTab = 'workbench';
    renderTabs();
    renderMain();
  }
}

// ── education layer ──

// Tier 1: dotted-underline tooltip; clicking through opens the concept drawer
// (tier 3) when a concept id is given.
function wbT(text, tip, conceptId) {
  const click = conceptId ? ` onclick="wbOpenConcept('${escAttr(conceptId)}')"` : '';
  return `<span class="wb-term${conceptId ? ' wb-term-link' : ''}" tabindex="0"` +
         ` data-tip="${esc(tip)}"${click}>${esc(text)}</span>`;
}

// Tier 2: per-panel "Why this matters" expander.
function wbWhy(html) {
  return `<details class="wb-why"><summary>Why this matters</summary>
    <div class="small" style="color:var(--muted);margin-top:.35rem">${html}</div></details>`;
}

function wbEnsureConcepts() {
  const wbs = state.wb;
  if (wbs.concepts) return Promise.resolve();
  if (wbs.conceptsPromise) return wbs.conceptsPromise;
  wbs.conceptsPromise = acmaFetchJson('rf-concepts.json')
    .then(d => { wbs.concepts = d; })
    .catch(err => { wbs.conceptsPromise = null; throw err; });
  return wbs.conceptsPromise;
}

function wbOpenConcept(id) {
  state.wb.drawerId = id || null;
  const el = document.getElementById('wb-drawer');
  if (!el) return;
  el.hidden = false;
  el.innerHTML = '<div class="small" style="padding:1rem;color:var(--muted)">Loading concept notes…</div>';
  wbEnsureConcepts().then(() => wbRenderDrawer()).catch(err => {
    el.innerHTML = `<div style="padding:1rem">
      <button onclick="wbCloseDrawer()" style="float:right">×</button>
      <p class="small" style="color:var(--muted)">Concept notes unavailable (${esc(err.message)}) —
      data/rf-concepts.json cannot be fetched over file://.</p></div>`;
  });
}

function wbCloseDrawer() {
  const el = document.getElementById('wb-drawer');
  if (el) { el.hidden = true; el.innerHTML = ''; }
  state.wb.drawerId = null;
}

function wbRenderDrawer() {
  const el = document.getElementById('wb-drawer');
  const data = state.wb.concepts;
  if (!el || !data) return;
  const list = data.concepts || [];
  const cur = list.find(c => c.id === state.wb.drawerId) || null;
  const head = `
    <div class="wb-drawer-head">
      <strong>${cur ? esc(cur.title) : 'RF concepts'}</strong>
      <span>
        ${cur ? `<button onclick="wbOpenConcept('')" title="All concepts">≡</button>` : ''}
        <button onclick="wbCloseDrawer()" title="Close">×</button>
      </span>
    </div>`;
  if (!cur) {
    el.innerHTML = `${head}
      <div class="wb-drawer-body">
        <p class="small" style="color:var(--muted)">Short, field-oriented explainers. Every entry
        says what the phenomenon looks like <em>in your data</em>, not just what it is.</p>
        ${list.map(c => `<a href="#" class="wb-drawer-item"
            onclick="wbOpenConcept('${escAttr(c.id)}');return false">${esc(c.title)}</a>`).join('')}
      </div>`;
    return;
  }
  const also = (cur.see_also || []).map(id => {
    const t = list.find(c => c.id === id);
    return t ? `<a href="#" onclick="wbOpenConcept('${escAttr(id)}');return false">${esc(t.title)}</a>` : '';
  }).filter(Boolean).join(' · ');
  el.innerHTML = `${head}
    <div class="wb-drawer-body">
      <p>${esc(cur.what)}</p>
      <p><strong>In your data:</strong> ${esc(cur.in_your_data)}</p>
      <p><strong>What to do:</strong> ${esc(cur.next)}</p>
      ${also ? `<p class="small" style="color:var(--muted)">See also: ${also}</p>` : ''}
    </div>`;
}

// ── page shell ──

function renderWorkbenchHtml() {
  const wbs = state.wb;
  const hasCase = wbs.affected.length > 0;
  const an = hasCase ? wbAnalyse() : null;
  if (an) an.nextCheck = wbNextCheck(an);
  state.wb.lastAnalysis = an;
  return `
    <div class="wb-page">
      <div class="wb-layout">
        <aside class="stack wb-rail">${wbSetupHtml(an)}</aside>
        <div class="stack">${an ? wbCentreHtml(an) : wbIntroHtml()}</div>
        <aside class="stack wb-rail">${wbRightHtml(an)}</aside>
      </div>
      <div id="acma-card" class="acma-card" hidden></div>
      <div id="wb-drawer" class="wb-drawer" hidden></div>
    </div>`;
}

function initWb() {
  wbSyncUrl();
  const A = state.acma, R = state.rfc;
  const rerender = () => { if (state.activeTab === 'workbench') renderMain(); };
  // Suspects / strip plot / timeline need ACMA + RFC data — fetch only once an
  // investigation exists, and only what hasn't already been loaded elsewhere.
  if (state.wb.affected.length) {
    if (!A.loaded && !A.loadPromise && !A.error) acmaEnsureCore().then(rerender).catch(rerender);
    if (A.loaded && !A.devLoaded && !A.devPromise) acmaEnsureDevices().then(rerender).catch(() => {});
    if (!R.loaded && !R.loadPromise && !R.error) rfcEnsureData().then(rerender).catch(rerender);
  }
  initWbMap();
}

// ── left rail: investigation setup ──

function wbSetupHtml(an) {
  const wbs = state.wb;
  const cases = wbCases();
  const caseNames = Object.keys(cases).sort();
  const passRangeReps = state.data.stations.filter(s =>
    s.roles.includes('repeater') && s.repeater && (s.repeater.pass_ranges || []).length).length;
  const roleReps = state.data.stations.filter(s => s.roles.includes('repeater')).length;
  return `
    <div class="panel">
      <div class="panel-header"><h3>Investigation</h3>
        ${(wbs.affected.length || wbs.good.length) ? '<button onclick="wbClearCase()">Clear</button>' : ''}
      </div>
      <label class="small" style="display:block;margin-top:.5rem">Paste ALERT IDs
        <textarea id="wb-paste" rows="2" style="margin-top:.3rem"
          placeholder="6129, 6130 2316&#10;2320 — space, comma or newline separated"></textarea>
      </label>
      <div class="button-row" style="justify-content:flex-start;margin:.4rem 0">
        <button class="primary" onclick="wbAddFromPaste('affected')">Add as affected</button>
        <button onclick="wbAddFromPaste('good')">Add as known-good</button>
      </div>
      <label class="small" style="display:block;margin-top:.4rem">Or search stations
        <input type="search" id="wb-pick" placeholder="Station name or number…"
               value="${esc(wbs.pickQuery)}" style="margin-top:.3rem"
               oninput="state.wb.pickQuery=this.value;wbRefreshPick()">
      </label>
      <div id="wb-pick-out">${wbPickResultsHtml()}</div>
      ${wbChipsHtml('affected', 'Affected stations')}
      ${wbChipsHtml('good', 'Known-good stations')}
      <p class="small" style="color:var(--muted);margin:.5rem 0 0">
        ${wbT('Known-good', 'Stations you have checked and found fine. Marking them sharpens specificity far more than adding affected stations does.', 'coverage_specificity')}
        stations sharpen the analysis; unselected stations are otherwise assumed good.</p>
    </div>

    <div class="panel">
      <div class="panel-header"><h3>Context</h3></div>
      <div class="upload-grid" style="margin-top:.5rem">
        <label>Onset date <span class="small" style="color:var(--muted)">(blank = unknown)</span>
          <input type="date" value="${esc(wbs.onset)}"
                 onchange="state.wb.onset=this.value;renderMain()">
        </label>
        <label>Onset range end <span class="small" style="color:var(--muted)">(optional)</span>
          <input type="date" value="${esc(wbs.onsetEnd)}"
                 onchange="state.wb.onsetEnd=this.value;renderMain()">
        </label>
        <label>Symptom type
          <select onchange="state.wb.symptom=this.value;renderMain()">
            <option value="">Unknown / mixed</option>
            ${Object.entries(WB_SYMPTOMS).map(([k, v]) => `
              <option value="${k}" ${wbs.symptom === k ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
        </label>
      </div>
      <p class="small" style="color:var(--muted);margin:.5rem 0 0">The symptom mildly weights the
        hypothesis ranking (shown in each score's arithmetic); it never decides it.</p>
    </div>

    <div class="panel">
      <div class="panel-header"><h3>Save / share</h3></div>
      <div class="upload-grid" style="margin-top:.5rem">
        <label>Case name
          <input type="text" id="wb-case-name" value="${esc(wbs.caseName)}" placeholder="e.g. Mt Stuart June event"
                 oninput="state.wb.caseName=this.value">
        </label>
      </div>
      <div class="button-row" style="justify-content:flex-start;margin-top:.5rem">
        <button onclick="wbSaveCase()">Save</button>
        <button onclick="wbShareLink(this)" ${wbs.affected.length ? '' : 'disabled'}>Copy share link</button>
      </div>
      ${caseNames.length ? `
        <div style="display:flex;gap:.4rem;align-items:center;margin-top:.6rem">
          <select id="wb-case-sel" onchange="wbLoadCase(this.value)">
            <option value="">Load saved case…</option>
            ${caseNames.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}
          </select>
          <button onclick="wbDeleteCase()" title="Delete the case selected above">🗑</button>
        </div>` : ''}
      <p class="small" style="color:var(--muted);margin:.5rem 0 0">Cases save to this browser;
        the share link carries the whole investigation in the URL.</p>
    </div>

    <div class="panel">
      <div class="panel-header"><h3>Routing data quality</h3></div>
      <p class="small" style="color:var(--muted);margin:.4rem 0 0">
        ${passRangeReps} of ${roleReps} repeaters have recorded pass ranges — H1 can only see
        those.${an && an.A_unrouted.length ? ` <strong>${an.A_unrouted.length}</strong> of your affected
        stations have no routing data.` : ''} If a suspect repeater is missing here, backfilling its
        pass ranges in stations.json is the highest-value fix.</p>
    </div>`;
}

function wbChipsHtml(list, label) {
  const ids = state.wb[list];
  if (!ids.length) return '';
  // Resolve names cheaply for chip labels (re-uses the analysis index pattern).
  const idx = buildSensorIndex();
  const cls = list === 'affected' ? 'wb-chip-aff' : 'wb-chip-good';
  const swapTitle = list === 'affected' ? 'Move to known-good' : 'Move to affected';
  return `
    <div style="margin-top:.6rem">
      <div class="small" style="color:var(--muted);margin-bottom:.25rem">${label} (${ids.length})</div>
      <div class="wb-chips">
        ${ids.map(id => {
          const hits = idx.get(id) || [];
          const name = hits.length ? hits[0].station.name : 'not in database';
          return `<span class="wb-chip ${cls}${hits.length ? '' : ' wb-chip-miss'}" title="${esc(name)}">
            <strong>${id}</strong> <span class="wb-chip-name">${esc(name)}</span>
            <a href="#" title="${swapTitle}" onclick="wbSwapId('${list}',${id});return false">⇄</a>
            <a href="#" title="Remove" onclick="wbRemoveId('${list}',${id});return false">×</a>
          </span>`;
        }).join('')}
      </div>
    </div>`;
}

function wbRefreshPick() {
  const el = document.getElementById('wb-pick-out');
  if (el) el.innerHTML = wbPickResultsHtml();
}

function wbPickResultsHtml() {
  const q = (state.wb.pickQuery || '').trim().toLowerCase();
  if (q.length < 2) return '';
  const hits = state.data.stations.filter(s => stationAlertIds(s).length &&
    (s.name.toLowerCase().includes(q) || (s.station_number || '').includes(q))).slice(0, 8);
  if (!hits.length) return '<p class="small" style="color:var(--muted);margin:.4rem 0 0">No stations with ALERT ids match.</p>';
  return `
    <div class="wb-pick-list">
      ${hits.map(s => `
        <div class="wb-pick-row">
          <span>${esc(s.name)} <span class="small" style="color:var(--muted)">${stationAlertIds(s).join(', ')}</span></span>
          <span>
            <button onclick="wbAddStation('${escAttr(s.id)}','affected')" title="Add as affected">+ aff</button>
            <button onclick="wbAddStation('${escAttr(s.id)}','good')" title="Add as known-good">+ good</button>
          </span>
        </div>`).join('')}
    </div>`;
}

// ── intro (empty state) ──

function wbIntroHtml() {
  return `
    <div class="panel">
      <div class="panel-header"><h2>Interference Workbench</h2></div>
      <p style="max-width:75ch">Select the stations you believe are affected (left) and the
        Workbench assembles the evidence spread across Map, Networks, Bit Flipper, RF Environment
        and RF Changes into one argued case: five competing explanations, scored, with the
        arithmetic open to inspection and the most informative next check named.</p>
      <div class="table-wrap" style="margin-top:.5rem">
        <table>
          <thead><tr><th style="width:16%">Hypothesis</th><th>Signature in the selected stations</th></tr></thead>
          <tbody>
            <tr><td><strong>H1</strong> Repeater common-mode</td><td class="small">Affected stations share a repeater path; unaffected ones mostly don't.</td></tr>
            <tr><td><strong>H2</strong> Geographic / regional</td><td class="small">Affected stations cluster spatially regardless of routing.</td></tr>
            <tr><td><strong>H3</strong> Channel-wide</td><td class="small">Affected stations share an RX frequency across different repeaters.</td></tr>
            <tr><td><strong>H4</strong> Site-local, independent</td><td class="small">No shared path, cluster or channel — staggered onsets, separate local sources.</td></tr>
            <tr><td><strong>H5</strong> Misattribution artefact</td><td class="small">"Affected" stations 1 address bit apart — data bleeding across IDs via bit flips. Checked first, because it invalidates the selection itself.</td></tr>
          </tbody>
        </table>
      </div>
      <div class="button-row" style="justify-content:flex-start;margin-top:.75rem">
        <button class="primary" onclick="wbLoadExample()">Load a worked example</button>
        <button onclick="wbOpenConcept('')">Open the RF concept notes</button>
      </div>
      <p class="small" style="color:var(--muted);margin-top:.6rem">The Workbench never claims a
        cause. It ranks explanations by how well they fit, states its confidence, and tells you
        what would most change the answer.</p>
    </div>`;
}

// ── centre column ──

function wbCentreHtml(an) {
  return `
    ${an.h5.pairs.length ? wbH5BannerHtml(an) : ''}
    ${wbVerdictHtml(an)}
    ${wbRankingHtml(an)}
    ${wbH5PanelHtml(an)}
    ${wbMatrixHtml(an)}
    ${wbMapPanelHtml(an)}
    ${wbTimelineHtml(an)}
    ${wbStripHtml(an)}
    ${wbBlindSpotsHtml()}`;
}

// H5 warning shown before ANY other analysis — a bit-flip pair means the
// selection itself may be wrong, which invalidates everything below it.
function wbH5BannerHtml(an) {
  const p = an.h5.pairs[0];
  return `
    <div class="wb-banner">
      <strong>⚠ Check misattribution first.</strong>
      Addresses ${an.h5.pairs.map(x => `${x.a} / ${x.b} (${x.d} bit${x.d > 1 ? 's' : ''})`).join(', ')}
      are within 2 bit flips of each other. With no
      ${wbT('payload protection', 'The plain ALERT Binary Format has no checksum over address or data — any flipped bit is accepted as truth.', 'no_crc')}
      in ALERT Binary Format, one may be the victim of the other's corrupted packets rather than
      independently affected — which would change this entire selection.
      <button style="margin-left:.5rem" onclick="wbOpenBf(${p.a})">Open ${p.a} in Bit Flipper</button>
    </div>`;
}

function wbVerdictHtml(an) {
  const lead = an.lead;
  const top = an.top;
  const conf = { high: 'High', moderate: 'Moderate', low: 'Low' }[an.confidence];
  let confWhy = `${lead.short} scores ${lead.score.toFixed(2)} against ${an.second.short} at ${an.second.score.toFixed(2)}.`;
  if (lead.key === 'h1' && top && top.specificity < 0.5 && top.coverage >= 0.8) {
    confWhy += ` Specificity is weak because ${esc(top.r.name)} carries most of this sub-network.`;
  }
  const title = lead.key === 'h1' && top
    ? `${lead.label} — ${esc(top.r.name)}` : lead.label;
  return `
    <div class="panel wb-verdict">
      <div class="small" style="color:var(--muted)">Leading hypothesis — most consistent with the evidence, not a proven cause</div>
      <h2 style="margin:.25rem 0">${title}</h2>
      <p style="margin:.3rem 0">${esc(an.stmt[lead.key])}</p>
      ${lead.key === 'h1' && top ? `
        <p class="small" style="margin:.3rem 0">
          ${wbT('Coverage', 'What fraction of the affected stations pass through this repeater — does it explain all of them?', 'coverage_specificity')} ${top.coverage.toFixed(2)}
          · ${wbT('Specificity', 'How well the repeater avoids explaining stations that are fine. Low specificity: it is on almost everyone’s path, so its involvement is less informative.', 'coverage_specificity')} ${top.specificity.toFixed(2)}
          · ${wbT('Explanatory power', 'Harmonic mean (F1) of coverage and specificity — punishes a candidate weak on either.', 'coverage_specificity')} ${top.power.toFixed(2)}</p>` : ''}
      <p style="margin:.35rem 0"><strong>Confidence: ${conf}.</strong> <span class="small">${confWhy}</span></p>
      <p style="margin:.35rem 0"><strong>Most informative next check:</strong> ${esc(an.nextCheck)}</p>
      ${an.notes.length ? `<div class="wb-notes">${an.notes.map(n => `<p class="small">▸ ${esc(n)}</p>`).join('')}</div>` : ''}
    </div>`;
}

function wbRankingHtml(an) {
  const arith = { h1: wbArithH1, h2: wbArithH2, h3: wbArithH3, h4: wbArithH4, h5: wbArithH5 };
  return `
    <div class="panel">
      <div class="panel-header"><h3>Hypothesis ranking</h3>
        <span class="small" style="color:var(--muted)">all five scored — losing hypotheses stay visible</span></div>
      ${an.hyps.map((h, i) => `
        <details class="wb-hyp">
          <summary>
            <span class="wb-hyp-rank">#${i + 1}</span>
            <span class="wb-hyp-name"><strong>${h.short}</strong> ${h.label}</span>
            <span class="wb-hyp-bar"><span style="width:${Math.round(h.score * 100)}%"></span></span>
            <span class="wb-hyp-score">${h.score.toFixed(2)}</span>
          </summary>
          <div class="wb-hyp-body">
            <p class="small" style="margin:.3rem 0">${esc(an.stmt[h.key])}</p>
            ${arith[h.key](an, h)}
          </div>
        </details>`).join('')}
      ${wbWhy(`A dashboard would show you one number; an investigation needs the competition.
        Seeing that H2 scored nearly as high as H1 tells you the case is not settled — and the
        arithmetic under each score shows exactly which stations drive it, so a number you cannot
        interrogate never has to be taken on faith.`)}
    </div>`;
}

function wbWeightRow(h) {
  return h.weight !== 1
    ? `<div class="acma-row"><span>× symptom weight (${esc(WB_SYMPTOMS[state.wb.symptom] || '')})</span><span>${h.weight.toFixed(2)} → ${h.score.toFixed(2)}</span></div>`
    : `<div class="acma-row"><span>symptom weight</span><span>1.00 (none)</span></div>`;
}

function wbArithH1(an, h) {
  if (!an.top) {
    return `<div class="wb-arith small">
      ${an.A_routed.length
        ? `Routed affected stations: ${an.A_routed.length}, but no documented repeater carries any of them.`
        : `Affected stations with routing data: 0 of ${an.A.length}. Pass ranges are recorded for
           ${an.repeaters.length} of ${an.repeaterRoleCount} repeaters — the gap is data, not analysis.`}
      ${wbWeightRow(h)}</div>`;
  }
  const t = an.top;
  const universe = an.explicitGood
    ? `the ${an.U.length} stations you marked known-good`
    : `all ${an.U.length} stations not flagged affected (assumed good)`;
  return `<div class="wb-arith small">
    <div class="acma-row"><span>unaffected universe</span><span>${universe}</span></div>
    <div class="acma-row"><span>coverage = |A ∩ through| / |A routed|</span><span>${t.passA.length} / ${an.A_routed.length} = ${t.coverage.toFixed(2)}</span></div>
    <div class="acma-row"><span>specificity = 1 − |U ∩ through| / |through|</span><span>1 − ${t.passUn}/${t.through} = ${t.specificity.toFixed(2)}</span></div>
    <div class="acma-row"><span>explanatory power = 2cs/(c+s)</span><span>${t.power.toFixed(2)}</span></div>
    ${wbWeightRow(h)}
    ${t.chain.length ? `<div class="acma-row"><span>chain</span><span>in series with ${esc(t.chain.join(', '))}</span></div>` : ''}
    ${an.A_unrouted.length ? `<div class="acma-row"><span>excluded (no routing)</span><span>${an.A_unrouted.map(s => esc(s.name)).join(', ')}</span></div>` : ''}
  </div>`;
}

function wbArithH2(an, h) {
  const H = an.h2;
  if (H.ratio == null || H.nPts < 3) {
    return `<div class="wb-arith small">Needs ≥3 affected stations with coordinates (have ${H.nPts}). ${wbWeightRow(h)}</div>`;
  }
  return `<div class="wb-arith small">
    <div class="acma-row"><span>mean pairwise distance, affected (${H.nPts} stations)</span><span>${H.dAff.toFixed(1)} km</span></div>
    <div class="acma-row"><span>network baseline (${H.sampleN}-station sample)</span><span>${H.dNet.toFixed(1)} km</span></div>
    <div class="acma-row"><span>tightness = clamp((baseline/affected − 1) / 4, 0–1)</span><span>${H.ratio.toFixed(2)}× → ${H.tight.toFixed(2)}</span></div>
    <div class="acma-row"><span>cluster specificity = affected in area / stations in area</span><span>${H.nPts}/${H.inCluster} = ${H.spec.toFixed(2)}</span></div>
    <div class="acma-row"><span>score = 2ts/(t+s) — same F1 grammar as H1</span><span>${H.base.toFixed(2)}</span></div>
    ${wbWeightRow(h)}
    <div class="acma-row"><span>confound</span><span>repeaters serve areas — see discriminating stations</span></div>
  </div>`;
}

function wbArithH3(an, h) {
  const H = an.h3;
  if (!H.rows.length) return `<div class="wb-arith small">No routed affected stations, so no channel statistics. ${wbWeightRow(h)}</div>`;
  return `<div class="wb-arith small">
    ${H.rows.slice(0, 4).map(r => `
      <div class="acma-row"><span>${r.f} MHz — affected ${Math.round(r.share * 100)}% vs base ${Math.round(r.base * 100)}%</span>
        <span>lift ${r.lift == null ? '∞ (capped 3)' : r.lift.toFixed(2) + '×'} → ${r.score.toFixed(2)}</span></div>`).join('')}
    <div class="acma-row"><span>score = clamp((lift − 1)/1.5, 0–0.9) × affected share</span><span>${H.base.toFixed(2)}</span></div>
    ${wbWeightRow(h)}
    <div class="acma-row"><span>why relative to base rate</span><span>68 of 88 documented repeaters share 151.5 MHz — raw sharing always fires</span></div>
  </div>`;
}

function wbArithH4(an, h) {
  return `<div class="wb-arith small">
    <div class="acma-row"><span>residual = 0.7 × (1 − max(H1, H2, H3 base))</span>
      <span>0.7 × (1 − ${Math.max(an.h1.base, an.h2.base, an.h3.base).toFixed(2)}) = ${an.h4.base.toFixed(2)}</span></div>
    ${wbWeightRow(h)}
    <div class="acma-row"><span>capped at 0.7</span><span>a residual can lead, never dominate</span></div>
  </div>`;
}

function wbArithH5(an, h) {
  const H = an.h5;
  return `<div class="wb-arith small">
    <div class="acma-row"><span>selected address pairs at Hamming distance 1 / 2</span><span>${H.d1} / ${H.pairs.length - H.d1}</span></div>
    <div class="acma-row"><span>score</span><span>${H.d1 ? 'distance-1 pair(s): 0.8 + 0.05 each, cap 0.95' : H.pairs.length ? 'distance-2 only: 0.45' : 'none: 0.05 baseline'} = ${H.base.toFixed(2)}</span></div>
    ${wbWeightRow(h)}
  </div>`;
}

// ── evidence panels ──

function wbH5PanelHtml(an) {
  const H = an.h5;
  return `
    <div class="panel">
      <div class="panel-header"><h3>1 · Address bit-flip check (H5)</h3>
        <span class="small" style="${H.pairs.length ? 'color:var(--warn)' : 'color:var(--ok)'}">
          ${H.pairs.length ? `${H.pairs.length} suspect pair${H.pairs.length > 1 ? 's' : ''}` : 'clear'}</span></div>
      <p class="small" style="color:var(--muted);margin:.4rem 0">Runs first because it can invalidate
        the selection: with 13 unprotected address bits, a single flip re-attributes a reading to a
        station whose ID differs by a power of two. Pairwise XOR over the selected addresses,
        flagging ${wbT('Hamming distance', 'How many bits differ between two addresses. Distance 1 = reachable by a single bit error.', 'hamming')} ≤ 2.</p>
      ${H.pairs.length ? `
        <div class="table-wrap">
          <table class="bf-table" style="min-width:560px">
            <thead><tr><th>Address A</th><th>Address B</th><th>Distance</th><th>Differing bit(s)</th><th></th></tr></thead>
            <tbody>${H.pairs.map(p => {
              const nameOf = a => { const rec = an.aff.byStation; for (const { station, addrs } of rec.values()) if (addrs.includes(a)) return station.name; return '—'; };
              return `<tr>
                <td>${p.a} <span class="small" style="color:var(--muted)">${esc(nameOf(p.a))}</span></td>
                <td>${p.b} <span class="small" style="color:var(--muted)">${esc(nameOf(p.b))}</span></td>
                <td>${p.d}</td>
                <td class="small mono">bit ${p.bits.join(', bit ')}</td>
                <td><button onclick="wbOpenBf(${p.a})">Bit Flipper →</button></td>
              </tr>`;
            }).join('')}</tbody>
          </table>
        </div>
        <p class="small" style="color:var(--warn);margin:.4rem 0 0">These stations may not be
          independently affected — compare their data series before treating them as separate evidence.</p>`
      : `<p class="small" style="color:var(--ok);margin:.4rem 0 0">✓ No selected addresses within 2 bit
          flips of each other — the selection looks independently addressed, and the rest of the
          analysis can be read at face value.</p>`}
      ${wbWhy(`An operator seeing bad data at stations 2316 and 2320 may believe both are affected
        when one is the victim of the other's corrupted packets (they differ by a single bit).
        Because this corrupts the input to every other hypothesis, it is checked before anything
        else is presented. The check reuses the Bit Flipper's address index — open any pair there
        for the full variant table and ARRO graph links.`)}
    </div>`;
}

function wbMatrixHtml(an) {
  const cols = an.candidates.slice(0, WB_MATRIX_COLS);
  if (!cols.length) {
    return `
    <div class="panel">
      <div class="panel-header"><h3>2 · Routing / pass-range matrix</h3></div>
      <p class="small" style="color:var(--muted);margin:.4rem 0 0">No documented repeater carries any
        selected station, so there is no matrix to draw. That is a finding: either these stations'
        routing is undocumented (see routing data quality, left) or their paths genuinely don't
        share infrastructure — which points at H2/H4, not H1.</p>
    </div>`;
  }
  const rows = [
    ...an.A.map(s => ({ s, cls: 'wb-row-aff', tag: 'affected' })),
    ...an.G.slice(0, WB_MATRIX_GOOD).map(s => ({ s, cls: 'wb-row-good', tag: 'known-good' })),
  ];
  return `
    <div class="panel">
      <div class="panel-header"><h3>2 · Routing / pass-range matrix</h3>
        <span class="small" style="color:var(--muted)">● = station's ALERT id inside repeater's pass ranges</span></div>
      <div class="table-wrap" style="margin-top:.5rem">
        <table class="wb-matrix">
          <thead><tr>
            <th style="min-width:140px">Station</th>
            ${cols.map(c => `<th class="wb-m-h" title="${esc(c.r.name)} — power ${c.power.toFixed(2)}"><span>${esc(c.r.name)}</span></th>`).join('')}
          </tr></thead>
          <tbody>
            ${rows.map(row => `
              <tr class="${row.cls}">
                <td title="${row.tag}">${esc(row.s.name)}
                  <span class="small" style="color:var(--muted)">${(stationAlertIds(row.s) || []).join(', ')}</span></td>
                ${cols.map(c => {
                  const hit = an.passes(row.s, c.r);
                  return `<td class="wb-m${hit ? ' hit' : ''}">${hit ? '●' : ''}</td>`;
                }).join('')}
              </tr>`).join('')}
          </tbody>
          <tfoot>
            <tr><td class="small">coverage</td>${cols.map(c => `<td class="small">${c.coverage.toFixed(2)}</td>`).join('')}</tr>
            <tr><td class="small">specificity</td>${cols.map(c => `<td class="small">${c.specificity.toFixed(2)}</td>`).join('')}</tr>
            <tr><td class="small"><strong>power</strong></td>${cols.map(c => `<td class="small"><strong>${c.power.toFixed(2)}</strong></td>`).join('')}</tr>
          </tfoot>
        </table>
      </div>
      ${an.candidates.length > cols.length ? `<p class="small" style="color:var(--muted);margin:.4rem 0 0">Top ${cols.length} of ${an.candidates.length} candidate repeaters shown, ranked by explanatory power.</p>` : ''}
      ${wbWhy(`The visual pattern usually makes the answer obvious before any score is read: a solid
        column of dots on the affected (red) rows that is sparse on the known-good (green) rows IS
        the repeater hypothesis. A column solid on both is a repeater that carries everything —
        high coverage, low specificity, uninformative. Red rows with no dots at all are the
        stations the leading repeater cannot explain.`)}
    </div>`;
}

function wbMapPanelHtml(an) {
  return `
    <div class="panel">
      <div class="panel-header"><h3>3 · Map</h3></div>
      <div class="map-legend" style="margin:.4rem 0">
        <span class="legend-item"><span class="legend-dot" style="background:${WB_AFFECTED_COLOR}"></span><span class="small">Affected</span></span>
        <span class="legend-item"><span class="legend-dot" style="background:${WB_GOOD_COLOR}"></span><span class="small">Known-good</span></span>
        <span class="legend-item"><span class="legend-dot" style="background:#0b5cab"></span><span class="small">Candidate repeater (sized by power)</span></span>
        <span class="legend-item"><span class="legend-dot" style="background:${WB_DISC_COLOR}"></span><span class="small">Discriminating station</span></span>
        ${state.acma.loaded && an.top ? `<span class="legend-item"><span class="legend-sq" style="background:#7b1fa2"></span><span class="small">ACMA threat (top candidate)</span></span>` : ''}
      </div>
      <div id="wb-map" style="height:430px;border-radius:6px"></div>
      ${an.disc.length ? `
        <div style="margin-top:.6rem">
          <div class="small"><strong>Discriminating stations</strong> — inside the affected area, routed differently; the highest-value observation available:</div>
          <div class="table-wrap" style="margin-top:.35rem">
            <table style="table-layout:auto"><thead><tr><th>Station</th><th>Routes via</th><th>km from cluster centre</th><th>Status</th></tr></thead>
            <tbody>${an.disc.map(d => `
              <tr><td>${esc(d.s.name)}</td><td class="small">${esc(d.via.join(', '))}</td>
                <td class="small">${d.km.toFixed(0)}</td>
                <td class="small">${d.status === 'known-good'
                  ? '<span style="color:var(--ok)">known-good — already supports H1</span>'
                  : '<span style="color:var(--warn)">unchecked — go look at its data</span>'}</td></tr>`).join('')}
            </tbody></table>
          </div>
        </div>`
      : an.top ? `<p class="small" style="color:var(--muted);margin:.5rem 0 0">No discriminating
          stations found: every routed station inside the affected area passes through
          ${esc(an.top.r.name)} too, so geography and routing cannot be separated from this
          selection alone. Widening the known-good set is the way forward.</p>` : ''}
      ${wbWhy(`H1 and H2 are confounded — repeaters serve geographic areas, so stations sharing a
        repeater are usually also near each other. The discriminator is a station inside the
        affected cluster on a different repeater: if it is clean, the repeater explanation gains;
        if it is affected, the geographic one does. Checking one named station is worth more than
        any amount of re-scoring.`)}
    </div>`;
}

function wbTimelineHtml(an) {
  const R = state.rfc;
  const wbs = state.wb;
  const topIds = new Set(an.candidates.slice(0, 3).map(c => c.r.id));
  let body;
  if (!topIds.size) {
    body = `<p class="small" style="color:var(--muted)">No candidate repeaters — register activity
      cannot be anchored to a suspect. If routing data is the blocker, that comes first.</p>`;
  } else if (R.error) {
    body = `<p class="small" style="color:var(--muted)">${esc(R.error)}</p>`;
  } else if (!R.loaded) {
    body = `<p class="small" style="color:var(--muted)">Loading register timeline…</p>`;
  } else {
    const onsetMid = wbs.onset
      ? (Date.parse(wbs.onset) + (wbs.onsetEnd ? Date.parse(wbs.onsetEnd) : Date.parse(wbs.onset))) / 2
      : null;
    const rows = [];
    for (const e of R.timeline.events) {
      let best = null;
      for (const a of e.anchors || []) {
        if (!topIds.has(a.id)) continue;
        if (!best || a.score > best.score) best = a;
      }
      if (!best || !e.date) continue;
      const days = onsetMid != null ? Math.round((Date.parse(e.date) - onsetMid) / 86400000) : null;
      if (onsetMid != null && Math.abs(days) > 120) continue;
      rows.push({ e, a: best, days });
    }
    rows.sort((x, y) => onsetMid != null
      ? Math.abs(x.days) - Math.abs(y.days)
      : (y.e.date || '').localeCompare(x.e.date || ''));
    const shown = rows.slice(0, 8);
    body = shown.length ? `
      <div class="table-wrap">
        <table style="table-layout:auto"><thead><tr>
          <th>Date</th>${onsetMid != null ? '<th>Δ onset</th>' : ''}<th>Licensee</th><th>Mechanism</th><th>Score</th><th>km</th><th>Near</th></tr></thead>
        <tbody>${shown.map(r => `
          <tr>
            <td class="small">${esc(r.e.date)}</td>
            ${onsetMid != null ? `<td class="small">${r.days > 0 ? '+' : ''}${r.days} d</td>` : ''}
            <td class="small">${esc(r.e.client || '?')}</td>
            <td class="small"><span class="legend-sq" style="background:${(ACMA_MECH[r.a.mech] || {}).color || '#666'}"></span> ${(ACMA_MECH[r.a.mech] || {}).label || esc(r.a.mech)}</td>
            <td class="small">${r.a.score}</td>
            <td class="small">${r.a.km}</td>
            <td class="small">${esc(rfcAnchorName(r.a.id))}</td>
          </tr>`).join('')}</tbody></table>
      </div>
      <p class="small" style="color:var(--muted);margin:.4rem 0 0">${onsetMid != null
        ? `Register events within ±120 days of onset, nearest first. An authorisation date is when paperwork was approved — an upper bound on when interference could have begun, never proof that it did.`
        : 'No onset date set — showing the most recent register events near the top candidates. Set an onset date (left) to rank by temporal proximity.'}</p>`
    : `<p class="small" style="color:var(--muted)"><strong>No register events near the leading
        candidates${onsetMid != null ? ' within ±120 days of onset' : ''}.</strong> That is a
        finding, not a failure: it points away from newly licensed transmitters and toward
        register-invisible sources — your own infrastructure (corrosion, equipment fault) or
        unlicensed emitters. The site-visit checklist covers those.</p>`;
    body += `<div class="button-row" style="justify-content:flex-start;margin-top:.5rem">
      <button onclick="wbOpenRfc()">Open in RF Changes →</button></div>`;
  }
  return `
    <div class="panel">
      <div class="panel-header"><h3>4 · Register activity vs onset</h3></div>
      <p class="small" style="color:var(--muted);margin:.4rem 0">Simultaneous onset across stations
        argues an external event; staggered onsets argue progressive degradation such as corrosion.
        ${wbT('ACMA register', 'The Register of Radiocommunications Licences records authorisations, not what is actually radiating.', 'acma_register')}
        events near the candidates are leads to correlate, not conclusions.</p>
      ${body}
    </div>`;
}

function wbOpenRfc() {
  const an = state.wb.lastAnalysis;
  if (an) state.rfc.anchorSel = new Set(an.candidates.slice(0, 3).map(c => c.r.id));
  if (state.wb.onset) state.rfc.onset = state.wb.onset;
  switchTab('rfchanges');
}

function wbStripHtml(an) {
  if (!an.top) return '';
  const A = state.acma;
  let body;
  if (A.error)        body = `<p class="small" style="color:var(--muted)">${esc(A.error)}</p>`;
  else if (!A.loaded) body = `<p class="small" style="color:var(--muted)">Loading ACMA carrier data…</p>`;
  else if (!A.anchorById[an.top.r.id]) {
    body = `<p class="small" style="color:var(--muted)">${esc(an.top.r.name)} is not an anchor in the
      ACMA extract${an.top.r.repeater.rx_mhz == null ? ' — it has no recorded RX frequency, which is the same backfill gap flagged under routing data quality' : ''}.
      Re-run tools/acma_fetch.py after fixing stations.json to include it.</p>`;
  } else {
    body = rfStripPlotHtml(an.top.r.id);
  }
  return `
    <div class="panel">
      <div class="panel-header"><h3>5 · Frequency neighbourhood — ${esc(an.top.r.name)}</h3></div>
      ${body}
      ${wbWhy(`The strip plot shows every licensed carrier around the leading candidate's RX
        channel. A tall coloured tick on or beside the red RX line is a classified threat; a wall
        of grey ticks nearby means a crowded segment where
        <em>adjacent-channel splatter</em> erodes margin without ever being "on" your frequency.
        An empty neighbourhood shifts suspicion to unlicensed sources and your own hardware.`)}
    </div>`;
}

function wbBlindSpotsHtml() {
  return `
    <div class="panel">
      ${rfcHelpHtml()}
    </div>`;
}

// ── right rail: suspects & actions ──

function wbRightHtml(an) {
  if (!an) {
    return `
      <div class="panel">
        <div class="panel-header"><h3>Suspects</h3></div>
        <p class="small" style="color:var(--muted);margin:.4rem 0 0">Ranked repeaters and licensed
          interference candidates appear here once affected stations are selected.</p>
      </div>`;
  }
  return `
    ${wbRepListHtml(an)}
    ${wbAcmaSuspectsHtml(an)}
    ${wbActionsHtml(an)}`;
}

function wbRepListHtml(an) {
  const cands = an.candidates.slice(0, 8);
  return `
    <div class="panel">
      <div class="panel-header"><h3>Ranked repeaters</h3></div>
      ${cands.length ? cands.map((c, i) => `
        <details class="wb-sus">
          <summary>
            <span class="wb-hyp-rank">#${i + 1}</span>
            <span class="wb-sus-name">${esc(c.r.name)}${c.chain.length ? ' <span class="badge">chain</span>' : ''}</span>
            <span class="wb-hyp-bar"><span style="width:${Math.round(c.power * 100)}%"></span></span>
            <span class="wb-hyp-score">${c.power.toFixed(2)}</span>
          </summary>
          <div class="small" style="padding:.35rem 0 .2rem">
            coverage ${c.coverage.toFixed(2)} · specificity ${c.specificity.toFixed(2)}
            ${c.chain.length ? `<br>In series with ${esc(c.chain.join(', '))} — inspect the chain as one path.` : ''}
            <br>Carries affected: ${c.passA.map(s => esc(s.name)).join(', ')}
            <br>Also carries ${c.passUn} unaffected station${c.passUn === 1 ? '' : 's'}.
          </div>
        </details>`).join('')
      : `<p class="small" style="color:var(--muted);margin:.4rem 0 0">No repeater carries any selected
          station — see the routing data quality note.</p>`}
    </div>`;
}

function wbAcmaSuspectsHtml(an) {
  const A = state.acma;
  let body;
  if (!an.top) {
    body = `<p class="small" style="color:var(--muted)">Needs a leading repeater candidate.</p>`;
  } else if (A.error) {
    body = `<p class="small" style="color:var(--muted)">${esc(A.error)}</p>`;
  } else if (!A.loaded) {
    body = `<p class="small" style="color:var(--muted)">Loading ACMA threat data…</p>`;
  } else {
    const anchor = A.anchorById[an.top.r.id];
    const threats = anchor ? anchor.threats.slice().sort((a, b) => b.score - a.score).slice(0, 8) : [];
    body = threats.length ? `
      ${threats.map(t => {
        const m = ACMA_MECH[t.mechanism] || { label: t.mechanism, color: '#666' };
        return `<a href="#" class="wb-threat" onclick="showAcmaCard('${escAttr(t.device_id)}','${escAttr(anchor.station_id)}');return false">
          <span class="legend-sq" style="background:${m.color}"></span>
          <span class="wb-threat-name">${esc(t.client || 'Unknown licensee')}
            <span class="small" style="color:var(--muted)">${m.label} · ${t.f_mhz != null ? t.f_mhz.toFixed(4) + ' MHz · ' : ''}${t.distance_km} km${t.inactive ? ' · not current' : ''}</span></span>
          <span class="wb-hyp-score">${t.score}</span>
        </a>`;
      }).join('')}
      <p class="small" style="color:var(--muted);margin:.4rem 0 0">Licensed candidates near
        ${esc(an.top.r.name)}, using the existing ACMA scoring — click for the full transmitter card.</p>`
    : `<p class="small" style="color:var(--muted)">No licensed interference candidates recorded near
        ${esc(an.top.r.name)}. A finding in itself: it shifts weight toward unlicensed emitters and
        the repeater's own hardware — both invisible to the register.</p>`;
  }
  return `
    <div class="panel">
      <div class="panel-header"><h3>Interference sources</h3></div>
      <div style="margin-top:.4rem">${body}</div>
    </div>`;
}

function wbActionsHtml(an) {
  return `
    <div class="panel">
      <div class="panel-header"><h3>Actions</h3></div>
      <div class="button-column">
        <button onclick="wbExportCsv()">Export case (CSV)</button>
        <button onclick="wbExportChecklist()">Site-visit checklist</button>
        <button onclick="wbExportComplaint()">Draft ACMA complaint</button>
      </div>
      <p class="small" style="color:var(--muted);margin:.5rem 0 0">The checklist is tailored to the
        leading mechanism; the complaint draft pre-fills the evidence and marks every inference as
        an inference.</p>
    </div>`;
}

// ── map ──

function initWbMap() {
  // remove() can be mid-animation when a lazy data load re-renders the tab and
  // detaches the old container — Leaflet throws harmlessly there; swallow it.
  if (state.wb.map) { try { state.wb.map.remove(); } catch (_) {} state.wb.map = null; }
  const el = document.getElementById('wb-map');
  const an = state.wb.lastAnalysis;
  if (!el || !an || !state.data || typeof L === 'undefined') return;

  const map = state.wb.map = L.map('wb-map').setView([-23, 146], 5);
  addBaseLayers(map);
  const layer = L.layerGroup().addTo(map);
  const bounds = [];

  if (an.cluster) {
    L.circle([an.cluster.lat, an.cluster.lon], {
      radius: an.cluster.radiusKm * 1000, color: '#888',
      weight: 1, dashArray: '6 6', fill: false, opacity: 0.6,
    }).addTo(layer);
  }

  const dot = (s, color, opts, popup) => {
    if (s.lat == null || s.lon == null) return;
    const m = L.circleMarker([s.lat, s.lon], {
      radius: 6, color, fillColor: color, fillOpacity: 0.85, weight: 1.5, ...opts,
    }).addTo(layer);
    m.bindPopup(popup);
    bounds.push([s.lat, s.lon]);
  };

  const topR = an.top ? an.top.r : null;
  for (const s of an.A) {
    dot(s, WB_AFFECTED_COLOR, {}, `<strong>${esc(s.name)}</strong><br>
      <span style="font-size:.83rem">Affected · AlertID ${stationAlertIds(s).join(', ')}</span>`);
    if (topR && topR.lat != null && s.lat != null && an.passes(s, topR)) {
      L.polyline([[s.lat, s.lon], [topR.lat, topR.lon]],
        { color: '#0b5cab', weight: 1.2, opacity: 0.45, dashArray: '5 6' }).addTo(layer);
    }
  }
  for (const s of an.G) {
    dot(s, WB_GOOD_COLOR, {}, `<strong>${esc(s.name)}</strong><br>
      <span style="font-size:.83rem">Known-good · AlertID ${stationAlertIds(s).join(', ')}</span>`);
  }
  for (const c of an.candidates.slice(0, 8)) {
    dot(c.r, '#0b5cab', { radius: 6 + Math.round(8 * c.power), weight: c === an.top ? 3 : 1.5 },
      `<strong>${esc(c.r.name)}</strong><br>
       <span style="font-size:.83rem">Candidate repeater · coverage ${c.coverage.toFixed(2)}
       · specificity ${c.specificity.toFixed(2)} · power ${c.power.toFixed(2)}</span>`);
  }
  for (const d of an.disc) {
    dot(d.s, WB_DISC_COLOR, { fillOpacity: 0.25, weight: 3 },
      `<strong>${esc(d.s.name)}</strong><br>
       <span style="font-size:.83rem">Discriminating station (${d.status}) — routes via
       ${esc(d.via.join(', '))}. Clean strengthens H1; affected strengthens H2.</span>`);
  }

  // ACMA threat squares around the leading candidate — same visual language as
  // the main map's RF layer (squares, mechanism colours).
  const A = state.acma;
  if (A.loaded && topR && A.anchorById[topR.id]) {
    const anchor = A.anchorById[topR.id];
    for (const t of anchor.threats.slice().sort((a, b) => b.score - a.score).slice(0, 10)) {
      const site = A.siteById[t.site_id];
      if (!site) continue;
      const mech = ACMA_MECH[t.mechanism] || { label: t.mechanism, color: '#666' };
      const size = Math.round(9 + t.score / 8);
      const icon = L.divIcon({
        className: 'acma-div',
        html: `<div class="acma-sq" style="width:${size}px;height:${size}px;background:${mech.color}"></div>`,
        iconSize: [size, size], iconAnchor: [size / 2, size / 2],
      });
      const m = L.marker([site.lat, site.lon], { icon }).addTo(layer);
      m.bindPopup(`<strong>${esc(t.client || 'Unknown licensee')}</strong> · score ${t.score}<br>
        <span style="font-size:.83rem">${mech.label} · ${esc(t.detail)}</span><br>
        <a href="#" onclick="showAcmaCard('${escAttr(t.device_id)}','${escAttr(anchor.station_id)}');return false">Full details →</a>`);
    }
  }

  // animate:false — an in-flight animation throws if a re-render (lazy ACMA/RFC
  // data arriving) replaces the container before it settles
  if (bounds.length) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 11, animate: false });
}

// ── exports ──

function wbCaseStamp() {
  return (state.wb.caseName ? slug(state.wb.caseName) + '-' : 'workbench-case-') +
         new Date().toISOString().slice(0, 10);
}

function wbExportCsv() {
  const an = state.wb.lastAnalysis;
  if (!an) return;
  const wbs = state.wb;
  const L1 = [];
  L1.push('MegaNet Interference Workbench — case export');
  L1.push(`generated,${new Date().toISOString()}`);
  L1.push(`case,${csvEscape(wbs.caseName || '(unnamed)')}`);
  L1.push(`affected_ids,${csvEscape(wbs.affected.join(' '))}`);
  L1.push(`known_good_ids,${csvEscape(wbs.good.join(' '))}`);
  L1.push(`onset,${wbs.onset || 'unknown'}${wbs.onsetEnd ? ' to ' + wbs.onsetEnd : ''}`);
  L1.push(`symptom,${WB_SYMPTOMS[wbs.symptom] || 'unknown'}`);
  L1.push(`confidence,${an.confidence}`);
  L1.push('');
  L1.push('section,hypothesis_ranking');
  L1.push('rank,hypothesis,label,score,base_score,symptom_weight,statement');
  an.hyps.forEach((h, i) => L1.push([i + 1, h.short, csvEscape(h.label), h.score.toFixed(2),
    h.base.toFixed(2), h.weight.toFixed(2), csvEscape(an.stmt[h.key])].join(',')));
  L1.push('');
  L1.push('section,repeater_candidates');
  L1.push('repeater,coverage,specificity,explanatory_power,affected_through,unaffected_through,chain_with');
  an.candidates.forEach(c => L1.push([csvEscape(c.r.name), c.coverage.toFixed(2),
    c.specificity.toFixed(2), c.power.toFixed(2), c.passA.length, c.passUn,
    csvEscape(c.chain.join('; '))].join(',')));
  if (an.h5.pairs.length) {
    L1.push('');
    L1.push('section,h5_address_pairs');
    L1.push('addr_a,addr_b,hamming_distance,differing_bits');
    an.h5.pairs.forEach(p => L1.push([p.a, p.b, p.d, csvEscape(p.bits.join(' '))].join(',')));
  }
  if (an.disc.length) {
    L1.push('');
    L1.push('section,discriminating_stations');
    L1.push('station,routes_via,km_from_cluster_centre,status');
    an.disc.forEach(d => L1.push([csvEscape(d.s.name), csvEscape(d.via.join('; ')),
      d.km.toFixed(1), d.status].join(',')));
  }
  L1.push('');
  L1.push('note,"Scores rank explanations by fit; none is a proven cause. See the Workbench for the arithmetic behind every number."');
  dlText(`${wbCaseStamp()}.csv`, L1.join('\n'));
}

// Mechanism-tailored fieldwork list — converts the analysis into a site visit.
function wbExportChecklist() {
  const an = state.wb.lastAnalysis;
  if (!an) return;
  const lead = an.lead;
  const topMech = (() => {
    const A = state.acma;
    if (!A.loaded || !an.top) return null;
    const anchor = A.anchorById[an.top.r.id];
    if (!anchor || !anchor.threats.length) return null;
    return anchor.threats.slice().sort((a, b) => b.score - a.score)[0].mechanism;
  })();
  const out = [];
  out.push(`# Site-visit checklist — ${state.wb.caseName || 'unnamed investigation'}`);
  out.push(`Generated ${new Date().toISOString().slice(0, 10)} · leading hypothesis: ${lead.short} ${lead.label} (score ${lead.score.toFixed(2)}, confidence ${an.confidence})`);
  out.push('');
  out.push('## Before leaving');
  out.push('- [ ] Export this case (CSV) and the RF Environment threat CSV for the target repeater');
  out.push('- [ ] Pull the last 30 days of data for every affected station and the discriminating stations named in the case');
  if (an.nextCheck) out.push(`- [ ] Most informative check first: ${an.nextCheck}`);
  out.push('');
  if (lead.key === 'h1' || lead.key === 'h3') {
    out.push(`## At the repeater (${an.top ? an.top.r.name : 'leading candidate'})`);
    if (topMech === 'imd3' || topMech === 'imd5' || topMech === 'imd3_triple' || !topMech) {
      out.push('- [ ] Inspect and torque mast joints, guy attachments and antenna mounts (rusty-bolt IMD)');
      out.push('- [ ] Check every RF connector for corrosion / water ingress; reseat and re-weatherproof');
      out.push('- [ ] Log co-tenant transmitter TX times against your corruption timestamps');
    }
    if (topMech === 'cosite_desense' || !topMech) {
      out.push('- [ ] Get the co-sited transmitter TX log from the site operator if they will share it');
      out.push('- [ ] Consider a band-pass cavity filter on the repeater RX');
    }
    if (topMech === 'co_channel' || topMech === 'adjacent' || lead.key === 'h3') {
      out.push('- [ ] Monitor the RX channel with a handheld/SDR for the co-channel carrier; note times and signal strength');
    }
    out.push('- [ ] Measure repeater RX noise floor (record dBm and time); compare against any previous reading');
    out.push('- [ ] Check squelch setting and RX sensitivity against commissioning values');
    out.push('- [ ] Photograph antenna, feedline and connector condition for the record');
  }
  if (lead.key === 'h2') {
    out.push('## In the affected area');
    out.push('- [ ] Drive-test the area with a handheld/SDR on the RX channel; log where the interferer is audible');
    out.push('- [ ] Note any new infrastructure since onset (towers, solar farms, VMS signs, industrial sites)');
    out.push('- [ ] Check the ACMA suspects list against what is physically present');
  }
  if (lead.key === 'h4' || lead.key === 'h2') {
    out.push('## At each affected site');
    out.push('- [ ] Battery-only power-down test: kill mains/solar, watch whether the noise floor drops (self-interference)');
    out.push('- [ ] Check solar regulator make/model — switch-mode controllers are notorious VHF noise sources');
    out.push('- [ ] Inspect nearby electric fences, powerlines (arcing insulators), pumps and VSDs');
    out.push('- [ ] Verify antenna connections, feedline condition and earth bonding');
  }
  if (lead.key === 'h5') {
    out.push('## Desk work first — no site visit indicated yet');
    out.push('- [ ] Compare the flagged address pairs\' data series; identify victim vs ghost');
    out.push('- [ ] Correct the affected list and re-run the Workbench before committing to fieldwork');
  }
  out.push('');
  out.push('## Log while on site');
  out.push('- [ ] Times of any observed interference (with your corruption timestamps to hand)');
  out.push('- [ ] Weather at time of visit (IMD and corrosion effects are weather-sensitive)');
  out.push('- [ ] Anything keying nearby: voice traffic, pagers, telemetry bursts');
  dlText(`${wbCaseStamp()}-site-visit.md`, out.join('\n'));
}

// Draft interference complaint with the evidence pre-filled. Every inference is
// marked as an inference — the draft argues "worth investigating", not "guilty".
function wbExportComplaint() {
  const an = state.wb.lastAnalysis;
  if (!an) return;
  const wbs = state.wb;
  const A = state.acma;
  const top = an.top;
  const lic = top && top.r.repeater.acma_licence ? top.r.repeater.acma_licence : '(licence number)';
  const rx = top && top.r.repeater.rx_mhz != null ? top.r.repeater.rx_mhz + ' MHz' : '(RX frequency)';
  const suspects = (A.loaded && top && A.anchorById[top.r.id])
    ? A.anchorById[top.r.id].threats.slice().sort((a, b) => b.score - a.score).slice(0, 5) : [];
  const out = [];
  out.push('# Draft — interference report to ACMA');
  out.push('(Review every field before sending. This draft was assembled by the MegaNet');
  out.push('Interference Workbench; all conclusions are stated as leads, not findings.)');
  out.push('');
  out.push('## Reporting party');
  out.push('Name / organisation: (fill in)');
  out.push('Contact: (fill in)');
  out.push('');
  out.push('## Service experiencing interference');
  out.push(`Service: ALERT flood-warning telemetry network (VHF, ${rx})`);
  out.push(`Licence: ${lic}`);
  if (top) out.push(`Receiver site: ${top.r.name}${top.r.lat != null ? ` (${top.r.lat.toFixed(4)}, ${top.r.lon.toFixed(4)})` : ''}`);
  out.push('');
  out.push('## Nature and extent of the interference');
  out.push(`Symptom: ${WB_SYMPTOMS[wbs.symptom] || 'data corruption (mixed symptoms)'} on the ALERT telemetry channel.`);
  out.push(`First observed: ${wbs.onset || '(date unknown)'}${wbs.onsetEnd ? ' – ' + wbs.onsetEnd : ''}.`);
  out.push(`Affected field stations: ${an.A.length} (${an.A.slice(0, 10).map(s => s.name).join('; ')}${an.A.length > 10 ? '; …' : ''}).`);
  if (top) {
    out.push(`Pattern: ${top.passA.length} of ${an.A_routed.length} routed affected stations share the ` +
      `${top.r.name} repeater path (coverage ${top.coverage.toFixed(2)}, specificity ${top.specificity.toFixed(2)}), ` +
      'which is most consistent with interference at or near that receiver. This is an inference from ' +
      'routing analysis, not a direct observation of an emitter.');
  }
  out.push('');
  out.push('## Impact');
  out.push('The affected service provides real-time flood warning data (rainfall and river level)');
  out.push('used for public-safety decisions. Corrupted or lost readings during a flood event delay');
  out.push('warnings. (Adjust to your circumstances.)');
  out.push('');
  if (suspects.length) {
    out.push('## Licensed services identified as worth investigating (from the ACMA RRL)');
    suspects.forEach(t => {
      const m = (ACMA_MECH[t.mechanism] || { label: t.mechanism }).label;
      out.push(`- ${t.client || 'Unknown licensee'} — licence ${t.lic || '?'}, ` +
        `${t.f_mhz != null ? t.f_mhz.toFixed(4) + ' MHz, ' : ''}${t.distance_km} km from the receiver. ` +
        `Candidate mechanism: ${m}${t.inactive ? ' (licence not current)' : ''}.`);
    });
    out.push('');
    out.push('These are candidates identified by automated screening of the public register; no');
    out.push('transmission by any of them has been directly observed causing the interference.');
    out.push('');
  }
  out.push('## Evidence available on request');
  out.push('- Corruption timestamps per affected station');
  out.push('- Routing analysis (which repeater paths the affected stations share) with arithmetic');
  out.push('- Register-change timeline near the receiver around the onset date');
  out.push('- Site-visit observations (once completed)');
  dlText(`${wbCaseStamp()}-acma-draft.md`, out.join('\n'));
}

// Restore a shared investigation from the URL hash. Runs at script load (after
// init's first render); station data arrives later via autoLoad → loadJson,
// which re-renders the restored tab.
if (typeof window !== 'undefined') wbRestoreFromUrl();

// ── ALERT Packets tab ────────────────────────────────────────────────────────────
// Decoder / encoder for ALERT / ERTS radio telemetry messages, per the Bureau of
// Meteorology "ERTS Data Formats" specification (July 2003). Ported from the
// standalone ALERT_PACKETS tool and integrated as a MegaNet tab. Decoded ALERT
// addresses are cross-referenced against the loaded MegaNet station database first,
// then against the bundled national address file "All 2021 Working 2.txt".

const Packets = (function () {

  // ── core codec ────────────────────────────────────────────────────────────────
  const CRC_POLY = 0x19; // x^6 + x^4 + x^3 + 1

  function bitsMsb(v, n) { const r = []; for (let i = n - 1; i >= 0; i--) r.push((v >> i) & 1); return r; }
  function crc6(bits) {
    let reg = 0;
    for (const b of bits) { const fb = ((reg >> 5) & 1) ^ b; reg = (reg << 1) & 0x3f; if (fb) reg ^= CRC_POLY; }
    return reg;
  }
  function eifCrc(a, d)    { return crc6(bitsMsb(a, 13).concat(bitsMsb(d, 11))); }
  function eafCrc(a, d, b) { return crc6(bitsMsb(a, 12).concat(bitsMsb(d, 11), [b & 1])); }

  function A(i)  { return { f: 'A', i }; }  function D(i) { return { f: 'D', i }; }
  function K(e)  { return { f: 'K', expect: e }; }
  function HD(i) { return { f: 'HD', i }; } function BS(i) { return { f: 'BS', i }; }
  function C(i)  { return { f: 'C', i }; }  function R(i) { return { f: 'R', i }; }
  function S(i)  { return { f: 'S', i }; }
  const B0 = { f: 'B', i: 0 }, VCO = { f: 'VCO', i: 0 }, DE = { f: 'DE', i: 0 };

  const FIELD_META = {
    A:   { label: 'Address (sensor ID)',       cls: 'f-A' },
    D:   { label: 'Data value',                cls: 'f-D' },
    K:   { label: 'Format ID / check bits',    cls: 'f-K' },
    R:   { label: 'FCS (CRC-6)',               cls: 'f-R' },
    C:   { label: 'CRC / wind-gust bits',      cls: 'f-C' },
    B:   { label: 'Battery status bit',        cls: 'f-B' },
    BS:  { label: 'Battery status',            cls: 'f-BS' },
    VCO: { label: 'VCO error flag',            cls: 'f-VCO' },
    DE:  { label: 'Data error flag',           cls: 'f-DE' },
    HD:  { label: 'High data bits (D11–D15)',  cls: 'f-HD' },
    S:   { label: 'Record status byte',        cls: 'f-S' },
    frame: { label: 'Start / stop bits',       cls: 'f-frame' },
  };

  const FORMATS = {
    abf: { key: 'abf', name: 'ALERT Binary Format (ABF)', short: 'ABF',
      map: [A(0), A(1), A(2), A(3), A(4), A(5), K(1), K(0),
            A(6), A(7), A(8), A(9), A(10), A(11), K(1), K(0),
            A(12), D(0), D(1), D(2), D(3), D(4), K(1), K(1),
            D(5), D(6), D(7), D(8), D(9), D(10), K(1), K(1)],
      abits: 13, note: 'The standard format used in Australia. No CRC — validity rests on the fixed check bits alone.' },
    bcc: { key: 'bcc', name: 'BCC Extended Check Format', short: 'BCC',
      map: [A(0), A(1), A(2), A(3), A(4), A(5), K(1), K(0),
            A(6), A(7), A(8), A(9), A(10), A(11), K(1), K(0),
            A(12), HD(0), HD(1), HD(2), HD(3), HD(4), K(0), K(1),
            BS(0), BS(1), BS(2), BS(3), VCO, DE, K(0), K(1)],
      abits: 13, note: 'Health/check message sent after a binary check signal. HD carries bits 11–15 of the full 16-bit stored value; BS is battery status; VCO and DE are error flags.' },
    eaf: { key: 'eaf', name: 'Enhanced ALERT Binary Format (EAF)', short: 'EAF',
      map: [A(0), A(1), A(2), A(3), A(4), A(5), K(1), K(1),
            A(6), A(7), A(8), A(9), A(10), A(11), D(0), D(1),
            D(2), D(3), D(4), D(5), D(6), D(7), D(8), D(9),
            D(10), B0, C(5), C(4), C(3), C(2), C(1), C(0)],
      abits: 12, note: '12-bit address (0–4095), battery bit B, 6 CRC bits. Wind sensors substitute gust data for the CRC. The BoM document does not define the EAF CRC algorithm — the check shown here assumes the same x⁶+x⁴+x³+1 CRC as EIF, computed over address, data and B.' },
    eif: { key: 'eif', name: 'Enhanced IFLOWS Format (EIF)', short: 'EIF',
      map: [A(0), A(1), A(2), A(3), A(4), A(5), K(1), K(1),
            A(6), A(7), A(8), A(9), A(10), A(11), A(12), D(0),
            D(1), D(2), D(3), D(4), D(5), D(6), D(7), D(8),
            D(9), D(10), R(5), R(4), R(3), R(2), R(1), R(0)],
      abits: 13, note: '13-bit address, 11-bit data, 6-bit FCS (CRC, generator polynomial x⁶+x⁴+x³+1 over address then data, MSB first).' },
    // The one modern format here, and the odd one out. ABF/BCC/EAF/EIF are what a
    // legacy ALERT sensor puts on the air as four 10-bit async words; A2C is how
    // that same 13-bit address and 11-bit value are re-packed as four plain bytes
    // inside an ALERT2 concentration frame, which is what an ELPRO ERT-A2 hands
    // out over RS232. No start/stop bits and no CRC — the ALERT2 MANT layer below
    // it has already checked the frame, so all this carries is a status byte that
    // reads 0 on every good record. Layout mirrors Alert2.decodeRecord(); the two
    // are the same three lines of arithmetic written declaratively and directly.
    a2c: { key: 'a2c', name: 'ALERT2 concentration record (A2C)', short: 'A2C', bytesOnly: true,
      map: [A(7), A(6), A(5), A(4), A(3), A(2), A(1), A(0),
            D(10), D(9), D(8), A(12), A(11), A(10), A(9), A(8),
            D(7), D(6), D(5), D(4), D(3), D(2), D(1), D(0),
            S(7), S(6), S(5), S(4), S(3), S(2), S(1), S(0)],
      validate: v => v.S === 0,
      abits: 13, note: 'One sensor reading inside an ALERT2 “ALERT concentration” payload, as delivered by an ELPRO ERT-A2. Four bytes: address low byte, then a packed byte holding the top 3 data bits and the top 5 address bits, then the data low byte, then a status byte (0 on every valid record observed). Address and data are the same 13 + 11 bits as the legacy formats, so a reading decodes to the same ID and value either way. See the ALERT2 / ERT-A2 tab to decode whole serial lines.' },
  };

  function normaliseInput(raw) {
    let s = String(raw || '').trim().replace(/[\s,_.\-]+/g, '');
    if (/^0x[0-9a-f]+$/i.test(s)) {
      const hex = s.slice(2);
      if (hex.length !== 8) return { ok: false, error: 'Hex input must be exactly 8 hex digits (32 bits).' };
      s = [...hex].map(h => parseInt(h, 16).toString(2).padStart(4, '0')).join('');
    }
    if (!/^[01]+$/.test(s)) return { ok: false, error: 'Input must be a binary string of 0s and 1s (spaces allowed), or hex like 0x07D5F8FE.' };
    if (s.length === 32) return { ok: true, bits32: s, framing: { present: false } };
    if (s.length !== 40) return { ok: false, error: 'Expected 40 bits (framed, 4 × 10-bit words) or 32 bits (payload only) — got ' + s.length + ' bits.' };
    const words = [0, 10, 20, 30].map(i => s.slice(i, i + 10));
    const test = (st, sp) => words.every(w => w[0] === st && w[9] === sp);
    let polarity = null, valid = false;
    if (test('1', '0'))      { polarity = 'negative'; valid = true; }
    else if (test('0', '1')) { polarity = 'standard'; valid = true; }
    const bits32 = words.map(w => w.slice(1, 9)).join('');
    return { ok: true, bits32, bits40: s, framing: { present: true, polarity, valid,
      detail: valid ? (polarity === 'negative' ? 'start = 1, stop = 0 (ALERT negative logic)' : 'start = 0, stop = 1 (standard async)')
                    : 'start/stop bits are inconsistent across the four words — framing ignored, middle 8 bits of each word taken as payload.' } };
  }

  function decodeFormat(fmtKey, bits32) {
    const fmt = FORMATS[fmtKey];
    const vals = {}; let identOk = true; const identErrors = [];
    fmt.map.forEach((cell, pos) => {
      const bit = bits32[pos] === '1' ? 1 : 0;
      if (cell.f === 'K') { if (bit !== cell.expect) { identOk = false; identErrors.push(pos); } }
      else (vals[cell.f] = vals[cell.f] || [])[cell.i] = bit;
    });
    const num = {};
    for (const [f, arr] of Object.entries(vals)) num[f] = arr.reduce((a, b, i) => a + (b << i), 0);
    const out = { format: fmtKey, name: fmt.name, identOk, identErrors, values: num };
    if (fmtKey === 'eif') { out.crcExpected = eifCrc(num.A, num.D);         out.crcOk = out.crcExpected === num.R; }
    if (fmtKey === 'eaf') { out.crcExpected = eafCrc(num.A, num.D, num.B);  out.crcOk = out.crcExpected === num.C; out.crcAssumed = true; }
    if (fmt.validate) out.extraOk = !!fmt.validate(num);
    out.valid = identOk && (out.crcOk !== false) && (out.extraOk !== false);
    return out;
  }

  // A2C is four raw bytes lifted out of an ALERT2 payload, not four async words
  // off the air, so it is only a candidate when the input arrived without
  // start/stop bits — and only when the caller asked for it. The Serial Monitor's
  // alert mode slices the byte stream into fours from wherever reading started,
  // which is the one place an extra always-plausible format would do harm: those
  // groups are not aligned to ALERT2 record boundaries, so any A2C it "found"
  // would be an artefact of where the read began.
  function decodeAll(bits32, opts) {
    const o = opts || {};
    return Object.keys(FORMATS)
      .filter(k => !FORMATS[k].bytesOnly || (o.bytes && !o.framed))
      .map(k => decodeFormat(k, bits32));
  }

  // Public decode helper shared with the Serial Monitor tab. Accepts the same
  // inputs as the decode box (40-bit framed / 32-bit payload binary, or 8-digit
  // hex) and returns the normalised framing, every format's decode and the single
  // unambiguous "best" format (null when zero or several formats pass all checks).
  // Pass { bytes: true } to also consider A2C — for callers that know their four
  // bytes are a record boundary, not an arbitrary slice of a stream.
  function decodeMessage(raw, opts) {
    const n = normaliseInput(raw);
    if (!n.ok) return { ok: false, error: n.error };
    const results = decodeAll(n.bits32, { framed: n.framing.present, bytes: opts && opts.bytes });
    const validOnes = results.filter(r => r.valid);
    const best = validOnes.length === 1 ? validOnes[0].format : null;
    return { ok: true, framing: n.framing, bits32: n.bits32, results, best };
  }

  function encodeFormat(fmtKey, values, polarity) {
    const fmt = FORMATS[fmtKey];
    const v = Object.assign({}, values);
    const lim = (name, val, bits) => {
      if (val == null || isNaN(val)) throw new Error('Missing value for ' + name + '.');
      if (val < 0 || val > (1 << bits) - 1) throw new Error(name + ' must be 0–' + ((1 << bits) - 1) + ' for this format (got ' + val + ').');
    };
    lim('Sensor ID', v.A, fmt.abits);
    if (fmtKey === 'abf') { lim('Data value', v.D, 11); }
    if (fmtKey === 'bcc') { v.HD = v.HD || 0; v.BS = v.BS || 0; v.VCO = v.VCO ? 1 : 0; v.DE = v.DE ? 1 : 0;
      lim('HD (high data bits)', v.HD, 5); lim('BS (battery status)', v.BS, 4); }
    if (fmtKey === 'eaf') { lim('Data value', v.D, 11); v.B = v.B ? 1 : 0; v.C = eafCrc(v.A, v.D, v.B); }
    if (fmtKey === 'eif') { lim('Data value', v.D, 11); v.R = eifCrc(v.A, v.D); }
    let bits32 = '';
    fmt.map.forEach(cell => { bits32 += cell.f === 'K' ? cell.expect : ((v[cell.f] >> cell.i) & 1); });
    const st = polarity === 'standard' ? '0' : '1', sp = polarity === 'standard' ? '1' : '0';
    let bits40 = '';
    for (let w = 0; w < 4; w++) bits40 += st + bits32.slice(w * 8, w * 8 + 8) + sp;
    const hex = '0x' + parseInt(bits32, 2).toString(16).toUpperCase().padStart(8, '0');
    return { format: fmtKey, values: v, bits32, bits40, hex, polarity: polarity === 'standard' ? 'standard' : 'negative' };
  }

  // ── station name lookup ───────────────────────────────────────────────────────
  // Two sources: the loaded MegaNet database (state.data) takes priority, then the
  // bundled national address file. MegaNet index is cached and rebuilt when the
  // underlying data object changes.
  let fileStations = null;      // Map id -> name from the address file (null until loaded)
  let fileLoading  = false;
  const mnIndex = { src: null, map: null };

  function megaNetName(id) {
    if (!state.data || !Array.isArray(state.data.stations)) return null;
    if (mnIndex.src !== state.data) {
      mnIndex.src = state.data;
      mnIndex.map = new Map();
      state.data.stations.forEach(s => stationAlertIds(s).forEach(aid => {
        if (!mnIndex.map.has(aid)) mnIndex.map.set(aid, s.name);
      }));
    }
    return mnIndex.map.get(id) || null;
  }

  function stationName(id) {
    const mn = megaNetName(id);
    if (mn) return { text: mn, none: false, source: 'meganet' };
    if (fileStations) { const n = fileStations.get(id); if (n) return { text: n, none: false, source: 'file' }; }
    if (fileStations === null && fileLoading) return { text: 'loading…', none: true };
    return { text: 'not found in address file', none: true };
  }

  async function loadStationsFile() {
    if (fileStations !== null || fileLoading) return;
    fileLoading = true;
    try {
      const res = await fetch(encodeURI('data/All 2021 Working 2.txt'));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = await res.arrayBuffer();
      const u8 = new Uint8Array(buf);
      let text;
      if (u8[0] === 0xFF && u8[1] === 0xFE)      text = new TextDecoder('utf-16le').decode(buf);
      else if (u8[0] === 0xFE && u8[1] === 0xFF) text = new TextDecoder('utf-16be').decode(buf);
      else                                        text = new TextDecoder('utf-8').decode(buf);
      text = text.replace(/^﻿/, '');
      fileStations = new Map();
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith(' ')) continue;             // address file rule: data lines start with a space
        const m = line.match(/^\s*(\d+)\s+(.*\S)/);
        if (m && !fileStations.has(+m[1])) fileStations.set(+m[1], m[2]);
      }
    } catch (e) {
      fileStations = new Map();
      fileStations.loadError = e.message;
    } finally {
      fileLoading = false;
      updateStnStatus();
      if (state.activeTab === 'packets') replay();       // re-render results now names are available
    }
  }

  function updateStnStatus() {
    const el = document.getElementById('pkt-stnStatus');
    if (!el) return;
    if (fileStations === null) { el.textContent = fileLoading ? ' Loading ALERT address file…' : ''; return; }
    if (fileStations.loadError)
      el.textContent = ' ALERT address file could not be loaded (' + fileStations.loadError + ') — decoding still works; names come from the MegaNet database only.';
    else
      el.textContent = ' Loaded ' + fileStations.size + ' addresses from the ALERT address file.';
  }

  // ── rendering helpers ─────────────────────────────────────────────────────────
  function bitCells(fmtKey, bits, framed) {
    const map = FORMATS[fmtKey].map;
    const cells = [];
    if (framed) {
      for (let w = 0; w < 4; w++) {
        cells.push({ bit: bits[w * 10], f: 'frame', lbl: 'S' });
        for (let i = 0; i < 8; i++) {
          const cell = map[w * 8 + i];
          cells.push({ bit: bits[w * 10 + 1 + i], f: cell.f, lbl: cell.f === 'K' ? 'K' : cell.f + (cell.i !== undefined ? cell.i : ''), cell });
        }
        cells.push({ bit: bits[w * 10 + 9], f: 'frame', lbl: 'E' });
      }
    } else {
      for (let p = 0; p < 32; p++) {
        const cell = map[p];
        cells.push({ bit: bits[p], f: cell.f, lbl: cell.f === 'K' ? 'K' : cell.f + (cell.i !== undefined ? cell.i : ''), cell });
      }
    }
    return cells;
  }

  function renderBitMap(fmtKey, bits, framed, identErrors, uid) {
    const cells = bitCells(fmtKey, bits, framed);
    const per = framed ? 10 : 8;
    const unit = FORMATS[fmtKey].bytesOnly ? 'Byte ' : 'Word ';
    let html = '<div class="bitwords" data-uid="' + uid + '">';
    for (let w = 0; w < 4; w++) {
      html += '<div class="bitword"><div class="wlabel">' + unit + (w + 1) + '</div><div class="bitrow">';
      let lbls = '';
      for (let i = 0; i < per; i++) {
        const c = cells[w * per + i];
        const payloadPos = framed ? (w * 8 + i - 1) : (w * 8 + i);
        const bad = c.f === 'K' && identErrors && identErrors.includes(payloadPos);
        html += '<div class="bit ' + FIELD_META[c.f].cls + (bad ? ' kbad' : '') + '" data-f="' + c.f + '" title="' + esc(FIELD_META[c.f].label + (c.cell && c.cell.i !== undefined ? ' — bit ' + c.cell.i : '')) + '">' + c.bit + '</div>';
        lbls += '<span>' + c.lbl + '</span>';
      }
      html += '</div><div class="lblrow">' + lbls + '</div></div>';
    }
    html += '</div>';
    return html;
  }

  const SWATCH = { A: 'addr', D: 'data', K: 'ident', R: 'crc', C: 'crc', B: 'batt', BS: 'batt', VCO: 'batt', DE: 'batt', HD: 'hd', S: 'status', frame: 'frame' };

  function legendHtml(fields) {
    return '<div class="legend">' + fields.map(f => '<span><i style="background:var(--c-' + SWATCH[f] + ')"></i>' + esc(FIELD_META[f].label) + '</span>').join('') + '</div>';
  }

  function fieldRows(fmtKey, dec) {
    const fmt = FORMATS[fmtKey];
    const rows = [];
    const positions = {};
    fmt.map.forEach((c, p) => { if (c.f !== 'K') { (positions[c.f] = positions[c.f] || []).push(p); } });
    const order = ['A', 'D', 'HD', 'BS', 'B', 'VCO', 'DE', 'R', 'C', 'S'];
    for (const f of order) {
      if (!(f in dec.values)) continue;
      const nbits = positions[f].length;
      const v = dec.values[f];
      const binMsb = v.toString(2).padStart(nbits, '0');
      let extra = '';
      if (f === 'A') {
        const s = stationName(v);
        extra = '<div>Station name: <span class="stn' + (s.none ? ' none' : '') + '">' + esc(s.text) + '</span>'
              + (s.source === 'meganet' ? ' <span class="badge ok">MegaNet</span>' : '') + '</div>';
      }
      if (f === 'HD') extra = '<div class="spec">Full 16-bit value = HD × 2048 + last transmitted 11-bit data value = ' + (v * 2048) + ' + data.</div>';
      if (f === 'S') extra = '<div class="spec">' + (v === 0
        ? '<span style="color:var(--ok)">0 — the value every valid record carries ✓</span>'
        : '<span style="color:var(--bad)">non-zero ✗</span> — records with a non-zero status byte in the reference capture also carried addresses matching no station, so treat the reading as corrupt.') + '</div>';
      if ((f === 'R' || f === 'C') && dec.crcExpected !== undefined) {
        extra = '<div class="spec">Computed ' + (f === 'R' ? 'FCS' : 'CRC') + ': ' + dec.crcExpected + ' — '
          + (dec.crcOk ? '<span style="color:var(--ok)">matches ✓</span>' : '<span style="color:var(--bad)">mismatch ✗</span>')
          + (dec.crcAssumed ? ' (algorithm assumed, see note below; for wind sensors these bits are gust data instead)' : '') + '</div>';
      }
      rows.push('<tr class="frow" data-f="' + f + '">'
        + '<td><span class="swatch" style="background:var(--c-' + SWATCH[f] + ')"></span>' + esc(FIELD_META[f].label) + '</td>'
        + '<td><code>' + binMsb + '</code><div class="spec">' + nbits + ' bit' + (nbits > 1 ? 's' : '') + ', sent ' + ((f === 'R' || f === 'C') ? 'MSB' : 'LSB') + ' first</div></td>'
        + '<td><span class="val">' + v + '</span>' + extra + '</td></tr>');
    }
    return '<table class="fields"><thead><tr><th>FIELD</th><th>BITS (MSB→LSB)</th><th>VALUE</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>';
  }

  function attachHover(container) {
    container.querySelectorAll('tr.frow').forEach(tr => {
      const f = tr.dataset.f;
      const card = tr.closest('.fmtbody, .encout') || container;
      tr.addEventListener('mouseenter', () => card.querySelectorAll('.bit[data-f="' + f + '"]').forEach(b => b.classList.add('hl')));
      tr.addEventListener('mouseleave', () => card.querySelectorAll('.bit[data-f="' + f + '"]').forEach(b => b.classList.remove('hl')));
    });
  }

  // ── decoder ───────────────────────────────────────────────────────────────────
  function doDecode(input, scroll) {
    const errEl = document.getElementById('pkt-decError');
    const frEl  = document.getElementById('pkt-decFraming');
    const resEl = document.getElementById('pkt-decResults');
    if (!resEl) return;
    state.pkt.decInput = input;
    state.pkt.lastDecode = input;
    errEl.hidden = true; frEl.hidden = true; resEl.innerHTML = '';
    const n = normaliseInput(input);
    if (!n.ok) { errEl.textContent = n.error; errEl.hidden = false; return; }
    if (n.framing.present) {
      frEl.innerHTML = 'Framing: ' + (n.framing.valid ? '<b style="color:var(--ok)">valid</b> — ' : '<b style="color:var(--warn)">inconsistent</b> — ') + esc(n.framing.detail)
        + '. Payload (32 bits): <code>' + n.bits32 + '</code>';
    } else {
      frEl.innerHTML = '32-bit payload supplied (no start/stop bits).';
    }
    frEl.hidden = false;
    const results = decodeAll(n.bits32, { framed: n.framing.present, bytes: true });
    const validOnes = results.filter(r => r.valid);
    const best = validOnes.length === 1 ? validOnes[0].format : null;
    const ordered = [...results].sort((a, b) => (b.valid ? 1 : 0) - (a.valid ? 1 : 0));
    ordered.forEach(r => {
      const fmt = FORMATS[r.format];
      const badges = [];
      // A2C has no check bits to pass or fail — its integrity claim is the status
      // byte, so it says that instead of a "check bits ✓" it never earned.
      if (r.extraOk !== undefined)
        badges.push(r.extraOk ? '<span class="badge ok">status byte 0 ✓</span>' : '<span class="badge bad">status byte non-zero ✗</span>');
      else
        badges.push(r.identOk ? '<span class="badge ok">check bits ✓</span>' : '<span class="badge bad">check bits ✗</span>');
      if (r.crcOk !== undefined) badges.push(r.crcOk ? '<span class="badge ok">' + (r.format === 'eif' ? 'FCS' : 'CRC') + ' ✓</span>'
                                                     : '<span class="badge ' + (r.crcAssumed ? 'warn' : 'bad') + '">' + (r.format === 'eif' ? 'FCS' : 'CRC') + ' ✗</span>');
      if (r.format === best) badges.unshift('<span class="badge ok">BEST MATCH</span>');
      const open = r.valid || validOnes.length === 0;
      const s = stationName(r.values.A);
      const summary = r.valid
        ? 'ID ' + r.values.A + (r.values.D !== undefined ? ' · value ' + r.values.D : '') + ' · ' + esc(s.text)
        : 'not a valid ' + fmt.short + ' message';
      let body = '';
      body += renderBitMap(r.format, n.framing.present ? n.bits40 : n.bits32, n.framing.present, r.identErrors, 'dec-' + r.format);
      const legendFields = [...new Set(fmt.map.map(c => c.f))]; if (n.framing.present) legendFields.push('frame');
      body += legendHtml(legendFields);
      body += fieldRows(r.format, r);
      body += '<p class="spec">' + esc(fmt.note) + '</p>';
      if (r.format !== 'bcc' && !fmt.bytesOnly && r.values.A !== undefined && r.values.D !== undefined)
        body += '<button class="ghost" onclick="Packets.prefillEncoder(\'' + r.format + '\',' + r.values.A + ',' + r.values.D + ')">Open in encoder</button>';
      if (fmt.bytesOnly)
        body += '<button class="ghost" onclick="switchTab(\'alert2\')">Decode a whole ERT-A2 line ▸</button>';
      resEl.insertAdjacentHTML('beforeend',
        '<div class="fmtcard' + (r.format === best ? ' best' : '') + (open ? ' open' : '') + '" id="pkt-card-' + r.format + '">'
        + '<div class="fmthead" onclick="this.parentElement.classList.toggle(\'open\')">'
        + '<h3>' + esc(fmt.name) + '</h3>' + badges.join(' ')
        + '<span class="caret">' + esc(summary) + ' ▾</span></div>'
        + '<div class="fmtbody">' + body + '</div></div>');
    });
    attachHover(resEl);
    if (scroll) resEl.scrollIntoView({ behavior: 'smooth' });
  }

  // ── encoder ───────────────────────────────────────────────────────────────────
  const ENC_EXTRAS = {
    abf: [], eif: [],
    eaf: [{ id: 'pkt-encB', key: 'b', label: 'Battery bit B (0 = good)', type: 'select01' }],
    bcc: [{ id: 'pkt-encHD', key: 'hd', label: 'HD — high data bits (0–31)', type: 'num', max: 31 },
          { id: 'pkt-encBS', key: 'bs', label: 'BS — battery status (0–15)', type: 'num', max: 15 },
          { id: 'pkt-encVCO', key: 'vco', label: 'VCO error flag', type: 'select01' },
          { id: 'pkt-encDE',  key: 'de',  label: 'DE data error flag', type: 'select01' }],
  };

  function encExtrasHtml(fmt) {
    const e = state.pkt.enc;
    return ENC_EXTRAS[fmt].map(x => {
      if (x.type === 'num')
        return '<div><label for="' + x.id + '">' + esc(x.label) + '</label>'
          + '<input type="number" id="' + x.id + '" min="0" max="' + x.max + '" value="' + (e[x.key] || 0) + '"'
          + ' oninput="Packets.setEnc(\'' + x.key + '\',this.value)"></div>';
      const v = e[x.key] ? 1 : 0;
      return '<div><label for="' + x.id + '">' + esc(x.label) + '</label>'
        + '<select id="' + x.id + '" onchange="Packets.setEnc(\'' + x.key + '\',this.value)">'
        + '<option value="0"' + (v === 0 ? ' selected' : '') + '>0</option>'
        + '<option value="1"' + (v === 1 ? ' selected' : '') + '>1</option></select></div>';
    }).join('');
  }

  function refreshStation() {
    const el = document.getElementById('pkt-encStation');
    if (!el) return;
    const id = parseInt(state.pkt.enc.id, 10);
    if (isNaN(id)) { el.textContent = ''; return; }
    const s = stationName(id);
    el.innerHTML = 'Station name for ID ' + id + ': <span class="stn' + (s.none ? ' none' : '') + '">' + esc(s.text) + '</span>'
      + (s.source === 'meganet' ? ' <span class="badge ok">MegaNet</span>' : '');
  }

  function onFormatChange(fmt) {
    state.pkt.enc.format = fmt;
    const wrap = document.getElementById('pkt-encExtras');
    if (wrap) wrap.innerHTML = encExtrasHtml(fmt);
    const dataWrap = document.getElementById('pkt-encDataWrap');
    if (dataWrap) dataWrap.style.display = fmt === 'bcc' ? 'none' : '';
    const idInput = document.getElementById('pkt-encId');
    if (idInput) idInput.max = (1 << FORMATS[fmt].abits) - 1;
    refreshStation();
  }

  function setEnc(key, val) {
    const num = ['id', 'data', 'hd', 'bs', 'vco', 'de', 'b'];
    state.pkt.enc[key] = num.includes(key) ? (parseInt(val, 10) || 0) : val;
    if (key === 'id') refreshStation();
  }

  function doEncode() {
    const errEl = document.getElementById('pkt-encError');
    const resEl = document.getElementById('pkt-encResult');
    if (!resEl) return;
    state.pkt.lastEncode = true;
    errEl.hidden = true; resEl.innerHTML = '';
    const e = state.pkt.enc;
    const fmt = e.format, polarity = e.polarity;
    const values = { A: parseInt(e.id, 10) };
    if (fmt !== 'bcc') values.D = parseInt(e.data, 10);
    if (fmt === 'eaf') values.B = e.b || 0;
    if (fmt === 'bcc') { values.HD = e.hd || 0; values.BS = e.bs || 0; values.VCO = e.vco || 0; values.DE = e.de || 0; }
    let enc;
    try { enc = encodeFormat(fmt, values, polarity); }
    catch (err) { errEl.textContent = err.message; errEl.hidden = false; return; }
    const dec = decodeFormat(fmt, enc.bits32);
    let html = '<div class="encout">';
    html += '<div class="outbits">40-bit framed:&nbsp; <b id="pkt-enc40">' + enc.bits40 + '</b>'
      + '<button class="ghost copybtn" onclick="Packets.copyTxt(\'pkt-enc40\',this)">copy</button></div>';
    html += '<div class="outbits">32-bit payload: <b id="pkt-enc32">' + enc.bits32 + '</b> &nbsp;·&nbsp; hex <b>' + enc.hex + '</b>'
      + '<button class="ghost copybtn" onclick="Packets.copyTxt(\'pkt-enc32\',this)">copy</button></div>';
    html += renderBitMap(fmt, enc.bits40, true, [], 'enc');
    const legendFields = [...new Set(FORMATS[fmt].map.map(c => c.f))]; legendFields.push('frame');
    html += legendHtml(legendFields);
    html += fieldRows(fmt, dec);
    html += '<p class="spec">' + esc(FORMATS[fmt].note) + '</p></div>';
    resEl.innerHTML = html;
    attachHover(resEl);
  }

  function copyTxt(id, btn) {
    const el = document.getElementById(id);
    if (!el || !navigator.clipboard) return;
    navigator.clipboard.writeText(el.textContent).then(() => {
      btn.textContent = 'copied ✓'; setTimeout(() => btn.textContent = 'copy', 1200);
    });
  }

  function prefillEncoder(fmt, idv, dv) {
    state.pkt.enc.format = fmt;
    state.pkt.enc.id = idv;
    state.pkt.enc.data = dv;
    const fmtEl = document.getElementById('pkt-encFormat'); if (fmtEl) fmtEl.value = fmt;
    const idEl = document.getElementById('pkt-encId');   if (idEl) idEl.value = idv;
    onFormatChange(fmt);
    const dEl = document.getElementById('pkt-encData');  if (dEl) dEl.value = dv;
    doEncode();
    const sec = document.getElementById('pkt-encodeSection');
    if (sec) sec.scrollIntoView({ behavior: 'smooth' });
  }

  // ── public: read the decode input box and decode / example ────────────────────
  const EXAMPLE = '1000001110111010101011111100001111111100';
  function decode()      { const el = document.getElementById('pkt-decInput'); if (el) doDecode(el.value, false); }
  function loadExample() { const el = document.getElementById('pkt-decInput'); if (el) { el.value = EXAMPLE; doDecode(EXAMPLE, false); } }
  function encode()      { doEncode(); }

  function replay() {
    if (state.pkt.lastDecode != null) doDecode(state.pkt.lastDecode, false);
    if (state.pkt.lastEncode)         doEncode();
  }

  // ── tab render + init ─────────────────────────────────────────────────────────
  function render() {
    const e = state.pkt.enc;
    const fmt = e.format;
    const abits = FORMATS[fmt].abits;
    return `
    <div class="pkt" style="max-width:1280px;margin:auto;padding:1rem;display:grid;gap:1rem">

      <div class="panel">
        <div class="panel-header"><h2>ALERT / ERTS Packet Tool</h2></div>
        <p class="sub">Decode and encode event-reporting radio telemetry (ALERT) messages per the Bureau of
          Meteorology <em>ERTS Data Formats</em> specification (July 2003) — ALERT Binary (ABF), BCC Extended
          Check, Enhanced ALERT Binary (EAF) and Enhanced IFLOWS (EIF). Decoded addresses are matched against
          the loaded MegaNet station database first, then the bundled national address file.</p>
        <p class="sub" style="margin-top:-.4rem">A fifth layout, <b>A2C</b>, joins them for 32-bit input: the
          four-byte form the same address and value take inside an ALERT2 “ALERT concentration” payload, which
          is what an ELPRO ERT-A2 puts on RS232. Paste whole serial lines on the
          <a href="javascript:void 0" onclick="switchTab('alert2')">ALERT2 / ERT-A2</a> tab instead — this page
          decodes one reading at a time.</p>
      </div>

      <div class="panel" id="pkt-decodeSection">
        <div class="panel-header"><h3>Decode a message</h3></div>
        <p class="sub">Paste a binary string — 40 bits (four 10-bit words including start/stop bits) or 32 bits
          (payload only). Hex like <code>0x07D5F8FE</code> also works. The message is decoded against every
          known format; the one that passes all checks is highlighted.</p>
        <div class="row">
          <div class="grow2">
            <label for="pkt-decInput">Binary message</label>
            <input type="text" id="pkt-decInput" spellcheck="false" value="${esc(state.pkt.decInput)}"
                   oninput="state.pkt.decInput=this.value"
                   onkeydown="if(event.key==='Enter')Packets.decode()"
                   placeholder="e.g. 1000001110111010101011111100001111111100">
          </div>
          <div class="fit"><button class="primary" onclick="Packets.decode()">Decode</button></div>
          <div class="fit"><button class="ghost" onclick="Packets.loadExample()">Load example</button></div>
        </div>
        <div id="pkt-decError" class="err" hidden></div>
        <div id="pkt-decFraming" class="framing-note" hidden></div>
        <div id="pkt-decResults"></div>
      </div>

      <div class="panel" id="pkt-encodeSection">
        <div class="panel-header"><h3>Encode a message</h3></div>
        <p class="sub">Pick a format, enter the sensor ID and raw value(s), and get the binary message back.
          CRC / FCS bits are computed automatically. The bit map shows exactly where each value lands.</p>
        <div class="row">
          <div>
            <label for="pkt-encFormat">Format</label>
            <select id="pkt-encFormat" onchange="Packets.onFormatChange(this.value)">
              <option value="abf"${fmt === 'abf' ? ' selected' : ''}>ABF — ALERT Binary</option>
              <option value="bcc"${fmt === 'bcc' ? ' selected' : ''}>BCC — Extended Check</option>
              <option value="eaf"${fmt === 'eaf' ? ' selected' : ''}>EAF — Enhanced ALERT Binary</option>
              <option value="eif"${fmt === 'eif' ? ' selected' : ''}>EIF — Enhanced IFLOWS</option>
            </select>
          </div>
          <div>
            <label for="pkt-encId">Sensor ID (address)</label>
            <input type="number" id="pkt-encId" min="0" max="${(1 << abits) - 1}" value="${esc(e.id)}"
                   oninput="Packets.setEnc('id',this.value)">
          </div>
          <div id="pkt-encDataWrap" style="display:${fmt === 'bcc' ? 'none' : ''}">
            <label for="pkt-encData">Data value</label>
            <input type="number" id="pkt-encData" min="0" max="2047" value="${esc(e.data)}"
                   oninput="Packets.setEnc('data',this.value)">
          </div>
          <div>
            <label for="pkt-encPolarity">Framing (start/stop bits)</label>
            <select id="pkt-encPolarity" onchange="Packets.setEnc('polarity',this.value)">
              <option value="negative"${e.polarity !== 'standard' ? ' selected' : ''}>ALERT negative logic — start=1, stop=0</option>
              <option value="standard"${e.polarity === 'standard' ? ' selected' : ''}>Standard async — start=0, stop=1</option>
            </select>
          </div>
        </div>
        <div class="row" id="pkt-encExtras" style="margin-top:10px">${encExtrasHtml(fmt)}</div>
        <div class="note compact" id="pkt-encStation" style="margin-top:.75rem"></div>
        <div class="row" style="margin-top:14px">
          <div class="fit"><button class="primary" onclick="Packets.encode()">Encode</button></div>
        </div>
        <div id="pkt-encError" class="err" hidden></div>
        <div id="pkt-encResult"></div>
      </div>

      <div class="panel">
        <details>
          <summary class="pkt-summary">Format cheat-sheet</summary>
          <ul class="pkt-cheat">
            <li><b>ABF</b> — 13-bit address, 11-bit data. Words 1–2 carry check bits <code>10</code>, words 3–4 carry <code>11</code>.</li>
            <li><b>BCC Extended Check</b> — follow-up health message: 13-bit address, 5 high data bits (HD), 4 battery status bits (BS), VCO and DE error flags. Words 3–4 carry check bits <code>01</code>.</li>
            <li><b>EAF</b> — 12-bit address, 11-bit data, battery bit B, 6 CRC bits (wind sensors substitute gust data for the CRC). Abandoned in practice.</li>
            <li><b>EIF</b> — 13-bit address, 11-bit data, 6-bit FCS. FCS is a CRC with generator polynomial x⁶+x⁴+x³+1 over the 24 address+data bits (address then data, MSB first).</li>
            <li>All fields are transmitted least-significant bit first; each 10-bit word is start bit + 8 payload bits + stop bit.</li>
            <li><b>A2C</b> — ALERT2 concentration record, the modern carrier for the same reading. Four bytes,
              no framing and no CRC: address low byte, a packed byte of <code>DDD AAAAA</code> (data bits 10–8,
              address bits 12–8), the data low byte, then a status byte that is 0 on every valid record. Offered
              only for 32-bit input, since these bytes come out of an ALERT2 payload rather than off the air as
              async words. An ERT-A2 concatenates several of them behind a three-byte header —
              see the <a href="javascript:void 0" onclick="switchTab('alert2')">ALERT2 / ERT-A2</a> tab.</li>
          </ul>
        </details>
        <p class="spec" style="margin-top:.75rem">
          Bit-field layouts from BoM <em>ERTS Data Formats</em> v1.0 (July 2003) —
          <a href="${encodeURI('docs/BOM spec erts_data_formats_doc.pdf')}" target="_blank" rel="noopener">specification PDF</a>.
          Station names from <a href="${encodeURI('data/All 2021 Working 2.txt')}" target="_blank" rel="noopener">All 2021 Working 2.txt</a>.
          <span id="pkt-stnStatus" class="small"></span>
        </p>
      </div>

    </div>`;
  }

  function init() {
    refreshStation();
    updateStnStatus();
    loadStationsFile();   // no-op if already loaded/loading
    replay();             // restore any previous decode/encode results
  }

  return { render, init, decode, encode, loadExample, onFormatChange, setEnc, copyTxt, prefillEncoder,
           decodeMessage, stationName, loadStationsFile };
})();

// ── ALERT2 / ERT-A2 tab ─────────────────────────────────────────────────────────
//
// Decoder for the "ALERT2 ASCII Protocol" an ELPRO ERT-A2 writes to its RS232
// port: one comma-separated line per received ALERT2 frame, 24 fixed fields of
// receiver metadata followed by the frame's payload as hex bytes.
//
//   ALERT2A,1,9999,ELPRO,N,1,2026,6,8,19,10,41.296,0,0,0,0,0,1,0,0,0,7,7,9999,74,64,F0,7E,18,15,00
//   └ tag  │ │    │     │ │ └──── ERT-A2 clock ──┘ └── status ──┘ │  │  │    └── payload ──────┘
//          │ │    │     │ └ constant                              │  │  └ source address
//          │ │    │     └ frame type                              │  └ payload length, bytes
//          │ │    └ agency id                                     └ reception quality
//          │ └ decoder address (this ERT-A2)
//          └ interface version
//
// The payload is an ALERT2 "ALERT concentration" element — IND type 0x74, two
// bytes of seconds-since-midnight, then any number of four-byte records each
// carrying one legacy 13-bit ALERT address and its 11-bit value. So the modern
// frame is a wrapper: what comes out the other end is the same ID-and-value pair
// the ALERT Packets tab has always decoded, which is why both tabs agree on a
// reading and why station lookup is shared between them.
//
// Nothing here is guesswork about the payload: the field meanings below were
// derived by decoding a 444-frame capture from a test ERT-A2 and checking every
// address, value and timestamp against the same traffic decoded by ELPRO's own
// Ranger software. Where a field's meaning could not be established that way it
// says so rather than inventing one — see REFERENCE at the bottom of the tab.
//
// Live capture is the destination, not the starting point. Web Serial is closed
// off on managed machines, so this ingests what an operator can get today: text
// pasted out of PuTTY, or a PuTTY session log picked off disk. Where the browser
// offers the File System Access API the picked log can also be re-read on a
// timer, which is as close to live as this gets without a serial port.

const Alert2 = (function () {

  // ── protocol ──────────────────────────────────────────────────────────────────

  const TAG = 'ALERT2A';
  const IND_ALERT_CONC = 0x74;     // payload byte 0 on every frame in the capture
  const HDR_BYTES = 3;             // IND + 2 bytes of seconds-since-midnight
  const REC_BYTES = 4;

  // The 24 fixed fields, in order. `role` drives the colour of the chip in the
  // frame anatomy; `sure` marks what the Ranger cross-check actually established
  // as against what was merely constant across every frame observed.
  const FIELDS = [
    { k: 'tag',      label: 'Protocol tag',      role: 'ident', sure: true,
      note: 'Always ALERT2A. ELPRO calls this the ALERT2 ASCII Protocol; the binary protocol is a different, longer framing this tab does not read.' },
    { k: 'version',  label: 'Interface version', role: 'ident', sure: false,
      note: '1 on every frame observed.' },
    { k: 'decoder',  label: 'Decoder address',   role: 'addr',  sure: true,
      note: 'The ERT-A2 doing the receiving — the unit this serial cable is plugged into. Configured on the unit itself.' },
    { k: 'agency',   label: 'Agency ID',         role: 'ident', sure: true,
      note: 'ALERT2 agency string carried in the frame. ELPRO here.' },
    { k: 'frameType', label: 'Frame type',       role: 'ident', sure: false,
      note: 'N on every frame observed.' },
    { k: 'const6',   label: 'Field 6',           role: 'ident', sure: false,
      note: '1 on every frame observed; meaning not established.' },
    { k: 'year',     label: 'Year',              role: 'time',  sure: true, num: true },
    { k: 'month',    label: 'Month',             role: 'time',  sure: true, num: true },
    { k: 'day',      label: 'Day',               role: 'time',  sure: true, num: true },
    { k: 'hour',     label: 'Hour',              role: 'time',  sure: true, num: true },
    { k: 'minute',   label: 'Minute',            role: 'time',  sure: true, num: true },
    { k: 'second',   label: 'Second',            role: 'time',  sure: true, num: true,
      note: 'Fractional, to milliseconds. Fields 7–12 are the ERT-A2\'s own real-time clock, which is not necessarily right — compare it with the ALERT2 time in the payload.' },
    { k: 'st13',     label: 'Status 13',         role: 'status', sure: false },
    { k: 'st14',     label: 'Status 14',         role: 'status', sure: false },
    { k: 'st15',     label: 'Status 15',         role: 'status', sure: false },
    { k: 'st16',     label: 'Status 16',         role: 'status', sure: false },
    { k: 'st17',     label: 'Status 17',         role: 'status', sure: false },
    { k: 'frameOk',  label: 'Frame valid',       role: 'status', sure: true, num: true,
      note: '1 on all 443 good frames in the reference capture and 0 on the single corrupt one, whose records also carried non-zero status bytes and addresses matching no station. Read as a frame-valid flag.' },
    { k: 'st19',     label: 'Status 19',         role: 'status', sure: false },
    { k: 'st20',     label: 'Status 20',         role: 'status', sure: false },
    { k: 'st21',     label: 'Status 21',         role: 'status', sure: false },
    { k: 'quality',  label: 'Reception quality', role: 'status', sure: false, num: true,
      note: '7 on every good frame and 1 on the corrupt one. Tracks frame health; the scale is not established, and it is not RSSI — no field in the ASCII line carries the dBm figure Ranger reports.' },
    { k: 'payLen',   label: 'Payload length',    role: 'len',   sure: true, num: true,
      note: 'Payload size in bytes. Matched the number of trailing hex fields on all 444 frames, so it is what tells a wrapped or truncated line from a complete one.' },
    { k: 'source',   label: 'Source address',    role: 'addr',  sure: true, num: true,
      note: 'The ALERT2 node that transmitted the frame. On a unit configured as a repeater this is the repeater\'s own address, so it equals the decoder address and says nothing about which field station the readings came from — that identity is in the payload, as the ALERT id of each record.' },
  ];
  const N_FIELDS = FIELDS.length;   // 24

  // ── one four-byte concentration record ────────────────────────────────────────
  //
  //   byte 0   AAAAAAAA   address bits 7–0
  //   byte 1   DDDAAAAA   data bits 10–8, then address bits 12–8
  //   byte 2   DDDDDDDD   data bits 7–0
  //   byte 3   SSSSSSSS   status; 0 on every valid record observed
  //
  // Same 13-bit address and 11-bit value as ABF/EIF, packed into bytes instead of
  // async words. FORMATS.a2c on the ALERT Packets tab draws this same layout.
  function decodeRecord(b, off) {
    return {
      off,
      bytes:   [b[0], b[1], b[2], b[3]],
      alertId: ((b[1] & 0x1f) << 8) | b[0],
      value:   ((b[1] >> 5) << 8) | b[2],
      status:  b[3],
      ok:      b[3] === 0,
    };
  }

  const FULL_SCALE = 2047;          // 11 bits all set: over-range or a dead sensor

  // ── capture ingest ────────────────────────────────────────────────────────────

  // PuTTY stamps this line into the log every time a session starts, so a log
  // reused across sessions has them scattered through the middle of the data —
  // and, as in the reference capture, one can land mid-line and cut a frame in
  // half. Both halves have to be recognised for what they are rather than
  // silently mangling the frames either side.
  // Both runs of "=~" are matched greedily so the whole banner is one match. A
  // lazier pattern chops the same line into three, which inflates the count and
  // leaves the text between the pieces looking like data.
  const BANNER = /(?:=~){3,}=?[^\n]*?(?:=~){3,}=?/g;
  const BANNER_TS = /PuTTY log (\d{4})\.(\d\d)\.(\d\d) (\d\d):(\d\d):(\d\d)/;

  // Some operators configure their terminal to stamp each line. There is no one
  // format, so rather than matching a list this takes whatever sits in front of
  // the ALERT2A tag, strips the brackets and tries to read a time out of it —
  // and if it can't, keeps it as an opaque label rather than throwing the line
  // away. The ERT-A2's own clock is in the frame regardless, so a prefix that
  // won't parse costs nothing.
  function parsePrefix(s) {
    const text = String(s || '').trim().replace(/^[[(<]\s*|\s*[\])>]$|[-–—:\s]+$/g, '').trim();
    if (!text) return null;
    let m = text.match(/(\d{4})[-/.](\d\d?)[-/.](\d\d?)[ T](\d\d?):(\d\d)(?::(\d\d)(?:[.,](\d{1,3}))?)?/);
    if (m) return { text, ms: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), +((m[7] || '0').padEnd(3, '0'))), dated: true };
    m = text.match(/(\d\d?)[-/.](\d\d?)[-/.](\d{4})[ T](\d\d?):(\d\d)(?::(\d\d)(?:[.,](\d{1,3}))?)?/);
    if (m) return { text, ms: Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0), +((m[7] || '0').padEnd(3, '0'))), dated: true };
    m = text.match(/^(\d\d?):(\d\d):(\d\d)(?:[.,](\d{1,3}))?$/);
    if (m) return { text, sod: +m[1] * 3600 + +m[2] * 60 + +m[3], dated: false };
    return { text, dated: false };
  }

  // A hex payload field, and nothing else: this is what says a stray line is the
  // tail of a wrapped frame rather than noise. Frames wrap when the receiving
  // terminal folds a long line, which puts the break at a comma — so the tail
  // starts with one, or is bare hex pairs.
  const HEX_TAIL = /^,?(?:[0-9A-Fa-f]{1,2})(?:\s*,\s*[0-9A-Fa-f]{1,2})*,?$/;

  // How many payload bytes a frame is still waiting for. This is what stops the
  // tail-gluing from being a guess: a complete frame never adopts the next line,
  // however much that line looks like hex. The reference capture has a PuTTY
  // banner landing mid-line and leaving a stray "A" behind — a perfectly good
  // hex byte, which without this check gets welded onto the frame above it.
  function shortfall(text) {
    const f = text.split(',');
    if (f.length <= N_FIELDS) return Infinity;          // header itself is incomplete
    const want = Number(f[N_FIELDS - 2]);               // field 23, the payload length
    return Number.isFinite(want) ? want - (f.length - N_FIELDS) : 0;
  }

  // Split a capture into frame texts. Returns the pieces in file order along with
  // everything deliberately dropped, so the summary can account for every line
  // rather than quietly losing some.
  function splitCapture(text) {
    const frames = [];              // { text, lineNo, prefix, wrapped }
    const banners = [];             // { lineNo, ms }
    const junk = [];                // { lineNo, text, why }
    let blank = 0;

    String(text || '').split(/\r?\n/).forEach((rawLine, i) => {
      const lineNo = i + 1;
      // A banner can sit anywhere in the line, so cut around it and treat the
      // remains as separate pieces rather than testing the line as a whole.
      const pieces = [];
      let last = 0;
      BANNER.lastIndex = 0;
      let m;
      while ((m = BANNER.exec(rawLine)) !== null) {
        if (m.index > last) pieces.push(rawLine.slice(last, m.index));
        const b = m[0].match(BANNER_TS);
        banners.push({ lineNo, ms: b ? Date.UTC(+b[1], +b[2] - 1, +b[3], +b[4], +b[5], +b[6]) : null });
        last = m.index + m[0].length;
      }
      if (last < rawLine.length) pieces.push(rawLine.slice(last));
      if (!pieces.length) return;

      pieces.forEach(piece => {
        const line = piece.trim();
        if (!line) return;
        const at = line.indexOf(TAG);
        if (at >= 0) {
          frames.push({ text: line.slice(at), lineNo, prefix: parsePrefix(line.slice(0, at)), wrapped: false });
          return;
        }
        // No tag: either the tail of the frame above, or something else entirely.
        const prev = frames.length ? frames[frames.length - 1] : null;
        if (prev && HEX_TAIL.test(line) && shortfall(prev.text) > 0) {
          prev.text = prev.text.replace(/,\s*$/, '') + ',' + line.replace(/^,\s*/, '');
          prev.wrapped = true;
          return;
        }
        junk.push({ lineNo, text: line, why: frames.length ? 'not an ALERT2A line' : 'before the first ALERT2A line' });
      });
    });
    return { frames, banners, junk };
  }

  // ── frame parse ───────────────────────────────────────────────────────────────

  function parseFrame(src, seq) {
    const f = {
      seq, lineNo: src.lineNo, raw: src.text, wrapped: src.wrapped, prefix: src.prefix,
      fields: src.text.split(',').map(s => s.trim()),
      warn: [], error: null, hdr: {}, payload: null, records: [],
    };
    const v = f.fields;

    if (v[0] !== TAG) { f.error = 'does not start with ' + TAG; return f; }
    if (v.length < N_FIELDS + 1) {
      f.error = 'truncated — ' + v.length + ' fields, at least ' + (N_FIELDS + 1) + ' expected'
              + (v.length < N_FIELDS ? '' : ' (header complete, payload missing)');
      return f;
    }

    const num = i => { const n = Number(v[i]); return Number.isFinite(n) ? n : null; };
    const h = f.hdr;
    FIELDS.forEach((spec, i) => { h[spec.k] = spec.num ? num(i) : v[i]; });

    // The ERT-A2's own clock. Built as local time because that is how the unit
    // reports it and how an operator reading the log will think about it.
    if ([h.year, h.month, h.day, h.hour, h.minute, h.second].every(x => x !== null)) {
      const s = Math.floor(h.second);
      h.clockMs = new Date(h.year, h.month - 1, h.day, h.hour, h.minute, s,
                           Math.round((h.second - s) * 1000)).getTime();
      h.clockSod = h.hour * 3600 + h.minute * 60 + h.second;
    } else {
      h.clockMs = null; h.clockSod = null;
      f.warn.push('the date/time fields did not parse as numbers');
    }
    if (h.frameOk !== 1) f.warn.push('frame-valid flag (field 18) is ' + v[17] + ', not 1 — the receiver did not consider this frame clean');

    // Payload.
    const hex = v.slice(N_FIELDS);
    const bad = hex.findIndex(x => !/^[0-9A-Fa-f]{1,2}$/.test(x));
    if (bad >= 0) { f.error = 'payload field ' + (N_FIELDS + bad + 1) + ' is not a hex byte (' + v[N_FIELDS + bad] + ')'; return f; }
    const bytes = hex.map(x => parseInt(x, 16));

    if (h.payLen !== bytes.length) {
      f.warn.push('payload length says ' + h.payLen + ' byte' + (h.payLen === 1 ? '' : 's')
                + ' but ' + bytes.length + ' arrived — the line is ' + (bytes.length < h.payLen ? 'cut short' : 'over-long'));
    }
    readPayload(f, bytes);
    return f;
  }

  // The IND payload, and the readings inside it. Identical on both wire formats
  // — the ASCII line spells these bytes out one hex field at a time and the
  // binary frame carries them whole, but from `0x74` on it is the same element,
  // so both paths decode it here.
  function readPayload(f, bytes) {
    if (bytes.length < HDR_BYTES) { f.error = 'payload is only ' + bytes.length + ' byte(s); ' + HDR_BYTES + ' are needed before any reading'; return f; }

    const ind = bytes[0];
    const sod = (bytes[1] << 8) | bytes[2];
    f.payload = { bytes, ind, sod, body: bytes.slice(HDR_BYTES) };

    if (ind !== IND_ALERT_CONC) {
      f.error = 'payload type 0x' + ind.toString(16).toUpperCase().padStart(2, '0')
              + ' is not the ALERT concentration type (0x74) this decoder knows';
      return f;
    }

    const body = f.payload.body;
    const whole = Math.floor(body.length / REC_BYTES);
    if (body.length % REC_BYTES) f.warn.push((body.length % REC_BYTES) + ' byte(s) left over after the last complete reading');
    for (let i = 0; i < whole; i++) {
      const r = decodeRecord(body.slice(i * REC_BYTES, i * REC_BYTES + REC_BYTES), HDR_BYTES + i * REC_BYTES);
      r.frame = f; r.idx = i;
      if (!r.ok) f.warn.push('reading ' + (i + 1) + ' has status byte 0x'
                           + r.status.toString(16).toUpperCase().padStart(2, '0') + ', not 0 — treat it as corrupt');
      f.records.push(r);
    }
    return f;
  }

  // ── the second wire format: ELPRO's binary framing (USB) ──────────────────────
  //
  // The ASCII protocol above is what the ERT-A2 writes to its secondary RS232
  // port, and it has no RSSI in it — 24 fixed fields, none of which is a signal
  // level. ELPRO's own Ranger software reports RSSI for every packet, and its
  // "Serial Data" pane shows why: over the USB port the unit speaks a different,
  // binary framing, and that one carries the number.
  //
  // Nothing here is a command sent to the unit. This decodes what the USB port
  // emits; whether Ranger has to ask for it first is not something a receive-only
  // capture can answer, and the reference material says so rather than guessing.
  //
  //   "ALERT2"  <len>  <TLV> <TLV> ...
  //   \_ 6 ASCII bytes, the frame sync
  //             \_ one byte: how many bytes of TLV follow
  //
  // Every element is tag / length / value. A tag byte with the top bit set is
  // the first of a two-byte tag; otherwise the tag is that one byte. Length is
  // always a single byte, so an element carries at most 255 bytes — which is why
  // the fixed receive buffer below is 24 and not something larger.
  const BIN_MAGIC = [0x41, 0x4C, 0x45, 0x52, 0x54, 0x32];   // "ALERT2"
  const BIN_FILL  = 0xA1;    // what the fixed receive buffer is padded out with
  const BIN_BUF   = 24;      // that buffer's size, constant across the capture

  // `sure` carries the same meaning as it does for the ASCII fields: established
  // by cross-checking against Ranger's own decode of the same traffic, as against
  // merely constant on every frame seen.
  const BIN_TAGS = {
    '75':   { label: 'Interface version', role: 'ident', kind: 'u8', sure: false,
              note: '1 on every frame observed — the same value the ASCII line carries as field 2.' },
    '18':   { label: 'Source address', role: 'addr', kind: 'u16', sure: true,
              note: 'Matched Ranger\'s Source column on every frame. On a unit configured as a repeater the source and decoder addresses are the same number, so this capture cannot say which of the two it is.' },
    '77':   { label: 'Agency ID', role: 'ident', kind: 'ascii', sure: true,
              note: 'ASCII, length-delimited. ELPRO here, matching Ranger\'s Agency ID column.' },
    '15':   { label: 'As received', role: 'len', kind: 'container', sure: true,
              note: 'The air-link PDU exactly as it landed in the receive buffer, length and fill included.' },
    '14':   { label: 'Decoded', role: 'len', kind: 'container', sure: true,
              note: 'The same PDU split into header and payload, with the receive measurements appended. This is the element the RSSI lives in.' },
    '8410': { label: 'PDU length', role: 'len', kind: 'u16', sure: true,
              note: 'Bytes of air-link PDU in the buffer below. Equalled header + payload on every frame.' },
    '8411': { label: 'Receive buffer', role: 'status', kind: 'buf', sure: true,
              note: 'Fixed ' + BIN_BUF + '-byte buffer: a two-byte length, the PDU, then 0xA1 fill to the end. The PDU here was byte-identical to the split copy in the decoded element on every frame.' },
    '8412': { label: 'Field 8412', role: 'status', kind: 'u8', sure: false,
              note: '0 on every frame observed; meaning not established.' },
    '8400': { label: 'MANT header', role: 'time', kind: 'mant', sure: false,
              note: 'The six bytes in front of the payload: three constant (00 10 70), then the payload length, then the source address. The constant three are where the ASCII line\'s status and quality fields must sit, but nothing in this capture varies enough to separate them.' },
    '8401': { label: 'Payload', role: 'ident', kind: 'payload', sure: true,
              note: 'The ALERT2 IND element — the same 0x74 concentration payload the ASCII line spells out one hex field at a time.' },
    '9C2F': { label: 'RSSI', role: 'rssi', kind: 'i8', sure: true,
              note: 'Signed 8-bit, dBm. Equalled Ranger\'s RSSI column exactly on all 44 cross-checked frames — no scaling, no offset. This is the field the ASCII protocol has no equivalent of.' },
  };

  // Wire order, with nesting depth, for the reference table. Not derivable from
  // the object above: JS orders integer-like keys numerically, and every tag but
  // 9C2F is one, so iterating BIN_TAGS gives a sequence no frame is ever in.
  const BIN_ORDER = [
    ['75', 0], ['18', 0], ['77', 0],
    ['15', 0], ['8410', 1], ['8411', 1], ['8412', 1],
    ['14', 0], ['8400', 1], ['8401', 1], ['9C2F', 1],
  ];

  // Hex out of whatever the operator pasted. Ranger's Serial Data pane wraps
  // mid-frame at whatever width the window happens to be, so line breaks mean
  // nothing here and the bytes are treated as one stream — the "ALERT2" sync
  // below is what finds the frame boundaries, not the newlines.
  //
  // Two prefixes do have to come off first, because their digits are hex too and
  // would otherwise be read as data: a bracketed terminal timestamp, and the
  // offset column of a hex dump. Both are stripped per line, before anything is
  // treated as a byte.
  const HEXDUMP_OFF   = /^\s*[0-9A-Fa-f]{4,8}h?\s*:\s*/;      // "0000C0:" / "0000c0h:"
  const HEXDUMP_ASCII = /\|[^|]*\|\s*$/;                      // hexdump -C's right-hand pane
  const LINE_PREFIX   = /^\s*[[(<][^\])>]*[\])>]\s*[-–—:]?\s*/;

  function hexStream(text) {
    const bytes = [];
    const marks = [];       // { at, lineNo } — byte index each line's data starts at
    const stats = { lines: 0, hexLines: 0, prefixes: 0, dumps: 0, oddTokens: 0, junk: [] };

    String(text || '').split(/\r?\n/).forEach((rawLine, i) => {
      const lineNo = i + 1;
      if (!rawLine.trim()) return;
      stats.lines++;
      let line = rawLine;
      if (LINE_PREFIX.test(line))   { line = line.replace(LINE_PREFIX, '');   stats.prefixes++; }
      if (HEXDUMP_OFF.test(line))   { line = line.replace(HEXDUMP_OFF, '');   stats.dumps++; }
      if (HEXDUMP_ASCII.test(line)) { line = line.replace(HEXDUMP_ASCII, ''); }
      const toks = line.replace(/0[xX]/g, ' ').split(/[^0-9A-Fa-f]+/).filter(Boolean);
      if (!toks.length) { stats.junk.push({ lineNo, text: rawLine.trim().slice(0, 80), why: 'no hex on the line' }); return; }

      const at = bytes.length;
      let took = 0;
      toks.forEach(t => {
        // A single digit is a byte written without its leading zero, which is
        // what a "%X" dump does — pad it. Any other odd length is genuinely
        // ambiguous, and guessing where the missing nibble goes would shift
        // every byte after it, so it is dropped and counted instead.
        if (t.length === 1) t = '0' + t;
        else if (t.length % 2) { stats.oddTokens++; return; }
        for (let k = 0; k < t.length; k += 2) bytes.push(parseInt(t.slice(k, k + 2), 16));
        took += t.length / 2;
      });
      if (took) { marks.push({ at, lineNo }); stats.hexLines++; }
    });
    return { bytes, marks, stats };
  }

  // Which source line a byte offset came from. Binary search, because a long
  // capture is tens of thousands of lines and every frame asks this once.
  function lineAt(marks, at) {
    let lo = 0, hi = marks.length - 1, best = marks.length ? marks[0].lineNo : 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (marks[mid].at <= at) { best = marks[mid].lineNo; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
  }

  // Tag / length / value, flat. Returns what it managed to read plus whatever
  // went wrong, rather than throwing — a capture cut off mid-frame is normal and
  // should produce one reported bad frame, not a dead panel.
  function tlvRead(bytes, from, to, depth, out) {
    let at = from;
    while (at < to) {
      const t0 = bytes[at];
      const wide = (t0 & 0x80) !== 0;
      if (wide && at + 1 >= to) return 'tag at byte ' + at + ' runs off the end of the element';
      const tag = wide ? ((t0 << 8) | bytes[at + 1]) : t0;
      const hex = wide ? hx(t0) + hx(bytes[at + 1]) : hx(t0);
      at += wide ? 2 : 1;
      if (at >= to) return 'element ' + hex + ' has no length byte';
      const len = bytes[at]; at++;
      if (at + len > to) return 'element ' + hex + ' claims ' + len + ' bytes but only ' + (to - at) + ' remain';
      out.push({ tag: hex, len, depth, off: at, val: bytes.slice(at, at + len), spec: BIN_TAGS[hex] || null });
      at += len;
    }
    return null;
  }

  function u16(v, i) { return (v[i] << 8) | v[i + 1]; }
  function i8(b)     { return b > 127 ? b - 256 : b; }

  // One binary frame, from the sync byte to the end of its declared length.
  function parseBinFrame(bytes, at, lineNo, seq) {
    const len   = bytes[at + 6];
    const end   = at + 7 + len;
    const raw   = bytes.slice(at, end);
    const f = {
      seq, lineNo, kind: 'bin', byteOff: at, bytes: raw,
      raw: raw.map(hx).join(' '),
      wrapped: false, prefix: null, fields: [],
      warn: [], error: null, hdr: {}, payload: null, records: [], tlv: [],
    };
    const h = f.hdr;
    // Nothing in the binary frame is the receiver's own clock — the ASCII line's
    // date and time fields have no counterpart here, and Ranger's own display
    // stamps its rows from the PC. So the only time a binary capture has is the
    // one inside the payload, and the skew check has nothing to compare.
    h.clockMs = null; h.clockSod = null; h.frameOk = null;
    h.decoder = null; h.quality = null; h.rssi = null;

    const err = tlvRead(raw, 7, raw.length, 0, f.tlv);
    if (err) { f.error = err; return f; }

    const top = {};
    f.tlv.forEach(e => { top[e.tag] = e; });
    // The two containers hold the elements that matter, so they are unpacked in
    // place: the flat list stays in wire order with `depth` marking the nesting,
    // which is what the anatomy view draws.
    ['15', '14'].forEach(tagHex => {
      const c = top[tagHex];
      if (!c) return;
      const kids = [];
      const kerr = tlvRead(c.val, 0, c.val.length, 1, kids);
      if (kerr) { f.warn.push('inside element ' + tagHex + ': ' + kerr); return; }
      kids.forEach(k => { k.off += c.off; top[k.tag] = k; });
      const i = f.tlv.indexOf(c);
      f.tlv.splice(i + 1, 0, ...kids);
    });

    if (top['75']) h.version = top['75'].val[0];
    if (top['18'] && top['18'].len >= 2) h.source = u16(top['18'].val, 0);
    if (top['77']) h.agency = String.fromCharCode.apply(null, top['77'].val);
    if (top['9C2F'] && top['9C2F'].len >= 1) h.rssi = i8(top['9C2F'].val[0]);
    else f.warn.push('no RSSI element (9C2F) in this frame');

    const mant = top['8400'];
    if (mant && mant.len >= 6) {
      h.mant = { flags: mant.val.slice(0, 3), payLen: mant.val[3], addr: u16(mant.val, 4) };
      h.payLen = mant.val[3];
      if (h.source == null) h.source = h.mant.addr;
      else if (h.mant.addr !== h.source)
        f.warn.push('the MANT header address (' + h.mant.addr + ') and the frame\'s source address (' + h.source + ') disagree');
    }

    const pay = top['8401'];
    if (!pay) { f.error = 'no payload element (8401) — nothing to decode'; return f; }
    if (h.payLen != null && h.payLen !== pay.len)
      f.warn.push('the MANT header says ' + h.payLen + ' payload bytes but the payload element carries ' + pay.len);
    h.payLen = pay.len;

    // The received copy and the decoded copy are the same PDU twice over. When
    // they disagree the frame is damaged in a way neither copy admits to on its
    // own, so it is worth saying rather than picking one.
    const buf = top['8411'];
    if (buf && buf.len >= 2 && mant) {
      const pdu = u16(buf.val, 0);
      if (pdu !== mant.len + pay.len)
        f.warn.push('the receive buffer says ' + pdu + ' PDU bytes, but the header and payload add up to ' + (mant.len + pay.len));
      const copy = buf.val.slice(2, 2 + Math.min(pdu, buf.len - 2));
      const split = mant.val.concat(pay.val);
      if (copy.length === split.length && copy.some((b, i) => b !== split[i]))
        f.warn.push('the received copy of the PDU and the decoded copy are not the same bytes');
    }
    if (top['8410'] && top['8410'].len >= 2 && mant) {
      const n = u16(top['8410'].val, 0);
      if (n !== mant.len + pay.len) f.warn.push('the PDU length element says ' + n + ', not ' + (mant.len + pay.len));
    }

    readPayload(f, pay.val);
    return f;
  }

  // Split a hex capture into frames. Frame sync is the "ALERT2" magic and the
  // length byte behind it: anything between one frame's end and the next sync is
  // counted and skipped, which is what makes a wrapped pane, a stray timestamp
  // or a log that starts mid-frame all harmless.
  function splitBinary(text) {
    const { bytes, marks, stats } = hexStream(text);
    const frames = [];
    const n = bytes.length;
    let at = 0, stray = 0, tail = null;

    while (at + 7 <= n) {
      let sync = true;
      for (let k = 0; k < 6; k++) if (bytes[at + k] !== BIN_MAGIC[k]) { sync = false; break; }
      if (!sync) { at++; stray++; continue; }
      const len = bytes[at + 6];
      if (at + 7 + len > n) {
        // The log stops part-way through a frame. Reported, not decoded: half a
        // frame decodes to readings that were never sent.
        tail = { at, want: len + 7, got: n - at, lineNo: lineAt(marks, at) };
        at = n;
        break;
      }
      frames.push(parseBinFrame(bytes, at, lineAt(marks, at), frames.length));
      at += 7 + len;
    }
    stray += Math.max(0, n - at);
    return { frames, stats, stray, tail, total: n };
  }

  function parseBin(text) {
    const split = splitBinary(text);
    const frames = split.frames;
    const good = frames.filter(f => !f.error);
    const recs = [];
    good.forEach(f => f.records.forEach(r => recs.push(r)));
    const s = split.stats;

    const ingest = [];
    if (s.hexLines) ingest.push(s.hexLines + ' line' + (s.hexLines === 1 ? '' : 's') + ' of hex read as one byte stream');
    if (s.prefixes) ingest.push(s.prefixes + ' bracketed prefix' + (s.prefixes === 1 ? '' : 'es') + ' stripped before the hex');
    if (s.dumps)    ingest.push(s.dumps + ' hex-dump offset column' + (s.dumps === 1 ? '' : 's') + ' stripped');
    if (s.oddTokens) ingest.push(s.oddTokens + ' token' + (s.oddTokens === 1 ? '' : 's') + ' with an odd number of digits dropped — they cannot be split into bytes');
    if (split.stray) ingest.push(split.stray + ' byte' + (split.stray === 1 ? '' : 's') + ' outside any frame skipped');
    if (split.tail)  ingest.push('the capture stops ' + (split.tail.want - split.tail.got) + ' byte(s) into a frame at line ' + split.tail.lineNo);

    return {
      text, mode: 'bin', frames, records: recs,
      stats: {
        mode: 'bin',
        frames: frames.length,
        wrapped: 0, prefixed: s.prefixes,
        errors: frames.filter(f => f.error).length,
        warned: good.filter(f => f.warn.length).length,
        records: recs.length,
        badRecords: recs.filter(r => !r.ok).length,
        banners: 0, junk: s.junk,
        bytes: split.total, stray: split.stray, ingest,
        decoders: [], agencies: [...new Set(good.map(f => f.hdr.agency).filter(Boolean))],
        sources: [...new Set(good.map(f => f.hdr.source).filter(x => x != null))],
        firstMs: null, lastMs: null,
        skew: null, skewN: 0, skewSpread: null,
      },
    };
  }

  // ── capture-level parse ───────────────────────────────────────────────────────

  function median(xs) {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function parseAscii(text) {
    const split = splitCapture(text);
    const frames = split.frames.map((src, i) => parseFrame(src, i));

    const good = frames.filter(f => !f.error);
    const recs = [];
    good.forEach(f => f.records.forEach(r => recs.push(r)));

    // How far the ERT-A2's clock sits from the ALERT2 frame time. Measured on
    // frames the receiver flagged clean, since the corrupt ones carry a payload
    // time that may itself be nonsense.
    const skews = good.filter(f => f.hdr.frameOk === 1 && f.hdr.clockSod !== null && f.payload)
                      .map(f => f.hdr.clockSod - f.payload.sod);
    const skew = median(skews);

    const clocks = good.map(f => f.hdr.clockMs).filter(x => x);
    return {
      text, mode: 'ascii', frames, records: recs,
      stats: {
        mode:      'ascii',
        frames:    frames.length,
        wrapped:   frames.filter(f => f.wrapped).length,
        prefixed:  frames.filter(f => f.prefix).length,
        errors:    frames.filter(f => f.error).length,
        warned:    good.filter(f => f.warn.length).length,
        records:   recs.length,
        badRecords: recs.filter(r => !r.ok).length,
        banners:   split.banners.length,
        junk:      split.junk,
        decoders:  [...new Set(good.map(f => f.hdr.decoder))],
        sources:   [...new Set(good.map(f => f.hdr.source))],
        agencies:  [...new Set(good.map(f => f.hdr.agency))],
        firstMs:   clocks.length ? Math.min(...clocks) : null,
        lastMs:    clocks.length ? Math.max(...clocks) : null,
        skew, skewN: skews.length,
        skewSpread: skews.length ? Math.max(...skews) - Math.min(...skews) : null,
      },
    };
  }

  // Which format a capture is in. The two are unmistakable from a few bytes —
  // one starts every line with the literal word ALERT2A, the other carries the
  // same word as hex — so sniffing beats making the operator classify a paste
  // they may not have looked at. A file holding both (an operator logging one
  // port after the other into the same file) reads as whichever yields more
  // frames, and the summary says which was chosen.
  const BIN_MAGIC_HEX = /4\s*1\W*4\s*C\W*4\s*5\W*5\s*2\W*5\s*4\W*3\s*2/i;

  function parse(text, mode) {
    const src = String(text || '');
    if (mode === 'ascii') return parseAscii(src);
    if (mode === 'bin')   return parseBin(src);

    const hasAscii = src.indexOf(TAG) >= 0;
    const hasBin   = BIN_MAGIC_HEX.test(src);
    if (hasAscii && !hasBin) return mark(parseAscii(src), 'auto');
    if (hasBin && !hasAscii) return mark(parseBin(src), 'auto');
    if (!hasAscii && !hasBin) return mark(parseAscii(src), 'auto');   // nothing recognisable; the ASCII path reports why
    const a = parseAscii(src), b = parseBin(src);
    const aN = a.stats.frames - a.stats.errors, bN = b.stats.frames - b.stats.errors;
    return mark(bN > aN ? b : a, 'auto');
  }

  function mark(p, how) { p.detected = how; return p; }

  // ── station resolution ────────────────────────────────────────────────────────
  //
  // An ALERT address is only unique within a region. MegaNet's database is
  // national, so ids get reused — 604 of its 5122 addresses belong to more than
  // one station, and a Queensland reading whose id is also a Victorian station's
  // will match both. The capture itself settles most of them: every frame in a
  // file came through one receiver, so the readings are all from one corner of
  // the country. Addresses that match exactly one station fix where that corner
  // is, and an ambiguous address then resolves to whichever candidate is near it.
  //
  // What this deliberately does not do is force a winner. Two stations 6 km apart
  // sharing the same ids (Wamuran McClintock Rd and Wamuran Eureka Ct do) cannot
  // be told apart by anything in the frame, and guessing between them would be
  // worse than saying so — those are reported as ambiguous, with a pin so an
  // operator who knows the answer can record it for the rest of the capture.

  const GAP_KM = 100;   // how much closer the winner must be before it is called resolved

  const idx = { src: null, byId: null };
  function alertIndex() {
    if (!state.data || !Array.isArray(state.data.stations)) return new Map();
    if (idx.src !== state.data) {
      idx.src = state.data;
      idx.byId = new Map();
      state.data.stations.forEach(s => {
        const types = new Map();
        stationSensors(s).forEach(se => {
          if (!se || se.alert_id == null) return;
          if (!types.has(se.alert_id)) types.set(se.alert_id, new Set());
          if (se.type) types.get(se.alert_id).add(se.type);
        });
        types.forEach((tset, aid) => {
          if (!idx.byId.has(aid)) idx.byId.set(aid, []);
          idx.byId.get(aid).push({ station: s, types: [...tset] });
        });
      });
    }
    return idx.byId;
  }

  function kmApart(aLat, aLon, bLat, bLon) {
    const dLat = (aLat - bLat) * 111.32;
    const dLon = (aLon - bLon) * 111.32 * Math.cos((aLat + bLat) / 2 * Math.PI / 180);
    return Math.sqrt(dLat * dLat + dLon * dLon);
  }

  function resolve(parsed) {
    const byId = alertIndex();
    const seen = new Map();
    parsed.records.forEach(r => { if (r.ok) seen.set(r.alertId, (seen.get(r.alertId) || 0) + 1); });

    const anchors = [];
    seen.forEach((n, aid) => {
      const c = byId.get(aid);
      if (c && c.length === 1 && c[0].station.lat != null && c[0].station.lon != null) anchors.push(c[0].station);
    });
    // Median, not mean: one station on the far side of the country would drag a
    // mean far enough to start picking the wrong candidates for everything else.
    const centre = anchors.length
      ? { lat: median(anchors.map(s => s.lat)), lon: median(anchors.map(s => s.lon)), n: anchors.length }
      : null;

    const out = new Map();
    seen.forEach((count, aid) => {
      const cands = (byId.get(aid) || []).map(c => {
        const st = c.station;
        const others = stationAlertIds(st).filter(x => x !== aid);
        return {
          station: st, types: c.types,
          distKm: (centre && st.lat != null && st.lon != null) ? kmApart(centre.lat, centre.lon, st.lat, st.lon) : null,
          siblings: others.filter(x => seen.has(x)).length,
          siblingsTotal: others.length,
        };
      });
      cands.sort((a, b) => ((a.distKm == null ? Infinity : a.distKm) - (b.distKm == null ? Infinity : b.distKm))
                        || (b.siblings - a.siblings));

      const pin = state.a2.picks[aid];
      let conf, chosen = null;
      if (!cands.length) conf = 'unknown';
      else if (pin != null && cands.some(c => c.station.id === pin)) { chosen = cands.find(c => c.station.id === pin); conf = 'pinned'; }
      else if (cands.length === 1) { chosen = cands[0]; conf = 'sole'; }
      else {
        chosen = cands[0];
        const a = cands[0], b = cands[1];
        if (a.distKm != null && b.distKm != null && b.distKm - a.distKm >= GAP_KM) conf = 'resolved';
        else if (a.siblings > b.siblings) conf = 'likely';
        else conf = 'ambiguous';
      }
      out.set(aid, { aid, count, cands, chosen, conf,
                     kind: chosen ? kindOf(chosen.types) : null,
                     // Only worth asking the bundled national address file about
                     // ids MegaNet has never heard of.
                     fileName: cands.length ? null : Packets.stationName(aid) });
    });
    return { byAlertId: out, centre, anchors: anchors.length,
             ambiguous: [...out.values()].filter(r => r.conf === 'ambiguous' || r.conf === 'likely').length,
             unknown: [...out.values()].filter(r => r.conf === 'unknown').length };
  }

  function kindOf(types) {
    const t = (types || []).join(' ').toLowerCase();
    if (/batt/.test(t)) return 'battery';
    if (/rain/.test(t)) return 'rain';
    if (/level|stage|ahd|height/.test(t)) return 'level';
    return null;
  }

  // Engineering values are an interpretation laid over the reading, not part of
  // it, so only the two that the reference capture actually supports are offered.
  // Battery values cluster at 130–142 across 213 readings, which is 13.0–14.2 V
  // and nothing else; rainfall counts step up one at a time, which is a tipping
  // bucket. Water level is left as raw counts because its scale is set per site
  // and the capture gives no way to tell which — a number invented here would
  // read like a measurement.
  //
  // `st` is the station the address resolved to, if any (see rowsFor /
  // stationRollup). When it carries a recorded TBRGbucketSize that wins; the
  // per-capture "mm per tip" box (a.mmPerTip, default 0.2) is a fallback for
  // everything else, not the only source any more. Either way the rule text
  // says which one was used — a converted millimetre value that doesn't say
  // that is exactly the kind of number that ends up in a report.
  function engValue(kind, raw, st) {
    const a = state.a2;
    if (!a.eng) return null;
    if (kind === 'battery' && a.battDiv > 0) return { text: (raw / a.battDiv).toFixed(1) + ' V',  rule: 'raw ÷ ' + a.battDiv };
    if (kind === 'rain') {
      const bucket = bucketSizeMm(st);
      const mmPerTip = bucket.recorded ? bucket.mm : a.mmPerTip;
      if (!(mmPerTip > 0)) return null;
      const mm = raw * mmPerTip;
      const source = bucket.recorded ? `recorded for ${st.name}`
                   : st ? `assumed — not recorded for ${st.name}`
                        : 'assumed — no station resolved';
      return { text: (Math.round(mm * 100) / 100) + ' mm',
               rule: 'raw × ' + mmPerTip + ' mm per tip (' + source + '), cumulative' };
    }
    return null;
  }

  // ── formatting helpers ────────────────────────────────────────────────────────

  function hx(b)   { return b.toString(16).toUpperCase().padStart(2, '0'); }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function hms(sod) {
    if (sod == null) return '—';
    const s = Math.floor(sod);
    return pad2(Math.floor(s / 3600)) + ':' + pad2(Math.floor(s / 60) % 60) + ':' + pad2(s % 60);
  }
  function clockText(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
         + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function isoText(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
         + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  // "12 h 00 m 01 s", for the clock-skew note. Signed, because which way the
  // clock is wrong is the whole point.
  function durText(sec) {
    const neg = sec < 0; let s = Math.round(Math.abs(sec));
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60);   s -= m * 60;
    const bits = [];
    if (h) bits.push(h + ' h');
    if (m) bits.push(m + ' m');
    if (s || !bits.length) bits.push(s + ' s');
    return (neg ? '−' : '') + bits.join(' ');
  }

  const CONF = {
    sole:      { badge: 'ok',   text: 'unique',    note: 'only one station in the database carries this address' },
    pinned:    { badge: 'ok',   text: 'pinned',    note: 'you chose this station for this address' },
    resolved:  { badge: 'ok',   text: 'resolved',  note: 'several stations share this address; the others are far outside this capture\'s area' },
    likely:    { badge: 'warn', text: 'likely',    note: 'several nearby candidates — this one has more of its other addresses in the capture' },
    ambiguous: { badge: 'bad',  text: 'ambiguous', note: 'candidates too close together to choose between — pin one below' },
    unknown:   { badge: 'bad',  text: 'no match',  note: 'no station in the database carries this address' },
  };

  // ── derived views over the parse ──────────────────────────────────────────────

  // The parse is cached against the exact text it came from, so switching views,
  // toggling a scale or pinning a station re-renders without re-reading the
  // capture — but pasting one character does re-read it.
  function current() {
    const a = state.a2;
    const key = a.mode + ' ' + a.text;
    if (!a.parsed || a.parsedKey !== key) {
      a.parsed = a.text.trim() ? parse(a.text, a.mode) : null;
      a.parsedKey = key;
    }
    return a.parsed;
  }

  function rowsFor(p, res) {
    const a = state.a2;
    const rows = [];
    p.frames.forEach(f => {
      if (f.error) return;
      f.records.forEach(r => {
        const info = res.byAlertId.get(r.alertId);
        const st = info && info.chosen ? info.chosen.station : null;
        const kind = info ? info.kind : null;
        if (a.onlyErrors && r.ok && !f.warn.length) return;
        if (a.hideUnknown && !st) return;
        rows.push({ r, f, info, st, kind, key: selKey(st, r.alertId), eng: engValue(kind, r.value, st) });
      });
    });
    return rows;
  }

  // What the table and the map agree to call one thing. A station carries three
  // or four ALERT addresses — rain, level, battery — and is one pin, so clicking
  // it has to light up every row it sent, not just the address that happens to
  // be under the cursor. Addresses that match no station keep their own key so
  // they still select as a unit, they just have nowhere to be drawn.
  function selKey(st, aid) { return st ? 'S' + st.id : 'A' + aid; }

  function stationRollup(p, res) {
    const by = new Map();
    p.frames.forEach(f => {
      if (f.error) return;
      f.records.forEach(r => {
        if (!r.ok) return;
        let e = by.get(r.alertId);
        if (!e) by.set(r.alertId, e = { aid: r.alertId, n: 0, first: null, last: null, min: Infinity, max: -Infinity, lastVal: null, rssi: [] });
        e.n++;
        const sod = f.payload.sod;
        if (e.first === null || sod < e.first) e.first = sod;
        if (e.last === null || sod >= e.last) { e.last = sod; e.lastVal = r.value; }
        e.min = Math.min(e.min, r.value);
        e.max = Math.max(e.max, r.value);
        if (f.hdr.rssi != null) e.rssi.push(f.hdr.rssi);
      });
    });
    return [...by.values()].map(e => {
      const info = res.byAlertId.get(e.aid);
      const st = info && info.chosen ? info.chosen.station : null;
      return Object.assign(e, { info, st, key: selKey(st, e.aid),
                                kind: info ? info.kind : null, eng: engValue(info ? info.kind : null, e.lastVal, st),
                                rssiMed: median(e.rssi), rssiBest: e.rssi.length ? Math.max(...e.rssi) : null,
                                rssiWorst: e.rssi.length ? Math.min(...e.rssi) : null });
    }).sort((x, y) => x.aid - y.aid);
  }

  // ── RSSI ──────────────────────────────────────────────────────────────────────
  //
  // The whole reason the binary format is worth reading. The bands are indicative
  // rather than a specification: the reference capture runs −81 to −114 dBm and
  // an ERT-A2 is usable to about −115, so the scale is laid out over the range a
  // real network actually occupies. It colours the map pins and the table cells,
  // and it is deliberately the same scale in both.
  const RSSI_BANDS = [
    { max: Infinity, min: -90,      color: '#137a3b', label: 'strong',   note: 'above −90 dBm' },
    { max: -90,      min: -100,     color: '#5a9e18', label: 'good',     note: '−90 to −100 dBm' },
    { max: -100,     min: -107,     color: '#c08a12', label: 'fair',     note: '−100 to −107 dBm' },
    { max: -107,     min: -112,     color: '#d4691f', label: 'marginal', note: '−107 to −112 dBm' },
    { max: -112,     min: -Infinity, color: '#b3261e', label: 'weak',    note: 'below −112 dBm' },
  ];
  function rssiBand(v) {
    if (v == null) return null;
    return RSSI_BANDS.find(b => v > b.min && v <= b.max) || RSSI_BANDS[RSSI_BANDS.length - 1];
  }
  function rssiCell(v) {
    if (v == null) return '<span class="spec">—</span>';
    const b = rssiBand(v);
    return '<span class="a2-rssi" style="--rssi:' + b.color + '" title="' + esc(b.label + ' — ' + b.note) + '">'
         + v + '<i>dBm</i></span>';
  }

  // ── rendering: shared bits ────────────────────────────────────────────────────

  function stationCell(info) {
    if (!info) return '<span class="stn none">—</span>';
    if (info.conf === 'unknown') {
      const f = info.fileName;
      return f && !f.none
        ? '<span class="stn">' + esc(f.text) + '</span> <span class="badge warn">address file</span>'
        : '<span class="stn none">no match</span>';
    }
    const c = CONF[info.conf];
    return stationLink(info.chosen.station)
         + (info.conf === 'sole' ? '' : ' <span class="badge ' + c.badge + '" title="' + esc(c.note) + '">' + c.text + '</span>');
  }

  // A named station is a station the operator will want to look at in full —
  // its sensors, its network, its position — and all of that already exists one
  // tab across. goToStation selects the row there, scrolls it into view and
  // pans that map to it, so the name is the shortest path to the rest of what
  // MegaNet knows about the site the reading came from.
  //
  // stopPropagation because these rows are themselves clickable: without it,
  // following the link would also fire the row's own map selection on the way
  // out of a tab that is about to be replaced.
  function stationLink(st) {
    return '<a class="stn a2-stlink" href="javascript:void 0" onclick="event.stopPropagation();goToStation(\''
         + escAttr(st.id) + '\')" title="Open ' + escAttr(st.name) + ' on the Stations tab">'
         + esc(st.name) + '</a>';
  }

  function valueCell(row) {
    const full = row.r.value === FULL_SCALE
      ? ' <span class="badge warn" title="11 bits all set — over-range, or a sensor reading nothing">full scale</span>' : '';
    const eng = row.eng ? '<div class="spec" style="margin-top:2px" title="' + esc(row.eng.rule) + '">' + esc(row.eng.text) + '</div>' : '';
    return '<span class="val">' + row.r.value + '</span>' + full + eng;
  }

  function typeCell(info) {
    if (!info || !info.chosen) return '<span class="spec">—</span>';
    return '<span class="spec">' + esc(info.chosen.types.join(', ') || '—') + '</span>';
  }

  // ── rendering: frame anatomy ──────────────────────────────────────────────────
  //
  // The point of this view: every byte on the wire, coloured by what it means,
  // sitting directly above the reading it produced. The packed byte gets its own
  // bit row because that is the one place the encoding stops being obvious —
  // three bits of data value living in the top of an address byte.

  function fieldChips(f) {
    let html = '<div class="a2-chips">';
    FIELDS.forEach((spec, i) => {
      const v = f.fields[i];
      if (v === undefined) return;
      html += '<span class="a2-chip r-' + spec.role + (spec.sure ? '' : ' unsure') + '" title="'
            + esc(spec.label + (spec.note ? ' — ' + spec.note : '')) + '">'
            + '<b>' + esc(v) + '</b><i>' + esc(spec.label) + '</i></span>';
    });
    html += '</div>';
    return html;
  }

  // The binary frame's equivalent. A TLV stream has no fixed field list to lay
  // out, so this draws what the frame actually contained, in wire order, with
  // the two containers' children indented under them — and the value rendered
  // as whatever its tag says it is rather than as bare hex.
  function tlvChips(f) {
    let html = '<div class="a2-tlv">';
    f.tlv.forEach(e => {
      const spec = e.spec;
      const role = spec ? spec.role : 'bad';
      const label = spec ? spec.label : 'unknown element';
      const note = spec ? spec.note : 'Not an element this decoder has seen; its bytes are shown raw.';
      html += '<div class="a2-tlvrow" style="margin-left:' + (e.depth * 22) + 'px">'
            + '<span class="a2-chip r-' + role + (spec && spec.sure ? '' : ' unsure')
            + '" title="' + esc(label + ' — ' + note) + '"><b>' + e.tag + '</b><i>' + esc(label) + '</i></span>'
            + '<code class="a2-tlvlen">' + e.len + ' B</code>'
            + '<span class="a2-tlvval">' + tlvValue(e) + '</span>'
            + '</div>';
    });
    html += '</div>';
    return html;
  }

  function tlvValue(e) {
    const raw = '<code>' + e.val.map(hx).join(' ') + '</code>';
    const kind = e.spec ? e.spec.kind : null;
    if (kind === 'container') return '<span class="spec">' + e.len + ' bytes of nested elements, below</span>';
    if (kind === 'u8'  && e.len >= 1) return '<b>' + e.val[0] + '</b> ' + raw;
    if (kind === 'u16' && e.len >= 2) return '<b>' + u16(e.val, 0) + '</b> ' + raw;
    if (kind === 'i8'  && e.len >= 1) return rssiCell(i8(e.val[0])) + ' ' + raw;
    if (kind === 'ascii') return '<b>' + esc(String.fromCharCode.apply(null, e.val)) + '</b> ' + raw;
    if (kind === 'mant' && e.len >= 6)
      return '<code>' + e.val.slice(0, 3).map(hx).join(' ') + '</code> <span class="spec">constant</span> · '
           + '<b>' + e.val[3] + '</b> <span class="spec">payload bytes</span> · '
           + '<b>' + u16(e.val, 4) + '</b> <span class="spec">source</span>';
    if (kind === 'buf' && e.len >= 2) {
      const n = u16(e.val, 0);
      const pad = Math.max(0, e.len - 2 - n);
      return '<code>' + e.val.slice(2, 2 + n).map(hx).join(' ') + '</code>'
           + (pad ? ' <span class="spec">+ ' + pad + ' × ' + hx(BIN_FILL) + ' fill</span>' : '');
    }
    if (kind === 'payload') return '<span class="spec">decoded below</span> ' + raw;
    return raw;
  }

  function payloadStrip(f) {
    const p = f.payload;
    const cell = (txt, lbl, cls, attrs) =>
      '<span class="a2-byte ' + cls + '"' + (attrs || '') + '><b>' + esc(txt) + '</b><i>' + esc(lbl) + '</i></span>';
    let html = '<div class="a2-bytes">';
    html += '<span class="a2-bgroup">'
          + cell(hx(p.bytes[0]), 'type', 'r-ident')
          + cell(hx(p.bytes[1]), 'time hi', 'r-time')
          + cell(hx(p.bytes[2]), 'time lo', 'r-time')
          + '</span>';
    f.records.forEach((r, i) => {
      const at = ' data-rec="' + i + '"';
      html += '<span class="a2-bgroup" data-rec="' + i + '">'
            + cell(hx(r.bytes[0]), 'id lo', 'r-addr', at)
            + cell(hx(r.bytes[1]), 'val hi + id hi', 'r-pack', at)
            + cell(hx(r.bytes[2]), 'val lo', 'r-data', at)
            + cell(hx(r.bytes[3]), 'status', r.ok ? 'r-status' : 'r-status bad', at)
            + '</span>';
    });
    const spare = p.body.length % REC_BYTES;
    if (spare) {
      html += '<span class="a2-bgroup">';
      p.bytes.slice(p.bytes.length - spare).forEach(b => { html += cell(hx(b), 'spare', 'r-bad'); });
      html += '</span>';
    }
    html += '</div>';
    return html;
  }

  // byte 1, bit by bit: DDD AAAAA. Reuses the ALERT Packets bit cells so the two
  // tabs draw a packed field the same way.
  function packedBits(b1) {
    let cells = '', labels = '';
    for (let i = 7; i >= 0; i--) {
      const isData = i >= 5;
      cells  += '<div class="bit ' + (isData ? 'f-D' : 'f-A') + '">' + ((b1 >> i) & 1) + '</div>';
      labels += '<span>' + (isData ? 'D' + (i + 3) : 'A' + (i + 8)) + '</span>';
    }
    return '<div class="bitword"><div class="bitrow">' + cells + '</div><div class="lblrow">' + labels + '</div></div>';
  }

  function recordBlock(r, i, res) {
    const info = res.byAlertId.get(r.alertId);
    const st   = info && info.chosen ? info.chosen.station : null;
    const eng = engValue(info ? info.kind : null, r.value, st);
    const [b0, b1, b2, b3] = r.bytes;
    return '<div class="a2-rec' + (r.ok ? '' : ' bad') + '" data-rec="' + i + '">'
      + '<div class="a2-rec-head">Reading ' + (i + 1) + ' <span class="spec">payload bytes ' + r.off + '–' + (r.off + 3)
      + ' · <code>' + r.bytes.map(hx).join(' ') + '</code></span></div>'
      + '<div class="a2-rec-body">'
      +   '<div class="a2-rec-bits">' + packedBits(b1) + '<div class="spec">the packed byte</div></div>'
      +   '<div class="a2-rec-maths">'
      +     '<div><span class="swatch" style="background:var(--c-addr)"></span>ALERT id'
      +       ' <code>(0x' + hx(b1) + ' &amp; 0x1F) &lt;&lt; 8 | 0x' + hx(b0) + '</code> = <span class="val">' + r.alertId + '</span>'
      +       ' &nbsp;' + stationCell(info) + typeCellInline(info) + '</div>'
      +     '<div><span class="swatch" style="background:var(--c-data)"></span>Value'
      +       ' <code>(0x' + hx(b1) + ' &gt;&gt; 5) &lt;&lt; 8 | 0x' + hx(b2) + '</code> = <span class="val">' + r.value + '</span>'
      +       (eng ? ' &nbsp;<b>' + esc(eng.text) + '</b> <span class="spec">(' + esc(eng.rule) + ')</span>' : '')
      +       (r.value === FULL_SCALE ? ' <span class="badge warn">full scale</span>' : '') + '</div>'
      +     '<div><span class="swatch" style="background:var(--c-status)"></span>Status <code>0x' + hx(b3) + '</code> — '
      +       (r.ok ? '<span style="color:var(--ok)">valid</span>' : '<span style="color:var(--bad)">non-zero, treat the reading as corrupt</span>') + '</div>'
      +   '</div>'
      + '</div></div>';
  }

  function typeCellInline(info) {
    if (!info || !info.chosen || !info.chosen.types.length) return '';
    return ' <span class="spec">' + esc(info.chosen.types.join(', ')) + '</span>';
  }

  function frameCard(f, res, open) {
    const badges = [];
    if (f.error)             badges.push('<span class="badge bad">error</span>');
    else if (f.warn.length)  badges.push('<span class="badge warn">' + f.warn.length + ' warning' + (f.warn.length > 1 ? 's' : '') + '</span>');
    else                     badges.push('<span class="badge ok">clean</span>');
    if (f.wrapped) badges.push('<span class="badge warn">re-joined</span>');

    const bin = f.kind === 'bin';
    if (bin) badges.push('<span class="badge ok" title="Read from the binary framing the USB port emits">USB</span>');

    const summary = f.error
      ? esc(f.error)
      : hms(f.payload.sod) + ' · ' + f.records.length + ' reading' + (f.records.length === 1 ? '' : 's')
        + (f.hdr.rssi != null ? ' · ' + f.hdr.rssi + ' dBm' : '')
        + ' · ' + f.records.map(r => r.alertId + ':' + r.value).join('  ');

    let body = '<div class="a2-raw"><code>' + esc(f.raw) + '</code></div>';
    if (f.prefix) {
      // What the terminal put in front of the frame. Shown rather than silently
      // dropped, so it is obvious the line was stripped and not mis-parsed.
      const when = f.prefix.dated ? new Date(f.prefix.ms).toISOString().replace('T', ' ').replace('.000Z', '')
                 : f.prefix.sod != null ? hms(f.prefix.sod) : null;
      body += '<div class="spec">Terminal stamped this line <code>' + esc(f.prefix.text) + '</code>'
            + (when ? ' — read as ' + esc(when) : ' — not recognised as a time, so it was set aside') + '.</div>';
    }
    if (f.warn.length) body += '<ul class="a2-warn">' + f.warn.map(w => '<li>' + esc(w) + '</li>').join('') + '</ul>';
    if (!f.error) {
      if (bin) {
        body += '<h4 class="a2-h">Frame elements</h4>' + tlvChips(f);
        body += '<div class="spec">Tag, length, value — nesting shown by indent. Faded chips are elements that were '
              + 'constant across every frame cross-checked against Ranger, so their meaning is recorded but not established.</div>';
      } else {
        body += '<h4 class="a2-h">Header fields</h4>' + fieldChips(f);
        body += '<div class="spec">Faded chips are fields that were constant across every frame in the reference capture, so their meaning is recorded but not established.</div>';
      }
      body += '<h4 class="a2-h">Payload — ALERT concentration, ' + f.payload.bytes.length + ' bytes</h4>' + payloadStrip(f);
      body += '<div class="spec">Frame time <b>' + hms(f.payload.sod) + '</b> (' + f.payload.sod
            + ' s since midnight, from the two time bytes). '
            + (bin
                ? 'Received at <b>' + (f.hdr.rssi != null ? f.hdr.rssi + ' dBm' : 'an unreported level')
                  + '</b>. This framing carries no receiver clock, so the payload time is the only time in it.'
                : 'ERT-A2 clock <b>' + clockText(f.hdr.clockMs) + '</b>.')
            + '</div>';
      body += f.records.map((r, i) => recordBlock(r, i, res)).join('');
      if (!f.records.length) body += '<p class="spec">No complete readings in this payload.</p>';
    }
    return '<div class="fmtcard' + (open ? ' open' : '') + '">'
      + '<div class="fmthead" onclick="this.parentElement.classList.toggle(\'open\')">'
      + '<h3>' + (bin ? 'Frame ' + (f.seq + 1) : 'Line ' + f.lineNo) + '</h3>' + badges.join(' ')
      + '<span class="caret">' + esc(summary.slice(0, 400)) + ' ▾</span></div>'
      + '<div class="fmtbody">' + body + '</div></div>';
  }

  // ── rendering: panels ─────────────────────────────────────────────────────────

  function statChip(n, label, kind) {
    return '<div class="a2-stat' + (kind ? ' ' + kind : '') + '"><b>' + esc(n) + '</b><span>' + esc(label) + '</span></div>';
  }

  function summaryPanel(p, res) {
    const s = p.stats;
    const rssis = p.frames.filter(f => !f.error && f.hdr.rssi != null).map(f => f.hdr.rssi);
    const chips =
        statChip(s.frames - s.errors, 'frames decoded')
      + statChip(s.records, 'readings')
      + statChip(res.byAlertId.size, 'ALERT addresses')
      + (rssis.length ? statChip(median(rssis) + ' dBm', 'median RSSI') : '')
      + statChip(res.unknown, 'unmatched addresses', res.unknown ? 'warn' : '')
      + statChip(res.ambiguous, 'need a choice', res.ambiguous ? 'warn' : '')
      + statChip(s.errors + s.badRecords, 'errors', (s.errors + s.badRecords) ? 'bad' : '');

    const ingest = [];
    ingest.push(s.mode === 'bin'
      ? 'Read as the <b>binary framing</b> the ERT-A2 emits on USB'
      : 'Read as the <b>ALERT2 ASCII protocol</b> the ERT-A2 writes to its RS232 port');
    if (p.detected === 'auto') ingest.push('detected automatically');
    if (s.banners) ingest.push(s.banners + ' PuTTY session banner' + (s.banners === 1 ? '' : 's') + ' skipped');
    if (s.wrapped) ingest.push(s.wrapped + ' wrapped line' + (s.wrapped === 1 ? '' : 's') + ' re-joined');
    if (s.mode !== 'bin' && s.prefixed) ingest.push(s.prefixed + ' line' + (s.prefixed === 1 ? '' : 's') + ' had a terminal timestamp in front, stripped');
    if (s.ingest) s.ingest.forEach(x => ingest.push(x));
    if (s.junk.length) ingest.push(s.junk.length + ' line' + (s.junk.length === 1 ? '' : 's') + ' ignored (line '
      + s.junk.slice(0, 3).map(j => j.lineNo).join(', ') + (s.junk.length > 3 ? ', …' : '') + ')');
    if (s.errors) ingest.push(s.errors + ' frame' + (s.errors === 1 ? '' : 's') + ' could not be decoded');

    const rssiNote = rssis.length
      ? '<div class="spec">RSSI ranges ' + Math.min(...rssis) + ' to ' + Math.max(...rssis)
        + ' dBm across ' + rssis.length + ' frame' + (rssis.length === 1 ? '' : 's') + '.</div>'
      : (s.mode === 'bin' ? '' : '<div class="spec">This format carries no signal level. To get RSSI against each packet, '
        + 'capture the USB port instead and paste the hex — see the protocol reference above.</div>');

    let clock = '';
    if (s.skew !== null) {
      // A few seconds of scatter is the gap between transmission and the receiver
      // getting the frame out of the port. Anything wider is the clock itself
      // moving, which is a different fault and must not be called latency.
      const steady = s.skewSpread == null || s.skewSpread <= 5;
      const spread = steady
        ? (s.skewSpread ? ' (spread ' + Math.round(s.skewSpread) + ' s, which is receive latency)' : '')
        : ', though it ranges over ' + durText(s.skewSpread) + ' — the offset is not constant, so the clock drifted or was reset part-way through this capture';
      clock = '<div class="note compact" style="margin-top:.8rem">'
        + (Math.abs(s.skew) < 2
            ? 'The ERT-A2 clock <b>agrees</b> with the ALERT2 frame time to within a couple of seconds across '
              + s.skewN + ' frame' + (s.skewN === 1 ? '' : 's') + '.'
            : 'The ERT-A2 header clock reads <b>' + durText(s.skew) + ' '
              + (s.skew > 0 ? 'ahead of' : 'behind') + '</b> the ALERT2 frame time across '
              + s.skewN + ' frame' + (s.skewN === 1 ? '' : 's') + spread + '. '
              + 'The frame time comes from the transmitting network and the header time from the receiver\'s own RTC, '
              + 'so it is the unit\'s clock that needs setting — not the readings.')
        + '</div>';
    }

    const idents = [
      s.decoders.length ? 'decoder address ' + esc(s.decoders.join(', ')) : '',
      s.sources.length  ? 'source address '  + esc(s.sources.join(', '))  : '',
      s.agencies.length ? 'agency '          + esc(s.agencies.join(', ')) : '',
    ].filter(Boolean).join(' · ');
    const span = (s.firstMs && s.lastMs)
      ? '<div class="spec">ERT-A2 clock spans ' + esc(clockText(s.firstMs)) + ' → ' + esc(clockText(s.lastMs)) + '.'
        + (idents ? ' ' + idents.charAt(0).toUpperCase() + idents.slice(1) : '') + '</div>'
      : (idents ? '<div class="spec">' + idents.charAt(0).toUpperCase() + idents.slice(1) + '.</div>' : '');

    const anchors = res.centre
      ? '<div class="spec">Ambiguous addresses were judged against the middle of this capture ('
        + res.centre.lat.toFixed(3) + ', ' + res.centre.lon.toFixed(3) + '), fixed by '
        + res.anchors + ' address' + (res.anchors === 1 ? '' : 'es') + ' that match exactly one station.</div>'
      : (state.data ? '<div class="spec">No address in this capture matches exactly one station, so there is nothing to place it geographically — shared addresses are all reported as ambiguous.</div>' : '');

    return `
      <div class="panel">
        <div class="panel-header"><h3>Capture summary</h3></div>
        <div class="a2-stats">${chips}</div>
        ${ingest.length ? '<div class="spec" style="margin-top:.6rem">' + ingest.join(' · ') + '.</div>' : ''}
        ${rssiNote}
        ${span}
        ${anchors}
        ${clock}
      </div>`;
  }

  // Columns only one of the two formats can fill are dropped when the capture is
  // the other one, rather than drawn as a column of dashes: the ASCII lines have
  // a receiver clock and no RSSI, the binary frames the reverse.
  function cols(p) {
    return {
      clock: p.frames.some(f => !f.error && f.hdr.clockMs),
      rssi:  p.frames.some(f => !f.error && f.hdr.rssi != null),
    };
  }

  // data-key is what ties a row to its pin. Clicking anywhere in the row selects
  // the station — except the station name itself, which is a link out to the
  // Stations tab and stops the event.
  function rowAttrs(key, extra) {
    return ' class="a2-row' + (state.a2.sel === key ? ' sel' : '') + (extra ? ' ' + extra : '') + '"'
         + ' data-key="' + escAttr(key) + '" onclick="Alert2.select(\'' + escAttr(key) + '\')"';
  }

  function readingsView(p, res) {
    const a = state.a2;
    const c = cols(p);
    const rows = rowsFor(p, res);
    const shown = rows.slice(0, a.limit);
    let html = '<div class="a2-tablewrap"><table class="fields a2-table"><thead><tr>'
      + '<th>FRAME TIME</th>' + (c.clock ? '<th>ERT-A2 CLOCK</th>' : '')
      + '<th>ALERT ID</th><th>STATION</th><th>SENSOR</th><th>VALUE</th>'
      + (c.rssi ? '<th>RSSI</th>' : '') + '<th>' + (p.stats.mode === 'bin' ? 'FRAME' : 'LINE') + '</th>'
      + '</tr></thead><tbody>';
    shown.forEach(row => {
      html += '<tr' + rowAttrs(row.key, row.r.ok ? '' : 'a2-badrow') + '>'
        + '<td><code>' + hms(row.f.payload.sod) + '</code></td>'
        + (c.clock ? '<td><span class="spec">' + esc(clockText(row.f.hdr.clockMs)) + '</span></td>' : '')
        + '<td><b>' + row.r.alertId + '</b></td>'
        + '<td>' + stationCell(row.info) + '</td>'
        + '<td>' + typeCell(row.info) + '</td>'
        + '<td>' + valueCell(row) + '</td>'
        + (c.rssi ? '<td>' + rssiCell(row.f.hdr.rssi) + '</td>' : '')
        + '<td><a class="a2-link" onclick="event.stopPropagation();Alert2.openFrame(' + row.f.seq + ')">'
        + (p.stats.mode === 'bin' ? row.f.seq + 1 : row.f.lineNo) + ' ▸</a></td>'
        + '</tr>';
    });
    html += '</tbody></table></div>';
    if (!rows.length) html += '<p class="spec">No readings match the current filters.</p>';
    if (rows.length > shown.length)
      html += '<div style="margin-top:12px"><button class="ghost" onclick="Alert2.more()">Show '
            + Math.min(ROW_STEP, rows.length - shown.length) + ' more</button> '
            + '<span class="spec">showing ' + shown.length + ' of ' + rows.length + ' readings</span></div>';
    return html;
  }

  function stationsView(p, res) {
    const c = cols(p);
    const roll = stationRollup(p, res);
    let html = '<p class="sub">One row per ALERT address heard, newest value last. This is the view that answers '
             + '“is that station still reporting, and what is it saying”'
             + (c.rssi ? ' — and, from the USB capture, how well it is being heard.' : '.') + '</p>'
             + '<div class="a2-tablewrap"><table class="fields a2-table"><thead><tr>'
             + '<th>ALERT ID</th><th>STATION</th><th>SENSOR</th><th>HEARD</th><th>FIRST → LAST</th><th>RANGE</th><th>LATEST</th>'
             + (c.rssi ? '<th>RSSI MEDIAN</th><th>BEST / WORST</th>' : '')
             + '</tr></thead><tbody>';
    roll.forEach(e => {
      html += '<tr' + rowAttrs(e.key) + '>'
        + '<td><b>' + e.aid + '</b></td>'
        + '<td>' + stationCell(e.info) + '</td>'
        + '<td>' + typeCell(e.info) + '</td>'
        + '<td>' + e.n + '</td>'
        + '<td><code>' + hms(e.first) + '</code> → <code>' + hms(e.last) + '</code></td>'
        + '<td><span class="spec">' + e.min + ' – ' + e.max + '</span></td>'
        + '<td><span class="val">' + e.lastVal + '</span>'
        + (e.eng ? ' <span class="spec">' + esc(e.eng.text) + '</span>' : '') + '</td>'
        + (c.rssi ? '<td>' + rssiCell(e.rssiMed) + '</td>'
                  + '<td><span class="spec">' + (e.rssiBest == null ? '—' : e.rssiBest + ' / ' + e.rssiWorst) + '</span></td>' : '')
        + '</tr>';
    });
    html += '</tbody></table></div>';
    if (!roll.length) html += '<p class="spec">No valid readings in this capture.</p>';
    return html;
  }

  function framesView(p, res) {
    const a = state.a2;
    const list = a.onlyErrors ? p.frames.filter(f => f.error || f.warn.length) : p.frames;
    const shown = list.slice(0, Math.max(1, Math.floor(a.limit / 4)));
    let html = '<p class="sub">Every byte of a frame, coloured by meaning, above the readings it produced. '
             + 'Click a line to open it.</p>';
    html += shown.map(f => frameCard(f, res, f.seq === a.frameIdx)).join('');
    if (!list.length) html += '<p class="spec">No frames match the current filter.</p>';
    if (list.length > shown.length)
      html += '<div style="margin-top:12px"><button class="ghost" onclick="Alert2.more()">Show more</button> '
            + '<span class="spec">showing ' + shown.length + ' of ' + list.length + ' frames</span></div>';
    return html;
  }

  function ambiguityPanel(res) {
    const rows = [...res.byAlertId.values()].filter(r => r.conf === 'ambiguous' || r.conf === 'likely');
    if (!rows.length) return '';
    let html = `
      <div class="panel">
        <div class="panel-header"><h3>Addresses that need a choice <span class="badge warn">${rows.length}</span></h3></div>
        <p class="sub">These ALERT addresses belong to more than one station in the database, and the candidates are
          close enough together that the capture cannot separate them. Pick the right one and it applies to every
          reading on this address for the rest of the capture.</p>`;
    rows.forEach(r => {
      html += '<div class="a2-ambig"><div class="a2-ambig-id">' + r.aid
            + ' <span class="spec">' + r.count + ' reading' + (r.count === 1 ? '' : 's') + '</span></div><div>';
      // Candidates can share a name as well as an address — the database holds
      // more than one pair of same-named records — so the station number goes on
      // the button too. Two identical buttons would be no choice at all.
      const sameName = new Set(r.cands.map(c => c.station.name)).size < r.cands.length;
      r.cands.forEach(c => {
        const on = r.chosen === c;
        const num = c.station.station_number;
        html += '<button class="ghost' + (on ? ' on' : '') + '" onclick="Alert2.pick(' + r.aid + ',\'' + escAttr(c.station.id) + '\')">'
          + esc(c.station.name) + (sameName && num ? ' <small>· ' + esc(num) + '</small>' : '') + '</button>'
          + '<span class="spec"> ' + (c.distKm == null ? 'no coordinates' : Math.round(c.distKm) + ' km from this capture')
          + (!sameName && num ? ' · ' + esc(num) : '')
          + ' · ' + c.siblings + '/' + c.siblingsTotal + ' of its other addresses heard'
          + (c.types.length ? ' · ' + esc(c.types.join(', ')) : '') + '</span><br>';
      });
      html += '</div></div>';
    });
    if (Object.keys(state.a2.picks).length)
      html += '<div style="margin-top:10px"><button class="ghost" onclick="Alert2.clearPicks()">Clear all pinned choices</button></div>';
    html += '</div>';
    return html;
  }

  // ── rendering: coverage map ───────────────────────────────────────────────────
  //
  // What a capture is really telling you is who this receiver can hear, and that
  // is a geographic question. One pin per station heard, sized by how much it
  // sent and — on a USB capture — coloured by how well it came in, which turns a
  // list of readings into a picture of the receiver's coverage.
  //
  // The pins and the table are one selection, not two: clicking a pin lights up
  // every row that station sent, and clicking a row lights up its pin. A station
  // carries several ALERT addresses, so the two only line up if they agree on
  // the station being the unit — which is what selKey settles.

  function mapPoints(p, res) {
    const by = new Map();
    p.frames.forEach(f => {
      if (f.error) return;
      f.records.forEach(r => {
        if (!r.ok) return;
        const info = res.byAlertId.get(r.alertId);
        const st = info && info.chosen ? info.chosen.station : null;
        if (!st || st.lat == null || st.lon == null) return;
        let e = by.get(st.id);
        if (!e) by.set(st.id, e = { st, key: selKey(st, r.alertId), aids: new Set(), n: 0, rssi: [], conf: info.conf });
        e.aids.add(r.alertId);
        e.n++;
        if (f.hdr.rssi != null) e.rssi.push(f.hdr.rssi);
      });
    });
    return [...by.values()].map(e => Object.assign(e, {
      rssiMed:   median(e.rssi),
      rssiBest:  e.rssi.length ? Math.max(...e.rssi) : null,
      rssiWorst: e.rssi.length ? Math.min(...e.rssi) : null,
    }));
  }

  function mapPanel(p, res) {
    if (!state.data) return `
      <div class="panel">
        <div class="panel-header"><h3>Where these packets came from</h3></div>
        <div class="note compact">No station file loaded, so there is nothing to put on a map. Load <b>stations.json</b> from the header.</div>
      </div>`;
    const pts = mapPoints(p, res);
    const withRssi = pts.filter(e => e.rssiMed != null).length;
    // Addresses, not stations. A station carries three or four of them, so
    // counting pins against addresses reports the difference as missing.
    const unplaced = [...res.byAlertId.values()]
      .filter(r => !r.chosen || r.chosen.station.lat == null || r.chosen.station.lon == null).length;

    const legend = withRssi
      ? '<div class="a2-legend"><span class="spec">Pin colour — RSSI</span>'
        + RSSI_BANDS.map(b => '<span class="a2-lkey" title="' + esc(b.note) + '"><i style="background:' + b.color + '"></i>' + esc(b.label) + '</span>').join('')
        + '<span class="spec">bands are indicative; pin size is how many readings the station sent</span></div>'
      : '<div class="a2-legend"><span class="spec">Pin size is how many readings the station sent. '
        + 'Paste a USB capture instead and the pins colour by RSSI.</span></div>';

    return `
      <div class="panel">
        <div class="panel-header"><h3>Where these packets came from <span class="badge ok">${pts.length} station${pts.length === 1 ? '' : 's'}</span></h3></div>
        <p class="sub">Every station this receiver heard in the capture. Click a pin to light up its readings in the
          table below; click a reading and its pin lights up here. The station name in either place opens it on the
          <a href="javascript:void 0" onclick="switchTab('stations')">Stations</a> tab.</p>
        <div id="a2-map" class="a2-map"></div>
        ${legend}
        ${pts.length ? '' : '<div class="note compact">None of the addresses in this capture resolved to a station with coordinates, so there is nothing to draw yet.</div>'}
        ${unplaced > 0 && pts.length ? '<div class="spec">' + unplaced + ' address' + (unplaced === 1 ? '' : 'es') + ' in this capture could not be placed — unmatched, ambiguous, or a station with no coordinates on file.</div>' : ''}
      </div>`;
  }

  function initCoverageMap(p, res) {
    stopMap();
    const el = document.getElementById('a2-map');
    if (!el || !state.data || typeof L === 'undefined' || !p || !res) return;
    const a = state.a2;
    const pts = mapPoints(p, res);

    // SVG, not canvas. The big Stations map needs the canvas renderer for its
    // 3,000-odd pins; a capture holds tens, and SVG gives each one a real DOM
    // node — which is what makes bringToFront on a selection safe. The canvas
    // renderer defers that to an animation frame, and a frame that lands after
    // the tab has been left is drawing into a context the removed map took with
    // it.
    const map = a.map = L.map('a2-map');
    // A view before any layer is added: Leaflet defers layer adds until the map
    // has one, and a deferred add can otherwise run against a renderer that has
    // not been set up. Replaced by the fit below on the same tick.
    map.setView(MAP_HOME, 4);
    addBaseLayers(map);
    a.mapLayer = L.layerGroup().addTo(map);
    a.mapMarks = new Map();

    const most = Math.max(1, ...pts.map(e => e.n));
    pts.forEach(e => {
      const band = rssiBand(e.rssiMed);
      const m = L.circleMarker([e.st.lat, e.st.lon], {
        radius: 5 + 5 * Math.sqrt(e.n / most),
        color: '#fff', weight: 1.5,
        fillColor: band ? band.color : '#5a6b7d', fillOpacity: .85,
      });
      m.a2Key = e.key;
      m.a2Base = { fill: band ? band.color : '#5a6b7d' };
      m.bindPopup(mapPopup(e));
      m.on('click', () => select(e.key, 'map'));
      m.addTo(a.mapLayer);
      a.mapMarks.set(e.key, m);
    });

    if (pts.length) {
      const b = L.latLngBounds(pts.map(e => [e.st.lat, e.st.lon]));
      // A single pin has no extent to fit, and fitBounds on a degenerate box
      // zooms to the tile server's limit.
      if (pts.length === 1) map.setView(b.getCenter(), 11);
      else map.fitBounds(b.pad(0.15));
    }
    // A filter or a scale change re-renders the tab, which throws the map away
    // and builds this one. Restoring the last view means the operator does not
    // lose their pan every time they tick a box.
    if (a.mapView) map.setView(a.mapView.center, a.mapView.zoom);
    map.on('moveend zoomend', () => { a.mapView = { center: map.getCenter(), zoom: map.getZoom() }; });
    setTimeout(() => { try { map.invalidateSize(); } catch (_) {} }, 0);
    applySelection();
  }

  function mapPopup(e) {
    const ids = [...e.aids].sort((x, y) => x - y).join(', ');
    return '<b>' + esc(e.st.name) + '</b>'
      + (e.st.station_number ? '<br><span class="spec">' + esc(e.st.station_number) + '</span>' : '')
      + '<br>' + e.n + ' reading' + (e.n === 1 ? '' : 's') + ' on address' + (e.aids.size === 1 ? ' ' : 'es ') + ids
      + (e.rssiMed != null
          ? '<br>RSSI <b>' + e.rssiMed + ' dBm</b> median, ' + e.rssiBest + ' best / ' + e.rssiWorst + ' worst'
          : '')
      + '<br><a href="javascript:void 0" onclick="goToStation(\'' + escAttr(e.st.id) + '\')">Open on the Stations tab →</a>';
  }

  function stopMap() {
    const a = state.a2;
    if (a.map) { try { a.map.remove(); } catch (_) {} }
    a.map = null; a.mapLayer = null; a.mapMarks = null;
  }

  // Selection is a highlight, not a filter, so it never re-renders: the rows and
  // the markers already exist and only their styling changes. Re-rendering here
  // would rebuild the map — and lose the pan, the popup and the click that
  // caused it — for something CSS can do.
  function applySelection() {
    const a = state.a2;
    document.querySelectorAll('#a2-view tr.a2-row').forEach(tr => {
      tr.classList.toggle('sel', a.sel != null && tr.dataset.key === a.sel);
    });
    if (a.mapMarks) a.mapMarks.forEach((m, key) => {
      const on = key === a.sel;
      m.setStyle({ color: on ? '#111' : '#fff', weight: on ? 3 : 1.5, fillOpacity: on ? 1 : .85 });
      if (on) m.bringToFront();
    });
  }

  function select(key, from) {
    const a = state.a2;
    a.sel = (a.sel === key) ? null : key;
    applySelection();
    if (a.sel == null) return;
    if (from === 'map') {
      const row = document.querySelector('#a2-view tr.a2-row.sel');
      if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      const m = a.mapMarks && a.mapMarks.get(a.sel);
      if (m && a.map) {
        // Pan only if the pin is off-screen, and never change the zoom. The map
        // opens fitted to the whole capture, which is the view worth keeping —
        // zooming to a pin every time a row is clicked throws that away and
        // leaves the operator re-orienting after each click.
        if (a.map.panInside) a.map.panInside(m.getLatLng(), { padding: [40, 40] });
        else a.map.panTo(m.getLatLng());
        m.openPopup();
      }
    }
  }

  // ── reference ─────────────────────────────────────────────────────────────────

  function referencePanel() {
    const rows = FIELDS.map((spec, i) => '<tr>'
      + '<td><b>' + (i + 1) + '</b></td>'
      + '<td><span class="swatch" style="background:var(--c-' + ROLE_VAR[spec.role] + ')"></span>' + esc(spec.label) + '</td>'
      + '<td>' + (spec.sure ? '<span class="badge ok">established</span>' : '<span class="badge warn">constant only</span>') + '</td>'
      + '<td class="spec">' + esc(spec.note || '') + '</td></tr>').join('');
    const binRows = BIN_ORDER.map(([tag, depth]) => {
      const spec = BIN_TAGS[tag];
      return '<tr>'
        + '<td style="padding-left:' + (6 + depth * 18) + 'px"><code>' + tag + '</code></td>'
        + '<td><span class="swatch" style="background:' + (spec.role === 'rssi' ? 'var(--ok)' : 'var(--c-' + ROLE_VAR[spec.role] + ')') + '"></span>' + esc(spec.label) + '</td>'
        + '<td>' + (spec.sure ? '<span class="badge ok">established</span>' : '<span class="badge warn">constant only</span>') + '</td>'
        + '<td class="spec">' + esc(spec.note || '') + '</td></tr>';
    }).join('');

    return `
      <div class="panel">
        <div class="panel-header"><h3>Two ways in — and which one has the RSSI</h3></div>
        <p class="sub">An ERT-A2 emits two different things on two different ports, and they do not carry the same
          information. This tab reads both; paste either and it works out which it is looking at.</p>

        <div class="a2-methods">
          <div class="a2-method">
            <h4>1 · ALERT2 ASCII protocol <span class="badge">secondary RS232 port</span></h4>
            <p class="spec">One comma-delimited line per received frame: the tag <code>ALERT2A</code>, 23 more
              fixed fields of receiver metadata — including the unit's own real-time clock — then the frame payload
              as hex bytes, one field per byte.</p>
            <div class="a2-raw"><code>ALERT2A,1,9999,ELPRO,N,1,2026,6,8,19,10,41.296,0,0,0,0,0,1,0,0,0,7,7,9999,74,64,F0,7E,18,15,00</code></div>
            <ul class="pkt-cheat">
              <li><b>Gives you</b> the receiver's clock, so a frame can be dated as well as timed, and a line that
                reads as text in any terminal.</li>
              <li><b>Does not give you RSSI.</b> None of the 24 fields is a signal level; field 22 is a reception
                quality that read 7 on every good frame in a 444-frame capture and 1 on the bad one, which is a
                health flag, not a measurement in dBm.</li>
              <li><b>Capture it with</b> PuTTY or any terminal on the RS232 port, and paste or load the log.</li>
            </ul>
          </div>
          <div class="a2-method">
            <h4>2 · ELPRO binary framing <span class="badge ok">USB port</span></h4>
            <p class="spec">What Ranger's own <em>Serial Data</em> pane shows when it is connected over USB: the
              ASCII word <code>ALERT2</code> as six bytes, a length, then tag/length/value elements — and one of
              those elements is the RSSI.</p>
            <div class="a2-raw"><code>41 4C 45 52 54 32 4D 75 01 01 18 02 27 0F 77 05 45 4C 50 52 4F …  9C 2F 01 94</code></div>
            <ul class="pkt-cheat">
              <li><b>Gives you RSSI</b> — element <code>9C2F</code>, one signed byte, dBm. <code>94</code> above is
                −108 dBm.</li>
              <li><b>Does not give you the receiver's clock.</b> There is no date or time of day in the framing at
                all; Ranger stamps its own display from the PC. The only time in a binary capture is the payload's
                own seconds-since-midnight.</li>
              <li><b>Capture it with</b> a terminal on the USB port, or by copying the hex straight out of Ranger's
                Serial Data pane. Paste it here — space-delimited, run together, wrapped mid-frame, it does not
                matter, because the frames are found by the <code>ALERT2</code> sync rather than by the line breaks.</li>
            </ul>
          </div>
        </div>

        <div class="note compact">
          <b>Is Ranger asking for this?</b> The capture is receive-only, so it shows what the USB port emits and
          not what, if anything, Ranger sent to turn it on. Nothing was needed to read it back — a terminal on the
          USB port produces these frames — so the working answer is that the two ports simply speak different
          protocols, and the USB one is the richer of the two. If a unit is ever found emitting nothing on USB
          until spoken to, that is the thing to revisit.
        </div>

        <details>
          <summary class="pkt-summary">Method 1 — ALERT2 ASCII protocol, field reference</summary>

          <p class="spec">Every line is <code>ALERT2A</code>, 23 more fixed fields, then the frame payload as
            hex bytes — one field per byte. Field 23 gives the payload length, which is what distinguishes a
            complete line from one the terminal wrapped or cut short.</p>

          <div class="a2-tablewrap"><table class="fields a2-table"><thead><tr>
            <th>#</th><th>FIELD</th><th>CONFIDENCE</th><th>NOTES</th>
          </tr></thead><tbody>${rows}</tbody></table></div>
        </details>

        <details>
          <summary class="pkt-summary">Method 2 — ELPRO binary framing, element reference</summary>

          <p class="spec">Six ASCII bytes <code>41 4C 45 52 54 32</code> (“ALERT2”) sync the frame, one byte gives
            the length of everything that follows, and the rest is tag / length / value. A tag byte with its top
            bit set is the first of a two-byte tag; otherwise the tag is that single byte. Length is always one
            byte. Two elements are containers whose value is more elements — shown indented below.</p>

          <div class="a2-tablewrap"><table class="fields a2-table"><thead><tr>
            <th>TAG</th><th>ELEMENT</th><th>CONFIDENCE</th><th>NOTES</th>
          </tr></thead><tbody>${binRows}</tbody></table></div>

          <h4 class="a2-h">The same PDU, twice</h4>
          <p class="spec">Element <code>15</code> holds the air-link PDU as it landed — a two-byte length, the PDU,
            then <code>A1</code> fill out to a fixed 24-byte buffer. Element <code>14</code> holds the same bytes
            split into a six-byte MANT header and the payload, with the RSSI appended. Both copies were
            byte-identical on every frame checked, so the decoder reads the split one and reports it when they
            disagree, rather than silently preferring one.</p>

          <h4 class="a2-h">Reading the RSSI by hand</h4>
          <p class="spec">The last four bytes of a frame are almost always <code>9C 2F 01 xx</code>: tag
            <code>9C2F</code>, length 1, then the value. Read <code>xx</code> as a signed byte —
            <code>94</code> → −108, <code>8E</code> → −114, <code>A8</code> → −88. Every value in the two reference
            captures fell between −81 and −114 dBm, which is the range a VHF receiver at the edge of its
            sensitivity actually works over.</p>

          <h4 class="a2-h">How this was established</h4>
          <p class="spec">44 binary frames from Ranger's Serial Data pane were decoded here and compared line for
            line against Ranger's own decode of the same 44 packets. Source address, agency, frame time, every
            ALERT address, every value and every RSSI matched on all 44 — including the multi-reading frames,
            where Ranger lists the readings in a different order. A second capture of 78 frames then parsed to the
            same structure with every byte accounted for: no leftover bytes between frames, no element the decoder
            did not recognise, and nothing it had to warn about. Elements that were constant across all of them are
            marked “constant only” rather than guessed at.</p>
        </details>

        <details>
          <summary class="pkt-summary">Shared by both — the payload, and what the readings mean</summary>

          <h4 class="a2-h">Payload — ALERT concentration</h4>
          <ul class="pkt-cheat">
            <li>Byte 1 — <b>0x74</b>, the element type. Every frame observed carried this one; ELPRO's Ranger
              labels the same traffic <em>ALERT (Conc)</em>. Any other value is reported rather than guessed at.</li>
            <li>Bytes 2–3 — <b>seconds since midnight</b>, big-endian, of the originating ALERT2 frame. Checked
              against Ranger's own “Received:” column, which matched to the second on every frame compared.
              Sixteen bits only reach 18:12:15, so a frame later in the day must carry the time some other way;
              the reference capture ends before that and cannot say how.</li>
            <li>Bytes 4 on — <b>four bytes per reading</b>, repeated to the end of the payload. A frame carries
              one to four readings, usually the rainfall, water level and battery of one field station.</li>
          </ul>

          <h4 class="a2-h">One reading, four bytes</h4>
          <ul class="pkt-cheat">
            <li><code>byte 0</code> — ALERT address, low 8 bits.</li>
            <li><code>byte 1</code> — <code>DDDAAAAA</code>: value bits 10–8 on top, address bits 12–8 below.
              This is the only part of the encoding that is not obvious by eye — a byte that looks like part of
              the address is carrying the top of the value as well.</li>
            <li><code>byte 2</code> — value, low 8 bits.</li>
            <li><code>byte 3</code> — status. 0 on all 541 valid readings in the reference capture; the four
              non-zero ones sat in the single frame the receiver had already flagged bad, and decoded to
              addresses no station has.</li>
            <li>So address is 13 bits (0–8191) and value 11 bits (0–2047) — the same widths a legacy ALERT
              sensor transmits, which is why the ALERT Packets tab decodes one of these records to the same
              id and value under its <b>A2C</b> layout.</li>
          </ul>

          <h4 class="a2-h">How this was established</h4>
          <p class="spec">A 444-frame capture from a test ERT-A2 was decoded and compared against the same
            traffic decoded by ELPRO's Ranger software. All 444 payload lengths matched the field count; every
            payload after the three-byte header was a whole number of four-byte records; addresses and values
            matched Ranger's decoded output record for record, including multi-reading frames; and the payload
            times matched Ranger's received times exactly. 339 of the 348 addresses heard matched a station in
            MegaNet. Fields with no such evidence behind them are marked “constant only” above, and the
            engineering scales below are interpretations, not part of the protocol.</p>

          <h4 class="a2-h">Engineering values</h4>

          <ul class="pkt-cheat">
            <li><b>Battery</b> — raw ÷ 10 volts. 213 battery readings in the reference capture fell between 130
              and 142, which is 13.0–14.2 V and nothing else plausible.</li>
            <li><b>Rainfall</b> — a cumulative tip count, ×&nbsp;mm per tip. Counts step up one at a time
              in the capture, which is a tipping bucket; the millimetres per tip is a site configuration
              (<code>TBRGbucketSize</code>) and wins when the address resolves to a station that carries
              one. Otherwise it falls back to the input below, 0.2&nbsp;mm by default — either way the
              value shown says whether it was recorded for that site or assumed.</li>
            <li><b>Water level</b> — left as raw counts. The scale is set per site and nothing in the capture
              reveals it, so no conversion is offered.</li>
            <li><b>2047</b> on any sensor is all eleven bits set: over-range, or a sensor reading nothing.</li>
          </ul>
        </details>

        <details>
          <summary class="pkt-summary">Getting the capture out of the ERT-A2</summary>

          <p class="spec">Web Serial would let this page read the unit directly, and is the point this tool is
            building towards — everything below is the interim, and the traffic it decodes is the argument for
            opening that up.</p>

          <h4 class="a2-h">Pasting</h4>
          <p class="spec">Either format goes straight into the box: an ASCII log as it comes out of PuTTY, or hex
            copied out of Ranger's Serial Data pane. The hex ingest strips a bracketed timestamp or a hex-dump
            offset column off the front of each line first — their digits are hex too, and would otherwise be read
            as data — then treats everything left as one byte stream and finds the frames by their sync word. That
            is what makes Ranger's pane usable directly: it wraps at whatever width the window happens to be, and
            here that does not matter.</p>

          <h4 class="a2-h">Loading a file</h4>
          <p class="spec"><b>Choose log file…</b> works in every browser and reads the file once, as it stood at
            that moment. UTF-16 logs are detected by their byte-order mark rather than assumed away.</p>

          <h4 class="a2-h">Watching a file</h4>
          <p class="spec">PuTTY writes its session log continuously (Session → Logging has <em>Flush log file
            frequently</em> on by default, so the file is not held back until the session closes). On a Chromium
            browser the <b>Watch</b> button uses the File System Access API to re-open that same file on a timer,
            which gives a log that keeps up with the unit without a serial port being involved. It needs Chrome or
            Edge over https or localhost, and it is a common thing for a managed machine to have switched off by
            policy — if that is what has happened the button now says so instead of doing nothing.</p>
        </details>
      </div>`;
  }

  const ROLE_VAR = { ident: 'ident', addr: 'addr', time: 'time', status: 'status', len: 'hd' };

  // ── sample ────────────────────────────────────────────────────────────────────
  // Real lines from a test ERT-A2, chosen to exercise every ingest path: plain
  // frames, a multi-reading frame, a line the terminal wrapped, a PuTTY banner
  // dropped mid-capture, a line carrying a terminal timestamp, the one corrupt
  // frame from the reference capture, and a line cut off at the end of the log.
  const SAMPLE = [
    'ALERT2A,1,9999,ELPRO,N,1,2026,6,8,19,10,41.296,0,0,0,0,0,1,0,0,0,7,7,9999,74,64,F0,7E,18,15,00',
    'ALERT2A,1,9999,ELPRO,N,1,2026,6,8,19,28,32.582,0,0,0,0,0,1,0,0,0,7,11,9999,74,69,20,2D,13,8A,00,2C,13,0C,00',
    // The same 15-byte frame a narrow terminal window folds in two. Nothing in
    // the protocol wraps: this is the terminal, and the tail has to be sewn back
    // on or the frame reads as one truncated line and one line of noise.
    'ALERT2A,1,9999,ELPRO,N,1,2026,6,8,19,29,46.068,0,0,0,0,0,1,0,0,0,7,15,9999,74,69,69,1F,08,89,00,1D,08,39,00',
    ',1E,08,02,00',
    '[2026-06-08 19:39:43.586] ALERT2A,1,9999,ELPRO,N,1,2026,6,8,19,39,43.586,0,0,0,0,0,1,0,0,0,7,15,9999,74,6B,BE,65,08,86,00,66,C8,2F,00,69,08,00,00',
    'ALERT2A,1,9999,ELPRO,N,1,2026,6,8,20,19,13.761,0,0,0,0,0,1,0,0,0,7,11,9999,74,75,00,B5,08,84,00,24,08,08,00',
    // The one frame in 444 the receiver flagged bad: field 18 reads 0, field 22
    // drops to 1, and every reading in it carries a non-zero status byte.
    'ALERT2A,1,9999,ELPRO,N,1,2026,6,8,20,51,10.161,0,0,0,0,0,0,0,0,0,1,19,9999,74,7C,7E,01,0E,08,11,81,07,23,FF,FB,21,00,14,00,00,00,08',
    'A=~=~=~=~=~=~=~=~=~=~=~= PuTTY log 2026.08.10 14:35:06 =~=~=~=~=~=~=~=~=~=~=~=',
    'ALERT2A,1,9999,ELPRO,N,1,2026,6,8,21,14,57.981,0,0,0,0,0,1,0,0,0,7,7,9999,74,86,1C,0E,10,0A,00',
    'ALERT2A,1,9999,ELPRO,N,1,2026,6,8,22,15,20.039,0,0,0,0,0,1,0,0,0,7,7,9',
  ].join('\n');

  // The same unit's USB port, in the binary framing — real frames from the
  // Ranger capture these were decoded against, so the RSSI figures are the ones
  // Ranger reported for them. Chosen to exercise the hex ingest as well: one,
  // two and three-reading frames, a frame the pane wrapped mid-way, a line
  // carrying a terminal timestamp in front of the hex, and a capture that stops
  // part-way through a frame.
  const SAMPLE_BIN = [
    '41 4C 45 52 54 32 4D 75 01 01 18 02 27 0F 77 05 45 4C 50 52 4F 15 24 84 10 02 00 0D 84 11 18 00 0D 00 10 70 07 27 0F 74 86 1C 0E 10 0A 00 A1 A1 A1 A1 A1 A1 A1 A1 A1 84 12 01 00 14 17 84 00 06 00 10 70 07 27 0F 84 01 07 74 86 1C 0E 10 0A 00 9C 2F 01 94',
    '41 4C 45 52 54 32 51 75 01 01 18 02 27 0F 77 05 45 4C 50 52 4F 15 24 84 10 02 00 11 84 11 18 00 11 00 10 70 0B 27 0F 74 86 6F DF 92 41 00 CE 12 00 00 A1 A1 A1 A1 A1 84 12 01 00 14 1B 84 00 06 00 10 70 0B 27 0F 84 01 0B 74 86 6F DF 92 41 00 CE 12 00 00 9C 2F 01 8E',
    '41 4C 45 52 54 32 51 75 01 01 18 02 27 0F 77 05 45 4C 50 52 4F 15 24 84 10 02 00 11 84 11 18 00 11 00 10 70 0B 27 0F 74 86 AF 87 09 8C 00 86 29 5B 00 A1 A1 A1 A1 A1 84 12 01 00 14 1B 84 00 06 00 10 70 0B 27 0F 84 01 0B 74 86 AF 87 09 8C 00 86 29 5B 00 9C 2F 01 93',
    // Ranger's Serial Data pane wraps at the width of the window, so a frame is
    // routinely cut in half like this. Nothing has to sew it back together: the
    // sync word and the length byte find the frame, and the line break is noise.
    '41 4C 45 52 54 32 4D 75 01 01 18 02 27 0F 77 05 45 4C 50 52 4F 15 24 84 10 02 00 0D 84 11 18 00 0D 00 10 70 07 27 0F 74 86 E8',
    '9A 15 06 00 A1 A1 A1 A1 A1 A1 A1 A1 A1 84 12 01 00 14 17 84 00 06 00 10 70 07 27 0F 84 01 07 74 86 E8 9A 15 06 00 9C 2F 01 98',
    '41 4C 45 52 54 32 4D 75 01 01 18 02 27 0F 77 05 45 4C 50 52 4F 15 24 84 10 02 00 0D 84 11 18 00 0D 00 10 70 07 27 0F 74 87 17 98 88 5A 00 A1 A1 A1 A1 A1 A1 A1 A1 A1 84 12 01 00 14 17 84 00 06 00 10 70 07 27 0F 84 01 07 74 87 17 98 88 5A 00 9C 2F 01 97',
    '41 4C 45 52 54 32 55 75 01 01 18 02 27 0F 77 05 45 4C 50 52 4F 15 24 84 10 02 00 15 84 11 18 00 15 00 10 70 0F 27 0F 74 87 DF 65 08 8B 00 66 C8 2F 00 69 08 00 00 A1 84 12 01 00 14 1F 84 00 06 00 10 70 0F 27 0F 84 01 0F 74 87 DF 65 08 8B 00 66 C8 2F 00 69 08 00 00 9C 2F 01 95',
    // The digits in that timestamp are all valid hex. Stripped as a prefix, not
    // read as bytes — which is the whole reason the ingest looks at lines at all.
    '[2026-08-10 14:45:09] 41 4C 45 52 54 32 4D 75 01 01 18 02 27 0F 77 05 45 4C 50 52 4F 15 24 84 10 02 00 0D 84 11 18 00 0D 00 10 70 07 27 0F 74 88 08 25 10 0B 00 A1 A1 A1 A1 A1 A1 A1 A1 A1 84 12 01 00 14 17 84 00 06 00 10 70 07 27 0F 84 01 07 74 88 08 25 10 0B 00 9C 2F 01 93',
    '41 4C 45 52 54 32 4D 75 01 01 18 02 27 0F 77 05 45 4C 50 52 4F 15 24 84 10 02 00 0D 84 11 18 00 0D 00 10 70 07 27 0F 74 89 34 CD 14 8C 00 A1 A1 A1 A1 A1 A1 A1 A1 A1 84 12 01 00 14 17 84 00 06 00 10 70 07 27 0F 84 01 07 74 89 34 CD 14 8C 00 9C 2F 01 95',
    '41 4C 45 52 54 32 4D 75 01 01 18 02 27 0F 77 05 45 4C 50 52',
  ].join('\n');

  // ── rendering: the tab ────────────────────────────────────────────────────────

  const ROW_STEP = 400;
  const canWatch = typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function';

  function inputPanel() {
    const a = state.a2;
    const w = a.watch;
    return `
      <div class="panel">
        <div class="panel-header"><h3>Capture</h3></div>
        <p class="sub">Two things can go in here. Paste an <b>ALERT2 ASCII log</b> from the RS232 port —
          session banners, wrapped lines and terminal timestamps are all handled, so paste it as it comes. Or paste
          the <b>hex from the USB port</b>, straight out of Ranger's Serial Data pane or any terminal: that one
          carries the RSSI. Either way, pick a file instead if that is easier.</p>
        <div class="a2-modes">
          <span class="spec">Read as</span>
          ${modeBtn('auto', 'Auto-detect', 'Look at the capture and decide — right for anything pasted whole')}
          ${modeBtn('ascii', 'ALERT2A ASCII', 'The comma-delimited protocol on the secondary RS232 port')}
          ${modeBtn('bin', 'USB hex', 'The binary framing the USB port emits — the one with RSSI in it')}
        </div>
        <textarea id="a2-text" class="a2-input" spellcheck="false" rows="7"
                  placeholder="ALERT2A,1,9999,ELPRO,N,1,2026,6,8,19,10,41.296,0,0,0,0,0,1,0,0,0,7,7,9999,74,64,F0,7E,18,15,00&#10;41 4C 45 52 54 32 4D 75 01 01 18 02 27 0F 77 05 45 4C 50 52 4F …"
                  oninput="state.a2.text=this.value">${esc(a.text)}</textarea>
        <div class="row" style="margin-top:12px">
          <div class="fit"><button class="primary" onclick="Alert2.decode()">Decode</button></div>
          <div class="fit"><button class="ghost" onclick="Alert2.chooseFile()">Choose log file…</button></div>
          ${canWatch ? '<div class="fit"><button class="ghost" onclick="Alert2.' + (w ? 'stopWatching()">Stop watching ' + esc(w.name) : 'watchFile()">Watch a log file…') + '</button></div>' : ''}
          <div class="fit"><button class="ghost" onclick="Alert2.loadSample('ascii')">Sample — RS232 ASCII</button></div>
          <div class="fit"><button class="ghost" onclick="Alert2.loadSample('bin')">Sample — USB hex</button></div>
          <div class="fit"><button class="ghost" onclick="Alert2.clear()">Clear</button></div>
        </div>
        <input type="file" id="a2-file" accept=".txt,.log,.csv,.hex,.dat,text/plain" hidden onchange="Alert2.onFile(this)">
        <div id="a2-status" class="note compact" style="margin-top:.75rem"${a.source ? '' : ' hidden'}>${esc(a.source)}</div>
        ${a.watchErr ? '<div class="note compact warn" style="margin-top:.75rem">' + a.watchErr + '</div>' : ''}
        ${!canWatch ? '<div class="spec">Watching a log file as it grows needs the File System Access API — a Chromium browser (Chrome, Edge) over https or localhost. Choosing a file still works everywhere; it reads the file once, as it stands.</div>' : ''}
      </div>`;
  }

  function modeBtn(id, label, title) {
    return '<button class="a2-vtab' + (state.a2.mode === id ? ' on' : '') + '" title="' + esc(title)
         + '" onclick="Alert2.setMode(\'' + id + '\')">' + esc(label) + '</button>';
  }

  function optionsRow() {
    const a = state.a2;
    const cb = (key, label, title) => '<label class="a2-cb" title="' + esc(title || '') + '">'
      + '<input type="checkbox" ' + (a[key] ? 'checked' : '') + ' onchange="Alert2.setOpt(\'' + key + '\',this.checked)"> ' + esc(label) + '</label>';
    return '<div class="a2-opts">'
      + cb('onlyErrors', 'Only problems', 'Show just the frames and readings something is wrong with')
      + cb('hideUnknown', 'Hide unmatched addresses', 'Drop readings whose ALERT address matches no station in the database')
      + cb('eng', 'Engineering values', 'Convert battery and rainfall counts, using the scales below')
      + '<span class="a2-num" title="Fallback only — a station carrying a recorded TBRGbucketSize uses that instead">'
      + 'mm per tip (fallback) <input type="number" step="0.1" min="0" value="' + a.mmPerTip
      + '" oninput="Alert2.setOpt(\'mmPerTip\',this.value)"></span>'
      + '<span class="a2-num">battery ÷ <input type="number" step="1" min="1" value="' + a.battDiv
      + '" oninput="Alert2.setOpt(\'battDiv\',this.value)"></span>'
      + '</div>';
  }

  function viewPanel(p, res) {
    const a = state.a2;
    const tab = (id, label) => '<button class="a2-vtab' + (a.view === id ? ' on' : '') + '" onclick="Alert2.setView(\'' + id + '\')">' + esc(label) + '</button>';
    let body;
    if (a.view === 'frames')        body = framesView(p, res);
    else if (a.view === 'stations') body = stationsView(p, res);
    else                            body = readingsView(p, res);
    return `
      <div class="panel">
        <div class="panel-header"><h3>Decoded</h3></div>
        <div class="a2-vtabs">${tab('readings', 'Readings')}${tab('stations', 'By station')}${tab('frames', 'Frame anatomy')}
          <span class="a2-vspacer"></span>
          <button class="ghost" onclick="Alert2.exportCsv()">Export CSV</button>
          <button class="ghost" onclick="Alert2.exportJson()">Export JSON</button>
        </div>
        ${optionsRow()}
        <div id="a2-view">${body}</div>
      </div>`;
  }

  function render() {
    const p = current();
    const res = p ? resolve(p) : null;
    return `
    <div class="pkt a2" style="max-width:1280px;margin:auto;padding:1rem;display:grid;gap:1rem">

      <div class="panel">
        <div class="panel-header"><h2>ALERT2 / ERT-A2 Serial Decoder</h2></div>
        <p class="sub">Decodes what an ELPRO ERT-A2 puts on its serial ports: receiver metadata, the frame's own
          timestamp, the signal level it came in at, and the ALERT readings packed into its payload — each one
          matched back to a station in the MegaNet database and put on the map. The readings inside are ordinary
          13-bit ALERT addresses and 11-bit values, the same ones the
          <a href="javascript:void 0" onclick="switchTab('packets')">ALERT Packets</a> tab decodes one at a time.</p>
        ${state.data ? '' : '<div class="note compact">No station file loaded — addresses will decode but nothing will be named or mapped. Load <b>stations.json</b> from the header to see station names.</div>'}
      </div>

      ${inputPanel()}
      ${referencePanel()}
      ${p ? summaryPanel(p, res) : ''}
      ${p && res ? ambiguityPanel(res) : ''}
      ${p && res ? mapPanel(p, res) : ''}
      ${p ? viewPanel(p, res) : ''}

    </div>`;
  }

  // ── event handlers ────────────────────────────────────────────────────────────

  function refresh() { renderMain(); }

  function readBox() {
    const el = document.getElementById('a2-text');
    if (el) state.a2.text = el.value;
  }
  function decode()     { readBox(); state.a2.limit = ROW_STEP; refresh(); }
  function clear()      { state.a2.text = ''; state.a2.parsed = null; state.a2.parsedKey = ''; state.a2.source = ''; state.a2.sel = null; state.a2.mapView = null; stopWatch(); refresh(); }
  function more()       { state.a2.limit += ROW_STEP; refresh(); }
  function setView(v)   { state.a2.view = v; refresh(); }
  // Changing format changes which capture is on screen, so the selection and the
  // map's remembered view belong to the old one and go with it.
  function setMode(m)   { state.a2.mode = m; state.a2.sel = null; state.a2.mapView = null; refresh(); }

  function loadSample(which) {
    const bin = which === 'bin';
    state.a2.text = bin ? SAMPLE_BIN : SAMPLE;
    state.a2.mode = 'auto';
    state.a2.sel = null; state.a2.mapView = null;
    state.a2.source = bin
      ? 'Sample capture — real binary frames off a test ERT-A2\'s USB port, the ones this decoder was checked against Ranger with.'
      : 'Sample capture — real ALERT2 ASCII lines from a test ERT-A2\'s RS232 port.';
    state.a2.limit = ROW_STEP;
    refresh();
  }

  function setOpt(key, val) {
    const a = state.a2;
    if (key === 'mmPerTip' || key === 'battDiv') {
      const n = Number(val);
      a[key] = Number.isFinite(n) ? n : a[key];
      // Typing in a number box must not re-render the field out from under the
      // cursor, so only the parts that read the scale are redrawn.
      const view = document.getElementById('a2-view');
      const p = current(); const res = p ? resolve(p) : null;
      if (view && p && res) {
        view.innerHTML = a.view === 'frames' ? framesView(p, res)
                       : a.view === 'stations' ? stationsView(p, res) : readingsView(p, res);
        attachRecHover(view);
      }
      return;
    }
    a[key] = val;
    refresh();
  }

  function openFrame(seq) {
    state.a2.view = 'frames';
    state.a2.frameIdx = seq;
    refresh();
    setTimeout(() => {
      const card = document.querySelector('#a2-view .fmtcard.open');
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 0);
  }

  function pick(aid, stationId) {
    if (state.a2.picks[aid] === stationId) delete state.a2.picks[aid];
    else state.a2.picks[aid] = stationId;
    refresh();
  }
  function clearPicks() { state.a2.picks = {}; refresh(); }

  // ── file ingest ───────────────────────────────────────────────────────────────

  function status(msg) {
    const el = document.getElementById('a2-status');
    if (el) { el.textContent = msg; el.hidden = !msg; }
    state.a2.source = msg;
  }

  function chooseFile() {
    const el = document.getElementById('a2-file');
    if (el) { el.value = ''; el.click(); }
  }

  // PuTTY writes its log in whatever the terminal's character set is, so a UTF-16
  // BOM is possible even though ANSI is usual. Sniff it rather than assuming.
  function decodeBuffer(buf) {
    const u8 = new Uint8Array(buf);
    if (u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf);
    if (u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf);
    return new TextDecoder('utf-8').decode(buf).replace(/^﻿/, '');
  }

  function onFile(input) {
    const f = input && input.files && input.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      state.a2.text = decodeBuffer(reader.result);
      state.a2.limit = ROW_STEP;
      state.a2.source = 'Loaded ' + f.name + ' (' + (f.size / 1024).toFixed(1) + ' kB), read once at '
                      + clockText(Date.now()) + '.';
      refresh();
    };
    reader.onerror = () => status('Could not read ' + f.name + ': ' + (reader.error && reader.error.message));
    reader.readAsArrayBuffer(f);
  }

  // Why the picker refused. Every path out of showOpenFilePicker except a
  // dismissal used to end up in the same bare `return`, which is exactly what a
  // managed machine looks like: the button is present, because the API exists,
  // and pressing it does nothing at all, because policy blocks the call and the
  // rejection was being swallowed. The failure has to be visible and it has to
  // name the likely cause — an operator cannot ask IT to unblock something the
  // page never admitted was blocked.
  function pickerRefusal(e) {
    const name = (e && e.name) || '';
    const msg  = esc((e && e.message) || String(e));
    if (name === 'SecurityError') return '<b>Watching was refused by the browser.</b> This usually means the page '
      + 'is not in a secure context (needs https or localhost), or it is embedded in a frame that is not allowed '
      + 'to open a file picker. <span class="spec">' + msg + '</span>';
    if (name === 'NotAllowedError') return '<b>Watching is blocked on this machine.</b> Chrome and Edge let an '
      + 'administrator turn the File System Access API off by policy (<code>DefaultFileSystemReadGuardSetting</code>, '
      + 'or a site on <code>FileSystemReadBlockedForUrls</code>) and a blocked call fails exactly like this — with '
      + 'no prompt. Ask for this site to be allowed, or use <b>Choose log file…</b>, which reads the file once and '
      + 'is not affected. <span class="spec">' + msg + '</span>';
    if (name === 'TypeError') return '<b>This browser would not accept the file picker\'s options.</b> Use '
      + '<b>Choose log file…</b> instead. <span class="spec">' + msg + '</span>';
    return '<b>Could not start watching.</b> Use <b>Choose log file…</b> instead — it reads the file once and works '
      + 'everywhere. <span class="spec">' + esc(name ? name + ': ' : '') + msg + '</span>';
  }

  // The nearest thing to a live feed available without Web Serial: keep the file
  // handle the picker returned and re-open it on a timer. PuTTY flushes its log
  // as it writes, so each re-read picks up whatever has arrived since.
  async function watchFile() {
    const a = state.a2;
    a.watchErr = '';
    if (!canWatch) {
      a.watchErr = '<b>This browser has no File System Access API.</b> Watching needs Chrome or Edge over https or '
                 + 'localhost. <b>Choose log file…</b> works everywhere.';
      refresh();
      return;
    }
    let handle;
    try {
      [handle] = await window.showOpenFilePicker({ multiple: false,
        types: [{ description: 'Terminal or hex log', accept: { 'text/plain': ['.txt', '.log', '.csv', '.hex', '.dat'] } }] });
    } catch (e) {
      // A dismissed picker is not a fault and must stay silent. Everything else
      // is a fault, and used to be silent too — that was the bug.
      if (e && (e.name === 'AbortError' || e.name === 'NotFoundError')) return;
      a.watchErr = pickerRefusal(e);
      refresh();
      return;
    }
    if (!handle) { a.watchErr = 'The file picker returned nothing to watch.'; refresh(); return; }
    stopWatch();
    a.watch = { handle, name: handle.name, timer: null, reads: 0 };
    const tick = async () => {
      // The watch outlives re-renders, so check the handle is still the one this
      // closure was started for — a second Watch replaces it, and the old timer
      // must not keep writing over the new one's text.
      if (!a.watch || a.watch.handle !== handle) return;
      try {
        const file = await handle.getFile();
        const text = decodeBuffer(await file.arrayBuffer());
        a.watch.reads++;
        if (text !== a.text) {
          a.text = text;
          if (state.activeTab === 'alert2') refresh();
        }
        status('Watching ' + a.watch.name + ' — re-read every ' + (a.watchMs / 1000)
             + ' s, last at ' + clockText(Date.now()) + ' (' + a.watch.reads + ' reads).');
      } catch (e) {
        // Permission can be revoked mid-watch (the file moves, the tab loses
        // its grant), and a timer failing quietly every five seconds is worse
        // than one that stops and says why.
        const name = a.watch ? a.watch.name : 'the file';
        stopWatch();
        a.watchErr = '<b>Stopped watching ' + esc(name) + '.</b> <span class="spec">'
                   + esc((e && e.name ? e.name + ': ' : '') + ((e && e.message) || e)) + '</span>';
        if (state.activeTab === 'alert2') refresh();
      }
    };
    await tick();
    if (a.watch) a.watch.timer = setInterval(tick, a.watchMs);
    refresh();
  }

  function stopWatch() {
    const w = state.a2.watch;
    if (!w) return;
    if (w.timer) clearInterval(w.timer);
    state.a2.watch = null;
  }

  // The button's own handler. stopWatch alone left the button still reading
  // "Stop watching …" until something else happened to re-render.
  function stopWatching() { stopWatch(); state.a2.watchErr = ''; refresh(); }

  // ── export ────────────────────────────────────────────────────────────────────

  function exportRows() {
    const p = current();
    if (!p) return [];
    const res = resolve(p);
    const out = [];
    // The frame carries a time of day but no date, and the receiver carries a
    // date but a clock that may be hours out. Pairing the receiver's date with
    // the frame's time of day is exact for the time and right for the date on
    // any frame whose clock error does not straddle midnight — which beats
    // correcting everything by one capture-wide offset when that offset drifts.
    const stamp = f => {
      if (!f.hdr.clockMs || !f.payload) return '';
      const d = new Date(f.hdr.clockMs);
      d.setHours(0, 0, 0, 0);
      return isoText(d.getTime() + f.payload.sod * 1000);
    };
    p.frames.forEach(f => {
      if (f.error) return;
      f.records.forEach(r => {
        const info = res.byAlertId.get(r.alertId);
        const st = info && info.chosen ? info.chosen.station : null;
        const eng = engValue(info ? info.kind : null, r.value, st);
        out.push({
          format: f.kind === 'bin' ? 'usb-binary' : 'rs232-ascii',
          line: f.lineNo,
          frame_time: hms(f.payload.sod),
          ert_a2_clock: isoText(f.hdr.clockMs),
          alert2_datetime: stamp(f),
          decoder: f.hdr.decoder == null ? '' : f.hdr.decoder,
          source: f.hdr.source == null ? '' : f.hdr.source,
          quality: f.hdr.quality == null ? '' : f.hdr.quality,
          rssi_dbm: f.hdr.rssi == null ? '' : f.hdr.rssi,
          alert_id: r.alertId,
          station: st ? st.name : (info && info.fileName && !info.fileName.none ? info.fileName.text : ''),
          station_number: st ? (st.station_number || '') : '',
          lat: st && st.lat != null ? st.lat : '',
          lon: st && st.lon != null ? st.lon : '',
          match: info ? info.conf : 'unknown',
          sensor: info && info.chosen ? info.chosen.types.join(' / ') : '',
          value: r.value,
          engineering: eng ? eng.text : '',
          status: '0x' + hx(r.status),
          bytes: r.bytes.map(hx).join(' '),
        });
      });
    });
    return out;
  }

  function exportCsv() {
    const rows = exportRows();
    if (!rows.length) return;
    const cols = Object.keys(rows[0]);
    const csv = [cols.join(',')].concat(rows.map(r => cols.map(c => csvEscape(r[c])).join(','))).join('\n');
    dlText('alert2-readings.csv', csv);
  }

  function exportJson() {
    const p = current();
    if (!p) return;
    const rssis = p.frames.filter(f => !f.error && f.hdr.rssi != null).map(f => f.hdr.rssi);
    dlText('alert2-readings.json', JSON.stringify({
      generated: new Date().toISOString(),
      capture: { format: p.stats.mode === 'bin' ? 'usb-binary' : 'rs232-ascii',
                 frames: p.stats.frames, records: p.stats.records, errors: p.stats.errors,
                 clock_skew_seconds: p.stats.skew,
                 rssi_dbm: rssis.length
                   ? { n: rssis.length, median: median(rssis), best: Math.max(...rssis), worst: Math.min(...rssis) }
                   : null },
      readings: exportRows(),
    }, null, 2));
  }

  // ── init ──────────────────────────────────────────────────────────────────────

  function init() {
    // Station names come from the same two sources as the ALERT Packets tab, and
    // the national address file is the fallback for addresses MegaNet has never
    // seen. It loads once for both tabs.
    Packets.loadStationsFile();
    const view = document.getElementById('a2-view');
    if (view) attachRecHover(view);
    const p = current();
    initCoverageMap(p, p ? resolve(p) : null);
  }

  // Leaving the tab: the div this map was built on is about to be replaced.
  function stop() { stopMap(); }

  // Hovering a reading lights up the four bytes it came out of, and vice versa.
  function attachRecHover(root) {
    root.querySelectorAll('.fmtbody').forEach(card => {
      const mark = (i, on) => card.querySelectorAll('[data-rec="' + i + '"]').forEach(el => el.classList.toggle('hl', on));
      card.querySelectorAll('[data-rec]').forEach(el => {
        const i = el.dataset.rec;
        el.addEventListener('mouseenter', () => mark(i, true));
        el.addEventListener('mouseleave', () => mark(i, false));
      });
    });
  }

  // parse/decodeRecord are the codec on its own, with no DOM behind it — the
  // form a live feed would call, and the form this is testable in. parse takes
  // the mode, so both wire formats are reachable without a page.
  return { render, init, stop, decode, clear, loadSample, more, setView, setMode, setOpt,
           openFrame, pick, clearPicks, select,
           chooseFile, onFile, watchFile, stopWatch, stopWatching, exportCsv, exportJson,
           parse, parseAscii, parseBin, decodeRecord };
})();

// ── NETWORK MAPS tab (Network Maps Navigator) ───────────────────────────────────
//
// Ports the legacy "ALERT Map Launcher v2.html" into MegaNet: a Queensland
// drainage-basin map with clickable regions, region/subregion/file navigation
// and an embedded PDF/image viewer. Adds station-aware search — type a station
// name, ALERT ID or site number and the tool suggests the relevant map(s).
//
// Data (catalogue, basin SVG, georeference) comes from maps-data.js, exposed as
// window.MegaNetMaps and loaded before this script.

const Maps = (function () {
  const MD = (typeof window !== 'undefined' && window.MegaNetMaps) || null;

  // Region fill palette (applied to basin polygons; readable on both themes).
  const REGION_COLOR = {
    'Far North':             '#2a9d8f',
    'Mackay / Whitsundays':  '#e76f51',
    'Burdekin / Townsville': '#457b9d',
    'Central QLD':           '#e9a92c',
    'Wide Bay / Burnett':    '#6aa84f',
    'SE QLD':                '#9b5de5',
    'West / South West':     '#d98b3a',
    'NSW Border':            '#8d99ae',
  };

  const mstate = {
    region:    localStorage.getItem('mn-maps-region') || 'All files',
    subregion: localStorage.getItem('mn-maps-sub')    || '_all',
    file:      localStorage.getItem('mn-maps-file')   || '',
    query:     '',
    basins:    null,   // [{name, region, pts:[[x,y],...]}]  parsed once
  };

  // ── catalogue helpers ─────────────────────────────────────────────────────────
  function regions()            { return MD ? MD.REGION_ORDER : ['All files']; }
  function subregions(region)   { return region === 'All files' ? [] : Object.keys((MD && MD.MAP_CATALOG[region]) || {}); }
  function regionFiles(region)  {
    if (!MD) return [];
    if (region === 'All files') return allFiles();
    return Object.values(MD.MAP_CATALOG[region] || {}).flat();
  }
  function allFiles() {
    if (!MD) return [];
    const seen = new Set();
    for (const r of MD.REGION_ORDER) {
      if (r === 'All files') continue;
      for (const f of regionFiles(r)) seen.add(f);
    }
    return [...seen];
  }
  function fileRegion(file) {
    if (!MD) return null;
    for (const r of MD.REGION_ORDER) {
      if (r === 'All files') continue;
      if (regionFiles(r).includes(file)) return r;
    }
    return null;
  }
  function fileSubregion(file) {
    if (!MD) return null;
    for (const r of MD.REGION_ORDER) {
      const groups = (MD.MAP_CATALOG[r]) || {};
      for (const [sub, files] of Object.entries(groups)) if (files.includes(file)) return sub;
    }
    return null;
  }
  function basinRegion(basinName) {
    if (!MD) return null;
    const slug = slugBasin(basinName);
    for (const [region, list] of Object.entries(MD.REGION_BASINS)) {
      if (list.some(b => slugBasin(b) === slug)) return region;
    }
    return null;
  }
  function slugBasin(v) {
    return String(v).toLowerCase().replace(/&apos;|&#39;/g, "'").replace(/[^a-z0-9]+/g, ' ').trim();
  }

  // ── files currently in view (region/subregion + text filter) ──────────────────
  function rawFiles() {
    if (mstate.region === 'All files') return allFiles();
    const data = (MD && MD.MAP_CATALOG[mstate.region]) || {};
    return mstate.subregion === '_all' ? Object.values(data).flat() : (data[mstate.subregion] || []);
  }
  function fileMatchesQuery(file, q) {
    if (!q) return true;
    const info = (MD && MD.FILE_INFO[file]) || {};
    const hay = [
      file,
      fileRegion(file) || '',
      fileSubregion(file) || '',
      ...(info.catchments || []),
      ...(info.aliases || []),
      ...(info.networks || []),
    ].join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every(tok => hay.includes(tok));
  }
  function filteredFiles() { return rawFiles().filter(f => fileMatchesQuery(f, mstate.query)); }

  function ext(file)   { return file.split('.').pop().toUpperCase(); }
  function isImage(f)  { return /\.(png|jpe?g|gif|webp|svg)$/i.test(f); }
  // Resolve a catalogue filename to its on-disk location (files live in
  // per-region sub-folders under maps/, see maps-data.js FILE_PATH) and
  // URL-encode each path segment. Falls back to the bare name if unmapped.
  function encPath(f)  {
    const rel = (MD && MD.FILE_PATH && MD.FILE_PATH[f]) || f;
    return './' + rel.split('/').map(encodeURIComponent).join('/');
  }
  function fileTags(file) {
    const info = (MD && MD.FILE_INFO[file]) || {};
    const out = [ext(file)];
    const n = file.toLowerCase();
    if (n.includes('network to')) out.push('backbone');
    if (n.includes('old') || n.includes('blank')) out.push('legacy');
    if (n.includes('repeaters')) out.push('repeaters');
    if ((info.networks || []).length) out.push('net-linked');
    return out;
  }

  // ── station → map suggestion engine ───────────────────────────────────────────
  // Signals: (1) radio_network_id → map  [authoritative]
  //          (2) georeferenced point-in-basin → map/region  [approx ~34 km]
  //          (3) free-text keyword match against FILE_INFO
  //          (4) nearest region centroid  [coarse fallback]
  function lonLatToSvg(lon, lat) {
    const g = MD.BASIN_GEOREF;
    const det = g.ax * g.by - g.bx * g.ay;
    const x = ( g.by * (lon - g.cx) - g.bx * (lat - g.cy)) / det;
    const y = (-g.ay * (lon - g.cx) + g.ax * (lat - g.cy)) / det;
    return [x, y];
  }
  function parseBasins() {
    if (mstate.basins || !MD) return mstate.basins;
    const doc = new DOMParser().parseFromString(MD.QLD_BASIN_SVG, 'image/svg+xml');
    const out = [];
    doc.querySelectorAll('polygon').forEach(p => {
      const name = (p.querySelector('title')?.textContent || '').replace(/&apos;/g, "'");
      const pts = (p.getAttribute('points') || '').trim().split(/\s+/).map(pair => {
        const [x, y] = pair.split(',').map(Number);
        return [x, y];
      }).filter(pt => pt.length === 2 && !isNaN(pt[0]) && !isNaN(pt[1]));
      if (name && pts.length > 2) out.push({ name, region: basinRegion(name), pts });
    });
    mstate.basins = out;
    return out;
  }
  function pointInPoly(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function basinOfStation(s) {
    if (!MD || s.lat == null || s.lon == null) return null;
    const [x, y] = lonLatToSvg(s.lon, s.lat);
    for (const b of parseBasins()) if (pointInPoly(x, y, b.pts)) return b;
    return null;
  }
  function nearestRegion(s) {
    if (!MD || s.lat == null || s.lon == null) return null;
    let best = null, bd = Infinity;
    for (const [region, c] of Object.entries(MD.REGION_CENTROIDS)) {
      const d = (c[0] - s.lat) ** 2 + (c[1] - s.lon) ** 2;
      if (d < bd) { bd = d; best = region; }
    }
    return best;
  }
  function stationTokens(s) {
    return (s.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(t => t.length > 2);
  }
  function mapsForStation(s) {
    if (!MD) return [];
    const scores = {};   // file -> {score, reasons:Set}
    const add = (file, score, reason) => {
      if (!file) return;
      const e = scores[file] || (scores[file] = { score: 0, reasons: new Set() });
      e.score = Math.max(e.score, score);
      e.reasons.add(reason);
    };
    // (1) radio network
    for (const net of (s.radio_network_ids || [])) {
      for (const f of (MD.NETWORK_FILES[net] || [])) add(f, 100, 'radio network ' + net);
    }
    // (2) basin (point-in-polygon)
    const basin = basinOfStation(s);
    let region = basin ? basin.region : null;
    if (basin) {
      const bslug = slugBasin(basin.name);
      let direct = false;
      for (const [file, info] of Object.entries(MD.FILE_INFO)) {
        if ((info.catchments || []).some(c => slugBasin(c) === bslug)) { add(file, 65, 'in ' + basin.name + ' catchment'); direct = true; }
      }
      if (region && !direct) for (const f of regionFiles(region)) add(f, 42, region + ' region (approx)');
    }
    // (3) keyword match on station name tokens
    const toks = stationTokens(s);
    if (toks.length) {
      for (const [file, info] of Object.entries(MD.FILE_INFO)) {
        const kw = [...(info.aliases || []), ...(info.catchments || [])].map(k => k.toLowerCase());
        const hit = toks.find(t => kw.some(k => k.includes(t) || t.includes(k)));
        if (hit) add(file, 55, "matches “" + hit + '”');
      }
    }
    // (4) region-centroid fallback if nothing yet
    if (!Object.keys(scores).length) {
      region = region || nearestRegion(s);
      if (region) for (const f of regionFiles(region)) add(f, 25, region + ' region (approx)');
    }
    return Object.entries(scores)
      .map(([file, e]) => ({ file, score: e.score, reasons: [...e.reasons] }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
  }

  // ── station text search (name / ALERT ID / site number / id) ──────────────────
  function stationHaystack(s) {
    const ids = new Set();
    const a = s.alert_ids || {};
    Object.values(a).forEach(v => (Array.isArray(v) ? v : [v]).forEach(x => x != null && ids.add(String(x))));
    (s.sensors || []).forEach(se => se.alert_id != null && ids.add(String(se.alert_id)));
    const site = s.site || {};
    return {
      text: [s.name, s.id, s.station_number, site.number, site.name].filter(Boolean).join(' ').toLowerCase(),
      ids,
    };
  }
  function matchStations(query) {
    if (!state.data || !query) return [];
    const q = query.toLowerCase().trim();
    const scored = [];
    for (const s of state.data.stations) {
      const h = stationHaystack(s);
      let score = 0;
      if (h.ids.has(q)) score = 100;                                   // exact ALERT id / number
      else if (s.name && s.name.toLowerCase() === q) score = 95;       // exact name
      else if (s.name && s.name.toLowerCase().startsWith(q)) score = 80;
      else if (h.text.includes(q)) score = 60;
      else if ([...h.ids].some(id => id.includes(q)) && q.length >= 2) score = 40;
      if (score) scored.push({ s, score });
    }
    return scored.sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name)).slice(0, 8);
  }

  // ── rendering ─────────────────────────────────────────────────────────────────
  function render() {
    if (!MD) {
      return `<div class="layout"><div class="panel"><h2 style="margin-top:0">Network Maps</h2>
        <p class="warn-text">Map data module failed to load (<code>maps-data.js</code>). Check that it is present and loaded before <code>app.js</code>.</p></div></div>`;
    }
    return `
    <div class="maps-layout">
      <aside class="maps-left stack">
        <div class="panel">
          <div class="panel-header"><h3 style="margin:0">Find a map</h3>
            <span class="small" id="maps-total"></span></div>
          <div style="margin-top:.6rem">
            <input type="search" id="maps-search" placeholder="Map, catchment, town — or station name / ALERT ID…"
                   value="${esc(mstate.query)}" oninput="Maps.onSearch(this.value)">
          </div>
          <div class="small" style="margin-top:.4rem;color:var(--muted)">
            Browse by region below, or search a station (name, ALERT ID, site number) to get suggested maps.</div>
          <div id="maps-suggest"></div>
        </div>

        <div class="panel">
          <div class="panel-header"><h3 style="margin:0">Queensland basins</h3>
            <button class="maps-reset" onclick="Maps.setRegion('All files')" title="Show all regions">Reset</button></div>
          <div id="maps-basin" class="maps-basin"></div>
          <div id="maps-region-chips" class="maps-chips" style="margin-top:.6rem"></div>
        </div>

        <div class="panel">
          <div id="maps-subregion-chips" class="maps-chips"></div>
          <div class="panel-header" style="margin-top:.5rem">
            <strong id="maps-list-title"></strong>
            <span class="small" id="maps-list-count"></span></div>
          <ul id="maps-file-list" class="maps-file-list"></ul>
        </div>
      </aside>

      <div class="panel maps-viewer-panel">
        <div class="maps-viewer-toolbar">
          <div style="min-width:0">
            <strong id="maps-current-file" style="display:block">No map open</strong>
            <span class="small" id="maps-current-path" style="word-break:break-all"></span>
          </div>
          <div class="button-row" style="flex-wrap:nowrap">
            <button onclick="Maps.step(-1)" title="Previous map">‹ Prev</button>
            <button onclick="Maps.step(1)" title="Next map">Next ›</button>
            <a id="maps-newtab" class="maps-newtab" target="_blank" rel="noopener">Open in new tab ↗</a>
          </div>
        </div>
        <div id="maps-viewer" class="maps-viewer">
          <div class="maps-empty">Select a map from the list, or search for a station to get a suggestion.</div>
        </div>
      </div>
    </div>`;
  }

  function init() {
    if (!MD) return;
    injectBasinMap();
    renderRegionChips();
    renderSubregionChips();
    renderList();
    renderSuggestions();
    updateTotal();
    if (mstate.file && allFiles().includes(mstate.file)) openFile(mstate.file, false);
  }

  function updateTotal() {
    const el = document.getElementById('maps-total');
    if (el) el.textContent = allFiles().length + ' maps';
  }

  function injectBasinMap() {
    const host = document.getElementById('maps-basin');
    if (!host) return;
    host.innerHTML = MD.QLD_BASIN_SVG;
    const svg = host.querySelector('svg');
    if (!svg) return;
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.classList.add('maps-basin-svg');
    svg.querySelector('rect')?.remove();                     // drop the white backdrop
    svg.querySelectorAll('polygon').forEach(p => {
      const name = (p.querySelector('title')?.textContent || '').replace(/&apos;/g, "'");
      const region = basinRegion(name);
      p.dataset.region = region || '';
      p.dataset.basin = name;
      const col = region ? REGION_COLOR[region] : null;
      p.style.fill = col || 'var(--muted)';
      p.style.fillOpacity = region ? '0.32' : '0.06';
      p.style.stroke = col || 'var(--border)';
      p.style.strokeOpacity = '0.85';
      p.style.cursor = region ? 'pointer' : 'default';
      if (region) {
        p.addEventListener('click', () => setRegion(region));
        p.addEventListener('mouseenter', () => { p.style.fillOpacity = '0.6'; });
        p.addEventListener('mouseleave', () => applyRegionHighlight());
      }
    });
    applyRegionHighlight();
  }

  function applyRegionHighlight() {
    const host = document.getElementById('maps-basin');
    if (!host) return;
    const active = mstate.region;
    host.querySelectorAll('polygon').forEach(p => {
      const region = p.dataset.region;
      if (!region) return;
      const on = active === 'All files' || region === active;
      p.style.fillOpacity = on ? (active !== 'All files' && region === active ? '0.62' : '0.32') : '0.08';
      p.style.strokeOpacity = on ? '0.9' : '0.3';
    });
  }

  function renderRegionChips() {
    const el = document.getElementById('maps-region-chips');
    if (!el) return;
    el.innerHTML = regions().map(r => {
      const count = r === 'All files' ? allFiles().length : regionFiles(r).length;
      const hint = (MD.REGION_HINTS[r]) ? `<span class="maps-chip-hint">${esc(MD.REGION_HINTS[r])}</span>` : '';
      const dot = r !== 'All files' && REGION_COLOR[r]
        ? `<span class="maps-chip-dot" style="background:${REGION_COLOR[r]}"></span>` : '';
      return `<button class="maps-chip${r === mstate.region ? ' active' : ''}" onclick="Maps.setRegion('${escAttr(r)}')">
        ${dot}${esc(r)}<span class="maps-count">${count}</span>${hint}</button>`;
    }).join('');
  }

  function renderSubregionChips() {
    const el = document.getElementById('maps-subregion-chips');
    if (!el) return;
    const subs = subregions(mstate.region);
    if (!subs.length) { el.innerHTML = ''; return; }
    let html = `<button class="maps-chip${mstate.subregion === '_all' ? ' active' : ''}" onclick="Maps.setSubregion('_all')">All in region</button>`;
    html += subs.map(sub =>
      `<button class="maps-chip${mstate.subregion === sub ? ' active' : ''}" onclick="Maps.setSubregion('${escAttr(sub)}')">
        ${esc(sub)}<span class="maps-count">${(MD.MAP_CATALOG[mstate.region][sub] || []).length}</span></button>`
    ).join('');
    el.innerHTML = html;
  }

  function renderList() {
    const el = document.getElementById('maps-file-list');
    const titleEl = document.getElementById('maps-list-title');
    const countEl = document.getElementById('maps-list-count');
    if (!el) return;
    const files = filteredFiles();
    if (titleEl) titleEl.textContent = mstate.region + (mstate.subregion !== '_all' ? ' · ' + mstate.subregion : '');
    if (countEl) countEl.textContent = `${files.length} / ${rawFiles().length}`;
    if (!files.length) {
      el.innerHTML = `<li class="maps-file"><div class="maps-file-name small">No maps match “${esc(mstate.query)}”.</div></li>`;
      return;
    }
    el.innerHTML = files.map(f => {
      const badges = fileTags(f).map(t => `<span class="badge maps-badge">${esc(t)}</span>`).join('');
      return `<li class="maps-file${f === mstate.file ? ' selected' : ''}">
        <div style="min-width:0">
          <div class="maps-file-name">${esc(f)}</div>
          <div class="maps-badges">${badges}</div>
        </div>
        <div class="maps-file-actions">
          <button onclick="Maps.openFile('${escAttr(f)}')">Open</button>
          <a class="maps-newtab" href="${encPath(f)}" target="_blank" rel="noopener">↗</a>
        </div></li>`;
    }).join('');
  }

  function renderSuggestions() {
    const el = document.getElementById('maps-suggest');
    if (!el) return;
    const q = mstate.query.trim();
    if (!q) { el.innerHTML = ''; return; }
    if (!state.data) {
      el.innerHTML = `<div class="maps-suggest-note small">Load <strong>stations.json</strong> to search by station name / ALERT ID.</div>`;
      return;
    }
    const matches = matchStations(q);
    if (!matches.length) { el.innerHTML = ''; return; }
    el.innerHTML = `<div class="maps-suggest-note small">Stations matching “${esc(q)}” → suggested maps:</div>` +
      matches.map(({ s }) => {
        const maps = mapsForStation(s);
        const aid = [...stationHaystack(s).ids].slice(0, 4).join(', ');
        const chips = maps.length
          ? maps.map(m => `<button class="maps-suggest-map" title="${escAttr(m.reasons.join('; '))}" onclick="Maps.openFile('${escAttr(m.file)}')">${esc(m.file)}</button>`).join('')
          : `<span class="small" style="color:var(--muted)">no map match — try browsing the region</span>`;
        return `<div class="maps-suggest-item">
          <div class="maps-suggest-station">${esc(s.name)}
            ${aid ? `<span class="small" style="color:var(--muted)">· ALERT ${esc(aid)}</span>` : ''}</div>
          <div class="maps-suggest-maps">${chips}</div>
        </div>`;
      }).join('');
  }

  // ── actions ───────────────────────────────────────────────────────────────────
  function setRegion(region) {
    mstate.region = region;
    mstate.subregion = '_all';
    localStorage.setItem('mn-maps-region', region);
    localStorage.setItem('mn-maps-sub', '_all');
    renderRegionChips(); renderSubregionChips(); renderList(); applyRegionHighlight();
  }
  function setSubregion(sub) {
    mstate.subregion = sub;
    localStorage.setItem('mn-maps-sub', sub);
    renderSubregionChips(); renderList();
  }
  function onSearch(v) {
    mstate.query = v;
    renderList(); renderSuggestions();
  }
  // A4/A3 (and every ISO A-series) page shares a 1:√2 ratio — used as the
  // viewer's default shape until a file's real page size is known.
  const A4_RATIO = 1 / Math.SQRT2;
  const pdfAspectCache = new Map(); // file -> width/height ratio (or null if undetectable)

  function setViewerAspect(ratio) {
    const host = document.getElementById('maps-viewer');
    if (!host) return;
    if (ratio && isFinite(ratio) && ratio > 0) host.style.setProperty('--maps-aspect', String(ratio));
    else host.style.removeProperty('--maps-aspect');
  }

  // Reads just enough of the PDF to find its first /MediaBox (and any
  // /Rotate) so the viewer can be sized to the map's real page proportions
  // instead of a guessed default.
  async function loadPdfAspect(file, path) {
    if (pdfAspectCache.has(file)) return;
    try {
      const res = await fetch(path);
      if (!res.ok) return;
      const buf = await res.arrayBuffer();
      const text = new TextDecoder('latin1').decode(buf);
      const m = text.match(/\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/);
      let ratio = null;
      if (m) {
        let w = Math.abs(parseFloat(m[3]) - parseFloat(m[1]));
        let h = Math.abs(parseFloat(m[4]) - parseFloat(m[2]));
        const rot = text.match(/\/Rotate\s+(-?\d+)/);
        if (rot) {
          const deg = ((parseInt(rot[1], 10) % 360) + 360) % 360;
          if (deg === 90 || deg === 270) [w, h] = [h, w];
        }
        if (w > 0 && h > 0) ratio = w / h;
      }
      pdfAspectCache.set(file, ratio);
      if (mstate.file === file) setViewerAspect(ratio || A4_RATIO);
    } catch (e) {
      // Fetch/parse failure: the A4 fallback aspect ratio already applied stands.
    }
  }

  function openFile(file, scroll = true) {
    mstate.file = file;
    localStorage.setItem('mn-maps-file', file);
    const host = document.getElementById('maps-viewer');
    const nameEl = document.getElementById('maps-current-file');
    const pathEl = document.getElementById('maps-current-path');
    const linkEl = document.getElementById('maps-newtab');
    const path = encPath(file);
    if (nameEl) nameEl.textContent = file;
    if (pathEl) pathEl.textContent = path;
    if (linkEl) linkEl.href = path;
    if (host) {
      if (isImage(file)) {
        host.innerHTML = `<img class="maps-view-img" alt="${escAttr(file)}" src="${path}">`;
        setViewerAspect(null);
        const img = host.querySelector('img');
        if (img) img.addEventListener('load', () => {
          if (mstate.file === file && img.naturalWidth && img.naturalHeight) {
            setViewerAspect(img.naturalWidth / img.naturalHeight);
          }
        }, { once: true });
      } else {
        host.innerHTML = `<iframe class="maps-view-frame" src="${path}#view=FitH" title="${escAttr(file)}"></iframe>`;
        setViewerAspect(pdfAspectCache.get(file) || A4_RATIO);
        loadPdfAspect(file, path);
      }
    }
    renderList();
    if (scroll && host) host.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function step(delta) {
    const files = filteredFiles();
    if (!files.length) return;
    const i = Math.max(0, files.indexOf(mstate.file));
    openFile(files[(i + delta + files.length) % files.length]);
  }

  return { render, init, setRegion, setSubregion, onSearch, openFile, step };
})();

// ── SERIAL MONITOR tab ──────────────────────────────────────────────────────────
//
// Connect physical serial devices to the browser's COM ports (Web Serial API) and
// stream their output live. Multiple ports can be open at once, each with its own
// settings (baud rate, data/stop bits, parity, flow control) and its own display
// mode:
//   • text  — bytes decoded as UTF-8/ASCII and split into lines on CR/LF
//   • hex   — raw bytes as a hex + ASCII dump, for inspecting binary framing
//   • alert — every 4 bytes decoded as a 32-bit ALERT payload (ABF/BCC/EAF/EIF)
//             via the shared Packets codec and cross-referenced to the station DB
//
// Web Serial needs a Chromium browser (Chrome/Edge/Opera) served from a secure
// context (https or localhost). Live connection objects hold non-serialisable
// streams, so they live in this module's `conns` array — not in global `state` —
// and survive tab switches (reads continue in the background); the DOM is rebuilt
// from each connection's capped entry buffer whenever the tab is shown again.

const Serial = (function () {
  const MAX_ENTRIES = 1000;                    // per-connection scrollback cap
  const BAUD_RATES  = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400];
  const DEFAULTS_KEY = 'mn-serial-defaults';

  const conns = [];          // live connection objects (module-scoped, not serialised)
  let nextId = 1;
  let disconnectHooked = false;
  let knownPorts = [];       // ports the browser has already granted us (getPorts)

  const supported = typeof navigator !== 'undefined' && 'serial' in navigator;

  // Bumped whenever the Serial Monitor changes. Shown in the tab header so it is
  // possible to confirm at a glance which build of app.js the browser actually
  // loaded — a stale, cached app.js is the usual reason a "fixed" bug persists.
  const SERIAL_BUILD = '2026-07-16e';

  function loadDefaults() {
    let d = {};
    try { d = JSON.parse(localStorage.getItem(DEFAULTS_KEY) || '{}'); } catch (_) {}
    return {
      baudRate:    d.baudRate    || 9600,
      dataBits:    d.dataBits    || 8,
      stopBits:    d.stopBits    || 1,
      parity:      d.parity      || 'none',
      flowControl: d.flowControl || 'none',
      mode:        d.mode        || 'text',
    };
  }
  function saveDefaults(conn) {
    const d = Object.assign({}, conn.settings, { mode: conn.mode });
    try { localStorage.setItem(DEFAULTS_KEY, JSON.stringify(d)); } catch (_) {}
  }

  function byId(id) { return conns.find(c => c.id === id); }

  // ── connection lifecycle ──────────────────────────────────────────────────────
  function addConnection() {
    const d = loadDefaults();
    const conn = {
      id: 'c' + (nextId++),
      name: 'Connection ' + (conns.length + 1),
      phase: 'setup',                    // setup | open | closed | error
      port: null,
      portLabel: '',
      settings: { baudRate: d.baudRate, dataBits: d.dataBits, stopBits: d.stopBits,
                  parity: d.parity, flowControl: d.flowControl },
      mode: d.mode,
      entries: [],                       // {ts, cls, body(html), raw(text)}
      bytes: 0,
      count: 0,                          // lines (text) / rows (hex) / frames (alert)
      openedAt: null,
      paused: false,
      autoscroll: true,
      timestamps: true,
      err: null,
      // per-mode framing buffers
      decoder: null,
      textBuf: '',
      hexBuf: [],
      hexOffset: 0,
      alertBuf: [],
      reader: null,
      writer: null,
      keepReading: false,
      readLoopPromise: null,
      flushTimer: null,
      statsPending: false,
    };
    conns.push(conn);
    renderList();
    // reveal the freshly added card
    const el = document.getElementById('ser-card-' + conn.id);
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // Write a short status line beneath the "Choose COM port…" button. Colour is
  // set inline so the message is legible regardless of the stylesheet.
  function setPortStatus(conn, msg, kind) {
    const el = document.getElementById('ser-port-status-' + conn.id);
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = kind === 'err' ? '#c7401a' : kind === 'warn' ? '#b26a00' : '';
  }

  // requestPort() rejects with the SAME NotFoundError whether the user cancelled
  // the picker or the browser refused to show a picker at all (enterprise policy
  // on a managed computer, kiosk/headless build, chooser UI unavailable). The one
  // observable difference is time: a human needs well over this many milliseconds
  // to see and dismiss a dialog, while a suppressed picker rejects almost
  // instantly after the call.
  const PICKER_INSTANT_MS = 350;

  async function choosePort(id) {
    const conn = byId(id);
    if (!conn) return;
    // The port picker can never look like a dead click: every path below either
    // opens the browser chooser, updates the UI, or leaves a visible message.
    console.log('[Serial] choosePort() invoked for', id, '(build ' + SERIAL_BUILD + ')');
    if (!supported) {
      alert('Web Serial isn’t available in this browser.\n\n'
        + 'Use a Chromium-based browser — Chrome, Edge or Opera — served over https or from localhost.');
      return;
    }
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      alert('Choosing a COM port needs a secure context (https or localhost).\n\n'
        + 'This page is being served insecurely, so the browser blocks access to serial ports.');
      return;
    }
    if (!navigator.serial || typeof navigator.serial.requestPort !== 'function') {
      const m = 'navigator.serial.requestPort is unavailable, so no COM-port picker can be shown.';
      setPortStatus(conn, m, 'err');
      alert(m);
      return;
    }
    // Definite Permissions-Policy block: the picker would be refused before it is
    // even requested — typically because this page is embedded in an <iframe>
    // without allow="serial" (a portal, SharePoint or Teams wrapper page).
    try {
      const fp = document.featurePolicy;
      if (fp && fp.features && fp.features().includes('serial') && !fp.allowsFeature('serial')) {
        setPortStatus(conn, (window.self !== window.top)
          ? 'Serial access is blocked because this page is embedded inside another page. '
            + 'Open the app in its own browser tab and try again.'
          : 'Serial access is disabled for this page by a Permissions-Policy.', 'err');
        return;
      }
    } catch (_) { /* diagnostic only — never blocks the real attempt */ }
    // Proof the handler ran, shown before the (blocking) native chooser opens.
    setPortStatus(conn, 'Opening the browser’s serial-port picker…', '');
    const t0 = Date.now();
    try {
      const port = await navigator.serial.requestPort();
      conn.port = port;
      conn.portLabel = portLabel(port);
      conn.err = null;
      hookDisconnect();
      await refreshKnownPorts();
      renderList();
    } catch (e) {
      const ms = Date.now() - t0;
      console.warn('[Serial] requestPort failed after ' + ms + ' ms:', e && e.name, '-', e && e.message);
      if (e && e.name === 'NotFoundError' && ms < PICKER_INSTANT_MS) {
        // Rejected faster than any human could close a dialog: the browser never
        // showed the picker. On managed (work) computers this is nearly always an
        // enterprise policy blocking Web Serial. Ports pre-approved by IT policy
        // still surface via getPorts(), so refresh the "Previously allowed" list
        // before showing the advice.
        await refreshKnownPorts();
        renderList();
        showBlockedPickerHelp(conn);
        return;
      }
      // Slow NotFoundError = the picker really opened and no port was chosen
      // (dismissed, or the device list was empty).
      if (e && e.name === 'NotFoundError') {
        setPortStatus(conn, 'No port selected. Click “Choose COM port…” again and pick your device. '
          + 'If the list is empty, the browser can’t see a serial device: check the USB cable/driver, and '
          + 'that no other program or browser tab already has the COM port open.', 'warn');
        return;
      }
      if (e && e.name === 'SecurityError') {
        setPortStatus(conn, 'The browser blocked the request: ' + ((e && e.message) || 'SecurityError')
          + ' — if this page is embedded inside another page or portal, open it in its own tab; '
          + 'otherwise check the padlock menu → Site settings → Serial ports.', 'err');
        return;
      }
      setPortStatus(conn, 'Could not select a COM port: ' + ((e && e.message) || e), 'err');
      alert('Could not select a COM port: ' + ((e && e.message) || e) + '\n\n'
        + 'If no port picker appeared, check that serial access is allowed for this site.');
    }
  }

  // Written into the status line when requestPort() rejected instantly, i.e. the
  // chooser was suppressed rather than cancelled. All markup here is our own —
  // the only dynamic value is the count of policy-granted ports.
  function showBlockedPickerHelp(conn) {
    const el = document.getElementById('ser-port-status-' + conn.id);
    if (!el) return;
    // The advice is long: let the port cell span the whole form row so it does
    // not squeeze into (and collide with) the narrow settings columns. The next
    // renderList() rebuilds the DOM and resets this automatically.
    const cell = el.closest ? el.closest('.ser-f-port') : null;
    if (cell) cell.style.gridColumn = '1 / -1';
    const isEdge = /Edg\//.test(navigator.userAgent);
    const policyPage = isEdge ? 'edge://policy' : 'chrome://policy';
    const granted = knownPorts.length
      ? '<p style="margin:.35rem 0 0"><strong>' + knownPorts.length + ' pre-approved port'
        + (knownPorts.length > 1 ? 's are' : ' is') + ' available</strong> under “Previously allowed” '
        + 'above — use that button instead of the picker.</p>'
      : '';
    el.style.color = '#c7401a';
    el.innerHTML =
        '<strong>The browser refused to show the port picker.</strong> It rejected the request instantly, '
      + 'so no dialog was ever displayed — this is a browser or IT-policy block, not an empty device list. '
      + '(If you did see a picker and closed it, ignore this and just click the button again.)'
      + granted
      + '<ol style="margin:.35rem 0 0 1.1rem;padding:0">'
      + '<li>Open <code>' + policyPage + '</code> and search for <code>serial</code>. '
      +   '<code>DefaultSerialGuardSetting = 2</code>, or this site listed under <code>SerialBlockedForUrls</code>, '
      +   'means your organisation blocks Web Serial — IT must add this site to <code>SerialAskForUrls</code>.</li>'
      + '<li>Click the padlock by the address bar → <em>Site settings</em> → <em>Serial ports</em> → set to '
      +   '<em>Ask</em>. If the control is greyed out, it is locked by IT policy.</li>'
      + '<li>IT can instead pre-approve the device itself (<code>SerialAllowUsbDevicesForUrls</code> or '
      +   '<code>SerialAllowAllPortsForUrls</code>) — pre-approved ports appear here under “Previously allowed” '
      +   'and need no picker at all. A ready-to-send request for IT is in '
      +   '<a href="docs/serial-help.html" target="_blank" rel="noopener">the serial access guide</a>.</li>'
      + '<li>Try the other browser — if Chrome is blocked, Edge often isn’t (and vice-versa).</li>'
      + '</ol>';
  }

  // Ports the browser has already granted us in a previous pick (persist across
  // reloads). Surfacing them lets the user reconnect a known device with one
  // click instead of fighting the picker, and is a live check of what the
  // browser can actually see.
  async function refreshKnownPorts() {
    try {
      knownPorts = (navigator.serial && navigator.serial.getPorts)
        ? await navigator.serial.getPorts() : [];
    } catch (_) { knownPorts = []; }
  }

  // Attach a previously-granted port (from the "Previously allowed" list) to a
  // connection without going through the picker.
  function useKnownPort(id, index) {
    const conn = byId(id);
    if (!conn) return;
    const port = knownPorts[index];
    if (!port) return;
    conn.port = port;
    conn.portLabel = portLabel(port);
    conn.err = null;
    hookDisconnect();
    renderList();
  }

  function portLabel(port) {
    try {
      const info = port.getInfo ? port.getInfo() : {};
      if (info && info.usbVendorId != null) {
        const v = info.usbVendorId.toString(16).padStart(4, '0');
        const p = (info.usbProductId != null ? info.usbProductId : 0).toString(16).padStart(4, '0');
        return 'USB serial (VID:PID ' + v + ':' + p + ')';
      }
    } catch (_) {}
    return 'Serial port';
  }

  // Translate a port.open() DOMException into a plain-English cause + remedy.
  // The raw messages ("Failed to open serial port.") tell the user nothing.
  function describeOpenError(e) {
    const name = e && e.name;
    const msg  = (e && e.message) || String(e);
    if (name === 'InvalidStateError')
      return 'The port is already open. Close it in the other browser tab or program that has it, then try again.';
    if (name === 'NotFoundError')
      return 'The device is no longer connected. Re-plug it, click “Change…”, pick it again, then Open.';
    if (name === 'SecurityError')
      return 'Serial access was blocked. Click “Change…” and pick the port again to re-grant permission, then Open.';
    if (name === 'NetworkError' || /failed to open|access is denied|access denied/i.test(msg))
      return 'The operating system refused to open the COM port. It is almost always still held by another '
        + 'program — a terminal (PuTTY/RealTerm), a logger, or this Serial Monitor in another tab. '
        + 'Close whatever else has the port open and try again.';
    return msg;
  }

  async function openConn(id) {
    const conn = byId(id);
    if (!conn) return;
    if (!conn.port) { alert('Choose a COM port first.'); return; }
    const s = conn.settings;
    const baudRate = +s.baudRate || 0;
    if (baudRate < 1) {
      conn.phase = 'setup';
      conn.err = 'Baud rate must be a positive number (e.g. 9600).';
      renderList();
      return;
    }
    // Always start from a clean slate. If a stale handle to this port is still
    // open — from a previous session, or a device that dropped without being
    // closed — a fresh open() would throw "The port is already open". Release it
    // first so re-opening (and re-plug → Reopen) reliably works.
    await teardown(conn);
    try {
      await conn.port.open({
        baudRate:    baudRate,
        dataBits:    +s.dataBits || 8,
        stopBits:    +s.stopBits || 1,
        parity:      s.parity || 'none',
        flowControl: s.flowControl || 'none',
        bufferSize:  4096,
      });
    } catch (e) {
      // keep the setup form up so the user can adjust settings and retry
      console.warn('[Serial] open failed:', e && e.name, '-', e && e.message);
      conn.phase = 'setup';
      conn.err = describeOpenError(e);
      renderList();
      return;
    }
    // reset framing buffers for a clean session
    conn.decoder   = new TextDecoder();
    conn.textBuf   = '';
    conn.hexBuf    = [];
    conn.hexOffset = 0;
    conn.alertBuf  = [];
    conn.phase     = 'open';
    conn.err       = null;
    conn.openedAt  = Date.now();
    conn.keepReading = true;
    saveDefaults(conn);
    emitSys(conn, 'Opened ' + conn.portLabel + ' @ ' + conn.settings.baudRate + ' baud, '
      + conn.settings.dataBits + fmtParity(conn.settings.parity) + conn.settings.stopBits
      + ', flow ' + conn.settings.flowControl + ' — mode: ' + MODE_LABEL[conn.mode], 'sys');
    conn.readLoopPromise = readLoop(conn);
    renderList();
  }

  function fmtParity(p) { return p === 'none' ? 'N' : p === 'even' ? 'E' : 'O'; }

  async function readLoop(conn) {
    while (conn.port && conn.port.readable && conn.keepReading) {
      const reader = conn.port.readable.getReader();
      conn.reader = reader;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.length) handleChunk(conn, value);
        }
      } catch (e) {
        emitSys(conn, 'Read error: ' + e.message, 'err');
      } finally {
        try { reader.releaseLock(); } catch (_) {}
        conn.reader = null;
      }
    }
    // loop exited: if we didn't ask to stop, the device went away
    if (conn.keepReading) {
      conn.keepReading = false;
      conn.phase = 'error';
      conn.err = 'Device disconnected';
      emitSys(conn, 'Device disconnected', 'err');
      flushPartials(conn);
      renderList();
    }
  }

  // Stop reading and release the OS port handle. Best-effort: every step is
  // guarded so it is safe to call in any state (never opened, open, or already
  // dropped). Used both by Close and as the clean-slate step before (re)opening.
  async function teardown(conn) {
    conn.keepReading = false;
    try { if (conn.reader) await conn.reader.cancel(); } catch (_) {}
    try { if (conn.readLoopPromise) await conn.readLoopPromise; } catch (_) {}
    conn.readLoopPromise = null;
    conn.reader = null;
    try { if (conn.writer) await conn.writer.close().catch(() => {}); } catch (_) {}
    conn.writer = null;
    // Only close if the port is actually open; closing a never-opened port
    // throws, and we want teardown to be a safe no-op in that case.
    try {
      if (conn.port && (conn.port.readable || conn.port.writable)) await conn.port.close();
    } catch (_) {}
  }

  async function closeConn(id, opts) {
    const conn = byId(id);
    if (!conn) return;
    await teardown(conn);
    flushPartials(conn);
    conn.phase = 'closed';
    emitSys(conn, 'Port closed', 'sys');
    if (!(opts && opts.silent)) renderList();
  }

  async function removeConn(id) {
    const conn = byId(id);
    if (!conn) return;
    if (conn.phase === 'open') await closeConn(id, { silent: true });
    const i = conns.indexOf(conn);
    if (i >= 0) conns.splice(i, 1);
    renderList();
  }

  function reopenConn(id) {
    const conn = byId(id);
    if (!conn) return;
    // reset counters for the new session; keep the scrollback
    conn.bytes = 0; conn.count = 0;
    openConn(id);
  }

  // ── incoming data handling ────────────────────────────────────────────────────
  function handleChunk(conn, u8) {
    conn.bytes += u8.length;
    if      (conn.mode === 'text')  handleText(conn, u8);
    else if (conn.mode === 'hex')   handleHex(conn, u8);
    else if (conn.mode === 'alert') handleAlert(conn, u8);
    scheduleStats(conn);
  }

  function handleText(conn, u8) {
    conn.textBuf += conn.decoder.decode(u8, { stream: true });
    let m;
    // split on CRLF, LF or lone CR
    while ((m = conn.textBuf.search(/\r\n|\r|\n/)) >= 0) {
      const line = conn.textBuf.slice(0, m);
      conn.textBuf = conn.textBuf.slice(m + (conn.textBuf.substr(m, 2) === '\r\n' ? 2 : 1));
      conn.count++;
      emit(conn, { ts: Date.now(), cls: 'rx', body: esc(line) || '&nbsp;', raw: line });
    }
    // don't let a newline-less stream buffer forever
    if (conn.textBuf.length > 8192) {
      conn.count++;
      emit(conn, { ts: Date.now(), cls: 'rx', body: esc(conn.textBuf), raw: conn.textBuf });
      conn.textBuf = '';
    }
  }

  function handleHex(conn, u8) {
    for (const b of u8) conn.hexBuf.push(b);
    while (conn.hexBuf.length >= 16) emitHexRow(conn, conn.hexBuf.splice(0, 16));
    scheduleFlush(conn);
  }

  function emitHexRow(conn, bytes) {
    const off = conn.hexOffset; conn.hexOffset += bytes.length;
    conn.count++;
    const hex = bytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = bytes.map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
    const offStr = off.toString(16).padStart(6, '0');
    const body = '<span class="ser-hex-off">' + offStr + '</span>'
      + '<span class="ser-hex-bytes">' + esc(hex) + '</span>'
      + '<span class="ser-hex-ascii">' + esc(ascii) + '</span>';
    emit(conn, { ts: Date.now(), cls: 'hex', body, raw: offStr + '  ' + hex + '  ' + ascii });
  }

  function handleAlert(conn, u8) {
    for (const b of u8) conn.alertBuf.push(b);
    while (conn.alertBuf.length >= 4) emitAlertFrame(conn, conn.alertBuf.splice(0, 4));
  }

  function emitAlertFrame(conn, bytes) {
    conn.count++;
    const hex = '0x' + bytes.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    const dec = Packets.decodeMessage(hex);
    let body, raw;
    if (dec.ok && dec.best) {
      const r = dec.results.find(x => x.format === dec.best);
      const st = Packets.stationName(r.values.A);
      const val = r.values.D !== undefined ? ' <span class="ser-alert-val">val ' + r.values.D + '</span>' : '';
      body = '<span class="ser-alert-hex">' + hex + '</span> '
        + '<span class="ser-badge ok">' + r.format.toUpperCase() + '</span> '
        + '<span class="ser-alert-id">ID ' + r.values.A + '</span>' + val + ' '
        + '<span class="ser-alert-stn' + (st.none ? ' none' : '') + '">' + esc(st.text) + '</span>'
        + ' <a class="ser-link" onclick="Serial.openInPackets(\'' + hex + '\')">details ▸</a>';
      raw = hex + '  ' + r.format.toUpperCase() + '  ID ' + r.values.A
        + (r.values.D !== undefined ? '  val ' + r.values.D : '') + '  ' + st.text;
    } else {
      body = '<span class="ser-alert-hex">' + hex + '</span> '
        + '<span class="ser-badge bad">no ALERT match</span>'
        + ' <a class="ser-link" onclick="Serial.openInPackets(\'' + hex + '\')">inspect ▸</a>';
      raw = hex + '  no ALERT match';
    }
    emit(conn, { ts: Date.now(), cls: 'alert', body, raw });
  }

  function scheduleFlush(conn) {
    if (conn.flushTimer) return;
    conn.flushTimer = setTimeout(() => { conn.flushTimer = null; flushPartials(conn); }, 300);
  }

  // Emit whatever bytes/text are held mid-frame — on idle, close or disconnect —
  // so slow trickle output isn't stuck waiting for a full row/line/frame.
  function flushPartials(conn) {
    if (conn.hexBuf && conn.hexBuf.length) emitHexRow(conn, conn.hexBuf.splice(0, conn.hexBuf.length));
    if (conn.textBuf) {
      conn.count++;
      emit(conn, { ts: Date.now(), cls: 'rx', body: esc(conn.textBuf), raw: conn.textBuf });
      conn.textBuf = '';
    }
    scheduleStats(conn);
  }

  function resync(id) {
    const conn = byId(id);
    if (!conn) return;
    conn.alertBuf.shift();                       // drop one byte to shift frame alignment
    while (conn.alertBuf.length >= 4) emitAlertFrame(conn, conn.alertBuf.splice(0, 4));
    emitSys(conn, 'Resynced — dropped 1 byte to shift ALERT frame alignment', 'sys');
  }

  function emitSys(conn, text, cls) {
    emit(conn, { ts: Date.now(), cls: cls || 'sys', body: esc(text), raw: text, sys: true });
  }

  // ── entry buffer + surgical DOM append ────────────────────────────────────────
  function emit(conn, entry) {
    conn.entries.push(entry);
    if (conn.entries.length > MAX_ENTRIES) conn.entries.splice(0, conn.entries.length - MAX_ENTRIES);
    if (conn.paused) return;
    const log = document.getElementById('ser-log-' + conn.id);
    if (!log) return;
    log.insertAdjacentHTML('beforeend', entryHtml(conn, entry));
    while (log.children.length > MAX_ENTRIES) log.removeChild(log.firstChild);
    if (conn.autoscroll) log.scrollTop = log.scrollHeight;
  }

  function entryHtml(conn, e) {
    const ts = conn.timestamps ? '<span class="ser-ts">' + fmtTime(e.ts) + '</span>' : '';
    return '<div class="ser-line ser-' + e.cls + '">' + ts + '<span class="ser-linebody">' + e.body + '</span></div>';
  }

  function fmtTime(t) {
    const d = new Date(t);
    const p = (n, w) => String(n).padStart(w || 2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3);
  }

  function repaintLog(conn) {
    const log = document.getElementById('ser-log-' + conn.id);
    if (!log) return;
    log.innerHTML = conn.entries.map(e => entryHtml(conn, e)).join('');
    if (conn.autoscroll) log.scrollTop = log.scrollHeight;
  }

  function scheduleStats(conn) {
    if (conn.statsPending) return;
    conn.statsPending = true;
    requestAnimationFrame(() => { conn.statsPending = false; paintStats(conn); });
  }
  function paintStats(conn) {
    const el = document.getElementById('ser-stats-' + conn.id);
    if (!el) return;
    el.textContent = statsText(conn);
  }
  function statsText(conn) {
    const unit = conn.mode === 'alert' ? 'frames' : conn.mode === 'hex' ? 'rows' : 'lines';
    const secs = conn.openedAt ? Math.max(1, (Date.now() - conn.openedAt) / 1000) : 1;
    const rate = conn.bytes ? ' · ' + Math.round(conn.bytes / secs) + ' B/s' : '';
    return conn.bytes.toLocaleString() + ' bytes · ' + conn.count.toLocaleString() + ' ' + unit + rate;
  }

  // ── toolbar actions ───────────────────────────────────────────────────────────
  function togglePause(id) {
    const conn = byId(id);
    if (!conn) return;
    conn.paused = !conn.paused;
    if (!conn.paused) repaintLog(conn);
    renderList();
  }
  function clearLog(id) {
    const conn = byId(id);
    if (!conn) return;
    conn.entries = [];
    repaintLog(conn);
  }
  function saveLog(id) {
    const conn = byId(id);
    if (!conn) return;
    const header = '# MegaNet Serial Monitor log — ' + conn.name + ' (' + conn.portLabel + ')\n'
      + '# ' + conn.settings.baudRate + ' baud, ' + conn.settings.dataBits + fmtParity(conn.settings.parity)
      + conn.settings.stopBits + ', mode ' + conn.mode + '\n';
    const lines = conn.entries.map(e => (conn.timestamps ? fmtTime(e.ts) + '  ' : '') + e.raw).join('\n');
    dlText('serial-' + slug(conn.name) + '.log', header + lines + '\n');
  }
  function toggleFlag(id, flag, val) {
    const conn = byId(id);
    if (!conn) return;
    conn[flag] = val;
    if (flag === 'timestamps') repaintLog(conn);
    if (flag === 'autoscroll' && val) { const log = document.getElementById('ser-log-' + id); if (log) log.scrollTop = log.scrollHeight; }
  }

  async function sendData(id) {
    const conn = byId(id);
    if (!conn || conn.phase !== 'open') return;
    const inp = document.getElementById('ser-send-' + id);
    const endSel = document.getElementById('ser-send-end-' + id);
    if (!inp) return;
    const text = inp.value;
    const end = endSel ? endSel.value : 'lf';
    const suffix = end === 'lf' ? '\n' : end === 'cr' ? '\r' : end === 'crlf' ? '\r\n' : '';
    try {
      if (!conn.port.writable) throw new Error('port is not writable');
      if (!conn.writer) conn.writer = conn.port.writable.getWriter();
      await conn.writer.write(new TextEncoder().encode(text + suffix));
      emit(conn, { ts: Date.now(), cls: 'tx', body: '<span class="ser-tx-arrow">»</span> ' + esc(text), raw: '» ' + text });
      inp.value = '';
    } catch (e) {
      emitSys(conn, 'Send failed: ' + e.message, 'err');
    }
  }

  function openInPackets(hex) {
    state.pkt.decInput = hex;
    state.pkt.lastDecode = hex;
    switchTab('packets');
  }

  // ── live setting binders (keep conn state current without a re-render) ─────────
  function setName(id, val) { const c = byId(id); if (c) c.name = val; }
  function setSetting(id, key, val) {
    const c = byId(id); if (!c) return;
    c.settings[key] = (key === 'baudRate' || key === 'dataBits' || key === 'stopBits') ? (parseInt(val, 10) || 0) : val;
  }
  function setMode(id, val) {
    const c = byId(id); if (!c) return;
    c.mode = val;
    const note = document.getElementById('ser-mode-note-' + id);
    if (note) note.textContent = MODE_HINT[val];
  }

  // ── disconnect handling ───────────────────────────────────────────────────────
  function hookDisconnect() {
    if (disconnectHooked || !supported) return;
    disconnectHooked = true;
    // A device being plugged in may newly appear in getPorts(): refresh so it
    // shows in the "Previously allowed" list ready to reconnect.
    navigator.serial.addEventListener('connect', () => { refreshKnownPorts().then(renderList); });
    navigator.serial.addEventListener('disconnect', e => {
      const conn = conns.find(c => c.port === e.target);
      if (conn) {
        if (conn.phase === 'open') {
          conn.phase = 'error';
          conn.err = 'Device disconnected';
          emitSys(conn, 'Device disconnected', 'err');
        }
        // Release our handle so a later reopen (after re-plugging) succeeds
        // instead of failing with "The port is already open".
        teardown(conn).then(() => renderList());
      }
      refreshKnownPorts().then(renderList);
    });
  }

  // ── rendering ─────────────────────────────────────────────────────────────────
  const MODE_LABEL = { text: 'ASCII text', hex: 'Hex dump', alert: 'ALERT decode' };
  const MODE_HINT = {
    text:  'Bytes are decoded as UTF-8/ASCII and split into lines on CR/LF.',
    hex:   'Raw bytes shown as a hex + ASCII dump (16 bytes per row) — best for inspecting binary framing.',
    alert: 'Every 4 bytes are decoded as a 32-bit ALERT payload (ABF/BCC/EAF/EIF) and matched to the station database. Use “Resync” to shift byte alignment if frames don’t line up. ALERT2 support is planned.',
  };

  function statusBadge(conn) {
    if (conn.phase === 'open')   return '<span class="ser-badge ok">● live</span>';
    if (conn.phase === 'closed') return '<span class="ser-badge">closed</span>';
    if (conn.phase === 'error')  return '<span class="ser-badge bad">● ' + esc(conn.err || 'error') + '</span>';
    return '<span class="ser-badge warn">not opened</span>';
  }

  function opt(val, label, cur) {
    return '<option value="' + val + '"' + (String(cur) === String(val) ? ' selected' : '') + '>' + label + '</option>';
  }

  function setupBody(conn) {
    const s = conn.settings;
    const portBtn = conn.port
      ? '<span class="ser-port-ok">✓ ' + esc(conn.portLabel) + '</span> '
        + '<button class="ghost" onclick="Serial.choosePort(\'' + conn.id + '\')">Change…</button>'
      : '<button class="ghost" onclick="Serial.choosePort(\'' + conn.id + '\')">Choose COM port…</button>';
    // Ports already granted in a previous pick — one click to reconnect without
    // the picker. Shown only before a port is chosen for this connection.
    const knownHtml = (!conn.port && knownPorts.length)
      ? '<div class="ser-known" style="margin-top:.4rem;font-size:.8rem">'
        + '<span style="opacity:.7">Previously allowed:</span> '
        + knownPorts.map((p, i) => '<button class="ghost" onclick="Serial.useKnownPort(\''
            + conn.id + '\',' + i + ')">' + esc(portLabel(p)) + '</button>').join(' ')
        + '</div>'
      : '';
    return ''
      + '<div class="ser-form">'
      + '  <label class="ser-f-name">Name'
      + '    <input type="text" value="' + esc(conn.name) + '" oninput="Serial.setName(\'' + conn.id + '\',this.value)">'
      + '  </label>'
      + '  <div class="ser-f-port"><label>COM port</label><div class="ser-port-row">' + portBtn + '</div>'
      + knownHtml
      + '    <div class="ser-port-status" id="ser-port-status-' + conn.id + '" style="font-size:.8rem;margin-top:.35rem"></div></div>'
      + '  <label>Baud rate'
      + '    <input type="number" list="ser-bauds" value="' + esc(s.baudRate) + '" min="1"'
      + '           oninput="Serial.setSetting(\'' + conn.id + '\',\'baudRate\',this.value)">'
      + '  </label>'
      + '  <label>Data bits'
      + '    <select onchange="Serial.setSetting(\'' + conn.id + '\',\'dataBits\',this.value)">'
      +        opt(8, '8', s.dataBits) + opt(7, '7', s.dataBits) + '</select></label>'
      + '  <label>Parity'
      + '    <select onchange="Serial.setSetting(\'' + conn.id + '\',\'parity\',this.value)">'
      +        opt('none', 'None', s.parity) + opt('even', 'Even', s.parity) + opt('odd', 'Odd', s.parity) + '</select></label>'
      + '  <label>Stop bits'
      + '    <select onchange="Serial.setSetting(\'' + conn.id + '\',\'stopBits\',this.value)">'
      +        opt(1, '1', s.stopBits) + opt(2, '2', s.stopBits) + '</select></label>'
      + '  <label>Flow control'
      + '    <select onchange="Serial.setSetting(\'' + conn.id + '\',\'flowControl\',this.value)">'
      +        opt('none', 'None', s.flowControl) + opt('hardware', 'Hardware (RTS/CTS)', s.flowControl) + '</select></label>'
      + '  <label>Display mode'
      + '    <select onchange="Serial.setMode(\'' + conn.id + '\',this.value)">'
      +        opt('text', 'ASCII text', conn.mode) + opt('hex', 'Hex dump', conn.mode) + opt('alert', 'ALERT decode', conn.mode) + '</select></label>'
      + '</div>'
      + '<p class="ser-mode-note" id="ser-mode-note-' + conn.id + '">' + MODE_HINT[conn.mode] + '</p>'
      + (conn.err ? '<p class="ser-err">Could not open port: ' + esc(conn.err) + '</p>' : '')
      + '<div class="ser-actions">'
      + '  <button class="primary" onclick="Serial.openConn(\'' + conn.id + '\')"' + (conn.port ? '' : ' disabled') + '>Open / Connect</button>'
      + '  <button class="ghost" onclick="Serial.removeConn(\'' + conn.id + '\')">Remove</button>'
      + '</div>';
  }

  function liveBody(conn) {
    const isOpen = conn.phase === 'open';
    const cfg = conn.settings.baudRate + ' baud · ' + conn.settings.dataBits + fmtParity(conn.settings.parity)
      + conn.settings.stopBits + ' · ' + MODE_LABEL[conn.mode];
    let tb = '<div class="ser-toolbar">';
    if (isOpen) {
      tb += '<button class="ghost" onclick="Serial.togglePause(\'' + conn.id + '\')">' + (conn.paused ? 'Resume' : 'Pause') + '</button>';
      if (conn.mode === 'alert')
        tb += '<button class="ghost" onclick="Serial.resync(\'' + conn.id + '\')">Resync</button>';
    } else {
      tb += '<button class="primary" onclick="Serial.reopenConn(\'' + conn.id + '\')">Reopen</button>';
    }
    tb += '<button class="ghost" onclick="Serial.clearLog(\'' + conn.id + '\')">Clear</button>';
    tb += '<button class="ghost" onclick="Serial.saveLog(\'' + conn.id + '\')">Save log</button>';
    if (isOpen) tb += '<button class="ghost" onclick="Serial.closeConn(\'' + conn.id + '\')">Close</button>';
    tb += '<button class="ghost" onclick="Serial.removeConn(\'' + conn.id + '\')">Remove</button>';
    tb += '<label class="ser-check"><input type="checkbox"' + (conn.timestamps ? ' checked' : '')
        + ' onchange="Serial.toggleFlag(\'' + conn.id + '\',\'timestamps\',this.checked)"> timestamps</label>';
    tb += '<label class="ser-check"><input type="checkbox"' + (conn.autoscroll ? ' checked' : '')
        + ' onchange="Serial.toggleFlag(\'' + conn.id + '\',\'autoscroll\',this.checked)"> autoscroll</label>';
    tb += '</div>';

    const stats = '<div class="ser-substats"><span class="ser-cfg">' + esc(cfg) + '</span>'
      + '<span class="ser-stats" id="ser-stats-' + conn.id + '">' + esc(statsText(conn)) + '</span></div>';

    const log = '<div class="ser-log' + (conn.mode === 'text' ? ' ser-log-text' : '') + '" id="ser-log-' + conn.id + '"></div>';

    let send = '';
    if (isOpen) {
      send = '<div class="ser-send">'
        + '<input type="text" id="ser-send-' + conn.id + '" placeholder="Send to device…"'
        + ' onkeydown="if(event.key===\'Enter\')Serial.sendData(\'' + conn.id + '\')">'
        + '<select id="ser-send-end-' + conn.id + '">'
        +   '<option value="lf">\\n (LF)</option><option value="crlf">\\r\\n (CRLF)</option>'
        +   '<option value="cr">\\r (CR)</option><option value="none">no line ending</option>'
        + '</select>'
        + '<button class="ghost" onclick="Serial.sendData(\'' + conn.id + '\')">Send</button>'
        + '</div>';
    }
    return tb + stats + send + log;
  }

  function connCardHtml(conn) {
    return '<div class="panel ser-conn ser-' + conn.phase + '" id="ser-card-' + conn.id + '">'
      + '<div class="ser-conn-head">'
      + '  <span class="ser-conn-name">' + esc(conn.name) + '</span>'
      + '  ' + statusBadge(conn)
      + '  <span class="ser-conn-port small">' + (conn.portLabel ? esc(conn.portLabel) : '') + '</span>'
      + '</div>'
      + (conn.phase === 'setup' ? setupBody(conn) : liveBody(conn))
      + '</div>';
  }

  function renderList() {
    const host = document.getElementById('serial-conns');
    if (!host) return;
    if (!conns.length) {
      host.innerHTML = '<div class="panel ser-empty"><p>No connections yet. Click '
        + '<strong>+ Add connection</strong> to choose a COM port and open a serial device.</p></div>';
      return;
    }
    host.innerHTML = conns.map(connCardHtml).join('');
    // repopulate live logs from each connection's retained scrollback
    conns.forEach(c => { if (c.phase !== 'setup') repaintLog(c); });
  }

  function render() {
    const bauds = '<datalist id="ser-bauds">' + BAUD_RATES.map(b => '<option value="' + b + '">').join('') + '</datalist>';
    let banner = '';
    if (!supported) {
      banner = '<div class="panel ser-warn"><h3>Web Serial isn’t available in this browser</h3>'
        + '<p>The Serial Monitor uses the <a href="https://developer.mozilla.org/docs/Web/API/Web_Serial_API" target="_blank" rel="noopener">Web Serial API</a>, '
        + 'which needs a Chromium-based browser — <strong>Chrome, Edge or Opera</strong> — served over <strong>https</strong> or from <strong>localhost</strong>. '
        + 'It is not supported in Firefox or Safari, or when this page is opened directly from a <code>file://</code> path.</p></div>';
    } else if (typeof location !== 'undefined' && !window.isSecureContext) {
      banner = '<div class="panel ser-warn"><h3>Not a secure context</h3>'
        + '<p>Web Serial only works over <strong>https</strong> or <strong>localhost</strong>. This page appears to be served insecurely, '
        + 'so opening a COM port will be blocked by the browser.</p></div>';
    }
    return '<div class="serial">' + bauds
      + '<div class="panel">'
      + '  <div class="panel-header"><h2>Serial Monitor '
      + '<span class="small" style="opacity:.55;font-weight:normal">build ' + SERIAL_BUILD + '</span></h2>'
      + '    <button class="primary" onclick="Serial.addConnection()"' + (supported ? '' : ' disabled') + '>+ Add connection</button>'
      + '  </div>'
      + '  <p class="sub">Connect physical serial devices to your computer’s COM ports and watch their output live. '
      + '     Open several devices at once — each connection has its own port, baud rate and framing, and its own display mode: '
      + '     plain <strong>ASCII text</strong>, a raw <strong>hex dump</strong>, or live <strong>ALERT</strong> binary decoding '
      + '     (ABF/BCC/EAF/EIF) cross-referenced to the station database. Click <em>+ Add connection</em>, choose a COM port, '
      + '     set the serial parameters, then <em>Open / Connect</em>.</p>'
      + '</div>'
      + banner
      + '<div id="serial-conns"></div>'
      + '</div>';
  }

  function init() {
    hookDisconnect();
    renderList();
    // Fill in the "Previously allowed" ports once the browser answers; keeps the
    // first paint instant and non-blocking.
    refreshKnownPorts().then(renderList);
  }

  return {
    render, init, addConnection, choosePort, useKnownPort, openConn, closeConn, removeConn, reopenConn,
    togglePause, clearLog, saveLog, toggleFlag, sendData, resync, openInPackets,
    setName, setSetting, setMode,
  };
})();

// Expose the module on `window` for parity with the other tab modules and for
// debugging from the console. NOTE: the built-in Web Serial `Serial` interface
// on `window` does NOT actually break the inline onclick handlers — a top-level
// `const Serial` lives in the global lexical environment, which name resolution
// consults before the global object, so `Serial.choosePort(…)` resolves to this
// module with or without this line. (An earlier fix wrongly blamed that global
// collision; the real "does nothing" reports trace to a silent NotFoundError or
// a stale, cached app.js — hence the visible status line and build stamp above.)
if (typeof window !== 'undefined') window.Serial = Serial;

// ── Bug / issue reporting ────────────────────────────────────────────────────
// MegaNet is a static GitHub Pages app: there's no server to POST an issue to
// and nowhere safe to keep an API token. So the report button gathers context
// and opens GitHub's own prefilled "New issue" page — the user reviews it and
// clicks Submit, and the issue lands on the project repo (GITHUB_REPO). A "Copy
// report" fallback covers anyone without a GitHub account: paste it into an
// email to the maintainer instead. Auto-collected diagnostics (which screen,
// data state, browser, and any captured errors) turn a vague "it broke" into
// something reproducible.
const BugReport = (function () {

  // ghLabel values are GitHub's built-in default labels, so the prefilled
  // ?labels= applies cleanly on a fresh repo.
  const TYPES = [
    { id: 'bug',         label: 'Something is broken', prefix: 'Bug',      ghLabel: 'bug' },
    { id: 'enhancement', label: 'Idea / improvement',  prefix: 'Idea',     ghLabel: 'enhancement' },
    { id: 'question',    label: 'Question',            prefix: 'Question', ghLabel: 'question' },
  ];

  // Snapshot of the user's current context. Ordered for readability in the issue.
  function collect() {
    const d   = state.data;
    const tab = TAB_LIST.find(t => t.id === state.activeTab);
    const sel = (d && state.selectedId) ? d.stations.find(s => s.id === state.selectedId) : null;
    return {
      'Screen':           tab ? `${tab.label} (${tab.id})` : state.activeTab,
      'Selected station': sel ? `${sel.name} — ${sel.station_number || sel.id}` : '(none)',
      'Data loaded':      d ? `yes — ${d.stations.length} stations, ${(d.radio_networks || []).length} networks`
                            : 'no',
      'App build':        APP_VERSION,
      'Theme':            state.theme,
      'Page':             location.href,
      'Browser':          navigator.userAgent,
      'Platform':         navigator.platform || '(unknown)',
      'Language':         navigator.language || '(unknown)',
      'Window size':      `${window.innerWidth}×${window.innerHeight} (screen ${screen.width}×${screen.height})`,
      'Online':           navigator.onLine ? 'yes' : 'no',
      'Time':             new Date().toString(),
    };
  }

  // Markdown block of the snapshot plus any captured runtime errors.
  function diagBlock() {
    let out = Object.entries(collect()).map(([k, v]) => `- **${k}:** ${v}`).join('\n');
    if (_errorLog.length) {
      out += '\n\n**Recent errors (newest last):**\n```\n'
        + _errorLog.map(e =>
            `[${e.at}] ${e.kind}: ${e.message}`
            + (e.where ? `\n    at ${e.where}` : '')
            + (e.stack ? `\n    ${e.stack.replace(/\n/g, '\n    ')}` : '')
          ).join('\n')
        + '\n```';
    } else {
      out += '\n\n_No JavaScript errors were captured this session._';
    }
    return out;
  }

  function template() {
    const typeOpts = TYPES.map(t => `<option value="${t.id}">${esc(t.label)}</option>`).join('');
    return `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="br-title"
           onclick="event.stopPropagation()">
        <div class="modal-head">
          <h2 id="br-title">Report a bug or idea</h2>
          <button class="modal-x" title="Close (Esc)" onclick="BugReport.close()">×</button>
        </div>
        <p class="sub">Tell us what happened. When you submit, MegaNet opens a pre-filled issue on the
           project's GitHub — just review it and click <em>Submit new issue</em>. No GitHub account?
           Use <em>Copy report</em> and email it to the maintainer instead.</p>

        <div class="modal-form">
          <label>What kind of report is this?
            <select id="br-type">${typeOpts}</select>
          </label>
          <label>What went wrong, or what would you like? <span class="req">*</span>
            <textarea id="br-desc" placeholder="e.g. Clicking a repeater on the Stations tab does nothing…"></textarea>
          </label>
          <label>What did you expect to happen? <span class="small">(optional)</span>
            <textarea id="br-expected" placeholder="e.g. The station's details should open on the right."></textarea>
          </label>

          <label class="check-inline">
            <input type="checkbox" id="br-include" checked>
            <span>Include diagnostic details <span class="small">(recommended — helps pinpoint the problem)</span></span>
          </label>

          <details class="diag-preview">
            <summary>Preview exactly what will be shared</summary>
            <pre class="diag-pre">${esc(diagBlock())}</pre>
          </details>
        </div>

        <div class="modal-foot">
          <button onclick="BugReport.close()">Cancel</button>
          <button onclick="BugReport.copy(this)">Copy report</button>
          <button class="primary" onclick="BugReport.submit()">Open GitHub issue ↗</button>
        </div>
      </div>`;
  }

  function open() {
    let root = document.getElementById('bugreport-modal');
    if (!root) {
      root = document.createElement('div');
      root.id = 'bugreport-modal';
      root.className = 'modal-overlay';
      root.onclick = close;   // click on the backdrop (outside the card) closes
      document.body.appendChild(root);
    }
    root.innerHTML = template();
    root.style.display = 'flex';
    document.addEventListener('keydown', onKey);
    const ta = document.getElementById('br-desc');
    if (ta) ta.focus();
  }

  function onKey(e) { if (e.key === 'Escape') close(); }

  function close() {
    const root = document.getElementById('bugreport-modal');
    if (root) { root.style.display = 'none'; root.innerHTML = ''; }
    document.removeEventListener('keydown', onKey);
  }

  function buildReport() {
    const type     = (document.getElementById('br-type')     || {}).value   || 'bug';
    const desc     = ((document.getElementById('br-desc')     || {}).value   || '').trim();
    const expected = ((document.getElementById('br-expected') || {}).value   || '').trim();
    const include  = (document.getElementById('br-include')   || {}).checked;
    const t        = TYPES.find(x => x.id === type) || TYPES[0];
    const tab      = TAB_LIST.find(x => x.id === state.activeTab);
    const screen   = tab ? tab.label : state.activeTab;

    const firstLine = desc.split('\n')[0].slice(0, 80);
    const title = `[${t.prefix}] ${firstLine || screen}`;

    let body = `**What happened / what's wanted**\n${desc || '_(none provided)_'}\n`;
    if (expected) body += `\n**Expected**\n${expected}\n`;
    body += `\n**Where:** ${screen} screen`;
    if (include) body += `\n\n---\n### Diagnostics\n${diagBlock()}`;
    body += `\n\n<sub>Reported from MegaNet ${APP_VERSION} via the in-app bug reporter.</sub>`;

    return { title, body, ghLabel: t.ghLabel, desc };
  }

  function issueUrl(labelOnly) {
    const r = buildReport();
    let url = `https://github.com/${GITHUB_REPO}/issues/new?labels=${encodeURIComponent(r.ghLabel)}`;
    if (!labelOnly) {
      url += `&title=${encodeURIComponent(r.title)}&body=${encodeURIComponent(r.body)}`;
    }
    return { url, report: r };
  }

  function submit() {
    const { url, report } = issueUrl(false);
    if (!report.desc) {
      alert('Please describe what went wrong or what you\'d like before submitting.');
      const ta = document.getElementById('br-desc'); if (ta) ta.focus();
      return;
    }
    // GitHub caps the length of a prefilled issue URL. If we're over a safe
    // budget, copy the report and open a blank issue so nothing typed is lost.
    if (url.length > 7500) {
      copyText(`${report.title}\n\n${report.body}`);
      alert('Your report is long, so it was copied to the clipboard instead of pre-filling GitHub. '
          + 'A blank new-issue page is opening — paste (Ctrl/Cmd+V) into the description.');
      window.open(issueUrl(true).url, '_blank', 'noopener');
    } else {
      window.open(url, '_blank', 'noopener');
    }
    close();
  }

  function copy(btn) {
    const r = buildReport();
    copyText(`${r.title}\n\n${r.body}`).then(ok => {
      if (!btn) return;
      const prev = btn.textContent;
      btn.textContent = ok ? 'Copied ✓' : 'Copy failed';
      setTimeout(() => { btn.textContent = prev; }, 1800);
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true, () => fallbackCopy(text));
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (_) { return false; }
  }

  return { open, close, submit, copy };
})();
if (typeof window !== 'undefined') window.BugReport = BugReport;
