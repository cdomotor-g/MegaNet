# db/

The MegaNet datastore's schema, as plain SQL.

Postgres, hosted on Supabase. Why that and not something else is in
[`docs/datastore-decision.md`](../docs/datastore-decision.md) — read it before
proposing a change, not after.

Everything the database is, is in `migrations/`. There is no ORM, no migration
framework and no `npm`: this repo has no build step and would gain nothing from
one. A migration is a numbered `.sql` file that a human can read, and apply with
`psql`, without installing anything first.

## Applying

The connection string is in the Supabase dashboard under **Project Settings →
Database → Connection string**. It contains the database password, so it lives in
your shell, never in this repo:

```sh
export MEGANET_DB_URL='postgresql://postgres.<ref>:<password>@<host>:5432/postgres'

psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
     -f db/migrations/0001_init.sql
```

`--single-transaction` is the point of that invocation: a migration either lands
whole or not at all. The files themselves carry no `begin`/`commit` so they also
work under tooling that has already opened a transaction of its own.

Applying in order, from nothing, gets you the current schema:

```sh
for f in db/migrations/*.sql; do
  psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction -f "$f" || break
done
```

Every migration is written to be idempotent, so re-running one that has already
landed is a no-op rather than an error. Pasting the file into the dashboard's SQL
editor works too, and is the path of least resistance for a one-off — but the
file in this repo stays the source of truth either way.

## Rules

These are short because they are absolute. Each one exists because the failure it
prevents is expensive and quiet.

**No table without RLS, in the same file.** Every `create table` is followed by
`alter table … enable row level security` and an explicit policy, in the same
migration. The anon key is committed in `app.js` and published to GitHub Pages;
it identifies the project and authorises nothing. A table with RLS off, reachable
with that key, is the whole database on the open internet. *No migration merges
that creates a table without enabling RLS in the same file.*

Note that Supabase's own `public.rls_auto_enable` event trigger — which enables
RLS automatically on new tables — only covers the `public` schema. Ours is
`meganet`. Nothing catches this for us.

**Grants are as narrow as the app needs, and named per table.** RLS decides which
*rows* a role sees; grants decide whether it can see the table at all. There is
deliberately no `alter default privileges` for the `meganet` schema, because a
blanket default hands `anon` the *next* table the moment it is created — exactly
the accident the rule above exists to prevent.

**Forward-only.** Once a migration has been applied anywhere it is never edited,
only followed by the next number. There are no down migrations: undoing something
is a new numbered file that says what it undoes.

**The schema version is part of the migration.** Every migration ends by writing
its own number into `meganet.app_meta`:

```sql
insert into meganet.app_meta (key, value)
values ('schema_version', '2')
on conflict (key) do update set value = excluded.value;
```

and bumps `DB_SCHEMA_VERSION` in `app.js` in the same commit. The app compares the
two on connect and says "database is v1, this app expects v2" rather than
half-working against a shape it does not understand.

**Exposed schemas live here, not in the dashboard.** `meganet` is not exposed to
the Data API by default; `0001_init.sql` adds it by setting `pgrst.db_schemas` on
the `authenticator` role. Doing it that way takes the list out of the dashboard's
hands — **Settings → Data API → Exposed schemas** stops managing it — which is the
trade we want: one more thing that lives in a migration instead of in a text box
somebody has to remember to edit. A future schema gets added the same way. If you
ever drop a schema, remove it from that list *first*, or PostgREST fails to build
its cache at all (`PGRST002`).

## What is in there now

| Object | What it is |
| --- | --- |
| `meganet` | The schema. Everything MegaNet owns lives here, not in `public`. |
| `meganet.touch_updated_at()` | `BEFORE UPDATE` trigger function stamping `updated_at`. Every table with that column hangs it off this one. |
| `meganet.app_meta` | Key/value facts about the database itself. `schema_version` is the number of the highest migration applied. Readable by anyone, writable by no one holding the anon key. |
| `meganet.station` | One row per station, 3,174 of them. `id` is the `stations.json` slug — also the app's `selectedId`, and in URLs. |
| `meganet.sensor` | 8,815 rows. Natural key `(station_id, sensor_id, type)`: one SSR carries several measurements. Indexed on `alert_id`, which is what the search box matches. |
| `meganet.repeater` | Repeater detail for the 88 stations carrying the role. One-to-one with `station`. |
| `meganet.pass_range` | The ALERT ranges a repeater passes or excludes, as rows with an `int4range` and a GiST index — so "which repeaters cover address N" is a lookup, not 88 × 10 ranges walked in JavaScript. |
| `meganet.radio_network`, `meganet.catchment`, `meganet.rm_system` | The reference vocabularies from the top of `stations.json`. |
| `meganet.doc_meta` | The document's `meta` header. Exactly one row, enforced. |
| `meganet.stations_json` | View: the whole `stations.json` document, rebuilt. `security_invoker`, so RLS on the base tables applies. |
| `meganet.stations_doc()` | The same document as a `stable` function, so `GET /rest/v1/rpc/stations_doc` returns it as the response body rather than wrapped in `{"doc": …}`. This is what the app calls. |

Everything is readable by `anon` and writable by nobody holding the anon key —
there is deliberately no insert/update/delete policy on any of it. The write path
is a later ticket, and it lands after the access gate, not before it.

### Two conventions worth knowing before you read the SQL

**`ord` columns.** Every table whose rows become a JSON *array* carries one. The
arrays in `stations.json` are in no natural order — stations are not sorted by
id, sensors are not sorted by `sensor_id`, pass ranges are not sorted by `low` —
so reproducing the document exactly means recording the order rather than
inventing one. `ord` is presentation order, never identity.

**`numeric`, not `double precision`.** A JSON number round-tripped through a
float comes back as `151.49999999999997`, or as `109.0` where the file said
`109`. `numeric` preserves the literal digit for digit. Nothing here does
arithmetic in the database, so the usual reason to prefer float does not apply.

### Loading the station list

`tools/import_stations_json.py` emits SQL that syncs the schema to
`stations.json` — upserting every row in the file and deleting every row that is
not in it. It is idempotent down to `updated_at`: a second run over the same file
changes nothing and restamps nothing.

```sh
python3 tools/import_stations_json.py \
  | psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction
```

Then check that what comes back out is what went in:

```sh
psql "$MEGANET_DB_URL" -tAc 'select doc from meganet.stations_json' > /tmp/doc.json
python3 tools/check_stations_doc.py /tmp/doc.json
```

That check is the one that matters. The whole read path rests on the database's
document being indistinguishable from the file, because ~17,700 lines of `app.js`
assume that shape.

## Checking it from outside

The Export tab's **Data source** panel does exactly this on first open, and shows
the result — along with which source the station list on screen actually came
from, which is a different question and can have a different answer. By hand:

```sh
curl -sS 'https://<ref>.supabase.co/rest/v1/app_meta?select=key,value' \
     -H 'apikey: <publishable key>' \
     -H 'Accept-Profile: meganet'

# and the station list itself, exactly as the browser fetches it
curl -sS 'https://<ref>.supabase.co/rest/v1/rpc/stations_doc' \
     -H 'apikey: <publishable key>' \
     -H 'Accept-Profile: meganet' > /tmp/doc.json
python3 tools/check_stations_doc.py /tmp/doc.json
```

`Accept-Profile` is not optional — without it PostgREST looks in `public`, finds
nothing, and says the table does not exist. Writes, when there are any, use
`Content-Profile` instead.
