# Signal Routes — what comes in from where

The **Signal Routes** tab (🛤️, Admin group, beside Base Stations) takes every burst the base stations'
receivers heard over today, the last three days or the last seven, and follows
each one back to the transmitter that put it on the air: the field station
itself, or the repeater that relayed it. Then it draws the answer four ways —
the routes as a flow, the same routes on the map, each repeater's pass ranges
on record set against what its carrier actually carried, and the protocols and
frame formats channel by channel.

It reads the receptions (`meganet.reception`, `0047`), the reception rollups
(`reception_daily`, `0071`) and the receivers' names (`ingest_point_latest`,
`0045`), all **editors only**: they name the base stations. Signed out, or as an
account that is not an editor, the tab says so, and **Show a demo** draws the
same four views from made-up receptions over the real station file.

## Whose carrier

A repeater on the networks Flood-Net hears transmits on the channel it listens
on, so the channel does not say whether a burst came straight from its station
or through a repeater. The **carrier** does. Every transmitter's crystal puts
its carrier a little off the channel — tens to hundreds of hertz — and a
repeater sends everything it relays on its own one. A base station running RPi
ALERT 0.14 or later measures each legacy burst's carrier offset (`cfo_hz`).

So the tab runs the server's own rules (`0077`, `roll_up_carriers_day()`; Station
Health's [Transmitter frequency](station-health.md#transmitter-frequency)), step
for step, for each receiver's UTC day:

1. **A repeater's carrier** is the ±30 Hz window holding the most of the
   addresses its pass ranges hold (less exclusions), heard by that receiver
   that day — accepted when its own sensors were heard there (and no other
   repeater passes them), or when 4 or more of the addresses it passes were,
   and at least half of those the receiver heard from its range.
2. **Two repeaters on one carrier** (within 60 Hz) are one transmitter: the one
   that relays the other's sensors; else the one heard on its own; else
   neither.
3. **Each burst** goes to the repeater whose carrier it sits on, when its
   address is that repeater's to pass; a copy (`duplicate` — a repeater's copy
   of a reading a second after the original) that no repeater explains is
   *unexplained*; anything else is **direct**, from its own station.

The server keeps the result as a row per transmitter (`carrier_daily`), which
says how many addresses a repeater relayed but not which, and is the service
key's — so the tab works it again from the receptions. One step of the server's
is not repeated: `0078` sets corrupted copies aside first; here a flipped
reading counts under the address it arrived as, a few a day. On 25 October
2026, on 18 Bateson's 151.525 MHz receiver, both found Mt Glorious AL RPTR's
carrier at +338 Hz and Toowoomba AL's at +101/+102 Hz, and three unexplained
copies.

A Quansheng radio and an ERT-A2 measure no carrier, and a burst that was two
carriers at once (a repeater keying up as its station lets go) comes without
one: those are **not measured**, and drawn as such.

## Routes

A flow in three columns: **sent by** (the station, by its ALERT address; an
address two stations share stays an address), **on the air from** (direct, a
repeater's carrier, an unexplained relay, or not measured) and **heard on** (the
receiver channel). A ribbon's width is the bursts it carried. The busiest 24
stations are drawn and the rest are one node; picking what they came through, or
a receiver — on the chips above the drawing, on a node, or in the table under it
— draws every station of it (up to 60) and fades the rest. Ribbons outlined in
dashes carried frames that were not ALERT Binary.

**ALERT2 — by path** draws the same for ALERT2: each source, the repeaters its
PDUs name as their path, and the receiver — from the hourly rollups, so up to an
hour behind.

## Map

The legacy routes on the ground: each station joined to the repeater whose
carrier its bursts came on, and that repeater to the base station; or straight
to the base station when heard direct. A station is coloured by how most of its
bursts came, and ringed when it is carried on ALERT2 too. *Show where pass ranges
and carriers disagree* adds a dashed line from each station relayed off its
repeater's record (below) and, with a repeater picked, a dashed line to each
station in its ranges that never came on its carrier.

## Pass ranges against the air

Each repeater whose carrier was found, with its pass ranges on record:

| | |
|---|---|
| **On its carrier** | addresses in its ranges heard relayed by it — the record confirmed |
| **Heard another way** | in its ranges, heard on a day its carrier was found, never on it — it does not relay them here (they come direct, or through another repeater), or the radio's ranges are not the record's |
| **Off its record** | on its carrier, in no range on record. **With copies** — two or more copies arriving a second after the original, on its carrier — it relays the address and the record does not say so. **Possible** — one copy, or every burst of the address on its carrier with no copy: it may relay it, or the station's own carrier happens to sit within 30 Hz of the repeater's (about one station in ten) |
| **In range, not heard** | addresses in its ranges that belong to a station in the register and were heard by no receiver in the period |

Each repeater's **address space** is drawn as a strip: its ranges to scale (the
empty stretches between them cut out), and a tick for every address — on its
carrier, heard another way, off its record.

**Relays no repeater on record explains** gathers the unexplained copies by
carrier: each receiver-day's densest 60 Hz windows of them, three addresses or
more, then one carrier on one receiver across the days (within 40 Hz — the
receiver's own crystal wanders that much). Each is a transmitter relaying those
addresses that the day's found carriers and the pass ranges did not account for.
When a register repeater's carrier was found at the same offset on that receiver
on another day, it is *probably* that repeater — its carrier went unfound on these
days because too few of the addresses its ranges hold were heard on it, which
itself says its ranges on record are wider than what it relays. Otherwise the
repeaters whose ranges hold the most of its addresses are named.

## Protocols and formats

- **ALERT2 or legacy.** Legacy ALERT from the receptions over the period;
  ALERT2 records from the rollups.
- **ALERT Binary, Enhanced iFLOWS or ASCII.** Each SDR channel is decoded in the
  one format set for it — Enhanced iFLOWS read off a strong Binary burst makes
  ghosts with a good CRC, so no channel tries both (`alert-dsp.js`). An iFLOWS
  station on a channel set to Binary therefore shows as bursts **heard and not
  decoded**, not as iFLOWS. A Quansheng radio decodes both and says which. The
  verdict at the top of the panel says whether anything decoded as Enhanced
  iFLOWS, and on which receiver; the bars show each receiver's frames by format
  and protocol, and what it heard and could not decode.
- **Which stations arrive which way.** An ALERT2 concentrator hears legacy
  stations and passes their readings on in its PDUs, which name each legacy
  address. A sample of the last twelve hours' PDUs (originals, not repeats)
  says which addresses each concentrator carries, so each station is *legacy
  only*, *both ways* or *ALERT2 only*; the ALERT2 sources are listed with the
  legacy addresses they carry and the paths their PDUs came by.

## Exports

📤 Export offers **the routes** (each station and address, how it came in, the
receiver, how many) and **pass ranges against the air** (each found repeater and
every address on its carrier, heard another way, or off its record) as CSV.

## Limits

- A repeater's carrier is found only on a day 4 or more of the addresses it
  passes were heard on it, and half of those heard from its range. A repeater
  with broad ranges on record that relays few of them is often not found; its
  relays then show as direct or unexplained — and the unexplained relays section
  puts them back to it when its carrier was found on another day.
- "Direct" means not on a found repeater's carrier.
- Only an SDR on RPi ALERT 0.14 or later measures carriers.
- A week of a busy base station is tens of thousands of receptions, read in
  six-hour chunks; past 200,000 the tab stops and says so.
- `npm run signalroutes` holds the tab to a fixture on the real station file —
  a repeater's carrier found, one station in its range heard only direct, one
  relayed off its record, a relay nobody explains, an Enhanced iFLOWS frame and
  ALERT2 by path.
