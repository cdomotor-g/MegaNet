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
// fullOpacity, restyle, afterBuild, autoValue, hover, hovered, cardChanged,
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
  const AUTO_TARGET = 0.045;     // share of the screen auto-contrast aims to cover in solid line
  const AUTO_MIN = 0.12;         // …and the faintest and strongest it will go
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
    draw: 'lines',
    flow: { mode: 'all', speed: 1, under: 0.35, playing: null },
    tails: { len: 24, spot: 120, follow: true, backboneFull: true },
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
      + 'at a station, open its card or focus a repeater to see its other paths, dashed.',
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
    Balance: 'Which comes forward, the map underneath or the network on it. Toward Network the base map turns grey and darker '
      + '(up to 85 % grey) and the lines get up to half as strong again; toward Photo the map keeps its colours and the lines '
      + 'fade, to under half at the end.',
    Easement: 'A strip of a lot that someone other than its owner has a right to use — a council drain, a power line, a neighbour’s driveway. The land stays the owner’s. Drawn as a dashed white line under the property lines; a station card’s land details name the easements at that site.',
    'Land tenure': 'How the land is held: freehold (owned privately), leased from the State, or kept by the State as a national park, State forest, reserve or unallocated State land. Freehold is left clear; each other kind is a pale colour of its own, under the property lines (Queensland only).',
  };

  const GROUPS = [
    ['everyone', 'Everyone'],
    ['tech', 'Instrument technicians'],
    ['flood', 'Flood forecasters'],
    ['property', 'Property services'],
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
  const VIEWS = [
    {
      id: 'overview', group: 'everyone', label: 'Overview',
      say: 'The whole network at a glance: every station, one best path for each field station until you zoom in, and the '
        + 'lines kept readable on whatever base map you have.',
      knobs: {
        base: null, links: true, roles: ALL_ROLES, backbone: true, arrows: false, colour: 'freq', health: false,
        outlines: false, ...only('riverLines', 'cameras', 'photos', 'siteFeatures'),
        drawing: { paths: 'lod', draw: 'lines', auto: true, balance: 50 },
      },
    },
    {
      id: 'site', group: 'everyone', label: 'Site visit',
      say: 'For a visit to a site: the satellite photo with property lines, easements, roads and survey marks, the field '
        + 'photos and site features. Radio paths are short tails until you point at a station.',
      caution: 'Property lines, roads and survey marks are fetched once you zoom in close.',
      knobs: {
        base: 'Satellite', links: true, roles: ALL_ROLES, backbone: true, arrows: false, colour: 'freq', health: true,
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
        base: 'Satellite', links: true, roles: ALL_ROLES, backbone: true, arrows: true, colour: 'freq', health: true,
        outlines: false, ...only('hubs', 'riverLines', 'photos', 'siteFeatures', 'twinOffer'),
        drawing: { paths: 'every', draw: 'tails', tails: { follow: true }, auto: true, balance: 62 },
      },
    },
    {
      id: 'weak', group: 'tech', label: 'Weak links',
      say: 'Every path coloured by its fade margin — the signal it has to spare — on a greyed map, so the weak ones stand out.',
      caution: 'Works out the margin for each path that has none saved yet, which fetches the ground heights along it.',
      knobs: {
        base: null, links: true, roles: ALL_ROLES, backbone: true, arrows: false, colour: 'fade', health: false,
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
        drawing: { paths: 'every', draw: 'lines', auto: true, balance: 60 },
      },
    },
    {
      id: 'traffic', group: 'tech', label: 'Live traffic',
      say: 'Each field station\'s best path, faded, with a pulse running along it whenever one of its readings comes in.',
      caution: 'Asks the network for new readings every 15 seconds while it is on.',
      knobs: {
        base: null, links: true, roles: ALL_ROLES, backbone: true, arrows: false, colour: 'freq', health: true,
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
        + 'areas and survey marks. No radio paths.',
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
        + 'roads, council areas and river basins on a topographic map. No radio paths.',
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
    map: null,
    root: null,           // the Layers panel's body, from bind()
    autoOp: null,         // auto-contrast's last figure, or null
    autoN: 0,             // …and the lines on screen it was worked out from
    lastFlat: true,       // whether the last restyle saw the flat map (no 3-D, no twin)
    hovered: null,        // the station id under the pointer
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
  function clean(c) {
    const d = DEFAULTS;
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
    if (wrote) { writeLS(LS_DRAWING, JSON.stringify(next)); S.unsaved = false; }
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
      else { S.autoOp = null; S.autoN = 0; }
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

  // What every line in one pass shares, worked out once for the pass.
  function context() {
    const cfg = C();
    const flat = isFlat();
    const T = modTails();
    return {
      cfg, flat,
      base: cfg.auto && S.autoOp != null ? S.autoOp : manualOp(),
      bal: balMul(cfg.balance),
      mix: casingMix(),
      tails: flat && cfg.draw === 'tails' && has(T, 'isLit') ? T : null,
      flow: flat && cfg.draw === 'flow' && !!modFlow(),
    };
  }
  function fullWith(line, x) {
    const role = line && line.mnLinkRole;
    return clamp(x.base * x.bal * (CASING_ROLES.has(role) ? x.mix : 1), 0, 1);
  }
  function modeWith(line, x) {
    const role = line && line.mnLinkRole;
    const field = FIELD_ROLES.has(role), backbone = BACKBONE_ROLES.has(role);
    if (x.flow) {
      if (field) return x.cfg.flow.under;
      if (backbone) return Math.max(0.5, x.cfg.flow.under);
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
    return clamp(fullWith(line, x) * modeWith(line, x), 0, 1);
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
      const op = clamp(full * modeWith(l, x), 0, 1);
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
    let sum = 0, n = 0;
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
        sum += len * (((l.options && l.options.weight) || CORE_W) + 2);
      }
    }
    return { cov: sum / (W * H), n };
  }
  // A new figure for what is on screen; applied (and the lines restyled, if
  // asked) only when it moved by more than AUTO_STEP. Held while the 3-D
  // view or the twin is up.
  function recomputeAuto(o = {}) {
    if (!C().auto) { S.autoOp = null; S.autoN = 0; return false; }
    if (!S.map || !isFlat()) { paintReadouts(); return false; }
    const m = measure();
    if (!m) return false;
    S.autoN = m.n;
    const op = clamp(AUTO_TARGET / Math.max(m.cov, 1e-4), AUTO_MIN, AUTO_MAX);
    const moved = S.autoOp == null || Math.abs(op - S.autoOp) > AUTO_STEP;
    if (moved) S.autoOp = op;
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
    if (pane) pane.style.filter = tileFilter(C().balance);
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
    S.autoN = 0;
  }

  // At the end of every refreshMapLayers, the early return included.
  function afterBuild() {
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
    const c = C();
    const T = modTails(), P = modPaths();
    if (c.draw === 'tails' && has(T, 'sync')) safely(() => T.sync(), 'MapTails.sync');
    if (c.paths !== 'every' && has(P, 'schedule')) safely(() => P.schedule(), 'MapPaths.schedule');
  }
  const hovered = () => S.hovered;

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

  function chipHtml(v, act) {
    const title = v.say + (v.caution ? ` ${v.caution}` : '');
    return `<button type="button" class="mv-chip" id="${chipId(v.id)}" data-view="${esc(v.id)}"
        aria-pressed="${act === v.id}" title="${esc(title)}"
        onclick="MapViews.apply('${escAttr(v.id)}')">${esc(v.label)}</button>`;
  }
  function savedChipHtml(v, i, act) {
    return `<span class="mv-saved">
        <button type="button" class="mv-chip mv-chip--saved" id="${chipId(v.id)}" data-view="${esc(v.id)}"
          aria-pressed="${act === v.id}" title="${esc(savedSay(v))}"
          onclick="MapViews.apply('${escAttr(v.id)}')">${esc(v.name)}</button>
        <button type="button" class="mv-chip-x" aria-label="${esc(`Remove your view ${v.name}`)}"
          title="Remove this view" onclick="MapViews.remove(${i})">✕</button>
      </span>`;
  }

  function chipsHtml(act) {
    const groups = GROUPS.map(([g, label]) => `
    <div class="mv-group" role="group" aria-labelledby="mv-g-${g}">
      <span class="mv-group-h" id="mv-g-${g}">${esc(label)}</span>
      <div class="mv-chips">${VIEWS.filter(v => v.group === g).map(v => chipHtml(v, act)).join('')}</div>
    </div>`).join('');
    const mine = savedList();
    return `
    <p class="mv-ask" id="mv-ask">What are you here for? Pick a ${termHtml('view', WORDS.View)}.</p>
    <div class="mv-groups">${groups}
    <div class="mv-group mv-group--saved" role="group" aria-labelledby="mv-g-saved">
      <span class="mv-group-h" id="mv-g-saved">Your views</span>
      <div class="mv-chips">${mine.length ? mine.map((v, i) => savedChipHtml(v, i, act)).join('')
        : '<span class="filter-note mv-none">None yet: set the map the way you like it, then keep it below.</span>'}</div>
    </div>
    </div>`;
  }

  function nowHtml(act) {
    const v = findView(act);
    const line = !v
      ? '<strong>Your own mix</strong>: the map as you have set it — no view matches it as it is now.'
      : v.say ? `<strong>${esc(v.label)}</strong>: ${esc(v.say)}`
        : `<strong>${esc(v.name)}</strong>: ${esc(savedSay(v))}`;
    return `
    <p class="filter-note mv-now" id="mv-now">${line}</p>
    ${S.undo ? `<button type="button" class="link-btn mv-undo" id="mv-undo" onclick="MapViews.undo()"
        title="Every switch the last view changed, back as it was before you picked it.">Put the map back</button>` : ''}`;
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

  function flowHtml(c) {
    const playing = playingNow(c);
    const mode = c.flow.mode;
    const h = 'MapViews.set({flow:{mode:this.value}})';
    return `
    <div class="mv-sub" id="mv-flow-opts">
      <div class="mv-radios" role="radiogroup" aria-labelledby="mv-flowmode-h">
        <span class="mv-radios-h" id="mv-flowmode-h">What moves</span>
        ${radio('flowmode', 'all', mode, 'Everything flows', h)}
        ${radio('flowmode', 'turns', mode, `Repeaters ${termHtml('take turns', WORDS['Take turns'])}`, h)}
        ${radio('flowmode', 'live', mode, termHtml('Live readings', WORDS['Live readings']), h)}
      </div>
      ${mode !== 'live' ? `${rangeHtml({
        id: 'mv-speed', label: 'Speed', value: c.flow.speed, min: 0.3, max: 2.5, step: 0.1, key: 'flow.speed',
        read: `${c.flow.speed.toFixed(1)}×`, aria: 'How fast the dashes run',
        valuetext: `${c.flow.speed.toFixed(1)} times the usual speed` })}
      <div class="mv-ends" aria-hidden="true"><span>Calm</span><span>Busy</span></div>` : ''}
      ${rangeHtml({
        id: 'mv-under', label: 'Lines underneath', value: c.flow.under, min: 0, max: 1, step: 0.05, key: 'flow.under',
        read: pct(c.flow.under), aria: 'How strong the lines under the dashes are',
        valuetext: `${Math.round(c.flow.under * 100)} per cent` })}
      ${mode !== 'live' ? `<button type="button" class="mv-play" id="mv-play"
          onclick="MapViews.togglePlay()">${playing ? 'Pause the dashes' : 'Play the dashes'}</button>` : ''}
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
    <details class="mv-card mv-fold${links ? '' : ' is-off'}" id="mv-card-paths"${foldOpen('paths') ? ' open' : ''}
      ontoggle="MapViews.fold('paths', this.open)">
      <summary class="mv-card-h">How the radio paths are drawn
        <span class="mv-fold-now">${esc(FOLD_PATHS[c.paths] || '')} · ${esc(FOLD_DRAW[c.draw] || '')}</span></summary>
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
    </details>`;
  }

  function autoReadHtml() {
    const c = C();
    if (!c.auto) return `Off: the lines are drawn at your Link opacity, ${pct(manualOp())}.`;
    const anyLines = typeof state !== 'undefined' && (state.mapShowLinks || state.mapShowBackbone);
    if (!anyLines) return 'Nothing to set: no radio paths are on the map.';
    if (S.autoOp == null) return 'Worked out once the map has paths on it.';
    if (S.map && !isFlat()) return `Held at ${pct(S.autoOp)} while the 3-D view is open.`;
    return `${pct(S.autoOp)} for ${S.autoN.toLocaleString()} line${S.autoN === 1 ? '' : 's'} on screen`;
  }

  function strengthCardHtml(c) {
    const bw = balanceWords(c.balance);
    return `
    <details class="mv-card mv-fold" id="mv-card-strength"${foldOpen('strength') ? ' open' : ''}
      ontoggle="MapViews.fold('strength', this.open)">
      <summary class="mv-card-h">Line strength
        <span class="mv-fold-now">${c.auto ? 'Auto-contrast' : 'Your Link opacity'} · Balance ${esc(bw.short.toLowerCase())}</span></summary>
      <label class="filter-check mv-check" for="mv-auto">
        <input type="checkbox" id="mv-auto" ${c.auto ? 'checked' : ''} onchange="MapViews.set({auto:this.checked})">
        ${termHtml('Auto-contrast', WORDS['Auto-contrast'])}
      </label>
      <p class="filter-note mv-auto-read" id="mv-auto-read">${autoReadHtml()}</p>
      ${rangeHtml({
        id: 'mv-balance', label: termHtml('Balance', WORDS.Balance), value: c.balance, min: 0, max: 100, step: 1,
        key: 'balance', read: bw.short, aria: 'Balance between the base map and the network', valuetext: bw.long })}
      <div class="mv-ends" aria-hidden="true"><span>Photo</span><span>Network</span></div>
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

  // What goes inside #map-views-block (app.js draws the block itself).
  function html() {
    const c = C();
    const act = active();
    return `
    <div class="map-display-h">Views</div>
    ${chipsHtml(act)}
    ${nowHtml(act)}
    ${pathsCardHtml(c)}
    ${strengthCardHtml(c)}
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
    const open = !!(words && words.open);
    el.innerHTML = html();
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
    hover, hovered, cardChanged, apply, undo, save, remove, active, snapshot, saved, legendHtml, opacityNoteHtml,
    togglePlay, fold,
    VIEWS, WORDS, GROUPS,
    // What is in force, for the checks.
    _state: () => {
      const pane = tilePane();
      return {
        settings: settings(), autoOp: S.autoOp, autoN: S.autoN, pick: pickNow(), active: active(),
        canUndo: !!S.undo, saved: savedList().map(v => ({ id: v.id, name: v.name })), hovered: S.hovered,
        attached: !!S.map, filter: pane ? pane.style.filter : null, flat: isFlat(),
      };
    },
  };
})();

if (typeof window !== 'undefined') window.MapViews = MapViews;
