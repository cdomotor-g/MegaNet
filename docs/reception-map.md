# The Reception Map, and a receiver in a vehicle

The **Reception Map** tab (Interference group) shows what the receivers heard,
where, and how strongly — and works out which transmitter is sending bad
packets. It is built for the question the network has now: *is a repeater
hearing stations cleanly and re-transmitting them with flipped bits?*

## What feeds it

Every Quansheng, RTL-SDR and ERT-A2 card on the Serial Monitor writes a
**reception log** (`reception-log.js`): every frame it hears, good or bad, with
its signal level and where the receiver was. A reception is not a reading —
readings keep one good copy of each value; receptions keep every copy, which is
what finding a corrupting repeater needs.

| Card | Logged as good | Logged as bad |
| --- | --- | --- |
| Quansheng | each DEC, with RSSI and noise floor | frames the radio's own burst bits show it heard and did not report (`rejected`); bursts nothing decoded from (`undecoded`) |
| RTL-SDR | each accepted reading, with votes and burst level (dBFS) | bit-flip shadows the decoder set aside (`shadow`); undecoded bursts |
| ERT-A2 | each reading, with RSSI on the USB port | readings from a frame that does not add up, and frames that would not decode (`frame`). A record's fourth byte is a time offset, not a status (#209); `status` is only on rows from before |

**Position**, best first: a **GPS card** on the Serial Monitor (fix under 10 s
old — recorded as exact); this device's own location while *track this device's
position* is ticked (a phone or tablet's is GPS-grade; a laptop's is Wi-Fi — kept
as approximate with its stated accuracy); the receiver's fixed location from *Send
to Flood-Net*; otherwise none. History read out of a log file gets no position.

The log is kept in this browser (newest 10,000), exported as **CSV or GeoJSON**,
and — when the receiver is sending to Flood-Net — posted to the database
(`meganet.report_receptions()`, migration `0047`; editors-only to read, since a
vehicle's receptions say where the vehicle went).

**The stored readings** are the other source, and the one with the most in it:
every base station's traffic, public, a week of it in a few seconds (*From the
stored readings*, ALERT frames only, for the time picked — *everything* means a
week). A stored reading is the copy the datastore kept, and each further path
that heard the same frame (`dup_paths`) counts as another copy. They carry no
position, so the map shows only the suspect repeaters; each is placed instead by
the **area its receiver hears** (the stations it hears that nobody else carries),
which is enough to rule out repeaters too far away to have been heard and to pick
the right station for a shared address. The **Station Health** tab's *Weigh the
copies on the Reception Map* hands over the readings it already holds.

The map reads this browser's log, a loaded file, the stored readings, the
receptions table (*Receptions table (editors)*), or a **demo drive**.

## Site surveys

Is a hill worth a repeater, or a depot a base station? Leave a receiver there
for a day or three and see. An [RPi ALERT](https://github.com/cdomotor-g/RPi_ALERT)
base station does it as a **site survey** (its *Survey* page, or `survey = <name>`
on its SD card; the kit list — receivers, a clock that survives a power cut,
power for the days — is in its `docs/survey.md`). It needs no network at the site:
everything it hears is kept on its card, and when it is next on a network it sends
it here as **receptions** tagged with the survey (`report_receptions`, `0047`,
which takes frames of any age and keeps them). Its readings stay on the Pi unless
the survey says otherwise: a reading posted days late marks its station *last
seen* now, and is stored beside the copy the network already has, since readings
deduplicate on the exact moment and no two receivers time a burst the same.

*Site surveys (editors)* lists them — the site, the base station, when, how much
it heard, where. Pick one and:

- **its receptions become the map's source** (this browser's own log is unticked),
  so the map and the bad-copy analysis are of that site alone;
- **a table of every station it heard**: good and bad frames, *heard of sent* — of
  the transmissions the network stored from that address while the site was
  listening, how many the site heard (the same value within 10 s; copies within
  5 s are one transmission; *listening* is any frame of the site's within 20
  minutes, so a night with the Pi switched off is not held against the site) —
  *only here*, the transmissions the site heard that no base station stored (the
  case for building there), the median signal and its spread (dBm off a radio,
  dBFS off an RTL-SDR — relative to the stick's gain, so compare sites surveyed
  with the same stick and gain), the median SNR, and the channels;
- the stations the network heard while the site listened and the site did not,
  on request;
- **a line on the map from the site to each station**, coloured by how much of it
  the site caught (blue: heard only there);
- the table as **CSV**, for a report.

`survey_list()`, `survey_receptions()` and `survey_summary()` (`0051`) do the
work in the database — the last joins every frame of the survey against the
readings of the same days — and, like the receptions, are for editors only.

## How it finds the bad repeater

1. **Copies of one transmission.** The copies of one frame land within seconds
   of each other — direct, then each repeater's re-send. On the stored readings a
   repeater's corrupted copy lands a median 2.1 s after the clean one, nine in ten
   within 6.6 s and none past 12, so:
   - a frame on the **same address** within 12 s is a copy, however many bits
     differ;
   - a frame on **another address** is a copy only within 3 bits — within 12 s
     when no station carries that address, within 3 s when one does (two
     stations' frames can be that alike by chance), and **never when one station
     carries both**: that is its next sensor, in the same burst (190 such pairs
     a week, which this used to call flips).

   The version a station carries beats one nobody does. Between two addresses,
   the version **in line with its own address's other reports** (within 5 counts
   of its last or next) beats one that is not — the context the packet was heard
   in: `4803 = 51` two seconds after `4801 = 51`, where 4801 reads 50-odd all week
   and 4803 reads in the thousands, is 4801's frame with an address bit flipped.
   Then the most copies; then, on one address, the value nearest that address's
   last; then the first heard; then the loudest. Any other copy is **flipped**.

   Three things are set aside rather than blamed, each counted on the tab:
   - **two stations that only look alike** — each frame in line with its own
     station's reports — are both kept;
   - **a station reporting faster than its copies land** — a rain gauge tipping
     every few seconds in a storm — sends real values inside one window: a value
     a few counts on, between the transmission's and the address's next or last
     one sent within two minutes, or carrying on the run, is that report (29 of
     the 33 one-to-three-tip "flips" on rain gauges in a week were);
   - **an address on no station that keeps turning up on its own** is a station
     Flood-Net does not know about (or a repeater stuck on one bit whose victim this
     receiver never hears), not a ghost.

   A lone frame whose address no station carries, within 2 bits of one heard
   clean, is a **ghost**. What a card refused counts too.
2. **Pass ranges — works today, even from one fixed receiver.** A bad copy of
   address A can only have come through a repeater whose pass ranges let A
   through and that is within 400 km of where the copy was heard. Each bad copy's
   **blame** is split across those repeaters; the one common to several stations'
   bad copies collects it, and one that is the *only* path for some is named.
3. **Geometry — once receptions have positions.** Bad copies are loudest near the
   repeater sending them: for each suspect, the correlation between bad-copy RSSI
   and log-distance from it (strongly negative for the culprit), the median
   distance, and the power-weighted centre of the bad copies with its nearest
   repeater.
4. **Timing — when repeater delays are recorded** (`repeater.delay_ms`, none yet).
   Recording each repeater's delay in the Station editor would let a copy's arrival
   offset name the repeater that sent it outright. Worth doing for the suspects.

The demo drive is built against the real registry with one real repeater made to
flip bits; `npm run reception` holds the method to naming it, by pass ranges
alone and with positions.

**It narrows; it does not convict.** Two stations with nearby addresses and
similar values transmitting in the same seconds can still look like a flip when
neither has other reports to set it against; repeaters that pass the same
addresses share the blame equally, however different their records; a missing
pass range hides a path. Confirm on site — a receiver parked beside the suspect,
or its own logs. `npm run reception` holds each rule above to readings built for
it.

## Doing it now, with what there is

- **A fixed receiver** (a Quansheng radio, an RTL-SDR, or the ERT-A2 by PuTTY log)
  at the office: leave it logging for a few days. The pass-range ranking needs no
  positions.
- **A drive with a phone or tablet**: an RTL-SDR on USB-OTG with Chrome on
  Android (WebUSB), *track this device's position* ticked — the phone's GPS places
  every reception.
- **A drive with a laptop and a USB GPS puck** (any u-blox/NMEA puck, ~$20–40):
  add a **GPS** card on the Serial Monitor beside the receiver card. On a managed
  laptop without Web Serial, log the GPS in PuTTY too and drop both logs on the
  tab.

Then open the Reception Map, pick the time window, and read the suspect table.

## A vehicle rig, when there is hardware

The software side is ready: GPS as a serial device, positions on every reception,
receptions to the database under an ingest token. What the rig needs:

| Part | Why |
| --- | --- |
| Receiver: Quansheng UV-K5 V3 on the ALERT firmware, or an RTL-SDR V4 | the Quansheng gives RSSI in dBm and its own decode; the SDR gives votes, levels and IQ captures to replay |
| USB GPS puck (u-blox M8/M10) | positions recorded as exact |
| A small always-on computer — a laptop on ignition power, or a Raspberry Pi 4/5 with Chromium in kiosk mode | runs the Serial Monitor; not a managed machine, so Web Serial and WebUSB work |
| Mobile data (the vehicle's hotspot) | receptions post as they happen; without it they wait in the browser and post later |
| A 1/4-wave 150 MHz magnetic-mount antenna, a fused ignition-switched supply | the usual |

Set-up on the rig: open Flood-Net, add the receiver card and a GPS card, give the
receiver a name (*Ute 3 — SDR*), paste the ingest token made for the rig on the
Admin tab (or press *Use in this browser* there), tick *Send to Flood-Net* with
location *the GPS card*, and leave it. Each card resumes sending after a restart.

Still to build when a rig exists: a headless runner (so a Pi does not need a
browser window), and the database side of the analysis — the same method run over
every vehicle's receptions at once, on the Reception Map's *Receptions table (editors)*.
