// MegaNet — whats-new.js
//
// WhatsNew — ✨ What's new in the banner, after a release with changes
// somebody using the app would notice (#222).
//
// The list is written here, for the people using the app, a line each: what
// changed on screen and where to find it. Not the roadmap's revision notes,
// which are written for whoever works on the code and say why; not the commit
// log either. An entry is added in the same push as the change it describes,
// with the next number — the number, not the date, is what "seen" remembers,
// because two releases can share a day.
//
// The pill shows only while an entry is unseen on this device, and pressing it
// is seeing them all. A device that has never opened the app (Route's
// newDevice) has seen everything already: a list of what changed is news only
// to somebody who knew what it was before.
//
// Nothing runs at load. init.js calls start().
//
// Exposes: start, open, entries.
// Requires: core.js (esc), modal.js, route.js.

const WhatsNew = (() => {
  const SEEN_KEY = 'mn-whats-new';

  // Newest first. `html` is trusted markup — it is written here, not typed in.
  const ENTRIES = [
    { n: 85, date: '2026-10-23', items: [
      '<strong>Rivers on the Stations map</strong>, on from the start: every principal named river and creek in Australia, '
        + 'from the Bureau of Meteorology\'s Geofabric, drawn under the pins with its name along it. The big rivers show '
        + 'across the country and their tributaries appear as you zoom in; from zoom 12 the small named creeks join them. '
        + 'Hover a river for its name; <strong>click it to select it</strong> — it lights up from source to mouth, and a '
        + 'card says how much country drains through it and which stations are on it, each a button to go there. Click '
        + 'open map, or 🧹, to put it down. A river picked in 📍 <em>Find a place</em> is selected the same way. Turn it '
        + 'off in 🗺️ Map display → <em>Rivers and creeks</em>.',
      '<strong>Thinner roads</strong> in <em>Road &amp; bridge owners</em>: the roads are drawn about half as heavy as '
        + 'before, so the rivers read first. The colours, and which roads are heaviest, are unchanged.',
    ] },
    { n: 84, date: '2026-10-23', items: [
      '<strong>Where faults happen</strong>, a new section on the <em>🧪 Bit Bench</em>: a model ALERT site in 3-D — a '
        + 'river gauge sending, a repeater on the far hill hearing it, and between them a hill, a shed and a passing truck, '
        + 'another gauge, a pager mast and a phone tower, a storm and an electric fence. It tours the fourteen faults one '
        + 'at a time, lighting the place each one happens and drawing a close-up of what goes wrong there beside it; '
        + '◀ ▶ step through them, <em>Hold this one</em> stops the tour, drag the site sideways to turn it, and '
        + '<em>Try it on the bench</em> opens that fault in the Faults section. Each section of the Bit Bench now also '
        + 'wears a picture and a colour of its own at the top, so they are easier to tell apart down the page.',
    ] },
    { n: 83, date: '2026-10-23', items: [
      '<strong>📶 Fade margin, one way.</strong> Every fade margin is now priced the way the network runs — a field '
        + 'station to its repeater, a repeater to its base — and nothing else, since nothing transmits back down. The '
        + '<em>Radio path</em> card and the elevation profile quote one figure and name the two ends it runs between; the '
        + '<em>back</em> figure and the worse-of-the-two are gone, so a TX power you change now moves the figure. The '
        + 'profile has a TX power box only at A, the transmitter; ⇄ <em>Flip direction</em> prices the other way round. '
        + 'The fade-margin map, the network review, the site and relocation finders and their downloads follow the same '
        + 'rule, and <em>Radio coverage</em> starts on <em>Centre Rx</em>, with no worst case.',
    ] },
    { n: 82, date: '2026-10-23', items: [
      '<strong>📶 Carrier fingerprint</strong>, on a station\'s card on the Stations map (under its ALERT IDs and '
        + 'frequencies) and in its Station details (under its ALERT addresses). Every burst a base station\'s SDR decodes '
        + 'comes on its transmitter\'s own carrier, and this is the station\'s — or, for a repeater, its relays\': '
        + '<em>Offset</em>, how far it sits from the other transmitters the same base stations hear; <em>Channel</em>, '
        + 'the channel it was heard on, checked against the TX frequency on record, with a ⚠ where they differ; and '
        + '<em>Drift</em>, how far it has moved against the thirty days before, or what is still needed to judge that. '
        + 'A link opens the Transmitter frequency panel in Station Health on the station.',
    ] },
    { n: 81, date: '2026-10-23', items: [
      '<strong>The Stations side panel names its buttons.</strong> The rail on the right of the Stations map now '
        + 'shows each button\'s name beside its icon, in three sections — <em>Stations &amp; places</em>, <em>Map</em> '
        + 'and <em>Tools</em> — whose headings fold them away. <strong>Collapse »</strong> at its top puts the names '
        + 'away for icons alone, and « brings them back, the way the left bar folds; it remembers. <em>Clear the '
        + 'selection</em>, the <em>3-D view</em>, <em>Full screen</em> and <em>Help</em> stay at the foot of the rail '
        + 'whatever is scrolled above them, and a mode such as <em>What\'s here?</em> wears a switch that says whether it '
        + 'is on.',
      'The icons are drawn to match the left bar in every look: thin lines under Calm, coloured tiles under Tiles, '
        + 'the dark frame under Instrument (the rail is part of it now), yellow signs under Signs, and emoji under '
        + 'Classic. Under Tiles the open panel\'s tile is <strong>gilded</strong>, so you can see which one is on. Some '
        + 'names are shorter: <em>Map display</em> is <strong>Layers</strong>, <em>Polar radio coverage</em> is '
        + '<strong>Radio coverage</strong>, <em>Repeater site finder</em> is <strong>Repeater sites</strong> and '
        + '<em>Station relocation finder</em> is <strong>Relocate station</strong>.',
    ] },
    { n: 80, date: '2026-10-23', items: [
      '<strong>↩ Undo in Station details.</strong> Once you have changed something and not saved it, an <em>Undo</em> '
        + 'button appears to the left of <em>Save</em> — at the top of the card and in the unsaved-changes bar at its '
        + 'foot. It throws away every unsaved change at once and puts the station back as the database has it (a new '
        + 'station\'s form goes back to blank). Nothing is sent to the database. <em>Last heard</em> now sits on its own '
        + 'line under the station\'s name, above the saved line and <em>In Flood-Net</em>.',
    ] },
    { n: 79, date: '2026-10-23', items: [
      '<strong>📡 Last heard reads the same on the map card and in the station editor.</strong> The card on the map '
        + 'now says it the way the editor\'s header does — <em>06:43 yesterday · ⛔ 31 h ago</em>, coloured and marked '
        + 'alike — and the two never disagree with the card\'s Health line. Where the server has looked at the station '
        + 'lately, it decides whether a quiet spell is overdue: a station it has not called silent (one that often goes '
        + 'a day or more between reports) is no longer red in the editor and the station list while its card and pin '
        + 'say OK.',
    ] },
    { n: 78, date: '2026-10-23', items: [
      '<strong>🧹 Clear the selection</strong>, on the Stations map: a new button in the side panel\'s strip, straight '
        + 'under ❔. It deselects the station and any link you clicked, puts the cards on the map away, and takes off '
        + 'everything drawn on the map — your drawings, the link budget\'s ends, the polar plot, the site finders\' '
        + 'answers and the found place\'s pin — without moving the map or touching the filters. (↺ on the map still '
        + 'resets everything, the filters and the view included.) Station details with changes you have not saved '
        + 'keeps its station.',
    ] },
    { n: 77, date: '2026-10-23', items: [
      '<strong>Click a pin, get its station details</strong>, on the Stations map: clicking a station\'s pin now loads it '
        + 'into the <em>Station details</em> card as well as the card on the map, and the side panel scrolls down to it — '
        + 'no need to press <em>Station details</em> on the map card first. If the station details have changes you have '
        + 'not saved, they stay where they are and the card on the map says so; save first, or press <em>Station '
        + 'details</em> to load the new station anyway.',
    ] },
    { n: 76, date: '2026-10-23', items: [
      '<strong>Where the IDs come from</strong>, a new view on the <em>ALERT2 / ERT-A2</em> tab, for when an ALERT2 receiver '
        + 'says it heard a legacy station that ought to be out of range. A legacy reading in an ALERT2 frame was heard by some '
        + 'ALERT2 repeater — its <em>concentrator</em> — and legacy ALERT carries no checksum, so a word that repeater misheard '
        + 'arrives as another station\'s address, usually one far away, with most of its bits 1. Each concentrator gets a row: '
        + 'how much of what it sends looks misheard, how much matches no station or one over 250 km away, and a verdict. '
        + '<em>Trace</em> any address for every copy of it by concentrator, its values, the legacy word it was rebuilt from '
        + '(drawn on ALERT Packets), and the clean reading another concentrator heard that same second. Signed in as an editor, '
        + '<em>From Flood-Net — reception log</em> reads what a Raspberry Pi heard straight into the tab, and checks the Pi\'s '
        + 'decode of every record against its bytes. Readings that look misheard, and stations matched far away, are marked '
        + 'on the other views too.',
    ] },
    { n: 75, date: '2026-10-23', items: [
      '<strong>Fainter links on the Stations map</strong>: the pass-range and backbone lines now open at 25 % opacity, '
        + 'so the stations show through them. Move <em>Link opacity</em> in Map display to have them stronger — the '
        + 'setting you pick is now remembered on this device.',
    ] },
    { n: 74, date: '2026-10-23', items: [
      '<strong>📟 SWR Meter</strong>, a new tab in the <em>Knowledge base</em> (and in the Field view, beside the forms): the '
        + 'power and SWR meters in the field kit — the Surecom SW-102, the Moonraker SWR-400 and the Comm-connect 3030 — drawn '
        + 'and worked. Pick your meter, then a made-up station with one fault (water in the coax, a loose N-type, a long run of '
        + 'thin cable, a bad jumper, the meter in backwards…) or type your own readings, and watch the power go up the line and '
        + 'come back, with the meter\'s own screen or needle showing what it would read and what to do about it. Flick the '
        + 'SWR-400\'s switches and turn its CAL knob as you would on site, and press TEST on the A2 to see what each meter makes '
        + 'of a short burst (the 3030 with PEAK and HOLD is the one built for it). Then: the steps for hooking up the meter you picked, '
        + 'what a meter is really measuring, what a decibel lost costs a station at its fade margin, a symptom-to-cause table '
        + 'for the field, and a worked case. The inspection form\'s <em>Antenna Tests</em> opens it with the readings typed there.',
    ] },
    { n: 73, date: '2026-10-23', items: [
      '<strong>Messages landing keep a glow</strong>, in ⏱️ Latency on the Stations map. After its green flash and pulse, '
        + 'a station that just reported keeps a green ring round its pin, and its links stay lit, for a minute — '
        + 'bright for the first 20 seconds, then fading — so you can still see which stations just reported if you looked '
        + 'away. And while the messages are animated, ⏱️ in the side panel\'s strip beats with the same green glow as the '
        + 'card\'s dot.',
    ] },
    { n: 72, date: '2026-10-22', items: [
      '<strong>Messages landing, in ⏱️ Latency on the Stations map</strong> — a new card in the Latency pane. '
        + 'While it is on, every message that lands in the log is played on the map a few seconds later: its station '
        + 'flashes green and a green pulse runs along its links to its repeater and on to a base, the way the logo '
        + 'on the loading screen pulses. It comes on with the Latency view; untick <em>Animate messages on the map</em> '
        + 'to keep the colours without it. <strong>⏻ Latency view</strong>, at the top of the pane, now turns the '
        + 'pins\' colours and the animation off together — and back on.',
    ] },
    { n: 71, date: '2026-10-22', items: [
      '<strong>Its checks, slot by slot, on the station card and in the station editor</strong> — the strip from '
        + '<em>Station Health</em>, a row a day and a square a check: received, received with frames lost, or not heard. '
        + 'On the card it sits under the Health lines; in the editor, at the top of <em>Telemetry</em>. Press a square to '
        + 'open Station Health on that check and see what the rest of the network was doing then — whether a check not '
        + 'heard was the station or its receivers is worked out there.',
    ] },
    { n: 70, date: '2026-10-22', items: [
      '<strong>◀ ▶ ▲ ▼ Step buttons on the chart\'s navigators</strong>, in <em>Plots</em> and <em>Field Data</em>. '
        + '◀ and ▶ at the two ends of the whole-record strip under the chart move the window earlier or later; ▲ and ▼ '
        + 'at the top and bottom of the bar down the right move the vertical range up or down — and with the chart '
        + 'selected, the ↑ and ↓ keys do the same, as ← and → already did across. Each press shifts it a fifth of its '
        + 'width or height, and a button goes faint when the window is already at that end of the record. Undo takes a '
        + 'quick run of presses back in one go, and ↺ resets both. ↺ and ⛶ now sit above the plot, not on it.',
    ] },
    { n: 69, date: '2026-10-22', items: [
      '<strong>🧪 Bit Bench</strong>, a new tab under <em>Interference</em>: a bench for the bits a station sends and the faults '
        + 'that change them. Type a number and see it in decimal, binary and hex, every bit a button to flip, with shift, rotate, '
        + 'invert, reverse and Gray code a press away; build an ALERT frame and watch its 40 bits go out as tones. Then pick one of '
        + 'fourteen faults — weak signal, impulse noise, reflections, a collision, intermodulation, crystal drift, a PLL slow to lock, '
        + 'a fast or slow clock, tones out of balance, a stuck bit and four other wiring faults — and watch it happen to the frame, '
        + 'bit by bit. <em>Send a batch</em> and it reads the fingerprint the fault leaves: where the flips land, which way they go, '
        + 'what was thrown out and what got through. <em>Whodunnit?</em> hides the fault for you to name, and <em>Your readings</em> '
        + 'reads pairs you paste in — what should have arrived, and what did.',
      '<strong>⚡ Bit Errors</strong>, a new lesson in the <em>Knowledge base</em>: each of those faults in depth — what it is, what it '
        + 'does to the bits and why, the fingerprint it leaves, how to confirm it in the field and what fixes it — with a field guide '
        + 'from symptom to cause and a calculator for the intermodulation products of any two transmitters. The five Mallee HydroTech '
        + 'lessons have a group of their own now, <em>Field training</em>, straight after Surveying.',
    ] },
    { n: 68, date: '2026-10-21', items: [
      '<strong>⏱️ Latency, on the Stations map.</strong> A new tool in the side panel, after 🔑 Legend: open it and '
        + 'every station pin is coloured by how fresh its data is — green heard in the last quarter hour, through gold, to '
        + 'maroon for a week or more; hollow if it has never been heard. A river gauge is still a triangle and the Bureau\'s '
        + 'pink outlines stay. <em>Colour by</em> switches between <em>Age</em> (how long since it was heard), '
        + '<em>Delay</em> (how long its readings take to reach the database) and <em>Checks</em> (how many of its timed '
        + 'checks went missing), over the last 24 h, 3 days or 7 days. The pane sums up the stations in view as you move '
        + 'the map, lists the worst of them and how each receiver is delivering; pick a station and it shows its checks '
        + 'slot by slot — the missed ones marked — and its readings\' delay one by one.',
    ] },
    { n: 67, date: '2026-10-21', items: [
      '<strong>🔙 The back button\'s list names where each step was.</strong> Hold the browser\'s back button down '
        + '(or right-click it) and every entry used to read the same — <em>Flood-Net — radio and satcom telemetry '
        + 'network tool</em>. Each one now names its tab, and the station when one was open: <em>Field Data — '
        + 'Flood-Net</em>, <em>Gatton AL · Stations — Flood-Net</em>. The browser\'s tab and its history say the same.',
    ] },
    { n: 66, date: '2026-10-21', items: [
      '<strong>💬 Tooltips above the pointer.</strong> Rest the mouse on a button, a pin or a chart and its tooltip now '
        + 'comes up <em>above</em> the pointer, rather than in the browser\'s box just under it, where the pointer '
        + 'covered the first words. It follows the pointer as it moves, and goes under it only at the very top of the '
        + 'window. The reading on the Field Data chart and the map labels that come up on hover — a fade margin, a '
        + 'frequency, a site\'s feature, a pin on Station Health, an ACMA licence — are above the pointer now too.',
    ] },
    { n: 65, date: '2026-10-21', items: [
      '<strong>📡 Last heard, in the station editor\'s header.</strong> Beside the station\'s name at the top of its '
        + 'details card: when Flood-Net\'s receivers last heard it, and how long ago — <em>Last heard 14:32 today · '
        + '9 min ago</em> — coloured as its row in the list is. Its card on the map already says the same, at the top '
        + 'of its health lines.',
    ] },
    { n: 64, date: '2026-10-21', items: [
      '<strong>📈 A sparkline on every sensor row.</strong> In the station editor\'s <em>ALERT IDs / Sensors</em>, '
        + 'each row now shows the last seven days of what that sensor has sent to Flood-Net, with its latest reading '
        + 'beside it — volts for a battery, the rain that fell for a rain gauge (bars, for a Rainfall Increment row), '
        + 'the raw count for a water level. Press the line for a bigger chart over 24 hours, 7, 30 or 90 days or 12 '
        + 'months, with the reading under your pointer and the readings as a table; <em>Open in Field Data</em> takes '
        + 'the same sensor and window to the Field Data tab for filtering and export.',
    ] },
    { n: 63, date: '2026-10-21', items: [
      '<strong>✏️ The station editor shows what you have changed and not saved.</strong> The details card is now '
        + '<em>teal</em> while it shows the station as the database has it. Change anything and the card turns '
        + '<em>gold-orange</em>, the field you changed is gilded, and a bar at the foot of the card — kept in view as '
        + 'you scroll — says how many changes are waiting, names them (press one to go to it) and has its own '
        + '<em>Save</em>. Put a field back the way it was and its gilt goes; once a save lands the card is teal again. '
        + 'A save that is refused leaves everything gold and says so in the bar.',
    ] },
    { n: 62, date: '2026-10-21', items: [
      '<strong>📡 Last heard, in the station list.</strong> The list of stations on the Stations tab has a new last '
        + 'column, <em>Last heard</em>: how long since Flood-Net\'s receivers last heard each station — <em>45 min</em>, '
        + '<em>3 h</em>, <em>2 d</em> — or <em>never</em>. Green is within two of its checks, ⚠ amber two or more, ⛔ red '
        + 'four or a day; grey is a station heard too seldom to judge. Point at a time for when it was heard. The side '
        + 'panel now opens 50 px wider to make room for the column — drag its edge if you would rather the map had it.',
    ] },
    { n: 61, date: '2026-10-21', items: [
      '<strong>🏛️ The station editor shows the station\'s owner, logo and all.</strong> Its <em>Owner</em> field '
        + 'now says what the station card on the map says: where the Bureau\'s Service Level Specification names the '
        + 'owner it shows that owner, with their logo, marked <em>per SLS</em> — the SLS is the word on it, so it is not '
        + 'typed. A box to type an owner in is there only for a station the SLS does not list. Owner now sits beside '
        + '<em>Station type</em>, and the tower\'s height beside the way the station faces.',
    ] },
    { n: 60, date: '2026-10-21', items: [
      '<strong>🎨 The Stations cards say what they are about.</strong> Each card beside (or under) the map now has a '
        + 'faint colour of its own and a band along its top: <em>blue</em> for the list — every station; '
        + '<em>violet</em> for the links between stations — Repeaters listening, the blast radius, the radio path, '
        + 'its profile and link budget; and <em>gold</em> for the details card — the one station you picked, in the '
        + 'same gold as its card on the map.',
    ] },
    { n: 59, date: '2026-10-21', items: [
      '<strong>🚚 Station relocation finder.</strong> On the Stations map, beside 🗼 Repeater site finder in the side '
        + 'panel\'s strip: pick a station that has to move, say how far it may go, and the ground round it is coloured by '
        + 'how good a new home each spot would be — fade margin to the repeaters that hear it now first, then open sky for '
        + 'the rain gauge (its WMO siting class from the trees and roofs round it), clear ground and how close it is. The '
        + 'three to five best are pinned, kept off every shed, house and building the State and OpenStreetMap have mapped, '
        + 'and out of the water. Point at the coloured ground to read any square.',
    ] },
    { n: 58, date: '2026-10-21', items: [
      '<strong>🗺️ Station Health\'s map, bigger and first.</strong> The <em>Where</em> map now has a row of its own '
        + 'across the page, under the headline and its numbers, so landing on the tab shows where the trouble is before '
        + 'the list of it. <em>Needs attention</em> follows below, the page\'s full width.',
    ] },
    { n: 57, date: '2026-10-20', items: [
      '<strong>✏️ The station editor has every action the map\'s card has.</strong> A station\'s details card now '
        + 'opens with <em>In Flood-Net</em> — Show in list, Zoom to station, Copy link, Field data, Digital twin, Field '
        + 'photos and a repeater\'s blast radius — and under its coordinates <em>Position</em> gains Directions and '
        + '<em>Records</em> gains ARRO admin, in the same order as on the map. Directions, like Copy lat, lon, goes to '
        + 'the figures in the boxes, so a pin you have just dragged is where it sends you.',
    ] },
    { n: 56, date: '2026-10-20', items: [
      '<strong>〽️ The elevation profile, full screen.</strong> Click the chart on the elevation profile — or ⛶ '
        + '<em>Full screen</em> in its key — and it opens the size of the window, the signal still running along it, with '
        + 'the path\'s figures over it and the notes under it. Point at it for the height and the signal anywhere along the '
        + 'line; Escape puts it back.',
      '<strong>🎨 One fade margin, one colour.</strong> The <em>Radio path</em> card now quotes the elevation profile\'s '
        + 'own fade margin, in the same colour. It turned the figure red whenever something stood above the line of sight, '
        + 'even where the profile had priced that in and called the path good; now it says <em>line of sight obstructed, '
        + 'priced in</em> beside the figure instead.',
    ] },
    { n: 55, date: '2026-10-20', items: [
      '<strong>🗺️ The carriers\' coverage maps on the map.</strong> In 🗺️ Map display, <em>Mobile coverage — the '
        + 'carriers\' 4G maps</em> draws Telstra\'s, Optus\'s or TPG\'s own 4G coverage map — or the best of the three — '
        + 'green where a phone works outdoors and amber where only with an external antenna, as each carrier gave it to '
        + 'the ACCC.',
      '<strong>📶 Each carrier\'s own word, on the cards.</strong> Under each carrier in a station card\'s or the '
        + '<strong>ℹ️ What is here</strong> card\'s <em>Mobile coverage</em> section is now what that carrier\'s own map '
        + 'says there — covered outdoors, external antenna only, or not covered — and the section says so when it and '
        + 'the estimate disagree.',
    ] },
    { n: 54, date: '2026-10-20', items: [
      '<strong>📶 Mobile coverage, estimated.</strong> Every station card, and the <strong>ℹ️ What is here</strong> card '
        + 'for any point on the map, now has a <em>Mobile coverage — estimated</em> section: for Telstra, Optus and TPG '
        + '(Vodafone), whether a phone should work there — <em>Good</em>, <em>Moderate</em>, <em>Basic</em> or <em>No '
        + 'coverage</em>, the same grades the carriers\' own maps use — with the signal in dBm, the band and which way the '
        + 'mast is, and the same again for a modem with an external antenna on a mast. It is worked out from the masts the '
        + 'ACMA register lists, over the map\'s terrain; <em>How each figure is reached</em> shows the sum, and each carrier\'s '
        + 'own map is linked beside it.',
    ] },
    { n: 53, date: '2026-10-20', items: [
      '<strong>⚡ The station list loads faster.</strong> The database now keeps the list ready, built again whenever '
        + 'somebody saves a station, instead of putting all of it together on every visit. It had grown slow enough that the '
        + 'app sometimes said <em>Could not load from the datastore: canceling statement due to statement timeout</em> and '
        + 'fell back to an older copy; that should not happen now.',
    ] },
    { n: 52, date: '2026-10-19', items: [
      '<strong>📡 What a base station hears, from here.</strong> Open a base station on the <em>Base Stations</em> tab '
        + '(administrators) and, under its panel, a waterfall of what its SDR sticks hear — every stick on one picture in its '
        + 'own colour, the last hour, six or a day, with the bursts it heard marked on their channels and listed by how busy '
        + 'each channel was. Point at it for the frequency, the level and what was heard. It needs RPi ALERT 0.13.5 on the station.',
    ] },
    { n: 51, date: '2026-10-19', items: [
      '<strong>🧹 Station cards, tidied.</strong> The actions on a station\'s card on the map are short lists under '
        + 'four headings — <em>In Flood-Net</em>, <em>Position</em>, <em>Imagery and terrain</em> and <em>Records</em> — '
        + 'their icons in one column and their ↗ → ⬇ in another. The station editor\'s links are the same lists, and so '
        + 'are the callouts a pin opens on a phone and the map\'s other callouts.',
      '<strong>✏️ The station editor, in sections.</strong> <em>Station</em>, <em>Location</em> and <em>Telemetry</em> '
        + 'each have a heading; Latitude and Longitude share a line, every checkbox sits beside its word, and each sensor\'s '
        + 'address, slot and type are on one line. The longer explanations are folded behind an <strong>ⓘ</strong> '
        + 'beside the field or heading they explain.',
    ] },
    { n: 50, date: '2026-10-19', items: [
      '<strong>🩷 Forecast and information locations: solid and dashed.</strong> On the Stations map a forecast '
        + 'location is now outlined in <strong>solid pink</strong> and an information location in <strong>dashed '
        + 'pink</strong>, in place of purple and pink — the dash tells them apart. The legend, the Filters\' '
        + '<em>Gauge</em> block, the 3-D view and 🔭 Look Around\'s rings and tags all match.',
    ] },
    { n: 49, date: '2026-10-19', items: [
      '<strong>⚫ TM stations are black on the map.</strong> A station read by a data logger and modem — its name ends '
        + '<em>TM</em> — is now a black pin, so it stands apart from the green of an ALERT station and the grey of a '
        + 'gauge read by hand. The legend keys it, and <em>Black for TM stations</em> under <em>Station pins</em> in '
        + '🗺️ Map display turns it off.',
    ] },
    { n: 48, date: '2026-10-19', items: [
      '<strong>🛣️ Access tracks.</strong> 813 GPS tracks driven to the sites over twenty years are now the '
        + '<em>Access track</em> of 743 stations: the last of the way in, up to 10 km out, ending at the station, with '
        + 'the GPS\'s jumps across country, wrong turns, walks round the gauge and repeat trips taken out. Signed-in '
        + 'editors see them with a station\'s other site features — listed on its card (a row shows the whole track on '
        + 'the map), and drawn in green on the map from zoom 16. Each one\'s note says which recorded track it came from.',
    ] },
    { n: 47, date: '2026-10-19', items: [
      '<strong>📡 Antenna gain in dBd.</strong> The link budget, the Repeater site finder, Polar radio coverage and the ACMA licence card now give '
        + 'antenna gain in dBd — the field stations\' CLV3 collinear reads as the 3 dB antenna it is sold as. Type gains in '
        + 'dBd too. The budget adds a <em>Dipole over isotropic</em> row (+2.15 dB) under each gain, so its sum still adds '
        + 'up; the figures themselves have not changed.',
    ] },
    { n: 46, date: '2026-10-19', items: [
      '<strong>📍 Two pins in the side panel, told apart again.</strong> In Calm and the looks in pictures the strip '
        + 'had greyed them both: now the <strong>red</strong> one is the Stations cards and the <strong>blue</strong> one '
        + '<em>Find a place</em>, as in Classic.',
    ] },
    { n: 45, date: '2026-10-19', items: [
      '<strong>📡 The signal on the profile runs one way now</strong>, A to B, over and over — <em>⇄ Flip direction</em> '
        + 'shows the other way round. And <strong>pointing at the chart</strong>, or along the line on the map, now shows the '
        + 'signal at that spot in dB beside the ground height, in its colour.',
    ] },
    { n: 44, date: '2026-10-19', items: [
      '<strong>📡 The signal, along the elevation profile.</strong> Between two stations, the chart now runs the '
        + 'transmission: a wave leaves one end, travels down the line of sight to the other, '
        + 'and the beam is painted by how much signal is left at each point — green when strong, then yellow, amber and '
        + 'orange as it fades, and red under the receiver\'s threshold, in the same colours as the fade margin. Ridges '
        + 'and (with the land-cover model) trees take their share where they stand, and the shadow behind a hill shows. '
        + '<em>⏸ Pause</em> in the chart\'s key holds it still.',
    ] },
    { n: 43, date: '2026-10-18', items: [
      '<strong>🔲 🎚️ 🪧 Three new looks, in pictures.</strong> Pick one from <em>⋯ → Theme &amp; look</em>. '
        + '<strong>Tiles</strong>: a coloured tile with a drawing on it for every tool. <strong>Instrument</strong>: a dark '
        + 'frame round the network, with how many stations are OK, on watch or at fault across the top and the map '
        + 'coloured by health. <strong>Signs</strong>: black on yellow and larger, for full sun and gloves — on a phone '
        + 'the inspection sheet becomes a row of signs, one a section. Calm and Classic are still there, one pick away.',
      '<strong>🏠 Home</strong>, a new tab under Start here: how the network is right now, the six things used most as '
        + 'big tiles, and every other tool under them. Tiles and Signs open on it, with 🏠 in the banner to come back.',
      '<strong>📌 Nearby</strong> now says whether the station you picked is reporting, under its buttons.',
    ] },
    { n: 42, date: '2026-10-18', items: [
      '<strong>🗺️ A quieter Stations map in the Calm look.</strong> It opens on a pale grey base map (dark grey in the '
        + 'dark theme), with every radio link in one colour, and without the waterways, survey marks, wind regions, road '
        + 'parcels, property boundaries, backbone paths and arrowheads. Want them? The top of <em>🗺️ Map display</em> '
        + 'lists what is off, with <em>Turn them all on</em> — or tick just the ones you use. Either way it is remembered.',
    ] },
    { n: 41, date: '2026-10-18', items: [
      '<strong>🔭 Look Around on a phone\'s bottom bar.</strong> In the Calm look the bar along the bottom of a phone now has '
        + '<em>Look</em>, beside Nearby — one tap to hold the phone up and see which station is which way.',
    ] },
    { n: 40, date: '2026-10-18', items: [
      '<strong>📖 Less to read before you start.</strong> In the Calm look a tab\'s long introduction now shows two lines, '
        + 'with <em>More about this tab</em> to read the rest — open it once and it stays open on that tab.',
      '<strong>🚦 Station Health says what it found first:</strong> how many findings need attention and at how many '
        + 'stations, how many are silent and how many checks came in — then the numbers, bigger, and <em>See them</em> '
        + 'takes you to the list, which now has more of the page.',
    ] },
    { n: 39, date: '2026-10-18', items: [
      '<strong>🪷 A calmer look.</strong> The same tabs, with less in front of you: the bar on the left lists the groups, '
        + 'and the tabs of the group you are in run across the top of the page. Search is a box in the banner, and Export, '
        + 'Theme, Help and Report a Bug are behind <strong>⋯</strong>. Prefer the old look? <strong>⋯ → Theme &amp; look → '
        + 'Classic</strong> puts it back, and it is remembered.',
      '<strong>📱 A bar along the bottom on a phone</strong>, for a site visit: Nearby, Map, Visits, Camera and More. On a '
        + 'phone the inspection sheet now shows one section at a time, with <em>Next</em> and <em>Back</em>.',
      '<strong>📌 Nearby</strong> — a new tab under <em>Site visits</em>: the stations closest to where you stand, nearest '
        + 'first, with how far and which way. Pick one for <em>Start inspection</em>, <em>Photos</em> and <em>Directions</em>.',
    ] },
    { n: 38, date: '2026-10-18', items: [
      '<strong>🔔 Notifications on your phone, for administrators.</strong> When an account is waiting for approval or a '
        + 'base station asks for a token, your phone can tell you — and the app\'s icon shows how many are waiting. Turn it '
        + 'on for each device on the <em>Admin</em> tab, under <em>🔔 Notifications</em>. On an iPhone or iPad, add '
        + 'Flood-Net to your Home Screen first, open it from the icon and sign in there; that is where notifications come.',
    ] },
    { n: 37, date: '2026-10-18', items: [
      '<strong>🔭 Forecast and information locations in Look Around.</strong> A pin for one of the Bureau\'s forecast '
        + 'locations is now ringed in purple and tagged <em>Forecast</em>, and one for an information location ringed in '
        + 'pink and tagged <em>Info</em> — the same stations the Stations map outlines. Tap the pin and its sheet says '
        + 'which in words; the other stations that way are tagged in its list too.',
    ] },
    { n: 36, date: '2026-10-17', items: [
      '<strong>🏛️ Owners\' logos on the station card.</strong> The <em>Owner</em> row now shows each owner\'s logo '
        + 'beside its name — the Bureau, WaterNSW, Seqwater, Sunwater, the councils and the rest, ninety-odd in all. '
        + 'A station with two owners shows both. A state department carries its government\'s logo; hover it to see '
        + 'whose it is.',
    ] },
    { n: 35, date: '2026-10-17', items: [
      '<strong>⏱️ TDMA Planner.</strong> A new tab under <em>Admin</em> that works out an ALERT2 time-slot plan for one radio '
        + 'channel: a valid frame length, a slot for every field station and repeater — the repeaters\' slots after the ones '
        + 'they forward and sized to the storm peak — the bytes each slot carries against what it must, and the worst-case '
        + 'time a report takes to reach the base. Sketch a network from a few counts or pick repeaters from the register, '
        + 'watch the frame and one report\'s journey, and take away the configuration sheet in the IND API\'s and the ERT-A2\'s names.',
    ] },
    { n: 34, date: '2026-10-16', items: [
      '<strong>🎚️ The fade-margin test, as a bench you can run.</strong> 🎓 Radio Propagation has a new section 6: a '
        + 'field station sending its test through a step attenuator (0–30 dB in 1 dB clicks) to a repeater on a hill. '
        + '<em>Auto</em> runs the test as it is done on site, one 3 dB step at a time; touch the attenuator and it is '
        + 'yours. Try 1, 5 or 25 W, a unity whip, a 3 dB collinear or a Yagi, and three kinds of country, and see '
        + 'where the decibels go (in watts too), the received power at every step for all three transmitters, how far '
        + 'each reaches, and — for the 3 dB-or-5 dB question — what each step size reads for the same link.',
    ] },
    { n: 33, date: '2026-10-14', items: [
      '<strong>🛣️ Who manages each road and bridge.</strong> Turn on <em>Road &amp; bridge owners (Qld)</em> in '
        + '🗺️ Map display and every Queensland road is coloured by who manages it: <strong>maroon</strong> for a '
        + 'State-controlled road (Transport and Main Roads), slate for the council\'s — or, where the State has not '
        + 'recorded an owner, the council\'s or private — green for national parks and State forests, brown dashed '
        + 'for private roads. Zoom in and every bridge gets a pin: hover it for whose it is, click it for who to call. '
        + 'The station card and <em>What is here</em> have a new <em>Road and bridge</em> section under the land: '
        + 'the nearest road and bridge, who manages each, and the TMR district or council\'s phone number and email.',
    ] },
    { n: 32, date: '2026-10-13', items: [
      '<strong>🌊 Flood velocity in the digital twin.</strong> The 🧊 pane has a <em>Flood velocity</em> panel: '
        + 'the station card\'s indicative velocity worked out on the twin\'s own ground, in the channel by the gauge '
        + 'and at the station, for whatever level the water is at. Change the slope (the card\'s, one read along the '
        + 'channel, or your own) and the roughness (Chow\'s table, by what the site looks like) and the figures follow. '
        + '<em>Colour the water by its speed</em> shades the flood from pale (slow) to deep blue (fast), with a key on '
        + 'the stage, and <em>The flow line</em> — the channel the slope is read along — can be drawn on the ground, arrows downstream. '
        + 'From a station card: <em>How the velocity is worked out → 🧊 Work it out in the digital twin</em>. '
        + 'Indicative, and nothing is saved to the station.',
    ] },
    { n: 31, date: '2026-10-13', items: [
      '<strong>🎛️ Views for the left bar.</strong> A <em>View</em> box at the top of the bar picks what it lists: '
        + '<strong>All</strong>, <strong>Simple</strong> (no Export, Map Generator or Interference group), or '
        + '<strong>Field</strong> — what a site visit needs on a phone. Signed in, the new <em>Views</em> tab makes your '
        + 'own: rename groups, move tabs (or drag them), take out what you never use. They are saved to your account, so '
        + 'they follow you to every device. A tab a view leaves out is never lost — the find box still finds it.',
      '<strong>🔭 Look Around has a tab of its own.</strong> The AR station finder — hold a phone up and the stations '
        + 'the way it faces are pinned over the camera — is in the left bar now, under Stations & networks, instead of '
        + 'in the Stations map\'s side panel.',
      '<strong>🔑 Accounts for everyone.</strong> Anybody can now create a free account with an email address and a '
        + 'password. A Bureau address is approved as soon as it is confirmed; any other is approved by an administrator. '
        + 'An approved account sees the <strong>field photos</strong> and keeps its own views; forgot your password? '
        + 'Reset it from <em>Sign in</em>.',
    ] },
    { n: 30, date: '2026-10-13', items: [
      '<strong>◉ Survey marks are circles now.</strong> With a river gauge\'s pin now a triangle, the survey marks '
        + 'layer draws the circles a survey plan uses: a <strong>ring round a dot</strong> for a benchmark (a mark with '
        + 'an AHD height), a <strong>bold empty ring</strong> for a permanent survey mark with no height, and a larger, '
        + 'glowing ringed dot for a CORS site. A benchmark mapped as a station\'s site feature is a red bullseye. The '
        + 'legend keys the ones in view.',
    ] },
    { n: 29, date: '2026-10-12', items: [
      '<strong>📍 Pins say what a station is.</strong> On the Stations map a river height gauge is now a '
        + '<strong>triangle</strong> and a rain gauge stays a circle (a station that measures both is a triangle); a gauge '
        + 'read by hand is <strong>grey</strong>; and the Bureau\'s forecast and information locations are outlined in '
        + '<strong>purple</strong> and <strong>pink</strong>, as on its own flood maps. Each is a switch under '
        + '<em>Station pins</em> in 🗺️ Map display, and the legend keys them.',
      '<strong>👤 Owner.</strong> The Stations filters have an <em>Owner</em> block — the Bureau, Seqwater, any council, '
        + 'with a box to find one — and a <em>Gauge</em> block: what a station measures, who reads it, and whether the '
        + 'Bureau forecasts for it. In 🗺️ Map display, <em>Owner</em> draws one owner\'s stations alone, or everyone\'s '
        + 'but theirs.',
    ] },
    { n: 28, date: '2026-10-12', items: [
      '<strong>📌 Site features.</strong> Signed in, a station\'s card has a <em>Site features</em> pill beside '
        + '<em>Move pin</em>: put its orifice outlet, inspection pits, benchmarks and gauge boards on the map, and draw '
        + 'its orifice run from the shelter through the pits — click by click, by your phone\'s position, or as typed '
        + 'coordinates. The card lists what is mapped, and from zoom 16 the map draws every station\'s (🗺️ Map display, '
        + '<em>Site features</em>). <em>⬇ GeoJSON</em> takes a station\'s to QGIS or Google Earth.',
    ] },
    { n: 27, date: '2026-10-12', items: [
      '<strong>⛰️ 3-D view: Draw &amp; measure works there too.</strong> Lines, circles, boxes, pins and notes drawn on '
        + 'the Stations map now show in the 3-D view, laid over the ground with their measurements. The ✏️ tools work in '
        + '3-D as well: click the terrain to draw, double-click (or press Enter) to finish a line, and clicks snap to the '
        + 'station pins you can see. The repeater site finder\'s <em>Draw a circle</em> works in 3-D now too.',
    ] },
    { n: 26, date: '2026-10-11', items: [
      '<strong>📊 Plots: line and points together.</strong> In <em>Style</em>, <em>Points</em> now switches on beside '
        + '<em>Line</em> or <em>Step</em>, so the line carries a mark on every reading. Switch the line off to get points alone.',
    ] },
    { n: 25, date: '2026-10-11', items: [
      '<strong>📊 Plots: Undo and Redo.</strong> The first buttons on the chart toolbar step back through what you did on the '
        + 'tab — a filter, a toolbar choice, a pan or zoom, a drawn line, moved, edited or deleted readings, a removed series '
        + 'or an import — and forward again. Ctrl+Z and Ctrl+Shift+Z (or Ctrl+Y) do the same; hover the button to see what '
        + 'it will undo.',
    ] },
    { n: 24, date: '2026-10-11', items: [
      '<strong>📊 Plots: filters per series.</strong> Each series you load has its own filters — the 3-5-7 test, rollovers, '
        + 'rate limits, quality codes and min/max. With more than one loaded, <em>Filters for</em> at the top of the Filters '
        + 'panel picks which series you are setting, and <em>Apply to all series</em> copies its settings to the rest.',
      '<strong>📊 Plots: Horizontal drag.</strong> A new <em>Drag does</em> choice: drag left or right to zoom the time axis to '
        + 'that span, leaving the vertical axis as it is.',
      '<strong>📊 Plots: a slimmer toolbar.</strong> The Fixed axis min/max boxes now sit on one line beside the axis buttons, '
        + 'and the toolbar buttons are shorter, so the chart gets more of the screen.',
    ] },
    { n: 23, date: '2026-10-11', items: [
      '<strong>📚 Knowledge base</strong>, a new group in the bar on the left, for lessons rather than tools. '
        + '<strong>🎓 Radio Propagation</strong> has moved into it from <em>Start here</em>.',
      'Five new lessons in it, adapted with permission from Mallee HydroTech\'s open training tools and credited on each '
        + 'tab: <strong>🪧 Staff Simulator</strong> (reading a levelling staff, marked as you go), <strong>📓 Survey '
        + 'Logbook</strong> (keeping and reducing a level book), <strong>♻️ Site Lifecycle</strong> (the life of a '
        + 'monitoring site, with scenarios to decide), and <strong>🏞️ Levelling Day</strong> and <strong>🛶 River Visit '
        + 'Day</strong> (a survey day and a routine site visit, step by step).',
    ] },
    { n: 22, date: '2026-10-09', items: [
      '<strong>📈 Station Health: All stations — sparklines.</strong> A new card lists every sensor heard in the window, a row '
        + 'each — the station\'s number and name, the sensor, and a sparkline of its readings across the same days — with '
        + 'the latest reading beside it. A sensor or station with a warning is highlighted the way the rest of the tab '
        + 'highlights it, its worst finding named, and those come first: a battery whose night lows are sliding shows its '
        + 'trend line and how fast it is falling. Pick a kind of sensor, show only those needing attention, or find a '
        + 'station by name or number; point at a line for a reading, and press a station\'s name to open it at that sensor.',
    ] },
    { n: 21, date: '2026-10-09', items: [
      '<strong>📊 ARRO Data is now <em>Plots</em></strong> — same place in <em>Data</em>, same chart, and it can now be '
        + 'drawn on. <strong>ƒ(t) function</strong> on the toolbar draws a function you type over the readings '
        + '(<code>t</code> is hours, <code>d</code> days — <code>2.4 + 0.05t</code>, <code>3·exp(−t/36)</code>, or a '
        + 'plain number for a horizontal line).',
      '<strong>Fit a curve to readings you pick.</strong> Set <em>Drag does</em> to <b>Select</b>, drag a box over a '
        + 'stretch, and <b>fit a curve</b>: a straight line, quadratic, cubic, exponential, a recession to a baseline, or '
        + 'whichever of them fits best — drawn solid over the readings and dashed past them, with its equation and r². '
        + '<b>Draw</b> sketches freehand on the chart and <b>Ruler</b> rules a straight line labelled with its slope per '
        + 'hour. All of them are listed under <em>Your lines</em> and go into the PNG and SVG downloads; Field Data has '
        + 'them too.',
    ] },
    { n: 20, date: '2026-10-09', items: [
      '<strong>📏 Level Survey</strong>, in a new group, <em>Surveying</em>: a station\'s levels surveyed on a phone. Book the '
        + 'run rise and fall a sight at a time and it is reduced as you go — the three checks, the misclose, the gauge boards '
        + 'against their face values, the water check — with a final field check saying what is left. It works with no '
        + 'signal, keeps everything on the phone, and sends it to Flood-Net, filed under its station, when there is one.',
      '<strong>📷 Read it off the display.</strong> Beside every reading, the camera reads the number off a digital level\'s '
        + 'screen for you to accept or correct, and keeps the picture — cut to the screen and compressed to tens of '
        + 'kilobytes — as the evidence behind the number. It reads a level\'s serial plate the same way, and your levels '
        + 'and staffs are kept in a list to pick from.',
      '<strong>🎯 Two-Peg Test</strong> and <strong>📖 How to Survey</strong>: the collimation check with its error worked out '
        + 'as you go, linked to the surveys done with that level; and a step-by-step refresher, with a worked example to '
        + 'practise on.',
      'Surveys export as an <strong>Excel workbook</strong>, a CSV, or a package with every photo. An administrator reviews a '
        + 'filed survey and applies what it found — gauge zero, benchmarks, the sensor reference, an offset correction — to '
        + 'the station; gauge zero is now an administrator\'s to change.',
    ] },
    { n: 19, date: '2026-10-09', items: [
      '<strong>Fade margins, calibrated against the whole network.</strong> The field allowance is now fitted to every '
        + 'station\'s attenuator tests on file — several hundred stations, not one region\'s — and is '
        + '<strong>12 dB</strong>. Most figures go up a few decibels. A test is read as the step its attenuator took: '
        + '3 dB on most, 1 dB where a reading is off that grid.',
      '<strong>📐 Network Review: the model against every attenuator test.</strong> One button prices every tested '
        + 'station\'s paths and shows how far the model is out — by distance, by hub and by basin — and names the hubs '
        + 'whose stations all read 10 dB better or worse than modelled: a mast, an antenna or a position the register '
        + 'is missing. The register panel also checks each repeater and base against the 5 m LiDAR.',
      '<strong>LiDAR, where it matters.</strong> The link budget card can price a path over Geoscience Australia\'s '
        + '5 m LiDAR round its ends and wherever the ground comes near the line of sight, with ~30 m terrain between. '
        + 'It is a setting, not the default: held against the field\'s tests it was no better, until the register\'s '
        + 'positions and heights are as sharp as the ground.',
    ] },
    { n: 18, date: '2026-10-08', items: [
      '<strong>🎓 Radio Propagation</strong>, a new tab under <em>Start here</em>: how radio carries a reading from a '
        + 'gauge to a base, in pictures that move. A 3-D catchment shows the wave spreading in every direction, the '
        + 'shadow behind a mountain, trees that are nearly transparent at 150 MHz, echoes off silos and a scarp, and '
        + 'repeaters relaying what they heard — a flipped bit becoming a ghost address. Below it: echoes adding up or '
        + 'cancelling, a path over a ridge at four frequencies, two keyings colliding bit by bit, and why repeaters wait.',
    ] },
    { n: 17, date: '2026-10-08', items: [
      '<strong>Fade margins, calibrated against the field.</strong> The link budget card, the fade-margin map, the '
        + 'profile\'s readout and polar coverage now price a path with Longley–Rice over the terrain, less a '
        + '<strong>16 dB field allowance</strong> fitted to attenuator tests on site — instead of standing the land cover '
        + 'on the profile, which read tens of decibels too low. Repeaters and bases are modelled on a 10 m mast, and an '
        + 'end surveyed below the terrain tiles is stood on them. Most figures go up, and now sit within a few decibels '
        + 'of what the attenuator finds — read as the 3 dB steps it finds them in; the old land-cover model is still in '
        + 'the card\'s propagation settings.',
      '<strong>📐 Network Review</strong>, a new tab for administrators under <em>Admin</em>: every field station\'s '
        + 'fade margin to every repeater, base or proposed site at once, beside what the attenuator last measured — and '
        + 'how Flood-Net\'s figures compare with Radio Mobile\'s.',
    ] },
    { n: 16, date: '2026-10-08', items: [
      '<strong>📸 Field Camera</strong>, a new tab under <em>Site visits</em>: take site photos in Flood-Net, each '
        + 'stamped the way Solocator stamps them — the compass ribbon and the heading (true north), the position and its '
        + '±, the height and its datum, the town and the time — with the <strong>station</strong> on it too. The station '
        + 'is suggested from where you stand and which way the camera faces; tap another to change it.',
      'Every photo is kept on the phone first, so a site with no signal loses nothing, then <strong>uploads by '
        + 'itself</strong> into Field Photos under that station as soon as there is a signal and you are signed in — the '
        + 'list on the tab says where each one is. <strong>📷</strong> uses the phone\'s own camera app instead, and is '
        + 'stamped the same way.',
    ] },
    { n: 15, date: '2026-10-08', items: [
      '<strong>📡 Polar radio coverage in 3-D.</strong> A coverage plot now lies on the ground when you tilt the map '
        + 'with ⛰️ — running up the valleys and stopping at the ridges — in the same colours, and a new threshold '
        + 're-colours it in place. It is still the best case: no antenna patterns, no trees.',
    ] },
    { n: 14, date: '2026-10-08', items: [
      '<strong>ALERT2 / ERT-A2</strong> now reads the receiver\'s lines by the ALERT2 specification. An ALERT2 '
        + 'gauge\'s own report — battery, stage, rain and the rest — is decoded and sent instead of being thrown away '
        + 'as corrupt, frames received after noon keep their own time instead of landing twelve hours early, and '
        + 'test frames are shown as test. The Serial Monitor\'s ERT-A2 card does the same, and says whether the '
        + 'network\'s time stamps are UTC or local time.',
    ] },
    { n: 13, date: '2026-10-08', items: [
      '<strong>🚗 Directions</strong> on the station card, beside <em>Copy lat, lon</em>: one press opens driving '
        + 'directions to the station from wherever you are — in Apple Maps on an iPhone, iPad or Mac, and in Google '
        + 'Maps anywhere else.',
    ] },
    { n: 12, date: '2026-10-08', items: [
      '<strong>Reset north in the digital twin.</strong> The compass in the top right of the 3-D view is now a '
        + 'button: press it to turn the view back to face north, keeping its tilt.',
    ] },
    { n: 11, date: '2026-10-08', items: [
      '<strong>Ask Claude</strong>, in <em>Station Health</em>, is now the <strong>AI briefing</strong>, and works with '
        + 'the AI of your choice. Where Claude cannot be reached — a network that blocks Anthropic — or you use '
        + 'another AI, such as Copilot, <strong>⤓ Download the briefing pack</strong>: one text file with the '
        + 'instructions, the findings and the stations that need attention in full. Attach it to a chat and ask the '
        + 'AI to follow it, then paste its answer back into the card to see the stations as links. It is under '
        + '⤓ Export too.',
    ] },
    { n: 10, date: '2026-10-07', items: [
      '<strong>Airtime</strong>, in <em>Station Health</em>: which stations\' transmissions land on top of each other at '
        + 'each base station, and whether the ones that do come with more corrupted copies. Every hour of the week laid '
        + 'over one shows the busy minutes — often the top of the hour — and who checks in them.',
      'Each station\'s <strong>check time</strong>, learned from what was heard, and how its logger seems to keep it: '
        + 'steady, drifting, jumped after a restart, or randomised. Where two stations\' checks keep landing together, '
        + 'it suggests the <strong>nearest clear time to move one to</strong>, and how to set it for that kind of '
        + 'logger — and which pairs of repeaters to give <strong>different delays</strong>. <strong>Export check '
        + 'times</strong> saves the list as a spreadsheet.',
    ] },
    { n: 9, date: '2026-10-07', items: [
      '<strong>🗺️ Radio Path Maps lists the maps on the right</strong> instead of leaving it blank: every map, '
        + 'each with its region, catchments, radio networks, the places it covers, its sheet size and date, and a '
        + 'small picture of the sheet so you can spot one by its look. The basin drawing, the region chips and the '
        + 'search box on the left filter the list; a station search puts the maps that station is likely to be on '
        + 'first and says why. <strong>Tiles</strong> shows the pictures big, <strong>Sort</strong> orders by '
        + 'region, name or newest, and <strong>‹ Back to list</strong> leaves a map.',
      'Maps now open inside Flood-Net on floodwarning.net — the site had been refusing to show its own PDFs '
        + 'in the viewer.',
    ] },
    { n: 8, date: '2026-10-07', items: [
      '<strong>The 3-D map says how to move it.</strong> Opening ⛰️ 3-D puts a hint at the foot of the view — '
        + 'drag to move, right-drag or Ctrl-drag to turn and tilt, wheel to zoom (on a phone: pinch, twist, and two '
        + 'fingers up or down to tilt) — which folds to a <strong>?</strong> after a few seconds; the '
        + '<strong>?</strong> brings it back. The 🎚️ 3-D panel lists the mouse, touch and keyboard controls too.',
      '<strong>The digital twin now moves the same way as the 3-D map.</strong> A drag moves the ground and a '
        + 'right-drag (or Ctrl-drag) turns and tilts — it used to be the other way round. The arrow keys move it, '
        + 'Shift with them turns and tilts, a double-click zooms in, and on a phone one finger moves it, a twist '
        + 'turns it and two fingers slid up or down tilt it.',
      'The <strong>compass</strong> and <strong>tilt</strong> buttons under ⛰️ now work on the digital twin '
        + 'too: face north, look straight down, and back. The twin\'s Orientation button is now '
        + '<strong>🔄</strong>, so 🧭 means "face north" everywhere.',
    ] },
    { n: 7, date: '2026-10-07', items: [
      '<strong>📲 Offline &amp; Install</strong>, a new tab under <em>Start here</em>: what Flood-Net does with no '
        + 'signal, what this device has saved and when, <strong>Get this device ready for no signal</strong> to save '
        + 'the rest in one go, and how to put Flood-Net on your home screen in the browser you are using — with an '
        + '<strong>Install</strong> button where the browser offers one. It also says plainly what does not work with '
        + 'no signal.',
      'One visit with a signal is now enough: the station list and the inspection sheets\' pick-lists are saved '
        + 'along with the app.',
    ] },
    { n: 6, date: '2026-10-07', items: [
      '<strong>Opens with no signal.</strong> A device that has opened Flood-Net before opens it again out of range, '
        + 'with the station list it last had — the header says it is a <strong>saved copy</strong>, and how old — and '
        + 'the inspection and maintenance sheets ready to start. On a phone it can be added to the home screen, and '
        + 'opens like an app.',
      'A page opened from the saved copy looks, once there is a signal, for a newer version, and says when there is '
        + 'one — <strong>Reload now</strong> or <strong>Later</strong>. It never reloads by itself, so a sheet half '
        + 'filled in is never lost.',
    ] },
    { n: 5, date: '2026-10-07', items: [
      '<strong>⤓ Export</strong> in the banner: what the tab you are on can save as a file, in one place — the station '
        + 'list as CSV, GeoJSON or KML (with the filters you have set), a chart, a table, a drawing. A tab with nothing '
        + 'to save says so, and why.',
      'Every file Flood-Net saves is named <strong>floodnet-…</strong>, so a download folder sorts them together.',
    ] },
    { n: 4, date: '2026-10-07', items: [
      '<strong>A station\'s health on its card.</strong> Under its owner, a station\'s card on the Stations map says '
        + 'when it was last heard, how its battery is doing night to night, and what is wrong with it — each line opens '
        + '<em>Station Health</em> on that station.',
      '<strong>Colour pins by health</strong>, in 🗺️ Map display: every pin OK, watch, fault or no data — with its size '
        + 'and a ring as well as its colour, and a key in the legend.',
    ] },
    { n: 3, date: '2026-10-07', items: [
      '<strong>No more browser pop-ups.</strong> Where the browser used to stop the page to ask <em>OK or Cancel?</em>, '
        + 'Flood-Net asks in a dialog of its own, and the button that acts says what it does — <em>Delete the station</em>, '
        + '<em>Revoke the token</em>, <em>Remove the drawings</em>. How something went is said in a note at the foot of the '
        + 'window; a failure stays there until you dismiss it.',
      'On a phone, or in a browser without Web Serial, the nav marks the <strong>Serial Monitor</strong> 🖥️: it needs '
        + 'Chrome, Edge or Opera on a computer to reach a device on a cable.',
    ] },
    { n: 2, date: '2026-10-07', items: [
      '<strong>Flood classes on the charts.</strong> On <em>ARRO Data</em> and <em>Field Data</em>, a level series\' card '
        + 'has <strong>Flood classes</strong> and <strong>AEP levels</strong>: tick either to draw the station\'s minor, '
        + 'moderate and major levels, or its AEP levels, as labelled lines across the chart — and into the PNG and SVG '
        + 'exports. Each is drawn in the series\' own datum, on the gauge or in metres AHD; one that cannot be placed '
        + 'is left out, and the card says why.',
    ] },
    { n: 1, date: '2026-10-07', items: [
      '<strong>The address bar says where you are</strong> — the tab, the station whose card is up and the map\'s '
        + 'view — so a bookmark, a reload or a link sent to somebody opens exactly that. <strong>🔗 Copy link</strong> on a '
        + 'station\'s card makes one. Back and forward move between tabs and stations.',
      '<strong>🔎 Search</strong> in the banner, or <kbd>Ctrl</kbd>+<kbd>K</kbd> anywhere: a station by name, number or '
        + 'ALERT address, a place, a tab or an action, in one box.',
      '<strong>Loading says what it is doing</strong> — which source it is asking and how much has arrived — and if '
        + 'nothing answers, what was tried, with <em>Try again</em>.',
      'A first visit opens the <strong>Site Map</strong>, the app\'s guide to every tab. After that the app opens on '
        + 'the tab you used last.',
      '<strong>🌗 Theme</strong> follows this device\'s light or dark setting unless you pick one — and there is a '
        + 'fourth, <strong>Sunlight</strong>: black on white with heavier lines on the map, for a screen read outdoors.',
    ] },
  ];

  const latest = () => ENTRIES.length ? ENTRIES[0].n : 0;

  function seen() {
    try { return Number(localStorage.getItem(SEEN_KEY)) || 0; } catch (_) { return latest(); }
  }

  function markSeen() {
    try { localStorage.setItem(SEEN_KEY, String(latest())); } catch (_) {}
    sync();
  }

  const unseen = () => ENTRIES.filter(e => e.n > seen());

  function sync() {
    const btn = document.getElementById('btn-whatsnew');
    if (btn) btn.hidden = !unseen().length;
  }

  function dateText(iso) {
    const d = new Date(`${iso}T00:00:00`);
    return Number.isNaN(d.getTime()) ? iso
      : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  // Every entry, newest first, the unseen ones marked — then they are seen.
  function open() {
    const fresh = new Set(unseen().map(e => e.n));
    Modal.open({
      title: 'What\'s new in Flood-Net',
      html: `<div class="wn">${ENTRIES.map(e => `
        <section class="wn-entry${fresh.has(e.n) ? ' is-new' : ''}">
          <h3 class="wn-date">${esc(dateText(e.date))}${fresh.has(e.n) ? ' <span class="wn-tag">new</span>' : ''}</h3>
          <ul>${e.items.map(i => `<li>${i}</li>`).join('')}</ul>
        </section>`).join('')}</div>`,
    });
    markSeen();
  }

  // init.js, once.
  function start() {
    if (typeof Route !== 'undefined' && Route.newDevice()) markSeen();
    else sync();
  }

  return { start, open, entries: ENTRIES };
})();
