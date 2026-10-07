// MegaNet — site-map.js
//
//   SiteMap   the Site Map tab: a guide to every other tab, for somebody who has
//             not met them yet — how the screen is laid out, the groups the
//             tabs are filed under and the order the work moves through them,
//             everyday jobs with the tab each is done on, and a card per tab
//             saying what it is for and when to reach for it. And the gold
//             leader that runs from any of those to the tab's own button in the
//             bar on the left, so the guide teaches where things are as well as
//             what they do.
//
// After core.js (TABS, TAB_LIST, HELP, esc, slug, registerTabTeardown) and
// app.js (switchTab, focusNavFind, setHelpCollapsed); before init.js. Nothing
// here runs at load: renderMain() calls render() and init().
//
// ── What it says, and where that comes from ──────────────────────────────────
//
// The tabs, their groups, their icons and their order are TABS — read, never
// restated, so a tab added to the nav is on this page the moment it is added.
// What each one is *for* is GUIDE below: a sentence and two or three jobs,
// written for this page. HELP is the manual, and its summaries run to a
// paragraph or, for Stations, a page; a newcomer scanning twenty-six cards needs
// the first line of the manual, not all of it. A tab with no GUIDE entry still
// gets a card — the first sentence of its HELP summary, marked data-fallback —
// and `npm run nav` fails on that mark, so the gap is noticed rather than
// shipped.
//
// "Goes with" on each card is HELP[id].related: the app's own statement, written
// a tab at a time, of which tabs belong beside which (core.js says how the nav's
// groups were cut from the same graph).
//
// ── The leader ───────────────────────────────────────────────────────────────
//
// The same idea as the station card's line to its pin (map-leader.js), and the
// same gilt — cased in near-black, a pale line down the middle — so it reads as
// the app's one way of saying "this, there". Anything on the page carrying
// data-sm-point is a source: pointed at, or holding focus, a line runs from it
// to a ring round its target in the shell. The target is named, not stored:
//
//   tab:<id>       that tab's button in the nav (found by its data-tab)
//   group:<slug>   a whole group in the nav, heading and all
//   nav / find     the nav itself, or its find box (🔎 on the icon rail)
//   dock / banner  ❔ in the side panel's strip, the banner's buttons
//
// …and re-found every frame while a line is up, because the shell under it is
// not still: renderTabs() rewrites the nav's markup on a collapse, the nav and
// the page scroll independently, and the nav's width slides. One svg, fixed over
// the window, in client pixels; a requestAnimationFrame loop that only touches
// the DOM when a number has moved, and only runs while something is pointed at.
//
// Where the target is not on screen the line says where it went instead: a nav
// put away behind ☰ on a phone gets the line at ☰, and a button scrolled out
// of the nav's own scroller is scrolled into it. A tab hidden by the nav's find
// box gets no line rather than a wrong one.

const SiteMap = (function () {
  // ── What each tab is for ───────────────────────────────────────────────────
  // what: one sentence. use: the jobs somebody would come to it for. note: the
  // one thing about access worth knowing before you go. Plain text; escaped.
  const GUIDE = {
    stations: {
      what: 'The whole network on one map, with the station list, its filters and every station\'s details in the side panel beside it.',
      use: [
        'Find a station by name, number or ALERT address and see where it stands',
        'Draw a line between two sites for its elevation profile and link budget',
        'Tilt the map into 3-D, or open a station\'s digital twin from close in',
        'Edit a station\'s record, or propose a new site (sign in first)',
      ],
    },
    maps: {
      what: 'The printed radio-path PDF map sheets, browsed by region.',
      use: [
        'Click a basin on the Queensland drawing to list its sheets',
        'Type a station name or address to find the sheet it is on',
      ],
    },
    passranges: {
      what: 'Which repeaters pass each station\'s ALERT addresses on, and the hop chain from field to base.',
      use: [
        'Trace field → repeater → base for any station',
        'Find orphans — stations no repeater covers — and gaps between address windows',
      ],
    },
    export: {
      what: 'Builds the set of CSV files Radio Mobile needs, for the networks you tick.',
      use: [
        'Model a network\'s coverage in Radio Mobile',
        'Export just the networks you are planning, not the whole file',
      ],
    },
    mapgen: {
      what: 'Composes a true-to-scale map sheet — stations, rivers, contours, a title block — to print or laser-cut.',
      use: [
        'Print an A4 map for a field trip, or save it as PDF or SVG',
        'Cut stacked terrain layers on a K40 laser',
      ],
    },
    rf: {
      what: 'Licensed transmitters near each repeater, out of the ACMA register, ranked by how likely they are to step on it.',
      use: [
        'See every licensed carrier around a repeater\'s receive channel',
        'Test whether corrupted readings cluster in business hours',
      ],
    },
    rfchanges: {
      what: 'What changed on the air, and when, according to the ACMA register.',
      use: [
        'Line a station going bad up against a new licence appearing near it',
        'Paste corruption counts to chart them against the changes',
      ],
    },
    workbench: {
      what: 'Works one interference case end to end: the candidates, the competing explanations and the next thing to check.',
      use: [
        'Score five explanations side by side for the stations affected',
        'Decide what to look at on the next site visit',
      ],
    },
    reception: {
      what: 'What the receivers heard, where, and how strongly — and which transmitter is sending bad copies.',
      use: [
        'Map a drive survey\'s signal strength',
        'Compare a candidate repeater or base site against what the network hears',
        'Find the repeater that flips bits in what it relays',
      ],
    },
    bitflipper: {
      what: 'What else could this ALERT address have been? Every variant one or more bit-flips away, checked against the station file.',
      use: [
        'Explain a reading that arrived on an address nobody owns',
        'Open it straight from a sensor row\'s Flip link in the station editor',
      ],
    },
    network: {
      what: 'The Bit Flipper\'s question for the whole network at once: addresses as nodes, ghosting between them as lines.',
      use: [
        'Spot clusters of addresses that can ghost onto each other',
        'Check an address is clear before giving it to a new sensor',
      ],
    },
    packets: {
      what: 'Decodes and encodes ALERT and ERTS messages against the Bureau\'s specification, bit by bit.',
      use: [
        'Paste a frame or hex and see every field coloured in',
        'Check the CRC and check bits of a suspect message',
      ],
    },
    alert2: {
      what: 'Decodes what an ELPRO ERT-A2 puts out on its serial ports.',
      use: [
        'Paste or drop a capture and read each frame',
        'Watch a PuTTY log as it grows',
      ],
    },
    hfem: {
      what: 'Decodes the Bureau\'s Hydro Field Event Message lines a logger sends when a sensor trips.',
      use: [
        'Paste one message or a whole capture to decode it',
        'Build a message to test a logger with',
      ],
    },
    serial: {
      what: 'Live receivers in the browser: radios, ERT-A2s and RTL-SDR sticks over USB or a serial port.',
      use: [
        'Decode ALERT off the air with an RTL-SDR stick',
        'Turn a Quansheng radio into a live ALERT dashboard',
        'Follow PuTTY\'s log where the browser cannot open the port',
      ],
    },
    arro: {
      what: 'Opens a station\'s page in ARRO (Contrail), where its telemetry lives.',
      use: [
        'Jump to a station\'s telemetry by name, number or raw id',
      ],
    },
    arrodata: {
      what: 'Charts ARRO\'s sensor CSV exports in the browser, with the Bureau\'s 3-5-7 continuity filter.',
      use: [
        'Drop in a sensor CSV to chart it — nothing is uploaded',
        'Find noise and drop-outs the filter would remove',
      ],
    },
    field: {
      what: 'Charts the readings stations sent to the Flood-Net datastore, with the same chart and filter as ARRO Data.',
      use: [
        'Plot a station\'s rainfall or river level over any window',
        'Put a station\'s sensors side by side',
      ],
    },
    msglog: {
      what: 'Every message the datastore accepted, newest first: who sent it, the raw value and the way it came in.',
      use: [
        'Wait for a test transmission to land (Follow re-checks every 30 s)',
        'Trace the pathway a reading took to get here',
        'See a raw count worked out in volts or millimetres',
      ],
    },
    health: {
      what: 'What the readings say about each station and the network carrying them, ranked by what needs doing.',
      use: [
        'Start the day with the "needs attention" list',
        'Look into silent stations, sliding batteries or blocked gauges',
        'Ask Claude to investigate and write the briefing',
      ],
    },
    inspections: {
      what: 'The six paper inspection sheets as one form, shaped by each station\'s configuration.',
      use: [
        'Fill in an inspection on a tablet at site — drafts keep on the device with no signal',
        'Record calibrations, readings and photos as you go',
      ],
    },
    maintenance: {
      what: 'The council maintenance tasks sheet: who owns a site, what condition it is in and who to ring.',
      use: [
        'Record a site\'s condition, access and vegetation',
        'Find the owner and the council contact',
      ],
    },
    history: {
      what: 'Every past inspection and maintenance form, read back the way the paper sheet is laid out.',
      use: [
        'Check what was done on the last visit before you go',
        'Print a record to A4 or export them as CSV',
      ],
      note: 'Sign in to read the records.',
    },
    photos: {
      what: 'Photos from the field, filed by where they were taken — from the camera\'s GPS, or read off the picture.',
      use: [
        'Drop in a handful, a folder or a zip after a trip',
        'See each one as a pin on the map and in a station\'s digital twin',
      ],
    },
    admin: {
      what: 'Where the station data comes from, and the housekeeping around it.',
      use: [
        'Load the station list from a file, GitHub or the datastore',
        'See which source is on screen, and take a snapshot',
        'Administrators: users, the sign-in allowlist and the dashboard',
      ],
    },
    basestations: {
      what: 'Every base station and ingest point: whether it is checking in, its receivers and uplink, and what needs a look.',
      use: [
        'Check a base station\'s health without going to site',
        'Change a setting, restart it or install an update remotely',
      ],
      note: 'Administrators only.',
    },
  };

  // ── The groups, in the order the work moves through them ──────────────────
  // Keyed by TABS' own headings. core.js orders the groups "outward from the
  // file you loaded — what is out there, what is interfering with it, what it
  // actually transmitted, what the sensors said, and what we did about it on
  // site"; `step` is that sentence, cut at the commas.
  const GROUPS = {
    'Stations & networks': { step: 'What is out there',
      blurb: 'The stations themselves, the radio paths between them, and the maps and files made from them. Most days start here.' },
    'Interference': { step: 'What is stepping on it',
      blurb: 'For readings that go bad with nothing wrong on site: the licensed transmitters nearby, what changed on the air, and a case worked through to the next check.' },
    'ALERT': { step: 'What it actually sent',
      blurb: 'The messages themselves — decoded bit by bit, explained when they land on the wrong address, and heard live off the air.' },
    'Data': { step: 'What the sensors said',
      blurb: 'The readings: charted, logged as they arrive, and read for what they say about each station\'s health.' },
    'Site visits': { step: 'What we did on site',
      blurb: 'The paperwork of a visit, digitised — inspections, council maintenance, the record of both, and the photos.' },
    'Admin': { step: 'Keeping it running',
      blurb: 'Where the station data comes from, who may sign in, and the base stations that receive it all.' },
  };

  // ── Everyday jobs ──────────────────────────────────────────────────────────
  // The question somebody new actually arrives with is not "what does Pass
  // Ranges do" but "where do I go to…". `icon` overrides the tab's own where
  // the job is one corner of a big tab (〽️ is the Stations path tools' button).
  const TASKS = [
    { text: 'Find a station and see it on the map',        tab: 'stations' },
    { text: 'Check a radio path will work',                tab: 'stations', icon: '〽️' },
    { text: 'See which stations need attention today',     tab: 'health' },
    { text: 'Watch for a test transmission to arrive',     tab: 'msglog' },
    { text: 'Chart a station\'s rainfall or river level',  tab: 'field' },
    { text: 'Decode an ALERT message',                     tab: 'packets' },
    { text: 'Explain a reading on an address nobody owns', tab: 'bitflipper' },
    { text: 'Work out what is interfering with a repeater', tab: 'workbench' },
    { text: 'Listen to ALERT off the air',                 tab: 'serial' },
    { text: 'Fill in a site inspection',                   tab: 'inspections' },
    { text: 'File the photos from a field trip',           tab: 'photos' },
    { text: 'Print a map for a field trip',                tab: 'mapgen' },
  ];

  const SELF = 'sitemap';
  // Six hues (--sm-group-1…6 in styles.css), cycled if a seventh group arrives.
  const HUES = 6;

  // ── The page ───────────────────────────────────────────────────────────────

  const tabOf = id => TAB_LIST.find(t => t.id === id);

  // The groups as the cards show them: every tab but this one, under its own
  // heading, and a group left with nothing (Start here) left out.
  function workGroups() {
    return TABS
      .map(g => ({ group: g.group, slug: slug(g.group), tabs: g.tabs.filter(t => t.id !== SELF) }))
      .filter(g => g.tabs.length)
      .map((g, i) => ({ ...g, n: i + 1, hue: 'sm-g' + ((i % HUES) + 1) }));
  }

  // HELP's first sentence, tags off, for a tab GUIDE does not cover yet.
  function fallbackWhat(id) {
    const text = String((HELP[id] && HELP[id].summary) || '').replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    const m = text.match(/^.*?[.?!](\s|$)/);
    return (m ? m[0] : text).trim();
  }

  function render() {
    const groups = workGroups();
    const tabCount = groups.reduce((n, g) => n + g.tabs.length, 0);
    return `
    <div class="page sm-page" id="sm-page" style="--page-max:1180px">
      <div class="sm-hero">
        <h2 class="sm-title" id="sm-h"><span aria-hidden="true">🗂️</span> Site map</h2>
        <p class="sm-lede">Every tab in the bar on the left, what it is for, and when you would
          reach for it. <strong>Point at any card</strong> — or move to it with the keyboard — and a
          gold line shows where its button is.</p>
        <ul class="sm-facts" aria-label="At a glance">
          <li><strong>${tabCount}</strong> tabs</li>
          <li><strong>${groups.length}</strong> groups</li>
          <li><kbd>Ctrl</kbd>+<kbd>K</kbd> finds any of them by what it does</li>
        </ul>
      </div>
      ${anatomyHtml()}
      ${journeyHtml(groups)}
      ${tasksHtml()}
      ${groups.map(groupHtml).join('')}
      <section class="panel sm-more" aria-labelledby="sm-more-h">
        <h3 id="sm-more-h">Still not sure?</h3>
        <p>Every tab has its own <strong>❔ Help</strong> in the side panel on the right — open it on
          any tab and it explains that tab in full, with what to watch out for and where to read
          more. Something wrong, or missing? <strong>🐞 Report a Bug</strong> in the banner sends a
          note to whoever looks after this app.</p>
        <div class="button-group">
          <button type="button" data-sm-point="dock" onclick="SiteMap.help()">❔ Open Help</button>
          <button type="button" data-sm-point="banner" onclick="BugReport.open()">🐞 Report a Bug</button>
        </div>
      </section>
    </div>`;
  }

  // The screen, drawn: banner, nav, the open tab, the side panel, numbered to
  // the list beside it. The nav in the drawing is TABS — a row per tab in its
  // group's hue — so the picture stays true as tabs come and go.
  function anatomyHtml() {
    return `
      <section class="panel sm-anatomy" aria-labelledby="sm-anat-h">
        <h3 id="sm-anat-h">The screen at a glance</h3>
        <div class="sm-anat" id="sm-anat">
          ${anatomySvg()}
          <ol class="sm-anat-key">
            <li data-sm-point="nav" data-sm-part="nav">
              <span class="sm-num" aria-hidden="true">1</span>
              <div><strong>The bar on the left</strong> — every tab, filed in groups. « at its top
                shrinks it to icons; on a phone it is tucked behind ☰. To find a tab by what it
                does — "decode", "battery", "print" — use
                <button type="button" class="link-btn" data-sm-point="find" onclick="focusNavFind()">🔎 Find a tab</button>
                or press <kbd>Ctrl</kbd>+<kbd>K</kbd>.</div>
            </li>
            <li data-sm-part="main">
              <span class="sm-num" aria-hidden="true">2</span>
              <div><strong>The tab you are on</strong> — fills the middle. This page is one; pick
                another in the bar and it takes this one's place.</div>
            </li>
            <li data-sm-point="dock" data-sm-part="dock">
              <span class="sm-num" aria-hidden="true">3</span>
              <div><strong>The side panel</strong> — <button type="button" class="link-btn"
                onclick="SiteMap.help()">❔ Help</button> explains whichever tab is open. On
                Stations it also holds the station list and the map's tools.</div>
            </li>
            <li data-sm-point="banner" data-sm-part="header">
              <span class="sm-num" aria-hidden="true">4</span>
              <div><strong>The banner</strong> — 🔑 Sign in (only needed to edit), 🐞 Report a Bug,
                and 🌗 light or dark.</div>
            </li>
          </ol>
        </div>
      </section>`;
  }

  function anatomySvg() {
    // The nav column: a short bar per group heading, a row per tab.
    const top = 66, bottom = 292;
    const nTabs = TAB_LIST.length, nGroups = TABS.length;
    const head = 5, gap = 4;
    const row = Math.min(9, (bottom - top - nGroups * head - (nGroups - 1) * gap) / nTabs);
    let y = top;
    let rows = '';
    let dataRow = null;
    const work = workGroups();
    TABS.forEach((g, gi) => {
      if (gi) y += gap;
      rows += `<rect class="sm-a-head" x="10" y="${(y + 1.5).toFixed(1)}" width="28" height="1.6" rx=".8"/>`;
      y += head;
      const hue = (work.find(w => w.group === g.group) || { hue: 'sm-g0' }).hue;
      g.tabs.forEach((t, ti) => {
        const cy = y + row / 2;
        const sq = Math.max(2.5, row - 2);
        const w = Math.min(64, 10 + t.label.length * 2.4);
        rows += `<rect class="sm-a-dot ${hue}" x="11" y="${(cy - sq / 2).toFixed(1)}" width="${sq.toFixed(1)}" height="${sq.toFixed(1)}" rx="1"/>`
              + `<rect class="sm-a-label" x="${(14 + sq).toFixed(1)}" y="${(cy - 1).toFixed(1)}" width="${w.toFixed(1)}" height="2" rx="1"/>`;
        if (t.id === SELF) rows += `<rect class="sm-a-here" x="7" y="${(y - 1).toFixed(1)}" width="92" height="${(row + 2).toFixed(1)}" rx="3"/>`;
        if (g.group === 'Data' && ti === 0) dataRow = { y: cy };
        y += row;
      });
    });
    // The open tab: this page, in miniature — six cards in their groups' hues.
    let cards = '';
    for (let i = 0; i < 6; i++) {
      const x = 124 + (i % 3) * 86, cy = 92 + Math.floor(i / 3) * 52;
      cards += `<rect class="sm-a-card" x="${x}" y="${cy}" width="78" height="42" rx="4"/>`
             + `<rect class="sm-a-edge sm-g${i + 1}" x="${x}" y="${cy}" width="3" height="42" rx="1.5"/>`
             + `<rect class="sm-a-label" x="${x + 9}" y="${cy + 9}" width="34" height="2.4" rx="1.2"/>`
             + `<rect class="sm-a-text" x="${x + 9}" y="${cy + 18}" width="58" height="1.8" rx=".9"/>`
             + `<rect class="sm-a-text" x="${x + 9}" y="${cy + 24}" width="48" height="1.8" rx=".9"/>`;
    }
    // The leader, drawn as it behaves: from the fourth card (Data) to that
    // group's first row in the nav, ending on a ring.
    const ly = dataRow ? dataRow.y : 200;
    const leader = `M124 165 C 108 165 ${112} ${ly.toFixed(1)} 101 ${ly.toFixed(1)}`;
    return `
          <svg class="sm-anat-svg" viewBox="0 0 480 300" role="img" aria-labelledby="sm-anat-t sm-anat-d">
            <title id="sm-anat-t">How the screen is laid out</title>
            <desc id="sm-anat-d">The banner across the top, the bar of tabs down the left in
              coloured groups, the open tab in the middle, and the side panel down the right,
              numbered 1 to 4 to match the list beside it. A gold line runs from a card in the
              middle to its tab's button in the bar.</desc>
            <rect class="sm-a-frame" x=".5" y=".5" width="479" height="299" rx="10"/>
            <g data-part="main">
              <rect class="sm-a-region sm-a-main" x="112" y="42" width="272" height="250" rx="6"/>
              <rect class="sm-a-title" x="124" y="54" width="70" height="5" rx="2.5"/>
              <rect class="sm-a-text" x="124" y="66" width="200" height="2" rx="1"/>
              <rect class="sm-a-text" x="124" y="72" width="160" height="2" rx="1"/>
              ${cards}
              <text class="sm-a-caption" x="248" y="214" text-anchor="middle">the tab you are on</text>
              <rect class="sm-a-text" x="124" y="232" width="248" height="2" rx="1"/>
              <rect class="sm-a-text" x="124" y="240" width="200" height="2" rx="1"/>
            </g>
            <g data-part="nav">
              <path class="sm-a-region sm-a-nav" d="M.5 34 H104.5 V299.5 H10.5 A10 10 0 0 1 .5 289.5 Z"/>
              <text class="sm-a-tiny" x="10" y="45">«</text>
              <rect class="sm-a-find" x="8" y="49" width="90" height="12" rx="3"/>
              <text class="sm-a-tiny" x="13" y="57.6">🔎 Find a tab…</text>
              ${rows}
            </g>
            <g data-part="dock">
              <rect class="sm-a-pane" x="392" y="42" width="48" height="250" rx="6"/>
              <text class="sm-a-tiny" x="416" y="58" text-anchor="middle">Help</text>
              <rect class="sm-a-text" x="398" y="66" width="36" height="1.8" rx=".9"/>
              <rect class="sm-a-text" x="398" y="72" width="30" height="1.8" rx=".9"/>
              <rect class="sm-a-text" x="398" y="78" width="34" height="1.8" rx=".9"/>
              <path class="sm-a-region sm-a-strip" d="M447.5 34 H479.5 V289.5 A10 10 0 0 1 469.5 299.5 H447.5 Z"/>
              <circle class="sm-a-btn" cx="463.5" cy="48" r="8"/>
              <text class="sm-a-tiny sm-a-q" x="463.5" y="51" text-anchor="middle">?</text>
              <rect class="sm-a-ghost" x="457.5" y="62" width="12" height="12" rx="3"/>
              <rect class="sm-a-ghost" x="457.5" y="78" width="12" height="12" rx="3"/>
              <rect class="sm-a-ghost" x="457.5" y="94" width="12" height="12" rx="3"/>
            </g>
            <g data-part="header">
              <path class="sm-a-region sm-a-header" d="M.5 34 V10.5 A10 10 0 0 1 10.5 .5 H469.5 A10 10 0 0 1 479.5 10.5 V34 Z"/>
              <text class="sm-a-brand" x="14" y="22">Flood-Net</text>
              <rect class="sm-a-hbtn" x="382" y="9" width="26" height="16" rx="8"/>
              <rect class="sm-a-hbtn" x="412" y="9" width="26" height="16" rx="8"/>
              <rect class="sm-a-hbtn" x="442" y="9" width="26" height="16" rx="8"/>
              <text class="sm-a-emoji" x="395" y="20.5" text-anchor="middle">🔑</text>
              <text class="sm-a-emoji" x="425" y="20.5" text-anchor="middle">🐞</text>
              <text class="sm-a-emoji" x="455" y="20.5" text-anchor="middle">🌗</text>
            </g>
            <path class="sm-a-lead-case" d="${leader}"/>
            <path class="sm-a-lead" d="${leader}"/>
            <rect class="sm-a-ring" x="6" y="${(ly - row / 2 - 2.5).toFixed(1)}" width="95" height="${(row + 5).toFixed(1)}" rx="3.5"/>
            <circle class="sm-a-lead-dot" cx="124" cy="165" r="2.6"/>
            <g class="sm-a-nums" aria-hidden="true">
              <circle cx="104.5" cy="150" r="9"/><text x="104.5" y="153.6" text-anchor="middle">1</text>
              <circle cx="248" cy="42" r="9"/><text x="248" y="45.6" text-anchor="middle">2</text>
              <circle cx="447.5" cy="150" r="9"/><text x="447.5" y="153.6" text-anchor="middle">3</text>
              <circle cx="364" cy="17" r="9"/><text x="364" y="20.6" text-anchor="middle">4</text>
            </g>
          </svg>`;
  }

  // The groups as one line of stops, numbered, each with its tabs' icons — the
  // order the work runs in, which is the order the nav lists them.
  function journeyHtml(groups) {
    return `
      <section class="panel sm-journey-panel" aria-labelledby="sm-journey-h">
        <h3 id="sm-journey-h">${groups.length} groups, in the order the work goes</h3>
        <p class="sm-sub">The bar files every tab under one of these. Point at a group to see it in
          the bar; press it to jump to its tabs below.</p>
        <div class="sm-journey-wrap">
          <ol class="sm-journey" style="--sm-stops:${groups.length}">
            ${groups.map(g => {
              const info = GROUPS[g.group] || {};
              return `
            <li class="sm-stop ${g.hue}">
              <button type="button" class="sm-stop-btn" data-sm-point="group:${g.slug}"
                      onclick="SiteMap.jump('${g.slug}')">
                <span class="sm-stop-n" aria-hidden="true">${g.n}</span>
                <span class="sm-stop-body">
                  <span class="sm-stop-name">${esc(g.group)}</span>
                  ${info.step ? `<span class="sm-stop-step">${esc(info.step)}</span>` : ''}
                  <span class="sm-stop-icons" aria-hidden="true">${g.tabs.map(t => t.icon).join(' ')}</span>
                </span>
              </button>
            </li>`;
            }).join('')}
          </ol>
        </div>
      </section>`;
  }

  function tasksHtml() {
    const items = TASKS.map(task => {
      const t = tabOf(task.tab);
      if (!t) return '';
      return `
          <li><button type="button" class="sm-task" data-sm-point="tab:${t.id}" onclick="switchTab('${t.id}')">
            <span class="sm-task-ico" aria-hidden="true">${task.icon || t.icon}</span>
            <span class="sm-task-text">
              <span class="sm-task-do">${esc(task.text)}</span>
              <span class="sm-task-where"><span class="sr-only">: </span><span aria-hidden="true">${t.icon}</span> ${esc(t.label)} <span aria-hidden="true">→</span></span>
            </span>
          </button></li>`;
    }).join('');
    return `
      <section class="panel sm-tasks-panel" aria-labelledby="sm-tasks-h">
        <h3 id="sm-tasks-h">I want to…</h3>
        <ul class="sm-tasks">${items}</ul>
      </section>`;
  }

  function cardHtml(t) {
    const g = GUIDE[t.id];
    const what = g ? g.what : fallbackWhat(t.id);
    const use = g ? g.use || [] : [];
    const pairs = ((HELP[t.id] && HELP[t.id].related) || [])
      .map(tabOf).filter(r => r && r.id !== SELF && r.id !== t.id);
    return `
          <li class="sm-card" id="sm-card-${t.id}" data-tab="${t.id}" data-sm-point="tab:${t.id}"${g ? '' : ' data-fallback="1"'}>
            <div class="sm-card-head">
              <span class="sm-card-ico" aria-hidden="true">${t.icon}</span>
              <h4 class="sm-card-h">${esc(t.label)}</h4>
            </div>
            <p class="sm-card-what">${esc(what)}</p>
            ${use.length ? `<ul class="sm-card-use" aria-label="Use it to">${use.map(u => `<li>${esc(u)}</li>`).join('')}</ul>` : ''}
            ${g && g.note ? `<p class="sm-card-note">${esc(g.note)}</p>` : ''}
            <div class="sm-card-foot">
              ${pairs.length ? `<p class="sm-pairs"><span class="sm-pairs-h">Goes with</span>
                ${pairs.map(r => `<span class="sm-pair" data-sm-point="tab:${r.id}" title="${esc(r.label)}"><span aria-hidden="true">${r.icon}</span> ${esc(r.label)}</span>`).join('')}</p>` : ''}
              <button type="button" class="sm-open" onclick="switchTab('${t.id}')">Open ${esc(t.label)} <span aria-hidden="true">→</span></button>
            </div>
          </li>`;
  }

  function groupHtml(g) {
    const info = GROUPS[g.group] || {};
    return `
      <section class="sm-group ${g.hue}" id="sm-sec-${g.slug}" aria-labelledby="sm-sec-h-${g.slug}">
        <div class="sm-group-head">
          <span class="sm-group-n" aria-hidden="true">${g.n}</span>
          <div>
            <h3 class="sm-group-h" id="sm-sec-h-${g.slug}" tabindex="-1">${esc(g.group)}${info.step ? ` <span class="sm-group-step">— ${esc(info.step)}</span>` : ''}</h3>
            ${info.blurb ? `<p class="sm-group-blurb">${esc(info.blurb)}</p>` : ''}
          </div>
        </div>
        <ul class="sm-cards">${g.tabs.map(cardHtml).join('')}</ul>
      </section>`;
  }

  // ── Doing things ───────────────────────────────────────────────────────────

  // A stop on the journey: its group's cards, brought up, with focus on the
  // heading so the next Tab is the first card's button.
  function jump(groupSlug) {
    const h = document.getElementById('sm-sec-h-' + groupSlug);
    if (!h) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    h.closest('section').scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
    h.focus({ preventScroll: true });
  }

  function help() {
    if (typeof setHelpCollapsed === 'function') setHelpCollapsed(false);
  }

  // ── The leader ─────────────────────────────────────────────────────────────

  const SVGNS   = 'http://www.w3.org/2000/svg';
  const GAP     = 4;     // px from a target's edge out to the ring round it
  const HIDE_MS = 140;   // grace while the pointer crosses the gap between cards
  const BEND    = 30;    // px; the least a curve leaves its ends square

  let root = null, anat = null, svg = null, raf = 0, hideTimer = 0;
  let hoverEl = null, focusEl = null, shown = null, lit = null, last = '';

  function overlay() {
    if (svg && svg.isConnected) return svg;
    svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('id', 'sm-leader');
    svg.setAttribute('class', 'sm-leader');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    // pathLength="1" so the draw-in can be a dash the length of any line.
    svg.innerHTML = `
      <path class="sm-l-case" pathLength="1"/>
      <path class="sm-l-gold" pathLength="1"/>
      <path class="sm-l-hi" pathLength="1"/>
      <rect class="sm-l-ring-case"/>
      <rect class="sm-l-ring"/>
      <circle class="sm-l-dot" r="4"/>`;
    document.body.appendChild(svg);
    return svg;
  }

  // Drawn and in the window. A target scrolled out of sight — ☰ once a phone's
  // page has scrolled the banner away — gets no line: one running off the top
  // of the screen points at nothing anybody can see.
  function onScreen(el) {
    if (!el || !el.isConnected) return null;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2 && r.bottom > 0 && r.top < window.innerHeight
      && r.right > 0 && r.left < window.innerWidth ? el : null;
  }

  // The element a data-sm-point names, as the shell stands this frame.
  function targetFor(spec) {
    const i = String(spec || '').indexOf(':');
    const kind = i < 0 ? spec : spec.slice(0, i);
    const val  = i < 0 ? '' : spec.slice(i + 1);
    let el = null;
    if (kind === 'tab') {
      el = document.querySelector(`#tab-nav .tab-btn[data-tab="${CSS.escape(val)}"]`);
    } else if (kind === 'group') {
      const h = document.getElementById('nav-h-' + val);
      el = h && h.closest('.nav-group');
    } else if (kind === 'nav') {
      el = document.querySelector('#tab-nav .nav-inner');
    } else if (kind === 'find') {
      el = onScreen(document.getElementById('nav-search'))
        || document.querySelector('#tab-nav .nav-find-btn');
    } else if (kind === 'dock') {
      el = document.querySelector('#help-panel .help-toggle');
    } else if (kind === 'banner') {
      el = document.querySelector('header .header-actions');
    }
    // Into the nav's scroller first, so a button below its fold counts as on
    // screen — but only on the way to a new target, never one already lit.
    if (el && el !== lit) bringIntoNav(el);
    if (onScreen(el)) return el;
    // The nav put away behind ☰ (a phone): the line goes to where it is.
    if (kind === 'tab' || kind === 'group' || kind === 'nav' || kind === 'find') {
      return onScreen(document.getElementById('btn-nav'));
    }
    return null;
  }

  // A target inside the nav's own scroller, scrolled into it — once, when the
  // line first goes there, so it does not fight somebody scrolling the nav.
  function bringIntoNav(el) {
    const inner = el.closest && el.closest('#tab-nav .nav-inner');
    if (!inner || inner === el) return;
    const ir = inner.getBoundingClientRect(), r = el.getBoundingClientRect();
    if (!r.height || !ir.height) return;             // put away: a phone's drawer, shut
    const pad = 10;
    if (r.top < ir.top + pad) inner.scrollTop -= ir.top + pad - r.top;
    else if (r.bottom > ir.bottom - pad) inner.scrollTop += Math.min(r.bottom - (ir.bottom - pad), r.top - (ir.top + pad));
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // The line from a source to the ring round its target. Out of the side the
  // target is on, square to it, and into the ring's facing side; level with the
  // source where the target is tall enough (the whole nav, a group), its
  // middle where it is a button. A target above or below — the banner — is
  // reached out of the top or the bottom instead.
  function geometry(src, t) {
    const a = src.getBoundingClientRect();
    const ico = src.querySelector('.sm-card-ico, .sm-task-ico, .sm-num');
    const ir = ico ? ico.getBoundingClientRect() : null;
    // A stop on the journey leaves from its top edge: level with its number,
    // the line would run through every number to the left of it.
    const ay = src.classList.contains('sm-stop-btn') ? a.top + 1
      : ir && ir.height ? (ir.top + ir.bottom) / 2 : (a.top + a.bottom) / 2;
    const tr = t.getBoundingClientRect();
    const ring = { x: tr.left - GAP, y: tr.top - GAP, w: tr.width + 2 * GAP, h: tr.height + 2 * GAP };
    const ty = ring.h > 64 ? clamp(ay, ring.y + 16, ring.y + ring.h - 16) : ring.y + ring.h / 2;
    const tcx = ring.x + ring.w / 2;
    let x1, y1, x2, y2, d;
    if (ring.x + ring.w <= a.left || ring.x >= a.right) {
      const dir = ring.x >= a.right ? 1 : -1;
      x1 = dir > 0 ? a.right : a.left;
      y1 = ay;
      x2 = dir > 0 ? ring.x : ring.x + ring.w;
      y2 = ty;
      const k = Math.max(BEND, Math.abs(x2 - x1) * 0.45);
      d = `M${x1} ${y1} C${x1 + dir * k} ${y1} ${x2 - dir * k} ${y2} ${x2} ${y2}`;
    } else {
      // Above or below, and overlapping it across: out of whichever side of
      // the source is nearer the target's middle, and hooked round into the
      // ring's facing edge. Straight up out of the source's top would run
      // through whatever is stacked above it — the key's other entries.
      const side = tcx >= (a.left + a.right) / 2 ? 1 : -1;
      const dir = ring.y >= a.bottom ? 1 : -1;
      x1 = side > 0 ? a.right : a.left;
      y1 = ay;
      x2 = tcx;
      y2 = dir > 0 ? ring.y : ring.y + ring.h;
      const k = Math.max(BEND, Math.abs(y2 - y1) * 0.45);
      d = `M${x1} ${y1} C${x1 + side * BEND} ${y1} ${x2} ${y2 - dir * k} ${x2} ${y2}`;
    }
    const r = n => Math.round(n * 10) / 10;
    return { d: d.replace(/-?\d+\.\d+/g, m => String(r(+m))), x1: r(x1), y1: r(y1), ring };
  }

  function paint(g) {
    if (!svg) return;
    if (!g) { svg.classList.remove('is-on'); last = ''; return; }
    const key = `${g.d}|${g.ring.x}|${g.ring.y}|${g.ring.w}|${g.ring.h}`;
    if (key === last) return;
    last = key;
    svg.querySelectorAll('path').forEach(p => p.setAttribute('d', g.d));
    svg.querySelectorAll('rect').forEach(rc => {
      rc.setAttribute('x', g.ring.x.toFixed(1));
      rc.setAttribute('y', g.ring.y.toFixed(1));
      rc.setAttribute('width', g.ring.w.toFixed(1));
      rc.setAttribute('height', g.ring.h.toFixed(1));
      rc.setAttribute('rx', '10');
    });
    const dot = svg.querySelector('circle');
    dot.setAttribute('cx', g.x1);
    dot.setAttribute('cy', g.y1);
    svg.classList.add('is-on');
  }

  function light(t) {
    if (t === lit) return;
    if (lit) lit.classList.remove('sm-lit');
    lit = t;
    if (t) t.classList.add('sm-lit');
  }

  function frame() {
    raf = 0;
    if (!shown || !shown.isConnected || !svg) { hide(); return; }
    const t = targetFor(shown.getAttribute('data-sm-point'));
    light(t);
    paint(t ? geometry(shown, t) : null);
    raf = requestAnimationFrame(frame);
  }

  function show(el) {
    if (shown) shown.classList.remove('is-pointing');
    shown = el;
    el.classList.add('is-pointing');
    overlay();
    last = '';
    // The draw-in, restarted for each new source.
    svg.classList.remove('is-drawing');
    void svg.getBoundingClientRect();
    svg.classList.add('is-drawing');
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function hide() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (shown) shown.classList.remove('is-pointing');
    shown = null;
    light(null);
    paint(null);
  }

  function settle() {
    const next = hoverEl || focusEl;
    if (next === shown) { clearTimeout(hideTimer); return; }
    clearTimeout(hideTimer);
    if (next) show(next);
    else hideTimer = setTimeout(() => { if (!(hoverEl || focusEl)) hide(); }, HIDE_MS);
  }

  const sourceOf = node => {
    const el = node && node.closest ? node.closest('[data-sm-point]') : null;
    return el && root && root.contains(el) ? el : null;
  };

  // The drawing's own region lit with the line, for the key's four entries.
  function part(node) {
    if (!anat) return;
    const el = node && node.closest ? node.closest('[data-sm-part]') : null;
    const p = el && anat.contains(el) ? el.getAttribute('data-sm-part') : '';
    if (p) anat.setAttribute('data-lit', p); else anat.removeAttribute('data-lit');
  }

  function onOver(e) { hoverEl = sourceOf(e.target); part(e.target); settle(); }
  function onLeave() { hoverEl = null; part(null); settle(); }
  function onFocusIn(e) { focusEl = sourceOf(e.target); settle(); }
  function onFocusOut(e) {
    if (e.relatedTarget && root && root.contains(e.relatedTarget)) return;
    focusEl = null;
    settle();
  }

  function init() {
    // Before the early return: a render that finds no page still leaves the
    // teardown for the one that does (test/README.md).
    registerTabTeardown('Site map', stop);
    root = document.getElementById('sm-page');
    anat = document.getElementById('sm-anat');
    if (!root) return;
    overlay();
    root.addEventListener('pointerover', onOver);
    root.addEventListener('pointerleave', onLeave);
    root.addEventListener('focusin', onFocusIn);
    root.addEventListener('focusout', onFocusOut);
  }

  // Leaving the tab: the line, the ring, the lit button and the loop, all of
  // them — the svg is on <body>, where the next tab's render does not reach.
  function stop() {
    clearTimeout(hideTimer);
    hoverEl = focusEl = null;
    hide();
    if (svg) svg.remove();
    svg = null;
    root = anat = null;
  }

  return { render, init, jump, help, guide: GUIDE, tasks: TASKS };
})();
