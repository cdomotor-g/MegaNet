-- 0002_stations.sql — the station list in Postgres, and the document the app reads.
--
-- Two jobs, and the second one is the reason the first is shaped the way it is.
--
--   1. Store the station list properly: normalised tables, real keys, real
--      indexes, so that "which repeaters cover ALERT address 6128" is a query
--      rather than a scan in JavaScript.
--   2. Hand the app back, unchanged, the exact JSON document it has always
--      parsed — `meganet.stations_doc()` returns a value structurally identical
--      to stations.json, key for key and element for element.
--
-- Why (2) matters: app.js is ~17,700 lines and every one of them below
-- loadJson() assumes that document's shape — s.roles, s.repeater.pass_ranges,
-- s.site.db_id, state.data.radio_networks. Exposing tables and rewriting the
-- app's data access would be a month of work and a regression in every tab.
-- Assembling the document in SQL costs this one file and touches nothing
-- downstream. The normalisation is real; the document is the API.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0002_stations.sql
--
-- Two conventions run through everything below.
--
-- `ord` — every table whose rows become a JSON *array* carries one. The arrays
-- in stations.json are not in any natural order (stations are not sorted by id,
-- sensors are not sorted by sensor_id, pass ranges are not sorted by low), so
-- reproducing the document exactly means recording the order rather than
-- inventing one. It also keeps the JSON export in #B3 free of churn: a re-export
-- of unchanged data produces a file that is diff-clean against the committed
-- one, instead of one whose every line has moved. `ord` is presentation order,
-- never identity — the primary keys below are natural ones.
--
-- `numeric`, not `double precision`, for every number that came out of the JSON.
-- A JSON number round-tripped through a float comes back as 151.49999999999997
-- or 109.0-where-the-file-said-109. numeric preserves the literal, digit for
-- digit, which is what makes the equivalence in tools/check_stations_doc.py an
-- exact match rather than an approximate one. Nothing here does arithmetic in
-- the database, so the usual reason to prefer float does not apply.

-- ── Reference lists ──────────────────────────────────────────────────────────
-- The three vocabularies from the top of stations.json. Small, slow-moving, and
-- pointed at by every station.

create table if not exists meganet.rm_system (
  id                integer     primary key,
  ord               integer     not null,
  name              text        not null,
  tx_power_w        numeric,
  line_loss_db      numeric,
  supp_loss_db_m    numeric,
  antenna_type      text,
  antenna_gain_dbi  numeric,
  antenna_height_m  numeric,
  rx_threshold_dbm  numeric,
  updated_at        timestamptz not null default now(),
  updated_by        text
);

comment on table meganet.rm_system is
  'Radio Mobile transmitter/receiver system presets. stations.json rm_systems[].';

create table if not exists meganet.radio_network (
  id          text        primary key,
  ord         integer     not null,
  name        text        not null,
  description text        not null default '',
  updated_at  timestamptz not null default now(),
  updated_by  text
);

comment on table meganet.radio_network is
  'BoM radio networks a station can belong to. stations.json radio_networks[].';

create table if not exists meganet.catchment (
  id          text        primary key,
  ord         integer     not null,
  name        text        not null,
  basin_no    text,
  area_sqkm   numeric,
  region      text,
  -- Present on exactly one row today ("QLD/NSW" on border_rivers). Nullable, and
  -- the view omits the key entirely when it is null, because that is what the
  -- file does.
  border      text,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

comment on table meganet.catchment is
  'Queensland drainage-basin vocabulary. stations.json catchments[].';

-- ── Document metadata ────────────────────────────────────────────────────────
-- stations.json's `meta` object. One row, enforced: the document has one header,
-- and a second row would silently pick a winner in the view.

create table if not exists meganet.doc_meta (
  only_row    boolean     primary key default true check (only_row),
  version     text        not null,
  description text        not null default '',
  updated     date,
  rm_paths    jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

comment on table meganet.doc_meta is
  'The stations.json `meta` header — version, description, Radio Mobile paths. Exactly one row.';

-- ── Stations ─────────────────────────────────────────────────────────────────
-- The id is the existing slug, kept deliberately: it is in URLs, in
-- state.selectedId, and in every cross-reference the app already holds. A
-- surrogate key here would buy nothing and break all of that.
--
-- Relational where it is queried or edited; jsonb for the long tail that is only
-- ever read and written whole:
--
--   site       ARRO's {db_id, number, name} — read as a unit to build ARRO links
--   satcom     {enabled, provider, terminal_id}
--   alert_ids  {rainfall, battery, water_level} — note that water_level is
--              sometimes an int and sometimes an array of them (4 stations
--              today). jsonb absorbs that; a column could not without either
--              lying about the shape or forcing a migration onto the app.
--
-- roles / radio_network_ids / catchment_ids / location_types are short arrays
-- that the filters read whole (stationRoleKeys and friends), so Postgres arrays
-- with GIN indexes beat join tables: fewer joins in the view, same query power.

create table if not exists meganet.station (
  id                text        primary key,
  ord               integer     not null,
  name              text        not null,
  station_number    text        not null default '',
  lat               numeric,
  lon               numeric,
  elevation_ahd     numeric,
  roles             text[]      not null default '{}',
  radio_network_ids text[]      not null default '{}',
  catchment_ids     text[]      not null default '{}',
  alert_ids         jsonb       not null default '{}'::jsonb,
  satcom            jsonb       not null default '{}'::jsonb,
  rm_system_id      integer     not null references meganet.rm_system (id),
  enabled           boolean     not null default true,
  notes             text        not null default '',
  -- The optional half. NULL means "the key is absent from the document", which
  -- is unambiguous here: no station in the file carries any of these as an empty
  -- string, empty array or null. The view omits each key when its column is null.
  legacy_unit_id    integer,
  site              jsonb,
  lga               text,
  basin             text,
  location_types    text[],
  updated_at        timestamptz not null default now(),
  updated_by        text
);

comment on table meganet.station is
  'One row per station. id is the stations.json slug, which is also the app''s selectedId and appears in URLs.';

comment on column meganet.station.ord is
  'Position in the stations[] array. Presentation order only — never identity.';

-- rm_system_id is a real foreign key; the array columns cannot be, because
-- Postgres has no per-element referential integrity. tools/import_stations_json.py
-- checks radio_network_ids and catchment_ids against the reference tables before
-- it emits anything, which is where that error is cheapest to catch anyway.
create index if not exists station_roles_idx      on meganet.station using gin (roles);
create index if not exists station_networks_idx   on meganet.station using gin (radio_network_ids);
create index if not exists station_catchments_idx on meganet.station using gin (catchment_ids);
create index if not exists station_name_idx       on meganet.station (lower(name));
create index if not exists station_number_idx     on meganet.station (station_number);

-- ── Sensors ──────────────────────────────────────────────────────────────────
-- 8,815 rows. The natural key is (station, sensor_id, type): one SSR carries
-- several measurements — "541155.0.R.6128" is both Rainfall and Rainfall
-- Increment — so sensor_id alone is not unique, and (station, type) is not
-- either (72 stations have two of a type).

create table if not exists meganet.sensor (
  station_id  text        not null references meganet.station (id) on delete cascade,
  sensor_id   text        not null,
  type        text        not null,
  ord         integer     not null,
  -- Null for the 927 sensors ARRO knows about that have no ALERT address, and
  -- for the 56 whose ARRO-internal device id was never resolved. The app already
  -- tolerates both.
  alert_id    integer,
  device_id   integer,
  updated_at  timestamptz not null default now(),
  updated_by  text,
  primary key (station_id, sensor_id, type)
);

comment on table meganet.sensor is
  'One row per sensor. stations.json stations[].sensors[].';

-- The search box matches a bare number against ALERT addresses, so this index is
-- the one that stops "6128" being a scan of 8,815 rows.
create index if not exists sensor_alert_id_idx on meganet.sensor (alert_id) where alert_id is not null;
create index if not exists sensor_station_idx  on meganet.sensor (station_id);
create index if not exists sensor_type_idx     on meganet.sensor (type);

-- ── Repeaters and their pass ranges ──────────────────────────────────────────
-- 88 repeaters. A repeater is a station, so this is a one-to-one extension
-- table keyed by the station rather than a table with its own identity.

create table if not exists meganet.repeater (
  station_id    text        primary key references meganet.station (id) on delete cascade,
  acma_licence  text        not null default '',
  rx_mhz        numeric,
  tx_mhz        numeric,
  notes         text        not null default '',
  updated_at    timestamptz not null default now(),
  updated_by    text
);

comment on table meganet.repeater is
  'Repeater detail for stations carrying the repeater role. stations.json stations[].repeater.';

-- Kept as rows rather than folded into the repeater's jsonb, because they are
-- queried: the pass-count shown on every repeater (#83) and the Pass Ranges tab
-- both ask "which repeaters cover address N". As rows with a range type and a
-- GiST index that is an index lookup; as JSONB it is 88 × ~10 ranges walked in
-- JavaScript on every render.
create table if not exists meganet.pass_range (
  repeater_id text        not null references meganet.repeater (station_id) on delete cascade,
  kind        text        not null check (kind in ('pass', 'exclusion')),
  lo          integer     not null,
  hi          integer     not null,
  ord         integer     not null,
  -- Inclusive at both ends: the app's test is low <= addr && addr <= high, and a
  -- range type that disagreed with that would be a bug that only shows up on the
  -- boundary addresses.
  --
  -- There is deliberately no `check (hi >= lo)`, and the inverted case becomes an
  -- empty range rather than an error. One range in the data really is inverted —
  -- Laheys Lookout AL passes 5389–5382 — which in the app's test matches no
  -- address at all. `empty` is exactly that behaviour, so the database agrees
  -- with the app instead of overruling it, and the document keeps the numbers
  -- the file actually contains. Swapping them here would silently switch 8
  -- addresses on; rejecting the row would mean the schema could not hold the
  -- data it exists to hold. Whether 5389 or 5382 is the typo is the network
  -- owner's call, not this migration's.
  span        int4range   generated always as (
                case when hi >= lo then int4range(lo, hi, '[]')
                     else 'empty'::int4range end) stored,
  updated_at  timestamptz not null default now(),
  updated_by  text,
  primary key (repeater_id, kind, lo, hi)
);

comment on table meganet.pass_range is
  'ALERT address ranges a repeater passes or excludes. stations.json stations[].repeater.pass_ranges[] / .exclusions[].';

create index if not exists pass_range_span_idx on meganet.pass_range using gist (span);

-- ── updated_at triggers ──────────────────────────────────────────────────────
-- One shared function from 0001; every table above hangs off it, so "when was
-- this row last touched" is the database's answer and not a matter of each
-- writer remembering.

do $$
declare
  t text;
begin
  foreach t in array array['rm_system', 'radio_network', 'catchment', 'doc_meta',
                           'station', 'sensor', 'repeater', 'pass_range']
  loop
    execute format('drop trigger if exists %I on meganet.%I', t || '_touch_updated_at', t);
    execute format(
      'create trigger %I before update on meganet.%I
         for each row execute function meganet.touch_updated_at()',
      t || '_touch_updated_at', t);
  end loop;
end
$$;

-- ── Row level security ───────────────────────────────────────────────────────
-- Every table created above, in the same file that creates it. The anon key is
-- committed to a public repo and published on GitHub Pages; RLS is the thing
-- actually deciding what it can reach. Supabase's own rls_auto_enable event
-- trigger covers `public` only — nothing catches a missing policy in `meganet`
-- for us. See db/README.md.
--
-- Read for everyone: the station list is already a public file in this repo, so
-- a policy that hands it to a stranger gives away nothing that
-- raw.githubusercontent.com does not. There is deliberately no insert/update/
-- delete policy on any of these tables — the write path is #B3, and it lands
-- after the access gate in #B8, not before it.

do $$
declare
  t text;
begin
  foreach t in array array['rm_system', 'radio_network', 'catchment', 'doc_meta',
                           'station', 'sensor', 'repeater', 'pass_range']
  loop
    execute format('alter table meganet.%I enable row level security', t);
    execute format('drop policy if exists %I on meganet.%I', t || '_read_all', t);
    execute format('create policy %I on meganet.%I for select using (true)',
                   t || '_read_all', t);
  end loop;
end
$$;

-- ── The document ─────────────────────────────────────────────────────────────
-- stations.json, rebuilt from the tables above. Every key, in the shape app.js
-- already parses.
--
-- Optional keys are merged in with `||` rather than emitted as nulls, because
-- absent and null are different things to the app: `'lga' in s` and `s.site.db_id`
-- both behave differently against {"site": null} than against a missing key. The
-- rule is one line per optional key, and it is exactly the set of columns
-- documented as nullable-means-absent on meganet.station.
--
-- Nulls *inside* a present key are kept as nulls — elevation_ahd is null on
-- 2,334 stations and site.db_id on 8, and those keys are present in the file.
-- This is why the view does not simply use jsonb_strip_nulls(), which would
-- flatten both cases into the same thing and quietly change 2,334 stations.
--
-- security_invoker: without it a view runs as its owner and reads straight past
-- the RLS policies above. Every base table here is world-readable so the result
-- is the same today — but the day one of them is not, the difference is a data
-- leak, and the correct setting costs nothing.

create or replace view meganet.stations_json
with (security_invoker = true) as
with sensor_doc as (
  select station_id,
         jsonb_agg(jsonb_build_object(
           'alert_id',  alert_id,
           'type',      type,
           'sensor_id', sensor_id,
           'device_id', device_id
         ) order by ord) as doc
    from meganet.sensor
   group by station_id
),
range_doc as (
  select repeater_id,
         coalesce(jsonb_agg(jsonb_build_object('low', lo, 'high', hi) order by ord)
                    filter (where kind = 'pass'), '[]'::jsonb) as passes,
         coalesce(jsonb_agg(jsonb_build_object('low', lo, 'high', hi) order by ord)
                    filter (where kind = 'exclusion'), '[]'::jsonb) as exclusions
    from meganet.pass_range
   group by repeater_id
),
station_doc as (
  select s.ord,
         jsonb_build_object(
           'id',                s.id,
           'name',              s.name,
           'station_number',    s.station_number,
           'lat',               s.lat,
           'lon',               s.lon,
           'elevation_ahd',     s.elevation_ahd,
           'roles',             to_jsonb(s.roles),
           'radio_network_ids', to_jsonb(s.radio_network_ids),
           'catchment_ids',     to_jsonb(s.catchment_ids),
           'alert_ids',         s.alert_ids,
           'satcom',            s.satcom,
           'rm_system_id',      s.rm_system_id,
           'enabled',           s.enabled,
           'notes',             s.notes
         )
         || case when s.legacy_unit_id is null then '{}'::jsonb
                 else jsonb_build_object('legacy_unit_id', s.legacy_unit_id) end
         || case when s.site is null then '{}'::jsonb
                 else jsonb_build_object('site', s.site) end
         || case when sd.doc is null then '{}'::jsonb
                 else jsonb_build_object('sensors', sd.doc) end
         || case when s.lga is null then '{}'::jsonb
                 else jsonb_build_object('lga', s.lga) end
         || case when s.basin is null then '{}'::jsonb
                 else jsonb_build_object('basin', s.basin) end
         || case when s.location_types is null then '{}'::jsonb
                 else jsonb_build_object('location_types', to_jsonb(s.location_types)) end
         || case when r.station_id is null then '{}'::jsonb
                 else jsonb_build_object('repeater', jsonb_build_object(
                        'acma_licence', r.acma_licence,
                        'rx_mhz',       r.rx_mhz,
                        'tx_mhz',       r.tx_mhz,
                        'pass_ranges',  coalesce(rd.passes,     '[]'::jsonb),
                        'exclusions',   coalesce(rd.exclusions, '[]'::jsonb),
                        'notes',        r.notes
                      )) end
         as doc
    from meganet.station s
    left join sensor_doc sd on sd.station_id  = s.id
    left join meganet.repeater r on r.station_id = s.id
    left join range_doc rd on rd.repeater_id = s.id
)
select jsonb_build_object(
         'meta', (
           select jsonb_build_object(
                    'version',     m.version,
                    'description', m.description,
                    'updated',     m.updated,
                    'rm_paths',    m.rm_paths
                  )
             from meganet.doc_meta m
         ),
         'radio_networks', (
           select coalesce(jsonb_agg(jsonb_build_object(
                    'id', n.id, 'name', n.name, 'description', n.description
                  ) order by n.ord), '[]'::jsonb)
             from meganet.radio_network n
         ),
         'catchments', (
           select coalesce(jsonb_agg(
                    jsonb_build_object(
                      'id',        c.id,
                      'name',      c.name,
                      'basin_no',  c.basin_no,
                      'area_sqkm', c.area_sqkm,
                      'region',    c.region
                    )
                    || case when c.border is null then '{}'::jsonb
                            else jsonb_build_object('border', c.border) end
                    order by c.ord), '[]'::jsonb)
             from meganet.catchment c
         ),
         'rm_systems', (
           select coalesce(jsonb_agg(jsonb_build_object(
                    'id',               y.id,
                    'name',             y.name,
                    'tx_power_w',       y.tx_power_w,
                    'line_loss_db',     y.line_loss_db,
                    'supp_loss_db_m',   y.supp_loss_db_m,
                    'antenna_type',     y.antenna_type,
                    'antenna_gain_dbi', y.antenna_gain_dbi,
                    'antenna_height_m', y.antenna_height_m,
                    'rx_threshold_dbm', y.rx_threshold_dbm
                  ) order by y.ord), '[]'::jsonb)
             from meganet.rm_system y
         ),
         'stations', (
           select coalesce(jsonb_agg(doc order by ord), '[]'::jsonb) from station_doc
         )
       ) as doc;

comment on view meganet.stations_json is
  'stations.json, rebuilt from the normalised tables. Structurally identical to the file — see tools/check_stations_doc.py.';

-- The app calls this rather than selecting the view, for one practical reason:
-- PostgREST returns a scalar function''s result as the response body itself, so
-- `GET /rpc/stations_doc` answers with the document. Selecting the view returns
-- {"doc": …} instead, which would mean parsing 3.6 MB and re-serialising it in
-- the browser just to unwrap it. Marked stable so PostgREST will accept GET.
create or replace function meganet.stations_doc()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select doc from meganet.stations_json;
$$;

comment on function meganet.stations_doc() is
  'The whole stations document, for GET /rest/v1/rpc/stations_doc. Body is the document itself.';

-- ── Supabase Data API (PostgREST) ────────────────────────────────────────────
-- As in 0001: skipped entirely when the roles are absent, so this file still
-- runs against a plain Postgres. Grants are named per object — no
-- `alter default privileges`, so a future table is never exposed by inheritance.
-- `meganet` is already in the exposed-schema list from 0001; all that is needed
-- here is telling PostgREST its cache is stale.

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  -- Read-only for the anon key. The write verbs are not granted to anyone but
  -- service_role: #B3 adds them, behind the gate in #B8.
  grant select on meganet.rm_system, meganet.radio_network, meganet.catchment,
                  meganet.doc_meta, meganet.station, meganet.sensor,
                  meganet.repeater, meganet.pass_range,
                  meganet.stations_json
    to anon, authenticated;

  grant select, insert, update, delete
     on meganet.rm_system, meganet.radio_network, meganet.catchment,
        meganet.doc_meta, meganet.station, meganet.sensor,
        meganet.repeater, meganet.pass_range
    to service_role;

  grant execute on function meganet.stations_doc() to anon, authenticated, service_role;

  notify pgrst, 'reload schema';
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- Bumped in the same commit as DB_SCHEMA_VERSION in app.js, so a database and an
-- app that disagree say so on the Export tab instead of half-working.

insert into meganet.app_meta (key, value)
values ('schema_version', '2')
on conflict (key) do update set value = excluded.value;
