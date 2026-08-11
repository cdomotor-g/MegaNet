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

No station data is in the database yet — that is a separate ticket. The app reads
`app_meta` and nothing else.

## Checking it from outside

The Export tab's **Data source** panel does exactly this on first open, and shows
the result. By hand:

```sh
curl -sS 'https://<ref>.supabase.co/rest/v1/app_meta?select=key,value' \
     -H 'apikey: <publishable key>' \
     -H 'Accept-Profile: meganet'
```

`Accept-Profile` is not optional — without it PostgREST looks in `public`, finds
nothing, and says the table does not exist. Writes, when there are any, use
`Content-Profile` instead.
