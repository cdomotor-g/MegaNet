-- check_flood_peaks.sql — Prove 0037: HDB's peak flood heights in the
-- database, each put on the ground through the zero in force on its day or
-- left off it with a reason, and every station's five largest floods kept in
-- step with what they are worked out from.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_flood_peaks.sql
--
-- The whole script runs inside a transaction and rolls back, so it is safe
-- against the live database. Like the other check_*.sql it needs a role
-- meganet.is_editor() says yes to — a direct psql connection — and prints a
-- row per check, exiting non-zero if any failed.
--
-- Section 2 reads the real extract where it is loaded
-- (python3 tools/ingest/flood_peaks.py --sql | psql …, or
-- select meganet.load_flood_peaks_from_url()) and says `skip` where it is
-- not. Section 3 then loads a document of its own over it — the rollback
-- puts the real one back — onto a station it creates, `_check_peaks`, bureau
-- number 999037, which no real gauge carries.

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

create or replace function pg_temp.refusal(p_doc jsonb)
returns text language plpgsql as $$
begin
  perform meganet.load_flood_peaks_doc(p_doc);
  return 'accepted';
exception when others then
  return sqlerrm;
end
$$;

-- ── 1. The migration landed whole ────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('schema_version is at least 37',
    (select value::integer >= 37 from meganet.app_meta where key = 'schema_version'));

  perform pg_temp.check_that('the four tables exist, each with RLS and a read-for-everyone policy',
    (select count(*) = 4 and bool_and(c.relrowsecurity) from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'meganet' and c.relkind = 'r'
        and c.relname in ('flood_peak_extract', 'flood_peak_gauge', 'flood_peak',
                          'station_flood_peak_top'))
    and (select count(*) = 4 from pg_catalog.pg_policies
          where schemaname = 'meganet' and cmd = 'SELECT' and qual = 'true'
            and tablename in ('flood_peak_extract', 'flood_peak_gauge', 'flood_peak',
                              'station_flood_peak_top')));

  perform pg_temp.check_that('no policy lets anybody write them',
    not exists (select 1 from pg_catalog.pg_policies
                 where schemaname = 'meganet' and cmd <> 'SELECT'
                   and tablename in ('flood_peak_extract', 'flood_peak_gauge', 'flood_peak',
                                     'station_flood_peak_top')));

  perform pg_temp.check_that('station_json carries flood_peaks beside 0033''s lists',
    (select definition like '%''flood_peaks''%' and definition like '%''aep_levels''%'
            and definition like '%station_flood_peak_top%'
       from pg_catalog.pg_views where schemaname = 'meganet' and viewname = 'station_json'));

  perform pg_temp.check_that('eleven triggers keep the five current: three on each input list, two on the station',
    (select count(*) = 11 from pg_catalog.pg_trigger
      where not tgisinternal and tgname like '%\_flood\_peaks\_%'
        and tgrelid in ('meganet.station_gauge_survey'::regclass,
                        'meganet.station_flood_class'::regclass,
                        'meganet.station_aep_level'::regclass,
                        'meganet.station'::regclass)));
end
$$;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    perform pg_temp.check_that('no anon role — grant checks skipped', true,
      'a plain Postgres rather than a Supabase-shaped one');
    return;
  end if;

  perform pg_temp.check_that('anon may read the peaks, the gauges, the extract, the five and the view',
    (select bool_and(has_table_privilege('anon', 'meganet.' || t, 'select'))
       from unnest(array['flood_peak_extract', 'flood_peak_gauge', 'flood_peak',
                         'station_flood_peak_top', 'station_flood_peak']) t)
    and has_function_privilege('anon', 'meganet.station_flood_peaks(text[])', 'execute'));

  perform pg_temp.check_that('neither browser role may write any of them directly',
    (select bool_and(not has_table_privilege(r, 'meganet.' || t, 'insert')
                 and not has_table_privilege(r, 'meganet.' || t, 'update')
                 and not has_table_privilege(r, 'meganet.' || t, 'delete'))
       from unnest(array['flood_peak_extract', 'flood_peak_gauge', 'flood_peak',
                         'station_flood_peak_top']) t
      cross join unnest(array['anon', 'authenticated']) r));

  perform pg_temp.check_that('only the service role may load, fetch or rebuild',
    (select bool_and(not has_function_privilege(r, f, 'execute'))
       from unnest(array['anon', 'authenticated']) r
      cross join unnest(array['meganet.load_flood_peaks_doc(jsonb)',
                              'meganet.load_flood_peaks_from_url(text)',
                              'meganet.refresh_station_flood_peaks(text[])']) f)
    and has_function_privilege('service_role', 'meganet.load_flood_peaks_doc(jsonb)', 'execute')
    and has_function_privilege('service_role', 'meganet.refresh_station_flood_peaks(text[])', 'execute'));
end
$$;

-- ── 2. The extract, where it is loaded ───────────────────────────────────────

do $$
declare
  meta jsonb := (select e.meta from meganet.flood_peak_extract e);
begin
  if meta is null then
    perform pg_temp.check_that('skip: the HDB extract is not loaded', true,
      'python3 tools/ingest/flood_peaks.py --sql | psql … loads it');
    return;
  end if;

  perform pg_temp.check_that('the tables hold what the file says: its gauges and its peaks',
    (select count(*) from meganet.flood_peak_gauge) = (meta ->> 'gauges')::integer
    and (select count(*) from meganet.flood_peak) = (meta ->> 'peaks')::integer,
    format('%s gauges and %s peaks for a file of %s and %s',
           (select count(*) from meganet.flood_peak_gauge), (select count(*) from meganet.flood_peak),
           meta ->> 'gauges', meta ->> 'peaks'));

  perform pg_temp.check_that('the kept five are exactly the ranked five',
    not exists (select station_id, flood_rank, bureau_number, ord, date_text, height_m, level_m_ahd
                  from meganet.station_flood_peak_top
                except
                select station_id, flood_rank, bureau_number, ord, date_text, height_m, level_m_ahd
                  from meganet.station_flood_peak where flood_rank is not null)
    and not exists (select station_id, flood_rank, bureau_number, ord, date_text, height_m, level_m_ahd
                      from meganet.station_flood_peak where flood_rank is not null
                    except
                    select station_id, flood_rank, bureau_number, ord, date_text, height_m, level_m_ahd
                      from meganet.station_flood_peak_top));

  perform pg_temp.check_that('every station''s five run 1, 2, 3… with no gap, largest first, one to a season',
    not exists (
      select 1 from (
        select station_id,
               array_agg(flood_rank order by flood_rank) as ranks,
               count(distinct season) as seasons, count(*) as n,
               bool_and(level_m_ahd is not null) as placed, bool_or(level_m_ahd is not null) as some,
               array_agg(coalesce(level_m_ahd, height_m) order by flood_rank) as sizes
          from meganet.station_flood_peak where flood_rank is not null
         group by station_id) s
       where s.ranks <> (select array_agg(i) from generate_series(1, s.n::integer) i)
          or s.seasons <> s.n
          or s.placed <> s.some
          or s.sizes <> (select array_agg(v order by v desc) from unnest(s.sizes) v)));

  perform pg_temp.check_that('no placed peak is off its anchor by more than the rule allows',
    not exists (select 1 from meganet.station_flood_peak
                 where level_m_ahd is not null
                   and (level_m_ahd > anchor_m + 20 or level_m_ahd < anchor_m - 30)));

  perform pg_temp.check_that('Beenleigh''s largest flood is HDB''s 1887 mark, 8.10 m on a zero of 0 m AHD',
    (select doc -> 'flood_peaks' -> 0 = '{"date": "1887", "height_m": 8.10, "level_m_ahd": 8.10}'::jsonb
       from meganet.station_json where id = 'beenleigh'),
    (select (doc -> 'flood_peaks')::text from meganet.station_json where id = 'beenleigh'));

  perform pg_temp.check_that('Ipswich: 1974 through the zero surveyed in 1967, 2011 through the one of 1975',
    (select level_m_ahd = 21.72 from meganet.station_flood_peak
      where station_id = 'ipswich' and date_text = '1974-01-27' and flood_rank is not null)
    and (select level_m_ahd = 19.25 from meganet.station_flood_peak
          where station_id = 'ipswich' and date_text = '2011-01-12' and flood_rank is not null));

  perform pg_temp.check_that('Little Nerang Dam''s 1996 peak written in m AHD is left off, and the same peak on the gauge is placed',
    (select not_placed like 'more than 20 m above%' from meganet.station_flood_peak
      where station_id = 'little_nerang_dam_al' and height_m = 169.38)
    and (select level_m_ahd = 169.37 from meganet.station_flood_peak
          where station_id = 'little_nerang_dam_al' and height_m = 1.35
            and peak_date = '1996-05-05'));

  perform pg_temp.check_that('a peak at 23:47 UTC on 30 March 2017 is the flood of 31 March in Queensland',
    (select date_text = '2017-03-31' from meganet.station_flood_peak
      where station_id = 'little_nerang_dam_al' and peak_date = '2017-03-30'
        and time_utc = '23:47'));

  perform pg_temp.check_that('no station outside the extract, and no deleted one, carries flood_peaks',
    not exists (select 1 from meganet.station_json j
                  join meganet.station s on s.id = j.id
                 where j.doc ? 'flood_peaks'
                   and not exists (select 1 from meganet.flood_peak_gauge g
                                    where meganet.bureau_key(g.bureau_number)
                                        = meganet.bureau_key(s.station_number))));
end
$$;

-- ── 3. The rules, on a gauge of our own ──────────────────────────────────────
-- A station re-levelled on 1 July 2000, from a zero of 48.00 m AHD to 50.00,
-- with a major class of 5.0 m (55.00 m AHD today), and a gauge whose peaks
-- test each rule: a year alone, a month alone, a peak older than the survey,
-- one on each zero, two in one season, one written in m AHD, and an hour
-- that is the next day in Queensland.

do $$
declare
  r      jsonb;
  v_doc  jsonb;
  got    jsonb;
  stamp  timestamptz;
begin
  r := meganet.save_station(jsonb_build_object(
    'id', '_check_peaks', 'name', 'Check flood peaks', 'station_number', '999037',
    'roles', jsonb_build_array('field'),
    'flood_classes', jsonb_build_array(
      jsonb_build_object('as_at', '2026-09-25', 'minor_m', 3.0, 'moderate_m', 4.0, 'major_m', 5.0)),
    'gauge_survey', jsonb_build_array(
      jsonb_build_object('valid_from', '1990-01-01', 'valid_to', '2000-07-01',
                         'gauge_zero_m', 48.00, 'datum', 'AHD'),
      jsonb_build_object('valid_from', '2000-07-01', 'gauge_zero_m', 50.00, 'datum', 'AHD'))));

  v_doc := jsonb_build_object(
    'meta', jsonb_build_object(
      'title', 'check_flood_peaks.sql', 'extracted', '2026-09-28',
      'source', jsonb_build_object('file', 'tools/check_flood_peaks.sql'),
      'peak_columns', '["date", "time_utc", "height_m", "site", "source", "type"]'::jsonb),
    'gauges', jsonb_build_array(jsonb_build_object(
      'bureau_number', '999037', 'name', 'CHECK FLOOD PEAKS', 'stream', 'CHECK CREEK',
      'basin', 'CHECK', 'file', 'CHECK_PEAKS_NEW.TXT',
      'peaks', '[
        ["1974",       null,    7.00, "A", "OTHER",     "FLOOD MARK"],
        ["1956-02",    null,    6.50, "A", "REGISTER",  "MANUAL OBS"],
        ["1985-03-01", null,    3.00, "A", "REGISTER",  "MANUAL OBS"],
        ["1995-02-10", "06:00", 6.00, "A", "LOG SHEET", "INSTRUMENT"],
        ["2005-02-10", "06:00", 4.00, "B", "LOG SHEET", "INSTRUMENT"],
        ["2005-02-11", "06:00", 54.00, "B", "LOG SHEET", "INSTRUMENT"],
        ["2010-12-30", "06:00", 5.80, "B", "LOG SHEET", "INSTRUMENT"],
        ["2011-01-12", "18:00", 5.90, "B", "LOG SHEET", "INSTRUMENT"]
      ]'::jsonb)));

  perform pg_temp.check_that('a document with its peak columns moved is refused by name',
    pg_temp.refusal(jsonb_set(v_doc, '{meta,peak_columns}',
                              '["time_utc", "date", "height_m", "site", "source", "type"]'::jsonb))
      like 'the document''s peaks are not in the columns this reads%');

  perform pg_temp.check_that('a date the loader cannot read is refused, naming it',
    pg_temp.refusal(jsonb_set(v_doc, '{gauges,0,peaks,0,0}', '"27/01/1974"'::jsonb))
      like 'peaks with a date this cannot read: 27/01/1974%');

  perform meganet.load_flood_peaks_doc(v_doc);

  perform pg_temp.check_that('the document is all that is left: one gauge, eight peaks, in the order given',
    (select count(*) from meganet.flood_peak_gauge) = 1
    and (select array_agg(ord order by ord) from meganet.flood_peak)
        = array[0, 1, 2, 3, 4, 5, 6, 7]
    and (select date_precision from meganet.flood_peak where ord = 0) = 'year'
    and (select peak_date from meganet.flood_peak where ord = 1) = '1956-02-01');

  perform pg_temp.check_that('each peak stands on the zero of its day, and one older than the survey on the oldest',
    (select array_agg(zero_m order by ord) from meganet.station_flood_peak
      where station_id = '_check_peaks')
      = array[48.00, 48.00, 48.00, 48.00, 50.00, 50.00, 50.00, 50.00]::numeric[]
    and (select array_agg(zero_in_force order by ord) from meganet.station_flood_peak
          where station_id = '_check_peaks')
      = array[false, false, false, true, true, true, true, true]);

  perform pg_temp.check_that('the peak written in m AHD — 104 m against a major of 55 — is left off, and says why',
    (select level_m_ahd is null and not_placed = 'more than 20 m above this gauge''s flood levels'
       from meganet.station_flood_peak where station_id = '_check_peaks' and ord = 5));

  got := (select j.doc -> 'flood_peaks' from meganet.station_json j where j.id = '_check_peaks');
  perform pg_temp.check_that('the five: largest first, one a season, the hour-18 peak on the next day, levels through the day''s zero',
    got = '[
      {"date": "2011-01-13", "height_m": 5.90, "level_m_ahd": 55.90},
      {"date": "1974",       "height_m": 7.00, "level_m_ahd": 55.00},
      {"date": "1956-02",    "height_m": 6.50, "level_m_ahd": 54.50},
      {"date": "1995-02-10", "height_m": 6.00, "level_m_ahd": 54.00},
      {"date": "2005-02-10", "height_m": 4.00, "level_m_ahd": 54.00}
    ]'::jsonb,
    coalesce(got::text, 'no flood_peaks'));

  -- The survey moves: the triggers rebuild the station's five with it.
  update meganet.station_gauge_survey set gauge_zero_m = 51.00
   where station_id = '_check_peaks' and valid_from = '2000-07-01';
  perform pg_temp.check_that('a zero re-surveyed moves the kept levels with it',
    (select level_m_ahd from meganet.station_flood_peak_top
      where station_id = '_check_peaks' and flood_rank = 1) = 56.90);

  select j.doc, j.updated_at into got, stamp from meganet.station_json j where j.id = '_check_peaks';
  perform meganet.save_station(
    jsonb_set(got, '{gauge_survey}', jsonb_build_array(
      jsonb_build_object('valid_from', '1990-01-01', 'gauge_zero_m', 48.00, 'datum', 'ASSUM'))),
    stamp);
  perform pg_temp.check_that('saved through the editor with a zero off AHD: the five are gauge heights with no level',
    (select j.doc -> 'flood_peaks' from meganet.station_json j where j.id = '_check_peaks')
    = '[
      {"date": "2005-02-11", "height_m": 54.00},
      {"date": "1974",       "height_m": 7.00},
      {"date": "1956-02",    "height_m": 6.50},
      {"date": "1995-02-10", "height_m": 6.00},
      {"date": "2011-01-13", "height_m": 5.90}
    ]'::jsonb,
    (select (j.doc -> 'flood_peaks')::text from meganet.station_json j where j.id = '_check_peaks'));

  perform pg_temp.check_that('the document the editor saved back carried flood_peaks, and the peaks stayed as loaded',
    (select count(*) from meganet.flood_peak where bureau_number = '999037') = 8);

  update meganet.station set station_number = '999038' where id = '_check_peaks';
  perform pg_temp.check_that('a station renumbered off the gauge loses its five',
    not exists (select 1 from meganet.station_flood_peak_top where station_id = '_check_peaks')
    and not (select j.doc ? 'flood_peaks' from meganet.station_json j where j.id = '_check_peaks'));
  update meganet.station set station_number = '0999037' where id = '_check_peaks';
  perform pg_temp.check_that('…and gets them back under its number with a leading zero',
    (select count(*) from meganet.station_flood_peak_top where station_id = '_check_peaks') = 5);

  update meganet.station set deleted_at = now() where id = '_check_peaks';
  perform pg_temp.check_that('a deleted station keeps no five',
    not exists (select 1 from meganet.station_flood_peak_top where station_id = '_check_peaks'));
  update meganet.station set deleted_at = null where id = '_check_peaks';

  perform meganet.load_flood_peaks_doc(jsonb_set(v_doc, '{gauges}', '[]'::jsonb));
  perform pg_temp.check_that('a gauge the next extract drops goes, its peaks and its five with it',
    not exists (select 1 from meganet.flood_peak_gauge)
    and not exists (select 1 from meganet.flood_peak)
    and not exists (select 1 from meganet.station_flood_peak_top where station_id = '_check_peaks'));

  perform meganet.load_flood_peaks_doc(v_doc);
  perform meganet.load_flood_peaks_doc(v_doc);
  perform pg_temp.check_that('loading the same document twice leaves one copy',
    (select count(*) from meganet.flood_peak) = 8
    and (select count(*) from meganet.station_flood_peak_top where station_id = '_check_peaks') = 5);

  delete from meganet.station where id = '_check_peaks';
  perform pg_temp.check_that('a station deleted outright takes its five with it',
    not exists (select 1 from meganet.station_flood_peak_top where station_id = '_check_peaks'));
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
  s integer;
begin
  select count(*) into n from _check where not ok;
  select count(*) into s from _check where name like 'skip:%';
  if n > 0 then
    raise exception '% of % checks failed', n, (select count(*) from _check);
  end if;
  raise notice 'all % checks passed%', (select count(*) from _check) - s,
    case when s > 0 then format(', %s skipped — the extract is not loaded', s) else '' end;
end
$$;

rollback;
