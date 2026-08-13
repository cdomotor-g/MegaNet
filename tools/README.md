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

`check_mqtt.sql` is the companion to `check_ingest.sql` for the MQTT bridge
(#B6): 39 checks over `meganet.station_status`, `meganet.bridge_health` and the
token-checked endpoints the bridge calls, in a transaction that rolls back. The
half of that acceptance which is about a client and a broker rather than about
Postgres is `bridge/test/integration.test.js`.

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

71 checks, one per line of #115's acceptance. Three groups are worth knowing
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
