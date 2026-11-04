-- check_station_benchmarks.sql — Prove the Bureau's benchmarks (0101) against a
-- real database: the loader makes the table match a document and refuses one
-- it cannot read, the view puts each benchmark on its station and on the gauge
-- only where the datums agree, and nobody but an editor reads any of it.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_station_benchmarks.sql
--
-- One row per claim, a non-zero exit if any fails, and the whole script in a
-- transaction that rolls back, so it is safe against the live database: the
-- fixture stations, the people and the document it loads all go, and the
-- benchmarks the live database held come back. Run it as the owner — a direct
-- psql connection. CI runs it in the db-checks job after every migration has
-- been applied from zero.
--
-- What it deliberately does not check: reading the report, which is
-- tools/ingest/benchmarks.py's (its --check runs in the private repository),
-- and the Level Survey's list, which is level-survey.js's.

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

-- One statement as another role with a request's claims, answering its first
-- column as text — or the SQLSTATE when it fails. Rolled back to where it
-- started either way, so nothing a role does here outlives the statement.
create or replace function pg_temp.as_role(p_role text, p_claims text, p_sql text)
returns text language plpgsql as $$
declare
  v       text;
  v_state text;
begin
  begin
    execute pg_catalog.format('set local role %I', p_role);
    perform pg_catalog.set_config('request.jwt.claims', p_claims, true);
    execute p_sql into v;
    raise exception using errcode = 'MNRLB', message = coalesce(v, '(null)');
  exception
    when sqlstate 'MNRLB' then
      get stacked diagnostics v = message_text;
      return v;
    when others then
      get stacked diagnostics v_state = returned_sqlstate;
      return 'error ' || v_state;
  end;
end;
$$;

-- What a load says, or the error it raised.
create or replace function pg_temp.load(p_doc jsonb)
returns text language plpgsql as $$
begin
  return meganet.load_benchmarks_doc(p_doc);
exception when others then
  return 'error: ' || sqlerrm;
end;
$$;

-- ── Fixtures ─────────────────────────────────────────────────────────────────
-- Three stations in the Tasman Sea — one on AHD, one on a State datum, one
-- deleted — and a number the document lists that is nobody's station. Four
-- people: an editor, a stranger, nobody signed in, and the service key.

insert into meganet.rm_system (id, ord, name)
values (-971, -971, 'check_station_benchmarks placeholder')
on conflict (id) do nothing;

insert into meganet.station (id, ord, name, station_number, rm_system_id, lat, lon, roles) values
  ('_check_bm_ahd',   -971, 'Check Benchmark Creek', '997101', -971, -31.7, 161.2, '{field}'),
  ('_check_bm_state', -972, 'Check Benchmark Weir',  '97102',  -971, -31.8, 161.3, '{field}'),
  ('_check_bm_gone',  -973, 'Check Benchmark Gone',  '997103', -971, -31.9, 161.4, '{field}')
on conflict (id) do nothing;
update meganet.station set deleted_at = now() where id = '_check_bm_gone';

-- The AHD station was re-levelled: the zero in force is the open row, not the
-- one that ended — and not the older open-ended one either.
insert into meganet.station_gauge_survey (station_id, ord, valid_from, valid_to, gauge_zero_m, datum) values
  ('_check_bm_ahd',   0, '2010-01-01', '2020-01-01', 99.00, 'AHD'),
  ('_check_bm_ahd',   1, '2020-01-01', null,        100.50, 'AHD'),
  ('_check_bm_ahd',   2, '2005-01-01', null,         98.00, 'AHD'),
  ('_check_bm_state', 0, '1993-03-19', null,         29.45, 'STATE');

insert into meganet.editor_allow (entry, note) values
  ('bm-editor@example.test', 'check_station_benchmarks — rolled back')
on conflict (entry) do nothing;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000b7101', 'bm-editor@example.test', now())
on conflict (id) do nothing;

create temporary table _who (k text primary key, role text, claims text) on commit drop;
insert into _who values
  ('anon',     'anon',          '{"role":"anon"}'),
  ('stranger', 'authenticated', '{"role":"authenticated","email":"stranger@example.invalid","sub":"00000000-0000-4000-8000-0000000b7109"}'),
  ('editor',   'authenticated', '{"role":"authenticated","email":"bm-editor@example.test","sub":"00000000-0000-4000-8000-0000000b7101"}'),
  ('service',  'service_role',  '{"role":"service_role"}');

create or replace function pg_temp.as_who(p_who text, p_sql text)
returns text language sql as $$
  select pg_temp.as_role(w.role, w.claims, p_sql) from _who w where w.k = p_who;
$$;

-- A document as tools/ingest/benchmarks.py writes one: the AHD station with
-- three marks (one with no comment, one assumed), the State station with two,
-- the deleted station with one, and a gauge that is nobody's station.
create or replace function pg_temp.doc(p_extra jsonb default '[]'::jsonb)
returns jsonb language sql as $$
  select jsonb_build_object(
    'meta', jsonb_build_object('title', 'check_station_benchmarks', 'printed', '2026-10-15',
              'source', jsonb_build_object('file', 'check', 'sha256', 'x'),
              'benchmark_columns', '["level_m", "datum", "description", "comment"]'::jsonb),
    'stations', '[
      {"bureau_number": "997101", "name": "CHECK BENCHMARK CREEK", "basin": "TASMAN",
       "benchmarks": [[101.73, "AHD", "PSM 1234 on the bridge", "Survey 2020"],
                      [103.00, "AHD", "TBM bolt in gum", null],
                      [8.57, "ASSUM", "Recorder platform GH", null]]},
      {"bureau_number": "097102", "name": "CHECK BENCHMARK WEIR", "basin": "TASMAN",
       "benchmarks": [[32.59, "STATE", "TBM on left bank d/s corner of weir", null],
                      [41.68, "AHD", "PSM on the hill", null]]},
      {"bureau_number": "997103", "name": "CHECK BENCHMARK GONE", "basin": "TASMAN",
       "benchmarks": [[5.00, "AHD", "Gone with the station", null]]},
      {"bureau_number": "997199", "name": "NOBODY''S GAUGE", "basin": "TASMAN",
       "benchmarks": [[1.00, "UNKNOWN", null, null]]}
    ]'::jsonb || p_extra);
$$;

-- ── 1. The migration landed whole ────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('schema_version is at least 101',
    (select value::integer >= 101 from meganet.app_meta where key = 'schema_version'));
  perform pg_temp.check_that('both tables are there, each with RLS on, and the view reads through it',
    (select count(*) = 2 and bool_and(c.relrowsecurity) from pg_catalog.pg_class c
      where c.oid in ('meganet.benchmark_extract'::regclass, 'meganet.bureau_benchmark'::regclass))
    and (select 'security_invoker=true' = any (c.reloptions) from pg_catalog.pg_class c
          where c.oid = 'meganet.station_benchmark'::regclass));
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    perform pg_temp.check_that('nobody signed out may read the benchmarks; a signed-in role may ask, and no browser role writes',
      not has_table_privilege('anon', 'meganet.bureau_benchmark', 'select')
      and not has_table_privilege('anon', 'meganet.station_benchmark', 'select')
      and not has_table_privilege('anon', 'meganet.benchmark_extract', 'select')
      and has_table_privilege('authenticated', 'meganet.station_benchmark', 'select')
      and not has_table_privilege('authenticated', 'meganet.bureau_benchmark', 'insert')
      and not has_table_privilege('authenticated', 'meganet.bureau_benchmark', 'update')
      and not has_table_privilege('authenticated', 'meganet.bureau_benchmark', 'delete'));
    perform pg_temp.check_that('…and only the service role may run the loader',
      not has_function_privilege('anon', 'meganet.load_benchmarks_doc(jsonb)', 'execute')
      and not has_function_privilege('authenticated', 'meganet.load_benchmarks_doc(jsonb)', 'execute')
      and has_function_privilege('service_role', 'meganet.load_benchmarks_doc(jsonb)', 'execute'));
  end if;
end
$$;

-- ── 2. Loading ───────────────────────────────────────────────────────────────

do $$
declare
  v text;
begin
  v := pg_temp.load(pg_temp.doc());
  perform pg_temp.check_that('a document loads, and says what it loaded',
    v like 'loaded 7 benchmarks at 4 stations, printed 2026-10-15; 2 of those stations are Flood-Net''s%', v);
  perform pg_temp.check_that('…every benchmark as printed, in the order printed, under the number as printed',
    (select array_agg(level_m::text || ' ' || datum order by ord) from meganet.bureau_benchmark where bureau_number = '997101')
      = '{"101.73 AHD","103.00 AHD","8.57 ASSUM"}'
    and exists (select 1 from meganet.bureau_benchmark where bureau_number = '097102' and ord = 1 and description = 'PSM on the hill'));
  perform pg_temp.check_that('…a gauge that is nobody''s station is kept, with no description and no comment',
    exists (select 1 from meganet.bureau_benchmark
             where bureau_number = '997199' and datum = 'UNKNOWN' and description is null and comment is null));
  perform pg_temp.check_that('…and the report it came from is recorded once',
    (select count(*) = 1 and bool_and(printed_on = '2026-10-15' and title = 'check_station_benchmarks')
       from meganet.benchmark_extract));

  -- Loading the same document again changes nothing. One transaction is one
  -- now(), so the rows are first dated back with their touch trigger held off
  -- (as the owner, rolled back with everything else), for a stamp that could
  -- be seen to move.
  alter table meganet.bureau_benchmark disable trigger bureau_benchmark_touch_updated_at;
  update meganet.bureau_benchmark set updated_at = '2026-01-01T00:00:00Z' where bureau_number like '997%' or bureau_number = '097102';
  alter table meganet.bureau_benchmark enable trigger bureau_benchmark_touch_updated_at;
  perform pg_temp.load(pg_temp.doc());
  perform pg_temp.check_that('loading the same document again leaves every row as it was',
    not exists (select 1 from meganet.bureau_benchmark
                 where (bureau_number like '997%' or bureau_number = '097102')
                   and updated_at <> '2026-01-01T00:00:00Z'));
end
$$;

-- ── 3. On the stations ───────────────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('each live station has its benchmarks, joined past the leading zeros',
    (select count(*) from meganet.station_benchmark where station_id = '_check_bm_ahd') = 3
    and (select count(*) from meganet.station_benchmark where station_id = '_check_bm_state') = 2);
  perform pg_temp.check_that('…a deleted station has none, and a gauge that is nobody''s is on no station',
    not exists (select 1 from meganet.station_benchmark where station_id = '_check_bm_gone' or bureau_number = '997199'));
  perform pg_temp.check_that('the zero is the one in force: open-ended, latest start — not one that ended, nor an older open one',
    (select bool_and(gauge_zero_m = 100.50 and gauge_datum = 'AHD' and gauge_zero_from = '2020-01-01')
       from meganet.station_benchmark where station_id = '_check_bm_ahd'));
  perform pg_temp.check_that('an AHD mark over an AHD zero is on the gauge: 101.73 − 100.50 = 1.23',
    (select on_gauge_m from meganet.station_benchmark where station_id = '_check_bm_ahd' and ord = 0) = 1.23);
  perform pg_temp.check_that('…so is a State mark over a State zero: 32.59 − 29.45 = 3.14',
    (select on_gauge_m from meganet.station_benchmark where station_id = '_check_bm_state' and ord = 0) = 3.14);
  perform pg_temp.check_that('an assumed mark is never put on the gauge, nor a mark in another datum from the zero''s',
    (select on_gauge_m from meganet.station_benchmark where station_id = '_check_bm_ahd' and ord = 2) is null
    and (select on_gauge_m from meganet.station_benchmark where station_id = '_check_bm_state' and ord = 1) is null);
  perform pg_temp.check_that('the view says which report it is',
    (select bool_and(printed_on = '2026-10-15') from meganet.station_benchmark where station_id like '\_check\_bm\_%'));
end
$$;

-- ── 4. Who reads it ──────────────────────────────────────────────────────────

do $$
declare
  v_anon text; v_stranger text; v_editor text; v_service text; v_raw text;
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    return;
  end if;
  v_anon     := pg_temp.as_who('anon',     'select count(*)::text from meganet.station_benchmark');
  v_stranger := pg_temp.as_who('stranger', 'select count(*)::text from meganet.station_benchmark');
  v_editor   := pg_temp.as_who('editor',   $q$select count(*)::text from meganet.station_benchmark where station_id like '\_check\_bm\_%'$q$);
  v_service  := pg_temp.as_who('service',  $q$select count(*)::text from meganet.station_benchmark where station_id like '\_check\_bm\_%'$q$);
  v_raw      := pg_temp.as_who('stranger', 'select count(*)::text from meganet.bureau_benchmark');
  perform pg_temp.check_that('nobody signed out reads a benchmark',
    v_anon like 'error 42501%', v_anon);
  perform pg_temp.check_that('…nor somebody signed in who is not an editor — through the view or the table',
    v_stranger = '0' and v_raw = '0', v_stranger || ' / ' || v_raw);
  -- The service key reads past RLS on Supabase (its role bypasses it); CI's
  -- scaffold role does not, so there it is the editor alone.
  perform pg_temp.check_that('…an editor does, and the service key',
    v_editor = '5' and (v_service = '5'
                        or not (select rolbypassrls from pg_catalog.pg_roles where rolname = 'service_role')),
    v_editor || ' / ' || v_service);
  v_editor := pg_temp.as_who('editor', $q$select meganet.load_benchmarks_doc('{}'::jsonb)$q$);
  perform pg_temp.check_that('…and not even an editor may load a document',
    v_editor like 'error 42501%', v_editor);
end
$$;

-- ── 5. What it refuses, and what a smaller document takes away ───────────────

do $$
declare
  v text;
begin
  v := pg_temp.load(jsonb_set(pg_temp.doc(), '{meta,benchmark_columns}', '["datum", "level_m", "description", "comment"]'));
  perform pg_temp.check_that('a document whose columns moved is refused by name',
    v like 'error: the document''s benchmarks are not in the columns this reads%', v);
  v := pg_temp.load(pg_temp.doc('[{"bureau_number": "997104", "name": "X", "basin": "TASMAN", "benchmarks": [[1.0, "GDA", "x", null]]}]'));
  perform pg_temp.check_that('…and so is a datum meganet.gauge_datum does not know',
    v like 'error: benchmarks with no level, or a datum%', v);
  v := pg_temp.load(pg_temp.doc('[{"bureau_number": "997104", "name": "X", "basin": "TASMAN", "benchmarks": [["1.0", "AHD", "x", null]]}]'));
  perform pg_temp.check_that('…and a level that is not a number',
    v like 'error: benchmarks with no level%', v);
  v := pg_temp.load(pg_temp.doc('[{"bureau_number": "0997101", "name": "AGAIN", "basin": "TASMAN", "benchmarks": []}]'));
  perform pg_temp.check_that('…and a station listed twice, even under a number with another leading zero',
    v like 'error: a station is in the document twice%', v);
  v := pg_temp.load('{"meta": {}, "gauges": []}');
  perform pg_temp.check_that('…and something that is not a benchmarks document at all',
    v like 'error: not a benchmarks document%', v);
  perform pg_temp.check_that('…and a refused document leaves the table as it was',
    (select count(*) from meganet.bureau_benchmark where bureau_number like '997%' or bureau_number = '097102') = 7);

  v := pg_temp.load(jsonb_set(pg_temp.doc(), '{stations}',
         '[{"bureau_number": "997101", "name": "CHECK BENCHMARK CREEK", "basin": "TASMAN",
            "benchmarks": [[101.74, "AHD", "PSM 1234 on the bridge", "Resurveyed"]]}]'));
  perform pg_temp.check_that('a smaller document takes away the stations it no longer lists, and the marks past a list''s end',
    (select count(*) from meganet.bureau_benchmark) = 1
    and (select level_m = 101.74 and comment = 'Resurveyed' from meganet.bureau_benchmark where bureau_number = '997101' and ord = 0), v);
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
