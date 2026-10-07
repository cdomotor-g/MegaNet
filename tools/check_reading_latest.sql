-- check_reading_latest.sql — Prove 0057, the newest reading of every address,
-- against a real database.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_reading_latest.sql
--
-- One row per claim, a non-zero exit if any fails, and a transaction that
-- rolls back — the readings included — so it is safe against the live
-- database. Run it as a role meganet.is_editor() says yes to (a direct
-- connection), as check_ingest.sql is.
--
-- Addresses 64601–64610 and ALERT2 station 64601: inside the ranges, clear of
-- check_ingest.sql's 64001–64200, check_receptions.sql's 643xx and
-- check_reading_signal.sql's 645xx, and far from the network.

\set ON_ERROR_STOP on

begin;

create temporary table _check (ord serial, name text, ok boolean, note text) on commit drop;
create or replace function pg_temp.check_that(p_name text, p_ok boolean, p_note text default '')
returns void language sql as $$ insert into _check (name, ok, note) values (p_name, coalesce(p_ok, false), p_note); $$;
create or replace function pg_temp.ts(p_ago interval)
returns text language sql stable as $$ select to_char(date_trunc('second', now()) - p_ago, 'YYYY-MM-DD"T"HH24:MI:SSOF'); $$;

-- The rule the view keeps, written out the obvious way — DISTINCT ON, which
-- reads every row — for the view's two-probe walk to be compared against.
create or replace function pg_temp.newest(p_addr text)
returns table (addr text, reading_ts timestamptz, received_at timestamptz, value_raw numeric, station_id text)
language sql stable as $$
  select distinct on (r.addr) r.addr, r.reading_ts, r.received_at, r.value_raw, r.station_id
    from meganet.reading r
   where r.addr = p_addr
   order by r.addr, r.reading_ts desc, r.received_at desc, r.value_raw desc;
$$;

-- ── 1. The shape ─────────────────────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('schema_version is at least 57',
    (select value::integer >= 57 from meganet.app_meta where key = 'schema_version'));

  perform pg_temp.check_that('meganet.reading_latest is a view, security_invoker',
    exists (select 1 from pg_class c
             where c.oid = to_regclass('meganet.reading_latest') and c.relkind = 'v'
               and 'security_invoker=true' = any (coalesce(c.reloptions, '{}'))));

  perform pg_temp.check_that('it carries the reading''s own columns, and none of its bookkeeping',
    (select array_agg(column_name::text order by ordinal_position) from information_schema.columns
      where table_schema = 'meganet' and table_name = 'reading_latest')
      = array['addr', 'alert_id', 'a2_station', 'a2_sensor', 'station_number', 'channel', 'station_id',
              'reading_ts', 'received_at', 'value_raw', 'value', 'unit', 'conversion', 'quality',
              'protocol', 'source', 'path', 'dup_count', 'freq_mhz', 'rssi_dbm', 'level_dbfs', 'snr_db'],
    (select string_agg(column_name::text, ', ' order by ordinal_position) from information_schema.columns
      where table_schema = 'meganet' and table_name = 'reading_latest'));

  perform pg_temp.check_that('anon and authenticated read it, as they read meganet.reading',
    has_table_privilege('anon', 'meganet.reading_latest', 'select')
      and has_table_privilege('authenticated', 'meganet.reading_latest', 'select')
      and has_table_privilege('anon', 'meganet.reading', 'select'));

  perform pg_temp.check_that('nobody writes through it',
    not has_table_privilege('anon', 'meganet.reading_latest', 'insert,update,delete')
      and not has_table_privilege('authenticated', 'meganet.reading_latest', 'insert,update,delete'));
end
$$;

-- ── 2. The newest reading of each address ────────────────────────────────────

do $$
declare
  a jsonb;
begin
  a := meganet.ingest(format($j${"source":"http","protocol":"alert","readings":[
        {"alert_id":64601,"reading_ts":"%1$s","value_raw":10},
        {"alert_id":64601,"reading_ts":"%2$s","value_raw":20},
        {"alert_id":64601,"reading_ts":"%3$s","value_raw":30},
        {"alert_id":64602,"reading_ts":"%3$s","value_raw":40,"received_at":"%4$s"},
        {"alert_id":64602,"reading_ts":"%5$s","value_raw":50,"received_at":"%6$s"},
        {"alert_id":64603,"reading_ts":"%7$s","value_raw":9,"received_at":"%8$s"},
        {"alert_id":64603,"reading_ts":"%7$s","value_raw":8,"received_at":"%9$s"},
        {"station_number":"999901","channel":"level","reading_ts":"%2$s","value_raw":1.25,"unit":"m"},
        {"station_number":"999901","channel":"level","reading_ts":"%3$s","value_raw":1.5,"unit":"m"},
        {"a2_station":64601,"a2_sensor":0,"reading_ts":"%3$s","value_raw":248},
        {"a2_station":64601,"a2_sensor":0,"reading_ts":"%1$s","value_raw":247}]}$j$,
        pg_temp.ts('3 hours'), pg_temp.ts('2 hours'), pg_temp.ts('1 hour'),
        pg_temp.ts('55 minutes'), pg_temp.ts('5 hours'), pg_temp.ts('1 minute'),
        pg_temp.ts('30 minutes'), pg_temp.ts('29 minutes'), pg_temp.ts('20 minutes'))::jsonb);

  perform pg_temp.check_that('the readings are stored', (a ->> 'accepted') = '11', a::text);

  perform pg_temp.check_that('one row per address: the last of three readings, by its own time',
    (select count(*) = 1 and bool_and(value_raw = 30 and reading_ts = pg_temp.ts('1 hour')::timestamptz)
       from meganet.reading_latest where addr = 'a:64601'));

  perform pg_temp.check_that('a backfill received later with an older time does not displace the newer reading',
    (select value_raw = 40 from meganet.reading_latest where addr = 'a:64602'),
    (select value_raw::text from meganet.reading_latest where addr = 'a:64602'));

  perform pg_temp.check_that('of two readings at one instant, the later received — not the larger value',
    (select value_raw = 8 from meganet.reading_latest where addr = 'a:64603'),
    (select value_raw::text from meganet.reading_latest where addr = 'a:64603'));

  perform pg_temp.check_that('a satellite address and an ALERT2 pair are addresses like any other',
    (select value_raw = 1.5 and unit = 'm' and channel = 'level' and station_number = '999901'
       from meganet.reading_latest where addr = 's:999901/level')
      and (select value_raw = 248 and a2_station = 64601 and a2_sensor = 0
             from meganet.reading_latest where addr = 'a2:64601/0'));

  perform pg_temp.check_that('an address no station carries is there, unattributed',
    (select station_id is null from meganet.reading_latest where addr = 'a:64601'));

  perform pg_temp.check_that('every test address agrees with DISTINCT ON, column for column',
    (select bool_and(n.reading_ts = l.reading_ts and n.received_at = l.received_at
                     and n.value_raw = l.value_raw and n.station_id is not distinct from l.station_id)
       from unnest(array['a:64601', 'a:64602', 'a:64603', 's:999901/level', 'a2:64601/0']) x(addr)
       cross join lateral pg_temp.newest(x.addr) n
       join meganet.reading_latest l on l.addr = n.addr)
      and (select count(*) = 5 from meganet.reading_latest
            where addr in ('a:64601', 'a:64602', 'a:64603', 's:999901/level', 'a2:64601/0')));

  perform pg_temp.check_that('the view has exactly one row for every address meganet.reading holds',
    (select count(*) from meganet.reading_latest) = (select count(distinct addr) from meganet.reading)
      and not exists (select 1 from meganet.reading_latest group by addr having count(*) > 1));
end
$$;

-- ── 3. As the agent API reads it ─────────────────────────────────────────────
-- The publishable key is anon: the view must answer it, through reading's own
-- RLS, exactly what it answers an editor.

create temporary table _as_editor on commit drop as
  select addr, reading_ts, value_raw from meganet.reading_latest
   where addr in ('a:64601', 'a:64602', 'a:64603', 's:999901/level', 'a2:64601/0');
grant select on _as_editor to anon;

do $$
declare
  n integer;
  same boolean;
begin
  execute 'set local role anon';
  select count(*) into n from meganet.reading_latest
   where addr in ('a:64601', 'a:64602', 'a:64603', 's:999901/level', 'a2:64601/0');
  select not exists (
    (select addr, reading_ts, value_raw from meganet.reading_latest
      where addr in ('a:64601', 'a:64602', 'a:64603', 's:999901/level', 'a2:64601/0')
     except select * from _as_editor)
    union all
    (select * from _as_editor
     except select addr, reading_ts, value_raw from meganet.reading_latest
      where addr in ('a:64601', 'a:64602', 'a:64603', 's:999901/level', 'a2:64601/0'))) into same;
  execute 'reset role';
  perform pg_temp.check_that('anon reads the same five rows an editor does', n = 5 and same, format('%s rows', n));
end
$$;

-- ── The verdict ──────────────────────────────────────────────────────────────

select lpad(ord::text, 2) as "#", case when ok then 'ok  ' else 'FAIL' end as result, name,
       case when ok then '' else left(coalesce(note, ''), 160) end as detail
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
