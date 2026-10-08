# `test/` — the web app's safety net

Built for [#130](https://github.com/cdomotor-g/MegaNet/issues/130), which gates the
`app.js` decomposition ([#129](https://github.com/cdomotor-g/MegaNet/issues/129)).

Before this existed, the entire mechanical check available to anyone editing the
front end was `node --check app.js`. That proves the braces balance. It cannot
see a function that moved out of scope, a namespace that lost a member, a
duplicate top-level name quietly overwriting a helper, or an `onclick` naming an
identifier that no longer resolves — which is every failure mode the split
risks, and the two live TDZ crashes in
[#131](https://github.com/cdomotor-g/MegaNet/issues/131) besides.

## Running it

```sh
cd test
npm install                       # once
npx playwright-core install chromium   # once, if no browser is present
npm run all                       # the eighty-nine that run in CI
```

| Command | What it does |
|---|---|
| `npm run check` | `node --check` over every script `index.html` loads |
| `npm run names` | no duplicate top-level declarations across those scripts |
| `npm run toplevel` | `init.js` is still the only file that executes at load |
| `npm run brand` | nothing a person reads says MegaNet: every string literal in the app, the Worker, the SDR Pi and the photo syncs (acorn-tokenised, so comments are not read), no download named `meganet-…`, and `index.html`, `about.html`, `llms.txt`, `robots.txt`, `docs/agent-api.md` and the five agent files. The repository's URLs, the Quansheng station-table tag and the API's legacy `X-MegaNet-Client` are the allowed exceptions. Parse-only |
| `npm run itm` | the Longley–Rice port against 53 reference losses from NTIA's own compiled library (`baseline/itm-vectors.json`), to 10⁻⁶ dB with every intermediate |
| `npm run pathcover` | the elevation profile with ground cover on it and the Longley–Rice budget over it, on a flat terrain tile the check makes itself and a seeded land cover — the band, the verdict, the rows that add up, the terminal-clutter term, the height table, the switch and the propagation settings |
| `npm run hfem` | the HFEM codec against the spec's own ten worked examples, its timestamp table and its undefined-scheme list — round trips byte-for-byte, every rejection asserting its reason |
| `npm run logger` | the base station program against the migration it posts into — `logger/base-station-http.CR300` is the one file here no CI can compile, so this holds the two things that can be held without a compiler: that it and `db/migrations/0026` name the same rig (a station number, a protocol key, four channel names and an ALERT address, agreed across a CRBasic `Const` and a SQL insert with nothing enforcing it), and that its ALERT2 self-test frame decodes back to the address it was built for across the whole 13-bit range — including the trap that an address above 8191 wraps into the value field rather than failing. Plus the units against `meganet.unit`, both JSON shapes actually parsing, balanced blocks, every `Call` naming a `Sub` that exists, and the plain-ASCII-with-LF rule the file states about itself |
| `npm run alertdsp` | the off-air ALERT decoder (`alert-dsp.js`, ported from agmurf/sdr-alert-decoder) against a real off-air burst of the 4078 ERT-A2 test rig (`test/fixtures/sdr/testrig_burst_240k.iq8`, from that repository): 4079 = 420 and 4080 = 121 under Enhanced iFLOWS as the original's own test requires, the rig's frames' CRC-6, nothing from the burst read as Binary (one format at a time), noise clearing no vote bar even with the carrier search bypassed, synthesised bursts in every format and both polarities, the demo band's five readings and its one-bit shadow, and the live pipeline — a 960 ksps stream with the channel 50 kHz off centre gated, decoded once, and reporting spectrum, level, scope and capture |
| `npm run quansheng` | the Quansheng ALERT receiver codec (`quansheng.js`) against every example line in the firmware's own `docs/ALERT_SERIAL.md` — the four line classes, the HDR schema, DEC/BST/STA/EVT by name, each payload re-decoding to its DEC, each BST's bits to its frames, the console replies, the screen, the binary frames byte for byte — and the station table it builds from this repo's `stations.json` against the firmware's own lookup over all 8,192 addresses |
| `npm run logfollow` | following the log file PuTTY writes instead of a COM port (`log-follow.js`, the Serial Monitor's log-file source and ERT-A2 card, the ALERT2 tab's Watch), in Chromium, under the policy a managed browser has — `showOpenFilePicker()` and `FileSystemFileHandle.getFile()` refusing with `NotAllowedError`, as they do with `DefaultFileSystemReadGuardSetting = 2`. Real files dropped through CDP's `Input.dispatchDragEvent`, then grown, truncated and replaced on disk: a generic card (lines as they are appended, Stop following / Follow again with nothing read twice, a log PuTTY started again read from the top), a Quansheng radio's log dropped anywhere on the tab (recognised from its contents, the dashboard filled, nothing written to a port, the console copying for PuTTY, a `GET` reply read into the settings), an ERT-A2's RS232 log (every reading decoded and matched to a station, a new line a new reading, *Open in the ALERT2 tab* handing over exactly the frames heard) and its USB port logged raw (the binary framing, RSSI on every reading), a dropped folder following its newest log and moving on to a new session's, *Read it once* taking only what was added, the picker's refusal saying to drag instead, a file dropped off the tab not navigating the page away, and the ALERT2 tab watching a dropped log as it grows. A Raspberry Pi's log (the relay run on the demo band) dropped on a waiting card: recognised, an RTL-SDR card in its place, the history's readings untimed and never timed "now"; live records appended in steps — a reading held until two seconds of the Pi's uptime have settled the clock, then timed by it, and a reading the Pi queued before them timed 3.5 s earlier, when it was heard; the controls copying `FREQ …` for PuTTY, three changes waiting as one `CFG` line, the Pi's `CFG` answer clearing them and an `ERR` said on the card; and, with an RTL-SDR card waiting for a Pi, a radio's log dropped on the tab still becoming a radio card, a Pi's log going to the waiting card with no other card made, and a log PuTTY has only just started (nothing in it yet) going there too and read as the Pi starts talking. Several channels on the Pi's one stick: the card's *Channels* box copying the tuning that hears four as one `CFG` line, the Pi's answer giving each channel a chip, a labelled band and its readings their channel, a rate too low for them refused on the card, the same list typed again changing nothing, and a log joined after the Pi's last `CFG` reading its channels off `STAT`. It also prints, without asserting, that a picked `File` cannot be read again once the file changes — the reason a drop is used |
| `npm run serialingest` | a Serial Monitor receiver card as a base station (`serial-ingest.js`, `0045`), in Chromium, with `/rpc/ingest_http` and `/rpc/report_ingest_point` stood in for by routes that record each request and answer as the real functions do (`tools/check_ingest_points.sql` holds the real ones to that contract in Postgres). Logs dropped through CDP and grown on disk: the receiver reporting its own id, kind and a location typed in (longitude-first turned round), from the browser's geolocation with its accuracy, and from a station — each as approximate with no GPS; the token in `X-Ingest-Token`, never `Authorization`; a live Quansheng reading posted as source `serial`, protocol `alert`, on `serial-monitor/<id>`, with its arrival time and its DEC line as the frame; a new card of the same kind resuming as the same receiver; a reading from a log's history going with the radio's own time and one with none skipped and counted, never stamped now; a refused token stopping, saying why, unticking the box and keeping what was waiting, then sending it once back on; an ERT-A2 log posted as `alert2` with each frame's own time of day on the receiver's date; a demo card offering no switch and sending nothing; and the Admin tab's **Ingest tokens** panel (`0046`), with Auth stood in for an administrator — a token minted under its label and shown once, *Use in this browser* handing it to the Serial Monitor's cards, *Done* taking it off the screen, the list, and *Revoke…* after a confirm. And a base station **asking** for its token (`0048`), both ends: a card with no token offering *Ask an administrator*, asking with a token the browser made (`mgn_` + 64 hex, in `X-Ingest-Token`), showing the code, keeping no token until approved, then keeping it and starting the card that asked, and *Stop asking* withdrawing the request; on the Admin tab, the request appearing by itself within a poll with its code and device line, a taken name offered as a replacement and not sent until that is ticked, approve and deny, and the Pi's QR link (`#pair=CODE`) opening that request — asking to sign in first, then with its form open, approving nothing by itself |
| `npm run basestations` | the **Base Stations** tab (`base-stations.js`, `0049`), in Chromium, with its eight database calls stood in for by routes that record each request and answer as the real functions do (`tools/check_base_stations.sql` holds the real ones to that contract in Postgres), and the database's clock ten minutes off the browser's. The pure parts first: a station online, quiet, offline, turned off or not managed by its own check-in interval; what needs a look, worst first and never the GPS; the settings form untouched being no change, a changed one the smallest patch — each stick's own settings rebuilt as the station builds them — and a frequency out of range refused. Then the tab: signed out, and signed in without being an administrator, it says what it is for and asks the database nothing; an administrator gets the list with each station's state, host station, receivers and what needs a look, and the team keys; *Open* asks for the whole status and the fast check-ins, and draws health, receivers, uplink, software, SSH access by fingerprint, settings, the log it sent and the requests; every button sends exactly its request — a receiver's key with both kinds of quote in it, and a confirmation with an apostrophe, included — and a confirmation said no to sends nothing; the settings form sends the smallest patch, refuses a bad frequency on the form, keeps what is typed and where the keyboard is through a poll, and says it sent in a note a repaint does not wipe; a queued request cancelled by its id; a station that only reports offering nothing to ask; a refusal from the database (`PT429`) shown rather than swallowed; a team key added and taken off after asking; leaving the tab stopping the polling; and a database without `0049` told so |
| `npm run reception` | the Reception Map (`reception.js`), the reception log every receiver card writes (`reception-log.js`) and the GPS card (`serial-gps.js`), in Chromium. The oracle is a drive whose answer is known: `Reception.demoDrive()` builds one against the real registry — two real repeaters relaying the same stations, one made to flip a bit in a third of what it relays — and the analysis must name that one first by pass ranges alone (positions stripped) and with positions, with its bad copies' RSSI falling with distance from it (r < −0.5) and the power-weighted centre of the bad copies nearest it. Plus NMEA (GGA, RMC, a failed checksum refused), a GPS card fed real sentences placing an ERT-A2 card's receptions — good and bad — as exact, the log through CSV and GeoJSON and back to the same answer, and the tab drawing its map and ranking the culprit first, and the stored readings — a row and its further paths as copies, a station's own two sensors in one burst not a flip, a corrupted copy nine seconds late found, a ghost on another station's address told from two stations that only look alike by each address's own reports, a storm's tips kept as reports, and the tab reading them from the datastore (stood in for) |
| `npm run airtime` | the Airtime panel's reasoning (`airtime-analysis.js`), in Node, on networks built transmission by transmission: the circle two checks share is the gcd of their periods (a 1-hour and a 3-hour station on one minute meet every 3 hours; two 3-hour stations an hour apart never do, though the folded hour stacks them; 2 h and 3 h meet every 6), how a logger keeps time (steady, drifting at 40 s a day and placed where it is now, jumped four minutes with when, randomised and left out of the clashes, too few to tell), damage riding on the transmissions that land together read as a ratio and spread evenly as none, the pairs that keep landing together counted once a moment across channels with their usual minute, one burst said and whole seconds not, three on one slot — the one doing best stays, two moved to whole half-minutes clear of each other and everything heard there by a minute or more, told how for their clock — a drifting check said before it arrives, repeater pairs with no delay whose shared stations carry the corrupted copies told apart with the Backbone's values (not when 150 ms apart, not on different channels), and from Station Health's result an unfiled address riding with a station kept as that station's and a ghost as its twin's. Confirmed red on three deliberate breaks |
| `npm run health` | the Station Health tab (`health.js`, `health-analysis.js`, `health-agent.js`, and the Airtime panel's one planted clash — found, said to hurt, its station moved, nothing else) and the values the Message Log works out for raw counts (`sensor-values.js`), in Chromium with the datastore stood in for by a route. The oracle is a week whose answer is known: `HealthAnalysis.demoWorld()` builds one against the real register with one of every fault planted once — a station that stops, a battery sliding, one with no charge, one missing more checks each day, one dropping its battery frame, one relayed with bits flipped, a rain gauge dry through a storm, a receiver outage, three neighbours gone overnight, a ghost — and each must be found where it was planted, the stations left alone with nothing worse than a note. Plus battery 133 shown as 13.3 V and marked as worked out, a far address called far, a 3-hour schedule read off its gaps through a two-day silence, a storm's tips kept as reports, a ghost on a station's own address set aside and look-alikes kept, the tab fetched twelve hours at a time, a filter, each station's owner (its own, else the SLS's) under its name and the header's owner filter narrowing the page to that owner's stations and back, a station and a missed check opened in context, the door to the Reception Map, the agent's tool loop against a scripted client (a tool that does not exist refused, saying why); the AI briefing's pack for another AI — Anthropic out of reach saying so and pointing to it, each station with a warning or worse in full with its last visit and neighbours, under Claude's own instructions with the two paragraphs about tools swapped out, downloaded as `floodnet-health-briefing-pack-….txt`, and the other AI's answer pasted back (surviving a redraw) drawn as the briefing with its station a link; Claude on Flood-Net's key (#229), the route stood in for: a signed-in editor offered it with today's spend and no key field, nothing announced for asking, the call sent through the route with the session as it is now and a planted key dropped, its body one the Worker's own check (`requestProblem`) accepts, the day spent turning the panel to the person's own key and that key used alone, a viewer and the signed-out offered their own key with the route not asked, and only there a box to remember it — about the device, unticked, honoured only when ticked; and no sideways scroll at 375 px |
| `npm run healthcard` | a station's health where people already look (#218, `health-glance.js`): its card on the Stations map and its pin, in Chromium with the datastore stood in for by `lib/postgrest-stub.mjs` — the strict PostgREST the agent API is held to, so a query the real one would refuse fails here too — answering from `HealthAnalysis.demoWorld()`'s week and a `station_health` built from it. The rules first: a quiet station a watch from two of its checks and a fault from four or a day (from 6 h and a day while its period is assumed to be three hours), a warning a watch and a critical finding a fault however recently heard, a note colouring nothing, never heard "no data" whatever else is said, and a station heard across less than two of its checks "no data" too, not a fault — 115 of the live network's 503 had been heard exactly once. Then the card, with **one request** (the station's own rows and ALERT addresses, newest first, at most 1,000) and none for a repaint or a second look: a sliding battery's last-heard time, night lows falling and when they reach 11.8 V, its findings worst first, a watch; a silent station a fault saying the receivers are Station Health's to weigh; one left alone OK; one heard only by the ingest, its readings aged out; one heard once, two days ago, no data and saying why; and one never heard — each of the last three a second, one-row look at `station_health`, and only those; a proposed station no section at all. Each line a door into Station Health at its own part — the battery chart, the findings — focused and in view, the address `?tab=health&station=…` and a reload of it landing on the same station, and a station the window holds nothing from said to be so. **Colour pins by health** off by default and asking nothing; switched on by a real click in 🗺️ Map display, **one request for the whole network** through four rebuilds, a theme change and the tab re-entered; every pin a class, never by colour alone (bigger is worse, a dashed or heavy black ring, no data hollow and dotted), its key in the legend in place of the role key, the counts in the note, the map's name and the announcement, a pin following its card the moment the card finds something, the #162 twin's older row losing to the newer, and switched off the roles' colours back. A datastore that refuses (401) and one that cannot be reached: every pin no data, the card saying which with Try again, Try again and ↻ Ask again answering once it is back. And the card's health lines inside a 375 px screen |
| `npm run rtlsdr` | the RTL-SDR WebUSB driver (`rtlsdr.js`) against a simulated dongle (`lib/fake-rtlsdr.mjs`, shared with `sdrpi`) — a register file answering like the RTL2832U, an R820T or R828D (bit-reversed reads, a PLL-lock bit) and an EEPROM: sample-rate ratio, the IF each bandwidth implies, PLL registers, the gain walk, GPIOs; a V3's Q-branch direct sampling below 24 MHz, a V4's upconverter, three inputs and notch filters, a generic R828D's 16 MHz crystal; a V2's FC0013 (zero-IF, offset-tuned, its PLL bands, VHF tracking filter, VCO re-selection and 23 gain steps) and an FC0012 (found only after the GPIO 4 reset, its GPIO 6 band filter); the EEPROM-forced bias tee on a V3 only, never on a generic stick, the errors that name the DVB driver, the Windows driver installer and Zadig, and that installer (`tools/install-rtlsdr-driver.cmd`) itself: plain ASCII with its batch-then-PowerShell header, looking for exactly the sticks `FILTERS` asks the browser for |
| `npm run sdrpi` | an RTL-SDR on a Raspberry Pi, read through PuTTY's log (`sdr-pi.js`, `sdr-pi/relay.js`; `docs/sdr-pi.md`), Node only. **The codec**: every setting parsed and refused as the console does (a frequency between 2000 and 100000 refused, not guessed; never `IFLOWS` for Enhanced iFLOWS), every setting through a `CFG` line and back, the card's settings to the Pi's and back, the commands each control sends, BIAS ON needing YES; the spectrum, ADC histogram (a single clipped sample still drawn red) and symbols packed and unpacked; the `Reader` fed one byte at a time and in odd pieces — records, hidden `OSC 7355` records cut in half, echoed typing with backspaces, finals, a window title, `ESC \`, a field `FIELDS` appended. **The relay**, run on recordings: the demo band's five readings named from `stations.json` as the radio names them, each tied to its burst, the one-bit shadow set aside, level/spectrum/trace hidden and readings not; the 4078 rig's real burst — 4079 = 420 and 4080 = 121 under Enhanced iFLOWS, CRC good. **Its console** over stdio (each command one OK or ERR, in order; a CFG line; TIME stamping what follows; settings kept across a restart), over TCP Raw (not echoed) and Telnet (WILL ECHO, echoed), and over a pseudo-terminal opened as `--serial` — PuTTY's place — with typing echoed and a two-line paste (python3; skipped without it). **The USB path**: the simulated V3 opened through `rtlsdr.js`, streamed, retuned, regained, bias tee on GPIO 0, the rate changed, an impossible frequency refused, the stick "unplugged" and found again, the tuner put to standby on stop. **Several channels on one stick**: `more` and `CHANNELS` parsed and refused (a frequency twice, even in two formats; channels too far apart for one stick), the networks' four channels tuned to 1.92 Msps around 151.85 MHz (every one inside the band, 50 kHz or more off the DC spike, none on another's mirror image) and 100 random sets tuned as well, the band check the relay and the card share, `STAT`'s `chans` packed and read back; a 960 ksps recording with stations on four frequencies decoded by a decoder each — every reading on its own channel only, two 25 kHz apart in the same instant included, the Enhanced iFLOWS one's CRC good, nothing from the frequency not listed; on the simulated stick, `CHANNELS` retuning it to 1.92 Msps with a decoder each, `MORE` outside the band refused, `MORE NONE` back to one |
| `npm run smoke` | loads the page in Chromium, opens all 28 tabs, asserts a clean console, audits every rendered `on*=` handler, and clicks the RF Changes / Workbench controls |
| `npm run registry` | every Leaflet map and every tab teardown is registered by the file that owns it — and actually fires |
| `npm run nav` | every tab is in the left nav exactly once, under one heading, and findable by its own label and by what it does — and the **Site Map** (`site-map.js`) that guides a newcomer round it: a card for every other tab, each written for the page rather than borrowed from its help, every job under *I want to…* opening a real tab, a journey stop per group; and its gold line, driven by a real pointer — a card, a related tab on a card and a group each lighting and ringing exactly their own place in the nav, a button below the nav's fold scrolled into it, the line gone when the pointer leaves, the same line from keyboard focus, the icon on the rail after `renderTabs()` has rewritten it, the svg off the page on leaving the tab, and on a phone ☰ in the banner — or no line at all once ☰ has scrolled away |
| `npm run shell` | the shell's landmarks, skip link, focus policy and disclosure state; the six-step breakpoint scale; and WCAG contrast for every token pair in all three themes (light, dark and, since #224, Sunlight) |
| `npm run tabs` | EPIC #107's per-tab Definition of Done, per tab that claims to have been through a U-issue, measured over `<main>` **and the side panel's pane on screen** (where the Stations cards are): no inline styles, tables wrapped/captioned/scoped, scroll regions named, clickable rows keyboard-reachable, landmarks and controls named, headings stepping by one, and no sideways scroll at 375/768/1440 in both themes — plus the two pattern-level claims (the basin drawing's shortcut condition, and the ARRO chart's palette round trip), and Radio Path Maps' catalogue: the right pane opens on the list, every catalogued map has a row and a thumbnail that loads (a map added without `tools/build_map_thumbs.py` fails), a region chip filters it, and a filter change while a map is open goes back to the list |
| `npm run rivers` | the rivers layer on the Stations map: named, grouped, labelled, and every named river reachable as a real control without a mouse (Enter on 🗺️ in the side panel's strip, then Enter on the river) — with the geometry seeded, because Overpass is off-origin |
| `npm run roads` | the road reserve on the Stations map, and the intersections that were missing from it: the DCDB files the crossing square at a junction under a parcel type of its own — `'Unlinked parcel or inter'`, truncated in the published field from *unlinked parcel or intersection* — so a layer drawing only `'Road Type Parcel'` left an unpainted hole at every junction, which reads as the one thing that is never true of a road reserve at an intersection. The cadastre is stubbed with a crossroads whose two roads stop dead at the square between them and share its four corners exactly, and the stub **honours the `where` clause** — without which the fixture would have drawn the junction whatever the app asked for and the whole file would have passed against the code it was written to fail against. Asserts the query asks for both parcel types, the junction is road reserve under the pointer, it names the two roads joined to its corners though it carries no name of its own, an unlinked parcel touching no road is refused, the note counts the two kinds apart, and a parcel in the bbox margin is drawn but not counted until it is on screen |
| `npm run survey` | the survey-marks layer on the Stations map: marks drawn, labelled with their register numbers and AHD heights, and the note counting only what the viewport actually holds — against a stub that answers exactly as the live SurveyControl service does: empty feature sets for any query carrying `resultRecordCount`, group layers whose `/query` can only 400, and every field name join-prefixed |
| `npm run mapctl` | the on-map panels put themselves away, on the Stations map at a phone's width (560 px) with its side panel told to decline its controls — the Stations map keeps only ↺ in its corner now, at any width, and what puts a control in a corner is the one question MapChrome asks the map's host, so the host is made to say no (as `claim` stands in for the datastore) and the contract is proved on the richest corner there is: a real pointer clicks a control inside Map display (a filter switch and a base-map switch) / Draw & measure, moves off, and the flyout has to go with it — plus the icon toggle, the keyboard's safety net, the pin as the only thing that persists, a tool armed from ✏️ that drew nothing with the click that armed it, and the corner's groups — then, with the host's own answer back, that corner holding ↺ alone, at its top right, at a phone's width and a wide one, and every other control in the side panel, the Map Generator's map still with its own corner flyout and a pin that docks it there — and the base maps as a blend inside 🗺️ Map display, in its pane of the side panel: two on at once, each at its own opacity off its own slider, stacked in list order, remembered across a reload, and an old single saved choice read as that base alone — and the stack reordered by a real pointer dragging a row's ⠿ grip and by the arrow keys on it, the map's z-order (labels included) following the rows, and the order saved and restored |
| `npm run help` | every tab's help entry is real content, every link out of the panel lands, and each walkthrough names itself and fits the side panel's help pane |
| `npm run insp` | the Inspections form renders what `meganet.inspection_form` says, on all six sheets — with the datastore answered out of the migration |
| `npm run maint` | the Council Maintenance Tasks form renders what the workbook's own filled sheet says — with the fixture read out of the `.xlsx` |
| `npm run history` | a saved record reads back as the sheet it was written on, and exports as it reads — with the records written by the app during the run |
| `npm run movepin` | the Stations tab's links and its move-pin mode: five pills in the editor card and every action on the station card a pin click opens — with no callout beside it on a desktop — the two document searches carrying the *reduced* station name rather than the raw one and asking for both spellings of the words that have two, and the mode armed, dragged with a real pointer, read back, cancelled and saved — plus the map's other interactive modes taken off on the way in |
| `npm run stationscard` | the Stations tab's **Copy lat, lon** pill and its collapsible station list: the coordinate on the clipboard read back for real, on the station card on the map (the station's recorded position) and in the editor card (whatever the two boxes currently say, which is what a dragged pin or a typed figure leaves there), the `execCommand` fallback that is the only clipboard path over `file://`, and the list and its filters as one card — the Filters toggle and + Propose / + New in its head, no <details> — the list shutting from its heading while the search box and the notes stay, keeping its live count on the heading and the selected station on the notes line, and being remembered across a tab change and a reload |
| `npm run riverdetails` | the Bureau's flood warning details (0031, 0032) on the station card and in the editor. The card's copy of the crossing-type legend, the datums and the Bureau's indexes against the rows `0031` and `0032` insert, every box the editor reads against a column its table has, and its three fields against the columns `0032` adds; the card naming the indexes that list the station and its AWRC number, stream and URBS label, showing the newest flood classification and the gauge zero in force with the rest under *Earlier*, and the flood effects shut behind a line that counts them, each height to the centimetre in the page's order — and nothing for a station the lists do not name; the editor's rows shut to one line, **+ Add** opening a row on top with the cursor in it, a removed row handing focus to its list's **+ Add**, a field sent trimmed or not at all when emptied, a figure the browser cannot read stopping the save by name, and — the one invisible when it breaks — a save sending only the lists that changed, because an untouched list resent through the browser's parse comes back with 94.50 as 94.5. At 375 px with every row open, nothing scrolls sideways and no box spills out of its row |
| `npm run floodlevels` | the AEP flood levels (0033) and the indicative flood velocity `flood-velocity.js` works out from them. The arithmetic off the page (Node's `vm`, no browser): Manning against a figure worked by hand, the critical-flow cap, no depth being no velocity, the channel bed as the gauge zero — but not a storage's, not an assumed datum's, not one 30 m down — the default slope by ground height and the bounds on a slope, a recorded setting with its entered roughness, and the module's default slopes against the ones the ingest wrote into `data/aep-levels.json`. Then in the browser: every box on an AEP row a column of `meganet.station_aep_level`; the card's *Flood levels (AEP)* section flagged modelled and indicative with a line per flood, the sheet's point 29 km from the station's said out loud, the velocity line straight after the wind region carrying the module's own figures, no velocity for a station with no level and nothing at all for one neither sheet names; the editor's read-only velocity beside the wind region, and a setting picked on the AEP row sending that list and only it. No sideways scroll at 375 px |
| `npm run frequencies` | a station's RX/TX frequency pairs (0033, `frequencies.js`): every box a column of `meganet.station_frequency`; the repeater's own pair as the primary row in `ef-rx`/`ef-tx`; an untouched form sending no list and the repeater's pair as it was; **+ Add frequency** putting a row at the foot with the cursor in its RX box, its count following, a blank one not being a change, a filled one going out exactly as typed with nothing else riding along; a use with no frequency, and a frequency that is not one, stopping the save by name; removing a row handing focus to **+ Add frequency**; a base station's section of its own with no primary row, none for a field station; the card listing every pair a line each. At 375 px with rows added, no sideways scroll and no box out of its row |
| `npm run land` | the land section on the station card and the *What is here* card (`site-land.js`), against the Queensland cadastre, address register, rural properties and land use services stubbed in their own shape: a freehold lot picked on *What is here* — lot on plan with its SmartMap link, *Private title — owner not published*, the council named as a council, address, rural property, area and land use with its year, a repeated parcel and a strata lot over it not read as second answers, four questions with the address asked by the lot's own lot/plan — then the station card at the same point answering from the same cache with nothing asked, placed right after the card's first section; freehold in public use given the hint *often public land … only the title says*, a ±5 m plot said, three addresses as the first and *2 more*, and a road on the line named beside the lot; a named reserve held *by the State, through a trustee — often the council* with the council named in the summary; a watercourse with the Water Act and its easement, no address asked; far outside Queensland nothing asked, and the DCDB's *New South Wales* pseudo-parcel read as not Queensland with only the parcel asked; a cadastre answering 500 named, nothing else asked, not re-asked on a repaint, and **Try again** from the keyboard getting the lot, then an address that never arrives read as *could not be read*, never *none registered*; a second open asking nothing, every query naming its fields, never more than three in flight. A named group adding no heading, every control named, links out in a new tab, no inline style, and no sideways scroll at 375 px |
| `npm run exposure` | the site exposure section on the station card (`site-exposure.js`), against the Queensland Government's map services stubbed layer by layer: in the tide on the Brisbane River every coastal row from its own layer — the Water Act limit on the station's own river over a nearer one on another creek, the finest acid sulfate soil map over a coarser one that disagrees, the national atlas's absence explained, the nearest sample site with its report — and the record's HAT put in AHD only through a gauge zero surveyed in AHD (an assumed datum, no zero, or a zero putting HAT at 133 m AHD each refused); near the tide, by a real pin click, the highest-tide-line bands and a national atlas class said to be inferred; inland, nothing coastal asked; on the shore, the 1 km edge with its caveat; across the Tweed, only coverage asked; far outside Queensland, nothing asked and *Not in Queensland* said in words; a storm tide map answering 500 and a soil map never answering each named as could not be read — never as "none" — not re-asked on a repaint, and **Try again** from the keyboard asking exactly those two with focus kept in the card; a second open asking nothing, never more than four in flight, a card that moves on dropping the old station's queue. A named group adding no heading, every control named, links out in a new tab, no inline style, and no sideways scroll at 375 px with every disclosure open |
| `npm run sls` | the Service Level Specifications on the station card (#180, 0038) — Queensland's and the one for New South Wales and the ACT: the bureau-number join with and without the document's leading zeros, and the flood class levels, prediction, priority and owner on screen being the ones in `data/sls-locations.json`; the card's first row always its owner — the station's own, else the SLS's marked *per SLS*, else *Not recorded*; the Manual pill saying so in words; an empty section, not a wrong one, for a station neither document carries. Each section's heading links to its document as the Bureau publishes it, in a new tab, with an accessible name that starts with the words on screen and a tooltip naming the edition the card quotes. A station the schedule gives two targets (PALMVIEW; NORTH MURWILLUMBAH, stacked in one cell) gets a line for each, its lead time beside its own trigger, and a service printed `TBC` in every column reads *To be confirmed* once. From the NSW document: an AHD gauge's classes in m AHD with its datum and AWRC number, two owners, a class the SES has not defined said in words and not called an irregularity, the `^` and `*` marks said in words with their meaning. GOONDIWINDI, in both documents and disagreeing, gets a section from each under its own heading, neither overwritten |
| `npm run stncard` | the station card on the Stations map (#175) and the gold leader that replaced the desktop callout (`map-leader.js`), at 1440 px and at 375 px: a real pin click paints the card without selecting and opens no callout; the leader leaves the card's top outline — straight up to a pin above it, round the corner to one beside it — and ends on a ring round the pin, and follows it through a pan, an animated zoom, a marker rebuild and a fanned-out stack (which holds while the card is on its pick); a pin the card covers gets no leader until `reveal()` moves it clear; the leader goes with the card; a *Repeaters listening* row pulses a ring round its pin; a filter change rebuilds the markers and leaves the card; *Station details* selects and scrolls the details card into view (opening the side panel on it), out of full screen first; the actions are four named, icon-led groups with a rule between them and nothing else in the section; × and Escape close it back to the opener and nothing passive reopens it; the station, ACMA and radio-path cards close each other; the phone callout is two pills inside the map's width with a finger-sized close button, and *Details* opens the card as a sheet with focus in it and its leader up to a pin the sheet is not covering; the legend names the layers that are off and the one-time 🗺️ tip shows once, saying the button is in the side panel's strip |
| `npm run trail` | the stations looked at this session (`station-trail.js`), a pill in the Stations map's top row, at 1440 px and on a phone in the hand: nothing until a station is looked at; pins clicked, a row selected and a tapped callout each put their station at the head, the latest first and each once; the pill right of the zoom buttons, level with them, one row even for the longest name in the file and short of ↺; pressed after the card was closed, the card back and the list down over it, the pill's station marked; Escape (in full screen, which does not leave on the same key), ↓ ↑ Home End, a press on the map and a pick putting it away with focus on the pill; a pick selecting the station, putting its card up and the map on it at zoom 15 or closer, and moving it to the head — a filtered-out station picked all the same, the filters narrowed; a reload keeping the trail (and, since #211, the card its address names) and a new session starting empty, capped at 100; in the twin the pill at the top of its stage right of the flood scale's column, level with its head, the card's top kept below it and a pick taking the twin there; and on a phone a zoom button's height with a finger's reach, its list on the map and in the twin moved left to fit |
| `npm run links` | where you are, in the address bar (`route.js`, #211), and the first load saying what it is doing (#212), in Chromium, with `stations.json` held part-way through by the server (`lib/server.mjs`'s `stream`) and every `pushState` counted: while the list is on its way a data tab shows the loading card — the datastore's failure listed, the source being asked instead, *1.0 MB of 8.1 MB* with the bar agreeing, the header saying *Loading stations…* — and never *No data loaded*; the station and view a link named kept in the address meanwhile and put on the map, card up and not selected, when the list lands; opening the app, the list landing and a link applied not steps of their own; a tab picked from the nav a step, back to the Stations tab at the view it was on, forward again; a pin opening a card a step, a pan rewriting the view in place, a second station a second step, back to the first at the view that step was left on, back again to no card, forward to it; a reload keeping tab, card and view; the card's 🔗 Copy link copying an absolute link that opens that station on that view for somebody with nothing stored; *Go to station* from another tab (`goToStation`) one step, and one back to the tab it came from; a station alone meaning Stations, close in; an unknown tab and an unknown station set aside politely and said; a link to a data tab opening on it; a bare address opening the tab used last; a Workbench case shared as `#wb…` still opening the Workbench, left out of the address when the Workbench is left, and back again with it; and a load that fails everywhere listing the three sources in order with why, ↻ Try again leading, the header and a screen reader told, and Try again landing the list |
| `npm run palette` | Ctrl/Cmd+K and 🔎 Search in the banner (`palette.js`, #221), in Chromium with every `pushState` counted: the banner's button and the chord open one dialog, the cursor in a box that is an ARIA combobox over a listbox; with nothing typed the actions, and once a station has been looked at, that station first; Escape closes it and focus goes back to the button. **Stations** through the Stations filter's own matching — *mount archer* finds Mt Archer AL, a station number puts its station first, a name ranks the ones starting with it first, an address window offers *All N matching stations* which puts the window in the Stations filter; Enter from another tab opens the station as one history step with its card up and the address naming it, and back returns. **The keyboard**: ↓ moves the mark and `aria-activedescendant` together, ↑ past the top wraps, the count is said in a status line, nothing matching says so and offers only a place search. **Places, tabs and actions**: a name offered to 📍 Find a place and a click there leaving the text in its box with the cursor in it, a coordinate going there, *council* opening Site Maintenance, *theme* switching it, *copy link* copying the address |
| `npm run firstvisit` | a first visit and ✨ What's new (#222: `route.js`'s `newDevice`/`firstVisit`, `site-map.js`'s greeting, `whats-new.js`), in Chromium: a browser that has never been here, at a bare address, opens the Site Map greeted and is not shown What's new; the list arriving keeps the greeting; it says why and that it will not happen again; Got it puts it away with focus on the page's heading, and it does not come back that visit; the next bare visit opens the tab used last, ungreeted; 📍 Go to Stations goes there and spends it; a new device that came by a link goes where it says, ungreeted; a device that has been here before opens where it always did and is shown ✨ What's new, which lists every entry with the unseen ones marked *new* in words, goes once looked at, and stays gone after a reload |
| `npm run themes` | the theme follows the device, and Sunlight (#224: `core.js`'s `themeStored`/`themeResolve`, `app.js`'s `applyTheme`, `setTheme`, `openThemeMenu`), in Chromium with the device's colour scheme emulated: a device that has never chosen follows its own setting at load and as it changes, the button saying System; a dark device opens dark; a stored `light` from before there were four stands on a dark device; 🌗 opens the four as radios, the current one checked and focused; a pick applies at once, is stored, renames the button and is said, and the dialog stays; Sunlight draws the radio paths 1.6× heavier on black ink and white grounds; `toggleTheme()` is still the light/dark flip; the catchment labels' darker ink follows the theme the page wears, not the device; and under forced colours the open tab keeps an outline. Sunlight's contrast is `npm run shell`'s, which now loops over all three themes |
| `npm run dialogs` | the app asks and tells in its own words, where it used to stop the page with the browser's `alert()`, `confirm()` and `prompt()` (#223: `modal.js`'s `confirmDialog` and `promptDialog`, `toast.js`'s `Toast`, `core.js`'s `TAB_NEEDS`). **Parsed, not grepped:** every script `index.html` loads has no call to the three — bare, through `window`/`self`/`globalThis`, or in an inline handler written into a string — so a local function cannot be called `confirm` either. **In Chromium:** a question is an `alertdialog` named by its question and described by what follows; its buttons say what they do; a dangerous one starts on the way out; Escape, ×, the backdrop and a second question over it are each "no"; focus goes back; Tab stays inside; a tick inside it rides on the answer. Asked over an open dialog it leaves that dialog standing, and **no key gets past it to a listener on the document** — the photo viewer's Escape and arrows live there. A line of text: the box focused, the button off while blank, Enter answers, Cancel is null. Toasts: said once through the app's live region (and not a second region), "done" going by itself but not while pointed at, "failed" staying until dismissed, three at most. The call sites people meet first: Remove all drawings, the map's reset, the Text tool's note from a click on the map, a station list that will not load, the bug reporter's own line, the Workbench's case name. And with Web Serial taken away, the Serial Monitor marked in the nav — the reason in its tooltip and its accessible name, not only the mark — and its banner naming the browsers that can. Any native dialog fails the run |
| `npm run exports` | ⤓ Export in the banner (#227: `export-menu.js`'s `ExportMenu`, `core.js`'s `floodnetName`): **every tab in `TABS` offers something or is exempt with a sentence saying why** — none both, none unknown — and every offer names a writer the app has, resolved rather than trusted (the offers are the tabs' own writers, by the path their buttons call). On Stations the dialog opens named for the tab, the first ready offer focused; on an exempt tab it says why. Signed out, the station list is offered but says *Sign in first* (the Export tab's rule, #191) and writes nothing when pressed; nothing selected says so; a writer that finds nothing (no polar plot) says what to do first. Signed in: the list as CSV (a row a filtered station), filtered to repeaters and bases as GeoJSON (**exactly** the filtered stations with a place, as points at [lon, lat] — two of the bases have none, so the map files have something to leave out, and the note says how many they did) and as KML (a placemark each); the selection's CSV. ARRO Data's demo (CSV and SVG), an ALERT2 sample, HFEM's spec examples, Reception's demo drive and Station Health's demo week each give their file through the banner. Every file is named `floodnet-…` — `alert2-readings.csv` and the ARRO chart's SVG included — and a name that already says so is left alone |
| `npm run offline` | opens with no signal (#213: `sw.js`, `pwa.js`, `manifest.webmanifest`, and the loaders reading `X-FloodNet-Offline`), in Chromium with a **real service worker** — which every other check runs without: `pwa.js` stands down under automation unless `mn-sw` is `on`, and this check sets it, with the network policy on the context so the worker's own requests meet it too. Installable: the manifest names Flood-Net, standalone, with 192, 512 and maskable icons that exist. Kept: the worker registered for the page's own version holds **every script `index.html` loads**, `styles.css`, the page and Leaflet — and nothing under `/api/`; controlled, the station document and the inspection sheet's tables as they arrive — **without holding them up**: stations.json held part-way by the test server, the loading card already counts the bytes that came, of the whole (#212). A data file the site changes under the same name with no new stamp (the monthly ACMA refresh) is the network's, not the copy's. Offline: a reload opens the app from the copy, its stations there and the header saying **saved copy, N minutes old — no signal** (never *from* a source it could not reach); an inspection sheet starts from the kept tables and its draft is saved on the device; the data file answers as last fetched; and an address that is not the app (a doc) is not answered with the app. A new deploy (the test server moves every stamp on): back online, the page that came from the copy is offered *A newer version of Flood-Net is ready* — and stays the old version until **Reload now** is pressed, which opens the new one, whose worker keeps its own copy and drops the old; a page from the network is offered nothing. A page that is not the app (a stand-in for Access's sign-in) is never kept: that worker goes redundant and the copy before it still answers. And `sw.js`'s reference tables are exactly the ones `inspections.js` and `maintenance.js` ask for |
| `npm run offlinetab` | the 📲 **Offline & Install** tab (`offline-tab.js`, and `pwa.js`'s `status`, `prepare`, `remove` and install prompt), in Chromium. Where it is: under *Start here*, after the Site Map; `?tab=offline` opens it; it draws with no station list loaded. Which browser: `detect()` against seventeen real user-agent strings — Safari and Chrome on an iPhone, an iPad (which says it is a Mac), an iPhone's home-screen app (no `Safari/` in its string, and not an app's browser for that), Android's Chrome, Samsung Internet, Firefox and Edge, three apps' own browsers (Instagram's, Facebook's, a WebView), and Chrome, Edge, Safari and Firefox on a computer — and the iOS version read off the string; then emulated devices, each shown its own steps first: Safari's Share → Add to Home Screen on an iPhone with the note that the icon keeps its own copy and sign-in, Chrome on an iPhone older than 16.4 sent to Safari, Chrome's ⋮ → Install app on Android and no iPhone note, Firefox on a computer told it cannot install, an app's browser given the address to take elsewhere; nothing pushing a 390 px page sideways. The install prompt: a `beforeinstallprompt` held (its default prevented — no strip of the browser's own), offered as 📲 Install, asked once when pressed, accepted and dismissed each said, the button gone once spent and focus on its section's heading rather than nowhere; opened as the installed app, the tab says so. No signal: the signal row says so and Get ready and Check are off with the reason beside them, and on again with a signal; Check for a newer version says this is the newest, by its stamp. **With a real worker** (as `npm run offline` runs one): one first visit keeps the station list and every sheet pick-list with no reload; the tab says Ready and counts them; Start again asks first, removes the worker and every copy, and with *do not keep one* stays off across a reload; **Get this device ready** turns it back on and goes through its steps — the app's files, the list, the pick-lists, the browser asked to keep them — to Ready |
| `npm run proposed` | proposed stations (0039) in the browser, against a stand-in for `save_station()`: **+ Propose** beside **+ New** opening a proposal (its band, this year, the box ticked, the type to choose, no number, the cursor in the name); a proposal missing its type, its year or its place, or dated 1850, not sent and saying which; a database at schema 38 not sent one at all; a complete one sent with `proposed`, `station_type`, the year as typed and no number; its hollow dashed pin, its card's band, its tagged row, callout and trail entry, the legend's swatch; an established station carrying none of it through a save; an editor's box locked on a saved proposal while the year still saves, + New warning that adding outright is an administrator's and the refusal worded about administrators rather than the editors list; an administrator establishing it (sent without `proposed`, the type and year kept, the pin solid, the band gone); and **What is here** proposing at its point to six decimals |
| `npm run stationhistory` | the station history (0056, `station-history.js`) against a stand-in for the database that writes a change row on a save the way the trigger does: signed out or off the editors list, no History section on the card and no Deleted stations on the Admin tab, and nothing asked; an editor's card asking for the station's changes newest first and naming who changed it last, opened into entries (what kind, when, who) with each field as it was and as it became, Restore where it can go back, "as now" where it already is, and the hub "not restored here" with no button; kept open through a repaint; a field put back only after a confirmation (a "no" sends nothing), by reading the database's copy and saving it through `save_station()` with its stamp, that field changed and the lists left out, the restore then the newest entry; a version put back — every field that change or a later one moved, the later changes counted, the hub left and said so; `proposed` put back refused in words about administrators; a database without the table told, in words, that history starts once 0056 is applied, the card otherwise whole; the Admin tab's deleted stations with when and who, Restore calling `restore_station()` with the list's stamp and putting the station back on the map, a refusal in the database's words, and a database without 0056 told so; no station written any other way; and `station_change` absent from the agent API |
| `npm run search` | ALERT address windows in the Stations filter box (its table read by `#stations-table-wrap`, wherever the side panel has put it): `4021-4025` selects the stations inside it, in every form (hyphen, en/em dash, `..`, reversed) and every paste (newlines, commas, spaces, semicolons), mixed with names and bare addresses — and everything the box already took, asserted again beside it |
| `npm run linkbudget` | the link budget card's two ends: each found by name, station number, ALERT address or address window against the *filter's own* answer, the box keeping its caret through a paste, an armed end filled from a pin click, a point and a row of the Stations list in its filtered state — without selecting it — Clear A / Clear B / Clear both, a half-typed figure surviving a repaint it did not ask for, and the four things the table refuses to compute: the same station at both ends, a zero-length path, a term nobody supplied, and a frequency that cannot say whether it is an override |
| `npm run pathcursor` | the elevation profile's cursor, on the chart and on the map at once: a dot running along the ground line with the pointer, tagged with the land height under it, and the same point marked on the map — from either side. The tiles are a **ramp in longitude** built in the check, 0 m at one end of the hop and 1,000 m at the other, continuous across tile boundaries and independent of the zoom Terrain picks, because flat ground would let a cursor that ignored the pointer entirely pass every assertion. So every reading is arithmetic: a quarter of the way along the plot the tag has to say 250 m, the dot has to be a quarter of the way across *and lower down it than the halfway one*, and the marker has to be a quarter of the way along the line. Driven from both directions, and asserted to leave nothing behind — off the chart, off the line, and when the line itself is deleted |
| `npm run mapfade` | arming a draw tool from the Draw & measure pane in the side panel (opened from ✏️ in its strip) must not also draw with it: a real pointer clicks **Line**, and the line that follows two map clicks has to come out with two points rather than the three the flyout's own leaked click once made of it — plus the link budget disarming itself the moment both ends are in and opening the ground profile unasked, Escape getting out of the pick, the margin chip in the card's corner carrying the table's own figure, half a decibel of default line loss at an end nobody has measured, the chart's sky and the earth-curvature arc under it, a Path row whose height does not depend on the two names, built area that is no longer obstruction-red, MapFade's bands set, banded, remembered and rendered as controls, an empty datastore read once rather than once per redraw for ever, a table bigger than PostgREST's 1,000-row ceiling read in pages, no land cover meaning no figure rather than a kinder one off bare earth — and, the assertion the rest of it exists for, the margin the map colours a link by being the same number to the decimal that the link budget card gives for that link. Plus the profile card's **⇄ Flip direction**, pressed from the keyboard — the line's points, the Path row's names and a typed antenna height all turned round, focus back on the button once the chart is redrawn — and a line vertex clicked 7 px off a drawn 📍 pin landing on the pin's exact coordinates, with the snap ring shown on hover |
| `npm run maplinks` | what the Stations map's links say and where its furniture sits (#186), and what the follow-up asked for: the arrows drawn as a function of the zoom (**nothing at all** below 10, growing and closing up to 15, read off the module's own ramp so "fewer links in view" cannot be mistaken for "bigger marks"), a backbone path's arrowheads sampled off the arrow canvas at the mark's own position with the field links taken off the map first — black, and none of the channel colour the line under it is drawn in — the cards in the side panel beside the map as the default with the **page** not scrolling behind the pane that does (the legend and Map display read in their own panes, opened from the strip) (rewritten for the side panel: the cards used to be a column inside `<main>` with a divider of their own), and the what-is-here card answering every row it can reach and naming the ones it cannot. Plus: the credit line out of the map *and* out of the box the on-map cards are positioned against, with the move-pin panel's Save button geometrically clear of it; the link colour a link is painted checked against `MapFreq.rows()` rather than a literal, so a re-ordered palette still passes and a wrong pairing does not; a backbone path as three lines with the black dash over the coloured core; the arrows' direction as *data* — a field link's polyline ending on the repeater it points at, a repeater-to-repeater path two-way — on a pointer-less canvas in a pane above the links; a repeater focus with no filter behind it dimming the map, enabling both Clear buttons and being cleared by them; a coordinate typed into the filter box being a filter and nothing else — no strip, no pin, the map where it was — and the same text in 📍 Find a place (the blue pin) listed, gone to and pinned in blue with nothing filtered, and ✕ taking the pin away; and the fold at 1,100 px moving the cards under the map and back into the side panel with the same Leaflet map on both sides of it, the side panel's width handle as a real separator the arrow keys move and a reload remembers, and the fold at `lg` putting the cards under the map without forgetting where they were wanted — plus, since #195, the map's **height** against a page made to overflow by 2,400 px for a reason the map has no part in and cannot shrink away, because the correction used to charge it for all of it and collapse it to its own `min-height` (a 929 px map became 306), and nothing about that state reads as broken from inside the app. **The panel search is measured with `getClientRects()`, never `el.hidden`** — the first implementation set the attribute and left every row on screen, because an author `display: flex` beats the browser's own `[hidden] { display: none }` at the same specificity, and a check reading the property would have agreed with the bug. Confirmed red on three deliberate breaks |
| `npm run dock` | the side panel (`#help-panel`, the dock) as a dock — the seams no single-surface check sees. A fresh visit at 1440 opens it on the Stations cards with ❔ saying Help is not the pane, **the elevation profile and the link budget in a pane of their own** (〽️, with its own h2) rather than among the cards, opened by a real click at the same width with the list put away, brought up by *Finish line* from the ✏️ pane, and put back among the cards — after the list, before Repeaters listening, 〽️ gone from the strip — by the fold; **every one of the Stations map's controls but ↺ is in its strip from the first render** — the six panels as panes with a button each, the five other plain buttons (ℹ️ ⛰️ 🧭 tilt ⛶) as themselves, still wearing the class their modules find them by, in the corner's groups and order, each group labelled, every gap between groups wider than every gap inside one, the camera pair not on screen while the map is flat, no 📌 and no corner icon showing, and building the map having opened nothing — while **the map's top-right corner draws ↺ and nothing else** — at the corner's top right, under the pointer, named, no other icon and no hairline, and reset by a real click on it with the side panel left as it was — and Leaflet's zoom stays; a pin set from code there moves nothing; ↑ ↓ Home End walk every button, across the groups, skipping hidden ones; a map pane opens from its strip button and takes real clicks and typing; ℹ️ in the strip arms and disarms; the showing pane's own button shuts the panel and the map takes the width, **with Leaflet told** (its size read back against the container's); the width handle is a vertical separator with a px value, a focus ring reached by Shift+Tab, a real pointer drag, arrow / Home / End / PageUp keys, a clamp past its range and a width that survives a reload; leaving the tab takes the Stations button, every card and every map control with it and **no id is ever on the page twice** (cards and panels, counted document-wide); a render inside the tab lands the new map's panel in **the same pane and strip button**, never shut on the way (a MutationObserver on the pane), with focus, the pane's scroll and the Map display find term kept, and focus carried to the new button — ⛶ in the strip, and ↺ in the corner, which goes with the map's own markup before the map is taken down; the pane last open opens again when the tab comes back; **full screen keeps the side panel on screen** — the map's right edge on the side panel's left, the panel fixed full height above the header, a pane opened, the panel shut and the handle moved all followed by the map and re-measured, Tab crossing between the map and the side panel at both seams in both directions (and, folded under it at 1000 px, not onto a card hidden under it), Escape from the side panel ending it, and leaving the tab ending it too; the fold at 1000 px keeping Help and every map control, focus and the pane preference with it, and unfolding onto the same map; at 375 px **the Stations tab's strip a rail beside the map** — 48 px in the row, the map ending where it begins and measured to it, every map control in it in the corner's order at 44 px and nothing in the map's corner, the cards under the map — whose panels open as **drawers** on the rail's inner edge over the map, by Enter as by a click, with the backdrop behind them, the rail lit above it and the map not moved; another rail button switching the drawer, the lit one, a tap on the dimmed page and Escape each putting it away with focus on its button, one drawer at a time with the nav's, ❔ opening help in the same drawer, and Escape in a dialog opened over a drawer closing the dialog alone; the rail's last button reachable above the fold at the top of a short phone's page, and the rail and drawer running to the foot of the screen once it is scrolled; every other tab keeping the old edge tab and its drawer; and full screen keeping the rail beside the map with ⛶ in it, a drawer over the map whose sliver is the backdrop; **focus carried across 560 px both ways** — ✏️ in the strip staying ✏️ in the rail, typing in the Map display find box kept through a drawer and back into its pane, ⛶ in the strip and ↺ in the corner each with itself; ↺ alone in the corner at 1000, at 375 and in full screen; no sideways scroll at 375 (help and a map panel), 768 and 1440 with the side panel open; and, in a browser with real scrollbars at 1440 × 550, a strip that scrolls with every button reachable and under the pointer and the bar beside the buttons, not over them |
| `npm run claim` | claiming an address from the message that arrived on it: an unresolved relayed row offers the claim, the picker sends the *station* address rather than the sensor slot, and the tab stops offering a write that has already landed — with the datastore stubbed at `dbRpc` |
| `npm run fieldkind` | a field series knows what it is measuring — the two SDI-12 levels at 18 Bateson charted as **RainAccum** with the inspector offering *"= 0.36 mm (assumed 0.2 mm/tip)"* against metres, and every layer underneath was right: the logger sent `s:999998/level_1` with `unit: "m"`, the row is typed `Water Level`. Two defects that only misbehave together — `fieldAddrs()` built `a:<alert_id>` addresses and nothing else, so the series never resolved to its sensor row, and `guessKind()` then read neither the unit nor the channel and fell through to its `RA` default. 30 assertions over the rule, the address list, the whole operator path, and the unit's veto over a kind set by hand — that last one added because a mutation run showed it was otherwise untested |
| `npm run fieldprobe` | what the *datastore* holds, as against what `stations.json` says it should: the Field Data picker's "In the datastore" block, driven for 18 Bateson — a station with no station number, no ALERT ids and no sensor rows, beside four channels reporting under `bateson_test`. The probe asks the station's own id first, then its registry addresses, then widens to a word out of its name; a widened match is listed, tagged with the station row it is filed under, and **never ticked or charted on its own**; ticked by hand it charts labelled with *that* station, named apart by channel. Plus the search box, the empty answer, and the four columns each query selects |
| `npm run gate` | the Access-to-Supabase verifier refuses what it must — a forged signature, a token minted for another Access application, an expired one, `alg: none` — against keys generated in-process, so it runs offline |
| `npm run briefing` | Station Health's *Ask Claude* on Flood-Net's own Anthropic key (`/api/briefing`, `worker/briefing.js`, #229), the one server-side door that spends money, offline: Anthropic, Access's key set and `meganet.whoami()` stood in for on fetch, the day's ledger the real `BriefingLedger` Durable Object over a Map, Access tokens signed by a key made in-process. **Who**: signed out, a session without Access (workers.dev, github.io), a forged, foreign-application or expired Access token, no Flood-Net session, one the database has expired or calls signed out, an editor's session behind somebody else's Access sign-in, a viewer, somebody off the editors list and the database not answering are each refused before Anthropic or the ledger is touched; an editor and an administrator are let in, by the Access header or its cookie, the database asked once a minute per session. **What**: the request `health-agent.js` builds (run in a `vm` as it is) is a briefing's, its prompt and nine tools word for word the Worker's copies; another model, more output, no stream, no fallback, other thinking, effort `max`, a task budget, an hour's cache, a tool_choice, an MCP server, another prompt or tool list (told to reload), images, documents, a system message, a prefill, a server tool call, a bare-string content, past 400 messages or 1 MB (by Content-Length and by what arrives) are each refused, and a whole conversation as the loop builds it passes. **End to end**: the real SDK at the version the page pins, given the page's own route options, sends the page's request through the route with the session and no key; Anthropic gets those bytes under Flood-Net's key and nothing of the caller's; the stream comes back byte for byte and is read as Anthropic's (a thinking note, a tool call, the next turn); the day is charged what the usage says, every fallback attempt at its own model's rates; a spent day is the SDK's 429 with the route's code, not retried. **How much**: the meter alike whole, byte by byte and with CRLF; Anthropic refusing the key (502, said so), overloaded (passed on) or unreachable charge nothing, and never starting to answer is given up and charged its input; Stop cancels Anthropic too and settles at input plus the most output that time allowed; 20 calls a minute per person, then a 429 with Retry-After, someone else unaffected; 3 in flight; the ceiling holding with a call still running; Brisbane's day, its midnight, a hold carried over, a lapsed hold charged in full, a late settle counted once; the spend surviving a restarted ledger. **Deployed as written**: `wrangler.toml` binds and creates the SQLite-backed class, `worker/index.js` exports it, and `docs/access.md` and `docs/station-health.md` state the ceiling the code sets |
| `npm run agentapi` | the read-only agent API and MCP server (`worker/api.js`) against a strict in-memory PostgREST (`lib/postgrest-stub.mjs`) built from the real `stations.json` and `data/sls-locations.json`: every route's and tool's shape — the latest readings (#230) against fixtures of every kind of address, by both of its paths, filtered, paged, and answering a 503 that names migration 0057 while the database lacks it, and GeoJSON at `[lon, lat]` with positionless stations named rather than dropped; every upstream request a GET, to a relation on the public list, with the publishable key and none of the caller's Authorization, cookie or Access identity; list caps, reading windows and paging past the server's max-rows; rate limits through Cloudflare's binding and the per-isolate fallback, per client name and per address; CORS, HEAD and ETags; both MCP eras (the 2025 `initialize` handshake; 2026-07-28's per-request metadata, header checks and `server/discover`), batching, the Origin rule and JSON-RPC errors; failed reads degrading to `unavailable` sections; the edge cache; `/api/db` and `/api/session` unchanged. Offline |
| `npm run agentdocs` | `docs/agent-api.md`, the five agent instruction files (`AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md`, `llms.txt`, `.cursor/rules/floodnet-api.mdc`) and `wrangler.toml`'s `[[ratelimits]]` state the URLs and limits `worker/api.js` uses; every OpenAPI path, MCP tool and query parameter (in its own endpoint's section) is documented, and every tool named in each agent file that lists them; `llms.txt` has the llmstxt.org shape; every relative link lands. Offline |
| `npm run drawkml` | the Draw & measure drawing as a Google Earth KML: **a wrong KML opens perfectly**, so every assertion is about the parsed file and the ground its numbers describe. The axis order (KML is `lon,lat`, every other API in this app is `lat, lon`, and getting it backwards puts an Australian drawing in the Indian Ocean); a circle that is round *on the sphere* — 72 bearings stepped with `destPoint`, every vertex measured back to the centre, so the tempting version that adds degrees of longitude fails by 2.2 km on a 20 km radius at Brisbane; the stations inside a shape, against a haversine written in the check rather than the app's; every `<styleUrl>` resolving to a `<Style>` that exists; and both halves of the 250 m fallback that finds the station under a pin nobody snapped. 45 assertions, six deliberate breaks — **one of which passed**, see the note below |
| `npm run terrain` | the five terrain-and-place features, against a world the check *makes*: terrarium tiles generated per tile coordinate from a closed-form surface — hills every eight kilometres, so the summits are real summits and the coverage is over real relief — which makes every answer checkable against arithmetic rather than against whatever SRTM says about Queensland today. Three of the five are meaningless over `pathcover`'s one flat tile, which is why this has a fixture of its own. The Radio Mobile colour file's twelve heights paired with its twelve colours *end to end* (head to head puts pure blue on the mountains, which is a plot that looks deliberate and is upside down); peaks rather than maxima (sort the grid and take the top five and you get five pixels of one hilltop, every time — the check measures the closest pair against the view); the coordinate parser over eleven shapes and seven near-misses, including `26 07 24 S`, where reading the S as a seconds marker rather than as South is a silent 52-degree error, and `6128 6129`, which is two station numbers and must not be a coordinate; the profile card's fade-margin row, banded and quoting both directions, and its stated reason when an end is a point on the ground; and the polar plot drawing, keying itself with both radios named, refusing a range that is not one, and **re-banding a new threshold without fetching a single extra tile** — the separation between a level and the colour it lands in, asserted against the tile counter — plus the saved CSV, every row of which has to land inside the plot it claims to describe and measure back to its own range from the centre. And 📍 Find a place, the blue pin's pane: a coordinate in it moving the map with no network and dropping one blue pin without filtering a station; the file's own answers at once — the Fitzroy catchment by name and by basin number 130, Lockyer Creek once however its stations spell it, the Lockyer Valley council area; a catchment pressed drawn in outline with the map fitted to the basin, a river pressed with the map over every station on it; a blocked gazetteer saying so with the file's answers standing beside it; the gazetteer asked no more than once a second with a letter typed every 700 ms, a lookup overtaken before its turn never sent, and the last one answered (from a stand-in, since the network policy blocks the real one); and a row pressed marked as the place shown in its own list and in no other query's |
| `npm run sites` | the repeater site finder (`map-sites.js`) — a pane of the side panel, opened with a real click on 🗼 in its strip, whose button stands in the tools group straight after 📡 and straight before ℹ️ — on the terrain kit's hilly world, with the land cover seeded (trees at both ends, rangeland between) and the Queensland cadastre stubbed to put a road parcel 70 m east of whatever it is asked about. The paste reads station numbers, a CSV row, a name in the wrong case and an ALERT address as exactly their stations, a `lat, lon` line as a proposed site rather than two numbers, names what matched nothing and hands a word matching hundreds back as a question; the answer is five summits of the world the tiles were made from (each higher than the ground 600 m away in eight directions), spaced, inside a search area that holds every site, and the fade margin quoted for the first is **the link budget card's own arithmetic over the same 256-sample path with the cover on it, to the last bit**, terminal clutter included; a weight is a re-rank — the screened pool survives it, and height alone puts the highest summit first; the cadastre is asked about the finalists only, not at all at weight nought, and a 500 is reported as unchecked with no bonus; the circle is Draw & measure's own, armed from the panel and landed with a real pointer; and ↺ takes the sites, the answer and every layer drawn for them away. **A candidate's pin is what a real pointer lands on** (it used to sit under the network's canvas, where it could be seen and never pressed). **The Google Earth file** is parsed and walked rather than trusted: a folder per candidate in rank order holding its pin (`lon,lat` — the axis-order check) and one path per site less the ones it stands on or could not compute, each styled by the band its own margin falls in **by an oracle written in the check** from the map's two thresholds, in the band's literal colour; #1's paths on and every other candidate's off on the folder *and* on each path; every `<styleUrl>` resolving; children in the KML 2.2 schema's order; the margin to the tenth under the CSV's own column names; the chords at antenna height off and said not to be clearance; the search area a ring on the sphere measured back with the check's own haversine; the caveat in the file; a site named with `&` and `<` surviving as its own name. **The KMZ** is the bytes that were downloaded (`Buffer.concat`, not a string), unzipped by a reader in the check: stored, `doc.kml` first in the file and the directory, local headers agreeing with the directory, every CRC right by a bitwise CRC that shares nothing with the writer's table, the pins 64 px PNGs decoded far enough to read the map's blue disc in its white ring, every icon `doc.kml` names in the zip — and `doc.kml` equal to the plain KML but for its icon styles; the KML button downloads that plain file; with no answer both buttons are off and a call writes no blob and says why. **The dim**: at 100 % no pane is touched; at 20 % every pane from the overlays up is at 0.2 and the finder's own, the popup's, the base tiles', the base labels' and the elevation's are not; a pane made after the slider moved is dimmed as it appears; the sites keep a dot and gain their names; ↺ puts every pane back though 20 % is still remembered, and a reload with 20 % remembered dims nothing. **In 3-D** (skipped without WebGL2): the finder's `mn-sites` source and its four layers between `mn-links` and `mn-stations`, holding the search area, a ring per site and the picked candidate's paths; a DOM pin per candidate that a real click picks — its paths replacing #1's on the terrain, the click reaching neither MapLibre's handler nor Leaflet's; the dim in `mn-links`/`mn-stations`/What-is-here paint as `['*', ['get','op'], 0.2]` and back to plain `['get','op']` at 100 %; *Draw a circle* off in 3-D with a reason and back on leaving it; and nothing left behind. Eight deliberate breaks (the candidate point's axes swapped, the ranks-≥2 path visibility dropped, the finder's panes not kept out of the dim, the pins' pane put back under the canvas, a CRC off by one bit, a band threshold moved, the dim applied while the finder is empty, the 3-D dim not reaching `mn-links`) each went red on the assertion meant for it |
| `npm run map3d` | the 3-D view on the Stations map, and the four things every other check here is structurally blind to. `smoke` opens the Stations tab and a ⛰️ button that does nothing at all passes; `registry` leaves the tab and asserts the Leaflet map went, which a WebGL context and its worker pool outliving the div they were built on also passes, because they are not a Leaflet map; `maplinks` measures the 2-D links, and a 3-D view drawing a different set in different colours from a second and wrong derivation leaves every one of its assertions green. So what is asserted is the **seam**: every core link and pin mirrored with the colour the 2-D map gave it, read off `state.mapLines` rather than compared against a literal (and the white casings *not* mirrored — in 3-D the terrain lifts the line); the colouring and the filters reaching it, by switching them and watching the mirror follow; the canvas sitting above every Leaflet pane and below the control corners, measured with `elementFromPoint` rather than read off the stylesheet, and ⛰️, ⛶ and the Map display and 3-D settings buttons — in the side panel's strip, off the map — and ↺, the one control still on it, in its top-right corner, each the thing under the pointer where it is drawn, so one set of controls still drives both modes; the renderer absent until ⛰️ is pressed, which is the whole justification for fetching a megabyte outside `index.html`'s script list; the renderer the version `map-3d.js` pins, imported as a module with no global left behind, opening from a page opened as a file as well (#190), and sizing a pin by exactly the depth MapLibre draws it at; a polar coverage plot draped on the terrain as the 2-D overlay's own image over its own corners, re-banded with no terrain tile fetched and the 2-D plot untouched by leaving (#188); and the GL context going with the tab. **The load-bearing one is the sheet.** A profile chart keeps the line of sight straight and bends the earth up under it; a 3-D view cannot, because the ground is drawn where the DEM says it is — so the bulge comes off the ray instead and the top edge is `los − bulge`. Write `ray = los` and the picture is still a picture, drawn over real terrain, reporting clearance that is not there by the whole bulge — ~50 m on a 60 km hop — with nothing thrown and nothing looking wrong, while the map and the profile card disagree about whether a path is blocked. So every sheet assertion is arithmetic against `pathAnalyse`'s own numbers computed in the same page, over a hop the check *picks for being 40–90 km long* so the bulge is larger than the tolerance. Confirmed red on four deliberate breaks: the bulge dropped (4 assertions), the casings mirrored (4), the canvas raised above the control corners (5, four of them the geometry probes), and the renderer loaded eagerly (1). The repeater site finder's own `mn-sites` source and layers are in every style and empty while it is idle, and its dim is then exactly off — the network's opacities are the plain `['get','op']` styleSpec wrote (`sites` drives the finder in 3-D). **What moves the 2-D map moves the camera**: a row of the station list (what its button calls) puts the station in the middle of the 3-D view at the 2-D map's zoom less one, keeping the tilt and heading; a camera already closer than the row asks for keeps its zoom; the same station asked for again after a pan by hand is gone back to (the 2-D map follows the camera, or that is a pan of nothing to Leaflet); *Zoom to station*, a fit, follows too; dragging the side panel's edge — a Leaflet `moveend` with no move behind it — moves nothing (confirmed red with a follow of every `moveend`); Leaflet's own drag, wheel, double-click and keys are off under the canvas, so a drag in 3-D moves the camera and the 2-D map ends where it stopped; and leaving 3-D shows the 2-D map there, handlers back. Confirmed red on the old code (10 assertions). **The card's gold leader reaches its pin in 3-D**: a pin clicked in 3-D gets it, drawn over the canvas rather than on the 2-D pane under it — the thing `elementFromPoint` finds along its own line — from the card's top outline to a ring centred where `project()` stands the pin on the terrain, still there after a turn of the camera; at the foot of a steep view the pin is drawn larger than in 2-D and the ring grows with it, measured with MapLibre's own hit-test (which scales a circle by its depth in its own code), where a ring at the 2-D size is shown to cut through the same pin, and towards the horizon it shrinks and still clears it; a pin under the card has no leader until `reveal()` slides the camera, keeping zoom, tilt and heading, and then has one; closing the card takes it; and leaving 3-D gives it back to the 2-D pane, drawn to the 2-D pin. **The Queensland cadastre is draped**: with Map display's two switches on, `mn-lots` and `mn-roads` are raster layers of their own between the base map and the links, roads over lots; each is the cadastre service's export at 512 px with MapLibre's `{bbox-epsg-3857}` left whole, at the 2-D zoom floors (13 and 12) and with the State's credit; the lot lines' renderer is the 2-D image's own (read off that image's request, casing and line), labelled closer in than 2-D (1:2,500) and only on Base lots; the road reserve is the 2-D layer's two parcel types in its colour (asked of `MapRoads.legendColour()`); tiles are asked with the bbox filled at whole zooms at or past the floors, and none on a pan zoomed out past both; property boundaries off takes only them off, on again puts them back under the roads with the elevation ramp under both, and a base map swapped in goes under all of it; and a tile the service will not give is said in the 3-D note. Confirmed red on two deliberate breaks: the ramp inserted under the links rather than under the cadastre (2 assertions), and failed tiles not counted (1). **How to move it**: the hint at the foot of the view as the mode opens, in `viewMoveWords`' words with the compass and tilt buttons named, a "?" beside it; standing above MapLibre's credits and scale and clear of its zoom and compass, and dropping when the credits close to their ⓘ; taking no pointer, so a drag on it is a drag of the map; folded by itself to its "?" minutes later, the "?" bringing it back, and pressed while it is up putting it away; the canvas's name carrying the keys, and the 🎚️ panel listing mouse, touch and keys. Needs WebGL2, which Playwright's Chromium has through SwiftShader; it skips rather than fails if that is ever absent |
| `npm run twin` | the digital twin (`digital-twin.js`, inside the Stations map, with its 🧊 side-panel pane), against a world the check makes: Queensland's elevation service answered with a tiled 32-bit-float GeoTIFF of a closed-form surface, so every vertex of the ground mesh is arithmetic — the request box grown by half a sample so pixel *centres* land on the vertices and the middle one on the station, the Type 3 rainfall pole (2.000 m × Ø0.300 m) with its foot at the origin on that ground, the 1.75 m figure with its feet on the ground a metre east, the imagery draped (a gradient, so the blank-sheet test has something to pass), the height at the pin from Elvis in the Ground truth list, and vertical exaggeration scaling the relief and nothing else. Then the horizon: three shells of far ground round the patch under a sky in haze, the innermost square the patch's edge vertex for vertex, each far vertex on its sheet's height at its own latitude and longitude — the State's closed-form surface at the inner sheet's nodes, the hilly tile world read as `terrain.js` reads a tile at the outer sheets' — less the Earth's curve (109 m at 40 km), the lift at the LiDAR edge fading by three patch-halves out, exaggeration stretching the far relief and not the curve, the far shell drawn first and outermost squares first, the orbit camera kept above the far ground, the switch (off keeps the patch and the setting; back on comes from memory; off from the start costs no tiles) and the tiles gone leaving the State's sheet alone with a note. Then the `.glb`: header, chunks, the ground's 40,401 positions read back out of the binary and matched to the scene, the embedded JPEG, the station's coordinates in the header, and no horizon in it. Then the fallbacks, each by breaking one host: an empty raster → the ~30 m tiles and a note that says so, put into AHD from EGM96 by the geoid grid's own number for the place and the note saying how far; the grid blocked → the tiles left in EGM96, exactly that far from the AHD ground, said, no flood water on it, and not remembered, so the next build is in AHD again; imagery aborted or blank → Esri; everything gone → a stage that says nothing could be read, an empty scene and a disabled export, never flat ground. Then the POV (eye 1.7 m above the ground, W moves at 3.2 m/s, Escape returns), a click on the ground answered with its height, the station as built (the record's rules for pole and tower and for ALERT and TM — a station the record cannot place a red post saying what is not known, not a pole drawn as TM — the pole's gauge, enclosure and kit with the plate naming the station, its door shut eight metres off, open on walking up and shut on leaving; the tower's mast, platform, ten rails, thirteen rungs and cabinet with the Kisters HS40, the Victron and the battery; walking into the ladder, W up it with Shift, the deck at the top with the eye 1.70 m over the grating and the cabinet door opening on its own, the toe boards holding, the hatch back onto the ladder and S down), the room (a fake Realtime server by `page.routeWebSocket`: the join's config and a track with no address in it, a visitor played in and drawn in their colours where their pose says, walked to the next pose, their arm raised and laser on the ground when pointing, gone when they leave; the twin's own poses gated to four a second and only on change; Space and the Point latch with the laser's dot on the terrain; nothing of it in the `.glb`; the leave on teardown; the switch off costing no socket), a phone with three notes folded under one line and the stage keeping the room, and the renderer torn down with the tab — the frame counter stops — and rebuilt on return. Then the twin inside the Stations map (`map-twin.js`): at zoom 15 with the station on the card its patch is fetched ahead and the map is still a map; at 17 the map offers the twin and is still a map until the offer is pressed, then hands over — the overlay up in the Leaflet container, Leaflet's drag and wheel held off, the station card above it — with **one ray per line the map drew for the station, in the colour the map gave it**, each ending at the patch's edge; a wheel past the edge hands back one level out and the renderer goes; the Map display switch off keeps the map a map at 18, and on again the same view offers it; ← Map leaves at the zoom the map was at, with the offer back on it; zooming the map out takes the twin down; and Open the tab → lands on the tab with the same station, the paths now read from the relations, one mesh each in the `.glb`. **It moves the way the 3-D map does**, driven with a real pointer and real keys and read back off the rig: a drag moves the ground and keeps the turn and the tilt, a right-drag and a Ctrl-drag turn and tilt about the same ground (up towards the horizon), the arrows move it and Shift with them tilts and turns, a double-click zooms in; the side panel's 🧭 and tilt buttons are up while the twin is (the 3-D map shut), read its camera, face it north, look straight down and tilt back to 60°; the compass on the stage, a button now, clicked for real faces it north and keeps the tilt; the Orientation button no longer wears 🧭; and the hint along the stage says how to move it in `viewMoveWords`' words. three.js is served from the `three` devDependency, so the check needs no network; it needs WebGL2, which Playwright's Chromium has through SwiftShader, and skips rather than fails without it |
| `npm run photos` | field photos (`photo-meta.js`, `field-photos.js`, `map-photos.js` and the twin's markers), in two halves. **Under Node**, the reader against photos built byte by byte (`lib/exif.mjs`): EXIF in a JPEG in both byte orders, a HEIC with its Exif item in `mdat` and in `idat`, a PNG's `eXIf` after its pixels and a WebP's `EXIF` — position to a centimetre, altitude, a true or magnetic heading, accuracy, datum, the GPS clock and the time in the zone the camera wrote; XMP alone; a DJI drone's own tags (`GpsLongtitude` and all) with the gimbal as the heading; orientation 6 standing the frame up and the lens's field of view across the upright width; 319 random, truncated and malformed files never throwing and never placed anywhere; a (0, 0) fix and a latitude with no longitude being no position. The zone a time was taken in when the file does not say — the GPS clock's difference, then the place: seventeen places and dates across every Australian zone, both sides of the Queensland border and both daylight-saving changes. The overlay parser against what field camera apps print — Solocator's (the two photos the issue came with), GPS Map Camera's labelled pair and day-first date, Timestamp Camera's DMS, NoteCam's hemisphere-first, an MGA grid reference and UTM with a band (Flinders Peak, the textbook's worked example, to a centimetre) — and against what OCR makes of them: a (T) read as (1), ± as +, ▲ as A, one reading in three with a digit wrong (the two that agree win and the misreading is kept as the rival), a decimal point lost and put back, an unsigned latitude guessed south and saying so; headings whose compass word has to agree (a latitude followed by S, a compass ribbon's bare numbers and `90° N` are not headings); dates both ways round flagged, twelve in the morning as nought. `reconcile()` and `record()`: the file's facts before the overlay's, and **no field the photo did not say — a null is not nought** (a photo with no pitch was being sent as held level, and one with no lens as 1° wide). **In Chromium**, against a fake project (the attachment vocabulary parsed out of 0010, Storage from `lib/storage.mjs`) and the real OCR engine served off disk at its pinned versions — fetched only when a photo needs it: signed out, a sentence and no request; signed in, eight files dropped at once — the two Solocator photos read off their overlays at high confidence (position, heading, ±4 m, 134 m HAE, the printed AEST), one placed from its EXIF without the OCR being asked though it carries the same overlay, the same photo twice refused as one, a HEIC with no picture in it sent to the decoder Chromium needs (fetched for it, at its pinned version, into a worker, and for nothing before it) and refused as damaged, two paddock photos the OCR finds nothing on, and a text file left out and said to be. A photo placed by hand from its row — words refused, a coordinate taking the nearest station, *No station* sent as a null, a station found by its number sent as chosen. The upload: ten objects in the `field-photos` bucket named by fresh uuids, each photo's bytes and thumbnail up before its row, and each record as it should be — what the OCR saw in `meta`, the lens's field of view, nothing for what was not known. The same photo again, refused three ways — asked first with nothing sent, a race lost with the two objects taken back down, a row the database refuses failing with its words and its objects gone, then sent again. The library newest first with every thumbnail signed in one batch; *Unplaced*, a photo placed from the viewer and filed under the nearest station; the carousel — a dialog with the focus in it, → ← Home End, wrapping, the strip, ›, Tab kept inside, Escape handing the focus back to the card even after the library was drawn again behind it — a caption saved as a patch, the original opened inside the click, a removal asking first and taking the row then both objects. The sync's report, and **linking Dropbox by PKCE end to end**: the authorize URL opened inside the click, the code traded with the verifier the S256 challenge was made from and no secret, the refresh token shown once and stored nowhere. **The map**: *On the map* lands on the spot at 16; three pins for four photos, the SW and NE photos one spot with a cone each way the camera faced (46° and 242°), each turned by a custom property; the pin a real click lands on (it was under the network's canvas, seen and never pressed) opening the carousel; nothing from zoom 11, nothing switched off. **Tilted into 3-D** (skipped without WebGL2): the same three pins, read off the 2-D layer with no query of their own — each badge 4 px up and right of where MapLibre projects its point on the terrain, the dots and the cones (laid in the ground's plane) under the station pins — the pair's badge clicked with a real pointer and answered by the badge alone, another pressed with Enter and the focus handed back to it by Escape, and none zoomed out, switched off or signed out. **The twin** (skipped without WebGL): *In the twin* opens it on the photo's station with the camera behind that photo's camera looking the way it looked (242°, not the spot's first 46°); two markers in the patch, each on the ground where its spot is to 5 cm, a wedge per view, none of it in the `.glb`; the line under the stage; the badge clicked where it is drawn; the POV walked up to it — *📷 2 photos taken here — Enter to look* — and Enter. **The viewer's side**, on a spot of five (the SW and NE photos and three Solocator photos put in the bucket by hand, placed from their EXIF): opened from a spot in compass order, N → E → S → W, on the first; a wedge per photo on the compass at the foot of the side, the one shown strong and the rest dimmed, widths the file never gave dashed; a click at 201° bringing up the one photo facing that way, whose ±13 m is the `--bad` red and says "a rough fix" in words; 238° in two wedges, both boxed in the search-hit amber on the strip and the dial, the nearer brought up and the other a second click away; 90° clearing the boxes; Enter on a wedge; a stored photo with no ± in its file read by the real OCR off its picture and saved as `accuracy_m` alone. **A pin moved**: *Move…* opens a map with the pin, the red ±13 m ring, the view cone and the four others' dots; the pin dragged east with the box and the words following, the others' dots with it and back when unticked; *Save* patching the photo by hand and the four others by the same offset; the map clicked, coordinates typed, and saved alone; Escape handing the focus back to *Move…*. Under Node, `needsOcr` asking for a Solocator file's missing ± and `reconcile` taking it only for the same fix. Then signing out takes every marker and pin down. **Last, a real HEIC** (`fixtures/photos/IMG_2041.HEIC`, 1.4 kB, made with pillow-heif — the recipe is beside it in the check): decoded by libheif, placed from its EXIF, filed under Gatton, uploaded as a JPEG with the HEIC's hash and what it was converted from — and the JPEG that went up decoded again and found to be the picture the right way up, four colours in four corners |
| `npm run photozip` | zip packs on the Field Photos tab (`photo-zip.js`, `field-photos.js`). **Under Node**, the reader against zips built byte by byte — stored and deflated entries, a folder, `__MACOSX`/`.DS_Store`/`Thumbs.db` counted as the zipper's, UTF-8 and CP437 names, a data descriptor, Info-ZIP's Unix time, a self-extractor's prefix, a comment, an unneeded ZIP64 record — then every refusal with its sentence: a password, bzip2 and AES, a saturated ZIP64 end record, a split zip, 2,001 files, too many bytes, a photo over 24 MB, a bomb stopped at its declared size, a wrong checksum, a short entry, a directory pointing at nothing, a zip cut in half. **In Chromium** (`lib/photo-project.mjs`): a zip dropped with loose photos — read, placed and uploaded exactly as the loose ones, the same photo in and beside it refused as one, each saying which zip, the pack's line saying what was left out and why, zipped photos let go once read and unzipped again to upload (the bytes that went up are the photo's own), outcomes logged with the zip's name — then a ZIP64 zip refused whole, a zip on the drop zone, and one found through the folder picker |
| `npm run photoreview` | the Review panel and equipment labels (`photo-review.js`, `photo-equipment.js`, `PhotoMeta.ocrLabels`, 0036). **Under Node**, `PhotoEquipment.parse` on clean and garbled OCR of Campbell, ELPRO, Beam, Kisters, Victron, Hydrological Services, Druck, VEGA, OTT and WaterLOG labels, readings pooled, and a warning sign, a Solocator overlay and bark reading as nothing; then the label plan and passes against a fake host. **In Chromium**, against a fake project and the real OCR engine: an editor who is not an administrator (the three lists, disabled buttons and why, a forced decision refused in the database's words, filters asking the database); an upload's outcome logged; 🔎 reading a drawn label and proposing a CR300 s/n 12345 as `ocr`; an administrator correcting a serial (patch = the correction only), approving untouched (no patch), "alongside" (`replaces: null`), rejecting with a note; a station scanned in bulk; labels read after upload; the Google Drive sync block; the station card's Equipment section |
| `npm run flood` | the Digital Twin's flood water (`flood-stages.js`, and its drawing in `digital-twin.js`), in two halves. **Under Node**, against real station records: Gatton's seven levels on one ladder in AHD (minor 7, moderate 10 and major 15 m on the gauge through the zero of 87.54 m AHD in force, dated; the four AEP levels as the sheet gives them), the newest edition of the classes on the zero still in force, a zero on an assumed datum and no surveyed zero leaving the classes off and the notes saying which and why, classes with no AEP row, a station with none of it; peaks on the gauge or in AHD, the highest named with its date, the top rising to it and a peak never colouring the water. The colours: clear blue, green, yellow, red, then magenta to dark blue shared out over one to four AEP levels — and a major class set above the 1% AEP level keeping the water in AEP colours past it, never back to red. Where 0 m is: the gauge zero at the channel, not one 30 m under it, not a storage's, not with no AHD zero, never at the top; the cycle. **The datum under the water**: every ladder, own or borrowed, in AHD and stood only on a ground in AHD (`onGround` leaves none on EGM96 and says why); and `geoid.js` reading `data/geoid-ahd-egm96.json` with the app's own decoder — nothing guessed before it is read, AHD = EGM96 − 0.34 m at Gatton, − 2.07 m at Nuriootpa and + 0.58 m at Scone, no value out at sea or off the grid, a grid of the wrong size refused, the file's own measure of its error at the stations under a quarter of a metre, and every station but the island gauges with a value. **In Chromium** (skipped without WebGL), Gatton's record stood on a valley the check makes — the State's elevation service answered with a GeoTIFF of a channel (bed 89 m), a floodplain (98 m), a hollow 96 m deep inside a flat-topped bank cresting at 103 m, and rising ground to the east (`lib/geotiff.mjs`) — so where the water goes is arithmetic: the channel found by the gauge; each level held from the line with a real click, the plane at its height, yellow at moderate and as opaque as a class; the focus kept on a level pressed from the keyboard, though the line is drawn again under it; the channel wet and the floodplain dry at moderate, the floodplain wet and the hollow dry at major (its fill level the bank's crest), the hollow filling past it; **the water drawn agreeing with the water computed** — the mask's texel under every point of a grid across the patch, found through the plane's own positions and UVs, against the ground's fill levels, at a level whose dry ground is off every axis, so a texture flipped, turned or transposed fails it; the pill on the stage saying it in a few words; the choice remembered; the slider at nought (nothing wet, *below minor*) and a tenth of the way; the staff and a ring per level in its colour; 2× exaggeration; the slider through all 401 steps passing every level in order in its colour, the band changing exactly at each level; **the rise read against its own clock** — SwiftShader draws a handful of frames a second, so every frame's water is checked against the cycle for the moment it was drawn, over four seconds that climb from 0 m, hold at the top, let out and start again; ⏸ holding the water and a still scene drawing nothing; ▶ and ⏸ on the pill; *Hide the water* and *Show it*; nothing of it in the `.glb`; every handler resolving; the canvas's name; a zero on an assumed datum keeping the AEP water from the channel with a note; the Stations map's twin at zoom 18 with the line and the pill, and on a phone the line standing down and the pill still starting and stopping the rise; a browser asking for reduced motion getting still water at the top. **The scale's measure**: under Node, the linear and the logarithmic track and back, and the bend a station's levels are fitted with and whether they warrant it — Gatton's twelve do (names 49 px off their marks on average linear, 4 bent), three classes metres apart do not; in Chromium, on Gatton with its floods, the scale opening linear with Log beside its head not pressed, turning logarithmic by itself on the seam's clock and Log lit, the marks where the bend puts them and the names beside them, the water not moved, the rise and a press and an arrow key along the bent track, Log pressed off and the linear scale kept for the station through a rebuild, Log pressed on again from the keyboard, and a station whose levels do not warrant it left linear. `-v` prints the rise's frames |
| `npm run twinsite` | the Digital Twin's site as the record builds it (`digital-twin.js`, `map-twin.js`), on a valley the check makes — a creek bed at 85 m AHD 30 m west of the gauge between banks at 90.5 m, a 10 cm flight dated May 2021 in the State's imagery catalogue, one bridge span 40 m south of the gauge in its road network's Bridges layer, Overpass left blocked. **The station as built**, measured off the scene's own bounding boxes: a station the SLS lists as Manual is a silver rain collector Ø200 mm × 300 mm, a white 1 m staff gauge, or both side by side; one the record cannot say anything about is a red post 1 m tall with a note saying what is not known; the Type 3 pole and the tower still where the record is sure. **The neighbours**: a station 129 m away built in the patch on its own ground, named, its name on the line under the stage opening its own twin. **The bridge**: Gatton's listed crossing (3.90 m on a zero of 87.54 m AHD) puts the deck nearest the gauge at 91.44 m, level; a station with no listed crossing stands the same span at its banks; a road network that will not answer is said out loud. **Borrowed levels**: a station with none offers the four nearest that have some, with distance, heights, the datum each gauge's zero is on and catchment, and says this ground's datum and the channel's height; one chosen is drawn over this channel as heights on its gauge with the notes saying whose and every datum crossed (from, carried, here — `FloodStages.datumWords`, held under Node for a State-datum zero, an AHD one and both modes), the line's *in m AHD, over this channel* carrying it on hover and the reading saying *over the channel*; carried in AHD instead, no level called a height on a gauge that is not here and the lender's own notes marked as its; a new choice or stopping takes every note the last one brought; a station whose own classes are on a State datum is offered its own, its datums saying that zero is not AHD. **The fold**: the lines over the stage open on arrival, folded after the delay (the check's seam shortens it), put off while the pointer or the focus is in them, and left alone once pressed — and the caveat along the stage's foot, which no fold takes: indicative modelling, in red, one line, a note with the whole of it for a reader and no pointer, on the tab and inside the Stations map. **The offer**: zoom 17 on a station offers the twin and names the flight, nothing is handed over until it is pressed, ← Map leaves the map at the zoom it was, × puts it away until the next zoom in, and 🔍 Zoom to station goes all the way in. Needs WebGL2 and skips without it |
| `npm run twincadastre` | the Queensland cadastre on the Digital Twin's ground (`twin-cadastre.js`) — every lot's boundary with its lot and plan written in it, and the road reserve outlined, washed and named — on a curved valley the check makes (so the ground's triangles are not its bilinear surface) and a neighbourhood laid over it in the Land Parcel Property Framework's own shape: two lots and a third across Railway Street, a T-junction with North Street whose square shares its corners with the four road halves, an unlinked remnant, an easement, a creek, a reserve the DCDB calls "Road", Lot 2 recorded twice (padded, started at another corner) and a strata lot over the station, corners at seven decimals as the service prints them. **The stub honours the query's `where`** — one that answered every row would draw the strata lot whatever the app asked — and pages at five rows with the transfer-limit flag, as the live service pages at 4,000. **Under Node**: heights on the triangle a point is in (the diagonal south-west to north-east, 11.5 m where the bilinear height is 11.75), a boundary cut at every grid line and diagonal so the middle of every piece is on the ground too, clipping, the label point in the middle of a lot and in the corner of an L, the DCDB's accuracy codes as metres and as how they were plotted, "Road" as no name, a junction joined and a remnant refused, the duplicate kept once, and the reserve's outline rules. **In Chromium** (skipped without WebGL): the question asked (the layer found by name, the patch's box, Base and Easement only, GeoJSON to 1 cm, not generalised, paged); twelve parcels and no strata lot; every line on the mesh three draws, found by a ray straight down onto it; the reserve one piece, Lot 2's frontage drawn once in the road colour and kept for when the reserve is off; the remnant a boundary; the easement where it crosses the lot; the wash on the ground's own geometry and nothing of it in the `.glb`; the station's lot, tenure, area, road and accuracy on the line under the stage and the credit line; a real click naming the road, the lot and its easement, the junction by the roads that meet there, and the unnamed reserve; the labels looking down (the station's lot first) on a canvas exactly over the scene that the pointer goes through, none over a sign or under the stage's own controls, and standing in the lot only its own; **the boundary drawn over the 10 cm drape round the station at a slant**, read off two screenshots with the lot lines on and off (red with the pull toward the eye taken out, since the drape is pulled forward over the ground); the lines going with the ground at 2.5×; the two switches, remembered, the frontage white with the reserve off, nothing drawn or credited with both off, nothing asked for a new twin until one is on again, and an answer drawn from memory; a patch read in three pages; a lot plotted to ±25 m and its note; a service answering 500, its note, and Rebuild asking again; New South Wales, where nothing is asked; and the twin inside the Stations map, drawing the same parcels over its own stage and taking them down with ← Map. Confirmed red on three deliberate breaks: the pull taken out, bilinear heights, and every cover type asked for |
| `npm run twinpin` | the move-pin mode where the ground can be seen: **the twin's own tab** — 📍 arms with no map under it, an amber post stands on the ground at the station, a real pointer drags it across the terrain with the readout following to the centimetre (the ground point back through the inverse of the twin's own projection), a click on the ground puts it there, Escape ends the move and not the twin, and Save writes the database's *current* copy of the station with only the position changed and none of its lists, against the stamp that copy came with — refused signed out — then rebuilds the twin on the new spot; **the twin inside the Stations map** — the overlay's 📍 arms the same mode, its panel on the stage while the map's own stands down, a click on the twin's ground moving the pin; and **⛰️ 3-D** — the pin on the terrain as a draggable marker with its leader and "was here" ring, a click on the ground moving it to *MapLibre's own* coordinate for that click (not Leaflet's flat-map one), a real drag of the marker moving it, cancelling taking it away. The datastore is stubbed at `dbSelect` and `dbSaveStation`; what the save sends is the assertion. Needs WebGL2 and skips without it |
| `npm run steps` | `npm run all` and `.github/workflows/web-smoke.yml` name the same checks, in both directions. Parse-only. It exists because the drift has happened twice — `catchments` and `mapfade` each sat in `all` with no CI step, running for whoever typed them and on no push at all — and **both halves stay green while they disagree**, which is why neither was found on purpose |
| `npm run adqual` | the `Data Quality` codes an ARRO export arrives with, and the control that acts on them. The tab read that column from the first import — readings table, callout, both export CSVs, editable by hand — and `runFilter()` read the timestamps and the values and nothing else, so **a reading the telemetry itself had flagged was filtered exactly as though it had not been**. Nothing throws and every other check here is green while it is true. The fixture's flagged readings are deliberately *plausible* — 40.9 m among levels of 0.6–0.8 m, re-sent four times — because 3/5/7 are counts-domain steps and four identical re-sends are continuous with each other at any threshold: make the bad readings bad enough to fail 357 on their own and the check passes against an app that ignores the codes entirely. The load-bearing assertions are the two that can only move if the gate runs *before* the rest of the pipeline, and both are about readings that are **not** flagged — three unflagged readings the walk rejects while the flagged burst is in the list and keeps once it is not, and the good reading after a flagged spike that the rate-of-fall limit blames on the spike until the spike leaves `live` first. 30 assertions, three deliberate breaks |
| `npm run floodlines` | a station's flood classes and AEP levels as lines across a level series on the ARRO Data and Field Data charts (#226), each in **that series' own datum**. The classes are metres on the gauge and the AEP levels metres AHD, a series is one or the other, and every way it goes wrong draws a tidy, labelled line in the wrong place — carried across the gauge zero the wrong way, not at all, or through a zero on an assumed datum. **Under Node** (`vm`, no browser), `FloodStages.lines()` against real records: Gatton's classes as they are on a series on the gauge and up through its zero of 87.54 m AHD on one in AHD, its AEP levels down through it the other way, lowest first; a zero on an assumed or a State datum (Beaudesert AL's), and no surveyed zero, leaving out exactly the lines that needed it with a note naming each and why, while a series on the gauge keeps its own classes; no datum, no lines; the words a line is labelled with, a figure never rounded; readings that look like the other datum named for it, and not where the zero is too near 0 m AHD to tell (Bohle River's 6.50 m); Bowen's gauge, re-levelled in 1990, saying so to a series that reaches back past it. **In Chromium**, an ARRO export for a real `Water Level` sensor through `importFiles`, on a station given Gatton's record: nothing drawn until *Flood classes* is ticked — from the keyboard, the focus kept through the rail's rebuild; each line at the height **the chart's own axis** gives its figure, read back off the tick labels; the axis not moved, and major beyond it named along the top; labels, the legend's keys and the chart's name; the AEP levels carried down to 15.15–16.21 m on the gauge and, with *stretch the axis*, drawn there and nowhere near 102.69; the same record in mAHD drawing its classes 87.54 m higher; a zero on an assumed datum leaving out the lines that needed it — no line, label, note or key for them — with the card saying why; the datum box, and readings that look like the other datum warned of with a fix one press away; Increment drawing none; a Field Data level in counts drawing none and saying why; and **the PNG export decoded pixel by pixel** — each line's row in its colour, minor's label written in it — and the SVG export carrying literal colours |
| `npm run ar` | the AR station finder (`station-ar.js`, 🔭 in the Stations side panel), whose every output is arithmetic nobody can see go wrong — a heading 11° out still draws a tidy row of pins. Under Node: the World Magnetic Model (WMM2025) against NOAA's own test values, the field to 0.1 nT and the declination to 0.01°; the camera's heading, tilt and roll from alpha, beta and gamma for poses built by hand, including a phone rolled 10° upright, where gamma swings to −90° and the matrix does not, and one held in landscape; and the directions — every station in one, each led by its nearest, no two leads within the width, no two labels in a row overlapping. Then the app on a phone, with Chromium's fake camera, a GPS fix the harness sets and compass readings dispatched as Android's and as an iPhone's (a gyro with no north and `webkitCompassHeading` beside it): every station the map shows within the distance in exactly one direction, against a haversine that is not the app's; the heading true north by the declination where the phone stands; the pins on the screen exactly the directions in view, each stem's foot on its bearing; F, R and B in their roles' colours; a tap to the station's sheet with its number and ALERT IDs; *I'm facing it* and Undo; the slider and the types; an iPhone compass's spike smoothed away; Escape twice, with the camera's tracks ended, the GPS watch cleared and the compass listeners gone; *Show on the map*; and on a desktop the map's centre, no camera asked for, ← → and a drag. Four deliberate breaks — the declination's sign, the watch left running, the compass unsmoothed, a stem 6 px off its bearing — each went red on its own assertion |
| `npm run camera` | the Field Camera (`field-camera.js`, `photo-stamp.js`, 📸 under *Site visits*), where everything happens out of `smoke`'s sight — the camera is not on until somebody presses, the stamp is pixels, and a photo kept on the device for want of a signal looks exactly like one that will never be sent. Under Node, the file the camera runs: the EXIF it writes read back by `PhotoMeta.read` — the position to the millimetre, the ±, the altitude and its sign, the true heading, the GPS clock, the shutter's local time with `OffsetTimeOriginal`, a UTF-8 description — after a JFIF header and replaced rather than doubled; the panel's words (Solocator's eight compass words, six places, the ±, the height always with its datum, a zone by name only where it agrees with the clock, Brisbane, Adelaide in daylight saving and UTC); and the panel as text read back by `PhotoMeta.vote`. Then a phone (Chromium's fake camera, a set GPS fix with and without a height, Android's and an iPhone's compass dispatched, Brisbane's clock) against a fake project: nothing asked before Start; the heading true by the declination where the phone stands, none pointed at the ground; the stations suggested — where you stand, the last photo's, in view, nearest — and the one on the stamp; the town asked of OpenStreetMap once and kept; photos taken signed out kept through a reload and sent by themselves once signed in — hash, bytes, thumbnail, row, log — filed under the station on the stamp, picked by hand or *No station* (a null); no network and back, uploads off, already there, a deleted station, an account that may not add photos; a camera-app photo placed and filed by its own EXIF, and that photo stripped of its EXIF read back by the real OCR engine into the same place, heading, ±, height, time and station; leaving the tab letting the camera, GPS and compass go, and a re-render keeping the picture. Three deliberate breaks — the declination's sign, the GPS left running, the station left to the database — each went red on its own assertions |
| `npm run review` | the **Network Review** tab (`network-review.js`, 📐 under *Admin*), in Chromium over the hilly world (`lib/terrarium.mjs`), with the two public inspection views it reads the measured margins from stood in for by routes. Signed out it is a paragraph and Sign in; signed in without being an administrator it says it needs one; neither draws a control or asks the datastore anything. As an administrator: two repeaters picked from the list (and then not offered again), each on the assumed 10 m mast its 4 m radio system calls for and saying so; every station their pass ranges carry gets a row and neither hub does; every cell computed, each row's Best the largest of its cells, and the tiles counting the rows the way the bands read them. The link budget card, set to one of those paths, gives the cell's own figure — the field model, its default allowance (read off the page), the repeater's mast, no terminal clutter — to within 0.05 dB. The measured margins: a visit's figure its largest load, a nought not a test, each figure the attenuator's 3 dB step (21 and 27 make 24–27), the attenuator's 30 dB shown as ≥30 and counted as "at least", a median leaning on an "at least" one too (27 and ≥30 is ≥28.5), and the check against the model over the rows that have both — a model figure inside a step no error, one outside it the distance to it. A proposed site becomes a column at its typed mast for every row, one with no position refused with a reason. The CSV is `floodnet-network-review-…`, says the model it was computed on, and carries a margin and a distance per hub, the measured step as two columns (the second empty for "at least") and a row per station. The converter's arithmetic (a Radio Mobile 24 dB is 20.1 in Flood-Net, 21.7 on site, read as 21), the register's assumed masts counted as the register says, the long pass-range links longest first, and the card's model setting the model the tab says it is using |
| `npm run concat` | byte-exact concat-and-diff against a recorded snapshot (milestone tool) |
| `npm run all` | the eighty-nine that run in CI |

`npm run smoke -- -v` also prints which off-origin hosts were blocked;
`toplevel`, `registry`, `nav`, `shell`, `tabs`, `help`, `search`, `linkbudget`, `mapfade`, `drawkml`, `steps`, `stncard`, `healthcard`, `flood` and `floodlines` take `-v` too, to list what
passed as well as what did not — `shell -v` prints every contrast ratio it
measured, in both themes, which is the fastest way to see how much headroom a
colour has before it stops clearing AA, and `nav -v` prints what each search
probe actually found, which is the fastest way to see why a `find` word is not
doing its job.

CI runs every check in `npm run all` — the list is no longer worth restating here,
because since #183 `npm run steps` holds the workflow and that chain to each
other, so the answer is always "all of them". It runs on every push that touches a root `*.js`,
`index.html`, `styles.css`, `stations.json`, `db/migrations/`, `test/` or the
inspection workbook in `archive/` — see
`.github/workflows/web-smoke.yml`. The `*.js` glob is deliberate: the app's
script list grew as `app.js` was split up — `core.js` and `init.js` in M1, ten
module files in M2, fourteen more in M3, `rf-changes.js` and `workbench.js` in
M4 — and a filter naming each file would have to have been edited by every
milestone. Twenty-six scripts were added across those four and not one of them
changed a line in this directory except the two baselines, which is the claim
the glob was put there to make good.

## Why this is not at the repo root

`docs/floodwarning-net.md:90` states the deployment decision: *"Flood-Net is static
files with no build step. An empty build command is correct, not a placeholder."*
A root `package.json` would put that at risk. So the harness has its own
`package.json` down here, and `test/node_modules/` is gitignored. Cloudflare
Pages still sees a repo of static files.

Nothing in `test/` is a runtime dependency of the app. Deleting the whole
directory would not change what a browser loads.

## Decisions worth knowing before you edit these

### The page is served over HTTP, not `file://`

`file://` is a supported mode for the app and deliberately so — it is a field
tool, and someone opening `index.html` off a laptop with no server is
anticipated. But it is a bad mode to *test* in: over `file://` the bundled
`stations.json` is unreachable (`autoLoad()` says so at `app.js:188`), so
`state.data` stays null and twelve of the twenty tabs render the empty state
instead of themselves. A smoke test that never draws a station table proves very
little.

So `lib/server.mjs` serves the repo root on a loopback port and the test loads
that. Real data — currently ~3,100 stations — through the real render paths.

### Everything off-origin is blocked, except Leaflet

`lib/network.mjs` aborts every request that is not to the loopback origin: the
Supabase datastore, GitHub raw, Overpass, the basemap tile servers. Leaflet is
the one exception every page needs, fulfilled from the pinned `leaflet`
devDependency rather than from unpkg. The libraries the app fetches only when
something asks for one are served from their devDependencies the same way —
MapLibre (the 3-D view), three.js (the Digital Twin), Tesseract.js (the field
photos' OCR) and libheif-js (their HEIC decoder). The last three are answered
only at the version pinned there and aborted at any other, so a pin that
drifts fails its check instead of being answered with something else;
MapLibre's is held by `npm run map3d` asserting the version that loaded, and
that it is both the one `map-3d.js` pins and the devDependency's. One check
runs over `file://` after all, for one reason: MapLibre 6's worker does not
start there on its own (`map-3d.js` says why), so `map3d` opens the repo's
`index.html` as a file — stations from GitHub raw, answered from the committed
`stations.json` — and holds the 3-D view's worker to answering there too.

Three consequences, all intended:

1. `autoLoad()` falls through the datastore to the bundled `stations.json`. The
   run is deterministic, uses committed data, and exercises the fallback path
   rather than the happy one.
2. A run needs no network at all, so it behaves the same on a laptop, in a
   sandbox, and on a CI runner.
3. Blocked subresources appear in the console as `Failed to load resource`. Those
   are the policy working, not the app failing, so `smoke.mjs` filters exactly
   that pattern and nothing else.

#130 asked for one of three approaches here to be picked and documented. This is
the pick: vendor Leaflet, block the rest.

### `pageerror`, not just `console.error`

The single most important line in `smoke.mjs`. An uncaught `ReferenceError`
during script evaluation never reaches `console.error` — it surfaces as
`pageerror`. A test watching only the console would miss the entire class of bug
this exists to catch. `pageerror` is never filtered.

### Opening a tab is not enough — the handler audit and the click phase

Added by [#135](https://github.com/cdomotor-g/MegaNet/issues/135), which pulled
111 top-level names inside two namespaces and needed something that could tell
whether it had broken anything.

An inline `on*=` attribute is a string. The browser compiles it and resolves its
identifiers against the **global** scope, and it does that **at click time**. So
a function moved inside an IIFE stops being reachable from `onclick="foo()"`
with no error at load, no error at render, and nothing thrown until a person
presses the button. `node --check` cannot see it. The duplicate-name check
cannot see it. Neither could this smoke test, which opened every tab and clicked
nothing inside one. `lib/controls.mjs` closes that, two ways:

**`auditHandlers()`** reads every `on*=` attribute the tab rendered, pulls the
callee paths out of it and asks the page whether each resolves to a function.
One `evaluate()` per tab, so it runs on all twenty — 313 distinct handler calls
across 5,578 attributes on a full pass. It is exhaustive over whatever is on
screen, which is its advantage and also its limit: a control that did not render
is a control it did not check.

Two false positives are filtered, and both are worth knowing about before you
add a third: `document.getElementById('x').click()` reads as a call to a global
`click`, so a match preceded by `)`, `]` or `.` is skipped; and a station called
`Fitzroy River (Qld)` sitting in a handler argument reads as a call to `River`,
so string literals are blanked (to the same length, keeping offsets) before
scanning. It is a reachability check, not a JavaScript parser.

**`exerciseSurface()`** clicks. The script is keyed by the handler each control
names — `Workbench.saveCase`, not `.wb-case-bar button:nth-child(2)` — which
makes it a direct statement about a module's public surface rather than about
its markup, and means a renamed member fails loudly instead of silently
matching nothing. It reports what it could not reach rather than skipping it, so
a control that quietly stopped rendering shows up in the run.

Both were confirmed to go red before being trusted, and they catch different
things:

| Break | audit | click |
|---|---|---|
| a member dropped from the namespace's return object | ✓ `RfChanges.sort()` does not resolve | ✓ `TypeError: RfChanges.sort is not a function` |
| a handler string left naming the now-private function | ✓ `rfcCardFor()` does not resolve | ✓ no control names the member any more |

**Adding to the click script.** Each entry is `{ member, how, note }` plus
optional `needs` (a member that must fire first for this one to be on screen),
`prep` (a field to type into before pressing), and `soft` (the control may
legitimately not render — reported as "not reached" rather than failed). Use
`soft` sparingly: it is the escape hatch that lets a genuinely broken control
pass. Exactly one entry uses it, `RfChanges.focusAnchor`, which only renders when
two or more pasted series resolve to real stations that share one repeater which
is itself in the ACMA threat layer — driving that would pin the test to whichever
stations are in `stations.json` this month.

### The duplicate-name check is separate from the smoke test on purpose

A duplicate top-level `const` throws at load, so the smoke test catches it. A
duplicate top-level `function` **does not** — the later declaration silently
overwrites the earlier one and every caller of the first starts calling the
second. This was verified: adding a second `function esc()` to a split file
leaves the smoke test fully green and only `npm run names` goes red.

With several agents adding helpers to different files during #129, this is the
one genuinely new failure mode the split introduces.

### `toplevel.mjs` — the load order, made checkable

`index.html` loads thirty classic scripts in a fixed order, and the only reason
that order is safe to add to is that **`init.js` is the only file that executes
at load**. A file that merely declares can sit anywhere, because nothing it does
is observable until something calls it. One top-level statement that runs on
sight takes that back — silently, with every other check still green.

Three milestones raised an ordering worry that measuring dissolved in minutes
(`Alert2` ↔ `Serial`, `PathProfile` ↔ `LinkBudget`, `RfChanges` ↔ `Workbench`),
each time by writing this check by hand and throwing it away. #142 needed it a
fourth time, so it is a script.

Inert means: declarations (initialisers are not inspected), `return` inside a
module IIFE, and `window.X = X` exports. The check **descends into module
IIFEs**, which is where every module in this app lives and where a stray
registration would hide. Three statements in the app do run at load; each is
listed in `ACCEPTED` at the top of the file with the reason it has to, and one
of them — core.js's Leaflet canvas patch — genuinely is load-bearing and says so
in its own comment. Adding an entry there makes that file's position mean
something, so say why.

### `registry.mjs` — the half smoke cannot see

Smoke opens all twenty tabs. It never *leaves* one, so a tab that forgot to
register its Leaflet map or its teardown passes: the tab itself is fine. It is
the leaving that isn't, and it fails in silence — a map missing from the
re-measure list renders at the wrong size after a nav collapse, a module missing
from the stop-list keeps its frame loop or its `ResizeObserver` running behind
whatever tab replaced it. Nothing throws.

Two phases. **Static**: parse every script and require that a file calling
`L.map()` also calls `registerLiveMap()`, `registerTabTeardown()` and
`removeMap()`. This is the one that catches the next tab, the one nobody has
written yet, because it never has to be told the tab exists. **Runtime**: open
the map tabs, spy on `invalidateSize`, collapse the nav and assert every live map
got the call; then leave each map tab and assert its map is actually gone, and
come back and assert it works again. Both phases were confirmed to go red by
deleting `bit-flipper.js`'s registration.

The teardown clause and the re-entry assertions are #143. Until then, three of
the five map tabs — Stations, Bit Flipper and the Workbench — registered no
teardown at all, so their maps outlived the div they were built on and were
still being re-measured on a nav collapse from tabs that could not show them.
`registry.mjs` is what made that legible and is now what keeps it fixed. The
re-entry half is asserted deliberately: a teardown that runs too eagerly breaks
the tab rather than leaking memory, which is the worse of the two failures.

See #142 for why the two registries were inverted in the first place, and #143
for why `removeMap()` exists rather than a bare `map.remove()` — a zoom in
flight when the map goes throws from a timer, where no `try`/`catch` at the call
site can reach it.

### `nav.mjs` — the half smoke never opens

Smoke reaches every tab by calling `switchTab(id)`. It never touches the nav, so
everything about the nav is outside it: a tab could be missing from every group
in `TABS`, or permanently filtered out of the rendered list by the find box, and
all twenty tabs would still open and still render clean. A user has no
`switchTab()`.

Four claims, and each one is invisible from anywhere else:

- **Coverage.** Every tab in `TAB_LIST` has exactly one button, under exactly one
  heading, in a group labelled by that heading. No group holds more than six
  tabs — a ceiling rather than a style rule, so the next tab has to be filed
  rather than dropped on the end of the biggest pile. That was the state #108
  found: eight of nineteen under one heading.
- **The find box.** Every tab is found by typing its own label, and a table of
  probes asserts that the words people actually type — "packet decoder", "com
  port", "contrail", "pdf", and the two labels #108 renamed — land on the tab
  they describe *and* are the match Enter takes.
- **Its rule.** Best score wins: narrows as a second word is typed, survives a
  word that is on no tab, returns nothing for a query that means nothing, and
  matches from the start of a word rather than anywhere inside one.
- **Its exits.** Picking a tab clears the query, and so does collapsing to the
  rail — where the box that would clear it is not rendered.

This file wrote the matching rule rather than checking one that already existed.
The first implementation required every typed term to match, and the probe for
#108's own example — *"the RF Environment view"* — went red on it: three terms,
no single tab carrying all three. The second matched bare substrings, and the
same probe pulled in the Interference Workbench, because "the" is inside
*hypotheses* and "rf" is inside *interference*. Both are assertions here now.

### `shell.mjs` — the half that renders perfectly and cannot be used

Every other check in this directory asks whether the app *works*. This one asks
whether it can be operated by someone who is not looking at it with a mouse in
their hand, and whether the design decisions six parallel issues are about to
inherit are the ones actually in the file.

Nothing above it can see any of that. A page opens all twenty tabs with a
clean console just as happily with no skip link, no landmark structure, a focus
ring that disappears on half its backgrounds, a nav that drops focus on `<body>`
every time you change tab, and a dark palette that fails contrast. None of it
throws.

It is also the check that turns #109 from documentation into a contract. Six
per-tab issues (#136–#141) are each told: use the tokens, do not add a
breakpoint, do not remove the focus ring, do not invent a table pattern. Those
instructions are worth exactly what they can be checked against.

Seven claims:

- **The scale.** Every `@media (max-width: N)` in `styles.css` has `N` in
  `BREAKPOINTS`, which is read out of the *running page* rather than re-typed
  here — so the CSS, `NAV_AUTO_COLLAPSE_PX` and `isPhoneNav()` cannot drift
  apart. Both directions: an unnamed width fails, and so does a named step that
  no rule uses, because an unused step is one somebody will "helpfully" pick.
- **Contrast.** Twenty-five text pairs and four control-boundary pairs, in both
  themes, computed from the values the browser resolves rather than from the
  source — so a `var()` chain, a `color-mix()` or a missing dark value is
  measured as rendered. A sentinel colour distinguishes "this token resolves to
  black" from "this token does not exist and the declaration was discarded",
  which is not hypothetical: `--line` was referenced three times and never
  defined, so three borders were not being drawn at all.
- **The focus ring.** `outline: none` appears in the file exactly where an
  allowlist in `shell.mjs` says it may, and every allowlist entry corresponds
  to a rule that still exists. A stale exemption is a licence nobody is using
  and the next person reads as precedent.
- **Landmarks and the skip link.** One banner, one main that can take focus,
  one labelled nav, one labelled complementary — counted *outside*
  `#main-content`, because five tabs render an `<aside>` of their own inside it
  and naming those is each U-issue's job, not this one's. The skip link has to
  be present, first in the tab order, visible when focused, and actually move
  focus rather than only scroll.
- **Disclosure.** Four shell controls open something; each is toggled and its
  `aria-expanded` re-read. Exactly one nav item is `aria-current`.
- **Focus and voice on a tab switch.** Focus lands on the new tab's own nav
  button — `renderTabs()` replaces the nav's `innerHTML`, so the button that
  was clicked is gone by the time the switch finishes, and a keyboard user was
  left on `<body>` every single time. And the guard on the other side: a switch
  from *outside* the shell must not move focus at all, because `switchTab()` is
  also called at startup by `Workbench.restoreFromUrl()`.
- **Sideways scroll.** The document does not scroll horizontally at 375, 768 or
  1440, in either theme, on the shell and on the proving-ground tab. Not all
  twenty: that is U1–U6's Definition of Done, and asserting it here would be
  claiming work #109 did not do.

Two things this check taught its own author, both recorded in the file. The
first `--ctl-border` candidate cleared 3:1 against `--panel` (3.20) and missed
it against `--bg` (2.98) — a near-miss no eye catches, on a token that is drawn
on both surfaces. And the sideways-scroll assertion went red at 768 px in one
theme and green in the other, which is not a theme bug: crossing the `xs` step
turns both rails from drawers into columns over a 160 ms transition, and the
check was measuring inside it. It waits the transition out now, for exactly the
reason `app.js` does before it re-measures a map.

### `tabs.mjs` — a list rather than a sweep, and two blind spots in it

`shell.mjs` holds #109's system against the shell **and one tab**, deliberately
and by its own comment. `tabs.mjs` (#137) is the other half: the same system
held against every tab a U-issue claims to have converted, named in `CONVERTED`.
A list rather than a sweep, on purpose — a tab nobody has converted does not
fail a check for work nobody has done, and a U-issue's landing commit adding its
ids is what puts it under the check.

**Two ways this check was quietly passing tabs it should not have**, both found
by #141 and both fixed there:

- **It read the whole document's heading outline**, so every tab got five free
  `h2`s: #108's nav group headings sit ahead of `<main>` in the DOM. A tab whose
  own first heading was an `h3` — three of #141's four — followed an `h2` and
  passed. It reads the shell's `h1` plus the headings inside `#main-content`
  now, which is the outline that actually belongs to the tab. Confirmed red by
  putting one heading back.
- **It checked two tabs in a state they are almost never in.** ARRO Data draws
  nothing until a CSV is dropped on it and Field Data draws nothing until the
  datastore answers — which under this harness it never does. Both were passing
  on an empty state and a paragraph while the toolbar, the chart, the legend,
  the readout and the readings table went unmeasured. A `CONVERTED` entry can
  carry a **`seed`** now: source for a function run in the page right after
  `switchTab()`. It builds two series through the module's own boundary
  (`seriesData` → `adoptSeries`) rather than out of a fixture file, so what the
  check draws is what the app draws, and it opens the `<details>` panels because
  a closed one is `display: none` and everything inside it filters out as
  invisible. The seeded ARRO Data tab checks 61 controls and 2 tables; before
  it, **one control and no tables**.

The generalisable half is the same shape as `maint`'s and `history`'s findings:
*a check is only as good as the state it is run against*. Uniform fixtures hide
rules about the non-uniform case; empty states hide everything.

### `mapctl.mjs` — the half nothing here has a pointer for

Every other check in this directory reaches the app the way a script does:
`switchTab(id)`, `page.evaluate()`, a `.focus()` and a keypress. That is the
right instrument for almost everything, and it is *structurally* blind to one
class of defect — anything whose only symptom is what happens when a **mouse
moves away**.

The on-map panels (#164) live entirely inside that blind spot. Four icons in the
Stations map's top-right corner — since the side panel took them, on a phone,
and on the other six maps at any width — each opening a flyout over the map, and the
whole design rests on one promise: **the pin is the only way a panel stays.**
When that promise broke, nothing else here noticed. Nothing threw, every `on*=`
handler still resolved, contrast was unchanged, the tab still rendered, and the
keyboard path `rivers.mjs` already checks — focus the icon, press Enter — went
on working perfectly. The app was simply unusable with a mouse: clicking any
control inside a panel focused that control, an ungated `focusin` promoted the
panel to open-for-real on that focus, and so ticking one checkbox welded the
panel to the map until its icon was hunted down and clicked again.

Two things follow for anything added here later:

- **The assertions ask about pixels, not classes.** `shown` is measured off
  `getClientRects()`, because a class reading "open" about an invisible panel —
  and an invisible panel with no class set — are both failures this file exists
  to name. A check written against `classList` would have passed throughout.
- **Each "it closes" assertion is paired with an "it stays" one.** A fix that
  made panels close on click would have satisfied the first half and broken the
  control. The pair is what pins the behaviour down from both sides, and it is
  the same reason §6 re-asserts the keyboard net that §2 narrows: a panel that
  vanishes out from under a Tab is not an improvement on one that will not go
  away.

The compounding failure is asserted directly, because it is what the bug looked
like when it was reported: two panels open at once, overlapping. Flyouts open at
the top of their *own* icon, and the icons are ~46 px apart while the panels are
150–450 px tall — so a second stuck panel lies **across** the first, the later
control paints on top, and a click aimed at a checkbox in the panel underneath
lands on the panel above it instead.

### `maplinks.mjs` — ask the geometry, not the attribute

The subject is the Stations map's links and the furniture around them (#186),
and every claim in it is invisible to `smoke`: a map whose links are all one
colour, whose arrows never draw, whose credit line covers the move-pin panel's
Save button, whose Clear buttons leave the map three-quarters faded and whose
Map display search hides nothing at all opens with a clean console.

The part worth carrying to the next check is not the subject but the
**measurement**. The panel search filters rows by setting the `hidden`
attribute on them, which is the right signal for a screen reader and, on its
own, hid nothing: half these rows are labels `styles.css` gives
`display: flex`, and an author rule beats the browser's own
`[hidden] { display: none }` at the same specificity. In a property dump the
implementation was perfect — every non-matching row had `hidden === true` — and
on screen the headings vanished and every checkbox stayed exactly where it was.
**A check reading `el.hidden` would have agreed with the bug.** So this file
asks `getClientRects()` everywhere it asks whether something is on screen, and
the same rule found a second defect of the same family in the same change: the
side-by-side split's `lg` fold-back, written where the other `lg` rules live,
lost on source order to the rules it was meant to undo and folded nothing. It
is measured here as a column width at a set viewport, not as a media query
somebody read.

Two other habits from elsewhere in this directory are worth naming because they
are what make the colour assertions mean anything. The link colours are checked
against `MapFreq.rows()` rather than against literals — a re-ordered palette
still passes, a *wrong* pairing does not — which is `terrainkit.mjs`'s rule
about the elevation ramp seen from the other side. And the arrows' direction is
checked as data: the polyline's far end has to be the repeater the arrow points
at, which is the one assertion that can tell "arrows drawn" from "arrows drawn
the right way round".

Confirmed red on three deliberate breaks: the `[hidden]` rule removed, the
credit strip put back inside `.mn-map-stage`, and the backbone's dash pass
dropped with a repeater-to-repeater path given a direction it hasn't got.

### `inspections.mjs` — the half the network policy hides

`registry.mjs` exists because smoke opens every tab and never leaves one. This
one exists because of the opposite problem: smoke *blocks* the datastore, and
the Inspections tab renders **from** it.

Which sections each of the six inspection forms prints comes out of
`meganet.inspection_form`, and every pick-list on the form comes out of a lookup
table (#115). Under smoke's policy those reads are aborted, the tab correctly
renders "the form itself could not be loaded", the handler audit finds six
handlers on an error panel, and a form of some 1,500 lines that nobody drew
passes. That is a true result about the failure path and says nothing at all
about the form.

So this check answers the datastore instead of blocking it — installing its
route *after* `applyNetworkPolicy`, so Playwright reaches it first, and serving
only the paths this tab asks for. Everything else still falls through to the
abort, which is what stops the test quietly depending on a request nobody meant
to make.

**The fixture is parsed out of `db/migrations/0009_inspections.sql`, not copied
from it.** That is the part worth keeping if this file is ever rewritten. The
form's whole claim is that it renders what the database says; a test that
renders it against a hand-written copy of what the database says is testing the
copy. Parse the migration, and a matrix the form cannot render fails here. It is
also why `db/migrations/**` is in the workflow's `paths:` filter.

What it asserts, for each of the six configurations: the sections on screen are
the matrix's, in the matrix's order; the ones it does not print are *named*
under "Not on this form"; every rendered handler resolves; no calibration block
is offered that the section guard in 0009 would refuse; the Serial Numbers panel
is that sheet's own after a configuration change; and the printed tip-test
reference values are filled in. Then, once: the printed 6% rule computes and
reads the right way either side of the threshold, and a save sends a document
with no section the form does not print and with the untouched grids pruned out.

Confirmed red on three deliberate breaks before being trusted — offering a
calibration block the guard would refuse, dropping a section from the render,
and sending the document unpruned. #146 added a fourth and a fifth: deleting the
Base Station Time box, and offering it on all six sheets rather than the one that
prints it.

### `maintenance.mjs` — the same blind spot, a different claim

The Site Maintenance tab is invisible to smoke for exactly the reason the
Inspections tab is: it renders from the datastore, and smoke blocks it. So the
first half of this check is `inspections.mjs`'s — the ten vocabularies are
parsed out of `0009` by `lib/migration.mjs`, which both files now share.

The second half is different, and it is the interesting one. The inspection
form's claim is *the matrix decides which sections print*, so its test renders
the matrix. The Council form has no matrix — there is one sheet, and its layout
does not vary. Its claim is **fidelity to a piece of paper**, and the paper is
in the repo: `archive/Inspection sheets for printing.xlsx` holds the blank
template and `Council Maint Tasks Mt Kanigan`, the same sheet filled in at a
real station.

So `lib/xlsx.mjs` reads the workbook — a zip of XML, both halves of which are in
Node's standard library, which is why this needed no new dependency — and the
check drives the filled sheet through the form. Two assertions come out of that
which a hand-written fixture could not make:

- **Every cell where the filled sheet differs from the blank template is either
  mapped onto a column or named in `UNMAPPED` with the reason.** A value
  somebody wrote on that sheet cannot go missing quietly, and replacing the
  workbook with a fuller example fails this until somebody has looked at the new
  cells. (There is one entry: an unlabelled "HS" in the Rainfall panel that has
  no printed box to be the value of.)
- **Every printed pick-list word resolves against the migration's own `label`.**
  That is #117's "one source of truth, not a parallel list" as a check rather
  than a claim: the workbook says `Poor (add comments below)`, so does
  `meganet.condition_rating`, and that is why the key is `poor`.

The rest: the nine sections render in the sheet's print order, a blank form
materialises the three asset panels and the two data-quality rows, no panel
offers a box its check constraint would refuse, no section states an uncaptured
box, every filled value is read back **out of the DOM** rather than out of
`state`, a save round-trips it and prunes the panels nobody filled in, and the
printed cross-reference works in both directions — the outstanding list starts a
linked form, and the button at the foot of a saved inspection that departed poor
lands on this tab with the link made.

One assertion here is worth knowing about because it exists to cover a hole in
the diff above. #148 gave the Comms and Power panel's Equipment and Power
sub-columns their own Condition and Owner, and the blank template and the filled
sheet carry the **same** words in those four cells — so mapping them changes no
difference between the sheets, and the diff assertion passes either way. What
proves that landed is the DOM: the panel prints three titled sub-blocks, and the
four new controls show what the sheet says. **A cell map is not a coverage
measure when both sheets agree on a cell**, which is the generalisable half.

#148 confirmed its three assertions red before trusting them: dropping the three
sub-headings, deleting one of the four new controls, and leaving a stale
uncaptured note on the panel.

`lib/xlsx.mjs` is not an xlsx library and does not try to be: cell references to
the text Excel would show, no styles, no formulas, no dates. It fails loudly on
anything else, which is the right failure for a fixture reader.

### `history.mjs` — the fixture the app writes itself

The Inspection History tab is invisible to smoke twice over: it renders from the
datastore *and* every record it renders is editors-only, so under smoke's policy
it correctly shows "sign in to read them" and a whole reader passes untested.

What is different about this check is where the fixture comes from. `insp` takes
its reference data out of `0009` rather than out of a copy of it; this takes the
**records** out of the app rather than out of a file:

1. It opens the Inspections tab, sweeps every box the Alert sheet renders and
   fills it in, and presses Save.
2. The fixture's `save_inspection` files the document it was sent.
3. The fixture's `inspection_doc` hands that same document back.

So what is under test is the round trip a person makes — fill in, save, come
back later and read it — rather than a reader agreeing with a fixture somebody
wrote to match the reader. It does the same with the Council sheet.

The assertion the design rests on is the first one: **a saved visit reads back
with exactly the sections the editable form printed, in the same order.** The
read-only view is one walk over the same `FIELDS`/`SECTIONS` tables the form
renders from, and a section in one and not the other means it is not. The CSV is
written from that same walk, and the check asserts that too, as a superset:
every (section, label) pair on screen has a row in the file.

Three things it covers that are specific to reading a record back rather than
writing one:

- **A printed section with no row saved against it says so** rather than
  printing a grid of empty boxes that reads as unfilled. That is 0009's
  decision 2 one level down — "nobody filled this in" is no row — and it is why
  the check leaves the gas section untouched before saving.
- **Pick-list values read back as their labels, not their keys.** Every select on
  the sheet is set by the sweep, so a model that skipped the lookup puts keys on
  screen; the check collects every value from the boxes *and* the grids and
  fails on any that is a known key.
- **The CSV names a photo by its object path and never by a signed URL.** #149's
  rule only bites in an export, because an export outlives the session that made
  it — a signed URL in a file somebody mails around is a private bucket with the
  door propped open.

The Council half asserts that the Comms and Power panel reads back as three
titled sub-blocks with three Conditions. #148 repaired that as a *writer* bug;
this is the reader not quietly re-creating it, which it could do while passing
every other assertion in the file.

Seven deliberate breaks were confirmed red before any of it was trusted: dropping
a section from the model, returning a key instead of a label, printing boxes for
an unrecorded section, dropping blank boxes from the CSV, putting the signed URL
in the CSV, collapsing the comms panel to one block, and sorting the timeline
oldest first.

**One of those seven did not go red the first time, and that is the part worth
carrying forward.** Dropping blank boxes from the CSV passed, because the sweep
had filled every box on the sheet — so there were no blank boxes on screen for
the superset assertion to miss. The fixture now leaves every fourth box blank on
purpose, and asserts that it did. *A check whose fixture is uniform cannot see a
rule about the non-uniform case*, which is the same shape as `maint`'s finding
that a cell map is not a coverage measure when both sheets agree on a cell.

### `lib/storage.mjs` — the upload path, faked, and what it refuses to fake

Both form checks grew an attachments section at #149, and neither owns the
fixture for it, for the same reason `lib/migration.mjs` is shared: two copies of
an upload fake would be two things to keep in step, and the half that drifts is
always the compensating delete.

What it does is serve `…/storage/v1/**` — the upload, the signed URL, the GET of
that URL (a one-pixel GIF, so a thumbnail does not 404 into the console the check
reads) and the delete — plus the three RPCs `0010` adds, and **record** all of it.

What it deliberately does not do is re-implement `meganet.attach_file()`. Every
rule that function enforces — the path prefix, the uuid leaf, the extension
against the content type, the size against the type's own limit, the role, that
the owner exists and is not soft-deleted — is proven against a real Postgres by
`tools/check_attachments.sql`, 47 checks of it. A JavaScript copy of those rules
here would be exactly the "fixture that tests the copy" that `lib/migration.mjs`
exists to avoid: it would pass while the database refused, or refuse while the
database accepted, and either way the check would be about the fixture.

So the browser's half is what is asserted, and it is the half only a browser can
answer: that an unsaved record offers no uploader at all (the attachment is a
foreign key and needs a row to point at), that a type or a size the vocabulary
refuses is refused **before** anything is uploaded rather than after, that the
bytes go up before the index row and a refused index row takes the bytes down
again, that the object is named with a generated uuid under the record's own
prefix rather than with the camera's filename — a private bucket read through
signed URLs is only as private as its paths are unguessable — that the file's own
name survives as the title, that each panel lists only its own role, and that
removing takes the index row first and the object second.

The type vocabulary comes out of `0010` the same way everything else comes out of
`0009`: parsed, not copied. That needed one extension to the reader — `array['jpg',
'jpeg']` is the one value shape `0009` never used, and without bracket-depth
tracking the extensions column parses as two half-columns and every column after
it shifts by one.

Confirmed red on three deliberate breaks before being trusted — naming the object
after the file, offering the uploader on an unsaved record, and skipping the size
check.

### `help.mjs` — the check for content, not for code

Every other check in here is about whether the app *works*. This one is about
whether what it says is still true, and it exists because #105 wrote nineteen
help entries and every way they decay is silent.

Smoke already asserts that each tab has a key in `HELP`. That is the check that
stops the rail rendering blank, and it says nothing at all about what is behind
the key. The three failures that actually arrive later all render a
perfectly good-looking panel:

- **A doc link that 404s.** Nine of these were added at #105, out to `docs/`,
  `db/README.md` and two bundled specification PDFs. Rename one of those files
  and the panel still draws the link, in the right place, with the right words
  on it. This is the load-bearing assertion here, and it is a filesystem check
  rather than a fetch — "is that file in the repo" is the same answer on
  GitHub Pages, and it is the only answer available for the `.md` ones, which
  `docUrl()` sends to GitHub's renderer and the network policy cannot reach.
- **A *see also* naming a tab that no longer exists.** The renderer drops it in
  silence: `TAB_LIST.find()` returns undefined and the map contributes an empty
  string. Rename a tab id in `TABS` and it quietly loses every route into it.
- **A placeholder that shipped.** #105's acceptance is real content on every
  tab, and the only way that stays true of tab twenty is if something checks it.

Two more about the walkthroughs, which are the one thing in the panel that the
prose around them does not also carry: an inline SVG with no `<title>` is an
empty box to a screen reader, and one carrying its own `width` is right in
exactly one of the three widths the rail is ever at. Both are asserted against
the **rendered** drawing rather than the source string, because what the panel
does with it is the question.

Two things it prints rather than asserts, on the no-silent-caps principle: how
many tabs have a walkthrough (two of nineteen, which is the intended result and
should be a stated number rather than an inferred one), and which *see also*
links are one-way. The second is deliberately not a failure — the Stations tab
is worth reaching from nearly everywhere and does not point back at everywhere —
but a missing return route should at least be visible.

Ten deliberate breaks were run before it was trusted and all ten went red on the
assertion they should have. Two of those were the halves of `docUrl()` that
#105 had to add: a fragment surviving (`db/README.md#…` did not match a plain
`/\.md$/`, so the useful link was being served as a download) and the space
encoding for the PDFs.

### `drawkml.mjs` — a wrong file that opens perfectly

The other checks here can lean on the browser: a page that renders wrongly is a
page that usually threw on the way, and `pageerror` catches it. A KML has no
such tell. It is written as a string, downloaded, and opened somewhere else
entirely — and Google Earth is *forgiving*: a `<styleUrl>` naming a style that
was never emitted draws in default white, a `<LinearRing>` whose first and last
points differ is closed silently, and coordinates handed over as `lat,lon`
instead of `lon,lat` draw an Australian catchment 30° south-west of Sri Lanka
without a word. `npm run smoke` presses the button and gets a file it never
opens. Nothing else in this directory looks inside one.

So every assertion is about the parsed document and about the ground its
numbers describe, and the two worth knowing about are geometric:

- **The axis order**, checked by putting a vertex where it belongs rather than
  by reading the source. The circle's ring starts at bearing 000°, so vertex 0
  has to share the centre's longitude and sit *north* of it. Written the wrong
  way round, both halves fail at once.
- **A circle is round on the sphere, not on the screen.** KML has no circle, so
  `MapDraw`'s `ringFor()` steps 72 bearings through `destPoint`. The tempting
  implementation adds degrees of latitude and longitude around a trig circle,
  which is exact at the equator, out by 6% at Brisbane and worse further south
  — an *ellipse* that looks entirely convincing at every zoom. Every vertex is
  measured back to the centre with a haversine written in this file, so that
  version fails by 2.2 km on a 20 km radius.

The membership lists are checked the same way — against a haversine written
here rather than against `acmaHaversineKm`, because a list checked with the
function that built it is checking nothing.

**Six deliberate breaks, and the one that passed.** Swapping the axes, the
flat-earth circle, a dropped `<Style>`, and the guard against a station id that
no longer resolves all went red on the assertion they should have. Turning the
250 m station-fallback down to **zero** did not — because the fixture had put
the test pin on the station's *exact* coordinates, where `0 <= 0` is true. The
fixture now places it 120 m away, on a station with nothing else within 400 m
(this file has co-located ALERT/telemetry pairs, which would have given the
assertion two right answers), and asserts the other end of the rule too: a pin
more than a kilometre from anything enrols nothing. Both mutations are red now.

This is the third entry in this repo's log of *a check whose fixture is uniform
cannot see a rule about the non-uniform case* — after `history.mjs`'s
every-box-filled sweep and #148's cell map. It is worth running against any
check whose fixture is generated rather than typed.

### `ci-steps.mjs` — the two lists that had to agree and nothing made them

`catchments.mjs` landed in `npm run all` with no step in
`.github/workflows/web-smoke.yml`, so it ran for whoever typed it and on no push
at all. `mapfade.mjs` did exactly the same, and was found by accident while
adding the step for something else. Both times the workflow's own comment ended
by saying the check worth writing is the one that holds the two lists together.

What makes it invisible is that **both halves stay green while they disagree**.
A check missing from CI passes locally for the person who wrote it — that is
what "I ran the tests" means. A step naming a script that has since been renamed
fails with `npm ERR! Missing script`, which reads like a broken workflow rather
than like a check that quietly stopped existing. Neither is loud and neither is
anybody's job to notice.

`npm run steps` reads the script names out of `test/package.json`, what
`npm run all` chains together, and every `npm run <name>` under a
`working-directory: test` step in the workflow, and requires them to agree in
both directions. Three exemptions, each named with its reason in the file:
`all` (the chain itself), `test` (npm's own default) and `concat` (a milestone
tool the workflow's footer says is deliberately not run). It is in both lists
like every other check — a rule that exempts its own enforcer has a hole in it.

Parse-only, under a second, and it holds for the check nobody has written yet.

## Using `concat-verify.mjs` across a split

The only claim that matters when a milestone cuts `app.js` is *the split lost
nothing*. Concatenating the pieces in `index.html` order and comparing the bytes
against the file before the cut is what proves it, and it is the only check that
reliably catches the **4 NUL-byte hazard**: literal `U+0000` characters inside
string literals, used as compound-key separators (see #129). `app.js` no longer
carries any: three left with `NetworkView` in M3 and are now `network-view.js`
lines 504 and 568×2, and the fourth left with `Alert2` in M2 and is
`alert2.js:857`. (All four were in `app.js` at 7895, 7959×2 and 19504 before M1,
at 7047, 7111×2 and 18583 between M1 and M2, and at 6154, 6218×2 and
`alert2.js:857` between M2 and M3 — they move whenever code moves out above them,
which is why the check counts them over the whole concatenation rather than
looking them up.) A tool that round-trips one of these files as text and
normalises control characters destroys those keys invisibly. A byte comparison
does not care what the bytes mean.

```sh
npm run concat -- --update    # 1. before cutting, record the baseline
                              # 2. cut the file, wiring each piece into index.html
npm run concat                # 3. after cutting — identical bytes or it failed
                              # 4. land it, then re-record for the next milestone
```

You can also compare straight against a file instead of the recorded baseline:

```sh
git show <ref>:app.js > /tmp/pre-split.js
npm run concat -- --against /tmp/pre-split.js
```

A milestone that also *edits* code cannot be verified this way. That is the
point: do the move and the edit as two commits.

It is not in CI. The baseline is a snapshot of a moment, so any honest change to
`app.js` makes it stale; as a per-push gate it would train everyone to re-record
without looking, and a verifier nobody looks at verifies nothing.

## When the tests need updating

- **A tab was added or removed.** `smoke.mjs` asserts `TABS` holds `EXPECTED_TABS` entries (22 as of the Digital Twin), so
  that a tab added without a `renderMain()` case fails here rather than in front
  of an operator. Give the new tab a `renderMain()` case and a `HELP` entry, then
  bump `EXPECTED_TABS`. The `HELP` entry has to be *written*, not stubbed —
  `npm run help` fails a summary under 140 characters and any of the usual
  placeholder words, which is what stops "every tab is documented" quietly
  becoming untrue at tab twenty. It also needs a **group, an icon nothing else
  uses, `find` words, and a `GUIDE` entry in `site-map.js`** (a sentence and
  two or three jobs for its Site Map card), or `npm run nav` goes red: a tab with no group is a
  tab with no route to it, and a tab whose only find words restate its label is
  findable only by people who already know what it is called. If the new tab
  takes a group past six, that is the check asking where it actually belongs —
  see #108 for how the current five were cut.
- **A tab was renamed.** Change `label` in `TABS` and leave `id` alone: the id
  keys `HELP`, `renderMain()`, the teardown registry and everything in
  `localStorage`. Add the old label to that tab's `find` words as the separate
  words it was — `npm run nav` matches from the start of a word, so `networkview`
  would only ever be reached by typing it as one — and update the tab's own
  heading in its module, or the nav and the page it opens disagree.
- **A script was added to `index.html`.** Nothing to do. Every check reads the
  script list out of `index.html`, so the split milestones are picked up
  automatically — M1 added `core.js` and `init.js`, M2 added ten module files, M3
  added fourteen and M4 added two, none of them touching a line of test code. A
  file added to the repo but not wired into `index.html` is invisible to the
  tests exactly as it is invisible to the app. The two baselines under
  `baseline/` do have to be re-recorded, since both name the script list they
  were taken over.
- **The top-level declaration count moved.** Reported, never enforced — a check
  that goes red for ordinary work gets switched off. Re-record with
  `npm run names -- --update` when it drifts. A *drop* of a hundred in a split
  commit means a file stopped being loaded — or, as in M4, that a hundred names
  went private on purpose, which is why it reports rather than enforces.
- **A tab grew a Leaflet map, or something that has to stop when you leave it.**
  Call `registerLiveMap(name, () => …)` where the map is built, and
  `registerTabTeardown(name, stop)` from the module's `init()`. Both are in
  `core.js`; `npm run registry` fails if a file builds a map and does not do
  all three. Register the *getter*, not the map — a teardown that nulls the slot
  has to be visible to the shell. Take the map down with `removeMap()` rather
  than `map.remove()`, and register the teardown *before* the early return that
  skips building a map, so a render that finds no container still leaves one
  behind for the render that does.
- **A check was added to `test/`.** Three edits, and `npm run steps` fails until
  all three are made: a `scripts` entry in `test/package.json`, that name in the
  `all` chain, and a step in `.github/workflows/web-smoke.yml` under
  `working-directory: test`. That check exists because the first two were made
  twice without the third, and a check CI does not run is a check that is not
  there. If a new check genuinely should not run per push, add it to `EXEMPT` in
  `ci-steps.mjs` **with the reason**, the way `concat` is.
- **A module needs something to happen at load.** It goes in `init.js`. Anywhere
  else and `npm run toplevel` goes red, which is the point: everything else
  declares, and that is what makes the load order safe to add to.
- **A form tab grew a field.** `npm run insp` and `npm run maint` both take
  their fixtures out of files in the repo — the migration and the workbook — so
  a new column with a seeded vocabulary needs nothing here. A new *box on the
  paper* does: add its cell to the map at the top of `maintenance.mjs`, or the
  diff assertion will report it as unaccounted for, which is the intended
  behaviour and not a nuisance. If the blank template and the filled sheet agree
  on that cell the diff will stay silent, so add a DOM assertion too — see the
  note under `maintenance.mjs` above. On the inspection side, a box that only
  some of the six sheets print belongs in the per-configuration box assertion in
  `inspections.mjs`, which checks both that the sheets printing it show it and
  that the others do not.
- **A form tab grew a section, or a section grew a box, and you want to know
  whether the history view followed.** Nothing to do — that is what
  `npm run history` is for. It compares the read-only record against the
  *editable* form's own section list, and the CSV against the read-only record,
  so a section added to either sheet turns up in all three or the check goes red.
  What does need an edit is the fixture's skip list, if the new section must be
  left unrecorded to keep the "nothing was recorded in this section" assertion
  meaningful.
- **A section grew an attachment panel.** `Attachments.sectionHtml()` is the
  whole of it, and `lib/storage.mjs` already serves the routes — but the panel
  list assertion in `maintenance.mjs` is exact, so a third panel on that tab is
  an edit there. That is intended: an attachment panel appearing somewhere
  nobody expected it is worth failing over.
- **A tab needs a width that is not on the breakpoint scale.** It does not get
  one. `npm run shell` fails any `@media (max-width:)` outside `BREAKPOINTS` in
  `core.js`, which is the whole point of #109: nine ad-hoc widths became six
  named steps, and the instruction to #136–#141 not to add a tenth is only
  worth something because this check enforces it. If a step is genuinely
  missing, add it to `BREAKPOINTS`, say what it means in
  `docs/design-system.md`, and use it — a change to the system, made in the
  open, rather than a number typed into one tab's CSS.
- **A colour was added or changed.** `npm run shell` computes WCAG contrast for
  every pair in its contract, in both themes, so a new token needs a
  dark-theme value *and* a line in `TEXT_PAIRS` or `NONTEXT_PAIRS` in
  `shell.mjs` naming what it is drawn on. Two of #109's own colours moved
  because of that check rather than because anyone looked at them. ~~And if the
  colour is one the ARRO chart draws, `ArroData` writes literal values into its
  SVG for the PNG export and does not pick up a token change.~~ **Closed by
  #141** — the chart's twelve colours are `--ad-series-1…12` and it resolves
  them off the document at draw time, so a palette change reaches it on the next
  `repaint()`. `tabs.mjs` holds that round trip; break it and two assertions go
  red. The twelve are categorical and deliberately *not* in the contrast
  contract, the same argument as `--maps-region-*`.
- **A U-issue landed a tab.** Add its tab id to `CONVERTED` in `tabs.mjs`, in
  the same commit. If the tab renders nothing worth checking until something is
  loaded, give the entry a `seed` — source for a function run in the page right
  after `switchTab()` (#141). Three of the twenty are like that: ARRO Data
  draws nothing until a CSV is dropped on it, and Field Data and the Message
  Log draw nothing until the datastore answers, which under this harness it
  never does. The first two were passing as an empty state and a paragraph
  while the toolbar, the chart, the legend and the readings table went
  unmeasured. Seed
  through the module's own boundary rather than a fixture file, and open any
  `<details>` you want checked — a closed one is `display: none`, and everything
  inside it is filtered out as invisible. That list is what the per-tab Definition of Done is asserted
  against, and a tab left off it is a tab nobody is holding — the check will go
  green all the way through a conversion that dropped half of it. The reverse is
  deliberate too: a tab nobody has converted yet does not fail a check for work
  nobody has done, which is why this is a list rather than a sweep over all
  twenty.
- **A tab needs a pattern that is not in the design system.** Add it to
  `docs/design-system.md` §3 and check it here, in that order. #137 added two
  (a scrolling `.table-wrap` is a named region; a clickable row carries a real
  button) and a third that is a condition rather than a shape (a graphic marked
  `role="img"` as a shortcut must have every operation it offers on a named
  control beside it — `tabs.mjs` asserts that every region on the basin drawing
  has a chip). A pattern nobody can find is a pattern the next five tabs will
  re-derive differently.
- **A control needs a different focus ring.** Override it; one selector beats
  the `:where()` rule with no `!important`. What you may not do is remove it:
  `outline: none` outside the two-entry allowlist in `shell.mjs` goes red, and
  an entry whose rule no longer exists goes red too.
- **A member was added to `RfChanges` or `Workbench` that an `on*=` attribute
  names.** Add it to `CONTROL_SCRIPT` in `lib/controls.mjs`. Nothing forces you
  to; the coverage line at the end of the run (`controls: workbench — 18/18
  fired`) is what makes the omission visible. The same applies to any module that
  grows a click script later.

## What this found on the way in

A pre-existing crash on `main`, and a good demonstration of why the harness was
worth building: leaving and re-entering the Stations tab threw an uncaught
`TypeError` out of Leaflet's `Canvas._clear` roughly half the time.

Leaflet 1.9.4 removes a map's layers in stamp order, and the shared canvas
renderer is a layer like any other — so it can be destroyed while paths that draw
on it are still coming off, leaving an animation frame that fires after the
context is gone. With ~7,000 station and link paths on that map it lands about
half the time. Cancelling the pending frame at teardown does not fix it: the
frame that survives is not reliably the one the renderer still holds an id for.
The fix is at the bottom of `core.js` — a redraw with no context returns instead
of throwing. It only has to be installed before the first `L.map()` call; core.js
loads before every module and before `init.js`, which is the only file that
renders a tab at load, so that is the one place it cannot be reordered out of.
