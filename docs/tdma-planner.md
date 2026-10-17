# TDMA Planner — how an ALERT2 frame is laid out slot by slot

The **TDMA Planner** tab (in the Admin group, open to everyone) takes one ALERT2
radio channel — its base, its repeaters and the field stations they carry — and
works out the time-slot plan that gets every report home: a frame length the
protocol allows, a slot for every transmitter, the repeaters' slots placed after
the slots they forward and sized to the traffic they carry at the storm peak, the
bytes each slot can hold against the bytes it must, and the worst-case time a
report takes to reach the base. It then says, device by device, what to set — in
the IND API's names and, where the manuals give one, the ERT-A2's.

This page is for the people planning the ALERT2 transition (the Network Review
and Transition Plan audience) and for anyone who wants to see how a TDMA frame
works. The tab is [`tdma-planner.js`](../tdma-planner.js); its arithmetic is a
set of pure functions at the top of the file, and `npm run tdma`
([`test/tdma.mjs`](../test/tdma.mjs)) holds them to the figures written here. The
plan is kept on the device that made it and nowhere else. It is a planning tool,
not a configuration tool: nothing it works out is written to a radio or to the
station register.

## What it is for

A legacy ALERT network is contention: every gauge transmits when it has
something to say, and two that speak at once are both lost. ALERT2's answer is
TDMA — one **frame** of time, repeating, divided into **slots**, each slot owned
by one transmitter, so nothing on the channel ever collides. The price is that
somebody has to lay the frame out: decide how long it is, give every station
and repeater a slot, make each slot long enough for what will be sent in it on
the worst day, and put the repeaters' slots where they can forward what they
have just heard. That is the plan this tab works out.

It works **one channel at a time** — a base, the repeaters that reach it and
the stations they carry, which is what shares a frame — and it plans for the
**storm peak**, not the average day, because a slot that fits an average report
cannot carry the first storm that fills it. It is for the
transition: it says what frame and slots a network would need when its stations
move to ALERT2, how much room is left for the stations not yet built, and what
each unit must be told.

## How a TDMA frame works

Everything in the plan comes from five documents (listed at the foot): the
AirLink specification that defines the bits on the air, Van Wie's description
of the protocol for Telos, the IND API that names every setting, Campbell
Scientific's AL200 guide, and OneRain's overview. Where this page gives a line
number it is a line of the extracted text of one of those documents, as the
planner's own comments do.

### Frame, slot and offset

- The **frame** is the period a station's slot repeats at. The IND API allows
  5,000 to 3,600,000 ms, "an integral multiple of the IND's minimum slot
  length" and "evenly divisible into twelve hours" (IND API lines 427–432); the
  AL200 guide says the same and calls 60,000 or 120,000 ms typical (lines 99–101).
- A **slot** is the period a transmitter may start in: at least 500 ms, growing
  in 250 ms steps (AirLink 4.2.1, line 916); the IND API allows 250–10,000 ms
  (lines 436–439). A transmitter can own several slots, "either contiguous or
  distributed across the frame" (AirLink line 920) — adjacent ones for more
  capacity, spread ones for less delay (Telos lines 591–593).
- Each slot has a **start offset** from the frame's start; the frame itself has
  a start offset within the hour (IND API lines 433–442). The AL200 takes both
  in 500 ms steps (AL200 lines 110–111).

### Buffer, window and air time

A transmitter's clock drifts between GPS corrections, so a transmission must sit
inside its slot with a **buffer** at each end — AirLink Figure 4-2 and Telos
Figure 9 both draw 400 usable ms in a 500 ms slot and 900 in 1000, that is
±50 ms (AirLink lines 955–959; Telos lines 607–621). The IND API's *Transmission
Delay into Slot*, 25–250 ms, is "also the minimum time buffer for the slot"
(lines 451–455), and *Center Transmission in Slot* puts the air time in the
middle. What is left is the **window**: `slot − 2 × buffer`. The planner's buffer
is a slider (25–250 ms, 50 by default), and every capacity in the plan follows it.

The **air time** of one AirLink frame is the preamble, then the encoded payload,
then the tail:

| Part | Length | Where it comes from |
|---|---:|---|
| Carrier only | 60 ms by default — a slider, 20–100 ms | AirLink asks for at least 20 ms, up to 60 in noisy places (lines 417–419); Telos's figures use 60 (lines 476–479); the IND API's default is 10 and it allows 5 |
| AGC tone | 15 ms by default — a slider, 5–100 ms | AirLink line 422; the IND API's default is 55 |
| Bit sync | 48 bits, 10.000 ms | AirLink lines 429–444 |
| Frame sync | 32 bits, 6.667 ms | AirLink lines 451–455 |
| Payload | the frame-payload bytes at 4800 bps, 1.6667 ms a byte | AirLink line 496, ±3 % |
| RF tail | 5 ms, fixed | "typically 5 milliseconds" (AirLink line 389); the IND API allows 0–100, default 5 |

Telos's "ALERT2 Preamble 92 Msec" (Figure 3) is 60 + 15 + 10 + 6.667 = 91.667.
The IND API's own defaults, 10 + 55 = 65 ms, are 10 ms *less* than the 75 ms
Telos planned with; the planner uses Telos's values and the sheet says so.

The payload is not the bytes you send. The AirLink puts a 2-byte header in front
of the MANT PDUs, blocks the result and forward-error-corrects each block (AirLink
§3): the **first block** is a fixed 24 bytes (2 header + 22 data, padded if short)
and comes out as 82 bytes on the air; every **follow-on block** carries up to 32
data bytes and comes out as 96, a partial one of *n* bytes as (*n* + 16) × 2; and
whenever there is any follow-on block, a 2-byte convolutional-code tail is added
once (AirLink lines 638–669, 809–811, 827–843). So for a payload of *P* MANT
bytes:

```
D  = max(0, P − 22)                 follow-on data bytes
nf = ceil(D / 32)                   follow-on blocks
frameBytes = 82 + (D > 0 ? 2·(D + 16·nf) + 2 : 0)
rfMs       = carrier + AGC + 10 + 6.667 + frameBytes × 8000 / 4800
airtimeMs  = rfMs + 5
```

Telos's "228 msec first block" (lines 364–367) is `rfMs(22)`; its 388 ms figure
for a full second block leaves out the 2-byte tail (3.33 ms) and both leave out
the 5 ms RF tail, so the planner's strict formula sits 3.33 ms of RF, or 8.33 ms
of air time, above Telos for every payload past 22 bytes. The planner uses the
strict figure.

### The air-time table

What `npm run tdma` asserts, with the default 60 + 15 ms preamble (tolerance
±1 ms):

| Payload (MANT bytes) | On the air (bytes) | RF (ms) | Air time (ms) | Why |
|---:|---:|---:|---:|---|
| 0 or 22 | 82 | 228.33 | 233.33 | a padded first block; Telos's "228 msec" |
| 23 | 118 | 288.33 | 293.33 | the first byte of a follow-on block costs a 1-byte partial block and the tail |
| 25 | 122 | 295.00 | 300.00 | the captured ERT-A2 river report — exactly 300 ms |
| 28 / 29 | 128 / 130 | 305.00 / 308.33 | 310.00 / 313.33 | the ERT-A2 quick-start report, without and with the path count byte |
| 53 | 178 | 388.33 | 393.33 | one byte short of a full follow-on block |
| 54 | 180 | 391.67 | 396.67 | a first block and one full follow-on block — what a ½ s slot holds |
| 55 | 214 | 448.33 | 453.33 | a second follow-on block begins |
| 100 | 336 | 651.67 | 656.67 | |
| 200 | 632 | 1145.00 | 1150.00 | |
| 500 | 1520 | 2625.00 | 2630.00 | |
| 1023 | 3110 | 5275.00 | 5280.00 | the AirLink maximum (line 606): about 5.28 s of RF |
| 22, at the IND API's 10 + 55 ms | 82 | 218.33 | 223.33 | 10 ms less than the Telos values |

And the capacities that follow — the largest payload whose air time fits a
window:

| Window (ms) | Slot it comes from | Capacity (bytes) | Why |
|---:|---|---:|---|
| 400 | ½ s, ±50 ms | 54 | Telos: "a first block and a full follow-on block" (lines 580–583), with 3.33 ms to spare |
| 900 | 1 s | 150 | |
| 1900 / 2000 | 2 s, ±50 / ±0 | 345 / 374 | Telos's 2 s slot in a 15 s frame: (345 − 9) / 4 = 84 legacy records a frame, 20,160 an hour — "over 20,000" (lines 1047–1048) |
| 2400 / 4400 | runs of 5 and 9 half-second slots | 447 / 854 | the second worked example's repeaters |
| 4900 / 5000 | Telos's 5 s repeater slot | 950 / 971 | 43 single-block 22-byte PDUs, or 35 of 27 bytes — Telos's "approximately 35" (lines 583–584) |
| 5400 | | 1023 | the maximum reached; a longer run carries nothing more |

### The 12-hour rule and the valid frames

A frame must divide 12 hours exactly, so that every unit's GPS clock agrees on
where the frames start: 43,200,000 ms = 2⁹ · 3³ · 5⁵, and a frame is a multiple
of 500 ms between 5 s and an hour. That leaves **79** lengths. The 61 up to ten
minutes, in seconds:

> 5, 6, 7.5, 8, 9, 10, 12, 12.5, 13.5, 15, 16, 18, 20, 22.5, 24, 25, 27, 30, 32,
> 36, 37.5, 40, 45, 48, 50, 54, 60, 64, 67.5, 72, 75, 80, 90, 96, 100, 108,
> 112.5, 120, 135, 144, 150, 160, 180, 192, 200, 216, 225, 240, 270, 288, 300,
> 320, 337.5, 360, 400, 432, 450, 480, 540, 576, 600

and then 675, 720, 800, 864, 900, 960, 1080, 1200, 1350, 1440, 1600, 1728, 1800,
2160, 2400, 2700, 2880 and 3600. A 7 s or 11 s frame is not allowed; 4.5 s is too
short. The planner's frame select offers the 61 and 900, 1800 and 3600 s. The
planner also requires the frame to be a whole number of its slot units — a
planner rule for a tidy frame: the IND API only requires a multiple of the IND's
minimum slot (lines 429–430) and the AL200 a 500 ms resolution (lines 99–100).

## What a report costs

Bytes are counted per **MANT PDU**, because that is what a slot carries and what
a repeater re-sends, each with its own header (AirLink lines 620–625: "one or
more concatenated MANT PDUs", oldest first).

An ALERT2 general sensor report is 6 bytes of MANT header (Telos line 669), an
application header of 1 control byte and a 2-byte timestamp (lines 834, 848–853
— the timestamp service is on by default and the planner keeps it on), then a
type byte, a length byte, and 2 + *w* bytes for each sensor of width *w*. The
sensor widths are the ERT-A2's own (its ID table, Sept 2025 manual lines
1049–1063): rain 4, stage 3, battery 1, RSSI 1, air temperature 2, humidity 1,
pressure 2, wind speed, direction and peak 2 each.

| Report | Sensors | MANT PDU bytes | Where it comes from |
|---|---|---:|---|
| Rain | rain, battery | 20 (21 with path service) | |
| River | stage, rain, battery | 25 (26) | the ERT-A2 frame captured in Flood-Net ([`alert2.js`](../alert2.js) `SAMPLE`) |
| Quick start — the default | rain, stage, battery, RSSI | 28 (29) | the ERT-A2's ALERT2 Quick Start (2021 manual lines 1528–1557; Sept 2025 lines 934–944) |
| Weather station | rain, air temperature, humidity, pressure, wind speed, direction, peak, battery | 43 (44) | |
| Housekeeping — a repeater's own | battery, RSSI | 17 (18) | |
| Each extra 2-byte sensor | | +4 | |
| From the register's sensors | register mode only | widths by type: rainfall 4, rainfall increment 4, water level 3, battery 1 | no sensors known → quick start |

The default report, 28 bytes, is already past the first block's 22 and so costs
a follow-on block — 310 ms, not the 228 ms single block a two-sensor rain gauge
sends.

**Path service** — *Add Path Service* in the IND API — makes each repeater append
its address to the header as it forwards: 1 count byte at the origin and 2 bytes
per repeater traversed (IND API lines 1109–1110; Telos line 675), the header
capped at 22 bytes. The IND API's default is off (lines 304–306); Telos
recommends it with echo suppression on multi-repeater networks (lines 710–713);
the only ERT-A2 capture on file asked for none. The planner plans with it **on**,
conservatively.

**Each sensor as its own PDU** — a switch, off by default. The ERT-A2 capture in
the 2021 manual (lines 2144–2163) sends each sensor as a separate MANT PDU rather
than one general sensor report; under TDMA those aggregate into one AirLink frame
in the station's slot, but each keeps its own 6-byte MANT and 3-byte application
header, so a sensor of width *w* costs 13 + *w*. The quick-start report becomes
17 + 16 + 14 + 14 = 61 bytes, 65 with path service (a count byte per PDU), and
every repeater adds 2 bytes to every one of those PDUs. The planner was first
written with this unmodelled; it is now the switch, because it is the only way an
ERT-A2 has been seen to report.

**Reports per frame.** An ERT-A2 sends after *Report Sensitivity* changes — 10
sensor-value changes by default, 10 mm on a river (Sept 2025 manual line 1039) —
then holds off for *Paralysis Time* (10 s in one ELPRO document,
600 s in another), so a station can have several reports ready when its slot
comes; they aggregate into one AirLink frame (AirLink lines 907–909). The slider
*Reports per station per frame* (1–6) sizes the slot for that peak.

**A repeater's run** carries, as separate PDUs: every PDU of every slot it
forwards in that sector, each grown by the path bytes; what its child repeaters
forwarded, grown again; its concentration PDUs (below); and, in its first run,
its own report. One AirLink frame, one preamble, one AirLink header (Telos lines
641–644). If the total passes 1023 bytes — the most one AirLink payload holds
(line 606) — one run cannot carry it: the plan says how many runs of ≤ 1023
bytes the PDUs need and that *Repeater slots per frame* is the remedy (below).
A single AirLink payload past 1023 bytes has its oldest PDUs removed (lines
622–625), which is exactly what the plan is sized to avoid. The ERT-A2 manual says only that a
repeater "will aggregate ALERT2 data frames when there is very high incoming data
flows" (Sept 2025 lines 693–695); the per-slot aggregation here is the protocol's
rule, and the help says so.

**Legacy concentration.** A repeater can take legacy ALERT readings and send them
on as a concentration PDU: 9 bytes of headers plus 4 bytes a reading (Telos lines
1002–1004, 1027–1029), each reading carrying a time offset of up to 255 s
(lines 1018–1019) — so a legacy reading cannot wait longer than that for the
repeater's slot. Three readings fit the first block (21 bytes); eleven make 53.
The slider *Legacy readings per gauge per minute* (a tip per millimetre at
60 mm/h is one a minute) sets the peak, and the records a repeater holds per
frame are `ceil(gauges × rate × frame / 60 s)`.

## How slots are allocated

### Hop order — deepest first

The default order walks the network from each base: a node's child repeaters
first (by name, each recursively), then its child field stations (by name), then
the node itself. So every repeater's run comes **after every slot it must
forward**, and a report crosses every hop within one frame; and each repeater's
own stations sit immediately before it, which is what the timeline shows. The
only latency-and-ordering statement in the sources is the IND API's, about the
acknowledgement round trip: with one hop it is "1 frame time + 1 slot time" at
least and 2 frames at most, "dependent on the ordering of the transmitters in
frame" (lines 408–414). *Order by station name* exists to show the cost of
ignoring that: a repeater whose slot comes before its stations' forwards their
reports a frame late, and every affected station is flagged.

### Runs sized to the peak

A field station's slot is the fewest slot units whose window holds its peak
bytes — one half-second unit for a 29-byte quick-start report (54 fit), two if
the clock buffer is raised to 100 ms (the window falls to 300 ms and holds 25).
A repeater's run is the fewest units that hold everything it forwards in that
sector, up to the IND API's 10 s maximum slot. Runs grow in whole units: Telos's
"multiple adjacent slots in order to increase data capacity" (lines 591–592).

Past 1023 bytes one run cannot carry the load, and the plan says what would:
**k**, the fewest runs of ≤ 1023 bytes the repeater's PDUs pack into, in order
(33 quick-start reports with path service fill one), is what *Repeater slots per
frame* must be set to — or the repeater's stations are split between repeaters.
The warning against the run says so in those words, the *Room for* tile repeats
it, and *Shortest frame that fits* reports that no frame length would help
(below), because the cap is bytes per run, not time: a 10 s slot holds nothing
more than a 5.4 s one. The sheet carries the one-slot-per-device caveat that
goes with k (the configuration sheet, below).

### Sectors

*Repeater slots per frame* (1–6) splits the frame into that many **sectors**; a
repeater's stations are spread one per sector and the repeater gets a run in
each sector that received anything, so a report waits at most one sector for its
repeater — Telos's "multiple slots within a single frame in order to reduce
latency" (lines 592–593). *Field stations transmit in every one of those* gives
each station a slot in every sector as well — Telos's station A, two slots 5 s
apart in a 10 s frame (AirLink lines 924–926). With that switch on, every run
is sized for a full report from every station — a worst case per run — so a
device's peak bytes and the byte totals are *S* × one report; the slot plan's
footnote says so.

### Keeping slots clear

*Spare slots to keep* is a target (20 % by default): the plan warns when fewer
are left. *Reserved slots at the frame's end* are left empty for a neighbouring
network or for maintenance — Network Review's principle of a slot kept empty
where a transmitter is within about 50 km of another network's receivers. *ALOHA
share* leaves a share of the frame for legacy contention traffic; AirLink says
mixing access methods "will reduce the benefits of TDMA" (lines 865–867), and
the plan says so.

### The latency walk

The worst case is a report ready just after the station's slot has started: it
waits a whole frame for its next slot, then at every hop waits for that
repeater's next run, and arrives when the last repeater's run ends. Typical is
about the worst case less half a frame. In the planner's words: *worst case = a
report ready just after the station's slot has started waits a whole frame for
its next slot, then every hop's wait to that repeater's next run; typical ≈ worst
− half a frame*. The walk is the planner's model, not a figure from the sources:
the IND API's round-trip statement above is the nearest analogue. When a
repeater's next run is not later in the same frame the report waits for the
first run of the next frame, and the station is flagged *Waits a frame*. If a
hop's repeater has no slot at all — the frame was full before its run — the walk
stops there: the station's latency reads *—, repeater has no slot*, the
worst-latency tile says *unknown: R has no slot*, and the journey follows the
busiest placed device as far as that repeater.

### Worked example 1 — Telos's 30 gauges and a repeater in a 20 s frame

Telos lines 571–575: "30 gage sites and a repeater on a single channel. Each gage
could be assigned a ½ second long slot and the repeater a 5-second slot in a
20-second frame." The preset *Telos textbook* sketches that — one repeater, 30
stations — with the ERT-A2's quick-start report, path service on and no spare
target:

| Device(s) | Depth / hops | Slots | Offset (ms) | Length (ms) | Window (ms) | Capacity (B) | Peak (B) | Use | Latency (s) | Notes |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| r1-f01 … r1-f30 | 2 / 1 | 0 … 29, one each | 0, 500, … 14,500 | 500 | 400 | 54 | 29 | 53.7 % | 40.0 (f01) … 25.5 (f30) | hop limit 1; 313.33 ms on air |
| r1 | 1 / 0 | 30–39 | 15,000 | 5,000 | 4,900 | 950 | 948 = 30 × 31 + 18 | 99.8 % | 25.0 (its own report) | within 10 % of capacity; 4,870 ms on air, 30 ms to spare |
| base | 0 | — | | | | | | | | receives only |

Forty slots, forty used, none spare; worst latency **40.0 s** at the first
station (it misses its slot by a hair, waits a frame, transmits in 0–0.5 s and
the repeater forwards it at 15–20 s). The planner reproduces Telos's frame — 30 ×
0.5 + 5 = 20 s — and shows it has 2 bytes of room: a fifth sensor, or path
service through a second repeater, breaks it. Telos sized the 5 s from "approximately
35 single block frames"; the formula gives 43 of 22 bytes or 35 of 27, so treat
~35 as the rule of thumb and the formula as the plan.

### Worked example 2 — a two-hop chain, 60 s frame

The preset *Backbone chain*: base → r1 → r2, twelve stations on each repeater,
½ s slots, a 20 % spare target. Order: r2's stations, r2, r1's stations, r1.

| Device(s) | Slots | Offset (ms) | Length (ms) | Window (ms) | Capacity (B) | Peak (B) | Use | Latency (s) | Hop limit |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| r2-f01 … r2-f12 | 0 … 11 | 0 … 5,500 | 500 | 400 | 54 | 29 | 53.7 % | 79.0 (f01) … 73.5 (f12) | 2 |
| r2 | 12–16 | 6,000 | 2,500 | 2,400 | 447 | 390 = 12 × 31 + 18 | 87.2 % | 73.0 | 1 |
| r1-f01 … r1-f12 | 17 … 28 | 8,500 … 14,000 | 500 | 400 | 54 | 29 | 53.7 % | 70.5 (f01) … 65.0 (f12) | 1 |
| r1 | 29–37 | 14,500 | 4,500 | 4,400 | 854 | 806 = 12 × 33 + 20 + 12 × 31 + 18 | 94.4 % | 64.5 | 0 |

120 slots, 38 used, 82 spare (68 %); worst latency **79.0 s** at r2-f01 — a 60 s
wait, then 19 s to the end of r1's run; room for about one more station, set by
r1, the tightest repeater (floor((854 − 806) / 31) = 1); r1 within 10 % of
capacity. The same network with two repeater slots per frame gives r2 three units
and r1 five in each half of the frame, and halves the wait at each repeater.

### The frame summary

Over the whole plan: slots used and spare, the slot and byte utilisation, the
deepest station and the most hops, the worst latency and whose it is, how many
unplaced transmitters there are, and **room for about N more stations** — the
smaller of the spare slots (per slot a station needs) and what the tightest
repeater could still forward.

## The warnings

Errors stop the plan; warnings are printed against the device or the frame, in
words, never as a colour alone.

**Errors**

- *Frame must be 5 s–3600 s, a multiple of 500 ms, dividing 12 hours evenly*
  (IND API lines 427–432; AL200 lines 99–101).
- *Frame is not a whole number of slots* — the planner's own rule, above.
- *Slot 500 ms–10 s in 250 ms steps* (AirLink line 916; IND API lines 436–439).
- *Buffer 25–250 ms* (IND API lines 451–455).
- *Frame start offset must leave room for one frame in the hour* (lines 433–435).
- *N transmitters have no slot: lengthen the frame or shorten the slots.*
- *A legacy reading cannot wait more than 255 s for a repeater slot (a planner
  rule: a concentration record's time offset is one byte of seconds)* — legacy
  gauges present and the frame, divided by the sectors, longer than 255 s. The
  planner's own inference from the record's one-byte offset (Telos lines
  1018–1019); the sources state no such limit in words.

**Warnings on a device**

- *Over capacity: this run cannot carry its peak — needs k runs of ≤ 1023 bytes:
  raise Repeater slots per frame to k, or split its stations* — the load passes
  1023 bytes, the most one AirLink payload holds (AirLink lines 606, 965–967);
  k is the packing described under *Runs sized to the peak*.
- *Within 10 % of capacity.*
- *Fits with under 10 ms to spare — the clock buffer is doing all the work* — the
  ½ s slot's 54 bytes is one such case: 396.67 ms in a 400 ms window.
- *Waits a frame at R: its slot comes before this one's* — the latency walk
  wrapped a frame at that hop.
- *More than 6 repeater hops cannot be expressed in Hop Limit* (IND API lines
  391–394; Telos lines 720–726).
- In register mode: *No backbone link to a base — assumed direct*; *No base
  picked*; *Not in any picked repeater's pass range*; on the network, *N
  stations more than 150 km from their hub left out of the plan*; and, on a
  base + repeater that is the root, the note *Base + repeater: its stations land
  here; its repeater role forwards only to an upstream base that is picked*.

**Warnings on the frame**

- *Fewer spare slots than the N % you asked to keep.*
- *Mixing ALOHA on the channel reduces TDMA's benefit* (AirLink lines 865–867).
- *AL200 offsets are in 500 ms steps; odd 250 ms slots misalign them* (AL200
  lines 110–111).
- *Carrier/AGC differ from the Telos planning values (60 + 15 ms); the IND API's
  own defaults are 10 + 55 ms.*

## Reading the page

**The figures at the top** — seven tiles: the frame (and how many slots of what
length); slots used, of how many; spare slots, as a count and a share (amber when
under the target); the worst latency and whose report it is (or *unknown: R has
no slot* when a repeater was left without one); the busiest slot, its device and
its use (amber from 90 %, and said in words when over); room for about N more
stations (or, when a repeater's load is over capacity, the remedy: *R — over
capacity: no run can carry its peak — needs k runs of ≤ 1023 bytes: raise
Repeater slots per frame to k, or split its stations*); and **Shortest frame
that fits** — the planner walks the
valid frames from the shortest and names the first in which everything is placed
with no error, no run over capacity and the spare target met, with a *Use it*
button (or "already the shortest"). On the Telos preset with no spare target
that is 20 s. A frame *fits* only if no device has a run whose peak exceeds its
capacity; when a repeater's load passes 1023 bytes no frame length helps, so the
tile reads *No frame fits at S repeater slot(s) per frame — needs k* and offers
no button. The tile is worked after the page has painted, since it is up to 79
allocations, and only again when something other than the frame length or the
followed device changes. An invalid frame shows one tile with the errors instead.

**1. The network** — *Sketch* draws a network from five counts: repeaters, the
depth of the chain they form, field stations per repeater, field stations heard
straight by the base, and legacy ALERT gauges per repeater. *From the register*
is below. Under either, one line counts the stations, repeaters and bases and the
deepest station's hops.

**🎛️ Frame, slots and traffic** — the card of sliders and switches, in four
groups: frame and slots (the frame length, the slot unit, the clock buffer,
repeater slots per frame, field stations in every one, the order, the frame
start offset); traffic at the storm peak (the report, extra sensors, reports per
frame, the repeaters' own report, path service, each sensor as its own PDU,
legacy readings a minute); keep clear (the spare target, reserved slots, the
ALOHA share); and radio timing (carrier and AGC). Every move works the plan
again at once, and the plan is kept on this device. The presets describe
sketches, so pressing one switches the source to *Sketch* (the register's hubs
are kept for when you switch back) and says so:

| Preset | What it sets | Why |
|---|---|---|
| Network Review default | 120 s, ½ s slots, two repeaters in a chain of two with 12 stations each, 20 % spare | the Network Review's principle; the AL200 guide's typical two minutes |
| Telos textbook | 20 s, one repeater, 30 stations, no spare target | worked example 1 |
| Backbone chain | 60 s | worked example 2 |
| Sparse rural | 120 s, three repeaters side by side with 8 stations each, 4 heard directly, river reports | |
| Dense / flash flood | 30 s, two repeater slots a frame, two repeaters with 10 stations each, 2 reports a frame | Telos's spread slots for latency |
| Legacy migration | 60 s, two repeaters with 15 legacy gauges each and no ALERT2 stations, a reading a minute, a 25 % ALOHA share | Telos's concentration case; OneRain's mixed channel |

**2. The frame** — the timeline: one bar per transmitter in slot order, field
stations green at 70 % height, repeaters blue at full height with an outline and
a label, reserved slots hatched grey one way, the ALOHA share hatched amber the
other way, spare slots a dashed outline; sector ticks and a time axis; on a
narrow screen the drawing scrolls inside its figure rather than shrink its
labels; a run too narrow to draw on its
own is merged with its neighbours of the same role and parent and labelled "12
field stations". Hover a bar for its slots, offset and bytes. Under it the **slot
detail strip** shows the followed device's first slot: the buffers at each end,
the window, and the air time centred in it — "Slot of 500 ms: 50 ms buffers,
400 ms window, 313 ms on air for 29 bytes (capacity 54)". **The frame as a
circle** draws the same bars round a clock face, 12 o'clock the frame's start —
OneRain draws a frame both ways (Figure 3) and each has its uses. *Play* sweeps
a playhead round one frame in eight seconds; it is left out when the system asks
for reduced motion.

**3. One report's journey** — pick a station (the worst by default) and the
diagram draws one row per hop — the station, each repeater, the base — along a
time axis from the moment its report is ready: a dashed wait, the slot it
transmits in, a dot where the report is handed to the next hop, a mark at the
base. The line under it says the worst case and the typical.

**4. The slot plan** — one row per transmitter: role, hops, slots, offset,
length, window, capacity, peak bytes, use, latency, and the warnings in words;
legacy gauges as a sub-row under their repeater ("15 legacy gauges concentrated
here: 15 records per frame"); a total row. In register mode the name opens the
station.

**5. What to configure** — the sheet, below.

**Exports** — *Export CSV* saves the plan as `floodnet-tdma-plan-<frame>s.csv`,
one row per transmitter and then every card setting, so the file stands alone;
*Configuration sheet CSV* saves `floodnet-tdma-config-sheet-<frame>s.csv`, one
row per device and field. *Print* opens every fold and prints the page with the
card and the network's controls left off; the sheet's last line restates every
setting, so the paper stands alone.

## The configuration sheet and the ERT-A2

The sheet has one section per transmitter (a base is a short "receives only"
row), each folded until it is opened — its table is drawn then, so a plan of
hundreds of devices stays light — and two columns of names: the **IND API's** —
what an ALERT2 encoder is configured with, each with its TLV type — and the
**ERT-A2's**, from the Sept 2025 manual's menus.

The wording is honest about what the ERT-A2 manuals show. Neither manual has an
item for the frame, the slot, either offset, the hop limit or path service — not
in Main, Unit Config, Communications, I/O or Diagnostics. The only TDMA mention is
that the VHF/UHF models "require GPS option for ALERT2 TDMA operation" (Sept 2025
line 179). So those rows read **"IND API name — ERT-A2: not in the documented
menus; confirm with ELPRO where it is set"**, and the sheet carries blanks to fill
in. What it does say, row by row:

| Row | IND API field (type) | Plan value | ERT-A2 field | Note |
|---|---|---|---|---|
| Role | — | field / repeater / base | **Unit Type** (Communications) | Field Station, Repeater (store and forward), Receiver Base (Sept 2025 lines 1208–1212) |
| Address | Source Address (24), 1–65534 | the device's address, or "assign" | **Station Address** (Unit Config) | |
| Destination | Destination Address (25), default 1; Add DA in Header (27) | 1 / off | — | |
| Frame | TDMA Frame Length (72) | the frame, ms | not in the documented menus | confirm with ELPRO |
| Frame start | TDMA Frame Start Offset (73) | the offset, ms | not in the documented menus | |
| Slot(s) | TDMA Slot Length (74), TDMA Slot Start Offset (75), one line per run | length / offset, ms | not in the documented menus | the AL200 takes offsets in 500 ms steps; from the second run on: *IND API v1.0 and the AL200 take one Slot Length and one Slot Start Offset per device; the AirLink allows several — confirm your IND accepts several slots, or split the repeater* (IND API lines 436–442; AL200 lines 104–110; AirLink lines 920–922) |
| Buffer | Transmission Delay into Slot (78); Center Transmission in Slot (79) | the buffer / on | not in the documented menus | |
| TDMA | enable TDMA (80) | on | — | GPS option required |
| Hop limit | Hop Limit (64), 0–6, 7 = not enabled | the station's hops | not in the documented menus | the capture showed 1 |
| Path | enable Add Path Service (26); Echo Suppression (63, repeaters) | on / on | not in the documented menus | |
| Timestamp | enable IND time stamp service (40) | on | — | the unit stamps when it has time; not a setting |
| Radio timing | Carrier Only (96), AGC (97), RF Tail (98) | 60 / 15 / 5 | — | the IND API's defaults are 10 / 55 / 5 |
| Clock | GPS clock Turn On period (76), Maximum On time (77) | 60 min / 5 min | **GPS Update**, **GPS Maximum On** | GPS Update — units not stated; GPS Maximum On — minutes (Sept 2025 lines 1223, 1249) |
| Power-up | Radio Transceiver Power-up (102), Audio Preload (103) | 750 / 100 ms | — | |
| Pass list (repeaters) | Address lists (49–56) | the children's addresses as ranges — in register mode, the repeater's pass ranges | **Address List** (one of four, 32 ranges each), **Status**, **Action** Pass, **Entries** | one pass list and up to three reject lists (Sept 2025 lines 1253–1264) |
| Repeater delay | — | **0** — the planner's assumption: the slots do the staggering | **Repeater Delay** | the manual asks for "greater than 200 ms" with multiple repeaters (lines 1250–1252); TDMA behaviour not stated |
| Concentration (a repeater with legacy gauges) | — | the gauges and the records a frame | a linked receiver in ALERT mode on RS-485 | the manual's mechanism: a second unit receiving legacy ALERT, linked on RS-485, whose readings the repeater sends on as ALERT2 concentration frames (lines 742–748, 1369–1370); a reading waits at most 255 s for the run |
| Report cadence | — | the reports-per-frame assumption | **Update Time** (min, default 180), **Paralysis Time** (s — 10 in one document, 600 in another), **Report Sensitivity** (default 10 sensor-value changes — 10 mm on a river) | |
| Format | — | — | **Report Format** ALERT2; **Agency ID** | the Agency ID's format is not stated |
| Bases | — | receives only; no radio transmission | Unit Type Receiver Base; RS-485 to the 115E-2 ("ALERT2 In") | the gateway imposes no timing on the plan — see [`elpro115e_mqtt.md`](elpro115e_mqtt.md) |

**The questions for ELPRO** — printed at the foot of the sheet, because only they
can answer them:

1. Where are the TDMA frame length, slot length and slot offset set on an
   ERT-A2, and in what units?
2. What are *GPS Update*'s units?
3. What does *Repeater Delay* do under TDMA — is it ignored, or added inside the
   slot?
4. Are the hop limit, path service and the application PDU ID configurable?
5. Does a repeater aggregate everything it heard into one frame per slot, or
   only "when there is very high incoming data flows"?
6. Does a linked receiver and repeater pair share one Station Address?
7. What is the Agency ID's format?

## Register mode

*From the register* needs the station register loaded; until it is, the picker
says so and the sketch works meanwhile. Pick **hubs** — the register's repeaters
and bases, the same list the Network Review offers — and:

- the **repeater links** are the backbone pairs the Stations map draws, up to
  *Repeater links up to … km* (100 km by default, as the Transition Plan's rule);
  the hubs are walked from the picked bases, breadth first, and each repeater's
  depth and parent follow from that walk. A repeater no link reaches is flagged
  *No backbone link to a base — assumed direct*;
- **who is the root**: a picked base that does not repeat. If none is picked
  but a picked station carries the base role as well as the repeater role
  (Constitution Hill is one), it is the root at depth 0 — its stations land on
  it, and its repeater role has nothing picked upstream to forward to; the plan
  notes against it *Base + repeater: its stations land here; its repeater role
  forwards only to an upstream base that is picked*. Pick a pure base as well
  and that station is a repeater at depth 1 under it, as any other. Only when
  nobody picked has the base role do the repeaters with a base pair in the
  register become roots at depth 1 under a virtual *Base (not picked — assumed
  <the nearest base in the register>, N km)*, and the network is flagged *No
  base picked*;
- the **field stations** are every station a picked repeater's pass ranges
  carry, within 150 km — a longer pass-range "link" is an address collision, not
  a radio path, so such a station is left out and counted once, however many
  hubs it was far from: *N stations more than 150 km from their hub left out of
  the plan* — and, if *Also stations within … km* is set, every
  field-role station within that distance of any hub (the same meaning as the
  Network Review's radius box);
- a station's **parent** is the picked repeater whose pass ranges cover one of
  its addresses, the shallowest first and the nearest among those; a station no
  pass range covers goes to the nearest hub, flagged *Not in any picked
  repeater's pass range*; a base as parent is one hop;
- a station's **address** is its primary ALERT address, its **sensors** are the
  register's — a type with no width, such as the register's "Repeater" entry,
  is not a reading and counts for nothing — (so the report *From the register's
  sensors* can size each station's own bytes), and the switch *Field stations
  are still legacy ALERT* makes every
  station a legacy gauge concentrated by its repeater — the transition's first
  state.

Only the hub ids are kept on the device; the devices are rebuilt from the register
each time, so a corrected pass range shows the next time the tab is opened.

## Limits and assumptions

- **One frame per slot.** Every transmitter sends one AirLink frame in each of
  its runs; a run grows in whole slot units rather than a device taking two
  frames.
- **General sensor reports only.** Reports are ALERT2 GSR PDUs of the sensors
  listed, or per-sensor PDUs with the switch. Not modelled: Type 2 tipping-bucket
  reports (the ERT-A2 sends rain as a 4-byte accumulator), a second control byte,
  a destination address in the header, and EERDS PDU IDs — none seen in
  Flood-Net's captures.
- **The timestamp service is always on** and the application header is always 3
  bytes.
- **One parent per device** for routing (a station's first parent); a second path
  is the Network Review's business, not the frame's.
- **No per-station policies.** Every field station has the same report kind,
  extra sensors and reports per frame; a repeater's own report is one setting
  for all. Writing a plan's slots back to the station register is not done; the
  exports carry it.
- **Telos's planning values** for the preamble (60 + 15 ms), not the IND API's
  defaults; both sliders move it.
- **The buffer is symmetric**, as *Center Transmission in Slot* makes it; a
  fixed *Transmission Delay into Slot* without centring is the same arithmetic.
- **Legacy traffic** is a rate per gauge, not a tip record; the protocol's 10 s
  ALOHA hold-off after a tail (AirLink lines 869–883) and the ERT-A2's *Paralysis
  Time* are different things and neither is modelled beyond the reports-per-frame
  slider.
- **Register mode** follows the register as it stands — pass ranges, addresses,
  positions — and inherits its faults, which the Network Review's register checks
  find.
- **The latency walk is a planner model**, not a figure from the sources (above).

## Sources

The planner's figures are drawn from these documents; line numbers on this page
are lines of the extracted text of each.

- *ALERT2 AirLink Protocol Specification*, Version 1.1, March 2012 — ALERT2
  Protocol Technical Working Group, National Hydrologic Warning Council (R. Chris
  Roark, Don Van Wie). The bit rate, preamble, blocking and FEC tables, slot and
  buffer rules, aggregation and ALOHA.
  <https://www.bluewaterdesign.us/docs/Airlink_Ver_1.1_Final.pdf>
- *A Description of the ALERT2 Protocol*, Don Van Wie, Telos Services, October
  2011. The 228 ms first block, the 92 ms preamble, the 30-gauge frame, the ½ s
  slot's capacity, the 5 s repeater slot, slot buffering, echo suppression and
  path, concentration.
  <https://www.bluewaterdesign.us/docs/ALERT2_Description_102511.pdf>
- *ALERT2 Intelligent Network Device Application Program Interface
  Specification*, Version 1.0 (draft for TWG review), April 2013 — ALERT2
  Protocol Technical Working Group, NHWC (David Leader, R. Chris Roark). Every
  setting's name, type, default and range; the 12-hour rule; the MANT header's
  fields.
  <https://s.campbellsci.com/documents/us/miscellaneous/alert2-intelligent-network-device.pdf>
- *AL200 ALERT2 Getting Started Guide*, Campbell Scientific, July 2019. The frame
  and slot offset resolution of 500 ms, the typical 60,000 or 120,000 ms frame,
  the hop limit.
  <https://s.campbellsci.com/documents/us/manuals/alert2-gsg.pdf>
- *ALERT2 transmission protocol, next generation real-time hydrologic monitoring
  standard* (white paper, v2.0), James Logan, Robert Thompson and Ilse Gayl,
  OneRain, presented at HWRS 2015. The frame drawn as a circle and as a bar.
  <https://onerain.com/wp-content/uploads/2020/10/alert2-transmission-protocol-overview-logan-gayl-thompson-v2.0.pdf>
- *ERT-A2 User Manual*, ELPRO Technologies, September 2025 (EL-ERT-A2_Manual_Sept25).
  The menus, Unit Type, Station Address, Update Time, Paralysis, Report
  Sensitivity, GPS Update and GPS Maximum On, Repeater Delay, the address lists,
  the sensor ID table, the GPS option for TDMA.
  <https://elprotech.com/wp-content/uploads/2024/11/EL-ERT-A2_Manual_Sept25.pdf>
- *ERT-A2 ALERT2 Configuration Manual*, ELPRO Technologies, v1.1, 2021. The ALERT2
  Quick Start, the captured frames with one PDU per sensor, Paralysis Time's 600 s.
  <https://elprotech.com/wp-content/uploads/2021/07/UserManual_ERT-A2_v1.1-2.pdf>
- And Flood-Net's own captures in [`alert2.js`](../alert2.js): the 25-byte river
  report that is exactly 300 ms on the air.
