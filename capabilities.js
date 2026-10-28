// MegaNet — capabilities.js
//
//   Capabilities   📇 the Capabilities tab, under Start here between the Site
//                  Map and Offline & Install: everything Flood-Net can do, a
//                  line each — what it is, who it is for, and a link to the
//                  place it is done — with a box that narrows the list as you
//                  type.
//
// After core.js (TAB_LIST, tabShown, esc, termHtml, dlText, announce) and
// app.js (switchTab); toast.js at call time. Nothing runs at load:
// renderMain() calls render() and init().
//
// ── Why a page of its own ────────────────────────────────────────────────────
//
// The Site Map is a card per tab. Most of what the app can do is not a tab: it
// is a layer on the Stations map fed from somebody else's server, a button on
// a station's card, a fold half-way down Station Health, a job the database or
// the Worker does on its own. Nobody finds those by reading the bar on the
// left. So this page lists the things themselves, one line each — short
// enough to scan, every one of them on the page at once so the browser's own
// Ctrl+F finds them too — and each name is a link to the tab it is done on,
// with where on that tab to look.
//
// ── What it says, and where that comes from ─────────────────────────────────
//
// GROUPS below is written by hand, a line per capability: the name, the tab
// it is done on (or the banner tool, or the page of its own), where on that
// tab, one sentence on what it gives, who may use it and, for anything drawn
// from outside Flood-Net, whose it is. A line can open what it names once its
// tab is up — a panel on the Stations map, with the Layers panel's own find
// box filled in so it shows the one switch, or a pane of the side panel. A tab's
// label and icon are read from TABS, never restated, so a rename reaches this
// page by itself. `npm run nav` holds every tab in TABS to having at least one
// line here and every line to naming a real tab, so a tab added without a
// line, or a line left pointing at a tab that has gone, fails the check.
//
// Who: '' is anybody, signed in or not; 'signin' needs an account of any kind;
// 'member' an account an administrator has approved; 'editor' an editor or an
// administrator; 'admin' an administrator; 'list' the people on that tool's
// own list. That is who may *use* it — most admin tabs are listed to everyone and say who they
// are for once opened. A line on a tab kept to a list of people (`who:` on its
// TABS entry, tabShown()) is left off for anyone not on it, as the Site Map
// and the bar leave the tab itself.
//
// ── The search ──────────────────────────────────────────────────────────────
//
// The nav's find box's rule, made stricter: every word typed has to start a
// word somewhere on the line — its name, what it does, where it is, its
// source, its group, its tab, its tag or its own find words — because here
// the point is to narrow a long list, not to pick the one best tab. The words
// that matched are marked in the name and the sentence (mark.hit, the Stations
// filter's highlight). The query and the "who" pick are kept while the app is
// open, so going to a capability and coming back finds the list as it was.

const Capabilities = (function () {
  // ── The words this page uses that mean something particular ───────────────
  // Hover on a tag, and the fold at the foot of the page, both read this.
  const WHO = {
    signin: { label: 'Sign-in',
      meaning: 'Needs you signed in with a Flood-Net account — any account. Signed out you can look at the tab, but not use this.' },
    member: { label: 'Approved account',
      meaning: 'Needs an account an administrator has approved — a confirmed Bureau address is approved by itself. Signed out, or still waiting, you cannot see this.' },
    editor: { label: 'Editors',
      meaning: 'For editors and administrators: anybody can look, but only an account given the editor role can change or save this.' },
    admin:  { label: 'Admin only',
      meaning: 'For administrators only — accounts given the admin role on the Admin tab. Others are told who it is for once they open it.' },
    list:   { label: 'On the list',
      meaning: 'Only for the people the owner has put on this tool\'s own list; anyone else is not shown it at all.' },
  };
  const SOURCE_MEANING = 'Comes from the organisation named, not from Flood-Net\'s own records — fetched as you look, or copied in from what they publish. It is only as current as they keep it.';
  const WORDS = [
    ['Admin only', WHO.admin.meaning],
    ['Editors', WHO.editor.meaning],
    ['Approved account', WHO.member.meaning],
    ['Sign-in', WHO.signin.meaning],
    ['On the list', WHO.list.meaning],
    ['A name in a dashed outline', SOURCE_MEANING],
  ];

  // The banner's tools, run from a line here rather than reached by a tab.
  // Each is looked up when pressed, so a module missing on this page is a line
  // that does nothing rather than a page that will not draw.
  const ACTS = {
    palette:  () => typeof Palette !== 'undefined' && Palette.open(),
    navfind:  () => typeof focusNavFind === 'function' && focusNavFind(),
    share:    () => typeof Route !== 'undefined' && Route.share(),
    help:     () => typeof setHelpCollapsed === 'function' && setHelpCollapsed(false),
    theme:    () => typeof openThemeMenu === 'function' && openThemeMenu(),
    whatsnew: () => typeof WhatsNew !== 'undefined' && WhatsNew.open(),
    bug:      () => typeof BugReport !== 'undefined' && BugReport.open(),
    export:   () => typeof ExportMenu !== 'undefined' && ExportMenu.open(),
    memory:   () => typeof MemMeter !== 'undefined' && MemMeter.togglePanel(),
    signin:   () => typeof Auth !== 'undefined' && Auth.open(),
  };

  // ── Everything it can do ───────────────────────────────────────────────────
  // name   what it is called (plain text).
  // tab    the TABS id it is done on — or act, a banner tool run from here
  //        (ACTS below), or href, a page of its own beside the app.
  // where  where on that tab, after its name; said again in a note when the
  //        name is pressed, so a switch half-way down a panel can be found.
  // open   what to open once the tab is up: { panel, find } a panel on the
  //        Stations map (MapChrome's id; `find` typed into the Layers panel's
  //        own find box, so it lands on the one switch), or { dock } a pane of
  //        the side panel.
  // what   one sentence: what a person gets.
  // who    '' | 'signin' | 'member' | 'editor' | 'admin' | 'list' (WHO above).
  // src    whose data, for anything not Flood-Net's own.
  // find   extra words somebody might search by.
  const L = find => ({ panel: 'display', find });   // a switch in 🗺️ Layers
  const GROUPS = [
    { key: 'around', icon: '🧭', name: 'Getting around',
      blurb: 'Finding your way, and the tools in the banner that work on every tab.',
      items: [
        { name: 'Home page', tab: 'home',
          what: 'How the network is right now — stations OK, on watch or at fault — and the tools used most as big tiles.' },
        { name: 'Site Map', tab: 'sitemap',
          what: 'A card for every tab saying what it is for and when to reach for it, with a gold line to its button.' },
        { name: 'Capabilities', tab: 'capabilities',
          what: 'This page: everything Flood-Net can do, searchable, each line opening the place it is done.' },
        { name: 'Search anything', act: 'palette', where: 'the banner › 🔎 Search, or Ctrl+K',
          what: 'One box for a station by name, number or ALERT address, a place, a survey mark, a tab or an action.',
          find: 'ctrl+k palette jump' },
        { name: 'Find a tab by what it does', act: 'navfind', where: 'the bar on the left › 🔎',
          what: 'Narrows the bar on the left to the tabs that do what you type — "decode", "battery", "print".' },
        { name: 'Share a link to here', act: 'share', where: 'the banner › 🔗 Share',
          what: 'Sends the address of what you are looking at — the tab, a station, the map\'s view — or copies it.',
          find: 'url bookmark send' },
        { name: 'Help for every tab', act: 'help', where: 'the side panel › ❔ Help',
          what: 'Explains the tab that is open in full, with what to watch out for and where to read more.' },
        { name: 'Views', tab: 'views',
          what: 'Choose what the bar on the left lists: All, Simple, Field for a site visit, or a view of your own.' },
        { name: 'Your own views', tab: 'views', who: 'signin',
          what: 'Rename groups, reorder, hide or add tabs; your views follow your account to every device.' },
        { name: 'Looks and themes', act: 'theme', where: 'the banner › Theme',
          what: 'Five layouts — Calm, Tiles, Instrument, Signs and Classic — in light, dark, or Sunlight for full sun.',
          find: 'dark mode contrast colour color' },
        { name: 'What\'s new', act: 'whatsnew', where: 'the banner › ✨ What\'s new',
          what: 'The changes since this device last looked, written for the people using the app.',
          find: 'changes release notes' },
        { name: 'Report a bug or an idea', act: 'bug', where: 'the banner › 🐞 Report a Bug',
          what: 'A note to whoever looks after Flood-Net, with what is needed to reproduce the problem added for you.',
          find: 'feedback suggestion issue problem' },
        { name: 'Export what you see', act: 'export', where: 'the banner › ⤓ Export',
          what: 'Saves what the open tab shows, its filters applied, as a file — CSV, GeoJSON, KML, PNG or SVG.',
          find: 'download save file' },
        { name: 'Works with no signal', tab: 'offline',
          what: 'Keeps the app, the station list and the inspection sheets on the device, with one button to get it all ready.',
          find: 'offline flight mode' },
        { name: 'Install as an app', tab: 'offline',
          what: 'Puts Flood-Net on your home screen like any other app, with the steps for the browser you are using.',
          find: 'pwa' },
        { name: 'Memory meter', act: 'memory', where: 'the thin bar under the banner',
          what: 'What the page is holding in memory, and buttons to let go of it on a struggling phone.' },
      ] },

    { key: 'stations', icon: '📍', name: 'Stations & the map',
      blurb: 'The station register, on a map and in a list, the tools you point at it, and a station\'s ground in 3-D.',
      items: [
        { name: 'Station list and filters', tab: 'stations', where: 'side panel › 📍 Stations', open: { dock: 'stations' },
          what: 'Every station, narrowed by name, number, ALERT address or range, type, sensor, network, owner, region, basin or council.',
          find: 'search filter' },
        { name: 'Highlight or hide the matches', tab: 'stations', where: 'map › 🗺️ Layers › Hide stations that don\'t match',
          open: L('hide stations'),
          what: 'Matching stations get an amber ring and their names, or everything else comes off the map.' },
        { name: 'Station card', tab: 'stations', where: 'press a station\'s pin',
          what: 'Owner, number, type, networks, position, height, ALERT IDs and what passes it on, with a line to its pin.',
          find: 'details popup' },
        { name: 'A station\'s health on its card', tab: 'stations', where: 'a station\'s card',
          what: 'When it was last heard, its battery trend and anything wrong, each line opening Station Health.' },
        { name: 'Directions, Street View and Google Earth', tab: 'stations', where: 'a station\'s card › Position',
          what: 'From a card: directions in your maps app, Street View, Apple Maps, Google Earth, or the position to copy.',
          src: 'Google, Apple', find: 'navigate drive lat lon coordinates kml' },
        { name: 'Edit a station', tab: 'stations', where: 'a station\'s card › ✏️ Station details', who: 'editor',
          what: 'Change and save a station\'s record, its sensors and their settings.' },
        { name: 'Propose a new station', tab: 'stations', where: 'map › What’s here? › 📌 Propose a station here', who: 'editor',
          what: 'Press a spot on the map and start a station there, saved as a proposal.' },
        { name: 'Add a station outright', tab: 'stations', where: 'a station\'s card › ✏️ Station details', who: 'admin',
          what: 'Put a new station straight into the register, or take a saved one out of Proposed.' },
        { name: 'Move a station\'s pin', tab: 'stations', where: 'a station\'s card › 📍 Move pin', who: 'editor',
          what: 'Drag a pin — on the flat map, in 3-D or in the twin — and save the new position.', find: 'relocate coordinates' },
        { name: 'Change history and restore', tab: 'stations', where: 'a station\'s card › history', who: 'editor',
          what: 'Who changed what on a station, and when, and putting an earlier version back.', find: 'undo audit' },
        { name: 'Restore a deleted station', tab: 'admin', where: 'Deleted stations', who: 'editor',
          what: 'The stations that have been deleted, each with Restore.', find: 'undelete' },
        { name: 'Equipment on site', tab: 'stations', where: 'a station\'s card › Equipment', who: 'member',
          what: 'The makes, models and serials fitted at a station, once a suggestion read from its photos is approved.' },
        { name: 'Site features', tab: 'stations', where: 'a station\'s card › 📌 Site features', who: 'editor',
          what: 'Map a station\'s outlet, pits, benchmarks, gauge boards, orifice run and tracks; save them as GeoJSON.' },
        { name: 'Radio links', tab: 'stations', where: 'map › 🗺️ Layers › Show radio paths', open: L('radio paths'),
          what: 'Lines from each field station to the repeaters and bases its ALERT IDs pass through, and how far to draw them.' },
        { name: 'Backbone paths', tab: 'stations', where: 'map › 🗺️ Layers › Backbone links', open: L('backbone'),
          what: 'The repeater-to-repeater and repeater-to-base paths; press one for its channel, distance and margin.' },
        { name: 'Arrows along the links', tab: 'stations', where: 'map › 🗺️ Layers', open: L('arrows'),
          what: 'Which way readings travel along each link.' },
        { name: 'Links coloured by channel or fade margin', tab: 'stations', where: 'map › 🗺️ Layers › Link colour', open: L('link colour'),
          what: 'Colour every link by its frequency, or by fade margin in bands you set.', find: 'frequency' },
        { name: 'Line of sight on every link', tab: 'stations', where: 'map › 🗺️ Layers', open: L('line of sight'),
          what: 'Links the ground blocks turn crimson.', src: 'AWS Terrain Tiles', find: 'los blocked terrain' },
        { name: 'Related repeaters', tab: 'stations', where: 'map › 🗺️ Layers › Include related repeaters', open: L('related repeaters'),
          what: 'Bring in the repeaters that carry the stations you filtered for, or the stations a repeater carries.' },
        { name: 'One owner\'s stations', tab: 'stations', where: 'map › 🗺️ Layers › Owner', open: L('owner'),
          what: 'Draw only one owner\'s stations, or everyone\'s but theirs.', find: 'council' },
        { name: 'Pins coloured by health', tab: 'stations', where: 'map › 🗺️ Layers', open: L('colour pins by health'),
          what: 'Each pin OK, on watch, at fault or no data, drawn bigger the worse it is.' },
        { name: 'Latency', tab: 'stations', where: 'map › ⏱️ Latency', open: { panel: 'latency' },
          what: 'Pins coloured by how old the data is, how late it came or checks missed — and readings shown landing.',
          find: 'stale data age delay' },
        { name: 'Blast radius', tab: 'stations', where: 'a repeater\'s card › 💥 Show blast radius',
          what: 'What goes dark if a repeater fails: its links in red, the stations stranded, and a list of them.',
          find: 'failure outage single point' },
        { name: 'Repeaters listening', tab: 'stations', where: 'side panel › 📍 Stations, under the list', open: { dock: 'stations' },
          what: 'The repeaters that carry the station you picked, nearest first.' },
        { name: 'Legend', tab: 'stations', where: 'map › 🔑 Legend', open: { panel: 'legend' },
          what: 'A key to every layer that is on, and a list of those that are off.', find: 'key' },
        { name: 'Draw and measure', tab: 'stations', where: 'map › ✏️ Draw & measure', open: { panel: 'draw' },
          what: 'Pins, lines, circles, boxes and text, by click or typed coordinates — with lengths, bearings and areas.',
          find: 'distance ruler area' },
        { name: 'Pick stations off the map', tab: 'stations', where: 'map › ✏️ Draw & measure, or Shift-click', open: { panel: 'draw' },
          what: 'Pick the stations inside a shape or Shift-click them, then save the selection as CSV.', find: 'select selection' },
        { name: 'A drawing to Google Earth', tab: 'stations', where: 'map › ✏️ Draw & measure › KML', open: { panel: 'draw' },
          what: 'Save the drawing as KML, with the stations it encloses or joins.' },
        { name: 'What\'s here?', tab: 'stations', where: 'map › What’s here?',
          what: 'Press any spot for its height, land cover, wind region, basin, council, land, road owner, mobile signal and nearest stations.',
          src: 'Queensland Government, Esri' },
        { name: 'Find a place', tab: 'stations', where: 'side panel › Find a place', open: { dock: 'places' },
          what: 'Coordinates, towns, basins, survey marks, rivers and councils — a pin and an outline where it is.',
          src: 'OpenStreetMap', find: 'town address locate' },
        { name: 'Your position', tab: 'stations', where: 'map › ➤ under the zoom buttons',
          what: 'Where you are, how sure, and which way you face, on a phone or tablet.', find: 'gps location' },
        { name: 'Station trail', tab: 'stations', where: 'map › 📍 in the top row',
          what: 'The stations you have looked at this session, to go back to any of them.', find: 'recent history' },
        { name: 'Minimap', tab: 'stations', where: 'map › 🗺️ Layers › Show the minimap', open: L('minimap'),
          what: 'A small overview showing where the main view is.' },
        { name: 'Full screen, clear and reset', tab: 'stations', where: 'map › ⛶, 🧹 and ↺',
          what: 'The map filling the window; 🧹 clears picks and drawings, ↺ the filters as well.' },
        { name: '3-D view', tab: 'stations', where: 'map › 3-D view',
          what: 'The map tilted over the ground, with the links, line-of-sight sheets and a rising water level.',
          src: 'AWS Terrain Tiles', find: 'tilt terrain three dimensional' },
        { name: 'Digital twin', tab: 'stations', where: 'side panel › 🧊 Twin', open: { dock: 'twin' },
          what: 'A station\'s ground from 0.5–1 m LiDAR and aerial photos, the station as built, to orbit or stand in.',
          src: 'Queensland Government, Geoscience Australia', find: '3d model lidar' },
        { name: 'Flood water in the twin', tab: 'stations', where: 'side panel › 🧊 Twin', open: { dock: 'twin' },
          what: 'The station\'s flood classes, modelled flood levels and historic peaks rising as water round it.',
          src: 'Bureau of Meteorology' },
        { name: 'Property boundaries in the twin', tab: 'stations', where: 'side panel › 🧊 Twin › Scene', open: { dock: 'twin' },
          what: 'Lots, plans and road reserves draped over the twin\'s ground.', src: 'Queensland Government (cadastre)' },
        { name: 'A twin for Blender', tab: 'stations', where: 'side panel › 🧊 Twin › Ground truth', open: { dock: 'twin' },
          what: 'The recorded height against the ground, and the twin to download as a .glb file.', find: 'glb 3d model' },
        { name: 'Explore a twin together', tab: 'stations', where: 'side panel › 🧊 Twin › Explore together', open: { dock: 'twin' },
          what: 'See other people in the same twin, and where they are pointing.' },
      ] },

    { key: 'outside', icon: '🌏', name: 'Outside data on the map',
      blurb: 'Layers and station-card sections drawn from other organisations\' data — most of it Queensland\'s.',
      items: [
        { name: 'Base maps', tab: 'stations', where: 'map › 🗺️ Layers › Base maps', open: L('base map'),
          what: 'Topographic, street, satellite, dark and light maps — tick several and blend them, each with its own opacity.',
          src: 'OpenTopoMap, OpenStreetMap, Esri', find: 'basemap background imagery' },
        { name: 'State aerial photography', tab: 'stations', where: 'map › 🗺️ Layers › Satellite', open: L('satellite'),
          what: 'Aerial photos as fine as 10–20 cm, under the Satellite base map.',
          src: 'Queensland Government, NSW Spatial Services', find: 'imagery' },
        { name: 'Rivers and creeks', tab: 'stations', where: 'map › 🗺️ Layers', open: L('rivers and creeks'),
          what: 'Every named river; point at one for its name, press it for the stations along it.',
          src: 'Bureau of Meteorology (Geofabric)', find: 'watercourse stream' },
        { name: 'A river\'s catchment, shaded by height', tab: 'stations', where: 'map › 🗺️ Layers', open: L('catchment, shaded'),
          what: 'Picking a river outlines the land that drains into it, shaded by elevation.',
          src: 'Bureau of Meteorology (Geofabric)' },
        { name: 'Highlight matching rivers', tab: 'stations', where: 'map › 🗺️ Layers', open: L('highlight matching rivers'),
          what: 'Lights up the rivers whose names match the station filter.', src: 'OpenStreetMap' },
        { name: 'Elevation shading', tab: 'stations', where: 'map › 🗺️ Layers', open: L('elevation shading'),
          what: 'Ground height as colour over any base map, slopes shaded, from SRTM or 5 m LiDAR.',
          src: 'AWS Terrain Tiles, Geoscience Australia (ELVIS)', find: 'terrain height' },
        { name: 'LiDAR contours', tab: 'stations', where: 'map › 🗺️ Layers', open: L('contours'),
          what: 'Contour lines every 1, 5 or 10 m.', src: 'Queensland Government' },
        { name: 'Elevation data coverage', tab: 'stations', where: 'map › 🗺️ Layers', open: L('elevation data coverage'),
          what: 'Where a LiDAR or elevation survey exists.', src: 'Geoscience Australia (ELVIS)' },
        { name: 'Highest ground in view', tab: 'stations', where: 'map › 🗺️ Layers', open: L('highest ground'),
          what: 'Pins the three to five highest points in the view.', src: 'AWS Terrain Tiles', find: 'peaks hills' },
        { name: 'Survey marks', tab: 'stations', where: 'map › 🗺️ Layers', open: L('survey marks'),
          what: 'Permanent survey marks and CORS sites, with AHD height, condition and the mark\'s report.',
          src: 'Queensland Government (SurveyControl)', find: 'benchmark pm' },
        { name: 'Property boundaries', tab: 'stations', where: 'map › 🗺️ Layers', open: L('property boundaries'),
          what: 'Every lot, with its lot and plan number when zoomed in.', src: 'Queensland Government (cadastre)',
          find: 'dcdb lots parcels land' },
        { name: 'Road parcels', tab: 'stations', where: 'map › 🗺️ Layers', open: L('road parcels'),
          what: 'Surveyed road reserves, with the road\'s name, locality and council.', src: 'Queensland Government (cadastre)' },
        { name: 'Road and bridge owners', tab: 'stations', where: 'map › 🗺️ Layers', open: L('bridge owners'),
          what: 'Roads coloured by who manages them; bridges say whose they are and who to call.',
          src: 'Queensland Government, QLDTraffic', find: 'tmr council' },
        { name: 'Flood and road cameras', tab: 'stations', where: 'map › 🗺️ Layers', open: L('cameras'),
          what: 'About 600 council and QLDTraffic cameras; press one for its latest picture and how old it is.',
          src: 'Councils, QLDTraffic', find: 'webcam' },
        { name: 'Mobile coverage', tab: 'stations', where: 'map › 🗺️ Layers', open: L('mobile coverage'),
          what: 'One carrier\'s 4G coverage or the best of three, outdoors or with an external antenna.',
          src: 'Telstra, Optus and TPG via the ACCC', find: 'phone reception 4g' },
        { name: 'Licensed transmitters', tab: 'stations', where: 'map › 🗺️ Layers › ACMA licences', open: L('acma'),
          what: 'Licensed transmitters near the network, filtered by how they could interfere; press one for its licence.',
          src: 'ACMA', find: 'interference licence register' },
        { name: 'Wind regions', tab: 'stations', where: 'map › 🗺️ Layers', open: L('wind regions'),
          what: 'The wind regions of the structural design standard, with what each letter means.', src: 'AS/NZS 1170.2' },
        { name: 'Drainage basins', tab: 'stations', where: 'map › 🗺️ Layers › River catchments', open: L('drainage basins'),
          what: 'Queensland\'s 77 drainage basins; those matching the filter light up.', src: 'Queensland Government',
          find: 'catchments' },
        { name: 'Maintenance hubs', tab: 'stations', where: 'map › 🗺️ Layers', open: L('maintenance hubs'),
          what: 'The Bureau\'s eight field maintenance hub areas.', src: 'Bureau of Meteorology' },
        { name: 'Forecast and information locations', tab: 'stations', where: 'map › 🗺️ Layers › Station pins', open: L('station pins'),
          what: 'Pin shapes for river gauges and hand-read gauges, and rings on the Bureau\'s forecast and information locations.',
          src: 'Bureau of Meteorology (SLS)' },
        { name: 'Modelled station height', tab: 'stations', where: 'a station\'s card › Elevation',
          what: 'A station with no recorded height gets one from LiDAR, marked as modelled.', src: 'Geoscience Australia (ELVIS)' },
        { name: 'The land a station is on', tab: 'stations', where: 'a station\'s card › Land',
          what: 'Its lot and plan, tenure, who holds it, the council, address and land use.', src: 'Queensland Government' },
        { name: 'The road or bridge beside a station', tab: 'stations', where: 'a station\'s card',
          what: 'The nearest road or bridge, who manages it and who to call.', src: 'Queensland Government, QLDTraffic' },
        { name: 'Mobile signal at a station', tab: 'stations', where: 'a station\'s card',
          what: 'Estimated phone and modem signal for each carrier, graded Good to None.', src: 'ACMA, ACCC' },
        { name: 'Flood classes and levels', tab: 'stations', where: 'a station\'s card',
          what: 'The Bureau\'s flood classes, modelled flood levels (AEP) and an indicative peak flow speed.',
          src: 'Bureau of Meteorology', find: 'minor moderate major velocity' },
        { name: 'Catchment above a gauge', tab: 'stations', where: 'a station\'s card',
          what: 'The area draining to a gauge, and a button that shades it on the map.', src: 'Bureau of Meteorology (Geofabric)' },
        { name: 'Cameras near a station', tab: 'stations', where: 'a station\'s card',
          what: 'Cameras within 2 km, each one press from its latest picture.', src: 'Councils, QLDTraffic' },
        { name: 'Site exposure', tab: 'stations', where: 'a station\'s card',
          what: 'Tidal water, Water Act limits, coastal hazard areas and acid sulfate soils at the site.',
          src: 'Queensland Government' },
        { name: 'A station\'s Bureau listing', tab: 'stations', where: 'a station\'s card › SLS',
          what: 'Its flood class levels, forecast role, owner and whether it is read by hand or radio.',
          src: 'Bureau of Meteorology (SLS)' },
      ] },

    { key: 'radio', icon: '📡', name: 'Radio planning',
      blurb: 'Will a path work, where should a repeater go, and what to set on it.',
      items: [
        { name: 'Path profile', tab: 'stations', where: 'side panel › Path tools', open: { dock: 'paths' },
          what: 'The ground, trees, Fresnel zone and line of sight between two points, with a verdict and the obstructions.',
          src: 'Geoscience Australia (LiDAR), Esri (land cover)', find: 'elevation profile fresnel' },
        { name: 'Link budget', tab: 'stations', where: 'side panel › Path tools', open: { dock: 'paths' },
          what: 'The fade margin between any two stations or points, by the Longley–Rice model, with the radio figures to change.',
          find: 'itm fade margin' },
        { name: 'Radio coverage', tab: 'stations', where: 'map › 📡 Radio coverage', open: { panel: 'polar' },
          what: 'Where a radio at a site would reach, as Radio Mobile draws it; its data saved as CSV.', find: 'polar' },
        { name: 'Repeater site finder', tab: 'stations', where: 'map › 🗼 Repeater sites', open: { panel: 'sites' },
          what: 'Ranks the best few spots for a new repeater to hear a set of stations; KMZ, KML or CSV.' },
        { name: 'Station relocation finder', tab: 'stations', where: 'map › 🚚 Relocate station', open: { panel: 'relocate' },
          what: 'Scores the ground round a station that must move and pins the best spots, clear of buildings and water.',
          src: 'OpenStreetMap, Queensland Government', find: 'move' },
        { name: 'ALERT IDs', tab: 'passranges',
          what: 'Which repeaters carry a station\'s addresses, what each repeater carries, and stations nothing covers.',
          find: 'pass ranges orphans' },
        { name: 'How full the address space is', tab: 'passranges',
          what: 'A wheel, a grid, the free addresses by region and each repeater\'s share.' },
        { name: 'Set aside ALERT addresses', tab: 'passranges', who: 'editor',
          what: 'The smallest free run that fits a new site, reserved so nobody else takes it.', find: 'allocate reserve' },
        { name: 'Repeater delays', tab: 'repdelays',
          what: 'The delay to set on each repeater so relayed copies do not land on top of one another.',
          find: 'stagger collision' },
        { name: 'Fade-margin matrix', tab: 'review', who: 'admin',
          what: 'Every station\'s margin to each repeater, base or proposed site, beside the field\'s attenuator tests.',
          find: 'network review' },
        { name: 'Network review against Radio Mobile', tab: 'review', who: 'admin',
          what: 'Radio Mobile\'s figures beside Flood-Net\'s, design rules checked, hub heights against LiDAR.' },
        { name: 'TDMA Planner', tab: 'tdma',
          what: 'An ALERT2 frame laid out slot by slot, latency and capacity worked out, and a settings sheet per device.' },
        { name: 'ALERT2 Transition Plan', tab: 'a2plan', who: 'list',
          what: 'The equipment, crews, timeline and cost of moving to ALERT2, with sliders to re-run it and scenarios to share.' },
      ] },

    { key: 'faults', icon: '🔬', name: 'Interference & decoding',
      blurb: 'When readings arrive wrong: who else is on the air, what was really sent, and what changed it on the way.',
      items: [
        { name: 'Transmitters near a repeater', tab: 'rf',
          what: 'Licensed transmitters near a repeater, ranked as interference suspects, with the score shown.', src: 'ACMA' },
        { name: 'Frequency strip plot', tab: 'rf',
          what: 'Every licensed carrier round a repeater\'s receive channel.', src: 'ACMA', find: 'spectrum' },
        { name: 'Working-hours test', tab: 'rf',
          what: 'Paste the times of bad readings and see whether they cluster in working hours.' },
        { name: 'Licence changes over time', tab: 'rfchanges',
          what: 'When transmitters near a repeater were licensed, what changed month to month, and new intermodulation.',
          src: 'ACMA', find: 'intermod' },
        { name: 'Bad readings against the changes', tab: 'rfchanges',
          what: 'Paste a series of corrupted readings and see when it started against the register.' },
        { name: 'Interference Workbench', tab: 'workbench',
          what: 'Work a case: five explanations scored side by side, ghosts flagged, the next check named, shared as a link.' },
        { name: 'Reception map and drive surveys', tab: 'reception',
          what: 'Each frame a receiver hears, with its strength and position — signal along a drive, bad copies blamed.' },
        { name: 'What our receivers heard', tab: 'reception', who: 'editor',
          what: 'Every copy Flood-Net\'s receivers heard, and a Pi left at a candidate site set against the network.',
          find: 'site survey receptions' },
        { name: 'Bit-flip sources', tab: 'flipsources',
          what: 'Each corrupted copy put down to the transmitter it came from, by its carrier; repeaters ranked.' },
        { name: 'Signal routes', tab: 'signalroutes', who: 'editor',
          what: 'Each burst traced to its sender, as a flow and on the map, against the pass ranges on record.',
          find: 'sankey protocol' },
        { name: 'Bit Flipper', tab: 'bitflipper',
          what: 'Every address a few flipped bits from one, matched to the stations, and the flips seen on the air.' },
        { name: 'Ghosting Graph', tab: 'network',
          what: 'Addresses as a graph: one-bit neighbours joined, and ghosting seen in the data drawn as arrows.' },
        { name: 'ALERT packet decoder', tab: 'packets',
          what: 'Paste a frame, payload or hex and see it decoded every way it can be, check bits and CRC included; or build one.',
          find: 'erts encoder' },
        { name: 'ERT-A2 log decoder', tab: 'alert2',
          what: 'Decodes an ERT-A2 capture or a PuTTY log as it grows — rain in mm, where it was, the clock\'s drift.',
          find: 'alert2 elpro' },
        { name: 'HFEM messages', tab: 'hfem',
          what: 'Decode the Bureau\'s field event messages, catch bad ones, and build a test message for a logger.' },
        { name: 'Serial Monitor', tab: 'serial',
          what: 'Several serial ports live at once — ERT-A2, radio, GPS — as text, hex or decoded ALERT. Chrome or Edge on a computer.',
          find: 'com port usb' },
        { name: 'Quansheng radio dashboard', tab: 'serial',
          what: 'A Quansheng radio on ALERT firmware as a live dashboard, with its controls.', find: 'uv-k5' },
        { name: 'Decode off the air', tab: 'serial',
          what: 'An RTL-SDR stick, on the computer or on a Raspberry Pi, decodes ALERT straight off the air.', find: 'sdr' },
        { name: 'A laptop as a base station', tab: 'serial',
          what: 'A Serial Monitor card posts what it decodes to Flood-Net, once an administrator approves its token.' },
        { name: 'Bit Bench', tab: 'bitbench',
          what: 'Decimal, binary and hex side by side, and fourteen faults — noise, drift, wiring — hitting an ALERT frame.' },
        { name: 'Name a fault by its fingerprint', tab: 'bitbench',
          what: 'Paste readings sent and received and see the fault\'s pattern — or play the whodunnit.' },
      ] },

    { key: 'monitor', icon: '🚦', name: 'Monitoring & alerts',
      blurb: 'Is everything reporting, what needs a visit, and the readings themselves.',
      items: [
        { name: 'Station Health', tab: 'health',
          what: 'The stations that need attention, ranked, with the evidence: silent, missing checks, batteries sliding, gauges dry or stuck.',
          find: 'faults alarms' },
        { name: 'One station\'s health', tab: 'health',
          what: 'Its checks slot by slot, battery trend, rain and level beside its neighbours, every receiver at a missed check.' },
        { name: 'Network Weather bulletin', tab: 'health',
          what: 'An animated, spoken bulletin on the network, daily and weekly, written each morning by Claude.',
          src: 'ElevenLabs (the voices)', find: 'news video' },
        { name: 'AI maintenance briefing', tab: 'health',
          what: 'Claude reads the findings and writes a briefing for the next visits — editors on Flood-Net\'s key, anyone on their own.',
          src: 'Anthropic', find: 'claude' },
        { name: 'Briefing pack for another AI', tab: 'health',
          what: 'The findings as a pack for Copilot, ChatGPT or another AI, and its answer pasted back.' },
        { name: 'Airtime and logger clocks', tab: 'health',
          what: 'Transmissions landing together, check timing and logger clocks, and what to change.' },
        { name: 'Transmitter frequencies', tab: 'health',
          what: 'Every transmitter\'s carrier offset and drift, as the base stations hear it.' },
        { name: 'Backbone', tab: 'backbone',
          what: 'Repeaters ranked by what went wrong over 7 to 90 days — off air, bad relays, signal, power — with the evidence.' },
        { name: 'Pass ranges against the air', tab: 'backbone', who: 'editor',
          what: 'What each repeater really relays, against its record.' },
        { name: 'A summary for the meeting', tab: 'backbone',
          what: 'The repeater ranking as CSV, and a summary in words for meeting notes.' },
        { name: 'Message Log', tab: 'msglog',
          what: 'Every reading as it arrives: who sent it, its address, raw and worked-out value, and how it got in.',
          find: 'incoming telemetry' },
        { name: 'Wait for a test transmission', tab: 'msglog',
          what: 'The log checks again every 30 seconds while you wait for a station\'s test.' },
        { name: 'Give an unknown address a station', tab: 'msglog', who: 'editor',
          what: 'Claim an address nobody owns for a station, and its stored readings come with it.' },
        { name: 'Field Data charts', tab: 'field',
          what: 'Chart a station\'s sensors over any window, raw or hourly and daily, and a river\'s gauges together.' },
        { name: 'Rainfall heat map', tab: 'stations', where: 'map › 🗺️ Layers', open: L('rainfall'),
          what: 'The network\'s rain painted between gauges, with totals, the peak hour, top falls and a 24-hour playback.' },
        { name: 'Plots from ARRO exports', tab: 'arrodata',
          what: 'Chart ARRO\'s CSV exports through the Bureau\'s 3-5-7 and other filters, each rejection explained.',
          src: 'Contrail (ARRO)', find: 'csv filter' },
        { name: 'Curves and lines on a chart', tab: 'arrodata',
          what: 'Fit a line or a recession curve, type a function, draw freehand or rule a slope.', find: 'regression trend' },
        { name: 'Edit readings on a chart', tab: 'arrodata',
          what: 'Lasso readings to set, shift, scale or delete them, in the browser only — ARRO is never changed.' },
        { name: 'Flood lines on a chart', tab: 'arrodata',
          what: 'Minor, moderate and major flood lines and modelled flood levels, in the series\' own datum.' },
        { name: 'ARRO Launcher', tab: 'arro',
          what: 'Open a station\'s ARRO pages by name, number, site id or a pasted ARRO link.', src: 'Contrail (ARRO)' },
        { name: 'Investigations', tab: 'investigations',
          what: 'Strange data looked into and what was behind it: dated write-ups, two pages each to read or print.' },
        { name: 'Alerts on your device', tab: 'admin', where: '🔔 Notifications', who: 'admin',
          what: 'A notification and a count on the app\'s icon when an account is waiting or a base station asks to join.',
          find: 'push notification' },
      ] },

    { key: 'visits', icon: '🩺', name: 'Site visits & surveying',
      blurb: 'Getting to a station, the forms, the photos and the level survey — made for a phone.',
      items: [
        { name: 'Nearby', tab: 'nearby',
          what: 'The stations nearest you, with distance and direction, each one press from an inspection, photos or directions.' },
        { name: 'Look Around', tab: 'lookaround',
          what: 'Hold up a phone and the stations each way are pinned over the camera\'s view.', find: 'ar augmented reality compass' },
        { name: 'Inspection form', tab: 'inspections',
          what: 'One form shaped to the station, covering the six paper sheets, with drafts kept when there is no signal.' },
        { name: 'Save an inspection', tab: 'inspections', who: 'editor',
          what: 'Save the visit, the 6% calibration check worked out, with photos attached privately.' },
        { name: 'Council maintenance form', tab: 'maintenance',
          what: 'Condition, owner, access and vegetation on the form the 22 councils use.' },
        { name: 'Save a council form', tab: 'maintenance', who: 'editor',
          what: 'Save the form with its attachments, and see the visits still waiting for one.' },
        { name: 'Inspection History', tab: 'history', who: 'editor',
          what: 'Every past inspection and council form in the paper layout; print on A4 or save as CSV.' },
        { name: 'Field Camera', tab: 'camera',
          what: 'Photos stamped with heading, position, height, station and time, the way Solocator stamps them.',
          find: 'photo picture' },
        { name: 'Photos that upload themselves', tab: 'camera', who: 'editor',
          what: 'Photos wait on the phone where there is no signal, then go to Field Photos on their own.' },
        { name: 'Field Photos', tab: 'photos', who: 'member',
          what: 'Every site photo, pinned where it was taken on the map and in the twin, with when and which way.' },
        { name: 'Field photos on the map', tab: 'stations', where: 'map › 🗺️ Layers', open: L('field photos'), who: 'member',
          what: 'A 📷 where each photo was taken, with the way the camera faced.' },
        { name: 'Bring in photos in bulk', tab: 'photos', who: 'editor',
          what: 'Drop files, a folder or a zip; placed by GPS or by reading the stamp, filed under the nearest station.',
          find: 'upload heic ocr' },
        { name: 'Photos from Dropbox or Google Drive', tab: 'photos', who: 'member',
          what: 'Photos dropped in a linked Dropbox or Google Drive folder arrive by themselves every 15 minutes.',
          src: 'Dropbox, Google Drive' },
        { name: 'Equipment read from photos', tab: 'photos', who: 'admin',
          what: 'Makes, models and serials read off photos and suggested for the register, for an administrator to approve.' },
        { name: 'Level Survey', tab: 'levels',
          what: 'Book a level run on a phone, reduced as you go, with the misclose checked before you leave.' },
        { name: 'Read a digital level with the camera', tab: 'levels',
          what: 'Point the camera at the level\'s display and the reading is typed in, the picture kept.', find: 'ocr' },
        { name: 'Send a survey', tab: 'levels', who: 'editor',
          what: 'Surveys kept on the phone are filed under their station when there is signal; Excel, CSV or zip out.' },
        { name: 'Apply a survey to a station', tab: 'levels', who: 'admin',
          what: 'Set a gauge zero, benchmarks or a sensor offset from a checked survey.' },
        { name: 'Two-Peg Test', tab: 'twopeg',
          what: 'Check a level\'s collimation against tolerance, and link the test to the surveys done with it.' },
        { name: 'How to Survey', tab: 'surveyguide',
          what: 'The level survey and two-peg test step by step, opened from each step of the sheet.' },
      ] },

    { key: 'paper', icon: '🖨️', name: 'Maps on paper & files out',
      blurb: 'Printed sheets, and the network taken away as files.',
      items: [
        { name: 'Radio Path Maps', tab: 'maps',
          what: 'The bundled radio-path map sheets, by basin or region, and the sheet a station is on.', find: 'pdf' },
        { name: 'Map Generator', tab: 'mapgen',
          what: 'A true-to-scale sheet with stations, rivers, contours and a grid — to print, or save as PDF or SVG.',
          src: 'OpenStreetMap, Esri' },
        { name: 'Maps for a laser cutter', tab: 'mapgen',
          what: 'Sheets in K40 Whisperer\'s colours, one file per contour level for a layered model.' },
        { name: 'The map\'s view to the Map Generator', tab: 'stations', where: 'map › 🗺️ Layers › Send view to Map Generator',
          open: L('map generator'), what: 'Opens the Map Generator on what the map is showing, at its scale.' },
        { name: 'Radio Mobile files', tab: 'export', who: 'signin',
          what: 'Every CSV Radio Mobile needs, for the networks you tick.' },
        { name: 'The station list as a file', tab: 'stations', where: '⤓ Export in the banner', who: 'signin',
          what: 'The stations the filters leave, as CSV, GeoJSON for a GIS or KML for Google Earth.' },
        { name: 'The register as stations.json', tab: 'admin', where: 'Snapshot', who: 'signin',
          what: 'The whole station register as it stands in the database, as one file.', find: 'backup snapshot' },
      ] },

    { key: 'learn', icon: '🎓', name: 'Learning',
      blurb: 'Lessons and practice, from how radio carries a reading to a day of levelling.',
      items: [
        { name: 'Radio Propagation', tab: 'propagation',
          what: 'How radio gets a reading home, in moving pictures: shadows, trees, echoes, collisions and repeaters.' },
        { name: 'Fade-margin test bench', tab: 'propagation',
          what: 'A step attenuator on a 1, 5 or 25 W station, and what each step does to its reach.' },
        { name: 'Bit Errors', tab: 'biterrors',
          what: 'Why readings arrive wrong, fault by fault: its fingerprint, how to confirm it on site and what fixes it.' },
        { name: 'Intermodulation calculator', tab: 'biterrors',
          what: 'The products two transmitters near a site make, and what a CRC would have caught.' },
        { name: 'SWR Meter', tab: 'swr',
          what: 'The SW-102, SWR-400 and 3030 meters drawn and working; type in your readings to see what they mean.' },
        { name: 'Pinouts', tab: 'pinouts',
          what: 'The connectors a site visit meets, pin by pin, with cables to buzz out and where each pinout came from.',
          src: 'Makers\' manuals', find: 'wiring db9 rs232' },
        { name: '4–20 mA loop calculator', tab: 'pinouts',
          what: 'Scale a current to a reading, and check the loop has the voltage to drive its sensor.' },
        { name: 'ERT-A2 Simulator', tab: 'a2firmware',
          what: 'An A2\'s console from real units\' logs: its menus to explore, and its settings changed step by step.' },
        { name: 'ERT-A2 firmware upgrade', tab: 'a2firmware',
          what: 'The upgrade walked through, the parts a unit needs from its versions, and the USB stick made ready.' },
        { name: 'Staff Simulator', tab: 'kbstaff',
          what: 'Practise reading a levelling staff through heat haze, wind and a rocking staff.', src: 'Mallee HydroTech' },
        { name: 'Survey Logbook', tab: 'kblogbook',
          what: 'Practise booking and reducing a level book, recovering missing readings and closing the loop.',
          src: 'Mallee HydroTech' },
        { name: 'Site Lifecycle', tab: 'kblifecycle',
          what: 'A station from choosing its site to taking it out, with a routine visit and call-out priorities to practise.',
          src: 'Mallee HydroTech' },
        { name: 'Levelling Day', tab: 'kblevel',
          what: 'A day of levelling practised step by step, against your own tolerances.', src: 'Mallee HydroTech' },
        { name: 'River Visit Day', tab: 'kbriver',
          what: 'A routine visit to a river gauging station, step by step.', src: 'Mallee HydroTech' },
      ] },

    { key: 'admin', icon: '🛠️', name: 'Admin & behind the scenes',
      blurb: 'Accounts, the base stations, what runs on its own, and the ways in for scripts and AI agents.',
      items: [
        { name: 'Sign in', act: 'signin', where: 'the banner › 🔑 Sign in',
          what: 'An account by email and password, an emailed code, or Google or Microsoft — needed to change things, not to look.',
          find: 'login account register' },
        { name: 'Your access', tab: 'admin',
          what: 'What your account may do, and what each kind of account may do.', find: 'roles permissions' },
        { name: 'Users and approvals', tab: 'admin', who: 'admin',
          what: 'Approve new accounts, give roles, and choose who may sign in.', find: 'allowlist' },
        { name: 'Admin dashboard', tab: 'admin', who: 'admin',
          what: 'The database\'s health and size, who is online, when people were last seen, and visits a day.',
          find: 'statistics analytics' },
        { name: 'Ingest tokens', tab: 'admin', who: 'admin',
          what: 'Make and revoke the tokens base stations post readings with, and approve a device by the code it shows.',
          find: 'pairing qr' },
        { name: 'Base station connections', tab: 'admin', who: 'admin',
          what: 'Each base station\'s uptime, dropouts and restarts over a week, a month or a quarter.' },
        { name: 'Base Stations', tab: 'basestations', who: 'admin',
          what: 'Every receiving station\'s check-ins, receivers, uplink, power and temperature, and what needs a look.',
          find: 'raspberry pi receivers fleet' },
        { name: 'Manage a base station from afar', tab: 'basestations', who: 'admin',
          what: 'Change a setting, restart it, install an update or fetch its log; manage the team\'s SSH keys.' },
        { name: 'Spectrum waterfall', tab: 'basestations', who: 'admin',
          what: 'What each base station\'s radio heard over a window, channel by channel against the licences.', src: 'ACMA' },
        { name: 'Load station data', tab: 'admin', where: 'Data source',
          what: 'The register from the database, the bundled file, GitHub or a file on this device.' },
        { name: 'This browser', tab: 'admin',
          what: 'What this browser keeps for Flood-Net, and clearing it while staying signed in.' },
        { name: 'Readings coming in', tab: 'msglog',
          what: 'Loggers and base stations post readings over HTTP or MQTT with a device token, in ALERT or the Bureau\'s HFEM format.',
          find: 'ingest telemetry api' },
        { name: 'Readings kept and archived', tab: 'field',
          what: 'Readings kept two years and hourly and daily summaries for good, each day archived before anything is deleted.',
          find: 'retention backup' },
        { name: 'Health worked out every 15 minutes', tab: 'health',
          what: 'Station Health\'s findings are worked out on the server every 15 minutes, whether anyone is looking or not.' },
        { name: 'Licence register kept current', tab: 'rf',
          what: 'The radio licence register is fetched every week, so RF Environment and RF Changes stay up to date.', src: 'ACMA' },
        { name: 'Account emails', tab: 'admin', who: 'admin',
          what: 'Administrators are emailed when accounts are waiting, and people are told when they are approved.' },
        { name: 'Agent API', href: 'api.html', where: 'its own page',
          what: 'Station data, readings, health and catchments as JSON for your own scripts — read-only, no key needed.',
          find: 'rest json openapi' },
        { name: 'MCP server for AI agents', href: 'api.html', where: 'its own page',
          what: 'Connect Claude or another AI agent to Flood-Net\'s public station data, as tools it can call.',
          find: 'claude agent mcp' },
        { name: 'ARRO admin launcher', href: 'arroadminlauncher.html', where: 'its own page',
          what: 'A page of its own for jumping straight into ARRO\'s admin pages.', src: 'Contrail (ARRO)' },
        { name: 'CSV to stations.json', href: 'migrate.html', where: 'its own page',
          what: 'Turns the ALL_UNITS and ALL_REPEATERS CSV exports into a stations.json.', find: 'migration convert' },
        { name: 'About Flood-Net', href: 'about.html', where: 'its own page',
          what: 'What Flood-Net is and what it is not — it is not a flood warning service.' },
        { name: 'Privacy and terms', href: 'privacy.html', where: 'its own page',
          what: 'What is kept, why, who sees it and how to have it removed; the terms of use beside it.' },
      ] },
  ];

  // ── State ──────────────────────────────────────────────────────────────────
  const S = { q: '', who: '', outside: false };
  const WHO_PICKS = [
    { v: '',         label: 'Anyone at all' },
    { v: 'open',     label: 'Open to everyone' },
    { v: 'account',  label: 'Needs an account' },
    { v: 'editor',   label: 'Editors and admins' },
    { v: 'admin',    label: 'Admin only' },
  ];

  const tabOf = id => TAB_LIST.find(t => t.id === id);
  const itemId = (g, i) => `cap-${g.key}-${i}`;

  // Every line the session may see, each with its group and its tab.
  function all() {
    const out = [];
    for (const g of GROUPS) {
      g.items.forEach((it, i) => {
        const t = it.tab ? tabOf(it.tab) : null;
        if (it.tab && (!t || !tabShown(t))) return;
        out.push({ ...it, group: g, tabInfo: t, id: itemId(g, i) });
      });
    }
    return out;
  }

  // ── The search ─────────────────────────────────────────────────────────────

  function terms(q) {
    return String(q || '').toLowerCase().replace(/[^\p{L}\p{N}\s'’.+-]/gu, ' ').split(/\s+/).filter(Boolean);
  }
  const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A term matches where it starts a word: "rad" finds "radar", not "parade".
  const startsWord = (text, t) => new RegExp(`(?<![\\p{L}\\p{N}])${reEsc(t)}`, 'iu').test(text);

  function haystack(it) {
    return [it.name, it.what, it.where, it.src, it.find, it.group.name, it.tabInfo ? it.tabInfo.label : '',
      it.who ? WHO[it.who].label : '', it.src ? 'outside source external' : ''].join(' ');
  }

  function whoOk(it) {
    switch (S.who) {
      case 'open':    return !it.who;
      case 'account': return !!it.who;   // signin, member, editor, admin, list
      case 'editor':  return it.who === 'editor' || it.who === 'admin';
      case 'admin':   return it.who === 'admin';
      default:        return true;
    }
  }

  function shown() {
    const ts = terms(S.q);
    return all().filter(it => whoOk(it) && (!S.outside || it.src)
      && ts.every(t => startsWord(haystack(it), t)));
  }

  // Text, escaped, with the searched-for word starts marked.
  function marked(text) {
    const ts = terms(S.q);
    const s = String(text || '');
    if (!ts.length) return esc(s);
    const re = new RegExp(`(?<![\\p{L}\\p{N}])(${ts.map(reEsc).sort((a, b) => b.length - a.length).join('|')})`, 'giu');
    let out = '', at = 0, m;
    while ((m = re.exec(s))) {
      out += esc(s.slice(at, m.index)) + `<mark class="hit">${esc(m[0])}</mark>`;
      at = m.index + m[0].length;
      if (!m[0].length) re.lastIndex++;
    }
    return out + esc(s.slice(at));
  }

  // ── The page ───────────────────────────────────────────────────────────────

  function render() {
    const every = all();
    const outside = every.filter(it => it.src);
    const groups = GROUPS.filter(g => every.some(it => it.group === g));
    return `
    <div class="page cap-page" id="cap-page" style="--page-max:1100px">
      <section class="panel cap-hero" aria-labelledby="cap-h">
        <h2 class="cap-title" id="cap-h"><span aria-hidden="true">📇</span> Capabilities</h2>
        <p class="cap-lede">Everything Flood-Net can do, a line each. <strong>Each name opens the place it is
          done</strong>; a tag says when it is for admins only, editors, or needs you signed in, and a name in a
          dashed outline says whose data it is when it is not Flood-Net's own. Search to narrow the list — or press
          <kbd>Ctrl</kbd>+<kbd>F</kbd>: every line is on the page.</p>
        <ul class="cap-facts" aria-label="At a glance">
          <li><strong>${every.length}</strong> capabilities</li>
          <li><strong>${groups.length}</strong> groups</li>
          <li><strong>${outside.length}</strong> from outside sources</li>
          <li><strong>${every.filter(it => it.who === 'admin').length}</strong> admin only</li>
        </ul>
      </section>
      <div class="cap-bar" role="search" aria-label="Search the capabilities">
        <label class="cap-q">
          <span>Search</span>
          <input type="search" id="cap-q" value="${esc(S.q)}" placeholder="e.g. rainfall, lidar, decode, battery, cameras"
            autocomplete="off" spellcheck="false" aria-describedby="cap-count">
        </label>
        <label class="cap-who">
          <span>Who it is for</span>
          <select id="cap-who">${WHO_PICKS.map(p => `<option value="${p.v}"${p.v === S.who ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}</select>
        </label>
        <label class="check-label cap-outside"><input type="checkbox" id="cap-outside"${S.outside ? ' checked' : ''}>
          <span>Outside sources only</span></label>
        <p class="cap-count small" id="cap-count"></p>
      </div>
      <nav class="cap-jump" aria-label="Groups on this page" id="cap-jump"></nav>
      <div id="cap-list"></div>
      <details class="panel cap-words">
        <summary><h3 class="cap-words-h" id="cap-words-h">What the words on this page mean</h3></summary>
        <dl class="cap-words-dl">${WORDS.map(([w, m]) => `<dt>${esc(w)}</dt><dd>${esc(m)}</dd>`).join('')}</dl>
      </details>
      <section class="panel cap-more" aria-labelledby="cap-more-h">
        <h3 id="cap-more-h">Something missing?</h3>
        <p>If Flood-Net does something that is not on this list, or you went looking for something it cannot do
          yet, <strong>🐞 Report a Bug</strong> sends a note to whoever looks after it. Each tab's
          <strong>❔ Help</strong>, in the side panel, explains that tab in full, and the
          <strong>🗂️ Site Map</strong> says what every tab is for.</p>
        <div class="button-group">
          <button type="button" data-cap-act="bug">🐞 Report a Bug</button>
          <button type="button" data-cap-act="sitemap">🗂️ The Site Map</button>
        </div>
      </section>
    </div>`;
  }

  function tagsHtml(it) {
    let h = '';
    if (it.who) h += `<span class="cap-tag cap-tag-${it.who} term-chip" title="${esc(WHO[it.who].meaning)}">${esc(WHO[it.who].label)}</span>`;
    if (it.src) h += `<span class="cap-src term-chip" title="${esc(SOURCE_MEANING)}">${marked(it.src)}</span>`;
    return h;
  }

  // The name: a link to the tab's address where there is a tab (so a
  // Ctrl-click opens it in a browser tab of its own), a link to the page where
  // it is a page, and a button where it is a tool in the banner.
  function nameHtml(it) {
    if (it.tabInfo) return `<a class="cap-name" href="?tab=${encodeURIComponent(it.tabInfo.id)}" data-cap="${it.id}">${marked(it.name)}</a>`;
    if (it.href) return `<a class="cap-name" href="${esc(it.href)}" target="_blank" rel="noopener">${marked(it.name)}</a>`;
    return `<button type="button" class="link-btn cap-name" data-cap="${it.id}">${marked(it.name)}</button>`;
  }

  function whereHtml(it) {
    const t = it.tabInfo;
    if (!t) return marked(it.where || '');
    return `<span aria-hidden="true">${t.icon}</span> ${esc(t.label)}${it.where ? ` <span aria-hidden="true">›</span> ${marked(it.where)}` : ''}`;
  }

  function itemHtml(it) {
    return `
          <li class="cap-item" id="${it.id}">
            <p class="cap-line">${nameHtml(it)} ${tagsHtml(it)}</p>
            <p class="cap-what">${marked(it.what)}</p>
            <p class="cap-where">${whereHtml(it)}</p>
          </li>`;
  }

  function listHtml(items) {
    if (!items.length) {
      return `<div class="panel cap-none"><p><strong>Nothing matches.</strong> Try fewer words, or the start of a
        word rather than the middle of one${S.who || S.outside ? ', or set Who it is for back to Anyone at all' : ''}.</p>
        <div class="button-group"><button type="button" data-cap-act="clear">Clear the search</button></div>
        <p class="small txt-muted"><kbd>Ctrl</kbd>+<kbd>K</kbd> searches the stations, places and tabs as well.</p></div>`;
    }
    return GROUPS.map(g => {
      const mine = items.filter(it => it.group === g);
      if (!mine.length) return '';
      return `
      <section class="panel cap-group" id="cap-g-${g.key}" aria-labelledby="cap-g-h-${g.key}">
        <div class="cap-group-head">
          <h3 id="cap-g-h-${g.key}" tabindex="-1"><span aria-hidden="true">${g.icon}</span> ${esc(g.name)}
            <span class="cap-group-n">${mine.length}</span></h3>
          ${g.blurb ? `<p class="cap-group-blurb small txt-muted">${esc(g.blurb)}</p>` : ''}
        </div>
        <ul class="cap-list">${mine.map(itemHtml).join('')}</ul>
      </section>`;
    }).join('');
  }

  function jumpHtml(items) {
    const counts = GROUPS.map(g => ({ g, n: items.filter(it => it.group === g).length })).filter(x => x.n);
    if (counts.length < 2) return '';
    return `<ul class="cap-jump-list">${counts.map(({ g, n }) =>
      `<li><button type="button" class="pill" data-cap-jump="${g.key}"><span aria-hidden="true">${g.icon}</span> ${esc(g.name)} <span class="cap-jump-n">${n}</span></button></li>`).join('')}</ul>`;
  }

  let announceTimer = 0;
  function paint(say) {
    const items = shown();
    const total = all().length;
    const list = document.getElementById('cap-list');
    const jump = document.getElementById('cap-jump');
    const count = document.getElementById('cap-count');
    if (!list) return;
    list.innerHTML = listHtml(items);
    if (jump) jump.innerHTML = jumpHtml(items);
    const filtered = S.q.trim() || S.who || S.outside;
    const text = filtered ? `${items.length} of ${total} match` : `All ${total} shown`;
    if (count) count.textContent = text;
    if (say) {
      clearTimeout(announceTimer);
      announceTimer = setTimeout(() => announce(filtered ? `${items.length} of ${total} capabilities match` : `All ${total} capabilities shown`), 600);
    }
  }

  // ── Doing things ───────────────────────────────────────────────────────────

  // A name pressed: the tab it is done on, and a note saying where on it.
  // A Ctrl-, Shift- or middle-click is left to the browser: the link's address
  // opens the same tab in a new browser tab.
  function go(id) {
    const it = all().find(x => x.id === id);
    if (!it) return;
    if (it.act) { if (ACTS[it.act]) ACTS[it.act](); return; }
    switchTab(it.tab);
    if (it.open) openOnArrival(it.open);
    if (it.where && typeof Toast !== 'undefined') Toast.note(`${it.name}: ${it.tabInfo.label} › ${it.where}`);
  }

  // What to open once the tab is drawn. The Stations map builds its corner
  // after the tab's markup is in, and some of its panels (Radio coverage,
  // Repeater sites, Relocate) attach later still, so it is looked for a few
  // times rather than once. A panel is opened by its own button, the way a
  // click opens it — never pinned, which is a preference kept for good.
  let arrival = 0;
  function openOnArrival(o) {
    const mine = ++arrival;
    let tries = 0;
    const step = () => {
      if (mine !== arrival || state.activeTab !== 'stations') return;
      if (tryOpen(o)) return;
      if (++tries < 40) setTimeout(step, 100);
    };
    setTimeout(step, 60);
  }

  function tryOpen(o) {
    if (o.dock) {
      if (typeof setDockTab !== 'function') return true;
      setDockTab(o.dock);
      return true;
    }
    // On a wide screen the map hands its panels to the side panel, each a
    // pane of its own ('map-<id>', app.js dockMapKey); otherwise it is a
    // flyout in the map's corner.
    const wrap = document.querySelector(`.mn-mapctl[data-panel="${o.panel}"]`);
    if (!wrap) return false;
    if (wrap.classList.contains('is-docked')) {
      if (typeof setDockTab === 'function') setDockTab('map-' + o.panel);
    } else if (!wrap.classList.contains('is-open') && !(state.mapPanelsPinned && state.mapPanelsPinned.has(o.panel))) {
      const btn = wrap.querySelector('.mn-mapctl-btn');
      if (btn) btn.click();
    }
    if (o.find && typeof setMapDisplayFind === 'function') {
      setMapDisplayFind(o.find);
      const box = document.getElementById('map-display-find');
      if (box) box.value = o.find;
    }
    return true;
  }

  function jumpTo(key) {
    const h = document.getElementById('cap-g-h-' + key);
    if (!h) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    h.closest('section').scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
    h.focus({ preventScroll: true });
  }

  function clear() {
    S.q = ''; S.who = ''; S.outside = false;
    const q = document.getElementById('cap-q');
    const w = document.getElementById('cap-who');
    const o = document.getElementById('cap-outside');
    if (q) q.value = '';
    if (w) w.value = '';
    if (o) o.checked = false;
    paint(true);
    if (q) q.focus();
  }

  function init() {
    const page = document.getElementById('cap-page');
    if (!page) return;
    paint(false);
    const q = document.getElementById('cap-q');
    if (q) q.addEventListener('input', () => { S.q = q.value; paint(true); });
    const w = document.getElementById('cap-who');
    if (w) w.addEventListener('change', () => { S.who = w.value; paint(true); });
    const o = document.getElementById('cap-outside');
    if (o) o.addEventListener('change', () => { S.outside = o.checked; paint(true); });
    page.addEventListener('click', e => {
      const a = e.target.closest('[data-cap]');
      if (a) {
        if (a.tagName === 'A' && (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey)) return;
        e.preventDefault();
        go(a.dataset.cap);
        return;
      }
      const j = e.target.closest('[data-cap-jump]');
      if (j) { jumpTo(j.dataset.capJump); return; }
      const act = e.target.closest('[data-cap-act]');
      if (!act) return;
      if (act.dataset.capAct === 'clear') clear();
      else if (act.dataset.capAct === 'bug' && typeof BugReport !== 'undefined') BugReport.open();
      else if (act.dataset.capAct === 'sitemap') switchTab('sitemap');
    });
  }

  // ── As a file ──────────────────────────────────────────────────────────────

  function exportFile(kind) {
    const items = shown();
    if (!items.length) return;
    const whoText = it => it.who ? WHO[it.who].label : 'Everyone';
    const whereText = it => it.tabInfo ? it.tabInfo.label + (it.where ? ' › ' + it.where : '') : (it.where || '');
    if (kind === 'md') {
      const lines = ['# Flood-Net capabilities', ''];
      for (const g of GROUPS) {
        const mine = items.filter(it => it.group === g);
        if (!mine.length) continue;
        lines.push(`## ${g.name}`, '');
        for (const it of mine) {
          const tags = [it.who ? WHO[it.who].label : '', it.src ? `source: ${it.src}` : ''].filter(Boolean);
          lines.push(`- **${it.name}**${tags.length ? ` _(${tags.join('; ')})_` : ''} — ${it.what} _Where: ${whereText(it)}._`);
        }
        lines.push('');
      }
      dlText('capabilities.md', lines.join('\n'), 'text/markdown');
      return;
    }
    const rows = [['Group', 'Capability', 'Who', 'Tab', 'Where', 'Source', 'Description']]
      .concat(items.map(it => [it.group.name, it.name, whoText(it), it.tabInfo ? it.tabInfo.label : '', it.where || '', it.src || '', it.what]));
    dlText('capabilities.csv', rows.map(r => r.map(csvEscape).join(',')).join('\n'));
  }

  return {
    render, init, shown, exportFile, go, clear,
    // For `npm run nav`: every line's tab, and every tab's lines.
    lines: () => GROUPS.flatMap(g => g.items.map(it => ({
      group: g.key, name: it.name, tab: it.tab || '', act: it.act || '', href: it.href || '', who: it.who || '',
      panel: (it.open && it.open.panel) || '', acts: !it.act || !!ACTS[it.act],
    }))),
  };
})();
