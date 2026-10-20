# Mobile coverage — estimated

Whether a phone works at a station or a point, for each of **Telstra**,
**Optus** and **TPG (Vodafone)**, in two places:

- **Mobile coverage — estimated**, a section on every station card, under the
  road and bridge section. It also gives the same figure for a modem with an
  external antenna on a mast, which is the question for a station's telemetry.
- The same section on the **ℹ️ What is here** card, for any point picked on the
  map.

Each carrier gets the ACMA coverage map standard's grade — **Good**,
**Moderate**, **Basic** or **No coverage** — with the level in dBm, the band,
and how far and which way the mast is. Under that is a sentence on what it adds
up to, links to each carrier's own map, **How each figure is reached** (every
term of the best sector's sum), and **Sources and limits**.

It is `site-mobile.js` (the section), `mobile-signal.js` (the arithmetic) and
`tools/mobile_sectors.py` (the data, `data/mobile/`).

It was asked for in these words: *"is it possible to bring in cell phone
coverage into flood-net somehow? … coverage overlay on the map and estimated
signal strength at locations like stations and with the information at map
point tool"*. This is the signal strength half. The overlay is below, under
[What is not here yet](#what-is-not-here-yet).

---

## Why an estimate, and not the carriers' maps

There is no open feed of any carrier's coverage map:

- **The carriers' own maps** (the ones linked on the card) are on their websites
  only, with no download and no interface anybody else may use.
- **The ACCC's open copies** of them ([Mobile Infrastructure Report data
  release](https://data.gov.au/data/dataset/accc-mobile-infrastructure-report-data-release),
  CC BY 2.5 AU) are each carrier's predicted coverage as at 31 January each
  year. They only say covered or not covered, for outdoor and external-antenna
  use, and nothing about how strong.

What is open is the **ACMA's Register of Radiocommunications Licences**. Every
mobile transmitter in a spectrum-licensed band has to be entered in it, with its
position, antenna height, azimuth, antenna and power. There are ~610,000
transmitter entries for the three carriers at ~23,000 sites. Flood-Net already
downloads the register every month for the interference layer. It also already
carries the terrain and the propagation model its link budgets run on
(`terrain.js`, `itm.js`). Put together, those are enough to **work the signal
out**. The section says so on its face and links the carriers' maps beside it.

## How a figure is reached

1. **The masts.** The register's transmitters within 60 km of the point, out of
   `data/mobile/`, which holds one row per sector: carrier, band, frequency,
   azimuth, height, horizontal beamwidth, front-to-back ratio, and the power per
   resource element (below).
2. **The likeliest four per carrier.** Each is ranked on a rough figure (free
   space at 1 km, then 35 dB a decade), so only a dozen or so masts are worked
   properly, most of them shared. A band is only considered as far as the
   networks plan it to reach: 60 km for 700, 850 and 900 MHz, 35 km for 1.8–2.6
   GHz, and 15 km for 3.5 GHz.
3. **The path.** One terrain profile per mast, from the mast to the point (~30
   m terrain tiles, the same ground the link budget stands on). Longley–Rice's
   *median* loss over it, for each band and mast height, to a phone at 1.5 m and
   to an antenna at 5 m.
4. **What stands round the phone.** The land cover at the point. Among trees or
   buildings the phone pays ITU-R P.2108's terminal clutter, the same loss the
   link budget's land-cover model charges a mast under the trees.
5. **The level.** For every sector:

   ```
   power per resource element (register)
   − 3 dB              two transmit ports; RSRP is one port's reference signal
   − antenna pattern   off boresight: 12·(φ/beamwidth)² dB, floored at the
                       front-to-back ratio (25 dB if the register has none)
   − path loss         Longley–Rice median
   − clutter           P.2108, if the point is among trees or buildings
   + receive gain      −3 dBi for a phone, 6 dBi for the external antenna
   − body / cable      4 dB for a phone, 2 dB of cable for the external antenna
   = median level
   − 8.3 dB            the standard's 85%: z(0.85) × σ 8 dB
   = the level that is graded and printed
   ```

   The strongest sector for each carrier is its row.

**Power per resource element.** RSRP, the figure the standard is written in, is
the power of one reference-signal resource element: a 15 kHz subcarrier for LTE,
or 30 kHz for NR at 3.5 GHz. The register gives a device's EIRP over its whole
bandwidth, so `tools/mobile_sectors.py` spreads it over the subcarriers: EIRP ÷
(0.9 × bandwidth ÷ subcarrier spacing).

## The grades

The grades are the ACMA's [Telecommunications (Mobile Network Coverage Maps)
Industry Standard 2026](https://www.legislation.gov.au/F2026L00381/latest/text),
Schedule 1. Every carrier's public map has been drawn to it since 30 June 2026,
so *Moderate* on this card is the same level *Moderate* is on a carrier's map:

| Grade | RSRP (4G) / SS-RSRP (5G) |
|---|---|
| Good | −95 dBm or more |
| Moderate | −105 to −95 dBm |
| Basic | −115 to −105 dBm |
| No coverage | under −115 dBm |

The phone is the standard's, from Table 2: 1.5 m above the ground, −3 dBi of
antenna gain and 4 dB of body loss. A level is graded at **85% of locations**,
with lognormal fading of σ = 8 dB. That is 8.3 dB under the median, and it is
the number the card prints beside the grade. **How each figure is reached**
shows the median as well.

The **external antenna** is this app's assumption, not the standard's: 6 dBi,
on a 5 m mast, with 2 dB of cable. That is roughly a yagi or panel on a station
mast. It is spelt out wherever it is shown.

## How well it agrees with the carriers' own maps

It was held against the carriers' own predicted outdoor 4G coverage as at 31
January 2026, from the ACCC release. The test was 150 stations picked at random
from the station list, asking whether a handheld gets at least *Basic*:

| Carrier | Agree | Inside the carrier's map, estimated no coverage | Outside it, estimated covered |
|---|---|---|---|
| Telstra | 88% (132 of 150) | 17 | 1 |
| Optus | 88% (132 of 150) | 16 | 2 |

Nothing was fitted to get there. The register's figures went in as they are.
Where the two disagree, the estimate is almost always the **more cautious**. It
says no coverage at a point the carrier counts as covered, and 11 of Telstra's
17 such points are within 10 dB of the −115 dBm edge. Two things account for most
of that:

- The January 2026 maps predate the standard's −115 dBm at 85% definition.
- A carrier's own model knows its real antenna tilts, heights and powers, which
  the register only approximates.

A point the carrier counts as covered, graded *No coverage* here, is worth
reading as "marginal".

## Limits

- **The register says what a site may radiate, not what it does.** It does not
  say how the antenna is tilted (96% of tilts are entered as 0, and the sign is
  not consistent), how busy the site is, or whether it is switched on. A sector
  registered and not yet built is priced as if it were built.
- **No vertical pattern.** The register has no vertical beamwidth for any mobile
  antenna. Close to a mast, under its main beam, the estimate is optimistic by a
  few dB. Past a few kilometres it makes little difference.
- **~30 m terrain, no buildings.** A gully narrower than a tile, a building, a
  vehicle or a cutting all cost signal that is not here. The cover is only what
  is at the point itself.
- **Median propagation.** Longley–Rice at 50% of time, locations and
  situations, then the standard's 85% shift. It is not a guarantee at any one
  spot.
- **Power per resource element** assumes the power is spread evenly over the
  subcarriers, with no reference-signal boost.
- **60 km.** A mast further away is not considered. Telstra's extended-range
  850 MHz sites can be heard further with a high-gain antenna.
- **TPG's regional customers** ride Optus's masts under the regional network
  sharing that started in 2025 (MOCN). Those transmitters are on Optus's
  licences, so the register alone would show TPG with no regional coverage. The
  ACCC lists the shared sites (*Mobile sites — Optus-TPG MOCN*). The tool flags
  every Optus site within 150 m of one, and the card counts it for TPG, saying
  *Optus's mast, shared*.

## The data

`data/mobile/` is rebuilt every month by the ACMA refresh
(`.github/workflows/acma-refresh.yml`), off the same register download the
interference layer uses:

- `index.json` holds the attribution, the extract's date, what was kept and
  dropped, and every cell with its sector count.
- `cells/<lat>_<lon>.json` holds one cell, 1° × 1°, named for its south-west
  corner. A city cell is up to ~2 MB, a rural one tens of kilobytes. A card
  fetches only the one to four cells round its point.
- `accc-mocn-sites-2026.csv` is the ACCC's list of Optus sites shared with TPG,
  as published (CC BY 2.5 AU). It is yearly: when the ACCC publishes the next
  year's, add it here and point the workflow's `--mocn` at it.

What the tool keeps: transmitters on the three carriers' spectrum licences, in
the 4G and 5G bands below 6 GHz (700, 850, 900, 1800, 2100, 2300, 2600, 3500).
For each sector it keeps the device with the most power per resource element,
because that is the carrier a phone camps on. What it drops, and counts in
`index.json`:

- millimetre wave;
- transmitters below ground (tunnels and mine pits);
- devices with no power.

It also repairs one kind of keying error: an EIRP more than 32 dB over the
device's own transmitter power is recomputed from the transmitter, the antenna's
gain and the feeder. In the October 2026 extract that was 87 devices. One light
pole in Docklands was entered at 166 MW.

Run it by hand with:

```sh
python3 tools/mobile_sectors.py --zip spectra_rrl.zip \
    --mocn data/mobile/accc-mocn-sites-2026.csv --out data/mobile
```

`npm run mobile` (in `test/`) holds the arithmetic to hand calculations and the
files to the shape the card reads.

## What is not here yet

- **The coverage overlay.** The ACCC's polygons are the carriers' own maps, and
  they would make the overlay: one layer per carrier and technology, outdoor and
  external antenna. They are big, though. Telstra's 4G outdoor map alone is 294
  MB of KML, and Optus's is 1.4 GB. They need turning into map tiles once a
  year and hosting somewhere the map can fetch them. That is the next piece.
- **A carrier's map at a point.** The same polygons would give a second row
  beside each estimate: *inside Telstra's outdoor map*. That comes with the
  overlay.

## Sources

- Register of Radiocommunications Licences — © Australian Communications and
  Media Authority, CC BY 4.0.
- ACCC Mobile Infrastructure Report data release (the MOCN site list, and the
  coverage maps used to check the estimate) — © Australian Competition and
  Consumer Commission, CC BY 2.5 AU.
- Telecommunications (Mobile Network Coverage Maps) Industry Standard 2026
  (F2026L00381) — Federal Register of Legislation.
- Terrain: AWS Terrain Tiles (SRTM/GMTED). Land cover: as `land-cover.js` names
  it.
