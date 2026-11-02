-- check_alert2_republished.sql — Prove 0097 takes the ELPRO gateway's
-- republished ALERT2 reports back out, and nothing else, against a real
-- database.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_alert2_republished.sql
--
-- Stores a short relay sequence the way the bridge did before 2 November 2026
-- — every message through meganet.ingest(), raw row and readings — shaped on
-- Station 1000's live feed: a report, the same publish delivered twice, a copy
-- 2.5 s later, the gateway's quarter-hour repeat, a new stamp, a changed value,
-- and the same stamp and value twelve hours on. Then runs 0097 from its file,
-- twice, and checks what is left.
--
-- Runs inside a transaction and rolls back. The relayed stations are 64301 and
-- 64302, far from anything the network uses. 0097 walks every ELPRO message in
-- reading_raw, so against the live database this is slow — it is written for
-- CI's empty one.

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

-- One relay message, posted as the bridge posted it: the frame verbatim in the
-- envelope, each set a reading under the gateway's publish time.
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

-- ── The sequence ─────────────────────────────────────────────────────────────
-- [sensor, value, AlertTimestamp]

-- Times from three days ago, inside roll_up()'s retention whenever this runs.
create temporary table _t on commit drop as
select pg_catalog.date_trunc('day', pg_catalog.now() - interval '3 days') + interval '23:01:54' as t0;

select pg_temp.relay(64301, t0, '[[9, 248, 13604], [10, -100, 13604]]') from _t;
select pg_temp.relay(64301, t0, '[[9, 248, 13604], [10, -100, 13604]]') from _t;                          -- delivered twice
select pg_temp.relay(64301, t0 + interval '2.5 s', '[[9, 248, 13604], [10, -100, 13604]]') from _t;       -- a copy
select pg_temp.relay(64301, t0 + interval '15 min', '[[9, 248, 13604], [10, -100, 13604]]') from _t;      -- the timer
select pg_temp.relay(64301, t0 + interval '24 min 23 s', '[[0, 35, 13604], [9, 248, 13604]]') from _t;    -- slot 0 is new
select pg_temp.relay(64301, t0 + interval '75 min', '[[9, 248, 39711]]') from _t;                          -- a new stamp
select pg_temp.relay(64301, t0 + interval '90 min', '[[9, 249, 39711]]') from _t;                          -- a new value
select pg_temp.relay(64301, t0 + interval '105 min', '[[9, 249, 39711]]') from _t;                         -- the timer
select pg_temp.relay(64301, t0 + interval '13 h 30 min 1 s', '[[9, 249, 39711]]') from _t;                 -- 12 h on
-- Frames with no AlertTimestamp cannot be told apart, so are left alone.
select pg_temp.relay(64302, t0 + interval '1 h', '[[13, 93.3, null]]') from _t;
select pg_temp.relay(64302, t0 + interval '75 min', '[[13, 93.3, null]]') from _t;

-- The rollups as roll_up() had them, counting every repeat.
select meganet.roll_up('-infinity');

create temporary table _before on commit drop as
select (select count(*) from meganet.reading_raw where path like 'meganet/v1/_check_a2/%') as raw_rows,
       (select n from meganet.reading_hourly where addr = 'a2:64301/9'
         and bucket = (select pg_catalog.date_trunc('hour', t0) from _t)) as h9;

\ir ../db/migrations/0097_alert2_republished_readings.sql

-- ── What is left ─────────────────────────────────────────────────────────────

do $$
declare
  v_t0 timestamptz := (select _t.t0 from _t);
  v_hr timestamptz := pg_catalog.date_trunc('hour', (select _t.t0 from _t));
  v_9  text;
  v_10 text;
begin
  -- Each slot's readings as seconds after the first.
  select string_agg(round(extract(epoch from reading_ts - v_t0))::text || '=' || value_raw, ' ' order by reading_ts)
    into v_9 from meganet.reading where addr = 'a2:64301/9';
  perform pg_temp.check_that('slot 9 keeps its first sightings only: the report, the new stamp, the new value, and the same pair twelve hours on',
    v_9 = '0=248 4500=248 5400=249 48601=249', v_9);

  select string_agg(round(extract(epoch from reading_ts - v_t0))::text || '=' || value_raw, ' ' order by reading_ts)
    into v_10 from meganet.reading where addr = 'a2:64301/10';
  perform pg_temp.check_that('slot 10 keeps one reading', v_10 = '0=-100', v_10);

  perform pg_temp.check_that('a slot first seen alongside repeats is kept',
    exists (select 1 from meganet.reading where addr = 'a2:64301/0' and value_raw = 35));

  perform pg_temp.check_that('the copy 2.5 s later is counted on the first reading, with the redelivery',
    (select dup_count from meganet.reading where addr = 'a2:64301/10' and reading_ts = v_t0) = 2,
    (select dup_count::text from meganet.reading where addr = 'a2:64301/10' and reading_ts = v_t0));

  perform pg_temp.check_that('frames with no AlertTimestamp are untouched',
    (select count(*) from meganet.reading where addr = 'a2:64302/13') = 2);

  perform pg_temp.check_that('every raw message is still there',
    (select count(*) from meganet.reading_raw where path like 'meganet/v1/_check_a2/%')
      = (select raw_rows from _before));

  perform pg_temp.check_that('the hour that counted four readings of slot 9 now counts one, with its two copies',
    (select h9 from _before) = 4
    and (select n from meganet.reading_hourly where addr = 'a2:64301/9' and bucket = v_hr) = 1
    and (select n_dup from meganet.reading_hourly where addr = 'a2:64301/9' and bucket = v_hr) = 2,
    (select h9 from _before)::text || ' → ' || coalesce((select n::text from meganet.reading_hourly
      where addr = 'a2:64301/9' and bucket = v_hr), 'none'));

  perform pg_temp.check_that('the daily rollup agrees with its hours',
    (select n from meganet.reading_daily where addr = 'a2:64301/9' and bucket = ((v_t0 + interval '1 day') at time zone 'UTC')::date)
      = (select sum(n) from meganet.reading_hourly where addr = 'a2:64301/9'
          and bucket >= ((((v_t0 + interval '1 day') at time zone 'UTC')::date)::timestamp at time zone 'UTC')
          and bucket <  ((((v_t0 + interval '2 days') at time zone 'UTC')::date)::timestamp at time zone 'UTC')));
end
$$;

create temporary table _after on commit drop as
select addr, reading_ts, value_raw, dup_count from meganet.reading where addr like 'a2:6430_/%';

\ir ../db/migrations/0097_alert2_republished_readings.sql

select pg_temp.check_that('running 0097 again changes nothing',
  not exists (
    (select addr, reading_ts, value_raw, dup_count from meganet.reading where addr like 'a2:6430_/%'
     except select * from _after)
    union all
    (select * from _after
     except select addr, reading_ts, value_raw, dup_count from meganet.reading where addr like 'a2:6430_/%')));

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
