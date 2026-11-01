-- check_alert_copies.sql — Prove 0096 (#232): one ALERT burst heard several
-- ways is one reading with every path it came by, and two real readings stay
-- two — against a real database.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_alert_copies.sql
--
-- One row per claim, a non-zero exit if any fails, and a transaction that
-- rolls back — the readings and the setting it changes included — so it is
-- safe against the live database. Run it as a role meganet.is_editor() says
-- yes to (a direct connection), as check_ingest.sql is.
--
-- Addresses 64701–64740, ALERT2 station 64701 and station number _chk-0096:
-- inside the ranges, clear of check_ingest.sql's 64001–64200,
-- check_receptions.sql's 643xx, check_reading_signal.sql's 645xx and
-- check_reading_latest.sql's 646xx, and far from the network.
--
-- The times are a fixed instant ten minutes ago plus milliseconds, because the
-- point is copies a fraction of a second to a few seconds apart.

\set ON_ERROR_STOP on

begin;

create temporary table _check (ord serial, name text, ok boolean, note text) on commit drop;
create or replace function pg_temp.check_that(p_name text, p_ok boolean, p_note text default '')
returns void language sql as $$ insert into _check (name, ok, note) values (p_name, coalesce(p_ok, false), p_note); $$;

create temporary table _base on commit drop as
  select date_trunc('second', now()) - interval '10 minutes' as t;

-- The base time plus a number of seconds, as ingest() reads a time.
create or replace function pg_temp.at(p_s numeric)
returns text language sql stable as $$
  select to_char((select t from _base) + p_s * interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SS.MSOF');
$$;

-- One legacy reading, posted on its own as a receiver would post it.
create or replace function pg_temp.post(p_id integer, p_s numeric, p_value integer, p_path text,
                                         p_freq numeric default null, p_protocol text default 'alert')
returns jsonb language sql as $$
  select meganet.ingest(jsonb_build_object(
    'source', 'serial', 'protocol', p_protocol, 'path', p_path, 'freq_mhz', p_freq,
    'readings', jsonb_build_array(jsonb_build_object(
      'alert_id', p_id, 'reading_ts', pg_temp.at(p_s), 'value_raw', p_value))));
$$;

create or replace function pg_temp.rows_of(p_addr text)
returns bigint language sql stable as $$ select count(*) from meganet.reading where addr = p_addr; $$;

-- Is this transaction holding 0096's lock?
create or replace function pg_temp.holds_copy_lock()
returns boolean language sql stable as $$
  with k as (select hashtext('meganet.ingest_alert_copies')::bigint as k)
  select exists (select 1 from pg_locks l, k
                  where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.granted
                    and l.classid::bigint = ((k.k >> 32) & 4294967295)
                    and l.objid::bigint = (k.k & 4294967295)
                    and l.objsubid = 1);
$$;

-- ── 1. The shape ─────────────────────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('schema_version is at least 96',
    (select value::integer >= 96 from meganet.app_meta where key = 'schema_version'));
  perform pg_temp.check_that('the window is a setting, 8 seconds',
    (select value = '8' from meganet.app_meta where key = 'alert_copy_window_s'));
  perform pg_temp.check_that('anon still cannot run ingest()',
    not has_function_privilege('anon', 'meganet.ingest(jsonb)', 'execute'));
end
$$;

-- ── 2. The lock: only a call with an ALERT address takes it ─────────────────
-- First, before anything in this transaction has posted an ALERT address.

do $$
begin
  perform meganet.ingest(jsonb_build_object('source', 'serial', 'protocol', 'hfem', 'readings', jsonb_build_array(
    jsonb_build_object('station_number', '_chk-0096', 'channel', 'lock', 'reading_ts', pg_temp.at(0), 'value_raw', 1))));
  perform pg_temp.check_that('a batch with no ALERT address does not take the lock', not pg_temp.holds_copy_lock());

  perform pg_temp.post(64740, 0, 1, 'serial-monitor/_chk-rx-a-sdr1');
  perform pg_temp.check_that('a batch with an ALERT address takes it, for the transaction', pg_temp.holds_copy_lock());
end
$$;

-- ── 3. One burst, heard several ways, is one reading ─────────────────────────

do $$
declare
  a jsonb; b jsonb; r record;
begin
  -- #232's case: two receivers, the second copy 0.813 s later on another channel.
  a := pg_temp.post(64701, 0,     100, 'serial-monitor/_chk-rx-a-sdr1-151.525', 151.525);
  b := pg_temp.post(64701, 0.813, 100, 'serial-monitor/_chk-rx-b-sdr1',         151.5375);
  select * into r from meganet.reading where addr = 'a:64701';
  perform pg_temp.check_that('two receivers'' copies of one burst, 0.8 s apart, are one reading',
    pg_temp.rows_of('a:64701') = 1, pg_temp.rows_of('a:64701')::text || ' rows');
  perform pg_temp.check_that('…with the second copy''s path in dup_paths and counted',
    r.dup_count = 1 and r.dup_paths = array['serial-monitor/_chk-rx-b-sdr1'], format('%s %s', r.dup_count, r.dup_paths));
  perform pg_temp.check_that('…the first copy''s time, path and frequency kept',
    r.reading_ts = (select t from _base) and r.path = 'serial-monitor/_chk-rx-a-sdr1-151.525' and r.freq_mhz = 151.525,
    format('%s %s %s', r.reading_ts, r.path, r.freq_mhz));
  perform pg_temp.check_that('…and the second call says so: accepted 0, duplicates 1',
    (a ->> 'accepted')::int = 1 and (b ->> 'accepted')::int = 0 and (b ->> 'duplicates')::int = 1, b::text);
  perform pg_temp.check_that('…as does its reading_raw row',
    (select accepted = 0 and duplicates = 1 from meganet.reading_raw where id = (b ->> 'raw_id')::bigint));

  -- A copy stamped earlier can arrive later: an ALERT2 concentrator's, timed
  -- by when it heard the burst, posted after the Pi's own.
  perform pg_temp.post(64702, 5,     200, 'serial-monitor/_chk-rx-a-sdr1');
  perform pg_temp.post(64702, 2,     200, 'serial-monitor/_chk-rx-a-sdr1-151.5375', 151.5375, 'alert2');
  perform pg_temp.check_that('a copy stamped 3 s before the stored one, posted after it, is that reading',
    pg_temp.rows_of('a:64702') = 1
      and (select bool_and(dup_count = 1 and reading_ts = (select t from _base) + interval '5 seconds') from meganet.reading where addr = 'a:64702'));
  perform pg_temp.check_that('…whichever protocol carried it — legacy, or an ALERT2 concentration record',
    (select bool_and(protocol = 1 and dup_paths = array['serial-monitor/_chk-rx-a-sdr1-151.5375']) from meganet.reading where addr = 'a:64702'));

  -- One batch, three copies: direct, then two repeaters (the concentrator
  -- 33300 PDU in #232 carried one burst 12, 11 and 6 s before its stamp).
  a := meganet.ingest(jsonb_build_object('source', 'serial', 'protocol', 'alert', 'readings', jsonb_build_array(
         jsonb_build_object('alert_id', 64703, 'reading_ts', pg_temp.at(0),   'value_raw', 300, 'path', 'serial-monitor/_chk-rx-a-sdr1'),
         jsonb_build_object('alert_id', 64703, 'reading_ts', pg_temp.at(1.2), 'value_raw', 300, 'path', 'serial-monitor/_chk-rx-a-sdr2'),
         jsonb_build_object('alert_id', 64703, 'reading_ts', pg_temp.at(6),   'value_raw', 300, 'path', 'serial-monitor/_chk-rx-a-sdr1-151.5375'))));
  perform pg_temp.check_that('three copies in one batch, 0, 1.2 and 6 s, are one reading with both other paths',
    pg_temp.rows_of('a:64703') = 1
      and (select bool_and(dup_count = 2 and dup_paths = array['serial-monitor/_chk-rx-a-sdr2', 'serial-monitor/_chk-rx-a-sdr1-151.5375'])
             from meganet.reading where addr = 'a:64703')
      and (a ->> 'accepted')::int = 1 and (a ->> 'duplicates')::int = 2, a::text);

  -- The edge of the window.
  perform pg_temp.post(64704, 0,   400, 'serial-monitor/_chk-rx-a-sdr1');
  perform pg_temp.post(64704, 7.9, 400, 'serial-monitor/_chk-rx-a-sdr2');
  perform pg_temp.check_that('7.9 s apart, inside the 8 s window: one reading', pg_temp.rows_of('a:64704') = 1);
  perform pg_temp.post(64705, 0,   500, 'serial-monitor/_chk-rx-a-sdr1');
  perform pg_temp.post(64705, 8.5, 500, 'serial-monitor/_chk-rx-a-sdr2');
  perform pg_temp.check_that('8.5 s apart, outside it: two', pg_temp.rows_of('a:64705') = 2);

  -- The nearest copy is the one counted, when two are within the window.
  perform pg_temp.post(64706, 0, 600, 'serial-monitor/_chk-rx-a-sdr1');
  perform pg_temp.post(64706, 9, 600, 'serial-monitor/_chk-rx-a-sdr1');
  perform pg_temp.post(64706, 6, 600, 'serial-monitor/_chk-rx-a-sdr2');
  perform pg_temp.check_that('a copy between two readings is counted on the nearer one',
    (select dup_count from meganet.reading where addr = 'a:64706' and reading_ts = (select t from _base) + interval '9 seconds') = 1
      and (select dup_count from meganet.reading where addr = 'a:64706' and reading_ts = (select t from _base)) = 0);

  -- The exact key still works as it always did.
  perform pg_temp.post(64707, 0, 700, 'serial-monitor/_chk-rx-a-sdr1');
  perform pg_temp.post(64707, 0, 700, 'serial-monitor/_chk-rx-b-sdr1');
  perform pg_temp.check_that('an exact repeat is still one reading, counted',
    pg_temp.rows_of('a:64707') = 1 and (select bool_and(dup_count = 1) from meganet.reading where addr = 'a:64707'));
end
$$;

-- ── 4. Two real readings stay two ────────────────────────────────────────────

do $$
begin
  -- #232's other case: the station sending the same value again a minute on.
  perform pg_temp.post(64710, 0,  100, 'serial-monitor/_chk-rx-a-sdr1');
  perform pg_temp.post(64710, 60, 100, 'serial-monitor/_chk-rx-a-sdr1');
  perform pg_temp.check_that('the same value a minute apart is two readings, neither a duplicate',
    pg_temp.rows_of('a:64710') = 2 and (select sum(dup_count) = 0 from meganet.reading where addr = 'a:64710'));

  perform pg_temp.post(64711, 0, 101, 'serial-monitor/_chk-rx-a-sdr1');
  perform pg_temp.post(64711, 1, 102, 'serial-monitor/_chk-rx-a-sdr1');
  perform pg_temp.check_that('a different value a second later is another reading', pg_temp.rows_of('a:64711') = 2);

  -- A station's own clock: the exact key stays the whole test.
  perform meganet.ingest(jsonb_build_object('source', 'serial', 'protocol', 'alert2', 'path', 'serial-monitor/_chk-rx-a-ert', 'readings', jsonb_build_array(
    jsonb_build_object('a2_station', 64701, 'a2_sensor', 1, 'reading_ts', pg_temp.at(0), 'value_raw', 7),
    jsonb_build_object('a2_station', 64701, 'a2_sensor', 1, 'reading_ts', pg_temp.at(1), 'value_raw', 7))));
  perform pg_temp.check_that('an ALERT2 self-report, stamped by the station, 1 s apart: two readings',
    pg_temp.rows_of('a2:64701/1') = 2);

  perform meganet.ingest(jsonb_build_object('source', 'serial', 'protocol', 'hfem', 'readings', jsonb_build_array(
    jsonb_build_object('station_number', '_chk-0096', 'channel', 'stage', 'reading_ts', pg_temp.at(0), 'value_raw', 7),
    jsonb_build_object('station_number', '_chk-0096', 'channel', 'stage', 'reading_ts', pg_temp.at(1), 'value_raw', 7))));
  perform pg_temp.check_that('a logger''s reading by station number, 1 s apart: two readings',
    pg_temp.rows_of('s:_chk-0096/stage') = 2);
end
$$;

-- ── 5. The setting ───────────────────────────────────────────────────────────

do $$
begin
  update meganet.app_meta set value = '0' where key = 'alert_copy_window_s';
  perform pg_temp.post(64720, 0, 100, 'serial-monitor/_chk-rx-a-sdr1');
  perform pg_temp.post(64720, 1, 100, 'serial-monitor/_chk-rx-a-sdr2');
  perform pg_temp.check_that('window 0: the exact key alone, as before 0096', pg_temp.rows_of('a:64720') = 2);

  update meganet.app_meta set value = '30' where key = 'alert_copy_window_s';
  perform pg_temp.post(64721, 0,  100, 'serial-monitor/_chk-rx-a-sdr1');
  perform pg_temp.post(64721, 20, 100, 'serial-monitor/_chk-rx-a-sdr2');
  perform pg_temp.check_that('window 30: copies 20 s apart are one', pg_temp.rows_of('a:64721') = 1);

  update meganet.app_meta set value = 'eight' where key = 'alert_copy_window_s';
  perform pg_temp.post(64722, 0, 100, 'serial-monitor/_chk-rx-a-sdr1');
  perform pg_temp.post(64722, 1, 100, 'serial-monitor/_chk-rx-a-sdr2');
  perform pg_temp.check_that('a setting that is not a number is read as 8, and costs no reading',
    pg_temp.rows_of('a:64722') = 1 and (select bool_and(dup_count = 1) from meganet.reading where addr = 'a:64722'));

  update meganet.app_meta set value = '600' where key = 'alert_copy_window_s';
  perform pg_temp.post(64723, 0,  100, 'serial-monitor/_chk-rx-a-sdr1');
  perform pg_temp.post(64723, 20, 100, 'serial-monitor/_chk-rx-a-sdr2');
  perform pg_temp.check_that('one over 60 s is read as 8 too: copies 20 s apart stay two', pg_temp.rows_of('a:64723') = 2);

  delete from meganet.app_meta where key = 'alert_copy_window_s';
  perform pg_temp.post(64724, 0, 100, 'serial-monitor/_chk-rx-a-sdr1');
  perform pg_temp.post(64724, 1, 100, 'serial-monitor/_chk-rx-a-sdr2');
  perform pg_temp.check_that('no setting at all: 8', pg_temp.rows_of('a:64724') = 1);
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
