-- 0027_catchments_and_hubs.sql — the basins in real coordinates, and who
-- maintains what.
--
-- Why this file exists
-- ────────────────────
-- Two KMZ files, and between them they answer two questions the app has been
-- guessing at or unable to ask.
--
-- **The basins were never in real coordinates.** `catchments[]` has held the
-- 76-basin Queensland vocabulary since the beginning — name, number, area, and
-- MegaNet's own map region — but `catchment_ids` on a station was left empty on
-- purpose, and the README says why: the only geometry in the repo is
-- `assets/geo/QldBasin_2009Nov_reduced.svg`, a projected map pinned to the world
-- by a least-squares affine fit (`BASIN_GEOREF`, maps-data.js) good to a mean of
-- about 34 km. That is enough to *suggest* a map on the Radio Path Maps tab and
-- explicitly "too coarse to store as authoritative data" — the same fit #84
-- measures at 100–150 km when it is asked to draw a boundary over tiles. The
-- README's own roadmap names the fix: "populate `catchment_ids` from official
-- basin boundaries". `QldBasin_2009Nov.kmz` is those boundaries, in WGS84, and
-- this is that roadmap item.
--
-- **Nothing recorded who maintains a station.** The Bureau divides the country
-- into eight field maintenance hubs, two of which (Cairns and Brisbane) cover
-- this network, and the line between them was not written down anywhere in this
-- repo. `Hub_Boundaries_May_2018v2_Si2.kmz` is that line.
--
-- What this file adds
-- ───────────────────
--   meganet.catchment  .division / .division_no — which way the water goes.
--                      Five divisions cover Queensland: North East Coast (47
--                      basins), Gulf (19), Murray Darling (5), Lake Eyre (5) and
--                      Bulloo (1, and its own division because it reaches the
--                      sea nowhere).
--   meganet.hub        The eight hubs. A vocabulary table beside catchment and
--                      radio_network, and like them it is part of the document.
--   meganet.station    .hub_id — which hub the station is in.
--
-- and restates `station_json`, `stations_json` and `load_stations_doc()` so all
-- three travel in stations.json like every other station fact. The geometry
-- itself does not live in Postgres: it is `data/qld-basins.geojson` and
-- `data/bom-hubs.geojson`, drawn by map-catchments.js and map-hubs.js, and
-- putting 1.3 MB of polygon in a table that nothing would ever join against
-- would buy nothing. What is stored here is the *answer* — the basin and the
-- hub each station falls in, computed once by tools/build_geo_layers.py at full
-- resolution rather than in the browser on every page load.
--
-- What the assignment changed, and why it is a correction
-- ──────────────────────────────────────────────────────
-- 786 stations of 3,173. 755 of those had no catchment at all and now have one;
-- 31 move basin, and 4 that fall in no polygon keep the id they had — tide
-- gauges in the water off the mouth of the river they report for, where the
-- honest geometric answer is "nowhere" and "nowhere" is worse than the answer
-- they already had.
--
-- The 31 that move are worth being explicit about, because a station's own
-- free-text `basin` field disagrees with 32 of the changed rows and that reads
-- alarming until you see what the two fields are. `basin` is BoM's flood-warning
-- river grouping — which warning a station is reported under. `catchment_ids` is
-- the drainage basin its coordinates are inside. Black River AL sits in the
-- Black basin and is reported under the Herbert; both are true. The
-- point-in-polygon was checked against twelve towns whose basin is not in
-- dispute (Brisbane, Rockhampton, Townsville, Cairns, Toowoomba, Longreach,
-- Mount Isa, Bundaberg, Mackay, Roma, Charleville, the Gold Coast) and is right
-- for all twelve.
--
-- 1,419 stations are in no Queensland basin, which is also correct: 1,280 of
-- them are in other states, and this dataset is Queensland's.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0027_catchments_and_hubs.sql
--
-- The rows arrive with the document, not from this file:
--
--   select meganet.load_stations_from_github();

-- ── The drainage division ────────────────────────────────────────────────────
-- Nullable, because the document's own optional-key rule applies: absent means
-- absent. Every one of the 77 basins has both today; a basin set that did not
-- would still load.

alter table meganet.catchment add column if not exists division    text;
alter table meganet.catchment add column if not exists division_no text;

comment on column meganet.catchment.division is
  'Australian drainage division — where the water in this basin ends up. From the Bureau''s own QldBasin export.';
comment on column meganet.catchment.division_no is
  'The division''s Roman numeral, as the Bureau writes it: I North East Coast, IV Murray Darling, IX Gulf.';

-- ── Hubs ─────────────────────────────────────────────────────────────────────
-- The Bureau's field maintenance regions. Shaped exactly like meganet.catchment
-- and meganet.radio_network, for the same reason: it is a short, slow-moving
-- vocabulary that stations point at, it rides in the document, and `ord` records
-- the order the document has rather than inventing one.
--
-- The id is the hub's town, slugged, without the word "Hub" — `brisbane`, not
-- `brisbane_hub`. The name keeps it, because "Brisbane Hub" is what a person
-- says and what the KMZ's own Hub_Name field holds.

create table if not exists meganet.hub (
  id          text        primary key,
  ord         integer     not null,
  name        text        not null,
  -- The KMZ's own Area attribute, in square kilometres. Not computed here, and
  -- not compared against the polygon: it is the source's number, kept because
  -- throwing away an attribute that arrived is how a re-import becomes an
  -- argument.
  area_sqkm   numeric,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

comment on table meganet.hub is
  'Bureau of Meteorology field maintenance hubs. stations.json hubs[]. Boundaries are data/bom-hubs.geojson, not here.';

-- ── The station's hub ────────────────────────────────────────────────────────
-- In the optional half of meganet.station, with lga and basin, and for the same
-- reason: NULL means the key is absent from the document. It is a real foreign
-- key — unlike catchment_ids, which is an array and so cannot be one — which is
-- why load_stations_doc() has to insert the hubs before the stations and delete
-- them after.

alter table meganet.station
  add column if not exists hub_id text references meganet.hub (id);

comment on column meganet.station.hub_id is
  'Which maintenance hub this station falls in. Point-in-polygon against data/bom-hubs.geojson by tools/build_geo_layers.py, not typed by hand.';

create index if not exists station_hub_idx on meganet.station (hub_id);

-- ── Row level security ───────────────────────────────────────────────────────
-- The new table, in the file that creates it. db/README.md is absolute about
-- this and the reason is that Supabase's rls_auto_enable event trigger covers
-- `public` only — nothing catches a missing policy in `meganet` for us.
--
-- Read for everyone, like every other vocabulary here: the hub list is in a
-- public file in this repo, so a policy handing it to a stranger gives away
-- nothing that raw.githubusercontent.com does not. No insert/update/delete
-- policy — the write path is load_stations_doc(), which runs as the caller.

alter table meganet.hub enable row level security;
drop policy if exists hub_read_all on meganet.hub;
create policy hub_read_all on meganet.hub
  for select using (true);

-- ── The document, restated ───────────────────────────────────────────────────
-- meganet.station_json, fifth restatement (0004 → 0013 → 0015 → 0024 → here).
-- The diff against 0024 is one line: hub_id joins the optional half, merged with
-- `||` rather than emitted as a null, because absent and null are different
-- things to the app.

create or replace view meganet.station_json
with (security_invoker = true) as
with sensor_doc as (
  select station_id,
         jsonb_agg(jsonb_build_object(
           'alert_id',  alert_id,
           'type',      type,
           'sensor_id', sensor_id,
           'device_id', device_id
         )
         || case when alert2_sensor_id is null then '{}'::jsonb
                 else jsonb_build_object('alert2_sensor_id', alert2_sensor_id) end
         order by ord) as doc
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
)
select s.id,
       s.ord,
       s.updated_at,
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
       || case when s.hub_id is null then '{}'::jsonb
               else jsonb_build_object('hub_id', s.hub_id) end
       || case when s.location_types is null then '{}'::jsonb
               else jsonb_build_object('location_types', to_jsonb(s.location_types)) end
       || case when s.tbrg_bucket_size is null then '{}'::jsonb
               else jsonb_build_object('TBRGbucketSize', s.tbrg_bucket_size) end
       || case when s.inspection_config_key is null then '{}'::jsonb
               else jsonb_build_object('inspection_config_key', s.inspection_config_key) end
       || case when s.alert2_station_id is null then '{}'::jsonb
               else jsonb_build_object('alert2_station_id', s.alert2_station_id) end
       || case when r.station_id is null then '{}'::jsonb
               else jsonb_build_object('repeater',
                      jsonb_build_object(
                        'acma_licence', r.acma_licence,
                        'rx_mhz',       r.rx_mhz,
                        'tx_mhz',       r.tx_mhz,
                        'pass_ranges',  coalesce(rd.passes,     '[]'::jsonb),
                        'exclusions',   coalesce(rd.exclusions, '[]'::jsonb),
                        'notes',        r.notes
                      )
                      || case when r.delay_ms is null then '{}'::jsonb
                              else jsonb_build_object('delay_ms', r.delay_ms) end) end
       as doc
  from meganet.station s
  left join sensor_doc sd on sd.station_id = s.id
  left join meganet.repeater r on r.station_id = s.id
  left join range_doc rd on rd.repeater_id = s.id
 where s.deleted_at is null;

comment on view meganet.station_json is
  'One row per live station: its id, its position in the document, its updated_at, and its stations.json fragment.';

-- meganet.stations_json, third restatement (0002 → 0004 → here). Two changes:
-- each catchment carries its division, and hubs[] joins the document between
-- catchments[] and rm_systems[] — the position stations.json itself uses, and
-- the one tools/snapshot_stations_json.py writes.
--
-- division and division_no are merged with `||` for the optional-key reason
-- above, and border keeps the same treatment it has always had.

create or replace view meganet.stations_json
with (security_invoker = true) as
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
                    || case when c.division is null then '{}'::jsonb
                            else jsonb_build_object('division', c.division) end
                    || case when c.division_no is null then '{}'::jsonb
                            else jsonb_build_object('division_no', c.division_no) end
                    || case when c.border is null then '{}'::jsonb
                            else jsonb_build_object('border', c.border) end
                    order by c.ord), '[]'::jsonb)
             from meganet.catchment c
         ),
         'hubs', (
           select coalesce(jsonb_agg(jsonb_build_object(
                    'id', h.id, 'name', h.name, 'area_sqkm', h.area_sqkm
                  ) order by h.ord), '[]'::jsonb)
             from meganet.hub h
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
           select coalesce(jsonb_agg(doc order by ord), '[]'::jsonb)
             from meganet.station_json
         )
       ) as doc;

comment on view meganet.stations_json is
  'stations.json, assembled from the tables. The document is the API — see 0002.';

-- ── The loader, restated ─────────────────────────────────────────────────────
-- meganet.load_stations_doc(), sixth restatement (0003 → 0013 → 0015 → 0022 →
-- 0024 → here). A plpgsql body cannot be patched, so the whole function is
-- restated for what is four changes:
--
--   1. hubs[] is upserted, before the stations, because station.hub_id is a real
--      foreign key and a station cannot point at a hub that is not there yet.
--   2. Each catchment carries division and division_no.
--   3. Each station carries hub_id.
--   4. Hubs the document dropped are deleted, with the other reference rows and
--      after the stations, for the same foreign-key reason in reverse.
--
-- The up-front validation grows a fourth clause to match. hub_id is a real
-- foreign key so Postgres would catch a bad one anyway, but it would catch it
-- with a constraint name a long way from the station that caused it, and this
-- function's whole contract is that a document that does not hang together is
-- refused before anything is touched.

create or replace function meganet.load_stations_doc(doc jsonb)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  n_station    integer;
  n_sensor     integer;
  n_repeater   integer;
  n_range      integer;
  n_inverted   integer;
  bad_ref      text;
begin
  if doc is null or jsonb_typeof(doc -> 'stations') is distinct from 'array' then
    raise exception 'not a stations document: stations[] is missing or is not an array';
  end if;

  -- Refuse a document that does not hang together, before touching anything.
  -- rm_system_id is a real foreign key so Postgres would catch it anyway, but
  -- radio_network_ids and catchment_ids are arrays and Postgres has no
  -- per-element referential integrity. A bad id in one of those would load
  -- silently and surface later as a filter option matching nothing.
  select string_agg(msg, '; ') into bad_ref from (
    select format('%s: unknown radio_network_id %L', s.value ->> 'id', v) as msg
      from jsonb_array_elements(doc -> 'stations') s
      cross join lateral jsonb_array_elements_text(
             coalesce(s.value -> 'radio_network_ids', '[]'::jsonb)) v
     where not exists (select 1 from jsonb_array_elements(coalesce(doc -> 'radio_networks', '[]'::jsonb)) n
                        where n.value ->> 'id' = v)
    union all
    select format('%s: unknown catchment_id %L', s.value ->> 'id', v)
      from jsonb_array_elements(doc -> 'stations') s
      cross join lateral jsonb_array_elements_text(
             coalesce(s.value -> 'catchment_ids', '[]'::jsonb)) v
     where not exists (select 1 from jsonb_array_elements(coalesce(doc -> 'catchments', '[]'::jsonb)) c
                        where c.value ->> 'id' = v)
    union all
    select format('%s: unknown hub_id %L', s.value ->> 'id', s.value ->> 'hub_id')
      from jsonb_array_elements(doc -> 'stations') s
     where s.value ->> 'hub_id' is not null
       and not exists (select 1 from jsonb_array_elements(coalesce(doc -> 'hubs', '[]'::jsonb)) h
                        where h.value ->> 'id' = s.value ->> 'hub_id')
    limit 20
  ) problems;

  if bad_ref is not null then
    raise exception 'document does not hang together — %', bad_ref;
  end if;

  -- ── meta ──────────────────────────────────────────────────────────────────
  insert into meganet.doc_meta (only_row, version, description, updated, rm_paths, updated_by)
  select true,
         coalesce(doc -> 'meta' ->> 'version', ''),
         coalesce(doc -> 'meta' ->> 'description', ''),
         (doc -> 'meta' ->> 'updated')::date,
         coalesce(doc -> 'meta' -> 'rm_paths', '{}'::jsonb),
         'load_stations_doc'
  on conflict (only_row) do update
     set version = excluded.version, description = excluded.description,
         updated = excluded.updated, rm_paths = excluded.rm_paths,
         updated_by = excluded.updated_by
   where (meganet.doc_meta.version, meganet.doc_meta.description,
          meganet.doc_meta.updated, meganet.doc_meta.rm_paths)
      is distinct from (excluded.version, excluded.description,
          excluded.updated, excluded.rm_paths);

  -- ── reference lists ───────────────────────────────────────────────────────
  insert into meganet.rm_system (id, ord, name, tx_power_w, line_loss_db, supp_loss_db_m,
                                 antenna_type, antenna_gain_dbi, antenna_height_m,
                                 rx_threshold_dbm, updated_by)
  select (e.value ->> 'id')::integer, (e.ord - 1)::integer,
         coalesce(e.value ->> 'name', ''),
         (e.value ->> 'tx_power_w')::numeric, (e.value ->> 'line_loss_db')::numeric,
         (e.value ->> 'supp_loss_db_m')::numeric, e.value ->> 'antenna_type',
         (e.value ->> 'antenna_gain_dbi')::numeric, (e.value ->> 'antenna_height_m')::numeric,
         (e.value ->> 'rx_threshold_dbm')::numeric, 'load_stations_doc'
    from jsonb_array_elements(coalesce(doc -> 'rm_systems', '[]'::jsonb)) with ordinality e(value, ord)
  on conflict (id) do update
     set ord = excluded.ord, name = excluded.name, tx_power_w = excluded.tx_power_w,
         line_loss_db = excluded.line_loss_db, supp_loss_db_m = excluded.supp_loss_db_m,
         antenna_type = excluded.antenna_type, antenna_gain_dbi = excluded.antenna_gain_dbi,
         antenna_height_m = excluded.antenna_height_m,
         rx_threshold_dbm = excluded.rx_threshold_dbm, updated_by = excluded.updated_by
   where (meganet.rm_system.ord, meganet.rm_system.name, meganet.rm_system.tx_power_w,
          meganet.rm_system.line_loss_db, meganet.rm_system.supp_loss_db_m,
          meganet.rm_system.antenna_type, meganet.rm_system.antenna_gain_dbi,
          meganet.rm_system.antenna_height_m, meganet.rm_system.rx_threshold_dbm)
      is distinct from (excluded.ord, excluded.name, excluded.tx_power_w,
          excluded.line_loss_db, excluded.supp_loss_db_m, excluded.antenna_type,
          excluded.antenna_gain_dbi, excluded.antenna_height_m, excluded.rx_threshold_dbm);

  insert into meganet.radio_network (id, ord, name, description, updated_by)
  select e.value ->> 'id', (e.ord - 1)::integer,
         coalesce(e.value ->> 'name', ''), coalesce(e.value ->> 'description', ''),
         'load_stations_doc'
    from jsonb_array_elements(coalesce(doc -> 'radio_networks', '[]'::jsonb)) with ordinality e(value, ord)
  on conflict (id) do update
     set ord = excluded.ord, name = excluded.name,
         description = excluded.description, updated_by = excluded.updated_by
   where (meganet.radio_network.ord, meganet.radio_network.name, meganet.radio_network.description)
      is distinct from (excluded.ord, excluded.name, excluded.description);

  insert into meganet.catchment (id, ord, name, basin_no, area_sqkm, region,
                                division, division_no, border, updated_by)
  select e.value ->> 'id', (e.ord - 1)::integer, coalesce(e.value ->> 'name', ''),
         e.value ->> 'basin_no', (e.value ->> 'area_sqkm')::numeric,
         e.value ->> 'region', e.value ->> 'division', e.value ->> 'division_no',
         e.value ->> 'border', 'load_stations_doc'
    from jsonb_array_elements(coalesce(doc -> 'catchments', '[]'::jsonb)) with ordinality e(value, ord)
  on conflict (id) do update
     set ord = excluded.ord, name = excluded.name, basin_no = excluded.basin_no,
         area_sqkm = excluded.area_sqkm, region = excluded.region,
         division = excluded.division, division_no = excluded.division_no,
         border = excluded.border, updated_by = excluded.updated_by
   where (meganet.catchment.ord, meganet.catchment.name, meganet.catchment.basin_no,
          meganet.catchment.area_sqkm, meganet.catchment.region,
          meganet.catchment.division, meganet.catchment.division_no,
          meganet.catchment.border)
      is distinct from (excluded.ord, excluded.name, excluded.basin_no,
          excluded.area_sqkm, excluded.region, excluded.division,
          excluded.division_no, excluded.border);

  -- ── hubs ──────────────────────────────────────────────────────────────────
  -- Before the stations, because station.hub_id is a real foreign key to this
  -- table and Postgres will (correctly) refuse a station pointing at a hub that
  -- is not there yet.
  insert into meganet.hub (id, ord, name, area_sqkm, updated_by)
  select e.value ->> 'id', (e.ord - 1)::integer, coalesce(e.value ->> 'name', ''),
         (e.value ->> 'area_sqkm')::numeric, 'load_stations_doc'
    from jsonb_array_elements(coalesce(doc -> 'hubs', '[]'::jsonb)) with ordinality e(value, ord)
  on conflict (id) do update
     set ord = excluded.ord, name = excluded.name,
         area_sqkm = excluded.area_sqkm, updated_by = excluded.updated_by
   where (meganet.hub.ord, meganet.hub.name, meganet.hub.area_sqkm)
      is distinct from (excluded.ord, excluded.name, excluded.area_sqkm);

  -- ── stations ──────────────────────────────────────────────────────────────
  insert into meganet.station (id, ord, name, station_number, lat, lon, elevation_ahd,
                               roles, radio_network_ids, catchment_ids, alert_ids, satcom,
                               rm_system_id, enabled, notes, legacy_unit_id, site, lga,
                               basin, hub_id, location_types, tbrg_bucket_size,
                               inspection_config_key, updated_by)
  select e.value ->> 'id', (e.ord - 1)::integer, coalesce(e.value ->> 'name', ''),
         coalesce(e.value ->> 'station_number', ''),
         (e.value ->> 'lat')::numeric, (e.value ->> 'lon')::numeric,
         (e.value ->> 'elevation_ahd')::numeric,
         coalesce((select array_agg(v order by o)
                     from jsonb_array_elements_text(e.value -> 'roles') with ordinality t(v, o)),
                  '{}'::text[]),
         coalesce((select array_agg(v order by o)
                     from jsonb_array_elements_text(e.value -> 'radio_network_ids') with ordinality t(v, o)),
                  '{}'::text[]),
         coalesce((select array_agg(v order by o)
                     from jsonb_array_elements_text(e.value -> 'catchment_ids') with ordinality t(v, o)),
                  '{}'::text[]),
         coalesce(e.value -> 'alert_ids', '{}'::jsonb),
         coalesce(e.value -> 'satcom', '{}'::jsonb),
         (e.value ->> 'rm_system_id')::integer,
         coalesce((e.value ->> 'enabled')::boolean, true),
         coalesce(e.value ->> 'notes', ''),
         (e.value ->> 'legacy_unit_id')::integer,
         e.value -> 'site',
         e.value ->> 'lga',
         e.value ->> 'basin',
         e.value ->> 'hub_id',
         (select array_agg(v order by o)
            from jsonb_array_elements_text(e.value -> 'location_types') with ordinality t(v, o)),
         (e.value ->> 'TBRGbucketSize')::numeric,
         nullif(e.value ->> 'inspection_config_key', ''),
         'load_stations_doc'
    from jsonb_array_elements(doc -> 'stations') with ordinality e(value, ord)
  on conflict (id) do update
     set ord = excluded.ord, name = excluded.name, station_number = excluded.station_number,
         lat = excluded.lat, lon = excluded.lon, elevation_ahd = excluded.elevation_ahd,
         roles = excluded.roles, radio_network_ids = excluded.radio_network_ids,
         catchment_ids = excluded.catchment_ids, alert_ids = excluded.alert_ids,
         satcom = excluded.satcom, rm_system_id = excluded.rm_system_id,
         enabled = excluded.enabled, notes = excluded.notes,
         legacy_unit_id = excluded.legacy_unit_id, site = excluded.site,
         lga = excluded.lga, basin = excluded.basin, hub_id = excluded.hub_id,
         location_types = excluded.location_types,
         tbrg_bucket_size = excluded.tbrg_bucket_size,
         inspection_config_key = excluded.inspection_config_key,
         updated_by = excluded.updated_by
   where (meganet.station.ord, meganet.station.name, meganet.station.station_number,
          meganet.station.lat, meganet.station.lon, meganet.station.elevation_ahd,
          meganet.station.roles, meganet.station.radio_network_ids,
          meganet.station.catchment_ids, meganet.station.alert_ids, meganet.station.satcom,
          meganet.station.rm_system_id, meganet.station.enabled, meganet.station.notes,
          meganet.station.legacy_unit_id, meganet.station.site, meganet.station.lga,
          meganet.station.basin, meganet.station.hub_id,
          meganet.station.location_types,
          meganet.station.tbrg_bucket_size, meganet.station.inspection_config_key)
      is distinct from (excluded.ord, excluded.name, excluded.station_number, excluded.lat,
          excluded.lon, excluded.elevation_ahd, excluded.roles, excluded.radio_network_ids,
          excluded.catchment_ids, excluded.alert_ids, excluded.satcom, excluded.rm_system_id,
          excluded.enabled, excluded.notes, excluded.legacy_unit_id, excluded.site,
          excluded.lga, excluded.basin, excluded.hub_id, excluded.location_types,
          excluded.tbrg_bucket_size, excluded.inspection_config_key);

  -- Stations the document no longer carries. Cascades to their sensors,
  -- repeater row and pass ranges, so this is also the tidy-up for those.
  --
  -- `document_managed` is the whole of 0022's change to this function. Every
  -- station that came out of stations.json has it true and is pruned exactly as
  -- before; a row this schema created for itself has it false and is left alone,
  -- because a document cannot be evidence that a row it never owned should go.
  delete from meganet.station t
   where t.document_managed
     and not exists (select 1 from jsonb_array_elements(doc -> 'stations') e
                      where e.value ->> 'id' = t.id);

  -- ── sensors ───────────────────────────────────────────────────────────────
  insert into meganet.sensor (station_id, sensor_id, type, ord, alert_id, device_id, updated_by)
  select s.value ->> 'id', x.value ->> 'sensor_id', x.value ->> 'type', (x.ord - 1)::integer,
         (x.value ->> 'alert_id')::integer, (x.value ->> 'device_id')::integer,
         'load_stations_doc'
    from jsonb_array_elements(doc -> 'stations') s
    cross join lateral jsonb_array_elements(coalesce(s.value -> 'sensors', '[]'::jsonb))
               with ordinality x(value, ord)
  on conflict (station_id, sensor_id, type) do update
     set ord = excluded.ord, alert_id = excluded.alert_id,
         device_id = excluded.device_id, updated_by = excluded.updated_by
   where (meganet.sensor.ord, meganet.sensor.alert_id, meganet.sensor.device_id)
      is distinct from (excluded.ord, excluded.alert_id, excluded.device_id);

  -- Same rule, one level down: a sensor belongs to a station, so it is the
  -- station's provenance that decides whether the document may remove it.
  -- elpro_test's three addresses are what resolve_station() matches an incoming
  -- alert_id against, so pruning them is pruning the test rig's identity.
  delete from meganet.sensor t
   where t.alert2_sensor_id is null
     and exists (select 1 from meganet.station st
                  where st.id = t.station_id and st.document_managed)
     and not exists (
     select 1 from jsonb_array_elements(doc -> 'stations') s
       cross join lateral jsonb_array_elements(coalesce(s.value -> 'sensors', '[]'::jsonb)) x
      where s.value ->> 'id' = t.station_id
        and x.value ->> 'sensor_id' = t.sensor_id
        and x.value ->> 'type' = t.type);

  -- ── repeaters ─────────────────────────────────────────────────────────────
  insert into meganet.repeater (station_id, acma_licence, rx_mhz, tx_mhz, delay_ms, notes, updated_by)
  select s.value ->> 'id', coalesce(s.value -> 'repeater' ->> 'acma_licence', ''),
         (s.value -> 'repeater' ->> 'rx_mhz')::numeric,
         (s.value -> 'repeater' ->> 'tx_mhz')::numeric,
         (s.value -> 'repeater' ->> 'delay_ms')::integer,
         coalesce(s.value -> 'repeater' ->> 'notes', ''), 'load_stations_doc'
    from jsonb_array_elements(doc -> 'stations') s
   where s.value ? 'repeater'
  on conflict (station_id) do update
     set acma_licence = excluded.acma_licence, rx_mhz = excluded.rx_mhz,
         tx_mhz = excluded.tx_mhz, delay_ms = excluded.delay_ms,
         notes = excluded.notes, updated_by = excluded.updated_by
   where (meganet.repeater.acma_licence, meganet.repeater.rx_mhz,
          meganet.repeater.tx_mhz, meganet.repeater.delay_ms, meganet.repeater.notes)
      is distinct from (excluded.acma_licence, excluded.rx_mhz,
          excluded.tx_mhz, excluded.delay_ms, excluded.notes);

  delete from meganet.repeater t
   where exists (select 1 from meganet.station st
                  where st.id = t.station_id and st.document_managed)
     and not exists (select 1 from jsonb_array_elements(doc -> 'stations') s
                      where s.value ->> 'id' = t.station_id and s.value ? 'repeater');

  -- ── pass ranges ───────────────────────────────────────────────────────────
  insert into meganet.pass_range (repeater_id, kind, lo, hi, ord, updated_by)
  select r.station_id, r.kind, r.lo, r.hi, r.ord, 'load_stations_doc'
    from (
      select s.value ->> 'id' as station_id, k.kind,
             (p.value ->> 'low')::integer as lo, (p.value ->> 'high')::integer as hi,
             (p.ord - 1)::integer as ord
        from jsonb_array_elements(doc -> 'stations') s
        cross join lateral (values ('pass', 'pass_ranges'), ('exclusion', 'exclusions'))
                   as k(kind, field)
        cross join lateral jsonb_array_elements(
                     coalesce(s.value -> 'repeater' -> k.field, '[]'::jsonb))
                   with ordinality p(value, ord)
    ) r
  on conflict (repeater_id, kind, lo, hi) do update
     set ord = excluded.ord, updated_by = excluded.updated_by
   where meganet.pass_range.ord is distinct from excluded.ord;

  delete from meganet.pass_range t
   where exists (select 1 from meganet.station st
                  where st.id = t.repeater_id and st.document_managed)
     and not exists (
     select 1 from jsonb_array_elements(doc -> 'stations') s
       cross join lateral (values ('pass', 'pass_ranges'), ('exclusion', 'exclusions'))
                  as k(kind, field)
       cross join lateral jsonb_array_elements(
                    coalesce(s.value -> 'repeater' -> k.field, '[]'::jsonb)) p
      where s.value ->> 'id' = t.repeater_id
        and k.kind = t.kind
        and (p.value ->> 'low')::integer = t.lo
        and (p.value ->> 'high')::integer = t.hi);

  -- Reference rows the document dropped. Last, because a station still pointing
  -- at an rm_system is a foreign key that would (correctly) refuse the delete.
  delete from meganet.rm_system t
   where not exists (select 1 from jsonb_array_elements(coalesce(doc -> 'rm_systems', '[]'::jsonb)) e
                      where (e.value ->> 'id')::integer = t.id);
  delete from meganet.radio_network t
   where not exists (select 1 from jsonb_array_elements(coalesce(doc -> 'radio_networks', '[]'::jsonb)) e
                      where e.value ->> 'id' = t.id);
  delete from meganet.catchment t
   where not exists (select 1 from jsonb_array_elements(coalesce(doc -> 'catchments', '[]'::jsonb)) e
                      where e.value ->> 'id' = t.id);
  delete from meganet.hub t
   where not exists (select 1 from jsonb_array_elements(coalesce(doc -> 'hubs', '[]'::jsonb)) e
                      where e.value ->> 'id' = t.id);

  select count(*) into n_station  from meganet.station;
  select count(*) into n_sensor   from meganet.sensor;
  select count(*) into n_repeater from meganet.repeater;
  select count(*) into n_range    from meganet.pass_range;
  select count(*) into n_inverted from meganet.pass_range where hi < lo;

  -- Said out loud on every run rather than left to be discovered: a range whose
  -- low is above its high passes no address at all, here or in the app.
  if n_inverted > 0 then
    raise notice 'note: % pass range(s) are inverted and match no address', n_inverted;
  end if;

  return format('loaded %s stations, %s sensors, %s repeaters, %s pass ranges%s',
                n_station, n_sensor, n_repeater, n_range,
                case when n_inverted > 0
                     then format(' (%s inverted range(s) — see db/README.md)', n_inverted)
                     else '' end);
end
$$;

-- ── Data API ─────────────────────────────────────────────────────────────────
-- The new table, named. As in 0002: skipped entirely when the roles are absent,
-- so this file still runs against a plain Postgres. Grants are named per object
-- — no `alter default privileges`, so a future table is never exposed by
-- inheritance.

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  grant select on meganet.hub to anon, authenticated;
  revoke insert, update, delete on meganet.hub from anon, authenticated;
  grant select, insert, update, delete on meganet.hub to service_role;

  notify pgrst, 'reload schema';
end
$$;

-- ── Did it take ──────────────────────────────────────────────────────────────
-- The storage_bucket.sql lesson (#145): a file that ran says so.

do $$
begin
  if to_regclass('meganet.hub') is null then
    raise exception '0027 did not take: meganet.hub is missing';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'meganet' and c.relname = 'hub' and c.relrowsecurity) then
    raise exception '0027 did not take: RLS is not enabled on meganet.hub';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_attribute
     where attrelid = 'meganet.station'::regclass and attname = 'hub_id' and not attisdropped) then
    raise exception '0027 did not take: meganet.station.hub_id is missing';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_attribute
     where attrelid = 'meganet.catchment'::regclass and attname = 'division' and not attisdropped) then
    raise exception '0027 did not take: meganet.catchment.division is missing';
  end if;
  -- The views have to actually emit the new keys, not merely compile. A
  -- restatement that dropped one would pass every check above.
  if not exists (select 1 from pg_catalog.pg_views
                  where schemaname = 'meganet' and viewname = 'station_json'
                    and definition like '%hub_id%') then
    raise exception '0027 did not take: station_json does not emit hub_id';
  end if;
  if not exists (select 1 from pg_catalog.pg_views
                  where schemaname = 'meganet' and viewname = 'stations_json'
                    and definition like '%hubs%') then
    raise exception '0027 did not take: stations_json does not emit hubs[]';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 26 → 27 in the same commit as this file.
-- 0013's note records why that is said here rather than remembered: 0012 bumped
-- the database and missed the app, and the app showed a schema-mismatch banner
-- until #147 found it.

insert into meganet.app_meta (key, value)
values ('schema_version', '27')
on conflict (key) do update set value = excluded.value;
