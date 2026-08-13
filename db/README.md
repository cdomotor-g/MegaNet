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
| `meganet.station_status` | What the broker last said about each station: its retained status, and the LWT published when its connection drops (#B6). Keyed by the topic segment, not `station.id`. |
| `meganet.station_health` | View: `station_status` plus the minutes since each station last spoke and last sent a reading. Applies no staleness threshold — the caller picks, per station. `security_invoker`. |
| `meganet.bridge_health` | One row per running MQTT bridge. Exists so "no readings since Tuesday" can be told apart from "the relay died on Tuesday". |
| `meganet.ingest_token_id()` | The `X-Ingest-Token` check `0007` does inline, factored out for `0008`'s endpoints. Raises PT401. Not granted to `anon` — directly reachable it would be a guessing oracle. |
| `meganet.mqtt_status(jsonb)`, `meganet.mqtt_seen(text, timestamptz)`, `meganet.bridge_heartbeat(jsonb)` | What the bridge reports that is not a reading: a station's status or LWT, when its reading last arrived, and the bridge's own pulse. Token-checked, like `ingest_http()`. |
| `meganet.rain_instrument_type`, `meganet.condition_rating`, `meganet.asset_owner`, `meganet.wl_instrument_type`, `meganet.comms_method`, `meganet.comms_equipment`, `meganet.power_supply`, `meganet.yes_no`, `meganet.data_quality_rating`, `meganet.council` | The ten pick-lists on the inspection workbook's `Dropdown` sheet, labels transcribed verbatim. What #116's and #117's form dropdowns read from. |
| `meganet.equipment_kind`, `meganet.attachment_role`, `meganet.calibration_kind` | Three more vocabularies the forms need that the `Dropdown` sheet does not carry — read off the Serial Numbers panels, the photo checklists and the calibration grids instead. |
| `meganet.inspection_config`, `meganet.inspection_section`, `meganet.inspection_config_section` | The form, as data: six configurations, fourteen sections, and which configuration prints which. **A section absent from the matrix is a section that form does not have** — a different fact from a section table with no row. |
| `meganet.inspection` | One station visit. The details panel and the remarks; every banner-headed block hangs off it. |
| `meganet.inspection_serial`, `meganet.inspection_data`, `meganet.inspection_data_value`, `meganet.inspection_power`, `meganet.inspection_rain_gauge`, `meganet.inspection_water_level`, `meganet.inspection_gas`, `meganet.inspection_radio`, `meganet.inspection_fade_margin`, `meganet.inspection_calibration`, `meganet.inspection_data_quality`, `meganet.inspection_admin` | The sections. Each carries a trigger refusing a row whose configuration's form does not print that section. |
| `meganet.maintenance_activity`, `meganet.maintenance_asset`, `meganet.maintenance_data_quality` | The Council Site Maintenance Tasks form. `inspection_id` is the printed cross-reference at the foot of every inspection sheet, as a foreign key. |
| `meganet.attachment` | Photos and pasted screenshots, for an inspection or a maintenance activity — exactly one of the two. The bytes are in Supabase Storage; this is the index. |
| `meganet.inspection_form` | View: one row per section a configuration prints, in that configuration's order. What a form renderer asks. |
| `meganet.inspection_needs_maintenance` | View: visits that departed Missing or Poor, and whether a maintenance activity was ever raised against them. |
| `meganet.inspection_doc(uuid)`, `meganet.maintenance_activity_doc(uuid)` | One record and everything under it, as one JSON document. |
| `meganet.save_inspection(jsonb, timestamptz)`, `meganet.save_maintenance_activity(jsonb, timestamptz)` | The write paths. One call is one transaction; children are replaced, not merged; a stale write is refused with `PT409`. |
| `meganet.delete_inspection(uuid, timestamptz)`, `meganet.delete_maintenance_activity(uuid, timestamptz)` | Soft delete, as for stations. |
| `meganet.form_write(text, jsonb)` | Internal: inserts one section row from a JSON object, over a closed table list, skipping generated columns. Granted to nothing a browser can reach. |

Everything is readable by `anon` **except `meganet.reading_raw` and the whole
inspection domain**. `reading_raw` holds whatever a device or an adapter actually
sent, unread — a debugging artefact rather than a publication, and the day an
adapter puts a header or a device key in its payload is the day the difference
matters. The inspection tables are withheld for a different reason: the Council
form carries landowner names, emails and phone numbers, and inspection remarks
carry site access notes. Editors and `service_role` can read both. The inspection
domain's *vocabularies* — the pick-lists and the form matrix — are public, because
they are the words printed on a blank form and say nothing about a site.

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

## MQTT ingest

Added by `0008_mqtt_bridge.sql`. The topic scheme, the broker choice and how a
logger publishes are [`docs/ingest-mqtt.md`](../docs/ingest-mqtt.md); running the
subscriber is [`bridge/README.md`](../bridge/README.md). What follows is only the
database's share.

**No new write path for readings.** Postgres cannot subscribe to MQTT, so there
is a process — `bridge/` — that holds the subscription and posts what it receives
to `ingest_http()`, exactly as an HTTP logger does. It holds an ordinary
`meganet.ingest_token` and no service key: three RPCs, and `revoked_at` turns all
three off at once. The bridge is not more trusted than the loggers it relays for.

**`meganet.station_status` is keyed by the topic segment, not `station.id`.**
Same reasoning as `reading.station_id` having no foreign key: a station that
starts publishing before MegaNet has been told about it is exactly the one whose
silence matters, and a foreign key would refuse to record it. `station_id` is
resolved where the key names a live station and left null where it does not.

**`online` is what the broker last said; staleness is computed, not stored.** The
LWT says a station's connection dropped, which is not the same as a station
having stopped reporting — a logger that publishes hourly is offline between
transmissions and perfectly well. So the column records the last thing the broker
told us, `since` moves only on a real state change (a retained message replayed
on every reconnect must not reset "down since 03:14"), and
`meganet.station_health` exposes the minutes since each station last spoke
without picking a threshold. Every station's reporting interval is different; a
constant here would be wrong for most of the network and invisible when it was.

**`meganet.bridge_health` exists so two silences can be told apart.** "No
readings since Tuesday" and "the relay died on Tuesday" look identical from the
front end and need different people out of bed. Counters are absolute totals
since the bridge started, never increments, so a lost heartbeat costs nothing.

**Both tables are world-readable** — #B7 will read them with the publishable key,
the same trade `0002` made for the station list — and the corollary is a rule the
bridge keeps: `detail` carries a short reason string, never a URL, token or
connection string.

**`meganet.ingest_token_id()` is the token check `0007` does inline, factored
out** so the three new endpoints share it rather than growing three opinions
about what a valid token is. It is *not* granted to `anon`: reachable directly,
it would be an oracle for guessing tokens one call at a time. The functions that
call it are `security definer`.

```sh
psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_mqtt.sql
```

39 checks, one per line of #B6's acceptance that can be answered in SQL, in a
transaction that rolls back. The half that cannot — reconnects, acknowledgement,
no message lost — is `bridge/test/integration.test.js`, which runs a real broker
against the real client with a database that fails on demand.

## Station inspections and maintenance activities

Added by `0009_inspections.sql`. The paper forms in
`archive/Inspection sheets for printing.xlsx` — six station-inspection sheets and
one Council Site Maintenance Tasks sheet — as tables. Epic #78 builds the form
that writes them going forward; epic #122 backfills ~35 years of the same sheets
out of a second workbook. Both write through here.

**There is one form, not six.** `Alert`, `Campbell DataLogger`, `Mace`,
`Gas Only`, `Base Station` and `DataLogger - old` are one family with sections
added, removed or reworded per station configuration — the workbook's own `Index`
sheet says form identity follows the station's telemetry type. So there is one
`meganet.inspection` and one set of section tables.

**"Does not apply" is a row, not a null.** This is the decision the rest hangs
off. `meganet.inspection_config_section` records which sections each
configuration's form actually prints, so a missing row in a section table means
*not recorded* and a missing row in the matrix means *not on this form*. A trigger
on every section table refuses the second case:

```sql
insert into meganet.inspection_gas (inspection_id, existing_cylinder_pressure_kpa)
values ('…a base-station inspection…', 12000);
-- ERROR: the base_station form has no gas section, so this inspection cannot carry one
```

The matrix was read off the six sheets cell by cell, and four entries came out
differently from a prose summary of the same workbook: `Mace` and
`DataLogger - old` print no Data Quality block and no photo checklist,
`DataLogger - old` has no radio section, and `Gas Only` has five sections in
total. Where the two disagree, the sheets win.

**Sixty-one column layouts collapse into one calibration table.** Every sheet
prints its calibration blocks differently, but all of them are the same seven
columns — expected, start, end, result, difference, error, passed.
`meganet.inspection_calibration` is that shape, keyed by `kind`, and
`meganet.calibration_kind` maps each kind to the section it prints under. That
mapping is also how the applicability guard works for a table whose section is a
property of its row rather than of the table.

**Two printed rules are computed rather than read.** "Calibration adjustment
should only be performed if the mean % error after 3 checks is greater than 6%"
is `meganet.inspection_rain_gauge.adjustment_indicated`, a generated column over a
per-visit threshold — per visit, because a threshold that changes must not
silently rewrite what past visits were judged against. The SWR legend beside the
antenna box ("<1.5 = Good  1.5 - 2.0 = Fair  >2.0 = Poor") is
`meganet.inspection_radio.swr_rating`.

**The cross-reference at the foot of every sheet is a foreign key.** Every
inspection form ends with *"sites on departure that are poor or have issues please
complete Flood Warning Council Maintenance Project form"*.
`meganet.maintenance_activity.inspection_id` is that sentence, and the view is the
list of times it was printed and not followed:

```sql
select station_name, inspected_on, parameter, on_departure_label
  from meganet.inspection_needs_maintenance
 where not has_maintenance_activity
 order by inspected_on desc;
```

**Two ways in, and they are functions** — same reasoning as `save_station()`. A
visit is a parent plus up to eleven children, and one whose gas section saved and
whose calibration rows did not is worse than one that did not save at all. No
table grants a write verb to a role a browser can reach. Children are *replaced*
rather than merged, because the form holds the whole record on screen and a merge
makes "I deleted that row" unsayable. The stale-write contract is 0004's exactly:

```sql
select meganet.save_inspection(
         '{"station_id":"…","config_key":"alert","inspected_on":"2026-08-13"}'::jsonb);
-- returns the saved document, which is what meganet.inspection_doc() returns
```

`meganet.form_write()` is worth one look before you trust it: it builds an INSERT
with dynamic SQL so that adding a column to a section table does not mean editing
a save function. Its table list is closed, every identifier goes through
`quote_ident`, and it is granted to nothing — the save functions reach it as
`security definer`.

**Nothing here is readable with the anon key.** The anon key is committed to this
repo and served from GitHub Pages, so "readable by anon" means "published", and
this domain holds landowner contact details and site access notes. Editors only —
which is who fills the forms in. The vocabularies and the form matrix *are*
public: they are the words on a blank form.

### Proving it

```sh
psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_inspections.sql
```

71 checks, in a transaction that rolls back, so it is safe against the live
database. Ten of them compare a lookup table against the `Dropdown` sheet's
columns verbatim; eleven check the section matrix against what the six sheets
actually print; the rest exercise the guard, the two computed rules, a whole-visit
round trip, the PT409 refusals, and the grants — both halves, since a schema that
refuses the wrong things is as broken as one that permits them.

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
