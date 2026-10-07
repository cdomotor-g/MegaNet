# Land — tenure and council

A section on every station card, and the same rows on the **ℹ️ What is here**
card, that says what the land at that point is: the lot and plan, its tenure,
who holds that kind of land in plain words, which council's area it is in, the
street address, the rural property's name and what the land is mapped as being
used for.

It is `site-land.js`. `stnCardHtml()` in `app.js` places it right after the
card's first section — beside the *Owner* row, because it answers the other
ownership question: whose ground, not whose station. `map-here.js` places it
between the ground's facts and the nearest stations. `npm run land` holds both
(see the end).

It was asked for in these words: *"we need to know details of the land like
whether it is council owned or that sort of thing."*

---

## What it can and cannot tell you

**Queensland does not publish who owns a lot.** The owner's name is on the
title, and a title is a paid search with Titles Queensland. What is free is the
**tenure** — the kind of holding — and for most of the network that answers the
question:

- A **Reserve** is State land set aside for a community purpose under the Land
  Act 1994 and managed by a trustee — most often the local council, sometimes a
  State agency or a community body. The cadastre often names it ("Dauth Park",
  "Both Valleys Reserve"). The trustee and the purpose are on the reserve's
  title record.
- A **road reserve** or a **watercourse** is State land: a road has its road
  manager (the council for a local road, Transport and Main Roads for a
  State-controlled one), and a watercourse's bed and banks are the State's under
  the Water Act 2000. A gauge on a bridge or in a channel is usually on one.
- **State Land**, **National Park**, **State Forest**, **Main Road**,
  **Railway** and the other State tenures name the agency without a search.
- **Freehold** cannot be answered for free. Councils own freehold too — a
  depot, a park, a pump station — so where the land use is one that often means
  a public owner (public services, recreation and culture, utilities,
  transport, waste, reservoirs, supply channels, stock routes) the card says so
  as a **hint**, and says that only the title is the answer.

So the card never says "council owned". It says what the tenure is, who holds
that kind of land, which council's area it is in, and what to search next.

---

## What each row means

| Row | What it says | Where from |
|---|---|---|
| **Lot on plan** | The lot and the plan it was created on — "Lot 192 on ML2222" — which is what a title search, a council and a surveyor all ask for, with a link to the State's free **SmartMap** of the lot (a one-page PDF). Where the cadastre's boundary is plotted to ±5 m or worse it says so: a station near the line may be on the other side of it. | Cadastre |
| **Tenure** | The tenure the cadastre records, and the parcel's name where it has one (a park, a reserve, a national park). For a parcel with no tenure: *Road reserve*, *Watercourse*, or *Road reserve or unlinked parcel* (the square where two roads meet). | Cadastre |
| **Held by** | Who holds that kind of land, from the tenure — see the table below. | Read from the tenure |
| **Council** | The local government area the lot is in, named as a council. The council whose area it is — not necessarily the owner. | Cadastre |
| **Address** | The first street address the State's address register gives the lot, and how many more. *None registered for this lot* when it has none. Lots only. | Property address register |
| **Lot area** | The lot's area. Lots only. | Cadastre |
| **Easement** | Any easement over the point — a powerline, a pipe, a right of way — by its lot and plan. The summary says that whoever holds it has rights there too. | Cadastre |
| **On the line with** | When the point is on the boundary between parcels, the other ones. A lot is shown first over a road or a watercourse, being the one a title search can be asked about. | Cadastre |
| **Property** | The rural property's name, where the State's rural properties map names one. | Rural properties |
| **Land use** | The mapped land use in the Australian Land Use and Management classes, and the year it was mapped there. | Land use mapping (QLUMP) |

Under the rows is a short summary — who holds the land and who to ask — with a
link to the next step: a title search, the State's page on reserves, or its
page on permits to occupy State land.

### Who holds it, by tenure

| Tenure | Held by |
|---|---|
| Freehold | Private title — owner not published (a title search names them) |
| Reserve | The State, through a trustee — often the council |
| State Land | The State — unallocated State land (Department of Resources; a permit to occupy for a structure) |
| Lands Lease | A lessee, on State land |
| National Park | The State — Queensland Parks and Wildlife Service |
| State Forest, Forest Reserve, Timber Reserve | The State — managed by QPWS or for its timber |
| Main Road | The State — Transport and Main Roads |
| Railway | A railway manager |
| Water Resource | A water authority — the title says which |
| Port and Harbours Boards | A port authority |
| Boat Harbours | The State — boat harbour |
| Commonwealth Acquisition | The Commonwealth |
| Housing Land, Industrial Estates | The State |
| Mines Tenure | A mining tenure holder |
| Road reserve | The council or Transport and Main Roads |
| Watercourse | The State — bed and banks (a riverine protection permit for works in it) |

A tenure the cadastre adds later reads as its own name, with *the title says
who*.

---

## Sources

All four are the Queensland Government's, on the same keyless ArcGIS host the
cadastre layers and the site exposure section already use
(`spatial-gis.information.qld.gov.au`), and all four are CC BY 4.0. The card's
*Sources and limits* names each with its custodian, which is the attribution
the licence asks for.

| Source | Layer | Custodian |
|---|---|---|
| [Cadastral data — Queensland series](https://www.data.qld.gov.au/dataset/cadastral-data-queensland-series) | `PlanningCadastre/LandParcelPropertyFramework/MapServer/4` | Department of Resources |
| [Property Address locations](https://www.data.qld.gov.au/dataset/property-address-locations) | `…/LandParcelPropertyFramework/MapServer/0` | Department of Resources |
| [Rural properties — Queensland](https://www.data.qld.gov.au/dataset/rural-properties-queensland) | `…/LandParcelPropertyFramework/MapServer/50` | Department of Natural Resources and Mines, Manufacturing and Regional and Rural Development |
| [Land Use Mapping — Current](https://www.data.qld.gov.au/dataset/land-use-mapping-current-web-service-json) | `PlanningCadastre/LandUse/MapServer/0` | Department of Environment and Science |

The State's trustee and reserve-purpose register (`StateManagedLand`) is behind
a login and is not used.

---

## Limits

- **One point.** The station's recorded position, rounded to five decimal
  places (about a metre). The cadastre's boundaries are plotted to anything from
  10 cm in a surveyed town to tens of metres in the far west, so a station near
  a boundary may be in the parcel next door.
- **Queensland only.** Outside the State's box nothing is asked and the section
  says *Not in Queensland*. Inside it, a point across the border or at sea comes
  back as one of the cadastre's pseudo-parcels for its own extent — "New South
  Wales", "Coral Sea" — and is said as *not on Queensland's land*, never as a
  lot.
- **The tenure is not the owner.** "Held by" is what that kind of holding
  usually means; the title is the authority.
- **Land use is a map,** at the year it was mapped for that area — often a
  decade old.

---

## What it costs

The parcel first; then, for a real lot, the land use, the rural property and the
address together (the address only for a lot with a lot/plan). Four requests a
station, each a handful of attributes, at most three in flight across the app.
Answers are kept for the session per position, so a second open of a card asks
nothing, and the *What is here* card at a station's position answers from the
station card's cache and the other way round. A source that failed is not asked
again for a minute unless **Try again** is pressed.

---

## The check

`npm run land` (`test/land.mjs`) answers the four services itself, in their own
shape, and holds the rules above: freehold never names an owner, a reserve names
the council as the likely trustee, a public land use beside freehold is a hint,
a failed source is named and never read as "none", the New South Wales
pseudo-parcel is not a lot, a watercourse asks no address, and the costs.
