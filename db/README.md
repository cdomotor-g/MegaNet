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

**A function that writes has its EXECUTE revoked from `public`, in the same
file.** Postgres grants EXECUTE on every new function to `PUBLIC` by default,
which is the same shape of quiet, expensive mistake as a table created without
RLS — and there is no event trigger watching for this one either. Any function
that changes data is followed by `revoke all on function … from public` and an
explicit grant to the roles that should have it.

**Forward-only.** Once a migration has been applied anywhere it is never edited,
only followed by the next number. There are no down migrations: undoing something
is a new numbered file that says what it undoes.

**One exception to "everything lives in `meganet`", and it is load-bearing.**
`0005_auth.sql` puts two triggers on `auth.users`, a table Supabase owns. That is
the only way to catch a signup, because `POST /auth/v1/otp` never touches the
Data API and so nothing inside our own schema is downstream of it. Two things
follow, and both bite quietly:

- **A trigger that errors blocks every signup, including from the dashboard.**
  `meganet.auth_user_gate()` raises on purpose for an unlisted address; if it ever
  raises for an *unintended* reason — the `meganet` schema missing, a botched
  half-apply — nobody can be created at all. The recovery is to drop the trigger
  (`drop trigger meganet_auth_user_gate on auth.users;`), fix the cause, and
  re-apply 0005.
- **Supabase upgrades own that table.** A future change to `auth.users` can drop
  or break these triggers without warning. If sign-in silently starts letting
  anyone in, check that both triggers still exist before looking anywhere else:

  ```sql
  select tgname from pg_trigger
   where tgrelid = 'auth.users'::regclass and not tgisinternal;
  ```

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
| `meganet.station` | One row per station, 3,174 of them. `id` is the `stations.json` slug — also the app's `selectedId`, and in URLs. `deleted_at` is the soft delete: null means live. |
| `meganet.sensor` | 8,815 rows. Natural key `(station_id, sensor_id, type)`: one SSR carries several measurements. Indexed on `alert_id`, which is what the search box matches. |
| `meganet.repeater` | Repeater detail for the 88 stations carrying the role. One-to-one with `station`. |
| `meganet.pass_range` | The ALERT ranges a repeater passes or excludes, as rows with an `int4range` and a GiST index — so "which repeaters cover address N" is a lookup, not 88 × 10 ranges walked in JavaScript. |
| `meganet.radio_network`, `meganet.catchment`, `meganet.rm_system` | The reference vocabularies from the top of `stations.json`. |
| `meganet.doc_meta` | The document's `meta` header. Exactly one row, enforced. |
| `meganet.station_json` | View: one row per *live* station — its id, its `ord`, its `updated_at`, and its `stations.json` fragment. Deleted stations are filtered out here, which is what makes the soft delete work everywhere at once. |
| `meganet.stations_json` | View: the whole `stations.json` document, rebuilt — the reference lists plus an aggregate of the view above. `security_invoker`, so RLS on the base tables applies. |
| `meganet.stations_doc()` | The same document as a `stable` function, so `GET /rest/v1/rpc/stations_doc` returns it as the response body rather than wrapped in `{"doc": …}`. This is what the app calls. |
| `meganet.load_stations_doc(jsonb)` | The reverse: makes the tables match a document. Idempotent. `EXECUTE` revoked from `public`. |
| `meganet.load_stations_from_url(text)` | Fetches `stations.json` over HTTP and hands it to the above. Defaults to the copy on `main`. Needs the `http` extension; says so plainly if it is missing. |
| `meganet.save_station(jsonb, timestamptz)` | The write path. One station and everything hanging off it, in one transaction. Refuses a stale write. Returns the saved fragment and its new `updated_at`. |
| `meganet.delete_station(text, timestamptz)` | Soft delete: stamps `deleted_at`, keeps every row. |
| `meganet.editor_allow` | Who may write — an email, or a domain with its at-sign. No policy and no grant to any role a browser can reach; readable only through the function below. |
| `meganet.is_editor()`, `meganet.email_allowed(text)`, `meganet.actor()` | The gate, the list lookup behind it, and who a write gets attributed to. |
| `meganet.app_user` | One row per person who has signed in, provisioned by trigger from `auth.users`. Carries a `role` column that nothing reads yet. You can select your own row and nobody else's. |
| `meganet.auth_user_gate()` | `BEFORE INSERT` on `auth.users`: refuses an address that is not on `editor_allow`, so an unlisted person never becomes a user at all. |
| `meganet.auth_user_sync()` | `AFTER INSERT/UPDATE` on `auth.users`: keeps `app_user` in step. Never writes `role`. |
| `meganet.email_may_sign_in(text)` | Yes/no for one address, callable anonymously so the sign-in panel can refuse before emailing. Deliberately an oracle — see `docs/access.md`. |
| `meganet.whoami()` | Identity and write permission as the database sees them. What the app shows in the header and the Data source panel. |
| `meganet.reading` | Every field-station reading. `addr` is the identity and the primary key is the deduplication — see **Telemetry**, below. |
| `meganet.reading_raw` | One row per `ingest()` call, holding the payload exactly as submitted. Ages out in 30 days. **The one table `anon` cannot read.** |
| `meganet.reading_hourly`, `meganet.reading_daily` | The rollups, kept forever. Sums rather than means, so a day re-aggregates from its hours exactly — and goes on being right after the readings are gone. |
| `meganet.ingest_source`, `meganet.protocol`, `meganet.quality`, `meganet.unit` | The four vocabularies a reading is validated against. A new transport or protocol is an `insert` here, not a migration. |
| `meganet.ingest(jsonb)` | The one way in. A batch, validated per row, deduplicated, partially accepted. `EXECUTE` revoked from `public` and never granted to `anon`. |
| `meganet.resolve_station(int, text)` | Which station is this address, when exactly one answer exists? Null otherwise. |
| `meganet.resolve_readings(int)` | The backfill: fill `station_id` on readings whose address has since become unambiguous. |
| `meganet.roll_up(timestamptz)` | Rebuild the rollups for every bucket touched since the watermark. Idempotent. |
| `meganet.retain(int)` | Roll up, then age out. The one retention job. |
| `meganet.as_ts()`, `meganet.as_num()`, `meganet.code_for()` | `ingest()`'s validators, split out so "be liberal in what you accept" is written once and a bad field produces a sentence rather than a cast error. |
| `meganet.ingest_token` | Per-device credentials for the HTTP ingest endpoint (#B5). Only `token_hash` is stored. RLS on, no policy — reachable with the service key or a direct connection, same trade as `editor_allow`. |
| `meganet.create_ingest_token(text, text, int, int)` | Mints a device token and returns it once. `EXECUTE` revoked from `public`, granted only to `service_role`. |
| `meganet.ingest_http(jsonb)` | The HTTP endpoint — `POST /rest/v1/rpc/ingest_http`. Checks `X-Ingest-Token` against `ingest_token`, then hands the batch to `ingest()`. The only function `anon` is granted here. |

Everything is readable by `anon` **except `meganet.reading_raw`**, which holds
whatever a device or an adapter actually sent, unread — a debugging artefact
rather than a publication, and the day an adapter puts a header or a device key
in its payload is the day the difference matters. Editors and `service_role` can
read it.

Nothing is *writable* by `anon` or by `authenticated`: no table grants either of
them a write verb, and the only ways in are the functions above — see **Writing**
and **Telemetry** below.

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

Two roads, same destination — both end at `meganet.load_stations_doc()`, both are
a *sync* rather than an append (every row in the document upserted, every row not
in it deleted), and both are idempotent down to `updated_at`: a second run over
the same document changes nothing and restamps nothing.

**From the SQL editor, with nothing installed.** The database fetches
`stations.json` from the repo itself, so the 3.5 MB never goes near a browser:

```sql
select meganet.load_stations_from_url();
```

That needs the `http` extension. If it is not enabled the function says so and
gives you the line that fixes it:

```sql
create extension if not exists http with schema extensions;
```

**From a workstation with the repo.** `tools/import_stations_json.py` emits the
same sync as plain SQL — no database connection of its own, so you can read it
before you run it. This is also the path for a database that cannot reach
`raw.githubusercontent.com`, which is the one inside the corporate network:

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

## Writing

Added by `0004_station_writes.sql`, for the station editor. Four things about it
are worth knowing before touching any of it.

**There are exactly two ways in, and they are functions.** `save_station()` and
`delete_station()`. No table grants `anon` or `authenticated` an insert, update or
delete, so there is no `PATCH /station?id=eq.x` to be had. That is deliberate: a
station is a row *plus* its sensors *plus* its repeater *plus* that repeater's
pass ranges, and a repeater whose ranges half-saved is worse than one that did not
save at all. One function call is one transaction.

**A stale write is refused, never merged.** Every call carries the `updated_at`
the editor loaded the station with, and the function rejects it if the row has
moved since:

```sql
select meganet.save_station(
         '{"id":"my_station","name":"…","roles":["field"]}'::jsonb,
         '2026-08-11T02:31:07.221Z'::timestamptz);
```

Omit that second argument and an *existing* station is refused too — an editor
that cannot say which version it started from has no business overwriting one. A
new station is the opposite: it must be omitted, because there is nothing to have
started from. The refusal carries SQLSTATE `PT409`, which PostgREST returns as
HTTP 409, so the app can tell "somebody got there first" from "the network is
down" without reading the message.

**Delete is soft, and undone with one line.**

```sql
update meganet.station set deleted_at = null where id = 'the_station';
```

The row, its sensors, its repeater and its ranges are all still there —
`meganet.station_json` simply stops carrying it. Note that a *full reload* is a
sync, so loading a document that no longer mentions a soft-deleted station
removes it for real; take a snapshot before reloading if that matters.

**Who may write is the database's decision, not the browser's.** `is_editor()`
answers it: never for `anon`, always for `service_role`, and for `authenticated`
only when the verified email on the request's token matches
`meganet.editor_allow`. `updated_by` is stamped from the same token, server-side —
a field the client fills in is a field the client can forge. The sign-in that
mints that token shipped in `0005_auth.sql` — see **Signing in**, below.

Maintaining the list needs the service key, or psql:

```sql
insert into meganet.editor_allow (entry, note)
values ('contractor@example.org', 'Bruce, until the Mitchell survey is done');
```

### Proving it is refused

The claim that matters is that a browser holding only the anon key cannot write.
Ask it directly — no token, and then a made-up one:

```sh
curl -sS -X POST 'https://<ref>.supabase.co/rest/v1/rpc/save_station' \
     -H 'apikey: <publishable key>' \
     -H 'Content-Profile: meganet' -H 'Content-Type: application/json' \
     -d '{"p_doc":{"id":"probe","name":"Probe","roles":[]}}' -w '\n%{http_code}\n'
```

`anon` holds no `EXECUTE` on either function, so PostgREST answers 404 — "no such
function", which is what it looks like from outside to a caller who may not run
it. A valid session for an address that is not on the list gets 403 and the
message `not authorised to write to the station list`. Either way the station is
not there afterwards:

```sh
curl -sS 'https://<ref>.supabase.co/rest/v1/station?id=eq.probe&select=id' \
     -H 'apikey: <publishable key>' -H 'Accept-Profile: meganet'   # => []
```

The same checks against a local Postgres, where `set local role` stands in for
what PostgREST does per request:

```sql
begin; set local role anon;
  select meganet.save_station('{"id":"probe","name":"Probe","roles":[]}'::jsonb);
rollback;   -- ERROR: permission denied for function save_station

begin; set local role authenticated;
  set local request.jwt.claims = '{"role":"authenticated","email":"someone@gmail.com"}';
  select meganet.save_station('{"id":"probe","name":"Probe","roles":[]}'::jsonb);
rollback;   -- ERROR: not authorised to write to the station list
```

### Keeping stations.json honest

The file in this repo is a copy now, and a copy nobody refreshes becomes a lie.
It is refreshed on a schedule rather than annotated as a dated snapshot —
`.github/workflows/stations-snapshot.yml` runs `tools/snapshot_stations_json.py`
weekly and opens a pull request when the document has moved. By hand:

```sh
python3 tools/snapshot_stations_json.py           # fetch and write stations.json
python3 tools/snapshot_stations_json.py --check   # exit 1 if it would change
```

The Export tab has the same thing as a button, for the operator who wants a copy
before going somewhere without a network.

## Signing in

Added by `0005_auth.sql`. The operational side — how to add a domain, add a
person, or recover when nobody can get in — is `docs/access.md`; what follows is
only the part that lives in the database.

**An unlisted address never becomes a user.** `meganet.auth_user_gate()` is a
`BEFORE INSERT` trigger on `auth.users`, so the refusal happens at the one point
downstream of every route in — including `POST /auth/v1/otp` called directly with
`curl`, which never touches the Data API and so could never have been caught by
anything in the `meganet` schema alone.

GoTrue does not pass the trigger's message back to the browser; the caller gets a
generic "Database error saving new user". That is why the app pre-checks with
`meganet.email_may_sign_in()` and carries its own wording. Do not spend effort
making that `raise exception` message prettier — nobody sees it but you, in the
logs, which is where it is aimed.

**There is no `allowed_domains` table.** #B8 sketched one; `meganet.editor_allow`
had already shipped in 0004 and answers the same question with one column holding
either a whole address or a domain with its at-sign. Two allowlists would be two
places to remove somebody from, and the failure mode of that is somebody being
removed from only one of them.

**`app_user.role` is recorded and enforces nothing.** Everyone is provisioned
`editor`. `is_editor()` asks `editor_allow`, not this column, so setting somebody
to `viewer` today does not stop them writing. The column exists now because
adding it early costs one line and retrofitting identity onto rows that were
written anonymously costs a migration and a guess.

Checking the gate the same way as the write path — `set local role` standing in
for what PostgREST does per request:

```sql
begin; set local role authenticated;
  set local request.jwt.claims = '{"role":"authenticated","email":"someone@bom.gov.au"}';
  select meganet.whoami();     -- may_write true
rollback;

begin; set local role authenticated;
  set local request.jwt.claims = '{"role":"authenticated","email":"someone@gmail.com"}';
  select meganet.whoami();     -- may_write false
rollback;

begin; set local role anon;
  select meganet.whoami();     -- signed_in false, may_write false, no error
rollback;
```

That last one is option (a) in three lines: anonymous is a state the database
answers politely, not one it errors at.

## Telemetry

Added by `0006_telemetry.sql`. Four tables, four vocabularies and one entry point.
The operational half — what a reading is, what retention costs — is in the main
[`README.md`](../README.md#field-station-telemetry); what follows is the part that
only matters if you are reading or changing the SQL.

**There is exactly one write path, and it is `meganet.ingest(jsonb)`.** Same
reasoning as `save_station()`: HTTP POST, MQTT, backfill and manual entry are four
adapters, and four adapters each doing their own validation is four subtly
different ideas about what a timestamp is. It is a plain Postgres function rather
than an Edge Function so that it travels with a `pg_dump`.

```sql
select meganet.ingest('[{"alert_id": 6128, "reading_ts": "2026-08-12T04:15:00Z",
                         "value_raw": 12, "source": "manual"}]'::jsonb);
```

An array, an object with a `readings` array, or a single reading object are all
accepted. Envelope keys — `source`, `protocol`, `path`, `received_at`, `keep_raw`
— are defaults that any row may override, so one batch can carry a mixed archive.

**A bad row and a bad envelope get different answers, on purpose.** A row that
fails validation comes back as `{"i": 4, "why": "…"}` with the rest of the batch
stored — a station sending one bad reading must not cost the other 287. A payload
that is not a readings array at all raises SQLSTATE `22023`, which PostgREST
returns as HTTP 400, because that is the caller misunderstanding the contract.

**`addr` is generated, and it is the identity.** `a:6128` for an ALERT address;
`s:541155/level` for a satellite or cellular station, which has no ALERT address
and reports under its station number with a channel naming the sensor. It is a
stored generated column rather than something the caller supplies so that it
cannot disagree with the columns it is built from, and the primary key
`(addr, reading_ts, value_raw)` hangs off it. That key **is** the deduplication:
`insert … on conflict do nothing`, and the copy that lost bumps `dup_count` and
appends its path to `dup_paths`.

A station that transmits both ways has two addresses, and they do not deduplicate
against each other. That is correct — they are two transmissions — and it is the
thing `path` and `dup_count` exist to make visible.

**`station_id` is never taken from the payload.** It is resolved by
`meganet.resolve_station()`, which answers only when exactly one live station
carries the address. 604 of 5,122 ALERT addresses are shared; guessing between
them would invent a fact. There is deliberately no foreign key on the column
either: a reading from a station MegaNet has not been told about yet is precisely
the reading that must not be dropped.

**`value_raw` is `numeric`, not the `int` #75 sketched.** A satellite or cellular
station has no counts to send and posts an engineering value directly; an integer
column would mean either losing the decimals or inventing a scale factor. An ALERT
count stored as numeric is still exactly that count, and `numeric` equality is
what makes `1.0` and `1.00` deduplicate.

**Rollups store sums, not means.** A mean cannot be re-aggregated — averaging
twelve hourly means gives the wrong day whenever the hours have different counts —
so `raw_mean` is a generated column over `raw_sum / n`, the day is built from the
hours, and the daily rollup stays exact after the readings behind it are deleted.

**`roll_up()` will not touch a bucket past the retention horizon.** Recomputing a
bucket whose readings have been half-deleted would overwrite a rollup that was
correct when it was made. It reports how many it skipped. A backfill older than
the window still lands in `meganet.reading` and is queryable until the next
`retain()`; it just does not rewrite history it can no longer see whole.

**Indexes, because they are a real fraction of the free tier.** The primary key
covers `(addr, reading_ts)`. `received_at` and `reading_ts` get BRIN indexes —
both are effectively insert-ordered, and both are only ever used for the whole-
range scans `roll_up()` and `retain()` do, so BRIN is kilobytes where a btree
would be tens of megabytes. Two partial btrees finish it: `(station_id,
reading_ts)` for "what did that site report last night", and one over the
unresolved rows for the backfill, which is tiny by construction because resolving
a row removes it from the index.

**Who may call it.** `meganet.is_editor()` — the same allowlist as the station
editor, deliberately, because the README already argues against two lists to
remove somebody from. `anon` holds no `EXECUTE`: a grant there would make a table
heading for millions of rows writable by anyone holding a key that is committed to
a public repo. `ingest_http()`, added by `0007_ingest_http.sql`, is the one
narrow exception — see below.

### Proving it

```sh
psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_ingest.sql
```

48 checks, one per line of #75's acceptance, in a transaction that rolls back — so
it is safe against the live database, including the rollups and the retention
watermark it moves. It prints a row per check and exits non-zero if any fail,
which makes it usable from a workflow as well as by hand.

Run it after applying `0006`, and again after touching anything in it.

## HTTP ingest

Added by `0007_ingest_http.sql`. A field station posts its own readings without
holding an editor session — the operational side, with a working `curl` and how
to mint and revoke a token, is [`docs/ingest-http.md`](../docs/ingest-http.md);
what follows is only the part that lives in the database.

**`POST /rest/v1/rpc/ingest_http`, not `/rest/v1/rpc/ingest`.** `ingest()` stays
exactly as `0006` left it — `anon` holds no `EXECUTE` on it, ever.
`ingest_http()` is a separate, narrower door: it is the only function this
migration grants to `anon`, and calling it does not hand out any other
capability. It checks a device token, then makes the one `ingest()` call the
token authorised.

**Not `Authorization: Bearer`.** PostgREST verifies that header as a JWT and
answers 401 for anything that fails to parse as one — before a request ever
reaches Postgres. A per-device opaque token sent that way would be refused
unconditionally, valid or not, and there is no Edge Function in front to
intercept it (same choice `0006` already made for `ingest()`). The token travels
in `X-Ingest-Token` instead, a plain header PostgREST passes straight through.

**The token is checked in SQL, not by switching Postgres role.** A literal
per-device role needs PostgREST to `SET ROLE` from a JWT's `role` claim, and
minting real per-device JWTs means holding this project's JWT secret in the
database — a bigger and riskier thing than this ticket's effort budget. Instead,
`ingest_http()` checks the token against `meganet.ingest_token` and, only if it
is live, sets a transaction-local flag (`meganet.ingest_authorized`) that
`meganet.is_editor()` now also accepts from `anon`. Nothing else can set that
flag — it is set inside a `security definer` function `anon` has no other way
to reach into — and it cannot outlive the request, because PostgREST runs each
call in its own transaction. The practical result is the same as a scoped role:
a device token opens exactly one door and nothing selectable behind it.

**Only the hash is stored.** `meganet.create_ingest_token()` generates the
token from `gen_random_uuid()` (core since PostgreSQL 13, drawn from the OS's
CSPRNG), stores `sha256(token)` hex-encoded, and returns the plaintext exactly
once. There is no second copy anywhere; a lost token is a new one, not a lookup.

**Revoking is one `update`, and takes effect on the very next call** —
`ingest_http()` checks `revoked_at` fresh every time, so there is no cache or
token lifetime to wait out:

```sql
update meganet.ingest_token set revoked_at = now() where label = 'Mount Stuart logger';
```

**`station_id` and the ALERT range are recorded, not enforced.** Same trade
`0005_auth.sql` made with `app_user.role`: a token minted today already carries
whichever station or address range its logger is for, so enforcing it later is
an `update` to `ingest_http()`, not a migration that touches a device in the
field.

**Batch size is capped at 1,000** readings per call, returned as a clear `22023`
(HTTP 400) rather than a request that times out instead.

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
