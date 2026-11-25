# Riverside sites — where along a river a station would be heard

**🌊 Riverside sites** is a pane of the Stations map's side panel (Tools, after
📜 ACMA licences). Click a place on the map, as near a river as you would put a
station, and it says how good a home a station would have there. One button then
does the same for every place along that river a few kilometres either way, and
draws the answer as a **strip**: the river's own quality, place by place.

It is `map-riverscout.js` (`MapRiverScout`), and `npm run riverscout` holds it.

It was asked for in these words: *"Station relocation tool to consider riverine
locations with good errts."* **errts** was read as radio reception — how well a
station there would be heard. (The register uses "ERRTS" for the Bureau's older
rain-gauge canister, which the ELPRO ERT-A2 replaces; it has no other meaning
here.)

## How it differs from the other two finders

| | 🚚 Relocate station | 🎯 Best repeater | 🌊 Riverside sites |
|---|---|---|---|
| Starts from | a station that has to move | a station or a new site | a click, on or near a river |
| Looks at | the ground within a few hundred metres | the masts already standing | the **river**, kilometres of it |
| Radio | modelled fade margin to the repeaters that hear it now | modelled, ranked, on to a base | modelled **and** what the receivers actually heard of the stations round it |
| Answer | coloured ground, the best few spots | the repeaters, ranked | a score, and a strip along the river |

## The score

Three figures, each nought to one, weighted and added, out of 100. Every answer
prints the weights it used.

| Figure | What it says | Nought | One | Weight |
|---|---|---|---|---|
| **Heard** | the fade margin to the best repeater or base within reach (the nearest four are priced) — the link budget card's own arithmetic, the radio most of the network runs, one way | 6 dB under the map's *ok* | 10 dB over its *good* | 55% |
| **Neighbours** | the share of frames that were good, over the last 14 UTC days, from the stations within 15 km — nearer ones, and ones on the same river, counting for more | 70% | 100% | 25% |
| **Riverside** | how close the place is to a river line | 1.5 km | within 150 m | 20% |

- A place **no repeater or base hears at the map's *ok* never scores 50**,
  whatever else it has: the margin is the requirement, the rest is preference.
- **Neighbours** comes from the reception rollup, `reception_daily` (one row a
  day per receiver and transmitter — not the raw `reception` table), read once a
  session, bounded to the last 14 days on its `bucket` column, and only for the
  stations with 30 or more frames. Receptions are for **editors**; anybody
  else's score is worked out without it and the other two share its weight
  (heard 73%, riverside 27%). The panel says which.
- **Riverside** reads the Geofabric river lines the Stations map draws. They are
  a 1:250,000 map's, so a hundred metres either way is the map's own error.

## Along the river

*Score this river* joins the river's lines end to end from the click, walks 5, 10
or 20 km each way, and prices a place every 250 m, 500 m or 1 km (at most 81
places; each priced on 96 terrain samples to the nearest four receivers, three at
a time). The river part of every place is one by construction, so the strip is
the radio and the neighbours.

- The **strip** is a cell for each place, in the order along the river, as tall
  as its score and coloured by band (green 70 or more, yellow 50 to 70, red
  under 50, grey not priced). The ends are named by compass. A cell pressed puts
  that place's card up and moves the map to it.
- The places are dotted on the map in the same colours; the best five are
  numbered pins, and listed under the strip.
- **Save CSV** has a row for every place: how far along the river, lat, lon, the
  score and its three figures, the best margin, and how many neighbours counted.

## What it is not

~30 m terrain and omnidirectional antennas, a river line good to about a hundred
metres, and nothing about whether the bank is above the floods, the ground will
hold a footing, or the landholder agrees (Flood-Net holds no landholder details).
It is a short list to walk on site, not a survey.

## Where it reads from

| What | From |
|---|---|
| Rivers, and the stations on them | `map-river-lines.js` (`MapRiverLines.nearestTo`, `courseOf`) over `data/rivers-au*.json` |
| Terrain and the path arithmetic | `terrain.js`, `path-profile.js` (`pathGround`, `pathAnalyse`), as 🎯 Best repeater |
| Repeaters, bases, radios | the station register in memory |
| What was heard | `reception_daily`, via `dbSelect` (editors only) |
