# ACMA licences — what the stations' own transmitters run under

The Stations map's **📜 ACMA licences** tool and the station card's **ACMA
licences near here** section (`map-acma.js`) answer one question: which radio
licence, if any, covers each transmitter in the network. This page says where
the answer comes from, the rules behind it, and what it cannot know.

The rules themselves are taught in the Knowledge base's **🪪 Radio Licensing**
lesson (`kb-licensing.js`), which quotes each one from its document and opens
the document at the sentence. The documents are kept in [`docs/acma/`](acma/README.md).

It is a different question from the interference layer (🗺️ Layers › ACMA
licences, 📡 RF Changes), which asks who *else* transmits near the receivers.

**Whose network.** The ALERT and ALERT2 flood-warning network is nobody's
alone: the Bureau of Meteorology, councils and water authorities each put up
and run their own gauges and repeaters and hold the licences for them. The
Bureau holds many and is the nearest thing the network has to a custodian,
but no one body owns it all. Flood-Net shows the network; it does not own it.
"The network" below means that shared network.

**Two meanings of "base station".** Base stations — the receiving sites
that take the readings in — **only receive**. None transmits, so
none needs a licence, and the tool marks each *Not a transmitter*. In a
licence and in the law, "base station" means something else: the one
transmitting station a point-to-multipoint licence names. In this network
that is always a **repeater**. Below, "the licensed repeater" is that
station, and "base station" appears only inside a quotation.

**A guide, not legal advice.** Written in November 2026 from the instruments
linked below. Check with ACMA (1300 850 115, info@acma.gov.au) before relying
on any of it.

## Where the data comes from

`tools/acma_station_licences.py` reads ACMA's daily download of the Register
of Radiocommunications Licences (`spectra_rrl.zip`, the same file the weekly
ACMA refresh already fetches) and writes `data/acma-station-licences.json`,
about 190 KB. It keeps **fixed-service** licences held by:

| Who | Which of their licences |
|---|---|
| The Bureau of Meteorology | every fixed licence below 1 GHz |
| Anybody else with a fixed licence on a channel this network's stations use | their fixed licences in 148–174 MHz |
| Councils with a point-to-multipoint licence in 148–174 MHz | those licences |

On 11 November 2026 that was 413 licences of 26 holders: 332 of the Bureau's
(269 point to multipoint, 63 point to point), 39 of Seqwater's, and 42 held by
24 councils. Every status the register still lists is kept, and both ends of
every point-to-point link, each licence's special conditions, and each
transmitter's and receiver's **frequency assignment number** (`freq_assign_id`,
the register's `EFL_FREQ_IDENT`; "Freq. assign. ID" on the licence document).

The panel's holder list is the same set, with a tick box each.

## The rules, and where each is written

| Point | What it says | Source |
|---|---|---|
| A transmitter needs a licence | Operating one without is an offence. Apparatus, spectrum and class licences are the three kinds. | [Radiocommunications Act 1992](https://www.legislation.gov.au/C2004A04465/latest/text), s 46 |
| Outside a condition is outside the licence | Operation "is not authorised by the relevant apparatus licence if it is not in accordance with the conditions of the licence". | Act, s 97(4) |
| Point to multipoint | One "base station" — here, a repeater — "at a fixed location specified in the licence"; remote stations whose "locations … are not specified in the licence". | [Fixed Licence determination 2025](https://www.legislation.gov.au/F2025L00388/latest/text), s 5(2) and note (Compilation No. 2, in force 21 March 2026) |
| Point to point | A station "principally for communication with one other fixed station". Both ends are on the licence. | [Interpretation determination 2025](https://www.legislation.gov.au/F2025L00362/latest/text) |
| Who a station may talk to | Only stations the same licence authorises or refers to. | Fixed Licence determination, s 13 |
| A remote station's channel | Only the licensed repeater's transmit and receive frequencies. | Fixed Licence determination, ss 15(2), 23(2) |
| A remote station's power and timing | For data or telemetry: no more than 2 s a transmission, at least 10 s between starts, no more than 1 in 30 of the time; no more than 1 W measured at the antenna input (5 W only in 451.5–452.5 and 805.5–806 MHz). | Fixed Licence determination, s 15(3)–(4), Table 2 |
| A remote station must not interfere | It may not be operated "if its operation causes harmful interference". At any distance. | Fixed Licence determination, ss 15(1), 23(1) |
| A licence's own conditions win | Where a condition written on the licence differs from the determination, the licence's applies. | Fixed Licence determination, s 12(2) |
| A fill-in transmitter | Only to overcome gaps "within the coverage area of a base station"; never "to extend the coverage area of a base station". | Fixed Licence determination, s 14(3)–(4) |
| A point-to-point antenna | Where the licence names none, 148–174 MHz needs at least 12 dBi, a beam of 44° or less and 20 dB front to back. | Fixed Licence determination, s 11, Table 1 |
| The service area (ACMA's planning radius) | "A service area radius of 30 km. All stations must be contained within the service area." 2 km for a low-power system. Only the licensed repeater is coordinated; the remote stations are protected by being inside the model. | [RALI FX16](https://www.acma.gov.au/sites/default/files/2025-11/rali_fx16.pdf), ss 3.1, 3.2 (in effect 25 March 2025) |
| ACMA's planning figures for power | The licensed repeater: 40 W EIRP at most (8.3 W low power), antenna gain 8.2 dBi at most. A remote station: 20 W EIRP at most, and 5 W at most in any direction but towards that repeater. | RALI FX16, s 3.1 |
| A transmitter that extends coverage | "…beyond a 30 km radius of the master station is not a supplementary transmitter; it is another master station and must be separately licensed". | RALI FX16, s 4.3 |
| A label on the transmitter | A licensed fixed transmitter of more than 2 W EIRP at a communal site carries a label with its frequency assignment number and "Do Not Remove". | [Labelling determination 2023](https://www.legislation.gov.au/F2023L01181/latest/text), ss 5, 7, 8; Act, s 300 |
| Land mobile | A fixed radio and mobiles "operated principally for two-way communications"; its service area is 40 km from the fixed radio. Not the licence for a fixed gauge. | [Land Mobile Licence determination 2025](https://www.legislation.gov.au/F2025L01132/asmade/text) |
| No licence at all | Any transmitter on 150.7875–152.49375 MHz at 100 mW EIRP or less. | [LIPD class licence 2025](https://www.legislation.gov.au/F2025L01047/asmade/text), Schedule 1, Table 1, item 17 |
| Somebody else's transmitter on your licence | Needs the holder's written authorisation, which some holders may not give. | Act, s 114; [Authorisations and Transfers determination 2025](https://www.legislation.gov.au/F2025L00844/asmade/text) |

### The 30 km question

**Must a station more than 30 km from the licensed repeater it reports to
have a licence of its own? Not a gauge, and not for that reason alone.**

There are three places a rule can live, and they say different things:

1. **The law** — the Act and the Fixed Licence determination — **sets no
   distance.** It lists what a remote station must do: talk to its own
   licence's stations, on the licensed repeater's frequencies, briefly, at low power,
   without harmful interference. ACMA's explanatory statement to the
   determination says a licence's unlisted transmitters "can be located
   anywhere, although for most practical purposes, they need to be located in
   relatively close physical proximity" to the one that is named.
2. **The licence document** names the repeater's site, frequency, power and
   antenna, and — as a rule — no distance. A few licences write one into a
   special condition ("a service area of 20 km"), and a licence's own condition
   binds; where one is given the tool draws it.
3. **ACMA's planning policy**, RALI FX16, is where 30 km comes from, and it is
   put firmly: "All stations must be contained within the service area." A
   RALI is applied when a licence is issued — the assigner certifies the station
   fits it — and allows exceptions case by case. It is not legislation.

So a gauge beyond the circle is **outside what its licence was planned for**:
unprotected, since only the licensed repeater is coordinated; bound not to interfere, which
is law at any distance; and on the back foot in a dispute. It is not
unlicensed. A **repeater** is different: a transmitter that carries the signal
further than a licensed repeater reaches may not run on that repeater's licence at all
(s 14(4); FX16 s 4.3) and needs a licence naming its own site.

What nobody has written down, as far as could be found, is what ACMA does about
an *existing* gauge beyond the service area of a licence already issued. The
reading above follows from the documents; only ACMA can confirm it, and the
lesson carries a draft of the question to send.

### What was read, and what was not

Read in full: the Act's sections cited, the Fixed Licence determination in the
version in force (Compilation No. 2) and as first made, its explanatory
statement, the Interpretation, Labelling and frequency-assignment-certificate
determinations, the class licence, and RALIs FX16 and FX19 — the two RALIs and
the as-made determination supplied by the owner as PDFs in November 2026, the
rest read on the Federal Register of Legislation. One Bureau licence document
(1463975/1) was read; the register's special conditions were counted for all.

Not read: ACMA's own web pages (the site refuses automated visits; the links
were found by search), and RALIs MS42 and LM08, which would say which of
FX16's two routes the 151.5 MHz licences were assigned by. Both routes use the
same service area.

## A station's licensing state

For a station that transmits — it has an ALERT address, or is a repeater:

| State | Rule |
|---|---|
| **Licence at the site** | A licence in force has a transmitter within 500 m, on a channel the station uses (or its channel is not on record). |
| **Inside a licence's area** | Otherwise: it is inside the circle of a point-to-multipoint licence in force, on its channel. For a **repeater** the verdict adds that a circle covers it only as a fill-in, and that it normally needs its own licence. |
| **Beyond a licence's area** | Otherwise, for a gauge: a repeater that carries it (by its pass ranges), within the map's Max TX distance, stands within 500 m of the transmitter of a point-to-multipoint licence in force on its channel. Covered in law by that licence; outside the service area ACMA planned it on. |
| **None found** | None of those. Never "unlicensed": the weekly copy can lag, the holder may not be in the list, or a transmitter of 100 mW EIRP or less may run under the class licence. |
| **Not a transmitter** | No ALERT address and not a repeater. Receiving needs no licence. Every base station is here: it only receives. |

A station's channel is its own transmit frequency where one is recorded, else
the listening frequency of each repeater that likely hears it directly
(`Frequencies.carriersOf`). A licence on another channel is left out and the
verdict says so. 500 m is the radius `tools/acma_fetch.py --suggest-licences`
already matches a repeater to its licence with.

On 11 November 2026, with a 30 km service area and every holder ticked: 225
stations with a licence at the site, 1,669 inside a licence's area (37 of them
repeaters with no licence at their own site), 203 beyond a licence's area, 409
with none found (51 of them repeaters), and 2,433 that are not transmitters
(plus 7 with no position). Before the fourth state existed the 203 were
counted among 612 "none found".

Where the station's radio is on record the verdict also works out the power
reaching its antenna (the radio's power less the cable's loss) and its EIRP,
and says when a remote station is over the 1 W the law allows or the 5 W ACMA
plans a gauge with an all-round antenna on.

## The transmitter label

The Radiocommunications (Labelling) Determination 2023 asks for one thing to
be on the equipment itself. A transmitter must carry a label with its
**frequency assignment number** and the words **"Do Not Remove"**, in a colour
that stands out from the label's background, when it is all of:

- operated under a transmitter licence (other than a PTS licence), and not a
  broadcasting station;
- a fixed transmitter authorised for **more than 2 W EIRP**;
- at a **communal site**: a place where two or more fixed transmitters operate
  on assigned frequencies within 200 m of each other, in the same broad band
  (30–300 MHz for this network). A place that had only two when the definition
  changed on 31 March 2025 is not counted until it has three.

Not complying can draw a civil penalty of up to 100 penalty units (Act, s 300).
It is not the whole licence: no name, licence number or expiry date is asked
for. A gauge alone at a riverbank is not at a communal site, and as an
unlisted remote station has no frequency assignment number.

The tool shows the number beside each licensed transmitter. A station with a
licence at its site, over 2 W EIRP, is told the label it needs — as a fact
where the register copy shows another licensed transmitter within 200 m, and
as "if another stands within 200 m" where it does not, since the copy holds
only the listed holders' licences.

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
file apart from the module, the fourth state held to the repeaters that carry
each station, the shapes drawn, the search, the CSVs, the card's section, the
label and the guide's sources.

`cd test && npm run licensing` — every quotation the lesson and the guide show
is on the page it names in the saved copy of its document, word for word; then
the lesson itself.
