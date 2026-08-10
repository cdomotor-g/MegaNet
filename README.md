# MegaNet — Radio & Satcom Network Station Tool

**Live app:** https://cdomotor-g.github.io/MegaNet/

MegaNet is a browser-based tool for managing and visualising a radio and satellite communications (satcom) network. It consolidates station data, repeater pass-range analysis, Radio Mobile export, and interactive mapping into a single self-contained HTML application backed by one JSON data file. No server, no build step — just open the file in a browser.

---

## Background

The Bureau of Meteorology operates a network of telemetry field stations that monitor rainfall, water levels, and battery status. Stations transmit their readings via ALERT radio, routed through one or more repeaters before reaching a base station (ingest point). Planning and maintaining these networks requires knowing:

- Which stations a repeater serves (based on its pass ranges)
- What path a station's signal takes from field to base
- How to configure Radio Mobile for propagation fade-margin modelling
- Where everything sits on a map

The existing codebase is a collection of separately-evolved HTML tools with overlapping data and duplicated logic. This project consolidates them.

---

## Repository Layout

The consolidation to a single-page app is done: the live tool is **`index.html`**
(loads `styles.css`, `maps-data.js`, `app.js`) backed by the one **`stations.json`**
data file. Everything else is organised into folders so the root stays clean.

```
MegaNet/
├── index.html              ← single entry point
├── app.js                  ← all application logic
├── maps-data.js            ← Network Maps catalogue, QLD basin SVG + georeference
├── styles.css              ← theme and layout
├── stations.json           ← single source of truth (see schema below)
├── migrate.html            ← legacy-CSV → stations.json converter (linked from the app)
├── .nojekyll               ← serve every file verbatim on GitHub Pages
│
├── maps/                   ← Radio-path maps for the Network Maps tab, by region
│   ├── far-north/          │  Barron, Herbert, Tully/Johnstone, Mulgrave, Saddle Mt
│   ├── mackay-whitsundays/ │  Don/Proserpine, Pioneer
│   ├── burdekin-townsville/│  Burdekin, Haughton, Mt Stuart
│   ├── central-qld/        │  Boyne/Baffle, Callide, Central Highlands, Dawson
│   ├── wide-bay-burnett/   │  Fraser Coast, Burnett, Mary, Kanigan
│   ├── se-qld/             │  Albert/Logan, Bremer/Lockyer, Caboolture, Maroochy, …
│   ├── west-south-west/    │  Blackall, Charleville, Warrego, SWRED, Western Downs, …
│   └── nsw-border/         │  NSW North Coast repeater maps
│
├── docs/                   ← reference documents
│   ├── BOM spec erts_data_formats_doc.pdf   (ERTS Data Formats spec, ALERT Packets tab)
│   ├── Hydrology Raw Data Filtering Program Specification.pdf  (357 filter, v2.1 2009)
│   ├── 357 Filter doco.doc                  (the 1998 first edition of the same spec)
│   └── aem_Durikai_AL_541134_Rainfall_541134_0_R_5758.csv  (sample ARRO export)
│
├── data/                   ← source + bundled data files
│   ├── ALL_UNITS.csv                 (legacy field-station source for migrate.html)
│   ├── ALL_REPEATERS.csv             (legacy repeater source for migrate.html)
│   ├── All 2021 Working 2.txt        (national ALERT address lookup, ALERT Packets tab)
│   ├── acma-raw/                     (prefiltered ACMA RRL subset, CC BY 4.0)
│   │   └── YYYY-MM/                  (archived monthly snapshots — never delete; see RF Changes)
│   ├── acma-threats.json … acma-dictionaries.json   (generated RF interference layer)
│   ├── acma-timeline.json            (authorisation-date timeline for the RF Changes tab)
│   ├── acma-snapshots.json / acma-changes.json      (snapshot index + precomputed diffs)
│   ├── acma-licence-suggestions.csv  (repeater ↔ ACMA licence review file)
│   ├── ghosting-links.json           (observed candidate → target ghosting links, Network View)
│   └── rf-concepts.json              (RF explainer entries for the Workbench concept drawer)
│
├── radio-mobile/           ← self-contained Radio Mobile desktop project
│   ├── MegaNet.csv … MegaNet_NetData.csv   (sample export set)
│   └── net1.map / .jpg / .geo / .inf / .kml / .dat   (map, terrain, georeference)
│
├── assets/geo/             ← source geometry (basin SVG is inlined in maps-data.js)
│   └── QldBasin_2009Nov_reduced.svg, Qld Major Streams, queensland-outline, all_2009Nov
│
├── tools/                  ← command-line helpers (needs Python; see tools/README.md)
│   ├── meganet_agent.py     (Claude-API agent that answers questions over stations.json)
│   ├── acma_prefilter.py    (reduce the 68 MB ACMA RRL extract to data/acma-raw/)
│   ├── acma_fetch.py        (classify + score interference candidates → data/acma-*.json)
│   └── acma_diff.py         (archive monthly snapshots + diff them → data/acma-changes.json)
│
└── archive/                ← redundant / superseded / unreferenced (see archive/README.md)
    ├── prototype_index.html, BitFlipper*.html, image_bitflipper.svg, app_updated*.js
    ├── z_Sensors_…_NATIONAL.csv, fred_sites_newfile.csv        (redundant data)
    ├── *_reduced.txt                                            (dupes of assets/geo SVGs)
    └── *.msg / *.pptx / *.docx                                  (original map sources)
```

> **Map file resolution.** The Network Maps catalogue in `maps-data.js` keeps the
> **bare filename** as each map's display name and lookup key; `MAPS_DIR` +
> `REGION_DIR` build a `FILE_PATH` table (filename → `maps/<region>/<file>`) that
> `app.js`'s `encPath()` uses to load the file. To add a map, drop it in the right
> `maps/<region>/` folder and add its filename to `MAP_CATALOG` (and `FILE_INFO`).

---

## Data Schema — `stations.json`

Each entry in the `stations` array represents one node in the network. A node can simultaneously be a field station, a repeater, and/or a base station — the `roles` array defines its capabilities.

### Top-level structure

```json
{
  "meta": {
    "version": "1.0",
    "description": "MegaNet station database",
    "updated": "YYYY-MM-DD"
  },
  "radio_networks": [
    {
      "id": "barcaldine",
      "name": "Barcaldine",
      "description": "Stations served by the Barcaldine repeater cluster"
    }
  ],
  "catchments": [
    {
      "id": "warrego",
      "name": "Warrego",
      "basin_no": "423",
      "area_sqkm": 59379.6,
      "region": "West / South West"
    }
  ],
  "stations": [ /* see below */ ]
}
```

### Station entry

```json
{
  "id": "UNIQUE_STATION_ID",
  "name": "Loudoun Bridge",
  "station_number": "422001A",
  "lat": -27.1234,
  "lon": 150.5678,
  "elevation_ahd": 312.5,

  "roles": ["field", "repeater", "base"],

  "radio_network_ids": ["barcaldine"],
  "catchment_ids": ["warrego"],

  "alert_ids": {
    "battery":     1042,
    "rainfall":    1043,
    "water_level": [1044, 1045]
  },

  "site": {
    "db_id":  3402,
    "number": "544070",
    "name":   "Abbieglassie AL"
  },

  "sensors": [
    { "alert_id": 1073, "type": "Rainfall",           "sensor_id": "544070.0.R.1073", "device_id": 1 },
    { "alert_id": 1073, "type": "Rainfall Increment", "sensor_id": "544070.0.R.1073", "device_id": 3 },
    { "alert_id": 1074, "type": "Battery",            "sensor_id": "544070.0.B.1074", "device_id": 2 }
  ],

  "repeater": {
    "acma_licence": "XXXXXX",
    "rx_mhz": 151.500,
    "tx_mhz": 151.625,
    "pass_ranges": [
      { "low": 1001, "high": 1199 },
      { "low": 2400, "high": 2499 }
    ],
    "exclusions": [],
    "notes": ""
  },

  "satcom": {
    "enabled": false,
    "provider": "",
    "terminal_id": ""
  },

  "rm_system_id": 1,

  "enabled": true,
  "notes": ""
}
```

#### Field notes

| Field | Type | Notes |
|-------|------|-------|
| `roles` | `string[]` | Any combination of `"field"`, `"repeater"`, `"base"` |
| `alert_ids.water_level` | `number` or `number[]` | Single ID or array for dual-sensor sites |
| `site` | `object` | Contrail/ARRO site the station maps to: `db_id` (internal ARRO site id), `number` (external site number), `name` |
| `sensors` | `object[]` | Every ALERT-addressable device at the site, sourced from the ARRO sensor exports. Each has `alert_id`, `type` (e.g. `"Rainfall"`, `"Water Level"`, `"Battery"`), `sensor_id` and `device_id`. `alert_id` is `null` for sensors ARRO has not given an ALERT address; `device_id` (and `site.db_id`) are `null` when the ARRO-internal ids are unknown, which only costs the sensor its ARRO graph link |
| `repeater.pass_ranges` | `object[]` | Unlimited; each has `low` and `high` inclusive bounds |
| `repeater.exclusions` | `object[]` | Reserved for next-generation equipment; same `low`/`high` structure |
| `rm_system_id` | `number` | References the Radio Mobile system spec (power, antenna, etc.) |
| `satcom.enabled` | `boolean` | Marks stations with satellite comms capability |
| `catchment_ids` | `string[]` | References `catchments[].id`. **Not yet populated** — the Network Maps tab derives a station's catchment at runtime from its coordinates (see feature 8). Populate this to make map suggestions exact. |

> **`site` / `sensors`** are the authoritative sensor records — the `alert_ids`
> labels are kept for backward compatibility but can be mislabelled (an address
> filed under `rainfall` may actually be a Water Level device). The Bit Flipper
> reads `sensors` for its Sensor / Sensor ID columns and ARRO links.
>
> **Provenance.** `site` / `sensors` come from ARRO's *Sensors — List by System*
> exports, one workbook per state, loaded with `tools/import_arro_sensors.py`.
> The `Site` column of those exports is the authoritative station name: an early
> import truncated names at 20 characters, and the importer repairs them. ARRO's
> internal `db_id` / `device_id` are not in the workbooks, so they are looked up
> in `archive/z_Sensors_with_Database_IDs_by_View_NATIONAL.csv` — the earlier
> national export, kept for exactly that reason.

---

## Planned Features

### 1. Unified Data Management
- Load `stations.json` from disk or drag-and-drop
- In-browser CRUD editor for stations with live validation
- Export edited data back to `stations.json`
- Import from legacy CSV format (migration path from current files)

### 2. Interactive Map
- Plot all stations by role using distinct markers:
  - Field stations (rainfall, water level, or both)
  - Repeaters
  - Base stations / ingest points
  - Satcom terminals
- Draw signal path lines between field stations and the repeaters/base stations their AlertID passes through
- Click a station to see its full detail panel
- Filter map display by role, sensor type, radio network, region, basin/council or data completeness (see *Filtering & Exploration*)
- Pull the repeaters that carry a matched station onto the map and into the table with it (*Include related repeaters*)
- Toggle individual link lines on/off, fade them with a slider, and cap how long a link may be before it is dropped (*Kill spaghetti*)
- Station name labels on, off, or automatic — appearing once you zoom in far enough to read them
- Draw and measure over the map: pins, lines, circles, rectangles and text, placed by hand or by coordinates and km, in a colour of your choosing
- Snap drawing to stations, so a path between two sites starts and ends on the sites and is named after them
- Select stations off the map — by rectangle, by circle, or by shift-clicking pins — into the table below, and export the set as CSV
- Leaflet.js with a base-map picker (top-right): OSM-Topo (default), OpenStreetMap, or Satellite

**Reading the map.** Every pin carries a white ring so it separates from the
base map and from its neighbours; ACMA transmitter squares carry the same ring.
The filter box **highlights instead of hiding**: all pins stay on the map,
matches get an amber ring, their names appear underneath, and the map zooms to
the extent of the matches so every one of them is on screen. Typing narrows the
highlight live. Labels are capped at the 60 matches nearest the middle of that
extent (the filter pane says when the cap is in effect). Tick *Hide stations
that don't match*, under **Map display**, for the old subtractive behaviour —
which still keeps the repeater at the far end of any drawn signal link, since a
TX path with its destination receiver hidden is the one station you most wanted
to see.

**Who carries this station?** Finding a station on the map is half the
question; the other half is which repeaters carry it. *Include related
repeaters* (under **Map display**, on by default) answers both at once: filter
for a station and every repeater whose pass ranges cover one of its ALERT
addresses comes with it — drawn at full opacity with a **dashed cyan ring**,
listed in the table below with a *via pass range* badge, linked to the station
by a drawn path, and held inside the map extent so none of them is off-screen.
It works the other way round too: filter for a repeater and the field stations
it serves are pulled in the same way. The dashed ring is what separates the two
kinds of result — amber means the filter named it, cyan means a pass range did.
Untick the box for literal matches only.

**Clearing a filter, twice over.** *Clear filters* puts every station back at
full opacity **without moving the map** — you were looking at a region and you
still are. *Clear & zoom out* does the same and re-fits to the whole network.

**Station names.** Names are capped at 60 on screen, because past that they
overlap into noise. The **Station names** control decides when they appear:
*Auto* (the default) draws them once the current view holds few enough to read,
so the national view is clean and zooming into a region brings them in; *On*
forces them for whatever is in view, keeping the 60 nearest the centre and
saying so over the map; *Off* draws none at all. Filter matches are always
named in Auto and On.

**Map and table together.** The map and the station table share the Stations
tab and the one filter pane: a search term, role or network narrows the table to
the matching rows while the map highlights (or, with *Hide stations that don't
match*, drops) the same set. Picking a row pans the map to that station and
opens its pin, so the list and the map never disagree about which site is being
looked at.

**Two panes, two scrollbars.** The filter pane and the map/table column are
each taller than the screen. They scroll separately — reaching a filter at the
bottom of the sidebar no longer drags the map off the top — and the divider
between them drags (or takes ←/→, Home to reset) to re-split the width, which
is remembered between visits. On a phone the two stack and the page scrolls as
one again.

**Signal links and *Kill spaghetti*.** Links are drawn from each field station
to every repeater whose pass ranges cover one of its ALERT addresses, which
across the whole network is 3000-plus lines, many of them running the length of
the country because two distant sites happen to share an address window.
*Kill spaghetti* (on by default) drops any link longer than **Max TX distance**
— 120 km by default, adjustable from 0 to 600 km, which is the range a VHF hop
plausibly covers. The pane says what it is removing ("1938 links drawn · 1203
over 120 km hidden"), so a link that vanished is never a mystery. Untick it to
see every path however long, at any distance.

Each link is drawn twice — a wide white casing underneath and the coloured line
on top — so it stays legible over satellite imagery and topo shading, where a
single thin orange line disappears. **Link opacity** fades the pair together
when the lines are burying the pins they are meant to explain.

**Draw & measure.** A sketching layer over the network map, for the picture
that goes into an email or an incident note: **pins**, **lines**, **circles**,
**rectangles** and free **text annotations**. Every shape can be drawn by
clicking on the map — click the circle's centre then its radius, click opposite
corners of a rectangle, click each corner of a line and double-click (or
*Finish*) to end it — *or* typed in as coordinates and real-world dimensions:
a centre and a radius in km, a centre and a width × height in km, a start point
and either a second coordinate or a bearing and distance. Either way it reduces
to the same few numbers, which the pane lists and lets you edit, so a circle
dropped roughly by hand becomes exactly 25.0 km by typing over its radius.

Shapes carry their own measurements on the map — length and bearing for a
two-point line, radius and area for a circle, width × height and area for a
rectangle — which is the measuring half of the tool: drop a line between two
sites to read off how far apart they are and on what bearing. *Show
measurements on the map* turns the labels off for a cleaner clipping. While a
tool is armed the cursor is a crosshair and clicks pass through the station
pins to the map underneath; Esc cancels the shape in progress, and Esc again
puts the tool away.

**Snap to stations.** On by default. A click within about 15 px of a station
pin lands on that station's exact coordinates rather than wherever the cursor
happened to be, so a path drawn between two sites really does start and end on
them. The station under the cursor is ringed while a tool is armed, so you can
see whether the next click will snap. A snapped shape is named after its
stations in the draw list — *Mt Stuart → Durikai · 42.1 km @ 073°* rather than
two lat/lon pairs — and remembers which stations they were. The threshold is in
screen pixels, not kilometres, so snapping behaves the same at the national
view and at street level. Untick *Snap to stations* for the times when the pin
is the correct location and the station is not; typing over a shape's numbers
also releases it from whatever it was snapped to.

**Colour.** Six presets that stay legible on street, topo and satellite tiles,
plus the browser's own colour picker for anything else. The chosen colour
applies to new shapes, and each shape keeps the colour it was drawn in.
Changing the colour while a shape is selected recolours that shape. The choice
is remembered across reloads; the shapes are not.

**Nothing is saved.** The drawings survive switching tabs and filtering, and
are cleared by reloading the page. There is no export — take a screen clipping
with the operating system's own tool.

**Selecting stations off the map.** Separate from the filters and from the
single station the editor is on: a set you pick by hand. A circle or rectangle
in the draw list carries a **Select inside** button that hands the stations
within it to the selection, so a selection box can be typed to exact dimensions
like everything else in that pane. **Shift-click** (or ctrl / ⌘-click) a pin to
add or remove it one at a time; a plain click still opens the popup. Selection
is additive, so two boxes over two regions give one selection holding both —
shift-click *Select inside* to replace instead of add.

Selected pins take a heavy violet ring, which is neither the amber of a filter
match nor the cyan of a station pulled in by a pass range. While the selection
is non-empty **the table under the map lists exactly the selected stations**,
under a bar saying how many there are. That is a display override, not a change
to the filter: **Clear selection** hands the list straight back to the filter
result. **Export CSV** writes the selected stations out with the columns the
table shows plus their ids. Like the drawings, the selection is session state —
it is not saved, and it is not in the URL.

**Stacked pins.** Where pins land on top of each other — co-sited stations, or
an ACMA site carrying a dozen licensed devices — hovering the stack (mouse) or
tapping it (touch) fans its members out around the stack centre on leader lines,
so each one can be seen and clicked. On touch the first tap fans, the second
opens that pin's popup. Pins snap back when the pointer leaves, the map zooms,
or the markers are rebuilt. Stacks larger than 16 fan their nearest 16 and say
how many were left out; hover only opens stacks of 10 or fewer, so panning
across a zoomed-out map doesn't fan pins constantly.

**My location (mobile).** On touch devices a ➤ button appears under the zoom
control. It is off by default; switching it on shows the phone's GPS position
with an accuracy ring and a cone pointing the way the phone is facing, taken
from the compass where the browser exposes one (iOS asks for permission on the
first tap) and from GPS course otherwise. Leaving the Stations tab stops the watch.

### 3. Pass Ranges
- For any station, identify which repeaters have a pass range covering its AlertIDs
- Show the full hop chain: field → repeater(s) → base station
- Flag stations with no matching repeater (orphaned)
- Flag pass-range gaps (AlertIDs that fall between all windows)
- Display pass-range exclusions (future equipment) alongside inclusions
- One filter box across both tables, taking a station number, an AlertID, part
  of a station name, or a pasted list of them — a repeater is kept when it
  matches, when a station it serves matches, or when its pass ranges cover any
  AlertID in the box
- Matches are marked in place, the same way the Stations tab marks them: the
  repeater name, the station names it serves, and — on an AlertID search — the
  one pass range that actually covers the address, which is what answers *which
  range picked this station up*. Stations that matched are pulled to the front
  of the "first 10" so the mark is visible on rows that were kept because of a
  station 80-odd names down the list
- Every row links through to that station on the Stations tab

A station is only treated as a repeater when it carries pass ranges saying which
AlertIDs it forwards; entries flagged `repeater` with no pass-range block at all
are field stations that were mis-tagged during the metadata import.

### 4. Filtering & Exploration

The **Filters** pane on the Stations tab drives the map and the table together.
It is built from whatever `stations.json` holds, so every option carries the
number of stations behind it and nothing is offered that no station uses:

| Block | Filters on | Control |
|-------|-----------|---------|
| Search | name, station number, ALERT address (numeric queries match addresses from the start) — one term or a pasted list | text box that accepts a paste |
| Station type | `roles[]` — field / repeater / base / satcom | tick boxes |
| Sensor type | every sensor type present in the file — rainfall, water level, battery, water quality, … | tick boxes, plus *must have all ticked types* for "rain **and** level" |
| Radio network | `radio_network_ids[]` | tick boxes |
| Region | the region of the station's catchment | tick boxes |
| Basin & council | `basin` and `lga` | dropdowns |
| Data completeness | missing lat/lon, missing ALERT address, disabled stations | dropdowns |

Blocks combine with AND (a repeater **and** on Mt Stuart **and** measuring
rainfall); options inside one block combine with OR.

**Partly-populated data is included, not hidden.** Most stations have no radio
network recorded and two thirds have no catchment, so each tick-box block ends
with a *Not recorded yet* bucket holding exactly those stations. It is ticked
like any other option, which means the default view is the whole network — every
station, every region, mapped or not — and nothing disappears until you
deliberately untick that bucket. Each block shows its state (*All*, *None*,
*3 of 15*) in its header, so a collapsed block can never be quietly filtering
the list; *Reset* at the top of the pane clears the lot.

Hovering a row reveals **only**, which narrows to that one value in a click
instead of un-ticking the other fourteen.

**The table says where the term landed.** Which rows matched is only half an
answer — "491" can be part of a station number, the start of an ALERT address
or a run inside a name, and the row on its own doesn't say which. The matched
characters are marked in amber, the same colour the map rings a matching pin
with, and follow the search's own rules exactly: a substring anywhere in the
name or station number, and only the *leading* digits of an ALERT address
(6128 is found by "61", never by "12"). So a station listed with
`54`**`491`**`3` under Stn # and nothing marked under AlertID is there for its
number, not its addressing.

**Pasting a list into the search box.** The box takes a list, not just one
term, so the addresses coming in on a telemetry log can be copied and dropped
straight in to see where those sites are on the map. Commas, semicolons, pipes,
tabs and new lines all separate — a spreadsheet column, a CSV row and a log
excerpt all work as pasted — and a run of bare numbers separated by spaces
splits too, since `6128 6129` is two addresses while `Mt Stuart` is one name.
Terms combine with OR. The box is a `<textarea>` (a single-line `<input>`
strips the line breaks out of a pasted column, gluing `6128` and `6129` into
`61286129`) that opens one line tall and grows with the paste.

Under it, the pane reports **which pasted terms are in no station on file** —
"7 search terms · 2 not in this database: 999991, 999992". A list that quietly
comes back short is not an answer to "where are these stations?". The Pass
Ranges filter box takes the same lists, and matches a repeater whose pass
ranges cover **any** of the pasted addresses.

### 5. Radio Mobile Export
Generate the complete set of CSV files required by Radio Mobile software from the JSON data:

| File | Contents |
|------|---------|
| `MegaNet.csv` | Master config (version, map paths, file includes) |
| `MegaNet_Network.csv` | One row per repeater with propagation parameters |
| `MegaNet_Unit.csv` | All selected stations with coordinates and display settings |
| `MegaNet_System.csv` | Transmitter/receiver system specs |
| `MegaNet_NetData.csv` | Network membership matrix (antenna heights, system IDs, roles) |

Export is scoped to the current filter selection so users can generate per-catchment or per-network RM projects.

### 6. ALERT Address / BitFlipper Tool (Integrated)
- Input an ALERT decimal address and see its bit-flip variants; the results,
  table and map update live in the background as you type (the address field
  keeps focus).
- **User-selectable bits to flip** — flip 1 bit (16 variants) up to N bits
  (all `C(16, N)` combinations). Large expansions are guarded with a
  "show only matched addresses" toggle and a render cap.
- Cross-references every variant against the station database and shows the
  matched **Station(s)**, **Sensor** type, **Sensor ID** and open **Repeater(s)**.
- **Open ARRO graph** link — builds a Contrail/ARRO URL (7-day window,
  Brisbane timezone, `devices[]=db_id|device_id`) for the matched sensors, with
  a configurable base URL.
- **Sensor-type filter** scopes both the results table and the ARRO link.
- Map of matched field stations, their bit-flip labels and the repeaters open
  to them.
- Replaces the standalone `BitFlipper.html`.

### 7. ALERT / ERTS Packet Decoder & Encoder (Integrated)
Ported from the standalone [ALERT_PACKETS](https://github.com/cdomotor-g/ALERT_PACKETS) tool and
available on the **ALERT Packets** tab. Based on the Bureau of Meteorology *ERTS Data Formats*
specification (July 2003).

- **Decode** — paste a 40-bit framed message, a 32-bit payload, or 8-digit hex and it is decoded
  against every known format (ABF, BCC Extended Check, EAF, EIF). Check bits and CRC/FCS are
  validated, framing polarity is detected, and the format that passes everything is highlighted as
  the best match. A colour-coded bit map shows which bits belong to which field (hover a field row
  to highlight its bits).
- **A2C** — a fifth layout, offered for 32-bit input only: the four-byte form the same address and
  value take inside an ALERT2 concentration payload, as delivered by an ELPRO ERT-A2. No framing and
  no CRC — its integrity claim is a status byte that reads 0 on every valid record. Whole serial
  lines are decoded on the ALERT2 / ERT-A2 tab; this page decodes one reading at a time.
- **Encode** — pick a format, enter the sensor ID and raw value(s), and get the message back
  (40-bit framed, 32-bit payload and hex) with CRC/FCS computed automatically. ABF, BCC, EAF and EIF
  only; A2C is a decode-side layout.
- **Station names** — decoded ALERT addresses are matched against the loaded MegaNet station
  database first (shown with a *MegaNet* badge), then against the bundled national address file
  `data/All 2021 Working 2.txt`.
- Spec reference: `docs/BOM spec erts_data_formats_doc.pdf` (bundled).

### 8. Network Maps Navigator (Integrated)
Ported from the standalone `ALERT Map Launcher v2.html` (now removed) and
available on the **Network Maps** tab. Browses the bundled Radio-path PDF maps
by region, and — new — suggests the relevant map(s) for any station.

- **Queensland basin map** — a clickable SVG of the state's drainage basins.
  Click a basin (or a region chip) to filter the map list to that region;
  basins are colour-coded by region.
- **Region / sub-region / file navigation** — the same catalogue as the legacy
  launcher (Far North, Mackay/Whitsundays, Burdekin/Townsville, Central QLD,
  Wide Bay/Burnett, SE QLD, West/South West, plus an NSW Border group). The
  three NSW repeater maps, previously mislabelled, are corrected to their real
  filenames.
- **Embedded viewer** — opens each `.pdf` in an inline frame (or `.jpg`/image
  maps as pictures) with prev/next and an "open in new tab" link.
- **Station-aware search** — type a **station name**, **ALERT ID**, or **site
  number** and the tool lists matching stations with their suggested maps.
  Suggestions are ranked from three signals:
  1. the station's `radio_network_id` → the "Network to X" / met-office map it
     belongs to (authoritative, where a network id is set);
  2. a **georeferenced point-in-basin test** — the station's coordinates are
     projected onto the basin SVG and the containing catchment → region → map
     is found (approximate, see below);
  3. free-text keyword match against each map's catchment / town aliases.
- Map data (catalogue, basin geometry, georeference) lives in `maps-data.js`,
  loaded before `app.js`. The map browser works even before `stations.json` is
  loaded; only the station suggestions require the dataset.

> **Data sufficiency for station→map search.** The station dataset currently has
> **no catchment or council/LGA fields**, and only ~88 of 1 154 stations carry a
> `radio_network_id`. Every station does have coordinates, so map suggestions are
> derived at runtime by projecting each station onto the Queensland basin polygons
> (`QldBasin_2009Nov_reduced.svg`). The projection is a least-squares affine fit
> (mean ≈ 34 km) — good enough to *suggest* a catchment/region, but too coarse to
> store as authoritative data, so per-station `catchment_ids` are **not** written.
> `stations.json → catchments[]` is now populated with the 76-basin QLD vocabulary
> (name, basin number, region) so the schema and filters are ready. **Roadmap to
> make search exact:** (a) add an `lga` field and populate it from an authoritative
> QLD LGA boundary set; (b) populate `catchment_ids` from official basin boundaries
> (or from the runtime detection, reviewed near basin edges); (c) backfill
> `radio_network_ids` for the remaining stations.

### 9. Serial Monitor (Live Serial Ingestion)
Connect physical serial devices to the computer's COM ports and stream their
output live, on the **Serial Monitor** tab. Built on the browser's
[Web Serial API](https://developer.mozilla.org/docs/Web/API/Web_Serial_API).

- **Multiple simultaneous connections** — click *+ Add connection* to spin up as
  many connections as you have ports. Each is an independent card with its own
  port, settings and display, all reading at once.
- **Per-connection serial settings** — choose the COM port (via the browser's
  native port chooser), then set baud rate (with a datalist of common rates),
  data bits (7/8), parity (none/even/odd), stop bits (1/2) and flow control
  (none/hardware). The last-used settings are remembered in `localStorage` and
  pre-fill the next new connection.
- **Three display modes** per connection:
  - **ASCII text** — bytes decoded as UTF-8/ASCII and split into lines on CR/LF.
  - **Hex dump** — raw bytes as an offset + hex + ASCII dump (16 bytes/row), for
    inspecting binary framing.
  - **ALERT decode** — every 4 bytes are decoded as a 32-bit ALERT payload
    (ABF/BCC/EAF/EIF) using the same codec as the ALERT Packets tab, showing the
    matched format, sensor ID, value and the station name (cross-referenced to
    the loaded MegaNet database and the bundled national address file). A
    *Resync* button drops a byte to shift frame alignment when a stream isn't
    4-byte aligned, and each decoded frame links through to the full ALERT
    Packets decoder. *(ALERT2 support is planned.)*
- **Live controls** — Pause/Resume, Clear, Save log (download the scrollback as
  text), optional timestamps and autoscroll, byte/line/frame counters with a
  live throughput reading, and a send box (with selectable line ending) to talk
  back to the device.
- **Background capture** — connections live outside the page's re-render cycle,
  so reads continue while you're on other tabs; the log is repainted from a
  capped scrollback buffer when you return.
- **Requirements** — Web Serial needs a Chromium browser (Chrome/Edge/Opera)
  served over **https** or **localhost**; the tab shows a clear notice in
  unsupported browsers or insecure contexts.
- **Managed / work computers** — enterprise policy can block Web Serial, in which
  case the browser rejects the port picker *instantly without showing it*. The app
  detects this (an instant rejection can't be a human cancelling the dialog) and
  shows targeted advice; [`docs/serial-help.html`](docs/serial-help.html) has a
  ready-to-send IT request with the exact Chrome/Edge policies
  (`SerialAskForUrls`, or `SerialAllowUsbDevicesForUrls` to pre-approve a device
  with no picker at all — pre-approved ports show up under *"Previously allowed"*).

### 10. Dark / Light Theme
- Toggle between dark and light modes
- Preference persisted to `localStorage`

### 11. Radio Network Management
- Named radio network clusters (typically named after the primary repeater or ingest point)
- Assign stations and repeaters to one or more networks
- Select networks to scope all views and exports to that cluster
- "Select all" / "Clear all" shortcuts

### 12. Station Detail Panel
Side panel or modal showing full station record:
- Name, number, coordinates, elevation
- All AlertIDs with sensor type labels
- Radio network memberships
- Repeater pass ranges (visual range bars)
- Matched field stations (if repeater)
- Matched repeaters (if field station)
- Satcom details if applicable
- Direct link to ARRO graphs for each AlertID

### 13. In-App Bug / Idea Reporter
The **🐞 Report a Bug** button in the header lets any user flag a problem or
suggestion without leaving the app. Because MegaNet is a static GitHub Pages
site with no backend (and nowhere safe for an API token), the reporter gathers
context and opens GitHub's own pre-filled **New Issue** page — the user reviews
it and clicks *Submit new issue*, so the report lands straight on the project
repo. Anyone without a GitHub account can use **Copy report** and paste it into
an email instead.

Each report auto-collects the context that turns a vague "it broke" into
something reproducible, all shown in a **"Preview exactly what will be shared"**
panel before anything leaves the browser:

- Which screen (tab) they were on, and the selected station (if any)
- Whether data is loaded, and the station / network counts
- App build (read from the `app.js?v=` cache-buster), theme, page URL
- Browser, platform, language, window/screen size, online state, timestamp
- **Recent uncaught JavaScript errors** — captured from page load via global
  `error` / `unhandledrejection` handlers (`app.js`), so the actual failure and
  its stack travel with the report even when the user only saw a blank panel

Report type (Bug / Idea / Question) maps to the matching GitHub default label
(`bug` / `enhancement` / `question`). Long reports that would exceed GitHub's
pre-filled-URL limit are copied to the clipboard automatically so nothing the
user typed is lost.

### 14. Collapsible Side Navigation
The tabs are a left-hand rail, grouped under headings, because a flat row of
eleven buttons said nothing about how they relate — and wrapped to a second line
on a narrow window.

| Group | Tabs |
| --- | --- |
| **Network** | Stations · Network Maps · Networks · Pass Ranges |
| **Radio investigation** | RF Environment · RF Changes · Interference Workbench · Bit Flipper · Network View · ALERT Packets · ALERT2 / ERT-A2 · Serial Monitor |
| **Data & admin** | ARRO Launcher · ARRO Data · Export |

The grouping is the point of the second row: RF Environment, RF Changes, the
Workbench and Bit Flipper are one investigation approached four ways, and
nothing in a flat bar ever said so. The packet tools joined them rather than
keeping a "Live tools" heading of their own — reading what a station actually
transmitted is part of that same investigation, and the split only ever cost a
second scan of the sidebar to find the decoder.

- **Collapses to an icon rail**, not to nothing — icons and tooltips stay, only
  the labels go. The state is kept in `localStorage` under `mn-nav`, alongside
  `mn-theme` and `mn-split`.
- **Starts collapsed under 900 px**, on a first visit only. The Stations tab
  already gives a permanent column to its resizable filter pane; a second
  permanent column on a laptop is one too many. A stored preference always wins.
- **Under 560 px it opens as a drawer over the content**, not as a column beside
  it. 236 px of nav plus a filter pane that won't compress below ~225 px does
  not fit in a 390 px phone at any setting, so the rail keeps its place in the
  layout and the expanded nav floats above — then closes itself once a tab has
  been picked.
- Keyboard-driven: ↑/↓ walk the tabs, and the active one carries `aria-current`.
- `TABS` in `app.js` is the single description of the nav — groups, labels and
  icons — and both the rail and its headings are rendered from it.

Two pieces of geometry hang off this. `--mn-chrome` (which the Stations panes
size themselves against) now measures the header alone, because the nav no
longer sits above the content. And collapsing changes the width of every Leaflet
map on the page, so `invalidateSize()` runs once the width transition has
finished — without it the tiles grey out and click coordinates drift by however
far the rail moved.

### 15. ARRO Deep Links & Launcher
ARRO (Contrail) is where a station's telemetry actually lives. Getting to a
station's admin page used to mean knowing its ARRO site id, and that id is the
one number nobody can guess.

**The two ids, which are not the same number.** Every enriched station carries a
`site` block:

```json
"site": { "db_id": 3318, "number": "541155", "name": "Loudoun Br AL" }
```

`site.db_id` is ARRO's own database index and the only key its URLs accept.
`site.number` is the BoM station number. Confusing the two is the most common
way to end up on the wrong page, which is why the editor labels them *"ARRO's
key, not BoM's"* and *"BoM's"* side by side rather than just printing both.
2,784 of 3,174 stations have a `db_id`; 8,759 sensors carry the `device_id` that
a sensor page also needs.

**Three places the link appears**, all built from the same constants:

- **Map pin popups** — *Open in ARRO admin ↗* under the existing *Show in the
  list below ↓*. Built inside the lazy popup function, so it costs nothing for
  the ~3,174 markers whose popup is never opened.
- **The station editor** — an ARRO block at the foot of the form with the site
  id, station number and ARRO site name as read-only fields, a site admin link,
  and a *Graph last 7 days* link. Per-sensor admin links hang off the existing
  sensor rows rather than forming a second list beside them.
- **The ARRO Launcher tab** — a jump box, grouped under **Data & admin**.

**The launcher's one addition over a standalone bookmarklet is the station
search.** Type a name, a station number or an ALERT address and it resolves to
the site id for you, reusing the same `prepareSearch` / `stationMatchesSearch`
helpers as the Stations tab. It also takes a raw site id for ids not in our
data, an optional device id for the sensor page, and a pasted ARRO URL of any
shape — admin, `devices[]=site|device` graph form, or a bare `3318|2` pair — from
which it reads the ids and shows what it found before you commit to it. Enter
opens the most specific page the boxes describe. Recents live in `localStorage`
under `mn-arro-recent`, deduped on the (site, device) pair so re-opening a page
reorders rather than accumulates.

- **Stations without a `db_id` degrade explicitly.** The popup omits the link
  rather than rendering a dead one; the editor says *"No ARRO site id
  recorded"* and explains where the id comes from; the launcher's search lists
  the station with *"none recorded"* in the site-id column instead of silently
  dropping it.
- **One host, set in one place.** `ARRO_HOST` and the three path constants live
  together at the top of `app.js`. The Bit Flipper's *ARRO base URL* box is
  still the only control, and its host now drives every ARRO link in the app —
  the box says so, and a base that won't parse falls back to the default rather
  than producing a broken link.
- The launcher works with no `stations.json` loaded — only the search needs it,
  and it says as much instead of showing an empty box.

One thing this shook out: the app had **no `a` rule at all**, so every link fell
back to the browser's `#0000EE` and, once followed, `#551A8B` — two shades of
near-black on a dark panel. Links are now `var(--accent)`, visited included.


### 16. Network View (Ghosting Knowledge Graph)
The Bit Flipper answers "what else could this address be?" one address at a
time. The Network View asks it of the whole file at once and draws the answer:
**ALERT addresses are nodes, and a relationship between two of them is an edge.**
Grouped under **Radio investigation**, next to the Bit Flipper it generalises.

Ported from a standalone `BitFlipper_Network_View` page — a hand-rolled SVG force
layout with no dependencies, its own palette, a full-viewport grid and its
relationships baked into the HTML. Everything about how it *feels* survived the
port; everything about where its data comes from changed.

**Two kinds of edge, deliberately in one graph.**

| | Where it comes from | Direction |
| --- | --- | --- |
| **Computed** | arithmetic — the two addresses are one bit apart | none; XOR is symmetric, so no arrowhead |
| **Confirmed** | observed, with an evidence file behind it | candidate → target, drawn with an arrow |

Keeping them apart in two views would have hidden the only question worth
asking, which is *which bit-adjacent pairs were ever actually seen ghosting*.
An edge can be both, and the export says which. Worth noting: **every one of the
154 shipped confirmed relationships is exactly one bit apart** — the observed set
is a subset of the arithmetic one, which is the bit-flip theory holding up.

**The graph is built from `stations.json`.** `buildSensorIndex()` and the Bit
Flipper's variant logic generalise into a full-file graph: 5,791 nodes over 5,122
distinct addresses, and ~23,700 one-bit-adjacent pairs. A node is one address as
transmitted by *one station* — not one sensor (a site reporting rainfall and
rainfall-increment on the same address transmits one thing) and not one address
(614 addresses are claimed by more than one station, and merging those would
invent a relationship between unrelated sites). The seven duplicated site records
in the file fold together the same way `dedupeMatches()` folds them.

**The confirmed relationships ship as data**, in `data/ghosting-links.json`,
lazily fetched like the ACMA layer rather than baked into `app.js` — they are a
snapshot of an evidence review that happens outside the app. Dropping a links CSV
adds to them; station names and sensor types still come from `stations.json`, so
the CSV only has to say which addresses were observed ghosting into which.

**Filters are generated, not fixed.** The original had four sensor-type
checkboxes; the shipped file has 22 sensor types. `NV_FACETS` is now the single
description of what can be filtered and coloured by — sensor type, station role,
radio network, basin, confirmed cluster — and adding an attribute means adding
one entry, which gives both a filter group and a *Colour by* option.

**Two ways out to the map**, both reusing what the Stations tab already has:

- **One node → *Show on map*** calls `goToStation()`, exactly as the Pass Ranges
  rows do.
- **The visible set → *Show these on the map*** resolves the nodes to station
  ids and hands them to `state.mapSelection` — the selection mechanism the map
  gained for picking stations off it — rather than inventing a second one.

A node that does not resolve to a station in the loaded file is **reported, not
dropped**: it draws grey and dashed, the note under the graph counts it, and its
card says it cannot be mapped. A confirmed relationship pointing at an address
the station file has never heard of is a finding, not noise. Where several
stations claim an address and the link names none of them, the end is left
unresolved rather than attributed to whichever came first.

**It stops when you leave.** The layout runs on `requestAnimationFrame` with a
cooling alpha, so it settles and then stops on its own; `switchTab()` stops it
outright, and the loop re-checks every frame that its tab is still the open one.

**Caps, in the spirit of `MAP_LABEL_CAP` and `BF_MAX_RENDER_ROWS`.** 400 rendered
nodes, and the note says how many matched. The number is set by drawing cost, not
by arithmetic: the force loop measures ~1.3 ms a frame even at several hundred
nodes, while rasterising the edges costs an order of magnitude more. (A spatial
grid was tried for the repulsion and measured *slower* — the Map lookups cost
more than the square roots they save at this size.) Labels are capped by stage
area rather than by a constant, because they hold a fixed size on screen at any
zoom, so what they collide with is the room the pane has.

### 17. Terrain Path Tools (Elevation Profile & Indicative Link Budget)
Two features under the Stations map that both answer *"will this radio path
work?"*, and one module underneath them that neither could exist without:
**ground elevation along a line**, which MegaNet previously had no way to get.

**Terrain, with no backend.** MegaNet is a static page on GitHub Pages, so an
elevation API with a key was never available. Instead `Terrain` fetches
**terrarium-encoded PNG elevation tiles** from AWS Terrain Tiles
(`elevation-tiles-prod`) — open data, no key, `Access-Control-Allow-Origin: *`,
~30 m SRTM over Australia — and decodes them in a canvas:

```
elevation_m = (R * 256 + G + B / 256) - 32768
```

It is the same XYZ scheme `makeBaseLayers()` already fetches base maps on, so the
lat/lon → tile maths is the standard Web Mercator pair and nothing more. Tiles
are cached **decoded**, as `Int16Array` metres rather than RGBA (128 KB a tile
instead of 256 KB, and metre resolution is far finer than the ~30 m the source
actually resolves), under an LRU bounded at 128 tiles ≈ 16 MB. A second profile
over the same country costs no network at all — which is the case for tiles over
an API, since an API would be one rate-limited request per profile with nothing
kept between them.

**Zoom is chosen, not fixed:** the coarsest zoom whose pixels are still finer
than the gap between samples, then backed off if the path won't fit in a 48-tile
budget. Going coarser is the expensive mistake — adjacent samples start landing
on the same pixel, and a ridge narrower than a pixel stops existing. A ridge that
stops existing is a path that reports clear. A 5 km hop lands on z12, a 120 km
hop on z9, and neither pulls hundreds of tiles.

**Failure is loud, and that is the point.** Offline, blocked, rate-limited and
withdrawn-CORS all surface as an explicit failure state, and the profile panel
draws *nothing* rather than a flat line. A flat profile reads as a clear path,
which is the one wrong answer that costs someone a site visit. A single missing
tile leaves a **gap** in the profile rather than being bridged through.

**Datum, declared rather than hidden.** Terrarium heights are above the EGM96
geoid; a station's `elevation_ahd` is Australian Height Datum. Over Australia the
two agree to about a metre — well inside the ~30 m sampling error — but they are
not the same datum and neither is ellipsoidal height. So a snapped station's own
`elevation_ahd` wins for that **endpoint**, tiles only ever supply the ground
*between* the ends, and the panel says so under every profile it draws.

**The elevation profile** appears under the map once a line exists in *Draw &
measure*, and plots ground (with a fixed k = 4/3 curvature bulge folded in so the
line of sight can be drawn straight), the LOS between the two antennas, the **60%
Fresnel zone**, and the stretches where terrain intrudes into it — plus a
plain-English verdict, *clear / marginal / obstructed*. Antenna heights default
from the station's `rm_systems[].antenna_height_m` and the frequency from the
repeater's `rx_mhz`; both are editable, and each box says whether it is showing a
default or an edit. The chart is inline SVG in the manner of `rfStripPlotHtml()`
and `rfcChartHtml()` — no charting library, nothing fetched to draw it.

> **On the Fresnel coefficient.** The first-zone radius here is
> `r1 = 17.32·√(d1·d2 / (f·D))` (km, GHz, metres), not the `8.657` the original
> ticket quoted. `8.657` is the same formula already specialised to the path
> *midpoint* with the total distance as its argument (17.32/2). Using it against
> `d1·d2/(f·D)` would halve the zone everywhere, and a half-size Fresnel zone
> reports clearance that is not there — the one direction this must never err in.

A **multi-leg line is a distance profile only** — no LOS, no Fresnel, and a note
saying why. A dog-leg is not a radio path, and drawing a line of sight across a
corner would describe a path nobody drew.

**The link budget card** takes two points — each independently a station or an
arbitrary point on the map — and itemises the path:

```
EIRP         = tx_power_dbm + tx_gain_dbi − tx_losses_db
FSPL(dB)     = 32.44 + 20·log10(f_MHz) + 20·log10(d_km)
RX predicted = EIRP − FSPL − obstruction_db + rx_gain_dbi − rx_losses_db
Fade margin  = RX predicted − rx_sensitivity_dbm
```

Every term is its own row, signed, and visibly adds up to the received level —
never a single number. Station ends auto-populate from `rm_systems[]` via
`rm_system_id`; **arbitrary ends make relocation studies work**, which is the
reason both ends are independently either kind: drop an end on a hilltop nobody
has been to and see what the path would do. Auto-filled values are all editable
and marked `default` (from the station data), `assumed` (a hypothetical site's
starting figures, which came from nowhere but this code) or `edited`. The
obstruction term is a **single knife-edge diffraction proxy** (ITU-R P.526)
derived from the same profile, shown on its own line and labelled as a proxy; with
no profile for those two points the card says the result is **free-space only**
rather than quietly reporting a clear path. Margin classes are good ≥ 20 dB ·
marginal 10–20 · poor < 10.

**Where the two features disagree, the terrain wins.** A blocked path can still
show a fat margin — one knife edge is the most optimistic diffraction model there
is, and here it is standing in for a ridge *above* the line of sight. So when the
profile says obstructed, the margin row is forced red and reads **Obstructed**
however good the number looks, instead of "Good".

**The disclaimer is part of the feature, not decoration.** A red banner sits at
the top of the card, always visible and never dismissible, and a collapsible table
one click below it lists exactly what this leaves out that Radio Mobile models —
clutter, climate and refractivity, statistical reliability, real antenna
patterns, multipath, polarisation, noise floor. Nearly all of those *reduce*
real-world margin, which is why "indicative" here mostly means **optimistic**:
a good margin is permission to model the path properly, never a result.

---

### 18. ARRO Data (CSV Import, 357 Filter & Plotting)

A tab for looking at what the sensors actually sent. ARRO exports one CSV per
sensor; this reads them in the browser, links each one back to its station, runs
the Bureau's **3-5-7 continuity filter** over it, and draws the result with a
chart built for finding noise rather than presenting a trend.

Nothing is uploaded. Files are read with `FileReader` and stay in the tab.

**The import knows what it is.** ARRO names its exports
`aem_Durikai_AL_541134_Rainfall_541134_0_R_5758.csv`, and the last four
underscore-separated fields are the sensor id `541134.0.R.5758` — the same id
already carried in `stations.json`. Parsing it links the import to its station
without anybody choosing one from a list, and the panel then offers the station
and its ARRO admin page directly. Failing that it falls back to the station
number, and failing that it says plainly that it is not linked.

**Two things in the sample export are worth knowing about**, because both are
silent corruption if you assume them away:

- **Rows are newest-first.** The 357 algorithm is defined over an ascending
  list, so the import sorts — stably, so equal timestamps keep file order.
- **Values over 999 carry an unquoted thousands separator.** `1,613.0` arrives
  as two fields and the row is one wider than the header. The columns either
  side of `Value` are fixed, so the parser anchors head and tail and glues the
  middle back together. 395 of the sample's 14,942 rows need this; a naive
  split silently shifts `Unit` into `Data Quality` for every one of them.

**The filter is the spec's, and its parameters are yours.** Steps 3/5/7, the
2048 rollover ceiling, the four-failure continuity break and the start-continuity
window are all editable and default to the specification. Both components are
implemented as written — Establish Start Continuity and Establish Continuity,
walking the list backwards from the newest reading, with Good / Suspect / Bad
states and suspects promoted or rejected by what comes after them.

**Order matters more than the spec lets on.** A rain accumulator that wraps and
one hit by a corrupt packet both look like a long fall, and the sample is full
of the second kind: 72 mm jumps to 1234 for a single reading and drops straight
back. Detecting rollovers on the raw series reads all 82 of those spikes as
wraps and shifts everything after them by 2048 apiece — an annual total of
6,392 mm at a gauge that actually moved 248. So the spikes go first: the 357
walk removes them with no rollover help, and only then is a fall between two
*surviving* readings trustworthy enough to judge. What makes a fall a rollover
is not its size but the step it leaves behind — `2045 → 2` is a wrap because it
is really a step of 5, while `1976 → 125` would be a step of 197 and is not.
With the offsets known the walk runs once more, so continuity carries across the
seam. On the sample this is the difference between 82 rollovers and none.

**Repeats are not readings.** ARRO re-sends an observation several times — the
sample carries 14,942 rows across 6,111 distinct timestamps. Anything that does
not advance the clock is set aside before filtering (`filterOutOfSyncDate()`).
That leaves one spec-inherent artifact: four re-sends of *one* corrupt packet
satisfy "any four consecutive data form a continuous set" and survive as a
series of their own — twelve readings above 1000 mm do exactly this. A
configurable **minimum gap** collapses them, off by default because it is a
departure from the spec rather than part of it. At 60 s the sample's kept series
becomes a strictly monotone accumulation, with the same 248 mm net.

**Raw is never overwritten.** The parsed arrays are written once at import and
never again; filtering only ever produces a parallel status array. Raw and
filtered are two views of one import, shown separately or overlaid, because a
filter you cannot inspect is worse than no filter. Every rejected reading can be
clicked for its full row and the reason it failed.

**The chart is hand-rolled SVG**, like the rest of the app's charts — no
library. It carries wheel zoom, drag to pan, drag-to-select zoom, an overview
strip of the whole record with the visible window on it, a crosshair with a
hover readout, keyboard pan/zoom, per-series colour and visibility, solo and
fit, light/dark repaint, and SVG/PNG download. Three readings of the data
(value, increment, rate per hour), three chart styles (line, step, points) and
four vertical scales — including **Kept**, which scales to the surviving
readings so a single 2014 mm spike stops flattening a 300 mm trace, and draws
the removals that fall outside as triangles on the top edge rather than hiding
them.

**Scale is handled by drawing pixels, not points.** Each pixel column keeps its
first, minimum, maximum and last value, so a spike survives at any zoom while
the drawn point count stays bounded by the width of the chart. The full series
is kept for filtering and export. Filtering the 14,942-row sample takes ~6 ms.

Exports reuse `csvEscape()` / `dlText()`: **kept** writes the filtered series,
**verdict** writes every row with the filter's decision against it — which is
the artifact to keep when the question is what was thrown away and why.

> The specification is in `docs/` (v2.1, May 2009, and the 1998 first edition),
> along with the sample export used to develop this.

### 19. ALERT2 / ERT-A2 Serial Decoder

Decodes the **ALERT2 ASCII protocol** an ELPRO ERT-A2 writes to its RS232 port,
on the **ALERT2 / ERT-A2** tab. One line per received ALERT2 frame: 24 fixed
fields of receiver metadata, then the frame payload as hex bytes.

```
ALERT2A,1,9999,ELPRO,N,1,2026,6,8,19,10,41.296,0,0,0,0,0,1,0,0,0,7,7,9999,74,64,F0,7E,18,15,00
```

The payload is an ALERT2 *ALERT concentration* element: type byte `0x74`, two
bytes of seconds-since-midnight, then four bytes per reading. Each reading is
the same 13-bit ALERT address and 11-bit value a legacy sensor transmits, packed
into bytes rather than async words:

| Byte | Contents |
| --- | --- |
| 0 | address bits 7–0 |
| 1 | `DDDAAAAA` — value bits 10–8, then address bits 12–8 |
| 2 | value bits 7–0 |
| 3 | status; `0` on every valid record observed |

That last packed byte is the only part of the encoding that is not obvious by
eye — a byte that looks like address is carrying the top of the value too — so
the **Frame anatomy** view draws it bit by bit with the arithmetic spelled out
beside it, above the reading it produced.

**Ingest.** Web Serial is closed off on managed machines, so this reads what an
operator can get today: text pasted from PuTTY, or a session log picked off
disk. PuTTY session banners (including one landing mid-line), terminal
timestamps in front of the frame, lines a narrow terminal wrapped, and a log cut
off mid-frame are all handled and accounted for in the summary rather than
silently dropped. On a Chromium browser the **Watch** button re-opens the same
log on a timer through the File System Access API, which is as close to live as
this gets without a serial port — and the case for opening one.

**Shared ALERT addresses.** An ALERT address is only unique within a region, and
604 of the database's 5,122 addresses belong to more than one station. Every
frame in a capture came through one receiver, so addresses matching exactly one
station fix where that capture is, and an ambiguous address resolves to whichever
candidate is near it — 96 of the 101 shared addresses in the reference capture,
against candidates 1,200 km away. The rest are reported as ambiguous with a pin
to record the answer, because two stations 6 km apart carrying the same addresses
cannot be told apart by anything in the frame, and guessing would be worse than
saying so.

**Clock skew.** The header time is the receiver's own RTC; the payload time comes
from the transmitting network. The summary reports the difference — 12 h 00 m 01 s
on the reference capture, an AM/PM error on the unit — and distinguishes a couple
of seconds of receive latency from a clock that drifted mid-capture.

> Field meanings were established by decoding a 444-frame capture and checking it
> against the same traffic decoded by ELPRO's Ranger software: payload lengths,
> record boundaries, addresses, values and frame times all matched, and 339 of
> the 348 addresses heard matched a station. Fields with no such evidence are
> marked *constant only* in the tab's own field reference rather than guessed at.

---

## Deployment Plan

### Phase 1 — Data Migration (Foundation)
**Goal:** Single JSON file replaces all CSVs with no loss of information.

1. Write a migration script (standalone HTML or Node.js) that reads `ALL_UNITS.csv`, `ALL_REPEATERS.csv`, `MegaNet_Network.csv`, and `MegaNet_System.csv` and outputs a valid `stations.json`.
2. Map existing repeater pass-window columns (up to 8) into the flexible `pass_ranges` array.
3. Map existing `Text` (AlertID) column into `alert_ids.battery` / `.rainfall` / `.water_level` based on naming conventions in the data.
4. Add `roles` inference: entries in `ALL_REPEATERS.csv` → `"repeater"`, remainder → `"field"`.
5. Validate output: every station referenced in `MegaNet_NetData.csv` must appear in `stations.json`.
6. ~~Keep `z_Sensors_…_NATIONAL.csv` as a separate sidecar file.~~ The relevant
   sensor records (type, Sensor ID, ARRO device IDs) are now baked into each
   station's `site` / `sensors` fields in `stations.json`, so the CSV is
   redundant and can be removed.

### Phase 2 — Single-Page Application Shell
**Goal:** One `index.html` with tabbed navigation replacing all three HTML files.

Tabs / panels:
- **Stations** — one page holding the interactive Leaflet map, the filterable
  table of all stations below it (names colour-coded by role, matching the map)
  and a built-in CRUD editor card below the list. The filter pane on the left
  drives the map and the table together
- **Network Maps** — Queensland basin explorer + bundled Radio-path PDF maps, with station-aware search
- **Networks** — radio network cluster management
- **Pass Ranges** — pass-range matching and hop-chain view; rows link through to
  the station on the Stations tab
- **Bit Flipper** — ALERT address tool
- **Network View** — the ghosting graph: ALERT addresses as nodes, bit-flip
  adjacency and observed ghosting as edges; hands its visible set to the
  Stations map as a selection
- **ALERT Packets** — decode/encode ALERT/ERTS telemetry messages (ABF, BCC, EAF, EIF, A2C)
- **ALERT2 / ERT-A2** — decode ELPRO ERT-A2 serial captures (ALERT2 ASCII protocol)
- **Serial Monitor** — live ingestion from physical COM ports (Web Serial), with ASCII / hex / ALERT-decode display
- **Export** — Radio Mobile file generation

Technology: Vanilla JS (no framework), same stack as current `app.js`.

### Phase 3 — Map & Link Visualisation
**Goal:** Full interactive map with signal paths.

1. Render markers by role with distinct icons/colours.
2. Compute pass-range matches at load time; draw polylines for each matched pair.
3. Click station → open detail panel with full record.
4. Filter controls update both the station table and the map simultaneously.
5. Toggle link-line visibility per radio network.

### Phase 4 — Pass-Range Analysis & BitFlipper Integration
**Goal:** Merge BitFlipper functionality into the main tool.

1. Move bit-flip logic and ARRO URL builder into `app.js`.
2. Cross-reference against `stations.json` alert IDs instead of loading the national CSV separately (or load it on demand).
3. Add orphan detection (stations with no matching repeater).
4. Add gap detection (AlertID ranges not covered by any pass window in a network).

### Phase 5 — Radio Mobile Export
**Goal:** Generate RM files from filtered JSON data.

1. Port `buildRmFiles()` from current `app.js` to read from `stations.json`.
2. Add per-catchment and per-network export scoping.
3. Allow user to set the Windows path prefix for RM config (stored in `meta` section of JSON).
4. Validate export: warn if any selected station is missing coordinates or system ID.

### Phase 6 — Editor & Import/Export
**Goal:** Maintain the data without editing JSON by hand.

1. Form-based station editor with validation.
2. Add / edit / delete stations, repeaters, networks, catchments.
3. Import CSV (legacy format) with field-mapping wizard.
4. Export `stations.json` from the browser.
5. Optional: diff view showing what changed since last export.

---

## ACMA RF Interference Layer

The network operates on **151.5 MHz** with the plain ALERT Binary Format, which
has **no error detection over the payload** — a single flipped bit re-attributes
a reading to the wrong station or corrupts its value. Corruption appearing
across many unrelated sites at once points at shared infrastructure — the
repeaters. This layer maps every licensed transmitter in the **ACMA Register of
Radiocommunications Licences (RRL)** that could plausibly be responsible, so an
interference investigation starts from evidence instead of guesswork.

### Using it

- **Stations tab → Map display → "Show ACMA licensed transmitters"**: master toggle, **on
  by default** — the ~1.4 MB core data (threats + sites) is fetched the first
  time the Stations tab opens, not at page load, and untick to drop the layer.
  Under it, *ACMA / RF Environment options* holds the mechanism checkboxes,
  minimum-score slider, current-licences-only, search
  radius, antenna beam wedges and threat links. Transmitters render as
  **squares** (MegaNet stations are circles), coloured by mechanism, capped at
  the top 500 by score. Click one for a summary popup, then *Full details →*
  for the complete card: RF parameters, antenna, site (including ACMA's
  coordinate precision), licence, licensee, advisory notes / special
  conditions, and co-sited devices with IMD partners cross-linked.
- **RF Environment tab**: per-repeater threat summary, sortable candidate
  table with CSV export, a frequency strip plot of every licensed carrier
  around each RX channel, and a corruption-timestamp correlation helper.
- **RF Changes tab**: answers *"did something change on the air near this
  repeater around the date our data went bad?"* — see below.

### Interference mechanisms

| Mechanism | Test | Why it matters |
|---|---|---|
| Co-channel | within 6.25 kHz of a repeater RX | direct collisions / capture |
| Adjacent | within 25 / 50 kHz | splatter raises the noise floor → bit flips |
| Harmonic | transmitter at RX/2 … RX/5 | poorly filtered PA stages |
| IMD3 / IMD5 | 2f₁−f₂ / 3f₁−2f₂ from devices at the **same site** | the "rusty bolt" — prime suspect for repeater-clustered corruption |
| Co-site desense | any strong transmitter at the repeater site, any frequency | front-end overload — the only path by which cellular matters |

Each candidate gets a 0–100 score (mechanism weight × distance × power ×
line-of-sight), with the components shown on the card. Line-of-sight is **not
yet assessed** (`los: null`, factor 0.7); the honest blind spots — amateur
radio, unlicensed/faulty emitters, spurious emissions, non-co-sited mixing,
tropospheric ducting — are documented in the layer's own "?" help panel.

### RF change detection (RF Changes tab)

The symptom this page investigates: a **sudden step in corruption** at some
field stations, consistent with a rise in the receiver noise floor tipping a
marginal-SNR link past the demodulator's decision threshold. The question is
whether an external transmitter was commissioned, upgraded or re-pointed near
the serving repeater around that time. Two complementary views:

- **Retrospective timeline** (works from a single extract):
  `DEVICE_DETAILS.AUTHORISATION_DATE` records when each frequency assignment
  was approved, and it is 100 % populated in the current subset. Pick a
  repeater set and an onset date and the page ranks every nearby authorisation
  in the window by `coincidence = interference score × temporal proximity ×
  co-site bonus`, with CSV export suitable for attaching to an ACMA
  interference complaint. Assignments authorised well after their licence was
  issued are flagged as **variations** — a power increase, added channel or
  re-point on an existing licence.
- **Snapshot diffs** (from the second archived month onward): a single extract
  can never show removals or prior parameter values, so every monthly subset is
  archived under `data/acma-raw/<YYYY-MM>/` and consecutive months are diffed
  into `data/acma-changes.json` — added / removed devices, frequency / power /
  antenna / site / licence-status changes, and new co-tenants at repeater
  sites. Diffs key on `EFL_ID` / `DEVICE_REGISTRATION_IDENTIFIER` (never
  `SDD_ID`, which ACMA documents as varying between extract runs). For every
  added or re-tuned device the tool also recomputes same-site intermodulation
  and reports **which IMD products are new** — one added carrier forms a new
  third-order product with every existing carrier on the mast, and the
  offender is often nowhere near 151.5 MHz itself.

The page also includes a rolling-median **step detector** (paste a per-station
corruption time series; detected onset dates pre-fill the selector) and flags
when all affected stations report through the same repeater — corruption
confined to one repeater's stations is strong evidence for that specific site.

**The archive is irreplaceable.** ACMA publishes a daily snapshot, not a
back-catalogue: a month that is not captured can never be recovered, and
nothing before the first archived month (2026-07) is observable. The monthly
refresh keeps every subset (~7.5 MB each) forever — **never delete a snapshot
directory**. Register dates are administrative: an authorisation is an upper
bound on when interference could have begun, not proof that it did, and the
page words every result as a lead to investigate. The register also cannot see
unlicensed or faulty emitters — the page's help panel lists its blind spots.

### Data pipeline

```
ACMA daily bulk extract (spectra_rrl.zip, ~68 MB zipped / ~580 MB CSV)
  └─ tools/acma_prefilter.py   → data/acma-raw/        (committed, ~7.5 MB)
       ├─ tools/acma_fetch.py  → data/acma-threats.json      (map layer, ~1 MB)
       │                         data/acma-sites.json        (site coordinates)
       │                         data/acma-devices.json      (card detail, lazy-loaded)
       │                         data/acma-dictionaries.json (lookup vocabularies)
       │                         data/acma-timeline.json     (RF Changes timeline)
       │                         data/acma-licence-suggestions.csv (review file)
       └─ tools/acma_diff.py   → data/acma-raw/<YYYY-MM>/    (archived snapshot)
                                 data/acma-snapshots.json    (archive index)
                                 data/acma-changes.json      (diffs + new IMD products)
```

The app only ever reads the generated JSON — no live ACMA calls (the RRL API
requires Digital ID authentication and won't serve CORS). Both tools are
stdlib-only Python 3.8+:

```bash
# with a downloaded extract:
python3 tools/acma_prefilter.py --zip spectra_rrl.zip --stations stations.json --out data/acma-raw
python3 tools/acma_fetch.py --suggest-licences        # reads data/acma-raw, writes data/acma-*.json
python3 tools/acma_diff.py --archive                  # archive this month's subset + recompute diffs
python3 tools/acma_fetch.py --help                    # all flags (radius, tolerances, mechanisms, dry-run)
```

A **monthly GitHub Action** (`.github/workflows/acma-refresh.yml`) downloads
the current extract, reruns the tools (including the snapshot archive + diff)
and opens a PR. In sandboxed
environments without ACMA access, attach the extract to a GitHub Release
(see the `acma-data-*` tags) and fetch it from there instead.

`data/acma-licence-suggestions.csv` matches MegaNet repeater coordinates
against ACMA sites to help backfill `repeater.acma_licence` (only 40 of 178
repeaters have it) — it is a review file, never applied automatically. The
single highest-value data task remains backfilling `repeater.rx_mhz`: the
analysis can only anchor on the 88 repeaters that have one.

### Attribution and conditions of use

Contains data from the Australian Communications and Media Authority,
**Register of Radiocommunications Licences**, licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The extract's usage
conditions additionally prohibit using licensee contact details for
unsolicited commercial electronic messages (*Spam Act 2003*) or telemarketing
(*Do Not Call Register Act 2006*) — this tool shows licensee identity for
interference-coordination purposes only and must not be used as a mailing
list.

---

## Interference Workbench

A single investigation surface (**Workbench** tab): select the stations you
believe are affected and MegaNet assembles the evidence spread across Map,
Networks, Bit Flipper, RF Environment and RF Changes into one argued case. It
is deliberately not a dashboard — it states what it thinks, shows the evidence,
says how confident it is, and names the observation most likely to change the
answer. Every score expands to its inputs and arithmetic.

### The five hypotheses

Five competing explanations are evaluated in parallel and ranked by
explanatory power — the losing hypotheses stay visible:

| # | Hypothesis | Signature in the selected stations |
|---|---|---|
| H1 | Repeater common-mode | affected stations share a repeater path; unaffected ones mostly don't |
| H2 | Geographic / regional | affected stations cluster spatially regardless of routing |
| H3 | Channel-wide | affected stations share an RX frequency across different repeaters |
| H4 | Site-local, independent | no shared path, cluster or channel — separate local sources |
| H5 | Misattribution artefact | "affected" stations 1 address bit apart — data bleeding across IDs |

**H5 runs first**, before anything else is presented: with 13 unprotected
address bits, two "affected" stations whose IDs differ by a power of two may
be one victim and one ghost of the same corrupted packets, which would change
the entire selection. Flagged pairs deep-link into the existing Bit Flipper.

**H1 scoring**: for each repeater, `coverage` (fraction of affected stations
through it) and `specificity` (how well it avoids explaining stations that are
fine) combine as a harmonic mean (F1) into *explanatory power* — so a base
station that everything routes through is correctly demoted rather than
topping the list on coverage alone. Repeaters in series are flagged as a
**chain**, not competing suspects. **H2** uses the same grammar: spatial
tightness versus a network baseline × the affected fraction of stations inside
the cluster. H1 and H2 are confounded (repeaters serve areas), so the
Workbench names the **discriminating stations** — inside the affected area but
routed differently — whose state most changes the answer. **H3** is scored
against each channel's base rate (68 of 88 documented repeaters share
151.5 MHz, so raw sharing is uninformative). **H4** is the residual.

### What it reuses

Bit Flipper address logic (H5), pass-range routing helpers (H1 and the
matrix), the shared Leaflet base layers, the ACMA threat scoring and
transmitter card (suspect list, map squares, frequency strip plot) and the RF
Changes timeline (register events near the candidates around onset). Nothing
loads until the tab is opened.

### Investigations

Cases (affected/known-good sets, onset, symptom) save to the browser by name
and share as a URL — the whole investigation is encoded in the hash
(`#wb&a=…`). Exports: case CSV, a site-visit checklist tailored to the leading
mechanism, and a draft ACMA interference report with the evidence pre-filled
and every inference marked as an inference.

### Education layer

Three tiers, aimed at hydrographers as much as RF engineers: dotted-underline
tooltips on every technical term; a "Why this matters" expander under each
evidence panel; and a concept drawer (slide-over) of field-oriented RF
explainers loaded from `data/rf-concepts.json` — a standalone file so entries
can be extended without touching `app.js`. Every entry states what the
phenomenon *looks like in your data*, not just what it is physically.

### Honesty rules

The Workbench never says "cause" — always "most consistent with" / "leading
hypothesis". Confidence is always shown, confounds are stated
("your affected stations share both a repeater and a location…"), weak or
empty results are reported as findings with a next step, and the blind-spots
panel (shared with RF Changes) lists what no register can see. H1 depends on
pass-range data: 88 of 178 repeaters currently have recorded pass ranges and
~78 % of stations with ALERT ids fall inside at least one — the Workbench
reports, per investigation, how many affected stations have no routing and
degrades honestly when they don't.

---

## Design Principles

- **No build step.** Open `index.html` directly in a browser; no Node, no bundler, no server required.
- **Single source of truth.** `stations.json` is the only data file the application depends on at runtime.
- **Flexible schema.** `pass_ranges` and `alert_ids` are arrays/objects, not fixed columns, so new equipment types don't require schema changes.
- **Additive roles.** A station can be a field station, a repeater, and a base station simultaneously; roles are not mutually exclusive.
- **Separation of concerns.** Data (`stations.json`) is kept separate from logic (`app.js`) and presentation (`styles.css`, `index.html`).
- **Progressive enhancement.** Each phase delivers a working tool; later phases add capability without breaking earlier work.

---

## License

MIT © cdomotor-g, 2026
