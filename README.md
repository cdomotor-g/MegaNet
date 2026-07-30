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
│   └── BOM spec erts_data_formats_doc.pdf   (ERTS Data Formats spec, ALERT Packets tab)
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
| `sensors` | `object[]` | Every ALERT-addressable device at the site, sourced from the national sensor export. Each has `alert_id`, `type` (e.g. `"Rainfall"`, `"Water Level"`, `"Battery"`), `sensor_id` and `device_id` |
| `repeater.pass_ranges` | `object[]` | Unlimited; each has `low` and `high` inclusive bounds |
| `repeater.exclusions` | `object[]` | Reserved for next-generation equipment; same `low`/`high` structure |
| `rm_system_id` | `number` | References the Radio Mobile system spec (power, antenna, etc.) |
| `satcom.enabled` | `boolean` | Marks stations with satellite comms capability |
| `catchment_ids` | `string[]` | References `catchments[].id`. **Not yet populated** — the Network Maps tab derives a station's catchment at runtime from its coordinates (see feature 8). Populate this to make map suggestions exact. |

> **`site` / `sensors`** are the authoritative sensor records — the `alert_ids`
> labels are kept for backward compatibility but can be mislabelled (an address
> filed under `rainfall` may actually be a Water Level device). The Bit Flipper
> reads `sensors` for its Sensor / Sensor ID columns and ARRO links. These fields
> were imported from `z_Sensors_with_Database_IDs_by_View_NATIONAL.csv`, which is
> now redundant and has been moved to `archive/`.

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
- Filter map display by role, catchment, radio network, or enabled status
- Toggle individual link lines on/off
- Leaflet.js with a base-map picker (top-right): OSM-Topo (default), OpenStreetMap, or Satellite

**Reading the map.** Every pin carries a white ring so it separates from the
base map and from its neighbours; ACMA transmitter squares carry the same ring.
The filter box **highlights instead of hiding**: all pins stay on the map,
matches get an amber ring, their names appear underneath, and the map zooms to
the extent of the matches so every one of them is on screen. Typing narrows the
highlight live. Labels are capped at the 60 matches nearest the middle of that
extent (the sidebar says when the cap is in effect). Tick *Hide stations that
don't match* for the old subtractive behaviour.

**Map and table together.** The map and the station table share the Stations
tab and the one filter pane: a search term, role or network narrows the table to
the matching rows while the map highlights (or, with *Hide stations that don't
match*, drops) the same set. Picking a row pans the map to that station and
opens its pin, so the list and the map never disagree about which site is being
looked at.

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
- One filter box across both tables, taking a station number, an AlertID or part
  of a station name — a repeater is kept when it matches, when a station it
  serves matches, or when its pass ranges cover the AlertID typed
- Every row links through to that station on the Stations tab

A station is only treated as a repeater when it carries pass ranges saying which
AlertIDs it forwards; entries flagged `repeater` with no pass-range block at all
are field stations that were mis-tagged during the metadata import.

### 4. Filtering & Exploration
- Filter stations by:
  - Role (field / repeater / base / satcom)
  - Catchment
  - Radio network cluster
  - AlertID or AlertID range
  - Enabled/disabled status
  - Sensor type (rainfall only, water level only, combined)
- Search by station name or station number
- Multi-select filters with AND logic

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
- **Encode** — pick a format, enter the sensor ID and raw value(s), and get the message back
  (40-bit framed, 32-bit payload and hex) with CRC/FCS computed automatically.
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
- **ALERT Packets** — decode/encode ALERT/ERTS telemetry messages (ABF, BCC, EAF, EIF)
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

- **Stations tab → Filters → "Show ACMA licensed transmitters"**: master toggle, **on
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
