# MegaNet tools

Small command-line helpers that sit alongside the browser app. Unlike the app
itself, most of these need Python (the ACMA tools are stdlib-only; the agent also
needs a network connection and the `anthropic` package). `check_ingest.sql` and
`check_mqtt.sql` need nothing but `psql`.

`check_inspections.sql` is the same idea for the station-inspection schema
(#115): 71 checks over the lookup tables, the form matrix, the applicability
guard and the two write paths `db/migrations/0009_inspections.sql` adds, in a
transaction that rolls back. Ten of them compare a lookup table against the
`Dropdown` sheet of `archive/Inspection sheets for printing.xlsx` verbatim, so a
re-invented option list fails rather than merely looking odd.

`check_attachments.sql` covers the door #149 added on top of that schema: 47
checks over `meganet.attach_file()`, `update_attachment()` and `detach_file()`,
most of them about a *refusal*, since the path convention those functions enforce
is what keeps a private bucket's objects unguessable. `storage_bucket.sql` is the
odd one out in this directory — it **writes**, and does not roll back. It creates
the `inspections` bucket and its four policies, and exists because the previous
plan for that (a twelve-step click-path in an issue) was followed halfway and
nobody noticed.

`check_mqtt.sql` is the companion to `check_ingest.sql` for the MQTT bridge
(#B6): 39 checks over `meganet.station_status`, `meganet.bridge_health` and the
token-checked endpoints the bridge calls, in a transaction that rolls back. The
half of that acceptance which is about a client and a broker rather than about
Postgres is `bridge/test/integration.test.js`.

## Map boundaries from a KMZ (#179)

`kml_to_geojson.py` turns a KML or KMZ of polygons into a web-sized GeoJSON, with
nothing but the standard library — Douglas-Peucker simplification written out,
because adding shapely to draw a polygon would be the first crack in this repo's
no-build-step rule. `build_geo_layers.py` is the MegaNet half: the handful of
facts about *these two files* that a general converter has no business knowing —
that the basins arrive in pieces ("Border Rivers 1/2/3", "Stradbroke 1–4",
"Maroochy" twice), that `BASIN_NUMB` reads "416 QLDNSW" and is two fields, and
that one basin name is shouted in lower case.

```bash
python3 tools/build_geo_layers.py --kmz-dir ~/Downloads                    # the layers
python3 tools/build_geo_layers.py --kmz-dir ~/Downloads --write-stations   # and stations.json
python3 tools/build_geo_layers.py --kmz-dir ~/Downloads --check            # fail on drift
```

It writes `data/qld-basins.geojson` (77 basins) and `data/bom-hubs.geojson`
(8 hubs) for the map to draw, and folds each station's basin and hub back into
`stations.json`. The source KMZs are not in the repo; point `--kmz-dir` at
wherever they are. What is simplified and what is dropped is printed, never
silent: the hub file is 5,931 rings for eight hubs and all but ~660 of them are
islets under a square kilometre, which the drawn copy leaves out and the
assignment still uses.

## The Service Level Specification (#180)

`ingest/sls.py` reads six of the ten schedules out of
`archive/QLD_SLS_current.pdf` — the Bureau's Queensland flood-warning SLS,
version 3.7 (December 2025), the file the Bureau publishes at
<https://www.bom.gov.au/qld/flood/brochures/QLD_SLS_current.pdf> — into
`data/sls-qld.json` and `data/sls-locations.json`. Version 3.1 (September
2018), which it read before, is `archive/QLD_SLS_v3.1_2018-09.pdf`, and still
reads through `--pdf` for a comparison.

```bash
pip install pdfplumber                     # the only dependency in this directory
python3 tools/ingest/sls.py                # rewrite both files
python3 tools/ingest/sls.py --report       # what came out, in prose
python3 tools/ingest/sls.py --check        # fail on drift (CI does this)
python3 tools/ingest/sls.py --pdf archive/QLD_SLS_v3.1_2018-09.pdf \
  --out /tmp/sls-3.1.json --out-locations /tmp/sls-3.1-locations.json
python3 tools/check_sls_merge.py           # meganet.sls_location against the file (CI does this)
```

`check_sls_merge.py` is the other half: the merge rule is in `sls.py` for the
file the app reads and in the view `meganet.sls_location` for the database, and
it loads `data/sls-qld.json` into the database the PG* variables name — in a
transaction it rolls back, so it is safe against the live one — and compares
the view with `data/sls-locations.json` location by location. Standard library
and `psql`.

The tables are ruled, so the cell grid recovers exactly — but the grid is not
the same from one page to the next. 3.7's Schedule 2 comes out 17, 18 or 20
columns wide and Schedule 8 15 or 18, because a rule that stops short on one
page is a column boundary on another, so a fixed column index (how 3.1 was
read) files a Major level as a Moderate one on the first page that moves. The
columns are read off each table's own header instead: a heading with headings
under it is a group, one with nothing under it is a column, and every cell is
filed under the column it sits beneath. Each page's columns are checked
against what its schedule must have before a row on it is read.

Read this way, 3.1 comes out as the old reader had it, field for field, except
where the old reader lost something: the peak accuracy of all 219 Schedule 2
rows, nine rows printed without a leading zero, and two Noosa rows filed under
Maroochy because their heading is misprinted "40 – Noosa". What the page prints
that is not a value of its column — `TBC`, `N/A`, `3. 5` — is left out of the
field and written into the row's `source_note`, and three Schedule 2 rows that
give a station two targets keep both, in order, joined by ` / `.

## The Bureau's flood warning station lists (0031, 0032)

`ingest/river_height_stations.py` reads nine documents of the Bureau's
Queensland flood warning station lists out of `archive/river-height-stations/`
— the three station indexes (Sections 1–3: FloodWarn rainfall, daily rainfall,
river height), flood classifications as at 2026 and 2014 (4, 4 (B)), the
crossings (5), the survey details (6), the flood effects (9) and the URBS
details — into `data/river-height-stations.json`, and prints the SQL that
writes them into the database.

```bash
python3 tools/ingest/river_height_stations.py            # rewrite the JSON
python3 tools/ingest/river_height_stations.py --report   # what came out, in prose
python3 tools/ingest/river_height_stations.py --check    # fail on drift (CI does this)
python3 tools/ingest/river_height_stations.py --plan     # the stations --sql would create
python3 tools/ingest/river_height_stations.py --sql \
  | psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction
```

Sections 1–6 are fixed-width, and the column rule under each page's headings is
read as the layout rather than written down here. The trap is the wrapping: a
name too long for its column carries on underneath, on a line with no station
number — sometimes after a page break — and the station name wraps at a word
while the stream is cut mid-word, so the two join differently. The 2014
edition prints the same names unwrapped, and Section 3 prints them in a wider
column; every joined name agrees with both. Section 4 (B) and the URBS details
are tab-aligned and read by the column each figure ends on; Section 9 is an
HTML page of `<pre>` blocks, read the same way.

The SQL is additive: it creates the stations Sections 1–3 list that no station,
live or deleted, carries the number of — named, placed and given a catchment
and hub from the Bureau's own row — then attaches every list only where the
station has none of its own for that edition, and sets the AWRC number, stream
and URBS label only where they are empty. It never writes over a station's
position, name or elevation; `--report` lists where the Bureau puts a station a
kilometre or more from where MegaNet does, and which new stations sit on top of
an existing one, for a person to decide. Safe to run again. `--sql` reads
`stations.json` to know which stations exist, so snapshot it from the database
first. `check_river_height_details.sql` and `check_bureau_station_lists.sql`
prove the two migrations it writes into.

## The AEP flood level sheets (0033)

`ingest/aep_levels.py` reads the two workbooks in `archive/aep-levels/` —
`QLD_AEP_Levels_1.xlsx` (sheet `FWIN_QLD_V9_2`) and `NSW_AEP_Levels_1.xlsx`,
supplied 26/09/2026 — into `data/aep-levels.json`, and prints the SQL that
attaches each row to the station it describes. Each row is a flood warning
station's ground height and its modelled water level in the 1%, 0.5%, 0.2% and
0.066% AEP floods (m AHD), with the sheet's three scores.

```bash
python3 tools/ingest/aep_levels.py            # rewrite the JSON
python3 tools/ingest/aep_levels.py --report   # what came out, in prose
python3 tools/ingest/aep_levels.py --check    # fail on drift (CI does this)
python3 tools/ingest/aep_levels.py --sql \
  | psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction
```

Standard library only (`ingest/xlsx.py` reads the workbooks). The header row is
checked word for word; a level that falls as the flood gets rarer, a level below
its ground, a confidence score that is not quality × difference, or one number
twice with different rows each raise. A cell's double is kept at the precision
the sheet displays (17.510000000000002 is 17.51).

It also works out the **water surface slope** that the flood velocity needs
(`flood-velocity.js`): the fall of the modelled flood between this station and
its nearest neighbours up- and downstream on the same stream in the same basin,
2–60 km away along the stream (AMTD where both gauges have one, else the
straight line × 1.3), structures excluded. 318 rows get one. The rest take a
default — the median of those slopes among stations at a similar ground height
— written into the JSON's `meta.default_slopes`, and `npm run floodlevels`
holds `flood-velocity.js`'s copy to it.

The SQL attaches by `bureau_key()`, or by position (within ~60 m) for the eleven
QLD rows with no station number, only to live stations and only where the
station has no row from that sheet yet — so it is safe to run again.
`check_aep_levels_and_frequencies.sql` is the database's half.

## `ingest/` — the historical inspection workbook (#122)

`ingest/xlsx.py` is a read-only .xlsx reader with nothing but the standard
library, and `ingest/survey.py` is #123's survey of
`archive/QLD All Site Inspections.xlsx` — 59 worksheets, 1,420 stacked station
blocks and 20,407 dated inspection rows going back to 1980.

```bash
python3 tools/ingest/survey.py           # rewrite the four artefacts
python3 tools/ingest/survey.py --check   # re-run and fail on any drift (CI does this)
```

It writes `inspection_sheet_manifest.json` (one row per worksheet, with a
disposition and the counts #124 reconciles against), `inspection_field_map.json`
(every header label in the workbook mapped onto a canonical field, or listed
unmapped with a reason), `inspection_layouts.json` (all 226 distinct column
layouts, each column carrying its field) and `inspection_survey_counts.json`.
The prose half — block detection, header resolution, value coercion, dates,
provenance, and the three questions still open for @cdomotor-g — is
[`docs/inspection-workbook-parse-spec.md`](../docs/inspection-workbook-parse-spec.md).

`ingest/extract.py` is #124's extractor and `ingest/crosswalk.py` is #125's
station attribution; both write to `data/inspections/` and neither opens a
database connection either. **`ingest/load.py` is where all of it reaches
Postgres** (#126):

```bash
python3 tools/ingest/load.py \
  | psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction
```

It emits plain SQL on stdout, the same trade `import_stations_json.py` makes: the
output can be read before it is run. 14,982 visits, 1,093 station blocks, 151,532
measured cells and 153 rejects, in about seven seconds — the bulk goes in through
`COPY` into temporary tables and the permanent tables are upserted from those, so
the logic stays at the top and the bottom of the file and the middle is data.

Re-running it is a no-op. Each visit's primary key is a `uuid5` of its workbook
address, so the same cell yields the same id on every run, and the load is a sync
rather than an append: anything the extractor no longer emits is removed, and
nothing with `origin = 'form'` is ever touched. Requires
`db/migrations/0014_inspection_history.sql`, which the generated SQL asserts
before it writes anything.

Neither survey file writes to a database; #124 is the extractor. `xlsx.py` is the piece
worth reusing: it reads merged ranges, `#VALUE!` as an error rather than as a
blank, the real used range (`Johnstone!` declares 16,382 columns and uses 29),
and the text of a threaded comment rather than the "your version of Excel"
stand-in Excel writes beside it.

## `acma_prefilter.py` + `acma_fetch.py` — the ACMA RF interference pipeline

See the "ACMA RF Interference Layer" section of the repo README for the full
picture. In short:

```bash
# 1. reduce the ~68 MB ACMA RRL daily extract to the MegaNet-relevant subset
python3 tools/acma_prefilter.py --zip spectra_rrl.zip --stations stations.json --out data/acma-raw

# 2. classify + score interference candidates, emit the JSON the map reads
python3 tools/acma_fetch.py --suggest-licences
```

Both are idempotent, stream the big CSVs rather than loading them, and
document every flag under `--help`. `acma_fetch.py --dry-run` prints the
per-mechanism candidate counts without writing anything — it doubles as the
sanity check that frequency units parsed correctly.

## `import_arro_sensors.py` — fold ARRO sensor exports into `stations.json`

ARRO's **Sensors — List by System** report exports one workbook per state with
every sensor it knows about. This script merges those workbooks into
`stations.json`: it repairs station names (the `Site` column is authoritative —
an early import truncated names at 20 characters), fills in missing station
numbers, adds sensors to stations that already exist, and appends the sites that
were missing entirely with their sensors and coordinates.

```bash
pip install xlrd        # the exports are BIFF .xls, not .xlsx

# see what would change without touching stations.json
python3 tools/import_arro_sensors.py --dry-run --report import.md Sensors_*_List_by_System.xls

# apply it
python3 tools/import_arro_sensors.py --report import.md Sensors_*_List_by_System.xls
```

Sites are matched on `station_number` first, then — only for stations that have
no number — on an exact name, then on a name that is a clean 20-character
truncation of exactly one unclaimed site. Everything else is imported as a new
station, so a near-miss never silently overwrites an existing record. The
`--report` file lists every rename, every added sensor, every new station, the
near-matches left for a human to judge, and the names still truncated because
nothing in the inputs can expand them.

`device_id` and `site.db_id` are ARRO-internal ids that the workbooks omit;
they are looked up in `archive/z_Sensors_with_Database_IDs_by_View_NATIONAL.csv`
(override with `--national`). Re-running over the same workbooks is a no-op.

## `import_stations_json.py` + `check_stations_doc.py` — the station list, into Postgres and back out

> **If you just want the data loaded and you have a browser, you do not need
> this.** `select meganet.load_stations_from_url();` in the Supabase SQL editor
> makes the database fetch `stations.json` and load it itself — see `db/README.md`.
> This script is for a database that cannot reach GitHub, or for when you want to
> read the SQL before it runs.

`import_stations_json.py` emits SQL that syncs the `meganet` schema to
`stations.json`. Nothing in it talks to a database, which is deliberate: the
output can be piped into `psql`, attached to a ticket, or simply read before it
is run. (It is ~2.7 MB — too big to paste into a browser SQL editor, which is
what the one-liner above exists for.)

```bash
python3 tools/import_stations_json.py \
  | psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction
```

It is a *sync*, not an append — every row in the file is upserted and every row
not in the file is deleted — and it is idempotent down to `updated_at`: a second
run over the same file changes nothing and restamps nothing, so "when did this
station last change" keeps meaning something. It refuses to emit anything for a
file that does not hang together (a station pointing at a radio network or
catchment that is not defined), and warns about ranges that are inverted and
therefore match no address.

`check_stations_doc.py` is the other half, and the more important one: it proves
the document the database hands back is `stations.json`.

```bash
psql "$MEGANET_DB_URL" -tAc 'select doc from meganet.stations_json' > /tmp/doc.json
python3 tools/check_stations_doc.py /tmp/doc.json      # exit 0 = identical
```

It compares every key, array element and value, treating a key that is *absent*
as different from one that is present and null — because `app.js` tests both
`'lga' in s` and `s.site.db_id`, and those behave differently. Numbers are
compared as decimals, so float drift is caught rather than rounded away. It takes
the API's response as happily as psql's output, so it checks the deployed
endpoint too.

Both are standard library only.

## `snapshot_stations_json.py` — the station list, back out to the file

The other direction from `import_stations_json.py`, and the one that matters now
that the editor writes to the database: `stations.json` in this repo is a copy,
and a copy nobody refreshes becomes a lie. This fetches the current document and
writes the file.

```bash
python3 tools/snapshot_stations_json.py            # fetch, write stations.json
python3 tools/snapshot_stations_json.py --check    # exit 1 if it would change
python3 tools/snapshot_stations_json.py --from -   # from a document on stdin
```

Two things it does that `curl … > stations.json` would not, and they are the
reason it exists. **Key order**: jsonb sorts an object's keys by length and then
by bytes, so a raw dump reorders every key in a 160,000-line file and buries the
change that actually happened; this writes the file's own order, so a line that
moved is a line that changed. **Numbers**: parsed as `Decimal` and written back as
the literal that arrived, so `151.5` does not come back as `151.49999999999997`.

Reads with the published anon key — the same request the browser makes, no secret
involved. `.github/workflows/stations-snapshot.yml` runs it weekly and opens a
pull request; the Export tab has the same snapshot as a button.

Standard library only.

## `check_ingest.sql` — prove the telemetry contract

Not Python: a psql script, so it runs anywhere the database does and needs
nothing installed.

```bash
psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_ingest.sql
```

48 checks, one per line of #75's acceptance — deduplication counted rather than
discarded, a batch with bad rows storing the good ones and reporting each bad one
with a reason, unresolved addresses stored and backfilled later, satellite and
cellular stations addressed by station number instead of an ALERT address,
rollups reconciled against the readings they came from, and the readings ageing
out while the rollups survive.

It prints a row per check and exits non-zero if any failed, so it works from a
workflow as well as by hand. The whole thing runs in a transaction and rolls back:
nothing it writes survives, including the rollups and the retention watermark it
moves, so it is safe against the live database. It has to be run as a role
`meganet.is_editor()` says yes to — a direct psql connection, or the service key.

Run it after applying `db/migrations/0006_telemetry.sql`, and again after touching
anything in it.

## `check_inspections.sql` — prove the inspection schema

Also a psql script, same shape and same guarantees.

```bash
psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_inspections.sql
```

86 checks, one per line of #115's acceptance. Three groups are worth knowing
about. Ten compare a lookup table's labels, in order, against the `Dropdown`
sheet's columns A–L — the acceptance asks for the transcribed values rather than
a re-invented set, and this is what makes that a test instead of an intention.
Eleven check the section matrix against what the six inspection sheets actually
print, including the four places the sheets disagree with a prose summary of the
same workbook. The rest exercise the applicability guard in both directions, the
two rules the sheets print in words and the schema computes, a whole-visit round
trip through `meganet.save_inspection()`, the `PT409` refusals, and the grants —
checking both that the vocabularies *are* reachable by `anon` and that no record
table is.

Run it after applying `db/migrations/0009_inspections.sql`, and again after
touching anything in it.

## `check_inspection_history.sql` — prove the historical archive

Also a psql script, same shape and same guarantees.

```bash
psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_inspection_history.sql
```

78 checks, one per line of #126's acceptance and #122's. They come in two kinds
and the difference is the useful part. The **shape** checks build their own data
and pass against an empty database, so they can be run the moment `0014` is
applied: a `>30` goes in and comes back out as `>30` rather than as 30 or null;
a bound cannot acquire a point estimate, because a check constraint refuses one;
a year-only row says it is a year-only row; an imported ALERT visit may carry a
decoder test and a typed one may not; a parked visit keeps its name and number
and `backfill_inspection_station()` attributes it later without a reload. The
**load** checks need `tools/ingest/load.py` to have been run and say plainly that
they were skipped rather than passing vacuously — 14,982 loaded and 153 rejected
reconciling against #124's own counts, and every projected battery voltage
compared against the measurement it was read from, which is the check that would
catch the section tables and the measurements drifting apart.

Run it after applying `db/migrations/0014_inspection_history.sql`. Run
`check_inspections.sql` beside it: `0014` widens `0009`'s section matrix and
restates its three guards, and those 86 checks are what prove it did not break
them.

## `check_attachments.sql` — prove the attachment door

Also a psql script, same shape and same guarantees.

```bash
psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_attachments.sql
```

47 checks over `db/migrations/0010_attachments.sql`. The largest group is about
refusal, and that is the point: `meganet.attach_file()` is the only way a browser
can write `meganet.attachment`, and most of what it does is say no. It refuses an
object filed under another record's prefix, a camera's own filename as the object
name, an extension the content type does not arrive under, a type that is not in
`meganet.attachment_type`, a file over that type's limit, a role that is not real,
both owners at once, neither owner, a bucket that is not `inspections`, a record
that does not exist and a record that has been soft-deleted.

Two of the checks are worth singling out. One asserts that `authenticated` still
holds `select` on `meganet.attachment` and **none** of the write verbs — the
whole reason 0010 is three functions rather than one `grant`, and a property that
would otherwise decay silently. The other asserts that a caption can be *cleared*
as well as changed, which is why `update_attachment()` takes a patch: a null
argument cannot express the difference between "set this to nothing" and "leave
this alone".

What it deliberately does not check is whether the bucket exists — a database
connection cannot see Storage's own state. That is `storage_bucket.sql`'s verdict
block, below, and it is exactly the half that went missing last time.

Run it after applying `db/migrations/0010_attachments.sql`, and again after
touching anything in it.

## `check_river_height_details.sql` — prove the river height station details

30 checks over `0031`, in a transaction that rolls back: the five tables and
their RLS and grants, the crossing-type and datum vocabularies against the
Bureau's legend, `save_station()` writing the three lists — including leaving a
list the document does not mention alone, and clearing one it sends empty — its
refusals of an unknown code and of a signed-in non-editor, and the loader's
sync and its `document_managed` guard. CI runs it after the stations load.

```bash
psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_river_height_details.sql
```

## `check_bureau_station_lists.sql` — prove the Bureau's index listings and flood effects

20 checks over `0032`, in the same shape: the three tables, their RLS and
grants, the three indexes against the Bureau's section numbers, the station's
three new fields, `save_station()` writing the two lists — blank rows dropped,
a list the document does not mention left alone, one it sends empty cleared —
its refusals of an index nobody prints and of a listing with no index, and the
loader's sync. CI runs it after the stations load.

```bash
psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_bureau_station_lists.sql
```

## `check_aep_levels_and_frequencies.sql` — prove the AEP levels and the frequencies

23 checks over `0033`, in a transaction that rolls back: both tables with RLS
and grants, `save_station()` writing both lists — keeping the digits a figure
was written with, leaving a list the document does not mention alone, clearing
one it sends empty — its refusals of a setting that is neither channel nor
floodplain, a score out of range, an implausible Manning n, a negative slope
and a frequency of zero, and the loader's sync. CI runs it after the stations
load.

```bash
psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_aep_levels_and_frequencies.sql
```

## `storage_bucket.sql` — create the `inspections` bucket and its policies

The one script here that writes, and the one that does not roll back. Idempotent
and safe to re-run: the bucket is an upsert and each policy is dropped before it
is created.

```bash
psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/storage_bucket.sql
```

It creates a **private** bucket called `inspections` and four policies on
`storage.objects` granting read, insert, update and delete to exactly the people
`meganet.is_editor()` already allows — the same list as the station editor and the
same list as every inspection table, so there is one list to take somebody off
rather than three. It finishes by asserting all three things it could have got
wrong: the bucket exists, `public` is false, and there are four policies. It
raises rather than printing a row, so a scripted run fails loudly.

**Why it is here and not in `db/migrations/`.** `storage.buckets` and
`storage.objects` are Supabase's, not ours, and `db/README.md` records exactly one
deliberate exception to "everything MegaNet owns lives in `meganet`". This is not
a second one.

**Why it is a file and not a dashboard click-path.** Because the click-path was
tried. #145 asked for the bucket and the policies in twelve steps; its other half
(applying `0009`) was done, this half was not, the issue was closed as if both
had been, and #149 found the bucket missing underneath a feature that indexes
objects into it. A file can be re-run when you are unsure, diffed when it
changes, and checked at the foot.

Run it once per project, after `db/migrations/0010_attachments.sql`.

## `meganet_agent.py` — ask questions about the network with the Claude API

An agentic Claude API loop that answers natural-language questions about the
station network. Claude runs Python in an Anthropic-hosted **code-execution
sandbox** and, from inside that sandbox, calls a `query_stations` tool that
reads the local `stations.json`. Because the dataset is large (3,000+ stations),
this keeps the raw records out of the model's context — Claude filters and
aggregates in code and only the answer comes back.

### Setup

```bash
pip install anthropic          # Python 3.9+
export ANTHROPIC_API_KEY=sk-ant-...   # your key; read from the env, never stored
```

### Use

```bash
python3 tools/meganet_agent.py "How many repeaters are in the Burdekin River basin?"
python3 tools/meganet_agent.py --verbose "List field stations in Townsville City LGA"
echo "Which basins have the most stations?" | python3 tools/meganet_agent.py
```

Options: `--model` (default `claude-opus-4-8`), `--max-turns`, `--max-tokens`,
`--stations <path>`, `--verbose` (per-turn trace to stderr).

### The `container_id` fix

This is the pattern that trips people up. When a custom tool is invoked from
*inside* the code-execution sandbox ("code execution with tools", a.k.a.
programmatic tool calling), that tool-use is bound to a sandbox **container**.
The naive agent loop sends the tool results back on the next request without
referencing the container, and the API rejects it:

```
HTTP 400: container_id is required when there are pending tool uses
generated by code execution with tools.
```

The fix: capture `response.container.id` and pass it back as the `container=`
argument on every follow-up request so the API resumes the *same* sandbox:

```python
kwargs = dict(model=model, max_tokens=max_tokens, tools=tools, messages=messages)
if container_id:                 # set once the first response returns a container
    kwargs["container"] = container_id
resp = client.messages.create(**kwargs)
if getattr(resp, "container", None):
    container_id = resp.container.id   # remember it for the next turn
```

See `meganet_agent.py` (`_run_turn` and the loop in `run_agent`) for the full,
commented implementation, including `pause_turn` handling and returning tool
results as *only* `tool_result` blocks (required for programmatic tool calls).
