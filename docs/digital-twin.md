# The Digital Twin tab

One station's patch of ground in three dimensions: the real relief under it
from the best public elevation model there is, the aerial imagery draped over
it, a **2 m × 300 mm pole** where the station stands and a **1.75 m figure**
beside it for scale. Orbit it, look straight down on it, or walk about in it
at eye height; click the ground for its height; and download the whole scene
as a `.glb` that Blender opens in one step.

It is `digital-twin.js`, the **Digital Twin** tab under *Stations & networks*,
and a 🧊 pill on the card of every station with a position. `npm run twin` holds it (see the end).

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

**The pole.** A cylinder 2.000 m tall and 0.300 m across, galvanised grey,
with a band in the station's role colour near the top so the thing on the
ground reads as the pin on the map. Its foot is on the ground at the origin.

**The figure.** 1.75 m, hi-vis and a hard hat, built from primitives (a model
is a file to fetch and a licence to carry; a capsule in orange gives a sense
of scale as well as a mesh of a face), a metre east of the pole with its feet
on the ground *there* — not at the pole's height.

**Vertical exaggeration** (1–3×) scales the relief and nothing else. The pole
and the figure are the ruler at every setting.

**Light.** A sun from the north, high, casting a short shadow the eye reads
as "standing on the ground". The sky is `--twin-sky`, a token, so the scene
sits in its panel in either theme.

**The camera.**

| Mode | Pointer | Keys |
|---|---|---|
| Orbit (default) | drag to orbit; wheel to zoom; right-drag, Shift-drag or two fingers to pan; pinch to zoom | arrows orbit; `+`/`−` zoom; `W A S D` pan; `R` reset; `T` top-down; `F` walk; inside the Stations map, a wheel out past the edge or `Esc` hands back to the map |
| Walk | drag to look; wheel to step | `W A S D` / arrows move at 1.6 m/s, Shift hurries; `Q`/`E` turn; `Esc` back to orbit |

The walker's eye is 1.70 m above the ground under it, and the orbit camera
is never let under the hill between it and the pole. A compass rose over the
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
the moment a pin has become a place — with a station under the view, the
map's rectangle hands over to that station's twin, whichever view was
showing: the 2-D map or ⛰️ 3-D (whose camera follows the 2-D map's zoom, so
both paths arrive the same way). Wheeling out past the twin's widest orbit,
pressing Escape, or **← Map** on the overlay hands back, with the map set one
level out — where the operator was heading.

"A station under the view" is, in order: the station on the card (the map's
memory of what you were looking at), the selected station, or the nearest
station to the map's centre — each only if it is within half a patch of the
centre, so a twin is never built for a pin off the edge of the screen. From
zoom 14 a station under the view has its ground and imagery fetched ahead
into the same bounded caches the tab uses, so the hand-over at 17 is a build
from memory rather than a wait. The switch is in 🗺️ Map display, on by
default and remembered.

⛰️ 3-D and the twin are one idea at two scales, and neither replaces the
other: a map camera cannot be put at eye height, and a site twin cannot show
a 60 km hop. The 3-D view is the network on its terrain — every pin and link,
the line-of-sight sheets — and the twin is the site. Zoom is the one thing
that already says which question is being asked, so zoom is the hand-over.

The overlay is a child of the Leaflet container, above the 3-D canvas and
below the control corners (`#map-twin`, one step above `#map3d`'s window in
`styles.css`); Leaflet's own drag and wheel are held off under it, for
`map-3d.js`'s reason, and the station card stays above both. The twin's scene,
controls and teardown are `digital-twin.js`'s; `map-twin.js` decides *when*
and gives it a host. **Open the tab →** on the overlay opens the Digital Twin
tab on the same station, for the settings, the Ground truth panel and the
`.glb`.

## The radio paths

What joins the station to the rest of the network is drawn from its antenna
as rays, each named at its end with the far station, the distance and the
bearing. Two sources, and the first is the one that matters:

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
| `spatial-img.information.qld.gov.au` | the ground and the imagery | ArcGIS ImageServers, CORS reflected; a new host for this app — `spatial-gis.information.qld.gov.au` (cadastre, contours, survey marks) is the one already allowed |
| `unpkg.com` | three.js, once a session | already allowed for Leaflet and MapLibre |
| `s3.amazonaws.com` | the ~30 m tiles, as a fallback | already allowed for every profile |
| `server.arcgisonline.com` | Esri imagery, as a fallback | already allowed for the Satellite base |
| `api-elevation.fsdf.org.au` | the height at the pin | already allowed for the station card |

See `docs/floodwarning-net.md` for why a hostname the Bureau's filter has never
categorised is denied by default, and what to ask for.

## The check

`npm run twin` builds the world itself: the State's service is answered with
a tiled 32-bit-float GeoTIFF of a closed-form surface in the exact layout the
real one uses, so every vertex of the mesh is arithmetic — the half-sample
request box, the heights at the pixel centres, the pole's foot at the origin,
the figure's feet on the ground where it stands, the exaggeration scaling the
relief and nothing else, the `.glb`'s chunks and positions read back out of
the binary, each fallback by breaking one host, walk mode at eye height, and
the renderer going with the tab. It needs WebGL2, which Playwright's Chromium
has through SwiftShader, and skips rather than fails without it.
