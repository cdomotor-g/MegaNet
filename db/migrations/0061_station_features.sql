-- 0061_station_features.sql — Where a station's ancillary features are: the
-- orifice outlet, the inspection pits, the benchmarks, the gauge boards and the
-- rest as points, and the orifice run as a line through them — drawn on the
-- Stations map (site-features.js) and kept here.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0061_station_features.sql
--
-- Why this file exists
-- ────────────────────
-- A station is one point in the register — its pin — and the site around it is
-- not. The orifice line leaves the shelter, runs through two or three pits and
-- ends at an outlet in the stream; the benchmarks the gauge is levelled from are
-- on a culvert headwall, a tree, a State mark up the road; the boards step down
-- the bank. Somebody new to the site, or the same person five years on, has to
-- find them, and the person with a spade has to know where the line runs. None
-- of that had anywhere to go: the register has the pin, 0060 has the levels.
--
--   1. station_feature_kind  what a feature can be — a vocabulary, so a new kind
--                            is an insert: its label, whether it is a point or
--                            a line (as GeoJSON names them), whether it has to
--                            be named, and a sentence saying what it is.
--   2. station_feature       one feature: its station and kind, a name and a
--                            note, where it is — a GeoJSON Point or LineString,
--                            longitude first, WGS84, to seven places (about a
--                            centimetre) — how that was got and the GPS's own ±,
--                            who added it and who last changed it, and a soft
--                            delete.
--   3. save_station_feature(), delete_station_feature()
--                            the two doors. Any editor. A stale write is refused
--                            (PT409), as everywhere else here.
--
-- Where, not how high. 0060's station_level_point holds a benchmark's or a
-- board's *level*, adopted by an administrator from a survey; this holds where
-- it *is*, mapped by any editor from the imagery, a phone's GPS or a coordinate
-- typed off a plan. The two meet on the name — BM1 is BM1 in both — and neither
-- is worked out from the other: a level survey's points are booked by what was
-- levelled, not where, and most of this never gets levelled at all.
--
-- The geometry is GeoJSON in a jsonb rather than a PostGIS column because
-- nothing in this schema uses PostGIS, the CI database does not have it, and
-- nothing here needs the database to do geometry: it checks the shape, rounds
-- the numbers, and measures how far the farthest point is from the pin, which
-- is the same flat-earth arithmetic field_photo_station_for() uses (0035). The
-- kind's geometry and the feature's are tied by a foreign key over a generated
-- column, so a benchmark cannot be a line however it is written.
--
-- Reading: editors only (RLS), like 0060 — a benchmark's position is not for
-- the open internet, and nor is a map of where to dig — and not in the agent
-- API. The vocabulary is public, like every other: it describes a blank form.
--
-- Depends on 0002 (station), 0004 (is_editor, actor, touch_updated_at).
-- tools/check_station_features.sql proves it.

-- ── 1. What a feature can be ─────────────────────────────────────────────────

create table if not exists meganet.station_feature_kind (
  key         text     primary key,
  label       text     not null,
  geometry    text     not null,
  needs_name  boolean  not null default false,
  ord         integer  not null,
  note        text     not null default '',
  constraint station_feature_kind_key check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  constraint station_feature_kind_geometry check (geometry in ('Point', 'LineString')),
  constraint station_feature_kind_label check (length(btrim(label)) between 1 and 60),
  constraint station_feature_kind_pair unique (key, geometry)
);

comment on table meganet.station_feature_kind is
  'What a station''s site feature can be (0061): a point or a line, as GeoJSON names them, and whether it has to be named. A new kind is an insert; site-features.js draws one it does not know with a plain marker.';

-- The four points the owner named first, a crest gauge beside them, and the
-- orifice run; a cable run because a pressure transducer's cable is the same
-- question as a bubbler's line; and one of each shape for everything else,
-- which has to say what it is.
insert into meganet.station_feature_kind (key, label, geometry, needs_name, ord, note) values
  ('orifice_outlet', 'Orifice outlet', 'Point', false, 10, 'Where the orifice line ends in the stream — the point a bubbler reads the water at.'),
  ('pit', 'Inspection pit', 'Point', false, 20, 'A pit on the orifice line or a cable run, opened to inspect, clear or join it.'),
  ('benchmark', 'Benchmark', 'Point', false, 30, 'A survey mark the gauge is levelled from — a local benchmark, a reference mark or a State mark.'),
  ('gauge_board', 'Gauge board', 'Point', false, 40, 'A staff gauge board, one of the flight read by eye.'),
  ('crest_gauge', 'Crest gauge', 'Point', false, 50, 'A maximum height gauge, read after a flood.'),
  ('other_point', 'Other point', 'Point', true, 90, 'Anything else at the site worth finding again — named.'),
  ('orifice_run', 'Orifice run', 'LineString', false, 110, 'The orifice line, from the shelter to the outlet, through its pits.'),
  ('cable_run', 'Cable run', 'LineString', false, 120, 'A sensor''s cable or a conduit, from the shelter to the sensor, through its pits.'),
  ('other_line', 'Other line', 'LineString', true, 190, 'Any other run worth finding again — an access track, a fence, a drain — named.')
on conflict (key) do nothing;

-- ── 2. The shape of a position, a line and a point ───────────────────────────
-- Sentences rather than booleans: the same function backs the table's check
-- constraint and the save's refusal, and the save says what is wrong in words.

-- One GeoJSON position: [longitude, latitude], two numbers and no third — this
-- keeps where, and a height is 0060's business.
create or replace function meganet.station_feature_position_problem(p jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
           when p is null or pg_catalog.jsonb_typeof(p) <> 'array' or pg_catalog.jsonb_array_length(p) <> 2
             then 'a position is [longitude, latitude]'
           when pg_catalog.jsonb_typeof(p -> 0) <> 'number' or pg_catalog.jsonb_typeof(p -> 1) <> 'number'
             then 'a position is two numbers, longitude first'
           when (p ->> 0)::numeric not between -180 and 180
             then pg_catalog.format('a longitude is between -180 and 180, not %s', p ->> 0)
           when (p ->> 1)::numeric not between -90 and 90
             then pg_catalog.format('a latitude is between -90 and 90, not %s', p ->> 1)
         end
$$;

comment on function meganet.station_feature_position_problem(jsonb) is
  'Why a GeoJSON position is not [longitude, latitude] within range, or null when it is. Internal to the site features (0061).';

-- A whole geometry: a Point, or a LineString of 2 to 500 positions that goes
-- somewhere, carrying its type and its coordinates and nothing else — so what
-- is stored is one shape, whatever wrote it.
create or replace function meganet.station_feature_geom_problem(p_geom jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_type text;
  v_c    jsonb;
  v_n    integer;
  v_why  text;
begin
  if p_geom is null or pg_catalog.jsonb_typeof(p_geom) <> 'object' then
    return 'where a feature is has to be a GeoJSON Point or LineString';
  end if;
  v_type := p_geom ->> 'type';
  if v_type is null or v_type not in ('Point', 'LineString') then
    return pg_catalog.format('where a feature is has to be a GeoJSON Point or LineString, not %s',
                             coalesce(v_type, 'nothing'));
  end if;
  if exists (select 1 from pg_catalog.jsonb_object_keys(p_geom) k where k not in ('type', 'coordinates')) then
    return 'a feature''s geometry carries its type and its coordinates, and nothing else';
  end if;
  v_c := p_geom -> 'coordinates';
  if v_type = 'Point' then
    v_why := meganet.station_feature_position_problem(v_c);
    return case when v_why is null then null else 'a point: ' || v_why end;
  end if;
  if v_c is null or pg_catalog.jsonb_typeof(v_c) <> 'array' then
    return 'a line is a list of positions';
  end if;
  v_n := pg_catalog.jsonb_array_length(v_c);
  if v_n < 2 then
    return pg_catalog.format('a line needs at least two points, not %s', v_n);
  end if;
  if v_n > 500 then
    return pg_catalog.format('a line is at most 500 points, not %s', v_n);
  end if;
  select pg_catalog.format('point %s of the line: %s', t.i, meganet.station_feature_position_problem(t.e))
    into v_why
    from pg_catalog.jsonb_array_elements(v_c) with ordinality as t(e, i)
   where meganet.station_feature_position_problem(t.e) is not null
   order by t.i
   limit 1;
  if v_why is not null then
    return v_why;
  end if;
  if (select count(distinct t.e) from pg_catalog.jsonb_array_elements(v_c) as t(e)) < 2 then
    return 'a line has to go somewhere — every point of it is the same point';
  end if;
  return null;
end;
$$;

comment on function meganet.station_feature_geom_problem(jsonb) is
  'Why a site feature''s geometry is not a GeoJSON Point, or a LineString of 2–500 positions going somewhere, with nothing but type and coordinates — or null when it is. Backs station_feature''s check and save_station_feature()''s refusal (0061).';

-- The same geometry with its numbers to seven places (about a centimetre — past
-- what a pin on 10 cm imagery or a phone's GPS means, and enough to keep a
-- surveyed coordinate typed off a plan) and no trailing zeros, so a value reads
-- back as it was typed. Only ever given a geometry that has passed the check.
create or replace function meganet.station_feature_round(p_geom jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case p_geom ->> 'type'
           when 'Point' then pg_catalog.jsonb_build_object('type', 'Point', 'coordinates',
             pg_catalog.jsonb_build_array(
               pg_catalog.trim_scale(pg_catalog.round((p_geom #>> '{coordinates,0}')::numeric, 7)),
               pg_catalog.trim_scale(pg_catalog.round((p_geom #>> '{coordinates,1}')::numeric, 7))))
           when 'LineString' then pg_catalog.jsonb_build_object('type', 'LineString', 'coordinates',
             (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
                       pg_catalog.trim_scale(pg_catalog.round((t.e ->> 0)::numeric, 7)),
                       pg_catalog.trim_scale(pg_catalog.round((t.e ->> 1)::numeric, 7))) order by t.i)
                from pg_catalog.jsonb_array_elements(p_geom -> 'coordinates') with ordinality as t(e, i)))
         end
$$;

comment on function meganet.station_feature_round(jsonb) is
  'A checked site feature geometry with every coordinate rounded to seven places (0061). Internal.';

-- How far the farthest point of a geometry is from a station's pin, in metres —
-- on the flat, as field_photo_station_for() measures (0035), which at a few
-- kilometres is good to well under a metre. Null for a station with no pin.
create or replace function meganet.station_feature_reach_m(p_geom jsonb, p_lat numeric, p_lon numeric)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
           when p_lat is null or p_lon is null then null
           else (select pg_catalog.round(pg_catalog.max(pg_catalog.sqrt(
                          (((t.e ->> 0)::float8 - p_lon::float8) * 111320.0 * pg_catalog.cos(pg_catalog.radians(p_lat::float8))) ^ 2
                        + (((t.e ->> 1)::float8 - p_lat::float8) * 110574.0) ^ 2))::numeric, 1)
                   from pg_catalog.jsonb_array_elements(
                          case p_geom ->> 'type'
                            when 'Point' then pg_catalog.jsonb_build_array(p_geom -> 'coordinates')
                            else p_geom -> 'coordinates'
                          end) as t(e))
         end
$$;

comment on function meganet.station_feature_reach_m(jsonb, numeric, numeric) is
  'The distance in metres from a station''s pin to the farthest point of a site feature''s geometry, or null with no pin (0061). Internal.';

-- ── 3. The features ──────────────────────────────────────────────────────────

create table if not exists meganet.station_feature (
  id          uuid          primary key default gen_random_uuid(),
  station_id  text          not null references meganet.station (id) on delete cascade,
  kind        text          not null,
  name        text          not null default '',
  note        text          not null default '',
  geom        jsonb         not null,
  geom_type   text          generated always as (geom ->> 'type') stored,
  placed      text          not null default 'map',
  accuracy_m  numeric(7,2),
  created_by  text          not null,
  created_at  timestamptz   not null default now(),
  updated_by  text          not null,
  updated_at  timestamptz   not null default now(),
  deleted_at  timestamptz,
  deleted_by  text,
  -- The kind and the shape, together: a benchmark is a point and an orifice run
  -- a line, by the vocabulary rather than by what the browser sent.
  constraint station_feature_kind_shape foreign key (kind, geom_type)
    references meganet.station_feature_kind (key, geometry),
  constraint station_feature_geom check (meganet.station_feature_geom_problem(geom) is null),
  constraint station_feature_placed check (placed in ('map', 'gps', 'typed', 'mixed')),
  constraint station_feature_accuracy check (
    accuracy_m is null or (placed in ('gps', 'mixed') and accuracy_m > 0 and accuracy_m <= 1000)),
  constraint station_feature_lengths check (
    length(name) <= 100 and length(note) <= 2000 and name = btrim(name)),
  constraint station_feature_deleted check ((deleted_at is null) = (deleted_by is null))
);

comment on table meganet.station_feature is
  'Where a station''s ancillary features are (0061): the orifice outlet, pits, benchmarks, gauge boards and the rest as GeoJSON points, the orifice run as a line — longitude first, WGS84, seven places — with how each was placed (map, gps, typed, mixed) and the GPS''s ±. Written only by save_station_feature() and delete_station_feature(); soft-deleted. Editors only.';
comment on column meganet.station_feature.placed is
  'How the position was got: map (clicked or dragged on the imagery), gps (the device''s own fix, accuracy_m its ±), typed (a coordinate typed or pasted), mixed (a line some of whose points came one way and some another).';

create index if not exists station_feature_station
  on meganet.station_feature (station_id) where deleted_at is null;

-- Two live features of one kind at one station do not share a name: two BM1s
-- is a benchmark entered twice. Unnamed ones repeat freely — four pits are four
-- pits.
create unique index if not exists station_feature_name_live
  on meganet.station_feature (station_id, kind, lower(name)) where deleted_at is null and name <> '';

drop trigger if exists station_feature_touch_updated_at on meganet.station_feature;
create trigger station_feature_touch_updated_at
  before update on meganet.station_feature
  for each row execute function meganet.touch_updated_at();

-- ── Row level security ───────────────────────────────────────────────────────
-- Editors read the live features; nobody writes but through the doors below.
-- The vocabulary is anybody's.

alter table meganet.station_feature enable row level security;
drop policy if exists station_feature_read_editors on meganet.station_feature;
create policy station_feature_read_editors on meganet.station_feature
  for select to authenticated using (meganet.is_editor() and deleted_at is null);

alter table meganet.station_feature_kind enable row level security;
drop policy if exists station_feature_kind_read on meganet.station_feature_kind;
create policy station_feature_kind_read on meganet.station_feature_kind
  for select to anon, authenticated using (true);

-- ── 4. The two doors ─────────────────────────────────────────────────────────

-- What a door answers with: the row as the app keeps it, without the generated
-- column or the tombstone (a live row has none).
create or replace function meganet.station_feature_json(p meganet.station_feature)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.to_jsonb(p) - 'geom_type' - 'deleted_at' - 'deleted_by'
$$;

comment on function meganet.station_feature_json(meganet.station_feature) is
  'A site feature as save_station_feature() answers it (0061). Internal.';

-- Add a feature, or change one. A JSON object with a closed key list, as 0035's
-- and 0060's doors take: a key this does not know is a mistake worth hearing
-- about. Without an id it is a new feature, and needs a station, a kind and a
-- geometry; with one it is a change, carries the updated_at it was read with
-- (PT409 if the row has moved since, or has been deleted), and keeps whatever
-- it does not mention. A feature stays with its station.
--
-- Refused in words (22023): a geometry that is not one; a kind that is not
-- one, or is the other shape; an "other" with no name; a point more than 10 km
-- from the station's pin — the wrong station's map, not a far-off benchmark —
-- and a ± on a position that was not a GPS fix is dropped rather than kept.
-- A save that changes nothing writes nothing and keeps the stamp.
create or replace function meganet.save_station_feature(p_feature jsonb, p_expected timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  text := meganet.actor();
  v_key    text;
  v_id     uuid;
  v_old    meganet.station_feature%rowtype;
  v_row    meganet.station_feature%rowtype;
  v_stn    meganet.station%rowtype;
  v_kind   meganet.station_feature_kind%rowtype;
  v_sid    text;
  v_name   text;
  v_note   text;
  v_geom   jsonb;
  v_why    text;
  v_placed text;
  v_acc    numeric;
  v_reach  numeric;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to map a station''s site features'
      using errcode = '42501',
            hint    = 'sign in with an address on the editors list — see docs/access.md';
  end if;
  if p_feature is null or pg_catalog.jsonb_typeof(p_feature) <> 'object' then
    raise exception 'meganet.save_station_feature() needs the feature as a JSON object' using errcode = '22023';
  end if;
  for v_key in select pg_catalog.jsonb_object_keys(p_feature) loop
    if v_key not in ('id', 'station_id', 'kind', 'name', 'note', 'geom', 'placed', 'accuracy_m') then
      raise exception 'meganet.save_station_feature() does not take %', v_key
        using errcode = '22023',
              hint    = 'id, station_id, kind, name, note, geom, placed and accuracy_m are the whole list';
    end if;
  end loop;

  -- A change, or a new one.
  if nullif(p_feature ->> 'id', '') is not null then
    begin
      v_id := (p_feature ->> 'id')::uuid;
    exception when others then
      raise exception 'a site feature''s id is a uuid, not %', p_feature ->> 'id' using errcode = '22023';
    end;
    select * into v_old from meganet.station_feature f where f.id = v_id for update;
    if not found or v_old.deleted_at is not null then
      raise exception 'that site feature is not in the database any more — it was deleted while you had it open'
        using errcode = 'PT409',
              hint    = 'reload the station''s site features; what you drew is still on screen';
    end if;
    if p_expected is null then
      raise exception 'a change to a site feature carries the stamp it was read with, so it cannot overwrite a newer one'
        using errcode = 'PT409',
              hint    = 'reload the station''s site features and make the change again';
    end if;
    if v_old.updated_at is distinct from p_expected then
      raise exception 'that site feature was changed at %, after you opened it', v_old.updated_at
        using errcode = 'PT409',
              hint    = 'reload to see the current version — saving now would overwrite somebody else''s work';
    end if;
    if p_feature ? 'station_id' and (p_feature ->> 'station_id') is distinct from v_old.station_id then
      raise exception 'a site feature stays with its station — delete it there and add it at the other'
        using errcode = '22023';
    end if;
    v_sid := v_old.station_id;
  else
    if p_expected is not null then
      raise exception 'a new site feature has no stamp to have started from' using errcode = '22023';
    end if;
    v_sid := nullif(pg_catalog.btrim(coalesce(p_feature ->> 'station_id', '')), '');
    if v_sid is null then
      raise exception 'a site feature needs the station it belongs to' using errcode = '22023';
    end if;
    if not (p_feature ? 'kind') or not (p_feature ? 'geom') then
      raise exception 'a new site feature needs its kind and where it is' using errcode = '22023';
    end if;
  end if;

  select * into v_stn from meganet.station s where s.id = v_sid;
  if not found or v_stn.deleted_at is not null then
    raise exception 'there is no station "%" to map a feature at', v_sid using errcode = '22023';
  end if;

  -- The kind, and its shape.
  select * into v_kind from meganet.station_feature_kind k
   where k.key = case when p_feature ? 'kind' then p_feature ->> 'kind' else v_old.kind end;
  if not found then
    raise exception '"%" is not a kind of site feature', p_feature ->> 'kind'
      using errcode = '22023',
            hint    = 'meganet.station_feature_kind lists them';
  end if;

  -- The name, with its spaces tidied; the note as written, trimmed.
  v_name := case when p_feature ? 'name'
                 then pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_feature ->> 'name', ''), '\s+', ' ', 'g'))
                 else coalesce(v_old.name, '') end;
  v_note := case when p_feature ? 'note' then pg_catalog.btrim(coalesce(p_feature ->> 'note', ''))
                 else coalesce(v_old.note, '') end;
  if pg_catalog.length(v_name) > 100 or pg_catalog.length(v_note) > 2000 then
    raise exception 'a site feature''s name is at most 100 characters, its note 2,000' using errcode = '22023';
  end if;
  if v_kind.needs_name and v_name = '' then
    raise exception 'an "%" needs a name saying what it is', pg_catalog.lower(v_kind.label) using errcode = '22023';
  end if;

  -- Where: the shape checked as sent, then rounded, then checked again — two
  -- points a hair apart can round onto one.
  if p_feature ? 'geom' then
    v_geom := p_feature -> 'geom';
    if pg_catalog.jsonb_typeof(v_geom) = 'object' then
      v_geom := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                  'type', v_geom -> 'type', 'coordinates', v_geom -> 'coordinates'));
    end if;
    v_why := meganet.station_feature_geom_problem(v_geom);
    if v_why is null then
      v_geom := meganet.station_feature_round(v_geom);
      v_why  := meganet.station_feature_geom_problem(v_geom);
    end if;
    if v_why is not null then
      raise exception '%', v_why using errcode = '22023';
    end if;
  else
    v_geom := v_old.geom;
  end if;
  if v_geom ->> 'type' <> v_kind.geometry then
    raise exception 'an "%" is a %, not a %', pg_catalog.lower(v_kind.label),
                    case v_kind.geometry when 'Point' then 'point' else 'line' end,
                    case v_geom ->> 'type' when 'Point' then 'point' else 'line' end
      using errcode = '22023';
  end if;
  v_reach := meganet.station_feature_reach_m(v_geom, v_stn.lat, v_stn.lon);
  if v_reach > 10000 then
    raise exception 'that is % km from the pin of %, and a site feature is within 10 km of its station',
                    pg_catalog.round(v_reach / 1000, 1), v_stn.name
      using errcode = '22023',
            hint    = 'if it is the station''s own pin that is wrong, move the pin first';
  end if;

  -- How it was placed, and the GPS's ± when it was a fix.
  v_placed := case when p_feature ? 'placed' then coalesce(nullif(p_feature ->> 'placed', ''), 'map')
                   else coalesce(v_old.placed, 'map') end;
  if v_placed not in ('map', 'gps', 'typed', 'mixed') then
    raise exception 'a site feature is placed on the map, by GPS, typed, or a mix of those — not %', v_placed
      using errcode = '22023';
  end if;
  if p_feature ? 'accuracy_m' then
    begin
      v_acc := nullif(p_feature ->> 'accuracy_m', '')::numeric;
    exception when others then
      raise exception 'a GPS ± is a number of metres, not %', p_feature ->> 'accuracy_m' using errcode = '22023';
    end;
  else
    v_acc := v_old.accuracy_m;
  end if;
  if v_placed not in ('gps', 'mixed') then
    v_acc := null;
  elsif v_acc is not null and (v_acc <= 0 or v_acc > 1000) then
    raise exception 'a GPS ± of % m is not one a position is kept with', v_acc using errcode = '22023';
  end if;
  v_acc := pg_catalog.round(v_acc, 2);

  if v_old.id is null then
    insert into meganet.station_feature (station_id, kind, name, note, geom, placed, accuracy_m, created_by, updated_by)
    values (v_sid, v_kind.key, v_name, v_note, v_geom, v_placed, v_acc, v_actor, v_actor)
    returning * into v_row;
  elsif v_old.kind = v_kind.key and v_old.name = v_name and v_old.note = v_note and v_old.geom = v_geom
        and v_old.placed = v_placed and v_old.accuracy_m is not distinct from v_acc then
    v_row := v_old;
  else
    update meganet.station_feature f
       set kind = v_kind.key, name = v_name, note = v_note, geom = v_geom, placed = v_placed,
           accuracy_m = v_acc, updated_by = v_actor
     where f.id = v_old.id
    returning * into v_row;
  end if;
  return meganet.station_feature_json(v_row);
exception
  when unique_violation then
    raise exception 'there is already a % called "%" at this station', pg_catalog.lower(v_kind.label), v_name
      using errcode = '23505',
            hint    = 'give this one another name, or open that one';
end;
$$;

comment on function meganet.save_station_feature(jsonb, timestamptz) is
  'Add or change a station''s site feature (0061): {id?, station_id, kind, name, note, geom, placed, accuracy_m}, with the updated_at it was read with for a change. Editors. Answers the row as saved.';

-- Delete one, softly: the row stays, with who and when, and editors stop
-- seeing it. Carries the stamp it was read with, as a change does — deleting
-- the version somebody has just corrected is the same mistake as overwriting
-- it. Deleting one that is already gone answers its tombstone.
create or replace function meganet.delete_station_feature(p_id uuid, p_expected timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor text := meganet.actor();
  v_row   meganet.station_feature%rowtype;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to map a station''s site features'
      using errcode = '42501',
            hint    = 'sign in with an address on the editors list — see docs/access.md';
  end if;
  select * into v_row from meganet.station_feature f where f.id = p_id for update;
  if not found then
    raise exception 'there is no site feature %', p_id using errcode = '22023';
  end if;
  if v_row.deleted_at is not null then
    return pg_catalog.jsonb_build_object('id', v_row.id, 'deleted_at', v_row.deleted_at);
  end if;
  if p_expected is null or v_row.updated_at is distinct from p_expected then
    raise exception 'that site feature was changed at %, after you opened it', v_row.updated_at
      using errcode = 'PT409',
            hint    = 'reload to see the current version before deleting it';
  end if;
  update meganet.station_feature f
     set deleted_at = pg_catalog.now(), deleted_by = v_actor
   where f.id = p_id
  returning * into v_row;
  return pg_catalog.jsonb_build_object('id', v_row.id, 'deleted_at', v_row.deleted_at);
end;
$$;

comment on function meganet.delete_station_feature(uuid, timestamptz) is
  'Soft-delete a station''s site feature (0061), with the updated_at it was read with. Editors. Answers {id, deleted_at}; a second delete answers the same.';

-- ── Grants ───────────────────────────────────────────────────────────────────
-- The writers and the internals revoked from public in the same file
-- (db/README.md); the doors granted to the two roles a request can be.

revoke all on function meganet.station_feature_position_problem(jsonb)                 from public;
revoke all on function meganet.station_feature_geom_problem(jsonb)                     from public;
revoke all on function meganet.station_feature_round(jsonb)                            from public;
revoke all on function meganet.station_feature_reach_m(jsonb, numeric, numeric)        from public;
revoke all on function meganet.station_feature_json(meganet.station_feature)          from public;
revoke all on function meganet.save_station_feature(jsonb, timestamptz)               from public;
revoke all on function meganet.delete_station_feature(uuid, timestamptz)              from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  revoke insert, update, delete, truncate
    on meganet.station_feature, meganet.station_feature_kind
    from anon, authenticated;
  revoke select on meganet.station_feature from anon;
  grant select on meganet.station_feature_kind to anon, authenticated, service_role;
  grant select on meganet.station_feature      to authenticated, service_role;
  grant execute on function meganet.save_station_feature(jsonb, timestamptz)  to authenticated, service_role;
  grant execute on function meganet.delete_station_feature(uuid, timestamptz) to authenticated, service_role;

  notify pgrst, 'reload schema';
end
$$;

-- ── Proof it took ────────────────────────────────────────────────────────────

do $$
declare
  t text;
begin
  foreach t in array array['station_feature_kind', 'station_feature'] loop
    if pg_catalog.to_regclass('meganet.' || t) is null then
      raise exception '0061 did not take: meganet.% is missing', t;
    end if;
    if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = pg_catalog.to_regclass('meganet.' || t)) then
      raise exception '0061 did not take: RLS is off on meganet.%', t;
    end if;
    if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
      if pg_catalog.has_table_privilege('anon', 'meganet.' || t, 'insert,update,delete')
         or pg_catalog.has_table_privilege('authenticated', 'meganet.' || t, 'insert,update,delete') then
        raise exception '0061 did not take: a browser role can write meganet.%', t;
      end if;
    end if;
  end loop;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator')
     and pg_catalog.has_table_privilege('anon', 'meganet.station_feature', 'select') then
    raise exception '0061 did not take: anon can read meganet.station_feature';
  end if;
  if (select count(*) from meganet.station_feature_kind) < 9 then
    raise exception '0061 did not take: the site feature kinds are not all there';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION follows once this is live, as for 0053–0060. The
-- guard means applying it out of order leaves the higher number.

insert into meganet.app_meta (key, value)
values ('schema_version', '61')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
