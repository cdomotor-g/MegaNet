-- 0003_load_stations.sql — load the station list from inside the database.
--
-- 0002 built the schema and the document that comes back out of it. Getting the
-- data *in* was a job for tools/import_stations_json.py, which emits ~2.7 MB of
-- SQL and expects psql at the other end. That is fine on a workstation with the
-- repo checked out and useless to somebody holding nothing but the Supabase SQL
-- editor in a browser tab — which is the situation this file exists for. 2.7 MB
-- is not something you paste into a textarea.
--
-- So the unpacking moves into the database. `stations.json` is public, and the
-- database can fetch it itself:
--
--   select meganet.load_stations_from_github();
--
-- One line, and the 3.5 MB never goes near the browser. Re-runnable: it is the
-- same sync the Python script does — upsert everything in the document, delete
-- everything not in it, and leave `updated_at` alone on rows that did not
-- actually change.
--
-- The Python script keeps its place. It is the path for an air-gapped database
-- that cannot reach raw.githubusercontent.com, and being able to read the SQL
-- before it runs is worth having. Both roads end at the same function:
-- meganet.load_stations_doc(jsonb).
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0003_load_stations.sql

-- ── The unpacker ─────────────────────────────────────────────────────────────
-- Takes the document and makes the tables match it. Everything the import script
-- does, in one function:
--
--   * upsert every row the document carries
--   * delete every row it does not
--   * skip the update when a row's data is unchanged, so a second run does not
--     restamp 3,174 rows and destroy the meaning of updated_at
--   * take array position as `ord`, so the document rebuilt by
--     meganet.stations_json comes back in the order it went in
--
-- Numbers survive because jsonb already stores them as numeric: ->> hands back
-- the literal the file contained, and the columns are numeric too. Nothing is
-- routed through a float, which is what would turn 1060.2 into
-- 1060.2000000000000455.
--
-- Absent keys stay absent. `doc->'site'` is SQL NULL when the key is missing,
-- and every nullable column on meganet.station means exactly "this key was not
-- in the document" — which is what the view turns back into a missing key.

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
                               basin, location_types, updated_by)
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
         location_types = excluded.location_types, updated_by = excluded.updated_by
   where (meganet.station.ord, meganet.station.name, meganet.station.station_number,
          meganet.station.lat, meganet.station.lon, meganet.station.elevation_ahd,
          meganet.station.roles, meganet.station.radio_network_ids,
          meganet.station.catchment_ids, meganet.station.alert_ids, meganet.station.satcom,
          meganet.station.rm_system_id, meganet.station.enabled, meganet.station.notes,
          meganet.station.legacy_unit_id, meganet.station.site, meganet.station.lga,
          meganet.station.basin, meganet.station.location_types)
      is distinct from (excluded.ord, excluded.name, excluded.station_number, excluded.lat,
          excluded.lon, excluded.elevation_ahd, excluded.roles, excluded.radio_network_ids,
          excluded.catchment_ids, excluded.alert_ids, excluded.satcom, excluded.rm_system_id,
          excluded.enabled, excluded.notes, excluded.legacy_unit_id, excluded.site,
          excluded.lga, excluded.basin, excluded.location_types);

  -- Stations the document no longer carries. Cascades to their sensors,
  -- repeater row and pass ranges, so this is also the tidy-up for those.
  delete from meganet.station t
   where not exists (select 1 from jsonb_array_elements(doc -> 'stations') e
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

  delete from meganet.sensor t
   where not exists (
     select 1 from jsonb_array_elements(doc -> 'stations') s
       cross join lateral jsonb_array_elements(coalesce(s.value -> 'sensors', '[]'::jsonb)) x
      where s.value ->> 'id' = t.station_id
        and x.value ->> 'sensor_id' = t.sensor_id
        and x.value ->> 'type' = t.type);

  -- ── repeaters ─────────────────────────────────────────────────────────────
  insert into meganet.repeater (station_id, acma_licence, rx_mhz, tx_mhz, notes, updated_by)
  select s.value ->> 'id', coalesce(s.value -> 'repeater' ->> 'acma_licence', ''),
         (s.value -> 'repeater' ->> 'rx_mhz')::numeric,
         (s.value -> 'repeater' ->> 'tx_mhz')::numeric,
         coalesce(s.value -> 'repeater' ->> 'notes', ''), 'load_stations_doc'
    from jsonb_array_elements(doc -> 'stations') s
   where s.value ? 'repeater'
  on conflict (station_id) do update
     set acma_licence = excluded.acma_licence, rx_mhz = excluded.rx_mhz,
         tx_mhz = excluded.tx_mhz, notes = excluded.notes, updated_by = excluded.updated_by
   where (meganet.repeater.acma_licence, meganet.repeater.rx_mhz,
          meganet.repeater.tx_mhz, meganet.repeater.notes)
      is distinct from (excluded.acma_licence, excluded.rx_mhz,
          excluded.tx_mhz, excluded.notes);

  delete from meganet.repeater t
   where not exists (select 1 from jsonb_array_elements(doc -> 'stations') s
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
   where not exists (
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

comment on function meganet.load_stations_doc(jsonb) is
  'Make the tables match a stations.json document. Idempotent: a second run over the same document changes nothing.';

-- ── Fetching it ──────────────────────────────────────────────────────────────
-- The one-liner. stations.json is public, so the database can pull it straight
-- from the repo and never involve the browser in moving 3.5 MB.
--
-- The http extension is looked up rather than assumed, and its absence is
-- reported with the command that fixes it — an error that tells you what to type
-- is worth more here than one that says "function does not exist". Looking the
-- schema up in pg_proc also means it does not matter whether the extension was
-- installed into `extensions` (Supabase's convention) or somewhere else.

create or replace function meganet.load_stations_from_url(
         url text default 'https://raw.githubusercontent.com/cdomotor-g/MegaNet/main/stations.json')
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  http_schema text;
  http_status integer;
  body        text;
begin
  select n.nspname into http_schema
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where p.proname = 'http_get'
   order by case when n.nspname = 'extensions' then 0 else 1 end
   limit 1;

  if http_schema is null then
    raise exception 'the http extension is not enabled on this database'
      using hint = 'run this once, then try again:  '
                   'create extension if not exists http with schema extensions;';
  end if;

  -- 3.5 MB over the public internet can outlast the 5-second default. Best
  -- effort: older builds of the extension do not have http_set_curlopt, and
  -- failing to raise the timeout is not a reason to refuse to try the fetch.
  begin
    execute format('select %I.http_set_curlopt(%L, %L)', http_schema, 'CURLOPT_TIMEOUT', '120');
  exception when others then
    null;
  end;

  execute format('select status, content from %I.http_get(%L)', http_schema, url)
     into http_status, body;

  if http_status is distinct from 200 then
    raise exception 'fetching % returned HTTP %', url, http_status;
  end if;

  return meganet.load_stations_doc(body::jsonb);
end
$$;

comment on function meganet.load_stations_from_url(text) is
  'Fetch stations.json over HTTP and load it. Defaults to the copy on main in the MegaNet repo.';

-- ── Who may run these ────────────────────────────────────────────────────────
-- Postgres grants EXECUTE on a new function to PUBLIC by default. These two
-- functions rewrite the entire station list, so that default is exactly wrong
-- and has to be revoked explicitly — the same class of quiet, expensive mistake
-- as a table created without RLS. Both are `security invoker`, so a caller
-- without write grants would fail anyway; this is the belt to that pair of
-- braces.

revoke all on function meganet.load_stations_doc(jsonb)     from public;
revoke all on function meganet.load_stations_from_url(text)  from public;

do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    grant execute on function meganet.load_stations_doc(jsonb)    to service_role;
    grant execute on function meganet.load_stations_from_url(text) to service_role;
  end if;

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    notify pgrst, 'reload schema';
  end if;
end
$$;

insert into meganet.app_meta (key, value)
values ('schema_version', '3')
on conflict (key) do update set value = excluded.value;
