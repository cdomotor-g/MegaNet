-- 0030_station_owner.sql — Who owns a station, recorded on the station.
--
-- Why this file exists
-- ────────────────────
-- The station card has shown a "Station owner" row since sls.js landed, but the
-- value was never the station's: it is looked up from the Bureau's 2018 Service
-- Level Specification (data/sls-locations.json) by bureau number. A station the
-- SLS does not list — anything commissioned after September 2018, such as the
-- Toowoomba Regional Council TMs 541166–541174 — has no owner anywhere in
-- MegaNet, and there was no field to put one in.
--
-- `station.owner` is that field: free text, the owner's name as it would be
-- written on the card (`Toowoomba Regional Council`). Null means nobody has
-- recorded one on the station, and the card then falls back to the SLS answer,
-- so the 1,146 stations the SLS already covers are unaffected until somebody
-- deliberately sets theirs.
--
-- What this file does NOT do
-- ──────────────────────────
-- It carries no station data, for 0029's reason: owners live in stations.json
-- and reach the table through tools/import_stations_json.py like every other
-- station edit, and a migration carrying rows would be a second copy of the
-- document. Nor does it back-fill from the SLS — that is a 2018 snapshot and the
-- card already shows it; copying it in would make it look like a fact somebody
-- checked.
--
-- What had to be restated
-- ───────────────────────
-- The same three objects 0029 restated, for the same reasons, verbatim from 0029
-- with the one key threaded through: station_json (explicit key list),
-- save_station() (without which the editor would null the owner on the next
-- save) and load_stations_doc(), where `owner` is in *both* halves of the
-- `is distinct from` pair so an owner-only re-import is not read as "nothing
-- changed". Both write paths store a blank owner as null, so the view's
-- absent-rather-than-null shape holds whichever way a row arrived.
--
-- No grants are repeated with the restatements; 0029 says why.
--
-- Idempotent and forward-only, per db/README.md.

-- ── The column ───────────────────────────────────────────────────────────────

alter table meganet.station
  add column if not exists owner text;

comment on column meganet.station.owner is
  'Who owns the station, as written on the card — e.g. "Toowoomba Regional '
  'Council". Null means not recorded on the station, in which case the card '
  'falls back to the owner in the 2018 SLS (data/sls-locations.json).';

-- ── meganet.station_json — 0029's view, plus the one key ─────────────────────
-- The optional-key shape (`|| case when … is null then '{}'`) rather than a
-- place in the base object: a surveyed station carries no provenance, and 840
-- of them would otherwise each gain a `"elevation_source": null`.

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
       -- Absent rather than null where the height was surveyed, which is the
       -- same shape `site` and `lga` use below: a station that carries no
       -- provenance is one whose elevation_ahd came from a survey, and 840 of
       -- them would otherwise each gain a `"elevation_source": null`.
       || case when s.elevation_source is null then '{}'::jsonb
               else jsonb_build_object('elevation_source', s.elevation_source) end
       -- Absent rather than null where nobody has recorded one, for the same
       -- reason: 3,172 stations would otherwise each gain `"owner": null`.
       || case when s.owner is null then '{}'::jsonb
               else jsonb_build_object('owner', s.owner) end
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

-- ── meganet.save_station() — 0029's function, plus the one key ───────────────
-- The editor's write path. A station saved from the app keeps whatever
-- provenance it arrived with rather than losing it on the next edit.

create or replace function meganet.save_station(
         p_doc jsonb,
         p_expected_updated_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id       text := p_doc ->> 'id';
  v_actor    text := meganet.actor();
  v_is_new   boolean;
  v_prev     timestamptz;
  v_ord      integer;
  v_rep      jsonb := p_doc -> 'repeater';
  v_delay    integer;
  v_a2       integer;
  v_dup_a2   integer;
  v_sensors  jsonb;
  v_ranges   jsonb;
  v_deleted  timestamptz;
  v_saved    jsonb;
  v_now      timestamptz;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to write to the station list'
      using errcode = '42501',
            hint    = 'sign in with an address on the editors list — see #B8';
  end if;

  if v_id is null or v_id = '' then
    raise exception 'the station has no id' using errcode = '22023';
  end if;
  if coalesce(p_doc ->> 'name', '') = '' then
    raise exception 'a station needs a name' using errcode = '22023';
  end if;
  if jsonb_typeof(p_doc -> 'roles') is distinct from 'array' then
    raise exception 'roles must be an array' using errcode = '22023';
  end if;
  -- Checked here rather than left to the foreign key so a stale pick-list gets
  -- an answer about the form, not about a constraint name.
  if nullif(p_doc ->> 'inspection_config_key', '') is not null
     and not exists (select 1 from meganet.inspection_config c
                      where c.key = p_doc ->> 'inspection_config_key') then
    raise exception 'unknown inspection configuration "%"', p_doc ->> 'inspection_config_key'
      using errcode = '22023',
            hint    = 'the telemetry-type list comes from meganet.inspection_config — reload and pick again';
  end if;
  -- Same manners for the repeater delay: the check constraint would refuse it
  -- anyway, but with a constraint name rather than a sentence.
  if v_rep is not null and jsonb_typeof(v_rep) = 'object' then
    v_delay := (v_rep ->> 'delay_ms')::integer;
    if v_delay is not null and (v_delay < 0 or v_delay > 999) then
      raise exception 'repeater delay must be between 0 and 999 ms, not %', v_delay
        using errcode = '22023';
    end if;
  end if;

  -- And for the ALERT2 address, which has two ways of being wrong that the
  -- indexes would otherwise report by name: out of range, and already somebody
  -- else's. The second is the one worth a sentence — the person typing it has no
  -- other way to find out who holds it.
  v_a2 := nullif(p_doc ->> 'alert2_station_id', '')::integer;
  if v_a2 is not null and (v_a2 < 1 or v_a2 > 65535) then
    raise exception 'an ALERT2 station address is 1-65535, not %', v_a2
      using errcode = '22023';
  end if;
  if v_a2 is not null and exists (
       select 1 from meganet.station st
        where st.alert2_station_id = v_a2 and st.deleted_at is null and st.id <> v_id) then
    raise exception 'ALERT2 station address % already belongs to another station', v_a2
      using errcode = '22023',
            hint    = 'two stations on one address would resolve to neither — clear it there first';
  end if;

  -- Two sensor rows claiming one slot is the same ambiguity one level down.
  select (x.value ->> 'alert2_sensor_id')::integer into v_dup_a2
    from jsonb_array_elements(coalesce(p_doc -> 'sensors', '[]'::jsonb)) x
   where nullif(x.value ->> 'alert2_sensor_id', '') is not null
   group by (x.value ->> 'alert2_sensor_id')::integer
  having count(*) > 1
   limit 1;
  if v_dup_a2 is not null then
    raise exception 'two sensors are both ALERT2 slot % — a slot is one instrument', v_dup_a2
      using errcode = '22023';
  end if;

  -- Lock the row before reading its stamp, so the check below and the write
  -- after it see the same version. Without the lock two saves can both read the
  -- stamp they expect and both proceed.
  select updated_at, deleted_at into v_prev, v_deleted
    from meganet.station where id = v_id for update;
  v_is_new := not found;

  if v_is_new then
    if p_expected_updated_at is not null then
      raise exception 'station "%" is no longer in the database — it was deleted while you had it open', v_id
        using errcode = 'PT409',
              hint    = 'your edits are still on screen; copy anything you need, then reload';
    end if;
  else
    if p_expected_updated_at is null then
      raise exception 'this editor did not load station "%" from the database, so it will not overwrite it', v_id
        using errcode = 'PT409',
              hint    = 'reload from the datastore and open the station again';
    end if;
    if v_prev is distinct from p_expected_updated_at then
      raise exception 'station "%" was changed in the database at %, after you opened it', v_id, v_prev
        using errcode = 'PT409',
              hint    = 'reload to see the current version — saving now would overwrite somebody else''s work';
    end if;
  end if;

  -- Position in the document. An existing station keeps its place; a new one
  -- goes on the end, which is where an appended station lands in the file too.
  if v_is_new then
    select coalesce(max(ord), -1) + 1 into v_ord from meganet.station;
  else
    select ord into v_ord from meganet.station where id = v_id;
  end if;

  insert into meganet.station (
    id, ord, name, station_number, lat, lon, elevation_ahd, elevation_source, owner,
    roles, radio_network_ids, catchment_ids, alert_ids, satcom,
    rm_system_id, enabled, notes, legacy_unit_id, site, lga, basin,
    location_types, tbrg_bucket_size, inspection_config_key,
    alert2_station_id, deleted_at, updated_by)
  values (
    v_id, v_ord,
    p_doc ->> 'name',
    coalesce(p_doc ->> 'station_number', ''),
    (p_doc ->> 'lat')::numeric,
    (p_doc ->> 'lon')::numeric,
    (p_doc ->> 'elevation_ahd')::numeric,
    p_doc ->> 'elevation_source',
    nullif(btrim(p_doc ->> 'owner'), ''),
    coalesce((select array_agg(v order by o)
                from jsonb_array_elements_text(p_doc -> 'roles') with ordinality t(v, o)),
             '{}'::text[]),
    coalesce((select array_agg(v order by o)
                from jsonb_array_elements_text(p_doc -> 'radio_network_ids') with ordinality t(v, o)),
             '{}'::text[]),
    coalesce((select array_agg(v order by o)
                from jsonb_array_elements_text(p_doc -> 'catchment_ids') with ordinality t(v, o)),
             '{}'::text[]),
    coalesce(p_doc -> 'alert_ids', '{}'::jsonb),
    coalesce(p_doc -> 'satcom', '{}'::jsonb),
    -- Not coalesced to 1 any more. 0022 made this column nullable because the
    -- bench gateway has no radio system and meganet.rm_system is empty until
    -- load_stations_doc() fills it — but save_station() went on defaulting a
    -- missing value to 1, which fails the foreign key outright on a database
    -- built from zero and, on a database that has rm_system 1, quietly writes it
    -- over the null 0022 had just made legal. Half of that fix was missing.
    nullif(p_doc ->> 'rm_system_id', '')::integer,
    coalesce((p_doc ->> 'enabled')::boolean, true),
    coalesce(p_doc ->> 'notes', ''),
    (p_doc ->> 'legacy_unit_id')::integer,
    p_doc -> 'site',
    p_doc ->> 'lga',
    p_doc ->> 'basin',
    (select array_agg(v order by o)
       from jsonb_array_elements_text(p_doc -> 'location_types') with ordinality t(v, o)),
    (p_doc ->> 'TBRGbucketSize')::numeric,
    nullif(p_doc ->> 'inspection_config_key', ''),
    -- Empty stays null. 0022 made rm_system_id nullable and the form promptly
    -- wrote 1 over every null it found, because `parseInt('') || 1` is 1; this
    -- column gets no such default, here or in the form.
    v_a2,
    -- Saving a station that had been deleted brings it back. The alternative is
    -- refusing the save of a station the editor is looking at, which would be a
    -- puzzle rather than a safeguard.
    null,
    v_actor)
  on conflict (id) do update
     set ord = excluded.ord, name = excluded.name,
         station_number = excluded.station_number,
         lat = excluded.lat, lon = excluded.lon,
         elevation_ahd = excluded.elevation_ahd,
         elevation_source = excluded.elevation_source, owner = excluded.owner,
         roles = excluded.roles,
         radio_network_ids = excluded.radio_network_ids,
         catchment_ids = excluded.catchment_ids, alert_ids = excluded.alert_ids,
         satcom = excluded.satcom, rm_system_id = excluded.rm_system_id,
         enabled = excluded.enabled, notes = excluded.notes,
         legacy_unit_id = excluded.legacy_unit_id, site = excluded.site,
         lga = excluded.lga, basin = excluded.basin,
         location_types = excluded.location_types,
         tbrg_bucket_size = excluded.tbrg_bucket_size,
         inspection_config_key = excluded.inspection_config_key,
         alert2_station_id = excluded.alert2_station_id,
         deleted_at = null, updated_by = excluded.updated_by;

  -- ── sensors ───────────────────────────────────────────────────────────────
  -- Normalised into a variable first, because the delete and the insert below
  -- both need the same list and a CTE cannot span two statements.
  --
  -- The natural key is (station_id, sensor_id, type), and a row the operator
  -- typed by hand has no sensor_id — those come from ARRO's export. One is
  -- minted from the station and, in order of preference, the ALERT address, the
  -- ALERT2 slot, or the row's position. The order matters: position is the only
  -- one of the three that changes when the form is reordered, so it is the last
  -- resort rather than the second.
  --
  -- `distinct on` because two rows with the same address and type are the same
  -- sensor typed twice, and ON CONFLICT refuses to touch one row twice in a
  -- statement — a duplicate would otherwise fail the whole save with an error
  -- about the query rather than about the form.
  select coalesce(jsonb_agg(jsonb_build_object(
           'sensor_id', sensor_id, 'type', type, 'ord', ord,
           'alert_id', alert_id, 'device_id', device_id,
           'alert2_sensor_id', alert2_sensor_id) order by ord), '[]'::jsonb)
    into v_sensors
    from (
      select distinct on (sensor_id, type) sensor_id, type, ord, alert_id, device_id,
             alert2_sensor_id
        from (
          select coalesce(nullif(x.value ->> 'sensor_id', ''),
                          v_id || ':' || coalesce(
                            x.value ->> 'alert_id',
                            case when nullif(x.value ->> 'alert2_sensor_id', '') is not null
                                 then 'a2:' || (x.value ->> 'alert2_sensor_id') end,
                            (x.ord - 1)::text))                                       as sensor_id,
                 coalesce(nullif(x.value ->> 'type', ''), 'Unknown')                  as type,
                 (x.ord - 1)::integer                                                 as ord,
                 (x.value ->> 'alert_id')::integer                                    as alert_id,
                 (x.value ->> 'device_id')::integer                                   as device_id,
                 nullif(x.value ->> 'alert2_sensor_id', '')::integer                  as alert2_sensor_id
            from jsonb_array_elements(coalesce(p_doc -> 'sensors', '[]'::jsonb))
                 with ordinality x(value, ord)
        ) raw
       order by sensor_id, type, ord
    ) uniq;

  delete from meganet.sensor t
   where t.station_id = v_id
     and not exists (select 1 from jsonb_array_elements(v_sensors) e
                      where e.value ->> 'sensor_id' = t.sensor_id
                        and e.value ->> 'type'      = t.type);

  insert into meganet.sensor (station_id, sensor_id, type, ord, alert_id, device_id,
                              alert2_sensor_id, updated_by)
  select v_id, e.value ->> 'sensor_id', e.value ->> 'type', (e.value ->> 'ord')::integer,
         (e.value ->> 'alert_id')::integer, (e.value ->> 'device_id')::integer,
         (e.value ->> 'alert2_sensor_id')::integer, v_actor
    from jsonb_array_elements(v_sensors) e
  on conflict (station_id, sensor_id, type) do update
     set ord = excluded.ord, alert_id = excluded.alert_id,
         device_id = excluded.device_id,
         alert2_sensor_id = excluded.alert2_sensor_id,
         updated_by = excluded.updated_by
   where (meganet.sensor.ord, meganet.sensor.alert_id, meganet.sensor.device_id,
          meganet.sensor.alert2_sensor_id)
      is distinct from (excluded.ord, excluded.alert_id, excluded.device_id,
                        excluded.alert2_sensor_id);

  -- ── repeater and its ranges ───────────────────────────────────────────────
  -- The role is what decides, not the presence of the object: un-ticking
  -- "repeater" in the editor has to remove the repeater detail, or a station
  -- keeps passing addresses it is no longer a repeater for.
  if v_rep is null or jsonb_typeof(v_rep) is distinct from 'object'
     or not (coalesce(p_doc -> 'roles', '[]'::jsonb) ? 'repeater') then
    -- Cascades to pass_range.
    delete from meganet.repeater where station_id = v_id;
  else
    insert into meganet.repeater (station_id, acma_licence, rx_mhz, tx_mhz, delay_ms, notes, updated_by)
    values (v_id, coalesce(v_rep ->> 'acma_licence', ''),
            (v_rep ->> 'rx_mhz')::numeric, (v_rep ->> 'tx_mhz')::numeric,
            v_delay,
            coalesce(v_rep ->> 'notes', ''), v_actor)
    on conflict (station_id) do update
       set acma_licence = excluded.acma_licence, rx_mhz = excluded.rx_mhz,
           tx_mhz = excluded.tx_mhz, delay_ms = excluded.delay_ms,
           notes = excluded.notes, updated_by = excluded.updated_by;

    -- Ranges are replaced wholesale rather than diffed. There are ten of them on
    -- a busy repeater, they have no identity beyond their own numbers, and the
    -- editor hands over a textarea — "these are the ranges now" is what it means
    -- and what this does. Duplicated lines collapse: (kind, lo, hi) is the key.
    select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'lo', lo, 'hi', hi, 'ord', ord)
                              order by ord), '[]'::jsonb)
      into v_ranges
      from (
        select distinct on (kind, lo, hi) kind, lo, hi, ord
          from (
            select k.kind,
                   (p.value ->> 'low')::integer  as lo,
                   (p.value ->> 'high')::integer as hi,
                   (p.ord - 1)::integer          as ord
              from (values ('pass', 'pass_ranges'), ('exclusion', 'exclusions')) as k(kind, field)
              cross join lateral jsonb_array_elements(coalesce(v_rep -> k.field, '[]'::jsonb))
                         with ordinality p(value, ord)
             where (p.value ->> 'low') is not null and (p.value ->> 'high') is not null
          ) raw
         order by kind, lo, hi, ord
      ) uniq;

    delete from meganet.pass_range where repeater_id = v_id;

    insert into meganet.pass_range (repeater_id, kind, lo, hi, ord, updated_by)
    select v_id, e.value ->> 'kind', (e.value ->> 'lo')::integer,
           (e.value ->> 'hi')::integer, (e.value ->> 'ord')::integer, v_actor
      from jsonb_array_elements(v_ranges) e;
  end if;

  select updated_at into v_now from meganet.station where id = v_id;
  select doc into v_saved from meganet.station_json where id = v_id;

  return jsonb_build_object(
           'station',    v_saved,
           'updated_at', v_now,
           'created',    v_is_new,
           'updated_by', v_actor);

exception
  -- Two saves racing to create the same id: the loser's insert hits the primary
  -- key rather than the stamp check above, because there was no row to lock.
  -- Same situation, so it gets the same answer.
  when unique_violation then
    raise exception 'station "%" already exists — somebody created it while you were typing', v_id
      using errcode = 'PT409',
            hint    = 'your edits are still on screen; give the station another name or reload';
end;
$$;

-- ── meganet.load_stations_doc() — 0029's function, plus the one key ──────────
-- The importer's write path, and where the is-distinct-from pair lives.

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
                               elevation_source, owner,
                               roles, radio_network_ids, catchment_ids, alert_ids, satcom,
                               rm_system_id, enabled, notes, legacy_unit_id, site, lga,
                               basin, hub_id, location_types, tbrg_bucket_size,
                               inspection_config_key, updated_by)
  select e.value ->> 'id', (e.ord - 1)::integer, coalesce(e.value ->> 'name', ''),
         coalesce(e.value ->> 'station_number', ''),
         (e.value ->> 'lat')::numeric, (e.value ->> 'lon')::numeric,
         (e.value ->> 'elevation_ahd')::numeric,
         e.value ->> 'elevation_source',
         nullif(btrim(e.value ->> 'owner'), ''),
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
         elevation_source = excluded.elevation_source, owner = excluded.owner,
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
          meganet.station.elevation_source, meganet.station.owner,
          meganet.station.roles, meganet.station.radio_network_ids,
          meganet.station.catchment_ids, meganet.station.alert_ids, meganet.station.satcom,
          meganet.station.rm_system_id, meganet.station.enabled, meganet.station.notes,
          meganet.station.legacy_unit_id, meganet.station.site, meganet.station.lga,
          meganet.station.basin, meganet.station.hub_id,
          meganet.station.location_types,
          meganet.station.tbrg_bucket_size, meganet.station.inspection_config_key)
      is distinct from (excluded.ord, excluded.name, excluded.station_number, excluded.lat,
          excluded.lon, excluded.elevation_ahd, excluded.elevation_source, excluded.owner,
          excluded.roles, excluded.radio_network_ids,
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

-- ── Did it take? ─────────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_catalog.pg_views
                  where schemaname = 'meganet' and viewname = 'station_json'
                    and definition like '%''owner''%') then
    raise exception '0030 did not take: station_json does not emit owner';
  end if;
  if not exists (select 1 from pg_catalog.pg_attribute a
                   join pg_catalog.pg_class c on c.oid = a.attrelid
                   join pg_catalog.pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'meganet' and c.relname = 'station'
                    and a.attname = 'owner' and not a.attisdropped) then
    raise exception '0030 did not take: meganet.station has no owner';
  end if;
  if (select count(*) from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'meganet' and p.proname = 'load_stations_doc'
         and p.prosrc like '%excluded.owner%') = 0 then
    raise exception '0030 did not take: load_stations_doc ignores owner';
  end if;
  if (select count(*) from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'meganet' and p.proname = 'save_station'
         and p.prosrc like '%excluded.owner%') = 0 then
    raise exception '0030 did not take: save_station ignores owner';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 29 → 30 in the same commit as this file.

insert into meganet.app_meta (key, value)
values ('schema_version', '30')
on conflict (key) do update set value = excluded.value;
