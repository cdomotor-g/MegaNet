# Site exposure — tides and soils

A section on every station card that says what the water and the ground at the
station are likely to do to whatever is built there: whether it stands in or
near tidal water, where the Water Act puts the nearest tidal limit, whether it is
in the coastal management district, the erosion prone 40 m from the highest tide
or a storm tide area, and what Queensland's acid sulfate soil mapping says about
the ground under it — beside the tide levels the station's own record already
carries, and a short, plain-language reading of what they add up to.

It is `site-exposure.js`, placed on the card by `stnCardHtml()` in `app.js`
between the *Flood levels (AEP)* section and the *Flood warning service (SLS)*
one. `npm run exposure` holds it (see the end).

It was asked for in these words: *"Tidal limits and acid sulphate soil info on
stations cards to inform remediation infrastructure choices. Users may like to
know what kind of salinity etc a site will be exposed to."*

Everything in it is **indicative**. It reads maps at one point. It is where a
conversation about materials and footings starts, not where it ends — the card
says so under every summary, and this page says why below.

---

## What each row means

| Row | What it says | Where from |
|---|---|---|
| **Tidal water** | *In tidal water* — within 50 m of a mapped tidal waterway. Otherwise the smallest of three bands the highest-astronomical-tide line comes within: 100 m, 1 km or 10 km, and "more than" the band inside it when that one said no; or *None within 10 km*. | Tidal waterways (DAF) for the first; the HAT line (Department of Resources) for the bands |
| **Tidal limit** | The Water Act downstream limit on the station's own stream if one is mapped within 20 km, otherwise the nearest one, saying it is on another stream; the straight-line distance to it. *None mapped within 20 km* where there is none. | Watercourse identification map |
| **Coast** | In or outside the coastal management district, and *within 40 m of HAT* where the point is in component 1 of the erosion prone area. | Coastal management district; erosion prone area |
| **Storm tide** | *High hazard* (covered by more than 1 m) or *Medium hazard* (less), *Not in a mapped storm tide area*, or *Not mapped here* where the State had no LiDAR to map it from. | Storm tide hazard areas |
| **Acid sulfate** | The finest acid sulfate soil map that covers the point (1:25 000, then 1:50 000, then 1:100 000), quoted in its own words with its scale and project code; or the national atlas's probability class where no finer map covers it, marked *inferred, not checked on the ground* at 1:2M; or *Not mapped here*, which is not the same as absent. | Acid sulfate soils series; national atlas |
| **National atlas** | Beside a finer answer: the atlas's class if Queensland's copy has one there — which, by how the copy was made, it usually does not, and the row says so rather than reading the gap as a finding. | National atlas |
| **ASS sample** | The nearest acid sulfate soil sample site within 2 km: how far, which project and site, how deep the core went, whether it has laboratory data or field pH, how many sites are within 2 km, and a link to the site's own report. Shown where there is one, or where the soil is mapped as likely and there is none. | Acid sulfate soil sites (SALI) |
| **Tide on the gauge** | From the station record, not the services: HAT from the Bureau's crossing type **T**, and the tide levels among its flood effects (HAT, MHWS, a historic storm tide), each a height on the gauge — and in m AHD only where the gauge zero in force is surveyed in AHD. | The Bureau's river height station lists (0031, 0032) |

The coastal rows (*Tidal limit*, *Coast*, *Storm tide*, *ASS sample*) are asked
only where the highest-tide line is within 10 km: all of them lie along the coast
and the estuaries, and inland they would be seven requests answering "no".

### The summary — *Indicative exposure*

A few sentences, each tied to a row above:

- **Salt water.** In tidal water: salt or brackish at high tide — saltier in a
  dry spell or a king tide, fresher in a flood — and steel and reinforced
  concrete corrode fastest where the tide wets and dries them. Within 100 m of
  the HAT line: salt in the air is likely, and a storm tide can bring salt water
  to the site. Within 1 km: salt on the wind and salty groundwater are worth
  checking for. None within 10 km: these maps put no salt water here — and
  inland salinity is not something they cover.
- **Storm tide.** In a mapped storm tide area: a surge can put seawater over the
  site, and the mapping allows for sea level rise to 2100.
- **The station's ground against HAT.** Where the gauge's HAT can be put in AHD
  and the station has a recorded elevation within 3 m of it: the one against the
  other, "modelled" where the elevation is.
- **Acid sulfate soil.** *Actual* — already making sulfuric acid; the water in
  and draining from it is acidic and sulfate-rich and attacks concrete and steel,
  galvanising included. *Likely* — harmless left wet and undisturbed; dug up,
  drained or dewatered, the iron sulfides oxidise to sulfuric acid, which attacks
  concrete and steel and releases iron and aluminium, and the soft muds they sit
  in can settle under a footing. *Possible* — worth testing for before digging.
  *Unlikely* — said, with the map's own note where it records acidic soil near
  the surface.

The soil sentences are the Queensland Government's own, from
[Acid sulfate soils explained](https://www.qld.gov.au/environment/land/management/soil/acid-sulfate/explained)
("safe and harmless when not disturbed"; dug up or drained, the pyrite "turns …
into sulfuric acid") and
[Impacts of acid sulfate soils](https://www.qld.gov.au/environment/land/management/soil/acid-sulfate/impacts)
("Sulfuric acid can also attack concrete and steel, slowly destroying pipes,
roads, bridges, and building foundations"; foundations on these soft estuarine
materials "may settle or subside unevenly"). The card links both.

### When a source does not answer

A row whose source did not answer says *could not be read* and names the source;
a line under the rows names every source that failed and why (*answered HTTP
500*, *no answer in 20 s*, *unreachable — offline, or the network blocks the
host*), says nothing on the card is claimed from them, and offers **↻ Try
again**. A failure is never shown as "none" — an empty answer and an unanswered
question look the same to a template, and that is the failure this section is
most at risk of. A failed source is not asked again on every repaint of the card,
only after a minute or when *Try again* is pressed.

### Outside Queensland

These are Queensland's maps; they stop at the border, and a point beyond it
answers "nothing here" from every one of them. So the first question is coverage:

- **Outside Queensland's extent** (a box a little larger than the State — most of
  the network outside the Brisbane hub): *Not in Queensland*, and nothing is
  asked.
- **In a Queensland local government area, or within 50 m of a mapped tidal
  waterway**: answered. The second catches a gauge in a river channel or on a
  jetty — Brisbane's LGA stops at the high-water mark on both banks of its river,
  and every LGA stops at the shore.
- **Within 1 km of a Queensland LGA but in none**: answered, under a line saying
  the point is on the shore, offshore or across the border, and that the layers
  stop at the border. (Tweed Heads is under 1 km from Coolangatta.)
- **Otherwise**: *Not in Queensland — or offshore, beyond its mapped land and
  tidal waterways*.

---

## Sources, licences and attribution

All on `spatial-gis.information.qld.gov.au/arcgis/rest/services`, asked with a
point `query` (`geometry=lon,lat&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects`,
plus `distance` in metres where a row asks "within"). Every feature query names
its fields and every "is it here" question is `returnCountOnly`.

| Dataset | Layer | Custodian, as the layer's copyright gives it | Licence |
|---|---|---|---|
| [Local government area boundaries — Queensland](https://www.data.qld.gov.au/dataset/local-government-area-boundaries-queensland) | `Boundaries/AdministrativeBoundaries/MapServer/1` | State of Queensland (Department of Natural Resources and Mines, Manufacturing and Regional and Rural Development) | CC BY 4.0 |
| [Queensland waterways for waterway barrier works — tidal](https://www.data.qld.gov.au/dataset/queensland-waterways-for-waterway-barrier-works-tidal) | `Environment/Fisheries/MapServer/15` | State of Queensland (Department of Agriculture and Fisheries), 2023 | CC BY 4.0 |
| [Highest astronomical tide — Queensland](https://www.data.qld.gov.au/dataset/geographic-features-queensland-series) (Geographic features series) | `Boundaries/AdminBoundariesFramework/MapServer/199` | State of Queensland (Department of Resources), 2023 | CC BY 4.0 |
| [Watercourse identification map — downstream limits](https://www.data.qld.gov.au/dataset/watercourse-identification-map-queensland-series) | `InlandWaters/WatercourseIdentificationMap/MapServer/200` | State of Queensland (Department of Natural Resources, Mines and Energy), 2019 | CC BY 4.0 |
| [Coastal management district](https://www.data.qld.gov.au/dataset/coastal-plan-series) (Coastal plan series) | `PlanningCadastre/CoastalManagement/MapServer/5` | Queensland Government (Department of Environment and Science), 2018 | CC BY 4.0 |
| [Erosion prone area — component 1, 40 m from HAT](https://www.data.qld.gov.au/dataset/erosion-prone-area-series) | `…/CoastalManagement/MapServer/9` | as above | CC BY 4.0 |
| [Storm tide — high and medium hazard](https://www.data.qld.gov.au/dataset/storm-tide-queensland-series), and where it is not mapped | `…/CoastalManagement/MapServer/11`, `/12`, `/13` | as above | CC BY 4.0 |
| [Acid sulfate soils series](https://www.data.qld.gov.au/dataset/acid-sulfate-soils-series) — 1:25 000, 1:50 000, 1:100 000 | `GeoscientificInformation/SoilsAndLandResource/MapServer/1902`, `/1952`, `/2002` | State of Queensland (Department of Environment and Science), 2020 | **CC BY 3.0 AU** |
| [Atlas of Australian Acid Sulfate Soils](https://doi.org/10.4225/08/512E79A0BC589) (Fitzpatrick, Powell & Marvanek), as Queensland serves it | `…/SoilsAndLandResource/MapServer/2052` | CSIRO, 2011 | CC BY 4.0 |
| Acid sulfate soil sites (SALI), in the [Queensland soil and land resource map service](https://www.data.qld.gov.au/dataset/queensland-soil-and-land-resource-data-web-map-service) | `…/SoilsAndLandResource/MapServer/1850` | State of Queensland (Department of Natural Resources and Mines, Manufacturing and Regional and Rural Development), 2025 | CC BY 4.0 |

The licences were read off data.qld.gov.au's catalogue and the atlas's DOI
record on 28 September 2026. Note the one that differs: the acid sulfate soils
series is **CC BY 3.0 AU**, not 4.0. Both require attribution, which the card's
*Sources and limits* disclosure gives — every dataset consulted for that station,
its custodian and its licence, linked.

---

## Limits

- **A map read at a point.** Every row is a point-in-polygon (or
  point-near-something) question asked at the station's recorded position,
  rounded to four decimal places (~11 m). A coordinate a few tens of metres out —
  the hut rather than the gauge, a pin dropped from an old map — can put a site
  on the other side of a boundary. The rows say where they came from so the
  reader can judge that.
- **Map scale.** The soil maps are drawn at 1:25 000 to 1:100 000, the national
  atlas's inland classes at 1:2 000 000. A polygon edge is a line on a map, not
  on the ground.
- **The national atlas, as Queensland serves it,** was clipped in 2021 to
  Queensland, to land below 20 m elevation and to land with no finer mapping —
  so it is usually missing exactly where a finer map answers, and missing above
  20 m whether or not anything is there. Its 1:2M classes were inferred from
  national soil and hydrography maps and are provisional. Queensland's copy does
  not carry the atlas's confidence rating.
- **The Water Act downstream limit** is a legal line: where the Water Act 2000
  stops treating a stream as a watercourse and the Coastal Protection and
  Management Act 1995 takes over. Where none is mapped, the Act's fallback is
  "the point to which the high spring tide ordinarily flows and reflows". A mapped
  limit is therefore near the tidal limit, not a measurement of how far salt
  water gets on a given day — king tides and low flows push it further, floods
  push it back. The watercourse map marks few of them (197 statewide in
  September 2026; the Brisbane River has none), and the distance given is a
  straight line, not along the river.
- **The HAT line** is "an approximation of the land–tidal water interface at the
  highest water level that can be predicted to occur under any combination of
  astronomical conditions". It follows the open coast and the tidal reaches of
  rivers alike, which is why it is used for distance rather than the tidal
  waterway polygons (those are estuaries and creeks and stop at the coast: a
  beach-front station read 3.7 km from them). Distances are bands, in a straight
  line, and say nothing about which side of the line the point is on.
- **Storm tide** mapping is the State's inundation area allowing for projected
  climate change to 2100; high hazard is more than 1 m deep, medium less. Where
  the State had no LiDAR it is *not mapped*, and the row says so.
- **HAT on the gauge** comes from the Bureau's lists as recorded on the station,
  and goes into AHD only through a gauge zero surveyed in AHD — never an assumed
  datum — and only when the answer is somewhere a tide could be (−1 to 8 m AHD).
- **Not covered at all:** inland (dryland) salinity and saline groundwater away
  from the coast, atmospheric salt from surf beyond what distance implies, and
  anywhere outside Queensland. The national atlas covers all of Australia and
  could answer the soil question for the New South Wales stations one day; that
  would be a different service and a separate change.

### What it is not

A design determination. Which concrete, which cover, which coating and which
footing are decisions made on a site investigation, and the card never offers
one. What it does is tell whoever is choosing which questions the site is likely
to raise:

- Acid sulfate soil is investigated, sampled and managed to the Queensland
  Government's guidance — the *Queensland Acid Sulfate Soil Technical Manual,
  Soil Management Guidelines* (version 5.1, May 2024) and the national sampling
  and laboratory methods manuals it points to — listed on the State's
  [Guidance materials for acid sulfate soils](https://www.qld.gov.au/environment/land/management/soil/acid-sulfate/national-guidance)
  page.
- Concrete durability is classified under AS 3600, whose exposure classes include
  members in sea water's tidal and splash zones and in aggressive — sulfate-bearing
  or acidic — soils, from the site's own test results.
- Atmospheric corrosivity for steel and coatings is zoned under AS 4312, where
  nearness to salt water drives the category.

---

## What it costs

Staged, so a station asks only what can matter to it, one request per layer:

| Stage | Asked | Requests |
|---|---|---|
| Coverage | local government area; tidal water within 50 m — and, if neither, a local government area within 1 km | 2–3 |
| Soil and distance | the three acid sulfate soil maps and the national atlas; out of tidal water, the three HAT-line bands | 4–7 |
| Coastal, only with the HAT line within 10 km | Water Act limits within 20 km; coastal management district; 40 m from HAT; storm tide high, medium and unmapped; sample sites within 2 km | 7 |

Thirteen to seventeen requests for a coastal station, nine or ten inland, none
outside Queensland — each a count or a handful of attributes, a few kilobytes at
most (the largest measured, the 113 sample sites within 2 km of Cairns Harbour,
is 38 KB). A point query answered in about a second when measured. At most four are in flight at once
across the whole app, each is given 20 s, and a card that moves to another
station drops the old one's unsent questions.

Answers are kept for the session per position, layer by layer: a second open of
the same card, and every repaint of it, asks nothing. A layer that failed is not
asked again for a minute unless *Try again* is pressed.

## What the network has to allow

| Host | For | Notes |
|---|---|---|
| `spatial-gis.information.qld.gov.au` | every row but *Tide on the gauge* | Already allowed — the cadastre, the road parcels, the contours and the survey marks come from it. Keyless; CORS reflects the Origin, `null` (file://) included |

The links on the card — data.qld.gov.au, qld.gov.au, doi.org and
resources.information.qld.gov.au for the sample sites' reports — are opened by a
person in a new tab and never fetched by the app.

See [`floodwarning-net.md`](floodwarning-net.md) for why a hostname the Bureau's
filter has never categorised is denied by default, and what to ask for. Where
this host is blocked, the section says *unreachable — offline, or the network
blocks the host* against each source, and claims nothing.

## The check

`npm run exposure` (`test/exposure.mjs`) answers the State's services itself —
one stub per layer, in the shape the live service returns — for seven stations
chosen for what each exercises: in the tide on the Brisbane River (every coastal
layer; a Water Act limit on another creek nearer than the one on its own river;
the finest soil map over a coarser one that disagrees), near the tide by a real
pin click (the HAT-line bands; the national atlas alone), inland (nothing coastal
asked), on the shore (the 1 km edge), across the Tweed (coverage asked, nothing
else), far outside Queensland (nothing asked), and one whose storm tide map
answers 500 and whose finest soil map never answers. It holds the rows to the
answers, the tide levels to the station's record and its datum, failures to
being named, *Try again* to asking exactly what failed with focus kept in the
card, the cache to asking nothing on a second open, the queue to four at once
and to dropping a card that moved on, and the section to the outline, names and
no-inline-style rules `npm run tabs` holds — and, at 375 px with every disclosure
open, to no sideways scroll. Twelve deliberate breaks were run against it before
it was trusted, and every one went red.
