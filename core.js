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
//   state                                            every mutable thing there is
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

// The left-hand nav, and the only description of it. Each tab carries an icon
// because the nav collapses to an icon rail, and a set of `find` words because
// twenty tabs is past the point where a rail of icons — or a column of labels
// — is something you scan.
//
// ── The grouping, and where it comes from (#108) ─────────────────────────────
//
// Three groups held these tabs until #108, and one of the three held eight of
// them: RF Environment, RF Changes, the Workbench, the Bit Flipper, Network
// View, ALERT Packets, ALERT2 and the Serial Monitor, under "Radio
// investigation". The heading was defensible — all eight are radio work — but a
// group you have to read end to end to use is a list, not a grouping, and by
// then a second group had quietly grown to seven.
//
// What settled it was not taste. `HELP[id].related` is this app's own statement,
// written a tab at a time and never with the sidebar in mind, of which tabs
// belong beside which. Read as a graph it does not describe three groups:
//
//   * The eight-tab group is two clusters with nothing mutual between them.
//     rf ↔ rfchanges ↔ workbench is a closed triangle. bitflipper ↔ network,
//     bitflipper ↔ packets, packets ↔ alert2, packets ↔ serial and alert2 ↔
//     serial are a second one. The *only* edges between the halves are
//     workbench → bitflipper and network → workbench, and both are one-way —
//     neither cluster claims the other back. That is two groups being described
//     as one.
//   * The seven-tab group is likewise two closed triangles — arro ↔ arrodata ↔
//     field, and inspections ↔ maintenance ↔ history — with *no* edge of any
//     kind between them. Reading a sensor trace and filling in a paper form had
//     been filed together on the strength of the word "data".
//   * Export is the one tab that moved further than its neighbours. Its
//     `related` entries are Network-group tabs, passranges ↔ export mutual
//     among them, and what it builds is scoped by the radio networks ticked on
//     its own left rail. It was under "Data & admin" and it belongs with the
//     network it exports.
//
// So: five groups, largest of them six tabs, each one a cluster the help text
// had already drawn. Group order runs outward from the file you loaded — what
// is out there, what is interfering with it, what it actually transmitted, what
// the sensors said, and what we did about it on site.
//
// ── Three tabs said "network" and meant three things ─────────────────────────
//
// "Network Maps" is not about networks: it browses the bundled Radio-path PDF
// map sheets, so it is **Radio Path Maps**. "Network View" is not about networks
// either: it draws ALERT addresses as nodes and bit-flip ghosting between them
// as edges — README §16 already calls it the ghosting knowledge graph — so it is
// the **Ghosting Graph**. Both old labels survive as `find` words — spelled as
// the two words they were, because the find box matches from the start of a
// word and `networkview` would only ever be reached by typing it as one — so
// the rename does not strand anyone who learnt the tab under its old name. Tab
// *ids* are untouched: they key HELP, renderMain(), the teardown registry and
// everything in localStorage.
//
// The third of the three, "Networks", is gone entirely. It was a read-only
// listing of the named radio-network clusters and the catchment vocabulary, and
// every number on it is already on a tab somebody is on anyway: the network
// each station belongs to is on its card and in the Stations filter pane, and
// the ticks that scope an export now live on the Export tab's own rail. A tab
// that repeats what is elsewhere still costs a row in the nav and a stop for
// every keyboard user walking it, so it was removed rather than kept for
// symmetry. `networks` as a *word* is not gone — it is a find term on the
// Stations and Export tabs, which is where the answer now is.
//
// ── `find`: the words nobody would think to look under the label ─────────────
//
// The jump box matches against the label, the group heading and these, so the
// list here is deliberately not a restatement of the label. It holds the words
// somebody would actually type — the job ("packet decoder", "com port"), the
// artefact ("csv", "pdf"), the vendor ("contrail", "elpro"), and the old name of
// anything renamed. Anything a person has called a tab out loud belongs here.
//
// ── Start here: the one group that is not part of the work ───────────────────
//
// The Site Map (site-map.js) is a guide to the other tabs, for somebody who has
// not met them yet: so it goes first, above the six groups the work runs
// through, under a heading that says what to do with it. Its find words are the
// ones a lost person types — "guide", "help", "what does each tab do" — and
// deliberately none that another tab owns: "user" and "new" would tie with
// Admin's users and RF Changes' new licences, and the tie goes to the first
// group, which is this one.
const TABS = [
  { group: 'Start here', tabs: [
    { id: 'sitemap',    label: 'Site Map',               icon: '🗂️',
      find: 'guide overview tour index directory contents orientation beginner introduction getting started help what does each every tab do explained' },
  ] },
  { group: 'Stations & networks', tabs: [
    { id: 'stations',   label: 'Stations',               icon: '📍',
      find: 'sites list map filters networks repeaters draw measure terrain elevation profile photos editor digital twin 3d lidar blender glb' },
    { id: 'maps',       label: 'Radio Path Maps',        icon: '🗺️',
      find: 'network maps navigator pdf printed sheets radio path basin catchment region queensland' },
    { id: 'passranges', label: 'Pass Ranges',            icon: '🔗',
      find: 'hop chain orphans gaps alertid address window coverage base' },
    { id: 'export',     label: 'Export',                 icon: '📤',
      find: 'csv radio mobile networks clusters download stations.json backup escape hatch data source' },
    { id: 'mapgen',     label: 'Map Generator',          icon: '🖨️',
      find: 'print paper a4 svg laser cut engrave k40 whisperer contour elevation layers billet plate title block scale bar graticule sheet' },
  ] },
  { group: 'Interference', tabs: [
    { id: 'rf',         label: 'RF Environment',         icon: '📶',
      find: 'acma licensed transmitters spectrum frequency carrier register nearby candidates strip plot' },
    { id: 'rfchanges',  label: 'RF Changes',             icon: '📈',
      find: 'acma register history new licences appeared changed timeline diff when' },
    { id: 'workbench',  label: 'Interference Workbench', icon: '🔬',
      find: 'case hypotheses scoring evidence checklist acma complaint site visit share' },
    { id: 'reception',  label: 'Reception Map',          icon: '📡',
      find: 'drive survey site survey candidate repeater base station site signal strength rssi coverage gps vehicle bad packets bit flip repeater triangulate where heard receptions' },
  ] },
  { group: 'ALERT', tabs: [
    { id: 'bitflipper', label: 'Bit Flipper',            icon: '🔀',
      find: 'flip alert address addresses ghosting variants corruption decimal cross-reference' },
    { id: 'network',    label: 'Ghosting Graph',         icon: '🧬',
      find: 'network view knowledge graph force layout nodes edges addresses collisions' },
    { id: 'packets',    label: 'ALERT Packets',          icon: '📦',
      find: 'decoder decode encoder encode erts message frame crc check bits hex payload spec' },
    { id: 'alert2',     label: 'ALERT2 / ERT-A2',        icon: '🛰️',
      find: 'erta2 elpro decode ports capture sample putty log watch follow drop' },
    { id: 'hfem',       label: 'HFEM Messages',          icon: '🌊',
      find: 'hydro field event message bom bureau meteorology decode paste site sensor scheme timestamp maintenance builder logger' },
    { id: 'serial',     label: 'Serial Monitor',         icon: '🔌',     needs: 'serial',
      find: 'com port web serial live stream terminal baud log quansheng radio uv-k5 rtl-sdr sdr usb dongle spectrum waterfall off air putty log file follow tail erta2 ert-a2 elpro alert2' },
  ] },
  { group: 'Data', tabs: [
    { id: 'arro',       label: 'ARRO Launcher',          icon: '🚀',
      find: 'contrail telemetry open station site raw id jump launch' },
    { id: 'arrodata',   label: 'ARRO Data',              icon: '📊',
      find: 'csv telemetry file chart plot sensor continuity 3-5-7 filter noise drop demo' },
    { id: 'field',      label: 'Field Data',             icon: '🌡️',
      find: 'readings telemetry datastore sensors chart plot window rainfall level quality' },
    { id: 'msglog',     label: 'Message Log',            icon: '📨',
      find: 'messages telemetry arrivals incoming ingest raw log fade margin ingress base pathway follow live decode calibration value volts battery converted' },
    { id: 'health',     label: 'Station Health',         icon: '🚦',
      find: 'monitoring maintenance o&m faults alarms battery trend voltage solar charge missed checks check signals timed reports silent quiet offline outage schedule repeater down receiver stopped base station network health data quality corrupted copies bit flips ghosts rain gauge blocked tipped level stuck flatline register unknown address agent ai claude briefing triage' },
  ] },
  { group: 'Site visits', tabs: [
    { id: 'inspections', label: 'Inspections',           icon: '🩺',
      find: 'form paper sheet checklist calibration draft photo configuration' },
    { id: 'maintenance', label: 'Site Maintenance',      icon: '🧰',
      find: 'council tasks form condition owner contact vegetation access' },
    { id: 'history',    label: 'Inspection History',     icon: '📋',
      find: 'past records read back print a4 csv timeline previous visits' },
    { id: 'photos',     label: 'Field Photos',           icon: '📷',
      find: 'pictures camera gps exif ocr overlay solocator geotag position heading upload bulk folder dropbox carousel unplaced' },
  ] },
  // Last, so it sits at the foot of the nav: nobody's daily work, and the one
  // group whose tab the header's load buttons and the Export tab's Data source
  // and snapshot panels moved into.
  { group: 'Admin', tabs: [
    { id: 'admin',      label: 'Admin',                  icon: '🛠️',
      find: 'administration users accounts people roles privileges permissions groups allowlist editors sign in access database datastore data source schema load stations.json github file snapshot backup settings storage reset migration dashboard health stats statistics visitors analytics last seen online active size tables volume connections' },
    { id: 'basestations', label: 'Base Stations',        icon: '🖥️',
      find: 'ingest points receivers fleet devices heartbeat check-in checking in uptime temperature under-voltage uplink queue remote manage restart reboot update upgrade release log ssh keys login maintenance team public key' },
  ] },
];

// Flattened, for the lookups that only care which tab is open (the bug
// reporter) and don't want to know how the nav happens to be grouped.
const TAB_LIST = TABS.flatMap(g => g.tabs);

// What a tab's own job needs from the browser (#223), for the tabs whose job is
// a device on a cable: a `needs` on the tab above names one of these. The nav
// marks such a tab where this browser lacks it — on a phone, or in Firefox or
// Safari anywhere — so the news comes before the tab is opened rather than
// after a button has been pressed; the tab's own banner says the rest.
// Asked of the browser itself, not guessed from the screen's width: a tablet
// with Chrome may have it, a desktop Firefox does not.
const TAB_NEEDS = {
  serial: {
    has: () => typeof navigator !== 'undefined' && 'serial' in navigator,
    why: 'needs Chrome, Edge or Opera on a computer, to reach a device on a cable',
  },
};

// '' when this browser can do what the tab is for, else why not, in words.
function tabCannot(t) {
  const n = t && t.needs && TAB_NEEDS[t.needs];
  return n && !n.has() ? n.why : '';
}

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
//   links    "read more": { label, href } out to docs/, href through docUrl();
//            or { label, call } to open something the app already has — see the
//            migrate-or-link note below for why both belong in one list
//   figure   { title, svg, steps[], caption } — a walkthrough, on the two tabs
//            that earn one. See the note below.
//
// `summary`, `watch`, `steps` and `svg` are authored HTML, not user input: they
// are written here and nowhere else, so they may carry <code>, <strong> and
// links, and the renderer deliberately does not escape them. Anything read from
// stations.json or typed by a user must not be interpolated into them.
//
// ── Walkthroughs: two of nineteen, on purpose (#105) ─────────────────────────
//
// A drawing goes in where "click here, then type this" genuinely beats a
// sentence, which is not most tabs. Two qualify, and both for the same reason:
// the thing being explained is a *shape* rather than a sequence of words.
//
//  * Stations — Draw & measure. The README needs forty lines of prose for it,
//    and the one fact that makes it click (a snapped line is named after the
//    two stations and carries its own distance and bearing) is a picture.
//  * Pass Ranges — the hop chain. An address window is an interval, "orphaned"
//    means falling outside every one of them, and both are drawings.
//
// The SVGs are inline and use the app's own CSS custom properties, so they
// repaint with the theme and quote the map's real colours — amber #ffc400 for a
// filter match, magenta var(--draw) for the sketch layer — rather than
// inventing a second palette for the help panel to be wrong in. Each carries a
// <title> and role="img": it is the only content in the panel that prose does
// not already carry, so a screen reader must not be handed an empty box.
//
// ── What stayed where it was, and why (#105's migrate-or-link decisions) ─────
//
// Four pieces of explanation were already embedded in the app before this panel
// existed. The decision for each was made rather than defaulted:
//
//  * The 357 filter explainer (#80) — **linked, not moved.** It is a wide modal
//    carrying two drawings, one of which is a worked example coloured by what
//    walk357() actually returns for those readings. Re-typing that into a
//    side-panel pane would produce a second, worse copy that drifts from the code;
//    the panel opens the real one instead (ArroData.explain()).
//  * docs/serial-help.html — **linked, not moved.** Its whole job is to be
//    forwarded to somebody's IT department, which needs a page with its own URL
//    and no MegaNet chrome around it. Text inside the help rail cannot be sent
//    to anyone.
//  * The ARRO id disambiguation in the station editor — **stays, and is
//    restated here.** The editor labels the two boxes at the moment somebody is
//    typing into one of them, which is where that warning works; the rule
//    itself ("db_id is ARRO's, number is BoM's") is short enough to also live
//    in the panel, and does, on both the Stations and ARRO Launcher tabs.
//  * The Stations filter pane's inline hints — **stay.** They are generated
//    per block from the loaded file (counts, the "not recorded yet" bucket's
//    size) so they cannot be lifted into a static string. What moved here is
//    the part that is *not* data-dependent and that the pane never says out
//    loud: that the box highlights rather than hides, and that a "not recorded
//    yet" bucket is ticked by default.
const HELP = {
  sitemap: {
    summary: 'A guide to the whole app for somebody new to it: how the screen is laid out, the '
           + 'groups the tabs are filed under and the order the work moves through them, a list of '
           + 'everyday jobs with the tab each one is done on, and a card for every tab saying what it '
           + 'is for and when you would reach for it. Point at a card, a job or a group — or move to '
           + 'its button with the keyboard — and a <strong>gold line</strong> runs from it to that '
           + 'tab\'s button in the bar on the left, so the next time you want it you know where it '
           + 'is. Press the button to go there.',
    watch: [
      'The line points at the bar on the left wherever it is. Shrunk to icons (« at its top), it '
      + 'points at the icon; on a phone, where the bar is put away behind <strong>☰</strong> in the '
      + 'banner, it points at ☰ instead.',
      'A card is a summary, not the manual. Each tab\'s own ❔ Help, in this side panel, says how '
      + 'that tab works in full — it changes as you change tabs.',
      'The words under each card\'s <em>Goes with</em> are the tabs its help names as related: '
      + 'the other places the same job is usually carried on. Point at one and the line goes to it.',
    ],
    related: ['stations', 'health', 'admin'],
  },
  stations: {
    summary: 'The map fills the page, and its cards sit beside it in the <strong>side panel</strong> '
           + 'on the right: press the red 📍 in the strip on its edge, under ❔, for the '
           + '<strong>Stations</strong> list with its filters, and the station details, '
           + 'one column that scrolls on its own; the blue 📍 under it for <strong>Find a place</strong>; '
           + 'and 〽️ for the path tools — the '
           + '<strong>radio path</strong> you clicked, the <strong>elevation profile</strong> and the '
           + '<strong>link budget</strong> with its fade margin — in a pane of their own; and, under 🧊 '
           + 'the digital twin, 🔭 the <strong>AR station finder</strong>. Press the '
           + 'button of the pane that is showing and the side panel shuts, giving the map the '
           + 'width; drag its left edge (or focus it and use the arrow keys) to make it wider or '
           + 'narrower. The map\'s own controls are in that strip too, below the side panel\'s own buttons, in groups with a '
           + 'hairline between them: what the map <em>shows</em> (🗺️ <strong>Map display</strong>, '
           + 'base maps first, and 🔑 the legend), the tools you point at it (✏️ <strong>Draw &amp; '
           + 'measure</strong>, 📡 <strong>Polar radio coverage</strong>, <strong>🗼 Repeater site '
           + 'finder</strong>, <strong>ℹ️ What is here</strong>), the <strong>3-D view</strong> (⛰️, 🎚️ '
           + 'its settings, and its camera), and how much screen the map gets (⛶ full screen). A panel '
           + 'among them opens as a pane of the side panel, the way 📍 does; a button does its one '
           + 'thing. The one control left on the map is <strong>↺ Reset</strong>, alone in its '
           + 'top-right corner: it clears the filters, the selection, every drawing and every card. '
           + '<strong>⛶ Full screen</strong> gives the map the whole window except the side panel, '
           + 'which stays beside it with the tools in it; Escape brings the page back. At or below '
           + '1,100 px, down to a phone\'s width, the cards are under the map in one long page and '
           + 'the side panel keeps the tools. On a phone the map fills the screen under the banner '
           + 'and the side panel is put away behind <strong>⋮</strong> at the top right: press it and '
           + 'the strip comes out as a rail down the right-hand edge, beside the map rather than on '
           + 'it, with ❔, the two 📍, 〽️ and the map\'s controls in it, and press it again to put the rail '
           + 'away. A pane opens as a drawer beside the rail — the cards and the path tools too — '
           + 'and pressing its button again, tapping the dimmed page or pressing Escape puts it '
           + 'away. The <strong>Stations</strong> card is the list and its filters in one: its head '
           + 'carries the live row count, the <strong>Filters</strong> toggle and + Propose and + New; '
           + 'under it the search box and the two clear buttons, then a line saying what the filters '
           + 'are doing and which station is selected, then the list. The filters drive the map and '
           + 'the list at once, and are built from whatever <code>stations.json</code> holds — every '
           + 'option carries the number of stations behind it, and nothing is offered that no station '
           + 'uses. <strong>Filters</strong> opens the whole panel in place of the search box. The '
           + 'heading shuts the list — it is the tallest thing there, and shutting it is how the '
           + 'editor gets onto one screen with the map — and leaves the search box and the notes. '
           + '<strong>Find a place</strong> (the blue 📍) takes the name of a town, a river or '
           + 'creek, a catchment or its basin number, a council area, or a coordinate, and lists what '
           + 'it means on the ground: the catchments and the rivers and council areas this network\'s '
           + 'stations are in, from the file, and the towns, localities, airports, rivers and '
           + 'boundaries OpenStreetMap knows. Press one and the map goes there, with a blue pin and '
           + 'its outline or course; the stations are left as they are. ✕ beside the box, or ↺, '
           + 'takes the pin away. '
           + 'Under the map the elevation profile and link budget follow the list; beside it they '
           + 'are the 〽️ pane, which opens by itself when you draw a line, click a radio path or '
           + 'ask for a link budget. The profile says how to draw a path until there is one. '
           + 'Selecting a '
           + 'station opens <strong>Repeaters listening</strong> between the list and the editor: '
           + 'every repeater with a pass range open to that station\'s addresses, nearest first. '
           + 'Clicking one puts the map on it and dims everything off its paths — the filters, the '
           + 'picked selection and the station being edited all stay where they are. At the foot of '
           + 'the editor, under ARRO, <strong>Inspections</strong> charts what that station\'s past '
           + 'visits measured — fade margin and battery under load to begin with, any of the other '
           + '35 recorded parameters on request — and the pill beside the heading opens the full '
           + 'records on the Inspection History tab with this station already in its filter box. '
           + 'That chart needs no sign-in; the records behind the pill do. Under the coordinate '
           + 'boxes, and on every station\'s map callout, is a row of pills: Street View, Google '
           + 'Earth and Apple Maps at that position, and searches of the <strong>FWIN</strong> and '
           + '<strong>OOHB</strong> document libraries for that station. Beside them, '
           + '<strong>Move pin on map</strong> and <strong>Copy lat, lon</strong> — the position as '
           + 'decimal degrees on the clipboard, ready to paste into a work order, a planning tool '
           + 'or a message to whoever is standing at the site. In the editor it copies what the two '
           + 'boxes say rather than what was last saved, so a pin you have just dragged or a figure '
           + 'you have just typed is what you get. In the editor\'s <strong>ALERT IDs / Sensors</strong> '
           + 'list, each row carries a <strong>Flip</strong> link that opens the Bit Flipper on that '
           + 'row\'s address — what else it could have been, one or more bit-flips away. It reads '
           + 'the address out of the box rather than off the saved record, so a row you have '
           + 'retyped sends you to the number on screen.',
    watch: [
      '<strong>The address bar says where you are</strong> — this tab, the station whose card is up '
      + 'and the map\'s view — so a bookmark, a reload or a link sent to somebody opens exactly this. '
      + '<strong>🔗 Copy link</strong> on a station\'s card copies one. Back and forward move between '
      + 'the tabs and the stations you opened; moving the map is not a step, so back never replays '
      + 'your pans. A link opens the station\'s card without selecting it — the card\'s own pills do that.',
      '<strong>From zoom 17 the map offers the station\'s digital twin</strong> — the ground to '
      + '1 m where the State holds LiDAR, the aerial imagery, the station as built and the radio paths '
      + 'as this map colours them — whenever a station is under the view: the one on the card, the '
      + 'selected one, or the nearest to the centre. It never jumps there by itself: a card on the map '
      + 'says what imagery covers the station (10 cm over most towns, and when it was flown) and '
      + '<em>Open the digital twin</em> hands the rectangle over. ← Map or Escape gives the map back at '
      + 'the same zoom; wheeling out steps one zoom out. <strong>🔍 Zoom to station</strong> goes all '
      + 'the way in, which is where the card appears, and <strong>🧊 Digital twin</strong> on a '
      + 'station\'s card opens its twin in one press. The switch is in 🗺️ Map display; ⛰️ 3-D is the '
      + 'same idea at network scale, and offers it at the same zoom.',
      '<strong>🧊 in the side panel\'s strip is the twin\'s pane</strong> — what the Digital Twin tab '
      + 'used to be: find a station and open its twin, the scene\'s settings (the patch, the '
      + 'exaggeration, the imagery, the cadastre, the horizon, the water, exploring together), the '
      + 'ground truth, the ground as numbers and the <code>.glb</code> for Blender. ⚙ Settings on the '
      + 'twin\'s own bar opens it. How the twin works is at the foot of the pane.',
      '<strong>3-D view</strong> — ⛰️ in the side panel\'s strip, or the panel of the same name — '
      + 'tilts the map onto the ground it is drawn on: the base map you are already on (the most opaque one, if you have blended several), draped over '
      + '~30 m terrain, with the pins and links you are already looking at on it. Drag to pan, '
      + 'right-drag (or Ctrl-drag, or two fingers) to tilt and rotate. It is the same map and the '
      + 'same controls, so a filter changed while it is tilted is the same filter — and the pins '
      + 'are still pins: click one and its card paints in the corner, click a repeater and its '
      + 'focus dim comes on, exactly as in 2-D. <strong>Elevation shading</strong> is draped on '
      + 'the terrain with its opacity slider and relief switch live, and <strong>ℹ️ What is '
      + 'here</strong> picks the ground the <em>camera</em> is looking at rather than the point '
      + 'underneath it on the flat map — which on a tilted view are not the same place, and can '
      + 'be kilometres apart. The one thing the tilted map cannot draw is the callout balloon on '
      + 'the pin itself. Press the mountain to tilt, and 🎚️ under it for everything about the '
      + 'tilt — and two more buttons appear under them '
      + 'while it is on: a <strong>compass</strong> that shows which way north has gone and puts '
      + 'you back facing it, and a <strong>tilt</strong> button that shows how far the camera has '
      + 'dropped, flattens it to straight down on one press and returns it to 62° on the next. '
      + 'Neither is offered on the flat map, where there is no camera to reset. Tick '
      + '<strong>Line-of-sight sheets</strong> and each hop also grows a vertical surface between '
      + 'its line of sight and the ground under it, green where the path clears the 60% Fresnel '
      + 'zone and red where the ground is above the line — the profile card\'s own geometry, so the '
      + 'two cannot disagree. Terrain is fetched for the view you are looking at and no further, '
      + 'and the sheets are capped at 80 hops at a time with the panel saying how many it left '
      + 'out: <em>an unsheeted hop is not a clear one</em>. Vertical exaggeration opens at 1×, '
      + 'which is the truthful setting; anything above it is a taller picture of the same ground, '
      + 'not more of it. And a terrain tile that will not load is said out loud rather than drawn '
      + 'flat, because flat ground between two stations reads as a clear path. One thing to know about the picture: <em>a pin behind a hill is hidden by it</em>. That is useful both ways round — a station you cannot see from a given point has no line of sight from it, and a station you are hunting for may be over the next ridge rather than missing.',
      'Three of the map\'s tools read the <strong>ground</strong> rather than the station list, '
      + 'and all three are indicative in the same way the elevation profile is — ~30 m terrain, '
      + 'heights above the EGM96 geoid, nothing standing on the ground. <strong>Elevation</strong> '
      + 'in the base-map picker paints the country by height, in the twelve bands of the Radio '
      + 'Mobile colour file, with the slopes shaded so a ridge is visible between two contours of '
      + 'the same colour; the shading can be switched off beside it. <strong>Highest ground in '
      + 'view</strong>, in <strong>Map display</strong>, pins the three to five highest points in '
      + 'the window — hilltops, not stations, whether or not anything is on them — and lists them '
      + 'ranked, each one a button that takes the map there. <strong>Polar radio coverage</strong> '
      + 'is Radio Mobile\'s own dialog: a centre unit, the radio at the other end, a link '
      + 'direction, a radial and azimuth range and a threshold, and it colours the ground by what '
      + 'a mobile would hear standing on it. That plot has <em>no antenna patterns, no trees and '
      + 'no terminal clutter</em>, every one of which only ever takes coverage away — so it is the '
      + 'best case, and the elevation profile card is the authority for any path you are about to '
      + 'build.',
      '<strong>🗼 Repeater site finder</strong> works the siting question the other way round: '
      + 'say which sites a new repeater has to serve — <em>Add the map selection</em>, '
      + '<em>Draw a circle</em> round them (Draw &amp; measure\'s own circle, so it stays on the map '
      + 'and can be typed to an exact radius), or paste a list of station numbers, names, ALERT '
      + 'addresses and <code>4021-4025</code> windows, with a <code>lat, lon</code> on its own line for '
      + 'a site that has no station yet — and <em>Find sites</em> returns the three to five best places '
      + 'nearby to put the mast. It screens every summit in a circle round the sites against every '
      + 'site over ~30 m terrain, then checks the best few the link budget card\'s way — 256 samples '
      + 'with the land cover on them — so the fade margin quoted for a result is the figure the card '
      + 'will show. Four sliders say what matters: <strong>elevation</strong>, <strong>line of '
      + 'sight</strong>, <strong>fade margin</strong> (the worse of the two directions) and '
      + '<strong>road reserve</strong>, asked of the Queensland cadastre for the finalists only — a '
      + 'mast on road reserve is rare and welcome, so it is a bonus and never a filter. Moving a '
      + 'slider re-ranks at once without re-running anything. Pick a result to draw its paths '
      + 'coloured by fade margin and list every site against it; <em>Profile the worst path</em> '
      + 'opens that path in the elevation profile, which remains the authority. Tick <em>Also score '
      + 'existing station sites</em> to weigh the masts already standing in the area against the '
      + 'bare hills — a site with power, a track and a willing landholder is worth metres. '
      + '<em>Everything else on the map</em> fades the network and every other layer — down to '
      + 'nothing — so the candidates and the sites stand out, each site keeping a dot and its name; '
      + 'the base map and the elevation keep their own sliders in Map display, and the fade only '
      + 'applies while there are sites or an answer, so Clear and ↺ put the map back. '
      + '<strong>🌏 Google Earth (KMZ)</strong> saves the whole answer for Google Earth on the '
      + 'web (earth.google.com, New → Import file to project): a folder per candidate with its '
      + 'numbered pin and its paths to every site, coloured by fade margin, #1\'s paths on and the '
      + 'others\' off so they can be compared one at a time, plus the sites and the search area; '
      + '<em>KML</em> is the same file as plain text, with Google\'s own numbered pins. In ⛰️ 3-D '
      + 'the search area, the rings, the chosen candidate\'s paths and the numbered pins stand on '
      + 'the terrain, and a pin click picks that candidate there too — only <em>Draw a circle</em> '
      + 'waits for 2-D, because its clicks land on the flat map.',
      '<strong>Find a place</strong> (the blue 📍 in the strip) is where a place is looked for, '
      + 'not the filter box — which filters the stations, and would have cut the network down to '
      + 'the stations named after a town while you were only looking for the town. Paste a '
      + 'coordinate into it — decimal, degrees and minutes, degrees-minutes-seconds, with or '
      + 'without hemisphere letters, in either order — and the map goes there and drops a blue '
      + 'pin, with no network at all. Type a name and it lists, at once and offline, the '
      + 'catchments (by name or basin number), and the rivers and creeks and the council areas '
      + 'this network\'s stations are on, each with how many; then, where the place-name service '
      + 'can be reached, the towns, localities, airports, rivers and boundaries it matches. A '
      + 'catchment is drawn in outline, a river along its course where OpenStreetMap has it, and a '
      + 'river from the file is the stretch its stations span. A lookup that cannot be made says '
      + 'so and leaves the rest of the list standing.',
      '<strong>🔭 AR station finder</strong> — on a phone, press <em>Look around</em> and hold the phone '
      + 'up: the stations the way it faces are pinned over the camera\'s picture, each with its type in '
      + 'a letter of its colour — <strong>F</strong> field (green), <strong>R</strong> repeater (blue), '
      + '<strong>B</strong> base (red). One pin a direction: the nearest station that way, named, with a '
      + 'count of how many more stand behind it. The slider sets how far out it looks, and the letters at '
      + 'the foot switch a type off. Tap a pin for the station\'s number, its ALERT IDs, how far and '
      + 'which way, the rest of that direction, and <em>Show on the map</em>. North is <em>true</em> '
      + 'north: the compass is corrected by the World Magnetic Model\'s declination, about 11° in '
      + 'Brisbane. Phone compasses are often 5–15° out — aim at a station you can see, tap its pin and '
      + 'press <em>I\'m facing it</em> to bring every pin into line. It shows what the map shows, so the '
      + 'map\'s filters apply. <em>From the map\'s centre</em> does the same without GPS or the camera; '
      + 'on a computer, drag or press ← and → to turn. The picture stays on the phone: nothing is '
      + 'recorded or sent.',
      '<strong>Limit link length</strong> caps how long a signal link may be before it stops being '
      + 'drawn — it culls the <em>drawing</em>, never the data. A hop you expected to see and '
      + 'cannot may simply be past the <em>Max TX distance</em> slider, which opens at 100 km; '
      + '🗺️ <strong>Map display</strong> (in the side panel\'s strip) says how many links were drawn and how '
      + 'many were culled, so check that before concluding the path isn\'t there.',
      'The strip belongs to the box the caret is in and goes when focus leaves it — the results '
      + 'are kept, so clicking back into the box brings the same strip back without a second '
      + 'lookup.',
      '<strong>Link colour</strong> is one radio group in <strong>Map display</strong>, not two '
      + 'switches: <em>By frequency</em> (the default), <em>By fade margin</em> or <em>Plain</em>. '
      + 'They cannot both be on because both want the same thing — the colour of a link\'s core '
      + 'line. Frequency is the default because it is <em>recorded</em> rather than computed: it '
      + 'is the rx frequency of the repeater on the link\'s end, so every link either has one or '
      + 'provably has not, the moment the file loads. A fade margin has to be swept over terrain '
      + 'first, and until it is, most links have no figure and no colour. The 🔑 legend lists '
      + 'every channel in the file with how many repeaters are on it. Line of sight is not in the '
      + 'group and does not need to be: it paints crimson over whichever colouring is running.',
      '<strong>Arrows along the links</strong> show which way the traffic runs — into the repeater '
      + 'that carries a field station, on to the base station from a repeater. A '
      + 'repeater-to-repeater backbone hop runs both ways and is drawn with a head at each end '
      + 'instead of a row of one-way arrows, and a backbone path\'s arrows are black like its '
      + 'dashes. They are a function of the zoom: nothing at all until about zoom 10, then '
      + 'growing and closing up as you go in. Out at a whole-state view direction is not the '
      + 'question anybody is asking, and a mat of chevrons over a dense network is the picture '
      + 'nobody wanted.',
      '<strong>Elevation shading</strong>, under <em>Overlay layers</em>, paints the ground itself '
      + 'in the Radio Mobile colour file\'s twelve height bands — over whichever base maps are '
      + 'on, with an opacity slider. It was a fifth base map until #186 and that was the '
      + 'wrong shape: picked as a base it took the localities, the roads and the watercourses '
      + 'with it, and the ground and the place names are not alternatives. The slider is what '
      + 'makes them one picture. Heights are above the EGM96 geoid at ~30 m sampling.',
      'The <strong>ℹ️ What is here</strong> button arms a pick: click anywhere on the map and a '
      + 'card in the map\'s bottom corner says what the app knows about that point — ground height, '
      + 'land cover, wind region, drainage basin, maintenance hub, and the nearest station, '
      + 'repeater and survey mark with the distance and bearing to each. Every one of those was '
      + 'already in the app and every one of them could only be asked about a <em>station</em>; '
      + 'this asks about the ground, which is the question siting actually starts from. Ground '
      + 'height there is a terrain tile above the EGM96 geoid, not a surveyed AHD figure like '
      + 'the one on a station\'s own card, and the card says so every time.',
      '<strong>Backbone paths</strong> are black dashes over the link colour, and they are of two '
      + 'kinds: two '
      + 'repeaters within the <em>Max TX distance</em> whose pass-range windows are open to at '
      + 'least one common ALERT address, and every repeater within that same distance of a base '
      + 'station — a base opens no window of its own to share, so on those the distance is the '
      + 'whole test. For backbone the slider is the <em>match</em> — moving it changes which '
      + 'pairs qualify, not just which are drawn. Clicking any radio path — field link or '
      + 'backbone — opens a card about that hop at the top of the path tools (〽️ in the side '
      + 'panel, or under the map), above the elevation profile and link budget it points at the '
      + 'same hop; × or Escape closes it. The dashes are what says <em>backbone</em>; the colour between them says '
      + 'whatever the link colouring says.',
      'The 🗺️ <strong>Map display</strong> panel has a <strong>Find a control</strong> box at the '
      + 'top of it. Type into it and the panel filters down to the rows that match — against the '
      + 'label, its note and its tooltip, so "wind", "dB", "contour" and "licence" all land '
      + 'somewhere. It filters what is drawn and switches nothing off; in the side panel the '
      + 'pane is the full height of the window, so there is plenty for it to filter.',
      'Where the station cards go follows the width of the window. Above 1,100 px they are in '
      + 'the <strong>side panel</strong> beside the map (📍, and 〽️ for the path tools), the map '
      + 'filling the height of the window and the cards scrolling on their own — the single '
      + 'column put the map\'s own answer below the fold, so reading it cost you the map. At or '
      + 'below 1,100 px they are under the map in one long page, because two 400 px columns are '
      + 'two things too narrow to read rather than two things in view. On a phone they are in the '
      + 'side panel again — 📍 and 〽️ in the rail that ⋮ brings out, each a drawer over the map — '
      + 'so that the map can have the whole screen. The side panel\'s width is '
      + 'yours: drag its left edge, or focus it and use the arrow keys, and it is remembered. The '
      + 'station list in the side panel carries five columns rather than ten — name, station '
      + 'number, roles, AlertID and <strong>SLS catchment</strong> — because ten of them in a '
      + '420 px pane is ten columns nothing fits in. The network, position, elevation, the enabled '
      + 'tick and the ARRO link are all on the station\'s card, which a click on any row opens; '
      + 'under the map the table has them back.',
      '<strong>Clear</strong> also clears the repeater focus — the dim that a click on a '
      + 'repeater pin puts over everything not on its own paths. Both are ways of saying "back to '
      + 'the whole network", so both buttons do both, and both are enabled by a focus even with no '
      + 'filter running.',
      '<strong>Include related repeaters</strong> widens the match itself rather than the drawing: '
      + 'repeaters whose pass ranges cover a matched station are pulled in even though they don\'t '
      + 'match the filter text. That is why the station count can exceed the number of rows your '
      + 'search would explain.',
      'The search box <strong>highlights rather than hides</strong>. Every station stays on the '
      + 'map; matches take an amber ring, get their names drawn, and the map zooms to fit them — '
      + 'so a pin still on screen has not necessarily matched anything. <em>Hide stations that '
      + 'don\'t match</em>, in the map\'s <strong>Map display</strong> panel, is the subtractive '
      + 'behaviour if '
      + 'that is what you want: it takes the pins <em>and the link lines that run to them</em>, so '
      + 'what is left is only the subset you filtered for. Tick <strong>Include related '
      + 'repeaters</strong> to bring the carriers — and their lines — back with it. Names are '
      + 'capped at 60 either way, and the panel says when the cap is in effect.',
      'A name is read <strong>both ways round</strong>. This file writes the same word two ways — '
      + '243 stations say <em>Ck</em> and 218 say <em>Creek</em>, 196 say <em>Rd</em> and 63 '
      + '<em>Road</em>, 117 <em>Mt</em> and 60 <em>Mount</em> — so typing either spelling finds '
      + 'both, and the same holds for St/Street (and St/Saint), Br/Bridge, Riv/River, Stn/Station, '
      + 'Res/Reservoir, Pk/Park, Rd/Road, Hwy/Highway and about a dozen more. An abbreviation only '
      + 'counts as one when it is the whole word, so <code>ck</code> reaches "Alligator Ck" '
      + 'without dragging in "Buckley" — though "Buckley" still answers to <code>ck</code> the way '
      + 'it always did, because this only ever <em>adds</em> matches. Punctuation between words is '
      + 'ignored too, so <code>mt. stuart</code> and <code>beerburrum woodford rd</code> both land. '
      + 'Two abbreviations are deliberately left out because this file means something else by '
      + 'them: <em>HW</em> is a dam or weir <strong>headwater</strong> rather than a highway, and '
      + '<em>AL</em>/<em>TM</em> mark an ALERT or telemetry station rather than naming the place. '
      + 'Station numbers are never expanded — they are digits, with no word in them to respell.',
      'The search box is a <strong>stack of entries</strong>, and each says what it is a list '
      + '<em>of</em>. With all three fields ticked — the default — a term is tried against the '
      + 'name, the station number and the ALERT addresses at once, which is right for one term '
      + 'and wrong for a pasted list: <code>491</code> starts ten addresses and sits inside four '
      + 'station numbers, so a column of addresses comes back with stations that merely share '
      + 'the digits. Untick what an entry is not, and press <strong>+ Add filter entry</strong> '
      + 'for a list that is something else. Entries combine as <em>any</em> (the default — two '
      + 'lists looked up at once) or <em>all</em> (a name and an address range as one question). '
      + 'An entry with no field ticked is ignored rather than matching nothing, and says so '
      + 'under itself.',
      'Every tick-box block ends with a <strong>Not recorded yet</strong> bucket, and it is ticked '
      + 'like everything else — which is why the opening view is the whole network. Most stations '
      + 'have no radio network recorded and two thirds have no catchment, so unticking one of '
      + 'those buckets removes most of the file rather than a fringe. Each block header says '
      + '<em>All</em>, <em>None</em> or <em>3 of 15</em>, so a collapsed block can never be '
      + 'quietly filtering the list.',
      'Saving a station edit needs a <strong>signed-in session</strong>, and is refused outright '
      + 'while the header says the list came from <code>stations.json</code> rather than the '
      + 'datastore — writing then would put a stale screen over whatever the database has since '
      + 'been told. Two people editing one station is <strong>refused, not merged</strong>: you '
      + 'are asked to reload rather than quietly overwriting somebody\'s afternoon, and a failed '
      + 'save never clears what you typed.',
      'The <strong>Inspections</strong> chart draws <strong>two axes and never a third</strong>. '
      + 'Volts and milliamps on one scale would draw a flat line under a mountain and imply they '
      + 'are comparable, so a parameter in a third unit is listed under the chart as <em>not '
      + 'drawn</em> rather than squeezed onto somebody else\'s scale — untick one to make room. '
      + 'Everything ticked is in <em>Readings as a table</em> underneath either way, drawn or not. '
      + 'A <strong>hollow marker</strong> is a visit the archive dates only to a month or a year: '
      + 'it is plotted at the start of that period, because a 1990 row is an event in 1990 and not '
      + 'the first of January. And calibration grids — the rain-gauge tip test, the shaft-encoder '
      + 'and receiver grids — are deliberately not on the parameter list: they are a grid per '
      + 'visit rather than one number, and they are read in full on the Inspection History tab.',
      '<strong>Move pin on map</strong> is how a coordinate gets fixed without typing one. It '
      + 'arms for the one station whose card is open — pins are not draggable otherwise, because '
      + 'a map you pan by dragging and 3,174 draggable pins is a gauge moved 40 m into a river by '
      + 'a mis-started pan. Drag the pin, or click the map where the station should be; the '
      + 'station\'s old pin stays put as a "was here" mark, with a dashed line to the new '
      + 'position and the distance between them on the panel. <em>Save position</em> puts the new '
      + 'coordinates in the two boxes on the form and saves the station exactly as the card\'s own '
      + 'Save would — so it needs the same signed-in session. <em>Cancel</em>, or Escape, leaves '
      + 'the station where it was. It works the same in <strong>⛰️ 3-D</strong> — the pin stands on '
      + 'the terrain and a click lands where the terrain is under the cursor, not where the flat map '
      + 'would put it — and <strong>inside the digital twin</strong>, where the pin is an amber post '
      + 'you drag across the ground with the State\'s finest imagery (10 cm over most towns) draped '
      + 'round it: the closest look this app has at where a station really stands.',
      'The two <strong>document searches</strong> do not send the station\'s name as written. A '
      + 'library search box requires <em>every</em> term to match, so a site filed as "Upper Sandy '
      + 'Ck" would be unreachable from a search that said "Creek" — the wrong half of the pair '
      + 'does not merely fail to help, it excludes every hit. So the link drops the telemetry '
      + 'suffix (<code>AL</code>, <code>TM</code>, <code>TBRG</code>) and the bracketed part of '
      + 'the name, and asks for the words that have two spellings as <em>either</em>: '
      + '<em>Upper Sandy Creek AL</em> is searched as '
      + '<code>upper sandy (creek OR ck OR crk)</code>. Ck/Creek, Rd/Road, Mt/Mount, Br/Bridge, '
      + 'St/Street and the rest are all handled that way. <strong>Hover a pill to see exactly '
      + 'what it will search for</strong> — and if a library turns out not to read the '
      + '<code>OR</code>s, that is the fastest way to tell, because the query is in the box when '
      + 'you land and can be edited there.',
      'The editor\'s two ARRO numbers are <strong>not the same number</strong>. <code>ARRO site '
      + 'id</code> is ARRO\'s own database key and the only one its URLs accept; <code>station '
      + 'number</code> is BoM\'s. The boxes sit side by side and are labelled, because handing '
      + 'ARRO the station number fails by opening somebody else\'s station rather than by '
      + 'erroring.',
      'Clicking a pin paints the <strong>station card</strong> in the map\'s bottom corner — '
      + 'the full details and every action, without changing the selection — and a gold '
      + '<strong>leader</strong> runs from the top of the card to a ring round the pin, so it is '
      + 'always plain which pin the card is about. The leader follows the pin as the map pans '
      + 'and zooms, and if the card opens over its own pin the map moves the pin clear. The '
      + 'card stays put while the filters change; <em>Station details</em> on it selects the '
      + 'station and jumps to its details card — in the side panel, or under the map when the '
      + 'cards are there. Picking a repeater in <em>Repeaters listening</em> puts the map on '
      + 'it and pulses a gold ring round its pin. On a phone a tap opens a small callout with '
      + '<em>Details &amp; actions</em> and <em>Copy lat, lon</em>, and the card opens as a '
      + 'sheet across the bottom of the map, with the leader up to the pin.',
      'The <strong>📍 pill</strong> in the map\'s top row, beside the zoom buttons, names the station '
      + 'whose card you last had up: press it and a card you closed comes back, and the stations '
      + 'you have looked at this session drop down under it, the latest first. Pick one and the map '
      + 'goes there, zoomed in, the station is selected and its card comes up. Looking at a station '
      + 'again — a pin, a row, its twin — moves it back to the top, so going back and forth between '
      + 'two keeps both at the head of the list. In the digital twin the pill is at the top of the '
      + 'view, beside the flood scale, and a pick takes the twin to that station. The list lasts '
      + 'as long as the browser tab does.',
      'A <strong>proposed station</strong> is where one is meant to go, not yet built. <strong>+ '
      + 'Propose</strong> under the station list opens one: a name, its <em>Station type</em> — an '
      + 'automatic or manual water level station, an automatic or manual rain gauge — the year it is '
      + 'proposed for (this year, or any year back or forward), and where it would go; '
      + '<strong>ℹ️ What is here</strong> offers <em>Propose a station here</em> at the point it was '
      + 'asked about. It needs no station number. Anybody who may edit may propose one; adding a '
      + 'station outright, and establishing a proposal (unticking <em>Proposed</em>), are an '
      + 'administrator\'s. A proposal is drawn hollow in a dashed ring, and is tagged '
      + '<em>Proposed</em> on its card, in the list and on the trail.',
      'A station the Bureau\'s Queensland flood warning station lists name has a <strong>Bureau '
      + 'flood warning details</strong> section on its card: which of the Bureau\'s indexes list '
      + 'it (FloodWarn rainfall, daily rainfall, river height), its AWRC number, the stream it '
      + 'is on and its URBS model label; the flood classes (minor, moderate, major, and the '
      + 'first-report, crops-and-grazing and towns heights where there are any), the crossing '
      + 'the gauge is read against, and the gauge zero with its datum, its '
      + '<abbr title="Adopted Middle Thread Distance">AMTD</abbr> — kilometres along the stream '
      + 'from its mouth up to the gauge — and the catchment area; and, under <em>Flood '
      + 'effects</em>, what each height on the gauge means on the ground. It shows what holds '
      + 'now, dated by the <em>Hdb snapshot</em> line under its heading, with minor, moderate '
      + 'and major a line each in green, yellow and red; earlier editions and earlier gauge '
      + 'levels are under <em>Earlier</em>. In the '
      + 'details card the same fields and lists are editable — one line per row, opened to '
      + 'edit, <strong>+ Add</strong> for the next edition, crossing, re-levelling or effect — '
      + 'and saved with the station.',
      'A station in the Queensland or New South Wales <strong>AEP flood level</strong> sheets has a '
      + '<strong>Flood levels (AEP)</strong> section too: the modelled water level in the 1%, '
      + '0.5%, 0.2% and 0.066% <abbr title="annual exceedance probability">AEP</abbr> floods '
      + '(about 1 in 100 to 1 in 1,500 years), the ground they stand over and the sheet\'s own '
      + 'confidence — all flagged <em>indicative</em>, because a model is talking. From them '
      + 'comes the <strong>Flood velocity</strong> line beside the wind region: an estimate by '
      + 'Manning\'s equation, in the channel and on the floodplain until somebody records which '
      + 'the station is, with its slope, roughness and depths under <em>How the velocity is '
      + 'worked out</em>. The setting, slope and roughness are editable on the AEP row in the '
      + 'details card.',
      'Every station in Queensland has a <strong>Site exposure — tides and soils</strong> section, '
      + 'asked of the Queensland Government\'s maps when its card opens: whether it is in or near '
      + 'tidal water, the nearest Water Act tidal limit, the coastal management district and storm '
      + 'tide areas, and the acid sulfate soil mapping under it, with a plain reading of what that '
      + 'means for what is built there — indicative, and a station outside Queensland is told the '
      + 'maps do not reach it (what each row means is in the link below).',
      'A station the Bureau\'s <strong>Service Level Specification</strong> (the SLS) for '
      + 'Queensland, or for New South Wales and the ACT, lists has a <strong>Flood warning '
      + 'service</strong> section as well: its flood class levels as the SLS gives them, whether '
      + 'somebody forecasts for it and how far ahead, its priority, who owns it and the Bureau\'s '
      + 'part in the site, and a <em>Manual — read by hand</em> pill on a gauge a person reads, '
      + 'which reports nothing over the radio. The NSW document also gives the gauge\'s datum — '
      + 'where it is AHD the levels are metres AHD — its AWRC number, and which classes the SES '
      + 'has not defined yet. The section\'s heading names the state and opens the Bureau\'s own '
      + 'copy of that document, a PDF, in a new tab; it is always the Bureau\'s current edition, '
      + 'and the heading names the edition the card\'s figures are from. A station on the border '
      + 'that both documents list has a section from each, since they do not always agree.',
      'Repeaters and base stations carry <strong>Frequencies</strong>: the repeater\'s own RX/TX '
      + 'pair is the primary — the one the path, fade and ACMA tools use — and <strong>+ Add '
      + 'frequency</strong> in the details card adds a row for every other channel, with its use '
      + 'and ACMA licence. The card lists them a line each.',
      'The 🗺️ <strong>Map display</strong> panel starts with the <strong>base maps</strong>: tick '
      + 'more than one and give each its own opacity to blend them — Satellite at 40% over '
      + 'OSM-Topo puts the contours on the real ground — and each is drawn over the ones listed '
      + 'above it; drag a row\'s ⠿ grip (or focus it and use the arrow keys) to change the order. '
      + 'The mix and the order are remembered. Below that the panel holds more than fits its first screenful — '
      + 'LiDAR contours, wind regions, line-of-sight checks, survey marks, ACMA licensing — '
      + 'and the legend\'s last line names whichever of them are currently off.',
    ],
    figure: {
      title: 'Draw & measure',
      svg: `
      <svg viewBox="0 0 300 176" role="img" aria-labelledby="fig-draw-t fig-draw-d">
        <title id="fig-draw-t">Drawing a measured path between two stations</title>
        <desc id="fig-draw-d">A line snapped between a field station and a repeater, carrying its
          own length and bearing, with a circle drawn beside it to an exact radius.</desc>
        <circle cx="68" cy="48" r="25" fill="none" stroke="var(--draw)" stroke-width="1.6"
                stroke-dasharray="4 3"/>
        <line x1="68" y1="48" x2="93" y2="48" stroke="var(--draw)" stroke-width="1.4"/>
        <circle cx="68" cy="48" r="1.8" fill="var(--draw)"/>
        <text x="72" y="43" font-size="8.5" text-anchor="middle" fill="var(--draw)">25 km</text>
        <line x1="58" y1="126" x2="228" y2="64" stroke="var(--draw)" stroke-width="2.2"
              stroke-linecap="round"/>
        <g transform="rotate(-20 143 95)">
          <text x="143" y="71" font-size="9" text-anchor="middle" fill="var(--draw)"
                font-weight="600">Mt Stuart &#8594; Durikai</text>
          <text x="143" y="83" font-size="9" text-anchor="middle" fill="var(--draw)">42.1 km @ 073&#176;</text>
        </g>
        <circle cx="58" cy="126" r="11" fill="none" stroke="#ffc400" stroke-width="1.6"
                stroke-dasharray="3 3"/>
        <circle cx="58" cy="126" r="5.5" fill="var(--role-field)" stroke="#fff" stroke-width="1.6"/>
        <text x="58" y="150" font-size="9" text-anchor="middle" fill="var(--muted)">field station</text>
        <circle cx="228" cy="64" r="7.5" fill="var(--role-repeater)" stroke="#fff" stroke-width="1.6"/>
        <text x="228" y="44" font-size="9" text-anchor="middle" fill="var(--muted)">repeater</text>
      </svg>`,
      steps: [
        'Open <strong>Draw &amp; measure</strong> from the ✏️ in the side panel\'s strip and pick '
        + '<em>Line</em>. The cursor becomes a crosshair and clicks pass through the pins to the '
        + 'map underneath, and the panel stays open beside the map while you work. (On a phone the '
        + '✏️ is in the rail that ⋮ at the top right brings out, and its panel is a drawer over the '
        + 'map: pick <em>Line</em>, then tap the dimmed map beside the drawer to put it away and '
        + 'draw — the tool stays armed.)',
        'Click near one station, then near the other, and double-click (or <em>Finish</em>) to end '
        + 'the line. Within about 15 px of a pin the click <strong>snaps</strong> to that '
        + 'station\'s exact coordinates — the ring in the drawing is what says the next click will.',
        'The line now carries its own length and bearing, and is named after the two stations '
        + 'rather than after two lat/lon pairs.',
        'Type over its numbers in the list to make it exact — a radius of <code>25</code> km, or a '
        + 'bearing and a distance instead of a second coordinate. Typing releases the shape from '
        + 'whatever it was snapped to.',
        '<strong>&#127758; KML &#11015;</strong> at the top of the panel hands the whole drawing to '
        + 'Google Earth — every shape in the colour it was drawn in, and a pin for each station a '
        + 'circle or a box encloses or a line runs between. Each shape lists the stations it holds, '
        + 'and each of those stations lists the shapes it is in.',
      ],
      caption: 'A two-point line also feeds the elevation profile and the link budget under the '
             + 'map. Esc cancels the shape in progress; Esc again puts the tool away. Nothing here '
             + 'is saved — reloading clears it — so a drawing worth keeping goes out as a KML.',
    },
    links: [{ label: 'Who may edit, and what to do when nobody can get in', href: 'docs/access.md' },
            { label: 'Site exposure on the station card — what each row means, its sources and limits',
              href: 'docs/site-exposure.md' }],
    related: ['passranges', 'maps', 'inspections'],
  },

  maps: {
    summary: 'Browses the bundled Radio-path PDF maps by region, and suggests the relevant map for '
           + 'a given station. The Queensland basin drawing is clickable — pick a basin, or a '
           + 'region chip, to filter the list down to it. Type a station name, ALERT address or '
           + 'site number instead and it lists the stations that match with the maps they are '
           + 'likely to be on.',
    watch: [
      'A suggested map is a <strong>suggestion</strong>. Only a station carrying a recorded radio '
      + 'network gets an authoritative answer; for everything else the station\'s coordinates are '
      + 'projected onto the basin drawing, and that projection is a least-squares fit averaging '
      + 'about <strong>34 km</strong> of error. Near a basin boundary it will name the wrong '
      + 'catchment, which is exactly why the result is not written back into the station file as '
      + 'data.',
      'The maps are <strong>PDFs shipped with the app</strong>, not a live layer — they are as '
      + 'current as the day they were drawn, and nothing on the Stations map feeds them. This tab '
      + 'works with no station file loaded at all; only the search half needs one.',
    ],
    related: ['stations'],
  },

  passranges: {
    summary: 'Which repeaters have a pass range covering a station\'s AlertIDs, and the hop chain '
           + 'that follows: field → repeater(s) → base. Stations no repeater covers are flagged as '
           + 'orphans, and AlertIDs that fall between every window are flagged as gaps. One filter '
           + 'box drives both tables, and takes a name, a station number, an address or a pasted '
           + 'list of them.',
    watch: [
      '<strong>Orphaned usually means unrecorded, not unserved.</strong> A station is orphaned '
      + 'here when no repeater\'s <em>recorded</em> pass ranges cover any of its addresses — and '
      + 'only 88 stations in the file carry a pass-range block at all. A site plainly reporting '
      + 'every day can still be listed here; what that is evidence of is a repeater whose windows '
      + 'nobody has written down.',
      'A station is only treated as a repeater when it <strong>carries pass ranges</strong>. An '
      + 'entry tagged <code>repeater</code> with no pass-range block is a field station that was '
      + 'mis-tagged on import, and it is left out of the matching rather than matching nothing.',
      'On an address search the <strong>one range that picked the station up is marked</strong>, '
      + 'which is the question this tab is usually open for. Matched stations are pulled to the '
      + 'front of the "first 10" in each row, so the mark is visible on a repeater kept because of '
      + 'a station eighty names down the list.',
    ],
    figure: {
      title: 'What a pass range is',
      svg: `
      <svg viewBox="0 0 300 150" role="img" aria-labelledby="fig-pr-t fig-pr-d">
        <title id="fig-pr-t">A hop chain, and the address windows behind it</title>
        <desc id="fig-pr-d">A field station hops through a repeater to a base station; below, two
          address windows on a number line, with one address falling outside both and so
          orphaned.</desc>
        <line x1="52" y1="30" x2="128" y2="30" stroke="var(--map-line)" stroke-width="2"/>
        <line x1="172" y1="30" x2="248" y2="30" stroke="var(--map-line)" stroke-width="2"/>
        <circle cx="38" cy="30" r="6" fill="var(--role-field)" stroke="#fff" stroke-width="1.5"/>
        <circle cx="150" cy="30" r="8" fill="var(--role-repeater)" stroke="#fff" stroke-width="1.5"/>
        <circle cx="262" cy="30" r="7" fill="var(--role-base)" stroke="#fff" stroke-width="1.5"/>
        <text x="38" y="50" font-size="8.5" text-anchor="middle" fill="var(--muted)">field</text>
        <text x="150" y="50" font-size="8.5" text-anchor="middle" fill="var(--muted)">repeater</text>
        <text x="262" y="50" font-size="8.5" text-anchor="middle" fill="var(--muted)">base</text>
        <text x="150" y="72" font-size="9" text-anchor="middle" fill="var(--text)">forwards these address windows:</text>
        <line x1="20" y1="104" x2="280" y2="104" stroke="var(--border)" stroke-width="1.5"/>
        <rect x="34" y="96" width="64" height="16" rx="3" fill="var(--role-repeater)" opacity=".22"
              stroke="var(--role-repeater)" stroke-width="1.2"/>
        <text x="66" y="128" font-size="8.5" text-anchor="middle" fill="var(--muted)">1001–1199</text>
        <rect x="126" y="96" width="58" height="16" rx="3" fill="var(--role-repeater)" opacity=".22"
              stroke="var(--role-repeater)" stroke-width="1.2"/>
        <text x="155" y="128" font-size="8.5" text-anchor="middle" fill="var(--muted)">2400–2499</text>
        <line x1="238" y1="92" x2="238" y2="116" stroke="var(--bad)" stroke-width="2"/>
        <text x="238" y="128" font-size="8.5" text-anchor="middle" fill="var(--bad)">6128</text>
        <text x="238" y="88" font-size="8.5" text-anchor="middle" fill="var(--bad)">orphaned</text>
      </svg>`,
      steps: [
        'A repeater forwards an address only if that address falls <strong>inside one of its '
        + 'windows</strong>, and outside every one of its exclusions. Nothing else decides it — '
        + 'not distance, not which network the station is on.',
        'So the hop chain is arithmetic over intervals: put an address in the filter box and the '
        + 'row that comes back is every repeater whose windows contain it, with the covering '
        + 'window marked.',
        'An address covered by no window anywhere is <strong>orphaned</strong> — the red mark. '
        + 'That is the tab\'s headline count, and the caveat above is what it usually means.',
      ],
      caption: 'Windows are inclusive at both ends and a repeater may carry any number of them. '
             + 'Two distant sites sharing one window is normal and is why the Stations map caps '
             + 'how long a drawn link may be.',
    },
    related: ['stations', 'bitflipper', 'export'],
  },

  rf: {
    summary: 'Licensed transmitters near each repeater that could be stepping on it, read out of '
           + 'the ACMA register. Pick a repeater and the candidates are ranked against it, with a '
           + 'frequency strip plot of every licensed carrier around its RX channel and a helper '
           + 'for testing whether your corruption timestamps cluster in business hours.',
    watch: [
      '<strong>The register only knows what is licensed.</strong> An unlicensed transmitter, a '
      + 'faulty one splattering outside its allocation, a spurious emission and an amateur '
      + 'operator are all invisible here, and any of them can be the actual cause. An empty '
      + 'candidate list is not a clean site.',
      'A score <strong>ranks, it does not measure</strong>. Line-of-sight is not yet assessed, so '
      + 'every candidate carries the same 0.7 factor for it — a transmitter with a mountain in the '
      + 'way scores exactly like one you can see. Open the card to read the components rather than '
      + 'trusting the total.',
      'Only repeaters with a <strong>recorded RX frequency</strong> can be anchored on, which is '
      + '88 of them. A repeater absent from the picker has not been cleared; it has no frequency '
      + 'on file, and backfilling <code>rx_mhz</code> is the highest-value data task this layer '
      + 'has.',
    ],
    related: ['rfchanges', 'workbench', 'stations'],
  },

  rfchanges: {
    summary: 'What changed on the air, and when, from the same ACMA register. Use it to line a '
           + 'station going bad up against something new appearing near it.',
    watch: [
      'Register dates are <strong>administrative</strong>. An authorisation date is an upper bound '
      + 'on when a transmitter could have come on air, not the day it did — licences are often '
      + 'authorised well before anything is switched on.',
      'A single extract can never show a <strong>removal</strong> or a prior value, so the timeline '
      + 'answers "what appeared" and only the snapshot diffs answer "what changed". The diffs start '
      + 'at the second archived month — nothing before the first one is observable, and a month '
      + 'nobody captured can never be recovered, because ACMA publishes today\'s register rather '
      + 'than a back catalogue.',
      'A new carrier is often <strong>not the one on your frequency</strong>. Adding one device to '
      + 'a mast forms a new third-order product with every carrier already on it, and the tool '
      + 'reports which of those products are new — the offender can be nowhere near 151.5 MHz.',
    ],
    related: ['rf', 'workbench'],
  },

  workbench: {
    summary: 'Works one interference case end to end. Name the affected stations and the analysis, '
           + 'the candidate transmitters and a suggested next check are assembled around them. Five '
           + 'competing explanations are scored in parallel and the losing ones stay on screen, '
           + 'because which hypothesis is <em>second</em> is most of what decides the next site '
           + 'visit.',
    watch: [
      'It never says <strong>cause</strong>, and that is a rule rather than a hedge — it says '
      + '"most consistent with", shows the arithmetic behind every score, and names the one '
      + 'observation most likely to change the answer. A confound it can see, it states: your '
      + 'affected stations usually share both a repeater and a patch of ground.',
      'The <strong>misattribution check runs first</strong>, before anything else is presented. '
      + 'Two "affected" stations whose ALERT addresses are one bit apart may be one real victim '
      + 'and one ghost of the same corrupted packets — which would change the selection the whole '
      + 'case is built on. Flagged pairs link straight into the Bit Flipper.',
      'The repeater hypothesis is only as good as the <strong>pass-range data</strong>, and much '
      + 'of it is missing. The Workbench reports per case how many of your affected stations have '
      + 'no routing at all rather than quietly scoring them as unexplained.',
      'A saved case lives in <strong>this browser</strong>, and sharing one means sharing a URL '
      + 'with the whole investigation encoded in it — the station sets, the onset date and the '
      + 'symptom all travel in the link.',
    ],
    related: ['rf', 'rfchanges', 'bitflipper', 'reception'],
  },

  reception: {
    summary: 'What the receivers heard, where, and how strongly — and which transmitter is sending '
           + 'bad packets. Every frame a Quansheng, RTL-SDR or ERT-A2 card hears is logged with its level '
           + 'and the receiver\'s position, and every base station\'s <strong>stored readings</strong> '
           + 'can be read in too; bad copies are laid against the repeaters whose pass ranges could have '
           + 'carried them.',
    watch: [
      '<strong>It works without moving.</strong> A bad copy of an address can only have come through a '
      + 'repeater that passes that address, so even one fixed receiver narrows the field: blame is split '
      + 'among the possible repeaters, and the one common to several stations\' bad copies collects it.',
      '<strong>Positions sharpen it.</strong> With a GPS card on the Serial Monitor (any USB GPS puck) or a '
      + 'phone\'s location, bad copies get louder nearer the repeater sending them; the table gives the '
      + 'correlation and the map shows where they were loudest. A drive past the suspects is the test.',
      '<strong>Each packet is read in its context.</strong> A station\'s own two sensors in one burst '
      + 'are never a flip of each other; between two stations\' addresses, the frame in line with its own '
      + 'address\'s other reports is the original and the other its ghost, and two that are both in line '
      + 'are both kept; a gauge tipping through a storm is reporting. The stored readings carry no '
      + 'position, so each is placed by the area its receiver hears — enough to rule out repeaters out of '
      + 'reach.',
      'It <strong>narrows; it does not convict</strong>. Two stations with nearby addresses and no other '
      + 'reports to set them against can still look like a flip, a missing pass range hides a path, and no '
      + 'repeater delays are recorded yet, so timing is not used. Confirm on site.',
      'Receptions are <strong>kept in this browser</strong> and, from a receiver sending to Flood-Net, in '
      + 'the database (editors only — they say where a vehicle was). Export a drive as CSV or GeoJSON '
      + 'and load it on another computer.',
      '<strong>Site surveys</strong> (editors): an RPi ALERT base station left at a candidate repeater or '
      + 'base-station site for a day or three, network or not, sends what it heard there when it is next '
      + 'on a network. Pick one under <em>Site surveys</em>: each station it heard, how many of the '
      + 'transmissions the network stored from it the site caught while listening, what the site heard '
      + 'that no base station stored, and its signal and SNR — with a line on the map from the site to '
      + 'each station, coloured by how much got through.',
    ],
    links: [{ label: 'The Reception Map and a vehicle rig', href: 'docs/reception-map.md' }],
    related: ['health', 'serial', 'workbench', 'bitflipper', 'network'],
  },

  bitflipper: {
    summary: 'What else could this ALERT address have been? Flips one bit up to N bits of a decimal '
           + 'address and cross-references every variant against the station file, live as you type. '
           + 'Two ways in: the address box here, or the <strong>Flip</strong> link on any sensor row '
           + 'in the station editor, which arrives with that row\'s address already entered.',
    watch: [
      'Flipping more bits is combinatorial — <code>C(16, N)</code> variants. Past two or three bits '
      + 'the useful view is <em>show only matched addresses</em>; the render cap is there to stop '
      + 'the table, not to tell you the search finished.',
      'An ALERT address is <strong>only unique within a region</strong>: 614 of the file\'s 5,122 '
      + 'addresses belong to more than one station. So a variant that matches is a candidate, and '
      + 'a variant matching two stations 1,200 km apart is the normal case rather than a data '
      + 'error.',
      'The <strong>ARRO base URL</strong> box on this tab is not local to it — its host drives '
      + 'every ARRO link in the app, including the launcher\'s and the ones in map popups. A base '
      + 'that will not parse falls back to the default rather than producing a broken link.',
    ],
    related: ['network', 'packets', 'passranges'],
  },

  network: {
    summary: 'The Bit Flipper\'s question asked of the whole file at once: ALERT addresses are '
           + 'nodes, a ghosting relationship between two of them is an edge, and the answer is '
           + 'drawn as a force layout with a geographical map beside it. What can be filtered and '
           + 'coloured by is generated from the data, so a new sensor type or network appears here '
           + 'without anybody adding a checkbox.',
    watch: [
      '<strong>Two kinds of edge in one graph, deliberately.</strong> A plain line is arithmetic — '
      + 'these two addresses are one bit apart, which is symmetric and true of ~23,700 pairs. An '
      + 'arrow is an observation with an evidence file behind it. The only question worth asking '
      + 'is which of the arithmetic pairs was ever actually seen ghosting, and separating them '
      + 'into two views would have hidden it.',
      'A node that resolves to no station in the loaded file is <strong>drawn grey and dashed, not '
      + 'dropped</strong> — a confirmed relationship pointing at an address the station file has '
      + 'never heard of is a finding. Where several stations claim one address and the evidence '
      + 'names none of them, that end is left unresolved rather than attributed to whichever came '
      + 'first.',
      'The graph draws the <strong>first 400 matching nodes</strong> and says how many matched. '
      + 'The cap is drawing cost, not arithmetic — filter down rather than reading the picture as '
      + 'the whole answer.',
    ],
    related: ['bitflipper', 'stations', 'workbench'],
  },

  packets: {
    summary: 'Decodes and encodes ALERT / ERTS messages against the Bureau\'s <em>ERTS Data '
           + 'Formats</em> specification. Paste a 40-bit framed message, a 32-bit payload or eight '
           + 'hex digits and it is tried against every known format, with check bits and CRC '
           + 'validated and framing polarity detected. A colour-coded bit map shows which bits '
           + 'belong to which field.',
    watch: [
      'Several formats can decode the same bits — the one highlighted is the <strong>best '
      + 'match</strong>, being the one whose check bits and CRC all pass, not the only reading. '
      + 'The others stay on screen for that reason.',
      '<strong>A2C is decode-only, and its integrity claim is thin.</strong> It is offered for '
      + '32-bit input alone: the four-byte form an address and value take inside an ALERT2 '
      + 'concentration payload, with no framing and no CRC — just a status byte that reads zero on '
      + 'every valid record seen. Whole serial lines of it belong on the ALERT2 tab.',
      'A decoded address is matched against the <strong>loaded Flood-Net file first</strong> (shown '
      + 'with a badge) and only then against the bundled 2021 national address list. An address is '
      + 'unique within a region and not nationally, so a name here is a candidate rather than an '
      + 'identification.',
    ],
    links: [{ label: 'ERTS Data Formats — the specification this decodes against',
              href: 'docs/BOM spec erts_data_formats_doc.pdf' }],
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
      '<strong>The two ports do not carry the same information</strong>, so which one a capture '
      + 'came off decides what you can ask of it. The USB binary framing is the only one carrying '
      + '<strong>RSSI</strong>; the RS232 ASCII line is the only one carrying the receiver\'s own '
      + 'clock. The tab sniffs which it was handed rather than asking, and says what is missing '
      + 'instead of inventing it.',
      'A log can be <strong>watched as it grows</strong>: drag it onto the tab from File Explorer. That still '
      + 'works where a policy has switched the browser\'s file picker off, and <em>Watch a log file…</em> says '
      + 'so when it has. For a live dashboard of the same decode, the Serial Monitor\'s ERT-A2 card follows '
      + 'a log, or the unit\'s port, the same way.',
      'Addresses matching exactly one station are what <strong>fix where a capture is</strong>, '
      + 'and an ambiguous address is then resolved to whichever candidate is near them. Two '
      + 'stations 6 km apart carrying the same addresses cannot be told apart by anything in the '
      + 'frame, so those are reported as ambiguous rather than guessed.',
      'On an ASCII capture the summary reports the gap between the receiver\'s clock and the '
      + 'network\'s frame time — a <strong>clock skew</strong> of hours is an AM/PM error on the '
      + 'unit rather than a decode fault. A binary capture has no receiver clock in it to compare, '
      + 'and says so.',
    ],
    related: ['serial', 'packets'],
  },

  hfem: {
    summary: 'Decodes the Bureau of Meteorology\'s Hydro Field Event Message format — the ASCII '
           + 'name-value line a logger pushes when a sensor trips or an inactivity timer expires. '
           + 'Paste one or a whole capture; each is decoded, matched to a station where the site '
           + 'number allows it, and reported honestly where it cannot be.',
    watch: [
      '<strong>The <code>T3</code> timestamp is the one to check.</strong> Its offset is the hours '
      + 'to <em>add</em> to reach UTC, which is the opposite of ISO 8601 and of every convention a '
      + 'reader is likely to have met: <code>20100727130000-10</code> is 03:00 UTC, not 23:00. The '
      + 'tab always shows the resolved instant beside the stamp as written so the arithmetic can '
      + 'be checked by eye, and it badges a computed UTC as computed.',
      '<strong>Raw and translated are different claims.</strong> Scheme <code>R_1-0</code> and '
      + 'scheme <code>R_1-6</code> both say rainfall: one is an integer counter whose engineering '
      + 'meaning is a site configuration that is <em>not in the message</em>, the other is '
      + 'millimetres as the logger scaled them. Nothing here converts a counter — a value shown '
      + 'with a unit was transmitted with that unit.',
      '<strong><code>M=1</code> is a property of the message, not of a reading.</strong> It means '
      + 'the station was in maintenance and the spec\'s meaning is "do not use this in '
      + 'production" — a technician may have been tipping the gauge. It is drawn as a banner '
      + 'across the whole message rather than as a column, because a column is what the eye skips.',
      'A raw counter carries the ceiling it wraps at, and the tab flags one within 5% of it. A '
      + 'rainfall counter at 2,043 of 2,047 is about to roll, and "the counter wrapped" and "the '
      + 'sensor jumped" are the same two numbers if you find out afterwards.',
      '<strong>HFEM has no checksum.</strong> The <code>|NN:</code> footer is the only integrity '
      + 'check the format has, so a structurally faulty line is rejected outright with the '
      + 'decoder\'s reason rather than half-decoded — a truncated message with three of five '
      + 'sensors intact must not land three readings. Every other message in the capture decodes '
      + 'independently of it.',
    ],
    related: ['alert2', 'packets', 'msglog'],
    links: [
      { label: 'HFEM ingest — the wire formats and what the bridge does with them', href: 'docs/ingest-hfem.md' },
      { label: 'BoM HFEM v1.0 — the specification this decoder implements', href: 'archive/BoM HFEM v1.0.pdf' },
    ],
  },

  serial: {
    summary: 'Streams live output from serial devices over the browser\'s Web Serial API — as many '
           + 'ports at once as the machine has, each an independent card with its own settings. A '
           + 'Quansheng radio on the ALERT receiver firmware becomes a dashboard with its own controls, '
           + 'an ELPRO ERT-A2 decodes as it arrives, and an RTL-SDR stick (Blog V2, V3 or V4, over WebUSB — '
           + 'or on a Raspberry Pi, read through PuTTY\'s log) decodes ALERT off the air itself. Where the '
           + 'browser will not open a port, a card follows the log file PuTTY writes instead.',
    watch: [
      '<strong>No Web Serial? Use PuTTY\'s log.</strong> Open the port in PuTTY with logging on '
      + '(Session → Logging → <em>All session output</em>) and <strong>drag the log file onto the tab</strong> '
      + '— or the folder it logs into, to follow its newest file. It is read every second as it grows, and '
      + 'that works where IT has switched off both Web Serial and the browser\'s file picker. Picking the file '
      + 'with an ordinary file dialog cannot do it: the browser refuses to read a picked file again once it has '
      + 'changed. A followed card only listens — PuTTY holds the port — so a radio\'s console buttons copy '
      + 'their command for pasting into PuTTY.',
      '<strong>A card can be a base station.</strong> <em>Send to Flood-Net</em> on a Quansheng, ERT-A2 or '
      + 'RTL-SDR card posts every reading it decodes into the database, with an ingest token for this '
      + 'computer, tagged with the receiver so its readings can be told from every other ingest point\'s. '
      + 'With no GPS, its location is approximate — the browser\'s, a station\'s, typed in, or the middle '
      + 'of the stations it hears — and is recorded as approximate. A reading from a log\'s history goes '
      + 'only with a time of its own, and a demo never sends.',
      'An <strong>RTL-SDR needs the computer to let go of it</strong> before the browser can '
      + 'have it: the WinUSB driver on Windows (the card\'s one-click installer, or Zadig — '
      + 'without it the stick is not even in the list), the DVB-T driver unloaded on Linux, '
      + 'nothing on a Mac — the same step rtl_sdr and SDR# need. Where that cannot happen — WebUSB '
      + 'off by policy, no administrator — <strong>put the stick on a Raspberry Pi</strong>: it decodes with '
      + 'the same code and prints what it hears on a serial port, for PuTTY to log and the card to follow. '
      + 'Gain is ADC headroom, not SNR: keep the histogram\'s end bins empty.',
      'ALERT Binary has <strong>no checksum</strong>. Off the air, a reading is only as good as '
      + 'its votes, and a strong burst can throw a one-bit ghost — the card reports those as '
      + 'shadows, not stations. Check the agency\'s own feed before acting on a value.',
      'Web Serial is a Chromium-only API, and it is refused outright on a page that is not '
      + 'HTTPS or localhost. A managed browser can also have it switched off by policy, in which '
      + 'case nothing on this tab will work until IT changes that — the linked page is written to '
      + 'be forwarded to them.',
      'A <strong>policy block looks nothing like a refusal</strong>: the port chooser is rejected '
      + 'instantly, without ever appearing. The tab reads that instant rejection as policy rather '
      + 'than as somebody cancelling the dialog, and says so — if you never saw a dialog, the '
      + 'machine said no, not you.',
      '<strong>Capture keeps running while you are on another tab.</strong> The connections live '
      + 'outside the page\'s render cycle, and the log is repainted from a capped scrollback when '
      + 'you come back — so a long unattended capture loses its oldest lines rather than its '
      + 'newest. <em>Save log</em> before <em>Clear</em>, and before the buffer laps.',
    ],
    links: [
      { label: 'Serial Monitor — what to ask IT for, and following PuTTY\'s log meanwhile', href: 'docs/serial-help.html' },
      { label: 'The Quansheng ALERT radio card', href: 'docs/serial-radio.md' },
      { label: 'A receiver card as a base station — tokens, tagging, location', href: 'docs/ingest-serial-monitor.md' },
      { label: 'The RTL-SDR card — sticks, drivers, and a hardware checklist', href: 'docs/serial-sdr.md' },
      { label: 'An RTL-SDR on a Raspberry Pi — for a PC that cannot reach USB', href: 'docs/sdr-pi.md' },
    ],
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
      '<strong>390 of 3,174 stations have no ARRO site id on file</strong>, and those degrade '
      + 'explicitly rather than silently: the search lists them with <em>none recorded</em> in the '
      + 'site-id column, map popups omit the link instead of rendering a dead one, and the editor '
      + 'says where the id would have come from. Nothing here invents one.',
      'The box also takes a <strong>pasted ARRO URL of any shape</strong> — an admin page, a '
      + '<code>devices[]=site|device</code> graph link, or a bare <code>3318|2</code> pair — and '
      + 'shows which ids it read out of it before you commit to opening anything.',
    ],
    related: ['arrodata', 'stations', 'bitflipper'],
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
      'The <strong>3/5/7 thresholds are in counts, not millimetres</strong>. A rain accumulator '
      + 'transmits tips; what a tip is worth is the gauge\'s bucket size, which is a separate fact '
      + 'the filter never sees. Setting a threshold as though it were millimetres is the quiet way '
      + 'to throw away a real record.',
      '<strong>Only two of the six filters are the specification\'s.</strong> The 3-5-7 test and '
      + 'rollover correction come from it; rate of rise, rate of fall, minimum/maximum and the '
      + 'repeat-collapsing minimum gap are this app\'s, run before the continuity walk, and each '
      + 'has its own switch so you can read the difference straight off the counts. '
      + '<strong>Rise and fall are two filters with two figures</strong>, because the fastest '
      + 'credible fall at a site is rarely the fastest credible rise — and an accumulator does not '
      + 'normally want the fall one at all, since it cannot fall except by wrapping or by '
      + 'corruption, which the rollover and 357 tests already own.',
      'Raw is <strong>never overwritten</strong> — filtering only produces a parallel verdict '
      + 'against each reading, every rejection can be clicked for the row and the reason, and the '
      + '<em>verdict</em> export is the artifact to keep when the question is what was thrown away.',
      'A file that will not link to a station still <strong>parses and plots</strong>. The link is '
      + 'read out of ARRO\'s own filename, so a renamed export falls back to the station number '
      + 'and then to saying plainly that it is not linked.',
      '<strong>Readings as a table</strong>, under the chart, is the same numbers without a mouse: '
      + 'one row per series for the window on screen, then the individual readings with the '
      + 'filter\'s verdict against each, marked with the same symbol the chart draws for it. It is '
      + 'capped at 300 rows and says when it has capped; <strong>⛶ Full screen</strong> raises the '
      + 'cap to 3,000 and gives the table the window, and the two export buttons are the uncapped '
      + 'answer.',
      '<strong>Readings can be edited, and the edits live only in this browser tab.</strong> Set '
      + '<em>Drag does</em> to <b>Select</b> and lasso a stretch (or tick rows in the table, or '
      + 'press <b>all in view</b>), then set a value, move the selection by an amount, scale it, '
      + 're-code its quality, drag it up or down on the chart, or delete it. The 357 walk re-runs '
      + 'on every change, so a spike deleted here stops dragging its neighbours down immediately, '
      + 'and both <b>Export</b> buttons write what is on screen. <strong>Nothing is written back '
      + 'to ARRO</strong> and closing the tab loses the lot — an edited series says so in the rail '
      + 'and carries a <em>revert</em> that puts its values back as loaded. Deleted rows do not '
      + 'come back.',
      '<strong>Demo data</strong> in the drop zone loads a real ARRO export shipped with the app; '
      + 'the list beside it picks which. <b>Durikai</b> is Durikai\'s rain accumulator, seven '
      + 'months, 14,942 readings, uncleaned — the file the filters were written against: 8,831 '
      + 'repeat timestamps, 395 values ARRO wrote with a thousands separator in an unquoted field, '
      + 'and the single-reading spikes to 1234 that read as rollovers unless the 357 walk removes '
      + 'them first. <b>Tyalgum Bridge</b> loads with the filter settings it was reviewed with '
      + '(3-5-7 at 3/5/8, rise and fall limits of 4 mm/h, quality codes DD, PD, ND and AN left '
      + 'out, a 0–1024 range) already set; <em>defaults</em> in the Filters panel undoes them.',
      '<strong>Mark</strong> on the chart toolbar has one tick per kind of mark — the 357 ✕, the '
      + 'range square, the rise and fall triangles, the quality diamond, repeats and rollover '
      + 'seams — so a flood of one kind can be switched off to see the others. Each kind is drawn '
      + 'up to 25,000 marks in the window; past that the chart names which kinds were capped, and '
      + 'zooming in shows the rest.',
      '<strong>Flood classes</strong> and <strong>AEP levels</strong>, ticked on a level series\' '
      + 'card, draw its station\'s minor, moderate and major lines and its modelled AEP levels '
      + 'across the chart, labelled, in the legend and in the PNG — each <strong>in the series\' '
      + 'own datum</strong>. The classes are metres on the gauge and the AEP levels metres AHD, so '
      + 'one or the other is carried across the gauge zero, and only a zero surveyed in AHD: where '
      + 'there is none, those lines are left off and the card says why. Whether the readings are '
      + 'on the gauge or in AHD comes from their unit, then the sensor; the card says which it '
      + 'took, a box overrules it, and it warns when the readings look like the other one. The '
      + 'vertical axis fits the readings and names any level beyond them along that edge; '
      + '<em>stretch the axis</em> takes it over them all.',
    ],
    links: [
      { label: 'How the 357 filter works — the test, drawn', call: 'ArroData.explain()' },
      { label: 'Hydrology Raw Data Filtering — the specification (v2.1, 2009)',
        href: 'docs/Hydrology Raw Data Filtering Program Specification.pdf' },
    ],
    related: ['arro', 'field', 'stations'],
  },

  field: {
    summary: 'Plots readings that field stations sent us, out of the Flood-Net datastore, using the '
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
      + 'conversion the datastore recorded is shown beside the count, never instead of it — which '
      + 'is also why a level drawn in counts gets no <strong>flood class</strong> lines: those are '
      + 'metres, and are drawn only against readings that are.',
      'A window with nothing in it says so rather than drawing an empty axis — silence and a run '
      + 'of zeroes are different claims.',
      '<strong>Raw readings age out; the rollups do not.</strong> Ninety days back is as far as '
      + 'individual readings go before the hourly and daily rollups are all that is left of them — '
      + 'which is why a wide window is drawn from rollups and why the header says so. Nothing is '
      + 'lost silently, but "Raw" over last winter will come back empty.',
      'The same reading arrives more than once — one transmission heard direct and via two '
      + 'repeaters is three copies — and the store <strong>counts the duplicates rather than '
      + 'discarding them</strong>. That count is the only place this network\'s real path '
      + 'redundancy is visible.',
      '<strong>Readings as a table</strong>, under the chart, is the same numbers without a mouse — '
      + 'the ARRO Data tab\'s, unchanged, and capped at 300 rows with the cap stated.',
    ],
    links: [
      { label: 'How the 357 filter works — the test, drawn', call: 'ArroData.explain()' },
      { label: 'Posting readings over HTTP — for whoever configures the logger',
        href: 'docs/ingest-http.md' },
      { label: 'Posting readings over MQTT, and knowing which stations went quiet',
        href: 'docs/ingest-mqtt.md' },
    ],
    related: ['arrodata', 'msglog', 'health', 'stations', 'alert2'],
  },

  msglog: {
    summary: 'The arrival log: every message the datastore accepted, newest first, one row per '
           + 'reading — who sent it, on what address, the raw value that arrived, and the pathway '
           + 'in (protocol, transport, ingress point, duplicate copies). Filter by window, by a '
           + 'pasted list of stations or addresses, by protocol or path; tick rows to map their '
           + 'stations in the tray above the table; open a row for the whole '
           + 'record and its decode. <strong>Follow</strong> re-asks every 30 seconds, which is '
           + 'the mode for standing in a paddock waiting for a test transmission to land.',
    watch: [
      '<strong>Raw is the headline column because raw is the truth.</strong> The value the device '
      + 'transmitted is always shown. <strong>Value</strong> beside it is the datastore\'s own '
      + 'conversion when it recorded one, and otherwise worked out here from what the register '
      + 'says the address is: a battery count ÷ 10 is volts (133 is 13.3 V), a rain gauge\'s '
      + 'count × its bucket is millimetres — a running total, not a fall. A worked-out value has '
      + 'a dotted underline and says so; one that cannot be what the sensor is (a 187 V battery) '
      + 'carries ⚠. A <strong>water level stays a raw count</strong>: its scale is set per site '
      + 'and nothing in Flood-Net records it, and a number invented here would read like a '
      + 'measurement.',
      'The <strong>narrow view is a reading aid, not the record</strong>. It opens with the '
      + 'field set — time, station, address, raw value — and the Columns button decides what '
      + 'each view keeps, remembered on this device per view. Export CSV always writes every '
      + 'column of every fetched row, whatever the views are hiding.',
      '<strong>One row is one reading, not one transmission.</strong> The datastore deduplicates '
      + 'on address, instant and value, and counts the further copies — so a reading heard '
      + 'direct and via two repeaters is one row saying ×3, and the copies\' paths are in the '
      + 'detail drawer. That count is the network\'s real path redundancy, visible nowhere else.',
      '<strong>Freq, Signal and SNR are how the kept copy was heard</strong> — when the base '
      + 'station said: a Raspberry Pi and the Serial Monitor do; an MQTT gateway or a backfill '
      + 'does not. Signal is dBm from a radio or an ERT-A2, and dBFS from an RTL-SDR, which is '
      + 'not calibrated in dBm — so compare SNR between receivers, and dBFS only within one. '
      + '<strong>Channel is not the radio channel</strong>: it names the sensor behind a station '
      + 'number, and Quality is what the source said about the value, not how loud it was.',
      'A station name here is a <strong>resolution, not a claim the message made</strong>. The '
      + 'datastore backfills <code>station_id</code> where the address is unambiguous; where it '
      + 'is not, the row shows the candidate nearest to where the receiver that heard it '
      + 'listens, and says how many more share the address — 604 of 5,122 ALERT addresses belong '
      + 'to more than one station, usually in different states. A station marked '
      + '<strong>far</strong> is the only one on file with the address and is hundreds of '
      + 'kilometres from everything else that receiver hears: an unregistered station nearby is '
      + 'using it.',
      '<strong>An unresolved row can name its own station.</strong> Open it and the drawer offers '
      + 'to attribute the message: pick a station and the address is attached to it, every '
      + 'reading already stored under that address is backfilled, and the tab says how many. '
      + 'That is the reverse of going to the Stations tab to type an address in, and it is the '
      + 'faster way round when the traffic is what you are looking at. It claims the '
      + '<em>address</em>, not the row — and for a relayed ALERT2 message that means the whole '
      + 'station, whose individual sensor slots are then named on the station card.',
      '<strong>Raw readings age out at about 90 days</strong>, so a window into last winter '
      + 'comes back empty here — the hourly and daily rollups that survive live on the Field '
      + 'Data tab. The submission a reading arrived on ages out faster (~30 days) and needs a '
      + 'signed-in session to fetch; the reading itself is public and stays the full 90.',
      'The <strong>tray map follows the Stations tab\'s rules</strong>: every pin stays on the '
      + 'map, ghosted; the stations behind your selected rows come up at full opacity with '
      + 'their names; and the repeaters whose pass ranges carry them are pulled in dashed cyan '
      + '— cyan meaning a pass range named it, never you.',
    ],
    links: [
      { label: 'The Message Log — what each column means, and the intended uses',
        href: 'docs/message-log.md' },
      { label: 'Posting readings over HTTP — for whoever configures the logger',
        href: 'docs/ingest-http.md' },
      { label: 'Posting readings over MQTT, and knowing which stations went quiet',
        href: 'docs/ingest-mqtt.md' },
    ],
    related: ['health', 'field', 'alert2', 'packets', 'stations'],
  },

  health: {
    summary: 'What the readings landing in the datastore say about each field station and the '
           + 'network carrying them, ranked by what needs doing. <strong>Needs attention</strong> '
           + 'is the morning\'s list: stations gone silent, missed check signals rising, batteries '
           + 'sliding or not charging, rain gauges dry through their neighbours\' rain, levels that '
           + 'did not move, receivers that stopped, repeaters that a run of silences has in common — '
           + 'each with its evidence and what to do about it. Pick a station for its '
           + '<strong>checks slot by slot</strong>, its <strong>battery across its solar day</strong>, '
           + 'its sensors, and the <strong>context lens</strong>: pick a missed check or a reading and '
           + 'see what every receiver and neighbour was doing at that moment. <strong>Ask Claude</strong> '
           + 'hands the findings to an agent that investigates and writes the briefing.',
    watch: [
      '<strong>Check schedules are learned, not assumed.</strong> Most stations send every sensor '
      + 'every three hours, some every two or every half hour; the period is read off the gaps '
      + 'between a station\'s battery reports (a battery reports at checks and nothing else), and a '
      + 'gap must be a whole number of periods — mostly exactly one.',
      '<strong>A missed check only counts when somebody was listening.</strong> A slot is a miss '
      + 'only if a receiver that hears the station delivered other traffic just before and just '
      + 'after it; otherwise it is unknown, not missed. A quarter-hour most of the network missed at '
      + 'once is the network\'s, and is counted apart from each station\'s.',
      '<strong>The battery is trended on its night lows.</strong> A solar station swings half a volt '
      + 'or more every day, so its trend is the lowest reading before dawn, in the station\'s own '
      + 'solar time, night after night — and the daily swing says whether charge is arriving at all.',
      '<strong>Corrupted copies are stored as readings.</strong> A repeater that relays with bit '
      + 'errors produces a second, different copy seconds after the first, and the datastore keeps '
      + 'both — 2% of the Raspberry Pi feed\'s first days. A flip in the address bits files it under '
      + 'another address: a ghost — told, on a station\'s own address, by being out of line with what '
      + 'that address reports while its near-twin is in line with its own. Both are set aside before '
      + 'anything is worked out, and both count against the repeaters within reach that could have '
      + 'carried them; a rain gauge tipping every few seconds through a storm is reporting, not being '
      + 'corrupted. <em>Weigh the copies on the Reception Map</em> takes them further.',
      '<strong>Silences that happen together are one finding.</strong> Stations behind one repeater '
      + 'that went quiet inside one check period of each other, or that went silent together and came '
      + 'back together, are reported as the repeater or the area, not as a dozen station faults. One '
      + 'that went at night and came back in daylight is the shape of a solar site that cannot carry '
      + 'itself through the night.',
      '<strong>Readings are public, so this tab needs no sign-in</strong> — and it reads only what the '
      + 'datastore holds: raw readings age out at about 90 days, and a station only one receiver can '
      + 'hear cannot be judged while that receiver is down.',
    ],
    links: [
      { label: 'Station Health — every finding, what triggers it, and what to do',
        href: 'docs/station-health.md' },
    ],
    related: ['msglog', 'reception', 'basestations', 'field', 'stations'],
  },

  mapgen: {
    summary: 'Composes a to-scale map sheet — stations, rivers, elevation contours, a lat/lon '
           + 'graticule, a title block — as a millimetre-true SVG. Pick a page (A4, the '
           + '200 × 200 mm laser billet, or custom), a centre and a 1:n scale, tick the features, '
           + 'and print it, save it as PDF from the print window, or download the SVG. The two '
           + 'laser modes speak K40 Whisperer\'s colour language — black raster-engraves, blue '
           + 'vector-engraves, red vector-cuts — and the layered mode writes <strong>one file per '
           + 'elevation level</strong> for stacked, vector-cut terrain.',
    watch: [
      'Every dimension is physical: the SVG\'s units are millimetres, so print at <strong>100% '
      + 'scale</strong> (never "fit to page") or the scale bar and the 1:n figure both lie. The '
      + 'stated scale is read at the centre latitude, as on any printed sheet.',
      'In layered mode each file <strong>cuts its own contour in red and engraves the next level '
      + 'up in blue</strong> — the engraved line is the assembly jig: the plate above sits exactly '
      + 'on it. The border cut repeats in every file so pieces that touch the plate edge come '
      + 'free of the blank.',
      'Contours are traced from the same ~30 m terrain tiles the elevation profile uses, so they '
      + 'are <strong>network-planning contours, not survey</strong> — the Stations tab\'s 1 m '
      + 'LiDAR layer is the close-look tool. Elevation step versus material thickness is yours '
      + 'to judge; the export panel shows the vertical scale and exaggeration that fall out.',
      'Station names manage their own overlap: each tries eight positions around its pin and a '
      + 'name that fits nowhere is dropped and counted in the notes rather than printed over a '
      + 'neighbour. Zoom the scale in and the dropped names come back.',
      '<strong>Backbone paths</strong> — repeater to repeater, and repeater to base station — is '
      + 'its own toggle under Features, with its own '
      + 'distance rather than a live read of the Stations tab\'s slider — a generated sheet '
      + 'depends only on what this panel shows. The default black raster-engraves in the laser '
      + 'modes, like the pins; recolour it blue for a faster vector engrave, and never red '
      + 'unless you mean to cut every path through the plate.',
      'The base map, the rivers and the terrain all arrive over the network. Whatever fails, '
      + 'the sheet still generates with what did arrive, and the notes under the preview say '
      + 'what is missing — a blank-based laser plate needs none of it to be complete.',
    ],
    related: ['stations', 'maps', 'export'],
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
    links: [{ label: 'The inspection schema, and why the form matrix earns its keep',
              href: 'db/README.md#station-inspections-and-maintenance-activities' }],
    related: ['stations', 'maintenance', 'history', 'export'],
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
      + 'sub-columns</strong>, and since <code>0011</code> each of the six has a column of its own. '
      + 'A form saved before that has the Comms pair filled and the other four empty, and empty '
      + 'here means <em>not recorded</em> — there is nothing to backfill it from.',
      'The <strong>canister-configuration screenshot and the benchmark photo can be attached</strong> '
      + 'once the form has been saved — the file hangs off the record by foreign key, so there has '
      + 'to be a saved row for it to belong to. Files go into a <strong>private</strong> bucket and '
      + 'are only ever shown through a link that expires; nothing attached here is on the open web.',
    ],
    links: [{ label: 'Who may read and write these records', href: 'docs/access.md' }],
    related: ['inspections', 'history', 'stations'],
  },

  history: {
    summary: 'What has already happened at a site. Every past station inspection and Council '
           + 'maintenance form, newest first, scoped to one station or across all of them — each '
           + 'one opening <strong>read-only</strong>, laid out the way the paper sheet is, and '
           + 'printable to A4 or exportable as CSV. The forms themselves are filled in on the '
           + 'Inspections and Site Maintenance tabs; this is where they are read back.',
    watch: [
      'The record on screen is <strong>one walk over the same sheet the form renders</strong>, not '
      + 'a second layout — so is the CSV. A box added to either sheet appears here and in the '
      + 'export without either being told, which is what stops the three drifting apart.',
      'A section the sheet prints with <strong>nothing recorded in it says so</strong>, rather than '
      + 'showing a grid of empty boxes that reads as unfilled. A section the sheet does not print '
      + 'at all is listed under <strong>Not on this form</strong>. Those are two different facts '
      + 'and the schema keeps them apart, so this view does too.',
      '<strong>On departure</strong> is the printed instruction at the foot of every inspection '
      + 'sheet, as a column: a rating the database marks as needing a maintenance visit, with a '
      + 'tick if a Council form was raised against it and an exclamation mark if none was.',
      'All of it is <strong>editors-only</strong> — inspection remarks carry site-access notes and '
      + 'the Council form carries named contacts\' phone numbers. Photos are drawn through links '
      + 'that expire, and the CSV names a photo by its object path rather than carrying a link '
      + 'that would still open it out of somebody\'s Downloads folder.',
      'It is <strong>empty for a station nobody has inspected in Flood-Net yet</strong>. The ~35 '
      + 'years of paper history in the archive workbook is issue #122\'s to load, and this is the '
      + 'view that will show it.',
    ],
    related: ['inspections', 'maintenance', 'stations'],
  },

  photos: {
    summary: 'Photos from the field, <strong>filed by where they were taken</strong> — drop in a '
           + 'handful, a whole folder or a zip of them, and each one is placed on the ground it shows: from the '
           + 'camera\'s own GPS where the file has it, and otherwise from the position a field camera '
           + 'app printed on the picture (Solocator, GPS Map Camera and the like), read off it by OCR. '
           + 'Each is filed under the nearest station within a kilometre. Then they are wherever that '
           + 'ground is drawn: a 📷 marker in the <strong>Digital Twin</strong> where the photo was '
           + 'taken, pointing the way the camera faced — click it, or walk up to it in the POV and '
           + 'press Enter — and a pin on the Stations map, standing on the terrain when the map is '
           + 'tilted into 3-D. Every door opens the same viewer: ← → '
           + 'through the photos taken at that spot, with when, where, which way and how each was known.',
    watch: [
      '<strong>Nothing is uploaded until you press Upload.</strong> A position read off a picture is '
      + 'a reading: the list says where each one came from, and flags one the OCR only read once. '
      + 'Check it, change it (paste coordinates, or pick a station), then upload.',
      '<strong>The same photo twice is one photo.</strong> Each file\'s SHA-256 is checked before a '
      + 'byte is sent, so dropping last week\'s folder in again costs a query a photo, not the upload.',
      'A photo that <strong>nothing can place</strong> still uploads, into <em>Unplaced</em> — open '
      + 'it there and give it coordinates or a station. It is drawn nowhere until it has a place.',
      'The OCR engine (~7 MB, Tesseract) is fetched only for a photo with no GPS in it, once a '
      + 'session. A photo sent through Messages, a chat app or an email has usually lost its GPS and '
      + 'kept the overlay, which is exactly the case it is for.',
      '<strong>HEIC</strong>, an iPhone\'s own format, is stored as a JPEG, so every browser can show '
      + 'it. Safari converts it itself; Chrome and Firefox cannot draw one, so for the first HEIC of a '
      + 'session a decoder (~0.5 MB, libheif) is fetched to do it instead. Nothing else changes — the '
      + 'position, time and heading still come from the file.',
      '<strong>Editors only</strong>: the pictures, and where they were taken, are in a private '
      + 'bucket and shown through links that expire. A site photo shows its access, its padlock and '
      + 'often a colleague, and its coordinates are as much a disclosure as its pixels.',
      '<strong>A zip of photos</strong> is opened here, not uploaded: every photo in it joins the '
      + 'list as if dropped on its own, saying which zip it came from, and the zip gets a line of its '
      + 'own — how many photos, and what was left out and why (not a photo, encrypted, too big, a '
      + 'zip inside the zip). Photos are unzipped one at a time, so a big pack does not fill memory.',
      '<strong>From Dropbox and Google Drive</strong>: photos saved into a linked folder are imported '
      + 'by a scheduled job, read the same way, and reported in the panel at the foot of the tab. A '
      + 'photo removed here stays removed — the sync will not bring it back.',
      '<strong>Review</strong> lists what happened to every file — from this browser, and the last '
      + 'two hundred from every way in: imported, unplaced, already in Flood-Net, refused or failed, '
      + 'and why. Filter it by outcome or by way in.',
      '<strong>Equipment labels.</strong> 🔎 in the viewer, or a station\'s worth from Review, reads '
      + 'the makes, models and serial numbers on the equipment in a photo (seconds a photo) and '
      + '<em>suggests</em> them for the station\'s register. Nothing is written until an '
      + '<strong>administrator</strong> approves it, correcting it first if the reading was wrong; '
      + 'approved equipment shows on the station card.',
      'The altitude a photo carries is shown, never used: phones and apps disagree about its datum '
      + '(Solocator prints height above the ellipsoid, some 40 m off AHD here). The marker in the twin '
      + 'stands on the twin\'s own ground.',
    ],
    related: ['stations', 'inspections', 'history'],
    links: [
      { label: 'Field photos — how a position is read, the Dropbox sync, and setting it up',
        href: 'docs/field-photos.md' },
      { label: 'Reviewing uploads, and approving equipment suggestions — who is an administrator',
        href: 'docs/field-photos.md#reviewing-what-came-in' },
    ],
  },

  export: {
    summary: 'Builds the full set of CSV files Radio Mobile needs, scoped to the networks ticked in '
           + 'the sidebar. The station file itself — the escape hatch from the database — and the '
           + '<strong>Data source</strong> panel that says which of the three sources the list on '
           + 'screen came from are on the <strong>Admin</strong> tab.',
    watch: [
      '<strong>The Stations tab\'s filters have no say here.</strong> What gets exported is the '
      + 'repeaters on the ticked networks plus every station their pass ranges cover — so a '
      + 'station you filtered to a minute ago may not be in the file, and a station you have never '
      + 'looked at may be. The unit count above the button is the set that will be written; check '
      + 'it rather than the map.',
      'That also means a station on <strong>no recorded network</strong> cannot be exported by '
      + 'ticking every box, because nothing pulls it in. Ticking all of them is a little under '
      + 'half the file, not the file.',
      '<strong>The download needs a signed-in session.</strong> Everything that says what this '
      + 'tab would produce — the ticks, the counts and the repeater table — reads without one; '
      + 'what is behind the sign-in is taking the network away as a file, which is the whole list '
      + 'rather than a view of it. Your ticks survive signing in.',
      '<strong>An AI agent or a script does not need this tab.</strong> The read-only station API '
      + '(<code>/api/v1</code>) and MCP server (<code>/api/mcp</code>) answer a station — or a '
      + 'whole-station dossier for a report — at a time, with no sign-in and rate limited. How to '
      + 'connect Claude, Copilot, Gemini, Cursor or ChatGPT is in the agent API link below.',
    ],
    links: [{ label: 'Why the station list lives in Postgres, and what that bought',
              href: 'docs/datastore-decision.md' },
            { label: 'Station data for AI agents and scripts — the read-only API and MCP server',
              href: 'docs/agent-api.md' }],
    related: ['stations', 'passranges', 'admin'],
  },
  admin: {
    summary: 'Where the station data comes from and the housekeeping around it: load '
           + '<code>stations.json</code> from a file, GitHub or the datastore, see which one is on '
           + 'screen and whether the database answers, and snapshot it. Administrators also manage '
           + '<strong>users</strong> and the <strong>allowlist</strong> of who may sign in here, and '
           + 'everybody can read what each user group may do. At the top, administrators get a '
           + '<strong>dashboard</strong>: database health and size, where the data is by part of the '
           + 'app, every table\'s size and rows, who is online and when each user was last seen, '
           + 'and visitors a day — signed in and anonymous.',
    watch: [
      '<strong>Adding a user is adding an allowlist entry.</strong> A person appears under Users '
      + 'the first time they sign in, with the entry\'s initial role. An address lets one person '
      + 'in; <code>@domain</code> lets in everybody at it.',
      '<strong>Viewer is recorded, not enforced.</strong> Editing is decided by the allowlist, so '
      + 'to stop somebody writing, remove their entry — setting them to viewer does not.',
      'The database refuses what would lock everybody out: demoting or deleting yourself, removing '
      + 'the last administrator, or removing the only entry that lets you in. The owner at a '
      + '<code>psql</code> prompt can still do all three.',
      'The <strong>Data source</strong> panel is the first place a schema mismatch shows up: if it '
      + 'says the list came from <code>stations.json</code> rather than the datastore, the app '
      + 'fell back, edits are refused, and <strong>Load from the datastore</strong> retries.',
      '<strong>Snapshot</strong> writes today\'s document out as a file to take somewhere without '
      + 'a network. It is a copy, not a branch — nothing reads it back in automatically.',
      '<strong>Anonymous visitors are counted by a random id this browser keeps</strong> — no name, '
      + 'address or IP. One browser is one visitor a day; clearing its storage makes a new one. Days are '
      + 'UTC. Database calls by role come from <code>pg_stat_statements</code> and count since its last reset.',
      '<strong>Clear settings</strong> forgets what this browser keeps for the app — filters, '
      + 'widths, drafts — and keeps your sign-in.',
      '<strong>A base station can ask for its own ingest token.</strong> Press <em>Request a token</em> '
      + 'on a Raspberry Pi running RPi ALERT (or <em>Ask an administrator</em> in a Serial Monitor card) and '
      + 'it appears under <em>Ingest tokens → Waiting for approval</em> with the code it shows. Check the '
      + 'code matches, then Approve: the device starts sending by itself — nothing to copy. Scanning the '
      + 'QR code on the Pi\'s screen opens that request here.',
    ],
    links: [{ label: 'Access, sign-in and the allowlist', href: 'docs/access.md' },
            { label: 'Ingest tokens, and base stations that ask for one', href: 'docs/ingest-http.md' },
            { label: 'The database schema, migrations and who may write', href: 'db/README.md' },
            { label: 'Why the station list lives in Postgres', href: 'docs/datastore-decision.md' }],
    related: ['export', 'photos', 'basestations'],
  },
  basestations: {
    summary: 'Every base station and ingest point on one list: whether it is checking in, its '
           + 'receivers, its uplink, its power and temperature, and what needs a look. Open one to see '
           + 'its health, software and settings, and ask it to <strong>change a setting</strong>, '
           + '<strong>restart</strong> a receiver or itself, <strong>install an update</strong> or '
           + '<strong>show its log</strong> — without going to site. Below the list are the team\'s '
           + '<strong>SSH public keys</strong>, which a base station installs for its maintenance '
           + 'login if its owner allows it. Administrators only.',
    watch: [
      '<strong>Flood-Net never connects to a base station.</strong> Each one checks in about once a '
      + 'minute, over the same HTTPS door and with the same ingest token as its readings, so nothing '
      + 'listens on it and no port is opened for it. What is asked here waits for that check-in; '
      + 'opening a station makes it check in every five seconds for the next three minutes.',
      '<strong>It can be asked for a short list of things, and nothing else.</strong> The database '
      + 'checks the list and the station checks it again. Never its token, where its readings go, its '
      + 'web page\'s password, its SSH keys, or how much it lets Flood-Net do.',
      '<strong>The station decides how much.</strong> Its owner can set it, on the station and never '
      + 'from here, to <em>report only</em> — its health shows, every request is refused — or stop '
      + 'it checking in at all.',
      '<strong>A request not collected within ten minutes expires</strong> rather than running hours '
      + 'later, and at most 20 wait for any one station. A queued one can be cancelled.',
      '<strong>Team keys are public keys, one per person.</strong> Nothing on the list can log in to '
      + 'anything by itself: a station installs it only if its owner turned that on, and the keys work '
      + 'only from a private network unless the station says otherwise. Take a key off when its owner '
      + 'moves on — stations that take the list drop it within the hour, or a minute if checking in.',
      'A station that posts readings but does not check in is listed as <em>not managed</em>, with when '
      + 'it last posted. Its token is under Admin → Ingest tokens.',
    ],
    links: [{ label: 'Base stations: checking in, what may be asked, and the team keys', href: 'docs/base-stations.md' },
            { label: 'Ingest tokens, and base stations that ask for one', href: 'docs/ingest-http.md' }],
    related: ['admin', 'msglog', 'health'],
  },
};

// ── The breakpoint scale (#109) ──────────────────────────────────────────────
// Six named steps, and this object is the only place they are written down.
//
// Before #109 styles.css held 23 `@media (max-width:)` blocks across *nine*
// distinct widths — 1400, 1200, 1100, 1000, 900, 720, 700, 560, 380 — which is
// not a responsive system, it is nine independent decisions that happened to
// be in the same file. Three of them were folded away (1200→1400, 1000→1100,
// 720→700; each fold carries its reasoning at the block it changed) and the
// six that remain are these.
//
// It lives in core.js rather than in styles.css for two reasons. CSS custom
// properties cannot be used inside a media query, so tokens there would look
// usable and not be. And two of these steps are already load-bearing in
// JavaScript — the nav auto-collapses at `md` and becomes a drawer at `xs` —
// so the app was going to hold the numbers regardless. `npm run shell` reads
// this object out of the running page and fails on any max-width in styles.css
// that is not one of its values, which is what makes "U1–U6 must not introduce
// a new breakpoint" a checked claim rather than an instruction.
//
//   xl  1400  the widest layouts give up a column (help panel narrows,
//             .crud-layout and the Workbench rail stack)
//   lg  1100  side-by-side becomes stacked (.layout, .map-layout, Radio Path
//             Maps, the Workbench)
//   md   900  a tablet. The nav auto-collapses to the icon rail, header
//             buttons drop their labels, tables switch to automatic layout and
//             scroll inside their wrapper
//   sm   700  two-column content folds to one (forms, pickers, optional table
//             columns)
//   xs   560  a phone. The nav and the help panel stop being columns and
//             become drawers over the page
//   xxs  380  the smallest phone. The banner shrinks its title rather than
//             pushing a button off the edge
//
// Adding a seventh step is allowed — it is a change to the system, made here
// and documented in docs/design-system.md, not a number typed into one tab's
// media query.
const BREAKPOINTS = { xl: 1400, lg: 1100, md: 900, sm: 700, xs: 560, xxs: 380 };

// Matches the width transition in styles.css (--motion-rail). Measuring a map
// mid-slide is worse than not measuring it at all, so the invalidate that
// follows a collapse waits the transition out rather than racing it.
const NAV_TRANSITION_MS = 160;

// Below this the nav starts collapsed, on first visit only. The Stations tab
// is one long column on a laptop already, and a second permanent column beside
// it is one too many. Named off the scale rather than repeated as a literal —
// this is what `md` *means*.
const NAV_AUTO_COLLAPSE_PX = BREAKPOINTS.md;

// How the digital twin works: what was the Digital Twin tab's help, when it
// had a tab. It is not keyed by a tab any more — the twin is inside the
// Stations map and its controls are the 🧊 pane of that tab's side panel — so
// it is not in HELP (whose keys are TABS' ids, `npm run help`); the pane
// shows it at its foot (digital-twin.js, paneHtml).
const TWIN_HELP = {
  summary: 'One station\'s patch of ground in three dimensions — the real relief under it from the '
         + 'best public elevation model there is (Queensland\'s 0.5–1 m LiDAR where it exists, the '
         + '~30 m SRTM elsewhere), the aerial imagery draped over it, <strong>the station as built</strong> '
         + 'where it stands — the Type 3 rainfall pole, the river-gauge tower with its platform and '
         + 'extension ladder, its staff gauge and its flood levels marked on it, a manual collector or staff gauge, or a red post where the record cannot say — with '
         + 'the other stations and the bridges in the patch, and a 1.75 m figure beside it for scale. Orbit it, '
         + 'look straight down on it, or take the POV and walk about in it at eye height (and up the '
         + 'ladder); click the ground for its height; move the station\'s pin to where it stands on '
         + '10 cm imagery; and '
         + 'download the whole scene as a <code>.glb</code> that Blender opens in one step.',
  watch: [
    '<strong>Everything in the view is indicative modelling</strong>, and the red line along the '
    + 'foot of every twin says so for as long as it is '
    + 'up: the ground is an elevation model, the imagery is draped on it, the station is built from '
    + 'its record, and the water is a level surface at the recorded levels. None of it is a survey, '
    + 'a flood map or a forecast; check anything that matters on site.',
    '<strong>The twin is inside the Stations map.</strong> From zoom 17 with a station under '
    + 'the view a card on the map offers it, saying what aerial imagery covers the station and when '
    + 'it was flown; press Open the digital twin and the map hands its rectangle over, and ← Map or '
    + 'Escape gives it back at the same zoom. 🧊 Digital twin on a station\'s card, or a station '
    + 'picked in this pane, goes straight there. This pane is the rest of it: the settings, the '
    + 'Ground truth panel and the .glb — ⚙ Settings on the twin\'s bar opens it.',
    '<strong>📍 Move pin</strong> puts the station where it stands: drag the amber post across the '
    + 'ground, or click where the station is, and a panel on the stage reads the new position to the '
    + 'centimetre. Round the station and the pin the State\'s finest imagery is draped again — 10 cm '
    + 'over most towns, where the rest of the patch is 0.39 m. Save writes the position (and nothing '
    + 'else) through the station editor\'s own save, then rebuilds the twin on the new spot. The '
    + 'same mode works on the 2-D map and in ⛰️ 3-D.',
    '<strong>🧭 Orientation</strong> turns the station to the way it faces on the ground — the side '
    + 'its enclosure door or a tower\'s ladder is on. Turn it with the bearing box, the 15° buttons '
    + 'or the slider, or orbit round to where the front should be and press Face the view. Save '
    + 'writes the bearing on the station for everybody; a station with none recorded is drawn facing '
    + 'south. The walk, the ladder and the deck turn with it.',
    '<strong>The lines over the view fold away</strong> ten seconds after the twin opens — the '
    + 'status, the paths, the photos, the water and the notes — so the stage gets the height back. '
    + '▾ Details brings them back (it counts the notes while they are folded); once pressed, they '
    + 'stay as you left them.',
    '<strong>The radio paths are drawn from the antenna</strong> as rays to the edge of the patch, '
    + 'along the line of sight to the far station, each named at its end. Inside the Stations map '
    + 'they are the map\'s own lines — the same filters, the same colouring (channel, fade margin or '
    + 'line of sight), the same culled set.',
    '<strong>The country runs to a horizon 60 km off</strong> — far ground round the patch from the '
    + 'State\'s raster at 40 m and the ~30 m tiles beyond, under a sky, with haze — but it is scenery: '
    + 'coarse on purpose, dropped for the Earth\'s curve, not in the .glb and not clickable. The '
    + 'patch is the survey. It is a few more requests, so the Scene panel can switch it off.',
    '<strong>The ground is a model, not a survey.</strong> Queensland\'s service is bare-earth LiDAR '
    + 'in AHD at 0.5–1 m where the State has flown it and SRTM where it has not, and it does not say '
    + 'which per pixel — a patch that looks smooth may be the 30 m data. Outside Queensland the '
    + 'ground is the same ~30 m terrain tiles every profile in this app reads, and the notes say so: '
    + 'at that resolution the channel a gauge sits in is not there.',
    'A recorded height well above the ground at the pin usually means the <strong>coordinate is the '
    + 'gauge down in the channel and the mark is the hut on the bank</strong> — a flag on the '
    + 'position, not a correction to the height. The Ground truth panel puts the two side by side, '
    + 'with what Elvis says at the point and which dataset it read.',
    '<strong>The station is read from its record, and nothing is assumed.</strong> A telemetered '
    + 'station that reads a river is the tower; one that reads rainfall the Type 3 pole. A station the '
    + 'SLS lists as Manual (or one the Bureau reads daily with nothing saying a radio does) is the '
    + 'observer\'s kit: a silver collector Ø200 × 300 mm for rain, a white 1 m staff gauge for a river, '
    + 'both side by side for both. Where the record cannot say what a station is, it is a red post '
    + '1 m tall, and the notes say what is not known. AL or ALERT in the name (or ALERT addresses) '
    + 'puts an ELPRO ERT-A2 in an enclosure; TM (or satcom) a Campbell CR300 and a Beam SBD modem; '
    + 'every tower cabinet carries a Kisters HS40 bubbler. The doors open when you come up to them.',
    '<strong>Bridges stand over the creek.</strong> The ground is bare-earth LiDAR, which has the '
    + 'bridges taken out, so each bridge in the patch (from the State\'s road network, or '
    + 'OpenStreetMap) is built as a deck — at the crossing height the Bureau lists for the gauge where '
    + 'there is one, else at its banks — with the photograph of the road on it. The other stations in '
    + 'the patch are built too, each named, and each name goes to its own twin.',
    '<strong>The cadastre lies on the ground.</strong> Every lot\'s boundary, in white, with its lot '
    + 'number and plan written in it, and the road reserve outlined and washed in the road colour with '
    + 'the road\'s name in it — Queensland\'s cadastre, the land parcels Queensland Globe draws, on the '
    + 'ground in every view. The line under the stage says which lot the station stands in and how far '
    + 'the road reserve is (or whose road reserve it stands in), and how well the cadastre is plotted '
    + 'there; a click on the ground names the parcel under it. Two switches in the Scene panel; '
    + 'Queensland only.',
    '<strong>You are not necessarily alone.</strong> With <em>Explore together</em> on (the Scene '
    + 'panel), the twin joins a room for its station and whoever else has that station open is '
    + 'drawn where they stand, in the hat, shirt and trouser colours they chose, with their name over '
    + 'their head — and you are drawn for them. Hold Space in the POV, or press Point, and your arm '
    + 'goes out with a laser to whatever you are looking at. The room sees a chosen name (a signed-in '
    + 'address\'s local part, or a visitor number), three colours and metres from the station; never '
    + 'the address, never a coordinate on the Earth. Past four others the twin listens without '
    + 'publishing, to keep the project\'s message budget for the readings it also serves.',
    'Vertical exaggeration stretches the relief and nothing else: the station is its true size and '
    + 'the figure 1.75 m at every setting. They are the ruler.',
    'Everything arrives over the network — the renderer on the first visit (~750 KB), then one '
    + 'raster and one image per patch. Whatever fails, the twin says which and draws what it did get; '
    + 'a ground that could not be read is never drawn flat.',
    '<strong>The water is the station\'s flood levels, stood on the ground.</strong> It rises from '
    + '0 m on the gauge to the highest level the record holds, is held there, let out, and rises '
    + 'again: clear blue below minor, then green, yellow and red past minor, moderate and major, and '
    + 'magenta through to dark blue past the AEP floods — the colour of the rarest level passed, so '
    + 'it never goes back down. It goes where the river would take it, not everywhere low: a hollow '
    + 'behind a bank stays dry until the bank is overtopped. It is one level surface through the '
    + 'patch, and a real flood slopes downstream, so the far edges are a guide. The floods the river '
    + 'has seen — its five largest from the Bureau\'s records, at the level each reached — rise with '
    + 'it as rings on the staff, the highest named; a flood colours nothing. Classes on a gauge whose '
    + 'zero is not surveyed to AHD, and floods whose gauge zero that day is not known in AHD, are named '
    + 'in the notes and not drawn. Not in the .glb.',
    '<strong>The scale up the left of the stage is the water\'s control.</strong> Every level is '
    + 'marked on it at its height, to scale, its name beside it — moved only far enough not to sit on '
    + 'another. ⏸ or ▶ at its head stops and starts the rise; press a name and the water is held at '
    + 'that level; press or drag on the track and the water follows the pointer, taking a level '
    + 'exactly when let go near its mark. On the track, Page Up and Page Down go level to level, Home '
    + 'and End to 0 m and the top. On a phone the names give way to their marks after five seconds — '
    + 'tap the track for five more (a tap only brings them back; drag to move the water) — and the '
    + 'hint along the foot folds to a <strong>?</strong> that brings it back. The line under the stage '
    + 'has the same levels, and <em>Hide the water</em> — each choice remembered.',
    '<strong>Log, beside the scale\'s head.</strong> The scale opens linear — a metre the '
    + 'same height all the way up. Where a station\'s levels crowd together near the top (the AEP '
    + 'floods and the largest floods within a metre or two of each other over major, as at Gatton), '
    + 'it turns <em>logarithmic</em> by itself a few seconds later: measured down from the highest '
    + 'level, so the top metres get the room and every name sits by its mark, and the rise slows as '
    + 'it climbs into them rather than passing them all in its last second — and <strong>Log</strong> '
    + 'lights up. Press it to turn the logarithmic scale on or off; the choice is kept for that station '
    + 'for the session, and the water never moves when the scale does.',
    '<strong>No levels here? Borrow a neighbour\'s.</strong> For a station with no flood heights '
    + 'the twin can put on its ground, the flood line (and a pill on the stage) offers the four nearest stations '
    + 'that have some — their distance, their heights and their catchment. Pick one and its levels '
    + 'are drawn over this channel as heights on its gauge (or, if you say so, as the same metres '
    + 'AHD). Only in the twin, only for the session, and every place that draws them says whose '
    + 'they are.',
    '<strong>A 📷 on the ground is where somebody stood with a camera</strong> — a post at chest '
    + 'height, the camera turned the way it faced and a pale wedge for each way a photo from there '
    + 'looked. Click it, pick it from the line under the stage, or walk up to it in the POV and '
    + 'press Enter, and the photos taken there open one after another. Editors only, like the '
    + 'photos themselves; the markers are not in the .glb.',
    'The <code>.glb</code> is in metres, y up, with its origin on the ground at the pole and the '
    + 'station\'s coordinates and datum in its header. Blender: <em>File → Import → glTF 2.0</em>, '
    + 'and it lands z-up. Point cloud data, when it is ingested, will sit in this same scene.',
  ],
  links: [
    { label: 'Digital twin — where the ground and the imagery come from, and the Blender workflow',
      href: 'docs/digital-twin.md' },
  ],
};

// The help panel's own width transition, and it plays exactly the role
// NAV_TRANSITION_MS does: the maps are re-measured once the slide has finished
// rather than part-way through it. Kept in step with styles.css.
const HELP_TRANSITION_MS = 160;

// The side panel's pane, in px (the strip beside it is --mn-help-rail). 420 is
// wide enough for the station table's five columns and the link budget's
// two-column rows without either wrapping, and leaves a 1440 px laptop with the
// nav open a map of about 700 px — wider than the side-by-side split it
// replaced ever gave it.
const DOCK_DEFAULT_W = 420;
// The narrowest a pane may be dragged to while there is room for more. Below
// this the Stations card's head and filter rows — the toggles, + Propose and
// + New, the search box and two Clear buttons — wrap onto four lines, and a
// card is not readable at that.
const DOCK_MIN_W = 300;
// What the side panel always leaves the page, in px: a map that is a strip is
// not a map, and the Stations map beside the pane is the reason the pane is
// resizable at all. Taken off the width #main-content would have, so the map
// itself is this less the layout's padding — about 360 px of map at worst.
const DOCK_MAIN_MIN = 400;

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

// What kind of station a station is, or is proposed to be (0039):
// meganet.station_type's four rows, in its order. Written out here rather than
// read from the database, as ROLE_LABEL is: the editor offers them in a session
// that loaded a file, and save_station() refuses a code it does not know
// whichever list the tab offered. A new kind is a row there and a line here.
const STATION_TYPE_LABEL = {
  auto_water_level:   'Automatic water level station',
  auto_rain_gauge:    'Automatic rain gauge',
  manual_water_level: 'Manual water level station',
  manual_rain_gauge:  'Manual rain gauge',
};

function stationTypeLabel(code) {
  return code ? (STATION_TYPE_LABEL[code] || code) : '';
}

// A proposed station, named the same way wherever it is named (0039): a tag
// beside it on the station card, in the station list, on the trail and over
// the twin, with what it is proposed as and for when on its tooltip. `short`
// leaves the year off the tag itself. Empty for a station that is not
// proposed.
function proposedTagHtml(s, { short = false } = {}) {
  if (!s || !s.proposed) return '';
  const what = [stationTypeLabel(s.station_type), s.proposed_year ? `proposed for ${s.proposed_year}` : '']
    .filter(Boolean).join(', ');
  return `<span class="proposed-tag" title="${escAttr(`Proposed — not yet established${what ? `: ${what}` : ''}.`)}"`
    + `>Proposed${!short && s.proposed_year ? ` ${esc(String(s.proposed_year))}` : ''}</span>`;
}

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

// ── Where else to look at a station ──────────────────────────────────────────
// Five links out of one station: three ways to look at where it is, and the two
// SharePoint libraries the network's paperwork actually lives in. They are
// written once, here, because the map popup and the station editor card render
// the same row and two copies of a URL shape drift the moment one is edited.

// The two document libraries, up to and including the `q=`. Everything before
// it — the site, the library, the `viewid` of the view that lists everything,
// and `view=7` — is what a browser puts in the address bar when somebody opens
// that library and types in its search box, kept verbatim rather than rebuilt
// from parts we would be guessing at.
const FWIN_DOC_SEARCH_URL =
  'https://bom365.sharepoint.com/sites/int-FloodWarningInfrastructureNetworkProgram2'
  + '/Shared%20Documents/Forms/Default.aspx'
  + '?viewid=d017a792%2Db4d7%2D44f1%2Daa85%2D5417f09fbd0c&view=7&q=';
const OOHB_DOC_SEARCH_URL =
  'https://bom365.sharepoint.com/sites/OOHB/FWN%20Library/Forms/AllItems.aspx'
  + '?viewid=3c588f77%2D6255%2D435e%2D9e1c%2Dc04e596dfb5e&view=7&q=';

// What a station's name says about its telemetry rather than about where it is.
// 1,332 of the 3,174 names end in AL (with -B, -P and -P2 variants), 237 in TM,
// and nothing in either library is filed under either — they are the kind of
// site it is, and the search box does not care.
const DOC_SEARCH_SUFFIX_RE = /[\s(]*\b(?:AL(?:[-\s]?[A-Z]\d?)?|TM|ALERT|TBRG)\b[\s)]*$/i;

// The words a document is as likely to abbreviate as to spell out. "Upper Sandy
// Creek" is filed as "Upper Sandy Ck" as often as not — 243 station names say Ck
// where 218 say Creek — so a query naming one spelling cannot reach a document
// written with the other, and a search box ANDs its terms: the wrong half of the
// pair does not merely fail to help, it excludes every hit.
//
// So the pair is not dropped, it is *asked for as either*. `(creek OR ck)` is
// KQL, which is what SharePoint's search box parses, and it keeps the recall of
// dropping the word and the precision of keeping it.
//
// **If the libraries turn out not to honour the operators from a URL, this is
// the one place to change**: `docSearchQuery()` below renders each group, and
// rendering a group as nothing instead — dropping the generic word, which is
// what a person does by hand — is a one-line edit there. Every pill's tooltip
// carries the query it will send, so which of the two is happening is visible
// on screen rather than something to reason about.
//
// Keyed by the spelling to search for first; the values are what the same word
// is written as elsewhere. Nothing that tells two sites apart is in here — only
// the generic half of a name, so "Upper", "North", "Seven Mile" and every proper
// noun are searched as themselves.
const DOC_SEARCH_VARIANTS = [
  ['creek', 'ck', 'crk'],
  ['river', 'rv', 'rvr', 'riv'],
  ['road', 'rd'],
  ['street', 'st'],
  ['mount', 'mt'],
  ['bridge', 'br'],
  ['crossing', 'xing'],
  ['reservoir', 'res'],
  ['station', 'stn'],
  ['avenue', 'ave'],
  ['lane', 'ln'],
  ['drive', 'dr'],
  ['highway', 'hwy', 'hway'],
];

// word → the group it belongs to, built once from the table above.
const DOC_SEARCH_GROUP = new Map(
  DOC_SEARCH_VARIANTS.flatMap(g => g.map(w => [w, g])));

// Words that are not a place at all, and are dropped rather than expanded: the
// kind of telemetry a site is, and the words that join two halves of a name
// together. `tbrg` and `alert` are the mid-name versions of the suffix above —
// "Greenough Rvr TBRG @ Yuin" is a rain gauge at Yuin. The joiners are stop
// words the index drops anyway; taking them out here keeps the query readable.
const DOC_SEARCH_NOISE = new Set([
  'al', 'tm', 'alert', 'tbrg', 'rep', 'repeater',
  'at', 'the', 'and', 'of', 'no',
]);

// Turn a station name into a query for a document library.
//
//   1. The parenthetical goes. It is the river a site is on, or the road it is
//      off, or the word "Repeater" — supplementary, and 122 names carry one.
//      Every extra term is another thing every hit has to match.
//   2. The telemetry suffix goes (above), and so do the noise words.
//   3. Punctuation becomes space, so "O'Shannassy" and "D/S" break into words
//      rather than into things no index holds.
//   4. Single letters go — what is left of D/S, U/S, W/L and the bare "@".
//      Digits stay: the 8 in "Swansea No. 8" is the whole point of that name.
//   5. A word with other spellings becomes `(this OR that)`. "St" is the one
//      whose position decides what it is: leading it is Saint and names the
//      place, so it is searched as itself; anywhere else it is Street.
//   6. A term said twice is said once — "Cudgewa Creek @ Cudgewa North" is
//      three terms, not four.
//   7. Five terms at most, and never nothing — a search that ANDs eight terms
//      finds an empty library, and a search with no terms is not a link.
function docSearchQuery(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';

  const head = raw.split('(')[0].trim() || raw.replace(/[()]/g, ' ');
  const bare = head.replace(DOC_SEARCH_SUFFIX_RE, '').trim() || head;

  const words = bare.toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w && !(w.length === 1 && /[a-z]/.test(w)));

  const kept = words.filter(w => !DOC_SEARCH_NOISE.has(w));
  const terms = [];
  const seen = new Set();
  for (const [i, w] of (kept.length ? kept : words).entries()) {
    const group = (w === 'st' && i === 0) ? null : DOC_SEARCH_GROUP.get(w);
    const term  = group ? `(${group.join(' OR ')})` : w;
    if (seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length === 5) break;
  }
  return terms.join(' ') || bare.toLowerCase();
}

// The document-library searches for a station, or null when it has no name to
// search for. Both libraries take the same words: the question is "what has
// anyone filed about this site", and it is asked of each of them in turn.
function stationDocSearchUrls(s) {
  const q = docSearchQuery(s && s.name);
  if (!q) return null;
  const enc = encodeURIComponent(q);
  return { fwin: FWIN_DOC_SEARCH_URL + enc, oohb: OOHB_DOC_SEARCH_URL + enc, q };
}

// Street View / Google Earth / Apple Maps links for a station's coordinates, or
// null when it has none. Google's Maps URLs API drops the viewer on the nearest
// available panorama — on farm tracks and hilltops with no coverage it lands on
// the map instead, which is why the link's title spells that out. Earth is the
// same place from above: the camera form (`@lat,lon,0a,2000d,…`) rather than a
// search, so it flies to the coordinate itself and not to whatever a geocoder
// makes of the name. Apple publishes no URL scheme for opening Look Around at a
// coordinate, so the Apple link is a map pin, not a panorama, and is labelled
// "Apple Maps" rather than "Apple Street View" because it isn't one.
function stationMapLinkUrls(s) {
  if (s == null || s.lat == null || s.lon == null) return null;
  const coord = `${s.lat},${s.lon}`;
  return {
    google: `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${encodeURIComponent(coord)}`,
    earth:  `https://earth.google.com/web/@${encodeURIComponent(s.lat)},${encodeURIComponent(s.lon)},0a,2000d,35y,0h,0t,0r`,
    apple:  `https://maps.apple.com/?ll=${encodeURIComponent(coord)}&q=${encodeURIComponent(s.name || '')}`,
  };
}

// The links above, rendered as the row of pills used in both the map popup and
// the station editor card — one place a URL shape is written, not two, and one
// place they are dressed.
//
// Pills rather than a stack of underlined text (#170): every one of these
// leaves the app for somewhere else, they are the same *kind* of thing as each
// other, and a column of five links reads as a menu nobody asked for. `.pill`
// is `.btn-link`'s shape at a link's weight — see styles.css.
//
// A station with no coordinates still gets the document searches: the two
// libraries are searched by name, and a site nobody has surveyed yet is exactly
// the one whose paperwork is worth finding.
//
// Split in two since #175: the array, and the row string joined from it. One
// place the URL shapes are written, two places they are drawn — the editor
// card's row, and the station card, which takes the halves below to put the
// pills in its groups. (The desktop callout's expanded row was a third, and
// counted them for its "Actions (N)" label, until the callout gave way to the
// leader.)
function mapLinksHtml(s) {
  return mapLinksPills(s).join('\n    ');
}

// Two kinds of leaving, kept apart since the station card grew groups (#175):
// three pills that put the *site* on somebody else’s imagery, and two that go
// looking for its *paperwork*. The concatenation is still what the editor card
// draws — one flat row, in the order #170 fixed — so nothing that reads
// mapLinksPills/mapLinksHtml changes shape; the station card asks for the
// halves instead and draws a rule between them.
function mapLinksPills(s) {
  return [...mapViewPills(s), ...docSearchPills(s)];
}

// Somebody else’s picture of this ground, by name. Null for a station with no
// coordinates — there is nowhere to point a camera.
//
// Named rather than positional because one caller has to reach *into* the
// order: the station card puts the KML download beside the Google Earth link
// (#176), and `pills[1]` would be a silent breakage the day a fourth imagery
// service is added. The flat array below is what everything else draws.
function mapViewPillParts(s) {
  const urls = stationMapLinkUrls(s);
  if (!urls) return null;
  return {
    street: `<a class="pill" href="${esc(urls.google)}" target="_blank" rel="noopener"
       title="Opens the nearest Google Street View panorama; sites with no coverage open the map at this location instead">🚶 Google Street View ↗</a>`,
    earth: `<a class="pill" href="${esc(urls.earth)}" target="_blank" rel="noopener"
       title="Opens Google Earth looking straight down on this location from about 2 km up">🛰️ Google Earth ↗</a>`,
    apple: `<a class="pill" href="${esc(urls.apple)}" target="_blank" rel="noopener"
       title="Opens Apple Maps at this location; Look Around is one tap away where Apple has coverage">🗺️ Apple Maps ↗</a>`,
  };
}

function mapViewPills(s) {
  const p = mapViewPillParts(s);
  return p ? [p.street, p.earth, p.apple] : [];
}

// The two document libraries, searched by name — so a station with no position
// still gets both, which is the whole point of searching by name.
function docSearchPills(s) {
  const docs = stationDocSearchUrls(s);
  if (!docs) return [];
  return [
    `<a class="pill" href="${esc(docs.fwin)}" target="_blank" rel="noopener"
       title="Searches the Flood Warning Infrastructure Network Program library for &quot;${escAttr(docs.q)}&quot;">📚 Search FWIN docs ↗</a>`,
    `<a class="pill" href="${esc(docs.oohb)}" target="_blank" rel="noopener"
       title="Searches the OOHB FWN Library for &quot;${escAttr(docs.q)}&quot;">📚 Search OOHB docs ↗</a>`,
  ];
}

// ── Copy the coordinate ──────────────────────────────────────────────────────
// Every one of the five pills above *takes* the coordinate somewhere. This is
// the sixth thing an operator wants from a position and the one none of them
// does: hand it over, so it can be pasted into a work order, a radio planning
// tool, a text message to whoever is standing in the paddock. The alternative
// is reading twelve digits off the screen and typing them somewhere else, which
// is the exact operation nobody can check.
//
// Not part of mapLinksHtml(): every pill in that row leaves the site, and this
// one does not go anywhere at all. Same row, same shape, different kind of
// thing — so it is built here and placed by each caller.

// Six decimal places, the same as MapMovePin writes when it saves a dragged
// pin — about 0.1 m, past what a handheld GPS claims. Number() strips the
// trailing zeros toFixed leaves behind, so a coordinate stored as -33.12 is
// copied as "-33.12" rather than as "-33.120000", and one carrying a double's
// seventeen digits is copied as the six that mean anything.
function stationLatLonText(s) {
  if (s == null || s.lat == null || s.lon == null) return '';
  return `${Number(Number(s.lat).toFixed(6))}, ${Number(Number(s.lon).toFixed(6))}`;
}

// Put text on the clipboard, and say whether it landed. Resolves rather than
// rejects, because every caller wants the same thing from a refusal — to say so
// on the button — and a rejected promise makes that a second code path.
//
// The fallback is not decoration. navigator.clipboard is unavailable over plain
// `file://` and over http on a non-localhost host, which is how this app is
// opened often enough to matter, and it is refused outright when the call is
// not close enough to a user gesture. execCommand('copy') is deprecated and
// still the only thing that works in those cases.
function copyToClipboard(text) {
  const value = String(text ?? '');
  if (!value) return Promise.resolve(false);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(value).then(() => true, () => _copyFallback(value));
  }
  return Promise.resolve(_copyFallback(value));
}

function _copyFallback(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    // Off-screen rather than hidden: a display:none textarea cannot be selected,
    // and scrolling the page to a focused element is the visible glitch this
    // avoids.
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_) { return false; }
}

// The pill itself, for the map callout and the station editor card — one place
// it is written, two places it is drawn, the same argument as mapLinksHtml().
// Nothing at all when the station has no position: a button that copies an
// empty string is worse than no button.
//
// `live` is the editor card's version. There the two coordinate boxes are the
// thing being edited — map-move-pin.js writes a dragged position straight into
// them without re-rendering the card, and a person can type over them — so the
// pill reads the boxes at the click instead of the record it was drawn from,
// and its tooltip names where it is reading rather than a figure that may since
// have changed. Everywhere else the coordinate is fixed and rides on the
// button, which is what makes the callout's pill work with no lookup at all.
function copyLatLonPillHtml(s, { live = false } = {}) {
  const text = stationLatLonText(s);
  if (!text) return '';
  return `<button type="button" class="pill mn-copy-latlon"${live ? '' : ` data-mn-latlon="${escAttr(text)}"`}
       onclick="${live ? 'editorCopyLatLon(this)' : 'copyStationLatLon(this)'}"
       title="${live
         ? 'Copy the latitude and longitude in the boxes above to the clipboard, as decimal degrees'
         : `Copy ${escAttr(text)} to the clipboard — decimal degrees, ready to paste into a map, a work order or a message`}"
       >📋 Copy lat, lon</button>`;
}

// The click. The coordinate rides on the button, so the callout's pill needs no
// lookup at all — but a caller may hand one in instead, which is what the editor
// card does: the two boxes above its pill are live, and a pin dragged into them
// or a figure typed over them has to be what gets copied. Reading them at the
// click is the only version of that which cannot go stale.
//
// The label says what happened and puts itself back. Guarded on isConnected
// because the likeliest place to press this is a Leaflet popup, and a popup
// closed inside the 1.6 s is a button that no longer exists.
function copyStationLatLon(btn, text) {
  if (!btn) return;
  const value = (text != null ? text : btn.getAttribute('data-mn-latlon')) || '';
  const prev  = btn.textContent;
  const flash = (label, said) => {
    btn.textContent = label;
    announce(said);
    setTimeout(() => { if (btn.isConnected) btn.textContent = prev; }, 1600);
  };
  // Only reachable from the editor card, whose boxes can be emptied after the
  // pill was drawn. Saying so beats a button that silently does nothing.
  if (!value) { flash('✗ No position', 'There is no latitude and longitude to copy'); return; }
  copyToClipboard(value).then(ok => ok
    ? flash('✓ Copied', `Copied ${value}`)
    : flash('✗ Copy failed', 'Could not copy the coordinate to the clipboard'));
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
const DB_ORIGIN    = 'https://jjprlritvhdqpvphfrnu.supabase.co';
const DB_ANON_KEY  = 'sb_publishable_PV9VjCM8NQeGAJMuwa5TKA_yX9GWacY';

// ── Which way round to the database ──────────────────────────────────────────
//
// A Supabase project ref is a per-tenant hostname that is linked to from nowhere
// and serves nothing a crawler would read, so no categorisation feed will ever
// classify it — and a filter that denies what it cannot classify denies that.
// The Bureau's does. It is what took floodwarning.net off their network, by way
// of the Access team domain, which fails the identical test for the identical
// reason (docs/floodwarning-net.md).
//
// So where this origin can carry the traffic itself, it does: worker/index.js
// forwards `/api/db/*` to the project, and the browser names one host — the one
// it already loaded the page from — for the app, the sign-in and the data alike.
//
// The list is of origins known to have that Worker in front of them, and the
// default when a host is not on it is the direct URL, which is what every origin
// used before the proxy existed. That way round on purpose: an origin nobody
// anticipated — a colleague's static server, a checkout served from a spare
// port — keeps behaving exactly as it always has instead of 404ing against a
// route that is not there. `file://` has no origin to speak of and is listed
// nowhere, so it takes the direct URL too.
const DB_PROXY_PATH     = '/api/db';
const DB_PROXY_HOSTS    = ['floodwarning.net', 'www.floodwarning.net'];
const DB_PROXY_SUFFIXES = ['.workers.dev', '.pages.dev'];

function dbProxyAvailable() {
  if (typeof location === 'undefined' || location.protocol === 'file:') return false;
  const host = (location.hostname || '').toLowerCase();
  return DB_PROXY_HOSTS.includes(host)
      || DB_PROXY_SUFFIXES.some(suffix => host.endsWith(suffix));
}

const DB_URL = dbProxyAvailable() ? `${DB_PROXY_PATH}/rest/v1` : `${DB_ORIGIN}/rest/v1`;

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
// 48: 0047 (receptions) and 0048 (a base station asking for its token) were
// applied live together — 0047 had waited since its own commit, when the
// connection timed out on every write.
// 51: site surveys (survey_list, survey_receptions, survey_summary).
// 52: a station last seen when it was heard (ingest_http's station_status).
const DB_SCHEMA_VERSION = 52;

// Host without the /rest/v1, for showing the operator where they are pointed.
//
// The project rather than whatever DB_URL currently holds: behind the proxy that
// is a path on this origin, and "reading /api/db/rest/v1…" answers a question
// nobody asked. Every sentence in the app that names this means the database.
function dbHostLabel() {
  try { return new URL(DB_ORIGIN).host; } catch (_) { return DB_ORIGIN; }
}

// …and which way it is being reached, appended to that label where it is not the
// obvious one. Worth a few words on screen because a failed read looks identical
// whether the project is asleep or this origin's Worker is the thing that is
// broken, and those have entirely different fixes.
function dbRouteLabel() {
  return dbProxyAvailable() ? ` (via ${location.host})` : '';
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

// ── Theme: the choice, and what it resolves to (#224) ──────────────────────────
// Four choices. 'system' follows the device's light or dark setting, and is
// what a device that has never chosen gets; 'light', 'dark' and 'sunlight' are
// fixed. Sunlight is the light theme with the contrast turned up, for a phone
// read in full sun — styles.css restates only what changes. The choice is kept
// under 'mn-theme', where the light/dark choice always was, so a choice made
// before there were four still stands. Here rather than beside toggleTheme()
// in app.js because `state` below is built from them, before app.js has loaded.
const THEME_CHOICES = ['system', 'light', 'dark', 'sunlight'];

function themeStored() {
  let v = null;
  try { v = localStorage.getItem('mn-theme'); } catch (_) {}
  return THEME_CHOICES.includes(v) ? v : 'system';
}

function themeResolve(choice) {
  if (choice !== 'system') return choice;
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
  catch (_) { return 'light'; }
}

// ── State ──────────────────────────────────────────────────────────────────────

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
    // The search box is a *stack* of entries, not one box. Each entry carries
    // its own text and its own set of fields to look in, so "these are station
    // numbers" and "these are ALERT addresses" can be two entries that cannot
    // contaminate one another. One entry with every field ticked is the default
    // and is exactly the single box this used to be. The shape, the field keys
    // and how two entries combine are documented over SEARCH_FIELDS in app.js;
    // newSearchRow() there builds this same object, and is what everything
    // except this initial value uses.
    searches:     [{ text: '', name: true, number: true, alert: true }],
    searchMode:   'any',   // 'any' | 'all' — how two or more entries combine
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
  // Blast radius (#161): while true, the focused repeater's links draw red and
  // the stations it alone carries get a red dashed ring — see map-blast.js.
  // A mode on the focus, so clearing the focus clears it too.
  mapBlast: false,
  mapShowLinks:   true,
  // Backbone paths: black lines between repeater pairs within mapMaxLinkKm
  // whose pass-range windows share an ALERT address, and between a repeater and
  // a base station within that same distance. Session-only like the rest of the
  // map display block — see map-backbone.js.
  mapShowBackbone: true,
  mapHideOthers:  false,   // filter box: highlight matches (default) vs hide the rest
  mapKillSpaghetti: true,  // drop pass-range links longer than mapMaxLinkKm
  // km. 120 until #164, then 70, and 100 since — by request each time, and the
  // figures behind the two moves are worth keeping together because they are
  // the same measurement read twice.
  //
  // At 120 km the map draws 1,938 of 3,141 pass-range paths and matches 183
  // backbone pairs; at 70 km, 1,537 and 96; at 100 km, 1,809 and 148. 120 was
  // the *ceiling* — about as far as a VHF hop plausibly reaches — and a map
  // that opens at its ceiling opens as spaghetti, which is what took it to 70.
  // 70 turned out to be the other end of that argument: it is inside the real
  // network, and a hop an operator knows exists and cannot see is a worse
  // failure than a busy map, because one of them looks like missing data.
  // 100 km draws the network that is actually there and still leaves 1,332
  // paths culled. Nothing is lost either way — the slider runs to
  // MAX_LINK_KM_CAP, and Limit link/path length off draws every path however
  // long.
  mapMaxLinkKm:   100,
  mapLinkOpacity: 0.8,     // pass-range lines: 0.1–1.0, applied over their casing
  mapLabelMode:   'auto',  // station name labels: 'auto' (fit the viewport) | 'on' | 'off'
  mapRelated:     true,    // pull pass-range-related repeaters in with the matches
  // Light up watercourses whose name matches the filter box (see MapRivers).
  // The one map display switch that is remembered between visits: it is the only
  // one that costs a network request, so an operator who turns it off means it.
  mapRivers:      localStorage.getItem('mn-rivers') !== 'off',
  // Survey marks & CORS sites (see MapSurvey, #120). On by default now, and
  // remembered like mapRivers: a crew standing at a site wants the benchmarks
  // beside the station without going looking for a checkbox first, and an
  // operator who turns them off means it.
  //
  // Default-on costs nothing at page load, which is what kept it off before.
  // MapSurvey has a MIN_ZOOM of 12 and the Stations map opens fitted to every
  // station in the network — an extent far wider than that — so the layer's
  // opening state is "zoom in to look them up" and no request is made until
  // somebody actually zooms to a site.
  mapSurvey:      localStorage.getItem('mn-survey') !== 'off',
  // Ground height as colour, over whichever base map is picked (see
  // MapElevation, #186). It was a base map until then and is an overlay now,
  // because the ground and the place names are not alternatives — the opacity
  // below is what makes them one picture. Off by default and remembered, on
  // MapContours' terms: it fetches a terrain tile per screenful the moment it
  // is on, so a cold page load has to cost nothing.
  mapElev:            localStorage.getItem('mn-map-elev') === 'on',
  // How much of the ground against how much of the map under it. 0.65 rather
  // than 1: the reason it stopped being a base map is that a full-strength
  // ramp takes the localities and the roads with it, so the figure it opens at
  // has to be one you can still read a name through.
  mapElevOpacity:     Math.max(0.1, Math.min(1,
                        Number(localStorage.getItem('mn-map-elev-opacity')) || 0.65)),
  // LiDAR contour lines (see MapContours, #121). Off by default and not
  // persisted, for MapSurvey's reasons; the interval is the 5 m default
  // SoRT's experience picked as the sane fast one.
  mapContours:        false,
  mapContourInterval: '5',
  // Which DEM the nation holds under a place (see ElvisCoverage). Off by
  // default and not persisted, on MapContours' own terms: it costs tile
  // requests for a view nobody asked a question about, so "no extra requests
  // fire with the layer off" has to stay true of a cold page load. The
  // opacity is a preference rather than a cost, so that one is remembered.
  // The Digital Twin taking the map over at close zoom (map-twin.js). On by
  // default and remembered, for mapRivers' reason: it is how an operator
  // reads the map, and a switch they turned off should stay off.
  mapTwinAuto:        localStorage.getItem('mn-map-twin') !== 'off',
  mapElvisCov:        false,
  mapElvisCovOpacity: Math.max(0.1, Math.min(1,
                        Number(localStorage.getItem('mn-elvis-cov-op')) || 0.6)),
  // The highest ground in view (see MapPeaks). Off by default and not
  // persisted, on MapContours' terms rather than MapSurvey's: a pass costs up
  // to a hundred terrain tiles for a view nobody asked a question about, so
  // "no extra requests fire with the layer off" has to stay true of a cold
  // page load. How many peaks is a preference rather than a cost, so that one
  // is remembered.
  mapPeaks:       false,
  mapPeakCount:   Math.max(3, Math.min(5, +localStorage.getItem('mn-peak-count') || 5)),
  // AS/NZS 1170.2 wind loading regions (see MapWind). On by default and
  // remembered since #176, on MapSurvey's terms rather than MapContours'.
  // "A layer that costs a request stays off until asked for" was the rule that
  // kept it off, and it does not hold here: the station card asks the same
  // file for its Wind region line the moment anybody opens a station, so
  // having the layer off never avoided the 650 KB fetch — it only meant the
  // map stayed silent about which regions the network crosses until somebody
  // went looking for a checkbox. An operator who turns it off means it.
  mapWind:        localStorage.getItem('mn-wind') !== 'off',
  // Road parcels from the Queensland cadastre (see MapRoads, #176). On by
  // default and remembered, on MapSurvey's terms — and for MapSurvey's exact
  // reason, which is that MIN_ZOOM does the work the default-off was doing.
  // The layer only draws from about zoom 13, the Stations map opens fitted to
  // the whole network, and no request is made until somebody zooms to a site —
  // which is the moment "whose road reserve is this?" is worth answering, and
  // the moment a checkbox stands between the operator and the answer.
  mapRoads:       localStorage.getItem('mn-roads') !== 'off',
  // Property / lot boundaries from the same Queensland cadastre (see MapLots).
  // On by default and remembered, on MapRoads' terms and for MapRoads' reason:
  // the scale gate does the work the default-off was doing. The lines draw
  // below about 1:40,000 and the Stations map opens fitted to the whole
  // network, so a cold load still makes no request — the first goes out when
  // somebody zooms to a site, which is when "whose land is this mast on?" gets
  // asked. An operator who switches them off means it.
  //
  // Its own key rather than the 'mn-lots' the layer shipped with. That one was
  // written while the layer was off by default, when unticking it only meant
  // "back to the default"; read under this default, it would keep the lines
  // hidden from exactly the people who had tried them once.
  mapLots:        localStorage.getItem('mn-property-boundaries') !== 'off',
  // The 77 Queensland drainage basins (see MapCatchments). Off by default and
  // remembered, on MapContours' terms rather than MapWind's: nothing else in
  // the app asks data/qld-basins.geojson for anything, so unlike the wind
  // regions the 760 KB really is avoided by leaving the layer off, and a
  // basin outline is context somebody goes looking for rather than context
  // every session wants.
  mapCatchments:  localStorage.getItem('mn-catchments') === 'on',
  // The Bureau's eight maintenance hub boundaries (see MapHubs). Off by
  // default and remembered, for the same reasons.
  mapHubs:        localStorage.getItem('mn-hubs') === 'on',
  // Line-of-sight check on drawn links (see MapLos). Off by default and not
  // persisted, for MapSurvey's reasons — it fetches terrain tiles on enable.
  mapLos:         false,
  // The Stations map in three dimensions (see Map3D, map-3d.js). Session-only
  // for mapFullscreen's reason: it is a mode an operator is in right now, not a
  // standing preference — and a tab that *opens* by fetching a megabyte of
  // WebGL renderer and a screenful of terrain has decided something on their
  // behalf that costs real bandwidth.
  map3d:          false,
  // The line-of-sight sheets in that view: a surface between each hop's ray and
  // the ground under it. Off by default and not persisted, for MapLos' reason
  // and the same cost — one terrain profile per hop on enable.
  map3dSheets:    false,
  // Vertical exaggeration of the relief, 1–3×. Remembered, unlike the two
  // above, because it is not something an operator is doing right now, it is
  // how they read a landscape. 1× is the default because it is
  // the truthful one — the slider says what it is doing, and anything above 1
  // is a taller picture of the same ground, not more of it.
  map3dExag:      Math.max(1, Math.min(3,
                    Number(localStorage.getItem('mn-3d-exag')) || 1)),
  // What the link colours mean (#186): 'freq' — the channel the hop runs on
  // (MapFreq, and the default); 'fade' — the fade margin in three bands
  // (MapFade); 'plain' — the one link colour the map drew for its whole life
  // before either existed. One radio group rather than two checkboxes, because
  // both want the same channel: the colour of the core line.
  //
  // Remembered, and the default is the frequency for the reason map-freq.js
  // gives at length — it is recorded rather than computed, so it is complete
  // and free the moment the file loads, which is what a default has to be.
  mapLinkColour:  mapLinkColourFromStorage(),
  // Fade-margin colouring on drawn links (see MapFade). Derived from the radio
  // group above so the two can never disagree, and kept as its own flag because
  // MapFade, MapLos, the legend and the map-display block have all asked
  // `state.mapFade` since long before there was a third option.
  mapFade:        mapLinkColourFromStorage() === 'fade',
  // Direction arrowheads along every drawn link (see MapArrows). On by default
  // and remembered: it costs nothing — no request, no computation, one canvas
  // painted off lines that are on the map already — so the rule that keeps
  // MapContours and MapPeaks off until asked for does not apply. An operator
  // who turns them off means it.
  mapArrows:      (localStorage.getItem('mn-map-arrows') || 'on') === 'on',
  // Where green stops being green and yellow stops being yellow, in dB of fade
  // margin. Higher than the link budget card's own bands (10 / 3) on purpose:
  // the card asks "would this link work", the map asks "which of these would I
  // rebuild first", and the second question wants more headroom before it says
  // green. Saved with every row, so a figure read back later carries the rule
  // it was judged under — and adopted *from* the rows when this browser has no
  // opinion of its own, which is what mapFadeBandsSet records.
  mapFadeGoodDb:  Number(localStorage.getItem('mn-map-fade-good') || 15),
  mapFadeOkDb:    Number(localStorage.getItem('mn-map-fade-ok') || 6),
  mapFadeBandsSet: localStorage.getItem('mn-map-fade-good') != null,
  // The map fills the viewport (see toggleMapFullscreen, app.js). Session-only
  // for mapSurvey's reasons: full screen is something an operator is doing
  // right now, not a standing preference — and a page that *opens* with a
  // full-screen map has hidden its own navigation.
  mapFullscreen:  false,
  // Which on-map control panels (see MapChrome, map-controls.js) the operator
  // has pinned open. Persisted, and the one thing about those panels that is:
  // a pin is a standing preference about how this operator reads a map, not
  // something they are doing right now. Everything else about a panel — which
  // one is hovered, which one was clicked open — dies with the map it was on.
  // It means something only where a panel is in a map's corner: the six maps
  // that have no side panel beside them. The Stations map's panels are panes
  // of the side panel at every width — drawers from its rail on a phone — and
  // a pane has no pin.
  mapPanelsPinned: new Set((localStorage.getItem('mn-map-panels') || '')
                             .split(',').map(s => s.trim()).filter(Boolean)),
  mapMatchLabels: new Set(),  // ids the current filter earned a label (see mapLabelIds)
  // Last refresh, for the map-display note: drawn, culled by the distance
  // slider, hidden with the stations they run to (#176), and the backbone
  // pair counts beside them.
  mapLinkCount:   { drawn: 0, culled: 0, hidden: 0, backbone: 0, backboneHidden: 0 },
  mapFitKey:      null,    // extent the map was last auto-fitted to (re-fit only on change)
  mapSearchTimer: null,    // debounce for the search box → marker rebuild
  passRelIdx:     null,    // both directions of the pass-range relation, per loaded file
  backboneIdx:    null,    // repeater backbone pairs + suggested delays, per loaded file
  // The Stations tab's filters, open or shut (#165) — in the Stations card
  // since the filters and the list became one card. Remembered, and it is
  // the one collapsible on that tab that is: Path profile and Link budget are
  // opened to answer a question and closed again, while the filters are how the
  // tab is operated — so an operator who shuts them to give the map the screen
  // means it.
  //
  // Shut on a first visit since #181. It used to open, and the reason given was
  // that "the search box is the most-used control on the page and a tab that
  // opens hiding it reads as broken" — which was true of a card whose head row
  // held a heading and a note. That head row now carries the search box and
  // both clear buttons, so the most-used control is on the screen either way,
  // and what the default decides is only whether the eight blocks of grouped
  // filters underneath it are, which on arrival they need not be.
  //
  // **Beside the map it lands shut, whatever was stored (#191).** Above `lg`
  // the cards are in the side panel beside the map (stationsSplitActive,
  // app.js), and the filters are the first thing in that pane — so a stored
  // "open" would land on a pane whose whole height is eight blocks of tick
  // boxes, with the list they filter below the fold. That is not what the pane
  // is for. So the landing state there is shut; pressing Filters still opens
  // it, and still writes the preference, which is honoured on every visit
  // between `xs` and `lg`, where the cards are under the map in one long page.
  // A phone lands shut for the same reason as a wide screen: its cards are a
  // pane of the side panel too, a drawer over the map, and eight blocks of
  // tick boxes are the whole of a drawer's height there.
  // Deliberately not a write: this reads the stored value and overrides it for
  // one page load, so nobody's setting is destroyed by having opened the tab
  // on a wide screen once. The media queries are stationsSplitActive()'s,
  // written out here because app.js has not loaded yet.
  filtersOpen:    (localStorage.getItem('mn-filters') || 'closed') === 'open'
                  && !(typeof window !== 'undefined' && window.matchMedia
                       && (!window.matchMedia(`(max-width: ${BREAKPOINTS.lg}px)`).matches
                           || window.matchMedia(`(max-width: ${BREAKPOINTS.xs}px)`).matches)),
  // The station list on the same tab — the scroller in the Stations card,
  // under its filters — and remembered for the same reason.
  // It is the tallest card on the page — a scroller capped at most of the
  // viewport — so shutting it is how the map, the path tools and the editor
  // card get onto one screen together. Open on a first visit: the list is half
  // of what this tab is, and a tab that opens showing an empty box where 3,174
  // stations should be reads as a file that failed to load.
  stationsListOpen: (localStorage.getItem('mn-stations-list') || 'open') === 'open',
  // The station the on-map card (bottom-left of the Stations map) is showing
  // (#175). Session-only, and deliberately NOT selectedId — a fourth thing
  // alongside the filters, selectedId and the map selection (see the
  // map-selection note in app.js): a plain pin click paints this without
  // selecting, so glancing at stations doesn't drag the editor and the table
  // along. `opener` follows state.acma.cardOpener's pattern (showAcmaCard).
  stnCard: { id: null, opener: null },
  // Left nav: an icon rail, or icons plus labels. Kept under 'mn-nav' the same
  // way the theme and the filter card are. With nothing stored the window's
  // width decides, so a first visit on a laptop isn't handed two sidebars.
  navCollapsed:   (localStorage.getItem('mn-nav')
                   || (window.innerWidth < NAV_AUTO_COLLAPSE_PX ? 'collapsed' : 'expanded')) === 'collapsed',
  // What is typed in the nav's "find a tab" box (#108). Deliberately *not*
  // persisted: a filter is a thing you are doing now, and a nav that opens
  // already showing four of its twenty tabs — with no memory of why — reads as
  // broken rather than as remembered. It is cleared by Escape, by picking a tab,
  // and by every reload.
  navQuery:       '',
  // The side panel (#help-panel, the "dock"): a strip of tab buttons on the
  // right-hand edge, and — while it is open — one pane beside it, which is the
  // help for this tab, the Stations cards, or one of the Stations map's panels
  // (on a phone, beside the Stations tab's rail or the help's edge tab, as a
  // drawer over the page). Two
  // questions kept apart on purpose, because they are answered at different
  // times: *whether* it is open, and *which* pane it would like to show.
  //
  // Open or shut is kept under 'mn-help', the key the help rail it grew out of
  // used, and with the same two words in it. What changed is the default: open.
  // It used to start shut at every width, because a reference surface that
  // opens itself on every load is one people learn to close rather than read.
  // That argument is about help, and the pane this opens on by default is not
  // help — it is the Stations cards, which are half of what that tab is.
  //
  // A browser that has a 'mn-help' but no 'mn-dock-tab' is one whose answer was
  // given about the help rail, before there was a side panel to give it about:
  // "collapsed" there meant "I have read the help", not "hide the Stations cards
  // from me". So until the side panel has been used once — every change to it
  // writes both keys (dockPersist, app.js) — the first visit is treated as a
  // fresh one, and the Stations tab opens with its cards beside the map.
  dockOpen:       localStorage.getItem('mn-dock-tab') == null
                  || (localStorage.getItem('mn-help') || 'expanded') === 'expanded',
  // Which pane, remembered: 'help', 'stations', or 'map-<panel id>' for one of
  // the Stations map's panels. A pane that does not exist where you are — the
  // Stations cards on any other tab or between `xs` and `lg`, where they are
  // under the map, a map panel on a tab with no Stations map — leaves the side
  // panel shut *there* without this being touched, so
  // coming back to the tab that has it opens it again. That is also what keeps
  // help from opening itself: on a fresh visit this says 'stations', and only
  // one tab has those.
  dockTab:        localStorage.getItem('mn-dock-tab') || 'stations',
  // How wide the open pane is, in px, not counting the strip. Stored as the
  // operator left it and clamped at the moment of use (dockWidthRange, app.js)
  // — never clamped in storage, so a window that was narrow for a while gives
  // the wider figure back when it is wide again.
  dockW:          Number(localStorage.getItem('mn-dock-w')) || DOCK_DEFAULT_W,
  // Two more things about the side panel, both a phone's alone (below `xs`),
  // and both there because the Stations map is the whole of a phone's screen:
  //
  //   dockRail    whether the rail of the side panel's buttons stands down the
  //               right-hand edge of the Stations map, taking its width, or is
  //               put away behind ⋮ at the right-hand end of the banner
  //               (toggleDockRail, app.js). The operator's, under
  //               'mn-dock-rail'; put away on a first visit, because the map is
  //               what a phone was opened to look at.
  //   dockDrawer  whether one of its panes is open over the page as a drawer.
  //               Never restored. dockOpen above is the side panel being open
  //               on a pane, written at every width and read at every width,
  //               and read on a phone it laid the Stations cards over the map
  //               on arrival — and again on every turn of a phone from
  //               landscape, where the cards are under the map, to portrait,
  //               where they are one of the side panel's panes. So a drawer is
  //               only ever one somebody opened on this screen (setDockTab),
  //               or one they were working in as the window narrowed to a
  //               phone's (dockPhoneCheck).
  dockRail:       localStorage.getItem('mn-dock-rail') === 'shown',
  dockDrawer:     false,
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
    // Ground cover on the profile (see LandCover): trees, buildings and crops
    // sampled along the path and stood on the terrain, in the Fresnel check and
    // in the propagation model both. On by default — it is one request per
    // profile, and a profile without it is the one that reads clear through a
    // forest. Remembered, because turning it off is a standing choice.
    cover:   (localStorage.getItem('mn-path-cover') || 'on') === 'on',
  },
  // Link budget card. The endpoints have to outlive a tab switch — half an hour
  // of what-ifs should not be thrown away by looking at the Pass Ranges tab.
  link: {
    open:    false,
    picking: false,  // map clicks are setting endpoints
    a:       null,   // { kind:'station'|'point', …, def:{}, over:{} } — see LinkBudget
    b:       null,
    freqMhz: null,
    // The propagation model's own inputs — Radio Mobile's network properties,
    // one for one, and starting from the same figures the Radio Mobile export
    // writes (RM_NET_DEFAULTS) so the two tools argue from the same premises.
    // Session-only, like the antenna overrides: a what-if, not a setting.
    prop: {
      climate:    RM_NET_DEFAULTS.Climate,        // 1..7, ITM's radio climates
      N0:         RM_NET_DEFAULTS.Refractivity,   // surface refractivity, N-units
      epsilon:    RM_NET_DEFAULTS.Permittivity,   // ground relative permittivity
      sigma:      RM_NET_DEFAULTS.Conductivity,   // ground conductivity, S/m
      pol:        RM_NET_DEFAULTS.Polarization,   // 0 horizontal, 1 vertical
      mdvar:      RM_NET_DEFAULTS['Stat. mode'],  // 0 spot, 1 accidental, 2 mobile, 3 broadcast
      time:       RM_NET_DEFAULTS['%Time'],
      location:   RM_NET_DEFAULTS['%Location'],
      situation:  RM_NET_DEFAULTS['%Situation'],
    },
    // Which of the card's disclosures are open: the propagation settings and
    // the cover-height table. Shut by default — they are the premises, and the
    // figure is what the card is opened for.
    propOpen:  false,
    coverOpen: false,
    // Which end the next station pick fills: a click on the map, or a row in
    // the Stations list under it. null is the original behaviour — A, then B,
    // then A again. Putting the caret in an end's search box arms that end,
    // which is what lets "this end, from over there" be said at all.
    target:  null,   // null | 'a' | 'b'
    // What is typed in each end's search box. One string per end, because the
    // two ends are two questions and answering one must not disturb the other.
    q:       { a: '', b: '' },
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
  // The automatic load while it is under way, and what it tried (app.js,
  // autoLoad; #212): { busy, kind, got, total, about, retry,
  // tried: [{ kind, error }] } — `total` the exact size when it can be known,
  // `about` the size this source had last time on this device.
  // Null until it starts. What a data tab shows before the list arrives is
  // read from here — loading, from where and how far, or what failed — so
  // "No data loaded" is never said while data is on its way.
  load:           null,
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
  nvMapBackbone:  [],   // repeater backbone paths on the mini-map — see refreshNvMap
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
  // HFEM tab (#154). The pasted capture is the only thing worth keeping across a
  // tab switch — the decode is recomputed from it and cached against the text
  // it was made from, the same trade a2 makes below and for the same reason.
  // The builder's fields are kept too: a message half-built is worth as much as
  // a capture half-read, and losing it on a tab switch would be the same bug.
  hfem: {
    text:      '',      // pasted capture, verbatim
    parsed:    null,    // last HfemTab.parse() result
    parsedKey: '',      // the text that parse was made from
    builder: {
      site: '123456',
      tscheme: 'T1',
      stamp: '20260818030000',
      offset: 10,
      maintenance: false,
      sensors: [
        { cls: 'R', instance: 1, scheme: 6,  value: '12.4' },
        { cls: 'H', instance: 1, scheme: 16, value: '1.482' },
      ],
    },
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
    watch:     null,        // { src, follower, name } — a log followed as it grows (log-follow.js)
    watchMs:   2000,        // the whole tab re-renders on each change, so not every second
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
    // Whatever opened the transmitter card, so closing it can put focus back
    // where it came from (#138). Not persisted anywhere — it is an element.
    cardOpener: null,
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
  // Inspection History (#118 — lazy, like the two form tabs it reads for. It
  // holds no form and no draft: everything here is either a list off the
  // datastore or one saved record, and both are re-read rather than kept.)
  hist: {
    query: '',           // the station picker's search box
    station: null,       // { id, name, number } the history is scoped to, or null for all
    unmatched: false,    // the third scope (#128): imported visits parked with no station
    list: null,          // the merged inspection + maintenance timeline, newest first
    listBusy: false,
    listError: null,
    flags: null,         // inspection id → meganet.inspection_needs_maintenance rows
    open: null,          // { kind, id, doc } the record on screen
    openBusy: false,
    openError: null,
    msg: null,           // one line in the toolbar — a file that would not sign, mostly
    // storage_path → signed URL, for as long as this record is open and no
    // longer. A signed URL is only as private as the path it signs (#149), so
    // it is never written anywhere that outlives the view.
    urls: {},
  },
  // The Inspections section at the foot of the station editor card
  // (station-inspections.js). Per station and re-read when the selection moves:
  // a station's inspection record is somebody else's to change, and holding a
  // second station's numbers would only ever be a chance to draw the wrong one.
  //
  // `params` is session state and deliberately *not* per station — an operator
  // comparing battery voltage across three sites should not have to re-tick it
  // at each one. It survives a tab switch and not a reload.
  stationInsp: {
    stationId:  null,   // the station the rows below belong to
    visits:     null,   // meganet.inspection rows for it, oldest first, or null while loading
    busy:       false,
    capped:     false,  // more visits than the chart will hold — said out loud, not hidden
    error:      null,
    // home table → { busy, rows, error }. Fetched per table as a parameter from
    // it is first ticked, and dropped whole when the station changes.
    byHome:     {},
    // meganet.measurement_field, filtered to the fields that are one number per
    // visit. The vocabulary is public, so this loads signed out even though the
    // readings do not.
    fields:     null,
    fieldsBusy: false,
    fieldsError: null,
    // The ticked parameters, in the order they were ticked. The two defaults
    // are named in station-inspections.js, which is also where the reason they
    // are these two is written down.
    params:     ['fade_margin_db', 'battery_under_load_v'],
    pickerOpen: false,
    tableOpen:  false,
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
  // Field photos (field-photos.js, 0035). The queue is state, not DOM, so it
  // carries on reading and uploading behind another tab and is all still there
  // when this one comes back; byId is every photo this session has seen,
  // whichever door it came in by, so the viewer never asks twice.
  photos: {
    types: null,         // the image rows of meganet.attachment_type
    typesLoading: false,
    typesP: null,
    typesError: null,
    queue: [],           // files being read and uploaded — see FieldPhotos._queue for the shape
    packs: [],           // zips opened into the queue, a line each (photo-zip.js)
    reading: false,
    uploading: false,
    readLabels: false,   // "Read equipment labels after upload" — off unless ticked
    logError: null,      // why the last upload's outcomes could not be logged (0036), if they could not
    review: null,        // the Review panel's state, made by photo-review.js when first drawn
    msg: null,           // { text, kind } — the line under the drop zone
    lib: null,           // the library's rows, for the filter below
    libKey: '',
    libLimit: 60,
    libLoading: false,
    libError: null,
    unplacedCount: null,
    filter: { show: 'all', station: '' },   // all | unplaced | dropbox | station
    sync: null,          // meganet.field_photo_sync rows
    syncError: null,
    byId: {},            // id → row
    near: {},            // box key → { at, p } — the twin's and the map's queries, a minute each
    urls: {},            // object path → { url, at } signed for this session
  },
  // The Stations map's 📷 layer (map-photos.js). On unless switched off: it
  // draws nothing for a session that is not signed in, and a photo somebody
  // took is the first thing they will look for.
  mapPhotos:     localStorage.getItem('mn-field-photos') !== 'off',
  // The theme picked, and what it comes to: every module reads `theme`, which
  // is 'light', 'dark' or 'sunlight' — never 'system' — so `=== 'dark'` stays
  // the right question everywhere it is asked (#224).
  themeChoice: themeStored(),
  theme: themeResolve(themeStored()),
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

// ── The app's live region (#109) ──────────────────────────────────────────────
// One polite region, in index.html, and this is the only thing that writes to
// it. U5 (#140) has three streaming surfaces — ALERT packets, ALERT2 frames,
// the serial monitor — and needed a policy to apply rather than one to invent,
// so here is the policy, in four rules:
//
//   1. Announce the *result of something the user did*, and nothing else. A
//      tab opened, a filter narrowed to three, a record saved, an import
//      rejected. Never a clock, never a progress percentage, never data that
//      arrived on its own.
//   2. Never per-frame. A stream is not an announcement — a packet decoder
//      that announces each packet is a screen reader that cannot be silenced
//      short of leaving the page. A streaming surface announces when it starts
//      and when it stops, and offers a summary on demand; the frames
//      themselves live in a log the user reads at their own pace.
//   3. Polite, always, from here. `assertive` interrupts whatever the user is
//      currently being read, which is right for exactly one thing — an error
//      that has just destroyed what they were doing — and that case belongs to
//      Modal or to a visible banner, both of which move focus and so announce
//      by themselves.
//   4. Say what changed, not that something changed. "Networks — 12 radio
//      networks" is an announcement; "updated" is a noise.
//
// The region is cleared before it is written, because a region assigned the
// same string twice announces once — the second "3 of 19 tabs" after a
// backspace and a retype would otherwise be silent.
function announce(message) {
  const el = document.getElementById('app-status');
  if (!el) return;
  const text = String(message ?? '').trim();
  el.textContent = '';
  if (!text) return;
  // A microtask is not enough — the region has to be observed empty between
  // the two writes, and that means a frame.
  requestAnimationFrame(() => { el.textContent = text; });
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

// The seven colours are the document's now, not this file's (#138), for the
// reason #141 gave about the twelve ARRO series colours: a palette written into
// a JavaScript object cannot follow the theme, and #6d4c41 — co-site desense,
// the mechanism with the most candidates in the current extract — is a dark
// brown that on a #18222d panel could not be seen at all.
//
// `color` stays, and stays the light literal, because five of the twelve
// consumers are Leaflet options (`L.polyline({color})`, `L.polygon({color})`)
// which become SVG *presentation attributes*, and a presentation attribute does
// not accept `var()`. Those five are the Stations map layer and belong to #136;
// this file gives it the two things it needs to convert them whenever it likes
// and changes none of them. See docs/design-system.md §3, "the ACMA boundary".
//
// Which of the two to reach for:
//   acmaMechVar()   — a CSS context (a `--dot` on a swatch, a `fill:` in a
//                     stylesheet). The token reaches the element; the theme
//                     reaches it for free, with no repaint.
//   acmaMechColor() — an SVG presentation attribute or a canvas, where a
//                     `var()` resolves to nothing. Resolved off the document at
//                     draw time, so a theme change reaches it on the next draw.
const ACMA_MECH = {
  co_channel:     { label: 'Co-channel',          color: '#d32f2f', token: '--acma-mech-co-channel' },
  adjacent:       { label: 'Adjacent channel',    color: '#f57c00', token: '--acma-mech-adjacent' },
  imd3:           { label: 'Intermod IMD3',       color: '#7b1fa2', token: '--acma-mech-imd3' },
  imd5:           { label: 'Intermod IMD5',       color: '#ce93d8', token: '--acma-mech-imd5' },
  imd3_triple:    { label: 'Intermod 3-signal',   color: '#9575cd', token: '--acma-mech-imd3-triple' },
  harmonic:       { label: 'Harmonic',            color: '#0288d1', token: '--acma-mech-harmonic' },
  cosite_desense: { label: 'Co-site desense',     color: '#6d4c41', token: '--acma-mech-cosite-desense' },
};

function acmaMechVar(mech) {
  const t = (ACMA_MECH[mech] || {}).token;
  return t ? `var(${t})` : 'var(--muted)';
}

function acmaMechColor(mech) {
  return cssVar((ACMA_MECH[mech] || {}).token, (ACMA_MECH[mech] || {}).color || '#666');
}

// The same pair for station roles (#136), and the last palette in the app that
// could not follow the theme. ROLE_COLOR's four literals stay, and stay light,
// for the same reason ACMA_MECH[k].color did: the map's pins are Leaflet
// options, which become presentation attributes, and a pin is drawn on tiles
// behind a white ring rather than on the page's own ground.
//
// Everything drawn *on the page* — the legend dots, the filter rows' role
// swatches, the popup's role pills — takes roleVar() instead, and follows the
// theme. --role-* has a dark set; ROLE_COLOR does not and cannot.
// The ink a filled mechanism pill takes (#136). A categorical palette has no
// single legible ink over all of it — white fails four of these seven and
// near-black fails three — so each hue is paired with its own, in the token
// block beside the hue itself.
function acmaMechInkVar(mech) {
  const t = (ACMA_MECH[mech] || {}).token;
  return t ? `var(${t}-ink, var(--acma-mech-ink))` : 'var(--text)';
}

function roleVar(role) {
  return ROLE_LABEL[role] ? `var(--role-${role})` : 'var(--muted)';
}

function roleColor(role) {
  return cssVar(ROLE_LABEL[role] ? `--role-${role}` : null, ROLE_COLOR[role] || '#666');
}

// What a token resolves to *right now*, for the places a `var()` cannot go: an
// SVG presentation attribute, a canvas fill, a Leaflet option. Six files had
// written this line out by hand before #138 (app.js, arro-data.js twice,
// map-draw.js, map-rivers.js, network-view.js), which is five more chances to
// forget the `.trim()` — getPropertyValue returns the declaration's whitespace
// and ` #0b5cab` is not a colour any of those three contexts accepts.
//
// Which link colouring the map opens with (#186). A function rather than a
// literal because `state` needs the same answer twice — once for
// mapLinkColour and once for the derived mapFade — and hoisting makes it
// readable from the object literal above.
//
// The second clause is the migration: this setting replaced a plain on/off
// switch for the fade-margin colouring, and an operator who had that switch on
// finds their map coloured the same way it was rather than silently swapped to
// the new default.
function mapLinkColourFromStorage() {
  let saved = null, fade = null;
  try {
    saved = localStorage.getItem('mn-map-link-colour');
    fade  = localStorage.getItem('mn-map-fade');
  } catch (_) { /* private mode, or storage disabled — take the default */ }
  if (saved === 'freq' || saved === 'fade' || saved === 'plain') return saved;
  return fade === 'on' ? 'fade' : 'freq';
}

// The fallback is not decoration. A token misspelt here resolves to the empty
// string and the attribute silently draws in black, which on a dark panel is a
// line nobody can see and nothing throws.
function cssVar(name, fallback = '') {
  if (!name) return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

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

