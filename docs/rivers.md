# Rivers and creeks

The rivers themselves, on the Stations map: every principal named river and
creek in Australia, drawn under the pins, named along their courses, and each
one a thing to select. It is **🗺️ Map display → Rivers and creeks (Geofabric,
BoM)**, the first of the overlay layers, and it is `map-river-lines.js`.

It was asked for in these words: *"what I really need is the rivers themselves
plotted on the map. They are really what we are most interested in this whole
project, is the rivers."* So it is **on by default** — in every look, including
Calm, which starts every other context layer off — and remembered on this
device once it is turned off.

---

## What is drawn

| Zoom | Rivers drawn | For example |
|---|---|---|
| up to 4 (Australia) | reaches draining 20,000 km² or more | the Murray, the Darling, the Burdekin, the Fitzroy |
| 5 | 5,000 km² or more | the Bowen, the Brisbane above the Lockyer |
| 6 – 7 (a State) | 1,000 km² or more | the Lockyer, the Haughton |
| 8 | 250 km² or more | |
| 9 | 50 km² or more | |
| 10 – 11 | every principal named river and creek | |
| 12 and closer | and the minor named creeks — Oxley Creek, Kedron Brook | asked of the live service a view at a time |

A river is drawn from its mouth upward as you zoom in — the same rivers, longer
— rather than a confetti of creeks, and the line is heavier the more country
drains through it, which is how a river map says which is the main stream. The
lines are drawn over the roads and the filter's river highlight and under every
pin, link and survey mark.

Names run along the rivers, turned to follow them and never upside down: the
biggest rivers first, up to 24 a view, each only where its stretch on screen is
long enough to carry it and the name would not overlap another.

## Selecting a river

- **Hover** a river: its name follows the pointer, the river glows, and the
  cursor says it can be clicked.
- **Click** it: the river is selected — every reach of it, from its headwaters
  to its mouth, whatever the zoom — in a navy line over a cyan glow, and a
  callout says how much country drains through its lowest reach, how many
  kilometres of channel are mapped, and **which of this network's stations are
  on it**, each a button that takes the map to the station with its card up.
  *Zoom to the whole river* fits the map to it.
- **Put it down** with a click on open map, *Clear selection* in the callout,
  *Clear* beside it in the Map display panel, or 🧹 *Clear the selection*.
- **Without a mouse**: the Map display panel lists the rivers named in view as
  buttons; pressing one selects it and opens its callout.
- **📍 Find a place**: a river or creek picked there — one of the network's own
  or one the gazetteer found — is selected on this layer, and the map goes to
  the whole of it. ✕ in Find a place puts it down with the pin.

A point under the pointer wins over the river it sits on: a station pin, a
radio link, a bridge, a survey mark or a field photo answers its own click. So
does an armed tool — Draw & measure, a link-budget pick, What is here, a pin
being moved.

A river's stations are the register's stations whose `stream` names it — with
the register's shorthands read as words (CK, R, STH, NTH) — and that stand
inside its extent, because "Deep Creek" is several different creeks.

## Where it comes from

The **Australian Hydrological Geospatial Fabric** (the Geofabric) v3.3,
Surface Hydrology Network, from the Bureau of Meteorology: *AHGF Network
Stream – Major, Named*, the principal named watercourses of the 1:250,000
national topographic series as one connected network, each reach with the area
that drains through it. © Commonwealth of Australia (Bureau of Meteorology),
CC BY 4.0. National, like the station register — a quarter of its stations are
outside Queensland — and named in capitals, the register's own convention, so
a river finds its gauges by name.

| File | Holds | Read |
|---|---|---|
| `data/rivers-au.json` | every river's name, drainage area, length and extent, and its reaches of 1,000 km² or more (1.5 MB) | when the map first opens with the layer on |
| `data/rivers-au/<lon>_<lat>.json` | the smaller reaches, a 2° square each (180 files, up to 32 KB) | from zoom 8, for the squares in view |
| the Geofabric's *Network Stream – All* service, on Geoscience Australia's Digital Atlas | the minor named creeks — about 600,000 segments, too many to ship | from zoom 12, a view at a time |

The two files are the site's own, so the service worker keeps the last copy of
each: the rivers are there with no signal wherever the map has been before.
The minor creeks need the network, and the panel says so when it is not there.

`tools/build_rivers.py` makes the files; `tools/README.md` says how. There is
nothing to re-run it for unless the Bureau publishes a new Geofabric.

## Limits

- **Mapped at 1:250,000.** A line is good to about a hundred metres; up close
  over imagery a river can sit beside its channel. The files are simplified to
  about 40 m, inside that.
- **Principal rivers first.** The national files hold the Geofabric's *major*
  named watercourses — 3,149 names. A small named creek is one of the minor
  ones, drawn only from zoom 12 and only with a network. An unnamed
  watercourse is not drawn at all.
- **One river, one name.** A river is the reaches of one name that join. Where
  the Geofabric spells a river two ways — the River Murray below the South
  Australian border, the Murray River above it — they are two rivers.
- **The highlight is separate.** *Highlight matching rivers* (map-rivers.js)
  still lights up the OpenStreetMap watercourses matching the filter box; the
  two can be on together.
