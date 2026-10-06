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

## Four ways in

- **Needs attention** — the findings, worst first: what is wrong, the evidence,
  and what to do. Filter by kind (power, check signals, network, sensors, data
  quality, register); *include notes* shows the informational ones too. *Export
  findings* downloads them all, with their evidence, as CSV.
- **The map** — each station heard, coloured by its worst finding; bigger is
  worse. A pin opens the station.
- **Check signals** — every scheduled station's checks over the window, slot by
  slot: received, received with frames missing, missed, missed network-wide, or
  nobody listening. Worst first; a row opens the station.
- **Receivers and repeaters** — each base station's delivery hour by hour, its
  upload lag and its corrupted copies; each repeater with the stations heard
  behind it, how many are silent now, and the corrupted copies it could have
  carried.

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

### Ask Claude

*Ask Claude* hands the findings to an agent — Claude Opus 5.5 — with tools over
the same readings (`list_findings`, `station_detail`, `context_at`,
`station_readings`, `station_history` up to 30 days, `stations_near`,
`receivers`, `repeaters`, `find_station`). Every tool reads; none writes. It
investigates — sets one finding against another, opens the odd ones, looks at
the moment — and writes the briefing: a headline, the stations to visit first
and why (each linking back to the station), what the network and the register
need, and what it could not tell. Follow-up questions continue the same
conversation. *Thorough* or *quicker* sets its effort; the cost of each briefing
is shown under it.

The key is the person's own: floodwarning.net is a static site, and a key in a
Worker secret would be spendable by anyone who can reach the page. It is typed
on the tab, used from this browser to Anthropic's API, and held in memory unless
*remember on this device* is ticked. The last briefing is kept on the device.

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
readings built for it.
