# 🚧 Before you dig

A tool on the Stations map (`map-dig.js`) and a view in the **Property** group of Views. It answers one question before site works at a station: *what is in the way?* That covers an orifice line trenched to the creek, old footings dug out, a station moved, or a crane or hiab (a truck-mounted crane) set up to lift a mast.

**It is a guide, not a locate.** The open data is incomplete, sometimes years old, and can be metres out. Always lodge a [Before You Dig Australia](https://www.byda.com.au/) request and have services located on site.

## Using it

- **Check a spot.** Press it and tap the map. Or pick a station from *At a station*. Pressing the **Before you dig** view arms the map, so your first tap checks that spot.
- **Draw a dig line.** Tap each bend of the trench, then *Check this line*. Lines, pipes and boundaries are measured from the whole line, not just its ends.
- **Check within** (10–100 m, default 30 m): how big the ring is. **Red** (*Stop*) is inside the ring. **Amber** (*Check*) is inside twice the ring. Anything further away is left off the list. A finding about the place itself, like a zone or a soil, is banded by what it means for the work.
- **Both / Overhead (cranes) / Underground (digging)**: which services to list. Land and ground findings always show.
- **Print check sheet / Save check sheet**: one page with the findings, what the open data leaves out, and blank lines for the Before You Dig request number, who located services, and the landholder.

## What it reads

| Finding | Source | Banding |
|---|---|---|
| Transmission lines, substations | Geoscience Australia | by distance; an overhead line's red reach is at least its crane exclusion zone |
| Overhead lines and underground cables (Qld) | Energex and Ergon | by distance, grouped by kind and voltage, with the exclusion zone |
| Gas and oil pipelines | Geoscience Australia | by distance |
| Water, sewer, recycled water and stormwater pipes | Brisbane City Council, Unitywater, Melbourne Water, Ballarat / Surf Coast / Mitchell | by distance (only inside each owner's area) |
| The lot, its tenure and how near its boundary | Qld cadastre (DCDB) | boundary inside the ring: amber; tenure: for the record, with whose permission it needs |
| Road reserves, easements | Qld cadastre | in one: red; near one: amber |
| Fire ant zones, cultural heritage party, protected areas | Qld biosecurity, cultural heritage and parks services; CAPAD | zone or party: amber; protected area: red |
| Acid sulfate soil | Qld soil mapping, finest scale first, then the national atlas | actual or likely: red; possible: amber |
| Soil type | Qld best-available soil mapping (Australian Soil Classification order) | Vertosol, Sodosol, Hydrosol, Organosol, Kurosol, Arenosol, Anthroposol: amber |
| Wind region | AS/NZS 1170.2:2021, Geoscience Australia | cyclonic (C, D): amber |
| Past flood outlines | Qld flood lines | for the record |

**Crane exclusion zones** come from the Electrical Safety Regulation 2013 (Qld), Schedule 2, for plant run by someone who is not an authorised electrical worker: 3 m up to 132 kV, 6 m to 330 kV, 8 m above. The line's owner says what applies to a particular line.

The services and ways of asking are the ones More map layers uses (`MapFeeds.digSources()`). The queries ask for a box around the spot or line and measure each shape's true distance in the browser. Energex and Ergon's service ignores a distance given with a single point (checked 20 Nov 2026), so the station card's *Power network* row now asks the same way.

## What the open data leaves out (researched 20 Nov 2026)

- **Telecommunications.** NBN, Telstra, Optus and the others publish no open maps of their cables. The only route is a Before You Dig request.
- **Gas distribution.** Street gas mains (Australian Gas Networks, Allgas and others) aren't in the open data, only the high-pressure transmission pipelines are.
- **Most councils' water, sewer and drainage.** Only the owners listed above publish theirs openly.
- **Private services.** The landholder's own power to sheds and pumps, water lines, irrigation and septic. Ask the landholder.
- **Contaminated land.** Queensland's Environmental Management Register and Contaminated Land Register are searched lot by lot, for a fee (the panel links to the registers page). There's no open map to draw.
- **Earlier works at a station.** Old orifice lines, cables and footings: the station card's photos and inspection history.

## Checks

`npm run dig` stubs every service with things a known distance from the spot and checks the banding, the panel, the sheet, a line, and that another view takes the check off. `npm run feeds` covers the two new layers, *Acid sulfate soils (Qld)* and *Soil type (Qld)*, in the new *Soil and ground* group of More map layers.
