-- check_ingest_seen.sql — Prove 0052: a station is last seen when it was
-- heard, not when its reading reached the database.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_ingest_seen.sql
--
-- One row per claim, a non-zero exit if any fails, and a transaction that
-- rolls back — the token, the readings and the station_status rows included —
-- so it is safe against the live database. Run it as a role meganet.is_editor()
-- says yes to (a direct connection), as check_ingest.sql is.
--
-- Addresses 64601–64620: inside the ALERT range, clear of check_ingest.sql's
-- 64001–64200, check_receptions.sql's 643xx and check_reading_signal.sql's
-- 645xx, and far from the network — so each is keyed a:<address>.

\set ON_ERROR_STOP on

begin;

create temporary table _check (ord serial, name text, ok boolean, note text) on commit drop;
create or replace function pg_temp.check_that(p_name text, p_ok boolean, p_note text default '')
returns void language sql as $$ insert into _check (name, ok, note) values (p_name, coalesce(p_ok, false), p_note); $$;
create or replace function pg_temp.ts(p_ago interval)
returns text language sql stable as $$ select to_char(date_trunc('second', now()) - p_ago, 'YYYY-MM-DD"T"HH24:MI:SSOF'); $$;
create or replace function pg_temp.seen(p_addr integer)
returns timestamptz language sql stable as $$ select last_seen_at from meganet.station_status where station_key = 'a:' || p_addr; $$;

create temporary table _tok on commit drop as
  select (meganet.create_ingest_token('_check_seen pi') ->> 'token') as token;

-- A base station's POST, as RPi ALERT makes it.
create or replace function pg_temp.post(p_body text)
returns jsonb language plpgsql as $$
declare a jsonb;
begin
  perform set_config('request.headers', format('{"x-ingest-token":"%s"}', (select token from _tok)), true);
  a := meganet.ingest_http(p_body::jsonb);
  perform set_config('request.headers', '', true);
  return a;
end $$;

do $$
begin
  perform pg_temp.check_that('schema_version is at least 52',
    (select value::integer >= 52 from meganet.app_meta where key = 'schema_version'));
  perform pg_temp.check_that('as_ts_or_null: ISO, epoch seconds and milliseconds, else null — never an error',
    meganet.as_ts_or_null('"2026-10-06T07:00:00Z"') = '2026-10-06T07:00:00Z'::timestamptz
      and meganet.as_ts_or_null('1790843886') = to_timestamp(1790843886)
      and meganet.as_ts_or_null('1790843886000') = to_timestamp(1790843886)
      and meganet.as_ts_or_null('"yesterday-ish"') is null
      and meganet.as_ts_or_null('true') is null
      and meganet.as_ts_or_null('null') is null
      and meganet.as_ts_or_null(null) is null);
  perform pg_temp.check_that('anon still runs ingest_http() and nothing new',
    has_function_privilege('anon', 'meganet.ingest_http(jsonb)', 'execute')
      and not has_function_privilege('anon', 'meganet.as_ts_or_null(jsonb)', 'execute'));
end
$$;

do $$
declare a jsonb;
begin
  -- Live: heard two minutes ago, posted now.
  a := pg_temp.post(format($j${"source":"serial","protocol":"alert","readings":[{"alert_id":64601,"reading_ts":"%s","value_raw":1}]}$j$, pg_temp.ts('2 minutes')));
  perform pg_temp.check_that('a live reading: seen when it was heard',
    pg_temp.seen(64601) = date_trunc('second', now()) - interval '2 minutes', a::text || ' seen ' || pg_temp.seen(64601));

  -- A backfill: heard three days ago, posted now (a base station back on a network, a site survey).
  a := pg_temp.post(format($j${"source":"serial","protocol":"alert","readings":[{"alert_id":64602,"reading_ts":"%s","value_raw":2}]}$j$, pg_temp.ts('3 days')));
  perform pg_temp.check_that('a reading posted three days late: seen three days ago, not now',
    pg_temp.seen(64602) = date_trunc('second', now()) - interval '3 days', 'seen ' || pg_temp.seen(64602));
  perform pg_temp.check_that('…and stored then, as before',
    (select last_reading_at = date_trunc('second', now()) - interval '3 days' from meganet.station_status where station_key = 'a:64602'));

  -- Heard a minute ago; then a backlog from three days ago arrives.
  a := pg_temp.post(format($j${"source":"serial","protocol":"alert","readings":[{"alert_id":64603,"reading_ts":"%s","value_raw":3}]}$j$, pg_temp.ts('1 minute')));
  a := pg_temp.post(format($j${"source":"serial","protocol":"alert","readings":[{"alert_id":64603,"reading_ts":"%s","value_raw":4}]}$j$, pg_temp.ts('3 days')));
  perform pg_temp.check_that('a late batch for a station heard since does not drag it back',
    pg_temp.seen(64603) = date_trunc('second', now()) - interval '1 minute', 'seen ' || pg_temp.seen(64603));

  -- Dead clocks: the station is on the air now, whatever its time says.
  a := pg_temp.post($j${"source":"serial","protocol":"alert","readings":[{"alert_id":64604,"reading_ts":"1985-06-01T00:00:00Z","value_raw":5}]}$j$);
  perform pg_temp.check_that('a time before 1990 (refused): seen now',
    pg_temp.seen(64604) = now() and (a -> 'rejected') @> '[{"i":0}]', a::text);
  a := pg_temp.post(format($j${"source":"serial","protocol":"alert","readings":[{"alert_id":64605,"reading_ts":"%s","value_raw":6}]}$j$, pg_temp.ts('-2 days')));
  perform pg_temp.check_that('a time two days ahead (refused): seen now',
    pg_temp.seen(64605) = now(), a::text);
  a := pg_temp.post(format($j${"source":"serial","protocol":"alert","readings":[{"alert_id":64606,"reading_ts":"%s","value_raw":7}]}$j$, pg_temp.ts('-10 minutes')));
  perform pg_temp.check_that('a time ten minutes ahead (stored): seen now, never in the future',
    pg_temp.seen(64606) = now() and (a ->> 'accepted') = '1', a::text);
  a := pg_temp.post($j${"source":"serial","protocol":"alert","readings":[{"alert_id":64607,"reading_ts":"2000-01-01T00:00:00Z","value_raw":8}]}$j$);
  perform pg_temp.check_that('an RTC reset to 2000 (stored as a reading): seen now',
    pg_temp.seen(64607) = now() and (a ->> 'accepted') = '1', a::text);
  a := pg_temp.post($j${"source":"serial","protocol":"alert","readings":[{"alert_id":64608,"value_raw":9}]}$j$);
  perform pg_temp.check_that('no time at all (refused): seen now',
    pg_temp.seen(64608) = now(), a::text);
  a := pg_temp.post($j${"source":"serial","protocol":"alert","readings":[{"alert_id":64609,"reading_ts":"a while ago","value_raw":10}]}$j$);
  perform pg_temp.check_that('a time that is not one (refused): seen now, and the bookkeeping did not fall over',
    pg_temp.seen(64609) = now(), a::text);

  -- An archive: marked as one, its old times are its own.
  a := pg_temp.post($j${"source":"backfill","protocol":"alert","readings":[{"alert_id":64610,"reading_ts":"2000-01-01T00:00:00Z","value_raw":11}]}$j$);
  perform pg_temp.check_that('a backfill of 2000: seen in 2000',
    pg_temp.seen(64610) = '2000-01-01T00:00:00Z'::timestamptz, 'seen ' || pg_temp.seen(64610));
  a := pg_temp.post(format($j${"source":"serial","protocol":"alert","readings":[{"alert_id":64611,"reading_ts":"%s","value_raw":12,"source":"backfill"}]}$j$, pg_temp.ts('200 days')));
  perform pg_temp.check_that('…a row saying so in a batch that does not: its own time',
    pg_temp.seen(64611) = date_trunc('second', now()) - interval '200 days', 'seen ' || pg_temp.seen(64611));

  -- One address, several rows: the latest heard.
  a := pg_temp.post(format($j${"source":"serial","protocol":"alert","readings":[{"alert_id":64612,"reading_ts":"%s","value_raw":13},{"alert_id":64612,"reading_ts":"%s","value_raw":14}]}$j$,
         pg_temp.ts('2 days'), pg_temp.ts('5 hours')));
  perform pg_temp.check_that('several rows for one address: the latest of them',
    pg_temp.seen(64612) = date_trunc('second', now()) - interval '5 hours', 'seen ' || pg_temp.seen(64612));
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
