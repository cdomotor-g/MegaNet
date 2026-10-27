# Road and bridge owners

Who manages each road and bridge in Queensland — Transport and Main Roads, the
council, the Parks and Wildlife Service, a private landholder — in two places:

- **Layers → Road & bridge owners (Qld)**, a layer on the Stations map:
  every road coloured by who manages it, and every bridge a pin that says whose
  it is. Click a bridge for who to call. It is `map-road-owners.js`.
- **Road and bridge — who manages them**, a section on every station card and on
  the **ℹ️ What is here** card, under the land section: the nearest road and who
  manages it, the nearest bridge and whose it is, and who to contact. It is
  `site-roads.js`. Pick a point on a road with What is here to ask about any
  road, not only one beside a station.

It was asked for in these words: *"we should include road and bridge owners …
would be nice if … the road owners marked on the map"*, after a look at
[QLDTraffic](https://qldtraffic.qld.gov.au/), whose *Road Lookup* page answers
the same question one road at a time.

---

## What "owner" means here

The land under a public road in Queensland is the State's (Land Act 1994). What
differs from road to road is who **manages and controls** it: Transport and Main
Roads (TMR) for a road declared **State-controlled** under the Transport
Infrastructure Act 1994, and the **council** for nearly every other. The State's
road data calls that the road's owner, and so does Flood-Net. It decides who
gives permission to work in the road corridor, who closes the road in a flood,
and who to ring when it is damaged.

The lines are thin — about half their first weight since 23 October 2026, so a
highway never reads heavier than the river it crosses on a map whose subject is
the rivers. Their order of weight is unchanged.

| On the map | Means | From the data |
|---|---|---|
| **Maroon**, over a white casing, heaviest | State-controlled — Transport and Main Roads | `scr_indicator` T, or `road_owner` TMR |
| Dark slate | The council's, as the State records it | `road_owner` LG |
| Thin, lighter slate | Not State-controlled, owner not recorded — the council's or private | `road_owner` Unknown |
| Green | National park or State forest — Queensland Parks and Wildlife Service | QPWS, Forestry |
| Brown, dashed | Private — the owner of the land it crosses | Private |
| Teal | Another public body — a port, water or utility authority, another State authority | PA, WA, UP, STATE, Other |

**Most roads have no owner recorded.** In October 2026, 342,520 of the 563,463
road segments in Queensland Roads and Tracks are "Unknown" and not
State-controlled. Nearly all of those are council roads and some are private;
the State has not recorded which, so Flood-Net does not guess. It draws them as
their own class and says what QLDTraffic's own lookup says of the same roads:
*the council's, or private*. The State-controlled flag, by contrast, is set for
every segment — so the TMR/not-TMR answer is always definite.

---

## The map layer

- **Off by default**, remembered between visits. It recolours every road, which
  is a way of reading the map somebody chooses rather than one every session
  should open in.
- **Wider than about 1:3,000,000** nothing is drawn. **To about 1:150,000** only
  the State-controlled network is drawn — the roads a flood cuts that the
  Bureau's warnings name. **Closer in**, every road, with footpaths, bikeways,
  ferries and proposed roads left out.
- **Bridges** appear from zoom 13: a pin with an arch, maroon for a bridge on
  TMR's register, slate for any other. Hover one for its name, its manager and
  the road it carries (or passes over); click it for a callout with TMR's
  structure number and what it is built of, and the TMR district, the council or
  the road's operator to call.
- The roads are one server-rendered image per view (a city's screenful is 6,000
  to 14,000 road segments, far more than the map can hold as shapes), so the
  roads take no pointer. To ask about one road, use **What is here** on it.
- **Queensland only.** The State's road data stops at the border.

---

## The card section

| Row | What it says |
|---|---|
| **Road** | The nearest road within 150 m, by its mapped centreline, with its national and State route numbers and how far away it is (*here* when the point is on it). An unnamed road or track says so rather than printing the data's placeholder "Road". |
| **Managed by** | Who manages it, in the words of the table above — with the council named — and who maintains it where the data says that is somebody else, and *a toll road* where it is one. |
| **Bridge** | The nearest bridge within 150 m: its name, how far away, and whether it is TMR's (with the structure number) or not State-controlled, in which case it goes with the road it carries — normally the council's. |
| **Contact** | Who to call, from QLDTraffic's road lookup: the TMR district for a State-controlled road or bridge, the council for a council road or an unrecorded one, and the road's own operator where the lookup names one (the Toowoomba Second Range Crossing's operator, a Transurban toll road, a busway). A park's, a private owner's or another body's road is not in that directory, and the row says so. |

Under the rows, a sentence or two on what it means for somebody about to work
there — a road corridor permit for a State-controlled road, the council's
approval for a council road — with links to TMR's road corridor permits and to
QLDTraffic for closures, flooding and roadworks.

Each of the three questions (the road, the bridge, the contact) can fail on its
own; a failure says which source could not be read and why, and **↻ Try again**
asks again.

---

## Sources

| Source | What it gives | Licence |
|---|---|---|
| [Queensland roads and tracks](https://www.data.qld.gov.au/dataset/queensland-roads-and-tracks) (QRT), `Transportation/RoadsAndTracks` on the State's spatial platform | Every road segment, its State-controlled flag and owner code (defined in the QRT data dictionary, November 2025), and ~5,500 road bridges and overpasses as lines, with no owner on them | © State of Queensland (Department of Natural Resources and Mines, Manufacturing and Regional and Rural Development), CC BY 4.0 |
| [State controlled roads bridges — Queensland](https://www.data.qld.gov.au/dataset/state-controlled-roads-bridges-queensland), `Transportation/StateRoadInformation` | TMR's register of the bridges it manages: one point per carriageway per structure (4,320 points), with the structure number, name, type, construction and the road section on it or under it | © State of Queensland (Transport and Main Roads), CC BY 3.0 AU |
| [QLDTraffic Road Lookup](https://qldtraffic.qld.gov.au/lookup.html) | For a point: the council, the TMR district (near a State-controlled road), TMR's state traffic centre, and a road's own operator where it has one — each with a phone number and an email address | © State of Queensland (Transport and Main Roads) |

**The two bridge sets are merged.** A QRT bridge within 30 m of a structure on
TMR's register is that structure and is not drawn twice (measured over
Toowoomba, Brisbane and Rockhampton: where both have a bridge they agree to
within 30 m, and each has bridges the other does not). A QRT bridge left over is
not one TMR manages.

**The road lookup is not a published interface.** It is the service QLDTraffic's
own Road Lookup page asks — keyless and open to other sites — but it is not in
the QLDTraffic API specification and can change without notice. Flood-Net asks
it once per point somebody chose, caches the answer, and keeps the road and
bridge rows standing if it fails.

---

## Limits

- **The nearest road is the nearest mapped centreline**, which can be a road the
  station is beside rather than the one it is reached by.
- **A bridge's owner is TMR's register or the road it carries.** A council bridge
  is not named as the council's by any published register; it is the council's
  because the road is.
- **Unrecorded owners are not guessed** (see above).
- **Queensland only.** About 41% of the network is in New South Wales; Transport
  for NSW publishes its own road classification, which this does not read yet.

---

## QLDTraffic — what else is there

Looked at for this work and not used yet. QLDTraffic's website reads public
GeoJSON feeds on `data.qldtraffic.qld.gov.au`, open to other sites (CORS), which
the QLDTraffic API specification licenses as CC BY 4.0 AU:

- **`events_v2.geojson`** — every current road event: flooding (flash and
  long-term), closures, hazards including *bridge or culvert damaged*, crashes,
  roadworks — each with its road, locality, council, TMR district, impact
  ("Road closed to all traffic") and who reported it (TMR, a council, Transport
  for NSW). About 2 MB, 400 kB compressed; a delta feed carries the last
  changes.
- **`floodcameras.geojson`** — about 120 flood cameras on causeways and bridges,
  each with a current image. **Drawn now**, with the councils' cameras, by the
  Stations map's *Flood & road cameras* layer (`docs/council-cameras.md`).
- **`webcameras.geojson`**, **`districts.geojson`**, rest areas and more.

A road closed by flooding near a gauge, and a camera looking at the crossing
the gauge measures, are both things a flood warning network would use. The
cameras are a layer now; the events are a layer of their own still to come, and
an issue on the roadmap (#238).

---

## The check

`npm run roadowners` (in `test/`) stubs the three sources as the live services
answer and holds the layer and the section to everything above: what is asked at
each scale, the image's renderer and filters, the merged bridge, the pins' hover
and callout, the section on a State road, a council road with a footpath closer,
an unnamed track, a private lane with the lookup down, a point in New South
Wales, and a Queensland station's card.
