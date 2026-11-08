# Trees and buildings round the stations — which open data to use

Issue #277 asks for the trees and buildings that stand round our stations to
be drawn in the ⛰️ 3-D view (`map-3d.js`, MapLibre GL JS 6 on draped terrain)
and then in the digital twin (`digital-twin.js`, three.js) — where each one
stands, and how tall. This page is the research for that: which **open** data
says so in Queensland and in the part of New South Wales the network reaches,
how good it is at our own stations, under what licence, and how a browser can
get at it. Paid data is out (the owner's decision), so the State's paid LiDAR
surface products and Geoscape are noted only to say why they are not used.

Everything below was fetched and measured on **8 November 2026**, not read off
web pages: tiles were opened, pixels read, features counted, and every
service was asked with an `Origin` header to see whether a web page would be
allowed to read the answer.

## The short answer

| | Use | How the browser gets it |
|---|---|---|
| **Tree heights** | **Meta / WRI Canopy Height Maps, version 2** — a height for every 1.2 m square of ground, worldwide, made by a machine-learning model from satellite photos | **Through a small Flood-Net Worker route** that passes the requests on to Meta's files and back. A web page cannot read Meta's files itself (their store refuses cross-site reads), and they are far too big to copy whole (390 GB for Queensland and New South Wales). |
| **Building outlines and heights in Queensland** | **The State's generated building outlines** — drawn from the State's own LiDAR (laser survey from aircraft), with the roof and ground heights measured | **A copy kept for us in R2 as one vector-tile file** for the 3-D view, rebuilt when the State adds survey areas. The twin can ask the State's service directly. |
| **Buildings everywhere else** (Queensland outside the surveyed towns, and New South Wales) | **Overture Maps buildings** — OpenStreetMap's outlines plus Microsoft's machine-drawn ones, with heights where either has one | **Directly from Overture's own tile file**, which allows cross-site reads. |

The State's outlines and Overture's are kept as **two separate layers**, never
merged into one file — that keeps the State's data under its own simple
licence and keeps the share-alike terms of Overture's licence off anything we
make (see *What needs the owner's say*).

Two plain-words notes for everything that follows:

- **Canopy height** is how high the top of the trees is above the ground,
  in metres. It is not the ground's height; a canopy height of 0 is open
  ground, a road or a roof.
- **Cross-site read** (CORS): a web page on `floodwarning.net` can only read a
  file from another website if that website says so in its reply. Where a
  source does not, the browser refuses — however public the file is.

## The stations we checked

Twenty-two stations, spread over the network: the coast, the ranges, the
inland, the far north and far west, four repeaters, a base station and three
stations in New South Wales. A second, random sample of **150 Queensland field
stations** was used for the building coverage figures.

| Station | Where | Role |
|---|---|---|
| Stewart River TM | Cape York, river in savanna woodland | field |
| Saddle Mtn AL | range behind Cairns, rainforest hilltop | repeater |
| Cairns | coast, city centre | field |
| Atherton Solar Crescent | Atherton Tableland town | field |
| Innisfail Wharf AL | wet-tropics coast town | field |
| Castle Hill AL | hill in Townsville | field, repeater |
| Mount Isa Mine | inland north-west | field |
| Mackay AL | coast city | field |
| Longreach TM | central west, out of town | field |
| Rockhampton Tm | coast city | field |
| Emerald Radar AL | central highlands | field, repeater |
| Maryborough St AL | Bundaberg | field |
| Murweh Shire Base Station | Charleville | base |
| Gympie AL | inland town | field |
| Brisbane Port Office AL | Brisbane city | field |
| Toowoomba AL | top of the range | field, repeater |
| Beechmont (DNRM) TM | Gold Coast hinterland ridge | field |
| Goondiwindi | border town | field |
| Armidale-Stephens Bridge | NSW tablelands | field |
| Bellingen (Bellinger River) | NSW coast valley | field |
| Bathurst Stanley Street | NSW central west | field |
| Birdsville Police Station | far west | field |

---

## Trees

### What each source says at our stations

Read off the real files. "At the mast" is the pixel the station stands on.
"Tallest nearby" is the 95th percentile within 100 m — the height most of the
taller trees round the station reach, without one odd pixel deciding it.
"Under trees" is the share of the ground within 100 m that is covered by
canopy taller than 5 m.

| Station | Meta v2: at the mast | Meta v2: tallest nearby | Meta v2: under trees | ETH 2020: at the mast | ETH 2020: tallest nearby | ETH 2020: under trees |
|---|---|---|---|---|---|---|
| Stewart River TM | 0 m | 5 m | 3% | 18 m | 18 m | 100% |
| Saddle Mtn AL | 13 m | 19 m | 98% | 26 m | 32 m | 100% |
| Cairns | 0 m | 4 m | 4% | 7 m | 15 m | 73% |
| Atherton Solar Crescent | 3 m | 5 m | 4% | no reading | 14 m | 61% |
| Innisfail Wharf AL | 0 m | 3 m | 4% | no reading | 16 m | 14% |
| Castle Hill AL | 0 m | 14 m | 31% | no reading | 23 m | 76% |
| Mount Isa Mine | 0 m | 4 m | 3% | 0 m | 4 m | 4% |
| Mackay AL | 1 m | 3 m | 4% | no reading | 18 m | 8% |
| Longreach TM | 0 m | 5 m | 4% | 0 m | 4 m | 2% |
| Rockhampton Tm | 10 m | 13 m | 15% | 19 m | 20 m | 8% |
| Emerald Radar AL | 0 m | 5 m | 4% | 1 m | 4 m | 3% |
| Maryborough St AL | 11 m | 11 m | 13% | 17 m | 18 m | 26% |
| Murweh Shire Base Station | 0 m | 11 m | 10% | no reading | 14 m | 10% |
| Gympie AL | 0 m | 15 m | 12% | 13 m | 22 m | 42% |
| Brisbane Port Office AL | 0 m | 8 m | 6% | no reading | 25 m | 24% |
| Toowoomba AL | 0 m | 16 m | 19% | 7 m | 23 m | 52% |
| Beechmont (DNRM) TM | 0 m | 17 m | 18% | 19 m | 24 m | 91% |
| Goondiwindi | 0 m | 17 m | 38% | 19 m | 20 m | 80% |
| Armidale-Stephens Bridge | 0 m | 6 m | 5% | 11 m | 14 m | 49% |
| Bellingen (Bellinger River) | 12 m | 17 m | 30% | 19 m | 21 m | 59% |
| Bathurst Stanley Street | 0 m | 9 m | 8% | 12 m | 15 m | 76% |
| Birdsville Police Station | 0 m | 0 m | 0% | 0 m | 0 m | 0% |

Both cover every station. They disagree a great deal, and the aerial photos
side by side with both maps (Stewart River, Cairns, Toowoomba, Goondiwindi)
show why:

- **Meta's map draws the trees where they stand** — single crowns, street
  trees along a road, the line of trees on a river bank. Laid over the photo
  of Cairns it picks out the rows of street trees; the racecourse, the roofs
  and the car parks read 0.
- **ETH's map is soft.** At 10 m a pixel holds a crown and the ground round
  it, and the model spreads canopy across whole blocks: over the same Cairns
  racecourse and roofs it reads 7–15 m, and it calls 73% of the ground there
  "under trees" where the photo shows a handful of trees. It also has no
  reading at all for several town pixels.
- **Where they part the other way** is open savanna woodland. At Stewart
  River the photo shows scattered trees across the slope and a dense band
  along the river; Meta reads most of the slope at 1–5 m, ETH reads 18 m
  everywhere. The truth is likely between the two. Neither map was checked
  against a LiDAR survey of trees here (no open one could be had — see
  *LiDAR surface models* below), so treat both as estimates, Meta's as the
  better-placed one.

### Meta / WRI Canopy Height Maps, version 2 — recommended

| | |
|---|---|
| What it is | A canopy height in whole metres for every 1.19 m square of ground, worldwide, from a machine-learning model (DINOv3) run over Vantor (formerly Maxar) satellite photos. Version 2 was released in 2026 and replaces version 1 (2024). |
| Coverage at our stations | **22 of 22.** Every station's tile exists and holds readings. |
| Licence and attribution | **CC BY 4.0** (AWS Open Data registry entry). Credit: *Meta and World Resources Institute (WRI) — 2026. Version 2 High Resolution Canopy Height Maps (CHMv2). Source imagery © Vantor.* |
| How a browser gets it | Files on Amazon S3 (`dataforgood-fb-data`, `forests/v2/global/dinov3_global_chm_v2_ml3/chm/<quadkey>.tif`, one per zoom-10 map square, about 35 km across). They are **cloud-optimised GeoTIFFs**: a reader can ask for just the bytes covering a small area (range requests work, 206 answers). But **the bucket refuses cross-site reads** — a GET carries no `Access-Control-Allow-Origin` and a preflight answers *"CORS is not enabled for this bucket."* So a page on `floodwarning.net` cannot read them directly. Inside, each file is 512 × 512 blocks packed with plain deflate, which a browser can unpack with its own built-in `DecompressionStream` — no library needed. |
| Size | 128 MB per file on average; **3,050 files and 390 GB** over the Queensland–New South Wales box. A 2 km × 2 km patch round one station is **0.1–0.7 MB** (measured: Birdsville 0.08 MB, Brisbane 0.22, Goondiwindi 0.31, Saddle Mtn 0.71) — about 2 GB for every station in the network. Each file carries smaller overview copies (2.4 m, 4.8 m, 9.6 m … 76 m), so one source serves a close look and a wide view. |
| A coarser copy | Meta also publish a 9.55 m "mean height" version (`…_10m_mean/`, 66 files and 11.6 GB over the same box, packed with zstd, which a browser cannot unpack without a library). The 1 m files' own overviews do the same job, so this one is not needed. |
| Date | The photos behind it date from **2010 to 2020** at our stations (mostly 2016–2020; each tile has a list of photo dates in `metadata/<quadkey>.geojson`). Trees cleared or grown since then are not in it. |
| Verdict | **Use it for tree heights.** Best placed, finest detail, open licence, covers everything. Its one obstacle is the cross-site refusal, which a pass-through on our own Worker removes. |

Version 1 (`forests/v1/alsgedi_global_v6_float/`) is still in the bucket but
is not worth using: its files are 65,536 pixels wide in single strips with no
overviews, so even a small area means reading a large part of the file.

### ETH Global Canopy Height 2020 (10 m)

| | |
|---|---|
| What it is | A canopy height for every 10 m square, worldwide, for 2020 (ETH Zürich, Lang et al.), from Sentinel-2 satellite photos and NASA's GEDI space laser. Served by Esri as a tiled image layer. |
| Coverage at our stations | **22 of 22 tiles**, but no reading on the station's own pixel at 6 town stations (Atherton, Innisfail, Castle Hill, Mackay, Charleville, Brisbane). |
| Licence and attribution | **CC BY 4.0** (Esri's item for the layer). Credit as `land-cover.js` already gives it: *Esri Global Canopy Height 2020 (ETH Zürich, Lang et al., 10 m, ±5 m).* |
| How a browser gets it | `tiledimageservices.arcgis.com/…/10m_Tree_Canopy_Height/ImageServer/tile/{level}/{row}/{col}` — 256-pixel tiles in Esri's LERC packing, **cross-site reads allowed** (`*`). Tiles only — no "what is the height here" query. `land-cover.js` already reads it for the path profile. |
| Size | 7–20 KB per tile at ~9 m pixels. |
| Date | 2020. |
| Verdict | **A fallback, not the source to draw from.** It works today with no Worker, which is its whole advantage. It overstates tree cover round towns and over open country, and a 10 m square is too coarse to stand a single tree on. |

### Queensland's woody vegetation (SLATS) and foliage cover

| | |
|---|---|
| What it is | The State's map of where woody vegetation stands (2024 is the latest), from Sentinel-2: patches over 0.5 ha with more than 10% crown cover, at least 20 m wide. The State also publishes *foliage projective cover* (the share of ground under leaves, 2023 latest) as a download. |
| Coverage | All of Queensland. Answered at Stewart River, Cairns and Toowoomba. None for New South Wales. |
| Licence | Not checked for these layers. |
| How a browser gets it | `spatial-gis.information.qld.gov.au/…/Environment/SLATS/MapServer/256` — an ArcGIS query service, cross-site reads allowed, answers in GeoJSON or compact PBF. Foliage cover: a QSpatial download only; no web service found on the State's public servers. |
| Verdict | **No heights**, so not a source for #277. Says *whether* there are trees, not how tall, and only for patches big enough to map at 1:10,000. |

### LiDAR surface models — through Elvis and from the State

The best tree and roof heights would come from LiDAR: a **surface model**
(the top of whatever is there — trees, roofs) minus the **ground model** (bare
earth). This was checked carefully, because the State and Elvis
(`elevation.fsdf.org.au`) hold a great deal of LiDAR:

- **The State's public raster services hold ground models only.** Its
  `Elevation/DEM_TimeSeries_AllUsers` catalogue lists 531 ground models, 3
  sea-floor models, one SRTM layer — and **one** surface model, a 20 m one
  from 2006 over the Cyclone Larry area (Innisfail–Cardwell). It has a ready
  "canopy height" colour scheme, but no canopy height layers are published
  in it.
- **The State sells its surface, height and canopy models.** Its own
  support page lists *DSM (surface model)*, *DHM (height model)* and *CHM
  (canopy height model)* as COG GeoTIFFs at "see fees". Point clouds and
  ground models **more than three years old** are free through Elvis; newer
  ones are sold. Paid data is out, so these are not used.
- **Elvis hands out files, not answers.** Free point clouds and ground
  models are ordered by drawing an area, and the download link arrives by
  email. The coverage layers it publishes are for ground models and point
  clouds; no surface-model layer was found. Its index of downloads now answers *401 Unauthorized*
  to a request that is not signed in, so which areas hold a surface model
  could not be listed from here.
- **New South Wales** publishes ground models (bare earth) and point clouds
  through Elvis; no open surface model was found.

So **"surface minus ground" cannot be fetched** by a browser anywhere in our
network. It could be *made*: the free point clouds (three years old or more)
could be ordered and turned into canopy heights offline. That is a large
job — hundreds of gigabytes of point cloud for the surveyed towns — and for
buildings the State has already done the equivalent (next section).

### Sentinel-2 10 m land cover (already in the app)

| | |
|---|---|
| What it is | Impact Observatory / Microsoft / Esri's map of what covers the ground — water, trees, crops, built area, rangeland and so on — one class per 10 m square, one map a year **2017–2025**. `land-cover.js` reads it for the path profile. |
| Licence | Source data **CC BY 4.0**; Esri's layer under Esri's terms. |
| How a browser gets it | `ic.imagery1.arcgis.com/…/Sentinel2_10m_LandCover/ImageServer`, cross-site reads allowed. |
| Verdict | **No heights** — it says "Trees", not how tall; `land-cover.js` gives each class a stand-in height (Trees 15 m). Useful in the 3-D view only to colour the ground, or to say where the canopy map's zeros are water. |

---

## Buildings

### What each source says at our stations

Counted in a 600 m × 600 m square centred on each station (300 m each way).
"With height" counts buildings that carry a height of any kind (for
OpenStreetMap, a `height` or `building:levels` tag). The State's heights are
the median height of the roof's highest point above the ground at the
building's centre.

| Station | State LiDAR outlines | Median height (State) | Survey | OpenStreetMap: buildings / with height or levels | Microsoft: buildings / with height | Overture: buildings / with height |
|---|---|---|---|---|---|---|
| Stewart River TM | 0 | — | — | 0 / 0 | 0 / 0 | 0 / 0 |
| Saddle Mtn AL | 4 | 6.3 m | 2024 | 4 / 0 | 0 / 0 | 4 / 0 |
| Cairns | 363 | 5.8 m | 2023–24 | 132 / 0 | 110 / 92 | 183 / 115 |
| Atherton Solar Crescent | 318 | 4.9 m | 2023 | 233 / 0 | 208 / 130 | 233 / 84 |
| Innisfail Wharf AL | 142 | 7.9 m | 2023 | 154 / 2 | 69 / 39 | 209 / 25 |
| Castle Hill AL | 11 | 3.9 m | 2025 | 11 / 0 | 1 / 0 | 11 / 0 |
| Mount Isa Mine | 0 (not surveyed) | — | — | 2 / 0 | 25 / 25 | 38 / 35 |
| Mackay AL | 146 | 8.0 m | 2023 | 53 / 9 | 55 / 53 | 69 / 36 |
| Longreach TM | 0 | — | — | 0 / 0 | 0 / 0 | 0 / 0 |
| Rockhampton Tm | 134 | 9.6 m | 2023 | 44 / 3 | 39 / 35 | 72 / 33 |
| Emerald Radar AL | 0 (not surveyed) | — | — | 0 / 0 | 1 / 1 | 1 / 1 |
| Maryborough St AL | 244 | 6.4 m | 2023 | 426 / 1 | 161 / 122 | 408 / 92 |
| Murweh Shire Base Station | 247 | 5.6 m | 2023 | 68 / 14 | 161 / 161 | 173 / 142 |
| Gympie AL | 137 | 6.4 m | 2023 | 115 / 1 | 91 / 91 | 111 / 27 |
| Brisbane Port Office AL | 80 | 26.3 m (tallest 270 m) | 2025 | 86 / 65 | 30 / 27 | 96 / 31 |
| Toowoomba AL | 21 | 5.7 m | 2023 | 24 / 10 | 15 / 11 | 29 / 6 |
| Beechmont (DNRM) TM | 53 | 4.2 m | 2023 | 4 / 0 | 35 / 35 | 36 / 31 |
| Goondiwindi | 95 | 5.4 m | 2023 | 52 / 0 | 77 / 77 | 76 / 71 |
| Armidale-Stephens Bridge | — (NSW) | — | — | 279 / 167 | 172 / 172 | 264 / 86 |
| Bellingen (Bellinger River) | — (NSW) | — | — | 187 / 30 | 166 / 166 | 237 / 137 |
| Bathurst Stanley Street | — (NSW) | — | — | 113 / 0 | 138 / 138 | 258 / 114 |
| Birdsville Police Station | 79 | 4.7 m | 2025 | 76 / 3 | 57 / 56 | 89 / 10 |

(Emerald Radar's one Microsoft/Overture "building" is 0.3 m tall — a slab
or a mistake.)

**Coverage across the network.** Of the 150 randomly chosen Queensland
stations, **117** have at least one building within the 600 m square by one
source or the other:

- the **State's LiDAR outlines cover 72 of them (62%)** — the towns and
  regions the State has flown and processed;
- **Overture covers 115 (98%)**; the State's layer had buildings where
  Overture had none at only 2;
- where both have buildings, the State's layer finds **about 30% more**
  (6,769 against 5,223) — it picks up sheds, carports and anything else of
  10 m² or more that the laser saw;
- **64%** of Overture's buildings there carry a height.

**How good the heights are.** The State's heights are measured, so they were
used as the yardstick. In 12 Queensland towns, every Microsoft or Overture
building whose centre fell inside a State outline was compared:

| Source | Buildings compared | Against the roof's highest point | Against the eaves (the roof's edge) |
|---|---|---|---|
| Microsoft's estimates | 831 | 2.7 m low (median) | right on average, typically 1.1 m out; 76% within 2 m |
| Overture's heights (from OpenStreetMap or Microsoft) | 544 | 2.3 m low (median) | within half a metre on average, typically 0.9–1.0 m out; 80% within 2 m |

So the estimated heights behave like **eave height**: good enough to draw a
flat-topped box of the right size, but a house drawn from them is about a
storey's roof short of its ridge. The State's layer gives both the eave and
the top.

### Queensland's generated building outlines (LiDAR) — recommended for Queensland

| | |
|---|---|
| What it is | Building outlines the State drew automatically from its LiDAR surveys (the points the survey classed as *building*), made for the Queensland Reconstruction Authority's damage assessments. Every outline of 10 m² or more, squared off. Each carries **four measured heights in metres AHD**: `bsm_max` (the highest point of the roof), `bsm_edge` (the average along the outline — the eaves), `bsm_min`, and `dtm_centre` (the ground at the building's centre). **Height above ground = `bsm_max − dtm_centre`**; eave height = `bsm_edge − dtm_centre`. |
| Coverage | **3,068,649 current outlines** in 119 survey areas (another 475,000 kept as "Superseded" where a newer survey replaced them — filter on `status = 'Current'`). The big cities and their regions, Toowoomba, the Wide Bay, Cairns to Innisfail, Townsville, Mackay, Rockhampton, Gladstone, and a long list of western and inland towns (Charleville, Longreach, Birdsville, Goondiwindi, St George, Blackall …). **Not** state-wide: no Mount Isa or Emerald, for instance. At our sample stations: 15 of the 16 Queensland stations with buildings near them. |
| Licence and attribution | **CC BY 4.0.** Credit as the State asks: *© The State of Queensland 2025* (Department of Natural Resources and Mines, Manufacturing and Regional and Rural Development). |
| How a browser gets it | `spatial-gis.information.qld.gov.au/arcgis/rest/services/Structure/BuildingsAndSettlements/MapServer/11/query` — an ArcGIS query service. **Cross-site reads allowed** (it echoes back whatever site asks, including `null` for a page opened from a file). Answers in JSON, GeoJSON or compact PBF, up to **4,000 outlines per request**. A 600 m square in a town held 20–360 outlines; a twin's 1.6 km patch in the densest town sampled (Cairns) would hold roughly 2,500 — still one request. It is a query service, not map tiles: the 3-D view would have to send a new query for every pan and zoom. The whole dataset is a single download (Geodatabase or Shapefile) from QSpatial. |
| Size | About 9 corners per outline. As one vector-tile file for the whole State, an estimated **few hundred MB** (not built and measured). |
| Date | Survey years **2021–2025** (2023–2025 at our sample stations). The State adds survey areas as new LiDAR is flown; outlines are not edited between surveys. |
| Known limits (the State's own notes) | Depends on how well the survey classed its points: a shade cloth can come out as a building, and dark roofs return the laser poorly and can be missed or mis-shaped. Outlines are squared off, so curved or complex buildings are rough. Buildings close together can merge. |
| Verdict | **Use it wherever it covers.** The only open source with measured heights, the only one that tells the eaves from the top, and it finds more of the small buildings near a station than any other. |

The same State service also has two hand-drawn topographic layers —
*Building areas* (large buildings over 625 m², with fields for eave and roof
height) and *Building points* (small buildings as dots). At our stations the
height fields were empty on every one, so they add nothing here.

### OpenStreetMap

| | |
|---|---|
| What it is | The volunteer-made world map. Buildings are outlines, sometimes tagged with `height` or `building:levels` (storeys). |
| Coverage | Good in most towns at our stations (often hand-traced from imagery); thin or absent out of town. **Heights are rare**: near our 19 Queensland stations, 22 of 1,484 buildings have a height (all in Brisbane's centre) and 106 have a storey count; 108 have one or the other. Out of the big towns, 0 of 217 had a height. Armidale is the exception, with storeys on 167 of 279. |
| Licence and attribution | **ODbL** (share-alike — see below). *© OpenStreetMap contributors.* |
| How a browser gets it | Through Overpass (the app already asks `overpass-api.de` and `overpass.kumi.systems` for bridges). During this check both reset or timed out from here, so the counts above came from the main OpenStreetMap server instead, which is not for use by an app. Overture (below) carries the same outlines as ready-made tiles. |
| Verdict | **Use it through Overture**, not on its own. |

### Microsoft Global ML Building Footprints

| | |
|---|---|
| What it is | Building outlines drawn by a machine-learning model from Bing Maps imagery (2014–2024), with a model-estimated height and a confidence score on each. Australia's 5 million were added in July 2023. |
| Coverage | Wide: it has buildings where OpenStreetMap has none (Mount Isa Mine 25, Beechmont 35, Charleville 161). Most outlines carry a height (84% near our Queensland stations, all of them near the New South Wales ones). Missed Saddle Mtn's four buildings and most of Castle Hill's. |
| Licence and attribution | **CDLA Permissive 2.0** by its own README today; Overture's attribution page still lists it under ODbL. Either way, used through Overture it comes under Overture's terms. |
| How a browser gets it | Gzipped files of one building per line (GeoJSON), one file per zoom-9 map square, listed in `dataset-links.csv` (latest index 13 Aug 2026). 1,776 files and 1.07 GB for Australia, up to 68 MB for one square (Brisbane). **No cross-site reads** (no `Access-Control-Allow-Origin`; a preflight answers 405). Not something a browser can use. |
| Heights | About eave height, as measured above; on its own, 2.7 m short of the roof's top. |
| Verdict | **Use it through Overture**, which already merges it in. |

### Overture Maps buildings — recommended for everywhere the State's outlines do not reach

| | |
|---|---|
| What it is | The Overture Maps Foundation's monthly building layer: OpenStreetMap's outlines first, Microsoft's where OpenStreetMap has none, plus a few from Esri's Community Maps. Each building has `height` and `num_floors` where a source gave one, and says where its outline and its height came from (`@geometry_source`, `@height_source`). |
| Coverage | **The widest of all**: 98% of the random sample's stations with buildings nearby, every New South Wales station in the sample, and Mount Isa. In the towns sampled, about two-thirds of buildings carry a height. |
| Licence and attribution | **ODbL** for the buildings theme. Credit: *© OpenStreetMap contributors, Overture Maps Foundation.* |
| How a browser gets it | **One file of vector tiles** for the whole world, `https://tiles.overturemaps.org/<release>/buildings.pmtiles` (PMTiles format, zoom 5–14, layers `building` and `building_part`). **Cross-site reads allowed** (`*`), and a reader fetches only the bytes of the tiles it needs: our 22 stations took about 7 small requests and 200 KB each. MapLibre reads PMTiles with the small `pmtiles` add-on; buildings are drawn with MapLibre's *fill-extrusion* layer from the `height` field. Two cautions: a **preflight** request is refused (403), so the reader must send plain single-range requests, which browsers allow without one — worth confirming in a browser before building on it; and **old releases are deleted after about two months** (July and August 2026 now answer 410 Gone). The current release's name is in Overture's catalogue, `https://stac.overturemaps.org/catalog.json` (marked `"latest": true`; cross-site reads allowed), so the app should look it up rather than keep a fixed address. |
| Size | 181 GB worldwide, but a browser only ever reads a few hundred KB. |
| Date | Monthly; release **2026-10-21.0** was read (OpenStreetMap as of 6 Sep 2026, Microsoft as of 11 Aug 2026). |
| Heights | About eave height, as measured above. |
| Verdict | **Use it outside the State's survey areas, and for New South Wales.** No copy needed. |

### New South Wales

New South Wales has no open building outlines of its own: the State's building
and tree layers are Geoscape's, bought for government use only and not
published. Overture is the source there.

### Not used

- **Geoscape Buildings** (heights, roof types, tree heights): paid.
- **The State's surface, height and canopy models**: paid (see *LiDAR surface
  models*).
- **Google Open Buildings**: none of it appeared in Overture's source list at
  any station sampled.

---

## Recommendation

### Tree heights: Meta / WRI version 2, through a Flood-Net Worker route

**Why this source.** It is the only open map that places single trees, it
covers every station, and its licence asks only for credit.

**Why not directly from the source.** Meta's bucket refuses cross-site reads,
so a page on `floodwarning.net` cannot read it however it asks.

**Why not a copy in R2.** A full copy is out of the question: 390 GB for
Queensland and New South Wales at full detail, 11.6 GB even at Meta's 10 m
version — more than the account's free 10 GB, which the photos and the daily
archive already share. A copy of just a 2 km square round each station
(about 2 GB) would serve the twin but not the 3-D view, which can be moved
anywhere.

**So: a pass-through.** One Worker route, for example
`/api/canopy/<quadkey>.tif`, that accepts only a 10-digit quadkey (digits 0–3),
fetches the same file from Meta's bucket with the browser's `Range` header,
and hands the bytes back with a cross-site header. It reads one fixed host and
one fixed folder, changes nothing, and stores nothing. It has two further
merits:

- **The Bureau's web filter** denies hostnames it has never classified
  (`docs/floodwarning-net.md`). Served from `floodwarning.net`, the canopy
  needs no new hostname allowed on a Bureau machine.
- **Meta has moved these files once** (version 1 to version 2 changed every
  path). With a pass-through, a move is one line on the Worker, not a change
  to the app.

How each view uses it:

- **The twin** reads the 1 m file round its 1.6 km patch — a few requests,
  about a megabyte or less — unpacks the blocks with the browser's own deflate, and stands a
  tree on each local high point of the canopy, as tall as the map says.
- **The 3-D view**, zoomed in, does the same for what is on screen; zoomed
  out, it reads the file's coarser overviews (9.6 m and up) for a canopy
  tint or nothing at all — single trees cannot be seen at that scale anyway.

**When to make a copy after all.** If the pass-through proves slow, or the
twin must work offline in the field, cut the 2 km square round each station
into R2 (about 2 GB) and read those first.

`land-cover.js` reads ETH's 10 m map for the path profile today. Meta's map
would place trees on a path better too, but that is a separate change and not
part of #277.

### Buildings: the State's LiDAR outlines in Queensland, Overture everywhere else

**Queensland, where the State has surveyed — a copy in R2.** Download the
whole dataset from QSpatial (one Geodatabase), keep only `status = 'Current'`,
and turn it into one PMTiles vector-tile file in the R2 bucket, carrying for
each outline its height above ground (`bsm_max − dtm_centre`), its eave
height (`bsm_edge − dtm_centre`), the survey and the year. Alongside it, a
small file of the 119 survey areas' outlines.
*Why a copy:* the State's service answers queries, not map tiles, so the 3-D
view would send a fresh query for every move and wait on the State's server
each time; a tile file in R2 is read the way the map already reads its other
layers, and is a few hundred MB. *Why it stays current:* the State only adds
survey areas, a few times a year; rebuilding the file then is enough.
**The twin** can skip the copy and ask the State's service for its one patch
(one request, cross-site reads allowed), or read the same R2 file — either
works; one code path for both is simpler.

**Everywhere else — Overture, directly.** Outside the survey areas, and in
New South Wales, read Overture's buildings file straight from
`tiles.overturemaps.org`, finding the current release from Overture's
catalogue each time. *Why not a copy:* it is open to cross-site reads, a
browser reads only a few hundred KB of it, and a copy would put Overture's
share-alike terms on our file.

**Keep the two apart.** Draw Overture's buildings only outside the State's
survey areas (that is what the survey-areas file is for), so the same house is
never drawn twice. A building with no height should be drawn at a stated
default (one storey, about 3.5 m) and the panel should say how many are
guessed, the way the app already says when ground is guessed.

### Attribution the views will need

- *Canopy height: Meta and World Resources Institute (WRI), CHMv2, 2026 —
  source imagery © Vantor (CC BY 4.0).*
- *Buildings (Queensland): © The State of Queensland 2025 — generated
  building outlines (CC BY 4.0).*
- *Buildings (elsewhere): © OpenStreetMap contributors, Overture Maps
  Foundation (ODbL).*

## What needs the owner's say

1. **ODbL's share-alike terms (Overture and OpenStreetMap).** Reading
   Overture's file directly and drawing it needs only the credit line. But
   if we ever **keep a copy** of their buildings (an extract in R2) or
   **merge** them with the State's outlines into one file, that file counts
   as a *derivative database* under ODbL: it must itself be offered to
   anyone under ODbL, and a merged file would pull the State's outlines in
   with it. The plan above avoids this by never copying or merging Overture.
   If a copy is wanted later (offline use, or Overture's monthly deletions
   become a nuisance), it is the owner's call whether Flood-Net publishes
   that copy under ODbL.
2. **A new Worker route that reaches a third-party host** (Meta's bucket on
   Amazon S3) on every visitor's behalf. It is read-only and fixed to one
   folder, like the cameras route, but it is a new outside dependency on the
   Worker.
3. **R2 space.** The account's free 10 GB is shared with the field photos and
   the daily archive. The State's buildings file (a few hundred MB) fits; a
   later per-station canopy copy (about 2 GB) probably does; anything bigger
   starts costing about US$0.015 per GB a month.
4. **The State's paid LiDAR products** (surface, height and canopy models for
   surveys under three years old) would be better than any of this, and are
   excluded only by the no-paid-data rule. Nothing to decide unless that rule
   changes.

## What could not be checked

- **Tree heights against a laser survey.** No open LiDAR canopy or surface
  model could be fetched anywhere in the network, so Meta's and ETH's tree
  heights were compared with each other and with aerial photos, not with a
  measurement.
- **Elvis's list of downloads** now needs a sign-in (it answered 401), so
  which areas hold a surface model in Elvis could not be listed; the State's
  own page says its surface models are paid.
- **Overpass** reset or timed out from this session on both endpoints the
  app uses, so OpenStreetMap was counted through the main OpenStreetMap
  server instead.
- **The licence of the State's woody-vegetation layers** was not looked up,
  because they carry no heights.
- **The size of the State's buildings as one tile file**, and of a
  Queensland–New South Wales extract of Overture, are estimates; neither file
  was built.
- **A browser test** of the two cross-site reads that depend on browser
  behaviour (Overture's file without a preflight; the deflate blocks in
  Meta's files) — both are standard, but were checked here with command-line
  requests, not in a browser.
