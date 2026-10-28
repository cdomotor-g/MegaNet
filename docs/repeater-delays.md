# Repeater delays — an assessment, and what to set each one to

*Queensland and northern New South Wales · the station register as of 28 October 2026 ·
the live version is the ⏳ **Repeater Delays** tab, under Stations & networks.*

## The answer

**Give neighbouring repeaters different delays.** The register holds no delay for any
repeater, and the network is thought to have most of them on one value. On one value,
**157 pairs of repeaters** send their copies of the same reading on top of each other at
a base station or repeater that hears both — bit on bit, which is exactly the collision
that comes out as flipped bits and ghost addresses. The plan below, kept under a second,
brings that to **7 pairs on top, 33 close and 154 clear** of 194. Set each repeater to the
**Delay, under 1 s** in the tables at the foot of this page, group by group.

**One decision is needed before going further than that: what delay range the repeaters
actually take.** Under a second there is not room to clear the busiest groups. If the
repeaters accept longer delays, every pair can be cleared:

| Longest delay | On top | Close | Clear | Delays used |
| --- | ---: | ---: | ---: | --- |
| Every repeater on one delay (now, presumably) | 157 | 0 | 37 | one |
| Under 1 s (999 ms) — what the register holds | 7 | 33 | 154 | 18, up to 950 ms |
| Up to 1.5 s | 0 | 15 | 179 | 19, up to 1,450 ms |
| Up to 2 s | 0 | 5 | 189 | 16, up to 1,950 ms |
| Up to 3 s | 0 | 0 | 194 | 18, up to 2,900 ms |

*On top*: less than a frame (133 ms) apart — the frames overlap and bits flip. *Close*: a
frame apart or more, but the later repeater keys up during the earlier one's frame, so
that copy is spoilt wherever the two arrive at about the same strength (no ghost, but a
lost copy). *Clear*: a lead-in and a frame apart (433 ms) — neither copy touches the other.

A delay over 999 ms cannot be recorded on a station yet (`meganet.repeater.delay_ms` is
checked under 1000, migration `0015`), and the repeaters' own limit is not on record. If
they take 3 s, use the **Delay, up to 3 s** column instead and the register's limit can
be raised to match.

## What was found

- **146 repeaters** on file, from Cairns to the Clarence. **122 share readings with at
  least one neighbour**, in **20 groups** that must be set together; the other **24 relay
  nothing another repeater also relays to a receiver hearing both** — their delay does not
  matter and they can be left as they are (listed at the foot).
- **194 pairs** of repeaters can put copies of one reading on top of each other. The
  biggest groups: Brisbane / Logan–Albert (16 repeaters), Fitzroy (14), Warrego / Paroo
  (13) and the Northern Rivers (11). The densest knot is six Northern Rivers repeaters
  (Mullumbimby, Kunghur, Tweed Heads, Limpinwood, Goonellabah, Murwillumbah) that all
  relay some of the same readings — so six different delays is the least the network
  can do with.
- **The pairs carrying most readings** on one delay: Hillcrest (Wine Glass) & Constitution
  Hill (315 readings, heard together at 18 Bateson, Marburg Radar and Gatton);
  Molendinar, Tallai & Tallebudgera Ck Rd (about 160 each, at Constitution Hill and the
  City of Gold Coast bases); Goonellabah & Mullumbimby (143); Bowra Sugarloaf & Point
  Lookout (139); Constitution Hill & Round Mt Res (98); Mt Glorious & Toowoomba (96).
- **Second hops matter.** A repeater that relays another repeater's copy sends a lead-in,
  a frame and its own delay after it, so copies of one reading spread out hop by hop.
  Under a second, a first-hop copy with a long delay lands on a second-hop copy with a
  short one: that is what the seven pairs left on top are — Mt Glorious & Toowoomba, Ghost
  Hill & Takura Reservoir, Bald Knob & Constitution Hill, Middle Creek & Mt Lindsay (the
  Warrego chain), and three with only one to three readings between them.
- **17 repeaters have no channel on record** — the Northern Rivers and Clarence repeaters
  and Bundamba (Barclay St). Each is assumed to share a channel with its neighbours, which
  errs towards a collision. Recording their channels may free some of them.

## Doing it

1. **Find out the repeaters' delay range and units**, and if possible time one
   repeater's lead-in (key-up to the first data bit) off the air. The plan assumes
   300 ms, the app's own figure; a shorter lead-in clears more pairs at the same delays
   (with a 100 ms lead-in, under 1 s: 3 on top, 7 close).
2. **Set the delays group by group, busiest group first** (the order below). A group
   half done can be worse than not started: two repeaters moved to one new value collide
   just as they did on the old one.
3. **Record each delay on its station as it is set** — Stations tab, the repeater's card,
   *Repeater delay (ms)*. The plan keeps a recorded delay and plans the rest around it,
   so it stays the same plan as the work goes on.
4. **Watch a group on the air for a week after it is set.** Bit-Flip Sources and Station
   Health show whether its corrupted copies and ghosts fall.
5. **Record the 17 missing channels.**

## How it is worked out

`delay-plan.js` follows every reading in the register. For each address each station
sends: the repeaters that pass it (pass ranges less exclusions) and hear the station —
80 km from a field station (nine in ten stations have their nearest carrying repeater
within 70 km), 100 km from a repeater site's own gauge — then the repeaters that pass it
and hear one of those (100 km, the Stations map's Max TX distance), up to four hops. Each
copy goes out a lead-in, a frame and the repeater's delay after the first copy it heard;
a repeater sends a reading on once. Two copies on one channel collide where a receiver
that wants the reading — a base station, or a repeater that passes the address — hears
both. A repeater hears only on its receive channel and is heard only on its transmit
channel; a channel not on record agrees with any.

The search places every repeater on a whole 50 ms step from 0 to the limit, group by
group: annealing (random moves, sometimes accepting a slightly worse one early on) and
then moving each repeater to its cheapest step until nothing improves. *On top* costs
1–2 a reading, worst on the same delay; *close* 0.25–0.75, less the further apart;
*clear* nothing. Deterministic: the same register and settings give the same plan, and
among delays that cost the same, the one a repeater has now wins, so it asks for as few
site visits as it can. `npm run delays` holds it to small networks whose answer is known
and to the register.

**What it cannot see.** Hearing is a distance, not a coverage model: a hill between two
repeaters it counts as hearing each other makes a pair that is not there, and a long
path over water it does not count leaves one out. It assumes a repeater counts its delay
from the end of the frame it heard and does not relay a reading twice; and it does not
follow a ghost that a collision turns into an address some other repeater passes. Saved
modelled link margins (`meganet.link_fade_margin`) cover only 42 repeater links so far —
too few to stand in for the distances.

## The plan, group by group

*Delay, under 1 s* is the recommendation. *Closest neighbour* is the repeater whose copies
come nearest to this one's under that plan, its delay, and how far apart (ms) the two
copies land. *Delay, up to 3 s* is the plan if the repeaters take up to three seconds —
every pair clear. Channels in MHz, receive → transmit where they differ.

### Group 1 — Brisbane hub / Logan-Albert Rivers

16 repeaters, 28 pairs; on one delay: on top; planned under 1 s: on top.

| Repeater | Channel (MHz) | Delay, under 1 s | Closest neighbour, apart | State | Delay, up to 3 s |
| --- | --- | ---: | --- | --- | ---: |
| Constitution Hill | 151.5 | **450 ms** | Molendinar AL (500 ms), 50 ms | on top | 450 ms |
| Hillcrest AL (Wine Glass) | 151.5 | **950 ms** | Molendinar AL (500 ms), 450 ms | clear | 900 ms |
| Molendinar AL | 151.5 | **500 ms** | Constitution Hill (450 ms), 50 ms | on top | 1350 ms |
| Tallai AL | 151.5 | **950 ms** | Molendinar AL (500 ms), 450 ms | clear | 450 ms |
| Tallebudgera Ck Rd AL | 151.5 | **0 ms** | Tomewin AL (150 ms), 150 ms | close | 1800 ms |
| Bald Knob AL | 151.5 | **950 ms** | Constitution Hill (450 ms), 67 ms | on top | 1350 ms |
| Round Mt Res AL | 151.5 | **0 ms** | Constitution Hill (450 ms), 450 ms | clear | 0 ms |
| Ball Lkt AL | 151.5 | **0 ms** | Obi Lookout AL (450 ms), 450 ms | clear | 450 ms |
| Obi Lookout AL | 151.5 | **450 ms** | Coolabine Ck AL (600 ms), 150 ms | close | 900 ms |
| Bundamba (Barclay St) AL | not recorded | **0 ms** | Constitution Hill (450 ms), 450 ms | clear | 0 ms |
| Hume Lane AL | 151.5 | **450 ms** | Bald Knob AL (950 ms), 500 ms | clear | 0 ms |
| Coolabine Ck AL | 151.5 | **600 ms** | Obi Lookout AL (450 ms), 150 ms | close | 0 ms |
| Kooralbyn AL | 151.5 | **150 ms** | Hillcrest AL (Wine Glass) (950 ms), 800 ms | clear | 0 ms |
| Tomewin AL | 151.5 | **150 ms** | Tallebudgera Ck Rd AL (0 ms), 150 ms | close | 0 ms |
| Pohlmans Range AL | 151.5 | **0 ms** | Constitution Hill (450 ms), 450 ms | clear | 0 ms |
| Baroon Dam Repeater | 151.5 | **150 ms** | Bald Knob AL (950 ms), 800 ms | clear | 0 ms |

### Group 2 — Richmond River / Brisbane hub

11 repeaters, 28 pairs; on one delay: on top; planned under 1 s: on top.

| Repeater | Channel (MHz) | Delay, under 1 s | Closest neighbour, apart | State | Delay, up to 3 s |
| --- | --- | ---: | --- | --- | ---: |
| Goonellabah (Wyreema Rd) | not recorded | **500 ms** | Tweed Heads (Duranbah) (350 ms), 150 ms | close | 450 ms |
| Mullumbimby (Chincogan) | not recorded | **950 ms** | Kunghur (The Junction) (800 ms), 150 ms | close | 900 ms |
| Tuckombil | not recorded | **0 ms** | Coopers Shoot Repeater (150 ms), 150 ms | close | 1350 ms |
| Murwillumbah (Hartigans Hill) | not recorded | **0 ms** | Limpinwood (Bald Mountain) (50 ms), 50 ms | on top | 1350 ms |
| Tweed Heads (Duranbah) | not recorded | **350 ms** | Goonellabah (Wyreema Rd) (500 ms), 150 ms | close | 1800 ms |
| Dunoon | not recorded | **950 ms** | Goonellabah (Wyreema Rd) (500 ms), 450 ms | clear | 0 ms |
| Kunghur (The Junction) | not recorded | **800 ms** | Mullumbimby (Chincogan) (950 ms), 150 ms | close | 2250 ms |
| Burringbar Reservoir | not recorded | **0 ms** | Goonellabah (Wyreema Rd) (500 ms), 500 ms | clear | 0 ms |
| Numinbah | not recorded | **800 ms** | Mullumbimby (Chincogan) (950 ms), 150 ms | close | 0 ms |
| Coopers Shoot Repeater | not recorded | **150 ms** | Tuckombil (0 ms), 150 ms | close | 0 ms |
| Limpinwood (Bald Mountain) | not recorded | **50 ms** | Murwillumbah (Hartigans Hill) (0 ms), 50 ms | on top | 0 ms |

### Group 3 — Warrego River / Paroo River

13 repeaters, 27 pairs; on one delay: on top; planned under 1 s: on top.

| Repeater | Channel (MHz) | Delay, under 1 s | Closest neighbour, apart | State | Delay, up to 3 s |
| --- | --- | ---: | --- | --- | ---: |
| Middle Creek AL | 151.5 | **950 ms** | Mt Lindsay AL (950 ms), 0 ms | on top | 1850 ms |
| Dunvegan AL | 151.5 | **150 ms** | Mt Lindsay AL (950 ms), 133 ms | close | 1400 ms |
| Augathella Rptr AL | 151.5 | **650 ms** | Willara AL (500 ms), 150 ms | close | 2900 ms |
| Willara AL | 151.5 | **500 ms** | Middle Creek AL (950 ms), 133 ms | close | 2450 ms |
| Mt Lindsay AL | 151.5 | **950 ms** | Middle Creek AL (950 ms), 0 ms | on top | 0 ms |
| Mt Tabor AL | 151.5 | **0 ms** | Dunvegan AL (150 ms), 150 ms | close | 750 ms |
| Calowrie AL | 151.5 | **900 ms** | Ravenscourt AL (400 ms), 500 ms | clear | 1900 ms |
| Myendetta AL | 151.5 | **400 ms** | Middle Creek AL (950 ms), 550 ms | clear | 1300 ms |
| Ravenscourt AL | 151.5 | **400 ms** | Calowrie AL (900 ms), 500 ms | clear | 300 ms |
| Moyallen AL | 151.5 | **500 ms** | Dunvegan AL (150 ms), 350 ms | close | 900 ms |
| Barradeen AL | 151.5 | **350 ms** | Middle Creek AL (950 ms), 600 ms | clear | 1050 ms |
| Cooks Tank AL | 151.5 | **350 ms** | Dunvegan AL (150 ms), 200 ms | close | 450 ms |
| Loddon AL | 151.5 | **950 ms** | Calowrie AL (900 ms), 1333 ms | clear | 600 ms |

### Group 4 — Sydney hub / Clarence River

5 repeaters, 7 pairs; on one delay: on top; planned under 1 s: close.

| Repeater | Channel (MHz) | Delay, under 1 s | Closest neighbour, apart | State | Delay, up to 3 s |
| --- | --- | ---: | --- | --- | ---: |
| Bowra Sugarloaf | not recorded | **950 ms** | Point Lookout (0 ms), 167 ms | close | 900 ms |
| Point Lookout | not recorded | **0 ms** | Bowra Sugarloaf (950 ms), 167 ms | close | 1350 ms |
| Boonanghi | not recorded | **350 ms** | Point Lookout (0 ms), 350 ms | close | 0 ms |
| Dorrigo (Mountain Top) | not recorded | **450 ms** | Point Lookout (0 ms), 450 ms | clear | 0 ms |
| Wooli (Browns Knob) | not recorded | **450 ms** | Point Lookout (0 ms), 433 ms | clear | 0 ms |

### Group 5 — Brisbane hub / South Coast

5 repeaters, 5 pairs; on one delay: on top; planned under 1 s: clear.

| Repeater | Channel (MHz) | Delay, under 1 s | Closest neighbour, apart | State | Delay, up to 3 s |
| --- | --- | ---: | --- | --- | ---: |
| Constitution Hill AL | 152.4 | **900 ms** | OReillys AL (950 ms), 483 ms | clear | 0 ms |
| Mt Tamborine AL | 151.5 → 152.4 | **50 ms** | Constitution Hill AL (900 ms), 1333 ms | clear | 0 ms |
| Wilsons Peak | 151.5 → 152.4 | **100 ms** | OReillys AL (950 ms), 850 ms | clear | 900 ms |
| Laheys Lookout AL | 151.5 → 152.4 | **0 ms** | Constitution Hill AL (900 ms), 1333 ms | clear | 0 ms |
| OReillys AL | 151.5 → 152.4 | **950 ms** | Constitution Hill AL (900 ms), 483 ms | clear | 0 ms |

### Group 6 — Fitzroy River (Qld) / Brisbane hub

14 repeaters, 30 pairs; on one delay: on top; planned under 1 s: close.

| Repeater | Channel (MHz) | Delay, under 1 s | Closest neighbour, apart | State | Delay, up to 3 s |
| --- | --- | ---: | --- | --- | ---: |
| Emerald Radar AL | 151.5 | **950 ms** | Glen Rock AL (300 ms), 283 ms | close | 900 ms |
| Roddas Lookout AL | 151.5 | **500 ms** | Blackdown Tableland AL (950 ms), 450 ms | clear | 1350 ms |
| Mt Mayde AL | 151.5 | **500 ms** | Glen Rock AL (300 ms), 200 ms | close | 2250 ms |
| Blackdown Tableland AL | 151.5 | **950 ms** | Roddas Lookout AL (500 ms), 450 ms | clear | 0 ms |
| Glen Rock AL | 151.5 | **300 ms** | Mt Mayde AL (500 ms), 200 ms | close | 0 ms |
| Mt Lowe AL | 151.5 | **500 ms** | Emerald Radar AL (950 ms), 450 ms | clear | 450 ms |
| Mt Pisgah AL | 151.5 | **350 ms** | Sedgeford AL (800 ms), 450 ms | clear | 450 ms |
| Middlemount AL | 151.5 | **150 ms** | Mt Lowe AL (500 ms), 933 ms | clear | 0 ms |
| Mt Joss AL | 151.5 | **550 ms** | Mt Lowe AL (500 ms), 533 ms | clear | 0 ms |
| Florence Vale AL | 151.5 | **0 ms** | Mt Lowe AL (500 ms), 500 ms | clear | 0 ms |
| Betanga AL | 151.5 | **50 ms** | Mt Mayde AL (500 ms), 1716 ms | clear | 0 ms |
| Kulumur Range AL | 151.5 | **0 ms** | Mt Mayde AL (500 ms), 500 ms | clear | 0 ms |
| Sedgeford AL | 151.5 | **800 ms** | Mt Pisgah AL (350 ms), 450 ms | clear | 0 ms |
| Billaboo AL | 151.5 | **950 ms** | Mt Mayde AL (500 ms), 450 ms | clear | 0 ms |

### Group 7 — Pioneer River

4 repeaters, 6 pairs; on one delay: on top; planned under 1 s: close.

| Repeater | Channel (MHz) | Delay, under 1 s | Closest neighbour, apart | State | Delay, up to 3 s |
| --- | --- | ---: | --- | --- | ---: |
| Clarke Range 2 AL | 151.5 | **950 ms** | Outer Harbour Tide AL (650 ms), 300 ms | close | 450 ms |
| Clarke Range AL Repeater | 151.5 | **450 ms** | Outer Harbour Tide AL (650 ms), 200 ms | close | 900 ms |
| Mt Pinnacle AL | 151.5 | **0 ms** | Clarke Range AL Repeater (450 ms), 450 ms | clear | 1350 ms |
| Outer Harbour Tide AL | 151.5 | **650 ms** | Clarke Range AL Repeater (450 ms), 200 ms | close | 0 ms |

### Group 8 — Brisbane hub / Brisbane River

6 repeaters, 9 pairs; on one delay: on top; planned under 1 s: on top.

| Repeater | Channel (MHz) | Delay, under 1 s | Closest neighbour, apart | State | Delay, up to 3 s |
| --- | --- | ---: | --- | --- | ---: |
| Mt Glorious AL RPTR | 151.525 | **0 ms** | Toowoomba AL (950 ms), 67 ms | on top | 450 ms |
| Toowoomba AL | 151.525 | **950 ms** | Mt Glorious AL RPTR (0 ms), 67 ms | on top | 1350 ms |
| Mt Petersen AL | 151.525 | **450 ms** | Schultz Lookout AL (500 ms), 50 ms | on top | 900 ms |
| Schultz Lookout AL | 151.525 | **500 ms** | Mt Petersen AL (450 ms), 50 ms | on top | 0 ms |
| Upper Sandy Creek AL | 151.525 | **600 ms** | Mt Glorious AL RPTR (0 ms), 600 ms | clear | 0 ms |
| Paradise Ck Rd AL | 151.525 | **450 ms** | Mt Glorious AL RPTR (0 ms), 450 ms | clear | 0 ms |

### Group 9 — Condamine-Culgoa Rivers / Border Rivers

6 repeaters, 9 pairs; on one delay: on top; planned under 1 s: close.

| Repeater | Channel (MHz) | Delay, under 1 s | Closest neighbour, apart | State | Delay, up to 3 s |
| --- | --- | ---: | --- | --- | ---: |
| Amiens Knob AL | 151.5 | **500 ms** | Upper Rosenthal AL (650 ms), 150 ms | close | 900 ms |
| Warahgai AL | 151.5 | **950 ms** | Upper Rosenthal AL (650 ms), 300 ms | close | 1350 ms |
| Upper Rosenthal AL | 151.5 | **650 ms** | Amiens Knob AL (500 ms), 150 ms | close | 450 ms |
| Bony Mountain AL | 151.5 | **50 ms** | Amiens Knob AL (500 ms), 450 ms | clear | 0 ms |
| Carrs Lkt AL | 151.5 | **0 ms** | Upper Rosenthal AL (650 ms), 650 ms | clear | 0 ms |
| Ballandean Hill AL | 151.5 | **0 ms** | Amiens Knob AL (500 ms), 500 ms | clear | 0 ms |

### Group 10 — Mary River (Qld) / Burrum River

4 repeaters, 5 pairs; on one delay: on top; planned under 1 s: on top.

| Repeater | Channel (MHz) | Delay, under 1 s | Closest neighbour, apart | State | Delay, up to 3 s |
| --- | --- | ---: | --- | --- | ---: |
| Ghost Hill AL | 151.5 | **450 ms** | Takura Resevoir AL (950 ms), 67 ms | on top | 450 ms |
| Takura Resevoir AL | 151.5 | **950 ms** | Ghost Hill AL (450 ms), 67 ms | on top | 1350 ms |
| Mt Goonaneman AL | 151.5 | **0 ms** | Ghost Hill AL (450 ms), 450 ms | clear | 0 ms |
| Mt Kanigan AL | 151.5 | **0 ms** | Ghost Hill AL (450 ms), 450 ms | clear | 0 ms |

### Group 11 — Condamine-Culgoa Rivers / Brisbane hub

5 repeaters, 6 pairs; on one delay: on top; planned under 1 s: clear.

| Repeater | Channel (MHz) | Delay, under 1 s | Closest neighbour, apart | State | Delay, up to 3 s |
| --- | --- | ---: | --- | --- | ---: |
| Mt MOWBULLAN RPTR | 151.5 | **700 ms** | Braziers Hill AL (50 ms), 650 ms | clear | 900 ms |
| Clovelly AL | 151.5 | **0 ms** | Bottle Tree AL (500 ms), 500 ms | clear | 2200 ms |
| Turkey Mountain AL | 151.5 | **950 ms** | Bottle Tree AL (500 ms), 450 ms | clear | 1300 ms |
| Braziers Hill AL | 151.5 | **50 ms** | Mt MOWBULLAN RPTR (700 ms), 650 ms | clear | 0 ms |
| Bottle Tree AL | 151.5 | **500 ms** | Turkey Mountain AL (950 ms), 450 ms | clear | 0 ms |

### Group 12 — Don River / Burdekin River

6 repeaters, 6 pairs; on one delay: on top; planned under 1 s: clear.

| Repeater | Channel (MHz) | Delay, under 1 s | Closest neighbour, apart | State | Delay, up to 3 s |
| --- | --- | ---: | --- | --- | ---: |
| Hurricane Cliff AL | 151.5 | **950 ms** | Mt Kelly AL (0 ms), 433 ms | clear | 450 ms |
| Mt Kelly AL | 151.5 | **0 ms** | Hurricane Cliff AL (950 ms), 433 ms | clear | 1350 ms |
| Moss Vale AL | 151.5 | **50 ms** | Strathdickie AL (500 ms), 450 ms | clear | 1350 ms |
| Strathdickie AL | 151.5 | **500 ms** | Hurricane Cliff AL (950 ms), 450 ms | clear | 0 ms |
| Burdekin Dam AL | 151.5 | **850 ms** | Mt Kelly AL (0 ms), 850 ms | clear | 0 ms |
| Scartwater AL | 152.4 → 151.5 | **800 ms** | Hurricane Cliff AL (950 ms), 2666 ms | clear | 0 ms |

### Group 13 — Brisbane hub / Burnett River

3 repeaters, 2 pairs; on one delay: on top; planned under 1 s: clear.

| Repeater | Channel (MHz) | Delay, under 1 s | Closest neighbour, apart | State | Delay, up to 3 s |
| --- | --- | ---: | --- | --- | ---: |
| Mt Watalgan AL | 151.5 | **900 ms** | Gladstone Radar AL (0 ms), 467 ms | clear | 900 ms |
| Gladstone Radar AL | 151.5 | **0 ms** | Mt Watalgan AL (900 ms), 467 ms | clear | 0 ms |
| Mt Gayndah AL | 152.4 → 151.5 | **600 ms** | Mt Watalgan AL (900 ms), 1766 ms | clear | 0 ms |

### Group 14 — Johnstone River / Herbert River

4 repeaters, 3 pairs; on one delay: on top; planned under 1 s: clear.

| Repeater | Channel (MHz) | Delay, under 1 s | Closest neighbour, apart | State | Delay, up to 3 s |
| --- | --- | ---: | --- | --- | ---: |
| Millaa Millaa AL | 151.5 | **900 ms** | Wallaman AL (800 ms), 433 ms | clear | 900 ms |
| Marco St AL | 151.5 | **150 ms** | Millaa Millaa AL (900 ms), 750 ms | clear | 0 ms |
| Murray Springs AL | 151.5 | **100 ms** | Wallaman AL (800 ms), 533 ms | clear | 900 ms |
| Wallaman AL | 151.5 | **800 ms** | Millaa Millaa AL (900 ms), 433 ms | clear | 0 ms |

### Group 15 — Warrego River / Condamine-Culgoa Rivers

5 repeaters, 10 pairs; on one delay: on top; planned under 1 s: close.

| Repeater | Channel (MHz) | Delay, under 1 s | Closest neighbour, apart | State | Delay, up to 3 s |
| --- | --- | ---: | --- | --- | ---: |
| Arabella AL | 151.5 | **950 ms** | Ularunda (Repeater) AL (950 ms), 433 ms | clear | 450 ms |
| Sommariva (Repeater) AL | 151.5 | **350 ms** | Ularunda (Repeater) AL (950 ms), 167 ms | close | 2250 ms |
| Glengarry (Repeater) AL | 151.5 | **0 ms** | Sommariva (Repeater) AL (350 ms), 350 ms | close | 1800 ms |
| Ularunda (Repeater) AL | 151.5 | **950 ms** | Sommariva (Repeater) AL (350 ms), 167 ms | close | 150 ms |
| Westcourt (Repeater) AL | 151.5 | **50 ms** | Glengarry (Repeater) AL (0 ms), 433 ms | clear | 600 ms |

### Group 16 — Fitzroy River (Qld)

3 repeaters, 2 pairs; on one delay: on top; planned under 1 s: clear.

| Repeater | Channel (MHz) | Delay, under 1 s | Closest neighbour, apart | State | Delay, up to 3 s |
| --- | --- | ---: | --- | --- | ---: |
| Dawson Range South AL | 151.5 | **150 ms** | Broadmere AL (700 ms), 550 ms | clear | 900 ms |
| Cracow AL | 151.5 | **750 ms** | Dawson Range South AL (150 ms), 583 ms | clear | 0 ms |
| Broadmere AL | 151.5 | **700 ms** | Dawson Range South AL (150 ms), 550 ms | clear | 0 ms |

### Group 17 — Mulgrave-Russell Rivers / Barron River

4 repeaters, 4 pairs; on one delay: on top; planned under 1 s: clear.

| Repeater | Channel (MHz) | Delay, under 1 s | Closest neighbour, apart | State | Delay, up to 3 s |
| --- | --- | ---: | --- | --- | ---: |
| Gillies Lookout AL | 151.5 | **450 ms** | Saddle Mtn AL (0 ms), 450 ms | clear | 450 ms |
| Gordonvale AL | 151.5 | **950 ms** | Gillies Lookout AL (450 ms), 500 ms | clear | 900 ms |
| Saddle Mtn AL | 151.5 | **0 ms** | Gillies Lookout AL (450 ms), 450 ms | clear | 1350 ms |
| Brinsmead AL | 151.5 | **650 ms** | Saddle Mtn AL (0 ms), 650 ms | clear | 0 ms |

### Group 18 — Tully River / Murray River (Qld)

3 repeaters, 3 pairs; on one delay: on top; planned under 1 s: clear.

| Repeater | Channel (MHz) | Delay, under 1 s | Closest neighbour, apart | State | Delay, up to 3 s |
| --- | --- | ---: | --- | --- | ---: |
| Bilyana AL | 151.5 | **500 ms** | Maalan Road AL (950 ms), 450 ms | clear | 900 ms |
| Maalan Road AL | 151.5 | **950 ms** | Bilyana AL (500 ms), 450 ms | clear | 1350 ms |
| South Mission Beach AL | 151.5 | **0 ms** | Bilyana AL (500 ms), 500 ms | clear | 0 ms |

### Group 19 — Brisbane hub

3 repeaters, 3 pairs; on one delay: on top; planned under 1 s: clear.

| Repeater | Channel (MHz) | Delay, under 1 s | Closest neighbour, apart | State | Delay, up to 3 s |
| --- | --- | ---: | --- | --- | ---: |
| Barneys Bore AL | 151.5 | **0 ms** | Wyanga AL (0 ms), 433 ms | clear | 0 ms |
| Mt Macquarie AL | 151.5 | **900 ms** | Barneys Bore AL (0 ms), 467 ms | clear | 900 ms |
| Wyanga AL | 151.5 | **0 ms** | Barneys Bore AL (0 ms), 433 ms | clear | 0 ms |

### Group 20 — Burnett River

2 repeaters, 1 pair; on one delay: on top; planned under 1 s: clear.

| Repeater | Channel (MHz) | Delay, under 1 s | Closest neighbour, apart | State | Delay, up to 3 s |
| --- | --- | ---: | --- | --- | ---: |
| Boondooma Repeater AL | 152.4 | **750 ms** | Hawkwood Range AL (300 ms), 450 ms | clear | 450 ms |
| Hawkwood Range AL | 152.4 | **300 ms** | Boondooma Repeater AL (750 ms), 450 ms | clear | 0 ms |

### No neighbour on their readings — leave as they are

Banana Range AL, Bellthorpe (Gap Rd) AL, Black Mountain (Farleigh) AL, Bones Knob AL,
Cameron Hill AL, Caniaview AL, Castle Hill AL, Hollywell AL, Kroombit Repeater AL, Lower
Springbrook AL, Mingela AL, Mt Calder AL, Mt Fort William AL, Mt Hopeful AL, Mt Mongrel AL,
Mt Stuart #3 Repeater, Mt Stuart AL, Mt Wolvi AL, Paluma AL, Poverty Hill AL, Radar Hill AL,
Saddle Mountain #2 Repeater, The Stonewall AL, Westwood Range AL.
