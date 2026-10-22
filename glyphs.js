// MegaNet — glyphs.js
//
//   Glyphs   the pictograms the three looks in pictures draw with (looks.js:
//            🔲 Tiles, 🎚️ Instrument, 🪧 Signs) — one for every tab, every
//            group, every state a station can be in and every section of an
//            inspection sheet — and the colour each group wears.
//
// After core.js (TABS, esc), before calm-shell.js and home.js, which draw
// with it. Data and pure functions only: nothing runs at load
// (`npm run toplevel`).
//
// ── One hand ─────────────────────────────────────────────────────────────────
// Every drawing is on the same 24-unit grid, in a 2-unit stroke with round
// ends and joins, in currentColor — so one sits on a coloured tile in white,
// on Signs' yellow in black and in the ink of its text on a plain button, and
// is the same drawing in each. Calm's line drawings (CalmShell.ICONS) are the
// same idea at a thinner stroke; these are bolder and more literal, because
// in these looks the picture is read before the word is: a rain gauge is a
// cloud with rain under it, a repeater a mast throwing out its signal.
//
// The emoji in TABS stay what Classic and the Site Map wear; a picture here is
// for a tab's button and tile, and never its only name — every one is drawn
// beside its label or carries it as the button's own.
//
// ── Colour ───────────────────────────────────────────────────────────────────
// Six hues, one a family of groups, so a tile's colour says what kind of work
// it is before it is read: the network blue, data teal, a site visit orange,
// radio purple, learning amber, admin slate. Each is dark enough for white on
// it (4.5:1 and better), which is how Tiles draws them.
//
// Exposes: svg, has, tab, group, groupOf, section, tile, HUES, G, TAB, GROUP,
//          SECTION.

const Glyphs = (() => {
  // 24-unit drawings, stroked in currentColor (styles.css, .gl).
  const G = {
    // things in the network
    gauge:     '<path d="M9 3v14"/><path d="M9 5h3M9 8h2M9 11h3M9 14h2"/><path d="M3 19c1.5-1.3 3-1.3 4.5 0s3 1.3 4.5 0 3-1.3 4.5 0 3 1.3 4.5 0"/>',
    repeater:  '<path d="M12 9v12"/><path d="M8 21l4-12 4 12"/><path d="M9.6 16h4.8"/><circle cx="12" cy="7.5" r="1.2"/><path d="M8.6 4.6a5 5 0 0 1 6.8 0"/><path d="M6.2 2.4a8.4 8.4 0 0 1 11.6 0"/>',
    base:      '<path d="M4 21V11h12v10"/><path d="M2.5 21h19"/><path d="M8 21v-5h4v5"/><path d="M19 21V6"/><path d="M16.5 8.5a3.5 3.5 0 0 1 5 0"/><path d="M15 6a6 6 0 0 1 8 0"/>',
    // what they measure
    rain:      '<path d="M7 14a4 4 0 0 1 .4-8 5.5 5.5 0 0 1 10.3 1.7A3.3 3.3 0 0 1 17.6 14z"/><path d="M8 17.5l-1 2.5M12 17.5l-1 2.5M16 17.5l-1 2.5"/>',
    level:     '<path d="M12 3v9M8.5 6.5 12 3l3.5 3.5"/><path d="M3 16c1.5-1.3 3-1.3 4.5 0s3 1.3 4.5 0 3-1.3 4.5 0 3 1.3 4.5 0"/><path d="M3 20.5c1.5-1.3 3-1.3 4.5 0s3 1.3 4.5 0 3-1.3 4.5 0 3 1.3 4.5 0"/>',
    battery:   '<rect x="2.5" y="7" width="17" height="10" rx="2"/><path d="M22 10.5v3"/><path d="M6 10v4M9.5 10v4M13 10v4"/>',
    signal:    '<path d="M4 20v-3M9 20v-7M14 20v-11M19 20V4"/>',
    solar:     '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>',
    gas:       '<rect x="7" y="6.5" width="10" height="14.5" rx="4"/><path d="M10 6.5V3h4v3.5"/><path d="M8.5 3h7"/>',
    // how they are
    ok:        '<circle cx="12" cy="12" r="9"/><path d="m7.8 12.3 2.8 2.8 5.6-5.8"/>',
    late:      '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.4 2.1"/>',
    silent:    '<path d="M4 20v-3M9 20v-7M14 20v-4M19 20v-2"/><path d="M3 3l18 18"/>',
    fault:     '<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5"/><circle cx="12" cy="17.2" r=".4" fill="currentColor"/>',
    nodata:    '<circle cx="12" cy="12" r="9" stroke-dasharray="2.5 3"/><path d="M9 12h6"/>',
    // what you do
    home:      '<path d="M3 11 12 3.5l9 7.5"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5.5h4V20"/>',
    map:       '<path d="m3 6 6-2.5 6 2.5 6-2.5v14.5l-6 2.5-6-2.5-6 2.5z"/><path d="M9 3.5v14.5M15 6v14.5"/>',
    nearby:    '<circle cx="12" cy="12" r="2.5"/><circle cx="12" cy="12" r="7.5"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3"/>',
    look:      '<path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M12 17s-3.5-3-3.5-5.8a3.5 3.5 0 0 1 7 0C15.5 14 12 17 12 17z"/>',
    inspect:   '<rect x="5" y="4" width="14" height="17.5" rx="2"/><path d="M9 2.5h6v3H9z"/><path d="m8.5 13 2.4 2.4 4.6-4.8"/>',
    camera:    '<path d="M3 8.5A1.5 1.5 0 0 1 4.5 7H7l1.8-2.5h6.4L17 7h2.5A1.5 1.5 0 0 1 21 8.5V18a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z"/><circle cx="12" cy="13" r="3.6"/>',
    photos:    '<rect x="6" y="6" width="15" height="13" rx="1.5"/><path d="M3 16V4.5A1.5 1.5 0 0 1 4.5 3H18"/><path d="m6 16 4-4 3 3 2.5-2.5L21 18"/><circle cx="16.5" cy="9.5" r="1.3"/>',
    survey:    '<rect x="7" y="4" width="10" height="5" rx="1"/><path d="M17 6.5h3"/><path d="M12 9v3"/><path d="M12 12 6 21M12 12l6 9M12 12v9"/>',
    pegs:      '<path d="M6 21V8M18 21V8"/><path d="M4 8h4M16 8h4"/><path d="M6 13.5h12" stroke-dasharray="2 2.5"/>',
    staff:     '<rect x="9" y="2.5" width="6" height="19" rx="1"/><path d="M9 6h3M9 9.5h4M9 13h3M9 16.5h4"/>',
    interfere: '<path d="M8 21h8M12 21V11"/><circle cx="12" cy="9" r="1.5"/><path d="M7.5 13.5a6.5 6.5 0 0 1 0-9M16.5 4.5a6.5 6.5 0 0 1 0 9"/><path d="m19 2-2.2 3.5h2.8L17.4 9"/>',
    spectrum:  '<path d="M3 20.5h18"/><path d="M5 20.5V17M8 20.5v-9M11 20.5V14M14 20.5V5M17 20.5v-7M20 20.5V16"/>',
    trend:     '<path d="M3 18l5.5-5.5 4 3L20 8"/><path d="M15 8h5v5"/>',
    drive:     '<path d="M2.5 17v-3.5L5 8h9l3.5 5.5H21V17"/><circle cx="7" cy="17.5" r="2"/><circle cx="16.5" cy="17.5" r="2"/><path d="M16 2.5a5 5 0 0 1 5 5"/>',
    decode:    '<path d="M7 5H5v14h2M17 5h2v14h-2"/><path d="M9.5 9V15M12 9h2.5v6H12z"/>',
    flip:      '<path d="M4 8h14l-3.5-3.5"/><path d="M20 16H6l3.5 3.5"/>',
    graph:     '<circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="8" r="2.2"/><circle cx="9" cy="18" r="2.2"/><path d="M8.2 6.4 15.8 7.6M7 8l1.4 7.8M16.5 9.8l-6 6.6"/>',
    packet:    '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h2M11 10h2M15 10h2M7 14h10"/>',
    message:   '<path d="M4 4.5h16v11.5H9.5L4 20.5z"/><path d="M8 8.5h8M8 12h5"/>',
    plug:      '<path d="M9 2.5v4.5M15 2.5v4.5"/><path d="M6 7h12v3.5a6 6 0 0 1-12 0z"/><path d="M12 16.5v5"/>',
    launch:    '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    data:      '<rect x="3" y="3.5" width="18" height="17" rx="2"/><path d="m6.5 15.5 3.5-4.5 3 2.5 4.5-6"/>',
    inbox:     '<path d="M3 13.5 6 5h12l3 8.5V19a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M3 13.5h5l1.5 2.5h5l1.5-2.5h5"/>',
    health:    '<path d="M12 20.5s-8-4.6-8-10.4A4.4 4.4 0 0 1 12 7.4a4.4 4.4 0 0 1 8 2.7c0 5.8-8 10.4-8 10.4z"/><path d="M6.5 12.5h3l1.5-2.5 2 4 1.5-1.5h3"/>',
    tools:     '<path d="M14.5 6.5a4 4 0 0 0 5 5L12 19a2.1 2.1 0 0 1-3-3z"/><path d="m14.5 6.5 2.5-2.5"/>',
    history:   '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 3.5v5h5"/><path d="M12 7.5V12l3 2"/>',
    learn:     '<path d="m12 4 10 5-10 5L2 9z"/><path d="M6 11v5c3 2.5 9 2.5 12 0v-5"/><path d="M22 9v6"/>',
    bits:      '<rect x="3.5" y="5" width="7" height="14" rx="3.5"/><path d="M15.5 7.5 18 5v14"/><path d="M15.5 19h5"/>',
    bolt:      '<path d="M13.5 2.5 5 13.5h6.5l-1 8 8.5-11h-6.5z"/>',
    waves:     '<circle cx="5" cy="12" r="1.6"/><path d="M9 8a5.5 5.5 0 0 1 0 8M13 5a10 10 0 0 1 0 14M17 2.5a14 14 0 0 1 0 19"/>',
    book:      '<path d="M4 19V5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19a2 2 0 0 0 2 2h13"/><path d="M8 7.5h7"/>',
    logbook:   '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 3v18M12 8h4M12 12h4"/>',
    cycle:     '<path d="M20 12a8 8 0 0 1-14.2 5M4 12a8 8 0 0 1 14.2-5"/><path d="M18.5 3v4h-4M5.5 21v-4h4"/>',
    admin:     '<path d="M12 2.5 4 5.5v6c0 5 3.4 8.6 8 10 4.6-1.4 8-5 8-10v-6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
    review:    '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.8-4.8"/><path d="m7.8 10.6 2 2 3.6-3.8"/>',
    plan:      '<rect x="3" y="4.5" width="18" height="16.5" rx="2"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/><path d="m8.5 15 2.3 2.3 4.7-4.6"/>',
    slots:     '<rect x="3" y="7" width="18" height="10" rx="1.5"/><path d="M7.5 7v10M12 7v10M16.5 7v10"/>',
    download:  '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    print:     '<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/>',
    chain:     '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    route:     '<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8.5 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.5"/>',
    signpost:  '<path d="M12 2.5v19"/><path d="M5 5.5h11l3 2.75-3 2.75H5z"/><path d="M19 13.5H8l-3 2.75L8 19h11z"/>',
    sliders:   '<path d="M4 6h9M18 6h2M4 12h3M12 12h8M4 18h11M19 18h1"/><circle cx="15.5" cy="6" r="2"/><circle cx="9.5" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
    offline:   '<path d="M7 18a4.5 4.5 0 0 1 .5-9A5.5 5.5 0 0 1 18 10.5 3.8 3.8 0 0 1 17.5 18z"/><path d="m9.5 13.5 2 2 3.5-3.5"/>',
    pin:       '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
    tag:       '<path d="M3 12V4h8l10 10-7 7z"/><circle cx="7.5" cy="8" r="1.3"/>',
    flag:      '<path d="M5 21V3.5"/><path d="M5 4h12l-2.5 4L17 12H5"/>',
    directions:'<path d="m3 11 18-8-8 18-2-8z"/>',
    search:    '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.8-4.8"/>',
    user:      '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    sparkle:   '<path d="M12 3c.6 4.2 2.8 6.4 7 7-4.2.6-6.4 2.8-7 7-.6-4.2-2.8-6.4-7-7 4.2-.6 6.4-2.8 7-7z"/><path d="M19 15.5v4M17 17.5h4"/>',
    more:      '<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>',
  };

  // The six families' colours (styles.css draws them as --hue-<key>).
  const HUES = ['net', 'data', 'field', 'radio', 'learn', 'admin'];

  // Each of TABS' groups: its picture, and its family.
  const GROUP = {
    'Start here':          ['home',      'net'],
    'Stations & networks': ['repeater',  'net'],
    'Interference':        ['interfere', 'radio'],
    'ALERT':               ['decode',    'radio'],
    'Data':                ['data',      'data'],
    'Site visits':         ['inspect',   'field'],
    'Surveying':           ['survey',    'field'],
    'Field training':      ['staff',     'learn'],
    'Knowledge base':      ['learn',     'learn'],
    'Admin':               ['admin',     'admin'],
  };

  // Every tab's picture. A tab added to TABS without one here is drawn with
  // its group's (tab(), below), so a missing line is a plainer button, never
  // a blank one — and `npm run looks` lists any that are missing.
  const TAB = {
    home: 'home', sitemap: 'signpost', offline: 'offline', views: 'sliders',
    stations: 'map', maps: 'route', passranges: 'chain', export: 'download', mapgen: 'print', lookaround: 'look',
    rf: 'spectrum', rfchanges: 'trend', workbench: 'interfere', reception: 'drive', flipsources: 'search', bitbench: 'bits',
    bitflipper: 'flip', network: 'graph', packets: 'decode', alert2: 'packet', hfem: 'message', serial: 'plug',
    arro: 'launch', arrodata: 'data', field: 'level', msglog: 'inbox', health: 'health',
    nearby: 'nearby', inspections: 'inspect', maintenance: 'tools', history: 'history', camera: 'camera', photos: 'photos',
    levels: 'survey', twopeg: 'pegs', surveyguide: 'book',
    propagation: 'waves', biterrors: 'bolt', kbstaff: 'staff', kblogbook: 'logbook', kblifecycle: 'cycle', kblevel: 'solar', kbriver: 'gauge',
    admin: 'admin', basestations: 'base', review: 'review', a2plan: 'plan', tdma: 'slots',
  };

  // An inspection sheet's sections (0009's section_key), for the row of signs
  // a sheet is stepped through on a phone (inspections.js, stepHeadHtml).
  const SECTION = {
    station_details: 'pin', initial_data: 'data', battery: 'battery', power_supply: 'solar', radio: 'repeater',
    rain_gauge: 'rain', water_level: 'level', gas: 'gas', data_quality: 'ok', serial_numbers: 'tag',
    base_tests: 'base', final_data: 'flag', remarks: 'message', admin_checklist: 'inspect',
  };

  const has = name => Object.prototype.hasOwnProperty.call(G, name);

  function svg(name, cls = 'gl') {
    return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${G[name] || G.more}</svg>`;
  }

  // The TABS group a tab is filed under.
  function homeGroup(id) {
    const g = TABS.find(x => x.tabs.some(t => t.id === id));
    return g ? g.group : '';
  }

  // A group's [picture, family]: its own, or — for a view's group, which
  // Flood-Net has no picture for — the one of the group its first tab is
  // filed under, as Calm's bar does (calm-shell.js, groupIcon).
  function group(name, firstTabId) {
    return GROUP[name] || GROUP[homeGroup(firstTabId)] || ['more', 'admin'];
  }

  // The family a tab belongs to, by the group TABS files it under.
  const groupOf = id => group(homeGroup(id))[1];

  function tab(id) {
    return TAB[id] || group(homeGroup(id))[0];
  }

  const section = key => SECTION[key] || 'inspect';

  // A picture on a tile of its family's colour (styles.css, .gl-tile).
  function tile(name, hue, cls = '') {
    return `<span class="gl-tile${cls ? ' ' + cls : ''}" data-hue="${esc(hue)}">${svg(name)}</span>`;
  }

  return { svg, has, tab, group, groupOf, section, tile, HUES, G, TAB, GROUP, SECTION };
})();
if (typeof window !== 'undefined') window.Glyphs = Glyphs;
