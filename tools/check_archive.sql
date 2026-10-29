-- check_archive.sql — Prove 0073, every row archived before anything is
-- deleted (#243), against a real database.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_archive.sql
--
-- One row per claim, a non-zero exit if any fails, and a transaction that
-- rolls back — its rows, its manifest entries, and whatever retain() deletes
-- while it runs — so it is safe against the live database. Its days are
-- hundreds of days old, before anything the live tables hold, so live rows
-- never land in them.

\set ON_ERROR_STOP on

begin;

create temporary table _check (ord serial, name text, ok boolean, note text) on commit drop;
create or replace function pg_temp.check_that(p_name text, p_ok boolean, p_note text default '')
returns void language sql as $$ insert into _check (name, ok, note) values (p_name, coalesce(p_ok, false), p_note); $$;
create or replace function pg_temp.sqlstate_of(p_sql text)
returns text language plpgsql as $$ begin execute p_sql; return 'none'; exception when others then return sqlstate; end; $$;
create or replace function pg_temp.as_role(p_role text, p_claims text, p_sql text)
returns text language plpgsql as $$
declare v text;
begin
  begin
    execute pg_catalog.format('set local role %I', p_role);
    perform pg_catalog.set_config('request.jwt.claims', p_claims, true);
    execute p_sql into v;
    raise exception using errcode = 'MNRLB', message = coalesce(v, '<null>');
  exception
    when sqlstate 'MNRLB' then return sqlerrm;
    when others then return 'ERROR ' || sqlstate;
  end;
end;
$$;

-- The days. Each well past its table's horizon, and before any live row.
create temporary table _d on commit drop as
  select ((now() at time zone 'UTC')::date - 400) as raw_kept,     -- archived: goes
         ((now() at time zone 'UTC')::date - 401) as raw_unarch,   -- never archived: stays
         ((now() at time zone 'UTC')::date - 402) as raw_late,     -- archived, then a late row: stays
         ((now() at time zone 'UTC')::date - 300) as rx_rolled,    -- archived and rolled up: goes
         ((now() at time zone 'UTC')::date - 301) as rx_unrolled,  -- archived, not rolled up: stays
         ((now() at time zone 'UTC')::date - 800) as rd_kept,      -- a reading day, archived and rolled up: goes
         ((now() at time zone 'UTC')::date - 3)   as recent;       -- inside every horizon: stays

create or replace function pg_temp.at(p_day date, p_h integer, p_m integer default 0)
returns timestamptz language sql as $$ select (p_day::timestamp at time zone 'UTC') + p_h * interval '1 hour' + p_m * interval '1 minute' $$;
create or replace function pg_temp.sha() returns text language sql as $$ select repeat('ab', 32) $$;
create or replace function pg_temp.k(p_table text, p_day date, p_v integer)
returns text language sql as $$ select format('%s/%s.v%s.ndjson.gz', p_table, to_char(p_day, 'YYYY/MM/DD'), p_v) $$;

insert into meganet.reading_raw (received_at, payload) select pg_temp.at(raw_kept, 1), '{"check":"kept"}'::jsonb from _d;
insert into meganet.reading_raw (received_at, payload) select pg_temp.at(raw_kept, 23, 59), '{"check":"kept"}'::jsonb from _d;
insert into meganet.reading_raw (received_at, payload) select pg_temp.at(raw_unarch, 5), '{"check":"unarchived"}'::jsonb from _d;
insert into meganet.reading_raw (received_at, payload) select pg_temp.at(raw_late, 5), '{"check":"late"}'::jsonb from _d;
insert into meganet.reading_raw (received_at, payload) select pg_temp.at(recent, 5), '{"check":"recent"}'::jsonb from _d;

do $$
declare
  t record;
  v jsonb;
begin
  select * into t from _d;

  -- What is due.
  v := meganet.archive_due('reading_raw', 1000);
  perform pg_temp.check_that('a day two or more days old is due, with its count and version 1',
    v @> jsonb_build_array(jsonb_build_object('day', t.raw_kept, 'rows', 2, 'version', 1)), left(v::text, 300));
  perform pg_temp.check_that('… but not today or yesterday',
    not exists (select 1 from jsonb_array_elements(v) e where (e ->> 'day')::date >= (now() at time zone 'UTC')::date - 1));

  -- One hour, every column as stored.
  v := meganet.archive_rows('reading_raw', t.raw_kept, 1);
  perform pg_temp.check_that('archive_rows gives one hour, every column',
    jsonb_array_length(v) = 1 and v -> 0 ? 'id' and v -> 0 -> 'payload' = '{"check":"kept"}'::jsonb, left(v::text, 300));
  perform pg_temp.check_that('an hour outside 0–23 is refused',
    pg_temp.sqlstate_of(format($q$select meganet.archive_rows('reading_raw', %L, 24)$q$, t.raw_kept)) = '22023');

  -- Recording.
  perform pg_temp.check_that('a count that is not the day''s now is refused, 40001: archive it again',
    pg_temp.sqlstate_of(format($q$select meganet.archive_record('reading_raw', %L, 1, 1, 10, %L, %L)$q$,
      t.raw_kept, pg_temp.sha(), pg_temp.k('reading_raw', t.raw_kept, 1))) = '40001');
  perform pg_temp.check_that('a key that is not the day''s is refused',
    pg_temp.sqlstate_of(format($q$select meganet.archive_record('reading_raw', %L, 1, 2, 10, %L, 'reading_raw/2000/01/01.v1.ndjson.gz')$q$,
      t.raw_kept, pg_temp.sha())) = '22023');
  perform meganet.archive_record('reading_raw', t.raw_kept, 1, 2, 10, pg_temp.sha(), pg_temp.k('reading_raw', t.raw_kept, 1));
  perform pg_temp.check_that('the day is recorded, and no longer due',
    exists (select 1 from meganet.archive_day where table_name = 'reading_raw' and day = t.raw_kept and rows = 2)
      and not (meganet.archive_due('reading_raw', 1000) @> jsonb_build_array(jsonb_build_object('day', t.raw_kept))));
  perform pg_temp.check_that('a version not after the last recorded is refused',
    pg_temp.sqlstate_of(format($q$select meganet.archive_record('reading_raw', %L, 1, 2, 10, %L, %L)$q$,
      t.raw_kept, pg_temp.sha(), pg_temp.k('reading_raw', t.raw_kept, 1))) = '22023');

  -- A late row makes its day due again, as the next version.
  perform meganet.archive_record('reading_raw', t.raw_late, 1, 1, 10, pg_temp.sha(), pg_temp.k('reading_raw', t.raw_late, 1));
  insert into meganet.reading_raw (received_at, payload) values (pg_temp.at(t.raw_late, 6), '{"check":"late, later"}');
  v := meganet.archive_due('reading_raw', 1000);
  perform pg_temp.check_that('a row that came after its day was archived makes the day due again, as version 2',
    v @> jsonb_build_array(jsonb_build_object('day', t.raw_late, 'rows', 2, 'version', 2)), left(v::text, 300));

  -- … once the day is past its horizon, where retain() would release it
  -- (0088): an archived submission day inside it is not counted every night.
  insert into meganet.app_meta (key, value) values ('retain_reading_raw_days', '500')
  on conflict (key) do update set value = excluded.value;
  v := meganet.archive_due('reading_raw', 1000);
  perform pg_temp.check_that('… but an archived submission day inside its horizon waits for it before it is counted again (0088)',
    not (v @> jsonb_build_array(jsonb_build_object('day', t.raw_late))), left(v::text, 300));
  perform pg_temp.check_that('… while a submission day never archived is due wherever it is',
    v @> jsonb_build_array(jsonb_build_object('day', t.raw_unarch, 'rows', 1, 'version', 1)), left(v::text, 300));
  update meganet.app_meta set value = '30' where key = 'retain_reading_raw_days';
end
$$;

-- Receptions: one day rolled up, one not. The horizon is widened while the
-- rollup is built, so roll_up_receptions() will build the first; the second
-- is put in after.
insert into meganet.editor_allow (entry, note) values ('ar-editor@example.test', 'check_archive — rolled back') on conflict (entry) do nothing;
select meganet.create_ingest_token('_check_ar pi') is not null as minted \gset
update meganet.app_meta set value = '400' where key = 'retain_reception_days';
insert into meganet.reception (ingest_token_id, point_id, receiver, heard_at, received_at, protocol, alert_id, ok, detail)
select (select id from meganet.ingest_token where label = '_check_ar pi'), 'ar-sdr', 'rtl-sdr', pg_temp.at(rx_rolled, h), now() - interval '10 minutes', 'alert', 7000 + h, true, '{}'::jsonb
  from _d, generate_series(2, 4) h;
select meganet.roll_up_receptions(100000) is not null as rolled \gset
insert into meganet.reception (ingest_token_id, point_id, receiver, heard_at, received_at, protocol, alert_id, ok, detail)
select (select id from meganet.ingest_token where label = '_check_ar pi'), 'ar-sdr', 'rtl-sdr', pg_temp.at(rx_unrolled, 2), now(), 'alert', 7100, true, '{}'::jsonb
  from _d;
update meganet.app_meta set value = '90' where key = 'retain_reception_days';

-- A reading day, rolled up the same way.
update meganet.app_meta set value = '1000' where key = 'retain_reading_days';
insert into meganet.reading (alert_id, reading_ts, value_raw, channel)
select 60091, pg_temp.at(rd_kept, h), h, '' from _d, generate_series(0, 2) h;
select meganet.roll_up(pg_temp.at((select rd_kept from _d), 0) - interval '1 hour') is not null as rolled_readings \gset
update meganet.app_meta set value = '730' where key = 'retain_reading_days';

do $$
declare t record;
begin
  select * into t from _d;
  perform meganet.archive_record('reception', t.rx_rolled, 1, 3, 10, pg_temp.sha(), pg_temp.k('reception', t.rx_rolled, 1));
  perform meganet.archive_record('reception', t.rx_unrolled, 1, 1, 10, pg_temp.sha(), pg_temp.k('reception', t.rx_unrolled, 1));
  perform meganet.archive_record('reading', t.rd_kept, 1, 3, 10, pg_temp.sha(), pg_temp.k('reading', t.rd_kept, 1));
end
$$;

create temporary table _ret on commit drop as select meganet.retain() as r;

do $$
declare
  t record;
  v jsonb := (select r from _ret);
begin
  select * into t from _d;
  perform pg_temp.check_that('an archived submission day past 30 days is deleted',
    not exists (select 1 from meganet.reading_raw where received_at >= pg_temp.at(t.raw_kept, 0) and received_at < pg_temp.at(t.raw_kept + 1, 0)),
    left(v::text, 300));
  perform pg_temp.check_that('… and its manifest says when it was released',
    (select released_at is not null from meganet.archive_day where table_name = 'reading_raw' and day = t.raw_kept));
  perform pg_temp.check_that('a day never archived is not deleted, however old',
    exists (select 1 from meganet.reading_raw where received_at = pg_temp.at(t.raw_unarch, 5)));
  perform pg_temp.check_that('a day whose count changed after it was archived is not deleted',
    (select count(*) from meganet.reading_raw where received_at >= pg_temp.at(t.raw_late, 0) and received_at < pg_temp.at(t.raw_late + 1, 0)) = 2
      and (select released_at is null from meganet.archive_day where table_name = 'reading_raw' and day = t.raw_late));
  perform pg_temp.check_that('a recent day is not touched',
    exists (select 1 from meganet.reading_raw where received_at = pg_temp.at(t.recent, 5)));

  perform pg_temp.check_that('an archived, rolled-up reception day past 90 days is deleted — its rollup kept',
    not exists (select 1 from meganet.reception where point_id = 'ar-sdr' and heard_at < pg_temp.at(t.rx_rolled + 1, 0) and heard_at >= pg_temp.at(t.rx_rolled, 0))
      and (select sum(n) from meganet.reception_daily where point_id = 'ar-sdr' and bucket = t.rx_rolled) = 3);
  perform pg_temp.check_that('an archived reception day that is not rolled up is not deleted',
    exists (select 1 from meganet.reception where point_id = 'ar-sdr' and alert_id = 7100));

  perform pg_temp.check_that('an archived, rolled-up reading day past 730 days is deleted — its rollup kept',
    not exists (select 1 from meganet.reading where alert_id = 60091)
      and (select sum(n) from meganet.reading_daily where alert_id = 60091 and bucket = t.rd_kept) = 3, left(v::text, 300));
  perform pg_temp.check_that('retain() says what it did, table by table',
    (v -> 'tables' -> 'reading_raw' ->> 'released_days')::int >= 1 and (v -> 'tables' -> 'reception' ->> 'deleted')::int >= 3
      and v ? 'rolled' and v ? 'rolled_receptions', left(v::text, 300));
  perform pg_temp.check_that('a released day is not offered to the archive again',
    not (meganet.archive_due('reading_raw', 1000) @> jsonb_build_array(jsonb_build_object('day', t.raw_kept))));
end
$$;

-- Who may.
do $$
declare
  c_editor text := '{"role":"authenticated","email":"ar-editor@example.test","sub":"00000000-0000-4000-8000-0000000ee801"}';
begin
  perform pg_temp.check_that('anon and a signed-in browser can neither list, read nor record the archive',
    not has_function_privilege('anon', 'meganet.archive_due(text, integer)', 'execute')
      and not has_function_privilege('anon', 'meganet.archive_rows(text, date, integer)', 'execute')
      and not has_function_privilege('authenticated', 'meganet.archive_rows(text, date, integer)', 'execute')
      and not has_function_privilege('authenticated', 'meganet.archive_record(text, date, integer, bigint, bigint, text, text)', 'execute')
      and not has_table_privilege('anon', 'meganet.archive_day', 'select'));
  perform pg_temp.check_that('the manifest has RLS on, editors only',
    (select relrowsecurity from pg_class where oid = 'meganet.archive_day'::regclass)
      and exists (select 1 from pg_policy where polrelid = 'meganet.archive_day'::regclass and polname = 'archive_day_read_editors'));
end
$$;

select lpad(ord::text, 2) as "#", case when ok then 'ok  ' else 'FAIL' end as result, name,
       case when ok then '' else left(coalesce(note, ''), 200) end as detail
  from _check order by ord;

do $$
declare n integer;
begin
  select count(*) into n from _check where not ok;
  if n > 0 then raise exception '% of % checks failed', n, (select count(*) from _check); end if;
  raise notice 'all % checks passed', (select count(*) from _check);
end
$$;

rollback;
