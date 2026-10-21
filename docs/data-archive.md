# The data archive

Flood-Net keeps everything it has been sent. The database holds the recent past in
full and the rollups for ever; **every raw row also goes to Cloudflare R2, a UTC day
at a time, before the database is allowed to let it go** (#243, `db/migrations/0073`).

| What | Full detail in the database | Kept for good |
| --- | --- | --- |
| Readings (`meganet.reading`) | 730 days | `reading_hourly` / `reading_daily`, and every row in R2 |
| Receptions (`meganet.reception`) | 90 days | `reception_hourly` / `reception_daily`, each transmitter's carrier offsets by the day (`carrier_daily`, 0077), every corrupted copy found (`flip_event`, 0078), and every row in R2 |
| Submissions (`meganet.reading_raw`) | 30 days | every row in R2 |

## How a day is archived

Nightly at 14:37 UTC (00:37 Brisbane), `.github/workflows/archive-r2.yml` runs
`tools/archive/archive-to-r2.mjs` with the project's secret key. For every UTC day two
or more days old that is not yet archived at its row count (`meganet.archive_due`), it
reads the day an hour at a time (`meganet.archive_rows`, every column as stored), gzips
it as NDJSON, puts it through the Worker (`PUT /api/archive/<table>/<yyyy>/<mm>/<dd>.v<n>.ndjson.gz`,
create-only, R2 checking the SHA-256 on the way in), **reads it back** and checks it, and
only then records it in `meganet.archive_day`. A row that arrives after its day was
archived makes the day due again; it is written as the next version beside the first.
Nothing is ever overwritten.

## How a day is deleted

`meganet.retain()` runs on pg_cron at 15:17 UTC. It rolls up, then deletes **only** a
day that is past its table's horizon, archived at exactly the rows it has now, and —
for readings and receptions — rolled up to exactly that count. Anything else stays,
however old. A night the archive does not run, nothing new is deleted.

## Getting a day back

```sh
SUPABASE_SECRET_KEY=… node tools/archive/restore-day.mjs reception 2026-10-05 > day.ndjson
```

It checks the object's hash and line count against the manifest and writes the rows, a
JSON object a line. An editor's access token works too (`ACCESS_TOKEN=…`). To look at
it in Postgres without touching the live table:

```sql
create temporary table day (like meganet.reception);
create temporary table lines (j jsonb);
\copy lines from 'day.ndjson'
insert into day select (jsonb_populate_record(null::meganet.reception, j)).* from lines;
-- a reception's detail as posted: select meganet.reception_detail(d) from day d;
```

## What it costs

At October 2026's traffic a day of receptions is a few MB gzipped and a day of readings
well under one. R2 is about US$0.015 a GB-month past its free 10 GB, and reading out of
it is free.
