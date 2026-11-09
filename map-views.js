// MegaNet — map-views.js
//
//   MapViews   the Views section at the top of the Stations map's Layers
//              panel, and the one place a radio path's strength is decided:
//
//              · ready-made views — a mix of the map's switches set in one
//                press and undone in one — for everyone, instrument
//                technicians, flood forecasters and property services, and
//                the person's own, kept on this device;
//              · how the radio paths are drawn: which of them (every path,
//                the best one, bundled, or areas instead of lines) and as
//                what (lines, flowing dashes, or tails and a spotlight);
//              · how strong the lines are: the person's own Link opacity, or
//                auto-contrast working it out from what is on screen, and
//                the Balance between the base map and the network on it.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reached from app.js — initMap attaches it after MapPaths, MapFlow and
// MapTails, and stopStationsMap detaches it; the Layers panel draws html()
// into #map-views-block and bind()s its body; refreshMapLayers asks
// lineOpacity() and fullOpacity() for each line it draws and calls
// afterBuild() when it is done; setMapLinkOpacity restyles through
// restyle(); a pin's hover and the station card's follow hooks tell hover()
// and cardChanged(); the legend asks legendHtml() and the Link opacity row
// opacityNoteHtml() — and from map-paths.js, map-flow.js and map-tails.js,
// which read settings() and hovered() and hand restyle() the lines whose lit
// state changed. All of it from inside functions, and the IIFE body only
// declares, so this file's position among the modules is free; Leaflet and
// every other module are reached the same way, each behind a typeof
// (npm run toplevel).
//
// ── One function decides every link's opacity ────────────────────────────────
// A link's opacity used to be set in three places — the build, the Link
// opacity slider and the repeater focus dim — and each put in the one thing
// it knew. Flow, tails, auto-contrast and Balance are four more things that
// bear on the same number, and five places multiplying in their own factor is
// five places to disagree. So lineOpacity() is the one answer, restyle() the
// one place it is written to a line, and the build, the slider, the
// spotlight and the views all go through them:
//
//   base   the person's Link opacity — or, with auto-contrast on, the figure
//          it worked out for what is on screen
//   × bal  Balance: 0.45 at the photo end, 1 in the middle, 1.55 at the
//          network end
//   × role a casing at MAP_LINK_CASING_MIX (0.75) of its core, as it always was
//   = full what the 3-D view and the twin copy (line.mnFullOpacity): neither
//          can see the flowing dashes or the tails, so neither takes their
//          factor
//   × mode the 2-D drawing's own factor — faint under flowing dashes, and
//          nothing for a tail whose path is not lit — 1 while 3-D or the twin
//          is up, because then the 2-D overlays are not drawing
//
// The focus dim stays applyMapFocusStyles' (a fifth of mnBaseOpacity), and
// restyle() honours it, which the old slider loop did not: moving it put a
// dimmed line back to full until the next focus pass. A line drawn at almost
// nothing is also made not interactive, so a path hidden behind its tails is
// neither hovered nor clicked (the shared canvas renderer, pinFirstCanvas,
// reads the flag live).
//
// ── Auto-contrast ────────────────────────────────────────────────────────────
// What makes the paths unreadable is not their number but how much of the
// screen they cover: 1,800 paths zoomed out are a solid mat, a dozen zoomed in
// are hairlines. So the figure is a coverage — each drawn core's length on
// screen, clipped to the screen, times its width plus a pixel each side,
// over the screen's area — and the strength is what puts about 4.5 % of the
// screen in solid line, kept between 12 % and 90 %. Worked out again after
// every build and whenever the map stops moving, and only repainted when it
// moves by more than 1.5 points, so a small pan does not restyle five
// thousand lines. It never writes mn-map-link-opacity: that is the person's
// own value, and turning auto-contrast off puts it back. While the 3-D view is
// up it holds: the 2-D map under it is not what anybody is looking at.
//
// ── Balance ──────────────────────────────────────────────────────────────────
// The base map is images, so taking it back is a CSS filter on Leaflet's tile
// pane, not a refetch: toward Network it greys and darkens; toward Photo it is
// left alone and the lines fade instead. Only on this map's pane — not saved
// into mn-base-maps, which all seven maps share — and not the 3-D view's or
// the magnifier's tiles, which are their own.
//
// ── Views, and putting the map back ──────────────────────────────────────────
// A view is a list of knobs: the base map, which stations and paths, the link
// colouring, the overlay layers, and the drawing settings above. Applying one
// reads each knob and calls its own module's setter only where it differs, so
// a view that is already half in place costs half as much, and anything the
// view leaves out is left as it is. The setters each rebuild or repaint as if
// a person had ticked their box; state.mapRefreshHold asks app.js to let those
// rebuilds go while the view is applied, and the map is built, the panel
// redrawn and the legend repainted once at the end.
//
// The map as it was just before is kept for the session, and Put the map back
// applies it as if it were a view. Saved views are the same snapshot with a
// name, in mn-map-saved-views. Two knobs — whether the radio paths are shown
// and which kinds of station are drawn — are not remembered by their own
// switches, so the last view picked (mn-map-view-pick) puts those two back on
// the next visit, as long as the rest of that view is still in force.
//
// Exposes: attach, detach, html, bind, rerender, settings, set, lineOpacity,
// fullOpacity, restyle, afterBuild, autoValue, hover, hovered, hoverGroup,
// hoveredIds, cardChanged,
// apply, undo, save, remove, active, snapshot, saved, togglePlay, VIEWS, WORDS,
// legendHtml, opacityNoteHtml, _state.

const MapViews = (function () {
  const LS_DRAWING = 'mn-map-drawing';
  const LS_PICK = 'mn-map-view-pick';
  const LS_SAVED = 'mn-map-saved-views';
  // Which of the section's two folds are open, per device. Both start shut:
  // the views themselves are the quick way in, and an open pair of cards put
  // every older Layers row a screen further down.
  const LS_OPEN = 'mn-map-views-open';
  const MAX_SAVED = 12;          // views a person can keep
  const NAME_MAX = 40;           // characters in a kept view's name
  const EPS = 0.004;             // an opacity that moved less than this is not repainted
  const AUTO_TARGET = 0.055;     // share of the screen auto-contrast aims to cover in solid line
  const AUTO_MIN = 0.16;         // …and the faintest and strongest it will go
  const AUTO_MAX = 0.9;
  const AUTO_STEP = 0.015;       // a new figure closer than this to the last is not applied
  const BAL_TOL = 3;             // a view's Balance still counts as in force within this many points
  const FOCUS_DIM = 0.2;         // applyMapFocusStyles' dim, as a fraction of mnBaseOpacity
  const CORE_W = 1.5;            // a core's width, when a line carries none
  const MOVE_SETTLE_MS = 60;     // moveend and zoomend arrive together; one answer for both
  const TURN_TICK_MS = 800;      // how often the "its turn now" line is read again

  const PATHS = ['every', 'best', 'lod', 'bundle', 'areas'];
  const DRAWS = ['lines', 'flow', 'tails'];
  const FLOW_MODES = ['all', 'turns', 'live'];
  const ROLES = ['field', 'repeater', 'base'];
  const FIELD_ROLES = new Set(['casing', 'core']);
  const BACKBONE_ROLES = new Set(['backbone', 'backbone-casing', 'backbone-dash']);
  const CASING_ROLES = new Set(['casing', 'backbone-casing']);

  // Today's map, exactly: every path, plain lines, the person's own opacity,
  // no Balance. Nobody's map changes until somebody picks something.
  const DEFAULTS = {
    paths: 'every',
    draw: 'flow',      // see defaultDraw(): Flow, unless the address says otherwise
    flow: { mode: 'all', speed: 1, under: 0.35, playing: null },
    tails: { len: 24, spot: 90, follow: true, backboneFull: true },
    auto: false,
    balance: 50,
  };
  // The settings' leaves, for working out what a change touched.
  const KEYS = ['paths', 'draw', 'flow.mode', 'flow.speed', 'flow.under', 'flow.playing',
    'tails.len', 'tails.spot', 'tails.follow', 'tails.backboneFull', 'auto', 'balance'];

  // The words the section uses, on hover where they are used and in the
  // section's own fold (core.js's rule: hover never reaches a finger).
  const WORDS = {
    View: 'A ready-made mix of the map\'s settings — the base map, which stations, paths and layers are on, and how the '
      + 'paths are drawn — set in one press. Anything you change afterwards is yours; Put the map back undoes the last view '
      + 'you picked.',
    'Best path': 'For each field station, only the one path to the repeater it is most likely to use: the one with the most '
      + 'fade margin (the signal it has to spare, in dB) where that has been worked out, otherwise the nearest repeater. Point '
      + 'at a station, open its card or focus a repeater to see its other paths, dashed. The backbone is cut the same way: '
      + 'each repeater keeps the one path on its best way to a base (the fewest hops, then the shortest), so the backbone '
      + 'is a tree into the bases rather than every pair of repeaters that could relay.',
    'Bundled into trunks': 'Paths of 16 km or more that come into one repeater from the same direction (within a 36° slice) '
      + 'curve together into one trunk on the way in, wider the more paths it carries. Shorter paths, and a path on its own, '
      + 'stay straight.',
    Areas: 'No lines: each repeater gets a coloured area round the field stations whose best path is to it (about 4.5 km '
      + 'round each), and those stations\' pins wear the same colour as a ring. Repeaters less than 60 km apart never share a colour.',
    Flow: 'Dashes run along each path into its repeater, and along the backbone on to the base, the way the readings travel. '
      + 'The lines underneath are faded so the dashes read. It starts paused if your device asks for less motion.',
    'Take turns': 'One repeater at a time, west to east, about 2.6 seconds each at the usual speed: its paths are drawn in full '
      + 'with the dashes running in, and its name is shown beside it. Focus a repeater to hold the turn on it.',
    'Live readings': 'The real messages, as they arrive: a pulse runs from the station along its path to the repeater and on '
      + 'to the base when one of its readings comes in, checked every 15 seconds. These are ⏱️ Latency\'s pulses, with the '
      + 'lines faded underneath so they show.',
    Tails: 'Instead of whole lines, each path shows only a short tail out of each end — 24 pixels long to begin with — '
      + 'pointing along it. A path is drawn in full when you point at its station or it is in the spotlight.',
    Spotlight: 'A circle round the pointer, 120 pixels from its middle to begin with: every path from a station inside it is '
      + 'drawn in full. On a touch screen, tap the map to move it.',
    'Auto-contrast': 'Sets how strong the lines are from how much of the screen they cover: many lines on screen and each is '
      + 'drawn fainter, a few and they are drawn stronger — between 12 % and 90 %. Worked out again whenever the map stops '
      + 'moving. Your own Link opacity is kept for when you turn it off.',
    Presenting: 'For a screen shared on a call (Teams and the like), where everything that moves on the screen costs the '
      + 'call: Flow\u2019s dashes stand still, the 3-D view\u2019s rising water stops, and the 3-D view is drawn at one pixel per '
      + 'screen pixel. Remembered on this device until you switch it off.',
    Balance: 'Which comes forward, the map underneath or the network on it. Toward Network the base map turns grey and darker '
      + '(up to 85 % grey) and the lines get up to half as strong again; toward Photo the map keeps its colours and the lines '
      + 'fade, to under half at the end.',
    Easement: 'A strip of a lot that someone other than its owner has a right to use — a council drain, a power line, a neighbour’s driveway. The land stays the owner’s. Drawn as a dashed white line under the property lines; a station card’s land details name the easements at that site.',
    'Land tenure': 'How the land is held: freehold (owned privately), leased from the State, or kept by the State as a national park, State forest, reserve or unallocated State land. Freehold is left clear; each other kind is a pale colour of its own, under the property lines (Queensland only).',
  };

  const GROUPS = [
    ['everyone', 'Everyone'],
    // One word each (owner, 7 Nov 2026): who the views are for at a glance.
    ['tech', 'Technicians'],
    ['flood', 'Flood'],
    ['property', 'Property'],
  ];

  // The overlay layers a view switches, each on its own module's setter.
  const LAYER_KNOBS = ['riverLines', 'riverCatchment', 'rain', 'elev', 'catchments', 'lots', 'easements', 'tenure',
    'roads', 'roadOwners', 'councils', 'survey', 'hubs', 'wind', 'cameras', 'photos', 'siteFeatures', 'twinOffer'];
  // What a person calls them, for a kept view's description.
  const LAYER_NAMES = {
    riverLines: 'rivers', riverCatchment: 'a river\'s catchment', rain: 'rainfall', elev: 'ground height',
    catchments: 'river basins', lots: 'property boundaries', easements: 'easements', tenure: 'land tenure',
    roads: 'road parcels', roadOwners: 'road owners', councils: 'council areas', survey: 'survey marks',
    hubs: 'maintenance hubs', wind: 'wind regions', cameras: 'flood cameras', photos: 'field photos',
    siteFeatures: 'site features', twinOffer: 'the digital twin',
  };
  const PATH_WORDS = {
    every: 'every path', best: 'the best path only', lod: 'the best path until zoomed in',
    bundle: 'paths bundled into trunks', areas: 'areas instead of paths',
  };
  const DRAW_WORDS = { lines: 'lines', flow: 'flowing dashes', tails: 'tails and a spotlight' };

  const ALL_ROLES = { field: true, repeater: true, base: true };
  const FIELD_ONLY = { field: true, repeater: false, base: false };

  // Every overlay knob, off, but for the ones named: a view lists them all,
  // so what it shows is the same whatever the map had on before.
  function only(...names) {
    const o = {};
    for (const k of LAYER_KNOBS) o[k] = names.includes(k);
    return o;
  }

  // The built-in views. The values are tuned here; the intent is the
  // owner's (build spec §7.4). `base: null` leaves the base map alone, and a
  // view with no radio paths leaves the link colouring alone: neither is
  // what it is about. `caution` is said in the chip's title — what turning
  // it on fetches.
  // Every view says whether the backbone is on, and only Overview and
  // Backbone have it: drawn over Site visit's tails, Radio paths' spotlight,
  // Weak links' margins or Live traffic's pulses it was most of what the eye
  // saw (the owner, 8 Nov 2026: "it makes a few of the view modes look
  // shit … need to have them switch it off automatically").
  const VIEWS = [
    {
      id: 'overview', group: 'everyone', label: 'Overview',
      say: 'The whole network at a glance: every station, one best path for each field station until you zoom in, and the '
        + 'lines kept readable on whatever base map you have.',
      knobs: {
        base: null, links: true, roles: ALL_ROLES, backbone: true, arrows: false, colour: 'freq', health: false,
        outlines: false, ...only('riverLines', 'cameras', 'photos', 'siteFeatures'),
        drawing: { paths: 'lod', draw: 'flow', flow: { mode: 'all' }, auto: true, balance: 50 },
      },
    },
    {
      id: 'site', group: 'everyone', label: 'Site visit',
      say: 'For a visit to a site: the satellite photo with property lines, easements, roads and survey marks, the field '
        + 'photos and site features. Radio paths are short tails until you point at a station.',
      caution: 'Property lines, roads and survey marks are fetched once you zoom in close.',
      knobs: {
        base: 'Satellite', links: true, roles: ALL_ROLES, backbone: false, arrows: false, colour: 'freq', health: true,
        outlines: false,
        ...only('lots', 'easements', 'roads', 'survey', 'photos', 'siteFeatures', 'cameras', 'twinOffer', 'riverLines'),
        drawing: { paths: 'every', draw: 'tails', tails: { follow: true }, auto: true, balance: 35 },
      },
    },
    {
      id: 'radio', group: 'tech', label: 'Radio paths',
      say: 'For work on the radio network: the satellite photo, every path as tails that light up round the pointer, arrows '
        + 'the way the readings travel, pins coloured by health, and the maintenance hubs.',
      caution: 'Fetches the maintenance hub areas (about 550 KB) the first time.',
      knobs: {
        base: 'Satellite', links: true, roles: ALL_ROLES, backbone: false, arrows: true, colour: 'freq', health: true,
        outlines: false, ...only('hubs', 'riverLines', 'photos', 'siteFeatures', 'twinOffer'),
        drawing: { paths: 'every', draw: 'tails', tails: { follow: true }, auto: true, balance: 62 },
      },
    },
    {
      id: 'weak', group: 'tech', label: 'Weak links',
      say: 'Every path coloured by its fade margin — the signal it has to spare — on a greyed map, so the weak ones stand out.',
      caution: 'Works out the margin for each path that has none saved yet, which fetches the ground heights along it.',
      knobs: {
        base: null, links: true, roles: ALL_ROLES, backbone: false, arrows: false, colour: 'fade', health: false,
        outlines: false, ...only('riverLines', 'photos', 'siteFeatures', 'twinOffer'),
        drawing: { paths: 'every', draw: 'lines', auto: true, balance: 85 },
      },
    },
    {
      id: 'backbone', group: 'tech', label: 'Backbone',
      say: 'Only the repeaters and bases and the backbone paths between them, with arrows the way the readings travel, their '
        + 'health, and the maintenance hubs.',
      caution: 'Fetches the maintenance hub areas (about 550 KB) the first time.',
      knobs: {
        base: null, links: true, roles: { field: false, repeater: true, base: true }, backbone: true, arrows: true,
        colour: 'freq', health: true, outlines: false, ...only('hubs', 'riverLines', 'photos', 'siteFeatures', 'twinOffer'),
        drawing: { paths: 'every', draw: 'flow', flow: { mode: 'all' }, auto: true, balance: 60 },
      },
    },
    {
      id: 'traffic', group: 'tech', label: 'Live traffic',
      say: 'Each field station\'s best path, faded, with a pulse running along it whenever one of its readings comes in.',
      caution: 'Asks the network for new readings every 15 seconds while it is on.',
      knobs: {
        base: null, links: true, roles: ALL_ROLES, backbone: false, arrows: false, colour: 'freq', health: true,
        outlines: false, ...only('riverLines', 'photos', 'siteFeatures', 'twinOffer'),
        drawing: { paths: 'best', draw: 'flow', flow: { mode: 'live' }, auto: true, balance: 65 },
      },
    },
    {
      id: 'rivers', group: 'flood', label: 'Rivers & catchments',
      say: 'Rivers and the land that drains to them on a topographic map: the river basins, ground height, the field stations '
        + 'with forecast and information locations outlined, and the flood cameras. No radio paths.',
      caution: 'Fetches the ground heights for each screenful, and the river basins (about 760 KB) the first time.',
      knobs: {
        base: 'OSM-Topo', links: false, roles: FIELD_ONLY, backbone: false, arrows: false, health: false, outlines: true,
        ...only('riverLines', 'riverCatchment', 'catchments', 'elev', 'cameras', 'photos', 'siteFeatures', 'twinOffer'),
        drawing: { paths: 'every', draw: 'lines', auto: true, balance: 40 },
      },
    },
    {
      id: 'rain', group: 'flood', label: 'Rainfall',
      say: 'The network\'s rain gauges as a heat map over the river basins on a light map, with the field stations and the '
        + 'forecast and information locations outlined. No radio paths.',
      caution: 'Reads the network\'s rain readings, and reads them again every 5 minutes while it is on.',
      knobs: {
        base: 'Light', links: false, roles: FIELD_ONLY, backbone: false, arrows: false, health: false, outlines: true,
        ...only('riverLines', 'catchments', 'rain', 'cameras', 'photos', 'siteFeatures'),
        drawing: { paths: 'every', draw: 'lines', auto: true, balance: 40 },
      },
    },
    {
      id: 'property', group: 'property', label: 'Property & easements',
      say: 'The satellite photo with property boundaries, easements, road parcels and who looks after each road, council '
        + 'areas and survey marks. Rest the mouse on the land, or tap it, for its lot on plan, area, tenure, easements and address. '
        + 'No radio paths.',
      caution: 'Fetches the council areas (about 1 MB) and draws road owners from a regional view; property lines, easements '
        + 'and survey marks once you zoom in.',
      knobs: {
        base: 'Satellite', links: false, roles: ALL_ROLES, backbone: false, arrows: false, health: false, outlines: false,
        ...only('lots', 'easements', 'roads', 'roadOwners', 'councils', 'survey', 'riverLines', 'photos', 'siteFeatures',
          'twinOffer'),
        drawing: { paths: 'every', draw: 'lines', auto: true, balance: 40 },
      },
    },
    {
      id: 'land', group: 'property', label: 'Land & tenure',
      say: 'How the land is held — freehold, leases, State land, parks and forests — with property boundaries, easements, '
        + 'roads, council areas and river basins on a topographic map. Rest the mouse on the land, or tap it, for its tenure, who '
        + 'holds that kind of land and what it is used for. No radio paths.',
      caution: 'Fetches the river basins (about 760 KB) and council areas (about 1 MB) the first time; land tenure and '
        + 'property lines once you zoom in.',
      knobs: {
        base: 'OSM-Topo', links: false, roles: ALL_ROLES, backbone: false, arrows: false, health: false, outlines: false,
        ...only('tenure', 'lots', 'easements', 'riverLines', 'catchments', 'councils', 'roads', 'photos', 'siteFeatures'),
        drawing: { paths: 'every', draw: 'lines', auto: true, balance: 40 },
      },
    },
  ];

  const S = {
    cfg: null,            // the drawing settings, read from storage on first ask
    addressDraw: null,    // how the address said to draw the paths (fromAddress)
    find: [],             // the words in Layers' find box, lower-cased (find)
    map: null,
    root: null,           // the Layers panel's body, from bind()
    autoOp: null,         // auto-contrast's last figure, or null
    autoN: 0,             // …and the lines on screen it was worked out from
    lastFlat: true,       // whether the last restyle saw the flat map (no 3-D, no twin)
    hovered: null,        // the station id under the pointer
    hoveredGroup: null,   // …or a bubble's stations, while the pointer is on one (hoverGroup)
    pick: undefined,      // the last view applied (mn-map-view-pick), read on first ask
    saved: null,          // the kept views (mn-map-saved-views), read on first ask
    undo: null,           // { snap, pick } — the map as it was before the last view
    sessionDone: false,   // the picked view's session-only knobs are put back once per page
    oweRefresh: false,    // a rebuild a change asked for while the hold was on
    unsaved: false,       // a slider moved live and not yet written
    moveT: null,
    turnT: null,
    soonRaf: null,
    liveRaf: null,
    livePatch: null,
    mq: null,             // the reduced-motion query, while attached
  };
  const BOUND = new WeakSet();

  // ── Small helpers ──────────────────────────────────────────────────────────

  const readLS = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const writeLS = (k, v) => {
    try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) { /* this session only */ }
  };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const num = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? clamp(n, lo, hi) : dflt; };
  const copy = o => JSON.parse(JSON.stringify(o));
  const pct = v => `${Math.round(v * 100)} %`;
  const at = (o, k) => k.split('.').reduce((x, p) => (x == null ? x : x[p]), o);
  const raf = fn => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16));
  const mapNow = () => S.map || (typeof state !== 'undefined' && state.map) || null;
  const lines = () => (typeof state !== 'undefined' && state.mapLines) || [];

  // Another module's call, kept from taking the map with it: an error is
  // said in the console, and the build or the restyle carries on.
  function safely(fn, what) {
    try { return fn(); } catch (e) { console.error('MapViews:', what, e); return undefined; }
  }
  const has = (mod, fn) => !!(mod && typeof mod[fn] === 'function');
  const modPaths = () => (typeof MapPaths !== 'undefined' ? MapPaths : null);
  const modFlow = () => (typeof MapFlow !== 'undefined' ? MapFlow : null);
  const modTails = () => (typeof MapTails !== 'undefined' ? MapTails : null);

  // The 3-D view or the digital twin up: the 2-D overlays stop drawing, and
  // the lines are drawn without the 2-D drawing's factor.
  function isFlat() {
    const three = typeof Map3D !== 'undefined' && has(Map3D, 'active') && safely(() => Map3D.active(), '3-D');
    const twin = typeof MapTwin !== 'undefined' && has(MapTwin, 'active') && safely(() => MapTwin.active(), 'twin');
    return !three && !twin;
  }
  function reducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (_) { return false; }
  }
  function hoverCapable() {
    try { return !!(window.matchMedia && window.matchMedia('(hover: hover)').matches); } catch (_) { return true; }
  }
  const playingNow = cfg => (cfg.flow.playing != null ? cfg.flow.playing : !reducedMotion());

  // ── The settings (build spec §2) ──────────────────────────────────────────

  // Anything in range kept, anything else back to its default: storage can
  // hold a value from an older version, or one typed into the console.
  // How the paths are drawn until somebody chooses: Flow, under every look
  // (the owner's call, 7 Nov 2026, and for Classic too on 8 Nov) — unless the
  // address said otherwise (fromAddress, below).
  function defaultDraw() {
    return S.addressDraw || 'flow';
  }
  // `?draw=lines` (or flow, tails): how this page draws the paths until
  // somebody chooses, for this page only. A link that shows the plain lines,
  // and the door the browser checks open on them by (test/lib/browser.mjs pins
  // it under Classic, as it pins the look). Never stored, and taken out of the
  // address, as `?rail=` is (app.js, dockNamesFromAddress). Called from
  // init.js, after Route has seen the address.
  function fromAddress() {
    let q = null;
    try { q = new URLSearchParams(location.search); } catch (_) { return; }
    if (!q.has('draw')) return;
    const v = q.get('draw');
    if (DRAWS.includes(v)) { S.addressDraw = v; S.cfg = null; }
    q.delete('draw');
    const rest = q.toString();
    try { history.replaceState(history.state, '', location.pathname + (rest ? '?' + rest : '') + location.hash); } catch (_) {}
  }
  // The stored settings' version. Before 2 the default was plain lines, and
  // a stored 'lines' was most often only that default written down when
  // something else was changed, so it is read as the new default once. At 2
  // Classic still started on lines, so a 2 that says lines under Classic is
  // read the same way once more; anywhere else a 2 that says lines was chosen.
  const DRAWING_V = 3;
  function oldDefaultLines(raw) {
    if (!raw || typeof raw !== 'object' || raw.draw !== 'lines' || raw.v === DRAWING_V) return false;
    if (raw.v !== 2) return true;
    try { return typeof lookStored === 'function' && lookStored() === 'classic'; } catch (_) { return false; }
  }
  function clean(c) {
    const d = Object.assign({}, DEFAULTS, { draw: defaultDraw() });
    const o = c && typeof c === 'object' ? c : {};
    const f = o.flow && typeof o.flow === 'object' ? o.flow : {};
    const t = o.tails && typeof o.tails === 'object' ? o.tails : {};
    return {
      paths: PATHS.includes(o.paths) ? o.paths : d.paths,
      draw: DRAWS.includes(o.draw) ? o.draw : d.draw,
      flow: {
        mode: FLOW_MODES.includes(f.mode) ? f.mode : d.flow.mode,
        speed: Math.round(num(f.speed, 0.3, 2.5, d.flow.speed) * 100) / 100,
        under: Math.round(num(f.under, 0, 1, d.flow.under) * 100) / 100,
        playing: f.playing === true || f.playing === false ? f.playing : null,
      },
      tails: {
        len: Math.round(num(t.len, 8, 70, d.tails.len)),
        spot: Math.round(num(t.spot, 60, 260, d.tails.spot)),
        follow: typeof t.follow === 'boolean' ? t.follow : d.tails.follow,
        backboneFull: typeof t.backboneFull === 'boolean' ? t.backboneFull : d.tails.backboneFull,
      },
      auto: typeof o.auto === 'boolean' ? o.auto : d.auto,
      balance: Math.round(num(o.balance, 0, 100, d.balance)),
    };
  }
  function C() {
    if (!S.cfg) {
      let raw = null;
      try { raw = JSON.parse(readLS(LS_DRAWING) || 'null'); } catch (_) { raw = null; }
      S.cfg = clean(raw);
      if (oldDefaultLines(raw)) S.cfg.draw = defaultDraw();
    }
    return S.cfg;
  }
  function merge(into, patch) {
    for (const [k, v] of Object.entries(patch || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v) && into[k] && typeof into[k] === 'object') merge(into[k], v);
      else into[k] = v;
    }
    return into;
  }
  const settings = () => copy(C());
  const holding = () => !!(typeof state !== 'undefined' && state.mapRefreshHold);

  // set(patch, opts): merge, clamp, keep, and react. opts.quiet leaves the
  // section as it is (a view being applied redraws it once at the end);
  // opts.live is a slider being dragged — the map follows it, a frame at a
  // time, and nothing is written until the slider's change.
  function set(patch, opts = {}) {
    if (opts.live) {
      S.livePatch = merge(S.livePatch || {}, copy(patch || {}));
      if (!S.liveRaf) {
        S.liveRaf = raf(() => {
          S.liveRaf = null;
          const p = S.livePatch;
          S.livePatch = null;
          if (p) commit(p, { live: true });
        });
      }
      return settings();
    }
    // A change lands after the inputs that led to it: whatever they left
    // waiting is part of it.
    if (S.livePatch) { patch = merge(S.livePatch, copy(patch || {})); S.livePatch = null; }
    return commit(patch, opts);
  }

  function commit(patch, opts) {
    const before = C();
    const next = clean(merge(copy(before), patch || {}));
    const ch = new Set(KEYS.filter(k => at(before, k) !== at(next, k)));
    S.cfg = next;
    if (ch.size) react(ch, next);
    if (opts.live) {
      if (ch.size) S.unsaved = true;
      paintReadouts();
      return settings();
    }
    const wrote = ch.size > 0 || S.unsaved;
    if (wrote) { writeLS(LS_DRAWING, JSON.stringify(Object.assign({ v: DRAWING_V }, next))); S.unsaved = false; }
    if (opts.quiet) paintReadouts();
    else rerender();
    if (wrote && typeof rerenderMapLegend === 'function') rerenderMapLegend();
    // The Link opacity row says auto-contrast is setting it, and is not to be
    // moved while it does (app.js draws that row).
    if (ch.has('auto') && typeof rerenderMapDisplayControls === 'function') rerenderMapDisplayControls();
    return settings();
  }

  function react(ch, next) {
    if (ch.has('balance')) applyTileFilter();
    if (ch.has('auto')) {
      if (next.auto) recomputeAuto({ restyle: false });
      else { S.autoOp = null; S.autoBb = null; S.autoN = 0; }
    }
    if (ch.has('paths')) {
      // The build reads MapPaths, which reads these settings.
      if (holding()) S.oweRefresh = true;
      else if (typeof refreshMapLayers === 'function') refreshMapLayers({ skipFit: true });
    }
    if ([...ch].some(k => k !== 'paths')) {
      restyle();
      syncOverlays();
    }
    if (ch.has('draw') || ch.has('flow.mode')) tickTurn();
    // The 3-D view follows how the paths are drawn (Flow's dashes, faint
    // field paths under Flow and Tails, the backbone's amber).
    if (['draw', 'flow.mode', 'flow.under', 'flow.playing', 'flow.speed'].some(k => ch.has(k))
        && typeof Map3D !== 'undefined' && typeof Map3D.viewsChanged === 'function') {
      safely(() => Map3D.viewsChanged(), 'Map3D.viewsChanged');
    }
  }

  function syncOverlays() {
    const F = modFlow(), T = modTails(), P = modPaths();
    if (has(F, 'sync')) safely(() => F.sync(), 'MapFlow.sync');
    if (has(T, 'sync')) safely(() => T.sync(), 'MapTails.sync');
    if (has(P, 'schedule')) safely(() => P.schedule(), 'MapPaths.schedule');
  }

  // ── Line strength (build spec §3) ─────────────────────────────────────────

  function casingMix() {
    // app.js's constant; read at call time, when every script has loaded.
    try { return MAP_LINK_CASING_MIX; } catch (_) { return 0.75; }
  }
  function manualOp() {
    const v = typeof state !== 'undefined' ? Number(state.mapLinkOpacity) : NaN;
    return Number.isFinite(v) ? clamp(v, 0, 1) : 0.25;
  }
  const balMul = b => 0.45 + 1.1 * b / 100;
  // The backbone under auto-contrast: a few dozen paths, the ones every
  // reading crosses, so they are not drawn as faint as the thousands of
  // field paths the figure was worked out for — a multiple of it, between
  // these two.
  // Worked out from the backbone's own share of the screen, so a hundred
  // repeater paths round a city are drawn fainter than ten in the bush.
  const BB_TARGET = 0.02, BB_AUTO_MIN = 0.3, BB_AUTO_MAX = 0.9;
  // Tails & spotlight draws almost nothing whole, so what it does draw
  // whole — the paths the spotlight or the pointer lights, and the
  // backbone — is drawn strong whatever the strength figure is: the point
  // of the mode is that those stand out.
  const LIT_MIN = 0.85;
  // The map's own backbone lines under Flow's amber ones: faint, but over the
  // 0.02 a line needs to stay hoverable.
  const FLOW_BB_UNDER = 0.12;

  // What every line in one pass shares, worked out once for the pass.
  function context() {
    const cfg = C();
    const flat = isFlat();
    const T = modTails();
    return {
      cfg, flat,
      base: cfg.auto && S.autoOp != null ? S.autoOp : manualOp(),
      bbBase: cfg.auto && S.autoBb != null ? S.autoBb : cfg.auto && S.autoOp != null ? S.autoOp : manualOp(),
      bal: balMul(cfg.balance),
      mix: casingMix(),
      tails: flat && cfg.draw === 'tails' && has(T, 'isLit') ? T : null,
      flow: flat && cfg.draw === 'flow' && !!modFlow(),
    };
  }
  function fullWith(line, x) {
    const role = line && line.mnLinkRole;
    const base = BACKBONE_ROLES.has(role) ? x.bbBase : x.base;
    return clamp(base * x.bal * (CASING_ROLES.has(role) ? x.mix : 1), 0, 1);
  }
  // A line's strength in this drawing: its full strength times the mode's
  // factor, lifted to the Tails floor when Tails draws it whole.
  function drawnWith(line, x, full) {
    const m = modeWith(line, x);
    let op = clamp(full * m, 0, 1);
    if (x.tails && m === 1) {
      const role = line && line.mnLinkRole;
      const floor = FIELD_ROLES.has(role) ? LIT_MIN : 0;
      op = Math.max(op, floor * (CASING_ROLES.has(role) ? x.mix : 1));
    }
    return op;
  }
  function modeWith(line, x) {
    const role = line && line.mnLinkRole;
    const field = FIELD_ROLES.has(role), backbone = BACKBONE_ROLES.has(role);
    if (x.flow) {
      if (field) return x.cfg.flow.under;
      // Everything flows and Repeaters take turns draw the backbone
      // themselves, in amber (map-flow.js), so the map's own black-dashed one
      // steps right back — kept just strong enough to hover and click.
      // Live readings draws nothing of its own: the backbone stays as it was.
      if (backbone) return x.cfg.flow.mode === 'live' ? Math.max(0.5, x.cfg.flow.under) : (role === 'backbone-dash' ? 0 : FLOW_BB_UNDER);
      return 1;
    }
    if (x.tails) {
      if (field) return safely(() => x.tails.isLit(line), 'MapTails.isLit') ? 1 : 0;
      if (backbone) return x.cfg.tails.backboneFull ? 1 : 0;
      return 1;
    }
    return 1;
  }
  const fullOpacity = line => fullWith(line, context());
  function lineOpacity(line) {
    const x = context();
    return drawnWith(line, x, fullWith(line, x));
  }

  // Every line with a role (or only the ones given — the spotlight hands over
  // the few whose lit state changed): the strength worked out, kept on the
  // line for the focus dim and for 3-D, and painted where it moved.
  function restyle(list) {
    const x = context();
    let fullMoved = false;
    for (const l of list || lines()) {
      if (!l || !l.mnLinkRole) continue;
      const full = fullWith(l, x);
      const op = drawnWith(l, x, full);
      if (l.mnFullOpacity == null || Math.abs(l.mnFullOpacity - full) > EPS) fullMoved = true;
      l.mnFullOpacity = full;
      l.mnBaseOpacity = op;
      const shown = l.mnFocusDimmed ? op * FOCUS_DIM : op;
      const now = l.options ? l.options.opacity : null;
      if ((now == null || Math.abs(now - shown) > EPS) && typeof l.setStyle === 'function') l.setStyle({ opacity: shown });
      if (l.options) l.options.interactive = op > 0.02;
    }
    S.lastFlat = x.flat;
    if (typeof MapArrows !== 'undefined' && has(MapArrows, 'schedule')) MapArrows.schedule();
    if (fullMoved && !x.flat && typeof Map3D !== 'undefined' && has(Map3D, 'active') && Map3D.active() && has(Map3D, 'sync')) {
      // Once the strength stops moving: a Balance slider dragged with the
      // 3-D view open would otherwise rebuild its few thousand features on
      // every frame of the drag.
      if (S.sync3d) clearTimeout(S.sync3d);
      S.sync3d = setTimeout(() => {
        S.sync3d = null;
        if (typeof Map3D !== 'undefined' && Map3D.active()) safely(() => Map3D.sync(), 'Map3D.sync');
      }, SYNC_3D_MS);
    }
  }
  const SYNC_3D_MS = 160;

  // ── Auto-contrast (build spec §3.1) ───────────────────────────────────────

  // A segment's length inside the screen (Liang–Barsky), in pixels.
  function clipLen(x0, y0, x1, y1, W, H) {
    const dx = x1 - x0, dy = y1 - y0;
    let t0 = 0, t1 = 1;
    const ps = [-dx, dx, -dy, dy], qs = [x0, W - x0, y0, H - y0];
    for (let i = 0; i < 4; i++) {
      const p = ps[i], q = qs[i];
      if (p === 0) { if (q < 0) return 0; continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) return 0; if (r > t0) t0 = r; } else { if (r < t0) return 0; if (r < t1) t1 = r; }
    }
    return Math.hypot(dx, dy) * (t1 - t0);
  }
  function pointsOf(l) {
    let ll = typeof l.getLatLngs === 'function' ? l.getLatLngs() : [];
    while (ll.length && Array.isArray(ll[0])) ll = ll.flat();
    return ll;
  }
  // How much of the screen the drawn cores cover: each field core's and
  // backbone core's length on screen times its width plus a pixel each side,
  // over the screen's area. Every drawn line counts, whatever its opacity —
  // counting only the visible ones would make the answer chase itself.
  function measure() {
    const map = S.map;
    if (!map || typeof map.getSize !== 'function') return null;
    const sz = map.getSize();
    const W = sz.x, H = sz.y;
    if (!(W > 1 && H > 1)) return null;
    let sum = 0, n = 0, bb = 0;
    for (const l of lines()) {
      if (!l || (l.mnLinkRole !== 'core' && l.mnLinkRole !== 'backbone')) continue;
      const pts = pointsOf(l);
      if (pts.length < 2) continue;
      let len = 0;
      let p = map.latLngToContainerPoint(pts[0]);
      for (let i = 1; i < pts.length; i++) {
        const q = map.latLngToContainerPoint(pts[i]);
        len += clipLen(p.x, p.y, q.x, q.y, W, H);
        p = q;
      }
      if (len > 0.5) {
        n++;
        const ink = len * (((l.options && l.options.weight) || CORE_W) + 2);
        sum += ink;
        if (l.mnLinkRole === 'backbone') bb += ink;
      }
    }
    return { cov: sum / (W * H), bbCov: bb / (W * H), n };
  }
  // A new figure for what is on screen; applied (and the lines restyled, if
  // asked) only when it moved by more than AUTO_STEP. Held while the 3-D
  // view or the twin is up.
  function recomputeAuto(o = {}) {
    if (!C().auto) { S.autoOp = null; S.autoBb = null; S.autoN = 0; return false; }
    if (!S.map || !isFlat()) { paintReadouts(); return false; }
    const m = measure();
    if (!m) return false;
    S.autoN = m.n;
    const op = clamp(AUTO_TARGET / Math.max(m.cov, 1e-4), AUTO_MIN, AUTO_MAX);
    const bbOp = clamp(BB_TARGET / Math.max(m.bbCov, 1e-4), BB_AUTO_MIN, BB_AUTO_MAX);
    const moved = S.autoOp == null || Math.abs(op - S.autoOp) > AUTO_STEP
      || S.autoBb == null || Math.abs(bbOp - S.autoBb) > AUTO_STEP;
    if (moved) { S.autoOp = op; S.autoBb = bbOp; }
    paintReadouts();
    if (moved && o.restyle) restyle();
    return moved;
  }
  const autoValue = () => (C().auto ? S.autoOp : null);

  function onMove() {
    if (S.moveT) return;
    S.moveT = setTimeout(() => {
      S.moveT = null;
      if (!S.map) return;
      // The 3-D view or the twin came or went: the drawing's factor did too.
      const flat = isFlat();
      if (flat !== S.lastFlat) { restyle(); syncOverlays(); }
      // The legend says the figure too; repainted only when it moved.
      if (C().auto && flat && recomputeAuto({ restyle: true }) && typeof rerenderMapLegend === 'function') rerenderMapLegend();
    }, MOVE_SETTLE_MS);
  }

  // ── Balance (build spec §3.2) ─────────────────────────────────────────────

  function tileFilter(b) {
    if (!(b > 50)) return '';
    const g = Math.max(0, (b - 50) / 50) * 0.85;
    const br = 1 - Math.max(0, (b - 50) / 50) * 0.45;
    return `grayscale(${g.toFixed(3)}) brightness(${br.toFixed(3)})`;
  }
  function tilePane() {
    const map = S.map;
    return map && typeof map.getPane === 'function' ? map.getPane('tilePane') : null;
  }
  function applyTileFilter() {
    const pane = tilePane();
    const b = C().balance;
    if (pane) pane.style.filter = tileFilter(b);
    // The base maps' own roads and place names (map-controls.js draws them in
    // a pane of their own, over the tiles): greyed with the photo, and faded
    // as well, or the orange roads stay the loudest thing on the map.
    const labels = S.map && typeof S.map.getPane === 'function' ? S.map.getPane('mnBaseLabels') : null;
    if (labels) {
      labels.style.filter = tileFilter(b);
      labels.style.opacity = b > 50 ? String(+(1 - (b - 50) / 50 * 0.6).toFixed(3)) : '';
    }
  }
  // In words, not a bare number: which side is stronger and by how much.
  function balanceWords(b) {
    if (b === 50) return { short: 'Even', long: 'Even: the photo and the network as they are' };
    const side = b < 50 ? 'photo' : 'network';
    const d = Math.abs(b - 50);
    const how = d < 15 ? 'a little stronger' : d < 35 ? 'stronger' : 'much stronger';
    const short = `${side === 'photo' ? 'Photo' : 'Network'} ${how}`;
    return { short, long: `${short} (${b} of 100, where 50 is even)` };
  }

  // The two folds: open or shut, per device.
  function foldOpen(key) {
    try { const v = JSON.parse(localStorage.getItem(LS_OPEN) || '{}'); return !!(v && v[key]); } catch (_) { return false; }
  }
  function fold(key, open) {
    // Opened or shut by the find box (find, below) is not somebody's choice:
    // while it has words in it, and the shutting after (the toggle event
    // comes once the words have gone).
    if (S.find && S.find.length) return;
    const d = typeof document !== 'undefined' ? document.getElementById('mv-card-' + key) : null;
    if (d && d.hasAttribute('data-find-closing')) {
      d.removeAttribute('data-find-closing');
      // A browser can fold that close into the open before it and send no
      // event at all, so the mark can outlive it: only a close is the box's.
      if (!open) return;
    }
    try {
      const v = JSON.parse(localStorage.getItem(LS_OPEN) || '{}') || {};
      v[key] = !!open;
      localStorage.setItem(LS_OPEN, JSON.stringify(v));
    } catch (_) {}
  }
  const FOLD_PATHS = { every: 'Every path', best: 'Best path only', lod: 'Best path until zoomed in', bundle: 'Bundled into trunks', areas: 'Areas, no lines' };
  const FOLD_DRAW = { lines: 'Lines', flow: 'Flow', tails: 'Tails & spotlight' };

  // ── Knobs: what a view sets (build spec §7.3) ─────────────────────────────

  // The base map a mix leads with: the highest opacity among the ones
  // ticked, the upper one in the stack on a tie, a ticked one at 0 % only if
  // nothing else is ticked.
  function leadOf(mix, order) {
    if (!mix || typeof mix !== 'object') return null;
    const ord = Array.isArray(order) ? order : Object.keys(mix);
    let best = null, bestOp = -1, bestAt = -1;
    for (const [name, v] of Object.entries(mix)) {
      if (!v || typeof v !== 'object' || !v.on) continue;
      const op = Number(v.op) || 0, idx = ord.indexOf(name);
      if (op > bestOp || (op === bestOp && idx > bestAt)) { best = name; bestOp = op; bestAt = idx; }
    }
    return best;
  }
  const wantLead = w => (typeof w === 'string' ? w : w && typeof w === 'object' ? leadOf(w.mix, w.order) : null);

  function boolKnob(key, mod, fn, rebuild) {
    return {
      avail: () => has(mod(), fn),
      read: () => !!state[key],
      same: (a, b) => !!a === !!b,
      write: v => mod()[fn](!!v),
      rebuild: () => !!rebuild,
    };
  }
  // Each module behind its own typeof: a top-level const is not a property
  // of window, so it cannot be looked up by name.
  const MOD = {
    MapArrows: () => (typeof MapArrows !== 'undefined' ? MapArrows : null),
    HealthGlance: () => (typeof HealthGlance !== 'undefined' ? HealthGlance : null),
    MapSymbols: () => (typeof MapSymbols !== 'undefined' ? MapSymbols : null),
    MapRiverLines: () => (typeof MapRiverLines !== 'undefined' ? MapRiverLines : null),
    MapRain: () => (typeof MapRain !== 'undefined' ? MapRain : null),
    MapElevation: () => (typeof MapElevation !== 'undefined' ? MapElevation : null),
    MapCatchments: () => (typeof MapCatchments !== 'undefined' ? MapCatchments : null),
    MapLots: () => (typeof MapLots !== 'undefined' ? MapLots : null),
    MapRoads: () => (typeof MapRoads !== 'undefined' ? MapRoads : null),
    MapRoadOwners: () => (typeof MapRoadOwners !== 'undefined' ? MapRoadOwners : null),
    MapCouncils: () => (typeof MapCouncils !== 'undefined' ? MapCouncils : null),
    MapSurvey: () => (typeof MapSurvey !== 'undefined' ? MapSurvey : null),
    MapHubs: () => (typeof MapHubs !== 'undefined' ? MapHubs : null),
    MapWind: () => (typeof MapWind !== 'undefined' ? MapWind : null),
    MapCameras: () => (typeof MapCameras !== 'undefined' ? MapCameras : null),
    MapPhotos: () => (typeof MapPhotos !== 'undefined' ? MapPhotos : null),
    SiteFeatures: () => (typeof SiteFeatures !== 'undefined' ? SiteFeatures : null),
    MapTwin: () => (typeof MapTwin !== 'undefined' ? MapTwin : null),
  };
  const M = name => MOD[name];

  const KNOB = {
    base: {
      avail: () => { const m = mapNow(); return !!(m && m.mnBases && has(m.mnBases, 'mix') && has(m.mnBases, 'set')); },
      read: () => { const b = mapNow().mnBases; return leadOf(b.mix(), has(b, 'order') ? b.order() : null); },
      snap: () => { const b = mapNow().mnBases; return { mix: b.mix(), order: has(b, 'order') ? b.order() : null }; },
      same: (cur, want) => cur === wantLead(want),
      write: want => {
        const b = mapNow().mnBases;
        if (typeof want === 'string') b.set({ [want]: 1 });
        else if (want && want.mix) b.set(want.mix, want.order || undefined);
      },
      rebuild: () => false,
    },
    links: {
      avail: () => typeof state !== 'undefined',
      read: () => !!state.mapShowLinks,
      same: (a, b) => !!a === !!b,
      write: v => { state.mapShowLinks = !!v; },
      rebuild: () => true,
    },
    roles: {
      avail: () => typeof MapSymbols !== 'undefined' && has(MapSymbols, 'setRole') && state.mapRolesOff instanceof Set,
      read: () => { const o = {}; for (const r of ROLES) o[r] = !state.mapRolesOff.has(r); return o; },
      same: (a, b) => ROLES.every(r => (a[r] !== false) === (!b || b[r] !== false)),
      write: want => {
        // The ones going on first, so the map is never asked to draw nothing.
        const off = state.mapRolesOff;
        for (const r of ROLES) if (want[r] !== false && off.has(r)) MapSymbols.setRole(r, true);
        for (const r of ROLES) if (want[r] === false && !off.has(r)) MapSymbols.setRole(r, false);
      },
      rebuild: () => true,
    },
    backbone: {
      avail: () => typeof setMapBackbone === 'function',
      read: () => !!state.mapShowBackbone,
      same: (a, b) => !!a === !!b,
      write: v => setMapBackbone(!!v),
      rebuild: () => true,
    },
    arrows: boolKnob('mapArrows', M('MapArrows'), 'setEnabled'),
    colour: {
      avail: () => typeof setMapLinkColour === 'function',
      read: () => state.mapLinkColour || 'plain',
      same: (a, b) => a === b,
      write: v => setMapLinkColour(v),
      rebuild: () => true,
    },
    health: boolKnob('mapHealth', M('HealthGlance'), 'setPins', true),
    outlines: boolKnob('mapPinSls', M('MapSymbols'), 'setOutlines'),
    riverLines: boolKnob('mapRiverLines', M('MapRiverLines'), 'setEnabled'),
    riverCatchment: boolKnob('mapRiverCatchment', M('MapRiverLines'), 'setCatchment'),
    rain: boolKnob('mapRain', M('MapRain'), 'setEnabled'),
    elev: boolKnob('mapElev', M('MapElevation'), 'setEnabled'),
    catchments: boolKnob('mapCatchments', M('MapCatchments'), 'setEnabled'),
    lots: boolKnob('mapLots', M('MapLots'), 'setEnabled'),
    easements: boolKnob('mapEasements', M('MapLots'), 'setEasements'),
    tenure: boolKnob('mapTenure', M('MapLots'), 'setTenure'),
    roads: boolKnob('mapRoads', M('MapRoads'), 'setEnabled'),
    roadOwners: boolKnob('mapRoadOwners', M('MapRoadOwners'), 'setEnabled'),
    councils: boolKnob('mapCouncils', M('MapCouncils'), 'setEnabled'),
    survey: boolKnob('mapSurvey', M('MapSurvey'), 'setEnabled'),
    hubs: boolKnob('mapHubs', M('MapHubs'), 'setEnabled'),
    wind: boolKnob('mapWind', M('MapWind'), 'setEnabled'),
    cameras: boolKnob('mapCameras', M('MapCameras'), 'setEnabled'),
    photos: boolKnob('mapPhotos', M('MapPhotos'), 'setEnabled'),
    siteFeatures: boolKnob('mapSiteFeatures', M('SiteFeatures'), 'setEnabled'),
    twinOffer: boolKnob('mapTwinAuto', M('MapTwin'), 'setEnabled'),
    drawing: {
      avail: () => true,
      read: () => settings(),
      // What a view keeps: everything but Play/Pause, which is the person's.
      snap: () => {
        const c = C();
        return {
          paths: c.paths, draw: c.draw,
          flow: { mode: c.flow.mode, speed: c.flow.speed, under: c.flow.under },
          tails: { len: c.tails.len, spot: c.tails.spot, follow: c.tails.follow, backboneFull: c.tails.backboneFull },
          auto: c.auto, balance: c.balance,
        };
      },
      // Tolerant: Balance within BAL_TOL, and the sliders a view carries
      // (speed, tail length, …) are applied but never what makes a view not
      // in force — a nudge is not a different view.
      same: (cur, want) => {
        if (!want) return true;
        if (want.paths != null && cur.paths !== want.paths) return false;
        if (want.draw != null && cur.draw !== want.draw) return false;
        if (want.auto != null && !!cur.auto !== !!want.auto) return false;
        if (want.balance != null && Math.abs(cur.balance - want.balance) > BAL_TOL) return false;
        const draw = want.draw != null ? want.draw : cur.draw;
        if (draw === 'flow' && want.flow && want.flow.mode != null && cur.flow.mode !== want.flow.mode) return false;
        if (draw === 'tails' && want.tails && want.tails.follow != null && !!cur.tails.follow !== !!want.tails.follow) return false;
        return true;
      },
      write: want => set(want, { quiet: true }),
      rebuild: (cur, want) => !!(want && want.paths != null && want.paths !== cur.paths),
    },
  };
  // The order a view is applied in: the base map first (its tiles take the
  // longest), the stations and paths, the overlays, the drawing last — it
  // restyles the lines the knobs before it decided are drawn.
  const ORDER = ['base', 'roles', 'links', 'backbone', 'arrows', 'colour', 'health', 'outlines',
    ...LAYER_KNOBS, 'drawing'];
  const CADASTRE = ['lots', 'easements', 'tenure'];
  // Not remembered by their own switches: a reload puts them back to all
  // stations and the paths on. The picked view puts them back (attach).
  const SESSION_KNOBS = ['links', 'roles'];

  function knobSame(name, want) {
    const k = KNOB[name];
    if (!k || want == null || !safely(() => k.avail(), name)) return true;
    return !!safely(() => k.same(k.read(), want), name);
  }

  function snapshot() {
    const out = {};
    for (const name of ORDER) {
      const k = KNOB[name];
      if (!safely(() => k.avail(), name)) continue;
      const v = safely(() => (k.snap ? k.snap() : k.read()), name);
      if (v !== undefined) out[name] = v;
    }
    return out;
  }

  // Every knob that differs, each through its own setter, with the map's
  // rebuilds held and run once at the end. Returns how many were set.
  function applyKnobs(knobs) {
    const writes = [];
    for (const name of ORDER) {
      if (!knobs || !(name in knobs)) continue;
      const want = knobs[name];
      const k = KNOB[name];
      if (want == null || !safely(() => k.avail(), name)) continue;
      const cur = safely(() => k.read(), name);
      if (safely(() => k.same(cur, want), name)) continue;
      writes.push({ name, want, rebuild: !!safely(() => k.rebuild(cur, want), name) });
    }
    if (!writes.length) return 0;
    // The cadastre's switches going off first and the ones going on after:
    // the last of them is then one that turns something on, which is the one
    // that has MapLots fetch with every flag in place.
    const cad = writes.filter(w => CADASTRE.includes(w.name));
    const cadOrder = cad.filter(w => !w.want).concat(cad.filter(w => w.want));
    let ci = 0;
    const run = writes.map(w => (CADASTRE.includes(w.name) ? cadOrder[ci++] : w));
    S.lastWrites = run.map(w => w.name);   // for the checks

    const outer = holding();
    if (typeof state !== 'undefined') state.mapRefreshHold = true;
    try {
      for (const w of run) {
        if (w.rebuild) S.oweRefresh = true;
        safely(() => KNOB[w.name].write(w.want), `knob ${w.name}`);
      }
    } finally {
      if (typeof state !== 'undefined') state.mapRefreshHold = outer;
    }
    if (!outer) {
      // Owed by a knob that rebuilds, or by any setter that asked app.js for
      // a rebuild while the hold was on (refreshMapLayers records it).
      const st = typeof state !== 'undefined' ? state : {};
      const owe = S.oweRefresh || !!st.mapRefreshOwed;
      S.oweRefresh = false;
      st.mapRefreshOwed = false;
      if (owe && typeof refreshMapLayers === 'function') refreshMapLayers({ skipFit: true });
      if (typeof rerenderMapDisplayControls === 'function') rerenderMapDisplayControls();
      if (typeof rerenderMapLegend === 'function') rerenderMapLegend();
    }
    return writes.length;
  }

  // ── Views: built-in and kept ──────────────────────────────────────────────

  function cleanSaved(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const out = [];
    for (const v of list) {
      if (!v || typeof v !== 'object' || typeof v.id !== 'string' || !/^my-[a-z0-9]+$/.test(v.id) || seen.has(v.id)) continue;
      const name = String(v.name || '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
      if (!name || !v.knobs || typeof v.knobs !== 'object') continue;
      const knobs = {};
      for (const k of ORDER) if (k in v.knobs) knobs[k] = v.knobs[k];
      seen.add(v.id);
      out.push({ id: v.id, name, knobs });
      if (out.length >= MAX_SAVED) break;
    }
    return out;
  }
  function savedList() {
    if (!S.saved) {
      let raw = null;
      try { raw = JSON.parse(readLS(LS_SAVED) || '[]'); } catch (_) { raw = []; }
      S.saved = cleanSaved(raw);
    }
    return S.saved;
  }
  function storeSaved(list) {
    S.saved = list;
    writeLS(LS_SAVED, JSON.stringify(list));
  }
  const saved = () => copy(savedList());

  function pickNow() {
    if (S.pick === undefined) S.pick = readLS(LS_PICK) || null;
    return S.pick;
  }
  function setPick(id) {
    S.pick = id || null;
    writeLS(LS_PICK, S.pick);
  }

  function findView(id) {
    if (!id) return null;
    return VIEWS.find(v => v.id === id) || savedList().find(v => v.id === id) || null;
  }
  function viewMatches(v) {
    return !!v && Object.keys(v.knobs).every(name => knobSame(name, v.knobs[name]));
  }
  // The view the map is in now: the one last picked while it still holds,
  // else the first that does — built-in before kept — else null ("your own
  // mix").
  function active() {
    const p = findView(pickNow());
    if (p && viewMatches(p)) return p.id;
    for (const v of VIEWS) if (viewMatches(v)) return v.id;
    for (const v of savedList()) if (viewMatches(v)) return v.id;
    return null;
  }

  function apply(id) {
    const v = findView(id);
    if (!v) return false;
    const snap = snapshot();
    const before = pickNow();
    const n = applyKnobs(v.knobs);
    if (n) S.undo = { snap, pick: before };
    setPick(v.id);
    rerender();
    if (typeof announce === 'function') {
      announce(n ? `Map set to the view ${viewName(v)}. Put the map back undoes it.`
        : `The map is already set to the view ${viewName(v)}.`);
    }
    return true;
  }

  function undo() {
    if (!S.undo) return false;
    const { snap, pick } = S.undo;
    S.undo = null;
    applyKnobs(snap);
    setPick(pick);
    rerender();
    if (typeof announce === 'function') announce('The map is back as it was before the view.');
    return true;
  }

  // ── The view in the address (route.js) ──────────────────────────────────
  // 🔗 Share and the address bar carry the view on screen, so a link opens
  // the map the way the sender sees it (the owner, 8 Nov 2026: "make a
  // user's current view sharable"). A built-in view in force is its name,
  // `view=radio`; anything else is the whole mix in one short code:
  //
  //   view=m1.<switches>.<pins>.<colour>.<bases>.<drawing>
  //
  //   switches  a 1 or 0 for each of SHARE_SWITCHES, in its order (- for one
  //             this device cannot say). Append only: a link made before a
  //             switch was added says nothing about it, and leaves it alone.
  //   pins      the field, repeater and base pins, a 1 or 0 each
  //   colour    the link colouring (freq, fade or plain)
  //   bases     each base map, top first, as name*opacity % (0 is off), ! between
  //   drawing   which paths ~ drawn as ~ Flow's motion ~ speed % ~ Lines
  //             underneath % ~ tail px ~ spotlight px ~ spotlight follows ~
  //             backbone in full ~ auto-contrast ~ Balance
  //
  // Opening one applies it the way pressing a view does: what it changed is
  // kept for Put the map back, and a note says so (applyShared).
  const SHARE_V = 'm1';
  const SHARE_SWITCHES = ['links', 'backbone', 'arrows', 'health', 'outlines', 'riverLines', 'riverCatchment', 'rain',
    'elev', 'catchments', 'lots', 'easements', 'tenure', 'roads', 'roadOwners', 'councils', 'survey', 'hubs', 'wind',
    'cameras', 'photos', 'siteFeatures', 'twinOffer'];
  // A base map's name, with the code's own separators kept out of it.
  const shareName = n => encodeURIComponent(n).replace(/[.*!~]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  function shareCode() {
    const id = active();
    if (id && VIEWS.some(v => v.id === id)) return id;
    const s = snapshot();
    const bit = v => (v === undefined ? '-' : v ? '1' : '0');
    const sw = SHARE_SWITCHES.map(n => bit(s[n])).join('');
    const pins = s.roles ? ROLES.map(r => (s.roles[r] === false ? '0' : '1')).join('') : '-';
    const colour = /^[a-z]{1,12}$/.test(String(s.colour || '')) ? s.colour : '-';
    let bases = '-';
    const mix = s.base && s.base.mix;
    if (mix && typeof mix === 'object') {
      const names = (Array.isArray(s.base.order) ? s.base.order : []).filter(n => mix[n]);
      for (const n of Object.keys(mix)) if (!names.includes(n)) names.push(n);
      const parts = names.map(n => `${shareName(n)}*${mix[n] && mix[n].on ? Math.round(num(mix[n].op, 0, 1, 1) * 100) : 0}`);
      if (parts.length) bases = parts.join('!');
    }
    const d = s.drawing;
    const draw = d ? [d.paths, d.draw, d.flow.mode, Math.round(d.flow.speed * 100), Math.round(d.flow.under * 100),
      d.tails.len, d.tails.spot, d.tails.follow ? 1 : 0, d.tails.backboneFull ? 1 : 0, d.auto ? 1 : 0, d.balance].join('~') : '-';
    return [SHARE_V, sw, pins, colour, bases, draw].join('.');
  }
  // A code read back: { id } for a built-in view, { knobs } for a mix, or
  // null for anything that is neither. Each part is read on its own, and one
  // that does not read is left out rather than spoiling the rest.
  function parseShare(code) {
    const c = String(code || '');
    if (VIEWS.some(v => v.id === c)) return { id: c };
    const p = c.split('.');
    if (p.length !== 6 || p[0] !== SHARE_V) return null;
    const knobs = {};
    [...p[1]].forEach((ch, i) => {
      const n = SHARE_SWITCHES[i];
      if (n && (ch === '1' || ch === '0')) knobs[n] = ch === '1';
    });
    if (/^[01]{3}$/.test(p[2]) && p[2] !== '000') {
      knobs.roles = {};
      ROLES.forEach((r, i) => { knobs.roles[r] = p[2][i] === '1'; });
    }
    if (/^[a-z]{1,12}$/.test(p[3])) knobs.colour = p[3];
    if (p[4] !== '-') {
      const mix = {}, order = [];
      for (const e of p[4].split('!')) {
        const m = /^([^*]{1,60})\*(\d{1,3})$/.exec(e);
        if (!m) continue;
        let name;
        try { name = decodeURIComponent(m[1]); } catch (_) { continue; }
        // In the base maps' own form: on with its opacity, or off with the
        // opacity this device last gave it left alone.
        const pct = Math.min(100, Number(m[2]));
        mix[name] = pct > 0 ? { on: true, op: pct / 100 } : { on: false };
        order.push(name);
      }
      if (order.some(n => mix[n].on)) knobs.base = { mix, order };
    }
    const d = p[5].split('~');
    if (d.length === 11 && PATHS.includes(d[0]) && DRAWS.includes(d[1])) {
      knobs.drawing = {
        paths: d[0], draw: d[1],
        flow: { mode: d[2], speed: Number(d[3]) / 100, under: Number(d[4]) / 100 },
        tails: { len: Number(d[5]), spot: Number(d[6]), follow: d[7] === '1', backboneFull: d[8] === '1' },
        auto: d[9] === '1', balance: Number(d[10]),
      };
      // clean() keeps each one in range, and puts back the default for one
      // that is not a number or not a choice.
      knobs.drawing = (({ paths, draw, flow, tails, auto, balance }) => ({ paths, draw, flow: { mode: flow.mode, speed: flow.speed,
        under: flow.under }, tails, auto, balance }))(clean(knobs.drawing));
    }
    return Object.keys(knobs).length ? { knobs } : null;
  }
  // A view from a link (Route.afterLoad), applied as pressing one is, with
  // what it changed kept for Put the map back and a note to say so.
  // Returns whether it changed anything.
  function applyShared(code) {
    const want = parseShare(code);
    if (!want) return false;
    const v = want.id ? findView(want.id) : null;
    const snap = snapshot();
    const before = pickNow();
    const n = applyKnobs(v ? v.knobs : want.knobs);
    if (n) S.undo = { snap, pick: before };
    setPick(v ? v.id : active());
    rerender();
    if (n && typeof Toast !== 'undefined' && Toast.note) {
      Toast.note(`This link set the map to ${v ? `the view ${viewName(v)}` : 'the view it was sent from'}. `
        + '↶ Put the map back, at the top of 🗺️ Layers, undoes it.');
    }
    return n > 0;
  }

  function newId() {
    const ids = new Set(savedList().map(v => v.id));
    let id;
    do { id = `my-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`; } while (ids.has(id));
    return id;
  }

  function save(name) {
    const nm = String(name || '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
    const say = m => { if (typeof announce === 'function') announce(m); };
    if (!nm) {
      say('Give the view a name first.');
      const box = document.getElementById('mv-save-name');
      if (box) box.focus();
      return null;
    }
    const list = savedList().slice();
    const i = list.findIndex(v => v.name.toLowerCase() === nm.toLowerCase());
    if (i < 0 && list.length >= MAX_SAVED) {
      say(`You have ${MAX_SAVED} views kept already. Remove one to keep another.`);
      return null;
    }
    const knobs = snapshot();
    let v;
    if (i >= 0) { v = { id: list[i].id, name: nm, knobs }; list[i] = v; } else { v = { id: newId(), name: nm, knobs }; list.push(v); }
    storeSaved(list);
    setPick(v.id);
    rerender({ draft: false });
    say(i >= 0 ? `Your view ${nm} now keeps the map as it is.` : `Kept as ${nm}, under Your views.`);
    return v.id;
  }

  function remove(index) {
    const list = savedList().slice();
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= list.length) return false;
    const [gone] = list.splice(i, 1);
    storeSaved(list);
    if (pickNow() === gone.id) setPick(null);
    if (S.undo && S.undo.pick === gone.id) S.undo.pick = null;
    rerender();
    // Focus was on the ✕ that has just gone: the next kept view, or the box.
    const next = list[Math.min(i, list.length - 1)];
    const f = document.getElementById(next ? chipId(next.id) : 'mv-save-name');
    if (f) f.focus({ preventScroll: true });
    if (typeof announce === 'function') announce(`Removed your view ${gone.name}.`);
    return true;
  }

  // On a new visit, the picked view's two session-only knobs back as they
  // were — but only while the rest of it still holds: a person who has since
  // set the map their own way has left that view, and gets their own map.
  // Written straight into state: initMap's first build follows the attach.
  function resumePick() {
    const v = findView(pickNow());
    if (!v) { if (pickNow()) setPick(null); return; }
    const kept = Object.keys(v.knobs).filter(k => !SESSION_KNOBS.includes(k));
    if (!kept.every(k => knobSame(k, v.knobs[k]))) { setPick(null); return; }
    let changed = false;
    if ('links' in v.knobs && v.knobs.links != null && !!state.mapShowLinks !== !!v.knobs.links) {
      state.mapShowLinks = !!v.knobs.links;
      changed = true;
    }
    if (v.knobs.roles && state.mapRolesOff instanceof Set) {
      for (const r of ROLES) {
        const want = v.knobs.roles[r] !== false;
        if (want === state.mapRolesOff.has(r)) {
          if (want) state.mapRolesOff.delete(r); else state.mapRolesOff.add(r);
          changed = true;
        }
      }
    }
    if (!changed) return;
    // Pins already on the map mean the first build has been: build again.
    if (state.mapMarkers && state.mapMarkers.length && typeof refreshMapLayers === 'function') refreshMapLayers({ skipFit: true });
    if (typeof rerenderMapDisplayControls === 'function') rerenderMapDisplayControls();
    if (typeof rerenderMapLegend === 'function') rerenderMapLegend();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  function attach(map) {
    if (S.map && S.map !== map) detach();
    S.map = map || null;
    if (!S.map) return;
    C();
    applyTileFilter();
    presentChip();
    if (typeof document !== 'undefined') document.documentElement.toggleAttribute('data-presenting', presenting());
    if (typeof S.map.on === 'function') S.map.on('moveend zoomend resize', onMove);
    try {
      if (!S.mq && window.matchMedia) {
        S.mq = window.matchMedia('(prefers-reduced-motion: reduce)');
        if (typeof S.mq.addEventListener === 'function') S.mq.addEventListener('change', onMotionPref);
        else if (typeof S.mq.addListener === 'function') S.mq.addListener(onMotionPref);
      }
    } catch (_) { S.mq = null; }
    if (!S.sessionDone) {
      S.sessionDone = true;
      safely(resumePick, 'the picked view');
    }
    tickTurn();
  }

  function detach() {
    if (S.sync3d) { clearTimeout(S.sync3d); S.sync3d = null; }
    const map = S.map;
    if (map) {
      if (typeof map.off === 'function') map.off('moveend zoomend resize', onMove);
      const pane = tilePane();
      if (pane) pane.style.filter = '';
      const labels = typeof map.getPane === 'function' ? map.getPane('mnBaseLabels') : null;
      if (labels) { labels.style.filter = ''; labels.style.opacity = ''; }
    }
    if (S.mq) {
      try {
        if (typeof S.mq.removeEventListener === 'function') S.mq.removeEventListener('change', onMotionPref);
        else if (typeof S.mq.removeListener === 'function') S.mq.removeListener(onMotionPref);
      } catch (_) { /* gone with the page */ }
      S.mq = null;
    }
    clearTimeout(S.moveT); S.moveT = null;
    clearTimeout(S.turnT); S.turnT = null;
    S.map = null;
    S.root = null;
    S.hovered = null;
    S.hoveredGroup = null;
    S.autoN = 0;
  }

  // At the end of every refreshMapLayers, the early return included.
  function afterBuild() {
    // The address carries the view (route.js): a switch moved from anywhere
    // — the panel, Ctrl+K, a card — ends in a rebuild, and the address
    // follows it, so a link copied from the address bar is the map on screen.
    if (typeof Route !== 'undefined' && typeof Route.sync === 'function') safely(() => Route.sync(), 'Route.sync');
    if (C().auto) safely(() => recomputeAuto({ restyle: false }), 'auto-contrast');
    const T = modTails(), F = modFlow(), P = modPaths();
    if (has(T, 'rebuildIndex')) safely(() => T.rebuildIndex(), 'MapTails.rebuildIndex');
    restyle();
    if (has(F, 'sync')) safely(() => F.sync(), 'MapFlow.sync');
    if (has(T, 'sync')) safely(() => T.sync(), 'MapTails.sync');
    if (has(P, 'schedule')) safely(() => P.schedule(), 'MapPaths.schedule');
    paintReadouts();
    // The legend's Views rows follow the build (Best path until zoomed in
    // flipping at zoom 11, Show radio paths ticked off, a new auto figure):
    // repainted when what they say has changed, and only then.
    const said = safely(() => legendHtml(), 'legend') || '';
    if (said !== S.legendSaid) {
      S.legendSaid = said;
      if (!(typeof state !== 'undefined' && state.mapRefreshHold) && typeof rerenderMapLegend === 'function') rerenderMapLegend();
    }
  }

  // A pin under the pointer, or none: the spotlight's lit set and the
  // other paths' overlay follow it.
  function hover(id) {
    const next = id == null ? null : id;
    if (S.hovered === next) return;
    S.hovered = next;
    hoverFollow();
  }
  const hovered = () => S.hovered;

  // A bubble of grouped pins under the pointer (map-cluster.js), or none: its
  // stations are pointed at all at once, so what a pin's hover lights — its
  // paths under Tails, the paths Best path or bundling leave out — lights for
  // every station in it (the owner, 9 Nov 2026: "pop in the links for station
  // clusters in the same way we do for individual stations").
  function hoverGroup(ids) {
    const next = Array.isArray(ids) && ids.length ? ids.filter(id => id != null) : null;
    const was = S.hoveredGroup;
    if (was === next || (was && next && was.length === next.length && was.every((id, i) => id === next[i]))) return;
    S.hoveredGroup = next && next.length ? next : null;
    hoverFollow();
  }

  // Everything pointed at: the pin, then the bubble's stations. What
  // map-tails.js and map-paths.js light.
  function hoveredIds() {
    const out = [];
    if (S.hovered != null) out.push(S.hovered);
    if (S.hoveredGroup) for (const id of S.hoveredGroup) if (id !== S.hovered) out.push(id);
    return out;
  }

  function hoverFollow() {
    const c = C();
    const T = modTails(), P = modPaths();
    if (c.draw === 'tails' && has(T, 'sync')) safely(() => T.sync(), 'MapTails.sync');
    if (c.paths !== 'every' && has(P, 'schedule')) safely(() => P.schedule(), 'MapPaths.schedule');
  }

  // The station card's station, or the focused repeater, changed.
  function cardChanged() {
    const c = C();
    const T = modTails(), F = modFlow(), P = modPaths();
    if (c.draw === 'tails' && has(T, 'sync')) safely(() => T.sync(), 'MapTails.sync');
    if (c.draw === 'flow' && has(F, 'sync')) safely(() => F.sync(), 'MapFlow.sync');
    if (c.paths !== 'every' && has(P, 'schedule')) safely(() => P.schedule(), 'MapPaths.schedule');
  }

  // Play/Pause: the opposite of what the dashes are doing when it is pressed,
  // not of what they were doing when the button was drawn — the device's
  // reduced-motion setting can change in between.
  // ── Presenting (#279) ─────────────────────────────────────────────────────
  // A switch pressed by hand, for a screen shared on a call: what moves on
  // the map is held still and the 3-D view does less, until it is switched
  // off. Kept in state.presenting (core.js) and under mn-presenting; the
  // modules that move things read it (map-flow.js, map-3d.js), and this file
  // tells them when it changes, marks the page and puts a chip on the map.
  const presenting = () => !!(typeof state !== 'undefined' && state.presenting);
  function presentHtml() {
    return `<label class="filter-check mv-check mv-present" for="mv-present"
        title="${esc(WORDS.Presenting)}">
        <input type="checkbox" id="mv-present" ${presenting() ? 'checked' : ''}
          onchange="MapViews.setPresenting(this.checked)">
        <span>📽️ ${termHtml('Presenting', WORDS.Presenting)} — sharing this screen on a call</span>
      </label>`;
  }
  function presentChip() {
    const map = S.map;
    const box = map && typeof map.getContainer === 'function' ? map.getContainer() : null;
    if (!box) return;
    let chip = box.querySelector('.mv-present-chip');
    if (!presenting()) { if (chip) chip.remove(); return; }
    if (!chip) {
      chip = document.createElement('div');
      chip.className = 'mv-present-chip';
      chip.setAttribute('role', 'status');
      chip.innerHTML = `<span>📽️ Presenting: the map holds still</span>
        <button type="button" class="mv-present-off" onclick="MapViews.setPresenting(false)"
          title="Switch Presenting off: the dashes and the 3-D water move again">Turn off</button>`;
      // Clicks on the chip are its own, not the map's.
      if (typeof L !== 'undefined' && L.DomEvent) { L.DomEvent.disableClickPropagation(chip); L.DomEvent.disableScrollPropagation(chip); }
      box.appendChild(chip);
    }
  }
  function setPresenting(on) {
    const v = !!on;
    if (typeof state === 'undefined') return;
    state.presenting = v;
    try { localStorage.setItem('mn-presenting', v ? 'on' : 'off'); } catch (_) {}
    if (typeof document !== 'undefined') document.documentElement.toggleAttribute('data-presenting', v);
    const F = modFlow();
    if (has(F, 'sync')) safely(() => F.sync(), 'MapFlow.sync');
    if (typeof Map3D !== 'undefined' && typeof Map3D.presentingChanged === 'function') safely(() => Map3D.presentingChanged(), 'Map3D.presentingChanged');
    presentChip();
    rerender();
    if (typeof rerenderMapLegend === 'function') rerenderMapLegend();
    if (typeof announce === 'function') {
      announce(v ? 'Presenting is on: the dashes and the 3-D water hold still, and the 3-D view does less.'
        : 'Presenting is off: the map moves as it did.');
    }
  }

  function togglePlay() {
    return set({ flow: { playing: !playingNow(C()) } });
  }

  // The device asked for less motion, or stopped asking: with Play still
  // following it, the dashes stop or start (MapFlow listens too) and the
  // button has to say which.
  function onMotionPref() {
    const c = C();
    if (c.draw === 'flow' && c.flow.playing == null) soon();
  }

  // "Its turn now", read again while the repeaters take turns.
  function tickTurn() {
    clearTimeout(S.turnT);
    S.turnT = null;
    const c = C();
    if (!S.map || c.draw !== 'flow' || c.flow.mode !== 'turns') return;
    const el = document.getElementById('mv-turn');
    if (el) el.innerHTML = turnHtml();
    S.turnT = setTimeout(tickTurn, TURN_TICK_MS);
  }

  // ── The section (build spec §7.2) ─────────────────────────────────────────

  const chipId = id => `mv-chip-${id}`;
  const viewName = v => (v.label || v.name || '');

  function describe(k) {
    const bits = [];
    const lead = wantLead(k.base);
    if (lead) bits.push(`${lead} base map`);
    if (k.links === false) bits.push('no radio paths');
    else if (k.drawing) {
      bits.push(`${PATH_WORDS[k.drawing.paths] || PATH_WORDS.every}, drawn as ${DRAW_WORDS[k.drawing.draw] || DRAW_WORDS.lines}`);
    }
    const on = LAYER_KNOBS.filter(n => k[n] === true).map(n => LAYER_NAMES[n]);
    if (on.length) bits.push(`with ${on.join(', ')}`);
    return bits.join('; ');
  }
  const savedSay = v => `Your own view, kept on this device: ${describe(v.knobs) || 'the map as you set it'}.`;

  // ── The section: a card per job, a row per view (look picked 7 Nov 2026:
  // the role cards, with the compact list's quick settings opened under the
  // view in force) ──────────────────────────────────────────────────────────

  // One short line per view, under its name; the full sentence (`say`) is the
  // row's hover title.
  const LINES = {
    overview: 'The whole network, tidy', site: 'Photo, property lines, survey marks',
    radio: 'Tails that light up round the pointer', weak: 'Coloured by the signal to spare',
    backbone: 'Repeaters, bases and the paths between', traffic: 'Readings pulse in as they arrive',
    rivers: 'Rivers, basins, ground height', rain: 'Rain gauges as a heat map',
    property: 'Boundaries, easements, road owners', land: 'Parks, forests, State land, leases',
  };
  // A pictogram per job, drawn in the card's own colour (styles.css).
  const ROLE_ICON = {
    everyone: '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><circle cx="7" cy="6.5" r="2.6"/><circle cx="13.5" cy="7.2" r="2.2"/><path d="M2.5 16c.4-3 2.2-4.8 4.5-4.8S11.1 13 11.5 16zM11 16c.2-2.4 1.3-3.9 2.8-3.9s2.9 1.5 3.2 3.9z"/></svg>',
    tech: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M10 9v8M7 17h6"/><circle cx="10" cy="7.5" r="1.4" fill="currentColor"/><path d="M6.6 4.4a5 5 0 0 0 0 6.2M13.4 4.4a5 5 0 0 1 0 6.2M4.4 2.4a8 8 0 0 0 0 10.2M15.6 2.4a8 8 0 0 1 0 10.2"/></svg>',
    flood: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M2 8c2-1.6 4-1.6 6 0s4 1.6 6 0 3-1.2 4-.8M2 12c2-1.6 4-1.6 6 0s4 1.6 6 0 3-1.2 4-.8M2 16c2-1.6 4-1.6 6 0s4 1.6 6 0 3-1.2 4-.8"/></svg>',
    property: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M3 9.5 10 3.5l7 6V17H3z"/><path d="M8 17v-4.5h4V17"/></svg>',
    saved: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M5 3h10v14l-5-3.6L5 17z"/></svg>',
  };
  // A small picture of what each view shows: a ground (satellite, topographic,
  // light or dark), then what is drawn on it. A sketch, not a screenshot.
  function thumbHtml(id) {
    const G = {
      sat: '<rect width="72" height="48" fill="#3c3a2c"/><path d="M0 30 Q18 22 36 28 T72 24 V48 H0z" fill="#2f3a26"/><path d="M44 0 Q50 18 72 20 V0z" fill="#26301f"/>',
      topo: '<rect width="72" height="48" fill="#e9e4d3"/><path d="M8 40 Q20 28 34 34 T66 26M4 30 Q18 18 32 24 T70 14" fill="none" stroke="#c9bf9f" stroke-width=".8"/>',
      light: '<rect width="72" height="48" fill="#eef1f4"/>',
      dark: '<rect width="72" height="48" fill="#1d2630"/>',
    };
    const river = c => `<path d="M-2 34 C14 30 18 40 30 36 S48 22 74 26" fill="none" stroke="${c || '#3d8fe0'}" stroke-width="2"/>`;
    const pin = (x, y) => `<circle cx="${x}" cy="${y}" r="2.1" fill="#107c10" stroke="#fff" stroke-width=".9"/>`;
    const rpt = (x, y) => `<circle cx="${x}" cy="${y}" r="3" fill="#0b5cab" stroke="#fff" stroke-width="1.1"/>`;
    const ln = (a, b, c, w, o, d) => `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${c}" stroke-width="${w || 1}" opacity="${o || 1}"${d ? ` stroke-dasharray="${d}"` : ''}/>`;
    const R1 = [20, 14], R2 = [54, 30];
    const P = [[8, 30], [14, 40], [30, 22], [36, 40], [44, 12], [62, 10], [66, 40], [28, 6]];
    const near = p => (Math.hypot(p[0] - R1[0], p[1] - R1[1]) < Math.hypot(p[0] - R2[0], p[1] - R2[1]) ? R1 : R2);
    const BB = '#ffb703';
    let b;
    switch (id) {
      case 'overview': b = G.light + river() + P.map(p => ln(p, near(p), '#2979ff', 1, 0.7)).join('') + ln(R1, R2, BB, 2.2) + P.map(p => pin(...p)).join('') + rpt(...R1) + rpt(...R2); break;
      case 'site': b = G.sat + '<path d="M10 4V44M28 4V44M46 4V44M4 16H68M4 32H68" stroke="#fff" stroke-width=".6" opacity=".8"/><path d="M4 24H68" stroke="#fff" stroke-width=".7" stroke-dasharray="2 2"/>' + ln([36, 24], [44, 18], '#6aa6ff', 1.6) + ln([36, 24], [30, 30], '#6aa6ff', 1.6) + pin(36, 24) + '<rect x="50" y="36" width="4" height="4" fill="#f0bf3c"/>'; break;
      case 'radio': b = G.sat + river() + [[0, 6], [10, 44], [40, 46], [62, 2], [72, 22], [2, 26]].map(e => ln(R2, [R2[0] + (e[0] - R2[0]) * 0.22, R2[1] + (e[1] - R2[1]) * 0.22], '#6aa6ff', 1.6)).join('') + '<circle cx="28" cy="22" r="11" fill="#fff" fill-opacity=".08" stroke="#fff" stroke-width=".8"/>' + ln([26, 20], R2, '#6aa6ff', 1.6) + ln([30, 26], R2, '#c58cff', 1.6) + pin(26, 20) + pin(30, 26) + rpt(...R2); break;
      case 'weak': b = G.dark + ln([6, 8], R2, '#00e676', 1.2, 0.35) + ln([10, 40], R2, '#00e676', 1.2, 0.35) + ln([28, 4], R2, '#ffab00', 1.4, 0.8) + ln([4, 24], R2, '#e53935', 2.2) + ln([40, 46], R2, '#00e676', 1.2, 0.35) + rpt(...R2) + pin(4, 24) + pin(28, 4); break;
      case 'backbone': b = G.light + ln([10, 10], [36, 20], BB, 2.6) + ln([36, 20], [62, 12], BB, 2.6) + ln([36, 20], [52, 40], BB, 2.6) + ln([10, 10], [36, 20], '#fff6d0', 1.4, 1, '4 6') + rpt(10, 10) + rpt(36, 20) + rpt(52, 40) + '<rect x="58" y="8" width="7" height="7" fill="#c7401a" stroke="#fff"/>'; break;
      case 'traffic': b = G.dark + P.slice(0, 5).map(p => ln(p, R2, '#2979ff', 1, 0.3)).join('') + ln([8, 30], R2, '#ffe27a', 1.8, 0.8) + '<circle cx="36" cy="30" r="2.6" fill="#fff"/><circle cx="31" cy="30" r="1.8" fill="#ffe27a" opacity=".7"/>' + rpt(...R2) + pin(8, 30); break;
      case 'rivers': b = G.topo + '<path d="M6 6 C24 2 40 8 52 4 L66 18 C60 34 50 44 30 44 C14 42 6 30 6 6z" fill="#4fa3d9" fill-opacity=".18" stroke="#0b4f8a" stroke-width=".8"/>' + river('#1f6fd1') + '<path d="M30 36 L36 14" stroke="#1f6fd1" stroke-width="1.3"/>' + pin(20, 33) + pin(44, 27) + '<circle cx="44" cy="27" r="4" fill="none" stroke="#e05aa8" stroke-width="1"/>'; break;
      case 'rain': b = G.light + '<circle cx="22" cy="20" r="14" fill="#7c4dff" fill-opacity=".22"/><circle cx="26" cy="22" r="7" fill="#3a2ea8" fill-opacity=".35"/><circle cx="54" cy="32" r="10" fill="#2979ff" fill-opacity=".2"/>' + river('#1f6fd1') + pin(24, 21) + pin(54, 32) + pin(10, 38); break;
      case 'property': b = G.sat + '<path d="M4 10H68M4 26H68M4 40H68M14 4V44M34 4V44M54 4V44" stroke="#fff" stroke-width=".7"/><path d="M24 4V44" stroke="#fff" stroke-width=".8" stroke-dasharray="2 2"/><path d="M0 34 L72 20" stroke="#f9a825" stroke-width="1.6"/>' + pin(44, 16); break;
      case 'land': b = G.topo + '<rect x="4" y="4" width="30" height="20" fill="#2e8b3e" opacity=".45"/><rect x="38" y="26" width="30" height="18" fill="#1b7f79" opacity=".4"/><rect x="40" y="4" width="16" height="16" fill="#d6539b" opacity=".35"/><path d="M4 24H68M34 4V44M56 4V44" stroke="#555" stroke-width=".6"/>' + river('#1f6fd1'); break;
      default: b = G.light + P.slice(0, 4).map(p => ln(p, R2, '#2979ff', 1, 0.6)).join('') + rpt(...R2);
    }
    return `<span class="mv-thumb" aria-hidden="true"><svg viewBox="0 0 72 48" preserveAspectRatio="xMidYMid slice" focusable="false">${b}</svg></span>`;
  }

  // What a view turns on, as a few short tags.
  const BASE_WORDS = { Satellite: 'Satellite photo', 'OSM-Topo': 'Topographic map', Light: 'Light map', Dark: 'Dark map', OpenStreetMap: 'Street map' };
  const LAYER_WORDS = {
    riverLines: 'Rivers', riverCatchment: 'Catchment of a picked river', rain: 'Rain heat map', elev: 'Ground height',
    catchments: 'River basins', lots: 'Property lines', easements: 'Easements', tenure: 'Land tenure', roads: 'Road parcels',
    roadOwners: 'Road owners', councils: 'Council areas', survey: 'Survey marks', hubs: 'Maintenance hubs',
    wind: 'Wind regions', photos: 'Field photos', siteFeatures: 'Site features',
  };
  function tagsOf(v) {
    const k = (v && v.knobs) || {};
    const out = [];
    if (k.base && BASE_WORDS[k.base]) out.push(BASE_WORDS[k.base]);
    if (k.links) {
      const d = k.drawing || {};
      out.push(FOLD_PATHS[d.paths] || 'Every path');
      if (d.draw === 'flow') out.push(d.flow && d.flow.mode === 'live' ? 'Live readings' : 'Flow');
      else if (d.draw) out.push(FOLD_DRAW[d.draw] || '');
    } else if (k.roles && k.roles.field === false) out.push('Repeaters & bases only');
    else out.push('No radio paths');
    if (k.backbone) out.push('Backbone');
    if (k.colour === 'fade' && k.links) out.push('Fade margin colours');
    if (k.health) out.push('Health pins');
    if (k.arrows) out.push('Arrows');
    if (k.outlines) out.push('Forecast locations');
    for (const [key, word] of Object.entries(LAYER_WORDS)) if (k[key] === true) out.push(word);
    return out.filter(Boolean);
  }
  const tagsHtml = list => `<span class="mv-tags">${list.map(t => `<span class="mv-tag">${esc(t)}</span>`).join('')}</span>`;

  function rowHtml(v, act, open) {
    const title = v.say + (v.caution ? ` ${v.caution}` : '');
    return `<button type="button" class="mv-chip mv-row" id="${chipId(v.id)}" data-view="${esc(v.id)}"
        data-find="${esc(tagsOf(v).join(' '))}"
        aria-pressed="${act === v.id}" aria-controls="mv-open" title="${esc(title)}"
        onclick="MapViews.apply('${escAttr(v.id)}')">${thumbHtml(v.id)}<span class="mv-row-text"><b>${esc(v.label)}</b>
        <span class="mv-row-line">${esc(LINES[v.id] || '')}</span></span><span class="mv-tick" aria-hidden="true"></span></button>`;
  }
  function savedRowHtml(v, i, act, open) {
    return `<span class="mv-saved">
        <button type="button" class="mv-chip mv-chip--saved mv-row" id="${chipId(v.id)}" data-view="${esc(v.id)}"
          aria-pressed="${act === v.id}" aria-controls="mv-open" title="${esc(savedSay(v))}"
          onclick="MapViews.apply('${escAttr(v.id)}')">${thumbHtml('saved')}<span class="mv-row-text"><b>${esc(v.name)}</b>
          <span class="mv-row-line">Your own view</span></span><span class="mv-tick" aria-hidden="true"></span></button>
        <button type="button" class="mv-chip-x" aria-label="${esc(`Remove your view ${v.name}`)}"
          title="Remove this view" onclick="MapViews.remove(${i})">✕</button>
      </span>`;
  }

  // The quick settings, under all the views, for the view in force (or the
  // one last picked, marked as changed): its tags, then which paths, how they
  // are drawn and the Balance, each a row of buttons. The full set is in More drawing
  // settings, at the foot of the section.
  function segHtml(label, items, cur, key) {
    const id = `mv-q-${key}`;
    return `<div class="mv-q" role="group" aria-labelledby="${id}-h">
        <span class="mv-q-h" id="${id}-h">${label}</span>
        <span class="mv-seg">${items.map(([val, text, patch, title]) => `<button type="button" class="mv-seg-b" id="${id}-${val}"
            aria-pressed="${cur === val}"${title ? ` title="${esc(title)}"` : ''} onclick="MapViews.set(${patch})">${esc(text)}</button>`).join('')}</span>
      </div>`;
  }
  function quickHtml(c, v, act) {
    const links = typeof state === 'undefined' || state.mapShowLinks !== false;
    const changed = v && act !== v.id;
    const name = v ? (v.label || v.name) : null;
    const balNow = c.balance < 45 ? 'photo' : c.balance > 55 ? 'network' : 'even';
    const pathsNow = c.paths === 'lod' ? 'best' : c.paths;
    // In the colour of the view's group, so it is plain which row it is for.
    const role = v ? (VIEWS.includes(v) ? v.group : 'saved') : '';
    return `
    <div class="mv-open${role ? ` mv-role--${role}` : ''}" id="mv-open" role="group" aria-labelledby="mv-now">
      <p class="mv-now" id="mv-now">${v && !changed ? `Settings for <strong>${esc(name)}</strong>`
        : v ? `<strong>Your own mix</strong>, started from ${esc(name)}`
        : '<strong>Your own mix</strong> — no view matches the map as it is now'}</p>
      ${v && v.knobs ? tagsHtml(tagsOf(v)) : ''}
      ${links ? `
      ${segHtml('Which paths', [
        ['every', 'Every', "{paths:'every'}", 'Every radio path'],
        ['best', c.paths === 'lod' ? 'Best*' : 'Best', "{paths:'best'}", c.paths === 'lod' ? 'Best path until you zoom in (More drawing settings)' : WORDS['Best path']],
        ['bundle', 'Bundled', "{paths:'bundle'}", WORDS['Bundled into trunks']],
        ['areas', 'Areas', "{paths:'areas'}", WORDS.Areas]], pathsNow, 'paths')}
      ${segHtml('Draw them as', [
        ['lines', 'Lines', "{draw:'lines'}", 'Plain lines'],
        ['flow', 'Flow', "{draw:'flow'}", WORDS.Flow],
        ['tails', 'Tails', "{draw:'tails'}", WORDS.Tails]], c.draw, 'draw')}` : `
      <p class="filter-note mv-off-note">No radio paths in this view. Show radio paths, under Stations &amp; links, brings them back.</p>`}
      ${segHtml(termHtml('Balance', WORDS.Balance), [
        ['photo', 'Photo', '{balance:25}', 'The photo stronger, the lines fainter'],
        ['even', 'Even', '{balance:50}', 'The photo and the lines as they are'],
        ['network', 'Network', '{balance:75}', 'The photo greyed, the lines stronger']], balNow, 'balance')}
    </div>`;
  }

  function chipsHtml(act) {
    const shown = act || pickNow();
    const open = id => id === shown;
    const c = C();
    const shownView = findView(shown);
    // The quick settings stand under all the views, not under the one in
    // force: opened inside the list they moved every row below it, and it was
    // hard to keep your place in it (the owner, 8 Nov 2026).
    const groups = GROUPS.map(([g, label]) => {
      const rows = VIEWS.filter(v => v.group === g).map(v => rowHtml(v, act, open(v.id))).join('');
      return `
    <div class="mv-group mv-role mv-role--${g}" role="group" aria-labelledby="mv-g-${g}">
      <span class="mv-group-h mv-role-h" id="mv-g-${g}"><span class="mv-role-ic">${ROLE_ICON[g] || ''}</span>${esc(label)}</span>
      <div class="mv-chips mv-rows">${rows}</div>
    </div>`;
    }).join('');
    const mine = savedList();
    return `
    <div class="mv-groups">${groups}
    <div class="mv-group mv-role mv-role--saved mv-group--saved" role="group" aria-labelledby="mv-g-saved">
      <span class="mv-group-h mv-role-h" id="mv-g-saved"><span class="mv-role-ic">${ROLE_ICON.saved}</span>Your views</span>
      <div class="mv-chips mv-rows">${mine.length ? mine.map((v, i) => savedRowHtml(v, i, act, open(v.id))).join('')
        : '<span class="filter-note mv-none">None yet: set the map the way you like it, then keep it below.</span>'}</div>
    </div>
    </div>
    ${quickHtml(c, shownView, act)}`;
  }

  function nowHtml() {
    return S.undo ? `<button type="button" class="link-btn mv-undo" id="mv-undo" onclick="MapViews.undo()"
        title="Every switch the last view changed, back as it was before you picked it.">↶ Put the map back</button>` : '';
  }

  function radio(name, value, cur, labelHtml, handler) {
    const id = `mv-${name}-${value}`;
    return `<label class="mv-opt" for="${id}"><input type="radio" id="${id}" name="mv-${name}" value="${value}"
        ${cur === value ? 'checked' : ''} onchange="${handler}"> <span>${labelHtml}</span></label>`;
  }

  function rangeHtml({ id, label, value, min, max, step, read, aria, valuetext, key }) {
    const patch = key.includes('.') ? `{${key.split('.')[0]}:{${key.split('.')[1]}:+this.value}}` : `{${key}:+this.value}`;
    return `<label class="filter-range mv-range" for="${id}">
        <span>${label} <strong id="${id}-val" aria-hidden="true">${esc(read)}</strong></span>
        <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}"
          aria-label="${esc(aria)}" aria-valuetext="${esc(valuetext)}"
          oninput="MapViews.set(${patch},{live:true})" onchange="MapViews.set(${patch})">
      </label>`;
  }

  function turnHtml() {
    const F = modFlow();
    const t = has(F, 'turn') ? safely(() => F.turn(), 'MapFlow.turn') : null;
    if (!t || !t.name) return 'No repeater with paths on screen to take a turn — move or zoom the map.';
    const n = Number(t.n) || 0;
    const held = typeof state !== 'undefined' && state.mapFocusRepeaterId != null && state.mapFocusRepeaterId === t.repeaterId;
    return `Its turn now: <strong>${esc(t.name)}</strong>, ${n.toLocaleString()} path${n === 1 ? '' : 's'}`
      + `${held ? ' — held there while it is focused' : ''}.`;
  }

  // A word Flow's controls use, with Flow's own meaning on hover.
  function flowTerm(w) {
    const F = modFlow();
    const m = F && F.WORDS && F.WORDS[w];
    return m ? termHtml(w, m) : esc(w);
  }

  function flowHtml(c) {
    const playing = playingNow(c);
    const mode = c.flow.mode;
    const h = 'MapViews.set({flow:{mode:this.value}})';
    return `
    <div class="mv-sub" id="mv-flow-opts">
      <div class="mv-radios" role="radiogroup" aria-labelledby="mv-flowmode-h">
        <span class="mv-radios-h" id="mv-flowmode-h">What moves</span>
        ${radio('flowmode', 'all', mode, flowTerm('Everything flows'), h)}
        ${radio('flowmode', 'turns', mode, `Repeaters ${termHtml('take turns', WORDS['Take turns'])}`, h)}
        ${radio('flowmode', 'live', mode, termHtml('Live readings', WORDS['Live readings']), h)}
      </div>
      ${mode !== 'live' ? `${rangeHtml({
        id: 'mv-speed', label: flowTerm('Speed'), value: c.flow.speed, min: 0.3, max: 2.5, step: 0.1, key: 'flow.speed',
        read: `${c.flow.speed.toFixed(1)}×`, aria: 'How fast the dashes run',
        valuetext: `${c.flow.speed.toFixed(1)} times the usual speed` })}
      <div class="mv-ends" aria-hidden="true"><span>Calm</span><span>Busy</span></div>` : ''}
      ${rangeHtml({
        id: 'mv-under', label: flowTerm('Lines underneath'), value: c.flow.under, min: 0, max: 1, step: 0.05, key: 'flow.under',
        read: pct(c.flow.under), aria: 'How strong the lines under the dashes are',
        valuetext: `${Math.round(c.flow.under * 100)} per cent` })}
      ${mode !== 'live' ? (presenting() ? `<p class="filter-note mv-play-held" id="mv-play">Held still while
          ${termHtml('Presenting', WORDS.Presenting)} is on.</p>` : `<button type="button" class="mv-play" id="mv-play"
          onclick="MapViews.togglePlay()">${playing ? 'Pause the dashes' : 'Play the dashes'}</button>`) : ''}
      ${mode === 'turns' ? `<p class="filter-note mv-turn" id="mv-turn">${turnHtml()}</p>` : ''}
      ${mode === 'live' ? '<p class="filter-note">A pulse runs as each reading comes in, so the first may take a minute or two to show.</p>' : ''}
    </div>`;
  }

  function tailsHtml(c) {
    const touch = !hoverCapable();
    return `
    <div class="mv-sub" id="mv-tails-opts">
      ${rangeHtml({
        id: 'mv-len', label: 'Tail length', value: c.tails.len, min: 8, max: 70, step: 2, key: 'tails.len',
        read: `${c.tails.len} px`, aria: 'How long each tail is', valuetext: `${c.tails.len} pixels` })}
      ${rangeHtml({
        id: 'mv-spot', label: `${termHtml('Spotlight', WORDS.Spotlight)} size`, value: c.tails.spot, min: 60, max: 260,
        step: 10, key: 'tails.spot', read: `${c.tails.spot} px`, aria: 'How far round the pointer the spotlight reaches',
        valuetext: `${c.tails.spot} pixels` })}
      <label class="filter-check mv-check" for="mv-follow"
        title="${touch ? 'On a touch screen the spotlight stays where you tap the map.' : 'The spotlight moves with the mouse pointer over the map; untick it to keep only the paths of the station you point at.'}">
        <input type="checkbox" id="mv-follow" ${c.tails.follow ? 'checked' : ''}
          onchange="MapViews.set({tails:{follow:this.checked}})">
        Spotlight follows the pointer
      </label>
      <label class="filter-check mv-check" for="mv-bbfull"
        title="The backbone paths between repeaters and bases drawn whole all the time; untick it and they get tails too.">
        <input type="checkbox" id="mv-bbfull" ${c.tails.backboneFull ? 'checked' : ''}
          onchange="MapViews.set({tails:{backboneFull:this.checked}})">
        Backbone always in full
      </label>
    </div>`;
  }

  function pathsNoteText() {
    const P = modPaths();
    if (C().paths === 'every' || !has(P, 'noteText')) return '';
    return safely(() => P.noteText(), 'MapPaths.noteText') || '';
  }

  function pathsCardHtml(c) {
    const links = typeof state === 'undefined' || state.mapShowLinks !== false;
    const hp = 'MapViews.set({paths:this.value})';
    const hd = 'MapViews.set({draw:this.value})';
    const note = pathsNoteText();
    return `
    <div class="mv-part${links ? '' : ' is-off'}" id="mv-card-paths">
      <div class="mv-part-h">How the radio paths are drawn</div>
      ${links ? '' : `<p class="filter-note mv-off-note">The radio paths are switched off (Show radio paths, under
        Stations &amp; links), so these wait until they are on.</p>`}
      <div class="mv-radios" role="radiogroup" aria-labelledby="mv-paths-h">
        <span class="mv-radios-h" id="mv-paths-h">Which paths</span>
        ${radio('paths', 'every', c.paths, 'Every path', hp)}
        ${radio('paths', 'best', c.paths, termHtml('Best path only', WORDS['Best path']), hp)}
        ${radio('paths', 'lod', c.paths, `${termHtml('Best path', WORDS['Best path'])} until you zoom in`, hp)}
        ${radio('paths', 'bundle', c.paths, termHtml('Bundled into trunks', WORDS['Bundled into trunks']), hp)}
        ${radio('paths', 'areas', c.paths, `${termHtml('Areas', WORDS.Areas)}, no lines`, hp)}
      </div>
      <p class="filter-note mv-paths-note" id="mv-paths-note"${note ? '' : ' hidden'}>${esc(note)}</p>
      <div class="mv-radios" role="radiogroup" aria-labelledby="mv-draw-h">
        <span class="mv-radios-h" id="mv-draw-h">Draw them as</span>
        ${radio('draw', 'lines', c.draw, 'Lines', hd)}
        ${radio('draw', 'flow', c.draw, termHtml('Flow', WORDS.Flow), hd)}
        ${radio('draw', 'tails', c.draw, `${termHtml('Tails', WORDS.Tails)} &amp; spotlight`, hd)}
      </div>
      ${c.draw === 'flow' ? flowHtml(c) : ''}
      ${c.draw === 'tails' ? tailsHtml(c) : ''}
    </div>`;
  }

  function autoReadHtml() {
    const c = C();
    if (!c.auto) {
      // The figure the field lines are really drawn at: the Link opacity, times
      // the Balance, times Flow's Lines underneath — said only when it differs.
      const x = context();
      const why = [];
      if (c.balance !== 50) why.push('the Balance');
      if (x.flow) why.push('Flow\u2019s Lines underneath');
      const drawn = fullWith({ mnLinkRole: 'core' }, x) * (x.flow ? c.flow.under : 1);
      const lit = x.tails ? '; Tails draws them whole only where the spotlight or the pointer lights them' : '';
      return `Off: your Link opacity, ${pct(manualOp())}${why.length ? `, drawn at ${pct(drawn)} with ${why.join(' and ')}` : ''}${lit}.`;
    }
    const anyLines = typeof state !== 'undefined' && (state.mapShowLinks || state.mapShowBackbone);
    if (!anyLines) return 'Nothing to set: no radio paths are on the map.';
    if (S.autoOp == null) return 'Worked out once the map has paths on it.';
    if (S.map && !isFlat()) return `Held at ${pct(S.autoOp)} while the 3-D view is open.`;
    return `${pct(S.autoOp)} for ${S.autoN.toLocaleString()} line${S.autoN === 1 ? '' : 's'} on screen`;
  }

  function strengthCardHtml(c) {
    const bw = balanceWords(c.balance);
    return `
    <div class="mv-part" id="mv-card-strength">
      <div class="mv-part-h">Line strength</div>
      <label class="filter-check mv-check" for="mv-auto">
        <input type="checkbox" id="mv-auto" ${c.auto ? 'checked' : ''} onchange="MapViews.set({auto:this.checked})">
        ${termHtml('Auto-contrast', WORDS['Auto-contrast'])}
      </label>
      <p class="filter-note mv-auto-read" id="mv-auto-read">${autoReadHtml()}</p>
      ${rangeHtml({
        id: 'mv-balance', label: termHtml('Balance', WORDS.Balance), value: c.balance, min: 0, max: 100, step: 1,
        key: 'balance', read: bw.short, aria: 'Balance between the base map and the network', valuetext: bw.long })}
      <div class="mv-ends" aria-hidden="true"><span>Photo</span><span>Network</span></div>
    </div>`;
  }

  // Everything the quick settings leave out, in one fold that starts shut:
  // best path until zoomed in, what moves in Flow and how fast, the tails
  // and the spotlight, auto-contrast and the Balance slider.
  function moreHtml(c) {
    const bits = [FOLD_PATHS[c.paths], FOLD_DRAW[c.draw], c.auto ? 'Auto-contrast' : 'Your Link opacity'].filter(Boolean);
    return `
    <details class="mv-card mv-fold" id="mv-card-more"${foldOpen('more') ? ' open' : ''}
      ontoggle="MapViews.fold('more', this.open)">
      <summary class="mv-card-h">More drawing settings
        <span class="mv-fold-now">${esc(bits.join(' · '))}</span></summary>
      ${pathsCardHtml(c)}
      ${strengthCardHtml(c)}
    </details>`;
  }

  function saveHtml() {
    return `
    <form class="mv-save" onsubmit="event.preventDefault();MapViews.save(this.elements.mvname.value)">
      <label class="mv-save-label" for="mv-save-name">Keep this mix</label>
      <span class="mv-save-row">
        <input type="text" id="mv-save-name" name="mvname" class="mv-save-name" maxlength="${NAME_MAX}"
          placeholder="A name for it" autocomplete="off" aria-describedby="mv-save-note">
        <button type="submit" class="mv-save-btn">Save</button>
      </span>
      <p class="filter-note mv-save-note" id="mv-save-note">Kept on this device under Your views, up to ${MAX_SAVED}.
        Saving under a name you have used already updates that view.</p>
    </form>`;
  }

  // The section's words, then the ones the three drawing modules add in the
  // legend (a trunk, the other paths, drawn whole, …): hover never reaches a
  // finger, and the legend has no fold of its own, so they are read here.
  function allWords() {
    const out = Object.assign({}, WORDS);
    for (const mod of [modPaths(), modFlow(), modTails()]) {
      const w = mod && mod.WORDS;
      if (!w || typeof w !== 'object') continue;
      for (const [k, v] of Object.entries(w)) if (!(k in out) && typeof v === 'string' && v) out[k] = v;
    }
    return out;
  }

  function wordsHtml() {
    return `
    <details class="mv-words lat-words small">
      <summary>What the words in Views mean</summary>
      <dl>${Object.entries(allWords()).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    </details>`;
  }

  // ── Find a control, over Views too ───────────────────────────────────────
  // Layers' find box (app.js, applyMapDisplayFind) sits above Views and
  // filters it as it filters the switches below: every word typed has to be
  // somewhere in what an item says — its words, its hover words — or in the
  // names of what it is under (Views, the group, the fold), so "flood" is
  // the Flood views and "technicians weak" is Weak links. A view's row keeps
  // its quick settings with it, both ways round: "balance" is the view in
  // force with its settings. A fold with a match inside is opened while the
  // words are there, and shut again after, without being remembered; the
  // words fold shows only the meanings that match. Kept here because
  // rerender() rebuilds the block and puts the filter back. Returns how many
  // items are showing.
  function find(terms) {
    S.find = (Array.isArray(terms) ? terms : []).map(t => String(t).toLowerCase()).filter(Boolean);
    return applyFind();
  }
  function saysAll(els) {
    let out = '';
    for (const el of els) {
      if (!el) continue;
      out += ' ' + (el.textContent || '');
      if (el.title) out += ' ' + el.title;
      for (const n of el.querySelectorAll('[title]')) out += ' ' + n.title;
      for (const n of el.querySelectorAll('[aria-label]')) out += ' ' + n.getAttribute('aria-label');
      if (el.getAttribute && el.getAttribute('data-find')) out += ' ' + el.getAttribute('data-find');
    }
    return out.toLowerCase();
  }
  function findOpen(d, want) {
    if (!d) return;
    if (want && !d.open) { d.setAttribute('data-find-opened', ''); d.open = true; }
    else if (!want && d.hasAttribute('data-find-opened')) {
      d.removeAttribute('data-find-opened');
      d.setAttribute('data-find-closing', '');
      d.open = false;
    }
  }
  function applyFind() {
    const el = blockEl();
    if (!el || typeof el.querySelectorAll !== 'function') return 0;
    const T = S.find || [];
    const matches = text => !T.length || T.every(t => text.includes(t));
    const head = el.querySelector(':scope > .map-display-h');
    const top = 'views \n ';
    let shown = 0;
    const show = (els, on) => { for (const e of els) if (e) e.hidden = !on; if (on) shown++; return on; };
    // The switch and the notes at the top level: Presenting, Put the map
    // back, the quick settings when no view is in force, Keep this mix.
    for (const e of el.querySelectorAll(':scope > .mv-present, :scope > .mv-open, :scope > .mv-undo, :scope > .mv-save')) {
      show([e], matches(top + saysAll([e])));
    }
    // The groups: each row with the quick settings opened under it.
    const groups = [...el.querySelectorAll('.mv-groups > .mv-group')];
    for (const g of groups) {
      const name = saysAll([g.querySelector('.mv-group-h')]);
      const list = g.querySelector('.mv-rows');
      let any = false;
      if (list) {
        const kids = [...list.children];
        for (let i = 0; i < kids.length; i++) {
          const unit = [kids[i]];
          if (kids[i + 1] && kids[i + 1].classList.contains('mv-open')) unit.push(kids[++i]);
          if (show(unit, matches(top + name + ' \n ' + saysAll(unit)))) any = true;
        }
      }
      g.hidden = !any;
    }
    const box = el.querySelector('.mv-groups');
    if (box) box.hidden = groups.length > 0 && groups.every(g => g.hidden);
    // More drawing settings: the whole fold when its name matches, else the
    // parts in it that do, opened.
    const more = el.querySelector('#mv-card-more');
    if (more) {
      const sum = top + saysAll([more.querySelector('summary')]);
      const parts = [...more.querySelectorAll('.mv-part')];
      if (!T.length || matches(sum)) {
        for (const pt of parts) pt.hidden = false;
        more.hidden = false;
        findOpen(more, false);
        if (T.length) shown++;
      } else {
        let any = false;
        for (const pt of parts) if (show([pt], matches(sum + ' \n ' + saysAll([pt])))) any = true;
        more.hidden = !any;
        findOpen(more, any);
      }
    }
    // The words: the meanings that match, opened; all of them under the
    // fold's own name.
    const words = el.querySelector('details.mv-words');
    if (words) {
      const sum = top + saysAll([words.querySelector('summary')]);
      const dts = [...words.querySelectorAll('dt')];
      if (!T.length || matches(sum)) {
        for (const dt of dts) { dt.hidden = false; if (dt.nextElementSibling) dt.nextElementSibling.hidden = false; }
        words.hidden = false;
        findOpen(words, false);
        if (T.length) shown++;
      } else {
        let any = false;
        for (const dt of dts) {
          const dd = dt.nextElementSibling && dt.nextElementSibling.tagName === 'DD' ? dt.nextElementSibling : null;
          if (show([dt, dd], matches(top + saysAll([dt, dd])))) any = true;
        }
        words.hidden = !any;
        findOpen(words, any);
      }
    }
    if (head) head.hidden = T.length > 0 && shown === 0;
    el.hidden = T.length > 0 && shown === 0;
    return T.length ? shown : 0;
  }

  // What goes inside #map-views-block (app.js draws the block itself).
  function html() {
    const c = C();
    const act = active();
    return `
    <div class="map-display-h">Views</div>
    ${presentHtml()}
    ${chipsHtml(act)}
    ${nowHtml()}
    ${moreHtml(c)}
    ${saveHtml()}
    ${wordsHtml()}`;
  }

  function blockEl() {
    if (S.root && typeof S.root.querySelector === 'function') {
      const r = S.root.querySelector('#map-views-block');
      if (r) return r;
    }
    return typeof document !== 'undefined' ? document.getElementById('map-views-block') : null;
  }

  // Redrawn whole — it is small — with what a person was in the middle of
  // kept: the control they were on, a name half typed, the words fold open.
  function rerender(opts = {}) {
    const el = blockEl();
    if (!el) return;
    const a = document.activeElement;
    const inside = !!(a && el.contains(a));
    const focusId = inside && a.id ? a.id : null;
    const box = el.querySelector('#mv-save-name');
    const draft = opts.draft === false ? '' : (box ? box.value : '');
    const words = el.querySelector('details.mv-words');
    const open = !!(words && words.open && !words.hasAttribute('data-find-opened'));
    el.innerHTML = html();
    applyFind();
    // The address carries the view (route.js): it follows every change,
    // which all end here.
    if (typeof Route !== 'undefined' && typeof Route.sync === 'function') safely(() => Route.sync(), 'Route.sync');
    if (draft) { const b = el.querySelector('#mv-save-name'); if (b) b.value = draft; }
    if (open) { const d = el.querySelector('details.mv-words'); if (d) d.open = true; }
    if (inside) {
      const f = (focusId && document.getElementById(focusId))
        || el.querySelector('.mv-chip[aria-pressed="true"]') || el.querySelector('.mv-chip');
      if (f && el.contains(f)) f.focus({ preventScroll: true });
    }
  }
  function soon() {
    if (S.soonRaf) return;
    S.soonRaf = raf(() => { S.soonRaf = null; rerender(); });
  }
  // Any switch moved anywhere else in the panel may have made a view (or
  // none) the one in force: the chips are read again once it has settled.
  // Its own controls are left out (they redraw the section themselves, and
  // by the time the event gets here the control may be gone from the page,
  // so they are known by their mv- names).
  function onPanelChange(e) {
    const t = e && e.target;
    const el = blockEl();
    if (t && ((el && el.contains(t)) || /^mv/.test(String(t.id || '')) || /^mv/.test(String(t.name || '')))) return;
    soon();
  }

  function bind(root) {
    if (root && typeof root.addEventListener === 'function') {
      S.root = root;
      if (!BOUND.has(root)) { BOUND.add(root); root.addEventListener('change', onPanelChange); }
    }
    rerender();
  }

  // The figures in the section and the Link opacity row, repainted in place.
  function paintReadouts() {
    if (typeof document === 'undefined') return;
    const c = C();
    const txt = (id, s) => { const e = document.getElementById(id); if (e) e.textContent = s; };
    const vt = (id, s) => { const e = document.getElementById(id); if (e) e.setAttribute('aria-valuetext', s); };
    const auto = document.getElementById('mv-auto-read');
    if (auto) auto.innerHTML = autoReadHtml();
    const op = document.getElementById('mv-op-note');
    if (op) op.innerHTML = opNoteInner();
    const bw = balanceWords(c.balance);
    txt('mv-balance-val', bw.short); vt('mv-balance', bw.long);
    txt('mv-speed-val', `${c.flow.speed.toFixed(1)}×`); vt('mv-speed', `${c.flow.speed.toFixed(1)} times the usual speed`);
    txt('mv-under-val', pct(c.flow.under)); vt('mv-under', `${Math.round(c.flow.under * 100)} per cent`);
    txt('mv-len-val', `${c.tails.len} px`); vt('mv-len', `${c.tails.len} pixels`);
    txt('mv-spot-val', `${c.tails.spot} px`); vt('mv-spot', `${c.tails.spot} pixels`);
    const pn = document.getElementById('mv-paths-note');
    if (pn) { const s = pathsNoteText(); pn.textContent = s; pn.hidden = !s; }
    const tn = document.getElementById('mv-turn');
    if (tn) tn.innerHTML = turnHtml();
  }

  function opNoteInner() {
    const v = S.autoOp;
    return `${termHtml('Auto-contrast', WORDS['Auto-contrast'])} is setting this: ${v == null ? 'once the map has paths on it' : pct(v)}`;
  }
  // For the Link opacity row in Stations & links, while auto-contrast is on.
  function opacityNoteHtml() {
    if (!C().auto) return '';
    return `<p class="filter-note mv-op-note" id="mv-op-note">${opNoteInner()}</p>`;
  }

  // The legend's Links section: what the paths' drawing adds to it.
  function legendHtml() {
    if (typeof state === 'undefined' || (!state.mapShowLinks && !state.mapShowBackbone)) return '';
    const c = C();
    const out = [];
    const P = modPaths(), F = modFlow(), T = modTails();
    if (state.mapShowLinks && c.paths !== 'every' && has(P, 'legendHtml')) out.push(safely(() => P.legendHtml(), 'MapPaths.legendHtml') || '');
    if (c.draw === 'flow' && has(F, 'legendHtml')) out.push(safely(() => F.legendHtml(), 'MapFlow.legendHtml') || '');
    if (c.draw === 'tails' && has(T, 'legendHtml')) out.push(safely(() => T.legendHtml(), 'MapTails.legendHtml') || '');
    if (c.auto) {
      out.push(`
    <span class="legend-item">
      <span class="small">Line strength set by ${termHtml('Auto-contrast', WORDS['Auto-contrast'])}${S.autoOp != null
        ? `: ${pct(S.autoOp)} for what is on screen` : ''}</span>
    </span>`);
    }
    if (c.balance !== 50) {
      out.push(`
    <span class="legend-item">
      <span class="small">${termHtml('Balance', WORDS.Balance)} ${esc(balanceWords(c.balance).long)}${c.balance > 50
        ? ': the base map greyed so the network stands out' : ': the lines faded so the map shows through'}</span>
    </span>`);
    }
    return out.join('');
  }

  return {
    attach, detach, html, bind, rerender, settings, set, lineOpacity, fullOpacity, restyle, afterBuild, autoValue,
    hover, hovered, hoverGroup, hoveredIds, cardChanged, apply, undo, save, remove, active, snapshot, saved, legendHtml, opacityNoteHtml,
    togglePlay, fold, setPresenting, presenting, fromAddress, find, shareCode, parseShare, applyShared,
    VIEWS, WORDS, GROUPS,
    // What is in force, for the checks.
    _state: () => {
      const pane = tilePane();
      return {
        settings: settings(), autoOp: S.autoOp, autoN: S.autoN, pick: pickNow(), active: active(), lastWrites: S.lastWrites || [],
        canUndo: !!S.undo, saved: savedList().map(v => ({ id: v.id, name: v.name })), hovered: S.hovered,
        hoveredGroup: S.hoveredGroup ? S.hoveredGroup.slice() : null,
        attached: !!S.map, filter: pane ? pane.style.filter : null, flat: isFlat(),
      };
    },
  };
})();

if (typeof window !== 'undefined') window.MapViews = MapViews;
