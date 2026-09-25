-- check_aep_levels_and_frequencies.sql — Prove 0033: a station's AEP flood
-- levels and its frequencies, and the two write paths that carry them.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_aep_levels_and_frequencies.sql
--
-- The whole script runs inside a transaction and rolls back, so it is safe
-- against the live database. Like the other check_*.sql it needs a role
-- meganet.is_editor() says yes to — a direct psql connection — and prints a row
-- per check, exiting non-zero if any failed.
--
-- The station it writes is `_check_aep`, bureau number 999032, which no real
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
  perform pg_temp.check_that('schema_version is at least 33',
    (select value::integer >= 33 from meganet.app_meta where key = 'schema_version'));

  perform pg_temp.check_that('both tables exist',
    (select count(*) = 2 from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'meganet' and c.relkind = 'r'
        and c.relname in ('station_aep_level', 'station_frequency')));

  perform pg_temp.check_that('RLS is on for both, each with a read-for-everyone policy',
    (select bool_and(c.relrowsecurity) from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'meganet' and c.relname in ('station_aep_level', 'station_frequency'))
    and (select count(*) = 2 from pg_catalog.pg_policies
          where schemaname = 'meganet' and cmd = 'SELECT' and qual = 'true'
            and tablename in ('station_aep_level', 'station_frequency')));

  perform pg_temp.check_that('0031''s lists are still in the view',
    (select definition like '%''flood_classes''%' and definition like '%''gauge_survey''%'
       from pg_catalog.pg_views where schemaname = 'meganet' and viewname = 'station_json'));
end
$$;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    perform pg_temp.check_that('no anon role — grant checks skipped', true,
      'a plain Postgres rather than a Supabase-shaped one');
    return;
  end if;

  perform pg_temp.check_that('anon may read both — the card is for anybody',
    (select bool_and(has_table_privilege('anon', 'meganet.' || t, 'select'))
       from unnest(array['station_aep_level', 'station_frequency']) t));

  perform pg_temp.check_that('neither browser role may write either directly',
    (select bool_and(not has_table_privilege(r, 'meganet.' || t, 'insert')
                 and not has_table_privilege(r, 'meganet.' || t, 'update')
                 and not has_table_privilege(r, 'meganet.' || t, 'delete'))
       from unnest(array['station_aep_level', 'station_frequency']) t
      cross join unnest(array['anon', 'authenticated']) r));
end
$$;

-- ── 2. save_station() writes the two lists ───────────────────────────────────

do $$
declare
  r jsonb;
begin
  r := meganet.save_station(jsonb_build_object(
    'id', '_check_aep', 'name', 'Check AEP levels', 'station_number', '999032',
    'roles', jsonb_build_array('field', 'base'),
    'aep_levels', jsonb_build_array(
      jsonb_build_object('as_at', '2026-09-26', 'source', 'QLD_AEP_Levels_1.xlsx (FWIN_QLD_V9_2)',
                         'point_lat', -27.2136, 'point_lon', 151.1858, 'ground_m', 336.50,
                         'aep_1_m', 338.69, 'aep_0_5_m', 338.91, 'aep_0_2_m', 338.94,
                         'aep_0_066_m', 338.98, 'data_quality', 2, 'level_difference', 2,
                         'confidence', 4, 'slope', 0.000989, 'slope_basis', 'from a neighbour'),
      jsonb_build_object('as_at', '2027-01-01', 'source', 'a blank row'),
      jsonb_build_object('ground_m', 12.00, 'setting', 'channel', 'manning_n', 0.040,
                         'note', '  ')),
    'frequencies', jsonb_build_array(
      jsonb_build_object('rx_mhz', 151.5125, 'tx_mhz', 151.5125, 'label', 'ALERT 2',
                         'acma_licence', '10182196/1'),
      jsonb_build_object('label', 'no frequency at all'),
      jsonb_build_object('tx_mhz', 162.050, 'label', '  '))));
  insert into _saved values ('first', r -> 'station', (r ->> 'updated_at')::timestamptz);

  perform pg_temp.check_that('a new station saves with both lists',
    (select count(*) from meganet.station_aep_level where station_id = '_check_aep') = 2
    and (select count(*) from meganet.station_frequency where station_id = '_check_aep') = 2);

  perform pg_temp.check_that('a blank row is dropped and the rest renumber from 0',
    (select array_agg(ord order by ord) from meganet.station_aep_level
      where station_id = '_check_aep') = array[0, 1]
    and (select array_agg(ord order by ord) from meganet.station_frequency
          where station_id = '_check_aep') = array[0, 1]);

  perform pg_temp.check_that('a figure keeps the digits it was written with',
    (r -> 'station' -> 'aep_levels' -> 0 ->> 'ground_m') = '336.50'
    and (r -> 'station' -> 'aep_levels' -> 1 ->> 'manning_n') = '0.040'
    and (r -> 'station' -> 'frequencies' -> 0 ->> 'rx_mhz') = '151.5125'
    and (r -> 'station' -> 'frequencies' -> 1 ->> 'tx_mhz') = '162.050',
    (r -> 'station' -> 'frequencies')::text);

  perform pg_temp.check_that('a row carries no key for what it does not state',
    not (r -> 'station' -> 'aep_levels' -> 1 ? 'note')
    and not (r -> 'station' -> 'aep_levels' -> 1 ? 'aep_1_m')
    and not (r -> 'station' -> 'frequencies' -> 1 ? 'rx_mhz')
    and not (r -> 'station' -> 'frequencies' -> 1 ? 'label'),
    (r -> 'station' -> 'aep_levels' -> 1)::text);

  perform pg_temp.check_that('the scores come back as whole numbers',
    (r -> 'station' -> 'aep_levels' -> 0 -> 'confidence') = '4'::jsonb);
end
$$;

do $$
declare
  d      jsonb := (select doc from _saved where k = 'first');
  stamp  timestamptz := (select saved_at from _saved where k = 'first');
  r      jsonb;
begin
  -- Every document a client older than 0033 builds leaves the two keys out.
  r := meganet.save_station((d - 'aep_levels' - 'frequencies')
                              || jsonb_build_object('name', 'Check AEP levels, renamed'), stamp);
  perform pg_temp.check_that('a save that does not mention a list leaves it alone',
    (select count(*) from meganet.station_aep_level where station_id = '_check_aep') = 2
    and (select count(*) from meganet.station_frequency where station_id = '_check_aep') = 2
    and jsonb_array_length(r -> 'station' -> 'frequencies') = 2);

  r := meganet.save_station((r -> 'station') || jsonb_build_object('frequencies', '[]'::jsonb),
                            (r ->> 'updated_at')::timestamptz);
  insert into _saved values ('empty', r -> 'station', (r ->> 'updated_at')::timestamptz);
  perform pg_temp.check_that('an empty list clears it, and the key goes from the document',
    (select count(*) from meganet.station_frequency where station_id = '_check_aep') = 0
    and not (r -> 'station' ? 'frequencies')
    and (select count(*) from meganet.station_aep_level where station_id = '_check_aep') = 2);
end
$$;

do $$
declare
  d      jsonb := (select doc from _saved where k = 'empty');
  stamp  timestamptz := (select saved_at from _saved where k = 'empty');
  before jsonb := (select doc from meganet.station_json where id = '_check_aep');
begin
  perform pg_temp.check_that('a setting that is neither channel nor floodplain is refused',
    pg_temp.refusal(d || '{"aep_levels": [{"setting": "gorge", "ground_m": 1}]}', stamp) = '22023');
  perform pg_temp.check_that('…and a score out of its range',
    pg_temp.refusal(d || '{"aep_levels": [{"confidence": 10, "ground_m": 1}]}', stamp) = '22023');
  perform pg_temp.check_that('…and a Manning n nobody would use',
    pg_temp.refusal(d || '{"aep_levels": [{"manning_n": 2, "ground_m": 1}]}', stamp) = '22023');
  perform pg_temp.check_that('…and a negative slope',
    pg_temp.refusal(d || '{"aep_levels": [{"slope": -0.001, "ground_m": 1}]}', stamp) = '22023');
  perform pg_temp.check_that('a frequency of zero MHz is refused',
    pg_temp.refusal(d || '{"frequencies": [{"rx_mhz": 0}]}', stamp) = '22023');
  perform pg_temp.check_that('a list that is not a list is refused',
    pg_temp.refusal(d || '{"frequencies": {"rx_mhz": 151}}', stamp) = '22023');
  perform pg_temp.check_that('a refused save wrote nothing',
    (select doc from meganet.station_json where id = '_check_aep') = before);
end
$$;

-- ── 3. The loader syncs them ─────────────────────────────────────────────────

do $$
declare
  doc     jsonb := (select doc from meganet.stations_json);
  stamped timestamptz := (select max(updated_at) from meganet.station_aep_level);
  n_all   integer := (select count(*) from meganet.station_aep_level);
begin
  perform meganet.load_stations_doc(doc);
  perform pg_temp.check_that('loading the database''s own document changes no row',
    (select count(*) from meganet.station_aep_level) = n_all
    and (select max(updated_at) from meganet.station_aep_level) is not distinct from stamped);

  perform meganet.load_stations_doc(jsonb_set(doc, '{stations}',
    (select jsonb_agg(case when e ->> 'id' = '_check_aep'
                           then e - 'aep_levels' || '{"frequencies": [{"rx_mhz": 150.1}]}'
                           else e end order by o)
       from jsonb_array_elements(doc -> 'stations') with ordinality x(e, o))));
  perform pg_temp.check_that('a document without a station''s list removes it, and one with a list adds it',
    (select count(*) from meganet.station_aep_level where station_id = '_check_aep') = 0
    and (select rx_mhz from meganet.station_frequency where station_id = '_check_aep') = 150.1);

  delete from meganet.station where id = '_check_aep';
  perform pg_temp.check_that('a station deleted outright takes its lists with it',
    not exists (select 1 from meganet.station_frequency where station_id = '_check_aep'));
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
