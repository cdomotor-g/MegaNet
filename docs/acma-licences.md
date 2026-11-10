# ACMA licences — what the stations' own transmitters run under

The Stations map's **📜 ACMA licences** tool and the station card's **ACMA
licences near here** section (`map-acma.js`) answer one question: which radio
licence, if any, covers each transmitter in the network. This page says where
the answer comes from, the rules behind it, and what it cannot know.

It is a different question from the interference layer (🗺️ Layers › ACMA
licences, 📡 RF Changes), which asks who *else* transmits near the receivers.

**A guide, not legal advice.** Written in November 2026 from the instruments
linked below. Check with ACMA (1300 850 115, info@acma.gov.au) before relying
on any of it.

## Where the data comes from

`tools/acma_station_licences.py` reads ACMA's daily download of the Register
of Radiocommunications Licences (`spectra_rrl.zip`, the same file the weekly
ACMA refresh already fetches) and writes `data/acma-station-licences.json`,
about 180 KB. It keeps **fixed-service** licences held by:

| Who | Which of their licences |
|---|---|
| The Bureau of Meteorology | every fixed licence below 1 GHz |
| Anybody else with a fixed licence on a channel this network's stations use | their fixed licences in 148–174 MHz |
| Councils with a point-to-multipoint licence in 148–174 MHz | those licences |

On 10 November 2026 that was 413 licences of 26 holders: 332 of the Bureau's
(269 point to multipoint, 63 point to point), 39 of Seqwater's, and 42 held by
24 councils. Every status the register still lists is kept, and both ends of
every point-to-point link, and each licence's special conditions.

The panel's holder list is the same set, with a tick box each.

## The rules, and where each is written

| Point | What it says | Source |
|---|---|---|
| A transmitter needs a licence | Operating one without is an offence. Apparatus, spectrum and class licences are the three kinds. | [Radiocommunications Act 1992](https://www.legislation.gov.au/C2004A04465/latest/text), s 46 |
| Point to multipoint | One base station “at a fixed location specified in the licence”; remote stations whose “locations … are not specified in the licence”. | [Fixed Licence determination 2025](https://www.legislation.gov.au/F2025L00388/asmade/text), s 5(2) and note (made 20 March 2025) |
| Point to point | A station “principally for communication with one other fixed station”. Both ends are on the licence. | [Interpretation determination 2025](https://www.legislation.gov.au/F2025L00362/latest/text) (made 13 March 2025) |
| Who a station may talk to | Only stations the same licence authorises or refers to. | Fixed Licence determination, s 13 |
| A remote station's channel | Only the base's licensed transmit and receive frequencies. | Fixed Licence determination, ss 15(2), 23(2) |
| A remote station's power and timing | For data or telemetry: no more than 2 s a transmission, at least 10 s between starts, no more than 1 in 30 of the time; no more than 1 W into the antenna (5 W only in 451.5–452.5 and 805.5–806 MHz). | Fixed Licence determination, s 15(3)–(4), Table 2 |
| A licence's own conditions win | Where a condition written on the licence differs from the determination, the licence's applies. | Fixed Licence determination, s 12(2) |
| A fill-in transmitter | May not be used to extend the base's coverage. | Fixed Licence determination, s 14(4) |
| A point-to-point antenna | Where the licence names none, 148–174 MHz needs at least 12 dBi and a beam of 44° or less. | Fixed Licence determination, s 11, Table 1 |
| Land mobile | A base and mobiles “operated principally for two-way communications”; its service area is 40 km from the base. Not the licence for a fixed gauge. | [Land Mobile Licence determination 2025](https://www.legislation.gov.au/F2025L01132/asmade/text) (made 18 September 2025) |
| No licence at all | Any transmitter on 150.7875–152.49375 MHz at 100 mW EIRP or less. | [LIPD class licence 2025](https://www.legislation.gov.au/F2025L01047/asmade/text), Schedule 1, Table 1, item 17 (made 4 September 2025) |
| Somebody else's transmitter on your licence | Needs the holder's written authorisation, which some holders may not give. | Act, s 114; [Authorisations and Transfers determination 2025](https://www.legislation.gov.au/F2025L00844/asmade/text) (made 10 July 2025) |
| The assumed reach (ACMA's planning radius) | ACMA plans a point-to-multipoint service on a 30 km service area (high power) or 2 km (low power), with every station inside it and nothing protected beyond it. | [RALI FX16](https://www.acma.gov.au/sites/default/files/2025-11/rali_fx16.pdf) (in effect 25 March 2025) |
| Power on land-mobile channels | Planned at 83 W EIRP (high power) and 8.3 W (low power). | [RALI LM08](https://www.acma.gov.au/sites/default/files/2025-12/rali_lm08_-_may_2024_update_1.pdf) (in effect 17 May 2024) |

### The 30 km question

**A point-to-multipoint licence states no distance.** The Bureau's licence
documents name the base's site, frequency, power and antenna, and nothing
about how far away a remote station may be. 30 km is the radius ACMA *plans*
such a service on (RALI FX16). So the tool draws a 30 km circle as a first
look, calls it an assumed reach everywhere it appears (the distance ACMA assumes when it hands out a channel, not a limit), and lets it be
changed. Four licences in the 10 November copy state a service area of their
own in a special condition (“a service area of 20 km”); for those the stated
figure is drawn instead.

What the rules actually test is that a remote station talks to the licensed
base, on its channel. Where the base of the covering licence stands at a
repeater that carries the station (by its pass ranges), the verdict says so.

### What was read, and what was not

The determinations, the class licence and the Act were read in full text on
the Federal Register of Legislation. ACMA's own website refused requests from
the machine this was built on, so the two RALIs and ACMA's “Options for fixed
licences” page were read through search-result extracts, not the documents
themselves: the 30 km and 2 km figures, the 83 W and 8.3 W figures, and the
statement that protecting a remote station takes its own point-to-point
licence come from those extracts. Open the linked documents to confirm them.

## A station's licensing state

For a station that transmits — it has an ALERT address, or is a repeater:

| State | Rule |
|---|---|
| **Licence at the site** | A licence in force has a transmitter within 500 m, on a channel the station uses (or its channel is not on record). |
| **Inside a licence's area** | Otherwise: it is inside the circle of a point-to-multipoint licence in force, on its channel. |
| **None found** | Neither. Never “unlicensed”: the weekly copy can lag, the holder may not be in the list, or a transmitter of 100 mW EIRP or less may run under the class licence. |
| **Not a transmitter** | No ALERT address and not a repeater. Receiving needs no licence. |

A station's channel is its own transmit frequency where one is recorded, else
the listening frequency of each repeater that likely hears it directly
(`Frequencies.carriersOf`). A licence on another channel is left out and the
verdict says so. 500 m is the radius `tools/acma_fetch.py --suggest-licences`
already matches a repeater to its licence with.

On 10 November 2026, with a 30 km radius and every holder ticked: 225 stations
with a licence at the site, 1,669 inside a licence's area, 612 with none
found, and 2,433 that are not transmitters (plus 7 with no position).

## ACMA's own pages

- **The licence document** is a PDF at an address built from the number:
  licence `1463975/1` is
  `https://cdn.acma.gov.au/rrl/licences/1/463/1463975/1.pdf` — the millions,
  then the thousands (not zero-padded: `10053639/1` is under `10/53/`), then
  the number, then the issue — wrapped in
  `https://backend.acma.gov.au/rrl/v1/licences/pdf?blobUrl=…&licenceNumber=1463975-1.pdf`.
  Checked against eight licence numbers of different lengths in November 2026.
- **The register** moved to a new website on 10 June 2026. The address of one
  licence's page there could not be confirmed, so the tool links the
  register's search page and the user pastes the number.

## Checks

`cd test && npm run acmamap` — every station's state worked out again from the
file apart from the module, the shapes drawn, the search, the CSVs, the card's
section and the guide's sources.
