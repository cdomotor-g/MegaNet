-- check_river_height_details.sql — Prove 0031: a station's flood classes,
-- crossings and gauge survey, their two vocabularies, and the two write paths.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_river_height_details.sql
--
-- The whole script runs inside a transaction and rolls back, so it is safe
-- against the live database. Like the other check_*.sql it needs a role
-- meganet.is_editor() says yes to — a direct psql connection — and prints a row
-- per check, exiting non-zero if any failed.
--
-- The station it writes is `_check_rhd`, bureau number 999031, which no real
-- station carries.

\set ON_ERROR_STOP on

begin;

create temporary table _check (
  ord   serial,
  name  text,
  ok    boolean,
  note  text
) on commit drop;

create or replace function pg_temp.check_that(p_name text, p_ok boolean, p_note text default '')
returns void language sql as $$
  insert into _check (name, ok, note) values (p_name, coalesce(p_ok, false), p_note);
$$;

-- The document a save hands back, and the SQLSTATE a refused one raises.
create temporary table _saved (k text primary key, doc jsonb, saved_at timestamptz) on commit drop;

create or replace function pg_temp.refusal(p_doc jsonb, p_stamp timestamptz)
returns text language plpgsql as $$
begin
  perform meganet.save_station(p_doc, p_stamp);
  return 'accepted';
exception when others then
  return sqlstate;
end
$$;

-- ── 1. The migration landed whole ────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('schema_version is at least 31',
    (select value::integer >= 31 from meganet.app_meta where key = 'schema_version'));

  perform pg_temp.check_that('all five tables exist',
    (select count(*) = 5 from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'meganet' and c.relkind = 'r'
        and c.relname in ('crossing_type', 'gauge_datum', 'station_flood_class',
                          'station_crossing', 'station_gauge_survey')));

  perform pg_temp.check_that('RLS is on for all five',
    (select bool_and(c.relrowsecurity) from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'meganet'
        and c.relname in ('crossing_type', 'gauge_datum', 'station_flood_class',
                          'station_crossing', 'station_gauge_survey')));

  perform pg_temp.check_that('each of the five has a read-for-everyone policy',
    (select count(*) = 5 from pg_catalog.pg_policies
      where schemaname = 'meganet' and cmd = 'SELECT' and qual = 'true'
        and tablename in ('crossing_type', 'gauge_datum', 'station_flood_class',
                          'station_crossing', 'station_gauge_survey')));

  perform pg_temp.check_that('the crossing types are the Bureau''s legend, all eleven',
    (select string_agg(code || '=' || label, ' ' order by ord) from meganet.crossing_type)
      = 'B=Bridge C=Causeway A=Approaches X=Crossing R=Road O=Old Bridge H=Highway '
        'F=Full Supply W=Weir S=Spillway T=Highest Astronomical Tide',
    (select string_agg(code || '=' || label, ' ' order by ord) from meganet.crossing_type));

  perform pg_temp.check_that('the datums are the four Section 6 uses',
    (select string_agg(code, ' ' order by ord) from meganet.gauge_datum)
      = 'AHD ASSUM STATE UNKNOWN');
end
$$;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    perform pg_temp.check_that('no anon role — grant checks skipped', true,
      'a plain Postgres rather than a Supabase-shaped one');
    return;
  end if;

  perform pg_temp.check_that('anon may read all five — the card is for anybody',
    (select bool_and(has_table_privilege('anon', 'meganet.' || t, 'select'))
       from unnest(array['crossing_type', 'gauge_datum', 'station_flood_class',
                         'station_crossing', 'station_gauge_survey']) t));

  perform pg_temp.check_that('neither browser role may write any of them directly',
    (select bool_and(not has_table_privilege(r, 'meganet.' || t, 'insert')
                 and not has_table_privilege(r, 'meganet.' || t, 'update')
                 and not has_table_privilege(r, 'meganet.' || t, 'delete'))
       from unnest(array['crossing_type', 'gauge_datum', 'station_flood_class',
                         'station_crossing', 'station_gauge_survey']) t
      cross join unnest(array['anon', 'authenticated']) r));

  perform pg_temp.check_that('anon still cannot call save_station()',
    not has_function_privilege('anon', 'meganet.save_station(jsonb, timestamptz)', 'execute'));
end
$$;

-- ── 2. save_station() writes the three lists ─────────────────────────────────

do $$
declare
  r jsonb;
begin
  r := meganet.save_station(jsonb_build_object(
    'id', '_check_rhd', 'name', 'Check River Height Details', 'station_number', '999031',
    'roles', jsonb_build_array('field'),
    'flood_classes', jsonb_build_array(
      jsonb_build_object('as_at', '2026-09-25', 'crossing_height_m', 4.60, 'crossing_type', 'B',
                         'minor_m', 2.4, 'crops_grazing_m', 3.5, 'moderate_m', 3.4, 'major_m', 4.1),
      jsonb_build_object('as_at', '2027-01-01'),                         -- a blank row
      jsonb_build_object('as_at', '2014-01-15', 'minor_m', 2.5, 'moderate_m', 3.5,
                         'major_m', 4.5, 'towns_m', null, 'note', '  ')),
    'crossings', jsonb_build_array(
      jsonb_build_object('as_at', '2026-09-25', 'stream', 'MUDGEERABA CREEK',
                         'name', 'Pacific Highway Bridge', 'height_m', 4.60, 'crossing_type', 'B')),
    'gauge_survey', jsonb_build_array(
      jsonb_build_object('valid_from', '2010-10-01', 'gauge_zero_m', 94.50, 'datum', 'AHD',
                         'amtd_km', 35.0, 'catchment_area_km2', 209.00),
      jsonb_build_object('valid_from', '1988-12-14', 'valid_to', '2010-10-01',
                         'gauge_zero_m', 82.20, 'datum', 'AHD'))));
  insert into _saved values ('first', r -> 'station', (r ->> 'updated_at')::timestamptz);

  perform pg_temp.check_that('a new station saves with all three lists',
    (select count(*) from meganet.station_flood_class where station_id = '_check_rhd') = 2
    and (select count(*) from meganet.station_crossing where station_id = '_check_rhd') = 1
    and (select count(*) from meganet.station_gauge_survey where station_id = '_check_rhd') = 2);

  perform pg_temp.check_that('a blank row is dropped and the rest renumber from 0',
    (select array_agg(ord order by ord) from meganet.station_flood_class
      where station_id = '_check_rhd') = array[0, 1]
    and (select as_at from meganet.station_flood_class
          where station_id = '_check_rhd' and ord = 1) = date '2014-01-15');

  perform pg_temp.check_that('a note of spaces is no note',
    (select note is null from meganet.station_flood_class
      where station_id = '_check_rhd' and ord = 1));

  perform pg_temp.check_that('the saved document carries the lists back',
    jsonb_array_length(r -> 'station' -> 'flood_classes') = 2
    and jsonb_array_length(r -> 'station' -> 'crossings') = 1
    and jsonb_array_length(r -> 'station' -> 'gauge_survey') = 2,
    (r -> 'station')::text);

  perform pg_temp.check_that('a figure keeps the digits it was written with',
    (r -> 'station' -> 'gauge_survey' -> 0 ->> 'gauge_zero_m') = '94.50'
    and (r -> 'station' -> 'crossings' -> 0 ->> 'height_m') = '4.60',
    (r -> 'station' -> 'gauge_survey' -> 0)::text);

  perform pg_temp.check_that('a row carries no key for what it does not state',
    not (r -> 'station' -> 'flood_classes' -> 1 ? 'towns_m')
    and not (r -> 'station' -> 'flood_classes' -> 1 ? 'note')
    and not (r -> 'station' -> 'gauge_survey' -> 0 ? 'valid_to'),
    (r -> 'station' -> 'flood_classes' -> 1)::text);

  perform pg_temp.check_that('dates come back as ISO dates',
    (r -> 'station' -> 'gauge_survey' -> 1 ->> 'valid_to') = '2010-10-01');
end
$$;

do $$
declare
  d      jsonb := (select doc from _saved where k = 'first');
  stamp  timestamptz := (select saved_at from _saved where k = 'first');
  r      jsonb;
  v_where text;
begin
  -- The same station, saved by a document that does not mention the lists —
  -- which is every document a client older than 0031 builds.
  r := meganet.save_station((d - 'flood_classes' - 'crossings' - 'gauge_survey')
                              || jsonb_build_object('name', 'Check River Height Details, renamed'),
                            stamp);
  insert into _saved values ('absent', r -> 'station', (r ->> 'updated_at')::timestamptz);

  perform pg_temp.check_that('a save that does not mention a list leaves it alone',
    (select count(*) from meganet.station_flood_class where station_id = '_check_rhd') = 2
    and (select count(*) from meganet.station_crossing where station_id = '_check_rhd') = 1
    and (select count(*) from meganet.station_gauge_survey where station_id = '_check_rhd') = 2
    and (r -> 'station' -> 'flood_classes') is not null);

  -- An empty list is a statement: there are none now. The row's physical
  -- address is taken first because the stamp cannot show a rewrite here: every
  -- save in this script shares one transaction, so now() — and with it
  -- updated_at — never moves. A new tuple is the rewrite the trigger stamps.
  select ctid::text into v_where from meganet.station where id = '_check_rhd';
  r := meganet.save_station((r -> 'station') || jsonb_build_object('crossings', '[]'::jsonb),
                            (r ->> 'updated_at')::timestamptz);
  insert into _saved values ('empty', r -> 'station', (r ->> 'updated_at')::timestamptz);

  perform pg_temp.check_that('an empty list clears it, and the key goes from the document',
    (select count(*) from meganet.station_crossing where station_id = '_check_rhd') = 0
    and not (r -> 'station' ? 'crossings')
    and (select count(*) from meganet.station_flood_class where station_id = '_check_rhd') = 2);

  perform pg_temp.check_that('a save that changes only a list still rewrites the station row',
    (select ctid::text from meganet.station where id = '_check_rhd') <> v_where,
    'the row was not updated, so its updated_at would not move and an open editor would not be told');
end
$$;

do $$
declare
  d      jsonb := (select doc from _saved where k = 'empty');
  stamp  timestamptz := (select saved_at from _saved where k = 'empty');
  before jsonb := (select doc from meganet.station_json where id = '_check_rhd');
begin
  perform pg_temp.check_that('an unknown crossing type is refused as bad input',
    pg_temp.refusal(d || '{"crossings": [{"crossing_type": "Q", "height_m": 1}]}', stamp) = '22023');

  perform pg_temp.check_that('…in a flood class row too',
    pg_temp.refusal(d || '{"flood_classes": [{"crossing_type": "Z", "minor_m": 1}]}', stamp) = '22023');

  perform pg_temp.check_that('an unknown datum is refused as bad input',
    pg_temp.refusal(d || '{"gauge_survey": [{"datum": "LAT", "gauge_zero_m": 1}]}', stamp) = '22023');

  perform pg_temp.check_that('a list that is not a list is refused',
    pg_temp.refusal(d || '{"flood_classes": {"minor_m": 1}}', stamp) = '22023');

  perform pg_temp.check_that('a refused save wrote nothing',
    (select doc from meganet.station_json where id = '_check_rhd') = before);

  perform pg_temp.check_that('a stale stamp is still refused with PT409',
    pg_temp.refusal(d, stamp - interval '1 second') = 'PT409');
end
$$;

do $$
declare
  d      jsonb := (select doc from _saved where k = 'empty');
  stamp  timestamptz := (select saved_at from _saved where k = 'empty');
  state  text;
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    perform pg_temp.check_that('no authenticated role — the signed-in refusal is skipped', true);
    return;
  end if;
  -- A signed-in address that is not on the editors list. Set inside the block
  -- whose failure is the point, so the role goes back when the refusal rolls
  -- the block back.
  begin
    set local role authenticated;
    perform set_config('request.jwt.claims',
      '{"role": "authenticated", "email": "somebody@example.invalid"}', true);
    perform meganet.save_station(d || '{"gauge_survey": []}', stamp);
    state := 'accepted';
  exception when others then
    state := sqlstate;
  end;
  perform pg_temp.check_that('a signed-in non-editor cannot write the lists',
    state = '42501' and (select count(*) from meganet.station_gauge_survey
                          where station_id = '_check_rhd') = 2, state);
end
$$;

-- ── 3. The loader syncs them ─────────────────────────────────────────────────

do $$
declare
  doc     jsonb := (select doc from meganet.stations_json);
  stamped timestamptz := (select max(updated_at) from meganet.station_flood_class);
  n_all   integer := (select count(*) from meganet.station_flood_class);
begin
  perform meganet.load_stations_doc(doc);

  perform pg_temp.check_that('loading the database''s own document changes no list',
    (select count(*) from meganet.station_flood_class) = n_all
    and (select max(updated_at) from meganet.station_flood_class) is not distinct from stamped
    and (select count(*) from meganet.station_gauge_survey where station_id = '_check_rhd') = 2);

  -- The same document without this station's flood classes: a sync removes them.
  perform meganet.load_stations_doc(jsonb_set(doc, '{stations}',
    (select jsonb_agg(case when e ->> 'id' = '_check_rhd' then e - 'flood_classes' else e end
                      order by o)
       from jsonb_array_elements(doc -> 'stations') with ordinality x(e, o))));

  perform pg_temp.check_that('a document without a station''s list removes it',
    (select count(*) from meganet.station_flood_class where station_id = '_check_rhd') = 0
    and (select count(*) from meganet.station_gauge_survey where station_id = '_check_rhd') = 2);
end
$$;

do $$
declare
  doc jsonb := (select doc from meganet.stations_json);
begin
  -- A station no document owns keeps its lists through a load (0022's rule).
  update meganet.station set document_managed = false where id = '_check_rhd';
  perform meganet.load_stations_doc(jsonb_set(doc, '{stations}',
    (select jsonb_agg(case when e ->> 'id' = '_check_rhd' then e - 'gauge_survey' else e end
                      order by o)
       from jsonb_array_elements(doc -> 'stations') with ordinality x(e, o))));

  perform pg_temp.check_that('a station no document owns keeps its lists through a load',
    (select count(*) from meganet.station_gauge_survey where station_id = '_check_rhd') = 2);

  -- And the lists go with the station when it really goes.
  delete from meganet.station where id = '_check_rhd';
  perform pg_temp.check_that('a station deleted outright takes its lists with it',
    not exists (select 1 from meganet.station_gauge_survey where station_id = '_check_rhd')
    and not exists (select 1 from meganet.station_flood_class where station_id = '_check_rhd'));
end
$$;

-- ── The verdict ──────────────────────────────────────────────────────────────

select lpad(ord::text, 2) as "#",
       case when ok then 'ok  ' else 'FAIL' end as result,
       name,
       case when ok then '' else left(coalesce(note, ''), 160) end as detail
  from _check order by ord;

do $$
declare
  n integer;
begin
  select count(*) into n from _check where not ok;
  if n > 0 then
    raise exception '% of % checks failed', n, (select count(*) from _check);
  end if;
  raise notice 'all % checks passed', (select count(*) from _check);
end
$$;

rollback;
