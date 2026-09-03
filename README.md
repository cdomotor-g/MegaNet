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
├── networks.js             ← Networks tab
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
├── terrain.js              ← Terrain   — ground height from terrarium PNG tiles
├── modal.js                ← Modal     — the shared dialog shell
├── packets.js              ← Packets   — ALERT / ERTS codec, and its tab
├── alert2.js               ← Alert2    — ALERT2 / ERT-A2 tab
├── network-maps.js         ← Maps      — Radio Path Maps tab (named for the tab, not
│                             the module, so it isn't confused with maps-data.js)
├── serial.js               ← Serial    — Serial Monitor tab (Web Serial)
├── message-log.js          ← MessageLog — Message Log tab (the arrival log:
│                             every message the datastore accepted, filterable,
│                             with a plot-and-map tray and a decode drawer)
├── bug-report.js           ← BugReport — prefilled GitHub issue reporter
├── init.js                 ← the only code that runs at load; must stay last
├── maps-data.js            ← Radio Path Maps catalogue, QLD basin SVG + georeference
├── styles.css              ← the design system, then theme and layout
│                             (tokens at the top; docs/design-system.md is the prose)
├── stations.json           ← the document schema (see below); export + offline fallback
├── migrate.html            ← legacy-CSV → stations.json converter (linked from the app)
├── .nojekyll               ← serve every file verbatim on GitHub Pages
│
├── maps/                   ← Radio-path maps for the Radio Path Maps tab, by region
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
│   ├── design-system.md                    (tokens, breakpoints, patterns, a11y primitives — #109)
│   ├── datastore-decision.md               (why Postgres on Supabase, and where)
│   ├── access.md                           (who gets in, who may edit, and recovery)
│   ├── ingest-http.md                      (posting readings from a field station — #B5)
│   ├── ingest-mqtt.md                      (topic scheme, broker choice, station credentials — #B6)
│   ├── mqtt-provisioning.md                (standing the broker and bridge up — browser only)
│   ├── message-log.md                      (the Message Log tab — columns, uses, edges)
│   ├── floodwarning-net.md                 (moving the domain to MegaNet — runbook)
│   ├── BOM spec erts_data_formats_doc.pdf   (ERTS Data Formats spec, ALERT Packets tab)
│   ├── Hydrology Raw Data Filtering Program Specification.pdf  (357 filter, v2.1 2009)
│   ├── 357 Filter doco.doc                  (the 1998 first edition of the same spec)
│   └── aem_Durikai_AL_541134_Rainfall_541134_0_R_5758.csv  (sample ARRO export)
│
├── db/                     ← the datastore's schema, as plain SQL
│   ├── README.md                           (how to apply, and the rules — read first)
│   └── migrations/                         (numbered, forward-only, run with psql)
│
├── bridge/                 ← the MQTT → MegaNet subscriber (#B6; Node, one dependency)
│   ├── README.md                           (running it, its config, and what its logs mean)
│   ├── index.js, src/                      (topics, payload rules, batching + acking, health)
│   ├── test/                               (npm test — unit, plus a real broker end to end)
│   ├── deploy/                             (mosquitto.conf + ACL examples for the self-hosted case)
│   └── tools/publish-sample.js             (a test client, for proving the path from a laptop)
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
│   ├── smoke.mjs            (headless Chromium: load, open all 19 tabs, clean console)
│   ├── dup-names.mjs        (no duplicate top-level names across the loaded scripts)
│   ├── inspections.mjs      (the six sheets, against the migration's own seed data)
│   ├── maintenance.mjs      (the Council sheet, against the workbook's filled example)
│   ├── history.mjs          (a saved record read back, against the form that wrote it)
│   ├── help.mjs             (every tab's help entry: real content, links that land)
│   ├── concat-verify.mjs    (byte-exact concat-and-diff, for the app.js split)
│   ├── syntax-check.mjs     (node --check over every script index.html loads)
│   └── package.json         (down here on purpose — the app itself still has no build step)
│
├── tools/                  ← command-line helpers (needs Python; see tools/README.md)
│   ├── check_ingest.sql     (psql: prove the telemetry contract — 48 checks, rolls back)
│   ├── check_mqtt.sql       (psql: prove the MQTT bridge's database half — 39 checks)
│   ├── check_inspections.sql (psql: prove the inspection schema — 90 checks, rolls back)
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
> `maps/<region>/` folder and add its filename to `MAP_CATALOG` (and `FILE_INFO`).

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

**Load stations.json from this device** is untouched and always available. Working
from a laptop with no network is a real part of this job.

The fallback is not padding. A free-tier Supabase project pauses after about a
week of inactivity, and a paused project *fails* the read rather than slowing it
down — MegaNet is exactly the burst-shaped tool that gets paused. Falling back
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
  database until somebody with SQL access says otherwise.
* **Saving needs a signed-in session.** The database refuses anonymous writes.
  Signed out, the editor still opens and still shows everything — the Save button
  reads **Sign in to save** and opens the sign-in panel rather than failing at the
  network. See [**Signing in**](#signing-in) below.
* **Saving is refused while the app is on the file fallback.** If the header says
  the list came from `stations.json` rather than the datastore, load from the
  datastore before editing: otherwise Save would write what is on screen over
  whatever the database has since been told.

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

### Keeping `stations.json` current

The file is a copy now, so it is refreshed on a schedule rather than left to
drift: `.github/workflows/stations-snapshot.yml` runs
`tools/snapshot_stations_json.py` weekly and opens a pull request when the
document has moved. The Export tab has the same snapshot as a button, for a copy
to take somewhere without a network.

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
completely separate source of truth from ARRO — same charting machinery later
(#B7), different data.

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

HTTP POST (#B5), the MQTT bridge (#B6), a backfill from an ARRO export and a
person typing one in are all adapters onto that call, which is why each of them
is thin and why none of them gets to disagree with the others about timestamps.
It is a plain Postgres function, so the whole thing moves inside the corporate
network with a `pg_dump`.

Four facts about this network are in the schema rather than left to be discovered:

* **The address is the identity, not the station.** A packet carries an address;
  which station that is may be unknown. 604 of 5,122 ALERT addresses belong to
  more than one station, and a new site reports before anyone adds it to MegaNet.
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
this is the first piece of MegaNet that needs a process running somewhere
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

### Reading it back — two tabs, one table

What lands through `ingest()` is read back two ways. **Field Data** charts one
station's sensors over a window — the 357 filter, the rollups, the gaps.
**Message Log** is the same rows read as an arrival log: every message the
datastore accepted, newest first, with the ingress pathway (protocol,
transport, which base heard it, how many further copies by which other paths)
as columns, a plot-and-map tray over any selection, a decode drawer per row,
and a Follow switch for watching a field test land. Each page links to the
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
| `catchment_ids` | `string[]` | References `catchments[].id`. **Not yet populated** — the Radio Path Maps tab derives a station's catchment at runtime from its coordinates (see feature 8). Populate this to make map suggestions exact. |
| `TBRGbucketSize` | `number` | Millimetres per tip for this station's tipping-bucket rain gauge. **Absent, not `null`, when not recorded** — most stations today. Every consumer that converts a tip count to millimetres falls back to an assumed 0.2 mm/tip and says so (`bucketSizeMm()` in `app.js`) when this is missing. Named as the ticket that introduced it asked, so it doesn't match this schema's usual snake_case (`tbrg_bucket_size_mm`) — flag it if that should change before more call sites depend on the name. |

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
- Light up the watercourses whose names match the filter box, drawn beneath the pins from OpenStreetMap (*Highlight matching rivers*)
- Draw and measure over the map: pins, lines, circles, rectangles and text, placed by hand or by coordinates and km, in a colour of your choosing
- Snap drawing to stations, so a path between two sites starts and ends on the sites and is named after them
- Select stations off the map — by rectangle, by circle, or by shift-clicking pins — into the table below, and export the set as CSV
- Leaflet.js, with the map's own controls stacked in its top-right corner as four icons — base
  map (OSM-Topo by default, OpenStreetMap, Satellite or Dark), **Map display**, **Draw & measure**
  and the **legend**. Each is an icon and nothing else until you point at it, click it or tab to it,
  and each can be pinned open — a pin that is remembered between visits

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

**Station names.** Names are capped at 60 on screen, because past that they
overlap into noise. The **Station names** control decides when they appear:
*Auto* (the default) draws them once the current view holds few enough to read,
so the national view is clean and zooming into a region brings them in; *On*
forces them for whatever is in view, keeping the 60 nearest the centre and
saying so over the map; *Off* draws none at all. Filter matches are always
named in Auto and On.

**Map and table together.** The map and the station table share the Stations
tab and the one filter card: a search term, role or network narrows the table to
the matching rows while the map highlights (or, with *Hide stations that don't
match*, drops) the same set. Picking a row pans the map to that station and
opens its pin, so the list and the map never disagree about which site is being
looked at.

**The ARRO column.** The last column on every row is a link straight out to that
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

**The station card, and the callout as a signpost (#175).** Clicking a pin
paints a card in the map's bottom-left corner — the station's number,
networks, position, elevation, wind region, every ALERT id with its reading
kind, a repeater's passing count and delay, the ACMA threat count, and every
action pill — *without* selecting the station: reading about a site must not
drag the editor and the table along, and the scroll from the map down to the
list to *see* a station and back up again was what this replaces. It is the
map's own memory of what you were last looking at: a filter keystroke rebuilds
every marker and takes the callout with it, and the card stays; selecting a row
paints it too, which is also the keyboard's way onto a map whose pins are
canvas. *Edit station ↓* on it selects the station and is the first thing in
the app that scrolls the editor into view. The callout on the pin shrank to
match — name, roles, `Stn #N · elevation`, and one *Actions (N) ▾* button that
opens the pills, remembered for the session once pressed — because the callout
carrying all of that *and* ten pills was a lot. On a phone the callout is the
identity and two fat pills, *Details & actions* and *Copy lat, lon*, sized to
fit inside the map with a finger-sized close button, and the card opens from
*Details* as a sheet across the bottom of the map. One card over the map at a
time: opening this one, the ACMA transmitter card or the radio-path card closes
the other two — which also ends the case where the last two, drawn in the same
rectangle, simply covered each other. The legend's last line names whichever
optional layers are off and that the 👁️ button is where they are turned on, the
👁️ flyout is grouped under three headings, and a first visit is told about the
button once.

**What that costs, stated rather than left to be found.** The split existed
because reaching a filter at the bottom of the rail dragged the map off the top,
and scrolling to a filter now scrolls the map away above it. Three things make
that a smaller problem than the one the split was solving: the filters are a
single card immediately under the map rather than a rail longer than the
viewport, the card collapses, and its summary line carries the live match count
— so what the filters are doing is readable without opening them, and reading it
costs you nothing of the map.

Inside the card the search box leads and spans, and the six filter groups flow
into as many columns as the window allows — four on a wide screen, two at 768 px,
one on a phone. A 320 px rail had one sensible arrangement; a card the width of
the page has a better one.

**Full screen.** The ⛶ button in the map's top-right corner, under the four
panel icons, fixes the map's panel to the viewport — the match note, the ACMA
and path cards and the corner controls all ride along, because they are all
positioned inside that panel. Press it again, or Escape, to put the page back;
Escape defers to any dialog open over the map, and the bug reporter still
opens on top. It is deliberately not a modal, though "a modal map" is how the
ask arrives: the shared dialog shell wipes its content on every exit, which
would destroy a live Leaflet map mid-flight, whereas adding a class to the
panel and removing it later never moves or rebuilds the map at all. Full
screen is something an operator is doing, not a preference, so it lasts the
session and is not remembered.

**Signal links and *Kill spaghetti*.** Links are drawn from each field station
to every repeater whose pass ranges cover one of its ALERT addresses, which
across the whole network is 3000-plus lines, many of them running the length of
the country because two distant sites happen to share an address window.
*Kill spaghetti* (on by default) drops any link longer than **Max TX distance**
— 70 km by default, adjustable from 0 to 600 km, which is the range a VHF hop
plausibly covers. The panel says what it is removing ("1537 links drawn · 1604
over 70 km hidden"), so a link that vanished is never a mystery. Untick it to
see every path however long, at any distance.

> The default was 120 km until #164 and is 70 km now, by request. 120 was the
> *ceiling* — about as far as a VHF hop plausibly reaches — and a map that opens
> at the ceiling opens as spaghetti: 1938 of 3141 paths drawn. 70 km draws 1537
> of them and is where the great majority of this network's real hops sit. It
> also halves the backbone: 183 qualifying pairs at 120 km, 96 at 70. Nothing is
> lost either way — the slider still runs to 600 km, and *Kill spaghetti* off
> draws every path however long.

Each link is drawn twice — a wide white casing underneath and the coloured line
on top — so it stays legible over satellite imagery and topo shading, where a
single thin orange line disappears. **Link opacity** fades the pair together
when the lines are burying the pins they are meant to explain.

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
app's own light/dark theme — pick it from the **Base map** icon. It is not
offered as a base for **Map Generator** sheets: the print palette is drawn to
sit on a light base and would disappear into a black one, and both laser modes
want no raster at all. *(CARTO's Dark Matter was the first choice and was
dropped: its keyless tiles now come back stamped "API KEY REQUIRED" across the
middle. Esri needs no key and was already serving three of this app's layers.)*

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
> real coordinates would make it a good offline layer; until then it stays out of
> this. See issue #84.

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

**Wind loading regions.** *Wind regions (AS/NZS 1170.2)*, another **Map
display** switch, draws the Standard's wind loading regions — A0–A5, B1, B2,
C and D — under the pins, on the severity ramp the Standard's own map uses:
green temperate through amber and orange to cyclonic red, with the Pilbara's
D in purple.

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
number: the same Longley–Rice run the link budget card does, over the same 64-sample
terrain, for both ends' filed radios — and the map paints each link **green at
15 dB or better, yellow at 6, red below**, with the thresholds editable in the
same flyout. The margin drawn is the **worse of the two directions**: path loss
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
and only the margins are expensive. Where both switches are on, the margin wins:
it is the one with a figure behind it, and it has already been charged for the
obstruction.

**Draw & measure.** A sketching layer over the network map, opened from the
pencil icon in the map's top-right corner — and pinnable open, which is what you
want while you are actually drawing. It is for the picture
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
- **Station names** — decoded ALERT addresses are matched against the loaded MegaNet station
  database first (shown with a *MegaNet* badge), then against the bundled national address file
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
| **Stations & networks** | Stations · Radio Path Maps · Networks · Pass Ranges · Export |
| **Interference** | RF Environment · RF Changes · Interference Workbench |
| **Addresses & packets** | Bit Flipper · Ghosting Graph · ALERT Packets · ALERT2 / ERT-A2 · Serial Monitor |
| **Telemetry** | ARRO Launcher · ARRO Data · Field Data |
| **Site visits** | Inspections · Site Maintenance · Inspection History |

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
- **Export moved.** All three of its own `related` entries are Stations &
  networks tabs, two of them mutual, and what it builds is scoped by the ticks on
  the Networks tab. It sat under "Data & admin" and belongs with the network it
  exports.

#### Three tabs said "network" and meant three things
`Network Maps` is not about networks — it browses the bundled Radio-path PDF map
sheets — so it is **Radio Path Maps**. `Network View` is not about networks
either: it draws ALERT addresses as nodes and bit-flip ghosting between them as
edges (§16 already called it the ghosting knowledge graph), so it is the
**Ghosting Graph**. `Networks` keeps the word, being the only one of the three
that means the named radio-network clusters in the file. Both old labels survive
as find words, so the rename strands nobody; **tab ids are unchanged**, because
they key `HELP`, `renderMain()`, the teardown registry and `localStorage`.

#### Find a tab
Nineteen tabs is past the size where a column of labels is something you scan, so
the nav carries a find box — **Ctrl/Cmd+K** from anywhere, or 🔎 on the collapsed
rail, both of which open the nav with the cursor already in it.

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
- **The ARRO Launcher tab** — a jump box, grouped under **Telemetry**.

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
Grouped under **Addresses & packets**, next to the Bit Flipper it generalises.

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
test, rollover correction, repeat timestamps, a **rate-of-rise** limit and
**minimum / maximum** limits each have their own on/off, so any of them can be
taken out of the pipeline and the difference read straight off the counts. Only
the first two come from the specification; the other three are gates this app
adds, and they run *before* the continuity walk so a reading nothing could have
produced never gets a vote on its neighbours:

- **Rate of rise** compares each reading with the one before it, and claims the
  step and nothing more. Anchoring to the last *surviving* reading is the
  obvious-looking alternative and it is a trap — a gauge that genuinely steps up
  and stays there is then measured against a value it will never return to, and
  the whole record after the step is lost. A corrupt plateau costs its first
  reading here and the rest is the 357 walk's business, which is what breaking
  and re-establishing continuity is for. An accumulator is only tested upwards;
  a water level is tested both ways, so a single dropout costs two readings.
- **Minimum / maximum** bound the exported `Value`, either end blank for
  unbounded.

Each removal keeps the name of the filter that made it: a cross for the 357
test, a square for out of range, a triangle for too fast, on the chart and in
the CSV verdict export alike.

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
library. It carries wheel zoom, drag to pan, drag-to-select zoom on either or
both axes, an overview strip of the whole record with the visible window on it
— movable, and resizable by its edges — a crosshair with a hover readout,
keyboard pan/zoom, per-series colour and visibility, solo and fit, light/dark
repaint, and SVG/PNG download. Three readings of the data
(value, increment, rate per hour), three chart styles (line, step, points) and
four vertical scales — including **Kept**, which scales to the surviving
readings so a single 2014 mm spike stops flattening a 300 mm trace, and draws
the removals that fall outside as triangles on the top edge rather than hiding
them.

**The toolbar over it is three captioned rows**, and the split is the whole of
it: *what the chart draws* (Series · Reading · Style · Vertical axis), then *the
window and what happens over it* (Window · Mark · Drag to zoom), then *Export*.
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

**Three ways into a closer look.** *Drag to zoom → box* (or Shift held) draws a
box, and the window becomes the box — both axes now, not just time. A flat sweep
stays the time-only zoom years of use have taught, and the rubber band says
which it will be before the button comes up: full height for a flat sweep, the
box itself otherwise. *Drag to zoom → vertical* (or Alt held, so neither zoom
ever needs the toolbar) is the other direction: time stays put and the vertical
axis becomes the dragged span. And the overview's window is no longer
drag-to-recentre only — each edge carries a grip that drags that edge alone,
so the window resizes as well as moves. What the drag zooms do to the vertical
axis is not private state: they commit through the toolbar's own axis mode —
*Fixed*, with the min/max boxes holding the dragged numbers — so the committed
range is visible, editable, and honest about what happened. Double-click, or
the 0 key, resets both axes and restores whatever vertical mode was chosen
before the first zoom; choosing a mode by hand drops that memory, because the
operator has spoken since and reset must not overrule them.

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

On a Chromium browser the **Watch** button re-opens the same log on a timer
through the File System Access API, which is as close to live as this gets
without a serial port — and the case for opening one. A machine whose policy
blocks that API now says so, with the policy name, instead of the button doing
nothing.

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

### 20. Help Panel (Contextual, Right-Hand)
A right-hand rail that says what the open tab is for and what to watch out for
on it. It exists because a real amount of explanation was already scattered
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
strip rather than to nothing, keeps its state in `localStorage` under `mn-help`
beside `mn-nav` / `mn-theme` / `mn-filters`, and re-measures every Leaflet map
once its width transition has finished rather than during it. Three places it
deliberately differs, because a reference surface is not a navigation one:

- **It starts collapsed at every width**, not just under 900 px. The nav is used
  on every interaction and earns its column; this is read once and closed. A
  stored preference always wins, as it does for the nav.
- **Under 560 px it becomes a drawer, and the two are mutually exclusive.**
  Opening either closes the other, so a 390 px screen is never asked to hold two
  drawers at once.
- **Its phone toggle stays on the panel, not in the header.** The nav could move
  ☰ into the header because the header already had a slot on the left. There is
  none on the right, and a seventh header button measured 30 px taller at 390 px
  — a permanent cost to the banner for a control that only matters when you go
  looking for it. So the strip becomes a fixed tab on the screen edge instead:
  still always present, costing no layout width.

The widths in between need no special case. The Stations tab is a single column
at every width since #165, so the nav and this panel are the only two things
holding width beside it. `--mn-help`
narrows from 300 px to 260 px below 1400 px all the same, so the map keeps a
usable share of a laptop with everything open.

**The content has a check of its own**, `npm run help`, and it exists because
every way this decays is silent. A doc link that 404s, a *see also* naming a tab
that was renamed, a placeholder that shipped and a walkthrough with no `<title>`
all render a perfectly good-looking panel — `npm run smoke` opens the tab and
the tab is fine. See **Testing** below.

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
  and a built-in CRUD editor card below the list. Selecting a station also opens
  a **Repeaters listening** card between the two, listing every repeater with a
  pass range open to that station's addresses (nearest first); clicking a row
  puts the map on that repeater without touching the filters or the selection.
  The filter card under the map drives the map and the table together
- **Radio Path Maps** — Queensland basin explorer + bundled Radio-path PDF maps, with station-aware search
- **Networks** — radio network cluster management
- **Pass Ranges** — pass-range matching and hop-chain view; rows link through to
  the station on the Stations tab
- **Bit Flipper** — ALERT address tool
- **Ghosting Graph** — ALERT addresses as nodes, bit-flip
  adjacency and observed ghosting as edges; hands its visible set to the
  Stations map as a selection
- **ALERT Packets** — decode/encode ALERT/ERTS telemetry messages (ABF, BCC, EAF, EIF, A2C)
- **ALERT2 / ERT-A2** — decode ELPRO ERT-A2 serial captures, either wire format (ALERT2 ASCII on RS232, or the USB binary framing that carries RSSI), mapped and matched to stations
- **Serial Monitor** — live ingestion from physical COM ports (Web Serial), with ASCII / hex / ALERT-decode display
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

Twenty-five checks. The fourteen below are the ones a change to the front end
meets first, in ascending order of cost; `test/README.md` has the full table:

| | Catches |
|---|---|
| `npm run check` | a broken brace, in under a second, before a browser is launched |
| `npm run names` | a second `function esc()` in another file silently overwriting the first |
| `npm run toplevel` | a statement that executes at load in a file that should only declare — the property the load order in `index.html` rests on |
| `npm run smoke` | the page loading and all 19 tabs opening with nothing on the console, every rendered `on*=` handler resolving to a real function, and 25 of the RF Changes / Workbench controls actually doing something when pressed |
| `npm run registry` | a Leaflet map or a tab teardown no file registered — and, at runtime, one that was registered and does not fire |
| `npm run help` | a help entry that decayed: a doc link pointing at a file that is no longer there, a *see also* naming a tab that was renamed, a placeholder that shipped, a walkthrough with no `<title>` or with a width of its own. Every one of those renders a panel that looks right, which is why smoke cannot see any of them |
| `npm run insp` | the Inspections form drawn against the schema's own seed data, on all six sheets. Smoke cannot see this one: it blocks the datastore, and this tab renders from it |
| `npm run maint` | the Council Maintenance Tasks form drawn against the workbook's own filled sheet, read out of the `.xlsx` in `archive/`. Every cell where that sheet differs from the blank template has to be either on screen or named as having no column |
| `npm run history` | a saved record reading back as the sheet it was written on. The fixture is not a file: the check fills a sheet in, saves it, and serves that document back — so the round trip is what is tested, and the read-only view is compared against the *editable* form's own section list |
| `npm run movepin` | a station's links and its move-pin mode. The five pills in the callout and in the editor card, the two document searches carrying the *reduced* station name rather than the raw one and asking for both spellings of the words that have two, and the mode armed, dragged **with a real pointer**, read back, cancelled and saved. Smoke sees none of it: a pill row missing two pills and a Save that writes null over a coordinate both open a tab with a clean console |
| `npm run stncard` | the station card on the map and the callout it turned into a signpost (#175), at a desktop width and at a phone's. A real pin click paints the card without selecting; a filter change destroys the callout and leaves the card; *Edit station ↓* selects and is the one thing that scrolls the editor into view; closing it holds until the next gesture; the three cards that share a rectangle close each other; and at 375 px the callout is two pills that fit inside the map with a finger-sized close button, and *Details* opens the card as a sheet with focus in it. Every one of those failures renders a page that looks right |
| `npm run itm` | the Longley–Rice port drifting from its reference: 53 losses computed by NTIA's own compiled library — its five published vectors and 48 synthetic profiles across every regime, climate, polarisation and mode of variability — held to 10⁻⁶ dB, intermediates included. Node-only, seconds |
| `npm run pathcover` | the profile with ground cover on it and the budget over it — the one state nothing else can reach, because the tile server is blocked. This check answers it with flat ground it makes itself and seeds the land cover: trees on flat ground obstruct, the chart draws the band, the Terrain / Statistics / Ground-cover rows add up to the path loss, an end under the trees pays P.2108's terminal loss, the height table and the switch change the profile, and the propagation settings move the figure the way they should |
| `npm run linkbudget` | the link budget card's two ends. Each is found by name, station number, ALERT address or address window — asserted against what the *Stations filter itself* returns for the same term, so the claim is that the card runs the shared matcher rather than a second copy of the rules. Then: the box keeping its caret through a paste, an end armed and filled from a pin click and from a row of the Stations list in its filtered state without selecting it, the three Clear buttons, a half-typed figure surviving a repaint it did not ask for, and the four things the table refuses to compute — the same station at both ends, a zero-length path, a term nobody supplied, and a frequency box that cannot say whether it holds an override. Every one of those is a clean console |

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

CI runs all twenty-three on any push touching a root `*.js`, `index.html`, `styles.css`,
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
