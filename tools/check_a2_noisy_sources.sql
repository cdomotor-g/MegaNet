-- check_a2_noisy_sources.sql — Prove 0126: what only a held ALERT2
-- concentrator relayed is not stored, does not count as the station heard,
-- and what it already put in can be taken out — while a good concentrator's
-- reports, legacy bursts and everything else go through as before.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_a2_noisy_sources.sql
--
-- One row per claim, a non-zero exit if any fails, and a transaction that
-- rolls back — the token, the hold, the readings and the station_status rows
-- included — so it is safe against the live database. Run it as a role
-- meganet.is_editor() says yes to (a direct connection), as check_ingest.sql is.
--
-- Addresses 64801–64830 and ALERT2 sources 64801 (held here) and 64802 (not):
-- clear of check_ingest.sql's 64001–64200, check_receptions.sql's 643xx,
-- check_reading_signal.sql's 645xx, check_ingest_seen.sql's 646xx and
-- check_alert_copies.sql's 647xx, and far from the network — so each address
-- is keyed a:<address> in station_status.

\set ON_ERROR_STOP on

begin;

create temporary table _check (ord serial, name text, ok boolean, note text) on commit drop;
create or replace function pg_temp.check_that(p_name text, p_ok boolean, p_note text default '')
returns void language sql as $$ insert into _check (name, ok, note) values (p_name, coalesce(p_ok, false), p_note); $$;
create or replace function pg_temp.ts(p_s integer)
returns text language sql stable as $$ select to_char(date_trunc('second', now()) - interval '10 minutes' + p_s * interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SSOF'); $$;
create or replace function pg_temp.rows_of(p_addr integer)
returns bigint language sql stable as $$ select count(*) from meganet.reading where addr = 'a:' || p_addr; $$;
create or replace function pg_temp.seen(p_addr integer)
returns boolean language sql stable as $$ select exists (select 1 from meganet.station_status where station_key = 'a:' || p_addr); $$;

create temporary table _tok on commit drop as
  select (meganet.create_ingest_token('_check_noisy pi') ->> 'token') as token;

-- A base station's POST, as RPi ALERT makes it: the envelope, the frame text
-- with each report's source, and the readings.
create or replace function pg_temp.post(p_frame text, p_readings jsonb, p_protocol text default 'alert2')
returns jsonb language plpgsql as $$
declare a jsonb;
begin
  perform set_config('request.headers', format('{"x-ingest-token":"%s"}', (select token from _tok)), true);
  a := meganet.ingest_http(jsonb_build_object('source', 'serial', 'protocol', p_protocol,
         'path', 'serial-monitor/_chk-noisy-sdr1-151.5375', 'frame', p_frame, 'readings', p_readings));
  perform set_config('request.headers', '', true);
  return a;
end $$;
create or replace function pg_temp.rd(p_id integer, p_value integer, p_s integer, p_extra jsonb default '{}')
returns jsonb language sql stable as $$
  select jsonb_build_object('alert_id', p_id, 'value_raw', p_value, 'reading_ts', pg_temp.ts(p_s), 'freq_mhz', 151.5375) || p_extra;
$$;

insert into meganet.a2_source_hold (a2_source, reason, held_by) values (64801, '_check: relays noise', '_check');

-- ── 1. The shape ─────────────────────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('schema_version is at least 126',
    (select value::integer >= 126 from meganet.app_meta where key = 'schema_version'));
  perform pg_temp.check_that('33300 is held, with a reason',
    (select length(reason) > 20 from meganet.a2_source_hold where a2_source = 33300));
  perform pg_temp.check_that('anyone may read the held sources',
    has_table_privilege('anon', 'meganet.a2_source_hold', 'select')
      and not has_table_privilege('anon', 'meganet.a2_source_hold', 'insert')
      and not has_table_privilege('authenticated', 'meganet.a2_source_hold', 'delete'));
  perform pg_temp.check_that('only the service key may take readings out',
    not has_function_privilege('anon', 'meganet.take_out_held_relays()', 'execute')
      and not has_function_privilege('authenticated', 'meganet.take_out_held_relays()', 'execute'));
  perform pg_temp.check_that('a2_relay_sources reads every source a frame names for a report, and only for that report',
    meganet.a2_relay_sources(E'SDR,ALERT2,64801,76,src=64801,stamp=1,before=58,mhz=151.5375\r\n'
                             || E'SDR,ALERT2,64801,76,src=64802,path=1-2\nSDR,ALERT2,648011,76,src=9\n'
                             || 'SDR,ALERT2,64801,761,src=8\nSDR,ALERT2,64801,76,src=123456', 64801, 76)
      = array[64801, 64802]);
end
$$;

-- ── 2. A held source's report is held; a good one's is stored ───────────────

do $$
declare a jsonb;
begin
  a := pg_temp.post(
    E'SDR,ALERT2,64801,76,src=64801,stamp=4221,before=58,mhz=151.5375\n'
    || E'SDR,ALERT2,64802,1329,src=64802,path=11056-10019,stamp=8777,before=29,mhz=151.5375\n'
    || E'SDR,ALERT2,64803,500,src=64801,stamp=4221,before=40,mhz=151.5375\n'
    || E'SDR,ALERT2,64803,500,src=64802,path=1,stamp=8777,before=40,mhz=151.5375\n'
    || 'SDR,ALERT2,64805,9,src=64801,stamp=4221,before=30,mhz=151.5375',
    jsonb_build_array(pg_temp.rd(64801, 76, 0), pg_temp.rd(64802, 1329, 1), pg_temp.rd(64803, 500, 2),
                      pg_temp.rd(64804, 7, 3), pg_temp.rd(64805, 9, 4, '{"a2_source": 64802}')));
  perform pg_temp.check_that('the answer counts one held, four stored, none refused',
    (a ->> 'held')::int = 1 and (a ->> 'accepted')::int = 4 and jsonb_array_length(a -> 'rejected') = 0, a::text);
  perform pg_temp.check_that('a report only the held source relayed is not stored',
    pg_temp.rows_of(64801) = 0);
  perform pg_temp.check_that('…and does not count as that address heard (station_status)',
    not pg_temp.seen(64801));
  perform pg_temp.check_that('…but the submission keeps it, under held, with its source',
    (select payload -> 'held' -> 0 ->> 'alert_id' = '64801' and payload -> 'held' -> 0 -> 'held_a2_source' = '[64801]'::jsonb
       from meganet.reading_raw where id = (a ->> 'raw_id')::bigint));
  perform pg_temp.check_that('a good source''s report is stored and heard',
    pg_temp.rows_of(64802) = 1 and pg_temp.seen(64802));
  perform pg_temp.check_that('a report a good source relayed as well as the held one is a real one: stored',
    pg_temp.rows_of(64803) = 1);
  perform pg_temp.check_that('a report the frame says nothing about is stored',
    pg_temp.rows_of(64804) = 1);
  perform pg_temp.check_that('a reading''s own a2_source is taken over the frame',
    pg_temp.rows_of(64805) = 1);

  a := pg_temp.post('', jsonb_build_array(pg_temp.rd(64806, 11, 5, '{"a2_source": 64801}')));
  perform pg_temp.check_that('…both ways: a held a2_source holds it with no frame at all',
    pg_temp.rows_of(64806) = 0 and (a ->> 'held')::int = 1, a::text);
end
$$;

-- ── 3. Only ALERT2-relayed legacy reports ────────────────────────────────────

do $$
declare a jsonb;
begin
  a := pg_temp.post('SDR,ALERT2,64807,12,src=64801', jsonb_build_array(pg_temp.rd(64807, 12, 6)), 'alert');
  perform pg_temp.check_that('a legacy burst heard direct is never held, whatever the frame says',
    pg_temp.rows_of(64807) = 1 and coalesce((a ->> 'held')::int, 0) = 0, a::text);

  a := meganet.ingest(jsonb_build_object('source', 'serial', 'protocol', 'alert2', 'path', 'serial-monitor/_chk-noisy-direct',
         'frame', 'SDR,ALERT2,64808,13,src=64801', 'readings', jsonb_build_array(pg_temp.rd(64808, 13, 7))));
  perform pg_temp.check_that('ingest() called directly holds it too',
    pg_temp.rows_of(64808) = 0 and (a ->> 'held')::int = 1, a::text);

  a := meganet.ingest(jsonb_build_array(pg_temp.rd(64809, 14, 8, '{"protocol": "alert2"}')));
  perform pg_temp.check_that('a bare array of readings, with no envelope to hold a frame, still goes in',
    pg_temp.rows_of(64809) = 1 and (a ->> 'accepted')::int = 1, a::text);
end
$$;

-- ── 4. Lifting a hold ────────────────────────────────────────────────────────

do $$
declare a jsonb;
begin
  delete from meganet.a2_source_hold where a2_source = 64801;
  a := pg_temp.post('SDR,ALERT2,64810,15,src=64801', jsonb_build_array(pg_temp.rd(64810, 15, 9)));
  perform pg_temp.check_that('a source no longer held is stored again',
    pg_temp.rows_of(64810) = 1 and pg_temp.seen(64810), a::text);
  insert into meganet.a2_source_hold (a2_source, reason, held_by) values (64801, '_check: relays noise', '_check');
end
$$;

-- ── 5. Taking out what a held source already put in ─────────────────────────
-- 64810 went in while 64801 was not held (above), and 64811–64813 are put
-- in now the same way. take_out_held_relays() removes those only 64801
-- relayed and nothing else heard, and leaves the rest.

do $$
declare a jsonb; v jsonb;
begin
  delete from meganet.a2_source_hold where a2_source = 64801;
  a := pg_temp.post(E'SDR,ALERT2,64811,16,src=64801\nSDR,ALERT2,64812,17,src=64801\nSDR,ALERT2,64812,17,src=64802\n'
                    || 'SDR,ALERT2,64813,18,src=64801',
                    jsonb_build_array(pg_temp.rd(64811, 16, 10), pg_temp.rd(64812, 17, 11), pg_temp.rd(64813, 18, 12)));
  -- 64813 heard again another way: a copy, so a real burst.
  perform meganet.ingest(jsonb_build_object('source', 'serial', 'protocol', 'alert', 'path', 'serial-monitor/_chk-noisy-other',
            'readings', jsonb_build_array(pg_temp.rd(64813, 18, 13))));
  perform pg_temp.check_that('(set-up) all four stored while 64801 was not held',
    pg_temp.rows_of(64810) + pg_temp.rows_of(64811) + pg_temp.rows_of(64812) + pg_temp.rows_of(64813) = 4
      and (select dup_count from meganet.reading where addr = 'a:64813') = 1);
  perform meganet.roll_up(now() - interval '2 hours');
  insert into meganet.a2_source_hold (a2_source, reason, held_by) values (64801, '_check: relays noise', '_check');

  v := meganet.take_out_held_relays();
  perform pg_temp.check_that('take_out_held_relays removes what only the held source relayed',
    pg_temp.rows_of(64810) = 0 and pg_temp.rows_of(64811) = 0 and (v ->> 'readings')::int >= 2, v::text);
  perform pg_temp.check_that('…and keeps what a good source relayed too, and what something else heard',
    pg_temp.rows_of(64812) = 1 and pg_temp.rows_of(64813) = 1 and pg_temp.rows_of(64802) = 1);
  perform pg_temp.check_that('…takes their hourly rollups with them',
    not exists (select 1 from meganet.reading_hourly where addr in ('a:64810', 'a:64811'))
      and exists (select 1 from meganet.reading_hourly where addr = 'a:64812'));
  perform pg_temp.check_that('…and the station_status rows noise alone made',
    not pg_temp.seen(64810) and not pg_temp.seen(64811) and pg_temp.seen(64812));
  perform pg_temp.check_that('run again, it finds nothing more',
    (meganet.take_out_held_relays() ->> 'readings')::int = 0);
end
$$;

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
