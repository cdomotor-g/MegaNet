# Flood-Net — Radio & Satcom Network Station Tool

**Live app:** https://cdomotor-g.github.io/MegaNet/

> **The app is Flood-Net.** The repository keeps the project's earlier name, MegaNet, and so do a few
> things nobody reads as a name: the `meganet` database schema, browser storage keys, MQTT topics
> (`meganet/v1/…`), the Cloudflare Worker and R2 bucket, and the Quansheng radio's station-table tag.
> Anything a person reads — the app, its downloads, the agent API and these docs — says Flood-Net.

Flood-Net is a browser-based tool for managing and visualising a radio and satellite communications (satcom) network. It consolidates station data, repeater pass-range analysis, Radio Mobile export, and interactive mapping into a single self-contained HTML application backed by one JSON data file. No server, no build step — just open the file in a browser.

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
(loads `styles.css`, `maps-data.js`, then the app's scripts in order) backed by
the one **`stations.json`** data file. Everything else is organised into folders
so the root stays clean.

The application logic was one 22,500-line `app.js` until
[#132](https://github.com/cdomotor-g/MegaNet/issues/132) split the foundation and
the entry point out of it,
[#133](https://github.com/cdomotor-g/MegaNet/issues/133) took ten self-contained
modules out into a file each, and
[#134](https://github.com/cdomotor-g/MegaNet/issues/134) took fourteen more, and
[#135](https://github.com/cdomotor-g/MegaNet/issues/135) finished the job by
wrapping RF Changes and the Interference Workbench — 111 loose top-level
functions between them — in namespaces first, then moving those out too.
`app.js` is 3,724 lines now, and what is left in it is the app shell, the
Stations tab and RF Environment.
They are still plain classic scripts sharing one global scope — no modules, no
bundler, no build step — so the split is a question of which file a function
sits in and nothing else. **The order they load in is the contract**, stated at
the top of `index.html`; later work adds files to that list rather than
reordering it.

Only `init.js` runs at load. Everything above it declares, which is what makes a
module movable to its own file without its position mattering — and what every
split so far has been able to prove byte-for-byte rather than assert.

The station list now lives in Postgres as well, and that is where the app reads
it from by default — `stations.json` is the export, the offline fallback, and
still the schema this document describes. The database returns *the same
document*, so nothing below changes: see
[**Where the station list comes from**](#where-the-station-list-comes-from).

```
MegaNet/
├── index.html              ← single entry point; its script order is the contract
├── core.js                 ← constants, TABS/HELP, state, shared utilities
├── app.js                  ← the app shell, the Stations tab, RF Environment
│                             ↓ the two #135 wrapped and lifted out, loaded
│                               immediately after app.js
├── rf-changes.js           ← RfChanges — RF Changes tab (ACMA register timeline & diffs)
├── workbench.js            ← Workbench — Interference Workbench tab (the case, argued)
│                             ↓ the fourteen modules #134 lifted out, one each
├── mem-meter.js            ← MemMeter  — the memory bar, and giving memory back
├── auth.js                 ← Auth      — Supabase sign-in, and the access token
├── map-draw.js             ← MapDraw   — draw & measure over the Stations map
├── path-profile.js         ← PathProfile — elevation profile, and the path physics
├── link-budget.js          ← LinkBudget — fade margin between two points
├── pass-ranges.js          ← Pass Ranges tab
├── bit-flipper.js          ← Bit Flipper tab
├── network-view.js         ← NetworkView — Ghosting Graph tab (the knowledge graph)
├── arro-launcher.js        ← ARRO Launcher tab
├── arro-data.js            ← ArroData  — ARRO Data tab (CSV import, 357 filter, plots)
├── datastore.js            ← the browser's PostgREST client: ping, reads, writes, snapshot
├── export.js               ← Export tab
├── station-editor.js       ← the station editor card on the Stations tab
├── inspections.js          ← Inspections — the six paper inspection sheets, digitised
├── maintenance.js          ← Maintenance — Site Maintenance tab, the Council sheet
├── history.js              ← History   — Inspection History tab: past records,
│                             read-only, printable to A4, exportable as CSV
│                             ↓ the ten modules #133 lifted out of it, one each
├── map-rivers.js           ← MapRivers — OSM watercourses under the station pins
├── map-spider.js           ← MapSpider — fans overlapping pins out on leader lines
├── map-locate.js           ← MapLocate — GPS dot, accuracy ring, compass cone
├── map-move-pin.js         ← MapMovePin — drag one station's pin to where the
│                             station is, and save the coordinates
├── station-trail.js        ← StationTrail — the stations looked at this session:
│                             a pill in the map's top row that brings a closed
│                             card back and goes back to any of them
├── station-ar.js           ← StationAR — 🔭 the AR station finder: a phone held up,
│                             the stations the way it faces pinned over the camera's
│                             picture, its compass turned to true north by WMM2025
├── terrain.js              ← Terrain   — ground height from terrarium PNG tiles
├── geoid.js                ← Geoid     — AHD less EGM96 at a point (AUSGeoid2020 and
│                             EGM96, a 0.1° grid in data/): the tiles' heights into AHD
├── digital-twin.js         ← DigitalTwin — the digital twin (in the Stations map, its
│                             settings the side panel's 🧊 pane): one station's ground in
│                             3-D, the station as built, its neighbours and bridges,
│                             a figure for scale, the move-pin mode, a .glb for Blender
├── twin-cadastre.js        ← TwinCadastre — the Queensland cadastre on the twin's
│                             ground: lot boundaries with their lot and plan, and the
│                             road reserve outlined and named
├── flood-stages.js         ← FloodStages — a station's flood classes, AEP levels
│                             and peaks on one ladder in AHD, the colour the twin's
│                             water takes past each, and its rise; levels borrowed
│                             from a nearby station, and the datums they cross
├── photo-meta.js           ← PhotoMeta — what a photo says about where it was taken:
│                             EXIF/XMP in four containers, and the overlay a field
│                             camera app printed on it, read by OCR (also the
│                             Dropbox and Google Drive syncs', under Node)
├── photo-zip.js            ← PhotoZip  — a zip of photos, opened in the browser
├── photo-equipment.js      ← PhotoEquipment — make, model, serial off a photo's labels
├── field-photos.js         ← FieldPhotos — Field Photos tab (bulk upload, placing,
│                             the library) and the carousel every door opens
├── photo-review.js         ← PhotoReview — the tab's Review panel, equipment
│                             suggestions, the station card's Equipment section
├── station-history.js      ← StationHistory — the station card's History: who
│                             changed what and when, a field or a version put
│                             back; the Admin tab's Deleted stations, restored
├── site-exposure.js        ← SiteExposure — the station card's tides and soils:
│                             tidal water, Water Act limits, coastal hazard areas,
│                             acid sulfate soils, from the State's map services
├── site-land.js            ← SiteLand  — the land at a station or a picked point:
│                             lot, tenure, who holds it, council, address, land use,
│                             from the Queensland cadastre
├── map-photos.js           ← MapPhotos — the Stations map's 📷 pins, a cone each
│                             way the camera faced
├── modal.js                ← Modal     — the shared dialog shell, and confirmDialog /
│                             promptDialog: the app's own questions, in place of the
│                             browser's confirm() and prompt() (#223)
├── toast.js                ← Toast     — how something just went, at the foot of the
│                             window, in place of alert() (#223)
├── packets.js              ← Packets   — ALERT / ERTS codec, and its tab
├── log-follow.js           ← LogFollow — follows a log file as it grows (PuTTY's,
│                             for a computer that blocks Web Serial)
├── alert2.js               ← Alert2    — ALERT2 / ERT-A2 tab
├── network-maps.js         ← Maps      — Radio Path Maps tab (named for the tab, not
│                             the module, so it isn't confused with maps-data.js)
├── serial.js               ← Serial    — Serial Monitor tab (Web Serial)
├── serial-radio.js         ← SerialRadio — its Quansheng ALERT radio dashboard
├── serial-sdr.js           ← SerialSdr — its RTL-SDR card (WebUSB, or a Raspberry Pi's log)
├── sdr-pi.js               ← SdrPi     — the text an RTL-SDR on a Raspberry Pi prints for PuTTY
│                             (both ends: sdr-pi/relay.js writes it, the card reads it)
├── serial-ert.js           ← SerialErt — its ELPRO ERT-A2 card (alert2.js, live)
├── serial-gps.js           ← SerialGps — a USB GPS (NMEA) card; the position for the rest
├── reception-log.js        ← RxLog     — every frame each receiver heard, with position
├── reception.js            ← Reception — the Reception Map tab (who was heard where; the bad repeater)
├── serial-ingest.js        ← SerialIngest — a receiver card as a base station
│                             (posts what it decodes into Flood-Net)
├── serial-viz.js           ← SerialViz — the canvas helpers those cards share
├── quansheng.js            ← Quansheng — the radio firmware's serial protocol codec
├── alert-dsp.js            ← AlertDsp  — the off-air ALERT decoder (runs in a Worker)
├── rtlsdr.js               ← RtlSdr    — WebUSB driver, RTL2832U + R820T/R828D
├── message-log.js          ← MessageLog — Message Log tab (the arrival log:
│                             every message the datastore accepted, filterable,
│                             with a plot-and-map tray and a decode drawer)
├── bug-report.js           ← BugReport — prefilled GitHub issue reporter
├── base-stations.js        ← BaseStations — Base Stations tab (every ingest point's
│                             health; asking a base station that checks in, 0049)
├── health-glance.js        ← HealthGlance — a station's health where people already
│                             look (#218): last heard, its battery and its findings on
│                             its card, each a door into Station Health, and Colour
│                             pins by health on the Stations map
├── site-map.js             ← SiteMap   — Site Map tab (a guide to every other tab,
│                             and the gold line from each to its button in the nav)
├── route.js                ← Route     — where you are, in the address bar: the tab,
│                             the station whose card is up (or Station Health has
│                             open) and the map's view, so a view can be linked to
│                             and back and forward work (#211)
├── pwa.js                  ← Pwa       — registers sw.js for the page's version, and
│                             offers a newer one to a page from the kept copy (#213)
├── offline-tab.js          ← OfflineTab — 📲 Offline & Install: what this device has
│                             kept, getting it ready, installing it in this browser
├── init.js                 ← the only code that runs at load; must stay last
├── sw.js                   ← the service worker: the copy kept for opening with no
│                             signal — the shell, the station list, the sheets' tables
├── manifest.webmanifest    ← installable: Flood-Net, standalone, its icons (assets/)
├── maps-data.js            ← Radio Path Maps catalogue, QLD basin SVG + georeference
├── styles.css              ← the design system, then theme and layout
│                             (tokens at the top; docs/design-system.md is the prose)
├── stations.json           ← the document schema (see below); export + offline fallback
├── migrate.html            ← legacy-CSV → stations.json converter (linked from the app)
├── .nojekyll               ← serve every file verbatim on GitHub Pages
├── AGENTS.md, GEMINI.md,   ← what an AI agent should know here, and how to read the
│   llms.txt                  station data (Copilot's and Cursor's copies are under
│                             .github/ and .cursor/; docs/agent-api.md is the source)
│
├── maps/                   ← Radio-path maps for the Radio Path Maps tab, by region
│   ├── far-north/          │  Barron, Herbert, Tully/Johnstone, Mulgrave, Saddle Mt
│   ├── mackay-whitsundays/ │  Don/Proserpine, Pioneer
│   ├── burdekin-townsville/│  Burdekin, Haughton, Mt Stuart
│   ├── central-qld/        │  Boyne/Baffle, Callide, Central Highlands, Dawson
│   ├── wide-bay-burnett/   │  Fraser Coast, Burnett, Mary, Kanigan
│   ├── se-qld/             │  Albert/Logan, Bremer/Lockyer, Caboolture, Maroochy, …
│   ├── west-south-west/    │  Blackall, Charleville, Warrego, SWRED, Western Downs, …
│   ├── nsw-border/         │  NSW North Coast repeater maps
│   └── thumbs/             │  page-1 thumbnails, one WebP per map (tools/build_map_thumbs.py)
│
├── docs/                   ← reference documents
│   ├── design-system.md                    (tokens, breakpoints, patterns, a11y primitives — #109)
│   ├── datastore-decision.md               (why Postgres on Supabase, and where)
│   ├── access.md                           (who gets in, who may edit, and recovery)
│   ├── ingest-http.md                      (posting readings from a field station — #B5)
│   ├── ingest-mqtt.md                      (topic scheme, broker choice, station credentials — #B6)
│   ├── mqtt-provisioning.md                (standing the broker and bridge up — browser only)
│   ├── message-log.md                      (the Message Log tab — columns, uses, edges)
│   ├── floodwarning-net.md                 (moving the domain to Flood-Net — runbook)
│   ├── agent-api.md                        (station data for AI agents — REST API and MCP server)
│   ├── base-stations.md                    (the Base Stations tab — checking in, what may be asked, team SSH keys)
│   ├── site-exposure.md                    (tides and soils on the station card — rows, sources, limits)
│   ├── site-land.md                        (the land — tenure, council, address — on the station and What is here cards)
│   ├── BOM spec erts_data_formats_doc.pdf   (ERTS Data Formats spec, ALERT Packets tab)
│   ├── Hydrology Raw Data Filtering Program Specification.pdf  (357 filter, v2.1 2009)
│   ├── 357 Filter doco.doc                  (the 1998 first edition of the same spec)
│   └── aem_Durikai_AL_541134_Rainfall_541134_0_R_5758.csv  (sample ARRO export)
│
├── db/                     ← the datastore's schema, as plain SQL
│   ├── README.md                           (how to apply, and the rules — read first)
│   └── migrations/                         (numbered, forward-only, run with psql)
│
├── worker/                 ← the Cloudflare Worker in front of the site (wrangler.toml)
│   ├── index.js                            (/api/db — the database proxy; /api/session — the gate's sign-in)
│   └── api.js                              (/api/v1, /api/mcp — the read-only agent API and MCP server)
│
├── bridge/                 ← the MQTT → Flood-Net subscriber (#B6; Node, one dependency)
│   ├── README.md                           (running it, its config, and what its logs mean)
│   ├── index.js, src/                      (topics, payload rules, batching + acking, health)
│   ├── test/                               (npm test — unit, plus a real broker end to end)
│   ├── deploy/                             (mosquitto.conf + ACL examples for the self-hosted case)
│   └── tools/publish-sample.js             (a test client, for proving the path from a laptop)
│
├── sdr-pi/                 ← an RTL-SDR on a Raspberry Pi, for a PC that cannot reach USB (docs/sdr-pi.md)
│   ├── relay.js                            (rtlsdr.js + alert-dsp.js under Node; readings out on a serial port, commands in)
│   ├── dsp-worker.js                       (the decoder's thread)
│   ├── install.sh                          (one command on the Pi: usb package, udev, the serial link, the service)
│   └── usb-gadget.sh                       (a Pi 4/5's USB-C port as a USB serial device — a COM port, no driver)
│
├── logger/                 ← the base station's side of ingest, over BOTH paths (CRBasic)
│   ├── README.md                           (loading it, commissioning it, what its diagnostics mean)
│   ├── base-station-http.CR300             (ERT-A2 ALERT2 ASCII off RS-232 → ingest_http() AND the MQTT bridge, with store-and-forward)
│   └── meganet_token.example.txt           (the token file's shape — the secret is never in the program)
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
│   ├── ghosting-links.json           (observed candidate → target ghosting links, Ghosting Graph)
│   ├── wind-regions-as1170-2021.geojson  (AS/NZS 1170.2 wind regions — GA eCat 146359, CC-BY 4.0, ~1 km simplified)
│   │                                     (road parcels are NOT bundled — MapRoads queries the live Qld cadastre per view)
│   └── rf-concepts.json              (RF explainer entries for the Workbench concept drawer)
│
├── radio-mobile/           ← self-contained Radio Mobile desktop project
│   ├── MegaNet.csv … MegaNet_NetData.csv   (sample export set)
│   └── net1.map / .jpg / .geo / .inf / .kml / .dat   (map, terrain, georeference)
│
├── assets/geo/             ← source geometry (basin SVG is inlined in maps-data.js)
│   └── QldBasin_2009Nov_reduced.svg, Qld Major Streams, queensland-outline, all_2009Nov
│
├── test/                   ← the web app's safety net (see test/README.md, and Testing below)
│   ├── smoke.mjs            (headless Chromium: load, open all 28 tabs, clean console)
│   ├── dup-names.mjs        (no duplicate top-level names across the loaded scripts)
│   ├── inspections.mjs      (the six sheets, against the migration's own seed data)
│   ├── maintenance.mjs      (the Council sheet, against the workbook's filled example)
│   ├── history.mjs          (a saved record read back, against the form that wrote it)
│   ├── help.mjs             (every tab's help entry: real content, links that land)
│   ├── photos.mjs           (field photos: the reader, the OCR, the tab, the map, the twin)
│   ├── photozip.mjs         (zip packs: the reader under Node, then a zip dropped on the tab)
│   ├── photoreview.mjs      (the Review panel, equipment labels, an administrator's decision)
│   ├── exposure.mjs         (the station card's tides and soils, a failed source never "none")
│   ├── twinsite.mjs         (the twin's site: the station as built, neighbours, bridges, the offer)
│   ├── twinpin.mjs          (move pin in the twin's tab, the map's twin and ⛰️ 3-D)
│   ├── trail.mjs            (the stations looked at: the pill, its list, a pick, the twin, a phone)
│   ├── proposed.mjs         (proposed stations: + Propose, the pin and card, who may establish)
│   ├── stationhistory.mjs   (the station card's History and the Admin tab's Deleted stations: who changed what, Restore)
│   ├── basestations.mjs     (the Base Stations tab: the list, a station's panel, what each button sends)
│   ├── fixtures/photos/     (the two Solocator photos the feature was built from, overlays kept)
│   ├── concat-verify.mjs    (byte-exact concat-and-diff, for the app.js split)
│   ├── syntax-check.mjs     (node --check over every script index.html loads)
│   └── package.json         (down here on purpose — the app itself still has no build step)
│
├── tools/                  ← command-line helpers (needs Python; see tools/README.md)
│   ├── check_ingest.sql     (psql: prove the telemetry contract — 48 checks, rolls back)
│   ├── check_mqtt.sql       (psql: prove the MQTT bridge's database half — 39 checks)
│   ├── check_inspections.sql (psql: prove the inspection schema — 90 checks, rolls back)
│   ├── check_field_photos.sql (psql: prove the field photo doors (0035) — 83 checks, rolls back)
│   ├── check_photo_review.sql (psql: prove the upload log, the administrator and the equipment register (0036) — 113 checks, rolls back)
│   ├── check_proposed_stations.sql (psql: prove proposed stations and who may add or establish one (0039) — 40 checks, rolls back)
│   ├── check_tower_height.sql (psql: prove a tower's platform height, 3.0 or 4.5 m, and who may record it (0040) — 18 checks, rolls back)
│   ├── check_flood_peaks_from.sql (psql: prove a station taking its flood history from another (0041) — 23 checks, rolls back)
│   ├── check_station_history.sql (psql: prove the station history, who it names and the way back (0056) — 50 checks, rolls back)
│   ├── check_base_stations.sql (psql: prove base stations checking in, being asked, and the team keys (0049) — 48 checks, rolls back)
│   ├── field-photos/        (the Dropbox and Google Drive → Flood-Net photo sync, run by field-photos-dropbox.yml and field-photos-gdrive.yml)
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

> **Map file resolution.** The Radio Path Maps catalogue in `maps-data.js` keeps the
> **bare filename** as each map's display name and lookup key; `MAPS_DIR` +
> `REGION_DIR` build a `FILE_PATH` table (filename → `maps/<region>/<file>`) that
> `app.js`'s `encPath()` uses to load the file. To add a map, drop it in the right
> `maps/<region>/` folder, add its filename to `MAP_CATALOG` (and `FILE_INFO`), then
> run `python3 tools/build_map_thumbs.py` for its thumbnail and page facts —
> `npm run tabs` fails on a catalogued map without one.

---

## Where the station list comes from

The app tries three sources, in order, and **says on screen which one it used** —
the counts in the header are followed by `· from the datastore` or
`· from stations.json (GitHub)`, and the Export tab's **Data source** panel gives
the detail: round-trip time, the date the data itself carries, and — after a
fallback — what went wrong and a button to retry the database.

| | Source | When |
| --- | --- | --- |
| 1 | **The datastore** — `GET /rest/v1/rpc/stations_doc` | Always tried first |
| 2 | **`stations.json` from this site** | The datastore did not answer |
| 3 | **`stations.json` from GitHub raw** | Neither of the above (e.g. the app is served from somewhere without the file) |

**Load from this device** (a `stations.json` file) is always available, on the
**🛠️ Admin** tab with **Load from GitHub**, the Data source panel and the snapshot button.
Working from a laptop with no network is a real part of this job.

The fallback is not padding. A free-tier Supabase project pauses after about a
week of inactivity, and a paused project *fails* the read rather than slowing it
down — Flood-Net is exactly the burst-shaped tool that gets paused. Falling back
turns that into "yesterday's data" instead of "no data", which is only acceptable
because the header then says so.

### It is the same document either way

`meganet.stations_doc()` returns the JSON described below — not tables, not a
different shape. Everything downstream of `loadJson()` in `app.js` is unchanged
and cannot tell the difference, which is the entire design: the database is
normalised properly, and a view reassembles the document the app already parses.

That claim is checked rather than asserted:

```bash
psql "$MEGANET_DB_URL" -tAc 'select doc from meganet.stations_json' > /tmp/doc.json
python3 tools/check_stations_doc.py /tmp/doc.json
```

Every key, every array element and every value, compared against `stations.json`
— including the difference between a key that is absent and one that is present
and null, which the app tests for. See `db/migrations/0002_stations.sql`.

### Getting the data in

The database can load itself from the repo — one line in the Supabase SQL editor,
with nothing installed locally:

```sql
select meganet.load_stations_from_url();
```

It fetches `stations.json` from `main` and syncs the tables to it, so the 3.5 MB
never passes through the browser. Re-runnable: it is the way to reload a snapshot
into any database, and running it twice changes nothing.

`tools/import_stations_json.py` does the same job as plain SQL for a database
that cannot reach GitHub. Both go through `meganet.load_stations_doc()`.

### Editing it

Save in the station editor writes to the database and waits for it, then updates
what is on screen from what came back. The rules that matter to whoever is using
it:

* **A failed save keeps your typing.** The form is never cleared by a failure —
  it says why, and everything you entered is still there.
* **Two people editing the same station is refused, not merged.** The save
  carries the version the editor opened, and the database rejects it if the row
  has moved since. You are told to reload rather than quietly overwriting
  somebody's afternoon.
* **Delete is recoverable.** It is a soft delete: the station leaves the list,
  and the record — with its sensors, repeater and pass ranges — stays in the
  database. An editor puts it back with **Restore** on the Admin tab's
  **Deleted stations**, through the same save and the same checks as an edit
  (`0056`).
* **Every change is kept.** The station card's **History** section, for an
  editor, lists who changed the station, when and what — each field as it was
  and as it became, newest first — and puts back one field, or the whole
  station as it was before a change, through the editor's own save. The
  station's own fields are recorded; its sensors, repeater ranges and the
  Bureau's lists are not, because every save replaces those lists whole and
  logging them is a design of its own. History begins once `0056` is on the
  live database, which is step 3 of #210. See `db/README.md`, *Station history*.
* **Saving needs a signed-in session.** The database refuses anonymous writes.
  Signed out, the editor still opens and still shows everything — the Save button
  reads **Sign in to save** and opens the sign-in panel rather than failing at the
  network. See [**Signing in**](#signing-in) below.
* **Saving is refused while the app is on the file fallback.** If the header says
  the list came from `stations.json` rather than the datastore, load from the
  datastore before editing: otherwise Save would write what is on screen over
  whatever the database has since been told.
* **Anybody who may edit may propose a station; adding one outright is an
  administrator's.** **+ Propose** beside **+ New** under the station list — or
  *Propose a station here* on **ℹ️ What is here**, at the point it was asked
  about — opens a proposal: a name, its *Station type* (an automatic or manual
  water level station, an automatic or manual rain gauge), the year it is
  proposed for (this year, or any year back or forward) and where it would go.
  It needs no station number. An administrator establishes it by unticking
  *Proposed* and giving it one; the type and the year stay, as the record of
  what was proposed. A proposal is drawn hollow in a dashed ring on the map and
  tagged *Proposed* on its card, in the list and on the trail. The database
  enforces all of it (`0039`); see `db/README.md`, *Proposed stations*.

The contract, the SQL and the `curl` proof that a stranger cannot write are in
[`db/README.md`](db/README.md) under **Writing**.

### Signing in

**Reading needs no account.** The station list, the maps, the ARRO tools and the
ACMA layer all work signed out, and that is a decision rather than an oversight —
`stations.json` and every line that reads it are in a public repository, so a
login in front of them would be a sign on a door in a field. The gate exists to
protect *writing*, and to say who made a change.

There is no password. The sign-in panel emails a link and a six-digit code;
either one produces a session, which lasts until the tab is closed.

Two independent locks, and it is worth knowing which is which:

* **Cloudflare Access** decides who may load the site. It is dashboard
  configuration, it protects the hostnames it is put in front of, and it is what
  an organisation's IT department eventually replaces with its own.
* **The database** decides who may change a station. Any verified `@bom.gov.au`
  address may; anyone else has to be added to `meganet.editor_allow`, which is one
  `insert` and needs no deploy. This is the lock that holds against `curl`.

Adding a domain, adding one person, and what to do when nobody can get in are all
in [`docs/access.md`](docs/access.md).

### With no signal

A device that has opened Flood-Net before opens it again with no signal (#213).
The **📲 Offline & Install** tab, under *Start here*, is the page for people: what
this device has kept and when, **Get this device ready for no signal** to keep the
rest in one go, how to install Flood-Net in the browser being used (with the
browser's own **Install** button where it offers one, and a plain "this one
cannot" where it does not), and what does and does not work with no signal.
`sw.js`, a service worker registered by `pwa.js` for the version the page is,
keeps the app — `index.html` and everything it loads, Leaflet included — and,
as they arrive, the station list and the inspection and maintenance sheets'
reference tables. A first visit's list goes past the worker (it was not there
yet when the page loaded), so when the worker first takes the page over, the
list and the sheets' lists are asked for again through it: one visit with a
signal is enough. With no network the app opens from that copy, and the header
says so: **saved copy, 3 hours old — no signal**, never "from the datastore" (and
with a signal but no answer from its source — a paused datastore fails the same
way — *no answer from the datastore* instead).
An inspection or maintenance sheet can be started and its draft is saved on the
device, as it always was.

- **The app's page is network-first.** The site is behind Cloudflare Access, so
  the copy answers the page only when the network cannot (an error, or five
  seconds of nothing); online, the page is the site's own, Access sign-in
  included, and a page is never kept from the network. A version whose
  `index.html` is not the app — Access's sign-in page, a redirect — is never
  kept: its worker does not install, and the copy before it carries on. Any
  other address a tab is pointed at (`/api/v1/…`, a doc) is the network's alone.
- **Files of a version come from the copy; every other file from the network.**
  A script or stylesheet with the deploy's `?v=` stamp is the same bytes for as
  long as the version lives, so the copy answers first. A file without one — the
  ACMA data a monthly refresh changes under the same name, the layers' GeoJSON —
  is fetched as if there were no worker, with its last copy kept for when there
  is no signal. Nothing waits on a copy being written: the first load's progress
  still counts the station list's bytes as they arrive.
- **A new deploy is offered, never swapped in.** Each deploy's stamp is a new
  worker, which keeps its own copy and drops the old. A page that came from the
  copy finds, once it can reach the site, whether it has moved on, and says
  *A newer version of Flood-Net is ready* with **Reload now** and **Later** — a
  sheet half filled in is never reloaded from under its author.
- **Installable.** `manifest.webmanifest` names Flood-Net, standalone, with
  192, 512 and maskable icons; a phone's browser offers to add it to the home
  screen.
- **Not kept:** the datastore's other reads, the Worker's `/api/` routes,
  sign-in and map tiles. A copy opened from `file://` is left exactly as it was.
- **Taking it off one device**: the tab's **Start again** removes the worker and
  every copy it kept (drafts are separate, and stay); ticking *do not keep a copy
  on this device again* keeps it off — for a shared computer — until somebody
  presses **Get this device ready** there.
- **Taking it off every device**, should a deploy ever need to: make `pwa.js`'s
  `wanted()` return `false`, and give `sw.js` an `activate` that deletes every
  `floodnet-` cache and calls `self.registration.unregister()`. Each device runs
  that the next time it opens the site with a signal, and is left with no worker.

### Reading it from an agent

Station data can also be read by programs: a read-only REST API at
`https://floodwarning.net/api/v1` (OpenAPI at `/api/v1/openapi.json`) and an
MCP server at `https://floodwarning.net/api/mcp` (`worker/api.js`) — public
data only, no sign-in, rate limited per client and per address, with a
one-call station **dossier** for drafting assessment reports, every reporting
station's **latest reading** in one call, and GeoJSON for a map. It reads with the
same publishable key the page does, only from relations `anon` may already
read, and never forwards anything from the caller. Setup for each agent (Claude
Code, Codex, Gemini, Copilot, Cursor, or plain `curl`), every endpoint, the
limits, and the Cloudflare Access bypass it needs are in
[`docs/agent-api.md`](docs/agent-api.md); `AGENTS.md`, `GEMINI.md`, `llms.txt`,
`.github/copilot-instructions.md` and `.cursor/rules/` say the same to the
agents that read each.

### Keeping `stations.json` current

The file is a copy now, so it is refreshed on a schedule rather than left to
drift: `.github/workflows/stations-snapshot.yml` runs
`tools/snapshot_stations_json.py` weekly and opens a pull request when the
document has moved. The Export tab has the same snapshot as a button, for a copy
to take somewhere without a network — behind a sign-in since #191, like the
Radio Mobile set beside it.

### Cost of the full document

Measured against Postgres 16 with the whole list loaded — 3,174 stations, 8,815
sensors, 88 repeaters:

| | |
| --- | --- |
| Building the document in Postgres | ~200 ms warm, ~500 ms cold |
| Over the wire, gzipped | **273 KB** (PostgREST compresses; the file is 294 KB gzipped) |
| Uncompressed | 2.3 MB, against the file's 3.5 MB — the same data without the indenting |

So the 3.6 MB the ticket worried about does not materialise: compressed, the
database's document is *smaller* than the committed file. The ~200 ms of database
time per page load is the real cost, and if that ever bites, a materialised view
refreshed on write is the fix — worth knowing before the write path lands.

#40's conclusion still holds: the JSON is not the bottleneck, rendering is.

---

## Field-station telemetry

The station list is what the network *is*. This is what it *reports*, and it is a
completely separate source of truth from ARRO — the same charting machinery (the
**Field Data** tab is the ARRO Data chart over these rows), different data.

Everything that will ever write a reading goes through **one function**:

```sql
select meganet.ingest('{
  "source": "mqtt", "protocol": "alert2", "path": "MOUNT_TABLETOP",
  "readings": [
    {"alert_id": 6128, "reading_ts": "2026-08-12T04:15:00Z",
     "value_raw": 12, "value": 2.4, "unit": "mm",
     "conversion": "raw x 0.2 mm per tip"},
    {"station_number": "541155", "channel": "level",
     "reading_ts": 1786000500, "value_raw": 1.842, "unit": "m"}
  ]}'::jsonb);

-- {"accepted": 2, "duplicates": 0, "rejected": [], "raw_id": 1}
```

HTTP POST (#B5) and the MQTT bridge (#B6) are adapters onto that call, which is
why each of them is thin and why none of them gets to disagree with the others
about timestamps. The schema names two more ways in — a backfill from an ARRO
export (protocol `arro`) and a reading typed in by a person (source `manual`) —
but no adapter for either was built, and no issue asks for one.
It is a plain Postgres function, so the whole thing moves inside the corporate
network with a `pg_dump`.

Four facts about this network are in the schema rather than left to be discovered:

* **The address is the identity, not the station.** A packet carries an address;
  which station that is may be unknown. 604 of 5,122 ALERT addresses belong to
  more than one station, and a new site reports before anyone adds it to Flood-Net.
  A reading is *never* dropped for an unresolved address — `station_id` is filled
  in where it is unambiguous and backfilled later where it is not.
* **Not every station has an ALERT address.** Satellite and cellular sites are not
  radio, and report under their station number with a channel naming the sensor.
  Both kinds of address live in the same table; `addr` is `a:6128` for one and
  `s:541155/level` for the other. Likewise `protocol` (ALERT, ALERT2, …) and
  `source` (HTTP, MQTT, …) are lookup tables — the next protocol is an `insert`,
  not a migration.
* **The same reading arrives more than once.** One transmission heard direct and
  via two repeaters is three copies. The primary key is the deduplication, and the
  copies are counted rather than thrown away: `dup_count` and `dup_paths` are the
  only place the network's real path redundancy is visible.
* **Raw values are the truth.** `value_raw` is what was transmitted, `value` is the
  conversion if there was one, and `conversion` says which rule produced it — a
  rainfall count means nothing without the bucket size, and the 357 filter's 3/5/7
  thresholds are in counts, not millimetres.

### Retention, and why it exists before the first row

The whole network at 15-minute reporting is ~914,000 rows a day, which fills the
500 MB free tier in under a week. So raw readings age out and the rollups are kept:

```sql
select meganet.retain();   -- rolls up, then deletes. In that order, always.
```

| | Kept for | Set by |
| --- | --- | --- |
| `meganet.reading` | 90 days | `app_meta.retain_reading_days` |
| `meganet.reading_raw` (submissions as received) | 30 days | `app_meta.retain_reading_raw_days` |
| `meganet.reading_hourly`, `meganet.reading_daily` | forever | — |

Both knobs are rows, so changing them needs no migration. Run `retain()` daily —
by hand for the pilot, from `pg_cron` or a scheduled workflow once there is enough
data to matter. The order is not optional: a reading deleted before it is rolled
up is gone from both places.

### Proving it

```sh
psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_ingest.sql
```

48 checks, one per line of the contract — deduplication, partial accept with a
reason per bad row, unresolved addresses stored and backfilled, non-radio
addressing, rollups reconciled against the readings they came from, and the
readings ageing out while the rollups survive. It runs in a transaction and rolls
back, so it is safe against the live database.

The full schema, the reasoning and the security posture are in
[`db/README.md`](db/README.md) and `db/migrations/0006_telemetry.sql`.

### Posting readings over HTTP

A field station can push its own readings without an editor session, via
`POST /rest/v1/rpc/ingest_http` and a per-device token — [`docs/ingest-http.md`](docs/ingest-http.md)
is written for whoever is configuring the logger, with the curl that works, the
payload shape, and how to mint and revoke a token. `db/migrations/0007_ingest_http.sql`
is the database side.

**Or the base station asks for its token** (`0048`): press *Request a token* on a
Raspberry Pi running [RPi ALERT](https://github.com/cdomotor-g/RPi_ALERT) (or *Ask
an administrator* in a Serial Monitor card), and approve the request on the Admin
tab from any device you are signed in on — after checking the code it shows. The
device makes the token itself and Flood-Net keeps only its hash, so nothing is
copied or carried and nobody signs in on the Pi.

**Once it posts, it can check in** (`0049`): a base station whose software
supports it reports its health about once a minute — receivers, queue, power,
temperature, clock, software — and collects what an administrator asked of it on
the **Base Stations** tab: a setting changed, a receiver restarted, an update
installed, its log. Flood-Net never connects to it; the request waits for the
station's next check-in, and only a short fixed list can be asked — never its
token, its passwords or where it sends readings. How much of this it takes is
decided on the station itself. The same tab keeps the team's **SSH public keys**,
which a station whose owner allows it installs for its maintenance login — so
getting in does not depend on whoever set it up remembering a password.
[`docs/base-stations.md`](docs/base-stations.md) has the whole contract.

**A base station that speaks this already exists**: [`logger/`](logger/README.md)
holds a CRBasic program for the datalogger at the base — it reads the ALERT2
ASCII the ERT-A2 puts on its RS-232 port (the same lines the ALERT2 / ERT-A2 tab
decodes), queues what it hears, and posts it. This is the one inbound path that
needs **no process running anywhere**: the logger is already at the site, and
the endpoint's idempotent retry means a dropped link costs a duplicate rather
than a reading. The token lives in a file on the logger rather than in the
program, so the program itself is in this repository with nothing redacted.

**That same program also publishes over MQTT**, to the topic scheme below, and
it does both for every reading rather than choosing. The primary key stores the
second copy zero times and counts it as a duplicate, so the belt and the braces
cost only the duplicates — and what the second path buys is knowing when the
base station itself stops talking, which no amount of HTTP can tell you.

### Posting readings over MQTT, and knowing which stations went quiet

Same reading object, same contract, one broker in between:

```
meganet/v1/<station>/<device>/reading      QoS 1
meganet/v1/<station>/status                retained, and the Last Will topic
```

`<station>` is the **bureau station number** — `541155` — not the app's slug: it
is the identifier the site card carries, and unlike a name-derived slug it is not
ours to move. The sites that have no bureau number, being repeaters and radars,
publish under their station id instead (`0020`).

**Postgres cannot subscribe to MQTT**, and Supabase does not host a broker, so
this is the first piece of Flood-Net that needs a process running somewhere
permanently: [`bridge/`](bridge/README.md), a small Node subscriber that
validates what arrives and posts it to the same `ingest_http()` endpoint an HTTP
logger uses. It holds a device token and no service key, and it acknowledges
nothing to the broker until the database has stored it — so a bridge that dies
mid-flight costs a redelivery, not a reading.

The reason to bother, beyond the readings: a station's **retained status and Last
Will** give station-offline detection for free, with no polling and one field in
the logger's CONNECT packet. "Which sites stopped talking overnight" becomes a
query:

```sql
select station_key, station_name, online, round(minutes_since_seen) as quiet_for
  from meganet.station_health
 where minutes_since_seen > 180 order by minutes_since_seen desc;
```

### Reading it back — three tabs, one table

What lands through `ingest()` is read back three ways. **Field Data** charts one
station's sensors over a window — the 357 filter, the rollups, the gaps.
**Message Log** is the same rows read as an arrival log: every message the
datastore accepted, newest first, with the ingress pathway (protocol,
transport, which base heard it, how many further copies by which other paths)
as columns, a plot-and-map tray over any selection, a decode drawer per row,
and a Follow switch for watching a field test land. A raw count the datastore
holds no conversion for — everything an RTL-SDR or a radio hears off the air —
is shown as what it is worth, worked out from what the address measures and
marked as such: a battery's `133` is *13.3 V*, a rain gauge's `43` is *8.6 mm*
of its running total, a level stays a count.
**Station Health** reads the same rows over days, for operations and
maintenance: which stations have gone quiet, whose missed check signals are
rising, whose battery is sliding or not charging, whose rain gauge stayed dry
through its neighbours' storm, which receiver stopped, which repeater a run of
silences or corrupted copies has in common — ranked by what needs doing, each
with its evidence and the action. Pick a station for its checks slot by slot
and its battery across its solar day, and pick any missed check or reading to
see what every receiver and neighbour was doing at that moment. *Ask Claude*
hands the findings to an agent (Claude Opus 5.5 — on Flood-Net's own key, behind
Access, for editors and administrators, up to US$20 a day; anyone else on their
own key) that investigates with tools over the same readings and writes the
briefing. The
same rules put a station's last-heard time, battery and findings on its card on
the Stations map, each a door back into this tab, and can colour every pin by
health (#218). Its *Airtime* panel reads the same window for which stations'
transmissions land on top of each other at each receiver and whether the ones
that do come with more corrupted copies, each station's check time and how its
logger keeps it (steady, drifting, jumped after a restart, randomised), and what
to change — the nearest clear check time for one of two stations that keep
meeting, said for that kind of logger, and the repeater pairs to give different
delays — with the hour folded to show the busy minutes. Together means within
3 s, the resolution a base station's decode-time stamps have.
[`docs/station-health.md`](docs/station-health.md) lists every finding, what
triggers it and what to do. Each page links to the
other per reading. The log is its rows, so it gets most of a screen: a
Short / Tall / Max switch in the panel header sets how much of one (Tall —
most of it — is the default), and each column header carries a grip that
drags the column's width, remembered on the device per view and per column,
with a *Reset widths* button in the Columns chooser. On a phone neither
applies — the columns share the width evenly, and the Columns chooser is the
path that works at that size. [`docs/message-log.md`](docs/message-log.md) is
the long form.

[`docs/ingest-mqtt.md`](docs/ingest-mqtt.md) is the page for whoever is
configuring a logger or choosing a broker — the topic scheme and why it is shaped
that way, per-station credentials and ACLs, and how to prove the whole path from
a laptop. [`docs/mqtt-provisioning.md`](docs/mqtt-provisioning.md) is the provisioning run
itself — signing up for the broker, minting the token, deploying the bridge, and
the checks that say which step broke. [`docs/elpro115e_mqtt.md`](docs/elpro115e_mqtt.md)
takes one device the rest of the way: provisioning an ELPRO 115E-2 base station to
publish into that bridge, enumerated separately for the system administrator and
for the technician holding the unit, and answered against ELPRO's own MQTT gateway
guide rather than guessed at. It assumes a browser and nothing else: the
bridge deploys from a button in Actions
([`deploy-bridge.yml`](.github/workflows/deploy-bridge.yml)), because "install
this CLI" is not an instruction this project's operator can follow. [`bridge/README.md`](bridge/README.md) is
for whoever runs the process;
`db/migrations/0008_mqtt_bridge.sql` and `tools/check_mqtt.sql` are the database
side.

---

## Station inspections

Field crews carry paper forms: six station-inspection sheets, one per station
configuration, and a Council Site Maintenance Tasks sheet for the stewardship and
liaison side. They are in
[`archive/Inspection sheets for printing.xlsx`](archive/), and since
`db/migrations/0009_inspections.sql` they are also tables.

The forms are not six unrelated layouts. They are one family — a core of sections
with blocks added, removed or reworded per configuration — and the workbook's own
index sheet says so: form identity follows the station's telemetry type. So the
schema is one `meganet.inspection` and one set of section tables, plus a matrix
saying which sections each configuration's form actually prints:

```sql
select section_label, variant_note
  from meganet.inspection_form
 where config_key = 'gas_only' order by ord;
```

That matrix is the part that earns its keep. Without it, "this station has no gas
bubbler" and "nobody filled the gas section in" are the same null. With it, the
first is a missing row in `meganet.inspection_config_section` and the second is a
missing row in `meganet.inspection_gas` — and a trigger refuses to record a
section on a form that does not have one.

Two rules the sheets print in words are computed rather than left to whoever
reads the numbers later: the "adjust only if the mean % error after 3 checks is
greater than 6%" note beside the rain-gauge tip test, and the SWR legend beside
the antenna box. And the sentence at the foot of every inspection sheet —
*"sites on departure that are poor or have issues please complete Flood Warning
Council Maintenance Project form"* — is a foreign key, with a view listing the
times it was printed and nobody followed it:

```sql
select station_name, inspected_on, parameter, on_departure_label
  from meganet.inspection_needs_maintenance
 where not has_maintenance_activity order by inspected_on desc;
```

That view is the **Site Maintenance** tab's picker: the visits the instruction
was printed for and nobody followed, each one a button that starts the Council
form with the link back to the visit already made. The other direction is a
button at the foot of an inspection that departed poor — which appears only once
that inspection has been saved, because the link is a foreign key and needs a row
to point at.

Unlike the station list and the readings, **none of this is readable with the
published anon key**: the council form carries landowner contact details and
inspection remarks carry site access notes. The pick-lists and the form matrix
are public — they are the words on a blank form. So is one more thing since
`0023`: the **numbers** a visit recorded, and the date it happened, through
seven `inspection_chart_*` views that carry no free text at all. That is what
lets the station card's chart draw without a sign-in while the records behind it
stay editors-only — the words are what was being withheld, and a fade margin of
18 dB in 1997 says nothing about who owns the paddock.

Reading one back is the **Inspection History** tab. A station's past visits and
Council forms are one timeline, newest first, with the departure ratings that met
the printed instruction shown against each one and whether a Council form was
raised. Opening a record renders it read-only in the layout of the sheet it was
written on, printable to A4 — Arial, shaded section banners, one page per visit,
the workbook's own print setup — and exportable as CSV.

That view is **one walk over the same field tables the form renders from**, not a
second layout. The screen, the printed page and the CSV are three renderings of
one record model, which is what stops a box added to a sheet appearing in one of
them and not the others. It keeps the schema's distinctions rather than
flattening them: a section the sheet prints with no row saved against it says
nobody filled it in, a section the sheet does not print at all is listed under
*Not on this form*, and the two are different sentences because they are
different facts.

On screen, what the technician actually recorded is set apart from the
furniture around it: every filled value renders green and a touch bolder, so
the recorded numbers can be found without reading the whole page. The
headings, box labels and hints stay plain, as do the label columns inside the
grid tables, and a blank box keeps its muted em dash. Green here means *this
is the data*, not *this value is fine*. On paper the record stays monochrome
as the print block intends — the green becomes black and keeps only the
weight — and the CSV is untouched by construction, since it reads the record
model rather than the screen.

The other way in is from the **station itself**. Under the ARRO block at the foot
of the station editor card on the Stations tab there is an **Inspections**
section: a pill that opens the Inspection History tab with that station already
in its filter box, and a chart of what its past visits actually measured. It
opens on **fade margin** and **battery voltage under load** — the two the field
crews reach for first, and the two the archive has most of (7,322 and 13,199
readings across 14,982 imported visits) — and any of the other 35 recorded
parameters can be ticked instead.

**The chart needs no sign-in.** The pill beside it does — Inspection History
renders the sheets as they were written, which is the half that carries the
remarks — and the section says so on screen rather than letting the pill lead to
a locked door.

That chart is not built on `meganet.inspection_measurement`, which would be the
obvious source and is the wrong one: it holds only the imported visits, so the
picture would stop dead at the import and show nothing typed since. It reads the
**section tables** — `inspection_power`, `inspection_radio`, `inspection_gas`,
`inspection_water_level`, `inspection_data` and `inspection_fade_margin` —
through `0023`'s `inspection_chart_*` views of them, which is where both origins
live, because `project_inspection_measurements()` writes every imported
measurement that has a home into exactly those columns. Those views are the
numeric half of each table and nothing else: no remarks, no inspector, no
comments column, and a soft-deleted visit is gone from them. The
parameter list is `meganet.measurement_field` itself, so it is the database's own
vocabulary rather than a copy of it, and a field added there appears in the
picker with no code change.

Two things it will not do, and says so on screen rather than quietly. It draws
**two axes and never a third**: volts and milliamps on one scale draw a flat line
under a mountain and call them comparable, and normalising every series to its
own band would fit any number of units on one picture at the cost of making every
gridline a lie — so a parameter in a third unit is named under the chart as *not
drawn*, and is still in the table below it. And it does not plot **calibration
grids or serial numbers**: a tip test is a grid per visit, not a number, and
which column holds the reading depends on the kind — reducing one to a single dot
would be inventing a measurement. Those are read in full on the history tab.

The schema is the whole of #115; the two forms that write it are #116
(Inspections) and #117 (Site Maintenance), the history view is #118, the
~35-year backfill out of the second workbook is epic #122. [`db/README.md`](db/README.md#station-inspections-and-maintenance-activities)
has the design decisions and the write path; `tools/check_inspections.sql` proves
it in 90 checks — including that the chart views publish the numbers and that
the records behind them are still not readable with the anon key.

---

## Data Schema — `stations.json`

Each entry in the `stations` array represents one node in the network. A node can simultaneously be a field station, a repeater, and/or a base station — the `roles` array defines its capabilities.

> This is also the shape the database returns. The tables behind it are
> normalised (`meganet.station`, `meganet.sensor`, `meganet.repeater`,
> `meganet.pass_range`, …); the document below is what the view rebuilds.

### Top-level structure

```json
{
  "meta": {
    "version": "1.0",
    "description": "Flood-Net station database",
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
  "TBRGbucketSize": 0.2,

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
| `catchment_ids` | `string[]` | References `catchments[].id`: the Queensland drainage basin the station's coordinates fall in, point-in-polygon against the Bureau's basin boundaries (#179; see `db/README.md`, *Where a station is*). An empty list for most stations outside Queensland. The Radio Path Maps tab does not read it, and still works a station's catchment out at runtime from its coordinates (see feature 8). |
| `TBRGbucketSize` | `number` | Millimetres per tip for this station's tipping-bucket rain gauge. **Absent, not `null`, when not recorded** — most stations today. Every consumer that converts a tip count to millimetres falls back to an assumed 0.2 mm/tip and says so (`bucketSizeMm()` in `app.js`) when this is missing. Named as the ticket that introduced it asked, so it doesn't match this schema's usual snake_case (`tbrg_bucket_size_mm`) — flag it if that should change before more call sites depend on the name. |
| `flood_classes` | `object[]` | The station's flood classification levels, one per edition of the Bureau's river height station list: `as_at`, and any of `first_report_m`, `minor_m`, `crops_grazing_m`, `moderate_m`, `towns_m`, `major_m` (metres on the gauge), `crossing_height_m` and `crossing_type` (a code from the Bureau's legend — `B` Bridge … `S` Spillway, `T` Highest Astronomical Tide), `note`. **Absent when there are none**, and a row carries a key only for what it states. The newest `as_at` is what the station card shows. See `db/README.md`, *The Bureau's flood warning station lists* |
| `crossings` | `object[]` | The crossing the gauge is read against: `stream`, `name`, `height_m`, `crossing_type`, `as_at`, `note`. Absent when there are none |
| `gauge_survey` | `object[]` | The gauge zero's history: `valid_from`, `valid_to` (absent while still in force), `gauge_zero_m`, `datum` (`AHD`, `ASSUM`, `STATE` or `UNKNOWN`), `amtd_km` (Adopted Middle Thread Distance — km along the middle of the stream from its mouth up to the gauge), `catchment_area_km2`, `note`. Absent when there are none |
| `bureau_listings` | `object[]` | Which of the Bureau's Queensland station indexes list the station: `section` (`"1"` FloodWarn rainfall, `"2"` daily rainfall, `"3"` river height), `as_at`, `note`. Absent when there are none |
| `flood_effects` | `object[]` | What each height on the gauge means on the ground: `height_m`, `effect` (as the Bureau writes it — "Minor Flood Level", "Bridge", "Low lying roads at …"), `detail` (the line the page prints under it in brackets, without them), `as_at`, `note`. In the page's order. Absent when there are none |
| `awrc_number` | `string` | The AWRC gauging station number (Section 3). Its first three digits are the basin. **Absent when not recorded** |
| `stream` | `string` | The stream the gauge is on, as Section 3 prints it. Absent when not recorded |
| `urbs_label` | `string` | The station's node in the Bureau's URBS runoff-routing model. Not unique — a TM and the ALERT gauge beside it read the same place. Absent when not recorded |
| `aep_levels` | `object[]` | The modelled water level at the station in four floods — `aep_1_m`, `aep_0_5_m`, `aep_0_2_m`, `aep_0_066_m` (the 1%, 0.5%, 0.2% and 0.066% annual exceedance probability events, m AHD) — over `ground_m`, at the sheet's `point_lat`/`point_lon`, with the sheet's `data_quality` (1–3), `level_difference` (1–3) and `confidence` (1–9), its `source` and `as_at`; then the indicative flood velocity's assumptions, `setting` (`channel` or `floodplain`), `slope` (m/m) with `slope_basis`, and `manning_n`, and a `note`. One row per sheet. **Absent when there are none.** Indicative, not observed. See `db/README.md`, *AEP flood levels and frequencies* |
| `frequencies` | `object[]` | RX/TX pairs beyond a repeater's own: `rx_mhz`, `tx_mhz`, `label` (what the channel is for), `acma_licence`. `repeater.rx_mhz`/`tx_mhz` stays the primary pair every path tool reads; a base station keeps all its pairs here. Absent when there are none |
| `proposed` | `boolean` | `true` while the station is **proposed and not yet established** — where one is meant to go, with no station number yet (`0039`). **Absent, never `false`**, on every other station. Setting or clearing it on a saved station is an administrator's, as is adding a station that is not a proposal |
| `station_type` | `string` | What kind of station it is, or is proposed to be: `auto_water_level`, `auto_rain_gauge`, `manual_water_level` or `manual_rain_gauge` (`meganet.station_type`). Required of a proposal, allowed on any station. Absent when not recorded |
| `proposed_year` | `number` | The year the station is proposed for — this year when it is proposed, unless somebody dates it back or forward (1900–2200). Required of a proposal, and kept once it is established. Absent when not recorded |
| `flood_peaks` | `object[]` | The station's five largest floods from HDB's peak flood heights, one per July–June season, largest first: `date` (the Queensland day where HDB gives the hour, else `yyyy-mm` or `yyyy`), `height_m` (on the gauge as it then stood) and `level_m_ahd` — the level reached, through the gauge zero in force that day, **absent** where that zero is not in AHD or the height disagrees with the gauge's flood levels. **Read-only**: worked out by the database from `meganet.flood_peak` and the gauge survey, never saved through the editor. Absent when HDB lists none. See `db/README.md`, *HDB's flood peaks* |

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

> **`bureau_listings` / `flood_classes` / `crossings` / `gauge_survey` /
> `flood_effects`, and `awrc_number` / `stream` / `urbs_label`,** started as
> Sections 1–6 and 9 and the URBS details of the Bureau's Queensland flood
> warning station lists (`archive/river-height-stations/`, read by
> `tools/ingest/river_height_stations.py` and attached by bureau number), and are
> the station's own rows from there on: an editor adds the next edition,
> crossing, re-levelling or effect in the station editor's *Bureau flood warning
> details* block, and the station card shows what holds now with the rest under
> *Earlier*. The 1,697 stations Sections 1–3 list that Flood-Net had none for were
> created from those indexes on 25/09/2026 — a field station each, at the
> Bureau's position, with no elevation yet.

> **`aep_levels`** come from the QLD and NSW AEP flood level workbooks
> (`archive/aep-levels/`, read by `tools/ingest/aep_levels.py` and attached by
> bureau number, or by position for the eleven rows with none). The station card
> shows them in a *Flood levels (AEP)* section flagged indicative, and
> `flood-velocity.js` turns them into the **indicative flood velocity** on the
> line beside the wind region: Manning's equation over the depth of each flood,
> in the channel (over the gauge zero, n 0.040) and on the floodplain (over the
> sheet's ground, n 0.060) until somebody records which the station is, with a
> slope from the same sheets' water surface between same-stream neighbours or,
> failing one, the median slope for stations at that ground height. The
> workings are on the card, and the setting, slope and roughness are editable on
> the AEP row.

---

## Features

This section started as the list of planned features, and everything in it has
shipped unless it says otherwise where it stands: a feature built another way
says how, and one that was not built says so and why. Work still to do is filed
as issues and sequenced on the roadmap,
[#113](https://github.com/cdomotor-g/MegaNet/issues/113), rather than listed
here.

### 1. Unified Data Management
- Load `stations.json` from this device — **Load from this device** on the
  🛠️ Admin tab, and **Load stations.json** on the first-load screen. Loading it
  by drag-and-drop was planned and not built, and no issue asks for it
- Add, edit and delete stations in the browser — the station editor card on the
  Stations tab; a save is checked before it is sent, and again by the database
  (see [**Editing it**](#editing-it))
- Take the data away — the station list as CSV, GeoJSON or KML through
  **⤓ Export** in the banner, with the Stations filters applied (#227), and the
  whole document as the snapshot on the Admin tab, written from the datastore
  (it downloads as `floodnet-stations.json`); both behind a sign-in (#191)
- Import from the legacy CSVs — `migrate.html`, the **Migration Tool**, linked
  from the Admin tab and the first-load screen: `ALL_UNITS.csv` and
  `ALL_REPEATERS.csv` in, `stations.json` out

### 2. Interactive Map
- Plot all stations by role, each role in its own colour — field station green,
  repeater blue, base station red; a station with several roles takes base over
  repeater over field. Two splits the plan drew were not built, and no issue asks
  for either: a field station's pin does not say whether it measures rainfall,
  water level or both (the *Sensor type* filter does), and satcom terminals have
  no pin of their own — *Satcom* is in the legend and among the editor's roles,
  but no station in `stations.json` carries it
- Draw signal path lines between field stations and the repeaters/base stations their AlertID passes through
- Click a station to see its full detail panel
- Filter map display by role, sensor type, radio network, region, basin/council or data completeness (see *Filtering & Exploration*)
- Pull the repeaters that carry a matched station onto the map and into the table with it (*Include related repeaters*)
- Toggle the link lines on/off (the backbone paths have a switch of their own), fade them with a slider, and cap how long a link may be before it is dropped (*Limit link/path length*)
- Colour the links by the frequency each hop runs on, by fade margin, or not at all — one radio group, frequency by default
- **Colour pins by health** — every station OK, watch, fault or no data by when Flood-Net last heard it (and, once its card has been opened, by what its readings say), with its key in the legend; bigger is worse and the ring says it again, so colour is never the only channel; off by default, one request for the whole network a load
- Arrowheads along every link showing which way the traffic runs — into the repeater, on to the base, both ways on a repeater-to-repeater backbone hop, and growing with the zoom rather than burying a whole-state view
- Map and station cards side by side on any window wider than 1,100 px — the map filling the page and the cards in the side panel beside it, whose width drags — and a five-column list there (name, station number, roles, AlertID, SLS catchment) instead of the ten the stacked shape, which a tablet's window gets, has room for; on a phone the map fills the screen and the cards are the side panel's drawers over it, from the rail that ⋮ in the banner brings out
- **What is here** — click any point and read its ground height, land cover, wind region, drainage basin, maintenance hub, the land's tenure and council, and the nearest station, repeater and survey mark
- **3-D view** — tilt the map and see the ground it is drawn on: the same base map draped over ~30 m SRTM terrain, the same pins and links on it, the Queensland property boundaries and road reserve on the ground when their switches are on, pan, tilt, rotate and zoom, and the option to draw each hop's line of sight as a vertical sheet rising from the ground to the ray
- Elevation shading over any base map, with an opacity slider
- Station name labels on, off, or automatic — appearing once you zoom in far enough to read them
- Light up the watercourses whose names match the filter box, drawn beneath the pins from OpenStreetMap (*Highlight matching rivers*)
- Draw and measure over the map: pins, lines, circles, rectangles and text, placed by hand or by coordinates and km, in a colour of your choosing
- Export the whole drawing to Google Earth as a KML — the shapes in their own colours, and the stations they enclose or run between
- Snap drawing to stations, so a path between two sites starts and ends on the sites and is named after them
- Select stations off the map — by rectangle, by circle, or by shift-clicking pins — into the table below, and export the set as CSV
- **Repeater site finder** — say which sites a new repeater has to serve (the map selection, a circle drawn round them, or a pasted list of station numbers, names and ALERT addresses) and get the three to five best places nearby to put the mast, ranked on elevation, line of sight, fade margin and road reserve; fade everything else on the map to see them, see them on the terrain in 3-D, and take them to Google Earth as a KMZ with each candidate's paths in a folder of its own — see *Repeater site finder* under §17
- Leaflet.js, with the map's own controls in the side panel's strip beside it (§20), grouped by what they
  are for and separated by a hairline: what the map **shows** (base map — OSM-Topo by default,
  OpenStreetMap, Satellite or Dark — **Map display**, the **legend**), the tools you point at it
  (**Draw & measure**, **Polar radio coverage**, **Repeater site finder**, **What is here**), the **3-D view**, its
  settings (🎚️) and its camera, and how much screen the map gets (⛶ full screen). A panel opens as a pane of
  the side panel from its button in the strip; a button does its one thing.
  The one control left on the map is ↺ reset, alone in its top-right corner at every width. On a phone the map
  fills the screen, and the strip is a rail down the right-hand edge that ⋮ in the banner brings out, beside the
  map rather than on it; a panel opens from it as a drawer over the page, and so do the station cards

**Reading the map.** Every pin carries a white ring so it separates from the
base map and from its neighbours; ACMA transmitter squares carry the same ring.
The filter box **highlights instead of hiding**: all pins stay on the map,
matches get an amber ring, their names appear underneath, and the map zooms to
the extent of the matches so every one of them is on screen. Typing narrows the
highlight live. Labels are capped at the 60 matches nearest the middle of that
extent (the **Map display** panel says when the cap is in effect). Tick *Hide
stations that don't match*, in that same panel, for the old subtractive behaviour —
which still keeps the repeater at the far end of any drawn signal link, since a
TX path with its destination receiver hidden is the one station you most wanted
to see.

**The map in three dimensions.** Press ⛰️ in the side panel's strip and the same map
tilts: the ground gets its real relief, the base map you were already on is
draped over it, and the pins and links you were already looking at come with
them. Drag to move, right-drag (or Ctrl-drag) to turn and tilt, scroll to zoom;
on a touch screen drag, pinch, twist to turn and slide two fingers to tilt; from
the keyboard the arrows move and Shift with them turns and tilts — up to 85° of
pitch, which is nearly along the ground. A hint at the foot of the view says
so when the mode opens, folds to a **?** after a few seconds, and the **?**
brings it back. The digital twin is moved exactly the same way, and says so in
the same words.

It is the *same* map, not a second one. The 3-D view does not work out for
itself which stations to draw or what colour a link should be: it mirrors the
lines and pins the 2-D map has already drawn, so the filters, the hidden and
culled sets, the frequency or fade-margin colouring and the focus dim are all
exactly what they were a moment ago. The 2-D controls stay on screen and keep
working while it is tilted, which is what makes it a mode rather than a
separate tool — change a filter in 3-D and it is the same filter.

Two ways to read a radio path, and you can have both at once. The link line
itself tracks across the ground, following every rise it crosses. Tick
**Line-of-sight sheets** and each hop also grows a vertical surface between the
ray and the ground under it — green where the path clears the 60% Fresnel zone,
amber where the ground is inside it, red where the ground is above the line —
so an obstruction is a curtain disappearing into a hill rather than a number in
a table. The geometry is the Path profile tool's own, with one transform: a
profile chart keeps the line of sight straight and bends the earth up
underneath it, and a 3-D view cannot, because the ground is drawn where the
terrain says it is. So the earth bulge comes off the ray instead. The clearance
is the same figure either way, which is the point — the tilted map and the
profile card cannot disagree about whether a path is blocked.

One thing to know about the picture: a pin behind a hill is hidden by it. That
cuts both ways — a station you cannot see from a given vantage has no line of
sight from it, which is exactly the question this view is for, but a station you
are hunting for may be over the next ridge rather than missing.

**Two Map display layers used to stop applying when the map was tilted, and
both work now (#194).** The **elevation ramp** is draped on the terrain as a
raster layer, served by a custom MapLibre protocol that fetches the same
terrarium tile from the same URL and hands it to `MapElevation`'s *own* painter
— so the bands, the hillshade and the relief switch are that file's, and there
is no second copy of them here. It sits between the base map and the links,
which is where its pane sits in 2-D, and the opacity slider and the relief
toggle both reach it. Before this it simply vanished when you tilted, which is
the hardest kind of absence to notice on this view: the 3-D map already shows
relief through shading, so the hills were still there and only the meaning of
the colour had gone.

**What is here** was the other failure and the worse one. The pick ran off the
2-D map's click, whose `latlng` is where that pixel sits on the *Leaflet* map,
while the camera looking at the terrain has its own centre, zoom, pitch and
bearing. On a 62°-pitched view, a third of the way down the frame, the two
answers were **12.6 km apart** — and the card reported a ground height, a land
cover class, a drainage basin and a nearest station for ground nobody had
clicked on. Near the middle of the frame the gap is ~150 m, which is how it went
unnoticed. The pick now takes the coordinate the renderer computed, the Leaflet
click is stopped so it cannot arrive with the other number, and the point is
marked on the terrain in the same cyan ring the 2-D marker uses — a card that
answers about a point you cannot see on the map is half an answer.

**Property boundaries and road parcels are on the terrain too.** The two
Queensland cadastre layers in 🗺️ Map display — the lot boundaries with their
lot/plan, and the road reserve washed and outlined in yellow, the layers
Queensland Globe draws as land parcels — were Leaflet panes, so they were under
the canvas and gone the moment the map tilted. They are draped on the ground now,
each off its own switch, between the elevation ramp and the links (roads over
lots, as in 2-D). Each file hands the 3-D view its own export as tiles
(`MapLots.tiles()`, `MapRoads.tiles()`), so the lines are that file's styling
rather than a second copy; tiles rather than a mirror of the 2-D drawing because
a tilted camera sees to the horizon, far past the one box the 2-D layer covers.
They keep the 2-D zoom floors (about 1:36,000 for lots, 1:72,000 for roads). Two
differences, both for legibility at a tilt: lot numbers come in a zoom later
(about 1:2,500) and only on the ground's own lots of a house block or more, not
on the easements and strata plans stacked over a town centre; and since there is
no hover on a picture, road names are written in the reserve close in. A tile
the service will not give is counted and said in the 3-D note — no line there is
not no boundary there.

**Pins are clickable here too (#193).** A pin in 3-D does what a pin in 2-D
does, less the callout this mode has no way to draw: an armed link-budget
picker takes the click, a repeater takes the focus dim, and the station card
paints in the corner. It always did paint — the card was being drawn
*underneath* the WebGL canvas, which reads exactly like a click that did
nothing. The cause is worth recording because the reasoning that hid it looks
sound: the cards are children of `.mn-map-stage`, outside the Leaflet container
entirely, and the comment on the canvas said that put them above it. It does
not. Being outside the container only matters if the container is a stacking
context, and `.leaflet-container` is `position: relative` with `z-index: auto`,
which is not one — so the canvas's 750 and the card's 690 were compared
directly, and the canvas won. The card is lifted to 760 for exactly as long as
the canvas is on screen: over the canvas so it can be read, under Leaflet's
control corners at 1000 so the controls it shares the map with stay
reachable — Leaflet's zoom, and on a phone the whole icon column. `#here-card`
rode on the same class and was lifted with it.

The check that holds it asks `elementFromPoint` over the card's own rectangle —
not *did a card open*, not *is it displayed*, but **is the card the thing
painted where the card is**. Every other signal read true the whole time it was
buried.

**The card's gold leader reaches its pin in 3-D too.** It is drawn in a Leaflet
pane, so it was under the canvas with the rest of the 2-D map, and a card in
3-D pointed at nothing. While the canvas is up the leader is now drawn over it —
over the pins, under MapLibre's own controls — to where MapLibre stands the pin
on the terrain, and it is redrawn in every frame MapLibre draws, so it stays on
the pin through a drag, a tilt, a turn and a terrain tile landing under it. Its
ring is sized to the pin as drawn there: a pin in 3-D grows towards the camera
and shrinks towards the horizon, and a ring at the 2-D size would cut through
the near ones. A pin opened under the card slides the camera — zoom, tilt and
heading kept — until it is clear, as the 2-D map pans one clear, and leaving
3-D hands the leader back to the 2-D map.

Terrain is fetched for the view you are looking at and no further, which is what
makes a whole-of-state network affordable to fly over; the sheets are capped at
80 hops at a time and the panel says how many it left out, because an unsheeted
hop is not a clear one. The renderer itself (MapLibre GL, ~1 MB of WebGL) is
fetched the first time you press ⛰️ and never for a session that does not. A
terrain tile that will not load is said out loud rather than drawn as flat
ground, for the reason the elevation profile gives at length: flat ground
between two stations reads as a clear path, and that is the one wrong answer
that costs somebody a site visit.

**Who carries this station?** Finding a station on the map is half the
question; the other half is which repeaters carry it. *Include related
repeaters* (in the map's **Map display** panel, on by default) answers both at once: filter
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

Both take the **repeater focus** with them, and until #186 neither did. Clicking
a repeater pin dims every station and link that is not on one of its own paths,
which is a display overlay rather than a filter — so clearing the filters left it
exactly where it was, and a map that had been both filtered and focused came back
from *Clear* still three-quarters faded, with nothing on screen saying why or
which control would undo it. Worse, with no filter running the two buttons were
disabled, so the one control that reads as "put it back" could not even be
pressed. Both are now enabled by a focus as well as by a filter, and both clear
it (and the blast styling that rides on it), because both are the operator saying
*back to the whole network*. Clicking the empty map still clears the focus on its
own; nobody should have had to know that was the way out.

**Station names.** Names are capped at 60 on screen, because past that they
overlap into noise. The **Station names** control decides when they appear:
*Auto* (the default) draws them once the current view holds few enough to read,
so the national view is clean and zooming into a region brings them in; *On*
forces them for whatever is in view, keeping the 60 nearest the centre and
saying so over the map; *Off* draws none at all. Filter matches are always
named in Auto and On.

**Map and table together.** The map and the station table share the Stations
tab and the one Stations card: a search term, role or network narrows the table to
the matching rows while the map highlights (or, with *Hide stations that don't
match*, drops) the same set. Picking a row pans the map to that station and
opens its pin, so the list and the map never disagree about which site is being
looked at.

**The ARRO column.** The last column of the stacked table — the split drops it,
along with the network and the position — is a link straight out to that
station's ARRO (Contrail) site admin page — the place its telemetry actually
lives. It exists because the key ARRO takes is `site.db_id`, an arbitrary
database index, and it is *not* the BoM station number over on the left, so
there is no way to get from the table to the telemetry by hand. The link opens
in a new tab and is remembered in the ARRO Launcher's recents, so a page opened
from here and one opened from there are the same visit. Clicking it does not
select the row or move the map.

The 390 of 3,174 stations that carry no `site.db_id` show an em dash rather than
a dead link — the site id arrives with the ARRO sensor export
(`tools/import_arro_sensors.py`), and a station missing from that export has
none here either. The column follows the Bit Flipper's **ARRO base URL** box
like every other ARRO link in the app: point that at another ARRO and these go
there too.

**One column, since #165.** The tab was a two-pane split from #136 until then:
a filter rail on the left, the map and the table on the right, a divider that
dragged to re-split the width, and a scroller inside each column. Every part of
that served a rail taller than the screen that had to stay beside the map.

There is no rail. #164 put Map display, Draw & measure and the legend on the map
itself, and #165 put the filters under it as a collapsible card — so the map is
about 320 px wider on every screen, and the page scrolls as one piece at every
width, which is what it already did on a phone.

**The corner, grouped (#192).** Eleven icons had accumulated in that corner over
seven issues, each its own Leaflet control with Leaflet's own 10 px margin: half
a metre of identical buttons down the side of the map, in the order the modules
happened to attach rather than in any order a reader could use. Nothing in the
column said which of them were about what the map *shows*, which were tools you
arm and then point at it, which were about how much screen it gets, and which
single one throws your work away — and the two that are the same feature, the
⛰️ that tilts the map and the ⛰️ that carries the tilt's own settings, were four
buttons apart and identical.

It is one control holding five labelled groups now, with 3 px inside a group and
a gap and a hairline between them, so the column reads as five short clusters
and is ~35 px shorter than the stack it replaced even before the two hidden
camera buttons. Each icon states its group and its place in it, so
`addBaseLayers` (first), `stationsMapPanels` (next) and `MapPolar.attach` (well
after) produce the same column whatever order they run in — 📡 lands among the
other tools instead of at the bottom where attaching last used to put it. The
groups are real ARIA groups with names, so a screen reader is told *3-D view*
where a sighted operator is shown a hairline; a separator that existed only in
the stylesheet would have made the corner prettier and no more navigable. And
when a corner is taller than its map, the groups that do not fit wrap, whole,
into a second column over the map rather than hanging off the bottom edge. The
Stations map's column is not on the map, at any width: it stands in the side
panel's strip, in the same groups and the same order with the same hairlines
and the same ARIA names (§20) — on a phone, a rail beside the map that ⋮ in
the banner brings out. That is
where it went last, and the phone is why. Below 560 px it used to come back to
the corner, where at 52 dvh with 44 px touch targets it was two columns of
buttons over a quarter of a map the width of the screen. The one button left
in the corner is ↺ reset, alone at the top right: it is about the map as a
whole rather than one of its tools, and it is looked for on the map.

**The 3-D pair is one split button, and it has a camera (#192).** The mountain
and its panel share an edge now, the panel drawn as a thin caret under the
button it belongs to: press the big half to tilt the map, the small half for
what it tilts it with. Two buttons appear beside them while the mode is on — a
**compass** whose needle turns with the map, and a **tilt** control that draws
the ground as the camera sees it, square from overhead and foreshortened as it
drops. Pressing the compass faces north again; pressing the tilt flattens the
camera to straight down, and pressing it again returns it to 62°, because a
reset that only ever flattens leaves whoever pressed it by accident with no way
back that does not involve discovering the right-drag. Both are drawn from the
camera rather than labelled once, which is half of what they are for: a needle
at 37° is how you *find out* the map is not facing north. Neither is offered on
the flat map — Leaflet has no pitch and no bearing, so there is no camera to
reset, and a button that can do nothing is not shown. In the side panel's
strip, where there is no split button to be half of, the settings are a button
of their own under ⛰️ and wear 🎚️ rather than a second mountain — at every
width, a phone's rail included. While a digital twin is up the pair drive the
twin's camera instead, over a flat map as well, so the same two buttons do the
same two things in both views.

**The station card, and the leader to its pin (#175).** Clicking a pin
paints a card in the map's bottom-left corner — the station's number,
networks, position, elevation, wind region, every ALERT id with its reading
kind, a repeater's passing count and delay, the ACMA threat count, and every
action pill — *without* selecting the station: reading about a site must not
drag the editor and the table along, and the scroll from the map down to the
list to *see* a station and back up again was what this replaces. It is the
map's own memory of what you were last looking at: a filter keystroke rebuilds
every marker, and the card stays; selecting a row paints it too, which is also
the keyboard's way onto a map whose pins are canvas. *Station details ↓* on it
selects the station and is the first thing in the app that scrolls the editor
into view. A gold **leader** joins the card to its pin (`map-leader.js`): out
of the card's top edge — straight up to a pin above it, round the top corner to
one beside it — onto a ring round the pin, cased in near-black with a warm
glow so it holds up on imagery, topo and the dark base alike, and the card's
own top edge goes gold to match. It draws itself in when the card moves to a
new station, follows the pin through pans, zooms and a fanned-out stack, and
where the card opens over its own pin the map moves the pin clear. It replaced
the callout a desktop used to open beside the card, which said nothing the card
did not — name, roles, `Stn #N · elevation` and the same pills again behind an
*Actions (N) ▾* button — and whose one job, pointing at the pin, is the
leader's. A row in *Repeaters listening* moves the map without moving the card,
so it pulses a gold ring round that repeater's pin instead. On a phone the
callout stays, because there it duplicates nothing: a tap opens the identity
and two fat pills, *Details & actions* and *Copy lat, lon*, sized to fit inside
the map with a finger-sized close button, and the card opens from *Details* as a
sheet across the bottom of the map, with the leader up to the pin. One card over the map at a
time: opening this one, the ACMA transmitter card or *What is here* closes the
others — which also ended the case where the ACMA card and the radio-path card,
drawn in the same rectangle, simply covered each other. (The radio-path card has
since left the map: it heads the path tools, and stays open beside these.) The legend's last line names whichever
optional layers are off and that the 🗺️ button is where they are turned on, the
🗺️ flyout is grouped under five headings (base maps first) — each drawing a rule above itself
since #191, because uppercase small caps in `--muted` was the whole of the
separation and an eye going down a single column of tick boxes reads a heading
as one more row unless something physically stops it — and a first visit is told
about the button once.

**A station's health, on its card and its pin (#218, `health-glance.js`).** The
card opens, under the station's name, with what somebody standing at the site
came to it for: **Last heard** (when, how long ago, and the check period its
readings keep), its **Battery** (last night's low and where the night lows are
going — *falling 0.12 V a day, 11.8 V in about 3 days*), and its **Findings**,
worst first, with every one of them, its evidence and what to do one disclosure
down. The heading carries the station's class — **OK**, **Watch**, **Fault** or
**No data** — as a glyph and a word as well as a colour. Each line is a door into
the **Station Health** tab with the station picked, at the part it was about: its
checks slot by slot, its battery chart, its findings — with the address saying so
(`?tab=health&station=…`), so that view is a link too; a station the tab's window
holds nothing from is said to be so, with a longer window one press away. It costs
**one request a card** — the station's newest readings, whatever their age, worked
out by the Station Health tab's own rules (`HealthAnalysis`), so the two cannot
disagree about a battery — kept for five minutes, so a repaint asks nothing; a
station with no readings left at all (they age out at about 90 days) costs a
second, one-row look at when the ingest last heard it, so *never* is only said
when it is true. What one station's readings cannot say is whether the receivers
that hear it were listening while it was quiet: the card says so, and that is
the tab's to weigh. A datastore that cannot be reached, or will not answer, is
*no data* with *Try again* — never *OK*.
**Colour pins by health**, under *Stations & links* in 🗺️ Map display and off
by default, colours every pin by the same rules: by when Flood-Net last heard it
(`meganet.station_health`, **one request for the whole network a load**, kept
fifteen minutes, however often the map is rebuilt) and, for a station whose card
has been opened, by what its readings say. A quiet station is a watch from two of
its checks and a fault from four or a day — a check taken as three hours, and a
fault waiting a whole day, until its own schedule is known — and a station heard
across less than two of its checks is *no data*, not a fault: it has shown no
rhythm to be overdue on (115 of the 503 stations the ingest had heard when this
was built had been heard exactly once — a single frame, often weeks ago). Bigger is worse, as
on Station Health's own map, and the ring says it again — a watch in a dashed
black ring, a fault in a heavy one, no data hollow in a dotted grey ring — so
colour is never the only channel; the legend's key replaces the role key while it
is on, and the note under the switch, the legend and the map's accessible name
carry how many of each. When the server works findings out itself (#215), the
card and the pins read them there instead: the seam is `SOURCE` in
`health-glance.js`, whose header says how.

**The trail of stations looked at (`station-trail.js`).** Closing the card is a
decision that holds, and nothing brought it back short of finding the pin again
— at zoom 6 one pin in thousands, and in the twin not a pin at all. So a 📍 pill
in the map's top row, beside the zoom buttons, names the station the card was
last on: press it and the card comes back, and the stations looked at this
session drop down under it, the latest first, the pill's own marked. A pick
selects the station as its row in the list does, puts its card up and moves the
map to it, zoomed in (to zoom 15, or as close as the map already was); looking
at a station again — a pin, a row, a path's far end, its twin, a tap on a
phone — moves it back to the top, so going back and forth between two keeps
both at the head. It folds to one row whatever the name, and Escape, a press
elsewhere or a pick puts the list away. In the digital twin, whose zoom buttons
stand down, the pill is at the top of the stage beside the flood scale's column
— the scale stays where it was — and a pick takes the twin to that station; the
card is kept below the pill's row there, so the one never covers the other. The
list is the tab's (`sessionStorage`): a reload keeps it and closing the tab
forgets it, and it holds the latest hundred.

**Reset (#191).** A fifth corner button, **↺**, and the one gesture that puts the
map back the way it was found: the filters and the search behind them, the
selection and the box-select, the focused repeater and its blast ring, every
drawing, both link-budget ends, the polar plot, the repeater site finder's sites
and answer, the spiderfied cluster, whatever mode was armed, and all four of the
corner cards. Eleven modules can put
something on this map and every one of them has its own way of taking it off
again — right for each of them in isolation, and adding up to a map nobody can
get back to a clean state without remembering all eleven.

What it deliberately leaves alone is everything in the 🗺️ flyout: the base-map mix,
the overlay layers, the link colouring, the label mode, the opacity sliders.
Those are settings rather than clicks — somebody who has turned the contours on
and the links off has said how they want to *read* a map, not made a selection —
and a reset that silently re-argued that would be the last time anyone pressed
it. The button's own tooltip says which of the two it is, and the announcement
after it says what was cleared and what was not. Only the drawings are
unrecoverable, so they are the only thing worth a confirm, and it is skipped
entirely when there are none.

**What that costs, stated rather than left to be found.** The split existed
because reaching a filter at the bottom of the rail dragged the map off the top,
and scrolling to a filter now scrolls the map away above it. Three things make
that a smaller problem than the one the split was solving: the filters are a
single card immediately under the map rather than a rail longer than the
viewport, the card collapses, and its summary line carries the live match count
— so what the filters are doing is readable without opening them, and reading it
costs you nothing of the map.

**Beside the map it lands with the card shut (#191)**, whatever was remembered.
Above 1,100 px the cards are in the side panel, and the filters are the first
thing in its Stations card — so a stored "open" would land on a pane whose whole height
is eight blocks of tick boxes, with the list they filter below the fold, which
is not what the pane is for. Pressing **Filters** still opens it and still
writes the preference, which is honoured on every visit between a phone's width
and 1,100 px, where the cards are under the map in one long page (a phone lands
shut too: its cards are a drawer, and the tick boxes would be all of it); the override is read-only
and lasts one page load, so nobody's setting is destroyed by having opened the
tab on a wide screen once.

Inside the card the search box leads and spans, and the six filter groups flow
into as many columns as the window allows — four on a wide screen, two at 768 px,
one on a phone. A 320 px rail had one sensible arrangement; a card the width of
the page has a better one.

**The list and its filters are one card.** They were two, a Filters card and a
Stations card under it, and two cards is two borders, two paddings and the gap
between them for what is one question asked twice — the filters say which
stations, the list is that set as rows. The one card's head carries the list's
toggle with the live row count, the **Filters** toggle and **+ Propose** and
**+ New**; under it the search box and the two clear buttons (**Clear** and
**Clear & zoom out**), one line tall; then one line saying what the filters are
doing and which station is selected; then the list. **Filters** opens the whole
panel in the search box's place; the heading shuts the list and leaves the
search box and that line, since the tab is operated from them. Both are
remembered.

**Finding a control in the Map display panel.** That one flyout holds a dozen
switches, three sliders, four selects, a radio group and the whole ACMA licence
block, under four headings, and it scrolls — so somebody who knows exactly which
switch they want still has to go looking for it. A **Find a control** box at the
top filters the panel to the rows that match, headings and all. It matches
against what each row *says* — its label, its note and its tooltip — so "wind",
"dB", "contour" and "licence" all land somewhere, and every word typed has to
appear somewhere in the row, in any order. The ACMA block is filtered whole
rather than row by row: it is one subject, and half a licence panel is harder to
read than none of it.

It filters what is *drawn* and changes nothing about what is *on* — a hidden
switch is still doing whatever it was doing, and the "nothing matches" line says
so — and the term survives the panel redrawing itself, which it does whenever one
of its own switches moves. The panel also opens **as tall as the map**, so there
is something for the find box to filter: every flyout on every map is now capped
against the map's own height rather than against a share of the viewport, which
is the only figure that is right in the page, on a phone, in full screen and in
the side-by-side split at once.

**Full screen.** The ⛶ button, in the group about how much screen the map gets,
fixes the map's panel to the viewport — the match note and the ACMA, path and
station cards all ride along, because they are all positioned inside that
panel — **except the side panel**, which stays on screen beside it at the width
it had, above the header, with its strip and its open pane: the map's tools
live in that strip, and a full-screen map that had covered them could only be
looked at. The map's edge follows the side panel's as a pane opens, the panel
shuts or its handle is dragged, re-measured each time; Tab walks the map and the
side panel and nothing under them; leaving the tab ends it. On a phone that is
the rail alone — out for as long as full screen lasts, even if ⋮ had put it
away, since ⛶ is in it — the map takes the rest of the screen, and a panel
opened from the rail is a drawer over it, which a tap on the sliver of map
beside it puts away. Press ⛶ again, or Escape, to put the page back;
Escape defers to any dialog open over the map, and the bug reporter still
opens on top. It is deliberately not a modal, though "a modal map" is how the
ask arrives: the shared dialog shell wipes its content on every exit, which
would destroy a live Leaflet map mid-flight, whereas adding a class to the
panel and removing it later never moves or rebuilds the map at all. Full
screen is something an operator is doing, not a preference, so it lasts the
session and is not remembered.

**Side by side, and it is how the tab opens on any window wider than 1,100 px.**
The map filling the page on the left, and everything normally under it — the
filters, the station list, the path tools, the details card — in the side panel
on the right (§20), the map at the height of the viewport and the cards a pane
that scrolls on its own. That is the whole point of it: the map stays in view
while the list beside it is read. At or below 1,100 px the same tab is one long
page with the cards under the map — down to a phone's width, where the map fills
the screen and the cards are the side panel's again, as drawers over it — and
the width is the only thing that chooses
between the two. Until the side panel it was three
columns inside `<main>` — the map, a divider that dragged and a column of cards —
beside a help rail that was a second right-hand column; the divider is the side
panel's own width handle now (a real ARIA separator with a value in px, dragged
with a pointer or moved with the arrow keys), and where it was left is
remembered.

> The height of the map beside the cards is *measured*, not computed from tokens. The
> first version guessed `calc(100dvh - var(--mn-chrome) - 2rem)`, which missed
> `#main-content`'s own padding and the gap above the panel, and left the **page**
> scrolling behind two columns that were each already scrolling — three scroll
> regions where there should be one. It is now taken from where the container
> actually starts, and then corrected once against whatever the document
> overflows by, because what is *below* the columns cannot be measured from
> above them.

**The correction had to learn whose overflow it was reading (#195).** It took
the document's overflow and subtracted the whole of it, on the reasoning that
the only thing below the fold could be the columns it had just sized. That
sentence is only true while the columns *are* what makes the page overflow. Let
anything else stick out down there — a rail that has stopped fitting, a card
that escaped its scroller, one frame of a layout that has not settled — and the
columns were charged for all of it and collapsed to `min-height`: a 929 px map
became 306 px, the pane beside it went with it, and the page shortened in the
same gesture. Nothing threw, both columns stayed columns, and every figure in
the calculation was a real measurement of something.

So the question is not *how far does the document overflow* but *how much of
that is this element*, and the only honest way to ask it is to shrink the
element and see whether the page got shorter. Whatever the shrink buys is what
it was too tall by; whatever it does not buy was never its to pay. Two
measurements instead of one, still one correction rather than a loop.

The other half of the same bug: the measurement used to run **below the fold**
too. Under 1100 px the stack is `height: auto` and the page is one long scroller
on purpose, so `--mn-split-h` is not read there at all — and a figure taken
against that page is a measurement of a layout that is not on screen. It was
stored anyway, as the floor, and it survived the fold because the variable does.
The sync now asks `stationsSplitActive()` — the same width test the table's
own column set follows — and writes nothing while the answer is no.

This is not #165's filter rail coming back. What sat beside the map then was the
map's *settings*, which had to be scrolled past to reach the map; what sits
beside it now is the map's *answer* — the list of what matched, the card of what
is selected, the profile of the path just clicked. It folds back to the single
column at 1100 px and below: two 400 px columns are two things too narrow to
read rather than two things in view, and a laptop docked to a wide screen finds
the cards beside its map again. There is no switch — there was a ◫ button
beside ⛶, remembered as a preference, and it went because it was a mode laid
over a decision the width already made: on every phone it did nothing, and on
a wide screen "off" was the stacked page nobody asked for once the side panel
held the cards.

Like full screen, crossing between the two readings never rebuilds the map:
the cards are one wrapper, *moved* between the side panel and the page, and the
Leaflet map keeps its view, its layers and its in-flight requests.

**The station list carries fewer columns beside the map.** Ten columns in a
420 px column is ten columns nothing fits in — measured at 1440 px, every
latitude and longitude in the table was clipped, 496 of the 500 station numbers
with them, and a third of the ALERT address lists. So the side-by-side shape
lists five: **Name**, **Stn #**, **Roles**, **AlertID** and **SLS catchment**.
Nothing is lost that is not already on the same screen — the position is what
the map beside it is drawing, and the network, the elevation, the enabled tick
and the ARRO link are all on the station's own card, one row click away in that
same column. Stacked, the table has the width of the page and keeps all ten.
Crossing 1100 px swaps the sets on its own, in either direction, because the
columns follow the *layout* and not the setting.

The SLS catchment is the one column that is not in the stacked table at all: the
drainage basin the Bureau's Service Level Specification files the station under,
which is the fact the map beside it cannot draw. It is the same answer the
station card's **SLS catchment** row gives, read from the same
`data/sls-locations.json` — Queensland's document and, since `0038`, the one for
New South Wales and the ACT; for the 47 border stations both list, the entry the
card puts first — and the 1.2 MB of schedule behind it is fetched once, after
the first paint, the first time the narrow table asks for it. The 1,620
stations neither document carries show an em dash, as the ARRO column already
does for a station with no site id.

**Signal links and *Limit link/path length*.** Links are drawn from each field station
to every repeater whose pass ranges cover one of its ALERT addresses, which
across the whole network is 3000-plus lines, many of them running the length of
the country because two distant sites happen to share an address window.
*Limit link/path length* (on by default; it was called *Kill spaghetti* until #186,
and the new name says what the switch does rather than what the map looks like
without it) drops any link longer than **Max TX distance** — 100 km by default,
adjustable from 0 to 600 km, which is the range a VHF hop plausibly covers. The
panel says what it is removing ("1809 links drawn · 1332 over 100 km hidden"), so
a link that vanished is never a mystery. Untick it to see every path however
long, at any distance.

> The default has moved twice, by request each time, and the figures behind the
> two moves are the same measurement read from opposite ends. Of 3,141
> pass-range paths the map draws **1,938 at 120 km, 1,537 at 70 and 1,809 at
> 100**; the qualifying backbone pairs go **183, 96, 148** with them.
>
> 120 was the *ceiling* — about as far as a VHF hop plausibly reaches — and a
> map that opens at its ceiling opens as spaghetti, which is what took it to 70
> at #164. 70 then turned out to be the other end of the same argument: it sits
> inside the real network, and **a hop an operator knows exists and cannot see
> is a worse failure than a busy map**, because one of them looks like missing
> data and the other only looks busy. 100 km draws the network that is actually
> there and still culls 1,332 paths. Nothing is lost at any setting — the slider
> runs to 600 km, and *Limit link/path length* off draws every path however
> long.

Each link is drawn twice — a wide white casing underneath and the coloured line
on top — so it stays legible over satellite imagery and topo shading, where a
single thin orange line disappears. **Link opacity** fades the pair together
when the lines are burying the pins they are meant to explain.

**What the link colours mean — one radio group, not three switches.** *Link
colour* in the same panel offers **By frequency** (the default), **By fade
margin** and **Plain**. They are radio buttons because all three want the same
channel — the colour of a link's core line — and a green line that might be
15 dB of headroom or might be 151.95 MHz is worse than either reading on its
own. Line of sight is deliberately *not* in the group: it paints crimson over
whichever colouring is running and says one thing, "the ground cuts this path",
which outranks "on this channel".

*By frequency* is the default because, of the two colourings, it is the one that
is complete and free the moment the file loads. A frequency is **recorded** — it is
`repeater.rx_mhz`, right there in `stations.json` — so every drawn link either
has one or provably has not; a fade margin is **computed**, per hop, over
terrain and land cover, and until the network has been swept and saved most
links have no figure and no colour. This network runs on four channels (151.5,
151.525, 151.95 and 152.4 MHz), and each gets a hue assigned in ascending
frequency order, so the same channel is the same colour on every load of the
same file.

**Every hue in that ramp is a cool one, and that is a constraint rather than a
preference.** A channel number carries no judgement — 151.525 MHz is not worse
than 151.5 — while orange, amber and red on this map all mean something: a fade
margin under the threshold, an obstructed path, a repeater whose loss strands a
station. The first version of the ramp gave 151.525 an amber, and sixty-five
links around Gatton came out the colour of a problem. So the range is blue
through violet to magenta, and the hot half of the wheel is left to the layers
that are actually saying *bad*. A field link takes the channel of the repeater at its end, which is
not an approximation but the definition — a field station transmits on whatever
its carrier listens on. A repeater-to-repeater backbone hop takes the first
end's and names both in the hover text when they differ. The 🔑 legend lists
every channel in the file with how many repeaters are on it.

**Arrows along the links.** Every drawn link carries arrowheads showing which
way the traffic runs: a pass-range link is a field station reporting *in* to
the repeater whose window covers its address, so a fan of arrows converging on a
hilltop is a picture of what that repeater carries; a repeater-to-base backbone
path points at the base, which is the direction traffic leaves the network. A
repeater-to-repeater path genuinely runs both ways and is drawn as such — one
head near each end, pointing outward, and none along the middle — rather than
being given a direction it hasn't got.

**They are a function of the zoom, and below about zoom 10 they are not drawn at
all.** Fixed-size marks were wrong at both ends of the range: zoomed out over a
dense patch the network is a mat of chevrons with the links invisible
underneath — direction is the one question nobody asks of a whole-state view,
and the arrows were answering it over the top of the picture somebody wanted —
while zoomed in, where *which way does this hop run* is exactly the question,
the same marks are too small to read against a 2.5 px line. So the head, the
spacing and both stroke widths run on one ramp from zoom 10 to zoom 15 and are
constant past it, and the legend says so while they are off. A backbone path's
arrows are black like its dashes: the backbone's identity on this map *is* the
black line, and a chevron in the channel colour over it reads as a field link.

They are drawn on a canvas of their own rather than as more Leaflet lines, and
that is not an optimisation but the only shape that works: the marks have to be
evenly spaced *on screen*, so as Leaflet layers the count would be a function of
the zoom (a few thousand at one zoom, tens of thousands at the next, rebuilt on
every wheel click), and a chevron in geographic coordinates grows with the zoom
until each one is a kilometre across. In screen pixels they are the same size at
every zoom, cost no layer objects, and take the colour and opacity of the line
they sit on at the moment they are painted — so they follow the frequency and
fade-margin colourings, an obstructed path going crimson, a blast turning a fan
red, and the focus dim, without knowing anything about any of them. On by
default and remembered; the switch is *Arrows along the links*.

**Backbone paths are black dashes over the colour.** A backbone path used to be
a solid black line, which was legible and said only "backbone" — and once the
links are coloured by frequency or by margin, the backbone being the one line on
the map with no colour is the one place the colouring stops answering. So since
#186 its core takes the colouring like every other link and a black dashed line
is laid over it: the dashes say *backbone*, the colour between them says
whatever the colouring says. With *Plain* selected the core is black already and
the dashes vanish into it, which is the line exactly as it always was.

**The credit line is under the map, not on it.** Leaflet puts the attribution
control in the map's bottom-right corner, floating over the map, and on these
maps it is not a short one — the Stations map credits four base services, the
drainage basins, the maintenance hubs, the wind regions and OpenStreetMap, which
wraps to two full-width lines across the foot of the map. Anything else that
wants the bottom of the map is then underneath it: that is how it was found, with
the move-pin panel's **Save position** and **Cancel** buttons sitting behind the
credits. The move-pin panel is not the problem, it is the first thing to want
that corner — a control in a map corner is a control somebody is meant to be able
to press, and a credit line that must always be on screen will always be in the
way of one.

So the control stays exactly as Leaflet built it, collecting credits from layers
as they come and go, and only its container is re-parented into a strip
immediately below the map. The credits stay live, complete and attached to the
map they describe, and stop covering it. It is done in `addBaseLayers`, so all
seven maps get it — and so does whatever map is written next.

**Hiding a station hides its lines.** *Hide stations that don't match*, in the
same panel, is the subtractive reading of the filter box — and until #176 it
made one exception: the repeaters at the far end of a drawn path were kept on
the map, so a line never ran off to nowhere. That was the wrong half of the pair
to keep. Somebody ticking that box wants the map down to the subset they are
working on, and an exception that quietly re-adds repeaters *and* their lines
hands back the spaghetti they were hiding. So hide mode is literal now: the
matches and whatever *Include related repeaters* pulled in behind them are the
whole of what is drawn, and a link — field or backbone — needs both its ends on
the map to be drawn at all. The note under the switch says how many went with
them ("412 links drawn · **1129** hidden with the stations they run to"), so a
count that drops when a filter is narrowed is never a mystery, and *Include
related repeaters* one row up is how the carriers and their lines come back.

**Names on the satellite view.** The Satellite base is Esri's World_Imagery,
and bare imagery gives no way to orient around a station without flipping back
to OSM-Topo — so whenever Satellite is the chosen base, on every map that
shares the base-map picker, two of Esri's reference tile services ride along
with it: place and locality names down to street level, and roads with their
names and route shields. The picker says so in a note, and the Satellite
layer's attribution credits them. Esri's third reference service,
World_Reference_Overlay, was evaluated and turned down — it re-draws the same
names slightly misregistered, its tile cache stops at level 13, and over
Australia it goes blank from about level 9 anyway. River names over imagery
stay the rivers layer's job, drawn above these tiles.

**The dark base.** The fourth base map is Esri's Dark Gray Canvas, and the
genre's whole point is that it is drawn deliberately badly: no terrain, no
landuse, no colour, roads down to hairlines. It is the base for reading the
*network* rather than the ground under it. Topo and satellite tiles are dense
and mid-toned edge to edge, so a white-ringed pin and a white-cased link line
are competing with the base for attention the whole time; on this one nothing
else in the frame is bright, and the pins and links are the only thing left to
look at.

Esri ships it as a mid-grey around `#444`, which is dark for a map but still
reads as a surface, so the app puts a mild brightness filter over the tiles to
take it to near-black. The filter is on the base layer alone: the matching
`Dark_Gray_Reference` service that rides along with it — the same
ride-along arrangement Satellite uses, for the same reason — sits in the label
pane above and keeps its full brightness, so the place names stay readable over
black ground.

It is offered on all seven maps, is never the default, and is independent of the
app's own light/dark theme — tick it under **Base maps** at the top of the 🗺️
**Map display** flyout, alone or blended with another. It is not
offered as a base for **Map Generator** sheets: the print palette is drawn to
sit on a light base and would disappear into a black one, and both laser modes
want no raster at all. *(CARTO's Dark Matter was the first choice and was
dropped: its keyless tiles now come back stamped "API KEY REQUIRED" across the
middle. Esri needs no key and was already serving three of this app's layers.)*

**Base maps, blended.** The four base maps were a radio group under their own
🗺️ *Base map* icon; they are the first section of the 🗺️ **Map display** flyout
now (which took the map icon over from the 👁️ it had), and each one is a
checkbox and an opacity slider. Tick several to mix them — Satellite at 40 % over
OSM-Topo is the contours on the real ground cover — and each is drawn over the
ones listed above it. The order is yours to change: drag a row's ⠿ grip up or
down (a finger works too), or focus the grip and use the arrow keys. Satellite's and Dark's place-name layers follow their base
on and off and at its strength. The mix is remembered (`mn-base-maps`) and shared
by every map in the app; the other six maps, which have no Map display of their
own, get a 🗺️ Map display holding just this section. The 3-D view drapes one
raster, so it follows the most opaque base that is on.

**Elevation shading — an overlay, not a fifth base map.** *Elevation shading*,
under **Overlay layers** in the 🗺️ panel, paints the ground itself in the Radio
Mobile colour file's twelve height bands: terrarium tiles decoded in the browser,
the same ones the elevation profile is built on. It shipped as a *base* map, one
radio beside OSM-Topo, on the reasoning that "what does this country look like"
is the question you have before you draw anything on it. That reasoning was
sound and the answer was still wrong, for a reason a radio button cannot
express: **the ground and the place names are not alternatives.** Picked as a
base it took the localities, the roads and the watercourses with it, so somebody
working out which of two hills a site sits on lost the names of both.

So it is an overlay with an **opacity slider** — the control that makes the two
readings one picture instead of a choice between them — and it draws just above
the base tiles and *below* the place-name layers that ride along with Satellite
and Dark, so on those two the names stay crisp over the wash. On OSM-Topo the
names are baked into the tiles and the slider is the whole of the answer. It
opens at 65%, off by default and remembered; *Shade the slopes* and the full
twelve-band key are beside it. Heights are above the EGM96 geoid at ~30 m
sampling.

> The cost, stated rather than discovered: the other six maps had Elevation in
> their base picker and no longer do. Map display is the Stations map's own
> panel, and a second copy of the switch in the shared picker would be two
> controls for one layer. Say so if you want it back on those maps.

**What is here.** The **ℹ️** button in the side panel's strip (on a phone, in the
rail that ⋮ brings out) arms a pick: click
anywhere and a card in the map's bottom corner says what the app already knows about
that point — ground height, land cover, wind region, drainage basin, maintenance
hub, the land (its lot, tenure, who holds that kind of land, the council area,
the address and the land use — the station card's land section, asked about the
point), and the nearest station, repeater and survey mark with the distance and
bearing to each, every one of them a button that takes you there.

Every fact on that card was already in the app and every one of them was
reachable only by asking about a *station*. The question that actually arrives on
a map is the other one: **this hill here, not the site three kilometres away.**
Siting a new repeater, judging where a road crosses a ridge, working out whose
hub a complaint belongs to — none of those start from a station, and until this
tool the only way to ask was to move a pin and read the station card, which
edits the network to answer a question about the ground.

Three of its rows are deliberately honest about a limit rather than quietly
weaker than they look:

- **Ground height** is a terrain tile — ~30 m sampling, above the EGM96 geoid.
  It is *not* AHD and *not* a survey, and a station's own card carries a
  surveyed figure, so this one names its datum every time. The two must never
  be read as the same number.
- **The nearest survey mark** is the nearest mark the survey layer has actually
  drawn. That layer fetches a viewport at a time past about zoom 12, so with it
  off or zoomed out there is no answer — and the card says that, and offers to
  turn the layer on, rather than reporting the nearest of nothing.
- **Land cover** is a 10 m raster class: a category, not a measurement of the
  tree in front of you.

The card shares one rectangle with the station card and the ACMA transmitter
card, and joins their exclusion — opening any of them closes the others.

**Centring a Map Generator sheet on a station.** The **Map Generator** tab —
the one that turns the network into a printable sheet or a laser plate — frames
its output from a centre latitude, a centre longitude and a scale. Two numbers
in a box is the honest way to say *where a sheet is*, and the wrong way to
choose it: nobody carries their repeater sites' coordinates around, and the way
the question actually arrives is "print me the country around Loudoun". So above
those boxes there is a search field that takes a station name, a station number
or an ALERT address — the same `prepareSearch`/`stationMatchesSearch` pair the
Stations filter box and the link budget's two end boxes use, so all three agree
about what a term matches — and picking a hit drops the frame's centre onto that
station. The picker map follows, and the panel says which station the centre is
sitting on.

The **scale is deliberately left alone**. "Centre on this station" is a question
about *where*, and a sheet that silently rescaled itself would take the plate-size
decision away from the person who made it; the hint says so and the **Scale**
box is one row down. The "centred on" line is derived rather than remembered —
it is only shown while the saved centre still rounds to that station's position
— so *Fit all stations*, a nudge, *Centre output here* or a typed figure all
retire it without anything having to remember to clear it.

**Highlighting rivers.** Half this network is named after the river it sits on,
so typing `burdekin` into the filter box lights up the Burdekin and its named
tributaries as well as the stations on it. *Highlight matching rivers* (in the
map's **Map display** panel, on by default, and the one map *display* switch
remembered between visits) is the control. The rivers are **context, not matches**: they draw
beneath the pins and the signal links in their own blue, they carry the river
name as a hover label, they never move the map's zoom or centre, and they have
no say whatever in which stations the filter selects — untick the box and the
Stations tab behaves exactly as it did before the layer existed.

The geometry comes live from **OpenStreetMap** via the Overpass API, bounded by
whatever the map is currently looking at. Overpass is a free public service, so
each lookup has to earn itself: it needs a name-ish term of three characters or
more (a bare number in that box is an ALERT address, and is treated as one), it
waits for your typing to pause, it is capped at 250 river segments per view, and
answers are cached by term and rounded map extent — so retyping the same word,
or nudging the map, costs no request at all. Zoom out past a 12° view and it
stops asking rather than pull half a continent of geometry. The **Map display**
panel says what happened each time: how many segments were drawn, how many were
over the cap, or that OpenStreetMap could not be reached — and lists each named
river it found as a button that opens that river's callout, so the layer is
usable without a mouse. That last case is the whole
failure mode — no network means no rivers, and nothing else on the tab changes.

> The bundled `assets/geo/Qld Major Streams_reduced.svg` is deliberately **not**
> the source here. Inverting `BASIN_GEOREF` puts its features 100–150 km from the
> actual watercourse, consistently west and south — accurate enough for its own
> job, point-in-polygon against 65 basins the size of small countries, and
> useless for drawing a line over a topographic basemap. Re-exporting it with
> real coordinates would make it a good offline layer, which issue #84 left as an
> optional second phase. #84 closed with the OpenStreetMap layer above; the
> offline one was not built and is not tracked.

**Survey marks.** *Survey marks & CORS sites (Qld)*, in the same **Map
display** panel, draws the Department of Resources' permanent survey marks and
CORS sites once you are zoomed in close enough for them to be more than
scatter — for the field crew doing a height or levelling check near a site,
each mark carries its register number and AHD height. **On by default**, and
remembered between visits the way the rivers switch is: a crew standing at a
site should not have to go find a checkbox first, and an operator who switches
the marks off means it. Default-on still costs nothing at page load — the
minimum zoom gates the fetch and the Stations map opens fitted to the whole
network, an extent far wider than that, so the layer's opening state is *zoom
in to look them up* and no request is made until somebody zooms to a site. The layer spent a while
answering "marks in view" while drawing almost none of them, and the repair is
worth recording because no part of it surfaced as an error: the live
SurveyControl service answers any query carrying a `resultRecordCount`
parameter with HTTP 200 and an empty feature set, so the app drew the ~100
statewide CORS sites — the one sublayer that honours the parameter — and not
one of the ~166,000 marks. The parameter is gone now; the service's group
layers, whose `/query` can only return 400, are skipped; the join-prefixed
attribute names it returns (`sirpub.….mrk_id`) are matched by their last
segment, so marks are labelled with register number and height rather than a
generic "Survey mark"; and the "in view" count counts what the viewport
actually holds rather than everything the padded fetch box returned. Epic
#119 closed leaving a live-browser spot-check of this overlay as a human step
— that check has since been made against the live service, and the service's
behaviour, quirks included, is pinned by `test/survey.mjs`.

Clicking a mark opens its callout, and since #174 the callout's first action is a link to
that mark's own **Survey Control Mark Report** — the Department's PDF, holding
the administrative detail, the GDA2020 and AHD blocks, the survey connections
and, on most marks, the Form 6 sketch that dimensions the mark to the road
edge, a fence corner or a building. That sketch is the thing that gets a crew
from a coordinate to the actual lid in the grass, which is why the link leads.
The link is the one the service publishes; where a mark's row carries none —
the fallback point layer publishes no report link at all — it is derived from
the mark number, `SCR` + six digits, a shape checked against 328 live marks and
CORS sites before it was relied on. Beside it, Street View at the mark's own
coordinates.

The callout also names what the mark physically is (`STAND`, `R/INF`, `BRASS
PLAQUE IN CONC`), its locality description, its condition and when anybody last
visited it, the AHD height with its class and order, and the Department's own
remarks. **None of that is fetched for the map** — the service publishes 54
fields per mark behind join-prefixed keys ~40 characters long, and asking for
what the callout reads takes a 177-mark viewport response from 30 kB to 180 kB,
per sublayer, per view. So the viewport query stays at the two fields it always
asked for, and one mark's full row is fetched when its callout opens and cached
against re-opening. A callout is useful before that lands and stays useful if it
never does: the heading, the coordinates, the height and the report link are all
built from what drawing the mark already knew.

**Road parcels.** *Road parcels (Qld cadastre)*, in the same **Map display**
panel, draws the **road reserve itself** — the surveyed parcel the road is
dedicated over, with its own boundary, its own local authority and usually its
own name. Every base map in the picker already draws roads; none of them draws
the parcel, and the parcel is what the questions actually land on. Is this mast
standing in the road reserve or on the neighbour's freehold? Whose road is the
access track? Can a trailer reach the site without crossing private land? A
centreline answers none of those; a parcel boundary answers all three at a
glance. Hover one and it names itself — road name, locality, local authority.

Drawn in yellow, because that is what a road is on every printed map anybody has
ever navigated from — the layer names itself before the legend does. A deep
golden yellow rather than a pure one, and that is legibility rather than taste:
yellow is the highest-luminance hue on the wheel, so a pure one hairlines away
to nothing over the light topo base while looking fine over satellite imagery.
It carries a heavier stroke than a mid-toned line would need for the same
reason. The two things on this map it sits closest to are the amber pass-range
links and wind region B1's yellow wash over south-east Queensland; a road parcel
is a closed ring with a fill where a link is a white-cased line, and a 95%
stroke where the wind region is a 20% fill, so shape and weight carry the
difference that hue alone would not.

The source is the DCDB's own *Cadastral parcels* layer on the Queensland spatial
platform, filtered to `parcel_typ = 'Road Type Parcel'`, updated nightly — the
same rows QSpatial's SmartMap draws as road. **On by default**, and remembered
between visits, on the survey marks' terms rather than the contours' — because
the minimum zoom does the work the default-off was doing. It draws from about
zoom 13 in and says *zoom in to draw road parcels* above that; the Stations map
opens fitted to the whole network, an extent an order of magnitude wider than
that, so the layer's opening state is *zoom in to draw them* and not one request
is made until somebody actually goes to a site. Which is the moment the question
arrives — whose road reserve is this — and having to find a checkbox first is
what stops it being asked. An operator who switches it off means it. The layer
caches by a rounded bounding box so a small pan costs nothing, and caps at 1500
parcels a view with the note saying when the cap is in effect. Queensland only — the
cadastre it reads stops at the border, and the note says so rather than showing
an empty layer. That matters more here than it does for the survey marks or the
contours, because it is measurable: **1,298 of the 3,173 stations with a
position are outside Queensland**, almost all of them in NSW, and NSW publishes
the same road-parcel polygons with the road name on them. Issue #177 carries
that.

Vector rather than the server-rendered image the contours settled on, and for
the opposite reason: road parcels are sparse where contour lines are dense, a
viewport's worth is tens of kilobytes, and the whole point is to be able to
point at one and be told what it is. It takes no clicks, only hovers — a road
parcel is an enormous target, and a layer that opened a callout every time
somebody clicked inside one would swallow the *click the empty map to clear the
focus* gesture the pins, the ACMA card and the repeater focus all depend on.

**Property boundaries.** *Property boundaries (Qld)*, in the same **Map
display** panel, draws every lot in the same cadastre — the land parcels
Queensland Globe draws — as a white line over a dark casing, so it reads on the
topo and the imagery alike, with each lot's lot/plan written in from about
1:5,000. **On by default**, and remembered between visits, on the road parcels'
terms: the lines draw below about 1:40,000 and the Stations map opens on the
whole network, so a cold load makes no request and the first one goes out when
somebody zooms to a site. An operator who switches them off means it. The layer
was off by default for its first release, and its switch has a new storage key
(`mn-property-boundaries`) so that an *off* saved back then — which only ever
meant "back to the default" — does not keep it hidden now. One server-rendered
image per view rather than vectors, because a suburban screenful is thousands
of lots; nothing in it takes the pointer, and the lot/plan label says what a
callout would have.

**Wind loading regions.** *Wind regions (AS/NZS 1170.2)*, another **Map
display** switch, draws the Standard's wind loading regions — A0–A5, B1, B2,
C and D — under the pins, on the severity ramp the Standard's own map uses:
green temperate through amber and orange to cyclonic red, with the Pilbara's
D in purple. Each of the six A regions has its own shade of that green, because
each of them is a separate region on the Standard's map even though they share
a design speed — one flat green over all six drew a boundary nobody could see.

**On by default and remembered**, on the survey marks' terms rather than the
contours'. The rule that kept it off was *a layer that costs a request stays off
until it is asked for*, and it turned out not to apply: the station card asks
for the same file for its **Wind region** line the moment anybody opens a
station, so having the layer off never avoided the fetch — it only meant the map
stayed silent about which regions the network crosses until somebody went
looking for a checkbox. An operator who unticks it means it, so the answer is
kept between visits.

**The key says what the letter costs.** The legend used to carry one line —
*Wind regions A–D* and a single green swatch — which is a key that names its own
colours and then declines to explain any of them. It is ten rows now, one per
region, each with where it is, the 500-year ultimate regional wind speed from
Table 3.1 (45 m/s in A, 57 in B1 and B2, 66 in C, 80 in D), how much design
pressure that is against a Region A site, and one sentence about what it means
for a structure. The pressure figure is the one that actually explains the
difference, and the reason it is there rather than the speed alone: pressure
goes with *V²*, so a Region D site is not "a bit worse" than a Region A one — it
is about **3.2×** the load on the same mast. Regions B2, C and D are marked
**cyclonic**, which is the NCC's own reading and the line that changes what has
to be built: wind-borne debris, cyclonic connection detailing and low-cycle
fatigue all start at B2, even though B2's wind speed matches B1's. Region A0
carries its own note — it is the only region where the Standard refuses a site
any shelter credit, holding Terrain Category 2 as the floor up to 100 m of
height whatever the ground looks like.

"What wind region is that site in?" — the first question of every mast and
aerial conversation — is answered whether or not that layer is drawn. The
station card on the map carries a **Wind region** line (it was the callout's
until #175 moved the callout's detail onto the card), and the station editor
card below the table carries it as a read-only field beside the elevation:
read-only because it is not a property of the station but of where the
station's coordinate falls, so moving the pin changes it and typing in it could
only ever be wrong. Asking is what fetches the polygons — the card opens on
*looking up…* and fills itself in — and every station after the first is free.
Nothing is fetched at page load, which was always the half of that rule that
mattered.

The polygons are Geoscience Australia's machine-readable interpretation of the
2021 boundaries (eCat 146359, **CC-BY 4.0**), simplified to about 1 km and
bundled at `data/wind-regions-as1170-2021.geojson`, so there is no live service
to be down — 650 kB of continent, about 135 kB over the wire, once per browser.
GA is blunt that the dataset is **indicative and not for design use**, and the
note under the switch, the callout line and the field's own tooltip all say so.

**Google Earth, with the network attached.** The callout, the station card and
the editor card have all carried a **Google Earth ↗** link for a long time — a
camera URL that flies to the coordinate and shows you the ground. What it could
never carry is the thing the map draws *around* that pin: the paths to the
repeaters that hear the station. Somebody standing in Google Earth looking at a
hilltop wants to know what the hop crosses, and a coordinate on its own cannot
tell them.

So the pill beside it, **🌏 Google Earth KML ⬇**, hands over a file instead of a
URL. It carries the station's own pin, a pin at the far end of every link, and a
line for each — pass-range links in the map's amber, backbone paths in its
heavier black, each named with its distance so the file reads as a list as well
as a picture, and every line `clampToGround` with `tessellate` set so it follows
the terrain rather than tunnelling through a ridge it is drawn over. (A straight
3-D chord between two hilltops looks like clearance that is not there, which on
a radio path is the one misreading that matters.) The links are the map's own:
the same `passRelationIndex` and backbone index, on the same **Max TX distance**
rule, so a KML and the map can never disagree about who carries whom. A file
rather than a URL because there is no URL form of it — Google's Earth URLs carry
a camera, not geometry — and KML because Google Earth desktop and web, My Maps,
QGIS, ArcGIS and every handheld that takes a track file all open it.

There is a second KML, from the other direction: **Draw & measure** exports the
whole drawing — see *🌏 KML ⬇ — the drawing in Google Earth* under that panel
below. This one answers *"what does this station reach"* from the network the
app already knows; that one answers *"what did I just draw, and which sites are
in it"* from a plan somebody made by hand.

**The station card's ALERT ids lead.** `6143 — Battery`, not `Battery — 6143`.
The list is sorted by id, and an id is what somebody opening the card came for,
so the number sits at the left edge where a sorted column belongs and the
reading kind qualifies it rather than hiding it.

**Line of sight, for every link at once.** The Path profile tool answers
"does this hop clear the terrain?" for the one line an operator drew; *Check
line of sight on links* asks the same question — the same analysis, at 64
samples — of every drawn field and backbone link, and colours the obstructed
ones crimson. That is its own red, not the one the blast-radius mode paints
(pick a repeater, see what goes dark if it dies): a blast is something an
operator armed and will disarm, an obstruction is a property of the ground,
and both can be on screen at once. Verdicts are cached in the browser
keyed by the physics inputs alone — both ends' coordinates, surveyed
elevations, filed antenna heights and the frequency — so a moved pin or an
edited elevation misses the cache naturally, and a network is profiled once
ever rather than once per session; misses trickle through four profiles at a
time. Two honesty rules carry over from the tools it borrows: a profile with
missing terrain tiles can prove an obstruction but never clearance, and the
map states the network *as filed* — the profile card's what-if antenna and
frequency overrides deliberately do not reach it. The note under the switch
carries the verdict counts and the same k=4/3 earth / ~30 m terrain /
no-trees caveats the profile card owns up to. Like the other layers that cost
requests, it is off by default and not remembered between visits.

**Fade margin, for every link at once — and kept.** *Check line of sight on
links* answers one bit per hop. *Colour links by fade margin* answers the
number: the same Longley–Rice run the link budget card does, over the same 256
samples, with the same land cover stood on the same terrain, for both ends'
filed radios — and the map paints each link **green at 15 dB or better, yellow
at 6, red below**, with the thresholds editable in the same flyout.

That "the same" is load-bearing, and it was learned the hard way. The sweep
first ran at 64 samples over bare ground — MapLos's economics, which are right
for *is the path cut* and wrong for *how many decibels* — and the map and the
card then gave two fade margins for one link: 17.3 dB and 2.2 dB. Sampling a
46 km hop over a range at 717 m intervals accounted for 2.9 dB of that gap; the
missing land cover accounted for the other 12.3, most of it ITU-R P.2108
terminal clutter at two antennas standing under the canopy at 4 m. So cover is
not optional in the sweep: a link whose cover cannot be fetched is a link that
cannot be computed, and is reported as one — because a margin over bare earth
is not a cheaper version of this figure, it is a consistently kinder one.

The margin drawn is the **worse of the two directions**: path loss
is reciprocal and the radios at either end are not, and one line can only
honestly carry one number. Green is a signal green rather than a natural one,
and a pixel heavier than the other two, because half the ground these links
cross is forest or cane and a green line over a green base map is a line nobody
can find.

The difference from the line-of-sight sweep is where the answers go. That one
remembers its verdicts in this browser, so the second person to open the map
pays the whole terrain bill again. This one has a **Save to the datastore**
button: press it and the margins land in `meganet.link_fade_margin`, and from
then on every page load — anyone's — paints the network from the datastore
without fetching a single tile. Every saved row carries the thresholds it was
judged against (`meganet.inspection_rain_gauge`'s `adjustment_threshold_pct`
rule: a threshold that changes must not silently rewrite what was already
judged) and a **signature** of every input the figure came from — both ends'
coordinates, elevations, antenna heights, power, gain, line loss and threshold,
the frequency, the sample count, the propagation settings and a model version.
A row is painted only while that signature still matches what the station list
says today, so a moved pin or a retuned repeater retires the colour and has it
counted as stale rather than letting it quietly age into a lie. Changing a
threshold re-colours instantly and computes nothing — a band is a comparison,
and only the margins are expensive. The read pages: PostgREST hands over a
thousand rows however many are asked for, silently, so a table this size read in
one go comes back a third painted and two-thirds looking uncomputed. Where both switches are on, the margin wins:
it is the one with a figure behind it, and it has already been charged for the
obstruction.

**Draw & measure.** A sketching layer over the network map, opened from ✏️ in
the side panel's strip as a pane beside the map, which stays open while you are
actually drawing — on a phone, from ✏️ in the rail that ⋮ brings out, as a
drawer: pick a tool and tap the dimmed map beside it to draw, the tool still
armed. It is for the picture
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
are cleared by reloading the page — so a drawing worth keeping has to leave the
page, which is what the KML button is for.

**🌏 KML ⬇ — the drawing in Google Earth.** At the top of the panel, beside
*Clear all*. It writes the whole drawing out as a KML file: every shape in the
colour it was drawn in, each named by what it measures and by the sites it was
snapped to, **and a pin for every station those shapes hold** — the ones inside
a circle or a rectangle, and the ones a pin sits on or a line runs between. Each
shape's description lists the stations it holds; each station's lists the shapes
it is in, so a site inside two circles says so once rather than being drawn
twice. Circles and rectangles arrive as filled areas, clamped to the ground and
tessellated so they lie over the terrain instead of floating above it as a flat
plate. Google Earth (desktop and web), Google My Maps, QGIS, ArcGIS and every
handheld that takes a track file open it.

A circle becomes a 72-sided polygon on the way out, because KML has no circle:
the sides are stepped by *bearing* rather than by adding degrees, so a 25 km
circle is 25 km on every side of it at Cape York and at Hobart alike. A shape
typed in as numbers still finds the site under it — a station within 250 m of
a point counts as the one that point is about, which covers the case where
snapping was off or the coordinates were typed rather than clicked.

Screen clipping is still the right answer for a picture of the map itself: a
KML carries the geometry and the sites, not the base map under them.

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
- The full hop chain, field → repeater(s) → base station, is drawn on the
  Stations map rather than listed here: a pass-range link from the station to
  each repeater, and a black-dashed backbone path on to the base. *Repeaters
  listening*, under a selected station, lists the first hop
- Flag stations with no matching repeater (orphaned)
- Pass-range exclusions (reserved for future equipment) sit under the inclusions
  in the station editor's repeater block, and every match on this tab and on the
  map honours them; no repeater in `stations.json` has one
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

Gap detection — the AlertIDs that fall between every window — was planned and
not built, and no issue tracks it. The orphan list is the station-by-station
half of the same question.

### 4. Filtering & Exploration

The **Filters** pane on the Stations tab drives the map and the table together.
It is built from whatever `stations.json` holds, so every option carries the
number of stations behind it and nothing is offered that no station uses:

| Block | Filters on | Control |
|-------|-----------|---------|
| Search | name, station number, ALERT address (numeric queries match addresses from the start), or an ALERT address range like `4021-4025` — one term or a pasted list of them, mixed freely, in as many separately-scoped entries as you like | text boxes that accept a paste, each with *Look in* tick boxes |
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

**Places have a box of their own: 📍 Find a place.** The blue pin in the side
panel's strip, beside the stations' red one (`places.js`). It used to be the
filter box that answered with places as well (#184), which made "Gympie" typed
to find the *town* also cut the network down to the four stations named after
it; a place moves the map and leaves the stations alone, so it has its own tool
and the filter box is the stations' again. Paste a coordinate into it —
decimal, degrees and minutes, or degrees-minutes-seconds, with or without
hemisphere letters, in either order — and the map goes there and drops a blue
pin, with no network at all. Type a name and it lists, grouped:

- **Catchments** — the 77 Queensland drainage basins the file carries, by name
  or basin number ("fitzroy", "130"); pressed, the basin is drawn in outline
  from `data/qld-basins.geojson` and the map fitted to it.
- **Rivers and creeks this network is on** — the register's `stream` values,
  with how many stations each has (a creek written *CK* and *CREEK* is one
  creek); pressed, the map goes to the stretch its stations span, drawn along
  its course where the gazetteer has already answered with it.
- **Council areas with stations in them** — the register's `lga` values, the
  same way.
- **Towns, localities and more** — OpenStreetMap's gazetteer (Nominatim):
  towns, localities, suburbs, airports, hills, rivers and creeks, council
  boundaries, each with its outline or course where OSM has one.

The first three are the file's own and answer at once, offline; the last is a
request, debounced, throttled to Nominatim's one a second and cached, and never
made for a number. A lookup that cannot be made says so and leaves the file's
answers standing. ✕ beside the box, or ↺, takes the pin and the outline away.

**Address ranges.** A term shaped `4021-4025` is a *window* over ALERT
addresses, and every station holding an address inside it is a match. It is the
same syntax a repeater's pass ranges are written in — the Pass Ranges tab prints
them that way and the station editor takes them that way — because it is the
same question arriving from the other side: *which sites are in that block?*
Paste as many windows as you like, on their own or mixed in with names and bare
addresses:

```
4021-4025
4036-4042
4047-4050
```

The dash may be a hyphen, an en or em dash (a window copied back off the Pass
Ranges tab carries an en dash) or `..`, the two ends may be either way round,
and windows separate from each other the same way everything else in the box
does — commas, semicolons, pipes, tabs, new lines, or plain spaces. A window is
matched against the address as a *number*, so unlike a bare term it is not a
prefix match: `4021-4025` is five addresses and nothing else. Nothing that used
to be searched as text is read as a window — no station name or station number
in the file has digits either side of a dash.

**What an entry is a list *of*.** With all three *Look in* boxes ticked — the
default, and what the box has always done — a term is tried against the name,
the station number and the ALERT addresses at once. That is right for one term
typed by somebody who does not know which of the three it is, and wrong for a
pasted list: `491` starts ten ALERT addresses **and** sits inside four station
numbers, and those two sets do not overlap, so a pasted column of addresses came
back with fourteen stations when ten were asked for. Untick what the entry is
not, and it only looks where you say.

**A second entry, for a list that is something else.** *+ Add filter entry*
gives another box with its own tick boxes, so a list of station numbers and a
list of ALERT addresses can be pasted into one filter without either picking up
the other's stations. Entries combine as:

| Match | Means | For |
|---|---|---|
| **any entry** (default) | a station answering any one entry is in — the union | two lists looked up at once |
| **all entries** | only stations answering every entry — the intersection | a name *and* an address range as one question |

An entry with no field ticked is **ignored rather than matching nothing** — an
empty selection is no constraint here, the same rule the tick-box blocks use —
and it says so under itself, so it is never silently dropped. *clear* takes the
stack back to one empty entry pointed at everything, which is how a fresh page
opens.

The amber marks follow the scoping exactly: an entry that says *these are ALERT
addresses* cannot put a highlight through a station name that happens to hold
the same digits, because the filter never made that match.

Under it, the pane reports **which pasted terms are in no station on file** —
"7 search terms · 2 not in this database: 999991, 999992" — once per entry, and
only where that entry is pointed, so a term that exists as somebody's station
number is still *not found* by an entry that said it was a list of addresses. A
list that quietly comes back short is not an answer to "where are these
stations?". Windows are
reported the same way, plus how much they actually cover: "3 search terms · 16
ALERT addresses inside the 3 ranges · all found", so a window naming a block
nobody has addressed yet says so rather than just matching nothing. The Pass
Ranges filter box takes the same lists and the same windows, and matches a
repeater whose pass ranges cover **any** of the pasted addresses — which for a
window is "any address on file inside it", so the answer to *which repeaters
carry this block?* is one paste.

### 5. Radio Mobile Export
Generate the complete set of CSV files required by Radio Mobile software from the JSON data:

| File | Contents |
|------|---------|
| `FloodNet.csv` | Master config (version, map paths, file includes) |
| `FloodNet_Network.csv` | One row per repeater with propagation parameters |
| `FloodNet_Unit.csv` | All selected stations with coordinates and display settings |
| `FloodNet_System.csv` | Transmitter/receiver system specs |
| `FloodNet_NetData.csv` | Network membership matrix (antenna heights, system IDs, roles) |

Export is scoped by the BoM networks ticked on the tab's own rail (with **All** and
**None** to tick or clear them), not by the Stations filters, so a Radio Mobile
project can be generated per network or for several. Per-catchment scoping was
planned and not built; no issue asks for it.

**Both downloads need a signed-in session (#191)** — *Generate & Download All*
and the `stations.json` *Snapshot* beside it. What is behind the sign-in is
taking the network away as a file rather than looking at it: one press writes
coordinates, heights, frequencies and pass windows for every repeater on the
ticked networks and every station their pass ranges reach. Everything that says
what the tab *would* produce — the network ticks, the unit counts, the selected
repeater table and the **Data source** panel with its Re-test button — reads
without one, so the decision to sign in can be made with the numbers on screen.
Ticks survive signing in. The gate is checked twice, in the markup and again
inside each action, because a render can outlive the session it was drawn for.

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

**Two ways in.** The address box on this tab is one. The other is the **ALERT
IDs / Sensors** list in the station editor, where every row carries a *Flip*
link that opens this tab on that row's address — so "what else could this
address have been?" can be asked of the sensor in front of you rather than by
copying a number between two tabs.

The link reads the address out of the *box* at click time, not off the saved
record: a row retyped from 6129 to 6130 and not yet saved takes you to 6130,
which is the number the person is looking at. A row with no address yet, or one
outside 1–65535, shows the link greyed rather than offering one that lands on
*"enter a valid ALERT address"* — and it wakes up as soon as the box holds one.

It sets the address and nothing else. The bit count, *show only matched
addresses* and the ARRO base URL stay exactly as they were left, because those
are the operator's settings and arriving from another tab is not a reason to
reset them. The one thing cleared is the sensor-type filter, which names a type
found under the *previous* address and can otherwise hide every row the new one
has. The Workbench's flagged pairs come in through the same door
(`openBitFlipper` in `bit-flipper.js`) and do set the bit count, to two, because
two bits is the question a flagged pair is asking.

The results table's badges now agree with the Stations tab: a field station's
name chip is in the green family and a repeater's in the blue, the same
`ROLE_COLOR` families the pins and the legend read from — they were the other
way round until recently.

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
- **Station names** — decoded ALERT addresses are matched against the loaded Flood-Net station
  database first (shown with a *Flood-Net* badge), then against the bundled national address file
  `data/All 2021 Working 2.txt`.
- Spec reference: `docs/BOM spec erts_data_formats_doc.pdf` (bundled).

### 8. Radio Path Maps Navigator (Integrated)
Ported from the standalone `ALERT Map Launcher v2.html` (now removed) and
available on the **Radio Path Maps** tab. Browses the bundled Radio-path PDF maps
by region, and — new — suggests the relevant map(s) for any station.

- **Queensland basin map** — a clickable SVG of the state's drainage basins.
  Click a basin (or a region chip) to filter the map list to that region;
  basins are colour-coded by region.
- **Region / sub-region / file navigation** — the same catalogue as the legacy
  launcher (Far North, Mackay/Whitsundays, Burdekin/Townsville, Central QLD,
  Wide Bay/Burnett, SE QLD, West/South West, plus an NSW Border group). The
  three NSW repeater maps, previously mislabelled, are corrected to their real
  filenames.
- **Map catalogue** — until a map is opened, the right-hand pane *is* the map
  list, filtered by whatever the left pane says (region, sub-region, the search
  box — station suggestions included). Each row carries everything known about
  the map — region › sub-region, catchments with their basin numbers, radio
  networks with how many stations are on each, the places it covers, and the
  sheet itself (A3/A4, which way up, file size, the date the PDF was made,
  whether it is a scan of a paper copy) — with a thumbnail of the sheet at the
  far right. **Tiles** swaps the rows for big thumbnails, for finding a sheet by
  its look; **Sort** orders by region, name or newest. A landing starts
  unfiltered with every map listed; the last map opened on the device is marked.
- **Embedded viewer** — opens each `.pdf` in an inline frame (or `.jpg`/image
  maps as pictures) with **‹ Back to list**, prev/next through the filtered list,
  and an "open in new tab" link. Changing a filter while a map is open goes back
  to the list. (`_headers` lets the site frame its own `maps/` files — the
  site-wide `X-Frame-Options: DENY` had been stopping every map opening on
  floodwarning.net.)
- **Station-aware search** — type a **station name**, **ALERT ID**, or **site
  number** and the tool lists matching stations with their suggested maps.
  Suggestions are ranked from three signals:
  1. the station's `radio_network_id` → the "Network to X" / met-office map it
     belongs to (authoritative, where a network id is set);
  2. a **georeferenced point-in-basin test** — the station's coordinates are
     projected onto the basin SVG and the containing catchment → region → map
     is found (approximate, see below);
  3. free-text keyword match against each map's catchment / town aliases.
- Map data (catalogue, basin geometry, georeference, and the generated
  `FILE_META` page facts) lives in `maps-data.js`, loaded before `app.js`.
  Thumbnails are `maps/thumbs/<region>/<name>.webp`, ~7 KB each, built with
  `python3 tools/build_map_thumbs.py`. The map browser works even before `stations.json` is
  loaded; only the station suggestions require the dataset.

> **Data sufficiency for station→map search.** Map *suggestions* are still derived
> at runtime by projecting each station onto `QldBasin_2009Nov_reduced.svg` through
> the least-squares affine fit in `BASIN_GEOREF` (mean ≈ 34 km) — fine for ranking
> a shortlist of PDFs, and the reason #84 says that same fit cannot draw a boundary
> over a basemap.
>
> **Roadmap item (b) is done (#179).** This note used to end on a three-item
> roadmap to make the search exact, and (b) was to populate `catchment_ids` from
> official basin boundaries. They are no longer derived from that fit: they are
> point-in-polygon against the Bureau's own basin boundaries in WGS84
> (`data/qld-basins.geojson`, from `QldBasin_2009Nov.kmz` via
> `tools/build_geo_layers.py`), and 1,754 of 3,173 stations now carry one — 755
> more than before, with the rest outside Queensland. Each station also carries
> `hub_id`, the Bureau maintenance hub responsible for it, from
> `data/bom-hubs.geojson`. Both draw on the Stations map as optional layers
> (**River catchments**, **Maintenance hubs** — off by default), and typing a basin
> name or number into the filter box lights the matching basins up the way it
> already lights up rivers. `catchments[]` now carries 77 basins with each one's
> drainage division. See `db/README.md` → **Where a station is** for what changed
> and how it was checked.
>
> The roadmap's other two items were not done and are not tracked: (a) an `lga`
> field populated from an authoritative QLD LGA boundary set, and (c)
> `radio_network_ids` backfilled for the remaining stations. The `lga` that 1,287
> stations carry is free text from the FRED site list merged in July 2026, and a
> Queensland station's card names its council area from the State's cadastre
> (*Land — tenure and council*, §12); 88 stations carry `radio_network_ids`, 85
> of them repeaters. Nor does the Radio Path Maps search read the real polygons:
> it could take a station's `catchment_ids` in place of the affine fit above, and
> no issue asks for the change (#84, which measured the fit, is closed).

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
    the loaded Flood-Net database and the bundled national address file). A
    *Resync* button drops a byte to shift frame alignment when a stream isn't
    4-byte aligned, and each decoded frame links through to the full ALERT
    Packets decoder. ALERT2 has a card of its own — the ERT-A2, below.
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
- **Quansheng ALERT radio** — a UV-K5 V3 / UV-K1 on the
  [ALERT receiver firmware](https://github.com/cdomotor-g/quansheng_alert_v3) becomes
  a dashboard: readings with fade-margin bars, a signal chart (noise floor,
  sensitivity, every burst), the raw bits of each burst with its frames boxed,
  stations heard — and the firmware's console as controls: clock sync, every
  setting, flash-log download/erase, the station table (built from Flood-Net and
  uploaded in the browser), a live mirror of the radio's screen, reboot.
  See [`docs/serial-radio.md`](docs/serial-radio.md).
- **RTL-SDR (Blog V2 / V3 / V4)** — a WebUSB driver for the RTL2832U with R820T(2) /
  R828D tuners (V3 direct sampling, V4 upconverter and input switching, bias tee),
  and an off-air ALERT decoder ported from
  [agmurf/sdr-alert-decoder](https://github.com/agmurf/sdr-alert-decoder), run in a
  Worker: spectrum with noise floor and peak hold, waterfall, channel power and
  bursts, FM audio waveform and tone spectrum, the decoded symbols, the ADC
  histogram, IQ capture and replay. See [`docs/serial-sdr.md`](docs/serial-sdr.md).
- **RTL-SDR on a Raspberry Pi** — for a computer that cannot reach USB at all (no
  WebUSB, no administrator to give the stick WinUSB): the stick goes on a Pi running
  the same driver and decoder under Node (`sdr-pi/relay.js`), which prints what it
  hears on a serial port — a Pi 4/5's USB-C port as a USB serial device, or a
  USB-serial cable on any Pi's pins — exactly as the Quansheng radio does. PuTTY logs
  that port; the RTL-SDR card follows the log and draws it as it draws a stick of
  its own. The spectrum, levels and decode traces travel inside an escape sequence
  PuTTY does not print, so its window reads like a scanner's while its log carries
  everything; the card's controls copy commands for PuTTY, several changes as one
  line. One install command on the Pi. See [`docs/sdr-pi.md`](docs/sdr-pi.md) and,
  for the protocol, [`docs/sdr-pi-serial.md`](docs/sdr-pi-serial.md).
- **ELPRO ERT-A2** — the ALERT2 / ERT-A2 tab's decoder fed live: the RS232 port's
  ALERT2A lines (with the receiver's clock and its skew against the frame time) or
  the USB port's binary frames (with RSSI), told apart by what arrives; every
  reading matched to its station the way that tab matches them, a stations-heard
  table, CSV export, and *Open in the ALERT2 tab* for the map and frame anatomy.
- **Following a log file instead of a port** — for a computer whose browser will
  not open a COM port. PuTTY opens the port and logs it (Session → Logging → *All
  session output*); any serial card — generic, Quansheng or ERT-A2 — follows that
  file as it grows, through the same pipeline a port's bytes take. Drag the log
  (or the folder PuTTY logs into, to follow its newest file) anywhere on the tab:
  a radio's or an ERT-A2's log becomes that card by itself. Re-picking a file with
  `<input type=file>` cannot do this — Chromium refuses to read a picked file
  again once it has changed (`NotReadableError`) — and the File System Access
  picker is what a managed Chrome/Edge switches off
  (`DefaultFileSystemReadGuardSetting`), so a dropped file is read through the
  File and Directory Entries API instead, which that policy does not cover
  (measured on Chromium 141 with the policy installed). Receive-only: PuTTY holds
  the port, so the radio's console buttons copy their command for pasting into
  PuTTY, and the replies are read back from the log. See `log-follow.js`'s header
  and `npm run logfollow`.
- **A base station in the browser** — the Quansheng, ERT-A2 and RTL-SDR cards can
  post every reading they decode into Flood-Net's database (*Send to Flood-Net*), through
  the same `ingest_http()` door and token model every base station uses, with source
  `serial` and a per-receiver path (`serial-monitor/<receiver id>`) so ingest points
  can be told apart — and two receivers hearing one reading are both on record. Each
  receiver reports its name, kind, device and location through
  `report_ingest_point()` (`0045`); with no GPS the location is the browser's, a
  station's, typed in, or the middle of the stations heard, and the database refuses
  to store anything but a GPS fix as exact. Readings out of a followed log's history
  go only with a time of their own; demos and replays never. See
  [`docs/ingest-serial-monitor.md`](docs/ingest-serial-monitor.md).
- **GPS** — a USB GPS puck (any NMEA 0183 receiver) is a card of its own: fix,
  satellites, accuracy, speed. Every receiver card stamps its position on what it
  hears, and a receiver sending to Flood-Net can use it as its location — the one kind
  the database records as exact.
- **Reception log and the Reception Map** — every frame each receiver hears, good or
  bad, with level and position, kept in the browser and (sending to Flood-Net) in the
  database (`0047`). The **Reception Map** tab maps it and ranks the repeaters most
  likely to be flipping bits in what they relay. See
  [`docs/reception-map.md`](docs/reception-map.md).
- **Demos** — each card has one, so the tab can be seen with nothing plugged in.
- **Managed / work computers** — enterprise policy can block Web Serial, in which
  case the browser rejects the port picker *instantly without showing it*. The app
  detects this (an instant rejection can't be a human cancelling the dialog) and
  shows targeted advice; [`docs/serial-help.html`](docs/serial-help.html) has a
  ready-to-send IT request with the exact Chrome/Edge policies
  (`SerialAskForUrls`, or `SerialAllowUsbDevicesForUrls` to pre-approve a device
  with no picker at all — pre-approved ports show up under *"Previously allowed"*).

### 10. Theme — System, Light, Dark or Sunlight
- 🌗 in the banner opens the four (#224). **System**, the default for a device that
  has never chosen, follows the device's own light or dark setting, and changes
  when it does; Light and Dark are fixed; **Sunlight** is the light theme with the
  contrast turned up and the map's lines drawn heavier, for a phone read outdoors.
- The choice is kept in `localStorage` (`mn-theme`, where the old light/dark
  choice was, so it still stands). `npm run shell` holds all three themes to the
  same contrast pairs; `npm run themes` holds which one is worn, and when.
- Windows contrast themes (forced colours): the open tab, the palette's marked
  option and pressed toggles keep an outline in the system's highlight.

### 11. Radio Network Management
- Named radio network clusters (typically named after the primary repeater or
  ingest point) — fifteen, in the station document's `radio_networks`. A
  station's networks are on its card, in the Pass Ranges tab's *Network* column
  and in the Ghosting Graph's filters
- Scope to a network: the Stations filter's *Radio network* block narrows the map
  and the list, and the Export tab's own ticks scope the Radio Mobile files, with
  **All** and **None** as the select-all and clear-all shortcuts (§5)
- Assigning stations to networks in the app was not built: `radio_network_ids`
  and the network list arrive with the station document, the station editor has
  no field for them, and no issue asks for one. The **Networks** tab that listed
  the clusters was removed at roadmap revision 91 (§14)

### 12. Station Detail Panel
Side panel or modal showing full station record:
- Name, number, coordinates, elevation
- All AlertIDs with sensor type labels
- Radio network memberships
- Repeater pass ranges, as `low–high` text in the station editor's repeater
  block — the visual range bars the plan drew were not built, and no issue asks
  for them
- Matched field stations (if repeater) — the repeater block's *ALERT IDs in
  range → stations*
- Matched repeaters (if field station) — the *Repeaters listening* card
- Satcom details were not built: every station keeps a `satcom` block, nothing
  shows it, and none in `stations.json` has it switched on. No issue asks for it
- A link to ARRO's graphs — *Graph last 7 days* in the editor's ARRO block draws
  every sensor of the station at once, and each sensor row with an ARRO device id
  links to that sensor's admin page
- **Site exposure — tides and soils** (Queensland): whether it stands in or
  near tidal water, the nearest Water Act tidal limit, the coastal management
  district and storm tide areas, and the acid sulfate soil mapping under it,
  asked of the State's map services when the card opens — indicative, and a
  source that did not answer is named, never read as "none"
  (`site-exposure.js`; `docs/site-exposure.md` has what each row means)
- **Land — tenure and council** (Queensland): the lot and plan the station
  stands on (with the State's free SmartMap of it), its tenure — freehold, a
  reserve, State land, a national park, a road reserve, a watercourse — who
  holds that kind of land in plain words (a reserve: the State through a
  trustee, most often the council), the council area, the street address, the
  rural property's name and the mapped land use. Queensland does not publish
  owners, so freehold says the owner is on the title and links to a title
  search (`site-land.js`; `docs/site-land.md` has what each row means)
- **Equipment**, for signed-in editors: what the station's register says is
  fitted there, once an administrator has approved it (`photo-review.js`)

### 13. In-App Bug / Idea Reporter
The **🐞 Report a Bug** button in the header lets any user flag a problem or
suggestion without leaving the app. Because Flood-Net is a static GitHub Pages
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
- App build (read from the `core.js?v=` cache-buster), theme, page URL
- Browser, platform, language, window/screen size, online state, timestamp
- **Recent uncaught JavaScript errors** — captured from page load via global
  `error` / `unhandledrejection` handlers (`core.js`), so the actual failure and
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
| **Stations & networks** | Stations · Radio Path Maps · Pass Ranges · Export · Map Generator |
| **Interference** | RF Environment · RF Changes · Interference Workbench |
| **ALERT** | Bit Flipper · Ghosting Graph · ALERT Packets · ALERT2 / ERT-A2 · HFEM Messages · Serial Monitor |
| **Data** | ARRO Launcher · ARRO Data · Field Data · Message Log |
| **Site visits** | Inspections · Site Maintenance · Inspection History · Field Photos |

#### Where the grouping comes from
Three groups held these tabs until #108, and one of the three held eight of the
nineteen. "Radio investigation" was a defensible heading — all eight *are* radio
work — but a group you have to read end to end to use is a list, not a grouping,
and a second group had quietly grown to seven.

What re-cut it was not taste. `HELP[id].related` is the app's own statement,
written a tab at a time and never with the sidebar in mind, of which tabs belong
beside which; read as a graph it does not describe three groups.

- The eight-tab group is **two clusters with nothing mutual between them**. `rf ↔
  rfchanges ↔ workbench` is a closed triangle; `bitflipper ↔ network`,
  `bitflipper ↔ packets`, `packets ↔ alert2`, `packets ↔ serial` and `alert2 ↔
  serial` are a second. The only edges between the halves — `workbench →
  bitflipper` and `network → workbench` — are both one-way.
- The seven-tab group is likewise two closed triangles, `arro ↔ arrodata ↔ field`
  and `inspections ↔ maintenance ↔ history`, with **no edge of any kind** between
  them. Reading a sensor trace and filling in a paper form had been filed
  together on the strength of the word "data".
- **Export moved.** Its own `related` entries are Stations & networks tabs,
  `passranges ↔ export` mutual among them, and what it builds is scoped by the
  radio networks ticked on its own left rail. It sat under "Data & admin" and
  belongs with the network it exports.

#### Three tabs said "network" and meant three things
`Network Maps` is not about networks — it browses the bundled Radio-path PDF map
sheets — so it is **Radio Path Maps**. `Network View` is not about networks
either: it draws ALERT addresses as nodes and bit-flip ghosting between them as
edges (§16 already called it the ghosting knowledge graph), so it is the
**Ghosting Graph**. Both old labels survive as find words, so the rename strands
nobody; **tab ids are unchanged**, because they key `HELP`, `renderMain()`, the
teardown registry and `localStorage`.

The third of the three, `Networks`, has since been removed outright. It was a
read-only listing of the named radio-network clusters and the catchment
vocabulary, and every number on it is already on a tab somebody is on anyway —
the network a station belongs to is on its card and in the Stations filter pane,
and the ticks that scope an export live on the Export tab's own rail. `networks`
as a *word* survives as a find term on Stations and Export, which is where the
answer now is.

#### Find a tab — and Search
Nineteen tabs is past the size where a column of labels is something you scan, so
the nav carries a find box — 🔎 on the collapsed rail opens the nav with the cursor
already in it.

**Ctrl/Cmd+K** from anywhere — or 🔎 **Search** in the banner — opens one box for
everything (`palette.js`, #221): **stations** by name, station number, ALERT
address or address window (the Stations filter's own matching, Ck/Creek and all),
**places** handed to 📍 Find a place (a coordinate, a town, a river, a catchment,
a council), **tabs** by the nav's own scoring below, and a few **actions** (the
Site Map, help for this tab, a link to where you are, a file, an export, the
theme, a bug report). With nothing typed it offers the stations looked at this
session. Enter opens a station through `goToStation()` — one step in the
browser's history, its card up and the map on it.

- It matches the **label, the group heading and the tab's `find` words**, so
  "packet decoder", "com port", "contrail" and "pdf" all land where the label
  alone never would.
- **Best score wins**: the tabs matching the most of what was typed. A second
  word narrows without ever overshooting into nothing, a word on no tab costs
  nothing, and a query that means nothing returns nothing and says so.
- Terms match **from the start of a word**, so "insp" finds Inspections but "the"
  does not find *hypotheses*.
- The best match is marked **↵** and is what Enter opens — not the topmost
  result, which is a different tab whenever a group heading has pulled its whole
  group in. The list keeps its order rather than re-sorting under the cursor.
- The query is an errand, not a setting: picking a tab clears it, collapsing to
  the rail clears it, and it is never persisted.

- **Collapses to an icon rail**, not to nothing — icons and tooltips stay, only
  the labels go. On the rail a tooltip names the group as well as the tab, since
  the heading giving it that context is clipped. The state is kept in
  `localStorage` under `mn-nav`, alongside `mn-theme` and `mn-filters`.
- **Starts collapsed under 900 px**, on a first visit only. The Stations tab is
  one long column already; a second permanent column on a laptop is one too
  many. A stored preference always wins.
- **Under 560 px it opens as a drawer over the content**, not as a column beside
  it. 236 px of nav plus a page that wants the rest of a 390 px phone does not
  fit at any setting, so the rail keeps its place in the layout and the expanded
  nav floats above — then closes itself once a tab has been picked.
- Keyboard-driven: ↑/↓ walk the tabs and the find box as one column, and the
  active tab carries `aria-current`. Each group is a `role="group"` labelled by
  its own heading, so the rail is still five groups to a screen reader after the
  headings have been visually clipped.
- `TABS` in `core.js` is the single description of the nav — groups, labels,
  icons and find words — and both the rail and its headings are rendered from it.
  `npm run nav` asserts that every tab in it reaches the nav exactly once and is
  findable by its own label; smoke cannot see that, because it opens tabs by
  calling `switchTab(id)` and never touches the nav.

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
- **The ARRO Launcher tab** — a jump box, grouped under **Data**.

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
  together at the top of `core.js`. The Bit Flipper's *ARRO base URL* box is
  still the only control, and its host now drives every ARRO link in the app —
  the box says so, and a base that won't parse falls back to the default rather
  than producing a broken link.
- The launcher works with no `stations.json` loaded — only the search needs it,
  and it says as much instead of showing an empty box.

One thing this shook out: the app had **no `a` rule at all**, so every link fell
back to the browser's `#0000EE` and, once followed, `#551A8B` — two shades of
near-black on a dark panel. Links are now `var(--accent)`, visited included.


### 16. Ghosting Graph (ALERT Address Ghosting, as a Graph)
The Bit Flipper answers "what else could this address be?" one address at a
time. The Ghosting Graph asks it of the whole file at once and draws the answer:
**ALERT addresses are nodes, and a relationship between two of them is an edge.**
Grouped under **ALERT**, next to the Bit Flipper it generalises.

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

### 17. Terrain Path Tools (Elevation Profile, Ground Cover & the Longley–Rice Link Budget)
Two features under the Stations map that both answer *"will this radio path
work?"*, and one module underneath them that neither could exist without:
**ground elevation along a line**, which Flood-Net previously had no way to get.

**Terrain, with no backend.** Flood-Net is a static page on GitHub Pages, so an
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
`elevation_ahd` wins for that **endpoint** and tiles supply everything else —
the ground between the ends, and an end that has no surveyed height of its own.
Which of the two an end is using is named on the card, and the panel says so
under every profile it draws.

**The elevation profile** appears under the map once a line exists in *Draw &
measure*, and plots ground (with the earth-curvature bulge folded in so the line
of sight can be drawn straight — k derived from the surface refractivity at the
path's own mean height, the way the propagation model derives it, so N₀ = 301 at
sea level is the textbook 4/3 and a path at 600 m is a little less), **what
stands on the ground** as a coloured band per land-cover class, the LOS between
the two antennas, the **60% Fresnel zone**, and the stretches where terrain or
cover intrudes into it — plus a plain-English verdict, *clear / marginal /
obstructed*, an *Obstructions* list that says whether each one is ground or
cover, the elevation angle at each end, and the path loss the model computed. Antenna heights default
from the station's `rm_systems[].antenna_height_m` and the frequency from the
repeater's `rx_mhz`; both are editable, and each box says whether it is showing a
default or an edit. The chart is inline SVG in the manner of `rfStripPlotHtml()`
and `rfcChartHtml()` — no charting library, nothing fetched to draw it.

Three things about how it is drawn are choices rather than defaults. The plot
area is **painted**: it had been transparent, which meant the picture ran into
the page and had no edge of its own, so there is a sky wash behind it and a
border round it now. The curvature that is folded into every ground reading is
also **drawn**, as an arc along the bottom of the plot with the planet filled in
underneath it, the way Radio Mobile shows the same thing — measured up from the
plot floor at the chart's own vertical scale, so it is genuinely flat on a 5 km
hop (a metre and a half of it) and bows up hard on a 100 km one (a hundred and
fifty), and the legend prints the figure so nobody has to measure it off the
picture. And **built area is black on light, white on dark** rather than the
brick red of Esri's Sentinel-2 legend, because red on this chart means an
obstruction — the Fresnel intrusion, the worst-point marker, an obstructed link
on the map — and a red band standing on the terrain read as one of those at a
glance. Finally the *Path* row under the chart is one end per line rather than
`A → B` wrapped wherever the names ran out, so every figure below it stays where
it was for the last path.

> **On the Fresnel coefficient.** The first-zone radius here is
> `r1 = 17.32·√(d1·d2 / (f·D))` (km, GHz, metres), not the `8.657` the original
> ticket quoted. `8.657` is the same formula already specialised to the path
> *midpoint* with the total distance as its argument (17.32/2). Using it against
> `d1·d2/(f·D)` would halve the zone everywhere, and a half-size Fresnel zone
> reports clearance that is not there — the one direction this must never err in.

A **multi-leg line is a distance profile only** — no LOS, no Fresnel, and a note
saying why. A dog-leg is not a radio path, and drawing a line of sight across a
corner would describe a path nobody drew.

**Ground cover — Radio Mobile's *Land cover* layer, from a better map.** A 4 m
field-station antenna in a gum forest is not 4 m above the ground the radio
sees; it is 11 m *below* the top of it. `LandCover` samples the Esri / Impact
Observatory / Microsoft **Sentinel-2 10 m Land Cover** (one class per 10 m
pixel, a map per year) at the profile's own sample points — all 256 in one
cross-origin `getSamples` request — and stands each class's **representative
height** (ITU-R P.1812's term) on the terrain: trees 15 m and built area 10 m
from P.1812-6's defaults, crops 2 m, flooded vegetation 5 m, rangeland 1 m,
water and bare ground 0. Where the class says *Trees*, the height is taken from
the **Esri Global Canopy Height 2020** map instead (ETH Zürich's 10 m canopy
model, ±5 m) — LERC tiles decoded in the browser with Esri's own decoder, loaded
from a CDN the first time a profile needs it — so a stand of ironbark and a
strip of regrowth stop being the same 15 m. The band is painted in the class's
own colour (theme tokens, both themes), the legend names every class on the path
and the height it stood at, and the table of heights under the chart is
editable and remembered. The switch is on by default and *off* is said in
warning colour, because a bare profile reads clear through a forest. The cover
goes into the profile the way P.1812 §3.2 says and Radio Mobile does: at every
interior sample, and **not at the two ends** — an antenna's own surroundings
are the terminal term below, so a canopy is never counted twice.

**The link budget card** takes two points — each independently a station or an
arbitrary point on the map — and itemises the path:

```
EIRP           = tx_power_dbm + tx_gain_dbi − tx_losses_db
Free space     = 32.45 + 20·log10(f_MHz) + 20·log10(d_km)
Terrain        = A_ref, the Longley–Rice reference attenuation over the profile
Statistics     = the climate's median shift + the variability for the reliability asked
Ground cover   = ITU-R P.2108 §3.1 terminal loss at an end whose antenna is under the cover
Obstruction floor = knife-edge over the worst obstruction, where the model's regime prices it lower
= Path loss    = the sum of those
RX predicted   = EIRP − path loss + rx_gain_dbi − rx_losses_db
Fade margin    = RX predicted − rx_sensitivity_dbm     (Radio Mobile's "Rx relative")
```

Every term is its own row, signed, and visibly adds up to the received level —
never a single number.

**The propagation model is Radio Mobile's.** `itm.js` is the ITS Irregular
Terrain Model (Longley–Rice) in point-to-point mode, ported function for
function from NTIA's reference C++ — v1.3, which NTIA states is functionally
identical to Hufford's FORTRAN v1.2.2, the code inside Radio Mobile's DLL — and
held to it by `npm run itm`: 53 reference losses computed by the compiled NTIA
library (its five published vectors plus 48 synthetic profiles across every
regime, climate, polarisation and mode of variability), matched to **10⁻⁶ dB**
with every intermediate (Δh, effective heights, horizons, N_s, warning bits).
The card's **Propagation settings** are the model's inputs and Radio Mobile's
network properties one for one — radio climate, surface refractivity, ground
permittivity and conductivity, polarisation, mode of variability and the three
percentages — and start from the figures the Radio Mobile export writes
(`RM_NET_DEFAULTS`: continental subtropical, N 301, ε 15, σ 0.005, vertical,
Spot, 50 / 50 / 70), so the two tools argue from the same premises. Spot mode
reads only *% of situations* and greys the other two, as Radio Mobile does.
Under the table, the readouts of Radio Mobile's Radio Link window: azimuth,
elevation angles, worst Fresnel, obstructions, k and N_s, propagation regime,
Δh, effective heights and horizons, the median shift and the variability, the
received level in µV, E-field and the field the receiver needs, system gain —
and the model's own warnings in words.

Two things here are deliberately *more* than Radio Mobile does. The terminal
term: where an antenna stands below the cover around it, ITU-R **P.2108 §3.1**'s
height-gain loss (a knife edge at the clutter's edge, 27 m away — ~13 dB for a
4 m antenna under 15 m trees at 150 MHz, ~18 dB at 450) is charged at that end,
applied only for cover that stands up, since open ground's height gain is
already inside the model's effective heights. And the **obstruction floor**:
ITM picks its regime by the smooth-earth horizon, not by what stands in the way,
so two low masts 10 km apart are "line of sight" to it with a ridge between
them and the ridge reaches the loss only through the interpolation — the
"smearing" ITM is criticised for and Radio Mobile inherits. When the geometry
says the line is cut and the model's excess over free space is below one knife
edge over the worst obstruction, the loss is held to that, in a row of its own
that is nought on most obstructed paths.

What it still leaves out is on the card too, in a comparison table against
Radio Mobile line by line: antenna patterns (one gain figure in every direction,
where Radio Mobile reads `.ant` files), interference, and whatever the map
missed. The banner says *a model, not a measurement*, and means it. Station ends auto-populate from `rm_systems[]` via
`rm_system_id`; **arbitrary ends make relocation studies work**, which is the
reason both ends are independently either kind: drop an end on a hilltop nobody
has been to and see what the path would do. Auto-filled values are all editable
and marked `default` (from the station data), `assumed` (a hypothetical site's
starting figures, which came from nowhere but this code) or `edited`. The
terrain, statistics and cover terms come from the profile; with no profile for
those two points the card says the result is **free-space only** rather than
quietly reporting a clear path — and offers *Profile this path*, which draws
the two ends as a line in *Draw & measure* so the elevation panel picks it up
and the model can run. Pressing it again lands back on the same line rather
than stacking another one at the same coordinates. Where a profile exists but
the model refuses it (a hop under a kilometre, a mast under half a metre) a
single knife edge stands in, labelled as a proxy. Margin classes are read
against a figure that already carries the statistical allowance for the
reliability asked, so they sit where Radio Mobile's own style does: good ≥ 10 dB
· marginal 3–10 · poor < 3.

**Either end is found by name, number or ALERT address.** Each end carries a
search box running the same `prepareSearch` / `stationMatchesSearch` pair as the
Stations filter, Pass Ranges and the ARRO Launcher — so a name, a station
number, an ALERT address and an address window like `4021-4025` all mean here
exactly what they mean there. Putting the caret in an end's box **arms** that
end: the next station picked anywhere — a pin on the map, a point on the ground,
or a row in the **Stations** list in whatever state the filters have left it —
lands on *that* end rather than on whichever happened to be empty. An armed pick
does not also select the station into the editor below, because an operator
building a budget asked for an endpoint, not for the form to be reloaded and the
map flown somewhere. **Clear A**, **Clear B** and **Clear both ends** wipe one
end, the other, or the pair — the station, its overrides and whatever is typed
in its box.

> Until this existed the card said "click a station on the map" and, on the pin
> itself, that was not true: markers are built with `bubblingMouseEvents: false`,
> so a click dead on a pin never reached `map.on('click')` and never reached the
> budget. What worked was clicking *near* a pin — inside `MapDraw`'s 15 px snap
> ring and outside the pin's own hit area — which is not an instruction anybody
> could follow. The marker handler now offers the pin to an armed pick before
> anything else it does.

**Each end shows the ground it is standing on**, and where that height came
from: a station's surveyed `elevation_ahd` where there is one, and a terrain-tile
sample (EGM96, and labelled as such) where there is not — which is most stations,
since only 840 of 3,174 carry an `elevation_ahd` at all. An end whose tile cannot
be fetched says *unavailable* rather than defaulting to sea level.

**The two cards can be set to different assumptions, and the budget says when
they are.** The elevation profile carries its own antenna heights and frequency;
the budget carries a height per end and a frequency of its own, and computes its
diffraction term at *those*. So the chart can show a clear path while the table
quotes a loss from an obstructed one. Neither figure is wrong, but saying nothing
about the gap would be, so the diffraction row names the frequency and the two
antenna heights behind it, and a note under the table spells out what the chart
above is drawn at whenever it differs — with a button that redraws the chart on
the budget's figures. That is a button rather than something the budget does by
itself: the profile's overrides apply to *every* line drawn on the map, so
writing to them would silently re-height the next hand-drawn path too.

The **ground under each end** is the third assumption the two can differ on, and
the one that bites hardest — a different ground height is a different line of
sight, so the same hop can come back *clear* in the table and *obstructed* on the
picture above it. The chart stands an end on the station's surveyed
`elevation_ahd` and otherwise on the profile's own sample; the card stands it on
whatever `fillGround` sampled at a single point, at its own zoom. Both heights
now ride along with the analysis, and the card says so when they disagree by more
than half a metre. There is no *redraw* button for this one: neither height is an
assumption to be switched, and the honest reading is the surveyed one where a
survey exists.

**A figure nobody supplied is not nought, and a path with no length has no
margin.** An absent antenna gain or feeder loss used to fold into 0 dB and carry
on, so the row printed `—` while the `= EIRP` subtotal beneath it was computed as
though a number had been given: the column silently stopped adding up. Those
terms now blank the margin the way a missing TX power and RX threshold always
have, and the row names which of them is missing. Both ends in the same place is
the other one — FSPL over a distance of nought is 0 dB, correctly and
catastrophically, so the margin came out at +155 dB and read **Good**. The same
station is refused at the second end with a reason, and a zero-length path
reports **No path** rather than a number.

**Where the two features disagree, the terrain wins.** A blocked path with no
model over it can still show a fat margin — one knife edge is the most
optimistic diffraction model there is, and here it is standing in for a ridge
*above* the line of sight. So when the profile says obstructed and the model
did not run, the margin row is forced red and reads **Obstructed**
however good the number looks, instead of "Good".

**The disclaimer is part of the feature, not decoration.** A red banner sits at
the top of the card, always visible and never dismissible, and a collapsible table
one click below it lists exactly what this leaves out that Radio Mobile models —
clutter, climate and refractivity, statistical reliability, real antenna
patterns, multipath, polarisation, noise floor. Nearly all of those *reduce*
real-world margin, which is why "indicative" here mostly means **optimistic**:
a good margin is permission to model the path properly, never a result.

#### Repeater site finder

The tools above answer questions about a path somebody has already drawn. Siting
a new repeater starts from the other end: *these* gauges have to be heard —
where does the mast go? **🗼 Repeater site finder**, in the side panel's strip among the
tools you point at the map, answers it.

**The sites to serve**, three ways, in any mixture and up to forty:

- **Add the map selection** — whatever is picked on the map (shift-click, box
  select, *Select inside*).
- **Draw a circle** — arms Draw & measure's own circle tool; click the middle,
  click the edge, and the stations inside land in the set. The circle stays on
  the map, can be typed to an exact radius, and is offered again under the button.
- **Paste a list** — station numbers, names, ALERT addresses and `4021-4025`
  windows, one per line or comma-separated, and a `lat, lon` on a line of its own
  for a proposed site with no station yet. Exact matches win over substrings, so a
  pasted column of station numbers does not quietly enrol every station sharing a
  digit run; a term that matches nothing is named, a word that matches many is
  handed back ("“creek” matches 457 — give the station number or the full name"),
  and both stay in the box to be corrected. Add the base or the next repeater too,
  if the new one has to reach it.

**Find sites** then works in two passes. It fetches one terrain grid over a
circle round the sites (the *Beyond the furthest site* margin, 5 km by default),
takes the highest summits in it — thinned so no two are the same hill, plus the
highest in each of a 5×5 set of blocks so a lower hill in the middle of the sites
is weighed against the range on the edge — and **screens** every one against every
site with `pathAnalyse` over bare ground. The best few (the number asked for plus
three spare) are then **refined** the link budget card's way: 256 samples off the
tiles with the land cover stood on them and P.2108 charged at a mast under trees —
so the fade margin quoted for a result is the figure the card will show when the
path is opened in it. The two passes are never mixed in one ranking.

**The score** is four figures, each 0–100, weighted by four sliders you own and
all printed beside every result: **elevation** (across the candidates' range),
**line of sight** (clear 1, marginal ½, obstructed 0, averaged over the sites),
**fade margin** (the worse direction of each path, as a fraction of the map's own
*good* band) and **road reserve** — on a Queensland road parcel scores 1, falling
to 0 at 250 m, asked of the cadastre for the finalists only and only while its
slider is above nought. A mast on road reserve is the rare happy case — no
landholder, no lease, a road to it — so it is a bonus, never a filter, and a
cadastre that cannot be reached is said to have failed rather than read as "no
road here". Moving a slider re-ranks at once without re-running anything; changing
the sites, the radio or the search area takes the answer away, because a list of
results still on screen under a question it does not answer is the one way this
can mislead.

Pick a result and its paths are drawn coloured by fade margin (dashed where the
ground cuts the line) with every site listed against it; **Profile the worst
path** opens that one in the elevation profile. **Also score existing station
sites** weighs the masts already standing in the area against the bare hills —
a site with power, a track and a willing landholder is worth metres. **Save CSV**
writes every result against every site. It is indicative in exactly the ways the
rest of this section is — ~30 m terrain, omnidirectional antennas, representative
cover heights, no buildings — a short list to take to a map and a landholder, not
a site survey.

**Everything else on the map** (under *On the map*) fades the rest of the map so
the answer can be seen: 0–100 %, remembered, and applied to every Leaflet pane
from the overlays up — the network's own canvas (links and pins), the marker,
shadow and tooltip panes, and every context layer's pane (rivers, roads, wind,
survey, contours, peaks, the polar plot, arrows, leader lines) — but never to the
finder's own two panes or the popups. The base map, its labels and the elevation
colours keep the sliders they already have in 🗺️ Map display. Because the
stations' own pins fade with the rest, each site to serve carries a dot of the
finder's own under its ring and, while the fade is on, its name. The fade applies
only while the finder has sites or an answer, so a low value remembered from
yesterday never opens today on a map with no network on it; **Clear** and ↺ put
the map back.

**🌏 Google Earth (KMZ)**, beside Save CSV, writes the answer for Google Earth —
on the web, *New → Import file to project* (or *Open local KML file*), or Earth
Pro's *File → Open*. The file is laid out to be compared one candidate at a time:

- **Sites to serve** — every site, a station with its number, roles, ALERT ids
  and position, and each saying which candidate serves it best.
- **One folder per candidate** (`#1 — 612 m · score 83 · 7 of 7 at ≥6 dB`,
  only #1's open) holding its numbered pin — whose balloon is the panel's summary,
  the road reserve and a table of every site's distance, line of sight and margin —
  and **Links from #n**: one path per site, draped on the ground and coloured by
  its fade margin band exactly as on the map, a path the ground cuts thinner and
  fainter since KML has no dashes; each carries the CSV's own column names as data.
  **#1's paths are on and every other candidate's are off** — on the folder and on
  each path, because Earth on the web converts an import into project features —
  so ticking a folder puts one candidate and its paths on the terrain at a time.
- **Sight lines at antenna height (3-D)**, per candidate and off by default:
  straight chords from the mast top to each site's antenna top, relative to the
  ground — "is anything solid in the way" over Earth's terrain, labelled as a
  chord and *not* Fresnel clearance.
- **The search area**, as an outline.

The KMZ is a stored zip whose first entry is `doc.kml`, with the numbered pins
drawn on a canvas in the map's own blue-disc style inside it; **KML** is the same
document with Google's own numbered pins, for tools that will not open a zip. Both
carry the caveat above. Heights are never absolute — the finder's ground is SRTM
above the geoid and Earth's is its own.

**In ⛰️ 3-D** the finder is on the terrain as well: the search area, the rings,
the chosen candidate's paths (from its own MapLibre source, between the network's
links and pins) and the numbered pins, which a click picks there just as on the
flat map. The fade reaches the network's links, pins, the What-is-here mark and
the line-of-sight sheets, and not the base map or the elevation drape. **Draw a
circle** is off while 3-D is on and says why: Draw & measure places its clicks on
the flat map under the 3-D view.

`npm run sites` holds it to all of this on a synthetic hilly world.

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

**And the panel says what the test is.** *How the 357 filter works* opens an
explainer with the test itself, the direction it walks, the three states, the
four-failure break, rollovers, repeats, and why the numbers are counts rather
than millimetres — reachable from the panel header, from the removed count, and
from any rejected reading you click. It carries two drawings: the spec's two
components as a flowchart, and a worked example of fourteen readings with a
spike and a dropout in it. The example's colours are not illustrative — they are
what `walk357()` returns when handed exactly those numbers, so the diagram
cannot drift away from the code that made it.

**Every filter has a switch, and not every filter is the spec's.** The 3-5-7
test, rollover correction, repeat timestamps, a **rate-of-rise** limit, a
**rate-of-fall** limit, **minimum / maximum** limits and the export's own
**quality codes** each have their own on/off, so any of them can be taken out of
the pipeline and the difference read straight off the counts. Only the first two
come from the specification; the rest are gates this app adds, and they run
*before* the continuity walk so a reading nothing could have produced never gets
a vote on its neighbours:

- **Rate of rise** compares each reading with the one before it, and claims the
  step and nothing more. Anchoring to the last *surviving* reading is the
  obvious-looking alternative and it is a trap — a gauge that genuinely steps up
  and stays there is then measured against a value it will never return to, and
  the whole record after the step is lost. A corrupt plateau costs its first
  reading here and the rest is the 357 walk's business, which is what breaking
  and re-establishing continuity is for.
- **Rate of fall** is the mirror of it, and a filter of its own rather than a
  sign on the one above (#191). Up and down are different questions with
  different answers at the same site: a level rises with the catchment and falls
  with the channel draining, and the fastest credible figure for one is
  routinely not the figure for the other. Until they were split, a water level's
  falls were judged against the *rise* threshold with no way to say otherwise
  (`Math.abs`), and an accumulator's falls were never judged at all. Now each
  direction has its own figure and its own verdict. An accumulator does not
  normally want the fall filter — it cannot fall except by wrapping or by
  corruption, both of which the rollover and 357 tests already own — but the
  switch is there, because the operator can see what it removes.
- **Minimum / maximum** bound the exported `Value`, either end blank for
  unbounded.
- **Quality codes** act on the `Data Quality` letters the export already
  carries, and are the only gate here that is not this app's opinion — the grade
  was in the file all along. The tab has read that column since the first import
  and showed it in the readings table, in the callout, in both export CSVs and
  as an editable cell; `runFilter()` read the timestamps and the values and
  nothing else, so **a reading the telemetry itself had flagged was filtered
  exactly as though it had not been.** The panel now lists every code in the
  loaded imports with how many readings carry it and the values they span, and a
  tick per code excludes it before the continuity walk runs.

  Two things about it are deliberate. **Nothing is excluded until a code is
  ticked, and the list starts empty**: the codes are a vendor vocabulary that
  differs by system and by site, nothing in the file says which of them are bad,
  and a default that guessed would silently delete somebody's flood peak. And
  **the counts stay legible with the switch off**, because working out *which*
  code to exclude is what somebody does before flicking it — a control that only
  showed its numbers once it was armed would have the order backwards.

  It matters most where the 357 test is weakest. The 3/5/7 steps are
  counts-domain constants, so on a water level in metres a 3 m step is enormous:
  a flagged reading a metre off the record clears every one of them comfortably,
  and four re-sends of one flagged packet are continuous with *each other* by any
  threshold at all — tightening the steps cannot touch them. On a sample export
  of 5,716 readings at Warrego Highway, the 60 kept readings outside −1…10 m were
  all coded, and none of the codes was doing anything.

Each removal keeps the name of the filter that made it: a cross for the 357
test, a square for out of range, an up triangle for too fast a rise, a down
triangle for too fast a fall, a hollow diamond for an excluded quality code — on
the chart, beside the tick box that switches it on, in the readings table's
verdict column, and in the CSV verdict export alike. The shapes are written down
once (`AD_MARKS`) and drawn from there by all four, so a legend can never teach a
shape the chart does not draw.

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

**And the repeat rule is only as good as the exporter's clock.** It tests
`t[i] <= lastT`, so it catches a re-send stamped with the *same second* and
nothing else. A Warrego Highway export shows both halves of that: through
January and February ARRO stamped each observation's re-sends identically and
about half of every month was set aside as repeats; from March the same re-sends
arrive one to three seconds apart, nothing matches, and **99% of the record is
kept where 50% was before**. Nothing changed about the data — the clock changed.
This is the one setting worth reaching for when a later stretch of a chart looks
denser than an earlier one, and it is why the minimum gap is a duration rather
than a switch.

**Raw is never overwritten.** The parsed arrays are written once at import and
never again; filtering only ever produces a parallel status array. Raw and
filtered are two views of one import, shown separately or overlaid, because a
filter you cannot inspect is worse than no filter. Every rejected reading can be
clicked for its full row and the reason it failed.

**Side by side, when overlaid is the wrong question.** Raw and filtered on one
chart answers *what was removed*; two charts of the same window answers *what
shape did the record have before, and after*, which is the question somebody
asks when deciding whether the settings are right. A collapsible pane under the
chart draws both, sharing the time window and one vertical scale — let each fit
its own data and the filtered pane comes out looking exactly like the raw one,
which is the opposite of the point. Which scale is the toolbar's existing
**vertical axis** control rather than a second one here: with a 2014 mm spike in
the record, **Kept** is what stops it flattening the filtered pane.

**The chart is hand-rolled SVG**, like the rest of the app's charts — no
library. It carries wheel zoom, Shift+wheel or a tilt wheel to pan sideways,
drag to pan, drag-to-select zoom on either or both axes, an overview strip of
the whole record with the visible window on it — movable, and resizable by its
edges — plus a second navigator down the right for the vertical axis, a
crosshair whose balloon says what the reading did either side of itself and a
pinned callout that says it at length, keyboard pan/zoom, per-series colour,
line type, axis side and visibility, solo and fit, light/dark repaint, and
SVG/PNG download. Three readings of the data
(value, increment, rate per hour), three chart styles (line, step, points) and
four vertical scales — including **Kept**, which scales to the surviving
readings so a single 2014 mm spike stops flattening a 300 mm trace, and draws
the removals that fall outside as triangles on the top edge rather than hiding
them.

**The toolbar over it is three captioned rows**, and the split is the whole of
it: *what the chart draws* (Series · Reading · Style · Vertical axis), then *the
window and what happens over it* (Window · Mark · Drag does · Picked), then
*Export*.
Before that it was fourteen controls in one wrapping run — four identically
styled segmented controls with nothing but a tooltip to say which governed
what, five bare checkboxes of two different kinds mixed together (three that put
marks on the chart, two that change what a drag means), and `90d` the same shape
of button as `PNG`, a jump-the-window control and a download reading as
siblings. Rows rather than one run because a flat run re-groups itself at every
width: at 1440 the checkboxes sat beside the axis buttons and at 1100 they did
not, so what looked like a group was an accident of the viewport. Each caption
is the group's accessible name as well as its visible one — `role="group"` with
`aria-labelledby` — so the eye and a screen reader are told the same thing.
Nothing about what any control *does* changed.

**Three ways into a closer look.** *Drag does → Box zoom* (or Shift held) draws a
box, and the window becomes the box — both axes now, not just time. A flat sweep
stays the time-only zoom years of use have taught, and the rubber band says
which it will be before the button comes up: full height for a flat sweep, the
box itself otherwise. *Drag does → Vertical* (or Alt held, so neither zoom
ever needs the toolbar) is the other direction: time stays put and the vertical
axis becomes the dragged span. What the drag zooms do to the vertical
axis is not private state: they commit through the toolbar's own axis mode —
*Fixed*, with the min/max boxes holding the dragged numbers — so the committed
range is visible, editable, and honest about what happened. Double-click, the
**↺** button over the chart's corner, or the 0 key, resets both axes and
restores whatever vertical mode was chosen before the first zoom; choosing a
mode by hand drops that memory, because the operator has spoken since and reset
must not overrule them. **⛶** beside it gives the chart the whole viewport,
Escape included.

*Drag does* is **one choice, not two switches** (#191). It was a pair of
independent tick boxes, so both could be on at once — which a drag cannot
honour: a press has exactly one meaning and `onpointerdown` had to pick between
them silently, always preferring the vertical. A segmented control with **Pan**
in it says the truth, which is that this is a choice whose commonest state is
the one that was never on the toolbar at all.

**Two navigators, one on each axis** (#191). The whole-record strip under the
chart has been joined by a vertical one down the right: the full value range in
the record as a track, a density band saying where the readings actually sit in
it, and a box marking the range the chart is drawing. Both take the same three
gestures — drag inside the box to move the window, drag an edge to resize it,
press outside it to bring the window there. The vertical one commits through
`commitY()`, the same manual takeover the box zoom and the Alt drag use, so all
three land in one place and there is no fifth axis mode for `yRange()` to
consult.

The horizontal strip's middle gesture used to be **wrong in a way that read as
randomness**. Its press handler recognised the two edges and called everything
else "pan" — and "pan" re-centred the window on the press point. So a press two
pixels outside the grip, which the cursor had just promised was a resize, threw
the window sideways by however far off centre it landed; a press dead in the
middle did nothing at all; and the two were the same gesture. On a zoomed-out
chart it was worse: `view()` lets the window run a whole span past either end of
the record, so both edge handles were drawn *off the ends of the track*, no
press could reach one, and every press jumped. Three things fix it — clamping
the drawn handles to the track, a real "move" that tracks the pointer by its
grab offset instead of teleporting to it, and a grip wide enough to hit — and
only the middle one is new behaviour; the other two are the promised behaviour
becoming reachable.

**A series can be drawn against either vertical axis** (#191), with its own line
type and its own colour picked from a grid of named swatches rather than only
from the browser's gradient surface. The right axis exists for the case this tab
hits constantly and had no answer for: rainfall in millimetres and a level in
metres over the same storm, where one scale means one of the two is a flat line
at the bottom and the operator's actual question is about their shapes against
each other. The left axis keeps the gridlines — two grids at two spacings over
one rectangle is a moiré, not a scale — and each axis labels its own unit, or
nothing when the series on that side disagree. *Fixed* and the vertical
navigator govern the left axis; the right one auto-fits its own series.

**Readings can be edited, in the chart or in the table** (#191), and the edits
live in the browser tab and nowhere else. Set *Drag does* to **Select** and
lasso a stretch — removed readings included, which is the point, since the
spike somebody wants to delete is by definition one the filter has already
rejected — or tick rows in the table, or press **all in view**. Then: set a
value, move the selection by an amount, scale it (`0.001` for millimetres read
as micrometres), re-code its quality, drag it up or down on the chart, or delete
it. Every edit re-runs the 357 walk, so a spike deleted here stops dragging its
neighbours down immediately, and both **Export** buttons write what is on
screen. Nothing is written back to ARRO; an edited series says so in the rail
and carries a **revert** that puts its values and quality codes back as loaded.
Deleted rows do not come back, and both the delete and the revert say so before
they run. Closing a series that has been edited asks first.

**The removed readings are clickable now.** `hoverAt()` searched the filtered
track alone in every mode but Raw, so the one reading anybody actually wants to
inspect — the one with a cross drawn on it — was the one reading on the chart
that did not answer a click. The removal marks are drawn whenever *Mark →
removed* is on; they are reachable whenever they are drawn, with one row per
series still, because a hit on the raw layer only survives if it is nearer than
the filtered layer's.

**Scale is handled by drawing pixels, not points.** Each pixel column keeps its
first, minimum, maximum and last value, so a spike survives at any zoom while
the drawn point count stays bounded by the width of the chart. The full series
is kept for filtering and export. Filtering the 14,942-row sample takes ~6 ms.

Exports reuse `csvEscape()` / `dlText()`: **kept** writes the filtered series,
**verdict** writes every row with the filter's decision against it — which is
the artifact to keep when the question is what was thrown away and why.

**Demo data** in the drop zone loads a real ARRO export committed to the repo at
`data/demo/aem_Durikai_AL_541134_Rainfall_541134_0_R_5758.csv` (#191). It is the
*same* export every argument above is made from — Durikai's rain accumulator,
seven months, 14,942 rows, 6,111 distinct timestamps, the 395 unquoted thousands
separators, the 82 single-reading spikes to 1234. Nothing about it was cleaned:
it is there because it is messy, and because every claim `runFilter()` makes
about what it is defending against can be checked against the file that taught
it. It arrives through `addSeries()` under its real filename, so the sensor-id
parse and the station link run exactly as they would for a file dropped from a
desktop — there is no demo code path in the chart.

> The specification is in `docs/` (v2.1, May 2009, and the 1998 first edition),
> along with the sample export used to develop this.

### 19. ALERT2 / ERT-A2 Serial Decoder

Decodes what an ELPRO ERT-A2 puts on its serial ports, on the **ALERT2 / ERT-A2**
tab. The unit emits two different things on two different ports, and they do not
carry the same information — so the tab reads both, and sniffs which one it has
been given.

#### Two ways in

**1 · ALERT2 ASCII protocol — secondary RS232 port.** One comma-delimited line
per received frame: 24 fixed fields of receiver metadata, including the unit's
own real-time clock, then the frame payload as hex bytes.

```
ALERT2A,1,9999,ELPRO,N,1,2026,6,8,19,10,41.296,0,0,0,0,0,1,0,0,0,7,7,9999,74,64,F0,7E,18,15,00
```

**2 · ELPRO binary framing — USB port.** What Ranger's own *Serial Data* pane
shows over USB, and **the one that carries RSSI**. The word `ALERT2` as six
bytes, a length, then tag/length/value elements:

```
41 4C 45 52 54 32 4D 75 01 01 18 02 27 0F 77 05 45 4C 50 52 4F …  9C 2F 01 94
                                                                  └── RSSI, −108 dBm
```

| | ASCII (RS232) | Binary (USB) |
| --- | --- | --- |
| RSSI | — | **yes**, element `9C2F`, signed byte, dBm |
| Receiver clock | yes | — (no date or time of day in the framing at all) |
| Frame time | payload, seconds since midnight | same |
| Source, agency, payload | yes | yes |

The binary frame nests two containers: `15` holds the air-link PDU as it landed
(a length, the PDU, `A1` fill to a fixed 24-byte buffer), and `14` holds the same
bytes split into a six-byte MANT header and the payload, with the RSSI appended.
Both copies were byte-identical on every frame checked; the decoder reads the
split one and reports it when they disagree.

The capture is receive-only, so it shows what the USB port *emits*, not what (if
anything) Ranger sent to turn it on. Nothing was needed to read it back, so the
working answer is that the two ports simply speak different protocols — the tab's
own reference says exactly that rather than claiming a secret command was found.

#### The payload, on both

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
operator can get today: text pasted from a terminal, hex copied out of Ranger, or
a session log picked off disk. On the ASCII side, PuTTY session banners (including
one landing mid-line), terminal timestamps in front of the frame, lines a narrow
terminal wrapped, and a log cut off mid-frame are all handled and accounted for in
the summary rather than silently dropped. On the hex side, a bracketed timestamp
or a hex-dump offset column is stripped off each line first — their digits are hex
too, and would otherwise be read as data — and everything left is treated as one
byte stream, with the frames found by their `ALERT2` sync rather than by the line
breaks. That is what makes Ranger's pane usable as-is: it wraps mid-frame at
whatever width the window happens to be. Space-delimited, run together, `0x`
prefixed, upper or lower case all work.

A log can also be **watched as it grows**: drag it (or the folder PuTTY logs
into) onto the tab and it is re-read every two seconds — which works even where a
policy has switched the browser's file picker off, since a dropped file is read
through a different API (see `log-follow.js`). Where the picker is allowed,
**Watch a log file…** does the same from a dialog; where it is blocked, the
button says so, with the policy name, and points at the drop. The Serial
Monitor's ERT-A2 card follows a log the same way, as a live dashboard.

**Map.** One pin per station heard in the capture, sized by how many readings it
sent and coloured by RSSI where the format carries it. The pins and the readings
table are one selection: clicking a pin lights up every row that station sent
(they carry three or four ALERT addresses each), and clicking a row lights up its
pin. Station names in both places are links through to the Stations tab, which
opens with that station selected, scrolled to and focused on its map.

**Shared ALERT addresses.** An ALERT address is only unique within a region, and
604 of the database's 5,122 addresses belong to more than one station. Every
frame in a capture came through one receiver, so addresses matching exactly one
station fix where that capture is, and an ambiguous address resolves to whichever
candidate is near it — 96 of the 101 shared addresses in the reference capture,
against candidates 1,200 km away. The rest are reported as ambiguous with a pin
to record the answer, because two stations 6 km apart carrying the same addresses
cannot be told apart by anything in the frame, and guessing would be worse than
saying so.

**Clock skew.** On an ASCII capture the header time is the receiver's own RTC and
the payload time comes from the transmitting network, so the summary reports the
difference — 12 h 00 m 01 s on the reference capture, an AM/PM error on the unit —
and distinguishes a couple of seconds of receive latency from a clock that drifted
mid-capture. A binary capture has no receiver clock in it to compare, and the
summary says so rather than inventing one.

> **ASCII.** Field meanings were established by decoding a 444-frame capture and
> checking it against the same traffic decoded by ELPRO's Ranger software: payload
> lengths, record boundaries, addresses, values and frame times all matched, and
> 339 of the 348 addresses heard matched a station.
>
> **Binary.** 44 frames from Ranger's Serial Data pane were decoded here and
> compared against Ranger's own decode of the same packets. Source, agency, frame
> time, every ALERT address, every value and every RSSI matched on all 44 —
> including multi-reading frames, where Ranger lists the readings in a different
> order. A second capture of 78 frames then parsed to the same structure with
> every byte accounted for: nothing stray between frames, no unrecognised element,
> no warning raised.
>
> Fields and elements with no such evidence behind them are marked *constant only*
> in the tab's own reference rather than guessed at.

### 20. Side Panel (Help, the Stations Cards, the Stations Map's Controls)
One column on the right of every tab, the *side panel* (`#help-panel`, called
"the dock" in the code): a strip of buttons on the screen's edge and, open, one
pane beside it. ❔ is the help described below; 📍, on the Stations tab, is the
Stations cards (the red pin, a station's wherever the app draws one); the blue 📍
under it is Find a place; 〽️ is the path tools (the elevation profile and the link budget);
🧊 is the digital twin's pane and 🔭 the AR station finder's;
and under them, on that tab, every one of the Stations map's own
controls — its panels as panes with a button each, its buttons as themselves.
It is the help rail and the Stations tab's right-hand column of cards merged
into one — see *The side panel as a dock* at the end of this section.

The help is what says what the open tab is for and what to watch out for on
it. It exists because a real amount of explanation was already scattered
through the app — the 357 filter modal, `docs/serial-help.html`, the ARRO id
disambiguation copy in the station editor, the hints in the Stations filter card
— with no single surface a first-time user could open to find any of it.

`HELP` in `core.js` is the single description of its content, keyed by the same
tab ids `TABS` uses, and the panel is rendered from it the way the nav is
rendered from `TABS`. Each entry carries a summary, optional *watch out for*
lines, optional links out, and the ids of related tabs — which is how the
panel says out loud that Bit Flipper, ALERT Packets, ALERT2 and the Serial
Monitor are one investigation approached four ways, and lets you walk between
them.

**All nineteen tabs are written (#105)**, and what "written" means here is
mostly the *watch out for* list rather than the summary. Those lines are the
things a tab is silent about and a user otherwise finds out the hard way — that
an orphaned station on Pass Ranges usually means a repeater nobody has recorded
rather than a site nothing serves; that the Export tab ignores the Stations
filters entirely and scopes off the ticked networks instead; that an ACMA score
ranks without measuring, because line-of-sight is not assessed and every
candidate carries the same factor for it; that Web Serial being blocked by
policy looks like nothing happening rather than like a refusal.

**Two of the nineteen carry a walkthrough**, both because the thing being
explained is a shape rather than a sentence: *Draw & measure* on the Stations
tab, and what a pass range actually is on Pass Ranges. They are inline SVG using
the app's own custom properties, so they repaint with the theme and quote the
map's real colours instead of inventing a second palette. Seventeen tabs have
none, which is the intended result rather than an unfinished one — `npm run
help` prints the count so it is a stated number rather than an inferred one.

**Three sorts of link out**, and the third is the one worth naming. A `.md`
link goes to GitHub's renderer, because markdown served off Pages downloads
rather than renders; a bundled PDF or HTML page is served from the site itself;
and a `call` entry opens something the app already has. That last one is how the
panel offers *How the 357 filter works* — the explainer is a wide modal whose
worked example is coloured by what `walk357()` actually returns, so the panel
opens the real one rather than keeping a second, worse copy that drifts.

Which of the app's existing embedded explanations moved in here and which stayed
was decided per item, and the decisions are recorded above `HELP` in `core.js`:
the 357 modal and `docs/serial-help.html` are linked rather than moved (one
would drift, the other exists to be forwarded to an IT department and needs a
URL of its own); the station editor's ARRO id labels stay where the typing
happens and the rule is restated in the panel; and the filter card's inline
hints stay, because they are generated from the loaded file and cannot be lifted
into a static string.

It borrows the nav's interaction contract on purpose (§14): it collapses to a
strip rather than to nothing, keeps its state in `localStorage` beside `mn-nav`
/ `mn-theme` / `mn-filters`, and re-measures every Leaflet map once its width has
settled rather than during the slide. Where it differs:

- **Two things are remembered, not one**: whether it is open (`mn-help`,
  `expanded`/`collapsed`, as it always was) and which pane it would like to show
  (`mn-dock-tab`: `help`, `stations`, or `map-<panel>`). A pane that is not
  there on the current tab — the Stations cards anywhere but Stations — leaves
  the panel shut *there* without the preference changing, so coming back finds
  it open on the same pane. A fresh visit prefers the Stations cards, which is
  why the Stations tab opens with them beside the map and every other tab opens
  with help shut, the way the rail always did: help opens itself nowhere. (A
  browser holding only the old help rail's `mn-help` answer, and no
  `mn-dock-tab`, is treated as a fresh visit: its "collapsed" was said about the
  help, not about the Stations cards.)
- **Its width is yours.** The handle on the pane's inner edge is a real
  separator (`role="separator"`, a value in px): drag it with a pointer, or
  focus it and use ← → (a step), PageUp/PageDown (a big one), Home/End (its
  narrowest and widest). The width is stored as `mn-dock-w` and clamped to the
  window at the moment of use — never below 300 px while there is room, and
  never so wide that the page keeps less than 400 px, so the Stations map beside
  it is never a strip. On a window too narrow for both (a tablet in portrait,
  where the cards are under the map anyway) it may take up to 55 % of the room
  instead; either way the page never scrolls sideways.
- **Pressing the button of the pane that is showing shuts the panel**, and the
  map gets the width. Any other button opens it on that pane.
- **Under 560 px a pane is a drawer** from the right, over the page, mutually
  exclusive with the nav's, with a backdrop that a tap puts it away on, and
  Escape — and only ever one somebody opened on that screen: nothing stored
  opens one on arrival, and turning a phone from landscape to portrait opens
  none, unless the operator was typing in the cards under the map, which then
  come with them as 📍's drawer, caret and all. What it opens from depends on
  the tab:
  - **On the Stations tab the map is the screen.** It runs edge to edge from
    the banner's foot to a one-line credit at the screen's (tap the credit for
    the rest of it), and the page under it does not scroll: the Stations cards
    are in the side panel, 📍 and 〽️, as beside a desktop's map. The strip is a
    rail down the right-hand edge, put away behind **⋮** at the right-hand end
    of the banner until it is asked for. ⋮ brings it out — 40 px wide, its
    buttons 36 px, sticky under the banner and taking its width from the page,
    so the map ends where the rail begins and only ↺, in its top-right corner,
    stands on it — and puts it away again, and which it was is remembered as
    `mn-dock-rail`. It holds ❔, 📍, 〽️ and every other one of the map's
    controls, in the same groups and order as on a desktop; a pane's drawer
    opens on the rail's inner edge, and the rail stays lit above the backdrop,
    so its buttons go on switching panes and the lit one puts its drawer away.
    A drawer opened while the rail is away — *Station details*, a radio path
    clicked on the map, a line finished — brings the rail out with it, over the
    page beside the drawer rather than taking the map's width, and takes it
    away again, focus to ⋮. Full screen brings the rail out too, because ⛶ is
    in it. Until this the rail stood beside the map all the time, 48 px of a
    390 px screen, with the cards under the map and the banner's station count
    wrapped to four lines above it: a map a third of the screen. Before that the
    map's controls went back to its corner on a phone, as flyouts with pins —
    two columns of 44 px buttons over a quarter of the map.
  - **Everywhere else it is the help rail exactly**: the strip holds only ❔
    there, and rather than a rail for one button it is a tab fixed on the
    screen edge, with help the drawer that tab rides on — the nav could move ☰
    into the header because the header had a slot on the left, and there is
    none on the right.

  Crossing 560 px changes none of what is in the strip, so nothing moves and
  focus stays where it was — on a strip button, or typing in a pane that turns
  into a drawer and back — and every map is measured again once the rails have
  settled, because a phone turned on its side crosses it.
- **It stays beside the map in full screen**, at its width, above the header,
  and everything in it goes on working; the map stops at its edge and follows
  it (see *Full screen* under the Stations tab).

#### The side panel as a dock

**The Stations cards.** The filters, the station list, the radio path card,
the elevation profile, the link budget, *Repeaters listening*, the blast radius
and the station editor are one wrapper (`#stations-cards`), emitted under the
map by the tab's render and *moved* — never re-rendered — into the side panel's
Stations pane while the window is wider than 1,100 px, or a phone's, where
the pane is a drawer over a map that fills the screen. The radio
path card, the elevation profile and the link budget are a wrapper of their own
inside it (`#stations-path-cards`), and
beside the map that goes to a pane of its own, 〽️ *Path tools*, under 📍: they
answer a question asked of the map rather than of the list, and they are the
cards the map sends people to. Under the map it goes back into the column
between the list and *Repeaters listening*, where the render emitted it. `#stations-main.is-split` then
means "the cards are in the side panel", and the map fills the height of the
window on its own — a phone's included, where it is edge to edge under the
banner. At or below 1,100 px, down to a phone's width, they fold under it
without the Leaflet map being rebuilt, and come back to the side panel when
the window is wide again, or a phone's — the width is the one thing that
decides. Every card is re-rendered in place by its own id, so
none of them knows it has moved; leaving the tab takes the wrapper out of the
side panel (a registered tab teardown), because a great deal of the app reads
"no `#stations-table-wrap`" as "not on the Stations tab". Everything that jumps
to a card — *Show in the list*, *Station details*, the radio path card's links,
*Link budget for this path*, *Finish line*, the site finder's *Profile the worst
path* — opens the side panel on the pane holding that card first (`dockReveal`),
because a scroll to an element in a hidden pane does nothing at all — on a
phone that pane is a drawer, which takes the place of whichever drawer the
press came from, and brings the rail out beside it if ⋮ had put it away. The elevation profile is always a card now, and with no line drawn it says
how to get one.

**The radio path card.** Clicking a radio path on the map — a field link or a
backbone path, in 2-D or 3-D — opens a card about that hop (the two ends, the
ALERT IDs on it, its frequency, distance and fade margin) at the top of the
path tools, above the profile and the budget it points at the same hop. It used
to sit over the map in the ACMA card's rectangle, which covered the map it had
been clicked on and left it a pane away from the two cards it summarises. The
click opens 〽️ (or scrolls the column under the map, leaving a full-screen map
first if the column is behind it) and puts focus on the card; × or Escape
closes it back to whatever opened it. It no longer joins the map cards'
one-at-a-time rule, since it is not over the map: the station card or the
transmitter card stays open beside it. It survives a render of the tab the way
the profile and the budget do, and closes itself once the profile moves off its
path — another line drawn or selected, or its line deleted — because it says
those two are open on this exact path.

**The Stations map's controls.** Everything MapChrome would put in the map's
top-right corner lives in the strip instead, at every width — a phone's rail
included, where a pane is a drawer — except ↺ reset, which is built to stay
(`corner: true` on `MapChrome.button`, so the side panel is never offered it)
and is the one thing in that corner. Each panel — 🗺️ Map display, 🔑 Legend, ✏️ Draw & measure,
📡 Polar radio coverage, 🗼 Repeater site finder, 🎚️ the 3-D settings — moves
its whole `.mn-mapctl` wrapper (icon, heading, pin and body) into a pane of its
own the moment it is built, with a button in the strip; its corner icon and its
📌 are hidden there, because a pane already stays open. Each other plain button
— ℹ️, ⛰️ and its two camera buttons (hidden until 3-D is on), ⛶ — is moved
into the strip itself, keeping the class its module finds it by. They stand in the
corner's groups and order (`MapChrome.groups()`), one labelled group each with a
hairline between them, and the strip scrolls, with a thin bar beside the
buttons rather than over them, when it is taller than the window. Building the
map opens nothing: which pane shows is the side panel's own preference, and a
fresh visit still opens on 📍. The map is rebuilt on every render of the tab,
and its new controls land in the *same* panes and strip buttons, so the pane
that was showing stays showing, a focused strip button keeps focus, focus on a
control of the old map goes to the same control of the new one — ↺ in the
corner included — and the pane's scroll comes back. The pin (`mn-map-panels`) means what it always did only where
a panel is in a corner: on the other six Leaflet maps, which keep their corners
because none of them sits beside the side panel (`MapChrome.dockInto` is per
map). This used to be opt-in, a panel moving in
only when its 📌 was pressed — which left the right-hand edge of the page two
places to look for the same kind of tool — and it is not any more.
`npm run dock` holds all of this.

**The content has a check of its own**, `npm run help`, and it exists because
every way this decays is silent. A doc link that 404s, a *see also* naming a tab
that was renamed, a placeholder that shipped and a walkthrough with no `<title>`
all render a perfectly good-looking panel — `npm run smoke` opens the tab and
the tab is fine. See **Testing** below.

### 21. Digital Twin (One Station's Ground in Three Dimensions)
One station's patch of ground — 200 to 1600 m square — with the real relief
under it, the aerial imagery draped over it, **the station as built** where
it stands and a **1.75 m figure** beside it for scale. Orbit it, look
straight down on it, or take the POV and walk about in it at eye height with
the keys — up the ladder of a tower, too; click the ground for its height;
watch the station's flood levels rise over it as water; and download the whole scene as a `.glb` that Blender opens
with one import. It is `digital-twin.js`, drawn **inside the Stations map**
(from zoom 17 the map offers it, and the 🧊 pill on the card of every station
with a position opens it in one press), with its settings — find a station,
the scene, Ground truth, the ground as numbers, the `.glb` — in the **🧊 pane
of the Stations side panel**. It had a tab of its own under *Stations &
networks* until September 2026; the tab's column became that pane, and an old
link to the tab lands there.

**The ground is the State's, then the tiles'.** Queensland's own elevation
service (`Elevation/QldDem` on `spatial-img.information.qld.gov.au`) holds
the public 0.5–1 m LiDAR DTMs where they have been flown and SRTM elsewhere,
bare earth, in AHD — the same Queensland LiDAR Elvis lists, served by the
agency that flew it — and answers one request with a GeoTIFF of 32-bit
floats for the whole patch, which the module reads in a hundred lines with
no library. Where that service has nothing (New South Wales, the sea, an
outage) the ground is the ~30 m SRTM every profile in this app reads,
lifted from `terrain.js`'s lattice, and the notes say so: at 30 m the
channel a gauge sits in is not there. Elvis's own API is asked for the one
number it is best at — the AHD height at the pin and which dataset it came
from — because its point call is ~2.5 s each with no batch (`elvis.js`
measured it) and its bulk download is a job that arrives by email. A patch
neither source answers is an empty stage that says why, never flat ground.

**The imagery is the State's aerial program, then Esri's tiles, then a
height ramp.** One JPEG of the patch from `LatestStateProgram_AllUsers`
(10–20 cm in the towns), with the plain grey sheet it returns outside its
photography told apart from a real one by its variance; Esri World Imagery
stitched on a canvas where that fails; and the ground coloured by height
where nothing can be had.

**The station is read from the record, and nothing is assumed.** A
telemetered station whose record has a water-level sensor (a `Water Level…`
or `Gas Pressure` sensor, a legacy `water_level` address, a Bureau listing
typed Water Level) is the river-gauge tower — 4 m mast, grating platform
with handrails, the cabinet with a Kisters HS40 compressor bubbler above and
the Victron, the telemetry, the terminals and the battery below, the gauge,
the antenna mast with its solar panel, and a ladder up the south side. A
telemetered rainfall station, rain-and-repeater included, is the Type 3
rainfall pole: 2.000 m × Ø0.300 m, green, with the tipping-bucket gauge and
its ring on top, the enclosure on the south face, the solar panel and the
whip. Inside is the kit the telemetry calls for: an ELPRO ERRTS ERT-A2 for
an ALERT station (AL/ALERT in the name, or ALERT addresses), a Campbell
CR300 and a Beam Iridium SBD modem for a TM station (TM in the name, or
satcom), a plate with the station's name and number either way. A station
the Service Level Specification lists as **Manual** — or one the Bureau
reads daily with nothing saying a radio does — is the observer's kit: a
silver rain collector Ø200 × 300 mm, a white 1 m staff gauge, or both. And
a station the record cannot place is a **red post 1 m tall**, with the notes
saying what is not known, rather than a pole guessed at. The doors open on
their own — the pole's when the POV eye comes close, the tower's when the
visitor is up on the platform — and shut again when they leave.

**The rest of the patch is built too.** Up to 40 other stations inside the
modelled ground stand by the same rules, each named, each name a button to
its own twin. The ground is bare-earth LiDAR, which has the bridges taken
out, so a road bridge's imagery ran down into the creek: each bridge in the
patch — the State's road network's bridges and its rail bridges, or
OpenStreetMap's where that cannot be asked — is built as a deck wearing the
photograph of the road, at the **crossing height the Bureau's HDB extract
lists** for the gauge where there is one (Gatton's 3.90 m on a zero of
87.54 m AHD is a deck at 91.44 m), otherwise at the higher of its banks.

**The cadastre lies on the ground.** Every lot's boundary, in white over a
dark casing, with its lot number and plan written in it — *Lot 2 / RP64333* —
and the road reserve outlined and washed in the road colour with the road's
name in it: the land parcels Queensland Globe draws, and the Stations map's
Property boundaries and Road parcels, asked of the same Queensland cadastre for
the patch and draped on the ground's own triangles, in orbit, top-down and the
POV, on the tab and in the map. The line under the stage says which lot the
station stands in — its tenure and area — how far the road reserve is and
which way, or whose road reserve it stands in, and how well the cadastre is
plotted there (±0.5 m in a surveyed town, ±25 m where it was compiled off a
1:10,000 map, and a note when it is coarser than 5 m). A click on the ground
names the parcel under it and any easement over it. Two switches in the Scene
panel, on by default and remembered (`twin-cadastre.js`).

**The request box is the patch grown by half a sample**, so the 201 pixel
centres the service returns are the 201 mesh vertices and the middle one is
the station. Vertical exaggeration scales the relief and nothing else — the
pole and the figure are the ruler at every setting. The **Ground truth**
panel puts the station's recorded height, the ground at the pin, Elvis's
answer and the difference side by side, with the one thing worth knowing
about that difference: a mark well above the ground usually means the
coordinate is the gauge in the channel and the mark is the hut on the bank.

**The renderer is three.js, fetched on the first visit** and never for a
session that does not come here — MapLibre's terms — by a dynamic
`import()` of the pinned ESM build, because three has shipped no UMD build
since r160. The page stays classic scripts; the call is from inside a
function. The `.glb` is written by the module itself (metres, y up, origin
on the ground at the pole, the station's coordinates and datum in its
header; the imagery embedded) and `tools/blender/import_twin.py` sets the
scene up in Blender — units, a sun from the north, a camera on the pole.
No point cloud is read. The frame is the one a cloud would land in — the
header carries the origin a LAS/LAZ file is shifted by — but reading one was
not built and no issue tracks it; `docs/digital-twin.md`, *Point clouds*, has
what it would take.

**The same twin is inside the Stations map, and that is the usual way in.**
From zoom 17 with a station under the view — the one on the card, the
selected one, or the nearest to the centre — a card on the map **offers**
that station's twin, saying what aerial imagery covers the station (10 cm
over most towns) and when it was flown, read from the State's imagery
catalogue; it never takes the map over by itself. *Open the digital twin*
hands the rectangle over, whichever view was showing (the 2-D map or ⛰️ 3-D,
whose camera follows the 2-D map's zoom); ← Map or Escape gives the map back
at the same zoom, and wheeling past the edge steps one zoom out. 🔍 Zoom to
station goes all the way in, which is where the card appears. From zoom 14
the station's patch is fetched ahead, so the hand-over is a build from
memory. The switch is in 🗺️ Map display. ⛰️ 3-D and the twin are one idea at
two scales — the network on its terrain, and the site — and neither replaces
the other; zoom is what says which question is being asked, so zoom is where
the offer appears (`map-twin.js`).

**Move pin works where the ground can be seen.** The station editor's *Move
pin on map* arms in the twin as well — on the tab and inside the Stations
map — as an amber post dragged across the ground or dropped where you click,
its position read to the centimetre; round the station and the pin the
State's finest imagery is draped again (100 m at 1024 px, 0.098 m a pixel,
where the patch's drape is 0.39 m), so a coordinate can be fixed against
10 cm photography. Save writes the latitude and longitude and nothing else,
through `save_station()` against the station's current row. In ⛰️ 3-D the pin
stands on the terrain and a click lands where the terrain is under the
cursor, not where the flat map would put that pixel (`map-move-pin.js`).

**The lines over the stage fold away** ten seconds after the twin opens —
unless the pointer or the focus is in them — and ▾ Details brings them back,
counting the notes while they are folded.

**Past the patch the country runs to a horizon 60 km off**, under a sky, in
haze: three sheets of far ground — the State's raster at 40 m to 4 km, the
~30 m tiles to 20 and 60 km — on one mesh of concentric squares that starts
on the patch's own edge vertices and widens by a few percent a square, every
far vertex dropped for the Earth's curve (27 m at 20 km, 245 m at 60) so the
horizon is where one belongs, each sheet draped with its own imagery. It is
scenery, not survey — coarse on purpose, not in the `.glb`, not clickable —
fetched only once the patch is standing, and the Scene panel can switch it
off; it is a few more requests.

**Nobody explores alone unless they choose to.** With *Explore together* on,
the twin joins a room for its station on Supabase Realtime (the project the
readings already live in — no server of ours) and whoever else has that
station open is drawn where they stand, in the hat, shirt and trouser colours
they chose, their name over their head; hold Space in the POV, or press
Point, and your arm goes out with a laser to whatever you are looking at.
The room sees a chosen name, three colours and metres from the station,
never an address or a coordinate on the Earth; poses go out four times a
second at most and only on change, and past four others a visitor listens
without publishing, so a busy day cannot silence the readings the same
project serves. The socket goes through the site's Worker where there is
one, like every database call (`twin-presence.js`).

**The radio paths are drawn from the antenna** as rays to the edge of the
patch along the line of sight to the far station, each named beside the pole
and again at its end, and listed under the stage — the far station's name is
a button that goes there.
Inside the Stations map they are the map's own lines — the same filters, the
same colouring, the same culled set, read off `state.mapLines` the way the
3-D view reads them, so the twin cannot disagree with the map it was opened
from. On the tab, with no map to mirror, they are the pass-range and backbone
relations as recorded, in the plain colours, and the notes say which.

**The station's flood levels rise over the ground as water.** From 0 m on
the gauge to the highest level the record holds — minor, moderate and major
through the gauge zero (only one surveyed to AHD; a class on an assumed datum
is named in the notes and not drawn), the AEP flood levels, and the floods
the river has seen — its five largest from HDB's peak flood heights, each at
the level it reached through the gauge zero of its day (`flood_peaks`,
`0037`) — sixteen seconds up, held, let out, and again. A clear blue below minor, then green,
yellow and red, and magenta through to dark blue past the AEP floods: the
colour of the rarest level passed, so where major sits above the 1% AEP level
(44 of 115 stations) the water stays magenta past it rather than going back
to red. It goes where the river would take it — a priority flood from the
channel by the gauge, so a hollow behind a bank stays dry until the bank is
overtopped — as one level surface, which a real flood is not: across a wide
patch the far edges are a guide. A staff in the channel carries a ring at
every level. **A scale up the left of the stage is the water's control**:
every level marked on it to scale, its name beside it — moved only as far as
it must be not to sit on another, the least giving way on a short stage — ⏸
or ▶ at its head, a name pressed to hold the water there, and the track
dragged to move it, taking a level exactly when let go near its mark. On a
phone the names stand down to their marks five seconds after they come up and
a tap on the track brings them back for five more (a tap for the names, not
the water), ⏸'s pill is a line and a bit tall, the whole of it the button, and
the hint along the stage's foot folds to a **?** that brings it back. The
line under the stage has the same levels and *Hide the water*; each choice is
remembered, reduced motion gets still water, and none of it is in the `.glb`
(`flood-stages.js`). A station with no levels the
twin can stand on its ground is offered the four nearest stations that have
some — distance, heights, catchment — and one chosen is drawn over this
channel as heights on its gauge (or the same metres AHD), for the session
only, with every line that draws it naming whose levels they are.

`docs/digital-twin.md` has the measurements behind every claim above, the
controls, the hosts a network has to allow, and the Blender workflow.
`npm run twin` holds the geometry, the hand-over and the mirror,
`npm run flood` the water, `npm run twinsite` the station as built, its
neighbours, the bridges and the offer, `npm run twincadastre` the property
boundaries, lot numbers and road reserve, and `npm run twinpin` the move-pin
mode in the twin and in 3-D — see **Testing** below.

### 22. Field Photos (Where Each Photo Was Taken, Shown There)

Photos from the field, filed by where they were taken and then drawn there:
a 📷 marker standing on the ground in the **Digital Twin** where the
photographer stood — a post at chest height, the camera turned the way it
faced, a wedge for each way a photo from there looked — clicked, or walked up
to in the POV and opened with Enter; a pin with a cone per direction on the
**Stations map**, flat or tilted into 3-D, where it stands on the terrain; and
the **Field Photos** tab under *Site visits*, where they
come in. Every one of those opens one viewer: a carousel over the photos taken
at that spot, ← → through them, with when, where, which way and how each was
known.

**In, by the handful or the folderful** — dropped on the tab, chosen, a
whole folder, or a zip of any of those (`photo-zip.js` opens it in the
browser, and each photo in it is queued as if it had been dropped on its
own) — each read in the browser before anything is sent: its SHA-256
(the same photo twice is one photo, asked of the database before a byte
moves), its EXIF or XMP (`photo-meta.js`: a JPEG, a HEIC, a PNG or a WebP, a
DJI drone's gimbal), and where the file holds no position, **the overlay a
field camera app printed on the picture, read by OCR** — Solocator's, GPS Map
Camera's, Timestamp Camera's, NoteCam's, an MGA grid reference — which is what
a photo that has been through Messages or a chat app still has when its EXIF
has gone. Readings are voted: a position is *high* confidence only when two
readings agree. The nearest station within a kilometre is picked, a 480 px
thumbnail made, and nothing goes up until somebody has looked at the list and
pressed Upload; a photo nothing could place still goes, into *Unplaced*. A HEIC
goes up as a JPEG: Safari converts it, and Chrome and Firefox, which cannot
draw one, fetch a WebAssembly libheif for the first HEIC of a session to do it.

**Or on their own, from Dropbox or Google Drive**: a scheduled workflow
(`.github/workflows/field-photos-dropbox.yml`, `field-photos-gdrive.yml`)
reads the linked folder every fifteen minutes with the same `photo-meta.js`
and files what is new, zips included. Linking Dropbox is a Dropbox app and a
refresh token got from the tab itself (PKCE — no app secret anywhere), then
three repository secrets; linking Google Drive is a service account the
folder is shared with, its key as a secret and the folder as a variable
(the project's secret key is shared with the Dropbox sync);
`docs/field-photos.md` has every click.

**What became of each one, and what its labels say.** Every attempt from
every way in — the tab, either sync — is logged to
`meganet.field_photo_upload` with its outcome and why, and listed on the
tab's **Review** panel. 🔎 on a photo reads the makes, models and serial
numbers on the equipment in it (the same OCR engine, over the whole frame
and four quarters) and proposes them through `propose_equipment()`, which is
also the seam an agent proposing equipment from new photos would use (#206).
Nothing reaches a station's equipment register until an **administrator**
(`app_user.role = 'admin'`) approves it, corrected or not; approved equipment
shows on the station card (`photo-review.js`,
`db/migrations/0036_photo_review.sql`).

**Editors only.** The pictures and their positions are in a private bucket,
shown through links that expire, written through three `security definer`
functions (`db/migrations/0035_field_photos.sql`) that enforce the path, the
type and size, one live photo per hash and one row per Dropbox file — a photo
removed here is never brought back by the sync.

`docs/field-photos.md` has the order a position is looked for in, the formats
the overlay parser reads, the time zones, the setup, and how the sync runs.
`npm run photos` holds the reader, the tab, the map (flat and tilted), the
twin and the HEIC decoder; `npm run photozip` the zip packs and
`npm run photoreview` the Review panel and the labels;
`tools/check_field_photos.sql` holds 0035 and `tools/check_photo_review.sql`
0036.

### 23. AR Station Finder (Hold a Phone Up, See Which Way the Stations Are)

🔭 in the Stations tab's side panel, in its first group after 🧊. Press **Look
around** on a phone and hold it up: the camera's picture fills the screen and the
stations the way it faces are pinned over it, each pin a callout on a stem whose
foot stands on the horizon at the station's bearing. A pin names the station and
says how far away it is, and its type in one letter in the map's own colours —
**F** field station (green), **R** repeater (blue), **B** base station (red).
Turn round and the pins come and go with the view; a little circle at the top
right is the same directions from above, the way you face at the top, so the
next one is easy to find.

**One pin a direction.** Thirty kilometres from a town in the south-east is two
hundred stations, and a pin each is a wall of labels nobody can read. So the
stations in range are gathered by bearing, nearest first: each joins the
direction of the nearest station already standing within a few degrees of it, or
starts one. A direction's pin is its nearest station — the one most likely to be
in sight — with a count of how many stand that way. The gathering is done in
bearings rather than on the screen, so a pin never changes what it stands for as
the phone turns; the labels are laid out in rows over the horizon round the
whole circle, nearest lowest, so none moves rows either, and one cut by the
screen's edge slides back onto it while its stem stays on the bearing.

**Tap a pin** for its sheet: the station's name, type and station number, its
ALERT IDs with what each reads, how far and on what bearing, every other station
that way nearest first (each a tap away), and **Show on the map** — the station's
card on the map, the map on its pin. The slider at the foot sets how far out it
looks (500 m to 300 km, 30 km to begin with) and the F, R and B toggles beside it
switch a type off; the pane carries the same two controls, and both are
remembered. It shows what the map shows: the map's filters apply.

**True north.** A phone's compass reads *magnetic* north, and in Brisbane that is
eleven degrees from true — a pin two kilometres to one side of its mast at ten
kilometres. So the heading is corrected by the declination where the phone
stands, from the World Magnetic Model 2025 (NOAA and the British Geological
Survey; its coefficients are in `station-ar.js`, good to 2030, and held to
NOAA's own test values by `npm run ar`). Android's `deviceorientationabsolute`
gives the camera's heading directly; an iPhone's gyro turns the view and its
`webkitCompassHeading` only keeps saying where north is in the gyro's frame, so
the pins move smoothly and a compass that twitches does not drag them. Phone
compasses are still often 5–15° out, more beside a vehicle: aim at a station you
can see, tap its pin and press **I'm facing it** to bring every pin into line
(*Undo align* puts it back).

**From the map's centre** does the same without GPS or camera — a look at a site
before driving to it, or on a computer, where a drag or ← and → turn the view. The
camera is asked for only on a phone or tablet, the screen is kept awake while the
view is up, and closing it (✕ or Escape) stops the camera, the GPS and the
compass. The picture is drawn on the screen and goes nowhere else: nothing is
recorded or sent.

### 24. Site Map (A Guide to Every Tab)

🗂️ **Site Map**, first in the nav under **Start here**, is for somebody who has
not met the app yet. It draws the screen — the banner, the bar of tabs, the open
tab, the side panel — numbered to a key; lays the groups out in the order the
work moves through them (what is out there, what is stepping on it, what it
actually sent, what the sensors said, what was done on site, keeping it
running); lists everyday jobs ("decode an ALERT message", "see which stations
need attention today") with the tab each is done on; and gives every tab a card
— what it is for, two or three things to use it for, and the tabs that go with
it.

**Point at anything** — a card, a job, a group, a related tab on a card — or
move to it with the keyboard, and a gold line runs from it to that tab's button
in the bar on the left, ending on a ring, the way the station card's line runs
to its pin. With the bar shrunk to icons it ends on the icon; on a phone, where
the bar is behind ☰, on ☰. A button below the nav's fold is scrolled into view
for it. The tabs, their groups and their icons are read from the nav itself, so
a new tab is on the page the moment it is added; what each card says is
`site-map.js`'s own, and `npm run nav` fails on a tab it has not written up.
Every other tab's ❔ Help ends with a pointer back here.

---

## Deployment Plan

The plan the consolidation was built to, kept as the record of it. **Every
phase shipped**, and under each step is what became of it: where it shipped, how
it was done another way, or — struck through — that it was not built or has
since gone, and why.
Work still to do is in the issues and on the roadmap,
[#113](https://github.com/cdomotor-g/MegaNet/issues/113), not here.

### Phase 1 — Data Migration (Foundation)
**Goal:** Single JSON file replaces all CSVs with no loss of information.

1. Write a migration script (standalone HTML or Node.js) that reads `ALL_UNITS.csv`, `ALL_REPEATERS.csv`, `MegaNet_Network.csv`, and `MegaNet_System.csv` and outputs a valid `stations.json`.
   **Done** as `migrate.html`, the Migration Tool, linked from the 🛠️ Admin tab.
   It reads the first two files: the networks come from `ALL_REPEATERS.csv`'s
   *BoM Network* column, and the Radio Mobile systems are written in from
   `MegaNet_System.csv`'s defaults.
2. Map existing repeater pass-window columns (up to 8) into the flexible `pass_ranges` array.
   **Done** — `Pass low 1` to `Pass high 8`.
3. Map existing `Text` (AlertID) column into `alert_ids.battery` / `.rainfall` / `.water_level` based on naming conventions in the data.
   **Done another way.** The tool files every `Text` address under `rainfall`;
   what each address measures came later, from ARRO's sensor exports, as each
   station's `sensors` (see *Field notes* above).
4. Add `roles` inference: entries in `ALL_REPEATERS.csv` → `"repeater"`, remainder → `"field"`.
   **Done**, with the unit's icon marking a base as well.
5. ~~Validate output: every station referenced in `MegaNet_NetData.csv` must appear in `stations.json`.~~
   **Not built**, and not tracked: the list has long outgrown those files — the
   Bureau's station indexes alone added 1,697 stations — so they are no longer
   the reference to check it against.
6. ~~Keep `z_Sensors_…_NATIONAL.csv` as a separate sidecar file.~~ The relevant
   sensor records (type, Sensor ID, ARRO device IDs) are now baked into each
   station's `site` / `sensors` fields in `stations.json`, and the CSV is in
   `archive/`, kept only for the ARRO ids the newer workbooks lack.

### Phase 2 — Single-Page Application Shell
**Goal:** One `index.html` with tabbed navigation replacing all three HTML files.

Tabs / panels:
- **Stations** — one page holding the interactive Leaflet map, the filterable
  table of all stations below it (names colour-coded by role, matching the map)
  and a built-in CRUD editor card below the list. Selecting a station also opens
  a **Repeaters listening** card between the two, listing every repeater with a
  pass range open to that station's addresses (nearest first); clicking a row
  puts the map on that repeater without touching the filters or the selection.
  The Stations card's filters, under the map or beside it, drive the map and the
  table together; 📍 Find a place (the blue pin) takes the map to a town, river,
  catchment, council area or coordinate
- **Radio Path Maps** — Queensland basin explorer + bundled Radio-path PDF maps, with station-aware search
- ~~**Networks** — radio network cluster management~~ — built as a read-only
  list of the clusters and the catchment vocabulary, and removed at roadmap
  revision 91: every number on it was already on a tab somebody is on (§11, §14)
- **Pass Ranges** — pass-range matching and orphaned stations; rows link through
  to the station on the Stations tab. The hop chain is drawn on the Stations map
  instead (§3)
- **Bit Flipper** — ALERT address tool
- **Ghosting Graph** — ALERT addresses as nodes, bit-flip
  adjacency and observed ghosting as edges; hands its visible set to the
  Stations map as a selection
- **ALERT Packets** — decode/encode ALERT/ERTS telemetry messages (ABF, BCC, EAF, EIF, A2C)
- **ALERT2 / ERT-A2** — decode ELPRO ERT-A2 serial captures, either wire format (ALERT2 ASCII on RS232, or the USB binary framing that carries RSSI), mapped and matched to stations
- **Serial Monitor** — live ingestion from physical COM ports (Web Serial), with ASCII / hex / ALERT-decode display; a Quansheng ALERT radio dashboard with its controls; and an RTL-SDR (Blog V2/V3/V4, WebUSB — or on a Raspberry Pi, read through PuTTY's log) that decodes ALERT off the air with a live spectrum and waterfall
- **Inspections** — the six paper station-inspection sheets, digitised: one form
  driven by `meganet.inspection_form`, drafts on the device, and the printed 6%
  tip-test rule computed rather than read
- **Site Maintenance** — the Council Maintenance Tasks sheet, digitised: the
  stewardship form rather than the calibration one, sharing every pick-list with
  the inspection form, and listing the visits whose departure rating asked for
  one and never got it
- **Inspection History** — what has already happened at a site: every past
  inspection and Council form, newest first, each opening read-only in the layout
  of the paper sheet, printable to A4 and exportable as CSV
- **Export** — Radio Mobile file generation

Technology: Vanilla JS (no framework), same stack as current `app.js`.

The shell has grown well past this list: 28 tabs in seven groups now, which
`TABS` in `core.js` describes and the 🗂️ Site Map tab draws.

### Phase 3 — Map & Link Visualisation
**Goal:** Full interactive map with signal paths.

1. Render markers by role with distinct icons/colours.
   **Done** — a colour per role (§2).
2. Compute pass-range matches at load time; draw polylines for each matched pair.
   **Done** (§2).
3. Click station → open detail panel with full record.
   **Done** — the station card (§2, §12).
4. Filter controls update both the station table and the map simultaneously.
   **Done** (§4).
5. Toggle link-line visibility per radio network.
   **Done another way.** There is no per-network switch; narrowing the map to a
   network with the *Radio network* filter and *Hide stations that don't match*
   leaves only the links whose two ends are still on it.

### Phase 4 — Pass-Range Analysis & BitFlipper Integration
**Goal:** Merge BitFlipper functionality into the main tool.

1. Move bit-flip logic and ARRO URL builder into `app.js`.
   **Done**, and moved on again when `app.js` was split: `bit-flipper.js`, and
   `buildArroUrl()` in `core.js`.
2. Cross-reference against `stations.json` alert IDs instead of loading the national CSV separately (or load it on demand).
   **Done** — the Bit Flipper reads each station's `sensors` (§6).
3. Add orphan detection (stations with no matching repeater).
   **Done** — the Pass Ranges tab (§3).
4. ~~Add gap detection (AlertID ranges not covered by any pass window in a network).~~
   **Not built**, and no issue tracks it (§3).

### Phase 5 — Radio Mobile Export
**Goal:** Generate RM files from filtered JSON data.

1. Port `buildRmFiles()` from current `app.js` to read from `stations.json`.
   **Done** — the Export tab, `runExport()` in `export.js` (§5).
2. Add ~~per-catchment and~~ per-network export scoping.
   **Per network, done**, by the tab's own ticks. Per catchment was not built,
   and no issue asks for it.
3. Allow user to set the Windows path prefix for RM config (stored in `meta` section of JSON).
   **Half done**: the paths are kept in `meta.rm_paths` and the tab shows the
   map's, but nothing in the app sets them — they change with the station
   document. No issue asks for more.
4. ~~Validate export: warn if any selected station is missing coordinates or system ID.~~
   **Not built**: the files are written as the data stands, a missing position
   as a blank, and no issue asks for a warning.

### Phase 6 — Editor & Import/Export
**Goal:** Maintain the data without editing JSON by hand.

1. Form-based station editor with validation.
   **Done** — the station editor card on the Stations tab; a save is checked
   before it is sent and again by the database ([**Editing it**](#editing-it)).
2. Add / edit / delete stations, repeaters, ~~networks, catchments~~.
   **Stations and their repeater blocks, done**, a deletion recoverable.
   Networks and catchments are not edited in the app: both arrive with the
   station document, the catchments built from the Bureau's basin boundaries
   (§8, §11). No issue asks for it.
3. Import CSV (legacy format) ~~with field-mapping wizard~~.
   **Done without the wizard**: the legacy import is `migrate.html` (Phase 1),
   which knows the two legacy files' columns by name. A wizard to map another
   CSV's columns was not built and is not tracked; data has come in since through
   the importers in `tools/`.
4. Export `stations.json` from the browser.
   **Done** — the snapshot on the 🛠️ Admin tab (§1).
5. ~~Optional: diff view showing what changed since last export.~~
   Not built as a diff against an export. What it was for — seeing what changed —
   shipped as the station card's **History** (#219): who changed each field,
   when, what it was and what it became, with **Restore**, and **Deleted
   stations** on the Admin tab. It needs `0056` on the live database, which is
   step 3 of #210. A diff against the last export is not tracked.

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
  **squares** (Flood-Net stations are circles), coloured by mechanism, capped at
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
assessed** (`los: null`, factor 0.7): `tools/acma_fetch.py` reserves a `--los`
switch for it, and no issue tracks building it. The honest blind spots — amateur
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

`data/acma-licence-suggestions.csv` matches Flood-Net repeater coordinates
against ACMA sites to help backfill `repeater.acma_licence` (only 40 of the 88
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
believe are affected and Flood-Net assembles the evidence spread across Map,
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
pass-range data, and there is less of it than this paragraph used to claim.
Re-measured against the committed `stations.json` while #105 was writing the
Pass Ranges help: the file holds **88 repeaters**, every one of them with pass
ranges and an `rx_mhz` — the "178 repeaters, 88 of them with pass ranges" this
said before is stale, and the mis-tagged entries §3 describes are no longer in
the file. What is worse than that sentence implied is the coverage: **1,075 of
the 2,479 field stations carrying an ALERT id fall outside every recorded
window — 43 %, not the ~22 % "~78 % fall inside" claimed.** So the Workbench
reports, per investigation, how many affected stations have no routing at all,
and degrades honestly when they don't — which matters more at 43 % than it did
at 22 %.

---

## Testing

```sh
cd test && npm install && npm run all
```

Sixty-two checks. The twenty-two below are the ones a change to the front end
meets first, in ascending order of cost; `test/README.md` has the full table:

| | Catches |
|---|---|
| `npm run check` | a broken brace, in under a second, before a browser is launched |
| `npm run names` | a second `function esc()` in another file silently overwriting the first |
| `npm run toplevel` | a statement that executes at load in a file that should only declare — the property the load order in `index.html` rests on |
| `npm run smoke` | the page loading and all 23 tabs opening with nothing on the console, every rendered `on*=` handler resolving to a real function, and 25 of the RF Changes / Workbench controls actually doing something when pressed |
| `npm run registry` | a Leaflet map or a tab teardown no file registered — and, at runtime, one that was registered and does not fire |
| `npm run help` | a help entry that decayed: a doc link pointing at a file that is no longer there, a *see also* naming a tab that was renamed, a placeholder that shipped, a walkthrough with no `<title>` or with a width of its own. Every one of those renders a panel that looks right, which is why smoke cannot see any of them |
| `npm run insp` | the Inspections form drawn against the schema's own seed data, on all six sheets. Smoke cannot see this one: it blocks the datastore, and this tab renders from it |
| `npm run maint` | the Council Maintenance Tasks form drawn against the workbook's own filled sheet, read out of the `.xlsx` in `archive/`. Every cell where that sheet differs from the blank template has to be either on screen or named as having no column |
| `npm run history` | a saved record reading back as the sheet it was written on. The fixture is not a file: the check fills a sheet in, saves it, and serves that document back — so the round trip is what is tested, and the read-only view is compared against the *editable* form's own section list |
| `npm run movepin` | a station's links and its move-pin mode. The five pills in the editor card and every action on the station card a pin click opens (and no callout with it), the two document searches carrying the *reduced* station name rather than the raw one and asking for both spellings of the words that have two, and the mode armed, dragged **with a real pointer**, read back, cancelled and saved. Smoke sees none of it: a pill row missing two pills and a Save that writes null over a coordinate both open a tab with a clean console |
| `npm run riverdetails` | the Bureau's flood warning details (0031, 0032) on the station card and in the editor: the card naming the indexes that list the station, its AWRC number, stream and URBS label, the newest flood classification, the gauge zero in force and the flood effects, with the rest under *Earlier*; the editor's rows shut to one line, added on top, removed without dropping focus, its three fields sent trimmed or not at all; and a save sending only the lists the form changed — an untouched list resent through the browser's parse would come back with 94.50 as 94.5, and nothing on screen would say so |
| `npm run floodlevels` | the AEP flood levels (0033) and the indicative flood velocity from them. The arithmetic off the page against figures worked by hand — Manning, the critical-flow cap, the channel bed (the gauge zero, but not a storage's, not an assumed datum's and not one 30 m down), the slope's sources and bounds, a recorded setting and an entered roughness — and `flood-velocity.js`'s default slopes against the ones the ingest wrote into `data/aep-levels.json`. Then the card: a *Flood levels (AEP)* section flagged indicative, the velocity line straight after the wind region with the module's own figures, the sheet's far-off point said out loud, nothing for a station neither sheet names; and the editor sending the AEP list, and only it, when a setting is picked |
| `npm run frequencies` | a station's RX/TX pairs (0033): the repeater's own pair as the primary row under the ids every path tool's form reads, **+ Add frequency** at the foot with the cursor in it, an untouched form sending no list and a filled row sending exactly what was typed, a use with no frequency or a frequency that is not one stopping the save by name, a base station's section of its own and none for a field station, and the card listing every pair a line each |
| `npm run stncard` | the station card on the map (#175) and the gold leader that replaced the desktop callout, at a desktop width and at a phone's. A real pin click paints the card without selecting and opens no callout; the leader leaves the card's top outline and ends on a ring round the pin, follows it through a pan, an animated zoom, a marker rebuild and a fanned-out stack, gives way when the card covers the pin (and the map moves the pin clear), goes with the card, and pulses round a repeater picked in *Repeaters listening*; a filter change rebuilds the markers and leaves the card; *Station details ↓* selects and is the one thing that scrolls the details card into view; closing it holds until the next gesture; the three cards that share a rectangle close each other; and at 375 px the callout is two pills that fit inside the map with a finger-sized close button, and *Details* opens the card as a sheet with focus in it and its leader up to a pin the sheet is not covering. Every one of those failures renders a page that looks right |
| `npm run itm` | the Longley–Rice port drifting from its reference: 53 losses computed by NTIA's own compiled library — its five published vectors and 48 synthetic profiles across every regime, climate, polarisation and mode of variability — held to 10⁻⁶ dB, intermediates included. Node-only, seconds |
| `npm run pathcover` | the profile with ground cover on it and the budget over it — the one state nothing else can reach, because the tile server is blocked. This check answers it with flat ground it makes itself and seeds the land cover: trees on flat ground obstruct, the chart draws the band, the Terrain / Statistics / Ground-cover rows add up to the path loss, an end under the trees pays P.2108's terminal loss, the height table and the switch change the profile, and the propagation settings move the figure the way they should |
| `npm run linkbudget` | the link budget card's two ends. Each is found by name, station number, ALERT address or address window — asserted against what the *Stations filter itself* returns for the same term, so the claim is that the card runs the shared matcher rather than a second copy of the rules. Then: the box keeping its caret through a paste, an end armed and filled from a pin click and from a row of the Stations list in its filtered state without selecting it, the three Clear buttons, a half-typed figure surviving a repaint it did not ask for, and the four things the table refuses to compute — the same station at both ends, a zero-length path, a term nobody supplied, and a frequency box that cannot say whether it holds an override. Every one of those is a clean console |
| `npm run twin` | the digital twin (in the Stations map, and its 🧊 side-panel pane) against a world the check makes — the State's elevation service answered with a tiled float GeoTIFF of a closed-form surface, so every mesh vertex is arithmetic: the request box grown by half a sample with the aspect snap switched off, each vertex at the surface's height at its own latitude and longitude, the Type 3 pole with its foot at the origin, the 1.75 m figure with its feet on the ground where it stands, exaggeration scaling the relief alone, the station as built (pole or tower from the record, the kit inside by telemetry, the door on approach, the ladder climbed and the deck at the top), the room (what the twin sends, a visitor played in through a fake Realtime server and drawn, walked, pointing, gone; the pointer's laser), the notes folded on a phone, the horizon (its innermost square the patch's edge vertex for vertex, each far vertex on its sheet's height at its own place less the Earth's curve, the far shell drawn first, the switch, the tiles gone), the `.glb` read back out of the binary with the horizon left out, each fallback by breaking one host, walk mode at eye height, and the renderer torn down with the tab |
| `npm run photos` | a field photo read, placed, uploaded and shown — the reader against photos built byte by byte and the overlay parser against what field camera apps print and what OCR makes of it, then the app signed in against a fake project with the real OCR engine and the real HEIC decoder: eight files dropped at once, the upload's order and records, the same photo refused three ways with its bytes taken back down, the carousel by keyboard, Dropbox's PKCE link, the map's pins clicked with a real pointer — flat, and tilted into 3-D — the twin's markers on the ground, and a real HEIC, which Chromium cannot draw, decoded and uploaded as a JPEG that is the picture. Smoke sees a tab that says "sign in" |
| `npm run flood` | the twin's flood water where the river would put it, in the colours of the levels it passes — the ladder, colours and cycle under Node against real station records (a class on an assumed-datum zero named and not drawn, a colour that never goes back from magenta to red past a major class set above the 1% AEP), then Gatton's levels stood on a valley the check makes: the channel wet at moderate, the floodplain at major, the hollow behind a bank dry until its crest is overtopped; every level passed in order in its colour; each frame of the rise where the cycle says for the moment it was drawn; the pause from the line and from the scale on the stage; the scale's marks to scale, its names never on one another and giving way least first on a short stage (the layout under Node too), a name pressed, the track dragged and taking a level near its mark, its keys; Gatton's own floods from HDB — 1893 over the rarest AEP level, so the rise goes to it, and a flood that colours nothing; the peaks contract (only a `level_m_ahd` is drawn, never a height through today's zero); hiding it, the Stations map's line and on a phone its scale, reduced motion, a phone in the hand (the scale's names and the hint standing down after five seconds and brought back by a tap on the track and by the "?", the tap leaving the water where it was, ⏸'s pill a line and a bit tall and all of it the button, and none of it for a phone's width driven by a mouse), and nothing of it in the `.glb` |
| `npm run twinsite` | the twin's site as the record builds it, on a valley the check makes: a Manual station drawn as a silver collector Ø200 × 300 mm, a 1 m staff gauge or both, and one the record cannot place as a 1 m red post saying what is not known — measured off the scene; a neighbour 129 m away built on its own ground and named; a bridge deck at Gatton's listed crossing (91.44 m AHD) and, with no listed crossing, at its banks; the four nearest donors offered to a station with no levels and one borrowed and given back; the lines over the stage folding after their delay and not under the pointer; and the map *offering* the twin at zoom 17 rather than handing itself over. Every one of those draws a plausible scene when it is wrong |
| `npm run twincadastre` | the Queensland cadastre on the twin's ground (`twin-cadastre.js`), on a curved valley and a neighbourhood the check lays over it in the service's own shape, with the stub honouring the query's `where` and paging as the live one does. Under Node: heights on the ground's triangles rather than its bilinear surface, a boundary cut at every grid line and diagonal so each piece lies in one triangle, the label point inside an L, the DCDB's accuracy codes, "Road" read as no name. In Chromium: the query (Base and Easement, not Strata; GeoJSON to the centimetre, not generalised); every line on the mesh three draws, found by a ray; the road reserve one piece — no edge two road parcels share, the junction joined, a lot's frontage drawn once; the station's lot, tenure, area, road and accuracy in words; a click naming the road, the lot and its easement, the junction and the unnamed reserve; the lot numbers looking down, standing in the lot, clear of the signs and of the stage's own controls; the lines drawn over the 10 cm drape at a slant (red with the pull toward the eye taken out); the exaggeration; the two switches and nothing asked while both are off; pages, a coarse plot, a service that will not answer, New South Wales; and the twin inside the Stations map. Needs WebGL2 and skips without it |
| `npm run twinpin` | the move-pin mode where the ground can be seen — the twin's tab, the twin inside the Stations map, and ⛰️ 3-D: the pin dragged with a real pointer and clicked into place in each renderer, the readout to the centimetre, the 3-D click landing on MapLibre's own coordinate for it rather than the flat map's, and Save writing the database's *current* copy of the station with only its position changed. Everywhere but the flat map the mode used to arm with its pin under a WebGL canvas, out of sight and out of reach |

The smoke test serves the repo on loopback, blocks every off-origin request
except a local copy of Leaflet, waits for the real `stations.json` to land, and
then opens each tab in turn watching for `pageerror` as well as `console.error`
— an uncaught `ReferenceError` during script evaluation never reaches the
console, and that is exactly the failure a moved function produces.

Since #135 it does two further things, because opening a tab was never going to
catch the failure that milestone risked. An inline `onclick=` resolves its
identifiers against the *global* scope **at click time**, so a function pulled
inside a namespace breaks its button with nothing thrown until a person presses
it. So the test now reads every `on*=` attribute each tab rendered and checks the
name in it resolves — 313 distinct handler calls across 5,578 attributes — and
then clicks its way through the RF Changes and Interference Workbench controls,
keyed by the handler each one names rather than by its label. See
`test/lib/controls.mjs`.

CI runs all sixty-two on any push touching a root `*.js`, `index.html`, `styles.css`,
`stations.json`, `db/migrations/`, `test/` or the inspection workbook in
`archive/`. The filter is a glob rather than a list of filenames
because the app's script list grew with every milestone of the split — a named
list would have to be edited by every milestone, and the one that forgot would
quietly stop being tested.

There is one more, `npm run concat`, which is not in CI: it concatenates the
scripts `index.html` loads and compares the bytes against a recorded snapshot.
That is the check that proves an `app.js` split moved code without changing it,
and the only one that catches the four literal NUL bytes the app carries inside
string literals — three in `network-view.js` since #134, one in `alert2.js`
since #133, and none left in `app.js` — because a
tool that rewrites a file as text normalises those away and silently breaks the
compound keys built from them.

`test/README.md` documents the decisions behind all of this: why HTTP rather than
`file://`, why Leaflet is vendored and everything else blocked, and what to do
when a tab is added.

---

## Design Principles

- **No build step.** Open `index.html` directly in a browser; no Node, no bundler, no server required. The
  test harness in `test/` has its own `package.json` and its own `node_modules`, deliberately kept out of
  the repo root so this stays true and the Pages build command stays empty.
- **Single source of truth.** `stations.json` is the only data file the application depends on at runtime.
- **Flexible schema.** `pass_ranges` and `alert_ids` are arrays/objects, not fixed columns, so new equipment types don't require schema changes.
- **Additive roles.** A station can be a field station, a repeater, and a base station simultaneously; roles are not mutually exclusive.
- **Separation of concerns.** Data (`stations.json`) is kept separate from logic (`app.js`) and presentation (`styles.css`, `index.html`).
- **Progressive enhancement.** Each phase delivers a working tool; later phases add capability without breaking earlier work.

---

## License

MIT © cdomotor-g, 2026
