# Station Health

The **Station Health** tab (Data group) reads the readings landing in the
datastore over days, for operations and maintenance: what they say about each
field station, and about the network carrying them. The Message Log is the
arrivals board — every reading, newest first. This is the maintenance board —
the same readings, read for which stations need a visit, which receiver or
repeater is the real fault behind a dozen station alarms, and which stored
readings are corrupted copies rather than data.

Readings are public, so the tab needs no sign-in. It fetches the last 3, 7 or
14 days (seven by default — about 17,000 readings of the Raspberry Pi feed,
twelve hours at a time, a few seconds) and works everything out in the browser
in a few hundred milliseconds. **Demo week** shows what it does with a made-up
week of real stations, one of every fault planted in it.

## Six ways in

- **Needs attention** — the findings, worst first: what is wrong, the evidence,
  and what to do. Filter by kind (power, check signals, network, sensors, data
  quality, register); *include notes* shows the informational ones too. *Export
  findings* downloads them all, with their evidence, as CSV.
- **The map** — each station heard, coloured by its worst finding; bigger is
  worse. A pin opens the station.
- **Check signals** — every scheduled station's checks over the window, slot by
  slot: received, received with frames missing, missed, missed network-wide, or
  nobody listening. Worst first; a row opens the station.
- **All stations — sparklines** — every sensor heard at a station, a row each:
  the station's number and name, the sensor (its register type and ALERT
  address), its readings across the window as a sparkline, the latest, and the
  worst finding about it. [Below](#all-stations--sparklines).
- **Receivers and repeaters** — each base station's delivery hour by hour, its
  upload lag and its corrupted copies; each repeater with the stations heard
  behind it, how many are silent now, and the corrupted copies it could have
  carried.
- **Airtime** — which stations' transmissions land on top of each other at each
  receiver and whether it costs them, each station's check time and how its
  logger keeps it, and what to change: a check time, or a pair of repeaters'
  delays. [Below](#airtime-transmissions-landing-together).

### A station

Opening a station shows its check schedule (the period, the phase, what share
arrived), its checks as a strip — one mark per slot — its battery across its
solar day with the night-time lows trended, its rain and level, its sensors, its
findings, and the last site visit with the battery measured then (from the
inspection history).

**The context lens.** Pick a missed check (a mark on the strip, or the buttons
under it) or a reading, and the lens shows the network at that moment: which
receivers that hear the station were delivering, which of its neighbours checked
in on time, and a verdict — *this miss is the station's own* when everyone
around it was heard, *something they share* when its neighbours missed too, or
*nobody was listening* when the receivers were down. For a reading, it shows the
station's own readings around it and the copies heard of it.

### AI briefing

The *AI briefing* card (it was *Ask Claude*) gets the findings to an AI that
writes the morning's briefing — Claude, on the tab, or whichever AI the person
can use, from a file.

**With Claude, here.** The card hands the findings to an agent — Claude Opus 5.5 — with tools over
the same readings (`list_findings`, `station_detail`, `context_at`,
`station_readings`, `station_history` up to 30 days, `stations_near`,
`receivers`, `repeaters`, `find_station`). Every tool reads; none writes. It
investigates — sets one finding against another, opens the odd ones, looks at
the moment — and writes the briefing: a headline, the stations to visit first
and why (each linking back to the station), what the network and the register
need, and what it could not tell. Follow-up questions continue the same
conversation. *Thorough* or *quicker* sets its effort; the cost of each briefing
is shown under it.

**Whose key.** An editor or an administrator signed in at floodwarning.net needs
none: the briefing runs on Flood-Net's own Anthropic key, held by the Worker
behind Cloudflare Access (`/api/briefing`, `worker/briefing.js`). The tab keeps
its tools and its loop; only the calls to Anthropic go through the Worker, which
checks Access and the database's word that this is an editor, carries nothing
but the briefing's own request, and stops at **US$20 a day** (Brisbane's day)
— the panel says how much of today is spent. Setting the key up is in
[`access.md` → Claude on Flood-Net's key](access.md#claude-on-flood-nets-key-229).

Anyone else — signed out, a viewer, the github.io copy or a local checkout, or an
editor once the day's allowance is spent — can still use their own key, typed
on the tab and sent from this browser to Anthropic and nowhere else. It is held
for the visit. Only where Flood-Net's key is not on offer is there a box to
remember it, worded as what it is — *this is my own device* — and unticked: a
remembered key is spent by whoever opens the page on that computer next, and no
page can tell a shared computer from a personal one. The last briefing is kept
on the device.

**With another AI, from a file.** Where the browser cannot reach
`api.anthropic.com` (or `cdn.jsdelivr.net`, where the SDK comes from) — a
network that blocks it — or the AI a person may use is another one (Copilot,
for the Bureau's staff), *⤓ Download the briefing pack* saves
`floodnet-health-briefing-pack-<date>.txt`, also offered under ⤓ Export. It is
one text file: how to use it, the instructions Claude gets here with its two
paragraphs about tools swapped for what the file holds, the overview, every
finding that needs attention with its evidence, the notes a line each, the
receivers and repeaters, and each station with a warning or worse in full (up
to 25, worst first) — what `station_detail` answers, with the eight nearest
stations from `stations_near`. Attach it to a chat with any AI and ask it to
follow the instructions in it. The AI cannot look further than the file (a
station's 30 days, the network at a moment, transmissions one by one), and is
told so. Making the pack asks the datastore for each station's last site visit,
as the tool does, and sends nothing anywhere else. *Paste its answer here* takes
the AI's briefing back: it is drawn where Claude's would be, each
`[[station_id]]` a link to the station, marked *pasted from another AI*, and
kept on the device like Claude's. When Claude cannot be reached, the error on
the card points to the pack.

## How the readings are read

**Corrupted copies first.** A repeater that relays with bit errors produces a
second, different copy of a frame seconds after the clean one, and the datastore
keeps both — about 2% of what is stored. The copies of one transmission land
within 12 s (a corrupted copy a median 2.1 s after the clean one, none past
12 s), so readings on one address within 12 s are one transmission: the value
most copies agree on is the reading, the nearest the address's last value on a
tie, and the rest are corrupted copies. Two exceptions, both measured on the
stored readings:

- **A station reporting faster than its copies land.** A rain gauge tipping
  every few seconds through a storm puts real values inside one window. A
  "corrupted copy" a few counts on, between its transmission and the address's
  next or last one (that one within two minutes), or carrying on the run the last
  one started, is the station's next report. 29 of the 33 one-to-three-tip
  "corruptions" on rain gauges in the first week were.
- **Ghosts.** A flip in the address bits files a copy under another address. A
  transmission within three bits — address and value together — of one heard on
  another address in the same 12 s is that transmission's ghost when nothing else
  explains it: always on an address no station here uses; on a station's own
  address only when its value is **out of line with that address's own reports**
  (more than 5 counts from its last and next) while the near-twin is in line with
  its own. `4803 = 51` two seconds after `4801 = 51`, where 4801 reads 50-odd all
  week and 4803 reads in the thousands, is 4801's frame. Two stations whose frames
  only look alike are both in line with their own, and stay readings.

Corrupted copies and ghosts are set aside before anything else is worked out —
a ghost neither counts as a check nor bends a battery trend — and both count
against the repeaters that could have carried them.

**Which station an address is.** 604 of 5,122 ALERT addresses are shared,
usually across the country. Each receiver's area is fixed by the stations it
hears that nobody else carries; a shared address resolves to the station near
there (`sensor-values.js`, the same rule the Message Log uses), and an address
whose only owner is more than 400 km away is a register problem, not a reading.

**Check schedules are learned, not assumed.** The period is read off the gaps
between a station's reports, chosen among the intervals a logger is set to (15
and 30 minutes, 1, 2, 3, 4, 6, 12 and 24 hours): a gap must be a whole number of
periods, mostly exactly one, and the longest period that explains 70% of the gaps
wins. Then every slot in the window is scored.

**A missed check only counts when somebody was listening.** A slot is a miss
only if a receiver path that hears the station delivered something within 20
minutes before *and* after it — one side is not enough: a receiver that died at
02:03 delivered plenty at 01:55. Otherwise it is *unknown*, not missed. A
quarter-hour in which 60% or more of the network's due checks (at least five)
went missing although the receivers were up is a **network-wide miss**, counted
apart from every station's.

**The battery is trended on its night lows.** A solar station swings half a volt
or more every day, so its trend is the lowest reading between 18:00 and 09:00 in
the station's own solar time, night after night (Theil–Sen, robust to the odd bad
night), and the night-to-day swing says whether charge is arriving at all. Single
readings far from both neighbours are spikes — corrupted copies without a clean
twin — and are set aside.

**Rain is a running total.** The gauge's count is put in order (the longest run
that never goes backwards), so a flipped bit or a reset cannot read as a downpour;
a step of 50 tips or more between two transmissions is not rain.

**Silences that happen together are one finding.** Stations behind one repeater
that went quiet inside one check period of each other, stations within 30 km that
went quiet together with no repeater to blame, and stations that went silent
together *and came back* together, are each reported once — the repeater, the
area or the spell — and the stations' own findings point there.

**Repeaters only within reach.** A repeater relays a station only if its pass
ranges let the address through *and* it is within 400 km of the station: the same
address numbers recur across the country.

## Every finding

| Finding | Severity | Triggered when | What to do |
| --- | --- | --- | --- |
| **Silent** | critical after 4 missed checks or a day, else warning | its last 2+ checks missed, quiet for at least 2 periods, while the receivers that hear it kept delivering | Check power and radio at the station; if its repeater went quiet too, start there. |
| **Went silent, then came back** | note | 4+ checks in a row missed and then reporting again, the spell 6 h or longer; *it went at night and came back in daylight* is the shape of a solar site that cannot carry itself through the night | Look for what comes and goes: battery voltage overnight, connectors, the antenna mount, the repeater. |
| **Missed checks rising** | warning (note for 2 in a day) | the last 24 h's miss rate 20 points above the days before, with 2+ misses; or the daily miss rate climbing 8+ points a day to 20% | Check the antenna, cable and connectors, and the path to its repeater — compare with its last fade margin. |
| **Misses n% of its checks** | warning from 25%, note from 10% | misses scattered through the window (not one spell), 8+ checks due | A marginal path: antenna alignment, cable and connectors, the repeater; a fade-margin test settles it. |
| **Checks arrive incomplete** | note | a quarter or more of its checks arrived without every sensor's frame | Frames are being lost on the way: check the antenna and cable, and the radio's transmit power. |
| **Clock drifting** | note | its checks walk 30 s a day or more from their slots | Set the logger's clock, and check its clock battery. |
| **Corrupted copies** | note | 8% or more of its transmissions have a corrupted copy, 5+ of them | One of the repeaters on its path relays with bit errors — see Repeaters. |
| **Battery critical** | critical | last night's low (or the latest) at or below 11.8 V | Replace or recharge the battery and check the charging circuit before the radio browns out. |
| **Battery low** | warning | last night's low at or below 12.2 V (about half charge at rest) | Test the battery under load, and the panel, regulator and fuse. |
| **Battery falling** | warning when it reaches 11.8 V within 30 days or is at 12.4 V, else note | night lows falling 0.04 V a day or faster over 4+ nights, 0.15 V in all | Check the solar panel (shade, dirt, cable), regulator and fuse while there is margin left. |
| **No daily charge** | warning at 12.6 V or below, else note | under 0.12 V between night and day over 3+ nights, below 13.3 V | Check the panel, its cable, the regulator and the fuse. |
| **Battery steady, day and night** | note | no daily swing, at 13.3 V or above | Nothing if mains-charged; a solar station reading dead flat has a stuck sensor. |
| **Battery held high** | warning | 3+ readings at 15.0 V or above on 2+ days | Check the regulator. |
| **One-reading spikes / corrupted rain counts set aside** | note | 2+ single wild readings between two that agree, or rain counts off the gauge's running total | Corrupted copies that arrived without their clean twin. Check the path. |
| **Rain counter went backwards** | note | the count dropped and it was not the counter wrapping | A logger restart or reset — check its power supply. |
| **No rain while its neighbours had rain** | warning | 0 mm here while 2+ gauges within 30 km recorded a median 10 mm or more, its checks arriving through it | Clean the funnel, and check the bucket pivots and the reed switch. |
| **Rain recorded alone** | warning | 10 mm or more in six hours when no gauge within 30 km recorded more than 1 mm | Was the gauge tipped — a visit, wildlife, vandalism? |
| **Level unchanged through rain** | warning | every level reading identical while gauges within 30 km recorded a median 15 mm or more | Check the level sensor — float, encoder or transducer. |
| **Level reads zero throughout** | note | every level reading 0 | A dry pool, or a disconnected sensor. |
| **Stations behind a repeater went quiet together** | critical | 3+ stations behind one repeater, 60% or more of those still heard before, last heard inside one check period of each other | Check the repeater — power, antenna, radio. |
| **Stations around a place went quiet together** | warning | 3+ unexplained silent stations within 30 km of one of them, last heard within two hours or a check period of it | Something they share: a repeater not on file, a link, local interference. |
| **Went silent together, and came back** | warning | spells at stations sharing a repeater or within 30 km that overlap by half the shorter | Check the shared repeater's logs and power for that time. |
| **Repeater relays with bit errors** | warning | the common factor in 5+ corrupted copies, at 3× the network's median rate (3% at least), over 20+ transmissions it could carry | Check the repeater's receiver and transmitter. |
| **Receiver stopped** | critical (warning after a day; a note for a short session days ago) | a receiver that delivered 50+ readings has delivered nothing for an hour | Check the base station on the Base Stations tab — power, network, the receiver software. |
| **Receiver outage** | warning | a gap in its delivery of 45 minutes, or four times its 90th-percentile gap if longer (once it has 30+ bursts to judge by) | Power, network, or the receiver restarting. Checks due then are not counted against the stations. |
| **Uploads arriving late** | warning | the median reading reaches the database 2 minutes after it was heard | Check the base station's network link. |
| **Receiver clock running ahead** | warning | readings stamped more than 5 s after the database received them | Set the base station's clock (NTP). |
| **Checks missed at once** | warning | a quarter-hour in which most of the network's due checks went missing while the receivers were up | Check the receiver, and for interference on the channel then. |
| **Ghost readings** | note | readings set aside as ghosts (see above) | Nothing at the stations — corrupted copies stored under the wrong address. |
| **Address in use, no station on file** | warning when it keeps a schedule, else note | an address heard 4+ times that no station carries, not ghosts | Fix the register: a station is reporting on an address no station on file carries. |
| **Address heard here, filed far away** | warning when it keeps a schedule, else note | the only station on file with it is more than 400 km from where the receiver hears | Fix the register: find the station here that uses it. |
| **Address shared here** | note | two stations near each other share the address, so its readings cannot be attributed | Fix the register. |
| **Address does not read like its sensor** | note | more than half of a "battery" address's readings (4+) are not a 12 V battery | Fix the register: another sensor, or another station, is on this address. |
| **Not heard at all** | note | registered, enabled stations on repeaters within reach that relayed others' traffic, with not one reading | Confirm whether they are decommissioned, or check them. |

## All stations — sparklines

Every sensor heard at a station in the window, a row each (below *Check
signals*; `health.js`): the station's number and name, the sensor — its type in
the register and its ALERT address — its readings across the window as a
sparkline, the latest reading, and the worst finding about it. Every row is
drawn over the same days, left to right, so the rows read together: a gap in
every row at once is a receiver that stopped, a line that stops early is its
station, and a battery whose night lows walk down its box is one to visit.

**What each line is.**

- A **battery**, in volts, with its corrupted copies and one-reading spikes
  left out — the series the station's battery chart draws. Every battery is on
  one scale, 11.5 to 14.5 V (wider only where a reading falls outside it), so
  one row's slope reads against the next. 12.2 V, about half charge, is dashed
  across it, and so is the trend through its night lows; when they are going
  somewhere, the row says so under the line (*↘ falling 0.12 V a day*).
- A **rain gauge**, as the rain fallen since the window began, counted from the
  tips the analysis kept (garbage frames, flipped bits and resets out): a storm
  is a step, a dry week a flat line along the bottom. The box is at least
  10 mm tall, so a passing shower does not fill it.
- A **water level**, without its one-reading spikes, and **any other sensor**
  as it was heard — both in raw counts, each on a scale of its own, at least
  ten counts tall so a wobble of a count stays a wobble.
- A silence longer than the station's checks allow (two and a half check
  periods, and at least four hours) is a gap in the line, not a line across it.
  The dot is the latest reading.

**What is highlighted.** A row wears the worst finding about the sensor itself
— a battery low, falling, not charging or held too high; a gauge dry through its
neighbours' storm; a level stuck — or about its whole station: silent, missing
more checks, its transmissions corrupted. They are the same findings *Needs
attention*, the map and the station are drawn from. A warning or worse colours
the line and the row's edge, and the finding is said in words beside it, with
the next worst under it (*Also: …*). Incomplete checks are pinned to the sensor
whose frame goes missing most. The rows of concern come first, worst first, then
the rest station by station.

**Using it.** Pick a kind of sensor (battery, rainfall, water level, other),
tick *only those needing attention*, or find a station by name or number. The
first 60 rows show, and *Show all* the rest. Point at a line for the reading
under the pointer and when it was heard. A station's name opens the station
above at that sensor's chart. The owner filter narrows it to the owners picked.
On a phone the number and the sensor fold under the station's name, so the line
sits beside it.

Addresses heard that no station on file can be given are counted under the
table; *The register and the data* says which and why.

## Airtime: transmissions landing together

ALERT is ALOHA. A station transmits when its logger says to, nobody listens
first, and two stations heard at one receiver at once spoil each other — one
lost, both lost, or a frame decoded with bits flipped. The **Airtime** panel
(below *All stations — sparklines*; `airtime-analysis.js`, drawn by `health-airtime.js`)
reads the same window for who lands on top of whom, whether it costs anything,
and what to change.

**What the times can say.** A legacy ALERT frame is 133 ms on the air (40 bits
at 300 baud), a keying with its lead-in about half a second. The times stored
are coarser: an RPi ALERT base station stamps a reading when its RTL-SDR's
decoder *finishes* — half a second to three seconds after the burst, varying
with the backlog on that channel — a Quansheng when its line reaches the Pi, an
ERT-A2 in whole seconds. So **together** means two stations' frames stamped
within **3 s** of each other at one receiver channel; nothing finer is claimed.
Two stamped within 0.3 s were decoded out of one squelch opening — back to back
or over each other on the air — and that is said, except on a channel whose
times are whole seconds. Repeater delays are under a second, too fine for these
times to measure at all.

**Does crowding cost anything?** Every transmission is *together* or *alone*,
and *damaged* if it came with a corrupted copy or a ghost. The panel puts the
two damage rates side by side: crowding that costs nothing needs no change.
Each clash (below) is held, separately, to its own slots — a frame lost, the
check missed, or a corrupted copy — against every check in the network that
shared its moment with nobody.

**The hour, folded.** Per receiver channel, every hour of the window laid over
one: transmissions a day in each half-minute, the checks among them, a dot
where one came with a corrupted copy, a tick for each station's check — in the
warning colour where it falls together with another's — and the five busiest
minutes past the hour with who checks in them. A 3-hour station and another an
hour after it stack in this picture without ever meeting; the clashes are worked
out on each pair's own cycle.

**Check signals: when each goes out.** Each station's learned check, as the time
it is heard (the first after midnight and the period, or the minutes past every
hour), how far it strays, and **how its logger keeps the time** — read off how
far each check landed from its slot, check after check, because the register
records no logger model or firmware:

| Its clock | When | What moves it |
| --- | --- | --- |
| **keeps its time** | on its slot to within 15 s | a logger timing its checks off its clock: change its timed-report offset or start time |
| **keeps its time loosely** | within 45 s | the same, with a wider guard |
| **drifting** | walking 5 s a day or more, well past its own scatter | a clock running free: set the clock (and its battery), or turn on time sync, before moving anything — a new offset will not stay put |
| **jumped to a new time** | stepped 30 s or more between two checks and stayed | the pattern of a logger that counts its interval from power-up, so a restart moved it: restart it at the new time, or set it to clock-timed checks |
| **randomised** | wandering more than 45 s about its slot | checks dithered by the logger: nothing to move, and left out of the clashes |
| **too few to tell** | fewer than six checks heard | confirm the time on the logger first |

**Clashes.** Two stations heard at a common receiver channel, or both within
120 km of a repeater that passes both, clash when their checks fall together:
on a circle as long as the greatest common divisor of their periods (a 1-hour
and a 3-hour station meet every 3 hours if they meet at all; two 3-hour stations
an hour apart never do), the stretch each check occupies — first frame to last,
and half a second more — comes within 3 s and both stations' own spread of the
other's.

**What to change**, most pressing first:

- **Move a check.** In each group of stations that clash, the ones that cannot
  usefully be moved (drifting, too few to tell) stay, then the ones doing best;
  each one left clashing is offered the nearest whole half-minute that clears
  every check heard at its receivers and repeaters by five minutes (an eighth of
  a short period), the quieter of two equally near — or the middle of the widest
  gap when nothing is that clear. Moves are planned in turn, so two stations are
  never sent to one gap. A **Change** when the shared slots came off worse —
  twice the network's rate and ten points above it, over four or more — else a
  **Consider**. The *how* is the table above, for that station's clock.
- **A clock walking into a clash** — said before it arrives, with when.
- **Stagger two repeaters.** A pair passing the same stations, sending on the
  same channel, with no delay on file or delays under 150 ms apart, whose shared
  stations' transmissions came with corrupted copies at 3% or more and twice the
  network's rate: a frame both accept is re-sent by both in the same instant.
  The values offered are the Backbone's (`map-backbone.js`, from where the
  repeaters are); each repeater is in one pair at most, and a repeater already
  named for relaying with bit errors is the likelier cause.

**Who lands together, again and again.** Every two stations in a pile-up, each
moment once however many channels heard it, with the minute past the hour it
usually happens at — the same minute every time is two checks meeting;
scattered, it is events — and the moments three stations or more landed at
once.

*Export check times* (and ⤓ Export → *Check times — CSV*) downloads every
station's check time, its clock, who it falls together with and the move
suggested. `npm run airtime` holds the rules to networks built for each, in
Node; `npm run health` holds the panel to the demo week's one planted clash.

## On a station's card, and its pin

The same rules reach the Stations tab (#218, `health-glance.js`), so somebody
looking at one station does not have to come here to see that it went quiet on
Tuesday.

- **The station card** opens with a *Health* section: **Last heard** (when, how
  long ago, and the check period its readings keep), the **Battery** (last
  night's low and where the night lows are going), and the **Findings** worst
  first, every one under a disclosure with its evidence and action. Its class —
  OK, Watch, Fault or No data — is a glyph and a word beside the colour. Each line
  opens this tab on the station, at its checks, its battery chart or its
  findings, and the address says so: `?tab=health&station=<id>`. A station the
  window holds nothing from is said to be so here, with a longer window one press
  away.
- **What the card works out from**: the station's newest readings — its own rows
  and its own ALERT addresses, the newest 1,000 whatever their age, **one
  request** — through `HealthAnalysis.run()`, over the last week it was on the air.
  So the battery, the schedule and the copy rules are this tab's exactly. What
  one station's readings cannot carry is everything that needs the rest of the
  network: whether its receivers were listening, its neighbours' rain, a repeater
  in common. Its silence is said as *Quiet for …*, not *Silent*, and says the
  receivers are this tab's to weigh. A station with no readings left costs a
  second, one-row look at `meganet.station_health`, so *never heard* is only said
  when it is true.
- **Colour pins by health**, in the Stations map's 🗺️ Map display (off by
  default): every pin by when the ingest last heard it — `meganet.station_health`,
  one request for the whole network a load, kept fifteen minutes — and, for a
  station whose card has been opened, by what its readings say.

| Class | When |
| --- | --- |
| **OK** | heard within two of its checks, nothing worse than a note |
| **Watch** | quiet for two of its checks or more (this tab's bar for *Silent*), or a warning |
| **Fault** | quiet for four of its checks or a day, whichever is first (this tab's bar for a critical silence), or a critical finding |
| **No data** | never heard; heard across less than two of its checks with no schedule learned — too seldom to say it is overdue (the tab's *no schedule learned*); or the datastore could not be asked — never *OK* for want of an answer |

A check is the station's own period once its card has been opened; until then it
is taken as three hours, and a fault waits a whole day. How long a station has
been heard comes from its card's oldest reading and from `station_health.since`,
which on a row the HTTP ingest keeps (`online` null) never moves after the row is
made — so it is when the station was first heard. Of the 503 stations the ingest
had heard when this was built, 115 had been heard exactly once; without this rule
ninety of them were red.

On the map bigger is worse, as on this tab's map, and the ring says it again —
dashed and black to watch, heavy and black at fault, hollow and dotted for no
data — so the class never rests on colour alone.

**The server's findings, where it has them** (#215, [below](#with-the-tab-closed)).
While the server's last run is fresh — within three quarters of an hour — the
card and the pins take what it keeps: the card asks for the station's open
findings beside its readings, and the pins' one request a load brings the worst
per station. For a station heard within the week the server reads, its silence
is the server's verdict alone — worked out over every receiver, with whether they
were listening — and *Quiet for …* and the assumed three hours stand down. The
kinds the server keeps (silent, a battery low, critical or not charging, and the
network's) come from it; the rest (a battery falling, a blocked gauge …) are still
worked out on the card. A station last heard before that week, or a server that
has not looked lately, gets the card's own rules as above.
`npm run healthcard` holds all of it.

## With the tab closed

The tab works its findings out when somebody opens it. Since `0059` (#215) the
same findings are also worked out **every fifteen minutes with nobody's browser
open**, and kept by the database, so that something can tell people (#216) and
the agent API can say which stations are silent (#230).

**The same rules, not a copy of them.** `.github/workflows/station-health.yml`
runs `tools/health/report.mjs`, which reads the last week of readings and the
register exactly as this tab does and runs this tab's own `health-analysis.js`
over them — the file itself, loaded in Node, not a port. A SQL version was built
and measured against it on the live week first: it disagreed exactly where the
subtleties decide (an address several stations share, a ghost that makes a
silent station look alive, misses counted from before a receiver died), so the
rules stay in one file and run in two places.

**What it costs.** The register and the whole week are read once every six
hours and kept in the workflow's cache; the runs between ask only for the
readings received since — a few hundred rows, two seconds. Read whole every
fifteen minutes they would have been near 6 GB a month of the database's
egress, more than the free plan allows for everything together.

**What is kept.** The findings about a present condition — *silent*, a repeater
or an area whose stations went quiet together, a receiver that stopped
delivering, a battery low, critical or not charging — at the severity the
analysis gave, in `meganet.health_finding`: one row each, with when it was first
seen, when last, and when it cleared. They are public, like the readings they
come from. History (a spell that came back) and slow diagnosis (a marginal path)
stay on the tab.

**What the tab shows of it.** While the week is still arriving, the status line
gives the server's last look — what it found, worst first. Once the tab has
worked it out, the line says how long ago the server last looked, and if that is
more than three quarters of an hour, that its schedule may have stopped and
nothing is being noticed while the tab is closed.

Base stations are watched with the tab closed too, by the database itself every
five minutes — [docs/base-stations.md](base-stations.md#noticed-with-the-tab-closed).

### Setting it up

Two things, once, both needing a person:

1. **Apply `db/migrations/0059_health_findings.sql`** to the live database, in
   number order after `0053`–`0058` (#210 has the queue and the steps). It
   switches on `pg_cron` for the base station checks.
2. **Give the workflow the project's secret key** (#210, step 4), unless the
   field photo syncs already have it:
   1. Supabase dashboard → the project (ref `jjprlritvhdqpvphfrnu`) → **Project Settings** →
      **API Keys** → under **Secret keys**, copy the key (or **Create new secret
      key**, named `github-actions`).
   2. GitHub → this repository → **Settings** → **Secrets and variables** →
      **Actions** → **New repository secret**. Name `SUPABASE_SECRET_KEY`, value
      the key → **Add secret**.

Then check it: GitHub → **Actions** → **Station health** → **Run workflow**.
The run's log ends `Reported: N open — …`, and
`select * from meganet.health_refresh` shows a `stations` row from a minute ago.
Until the secret is there, every run says so in a notice and does nothing else.

`npm run healthreport` holds the run to the demo week: what it reports is exactly
this tab's findings of those kinds, the planted silent station among them.
`tools/check_health_findings.sql` holds the database to what it does with a
report.

## Limits

- It reads only what the datastore holds: raw readings age out at about 90 days,
  and a station only one receiver can hear cannot be judged while that receiver
  is down — its checks are *unknown*, not missed.
- The schedule is learned from the window. A station heard fewer than five times,
  or only on events, has no schedule; a long quiet while its receivers listen is
  still reported.
- Corrupted copies are counted against every repeater that could have carried
  them, equally. Repeaters that pass the same addresses share the blame however
  different their records are; the Reception Map (*Weigh the copies on the
  Reception Map*) takes the same copies further, and a receiver parked beside the
  suspect settles it.
- The agent's briefing is advice. It names what it could not tell; check its
  station links before driving.

`npm run health` holds the analysis to the demo week — every planted fault found
where it was planted, the stations left alone clean — and each rule above to
readings built for it; and *All stations — sparklines* to a row for every
sensor heard, the planted faults highlighted on their sensors' rows (the sliding
battery's trend line sloping down, the dry gauge flat along the bottom) and the
stations left alone not.
