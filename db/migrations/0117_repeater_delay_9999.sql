-- 0117_repeater_delay_9999.sql — A repeater's delay may be up to 9999 ms.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0117_repeater_delay_9999.sql
--
-- Why this file exists
-- ────────────────────
-- 0015 held a repeater's delay under 1000 ms. A maintainer swapped Hillcrest
-- AL (Wine Glass) to an ERT-A2 set to 2700 ms and the station editor saved it
-- as 999. The new limit is 9999 ms, in the column's check, in save_station()'s
-- own message (0060's function, word for word but for that number), and in the
-- editor, the plan and the docs.

do $$
declare c text;
begin
  for c in select con.conname
             from pg_catalog.pg_constraint con
            where con.conrelid = 'meganet.repeater'::regclass and con.contype = 'c'
              and pg_catalog.pg_get_constraintdef(con.oid) like '%delay_ms%'
  loop
    execute format('alter table meganet.repeater drop constraint %I', c);
  end loop;
end
$$;

alter table meganet.repeater
  add constraint repeater_delay_ms_check check (delay_ms >= 0 and delay_ms <= 9999);

comment on column meganet.repeater.delay_ms is
  'How long this repeater waits before re-transmitting a message its pass ranges accept, in milliseconds (0–9999). Null = not set; the app suggests a collision-avoiding value from the backbone adjacency but never records one silently. stations.json stations[].repeater.delay_ms.';

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
  v_key      text;
  v_bad      text;
  v_proposed boolean;
  v_type     text;
  v_year     integer;
  v_tower    numeric;
  v_from     text;
  v_facing   numeric;
  v_was      boolean;
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
    if v_delay is not null and (v_delay < 0 or v_delay > 9999) then
      raise exception 'repeater delay must be between 0 and 9999 ms, not %', v_delay
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

  -- The lists 0031 and 0032 added. Each is a list when it is there at all, and
  -- the codes in it are ones the vocabularies know — asked here, before anything
  -- is written, so a code nobody knows gets a sentence naming it rather than a
  -- foreign key's name.
  foreach v_key in array array['flood_classes', 'crossings', 'gauge_survey',
                               'bureau_listings', 'flood_effects',
                               'aep_levels', 'frequencies'] loop
    if p_doc ? v_key and jsonb_typeof(p_doc -> v_key) is distinct from 'array' then
      raise exception '% must be a list', v_key using errcode = '22023';
    end if;
  end loop;

  select string_agg(distinct c.code, ', ') into v_bad
    from (select nullif(btrim(x.value ->> 'crossing_type'), '') as code
            from jsonb_array_elements(case when jsonb_typeof(p_doc -> 'flood_classes') = 'array'
                                           then p_doc -> 'flood_classes' else '[]'::jsonb end) x
          union all
          select nullif(btrim(x.value ->> 'crossing_type'), '')
            from jsonb_array_elements(case when jsonb_typeof(p_doc -> 'crossings') = 'array'
                                           then p_doc -> 'crossings' else '[]'::jsonb end) x) c
   where c.code is not null
     and not exists (select 1 from meganet.crossing_type t where t.code = c.code);
  if v_bad is not null then
    raise exception 'unknown crossing type %', v_bad
      using errcode = '22023',
            hint    = 'the crossing types are the Bureau''s legend, in meganet.crossing_type';
  end if;

  select string_agg(distinct c.code, ', ') into v_bad
    from (select nullif(btrim(x.value ->> 'datum'), '') as code
            from jsonb_array_elements(case when jsonb_typeof(p_doc -> 'gauge_survey') = 'array'
                                           then p_doc -> 'gauge_survey' else '[]'::jsonb end) x) c
   where c.code is not null
     and not exists (select 1 from meganet.gauge_datum d where d.code = c.code);
  if v_bad is not null then
    raise exception 'unknown datum %', v_bad
      using errcode = '22023',
            hint    = 'the datums a gauge zero may be in are meganet.gauge_datum';
  end if;

  -- The two lists 0033 added, asked the same way: a sentence naming what is
  -- wrong rather than a check constraint's name. The editor offers only the
  -- values these accept, so a refusal here is a stale tab or a hand-made
  -- document.
  select string_agg(distinct msg, '; ') into v_bad
    from (select case
                   when nullif(btrim(x.value ->> 'setting'), '') is not null
                    and btrim(x.value ->> 'setting') not in ('channel', 'floodplain')
                     then format('setting %L is neither channel nor floodplain', x.value ->> 'setting')
                   when nullif(x.value ->> 'data_quality', '')::numeric not between 1 and 3
                     then format('data quality %s is not 1–3', x.value ->> 'data_quality')
                   when nullif(x.value ->> 'level_difference', '')::numeric not between 1 and 3
                     then format('level difference %s is not 1–3', x.value ->> 'level_difference')
                   when nullif(x.value ->> 'confidence', '')::numeric not between 1 and 9
                     then format('confidence %s is not 1–9', x.value ->> 'confidence')
                   when nullif(x.value ->> 'slope', '')::numeric < 0
                     then format('slope %s is below zero', x.value ->> 'slope')
                   when nullif(x.value ->> 'manning_n', '')::numeric not between 0.01 and 0.3
                     then format('Manning n %s is outside 0.01–0.3', x.value ->> 'manning_n')
                 end as msg
            from jsonb_array_elements(case when jsonb_typeof(p_doc -> 'aep_levels') = 'array'
                                           then p_doc -> 'aep_levels' else '[]'::jsonb end) x
          union all
          select case
                   when nullif(x.value ->> 'rx_mhz', '')::numeric <= 0
                     or nullif(x.value ->> 'tx_mhz', '')::numeric <= 0
                     then 'a frequency is a positive number of MHz'
                 end
            from jsonb_array_elements(case when jsonb_typeof(p_doc -> 'frequencies') = 'array'
                                           then p_doc -> 'frequencies' else '[]'::jsonb end) x) c
   where msg is not null;
  if v_bad is not null then
    raise exception 'not saved: %', v_bad using errcode = '22023';
  end if;

  select string_agg(distinct c.code, ', ') into v_bad
    from (select nullif(btrim(x.value ->> 'section'), '') as code
            from jsonb_array_elements(case when jsonb_typeof(p_doc -> 'bureau_listings') = 'array'
                                           then p_doc -> 'bureau_listings' else '[]'::jsonb end) x) c
   where c.code is not null
     and not exists (select 1 from meganet.bureau_index b where b.code = c.code);
  if v_bad is not null then
    raise exception 'unknown Bureau index section %', v_bad
      using errcode = '22023',
            hint    = 'the indexes a station can be listed in are meganet.bureau_index — Sections 1, 2 and 3';
  end if;
  -- A listing that says something, but not which index: refused rather than
  -- dropped, because somebody typed the date or the note meaning to keep it.
  if exists (select 1
               from jsonb_array_elements(case when jsonb_typeof(p_doc -> 'bureau_listings') = 'array'
                                              then p_doc -> 'bureau_listings' else '[]'::jsonb end) x
              where nullif(btrim(x.value ->> 'section'), '') is null
                and num_nonnulls(nullif(x.value ->> 'as_at', ''),
                                 nullif(btrim(x.value ->> 'note'), '')) > 0) then
    raise exception 'a Bureau index listing needs the section it is listed in'
      using errcode = '22023',
            hint    = 'pick Section 1, 2 or 3 for the row, or remove it';
  end if;

  -- The tower's platform height (0040): one of the standard drawing's two,
  -- 3.0 m or 4.5 m, or absent. Asked before anything is written, in a sentence
  -- rather than the column's check.
  if jsonb_typeof(p_doc -> 'tower_height') not in ('number', 'string', 'null') then
    raise exception 'a tower''s platform height is 3.0 or 4.5 (metres), not %', p_doc -> 'tower_height'
      using errcode = '22023';
  end if;
  if nullif(btrim(p_doc ->> 'tower_height'), '') is not null
     and btrim(p_doc ->> 'tower_height') !~ '^[0-9]+(\.[0-9]+)?$' then
    raise exception 'a tower''s platform height is 3.0 or 4.5 (metres), not "%"', p_doc ->> 'tower_height'
      using errcode = '22023';
  end if;
  v_tower := nullif(btrim(p_doc ->> 'tower_height'), '')::numeric;
  if v_tower is not null and v_tower not in (3.0, 4.5) then
    raise exception 'a tower''s platform height is 3.0 or 4.5 (metres), not %', v_tower
      using errcode = '22023',
            hint    = 'the standard drawing''s two platform heights, each on a 2100 × 2100 footing';
  end if;

  -- The station it takes its flood history from (0041): another live station,
  -- or absent.
  if jsonb_typeof(p_doc -> 'flood_peaks_from') not in ('string', 'null') then
    raise exception 'flood_peaks_from is a station''s id, not %', p_doc -> 'flood_peaks_from'
      using errcode = '22023';
  end if;
  v_from := nullif(btrim(p_doc ->> 'flood_peaks_from'), '');
  if v_from is not null and v_from = v_id then
    raise exception 'a station cannot take its flood history from itself'
      using errcode = '22023';
  end if;
  if v_from is not null
     and not exists (select 1 from meganet.station s where s.id = v_from and s.deleted_at is null) then
    raise exception 'there is no station "%" to take the flood history from', v_from
      using errcode = '22023',
            hint    = 'name it by its id, such as gatton';
  end if;

  -- The way the station faces (0044): a bearing in whole or part degrees,
  -- 0 up to but not 360, or absent. 360 is read as 0 rather than refused.
  if jsonb_typeof(p_doc -> 'facing_deg') not in ('number', 'string', 'null') then
    raise exception 'the way a station faces is a bearing in degrees, 0 to 359, not %', p_doc -> 'facing_deg'
      using errcode = '22023';
  end if;
  if nullif(btrim(p_doc ->> 'facing_deg'), '') is not null
     and btrim(p_doc ->> 'facing_deg') !~ '^[0-9]+(\.[0-9]+)?$' then
    raise exception 'the way a station faces is a bearing in degrees, 0 to 359, not "%"', p_doc ->> 'facing_deg'
      using errcode = '22023';
  end if;
  v_facing := round(nullif(btrim(p_doc ->> 'facing_deg'), '')::numeric, 1);
  if v_facing = 360 then v_facing := 0; end if;
  if v_facing is not null and (v_facing < 0 or v_facing >= 360) then
    raise exception 'the way a station faces is a bearing in degrees, 0 to 359, not %', v_facing
      using errcode = '22023',
            hint    = 'clockwise from true north: 0 north, 90 east, 180 south, 270 west';
  end if;

  -- The proposal (0039), asked before anything is written, like the lists
  -- above: `proposed` is true or false when it is there at all, the type is one
  -- meganet.station_type knows, and the year is four figures a person could
  -- mean. A proposal carries all three things that make it one — what kind of
  -- station, the year it is proposed for, and where it would go — and each
  -- missing one is refused with its own sentence rather than the constraint's.
  if jsonb_typeof(p_doc -> 'proposed') not in ('boolean', 'null') then
    raise exception 'proposed is true or false, not %', p_doc -> 'proposed'
      using errcode = '22023';
  end if;
  v_proposed := coalesce((p_doc ->> 'proposed')::boolean, false);
  v_type := nullif(btrim(p_doc ->> 'station_type'), '');
  if v_type is not null
     and not exists (select 1 from meganet.station_type t where t.code = v_type) then
    raise exception 'unknown station type "%"', v_type
      using errcode = '22023',
            hint    = 'the types are meganet.station_type: an automatic or manual water level station, an automatic or manual rain gauge';
  end if;
  if nullif(btrim(p_doc ->> 'proposed_year'), '') is not null
     and btrim(p_doc ->> 'proposed_year') !~ '^[0-9]{4}$' then
    raise exception 'the year a station is proposed for is a year, such as 2026 — not "%"', p_doc ->> 'proposed_year'
      using errcode = '22023';
  end if;
  v_year := nullif(btrim(p_doc ->> 'proposed_year'), '')::integer;
  if v_year is not null and (v_year < 1900 or v_year > 2200) then
    raise exception 'the year a station is proposed for is between 1900 and 2200, not %', v_year
      using errcode = '22023';
  end if;
  if v_proposed then
    if v_type is null then
      raise exception 'a proposed station needs its type: an automatic or manual water level station, or an automatic or manual rain gauge'
        using errcode = '22023';
    end if;
    if v_year is null then
      raise exception 'a proposed station needs the year it is proposed for'
        using errcode = '22023';
    end if;
    if nullif(p_doc ->> 'lat', '') is null or nullif(p_doc ->> 'lon', '') is null then
      raise exception 'a proposed station needs a position: where it is proposed to go'
        using errcode = '22023',
              hint    = 'type its latitude and longitude, or pick the point on the map with What is here';
    end if;
  end if;

  -- Lock the row before reading its stamp, so the check below and the write
  -- after it see the same version. Without the lock two saves can both read the
  -- stamp they expect and both proceed.
  select updated_at, deleted_at, proposed into v_prev, v_deleted, v_was
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

  -- Who may add a station, and who may establish one (0039). A new station
  -- that is not a proposal is a station added outright; a flag that changes on
  -- a station already here is a proposal established, or an established
  -- station taken back to proposed. All three are an administrator's
  -- (is_admin(), 0036, which says yes to the service role and to a direct
  -- connection). Anybody who may edit may propose one and edit a proposal.
  -- After the stamp checks, so a stale tab hears that first. The detail line is
  -- what tells this refusal from 42501's other meaning, "not on the editors
  -- list", which asks for something different of the person reading it.
  if not meganet.is_admin() then
    if v_is_new and not v_proposed then
      raise exception 'only an administrator adds a station outright — save it as a proposed station, and an administrator establishes it'
        using errcode = '42501',
              detail  = 'administrator',
              hint    = 'tick Proposed, give it a type and a year, and save again';
    end if;
    if not v_is_new and v_was is distinct from v_proposed then
      raise exception '%', case when v_was
                                then 'only an administrator establishes a proposed station'
                                else 'only an administrator takes an established station back to proposed' end
        using errcode = '42501',
              detail  = 'administrator';
    end if;
  end if;

  -- Gauge zero is an administrator's (0060). The rows' dates, gauge zeros and
  -- datums, as a set, must come out as the station has them; the AMTD, the
  -- catchment area and the note are anybody's who may edit. Rows with neither
  -- a gauge zero nor a datum say nothing about a level and are left out of it.
  if p_doc ? 'gauge_survey' and not meganet.is_admin() then
    if coalesce((select pg_catalog.string_agg(pg_catalog.format('%s|%s|%s|%s', g.valid_from, g.valid_to,
                                                                pg_catalog.trim_scale(g.gauge_zero_m), g.datum), ';'
                                              order by g.valid_from nulls first, g.valid_to nulls first,
                                                       g.gauge_zero_m nulls first, g.datum nulls first)
                   from meganet.station_gauge_survey g
                  where g.station_id = v_id and (g.gauge_zero_m is not null or g.datum is not null)), '')
       is distinct from
       coalesce((select pg_catalog.string_agg(pg_catalog.format('%s|%s|%s|%s', r.valid_from, r.valid_to,
                                                                pg_catalog.trim_scale(r.gauge_zero_m), r.datum), ';'
                                              order by r.valid_from nulls first, r.valid_to nulls first,
                                                       r.gauge_zero_m nulls first, r.datum nulls first)
                   from (select nullif(x.value ->> 'valid_from', '')::date              as valid_from,
                                nullif(x.value ->> 'valid_to', '')::date                as valid_to,
                                nullif(x.value ->> 'gauge_zero_m', '')::numeric         as gauge_zero_m,
                                nullif(pg_catalog.btrim(x.value ->> 'datum'), '')       as datum
                           from pg_catalog.jsonb_array_elements(p_doc -> 'gauge_survey') x(value)) r
                  where r.gauge_zero_m is not null or r.datum is not null), '') then
      raise exception 'only an administrator changes a station''s gauge zero, its datum or the dates it applies between'
        using errcode = '42501',
              detail  = 'administrator',
              hint    = 'record it in a level survey on the Level Survey tab, and an administrator applies it — the AMTD, catchment area and notes are still yours to edit';
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
    alert2_station_id, awrc_number, stream, urbs_label, proposed, station_type,
    proposed_year, tower_height, flood_peaks_from, facing_deg, deleted_at, updated_by)
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
    -- 0032's three: a blank one is null, so the view's absent-rather-than-null
    -- shape holds whichever way a row arrived.
    nullif(btrim(p_doc ->> 'awrc_number'), ''),
    nullif(btrim(p_doc ->> 'stream'), ''),
    nullif(btrim(p_doc ->> 'urbs_label'), ''),
    -- 0039's three, as asked above.
    v_proposed, v_type, v_year,
    -- 0040's, 0041's and 0044's, as asked above.
    v_tower, v_from, v_facing,
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
         awrc_number = excluded.awrc_number, stream = excluded.stream,
         urbs_label = excluded.urbs_label,
         proposed = excluded.proposed, station_type = excluded.station_type,
         proposed_year = excluded.proposed_year,
         tower_height = excluded.tower_height,
         flood_peaks_from = excluded.flood_peaks_from,
         facing_deg = excluded.facing_deg,
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

  -- ── flood classes, crossings, gauge survey (0031) ─────────────────────────
  -- Each list the editor sends is "these are the rows now", so it replaces what
  -- is there, the way the pass ranges above are replaced. A list that is not in
  -- the document at all is left exactly as it is — see the head of 0031 for why
  -- that differs from the sensors. Blank rows are dropped rather than refused: an
  -- editor's "+ Add" row left empty is not something anybody meant to save. What
  -- survives is renumbered from 0, so `ord` stays the list's own order.
  if p_doc ? 'flood_classes' then
    delete from meganet.station_flood_class where station_id = v_id;
    insert into meganet.station_flood_class (
      station_id, ord, as_at, first_report_m, crossing_height_m, crossing_type,
      minor_m, crops_grazing_m, moderate_m, towns_m, major_m, note, updated_by)
    select v_id, (row_number() over (order by r.ord))::integer - 1,
           r.as_at, r.first_report_m, r.crossing_height_m, r.crossing_type,
           r.minor_m, r.crops_grazing_m, r.moderate_m, r.towns_m, r.major_m, r.note, v_actor
      from (
        select x.ord,
               nullif(x.value ->> 'as_at', '')::date                   as as_at,
               nullif(x.value ->> 'first_report_m', '')::numeric       as first_report_m,
               nullif(x.value ->> 'crossing_height_m', '')::numeric    as crossing_height_m,
               nullif(btrim(x.value ->> 'crossing_type'), '')          as crossing_type,
               nullif(x.value ->> 'minor_m', '')::numeric              as minor_m,
               nullif(x.value ->> 'crops_grazing_m', '')::numeric      as crops_grazing_m,
               nullif(x.value ->> 'moderate_m', '')::numeric           as moderate_m,
               nullif(x.value ->> 'towns_m', '')::numeric              as towns_m,
               nullif(x.value ->> 'major_m', '')::numeric              as major_m,
               nullif(btrim(x.value ->> 'note'), '')                   as note
          from jsonb_array_elements(p_doc -> 'flood_classes') with ordinality x(value, ord)
      ) r
     where num_nonnulls(r.first_report_m, r.crossing_height_m, r.crossing_type, r.minor_m,
                        r.crops_grazing_m, r.moderate_m, r.towns_m, r.major_m, r.note) > 0;
  end if;

  if p_doc ? 'crossings' then
    delete from meganet.station_crossing where station_id = v_id;
    insert into meganet.station_crossing (
      station_id, ord, as_at, stream, name, height_m, crossing_type, note, updated_by)
    select v_id, (row_number() over (order by r.ord))::integer - 1,
           r.as_at, r.stream, r.name, r.height_m, r.crossing_type, r.note, v_actor
      from (
        select x.ord,
               nullif(x.value ->> 'as_at', '')::date                as as_at,
               nullif(btrim(x.value ->> 'stream'), '')              as stream,
               nullif(btrim(x.value ->> 'name'), '')                as name,
               nullif(x.value ->> 'height_m', '')::numeric          as height_m,
               nullif(btrim(x.value ->> 'crossing_type'), '')       as crossing_type,
               nullif(btrim(x.value ->> 'note'), '')                as note
          from jsonb_array_elements(p_doc -> 'crossings') with ordinality x(value, ord)
      ) r
     where num_nonnulls(r.stream, r.name, r.height_m, r.crossing_type, r.note) > 0;
  end if;

  if p_doc ? 'gauge_survey' then
    delete from meganet.station_gauge_survey where station_id = v_id;
    insert into meganet.station_gauge_survey (
      station_id, ord, valid_from, valid_to, gauge_zero_m, datum, amtd_km,
      catchment_area_km2, note, updated_by)
    select v_id, (row_number() over (order by r.ord))::integer - 1,
           r.valid_from, r.valid_to, r.gauge_zero_m, r.datum, r.amtd_km,
           r.catchment_area_km2, r.note, v_actor
      from (
        select x.ord,
               nullif(x.value ->> 'valid_from', '')::date                as valid_from,
               nullif(x.value ->> 'valid_to', '')::date                  as valid_to,
               nullif(x.value ->> 'gauge_zero_m', '')::numeric           as gauge_zero_m,
               nullif(btrim(x.value ->> 'datum'), '')                    as datum,
               nullif(x.value ->> 'amtd_km', '')::numeric                as amtd_km,
               nullif(x.value ->> 'catchment_area_km2', '')::numeric     as catchment_area_km2,
               nullif(btrim(x.value ->> 'note'), '')                     as note
          from jsonb_array_elements(p_doc -> 'gauge_survey') with ordinality x(value, ord)
      ) r
     where num_nonnulls(r.gauge_zero_m, r.datum, r.amtd_km, r.catchment_area_km2, r.note) > 0;
  end if;

  -- ── index listings, flood effects (0032) ─────────────────────────────────
  -- 0031's rule for 0031's lists: present replaces, absent leaves alone, blank
  -- rows go, and what is left is renumbered from 0.
  if p_doc ? 'bureau_listings' then
    delete from meganet.station_bureau_listing where station_id = v_id;
    insert into meganet.station_bureau_listing (
      station_id, ord, section, as_at, note, updated_by)
    select v_id, (row_number() over (order by r.ord))::integer - 1,
           r.section, r.as_at, r.note, v_actor
      from (
        select x.ord,
               nullif(btrim(x.value ->> 'section'), '')        as section,
               nullif(x.value ->> 'as_at', '')::date           as as_at,
               nullif(btrim(x.value ->> 'note'), '')           as note
          from jsonb_array_elements(p_doc -> 'bureau_listings') with ordinality x(value, ord)
      ) r
     where r.section is not null;
  end if;

  if p_doc ? 'flood_effects' then
    delete from meganet.station_flood_effect where station_id = v_id;
    insert into meganet.station_flood_effect (
      station_id, ord, as_at, height_m, effect, detail, note, updated_by)
    select v_id, (row_number() over (order by r.ord))::integer - 1,
           r.as_at, r.height_m, r.effect, r.detail, r.note, v_actor
      from (
        select x.ord,
               nullif(x.value ->> 'as_at', '')::date           as as_at,
               nullif(x.value ->> 'height_m', '')::numeric     as height_m,
               nullif(btrim(x.value ->> 'effect'), '')         as effect,
               nullif(btrim(x.value ->> 'detail'), '')         as detail,
               nullif(btrim(x.value ->> 'note'), '')           as note
          from jsonb_array_elements(p_doc -> 'flood_effects') with ordinality x(value, ord)
      ) r
     where num_nonnulls(r.height_m, r.effect, r.detail, r.note) > 0;
  end if;

  -- ── AEP levels, frequencies (0033) ────────────────────────────────────────
  -- 0031's rule: the list the editor sends replaces what is there, a list it
  -- does not send is left alone, and a blank row is dropped.
  if p_doc ? 'aep_levels' then
    delete from meganet.station_aep_level where station_id = v_id;
    insert into meganet.station_aep_level (
      station_id, ord, as_at, source, point_lat, point_lon, ground_m, aep_1_m,
      aep_0_5_m, aep_0_2_m, aep_0_066_m, data_quality, level_difference, confidence,
      setting, slope, slope_basis, manning_n, note, updated_by)
    select v_id, (row_number() over (order by r.ord))::integer - 1,
           r.as_at, r.source, r.point_lat, r.point_lon, r.ground_m, r.aep_1_m,
           r.aep_0_5_m, r.aep_0_2_m, r.aep_0_066_m, r.data_quality, r.level_difference,
           r.confidence, r.setting, r.slope, r.slope_basis, r.manning_n, r.note, v_actor
      from (
        select x.ord,
               nullif(x.value ->> 'as_at', '')::date                as as_at,
               nullif(btrim(x.value ->> 'source'), '')              as source,
               nullif(x.value ->> 'point_lat', '')::numeric         as point_lat,
               nullif(x.value ->> 'point_lon', '')::numeric         as point_lon,
               nullif(x.value ->> 'ground_m', '')::numeric          as ground_m,
               nullif(x.value ->> 'aep_1_m', '')::numeric           as aep_1_m,
               nullif(x.value ->> 'aep_0_5_m', '')::numeric         as aep_0_5_m,
               nullif(x.value ->> 'aep_0_2_m', '')::numeric         as aep_0_2_m,
               nullif(x.value ->> 'aep_0_066_m', '')::numeric       as aep_0_066_m,
               nullif(x.value ->> 'data_quality', '')::integer      as data_quality,
               nullif(x.value ->> 'level_difference', '')::integer  as level_difference,
               nullif(x.value ->> 'confidence', '')::integer        as confidence,
               nullif(btrim(x.value ->> 'setting'), '')             as setting,
               nullif(x.value ->> 'slope', '')::numeric             as slope,
               nullif(btrim(x.value ->> 'slope_basis'), '')         as slope_basis,
               nullif(x.value ->> 'manning_n', '')::numeric         as manning_n,
               nullif(btrim(x.value ->> 'note'), '')                as note
          from jsonb_array_elements(p_doc -> 'aep_levels') with ordinality x(value, ord)
      ) r
     where num_nonnulls(r.ground_m, r.aep_1_m, r.aep_0_5_m, r.aep_0_2_m, r.aep_0_066_m,
                        r.setting, r.slope, r.manning_n, r.note) > 0;
  end if;

  if p_doc ? 'frequencies' then
    delete from meganet.station_frequency where station_id = v_id;
    insert into meganet.station_frequency (
      station_id, ord, rx_mhz, tx_mhz, label, acma_licence, updated_by)
    select v_id, (row_number() over (order by r.ord))::integer - 1,
           r.rx_mhz, r.tx_mhz, r.label, r.acma_licence, v_actor
      from (
        select x.ord,
               nullif(x.value ->> 'rx_mhz', '')::numeric        as rx_mhz,
               nullif(x.value ->> 'tx_mhz', '')::numeric        as tx_mhz,
               nullif(btrim(x.value ->> 'label'), '')           as label,
               nullif(btrim(x.value ->> 'acma_licence'), '')    as acma_licence
          from jsonb_array_elements(p_doc -> 'frequencies') with ordinality x(value, ord)
      ) r
     where num_nonnulls(r.rx_mhz, r.tx_mhz) > 0;
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

revoke all on function meganet.save_station(jsonb, timestamptz) from public;
do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated')
     and exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    grant execute on function meganet.save_station(jsonb, timestamptz) to authenticated, service_role;
  end if;
end
$$;

do $$
begin
  if pg_catalog.pg_get_functiondef('meganet.save_station(jsonb, timestamptz)'::regprocedure) not like '%v_delay > 9999%' then
    raise exception '0117 did not take: save_station() still stops a delay at 999';
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conrelid = 'meganet.repeater'::regclass and conname = 'repeater_delay_ms_check'
                    and pg_catalog.pg_get_constraintdef(oid) like '%9999%') then
    raise exception '0117 did not take: the delay check is not 9999';
  end if;
end
$$;

insert into meganet.app_meta (key, value)
values ('schema_version', '117')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;

notify pgrst, 'reload schema';
