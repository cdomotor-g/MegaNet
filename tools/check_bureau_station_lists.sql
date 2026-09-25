-- check_bureau_station_lists.sql — Prove 0032: a station's index listings and
-- flood effects, its AWRC number, stream and URBS label, the vocabulary of the
-- Bureau's indexes, and the two write paths.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_bureau_station_lists.sql
--
-- The whole script runs inside a transaction and rolls back, so it is safe
-- against the live database. Like the other check_*.sql it needs a role
-- meganet.is_editor() says yes to — a direct psql connection — and prints a row
-- per check, exiting non-zero if any failed.
--
-- The station it writes is `_check_bsl`, bureau number 999032, which no real
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
  perform pg_temp.check_that('schema_version is at least 32',
    (select value::integer >= 32 from meganet.app_meta where key = 'schema_version'));

  perform pg_temp.check_that('the station has its three new fields',
    (select count(*) = 3 from information_schema.columns
      where table_schema = 'meganet' and table_name = 'station'
        and column_name in ('awrc_number', 'stream', 'urbs_label')));

  perform pg_temp.check_that('all three tables exist, with RLS on',
    (select count(*) = 3 and bool_and(c.relrowsecurity) from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'meganet' and c.relkind = 'r'
        and c.relname in ('bureau_index', 'station_bureau_listing', 'station_flood_effect')));

  perform pg_temp.check_that('each of the three has a read-for-everyone policy',
    (select count(*) = 3 from pg_catalog.pg_policies
      where schemaname = 'meganet' and cmd = 'SELECT' and qual = 'true'
        and tablename in ('bureau_index', 'station_bureau_listing', 'station_flood_effect')));

  perform pg_temp.check_that('the indexes are the Bureau''s Sections 1, 2 and 3',
    (select string_agg(code || '=' || label, ' ' order by ord) from meganet.bureau_index)
      = '1=FloodWarn rainfall 2=Daily rainfall 3=River height',
    (select string_agg(code || '=' || label, ' ' order by ord) from meganet.bureau_index));
end
$$;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    perform pg_temp.check_that('no anon role — grant checks skipped', true,
      'a plain Postgres rather than a Supabase-shaped one');
    return;
  end if;

  perform pg_temp.check_that('anon may read all three — the card is for anybody',
    (select bool_and(has_table_privilege('anon', 'meganet.' || t, 'select'))
       from unnest(array['bureau_index', 'station_bureau_listing', 'station_flood_effect']) t));

  perform pg_temp.check_that('neither browser role may write any of them directly',
    (select bool_and(not has_table_privilege(r, 'meganet.' || t, 'insert')
                 and not has_table_privilege(r, 'meganet.' || t, 'update')
                 and not has_table_privilege(r, 'meganet.' || t, 'delete'))
       from unnest(array['bureau_index', 'station_bureau_listing', 'station_flood_effect']) t
      cross join unnest(array['anon', 'authenticated']) r));
end
$$;

-- ── 2. save_station() writes the two lists and the three fields ─────────────

do $$
declare
  r jsonb;
begin
  r := meganet.save_station(jsonb_build_object(
    'id', '_check_bsl', 'name', 'Check Bureau Station Lists', 'station_number', '999032',
    'roles', jsonb_build_array('field'),
    'awrc_number', '011902', 'stream', ' BLACKWATER CREEK ', 'urbs_label', '',
    'bureau_listings', jsonb_build_array(
      jsonb_build_object('section', '3', 'as_at', '2026-09-26'),
      jsonb_build_object('as_at', ''),                                   -- a blank row
      jsonb_build_object('section', '1', 'as_at', '2026-09-25', 'note', '  ')),
    'flood_effects', jsonb_build_array(
      jsonb_build_object('as_at', '2026-09-26', 'height_m', 0.99, 'effect', 'Highest Astronomical Tide'),
      jsonb_build_object('as_at', '2026-09-26'),                         -- a blank row
      jsonb_build_object('as_at', '2026-09-26', 'height_m', 94.50, 'effect', 'Spillway',
                         'detail', 'Hinze Dam spillway'))));
  insert into _saved values ('first', r -> 'station', (r ->> 'updated_at')::timestamptz);

  perform pg_temp.check_that('a new station saves with both lists, blank rows dropped',
    (select array_agg(section order by ord) from meganet.station_bureau_listing
      where station_id = '_check_bsl') = array['3', '1']
    and (select array_agg(ord order by ord) from meganet.station_flood_effect
          where station_id = '_check_bsl') = array[0, 1]);

  perform pg_temp.check_that('a height keeps the digits it was written with',
    (r -> 'station' -> 'flood_effects' -> 1 ->> 'height_m') = '94.50',
    (r -> 'station' -> 'flood_effects' -> 1)::text);

  perform pg_temp.check_that('a row carries no key for what it does not state',
    not (r -> 'station' -> 'flood_effects' -> 0 ? 'detail')
    and not (r -> 'station' -> 'bureau_listings' -> 1 ? 'note'),
    (r -> 'station' -> 'bureau_listings')::text);

  perform pg_temp.check_that('the fields are trimmed, a blank one is no field at all',
    (r -> 'station' ->> 'awrc_number') = '011902'
    and (r -> 'station' ->> 'stream') = 'BLACKWATER CREEK'
    and not (r -> 'station' ? 'urbs_label')
    and (select urbs_label is null from meganet.station where id = '_check_bsl'),
    (r -> 'station')::text);
end
$$;

do $$
declare
  d      jsonb := (select doc from _saved where k = 'first');
  stamp  timestamptz := (select saved_at from _saved where k = 'first');
  r      jsonb;
begin
  r := meganet.save_station((d - 'bureau_listings' - 'flood_effects')
                              || jsonb_build_object('urbs_label', 'CHECK_BS'),
                            stamp);
  insert into _saved values ('absent', r -> 'station', (r ->> 'updated_at')::timestamptz);

  perform pg_temp.check_that('a save that does not mention a list leaves it alone',
    (select count(*) from meganet.station_bureau_listing where station_id = '_check_bsl') = 2
    and (select count(*) from meganet.station_flood_effect where station_id = '_check_bsl') = 2
    and (r -> 'station' ->> 'urbs_label') = 'CHECK_BS');

  r := meganet.save_station((r -> 'station') || jsonb_build_object('flood_effects', '[]'::jsonb),
                            (r ->> 'updated_at')::timestamptz);
  insert into _saved values ('empty', r -> 'station', (r ->> 'updated_at')::timestamptz);

  perform pg_temp.check_that('an empty list clears it, and the key goes from the document',
    (select count(*) from meganet.station_flood_effect where station_id = '_check_bsl') = 0
    and not (r -> 'station' ? 'flood_effects')
    and (select count(*) from meganet.station_bureau_listing where station_id = '_check_bsl') = 2);
end
$$;

do $$
declare
  d      jsonb := (select doc from _saved where k = 'empty');
  stamp  timestamptz := (select saved_at from _saved where k = 'empty');
  before jsonb := (select doc from meganet.station_json where id = '_check_bsl');
begin
  perform pg_temp.check_that('an index the Bureau does not print is refused as bad input',
    pg_temp.refusal(d || '{"bureau_listings": [{"section": "7", "as_at": "2026-09-26"}]}', stamp) = '22023');

  perform pg_temp.check_that('a listing with a date but no section is refused, not dropped',
    pg_temp.refusal(d || '{"bureau_listings": [{"as_at": "2026-09-26", "note": "joined"}]}', stamp) = '22023');

  perform pg_temp.check_that('a list that is not a list is refused',
    pg_temp.refusal(d || '{"flood_effects": {"height_m": 1}}', stamp) = '22023');

  perform pg_temp.check_that('a refused save wrote nothing',
    (select doc from meganet.station_json where id = '_check_bsl') = before);
end
$$;

-- ── 3. The loader syncs them ─────────────────────────────────────────────────

do $$
declare
  doc     jsonb := (select doc from meganet.stations_json);
  stamped timestamptz := (select max(updated_at) from meganet.station_bureau_listing);
  n_all   integer := (select count(*) from meganet.station_bureau_listing);
begin
  perform meganet.load_stations_doc(doc);

  perform pg_temp.check_that('loading the database''s own document changes no listing',
    (select count(*) from meganet.station_bureau_listing) = n_all
    and (select max(updated_at) from meganet.station_bureau_listing) is not distinct from stamped
    and (select awrc_number from meganet.station where id = '_check_bsl') = '011902');

  perform meganet.load_stations_doc(jsonb_set(doc, '{stations}',
    (select jsonb_agg(case when e ->> 'id' = '_check_bsl'
                           then e - 'bureau_listings' - 'stream' else e end order by o)
       from jsonb_array_elements(doc -> 'stations') with ordinality x(e, o))));

  perform pg_temp.check_that('a document without a station''s listings and stream removes them',
    (select count(*) from meganet.station_bureau_listing where station_id = '_check_bsl') = 0
    and (select stream is null and awrc_number = '011902' from meganet.station
          where id = '_check_bsl'));

  delete from meganet.station where id = '_check_bsl';
  perform pg_temp.check_that('a station deleted outright takes its lists with it',
    not exists (select 1 from meganet.station_flood_effect where station_id = '_check_bsl')
    and not exists (select 1 from meganet.station_bureau_listing where station_id = '_check_bsl'));
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
