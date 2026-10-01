# The Reception Map, and a receiver in a vehicle

The **Reception Map** tab (Interference group) shows what the Serial Monitor's
receivers heard, where, and how strongly — and works out which transmitter is
sending bad packets. It is built for the question the network has now: *is a
repeater hearing stations cleanly and re-transmitting them with flipped bits?*

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
| ERT-A2 | each reading, with RSSI on the USB port | readings with a status byte (`status`); frames the receiver flagged (`frame`) |

**Position**, best first: a **GPS card** on the Serial Monitor (fix under 10 s
old — recorded as exact); this device's own location while *track this device's
position* is ticked (a phone or tablet's is GPS-grade; a laptop's is Wi-Fi — kept
as approximate with its stated accuracy); the receiver's fixed location from *Send
to MegaNet*; otherwise none. History read out of a log file gets no position.

The log is kept in this browser (newest 10,000), exported as **CSV or GeoJSON**,
and — when the receiver is sending to MegaNet — posted to the database
(`meganet.report_receptions()`, migration `0047`; editors-only to read, since a
vehicle's receptions say where the vehicle went). The map reads this browser's
log, a loaded file, the database, or a **demo drive**.

## How it finds the bad repeater

1. **Copies of one transmission.** Frames heard within 3 s of each other and
   within 3 bits are copies of one transmission (direct, then each repeater's
   re-send). The version a station actually carries, heard most often, is the
   truth; any other copy is **flipped**. A lone frame whose address no station
   carries, within 2 bits of one the receiver did hear, is a **ghost**. What a
   card refused counts too.
2. **Pass ranges — works today, even from one fixed receiver.** A bad copy of
   address A can only have come through a repeater whose pass ranges let A
   through. Each bad copy's **blame** is split across those repeaters; the one
   common to several stations' bad copies collects it, and one that is the *only*
   path for some is named.
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

**It narrows; it does not convict.** Two stations with nearby addresses
transmitting in the same seconds can look like a flip; a missing pass range hides
a path. Confirm on site — a receiver parked beside the suspect, or its own logs.

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

Set-up on the rig: open MegaNet, add the receiver card and a GPS card, give the
receiver a name (*Ute 3 — SDR*), paste the ingest token made for the rig on the
Admin tab (or press *Use in this browser* there), tick *Send to MegaNet* with
location *the GPS card*, and leave it. Each card resumes sending after a restart.

Still to build when a rig exists: a headless runner (so a Pi does not need a
browser window), and the database side of the analysis — the same method run over
every vehicle's receptions at once, on the Reception Map's *From the database*.
