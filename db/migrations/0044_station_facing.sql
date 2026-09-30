-- 0044_station_facing.sql — The way a station faces, recorded on the station.
--
-- Why this file exists
-- ────────────────────
-- The Digital Twin draws every station square to the compass: a pole's
-- enclosure door and a tower's ladder on the south, its solar panel and
-- cabinet on the north. Stations on the ground are not all built that way —
-- a tower's ladder goes where the bank lets it, a pole's door where the
-- observer walks up — so a twin that stands every one of them facing south
-- is wrong about the side the operator will be looking for. The twin's
-- ↻ Orientation tool turns the model; this is where the answer is kept, so
-- everybody sees the same station.
--
--   facing_deg   the bearing the station's front faces, in degrees clockwise
--                from true north, 0 up to but not 360 — the front being the
--                side its enclosure door, or a tower's ladder, is on. Null
--                where nobody has recorded it, and the twin then draws it
--                facing south (180), as it always has, and says so.
--
-- Allowed on any station, as tower_height (0040) is: what the twin draws for a
-- station is its reading of the record, which can change.
--
-- Who may do what
-- ───────────────
-- Whoever may edit the station (meganet.is_editor(), 0004) — through
-- save_station(), from the station editor or the twin's Orientation tool,
-- which saves it the way the tower's height is saved from the Scene panel.
--
-- What is stored, and in what shape
-- ─────────────────────────────────
-- One column, numeric(4,1), and in the station document an optional key,
-- absent where null, so stations.json gains nothing until somebody records one.
--
-- What had to be restated
-- ───────────────────────
-- 0041's station_json, save_station() (without which the editor would null the
-- bearing on the next save) and load_stations_doc(), verbatim with the one key
-- threaded through; facing_deg is in both halves of the `is distinct from` pair
-- so a bearing-only re-import is not read as "nothing changed". Same
-- signatures, so no grants are repeated; 0029 says why.
--
-- Idempotent and forward-only, per db/README.md.

-- ── The column ───────────────────────────────────────────────────────────────

alter table meganet.station add column if not exists facing_deg numeric(4,1);

comment on column meganet.station.facing_deg is
  'The bearing the station''s front faces — the side its enclosure door, or a '
  'tower''s ladder, is on — in degrees clockwise from true north, 0 up to but '
  'not 360 (0044). Null means not recorded, and the Digital Twin draws it '
  'facing south.';

alter table meganet.station drop constraint if exists station_facing_deg_bearing;
alter table meganet.station add constraint station_facing_deg_bearing
  check (facing_deg >= 0 and facing_deg < 360);

-- ── meganet.station_json — 0041's view, plus the way the station faces ────

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
),
-- The three lists 0031 added, each in its `ord` and each row with its nulls
-- stripped: a row states what the list printed and nothing else, so a flood
-- class with no crops-and-grazing level has no such key rather than a null one.
flood_doc as (
  select station_id,
         jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'as_at',             as_at,
           'first_report_m',    first_report_m,
           'crossing_height_m', crossing_height_m,
           'crossing_type',     crossing_type,
           'minor_m',           minor_m,
           'crops_grazing_m',   crops_grazing_m,
           'moderate_m',        moderate_m,
           'towns_m',           towns_m,
           'major_m',           major_m,
           'note',              note
         )) order by ord) as doc
    from meganet.station_flood_class
   group by station_id
),
crossing_doc as (
  select station_id,
         jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'as_at',         as_at,
           'stream',        stream,
           'name',          name,
           'height_m',      height_m,
           'crossing_type', crossing_type,
           'note',          note
         )) order by ord) as doc
    from meganet.station_crossing
   group by station_id
),
survey_doc as (
  select station_id,
         jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'valid_from',         valid_from,
           'valid_to',           valid_to,
           'gauge_zero_m',       gauge_zero_m,
           'datum',              datum,
           'amtd_km',            amtd_km,
           'catchment_area_km2', catchment_area_km2,
           'note',               note
         )) order by ord) as doc
    from meganet.station_gauge_survey
   group by station_id
),
-- The two lists 0032 added, 0031's way: in `ord`, nulls stripped.
listing_doc as (
  select station_id,
         jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'section', section,
           'as_at',   as_at,
           'note',    note
         )) order by ord) as doc
    from meganet.station_bureau_listing
   group by station_id
),
effect_doc as (
  select station_id,
         jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'as_at',    as_at,
           'height_m', height_m,
           'effect',   effect,
           'detail',   detail,
           'note',     note
         )) order by ord) as doc
    from meganet.station_flood_effect
   group by station_id
),
-- The two lists 0033 added, on the same terms as 0031's and 0032's: in `ord`,
-- nulls stripped per row, absent where a station has none.
aep_doc as (
  select station_id,
         jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'as_at',            as_at,
           'source',           source,
           'point_lat',        point_lat,
           'point_lon',        point_lon,
           'ground_m',         ground_m,
           'aep_1_m',          aep_1_m,
           'aep_0_5_m',        aep_0_5_m,
           'aep_0_2_m',        aep_0_2_m,
           'aep_0_066_m',      aep_0_066_m,
           'data_quality',     data_quality,
           'level_difference', level_difference,
           'confidence',       confidence,
           'setting',          setting,
           'slope',            slope,
           'slope_basis',      slope_basis,
           'manning_n',        manning_n,
           'note',             note
         )) order by ord) as doc
    from meganet.station_aep_level
   group by station_id
),
freq_doc as (
  select station_id,
         jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'rx_mhz',       rx_mhz,
           'tx_mhz',       tx_mhz,
           'label',        label,
           'acma_licence', acma_licence
         )) order by ord) as doc
    from meganet.station_frequency
   group by station_id
),
-- 0037's: the station's five largest floods, largest first, as kept in
-- station_flood_peak_top — station_flood_peaks() decides which five and at
-- what level. The level is absent where the peak cannot be put on the ground,
-- and the row says only what the record does: a date, a height on the gauge,
-- and a level if there is one.
-- 0041: the gauge a station's floods came from, where it is not the station's
-- own — the peaks of the station it takes its flood history from.
borrow_doc as (
  select t.station_id, min(t.bureau_number) as bureau_number
    from meganet.station_flood_peak_top t
    join meganet.station s on s.id = t.station_id
   where meganet.bureau_key(t.bureau_number) is distinct from meganet.bureau_key(s.station_number)
   group by t.station_id
),
peak_doc as (
  select station_id,
         jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'date',        date_text,
           'height_m',    height_m,
           'level_m_ahd', level_m_ahd
         )) order by flood_rank) as doc
    from meganet.station_flood_peak_top
   group by station_id
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
       -- 0032's three, absent where not recorded: most stations are in none of
       -- the Bureau's lists and would otherwise each carry three nulls.
       || case when s.awrc_number is null then '{}'::jsonb
               else jsonb_build_object('awrc_number', s.awrc_number) end
       || case when s.stream is null then '{}'::jsonb
               else jsonb_build_object('stream', s.stream) end
       || case when s.urbs_label is null then '{}'::jsonb
               else jsonb_build_object('urbs_label', s.urbs_label) end
       -- 0039's three: `proposed` only where it is true, the type and the year
       -- absent where nobody has said — a station on the ground that was never
       -- proposed gains none of them, and stations.json is unchanged by them.
       || case when s.proposed then jsonb_build_object('proposed', true)
               else '{}'::jsonb end
       || case when s.station_type is null then '{}'::jsonb
               else jsonb_build_object('station_type', s.station_type) end
       || case when s.proposed_year is null then '{}'::jsonb
               else jsonb_build_object('proposed_year', s.proposed_year) end
       -- 0040: the tower's platform height, absent where nobody has recorded
       -- one — the Digital Twin then draws the 3.0 m default.
       || case when s.tower_height is null then '{}'::jsonb
               else jsonb_build_object('tower_height', s.tower_height) end
       -- 0041: the station it takes its flood history from, and — where its
       -- floods are that station's rather than its own — that gauge's number.
       || case when s.flood_peaks_from is null then '{}'::jsonb
               else jsonb_build_object('flood_peaks_from', s.flood_peaks_from) end
       || case when bd.bureau_number is null then '{}'::jsonb
               else jsonb_build_object('flood_peaks_gauge', bd.bureau_number) end
       -- 0044: the bearing the station's front faces, absent where nobody has
       -- recorded one — the Digital Twin then draws it facing south.
       || case when s.facing_deg is null then '{}'::jsonb
               else jsonb_build_object('facing_deg', s.facing_deg) end
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
       -- Absent rather than empty where a station has no rows, like `sensors`:
       -- most stations are in none of the Bureau's lists.
       || case when fd.doc is null then '{}'::jsonb
               else jsonb_build_object('flood_classes', fd.doc) end
       || case when cd.doc is null then '{}'::jsonb
               else jsonb_build_object('crossings', cd.doc) end
       || case when gd.doc is null then '{}'::jsonb
               else jsonb_build_object('gauge_survey', gd.doc) end
       || case when ld.doc is null then '{}'::jsonb
               else jsonb_build_object('bureau_listings', ld.doc) end
       || case when ed.doc is null then '{}'::jsonb
               else jsonb_build_object('flood_effects', ed.doc) end
       -- Absent rather than empty for the same reason: most stations are in
       -- neither AEP sheet, and all but the repeaters and base stations have no
       -- frequency beyond the repeater's own.
       || case when ad.doc is null then '{}'::jsonb
               else jsonb_build_object('aep_levels', ad.doc) end
       || case when qd.doc is null then '{}'::jsonb
               else jsonb_build_object('frequencies', qd.doc) end
       -- Absent where HDB lists no peaks for the station's gauge — most of them.
       || case when pd.doc is null then '{}'::jsonb
               else jsonb_build_object('flood_peaks', pd.doc) end
       as doc
  from meganet.station s
  left join sensor_doc sd on sd.station_id = s.id
  left join meganet.repeater r on r.station_id = s.id
  left join range_doc rd on rd.repeater_id = s.id
  left join flood_doc fd on fd.station_id = s.id
  left join crossing_doc cd on cd.station_id = s.id
  left join survey_doc gd on gd.station_id = s.id
  left join listing_doc ld on ld.station_id = s.id
  left join effect_doc ed on ed.station_id = s.id
  left join aep_doc ad on ad.station_id = s.id
  left join freq_doc qd on qd.station_id = s.id
  left join peak_doc pd on pd.station_id = s.id
  left join borrow_doc bd on bd.station_id = s.id
 where s.deleted_at is null;

-- ── meganet.save_station() — 0041's function, plus facing_deg ───────────────

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

-- ── meganet.load_stations_doc() — 0041's function, plus facing_deg ──────────

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
  n_flood      integer;
  n_crossing   integer;
  n_survey     integer;
  n_listing    integer;
  n_effect     integer;
  n_aep        integer;
  n_freq       integer;
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
                               inspection_config_key, awrc_number, stream, urbs_label,
                               proposed, station_type, proposed_year, tower_height,
                               flood_peaks_from, facing_deg, updated_by)
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
         nullif(btrim(e.value ->> 'awrc_number'), ''),
         nullif(btrim(e.value ->> 'stream'), ''),
         nullif(btrim(e.value ->> 'urbs_label'), ''),
         coalesce((e.value ->> 'proposed')::boolean, false),
         nullif(btrim(e.value ->> 'station_type'), ''),
         nullif(btrim(e.value ->> 'proposed_year'), '')::integer,
         nullif(btrim(e.value ->> 'tower_height'), '')::numeric,
         nullif(btrim(e.value ->> 'flood_peaks_from'), ''),
         nullif(btrim(e.value ->> 'facing_deg'), '')::numeric,
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
         awrc_number = excluded.awrc_number, stream = excluded.stream,
         urbs_label = excluded.urbs_label,
         proposed = excluded.proposed, station_type = excluded.station_type,
         proposed_year = excluded.proposed_year,
         tower_height = excluded.tower_height,
         flood_peaks_from = excluded.flood_peaks_from,
         facing_deg = excluded.facing_deg,
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
          meganet.station.tbrg_bucket_size, meganet.station.inspection_config_key,
          meganet.station.awrc_number, meganet.station.stream, meganet.station.urbs_label,
          meganet.station.proposed, meganet.station.station_type, meganet.station.proposed_year,
          meganet.station.tower_height, meganet.station.flood_peaks_from,
          meganet.station.facing_deg)
      is distinct from (excluded.ord, excluded.name, excluded.station_number, excluded.lat,
          excluded.lon, excluded.elevation_ahd, excluded.elevation_source, excluded.owner,
          excluded.roles, excluded.radio_network_ids,
          excluded.catchment_ids, excluded.alert_ids, excluded.satcom, excluded.rm_system_id,
          excluded.enabled, excluded.notes, excluded.legacy_unit_id, excluded.site,
          excluded.lga, excluded.basin, excluded.hub_id, excluded.location_types,
          excluded.tbrg_bucket_size, excluded.inspection_config_key,
          excluded.awrc_number, excluded.stream, excluded.urbs_label,
          excluded.proposed, excluded.station_type, excluded.proposed_year,
          excluded.tower_height, excluded.flood_peaks_from, excluded.facing_deg);

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

  -- ── flood classes, crossings, gauge survey (0031) ─────────────────────────
  -- The sensors' rule, three times: upsert what the document carries by
  -- (station, position), touch only a row that actually differs, then remove the
  -- positions past the end of each station's list — for document-managed
  -- stations only, since it is the station's provenance that decides. Absent is
  -- empty here, as everywhere else in a sync.
  insert into meganet.station_flood_class (
    station_id, ord, as_at, first_report_m, crossing_height_m, crossing_type,
    minor_m, crops_grazing_m, moderate_m, towns_m, major_m, note, updated_by)
  select s.value ->> 'id', (x.ord - 1)::integer,
         (x.value ->> 'as_at')::date,
         (x.value ->> 'first_report_m')::numeric, (x.value ->> 'crossing_height_m')::numeric,
         x.value ->> 'crossing_type',
         (x.value ->> 'minor_m')::numeric, (x.value ->> 'crops_grazing_m')::numeric,
         (x.value ->> 'moderate_m')::numeric, (x.value ->> 'towns_m')::numeric,
         (x.value ->> 'major_m')::numeric, x.value ->> 'note', 'load_stations_doc'
    from jsonb_array_elements(doc -> 'stations') s
    cross join lateral jsonb_array_elements(coalesce(s.value -> 'flood_classes', '[]'::jsonb))
               with ordinality x(value, ord)
  on conflict (station_id, ord) do update
     set as_at = excluded.as_at, first_report_m = excluded.first_report_m,
         crossing_height_m = excluded.crossing_height_m,
         crossing_type = excluded.crossing_type, minor_m = excluded.minor_m,
         crops_grazing_m = excluded.crops_grazing_m, moderate_m = excluded.moderate_m,
         towns_m = excluded.towns_m, major_m = excluded.major_m, note = excluded.note,
         updated_by = excluded.updated_by
   where (meganet.station_flood_class.as_at, meganet.station_flood_class.first_report_m,
          meganet.station_flood_class.crossing_height_m,
          meganet.station_flood_class.crossing_type, meganet.station_flood_class.minor_m,
          meganet.station_flood_class.crops_grazing_m,
          meganet.station_flood_class.moderate_m, meganet.station_flood_class.towns_m,
          meganet.station_flood_class.major_m, meganet.station_flood_class.note)
      is distinct from (excluded.as_at, excluded.first_report_m, excluded.crossing_height_m,
          excluded.crossing_type, excluded.minor_m, excluded.crops_grazing_m,
          excluded.moderate_m, excluded.towns_m, excluded.major_m, excluded.note);

  delete from meganet.station_flood_class t
   where exists (select 1 from meganet.station st
                  where st.id = t.station_id and st.document_managed)
     and not exists (select 1 from jsonb_array_elements(doc -> 'stations') s
                      where s.value ->> 'id' = t.station_id
                        and t.ord < jsonb_array_length(
                                      coalesce(s.value -> 'flood_classes', '[]'::jsonb)));

  insert into meganet.station_crossing (
    station_id, ord, as_at, stream, name, height_m, crossing_type, note, updated_by)
  select s.value ->> 'id', (x.ord - 1)::integer,
         (x.value ->> 'as_at')::date, x.value ->> 'stream', x.value ->> 'name',
         (x.value ->> 'height_m')::numeric, x.value ->> 'crossing_type',
         x.value ->> 'note', 'load_stations_doc'
    from jsonb_array_elements(doc -> 'stations') s
    cross join lateral jsonb_array_elements(coalesce(s.value -> 'crossings', '[]'::jsonb))
               with ordinality x(value, ord)
  on conflict (station_id, ord) do update
     set as_at = excluded.as_at, stream = excluded.stream, name = excluded.name,
         height_m = excluded.height_m, crossing_type = excluded.crossing_type,
         note = excluded.note, updated_by = excluded.updated_by
   where (meganet.station_crossing.as_at, meganet.station_crossing.stream,
          meganet.station_crossing.name, meganet.station_crossing.height_m,
          meganet.station_crossing.crossing_type, meganet.station_crossing.note)
      is distinct from (excluded.as_at, excluded.stream, excluded.name,
          excluded.height_m, excluded.crossing_type, excluded.note);

  delete from meganet.station_crossing t
   where exists (select 1 from meganet.station st
                  where st.id = t.station_id and st.document_managed)
     and not exists (select 1 from jsonb_array_elements(doc -> 'stations') s
                      where s.value ->> 'id' = t.station_id
                        and t.ord < jsonb_array_length(
                                      coalesce(s.value -> 'crossings', '[]'::jsonb)));

  insert into meganet.station_gauge_survey (
    station_id, ord, valid_from, valid_to, gauge_zero_m, datum, amtd_km,
    catchment_area_km2, note, updated_by)
  select s.value ->> 'id', (x.ord - 1)::integer,
         (x.value ->> 'valid_from')::date, (x.value ->> 'valid_to')::date,
         (x.value ->> 'gauge_zero_m')::numeric, x.value ->> 'datum',
         (x.value ->> 'amtd_km')::numeric, (x.value ->> 'catchment_area_km2')::numeric,
         x.value ->> 'note', 'load_stations_doc'
    from jsonb_array_elements(doc -> 'stations') s
    cross join lateral jsonb_array_elements(coalesce(s.value -> 'gauge_survey', '[]'::jsonb))
               with ordinality x(value, ord)
  on conflict (station_id, ord) do update
     set valid_from = excluded.valid_from, valid_to = excluded.valid_to,
         gauge_zero_m = excluded.gauge_zero_m, datum = excluded.datum,
         amtd_km = excluded.amtd_km, catchment_area_km2 = excluded.catchment_area_km2,
         note = excluded.note, updated_by = excluded.updated_by
   where (meganet.station_gauge_survey.valid_from, meganet.station_gauge_survey.valid_to,
          meganet.station_gauge_survey.gauge_zero_m, meganet.station_gauge_survey.datum,
          meganet.station_gauge_survey.amtd_km,
          meganet.station_gauge_survey.catchment_area_km2, meganet.station_gauge_survey.note)
      is distinct from (excluded.valid_from, excluded.valid_to, excluded.gauge_zero_m,
          excluded.datum, excluded.amtd_km, excluded.catchment_area_km2, excluded.note);

  delete from meganet.station_gauge_survey t
   where exists (select 1 from meganet.station st
                  where st.id = t.station_id and st.document_managed)
     and not exists (select 1 from jsonb_array_elements(doc -> 'stations') s
                      where s.value ->> 'id' = t.station_id
                        and t.ord < jsonb_array_length(
                                      coalesce(s.value -> 'gauge_survey', '[]'::jsonb)));

  -- ── index listings, flood effects (0032) ─────────────────────────────────
  -- The same sync, twice more.
  insert into meganet.station_bureau_listing (station_id, ord, section, as_at, note, updated_by)
  select s.value ->> 'id', (x.ord - 1)::integer,
         x.value ->> 'section', (x.value ->> 'as_at')::date, x.value ->> 'note',
         'load_stations_doc'
    from jsonb_array_elements(doc -> 'stations') s
    cross join lateral jsonb_array_elements(coalesce(s.value -> 'bureau_listings', '[]'::jsonb))
               with ordinality x(value, ord)
  on conflict (station_id, ord) do update
     set section = excluded.section, as_at = excluded.as_at, note = excluded.note,
         updated_by = excluded.updated_by
   where (meganet.station_bureau_listing.section, meganet.station_bureau_listing.as_at,
          meganet.station_bureau_listing.note)
      is distinct from (excluded.section, excluded.as_at, excluded.note);

  delete from meganet.station_bureau_listing t
   where exists (select 1 from meganet.station st
                  where st.id = t.station_id and st.document_managed)
     and not exists (select 1 from jsonb_array_elements(doc -> 'stations') s
                      where s.value ->> 'id' = t.station_id
                        and t.ord < jsonb_array_length(
                                      coalesce(s.value -> 'bureau_listings', '[]'::jsonb)));

  insert into meganet.station_flood_effect (
    station_id, ord, as_at, height_m, effect, detail, note, updated_by)
  select s.value ->> 'id', (x.ord - 1)::integer,
         (x.value ->> 'as_at')::date, (x.value ->> 'height_m')::numeric,
         x.value ->> 'effect', x.value ->> 'detail', x.value ->> 'note', 'load_stations_doc'
    from jsonb_array_elements(doc -> 'stations') s
    cross join lateral jsonb_array_elements(coalesce(s.value -> 'flood_effects', '[]'::jsonb))
               with ordinality x(value, ord)
  on conflict (station_id, ord) do update
     set as_at = excluded.as_at, height_m = excluded.height_m, effect = excluded.effect,
         detail = excluded.detail, note = excluded.note, updated_by = excluded.updated_by
   where (meganet.station_flood_effect.as_at, meganet.station_flood_effect.height_m,
          meganet.station_flood_effect.effect, meganet.station_flood_effect.detail,
          meganet.station_flood_effect.note)
      is distinct from (excluded.as_at, excluded.height_m, excluded.effect,
          excluded.detail, excluded.note);

  delete from meganet.station_flood_effect t
   where exists (select 1 from meganet.station st
                  where st.id = t.station_id and st.document_managed)
     and not exists (select 1 from jsonb_array_elements(doc -> 'stations') s
                      where s.value ->> 'id' = t.station_id
                        and t.ord < jsonb_array_length(
                                      coalesce(s.value -> 'flood_effects', '[]'::jsonb)));

  -- ── AEP levels, frequencies (0033) ────────────────────────────────────────
  -- 0031's rule for its three lists, twice more.
  insert into meganet.station_aep_level (
    station_id, ord, as_at, source, point_lat, point_lon, ground_m, aep_1_m,
    aep_0_5_m, aep_0_2_m, aep_0_066_m, data_quality, level_difference, confidence,
    setting, slope, slope_basis, manning_n, note, updated_by)
  select s.value ->> 'id', (x.ord - 1)::integer,
         (x.value ->> 'as_at')::date, x.value ->> 'source',
         (x.value ->> 'point_lat')::numeric, (x.value ->> 'point_lon')::numeric,
         (x.value ->> 'ground_m')::numeric,
         (x.value ->> 'aep_1_m')::numeric, (x.value ->> 'aep_0_5_m')::numeric,
         (x.value ->> 'aep_0_2_m')::numeric, (x.value ->> 'aep_0_066_m')::numeric,
         (x.value ->> 'data_quality')::integer, (x.value ->> 'level_difference')::integer,
         (x.value ->> 'confidence')::integer, x.value ->> 'setting',
         (x.value ->> 'slope')::numeric, x.value ->> 'slope_basis',
         (x.value ->> 'manning_n')::numeric, x.value ->> 'note', 'load_stations_doc'
    from jsonb_array_elements(doc -> 'stations') s
    cross join lateral jsonb_array_elements(coalesce(s.value -> 'aep_levels', '[]'::jsonb))
               with ordinality x(value, ord)
  on conflict (station_id, ord) do update
     set as_at = excluded.as_at, source = excluded.source,
         point_lat = excluded.point_lat, point_lon = excluded.point_lon,
         ground_m = excluded.ground_m, aep_1_m = excluded.aep_1_m,
         aep_0_5_m = excluded.aep_0_5_m, aep_0_2_m = excluded.aep_0_2_m,
         aep_0_066_m = excluded.aep_0_066_m, data_quality = excluded.data_quality,
         level_difference = excluded.level_difference, confidence = excluded.confidence,
         setting = excluded.setting, slope = excluded.slope,
         slope_basis = excluded.slope_basis, manning_n = excluded.manning_n,
         note = excluded.note, updated_by = excluded.updated_by
   where (meganet.station_aep_level.as_at, meganet.station_aep_level.source,
          meganet.station_aep_level.point_lat, meganet.station_aep_level.point_lon,
          meganet.station_aep_level.ground_m, meganet.station_aep_level.aep_1_m,
          meganet.station_aep_level.aep_0_5_m, meganet.station_aep_level.aep_0_2_m,
          meganet.station_aep_level.aep_0_066_m, meganet.station_aep_level.data_quality,
          meganet.station_aep_level.level_difference, meganet.station_aep_level.confidence,
          meganet.station_aep_level.setting, meganet.station_aep_level.slope,
          meganet.station_aep_level.slope_basis, meganet.station_aep_level.manning_n,
          meganet.station_aep_level.note)
      is distinct from (excluded.as_at, excluded.source, excluded.point_lat,
          excluded.point_lon, excluded.ground_m, excluded.aep_1_m, excluded.aep_0_5_m,
          excluded.aep_0_2_m, excluded.aep_0_066_m, excluded.data_quality,
          excluded.level_difference, excluded.confidence, excluded.setting,
          excluded.slope, excluded.slope_basis, excluded.manning_n, excluded.note);

  delete from meganet.station_aep_level t
   where exists (select 1 from meganet.station st
                  where st.id = t.station_id and st.document_managed)
     and not exists (select 1 from jsonb_array_elements(doc -> 'stations') s
                      where s.value ->> 'id' = t.station_id
                        and t.ord < jsonb_array_length(
                                      coalesce(s.value -> 'aep_levels', '[]'::jsonb)));

  insert into meganet.station_frequency (
    station_id, ord, rx_mhz, tx_mhz, label, acma_licence, updated_by)
  select s.value ->> 'id', (x.ord - 1)::integer,
         (x.value ->> 'rx_mhz')::numeric, (x.value ->> 'tx_mhz')::numeric,
         x.value ->> 'label', x.value ->> 'acma_licence', 'load_stations_doc'
    from jsonb_array_elements(doc -> 'stations') s
    cross join lateral jsonb_array_elements(coalesce(s.value -> 'frequencies', '[]'::jsonb))
               with ordinality x(value, ord)
  on conflict (station_id, ord) do update
     set rx_mhz = excluded.rx_mhz, tx_mhz = excluded.tx_mhz, label = excluded.label,
         acma_licence = excluded.acma_licence, updated_by = excluded.updated_by
   where (meganet.station_frequency.rx_mhz, meganet.station_frequency.tx_mhz,
          meganet.station_frequency.label, meganet.station_frequency.acma_licence)
      is distinct from (excluded.rx_mhz, excluded.tx_mhz, excluded.label,
          excluded.acma_licence);

  delete from meganet.station_frequency t
   where exists (select 1 from meganet.station st
                  where st.id = t.station_id and st.document_managed)
     and not exists (select 1 from jsonb_array_elements(doc -> 'stations') s
                      where s.value ->> 'id' = t.station_id
                        and t.ord < jsonb_array_length(
                                      coalesce(s.value -> 'frequencies', '[]'::jsonb)));

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
  select count(*) into n_flood    from meganet.station_flood_class;
  select count(*) into n_crossing from meganet.station_crossing;
  select count(*) into n_survey   from meganet.station_gauge_survey;
  select count(*) into n_listing  from meganet.station_bureau_listing;
  select count(*) into n_effect   from meganet.station_flood_effect;
  select count(*) into n_aep      from meganet.station_aep_level;
  select count(*) into n_freq     from meganet.station_frequency;

  -- Said out loud on every run rather than left to be discovered: a range whose
  -- low is above its high passes no address at all, here or in the app.
  if n_inverted > 0 then
    raise notice 'note: % pass range(s) are inverted and match no address', n_inverted;
  end if;

  return format('loaded %s stations, %s sensors, %s repeaters, %s pass ranges, '
                '%s flood classes, %s crossings, %s gauge surveys, %s index listings, '
                '%s flood effects, %s AEP level rows, %s frequencies%s',
                n_station, n_sensor, n_repeater, n_range, n_flood, n_crossing, n_survey,
                n_listing, n_effect, n_aep, n_freq,
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
                    and definition like '%''facing_deg''%'
                    and definition like '%''flood_peaks_from''%'
                    and definition like '%''tower_height''%') then
    raise exception '0044 did not take: station_json does not emit facing_deg';
  end if;
  if (select count(*) from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'meganet' and p.proname = 'save_station'
         and p.prosrc like '%excluded.facing_deg%'
         and p.prosrc like '%excluded.flood_peaks_from%') = 0 then
    raise exception '0044 did not take: save_station does not write facing_deg';
  end if;
  if (select count(*) from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'meganet' and p.proname = 'load_stations_doc'
         and p.prosrc like '%excluded.facing_deg%') = 0 then
    raise exception '0044 did not take: load_stations_doc does not sync facing_deg';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 43 → 44 in the same commit as this file.

insert into meganet.app_meta (key, value)
values ('schema_version', '44')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
