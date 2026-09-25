-- 0031_river_height_details.sql — What the Bureau's river height station lists
-- say about a station: its flood classification levels, the crossing its gauge
-- is read against, and the survey of the gauge itself.
--
-- Why this file exists
-- ────────────────────
-- "Queensland Flood Warning River Height Stations" is a Bureau report printed in
-- sections, every row keyed on the bureau number. Four of its sections are in
-- archive/river-height-stations/, and each answers something the station record
-- could not:
--
--   Section 4, 25/09/2026    flood classifications — the first-report, minor,
--   Section 4 (B), 15/01/2014  crops-and-grazing, moderate, towns and major
--                            heights, and the height of the crossing the gauge
--                            is read against with a code saying what it is
--                            (Bridge, Causeway … Spillway, Full Supply, HAT).
--   Section 5, 25/09/2026    the crossings themselves: the stream and the
--                            crossing's name.
--   Section 6, 25/09/2026    the gauge: the height of its zero, in which datum
--                            and from when to when — a history, several rows
--                            for a gauge that has been re-levelled — plus its
--                            AMTD (Adopted Middle Thread Distance: km along the
--                            middle of the stream from its mouth up to the
--                            gauge) and the catchment area above it.
--
-- These become three tables hanging off meganet.station, exactly as the sensors
-- do, and three lists in the station's document — `flood_classes`, `crossings`
-- and `gauge_survey`. So the station card reads them from the station it already
-- holds, the editor saves them with everything else in one save_station() call
-- and one transaction, and stations.json carries them like any other station
-- fact. They are MegaNet's rows from here on: the Bureau's lists are where they
-- started, and an editor adds the next edition, the next crossing or the next
-- re-levelling in the station editor.
--
-- What is stored, and in what shape
-- ─────────────────────────────────
-- A row per printed row, as written. `numeric` for every figure, for 0002's
-- reason — 94.50 stays 94.50. Rows are ordered by `ord` and keyed by
-- (station_id, ord): a list the editor replaces wholesale has no other identity,
-- which is 0004's reasoning about pass ranges.
--
--   meganet.station_flood_class   one row per edition, dated by `as_at`. The
--                                 2014 edition is kept beside the 2026 one: it is
--                                 superseded, and it is also the only record of
--                                 the levels a station had before, or had at all
--                                 if the 2026 list dropped it. The card shows the
--                                 newest and says the rest are earlier.
--   meganet.station_crossing      the crossing, dated by the list it came from.
--   meganet.station_gauge_survey  the gauge zero's history, dated by valid_from
--                                 and valid_to. One printed row has its dates
--                                 the wrong way round (535200, from 2021 to
--                                 2020); it is kept as printed and the card says
--                                 so, for the reason load_stations_doc() gives
--                                 about inverted pass ranges — a check
--                                 constraint would have refused the document,
--                                 and then every save of that station.
--
-- Section 4 prints the crossing's height and type and Section 5 prints them
-- again, beside the stream and the name. For 2026 they agree on all 825
-- crossings, which is why the card shows the one crossing line, not two. Both
-- are kept as the Bureau prints them: the 2014 edition has no Section 5, and its
-- crossing heights are only on its Section 4 rows.
--
-- Two vocabularies carry the codes. `meganet.crossing_type` is the legend
-- printed at the foot of every page of Sections 4 and 5; `meganet.gauge_datum`
-- is the four datums Section 6 uses. Foreign keys, so a code nobody knows is
-- refused rather than stored — and a new code is an insert here, not a migration.
--
-- What this file does NOT do
-- ──────────────────────────
-- It carries no station data, for 0029's and 0030's reason: a migration carrying
-- rows would be a second copy of the document. The rows are attached to the
-- stations they describe by bureau number with
--
--   python3 tools/ingest/river_height_stations.py --sql \
--     | psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction
--
-- which attaches only to live stations, and only where the station has none of
-- its own yet — so it can be re-run after stations are added without touching a
-- row somebody has since edited. Rows the lists hold for stations MegaNet does
-- not have (about half of each) stay in data/river-height-stations.json.
--
-- What had to be restated
-- ───────────────────────
-- The same three objects 0029 and 0030 restated, verbatim from 0030 with the
-- three lists threaded through: station_json (three optional keys, absent where
-- a station has no rows — 2,426 of the 3,176 are in none of the Bureau's lists,
-- and would otherwise each carry three empty ones), save_station() and
-- load_stations_doc().
--
-- save_station() differs from the sensors in one deliberate way: a list that is
-- **absent** from the document it is handed is left alone, and only a list that
-- is present — empty included — replaces what is there. Every client that
-- existed before this file builds its document without these keys, and reading
-- their absence as "none" would have deleted every flood class on the first
-- save from a tab opened before the deploy. load_stations_doc() is a sync of a
-- whole document, and there absent means none, as it does for everything else.
--
-- No grants are repeated with the restatements; 0029 says why.
--
-- Idempotent and forward-only, per db/README.md.

-- ── The vocabularies ─────────────────────────────────────────────────────────
-- The legend, in the order the page prints it. The labels are the page's own
-- words; `meaning` is what the height beside the code is the height *of*, which
-- the page leaves to the reader and the card cannot.

create table if not exists meganet.crossing_type (
  code     text        primary key,
  label    text        not null,
  meaning  text        not null default '',
  ord      integer     not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

comment on table meganet.crossing_type is
  'The crossing codes of the Bureau''s river height station lists (Sections 4 and 5), as the legend at the foot of each page prints them.';

insert into meganet.crossing_type (code, label, meaning, ord) values
  ('B', 'Bridge',                    'the height at which the bridge goes under', 0),
  ('C', 'Causeway',                  'the height at which the causeway goes under', 1),
  ('A', 'Approaches',                'the height at which the approaches to the crossing go under', 2),
  ('X', 'Crossing',                  'the height at which the crossing goes under', 3),
  ('R', 'Road',                      'the height at which the road goes under', 4),
  ('O', 'Old Bridge',                'the height at which the old bridge goes under', 5),
  ('H', 'Highway',                   'the height at which the highway goes under', 6),
  ('F', 'Full Supply',               'the storage''s full supply level', 7),
  ('W', 'Weir',                      'the height of the weir', 8),
  ('S', 'Spillway',                  'the height of the spillway', 9),
  ('T', 'Highest Astronomical Tide', 'the highest astronomical tide', 10)
on conflict (code) do update
   set label = excluded.label, meaning = excluded.meaning, ord = excluded.ord
 where (meganet.crossing_type.label, meganet.crossing_type.meaning, meganet.crossing_type.ord)
       is distinct from (excluded.label, excluded.meaning, excluded.ord);

create table if not exists meganet.gauge_datum (
  code     text        primary key,
  label    text        not null,
  ord      integer     not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

comment on table meganet.gauge_datum is
  'The datums Section 6 of the Bureau''s river height station lists measures a gauge zero in, by the code it prints.';

-- STATE is recorded as the page writes it. It is the older state levelling
-- datum some Queensland gauges were set to before AHD; the list does not say
-- more, and neither does this.
insert into meganet.gauge_datum (code, label, ord) values
  ('AHD',     'Australian Height Datum', 0),
  ('ASSUM',   'Assumed datum',           1),
  ('STATE',   'State datum',             2),
  ('UNKNOWN', 'Datum unknown',           3)
on conflict (code) do update
   set label = excluded.label, ord = excluded.ord
 where (meganet.gauge_datum.label, meganet.gauge_datum.ord)
       is distinct from (excluded.label, excluded.ord);

-- ── The three lists ──────────────────────────────────────────────────────────
-- Each hangs off a station and goes with it: `on delete cascade`, like the
-- sensors, so a hard delete takes them along and the soft delete (which keeps
-- the row) keeps them too.
--
-- The `carries_something` checks are what "a row" means: a flood class row with
-- no figure, a crossing with nothing about it, a survey with no zero, datum,
-- distance or area is a blank line, and both write paths drop one rather than
-- store it.

create table if not exists meganet.station_flood_class (
  station_id        text        not null references meganet.station (id) on delete cascade,
  ord               integer     not null,
  -- The edition: the date on the list this came from, or, for a row an editor
  -- adds, the date the classification took effect.
  as_at             date,
  first_report_m    numeric,
  crossing_height_m numeric,
  crossing_type     text        references meganet.crossing_type (code),
  minor_m           numeric,
  crops_grazing_m   numeric,
  moderate_m        numeric,
  towns_m           numeric,
  major_m           numeric,
  note              text,
  updated_at        timestamptz not null default now(),
  updated_by        text,
  primary key (station_id, ord),
  constraint station_flood_class_carries_something check (
    num_nonnulls(first_report_m, crossing_height_m, crossing_type, minor_m,
                 crops_grazing_m, moderate_m, towns_m, major_m, note) > 0)
);

comment on table meganet.station_flood_class is
  'A station''s flood classification levels, one row per edition, as the Bureau''s river height station lists (Section 4) print them. Heights in metres on the gauge.';
comment on column meganet.station_flood_class.first_report_m is
  'The height at which the gauge is first reported to the Bureau.';
comment on column meganet.station_flood_class.crossing_height_m is
  'The height, on the gauge, of the crossing it is read against — what kind of crossing is crossing_type.';

create table if not exists meganet.station_crossing (
  station_id     text        not null references meganet.station (id) on delete cascade,
  ord            integer     not null,
  as_at          date,
  stream         text,
  name           text,
  height_m       numeric,
  crossing_type  text        references meganet.crossing_type (code),
  note           text,
  updated_at     timestamptz not null default now(),
  updated_by     text,
  primary key (station_id, ord),
  constraint station_crossing_carries_something check (
    num_nonnulls(stream, name, height_m, crossing_type, note) > 0)
);

comment on table meganet.station_crossing is
  'The crossings a station''s gauge is read against, as Section 5 of the Bureau''s river height station lists prints them: the stream, the crossing''s name, and the height on the gauge at which it matters.';

create table if not exists meganet.station_gauge_survey (
  station_id          text        not null references meganet.station (id) on delete cascade,
  ord                 integer     not null,
  valid_from          date,
  valid_to            date,
  gauge_zero_m        numeric,
  datum               text        references meganet.gauge_datum (code),
  amtd_km             numeric,
  catchment_area_km2  numeric,
  note                text,
  updated_at          timestamptz not null default now(),
  updated_by          text,
  primary key (station_id, ord),
  constraint station_gauge_survey_carries_something check (
    num_nonnulls(gauge_zero_m, datum, amtd_km, catchment_area_km2, note) > 0)
);

comment on table meganet.station_gauge_survey is
  'The survey of a station''s gauge, as Section 6 of the Bureau''s river height station lists prints it: the height of the gauge zero, its datum and the period it held, with the gauge''s AMTD and catchment area. Several rows for a gauge that has been re-levelled; valid_to null means still in force.';
comment on column meganet.station_gauge_survey.amtd_km is
  'Adopted Middle Thread Distance: kilometres along the middle of the stream from its mouth (or its junction with the stream it joins) up to the gauge.';
comment on column meganet.station_gauge_survey.catchment_area_km2 is
  'The catchment area above the gauge, in square kilometres.';

-- The touch trigger every table with an updated_at hangs off (0001).
do $$
declare
  t text;
begin
  foreach t in array array['crossing_type', 'gauge_datum', 'station_flood_class',
                           'station_crossing', 'station_gauge_survey']
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
-- In the file that creates the tables, per db/README.md. Read for everyone, as
-- the station list is — these are the Bureau's published figures and a card
-- anybody may open. Written only through save_station() and the loaders; the
-- editor policies are 0004's belt-and-braces for the day somebody grants a write
-- verb directly, and the vocabularies get none at all.

do $$
declare
  t text;
  v text;
begin
  foreach t in array array['crossing_type', 'gauge_datum', 'station_flood_class',
                           'station_crossing', 'station_gauge_survey']
  loop
    execute format('alter table meganet.%I enable row level security', t);
    execute format('drop policy if exists %I on meganet.%I', t || '_read_all', t);
    execute format('create policy %I on meganet.%I for select using (true)',
                   t || '_read_all', t);
  end loop;

  foreach t in array array['station_flood_class', 'station_crossing', 'station_gauge_survey']
  loop
    foreach v in array array['insert', 'update', 'delete'] loop
      execute format('drop policy if exists %I on meganet.%I', t || '_' || v || '_editors', t);
    end loop;
    execute format(
      'create policy %I on meganet.%I for insert to authenticated
         with check (meganet.is_editor())', t || '_insert_editors', t);
    execute format(
      'create policy %I on meganet.%I for update to authenticated
         using (meganet.is_editor()) with check (meganet.is_editor())',
      t || '_update_editors', t);
    execute format(
      'create policy %I on meganet.%I for delete to authenticated
         using (meganet.is_editor())', t || '_delete_editors', t);
  end loop;
end
$$;

-- Grants, named per table and read-only for the browser roles, inside 0002's
-- guard so a plain Postgres still takes the file.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  grant select on meganet.crossing_type, meganet.gauge_datum,
                  meganet.station_flood_class, meganet.station_crossing,
                  meganet.station_gauge_survey
    to anon, authenticated;

  grant select, insert, update, delete
     on meganet.crossing_type, meganet.gauge_datum,
        meganet.station_flood_class, meganet.station_crossing,
        meganet.station_gauge_survey
    to service_role;

  notify pgrst, 'reload schema';
end
$$;

-- ── meganet.station_json — 0030's view, plus the three lists ───────────────

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
       -- Absent rather than empty where a station has no rows, like `sensors`:
       -- most stations are in none of the Bureau's lists.
       || case when fd.doc is null then '{}'::jsonb
               else jsonb_build_object('flood_classes', fd.doc) end
       || case when cd.doc is null then '{}'::jsonb
               else jsonb_build_object('crossings', cd.doc) end
       || case when gd.doc is null then '{}'::jsonb
               else jsonb_build_object('gauge_survey', gd.doc) end
       as doc
  from meganet.station s
  left join sensor_doc sd on sd.station_id = s.id
  left join meganet.repeater r on r.station_id = s.id
  left join range_doc rd on rd.repeater_id = s.id
  left join flood_doc fd on fd.station_id = s.id
  left join crossing_doc cd on cd.station_id = s.id
  left join survey_doc gd on gd.station_id = s.id
 where s.deleted_at is null;

-- ── meganet.save_station() — 0030's function, plus the three lists ─────────
-- The editor's write path. Everything 0030 did, unchanged, and then the three
-- lists when the document carries them.

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

  -- The three lists 0031 added. Each is a list when it is there at all, and the
  -- codes in it are ones the two vocabularies know — asked here, before anything
  -- is written, so a code nobody knows gets a sentence naming it rather than a
  -- foreign key's name.
  foreach v_key in array array['flood_classes', 'crossings', 'gauge_survey'] loop
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

-- ── meganet.load_stations_doc() — 0030's function, plus the three lists ─────
-- The importer's write path, syncing the three lists the way it syncs sensors.

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

  -- Said out loud on every run rather than left to be discovered: a range whose
  -- low is above its high passes no address at all, here or in the app.
  if n_inverted > 0 then
    raise notice 'note: % pass range(s) are inverted and match no address', n_inverted;
  end if;

  return format('loaded %s stations, %s sensors, %s repeaters, %s pass ranges, '
                '%s flood classes, %s crossings, %s gauge surveys%s',
                n_station, n_sensor, n_repeater, n_range, n_flood, n_crossing, n_survey,
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
                    and definition like '%''flood_classes''%'
                    and definition like '%''crossings''%'
                    and definition like '%''gauge_survey''%'
                    and definition like '%''owner''%') then
    raise exception '0031 did not take: station_json does not emit the three lists';
  end if;
  if (select count(*) from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'meganet' and p.proname = 'save_station'
         and p.prosrc like '%station_flood_class%'
         and p.prosrc like '%station_crossing%'
         and p.prosrc like '%station_gauge_survey%'
         and p.prosrc like '%excluded.owner%') = 0 then
    raise exception '0031 did not take: save_station does not write the three lists';
  end if;
  if (select count(*) from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'meganet' and p.proname = 'load_stations_doc'
         and p.prosrc like '%excluded.crops_grazing_m%'
         and p.prosrc like '%excluded.stream%'
         and p.prosrc like '%excluded.catchment_area_km2%'
         and p.prosrc like '%excluded.owner%') = 0 then
    raise exception '0031 did not take: load_stations_doc does not sync the three lists';
  end if;
  if (select count(*) from meganet.crossing_type) < 11
     or (select count(*) from meganet.gauge_datum) < 4 then
    raise exception '0031 did not take: the vocabularies are short';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 30 → 31 in the same commit as this file.
--
-- The guarded form db/README.md asks for "the next time these are touched": a
-- database that is already further on keeps its number, so applying this file
-- late cannot wind schema_version backwards.

insert into meganet.app_meta (key, value)
values ('schema_version', '31')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
