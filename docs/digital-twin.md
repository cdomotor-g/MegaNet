# The Digital Twin tab

One station's patch of ground in three dimensions: the real relief under it
from the best public elevation model there is, the aerial imagery draped over
it, a **2 m × 300 mm pole** where the station stands and a **1.75 m figure**
beside it for scale. Orbit it, look straight down on it, or walk about in it
at eye height; click the ground for its height; watch the station's flood
levels rise over it as water; and download the whole scene as a `.glb` that
Blender opens in one step.

It is `digital-twin.js`, the **Digital Twin** tab under *Stations & networks*,
and a 🧊 pill on the card of every station with a position. `npm run twin` holds it, and `npm run flood` its
flood water (see the end).

---

## Why a tab of its own

The Stations map's 3-D view (`map-3d.js`) is the whole network on the
ground — tens of kilometres of terrain at ~30 m, links and pins draped over
it, and a camera that stays a map camera: it tilts and turns, but it never
goes below the terrain and never stands on it. This is the other scale
entirely: a few hundred metres around one site, the ground to 1 m where the
State holds LiDAR, and a camera that can be put at a technician's eye height
beside the pole. Those are different renderers answering different questions,
and the honest thing is two of them rather than one that half-answers both.

## Where the ground comes from, in order

### 1. Queensland's own elevation service

`Elevation/QldDem`, an ArcGIS ImageServer on
`spatial-img.information.qld.gov.au` — the State's publicly available
bare-earth DTMs: **0.5 and 1 m LiDAR where it has been flown, SRTM elsewhere,
in AHD**. It is the same Queensland LiDAR that Elvis (elevation.fsdf.org.au)
lists under "QLD Government", served by the agency that flew it.

Measured against the live service, not read off a page:

| | |
|---|---|
| Native pixel | 0.5 m (the service's `pixelSizeX`); the LiDAR is 0.5–1 m, the fill SRTM |
| One request | `exportImage?bbox=…&bboxSR=4326&imageSR=4326&size=201,201&format=tiff&pixelType=F32` |
| What comes back | a GeoTIFF: one band of 32-bit floats, **uncompressed**, in **128 × 128 tiles**, little-endian, with GDAL's NoData tag (`-9999`). 201 × 201 is ~263 KB in 2–5 s |
| Outside the data | an *empty* TIFF — every tile's byte count is zero — not an error and not zeros |
| CORS | reflects any origin, `null` (file://) included, so no proxy and no key |
| Extent | lon 137.8–160.1, lat −29.7 to −9.0 (the service's own, in degrees, rounded outward); nothing outside it is asked for |

That TIFF is read in a hundred lines of `digital-twin.js` (`readTiffF32`)
with no library: tiles or strips, either byte order, and a refusal for
anything that is not one band of uncompressed floats — a compressed or
integer answer means the service changed, and the fallback ground is the
honest response.

**The request box is the patch grown by half a sample on every side.** An
ImageServer samples a pixel at its centre, and `size` pixels over a bbox have
their centres at `bbox.min + (i + ½) · pixel`. Asked for the patch itself,
every height would land half a sample off and the middle one a metre off the
station, and nothing would look wrong. Grown by half a sample, the 201 pixel
centres are the 201 mesh vertices and the middle one *is* the station.

**And `adjustAspectRatio=false`, which is load-bearing.** A patch that is
square in metres is not square in degrees — a degree of longitude is cos(lat)
of a degree of latitude — and the ImageServer's default (`true`) quietly
widens the shorter axis so the pixels come out square in the image's own
units. Measured live: a 402 m box at Brisbane came back 450 m north to south,
every row 2.24 m apart on the ground where the mesh had them at 2.00 m, the
centre pixel still on the station and nothing to see. With the parameter off
the service honours the box as asked, and the module checks the GeoTIFF's own
`ModelPixelScale` and `ModelTiepoint` against the request rather than trusting
it: a raster that came back a different shape is a failed request, not a
ground. `npm run twin` asserts the URL the tab sends, and its fake service
snaps the extent exactly as the real one does unless the parameter is there,
so the regression is one the check can see.

### Why not Elvis's API for this

Elvis exposes one keyless call a browser can make — the height at a point
(`api-elevation.fsdf.org.au/elevation-at-point`), which `elvis.js` measured
at 1.4–5 s each, no batch, and load-shedding above ~8 in flight. Forty
thousand samples is not a request it can answer. Its bulk download
(`elevation/initiateJob`) is a job that arrives by email, and its other
endpoints (`identify`, `downloadables`) sit behind a CloudFront rule that
refuses anything but its own front end. So Elvis gives this tab the one
number it is best at — the AHD height at the pin and which dataset it came
from, in the Ground truth panel — and the State's raster service gives the
surface.

### 2. AWS Terrain Tiles, via terrain.js

Wherever Queensland's service has nothing — New South Wales stations, the
sea, an outage — the ground is the ~30 m SRTM every profile in this app
reads. `Terrain.grid()` is asked for a lattice at about the tiles' own
spacing (nearest-pixel, as it always is) and that lattice is lifted
bilinearly to the 201 × 201 mesh: sampling the tiles at 2 m directly would
be a staircase of fifteen flat steps across the patch. A patch the State
answered with *some* holes is filled from the tiles cell by cell and the
notes count how many.

A patch built on the tiles says so under the stage, because the difference is
the whole point: at 30 m the channel a gauge sits in is smoothed away and the
bank it stands on is a gentle slope. Elvis lists 1–2 m LiDAR for much of NSW
(`data/elvis/elvis-fill.csv` has 469 NSW stations answered off 1 or 2 m data);
it is not yet a raster source this tab can read, and the note says that too.

**Nothing is ever drawn flat.** A patch neither source could answer is an
empty stage and a status line that says why, never a plane at the station's
height — terrain.js's rule, which reaches further here than in a profile.

### Datum

The State's DTM is orthometric — **AHD**, the datum every surveyed
`elevation_ahd` in `stations.json` is in. The tiles are heights above the
**EGM96** geoid, within about a metre of AHD over Australia and not a survey.
The Ground truth panel names which one the ground is standing on.

## The imagery

The same shape as the ground:

1. **Queensland's aerial program** —
   `Basemaps/LatestStateProgram_AllUsers`, an ImageServer on the same host:
   the State Remotely Sensed Image Library's photography three years or older
   (10–20 cm in the towns, coarser in the bush), Planet satellite where
   nothing was flown. One `exportImage` JPEG of the patch: 1024 px for a
   patch up to 400 m (0.4 m/px), 2048 for the two wide ones. The service
   answers a patch it has no photography for with a plain grey sheet rather
   than an error; sixty-four pixels on an 8 × 8 lattice tell the two apart by their
   variance (`isBlank`).
2. **Esri World Imagery** tiles, stitched onto one canvas the patch's size,
   where the State's sheet is blank or unreachable — the same host and
   terms as the Stations map's Satellite base.
3. **A height ramp** — dark green through olive and tan to a pale crest —
   where neither can be had, with a note.

The imagery is a texture on the ground mesh; north is up in both the raster
and the JPEG, so the top row of each lands on the mesh's north edge. Within a
1.6 km patch the difference between a Web Mercator square (the tiles) and a
lat/lon one (the mesh) is a uniform scale, which mapping the box's corners to
the texture's corners already absorbs.

## The scene

**Coordinates.** Metres, y up, origin on the ground at the station: x east,
z south (three.js is right-handed with y up, so north is −z). Lat/lon →
metres is the equirectangular step `core.js` already carries
(`KM_PER_DEG_LAT`, `kmPerDegLon`), exact to a few centimetres over the widest
patch offered.

**The patch.** 200, 400 (default), 800 or 1600 m square, always 201 × 201
samples — 1, 2, 4 or 8 m apart. 200 m at 1 m is the State's LiDAR at
something close to its own resolution; 1600 m is the setting for a site on a
ridge whose relief is what matters.

**The station as built.** What stands at the origin is the station the
network puts there, read from the record — and where the record cannot say,
nothing is assumed:

- A **Type 3 rainfall station** — the green pole, 2.000 m × Ø0.300 m, the
  tipping-bucket gauge and its ring on top, the enclosure on the south face,
  the solar panel on its bracket to the north, the whip antenna up the east
  side, on a concrete pad — for a *telemetered* station that reports rainfall
  and not a river. A band in the station's role colour rides the pole. A
  repeater that measures nothing is the same pole without the gauge.
- A **river-gauge tower** — a 4 m galvanised mast on its flange, a 1.8 m
  grating platform with handrails and toe boards 4 m up, the cabinet on the
  platform's north side, the gauge on its west, the antenna mast with the
  solar panel and the whip at its north-east corner, and a ladder up the
  south side with rungs every 300 mm — for a *telemetered* station whose
  record says it reads a river: a sensor typed `Water Level…` or `Gas
  Pressure`, a legacy `water_level` ALERT address, a Bureau listing typed
  Water Level, or the SLS's data type. The foundation is below the ground and
  is not drawn.
- A **manual rainfall station** — the depositional collector an observer
  reads: a silver cylinder **Ø200 mm and 300 mm tall** standing on the ground,
  open at the top with its funnel inset.
- A **manual river station** — a white **staff gauge 1 m tall** on the
  ground, graduated as the real plates are: a black E every ten centimetres,
  the metre figures in red.
- A **manual station that reads both** — the two side by side, 1.2 m apart:
  the record has one coordinate for what are often two places on the ground,
  and the notes say so.
- **A red post, 1 m tall**, where the record cannot say what the station is —
  nothing says whether a person or a radio reads it, or nothing says what it
  measures. A Type 3 pole there would be a guess drawn as confidently as a
  fact; the notes say what is known and what is not.

*Manual* is what the Bureau's Service Level Specification says (its gauge
type, by bureau number — the station card's own lookup), or, for a station
the SLS does not carry, being in the Bureau's list of daily-read gauges
(Section 2 of its river height station lists) with nothing in the record
saying a radio reads it. *Telemetered* is a name ending AL, ALERT or TM,
ALERT addresses, satcom, or the SLS saying Automatic. What it measures is the
sensors, the ALERT addresses, the Bureau's location types and the SLS's data
type, together. The SLS file is read once, alongside the ground; a build that
cannot have it decides from the record alone and says so.

Inside each pole and tower enclosure is the kit the network fits, by
telemetry: an **ELPRO ERRTS ERT-A2** radio for an ALERT station (a name ending
AL or ALERT, or ALERT addresses in the record), a **Campbell Scientific
CR300** logger and a **Beam Iridium SBD modem** for a TM station (a name
ending TM, or satcom on). An automatic station whose radio the record cannot
name is drawn as TM, and the notes say so. Every tower cabinet carries a
**Kisters HS40 compressor bubbler** in its upper compartment — panel,
desiccant tube, pressure gauge, display, valves, compressor control and
compressor — and a **Victron** charge controller, the telemetry, the
terminals and the battery below. A plate inside names the station and gives
its number. Everything is primitives, not fetched models, at true size.

**The other stations in the patch** are built too, by the same rules, each
standing on the ground where the record puts it with its name over it — a
river gauge and the rain gauge beside it, a repeater on the ridge above a
town. The nearest forty; the line under the stage (*📡 Also in this patch*)
names every one with its distance and bearing, each name a button that goes
to that station's own twin, as a radio path's far end does. Their enclosure
doors open as the POV visitor walks up; only the centre's tower can be
climbed. They are the site, so they are in the `.glb`.

**Bridges.** The ground is bare earth — a LiDAR DTM is made by taking the
bridges *out* — so a road bridge over a creek is, on that ground, a road that
dives into the creek and climbs the far bank, and the imagery draped on it
dives with it. So each bridge in the patch is built as a deck across the gap:
the deck with the aerial photograph of the road on its top, girders under it,
rails along it and piers down to the bed where there is room for one. Where
they are comes from Queensland's road network — the *Bridges* layer of
RoadsAndTracks and the railway bridges of OtherTransport, one query each for
the patch's box — and, outside Queensland or when it cannot be reached, from
OpenStreetMap through Overpass. Neither answering leaves the ground as it is
and says so in the notes; no deck is ever guessed at.

How high the deck stands:

- **At the crossing height the Bureau lists**, where there is one: the river
  height station lists give the crossing a gauge is read against as a height
  *on the gauge* (a Bridge, Old Bridge or Highway crossing, 0031), and where
  the gauge's zero is surveyed in AHD that is a level — Gatton's Smithfield
  Road Bridge at 3.90 m on a zero of 87.54 m AHD is 91.44 m AHD. It goes on
  the bridge nearest the gauge, within 250 m, level from end to end: it is
  the height the Bureau says the crossing goes under at, which is the deck.
  The flood water, rising, covers it there.
- **Otherwise at its banks**: the ground at each end of the span, or a few
  metres on along the road where the approach meets the abutment, whichever is
  higher, and a straight deck between the two.

The widths are not in either source: a road bridge is 8 m across, a railway's
5 m, a track's 4 m (an OpenStreetMap way that gives its width or its lanes is
drawn at that). The line under the stage says each deck's level and which
rule set it. Bridges are the site: they are in the `.glb`.

**The imagery, sharp where it matters.** The drape is one texture over the
patch — 1,024 px over 400 m, 0.39 m a pixel — while the State has flown most
towns at 10 cm. So round the station, where the State's catalogue holds
imagery at least 1.5 times finer than the drape, a 100 m square is draped
again at 0.098 m a pixel, on a mesh of its own riding the ground a hair above
the patch's; while a pin is being moved, the square follows the pin (in 25 m
steps, one request at the end of a drag, never during one). The status line
says what was flown and when — *10 cm imagery (Lockyer Valley Urban, May
2021) round the station*. It is the view, not the site: not in the `.glb`.

**The doors** open on their own: the pole's enclosure when the POV eye comes
within 2.2 m of it, the tower's cabinet when the visitor is up on the
platform — and close again when they leave, or when the view goes back to
orbit.

**The notes, inside the map.** On the tab the notes are a list under the
status. Inside the Stations map they are folded under a one-line count
("⚠ 2 notes") that opens as a flyout over the stage — the stage never moves
for it — because a map on a phone is 340 px tall and three notes of four
lines each once left it no height at all. The map's zoom corner stands down
while the twin is up (← Map, Escape or a wheel out is the way back), which
gives a phone's bar the room its buttons need.

**The lines over the stage fold away.** The status, the radio paths, the
photos, the water, who else is here, the other stations and bridges, and the
notes are a line each, and together they were most of a small map. They sit
under one button — **▴ Details** on the tab's header and on the map overlay's
bar — and are **open when the twin opens** (the build is saying what it could
and could not get) and **folded ten seconds later**, the stage taking the
height back. The fold waits while the pointer is over the lines or the focus
is in them, and once the button has been pressed either way it stays as it
was left. Folded, the button counts the notes (**▾ ⚠ 2**), so a warning is
never folded out of sight without a mark, and what the status line says from
then on goes to the app's live region instead. A new station — or coming back
to the twin — opens them again. On a phone's map the line naming the other
stations and bridges stands down, as the water's does, and the button to the
tab with them: the bar is one row of 44 px targets.

**The figure.** 1.75 m, hi-vis and a hard hat, built from primitives (a model
is a file to fetch and a licence to carry; a capsule in orange gives a sense
of scale as well as a mesh of a face), a metre east of the pole with its feet
on the ground *there* — not at the pole's height.

**Vertical exaggeration** (1–3×) scales the relief and nothing else. The
station and the figure are their true size at every setting: they are the
ruler.

**Light, sky and haze.** A sun from the north, high, casting a short shadow
the eye reads as "standing on the ground". The sky is a dome that rides with
the camera, shaded from `--twin-zenith` overhead through `--twin-sky` at the
horizon to `--twin-haze` below it — tokens, so the light theme is a day and
the dark one a dusk with the horizon still a line — and the air is
exponential fog in the horizon's colour (95 % at 60 km, 3 % at 5 km, nothing
on the patch) so the far ground fades into the sky rather than ending at an
edge.

**The horizon.** Past the patch's edge the country runs to 60 km, so the site
reads as a place rather than a model on a table:

- *Three sheets of heights*, each 201 × 201 like the patch, about the
  station: ±4 km, ±20 km and ±60 km. The inner one is the State's raster
  resampled to 40 m (one request, AHD like the patch) where its box is inside
  the service's extent, the tiles otherwise; the outer two are the ~30 m
  tiles at the zoom `terrain.js` picks for 200 m and 600 m samples — four to
  nine tiles and one to four, most of them already in its cache from the
  Stations map. Nothing is fetched until the patch is standing, and the
  numbers on the panels never wait on it.
- *One mesh of concentric squares.* The innermost square **is** the patch's
  800 edge vertices — same place, same height, so there is no crack — and
  each square out is ~3 % wider than the last: 200 segments a side to
  1.5 patch-halves, 100 to 4, then 50 to the edge, ~50,000 vertices in all.
  Where a square is finer than the one outside it, its odd vertices are put
  on the line between their neighbours. The tiles' heights just outside the
  patch are lifted by however much they differ from the LiDAR at the edge,
  a lift that fades to nothing by three patch-halves out; the eye sees one
  ground, and the notes still say which is which.
- *The Earth's curve.* Every far vertex is dropped by d²/2R, with R the
  Earth's radius over (1 − 0.13) — the light's own refraction, 7,320 km —
  27 m at 20 km and 245 m at 60 km. That is what puts a horizon where one
  belongs and hides the far side of a plain below it; the depth buffer does
  the rest. The drop starts at the patch's circumscribed circle, so the seam
  is untouched.
- *Drawn outermost first.* A 24-bit depth buffer with a 0.2 m near plane
  cannot tell 40 km from 40.5. Rather than a logarithmic depth (which writes
  `gl_FragDepth` and so loses the polygon offset the wireframe rides on),
  each shell's triangles go in the index outermost square first and the far
  shell is drawn before the near, so where the buffer cannot decide the
  nearer ridge wins. The camera is never more than a few kilometres from the
  station, so its order is the station's.
- *Imagery per sheet* — the State's program, then Esri — at 1024 px: 8, 39
  and 117 m/px, draped as each sheet lands, coloured by height on the
  patch's own scale where none can be had.
- *Scenery, not survey.* Not in the `.glb`, not clickable, coarse on purpose;
  the exaggeration slider stretches it with the patch. It costs one raster,
  five to thirteen tiles and three images (about 2 MB); the Scene panel's
  switch turns it off, and the setting is kept. A sheet that does not arrive
  is a ring not drawn — never flat ground at the station's level — and the
  notes say so.

**The camera.**

| Mode | Pointer | Keys |
|---|---|---|
| Orbit (default) | drag to orbit; wheel to zoom; right-drag, Shift-drag or two fingers to pan; pinch to zoom | arrows orbit; `+`/`−` zoom; `W A S D` pan; `R` reset; `T` top-down; `F` or `P` for the POV; inside the Stations map, a wheel out past the edge or `Esc` hands back to the map |
| POV | drag to look; wheel to step; Point (a latch) to point | `W A S D` / arrows move at 3.2 m/s, Shift runs at 9; `Q`/`E` turn; Space held points; `Esc` back to orbit |

The POV eye is 1.70 m above whatever is under it — the ground, a rung, the
grating — and the orbit camera is never let under the hill between it and
the station. At a tower, walking into the foot of the ladder while facing it
takes hold of it: `W` climbs (1.2 m/s, Shift doubles it), `S` climbs down,
and at the top the visitor steps onto the platform, where the toe boards
and the cabinet hold them in and the cabinet door swings open. Walking out
through the hatch, facing it, is back onto the ladder. A compass rose over the
stage turns so its N points where north is on screen. A click on the ground
answers with where it is from the pole and how high it is — the twin's "what
is here".

**The table.** Under the stage, one activation away: the ground height along
two lines through the pole (west → east, south → north) at offsets that fit
the patch — part 3 of the design system's chart pattern, so the numbers are
there for whoever cannot see the picture.

## In the Stations map

The same twin is inside the Stations map (`map-twin.js`), and that is the
usual way in. **From zoom 17** — about a kilometre across on a laptop's map,
the moment a pin has become a place — with a station under the view, a card
at the top of the map **offers** that station's twin, whichever view is
showing: the 2-D map or ⛰️ 3-D (whose camera follows the 2-D map's zoom, so
both arrive the same way). It says what the twin would show that the map does
not: the aerial photography over the station, at the resolution and the date
the State's own imagery catalogue gives for that point — *Aerial photography
at 10 cm (Lockyer Valley Urban, May 2021) covers Gatton* — or, outside
Queensland's program, that the imagery is Esri's. **🧊 Open the digital twin**
hands the map's rectangle over; **×** puts the card away for that station
until the map is next zoomed out past 17. **🔍 Zoom to station** on the card
goes all the way in — the deepest zoom the base allows (17 on the topo base,
19 on the others) — so it lands on the offer.

The twin used to take the map over at 17 on its own. It did not ask, and a
map that turns into something else at a zoom level cannot be used at that
zoom level — a pin could not be clicked at 17 without a WebGL scene arriving
over it. Now the map stays a map at every zoom, and the twin is one press
away wherever it has something to add. **← Map** or **Escape** gives the map
back as it was, at the zoom it was at, with the card on it again; wheeling out
past the twin's widest orbit gives it back one level out.

"A station under the view" is, in order: the station on the card (the map's
memory of what you were looking at), the selected station, or the nearest
station to the map's centre — each only if it is within half a patch of the
centre, so a twin is never offered for a pin off the edge of the screen. From
zoom 14 a station under the view has its ground and imagery fetched ahead
into the same bounded caches the tab uses, so the hand-over, when it is asked
for, is a build from memory rather than a wait. The catalogue is asked once a
station and remembered for the session. The switch — **Offer the digital twin
at close zoom** — is in 🗺️ Map display, on by default and remembered.

⛰️ 3-D and the twin are one idea at two scales, and neither replaces the
other: a map camera cannot be put at eye height, and a site twin cannot show
a 60 km hop. The 3-D view is the network on its terrain — every pin and link,
the line-of-sight sheets — and the twin is the site. Zoom is the one thing
that already says which question is being asked, so zoom is where the offer
comes up.

The overlay is a child of the Leaflet container, above the 3-D canvas and
below the control corners (`#map-twin`, one step above `#map3d`'s window in
`styles.css`); Leaflet's own drag and wheel are held off under it, for
`map-3d.js`'s reason, and the station card stays above both. Its head is one
row that never shrinks — the words come off its buttons below `sm`, as they
do off the banner's — and the status, the paths, the flood water and the
credit line are one line each with the whole text as their tooltip, so a map
340 px tall on a phone still gives the stage a picture's worth of height and
nothing spills over the credit line under the map. Below `sm` the flood
water's line stands down altogether — there is no row to spare — and the
scale on the stage is its control. The twin's scene,
controls and teardown are `digital-twin.js`'s; `map-twin.js` decides *when*
and gives it a host. **Open the tab →** on the overlay opens the Digital Twin
tab on the same station, for the settings, the Ground truth panel and the
`.glb`.

## Moving a station's pin

The twin is the best place there is to put a station's position right: the
ground is the State's LiDAR and, round the station, the imagery is what was
flown — 10–20 cm over most towns. So the move-pin mode (`map-move-pin.js`, the
station card's **📍 Move pin on map**) works here, and in ⛰️ 3-D, as it does on
the flat map:

- **On the Digital Twin tab**, **📍 Move pin** on the header arms it for the
  station on the stage — there is no map under it, and none is needed. An
  **amber post** stands on the ground at the station, taller than what is
  built there so its head shows over it, with a ring at its foot. Drag the
  post across the ground, or click the ground where the station stands: the
  post goes there, a grey ring marks where the station was and a dashed line
  runs along the ground between the two. A panel on the stage reads the
  latitude and longitude back to six places and the distance moved — in
  centimetres under a metre — with **Save position** and **Cancel**. The 10 cm
  drape follows the post. **Escape** ends the move, and only the move.
- **Inside the Stations map**, the overlay's **📍** arms the same mode the
  station card's pill does; its panel is on the stage and the map's own, in the
  corner, stands down while the twin is up. Escape ends the move and leaves the
  twin up.
- **In ⛰️ 3-D**, the pin is drawn on the terrain — the same amber pin, as a
  marker that can be dragged, with its leader and its "was here" ring — and a
  click on the ground puts it where MapLibre says that pixel is on the
  terrain. It used to arm, put its panel in the corner and leave its pin under
  the canvas, where nobody could see or reach it; and a click fell through to
  the flat map, which on a tilted camera is somewhere else.

**Saving.** On the Stations tab the numbers go into the station editor's boxes
and the editor's own Save is pressed, as on the flat map. On the Digital Twin
tab there is no editor, so Save reads the station's **current copy from the
database** (`station_json`, with the stamp that goes with it), changes the
position and nothing else — its lists are left out, so `save_station()` leaves
every one of them as it is — and writes it back through the editor's own
`save_station()`. Somebody else's edit since this tab loaded is kept rather
than written over. Signed out, or with the station list not from the
datastore, the panel says so and the pin stays where it was put. Saved, the
twin is rebuilt standing on the new spot: its ground is a patch centred on
the station.

## The radio paths

What joins the station to the rest of the network is drawn from its antenna
as rays, each named twice with the far station, the distance and the bearing
— on the ray beside the pole, where the opening view is looking, and again
at the ray's end, scaled with its distance — and listed under the stage as
words: **Radio paths:** the far station's name, in the ray's colour, then its
distance and bearing. The name is a button that goes there: inside the
Stations map the map moves to the far station at this zoom and the hand-over
follows; on the tab the twin is rebuilt for it. Two sources, and the first is
the one that matters:

- **Inside the Stations map**, the map's own lines — the seam `map-3d.js`
  reads (`state.mapLines`): the same filters, the same colouring (channel,
  fade margin or line of sight, whichever is on), the same hidden and culled
  sets. Nothing is re-derived, so the twin cannot disagree with the map it
  was opened from. `npm run twin` holds the mirror: one ray per far end, in
  the colour the map gave the line.
- **On the Digital Twin tab** there is no map to mirror (leaving the Stations
  tab takes its lines with it), so the relations themselves are asked — the
  pass-range and backbone indexes `app.js` draws the lines from, through its
  own functions — in the plain colours. The notes say which, because "as the
  map colours them" and "as recorded" are different claims.

A path's far end is beyond the patch almost always, so the ray runs from the
antenna to the patch's edge along the line of sight to the far antenna (the
station's `rm_system` antenna height, or the 4 m default, at both ends; the
far ground from its recorded height or the terrain tiles). Over a hop this
short the earth's bulge is millimetres and is left out. Vertical exaggeration
scales the ray's rise with the ground's relief — the clearance it shows over
the ground is the true clearance at 1× and stretches with the ground above
that — and the antenna height itself, like the pole, is never scaled. Where
the antenna is higher than the 2 m pole a thin mast joins them, so the ray
leaves from somewhere the eye can see. The rays go into the `.glb` as meshes
named `path to …`.

## Exploring together

With **Explore together** on (the Scene panel; the setting is kept), the twin
joins a room for its station on Supabase Realtime — the project the readings
already live in, so no server of ours — and whoever else has that station's
twin open is drawn in it (`twin-presence.js`):

- **Who.** Each visitor is a figure in the hat, shirt and trouser colours they
  chose (three swatches in the Scene panel, remembered per browser; the
  defaults come from a per-browser id, so a person is the same figure every
  visit), with their name over their head: the local part of a signed-in
  address — the header's own rule — or "Visitor 417" for a stranger. What the
  room carries is that name, the three colours and metres from the station,
  and nothing else: never the address, never the session token, never a
  coordinate on the Earth. It is a public channel, joined with the project's
  publishable key, and that is the rule that keeps it so.
- **Where.** A pose — metres east and south of the station, the look's yaw
  and pitch, the ground/ladder/deck level and the climb, whether they are
  pointing — goes out at most four times a second and only when it changed
  (a keep-alive every five seconds otherwise), and each viewer walks the
  figure from its last pose to the next over the time between. The figure's
  height is worked out where it is drawn, from the level and the ground
  there, because each viewer's ground is exaggerated by their own setting. A
  visitor in orbit rather than the POV is named but not drawn; one who has
  wandered off this viewer's patch is not drawn either.
- **Pointing.** Hold Space in the POV, or press **Point** (a latch), and your
  right arm goes out along your look with a laser to whatever it lands on —
  the ground, the station, the far ground — and a dot there; the others see
  the arm and the laser from your hand, you see the laser from beside your
  eye. Space releases it; Point pressed again does; leaving the POV does.
- **The line under the stage** says who is here ("With you: bao · Visitor
  417"), that you are alone, or why the room could not be reached.
- **The budget.** The project's plan allows a hundred messages a second
  across everything it serves, and a pose to a room of N is N − 1 messages.
  Four a second, only on change, and past four others in the room a visitor
  listens without publishing (the line says so) — five people walking at once
  are eighty messages a second, inside the budget; figures are still drawn
  for up to eight, so a visitor who is listening sees who is there.
- **The wire.** The socket goes the way every database call goes: through
  the site's own Worker where there is one (`/api/db/realtime/v1`, which
  `worker/index.js` carries with the WebSocket upgrade — the fourth service
  on its list), and to the project directly everywhere else. On a network
  that filters by hostname the Worker's route is what makes the room
  reachable at all, and it is the one part of this that a check here cannot
  prove: it wants a socket from a browser on that network.
- **The protocol** is Phoenix's, a hundred lines of JSON written in the
  module rather than fetched as a library — join, heartbeat, presence track,
  presence state and diff, broadcast — every message of which was verified
  against the project before it was written down.
- **The check** stands up a fake room with Playwright's WebSocket routing: it
  reads what the twin sends (the join's config, a track with no address in
  it, poses gated to the rate) and plays a visitor in — joining, walking,
  pointing, leaving — and measures the figure drawn for them. Every other
  check closes off-origin sockets at once, so no run reaches the project.

## Field photos

Where somebody stood with a camera is drawn where they stood
(`docs/field-photos.md` has the rest of it): for every spot in the patch with
field photos — photos within 3 m of each other are one spot — a post at chest
height (1.45 m) on the ground as drawn (the exaggeration slider moves it with
the ground), a camera on it turned the way the first photo there faced and
tilted as it was, a pale wedge the width of the lens's view ahead of it **for
each way a photo from there looked**, and a badge with the count that stays
about one size on screen from across the patch. A click on the badge, the
post or the camera opens the photos taken there; the wedge takes no click,
because it lies on ground people click for its height. The line under the
stage lists every spot by distance and direction from the station, and in the
POV, within 2.5 m of one, *📷 n photos taken here — Enter to look*.

*In the twin* on a photo stands the orbit camera 7 m behind that photo's
camera, looking the way it looked. The photos are asked for by the patch's
box, only for a signed-in editor; signed out, the line says to sign in and
nothing is drawn. None of it goes in the `.glb`.

## Flood water

The station's flood levels, stood on the ground as water. It rises from 0 m
on the gauge to the highest level the record holds — **sixteen seconds up,
whatever the range**, so a creek that floods 3 m and a river that floods 16 m
take the same time to watch — is held there for three, let out in one and a
half, and rises again. `flood-stages.js` holds the ladder, the colours and the
cycle (pure: a station record in, numbers and words out); `digital-twin.js`
draws them.

**The colours** are the level the water has passed: a clear blue below minor,
green past minor, yellow past moderate, red past major, and past the AEP
floods magenta through to a dark blue at the rarest — magenta and dark blue
when a station has two AEP levels, the ramp between them shared out when it
has three or four (446 of the 538 stations with AEP levels have all four). The
colour is that of the **furthest level passed in that order** — the classes,
then the AEP floods from the most frequent to the rarest — not of the last one
passed by height, because the two interleave more often than not: of the 115
stations with a major class, an AHD gauge zero and a 1% AEP level, 44 have
major *above* the 1% AEP level. There the water turns magenta before it
reaches major and stays magenta past it, rather than going back to red. The
colour says how rare a flood the water has passed, and it never says less as
the water rises. The tokens are `--flood-water-*` in `styles.css`.

**The levels**, all on one ladder in metres AHD:

- **The flood classes** (minor, moderate, major) are heights *on the gauge*,
  so they are put on the ground through the gauge zero in force — and only a
  zero surveyed to AHD. Of the 1,093 stations with classes, 769 have one;
  196 have a zero on an assumed, a State or an unknown datum, and 127 no
  surveyed zero at all. A class hung from a zero that is not AHD would be
  drawn as confidently as it was wrong, so it is named in the notes (*"…its
  zero is on the assumed datum rather than AHD, so they cannot be put on the
  ground: minor 7 m, moderate 10 m, major 15 m"*) and not drawn.
- **The AEP flood levels** — the row the station card reads
  (`FloodVelocity.pickRow`), already in AHD, so they stand whatever the zero.
- **The floods the river has seen** — HDB's peak flood heights (`0037`,
  `tools/ingest/flood_peaks.py`; `db/README.md` has the rest). The station
  record carries its **five largest floods, one per July–June season, largest
  first**, as `flood_peaks`:

  ```json
  "flood_peaks": [
    { "date": "1893-02-04", "height_m": 16.33, "level_m_ahd": 103.87 },
    { "date": "2011-01-11", "height_m": 15.38, "level_m_ahd": 102.92 }
  ]
  ```

  `height_m` is the height on the gauge as it then stood. `level_m_ahd` is the
  level the water reached, which the database works out through the gauge
  zero **in force on that day** — 129 of these gauges have had more than one,
  and Tinaroo Falls Dam's zero moved by 670 m at the end of 2010 — and leaves
  off where it cannot honestly be had: a zero then on an assumed, a State or
  no datum, or a height that would put the water more than 20 m over the
  gauge's own flood levels (HDB holds a few peaks written in m AHD). **Only a
  peak with a level is drawn**; one without is named in the notes, never
  hung from today's zero. `date` is the day in Queensland where HDB gives the
  hour (its extract is in UTC), else as much of a date as it holds — 1947-01,
  1887. Each is a ring on the staff, smaller than a class's, the highest
  labelled *Highest recorded (date)*, and the rise goes up to it when it is
  the highest level there is — at Gatton, 1893 stands 12 cm over the 0.066%
  AEP level. A flood never colours the water: it is history, not a class.

**Where 0 m is.** The gauge zero, when it is AHD and sits at the channel the
ground shows — no more than 30 m below the lowest ground by the gauge (a
dam's headwater gauge often reads AHD straight off a zero of 0) and no more
than 10 m above it. Otherwise the lowest ground within 60 m of the station,
and the notes say which and why. A storage's zero is never its bed.

**Where the water goes.** Not everywhere low. Every sample of the ground
carries the lowest level at which it joins the channel by the gauge — the
least, over every path from the channel to it, of the highest ground on the
path (a priority flood: Dijkstra with *max* for *plus*, once per ground). At a
level, a sample is under water when that is below the level. So a hollow
behind a bank stays dry until the bank is overtopped, and a dam in the next
gully is not flooded by a river it is not joined to. The water itself is one
plane at the level, masked to those samples and cut by the ground in the depth
buffer, so its edge is the true contour wherever the ground makes it.

**The water is only as good as the ground's sampling**, and a bank is where
that shows. The ground is 201 samples a side: 2 m apart at the default 400 m
patch, 8 m at 1600 m. A bank narrower than a few samples is drawn lower than
it is — a step between two samples on a diagonal can pass beside its crest
rather than over it — so water the real bank holds back can cross it here.
The check found this on its own valley first: a bank 4 m wide at the crest
leaked 40 cm under its top at the 2 m spacing, and had to be made
flat-topped to hold. A levee in the twin that fills when it should not is
worth looking at on a smaller patch before it is believed.

**The one simplification worth saying out loud: a level surface through the
whole patch.** A real flood slopes downstream — the AEP sheets give the slope,
a metre in 600 at Gatton — so across a 1.6 km patch the far edges are a
guide, not a map. The line's tooltip says so.

**The staff** is a white post in the channel from 0 m to the top, with a ring
at every level in its colour — the gauge board the water is read against. The
exaggeration slider moves the water and the rings with the ground.

**The scale on the stage** stands the levels up the left of the view, to
scale: ⏸ or ▶ and how high at its head (*14.6 m · moderate*), and under it a
track from 0 m on the gauge at the foot to the highest level at the head, the
water filling it in the colour it has, a mark at every level at its height,
and the level's name beside it — *Major 15.0 m*, *1% AEP 15.1 m*, *Jan 1974
14.6 m*, *Feb 1893 ★ 16.3 m* for the record — on the gauge where every level
has a height on it, else in m AHD. Names are moved off their marks only as far
as they must be not to sit on one another, a crowd of them spread evenly about
where their marks are and a line joining each to its own (`FloodStages.scale`,
pure, so `npm run flood` holds the arithmetic under Node as well as the
drawing in Chromium). Where the stage is too short for every name — the
Stations map on a phone — the least give way and keep their marks: the classes
first, then the highest flood recorded, the AEP levels from the 1%, then the
other floods.

- **Play and pause** at its head.
- **Skip to a level**: press its name, and the water is held there — the name
  says it is the one held.
- **Slide through the levels**: press or drag on the track and the water
  follows the pointer; let go within a few pixels of a mark and it takes that
  level exactly.
- **The keys**, on the track (a slider to a reader): ↑ ↓ a hundredth of the
  way, a tenth with Shift, Page Up and Page Down level to level, Home 0 m and
  End the top.

Anything but ▶ holds the water still. The scale steps aside while a pin is
being moved (its panel has that corner then), and its foot clears the hint
along the stage's foot, however many lines that makes.

**Turning it off.** Three places, each remembered in the browser (`mn-twin`):

- **The scale** above. On a phone's Stations map it is the only control: the
  line above the stage has no row to spare there, so it stands down.
- **The line** under the stage (in the Stations map, above it): *🌊 Flood
  levels:* ⏸ *Pause the rise* / ▶ *Play the rise*, the reading (*water 10.0 m
  on the gauge, 97.54 m AHD — past moderate*), every level as a button that
  holds the water there, and *Hide the water*.
- **The Scene panel's *Flood water*:** shown or not, animated or not, and a
  slider for the level — moving it holds the water where it is put.

Paused, the water stays where it was caught; a browser that asks for reduced
motion gets still water at the top until ▶ is pressed. While it rises the
scene is redrawn up to 30 times a second — it otherwise draws only when
something moves — and paused it draws nothing at all.

It is a simulation, not the site: **not in the `.glb`**. Editors and visitors
alike see it; the levels are the station card's, and those are public.

### A station with no levels, and a nearby one's

3,710 stations have no heights the twin can put on their ground, and many of
them are a few kilometres up or down a river from one that has. For those the
flood line says so and offers **Use a nearby station's levels…** (a pill on
the stage, where the scale would be, offers it too — on a phone's map it is
the only place that can — and so does the Scene panel's *Flood water*). The offer opens a dialog listing
the **four nearest stations that have levels**: each one's distance and
bearing, its flood heights (the classes on its gauge, the AEP levels in AHD)
and its catchment — the basin by name, the stream, and *same catchment* where
it shares one. **Use these** draws that station's levels here.

How the heights cross from there to here is the operator's choice, and the
dialog asks:

- **As heights on the gauge, laid over this station's channel** (the
  default). Each level becomes a height over the lowest ground by this gauge:
  a minor class of 3.0 m is water 3.0 m over this channel's bed. A class is
  already a gauge height; an AEP level is brought down to one through the
  other gauge's AHD zero, and left out — with a note — where it has none. The
  better guide across a river's fall, which on a creek is a metre a
  kilometre.
- **As the same heights in metres AHD** — the other station's own ladder,
  unchanged: right only a short way along the same reach.

A station whose own classes are on an assumed or a State datum — which the
twin cannot put on the ground — is offered **its own** first, as heights over
its own channel. Borrowed levels are drawn only in the twin and only for the
session; nothing is saved to the station. The notes, the flood line and the
Scene panel all say whose they are, how far off, and that they are a guide,
not a model — and **change** or **stop** is on the line.

## The Ground truth panel

Side by side: the station's recorded height (surveyed, or modelled with its
`elevation_source`), the ground at the pin from the model the scene stands on,
the difference, what Elvis says at the point and which dataset it read, the
relief in the patch, and the imagery. And the one thing worth knowing about
that difference, from `tools/elvis_station_elevations.py`'s audit of the
whole file: a recorded height well above the ground at the pin usually means
**the coordinate is the gauge down in the channel and the mark is the hut on
the bank** — a flag on the position, not a correction to the height.

## The renderer

three.js, ~750 KB of WebGL, fetched on the first visit to the tab and never
for a session that does not come here — MapLibre's terms in `map-3d.js`.
Unlike MapLibre it has no UMD build any more: r160 was the last, and it
prints a deprecation warning on every load. So it arrives by a dynamic
`import()` of the pinned ESM build (`three@0.185.1/build/three.module.min.js`,
the last release that ships a minified one) from inside the module. That is
the one place this app uses a module, and it is a call from inside a
function, not a change to what kind of page this is (#129): `index.html`
stays classic scripts in one global scope, and `npm run toplevel`, `names`
and `smoke` parse and run `digital-twin.js` as such. The build imports its
core by a relative path, so no import map is needed and file:// still works.

Under the test harness three is served from the `three` devDependency
(`test/lib/network.mjs`), so no check needs the network for it.

## Blender

The **⬇ Download .glb for Blender** button writes a glTF 2.0 binary — written
by the module itself rather than through three's `GLTFExporter`, which would
be a second module to fetch for a format this scene needs a twentieth of.
In it:

- every mesh, one node each, with its transform baked into the vertices: the
  ground (with normals and UVs), the pole and its band, the figure's parts;
- the imagery as an embedded JPEG on the ground's material;
- `asset.extras`: the station id, name and number; the origin's lat/lon, AHD
  height and datum; the ground's source, sample spacing and attribution; the
  imagery's source; the pole and figure dimensions; the exaggeration; when it
  was generated.

Metres, y up, origin on the ground at the pole. **Blender: File → Import →
glTF 2.0**, and it lands z-up (x east, y north, z up) with the imagery on the
ground. `tools/blender/import_twin.py` does the ten clicks after that — units,
a sun from the north, a camera framed on the pole, the header's coordinates
written onto the scene as custom properties, and optionally a render:

```sh
blender --background --python tools/blender/import_twin.py -- twin-loudoun_br_al-400m.glb --render twin.png
```

### Point clouds, later

The scene is built to take them: `three.Points` draws a cloud in the same
metres-from-the-pole frame the mesh is in, and the `.glb`'s header carries the
origin a LAS/LAZ file's coordinates have to be shifted by. Elvis is the
source: its point-cloud coverage is published as tiles
(`s3-ap-southeast-2.amazonaws.com/fsdf-elevation-tile-cache/POINT_CLOUD/{z}/{x}/{y}.png`,
the same cache `map-elvis-coverage.js` reads the DEM coverage from, and one
whose CORS allows only Elvis's own origin) and the data itself comes from a
download job. A LAZ decoder in the browser is a library decision the way
three.js was, and belongs to that issue.

## What the network has to allow

| Host | For | Notes |
|---|---|---|
| `spatial-img.information.qld.gov.au` | the ground, the imagery, the horizon's inner sheet and its imagery | ArcGIS ImageServers, CORS reflected; a new host for this app — `spatial-gis.information.qld.gov.au` (cadastre, contours, survey marks) is the one already allowed |
| `unpkg.com` | three.js, once a session | already allowed for Leaflet and MapLibre |
| `s3.amazonaws.com` | the ~30 m tiles, as a fallback and for the horizon's outer sheets | already allowed for every profile |
| `server.arcgisonline.com` | Esri imagery, as a fallback | already allowed for the Satellite base |
| `api-elevation.fsdf.org.au` | the height at the pin | already allowed for the station card |
| `spatial-gis.information.qld.gov.au` | where the bridges are (RoadsAndTracks layer 22, OtherTransport layer 160) | already allowed for the cadastre, contours and survey marks |
| `overpass-api.de`, `overpass.kumi.systems` | bridges outside Queensland, or when the State cannot be reached | already allowed for the rivers layer |

See `docs/floodwarning-net.md` for why a hostname the Bureau's filter has never
categorised is denied by default, and what to ask for.

## The check

`npm run twin` builds the world itself: the State's service is answered with
a tiled 32-bit-float GeoTIFF of a closed-form surface in the exact layout the
real one uses, so every vertex of the mesh is arithmetic — the half-sample
request box, the heights at the pixel centres, the pole's foot at the origin,
the figure's feet on the ground where it stands, the exaggeration scaling the
relief and nothing else, the station as built (which of the two the record
picks and why, the kit inside by telemetry, the plate, the pole's door
opening on approach and shutting on leaving; the tower's mast, rails, rungs
and cabinet, the ladder taken by walking into it, the deck at the top with
the door opening on its own, the toe boards holding, and the way down), the
room (what the twin sends, a visitor played in and drawn, walked, pointing,
gone; the pointer's own laser on the ground; the notes folded on a phone with
the stage keeping the room), the horizon (its innermost square the patch's edge
vertex for vertex, each far vertex on its sheet's height at its own latitude
and longitude read off the fixture the way `terrain.js` reads a tile, less
the Earth's curve, the lift at the edge fading out, the far shell drawn
first, the switch and what it saves, the tiles gone leaving the State's
sheet alone and a note), the `.glb`'s chunks and positions read back out of
the binary with the horizon left out, each fallback by breaking one host,
walk mode at eye height, and the renderer going with the tab. It needs WebGL2, which Playwright's Chromium
has through SwiftShader, and skips rather than fails without it.

`npm run twinsite` holds what the owner asked the site to be, on a valley
the check makes about whichever station is under test: the collector, the
staff gauge, both, and the red post measured off the scene's own bounding box
(and the pole and the tower where the record is sure); a neighbour 129 m off
built where it is, on its ground, named, and its name going to its twin; a
bridge across the creek at Gatton's listed crossing height and, for a station
with none, at its banks — and a road network that will not answer, said out
loud; the 10 cm drape round the station; a station with no levels offered the
four nearest with theirs, one chosen and drawn over the channel, and stopped;
the lines folding after the delay, waiting while the focus is in them, and
staying as pressed; and the offer at zoom 17, the hand-over only when pressed,
← Map at the same zoom, × until the next zoom in, and Zoom to station all the
way in. `npm run twinpin` moves a pin: on the twin's tab with no map (a real
pointer drags the post, a click puts it, Escape ends only the move, Save
writes the database's current copy with only the position changed and none of
its lists, and the twin rebuilds on the new spot), inside the Stations map's
twin, and in ⛰️ 3-D (the pin on the terrain, a click moved to MapLibre's own
coordinate for the pixel and not the flat map's, a real drag, cancel).

`npm run flood` holds the water. `flood-stages.js` first, under Node, against
real station records: the classes through the zero in force and only an AHD
one, the AEP row the card reads, the peaks, the colours and the one that never
goes back down, where 0 m is and why, and the cycle. Then the real Gatton
levels — minor 7, moderate 10, major 15 m on a zero of 87.54 m AHD, four AEP
levels from 102.69 to 103.75 m AHD — stood on a valley the check makes the
same way `twin` makes its ground: a channel with its bed at 89 m, a floodplain
at 98 m, a hollow 96 m deep inside a bank whose crest is 103 m, and rising
ground to the east. So where the water should be is arithmetic: below
moderate only the channel is wet, at major the floodplain is and the hollow is
not, past the bank's crest the hollow fills too. Every level is passed in
order in its colour on the slider; the rise is read against its own clock,
not the wall's — SwiftShader draws a handful of frames a second, so what is
asserted is that each frame puts the water where the cycle says for the
moment it was drawn; and the pause, the pill, hiding it, the Stations map's
line (and on a phone its pill), reduced motion, an assumed-datum zero, and
nothing of it in the `.glb`.
