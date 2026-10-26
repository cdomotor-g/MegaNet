# State of the backbone

The **Backbone** tab (🗼, Data group, beside Station Health), headed **State of the backbone**, lists
every repeater on record that has something wrong with it over a period you
pick — the last 7, 14, 30, 60 or 90 days, 30 to start — **ranked by the sum of
its issues**, worst first. Inside each repeater its issues are ranked by how
much each one matters. It is built for running through in a meeting: a summary
first, then a section a repeater with the evidence behind it.

It measures nothing new. It gathers, repeater by repeater, what the network's
other tools already find, and reads it all again **every fifteen minutes** while
the tab is open, so the page is always the period up to now. The period you
pick is remembered on the device.

## What it reads

| Source | What it gives each repeater |
| --- | --- |
| `meganet.health_finding` (`0059`) | Station Health's findings with when each opened and cleared: the repeater's own station **silent**, the stations behind it gone quiet together (**repeater-down**), an **area** going quiet with it, and its **battery** — plus the server's transmitter findings (`0075`, `0077`, `0078`): off channel, drifting, **corrupting**. Found before the end of the period, and cleared after its start or not yet. |
| `meganet.transmitter_summary` (`0077`, `0083`) | Its **carrier** against the fleet, day by day — the fingerprint every burst it relays carries ([Transmitter frequency](station-health.md#transmitter-frequency)) — and its **signal**: how far over the base stations' noise that carrier arrived over the last week, its change against its own past, and its line, each day against its usual with the receivers' own steps taken out ([Transmitter signal](station-health.md#transmitter-signal)). A database before `0083` has no signal columns: PostgREST refuses them with a 400, and the tab asks again without them. |
| `meganet.recent_flips()` (`0078`) | Every **corrupted copy** that came on its carrier in the period: as strong as the clean copy or more than 6 dB weaker (its SNR beside the clean copy's), the clean copy reaching us another way or not, the address it landed on, and the hour. |
| `meganet.flip_summary`, `meganet.flip_sources` (`0078`, `0079`) | What it sent in the last week and how much was corrupted; its share of the corrupted copies by **pass range** — the circumstantial side ([Bit-Flip Sources](station-health.md#the-bit-flip-sources-tab)). |
| `meganet.reading_daily`, `meganet.station_health` | Its own sensors' reports day by day, and when it was last heard. |
| Signal Routes (editors) | Its **pass ranges on record against the air** ([Signal Routes](signal-routes.md)): addresses on its carrier, with copies, that no range of its holds; addresses in its ranges that reach us only another way. |

All but the last are public and name no receiver, so the tab works for anybody,
signed in or not. The pass ranges against the air need the receptions, which
only editors may read: an editor presses **Read them** (the last seven days, as
Signal Routes reads them — a minute or so), or the tab uses what Signal Routes
already read this session.

The **stations behind a repeater** are the register's: field stations whose
addresses its pass ranges hold (less exclusions), within 150 km of it. Of those,
**only through it** are the ones no other repeater on record passes. Overlapping
ranges hide a chain — Toowoomba's Lockyer stations are Mt Glorious's on the
register too, though they reach Mt Glorious through Toowoomba — which is why a
repeater with a good share of all its stations quiet counts as critical even
when none is "only through it".

## The issues

| Issue | What makes it | Severity |
| --- | --- | --- |
| **Off air** | Its own station silent now, having kept a schedule (or been heard 30 times a week or more); or the stations behind it gone quiet together. | The finding's; critical when the stations behind it went with it, three only through it are quiet, or 40% or more of all of them (five at least). |
| **Seldom heard** | Its own station "silent" but heard only a few times a week with no schedule — a repeater our receivers catch by luck from far away, not one that is missing. | A note. |
| **Dropping out** | Spells off air that came back (its own station's, and the stations behind it going quiet together). | A warning at three spells or a day in all; else a note. Overnight spells are said: the pattern of a solar site that cannot carry the night. |
| **Corrupted relays** | Copies of other stations' readings with a bit or two wrong, on its own carrier. As strong as the clean copy means it sent the wrong bits — its receiver, its site or its radio — not that our receiver misheard it; reaching us clean another way means the corruption entered at this repeater. Interference keeps hours; a failing radio does not. | The server's own finding (critical at 10% of what it sent); without one, a warning at 2% on five clear copies. With nothing on its carrier, a share by pass range twice the network's is a note. |
| **Signal** | The server's `transmitter-snr-falling` on its own carrier (`0083`): everything it relays reaching the base stations 3 dB or more weaker than its own past, in a week or over three months, with the base stations' own steps taken out ([Transmitter signal](station-health.md#transmitter-signal)). The stations behind it have lost that margin too. Short of the finding, from its line: **weakening** — fallen more than half way to it (1.8 dB); and **little margin** — heard under 12 dB over the noise, within a few dB of the 8.5 dB where decodes stopped on the live receptions: its path to the base stations Flood-Net hears it with, or its site, more than a fault (and not necessarily the base it was built to reach). | The finding's (critical at 6 dB when most base stations judging it agree); weakening and little margin are notes. |
| **Carrier** | Off the fleet (median 2.5 ppm or more over two days or more), or moving 1 ppm or more between days. One day far from every other is set aside — more often a receiver's tuning that day than the radio. | A warning off the fleet (critical at 5 ppm over three days); moving 2 ppm over three days a warning; else a note. |
| **Power** | Its own battery finding: critical, low, falling, no daily charge. | The finding's. |
| **Pass ranges** | The register: no ranges, or a range that runs backwards; and against the air, addresses relayed off its record. | Off its record with copies a warning; else a note. |

Repeaters that went off air within half an hour of each other are said to have
**stopped together**: one thing they share — a link between them, a channel, a
site's power — fits better than as many faults.

Each section ends with **what it points to**: up to three sentences from its
issues together — power first when an off-air repeater's battery said so; a
failing radio when it was corrupting before it stopped; the corruption entering
at the repeater when clean copies came another way; our receivers mishearing it
when most of its corrupted copies arrived much weaker than the clean ones; a
link with little margin; its antenna or feeder when
it is both weaker on the air and corrupting what it relays (it hears through
them as well as sends on them). Said as possibilities, never
as orders.

## How it is ranked

Each issue scores

> severity (critical 10, warning 4, note 1)
> × how much of the network leans on the repeater (1 to 2.5: the stations only
>   through it in full and the others a quarter, on a log scale; half that for
>   power; 1 for pass ranges)
> × whether it is still going on (1; ½ once it cleared; ¾ for dropping out,
>   which is a habit rather than an event)
> × the kind of trouble (off air 1.2, corrupted relays 1, its signal fading
>   0.9, dropping out and power 0.8, carrier 0.7, pass ranges 0.5)
> × for corrupted relays, 1 to 1.5 as the copies mount (to 100 or more).

A repeater's **score** is the sum of its issues', and ranks it. Its **state** is
the worst of what is still going on, or *cleared* when nothing is. The score is
a ranking, not a measurement: it puts the repeater that is off air *and*
corrupting with 150 stations behind it above the one with a weak battery and six.

## The page

- **Summary** — the tiles (repeaters with a warning or worse, critical now, off
  air now, relaying corrupted copies, stations quiet now behind them); then a
  row a repeater, the worst twelve until **Show all**: its state, its one or two
  key issues, and its score as a bar split by kind of trouble. Under it, the
  map: each repeater coloured by state and sized by score, the base stations as
  ◆; a repeater picked shows the stations behind it, those quiet now in red.
- **A section a repeater** — what is behind it, its frequency, when its own
  reports were last heard, how far over the noise it is heard; a **timeline** of
  the period (its own reports day by day, when it was off air, its corrupted
  copies day by day, its carrier on each day measured, its signal's line against
  its usual with the fading finding flagged under it, its power); what it points
  to; each issue with its evidence,
  and for corrupted relays the hours of the day. Links open it in Station Health,
  Stations, Bit-Flip Sources and Signal Routes.
- **Notes only** — the repeaters with nothing worse than a note, folded.
- **How it is worked out** — the sources and the weights, folded.

⤓ Export saves **the ranking** as CSV (a row an issue, with its evidence) and
**the summary** as text, for a meeting's notes or an email. When the database
cannot be reached the tab says so, with **Try again** and **Show a demo** (made-up
findings on the real station file).

## What it cannot tell

- The findings began on **21 October 2026**: a long period holds what there is.
- Its **signal** needs `0083` on the database (with `0080`–`0082` before it).
  Until it is applied the tab shows no signal — no line, no level, no fading
  finding — and *How it is worked out* says so.
- Carriers are measured only by base stations running RPi ALERT 0.14 or later,
  and a repeater's carrier is found only on days enough of its stations were
  heard through it. One or two days measured is a lead, not a verdict.
- A repeater with no sensors of its own (Mt Glorious AL RPTR) can only be seen
  off air through the stations behind it.
- The base stations' own receivers — a channel no longer listened to, a stick
  that lost its tuning — are on the Base Stations tab and in Network Weather,
  not here; when several repeaters stop together, rule our end out first.

`npm run backbone` holds it to a planted month on the real station file.
