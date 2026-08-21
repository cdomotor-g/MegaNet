-- 0022_stations_outside_the_document.sql — A station the document does not own,
-- and the two things that assumed no such station could exist.
--
-- Why this file exists
-- ────────────────────
-- 0021 created `elpro_test`: the first row in meganet.station that does not come
-- from stations.json. It was written as a plain insert, because from inside 0021
-- that is all it looks like. It is not, and it broke two things that had been
-- true since 0002 without anybody having written them down.
--
-- **1 · Every station was required to have a radio system, and on a fresh
-- database there are none.** `station.rm_system_id` was `not null references
-- meganet.rm_system (id)`, and meganet.rm_system is populated *only* inside
-- load_stations_doc(). CI applies every migration from zero against an empty
-- database and only loads stations.json afterwards, so when 0021 ran there was
-- no rm_system 1 to point at and the migration aborted on the foreign key. The
-- db-checks job had been red on main from the moment 0021 landed.
--
-- **2 · load_stations_doc() is a sync, and it deletes every station the document
-- does not carry.** `elpro_test` is not in stations.json and never will be, so
-- the next stations load removed it. Nothing failed and nothing said so: the
-- readings survive — meganet.reading deliberately carries no foreign key to
-- station (0006) — but they stop resolving to anything, which is the exact
-- outcome 0021 wrote three paragraphs explaining that it existed to prevent.
--
-- Both are the same mistake seen twice, and it is worth naming because the next
-- one of these rows will hit it again: **a station that is not in the document
-- is a different kind of thing from a station that is, and the schema had no way
-- to say so.** This file gives it one.
--
-- What changes
-- ────────────
--   1. `station.rm_system_id` becomes nullable.
--   2. `station.document_managed` says whose row it is. Default true, so every
--      one of the 3,174 existing stations is unaffected.
--   3. load_stations_doc() prunes only rows a document-managed station owns —
--      the station, and its sensors, repeater and pass ranges.
--   4. `elpro_test` and its three addresses move here from 0021.
--
-- tools/import_stations_json.py carries the same four guards, because it is a
-- second loader emitting the same sync as plain SQL and CI runs *that* one. The
-- station guard alone is worse than none: it leaves the row present with its
-- sensors deleted, which resolves no address at all while every query that only
-- looks at meganet.station says the station is fine. That is not hypothetical —
-- it is what the first version of this fix did, and tools/check_mqtt.sql now
-- asserts all four survive a load rather than just the row.
--
-- Why nullable rather than a placeholder rm_system row
-- ───────────────────────────────────────────────────
-- The alternative was to invent an rm_system meaning "not a radio station" and
-- point the test rig at it. That works, and it puts a fabricated radio preset in
-- a reference table the document owns, where the app's link-budget and RF tabs
-- would offer it in a pick-list to people choosing a real one.
--
-- Null is what is actually true. A 115E-2 on a bench has no antenna height and
-- no transmit power for the same reason it has no latitude — **there is no
-- site** — and 0021 already made exactly this call for lat/lon, on exactly this
-- reasoning. The app was already ready for it: path-profile.js:88 tests
-- `st.rm_system_id == null` and declines to draw a link budget, which is the
-- correct answer rather than a fallback.
--
-- **The cost, stated plainly**: `not null` was catching one class of bad load —
-- a stations.json whose station omits the key would previously have been refused
-- by Postgres and will now load as null. That check moves to where the other
-- reference checks already live, tools/import_stations_json.py's
-- check_references(), which is also the only place that can tell "the key is
-- missing" from "the key is deliberately null".
--
-- Why a column rather than reading updated_by
-- ───────────────────────────────────────────
-- load_stations_doc() stamps `updated_by = 'load_stations_doc'`, so "was this
-- row written by the loader" looks answerable without a new column. 0004 already
-- worked through why that is a trap and deleted the trigger that tried it: the
-- value stays on the row afterwards, so any later hand-run update changes the
-- answer. A row's *provenance* is not the same fact as who touched it last, and
-- only one of the two is stable enough to delete rows on.
--
-- This project has also already solved this exact problem once, elsewhere: the
-- inspection loader is a sync over tables that also hold rows typed into MegaNet,
-- and it tells them apart with `origin = 'form'` — an explicit column, set at
-- write time, that no statement the generator emits ever touches (db/README.md).
-- `document_managed` is that column for stations. The generalisation is worth
-- writing down because there will be a third: **a loader that owns most of a
-- table has to be told which rows it does not own, or the first row added by
-- another route disappears at the next load without a word.**
--
-- What is deliberately NOT changed: the document still carries the row
-- ───────────────────────────────────────────────────────────────────
-- `stations_json` is left alone, so once the weekly snapshot next runs,
-- `elpro_test` appears in stations.json like any other station. That is 0021's
-- intent and it is worth protecting: the row exists so the trial's readings
-- resolve to something a person can read *in the app*, and the app draws its
-- station list from the document. Filtering the document to document-managed
-- rows was tried while writing this file and reverted — it makes the flag read
-- prettily in both directions and it takes the test station off the screen it
-- was created for.
--
-- `document_managed` is not emitted as a document key either, and does not need
-- to be. The loaders' upsert lists every column the document describes, and this
-- is not one of them, so a load leaves it exactly as it found it. A snapshot that
-- carries `elpro_test` therefore round-trips into a database where this migration
-- has already run — and every database runs every migration — with the flag still
-- false. The one ordering that would lose it is loading such a snapshot into a
-- database where 0022 never ran, which is not a database this project has.

-- ── 1 · A station may have no radio system ───────────────────────────────────

alter table meganet.station alter column rm_system_id drop not null;

comment on column meganet.station.rm_system_id is
  'Radio Mobile preset for link budgets. NULL where the row is not a radio station at all — a bench gateway or a test rig — which is the same reason those rows have no lat/lon. Every station that came from stations.json has one.';

-- ── 2 · Whose row is it ──────────────────────────────────────────────────────

alter table meganet.station
  add column if not exists document_managed boolean not null default true;

comment on column meganet.station.document_managed is
  'True where stations.json owns this row''s lifecycle — load_stations_doc() upserts it and deletes it when the document stops carrying it. False for rows a migration created, which no document describes and no document may therefore remove. Not emitted into the document: see 0022.';

-- ── 3 · The loader, restated ─────────────────────────────────────────────────
-- Fourth restatement (0003 → 0013 → 0015 → here), and the diff against 0015 is
-- one guard on each of the four prunes that delete station-keyed rows. The whole
-- body is repeated because a plpgsql function cannot be patched in place, not
-- because anything else changed.

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

  insert into meganet.catchment (id, ord, name, basin_no, area_sqkm, region, border, updated_by)
  select e.value ->> 'id', (e.ord - 1)::integer, coalesce(e.value ->> 'name', ''),
         e.value ->> 'basin_no', (e.value ->> 'area_sqkm')::numeric,
         e.value ->> 'region', e.value ->> 'border', 'load_stations_doc'
    from jsonb_array_elements(coalesce(doc -> 'catchments', '[]'::jsonb)) with ordinality e(value, ord)
  on conflict (id) do update
     set ord = excluded.ord, name = excluded.name, basin_no = excluded.basin_no,
         area_sqkm = excluded.area_sqkm, region = excluded.region,
         border = excluded.border, updated_by = excluded.updated_by
   where (meganet.catchment.ord, meganet.catchment.name, meganet.catchment.basin_no,
          meganet.catchment.area_sqkm, meganet.catchment.region, meganet.catchment.border)
      is distinct from (excluded.ord, excluded.name, excluded.basin_no,
          excluded.area_sqkm, excluded.region, excluded.border);

  -- ── stations ──────────────────────────────────────────────────────────────
  insert into meganet.station (id, ord, name, station_number, lat, lon, elevation_ahd,
                               roles, radio_network_ids, catchment_ids, alert_ids, satcom,
                               rm_system_id, enabled, notes, legacy_unit_id, site, lga,
                               basin, location_types, tbrg_bucket_size,
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
         lga = excluded.lga, basin = excluded.basin,
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
          meganet.station.basin, meganet.station.location_types,
          meganet.station.tbrg_bucket_size, meganet.station.inspection_config_key)
      is distinct from (excluded.ord, excluded.name, excluded.station_number, excluded.lat,
          excluded.lon, excluded.elevation_ahd, excluded.roles, excluded.radio_network_ids,
          excluded.catchment_ids, excluded.alert_ids, excluded.satcom, excluded.rm_system_id,
          excluded.enabled, excluded.notes, excluded.legacy_unit_id, excluded.site,
          excluded.lga, excluded.basin, excluded.location_types,
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
   where exists (select 1 from meganet.station st
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

-- ── 4 · The test station, moved here from 0021 ───────────────────────────────
-- 0021 keeps the protocol row and the full account of why this station exists
-- and why its identifiers are the ones they are — that reasoning is worth
-- reading and this is not the file people will look in for it. What moved is the
-- executable half, because it cannot run before the two columns above exist.

insert into meganet.station
  (id, ord, name, station_number, roles, rm_system_id, document_managed, enabled, notes)
select
  'elpro_test',
  coalesce(max(s.ord), 0) + 1,
  'ELPRO 115E-2 test unit',
  '999999',
  array['base']::text[],
  null,
  false,
  true,
  'Bench/test gateway, not a site. Exists so the 115E-2 MQTT trial has somewhere '
  || 'to land that a person can read: see docs/elpro115e_test_card.md for the '
  || 'technician''s half and docs/elpro115e_mqtt.md for the full provisioning '
  || 'guide. Publishes as elpro_test on meganet/v1/elpro_test/logger/reading/elpro. '
  || 'No lat/lon and no rm_system_id on purpose — there is no site and it is not '
  || 'a radio station. Not in stations.json, so document_managed is false and a '
  || 'stations load leaves it alone (0022). Retire with '
  || 'update meganet.station set deleted_at = now() where id = ''elpro_test''.'
from meganet.station s
on conflict (id) do update
  set name             = excluded.name,
      station_number   = excluded.station_number,
      roles            = excluded.roles,
      rm_system_id     = excluded.rm_system_id,
      document_managed = excluded.document_managed,
      enabled          = excluded.enabled,
      notes            = excluded.notes,
      deleted_at       = null,
      updated_at       = now();

-- The three addresses, moved here with the station they hang off. 0021 explains
-- why there are three; the reason they had to move is only that they reference a
-- row that could not exist before this file ran.

insert into meganet.sensor (station_id, sensor_id, type, ord, alert_id) values
  ('elpro_test', 'elpro_test_level',   'Water Level', 1, 9001),
  ('elpro_test', 'elpro_test_rain',    'Rainfall',    2, 9002),
  ('elpro_test', 'elpro_test_battery', 'Battery',     3, 9003)
on conflict (station_id, sensor_id, type) do update
  set alert_id   = excluded.alert_id,
      ord        = excluded.ord,
      updated_at = now();

-- ── Check ────────────────────────────────────────────────────────────────────
-- Fail the migration rather than leave a half-made station behind: a test rig
-- that silently did not resolve would send the technician looking at the device.
do $$
begin
  if meganet.resolve_station(9003, null) is distinct from 'elpro_test' then
    raise exception 'elpro_test did not take: resolve_station(9003) = %',
      coalesce(meganet.resolve_station(9003, null), '(null)');
  end if;
  if meganet.resolve_publisher('elpro_test') is distinct from 'elpro_test' then
    raise exception 'resolve_publisher(''elpro_test'') = %',
      coalesce(meganet.resolve_publisher('elpro_test'), '(null)');
  end if;
end
$$;

-- ── PostgREST ────────────────────────────────────────────────────────────────
-- A new column and a relaxed constraint on a table PostgREST already knows
-- about; the cached column list predates this file.

notify pgrst, 'reload schema';

-- ── Did it take ──────────────────────────────────────────────────────────────
-- The storage_bucket.sql lesson (#145): a file that ran says so. Both halves are
-- asserted, because either one alone leaves the bug this file exists to fix.

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'meganet' and table_name = 'station'
       and column_name = 'document_managed') then
    raise exception '0022 did not take: meganet.station.document_managed is missing';
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'meganet' and table_name = 'station'
       and column_name = 'rm_system_id' and is_nullable = 'NO') then
    raise exception '0022 did not take: meganet.station.rm_system_id is still not null';
  end if;

  if not exists (
    select 1 from meganet.station
     where id = 'elpro_test' and not document_managed) then
    raise exception '0022 did not take: elpro_test is missing or still document-managed';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 21 → 22 in the same commit as this file.
-- 0013's note records why that is said here rather than remembered: 0012 bumped
-- the database and missed the app, and the app showed a schema-mismatch banner
-- until #147 found it.

insert into meganet.app_meta (key, value)
values ('schema_version', '22')
on conflict (key) do update set value = excluded.value;
