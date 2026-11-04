# Hillcrest (Wine Glass) pass ranges — what to set them to

*Hillcrest AL (Wine Glass), 540235, the repeater on 151.500 MHz at Logan · the station
register as of 4 November 2026 · what Flood-Net's receiver heard, 5 October to 4 November
2026 · written 4 November 2026.*

A **pass range** is a block of ALERT addresses a repeater is set to relay. Hillcrest
relays every reading it hears whose address is in one of its ranges, and sends it out again
on the channel it heard it on, 151.500.

## The answer

**Cut Hillcrest from 621 addresses to 167.** Keep Logan's stations and the few stations
no other repeater on 151.500 carries. Leave the Ipswich, Lockyer, Moreton Bay and Brisbane
blocks, and the Scenic Rim block, to the repeaters that already carry them.

| Now | Suggested | What the suggested range carries |
| --- | --- | --- |
| 1900–2200 | **2051–2053** | Springfield Lakes AL (Ipswich City Council) |
| | **2065–2067** | Grandchester AL (Bureau), kept to be safe, see *Watch* |
| | **2101–2102** | Jingle Downs AL |
| | **2179–2181** | Rosewood Detention Basin AL (Ipswich City Council), kept to be safe |
| 4151–4199 | **4151–4199** (no change) | Logan's block: Schmidts Rd, Bayes Rd, Lower and Upper Quinzeh, Waller Rd, Henderson Ck, and room to grow |
| 4800–4899 | **4840–4845** | Springfield Lakes HL Dam and LL Dam |
| 5304–5399 | **5308–5312** | Romani, Maclean Bridge (Logan City Council) |
| | **5356–5367** | Mt Alford, Mt Sugarloaf, Wyaralong Dam (Nindooinbah and Bromelton Dams come along, at no cost) |
| | **5391–5399** | Darlington School, Innisplain |
| 6200–6274 | **6200–6274** (no change) | Hillcrest's own rain and battery, and Logan's block: 18 stations from Oxley Ck to Beenleigh |

**If the repeater takes only eight ranges** (the most any repeater on the register holds),
leave out 2065–2067 and 2179–2181. Those two are kept only to be cautious. Then watch them
with the rest (see *Watch for a week after*).

What it does:

- **Hillcrest sends about 7 in 10 fewer relays.** 15,469 of the 22,333 bursts heard on its
  carrier from 22 October to 4 November were from addresses the suggested ranges leave out.
- **No station is left without a repeater.** Every station on file that Hillcrest carries
  today is still carried by at least one repeater afterwards. That includes all 24 Logan City
  Council stations, all 16 Ipswich City Council stations, all 11 City of Moreton Bay stations,
  all 7 Scenic Rim Regional Council stations and all 6 Brisbane City Council stations. 39
  stations stay on Hillcrest and 113 go to repeaters that already carry them.
- **Its overlap with Constitution Hill falls from 319 addresses on file to 87.** That was
  the busiest pair of repeaters in the delay plan ([repeater-delays.md](repeater-delays.md)).

## Why it is too open

**1900–2200 and 4800–4899 copy Constitution Hill's ranges exactly, and Constitution Hill is
itself a base.** Together they cover 94 stations in this area, from Beachmere and Dayboro,
60 km north, to Buaraba and Grandchester, 56–70 km west. For 86 of them, Constitution Hill's
modelled fade margin (how much signal is to spare on the path) is better than Hillcrest's, by
up to 49 dB. Of the other eight, four stay on Hillcrest (Grandchester, Jingle Downs and the two
Springfield Lakes gauges). The other four are Calamvale, Forestdale, Greenbank and Mt Marrow,
where Constitution Hill still has 16–34 dB. Whatever Constitution Hill hears has already
reached the Bureau, so Hillcrest's copy adds nothing.

**Hillcrest re-sends Constitution Hill's relays.** Timing shows it. Each relay comes a fixed time after the
burst it repeats: about half a second here, one hop. Where Flood-Net's receiver heard an
earlier copy of the same reading:

- For **Logan's stations**, Hillcrest's copy came about 0.5 s after it (26 of 28 times). That
  is one hop: Hillcrest heard the station itself.
- For the **Logan–Albert stations in 5308–5399**, the same: 107 of 111 one hop.
- For the **Ipswich, Lockyer and 4800–4899 stations**, more than 8 in 10 came 0.9 s or more
  after an earlier copy, most of them 1 to 1.6 s. So Hillcrest was the second or third transmitter of that reading.
  John Bray Park is plain: 240 of 253 of Hillcrest's copies came 0.5–2.8 s after another copy,
  most of them 1.0–1.4 s.

So on 151.500, one reading from Ipswich often goes out three times or more: the station's own
burst, Constitution Hill's relay and Hillcrest's. That airtime is shared with every station
and repeater on the channel. It matters most in a storm, when gauges send fast and bursts
collide. Each needless relay is also another chance for the small damage Hillcrest does
(1.6% of the relays checked, [investigation 03](../investigations/2026-11-hillcrest-wine-glass.html)).

**5313–5399 is already carried onto 152.400.** Laheys Lookout, O'Reillys, Wilsons Peak and
Kooralbyn carry those stations, and Flood-Net's receiver heard them there hundreds of times
in 20 days: for example Kilmoylar Rd 865 times, Yarrahappini 670, Bromfleet 588 and
Nindooinbah Dam 551. Hillcrest's copies of most of them were few, or second-hand.

**Its ranges also hold 67 far-off stations** that use the same addresses on other networks:
54 in 4800–4899 (Gippsland, Alice Springs and Bundaberg) and 13 in 5304–5399 (South
Australia). Hillcrest can never hear them. The ranges were never cut to fit this area.

## Nobody is orphaned — the council stations

| Council | Stations in Hillcrest's ranges | Stay on Hillcrest | The others are carried by |
| --- | ---: | ---: | --- |
| Logan City Council | 24 | 19 | Laheys Lookout, heard on 152.400 460–865 times each in 20 days (Bromfleet, Yarrahappini, Tamborine, Flagstone Ck, Kilmoylar Rd) |
| Ipswich City Council | 16 | 2 | Constitution Hill. Modelled margin from Hillcrest is worse for all 14 |
| City of Moreton Bay | 11 | 0 | Constitution Hill, and Round Mt Res for Beachmere and Lipscombe Rd |
| Scenic Rim Regional Council | 7 | 0 | Laheys Lookout, O'Reillys and Wilsons Peak onto 152.400, the channel the SRRC base listens on. Hillcrest never reached that base: it sends on 151.500 |
| Brisbane City Council | 6 | 0 | Constitution Hill, 34–40 dB. Hillcrest relayed these six 11 times between them from 22 October to 4 November |

**Why Logan's stations stay.** Hillcrest hears them first-hand. Its modelled margins are
8 to 54 dB, apart from Wolffdene and Bahrs Scrub, which are weak on every path.
Constitution Hill's are −7 to 24 dB. The register lists Mt Tamborine as a second
path for 4151–4199 and 6200–6274. But in 20 days of listening to 152.400, Flood-Net's receiver
heard **none** of those addresses there, while Mt Tamborine's Gold Coast block came through
more than 13,000 times. So for Logan, Hillcrest is the main path and Constitution Hill the
only backup. Keep both.

**Why the five stations in 5356–5399 stay.** Mt Alford, Mt Sugarloaf, Wyaralong Dam,
Darlington School and Innisplain are in no other 151.500 repeater's ranges. Constitution Hill
No 2 lists them but listens on 152.400. Mt Alford sends on 151.500 and Hillcrest hears it
first-hand (98 of 103 one hop). The rest are heard too seldom to be sure, and keeping them
costs Hillcrest almost nothing.

## Watch for a week after

1. **Check in the Bureau's own data that each station below still arrives.** Each one sends
   a report every three hours, rain or not, so a gap shows within a day. If one goes quiet,
   add its range back to Hillcrest.
   - Kept only to be safe (or left out under the eight-range option): **Grandchester AL**
     2065–2067, **Rosewood Detention Basin AL** 2179–2181.
   - Taken off, with a weak modelled margin to Constitution Hill: **Meadow Flat Rd Bridge**
     4837–4839, **Marburg AL** 2086–2088, **Limestone Park** 4828–4830, **South Ripley (Wards
     Rd)** 4813–4815 (all Ipswich City Council); **John Bray Park** 1956–1958, **Samford
     Valley** 1962–1964, **Lipscombe Rd** 1979–1981 (City of Moreton Bay); **Greys Plains Rd**
     2077–2079, **Goolman** 4818–4819, **Upper Western Ck** 4816–4817, **Lower Mt Walker**
     2030–2032, **Peak Crossing** 2062–2064, **Tallegalla** 2068–2069. In every case
     Hillcrest's own margin is worse, and where the timing shows anything, Hillcrest's copy
     came second.
2. **Flood-Net's own receiver will hear less, and that is expected.** It hears about 48 of the
   stations being taken off mostly through Hillcrest (Ipswich AL, Moggill, Brisbane Rd,
   Karalee, Beachmere and others). Station Health may call them quiet. That is our receiver
   losing a copy, not the network losing the station. Constitution Hill's copies may come
   through clearer once Hillcrest stops landing on top of them.
3. **Put the new ranges on the register once they are set.** Use the Stations tab: Hillcrest's
   card, then its pass ranges. Then the Pass Ranges and Repeaters tabs and the delay plan
   follow the real setting.

## Also found

- **Mt Tamborine's register ranges don't match the air.** Its 4151–4199 and 6200–6274 are
  never heard on 152.400. Either it isn't set to relay them, or it can't hear Logan. Worth
  checking at its next visit, and correcting on the register either way.
- **Something not on the register sends 4846–4848 and 4856.** It was heard 2,672 times on
  151.500 in a month, on a steady carrier. The register has those addresses only on stations
  in Victoria. It is probably a station in this area that's missing from the register.
  Constitution Hill still carries 4800–4899, so this change doesn't cut it off, but it should
  be found and recorded.
- **Hillcrest and Constitution Hill still share 87 addresses** (Logan's blocks and a few
  others), so they still need different delays. The ⏳ Repeater Delays tab plans again once
  the register holds the new ranges.

## How this was worked out

- **Ranges and stations:** `stations.json`. A station counts as carried if one of its ALERT
  addresses is in a repeater's pass ranges, as the Pass Ranges tab works it out. Owners come
  from the Bureau's Service Level Specification.
- **Margins:** the fade margins saved in Flood-Net (`meganet.link_fade_margin`, the field
  model), station to repeater, one way. Good is 15 dB or more, OK is 6–15 dB.
- **What was heard:** Flood-Net's receiver, legacy ALERT. On 151.500, 5 October to
  4 November. On 152.400, 5 to 24 October, when it was listening there. Hillcrest's carrier is
  +120 to +240 Hz, as investigation 03 found; offsets were measured from 22 October.
- **Timing:** for each burst on Hillcrest's carrier, the earliest copy of the same address
  and value on another carrier in the five seconds before it.
- **Limits:** the receiver is one site and is not a Bureau base. A margin is a model, not a
  measurement. So the watch list above is part of the change, not an extra.
