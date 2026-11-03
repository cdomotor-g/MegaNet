-- check_alert2_restored.sql — Prove 0097 then 0098 leave every ELPRO
-- transmission stored once, every copy counted on its reading, and the legacy
-- reports a bridge restart cut short put back — against a real database.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_alert2_restored.sql
--
-- Stores a short ALERT2 relay sequence the way the bridge did before 2 November
-- 2026 — every message through meganet.ingest(), raw row and readings — shaped
-- on Station 1000's live feed: a stamp that does not move while the station
-- transmits every quarter hour, the same publish delivered twice, a copy 2.5 s
-- later, and the same stamp and value twelve hours on. Runs 0097 (which took
-- the quarter-hour transmissions for republishes and removed them), then a
-- retained hand-over of the copy as a freshly restarted bridge stored it, then
-- 0098, twice, and checks what is left. Then a legacy table and a batch the
-- bridge cut short after a restart, and 0098 putting the batch back.
--
-- Runs inside a transaction and rolls back. The relayed stations are 64301 and
-- 64302 and the legacy addresses 64310-64322, far from anything the network
-- uses. 0097 and 0098 walk every ELPRO message in reading_raw, so against the
-- live database this is slow — it is written for CI's empty one.

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

-- One ALERT2 relay message, posted as the bridge posted it before 2 November:
-- the frame verbatim in the envelope, every set a reading under the gateway's
-- publish time.
create or replace function pg_temp.relay(p_station integer, p_at timestamptz, p_sets jsonb)
returns void language plpgsql as $$
declare
  v_ms    bigint := (extract(epoch from p_at) * 1000)::bigint;
  v_frame jsonb;
  v_rows  jsonb;
begin
  select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'timestamp', v_ms, 'Sensor', (s ->> 0)::integer, 'Value', (s ->> 1)::numeric,
           'AlertTimestamp', (s ->> 2)::integer)) order by o),
         jsonb_agg(jsonb_build_object(
           'a2_station', p_station, 'a2_sensor', (s ->> 0)::integer,
           'reading_ts', v_ms, 'value_raw', (s ->> 1)::numeric) order by o)
    into v_frame, v_rows
    from jsonb_array_elements(p_sets) with ordinality as x(s, o);
  perform meganet.ingest(jsonb_build_object(
    'source', 'mqtt', 'protocol', 'elpro',
    'path', 'meganet/v1/_check_a2/logger/reading/elpro/Station ' || p_station,
    'frame', v_frame::text, 'received_at', p_at + interval '1 second',
    'readings', v_rows));
end
$$;

-- One legacy Alert1 message, with only its first p_stored entries stored — what
-- a bridge that could not split it kept.
create or replace function pg_temp.relay1(p_at timestamptz, p_sets jsonb, p_stored integer)
returns void language plpgsql as $$
declare
  v_ms    bigint := (extract(epoch from p_at) * 1000)::bigint;
  v_frame jsonb;
  v_rows  jsonb;
begin
  select jsonb_agg(jsonb_build_object('timestamp', v_ms, 'Sensor', (s ->> 0)::integer,
                                      'Value', (s ->> 1)::numeric) order by o),
         coalesce(jsonb_agg(jsonb_build_object('alert_id', (s ->> 0)::integer, 'reading_ts', v_ms,
                                               'value_raw', (s ->> 1)::numeric) order by o)
                    filter (where o <= p_stored), '[]'::jsonb)
    into v_frame, v_rows
    from jsonb_array_elements(p_sets) with ordinality as x(s, o);
  perform meganet.ingest(jsonb_build_object(
    'source', 'mqtt', 'protocol', 'elpro',
    'path', 'meganet/v1/_check_a2/logger/reading/elpro/Alert1',
    'frame', v_frame::text, 'received_at', p_at + interval '1 second',
    'readings', v_rows));
end
$$;

-- Times from three days ago, inside roll_up()'s retention whenever this runs.
create temporary table _t on commit drop as
select pg_catalog.date_trunc('day', pg_catalog.now() - interval '3 days') + interval '23:01:54' as t0;

-- ── The ALERT2 sequence — [sensor, value, AlertTimestamp] ────────────────────

select pg_temp.relay(64301, t0, '[[9, 248, 13604], [10, -100, 13604]]') from _t;
select pg_temp.relay(64301, t0, '[[9, 248, 13604], [10, -100, 13604]]') from _t;                          -- delivered twice
select pg_temp.relay(64301, t0 + interval '2.5 s', '[[9, 248, 13604], [10, -100, 13604]]') from _t;       -- a copy
select pg_temp.relay(64301, t0 + interval '15 min', '[[9, 248, 13604], [10, -100, 13604]]') from _t;      -- next transmission
select pg_temp.relay(64301, t0 + interval '24 min 23 s', '[[0, 35, 13604], [9, 248, 13604]]') from _t;
select pg_temp.relay(64301, t0 + interval '75 min', '[[9, 248, 39711]]') from _t;
select pg_temp.relay(64301, t0 + interval '90 min', '[[9, 249, 39711]]') from _t;
select pg_temp.relay(64301, t0 + interval '105 min', '[[9, 249, 39711]]') from _t;
select pg_temp.relay(64301, t0 + interval '13 h 30 min 1 s', '[[9, 249, 39711]]') from _t;
select pg_temp.relay(64302, t0 + interval '1 h', '[[13, 93.3, null]]') from _t;
select pg_temp.relay(64302, t0 + interval '75 min', '[[13, 93.3, null]]') from _t;

select meganet.roll_up('-infinity');

\ir ../db/migrations/0097_alert2_republished_readings.sql

create temporary table _after_0097 on commit drop as
select (select count(*) from meganet.reading where addr = 'a2:64301/9') as slot9;

-- A restarted bridge storing the copy again from the broker's retained hand-over
-- (as on 2 November at 03:12 UTC): the same bytes as the copy, as a row of its
-- own.
select pg_temp.relay(64301, t0 + interval '2.5 s', '[[9, 248, 13604], [10, -100, 13604]]') from _t;

-- ── The legacy sequence — [address, value] ───────────────────────────────────

select pg_temp.relay1(t0 + interval '2 h', '[[64310, 5]]', 1) from _t;
select pg_temp.relay1(t0 + interval '2 h 1 min', '[[64311, 7], [64310, 5]]', 1) from _t;
select pg_temp.relay1(t0 + interval '2 h 2 min', '[[64312, 9], [64311, 7], [64310, 5]]', 1) from _t;
-- Three reports that arrived together, kept short by a bridge that had just
-- restarted and did not know the table.
select pg_temp.relay1(t0 + interval '2 h 3 min', '[[64320, 1], [64321, 2], [64322, 3]]', 1) from _t;

\ir ../db/migrations/0098_alert2_readings_restored.sql

-- ── What is left ─────────────────────────────────────────────────────────────

do $$
declare
  v_t0 timestamptz := (select _t.t0 from _t);
  v_hr timestamptz := pg_catalog.date_trunc('hour', (select _t.t0 from _t));
  v_9  text;
  v_10 text;
begin
  perform pg_temp.check_that('0097 had taken the quarter-hour transmissions out (the starting point)',
    (select slot9 from _after_0097) = 4, (select slot9 from _after_0097)::text);

  -- Each slot's readings as seconds after the first.
  select string_agg(round(extract(epoch from reading_ts - v_t0))::text || '=' || value_raw, ' ' order by reading_ts)
    into v_9 from meganet.reading where addr = 'a2:64301/9';
  perform pg_temp.check_that('slot 9 has every transmission, each once, under its own time',
    v_9 = '0=248 900=248 1463=248 4500=248 5400=249 6300=249 48601=249', v_9);

  select string_agg(round(extract(epoch from reading_ts - v_t0))::text || '=' || value_raw, ' ' order by reading_ts)
    into v_10 from meganet.reading where addr = 'a2:64301/10';
  perform pg_temp.check_that('slot 10 has both of its transmissions', v_10 = '0=-100 900=-100', v_10);

  perform pg_temp.check_that('the redelivery and the copy are counted on the first reading, once each',
    (select dup_count from meganet.reading where addr = 'a2:64301/10' and reading_ts = v_t0) = 2,
    (select dup_count::text from meganet.reading where addr = 'a2:64301/10' and reading_ts = v_t0));

  perform pg_temp.check_that('the copy the retained hand-over stored as a row of its own is gone',
    not exists (select 1 from meganet.reading
                 where addr like 'a2:64301/%' and reading_ts = v_t0 + interval '2.5 s'));

  perform pg_temp.check_that('a restored reading is linked to the message it came in',
    (select r.raw_id is not null and w.path like '%/Station 64301'
       from meganet.reading r join meganet.reading_raw w on w.id = r.raw_id
      where r.addr = 'a2:64301/9' and r.reading_ts = v_t0 + interval '15 min'));

  perform pg_temp.check_that('frames with no AlertTimestamp are untouched',
    (select count(*) from meganet.reading where addr = 'a2:64302/13') = 2);

  perform pg_temp.check_that('the hour holding three of slot 9''s transmissions counts three, with its two copies',
    (select n from meganet.reading_hourly where addr = 'a2:64301/9' and bucket = v_hr) = 3
    and (select n_dup from meganet.reading_hourly where addr = 'a2:64301/9' and bucket = v_hr) = 2,
    coalesce((select n || ' / ' || n_dup from meganet.reading_hourly
               where addr = 'a2:64301/9' and bucket = v_hr), 'none'));

  perform pg_temp.check_that('the daily rollup agrees with its hours',
    (select n from meganet.reading_daily where addr = 'a2:64301/9' and bucket = ((v_t0 + interval '1 day') at time zone 'UTC')::date)
      = (select sum(n) from meganet.reading_hourly where addr = 'a2:64301/9'
          and bucket >= ((((v_t0 + interval '1 day') at time zone 'UTC')::date)::timestamp at time zone 'UTC')
          and bucket <  ((((v_t0 + interval '2 days') at time zone 'UTC')::date)::timestamp at time zone 'UTC')));

  perform pg_temp.check_that('the legacy batch the bridge cut short is whole again',
    (select count(*) from meganet.reading where addr in ('a:64320', 'a:64321', 'a:64322')) = 3);

  perform pg_temp.check_that('the legacy table''s re-sent entries were not put back',
    (select count(*) from meganet.reading where addr = 'a:64310') = 1
    and (select count(*) from meganet.reading where addr = 'a:64311') = 1
    and (select count(*) from meganet.reading where addr = 'a:64312') = 1);
end
$$;

create temporary table _after on commit drop as
select addr, reading_ts, value_raw, dup_count from meganet.reading where addr like 'a2:6430_/%' or addr like 'a:643__';

\ir ../db/migrations/0098_alert2_readings_restored.sql

select pg_temp.check_that('running 0098 again changes nothing',
  not exists (
    (select addr, reading_ts, value_raw, dup_count from meganet.reading where addr like 'a2:6430_/%' or addr like 'a:643__'
     except select * from _after)
    union all
    (select * from _after
     except select addr, reading_ts, value_raw, dup_count from meganet.reading where addr like 'a2:6430_/%' or addr like 'a:643__')));

-- ── The verdict ─────────────────────────────────────────────────────────────

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
