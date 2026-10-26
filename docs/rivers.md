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

## Plotting a river's gauges together

A selected river's callout ends with a pair of pills for **every river height
gauge along it** (`group-plots.js`), and the names of the stations they
capture under them:

- **📈 ARRO this river** opens ARRO's graph with each gauge's Water Level
  device on one chart (`devices[]=site|device`, the last seven days), at most
  40 of them.
- **📉 Flood-Net plot** opens a dialog of what each gauge has sent, out of the
  Flood-Net datastore: a strip a gauge on one time axis, **highest ground
  first** — roughly upstream to downstream, so a flood is seen going down the
  river — each on its own scale, because each reads against its own zero.
  24 hours to 12 months; the pointer or the arrow keys read every strip at
  one instant; the gauges are a table one press away. **Open in Field Data**
  takes the same gauges and window to that tab, ticked as a group, where they
  are filtered, inspected and exported.

The gauges along a river are the stations above that carry a river height
sensor, **and** the gauges with no `stream` recorded — 580 of the register's
1,283 — that stand within 300 m of the river's line as drawn. The callout
marks those *(on its line)*.

The same pair is on a **station's card**, under *Plot with its neighbours*:

- **River** — for a station with a river height sensor: the river it stands
  on (the one its stream names, or with no stream the line within 300 m of
  it), and every gauge along it. With the rivers switched off, or a stream
  the Geofabric does not draw, the gauges whose stream has the same name
  within 60 km, and the card says it matched by name alone.
- **Rain** — for a station with a rain gauge: every rain gauge within a
  distance of it, nearest first, on **one** millimetre scale so the bars
  compare. 25 km to start; the slider takes it from 5 to 100 km, on the card
  or in the dialog, and this device remembers it.

A gauge is a measurement, not a sensor row: *Rainfall* and *Rainfall
Increment* on one ALERT address are one gauge (ARRO is handed the increment),
and two register records on one address are one strip, not two.

## A river's catchment, and a gauge's

Selecting a river also shows **the land that drains into it**: outlined, and
shaded by the height of its own ground — river-flat green through the plains'
straw and the ranges' brown to pale tops. The ramp is stretched over that
catchment's own heights (its 2nd to 98th percentile, which the legend gives),
so the relief of a coastal creek reads as clearly as the Great Dividing Range.
The callout gives the catchment's area. *…with its catchment, shaded by
height*, under the rivers switch in Map display, turns it off (remembered).

A station on a stream has a **Catchment** section on its card: the area above
its gauge, and *Show the catchment on the map*. It is the Bureau's own where
the station's AWRC number is a gauging station of the Geofabric's network
(the card says so). Otherwise the station is placed on its stream by name and
position, and its catchment traced up the Geofabric's finest catchments — one
for every stream segment, minor creeks included — from the reach it stands
on; where those cannot answer, it runs to the nearer of the two sub-catchment
boundaries round it — the one whose area is closer to the Geofabric's own
drainage area at that reach. The card says which.

Either is put down with the river: a click on open map, *Clear selection*, or
🧹.

**Where the boundaries come from.** Not the elevation tiles in the browser —
working out where water runs from raw heights needs a hydrologically
conditioned DEM (pits filled, streams burnt in, flats given a direction) and
a hundred million cells for one big river. The Bureau has done that for the
whole country: the Geofabric's *Hydrology Reporting Catchments* cut the land
from a ~30 m DEM at every significant node of the stream network — junctions,
dams and the gauging stations themselves — into 53,804 sub-catchments, each
draining from one node to the next. `tools/build_catchments.py` walks that
network upstream for every river and every station on a stream, joins the
pieces on a 250 m grid and traces the outline, simplified more for a big
catchment than a small one (a continent-sized one is only ever looked at
whole) and, for one under a few hundred kilometres across, its grid's
staircase rounded off. A small creek can lie wholly inside one sub-catchment
of the river it joins, so for a river's mouth or a station's reach draining
under 2,000 km² it reads the network's own **fine catchments** as well — one
for every stream segment, about a square kilometre each, seven million in
all — round that reach only, and traces everything above it on a 50 m grid. The shading is the Elevation layer's terrain — the same ~30 m tiles,
hillshaded the same way — clipped to the outline. With no terrain (offline,
a blocked host) the catchment is a flat wash and the legend says so.

| File | Holds | Read |
|---|---|---|
| `data/catchments-au/index.json` | every river's and station's catchment area, and which file holds its outline (~75 KB) | when a river is first selected, or a station card first asks |
| `data/catchments-au/r<n>.json`, `s<n>.json` | the outlines, 32 rivers or stations a file | when one of them is shown |

**Limits.** 3,022 of the 3,728 rivers have a catchment, 531 of them cut from
the fine catchments, and 1,145 stations — 98 at a gauged node of the Geofabric
(most of this network's gauges are the Bureau's flood warning gauges, and most
of the Geofabric's are the States' water-monitoring ones), 565 traced up the
fine catchments from their reach and 482 to the nearer sub-catchment boundary.
The outline is good to a few hundred metres; the area quoted is the Bureau's
own, from its catchments. It can be well above the network's drainage area at a river's mouth — the
Burdekin's catchment is 127,000 km², its basin's 129,860, where the network
gives 94,000 at its lowest reach — so a river's card leads with the
catchment's. A pocket inside a catchment that the
Geofabric says drains nowhere is filled. Every catchment is checked against
the network's own drainage area at its reach and left out unless within 0.6
to 1.6 of it; the 706 rivers without one are mostly short creeks of a few
tens of square kilometres where the fine catchments and the stream network
disagree, and their callout says so. A minor creek from the live service has
none either.

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
