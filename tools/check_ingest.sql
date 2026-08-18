-- check_ingest.sql — Prove the telemetry contract, against a real database.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_ingest.sql
--
-- Every check below is one line of #75's acceptance. The whole script runs inside
-- a transaction and rolls back, so it is safe against the live database: nothing
-- it writes survives, including the rollups and the retention watermark it moves.
--
-- It needs to be run as a role meganet.is_editor() says yes to — a direct psql
-- connection, or one holding the service key. It prints a row per check and exits
-- non-zero if any of them failed, so it works in a workflow as well as by hand.
--
-- Times are relative to now() rather than fixed, because rolling up and ageing
-- out are both defined against the clock and a fixture dated 1991 would exercise
-- neither. The addresses are 64001–64200, which is inside the ALERT range and
-- far from anything the network uses; even so, a collision would need the same
-- address, second and value, and the transaction is rolled back regardless.

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

-- The clock the whole script hangs off: the top of the hour, 26 hours ago. Old
-- enough that a one-day retention window sweeps it, recent enough that a
-- ninety-day one does not.
create temporary table _base on commit drop as
  select date_trunc('hour', now()) - interval '26 hours' as t;

create or replace function pg_temp.base(p_offset interval default '0')
returns text language sql stable as $$
  select (t + p_offset)::text from _base;
$$;

-- Stations to resolve against: one carrying a unique address, two sharing one.
insert into meganet.rm_system (id, ord, name)
values (-991, -991, 'check_ingest placeholder')
on conflict (id) do nothing;

insert into meganet.station (id, ord, name, station_number, rm_system_id)
values ('_check_alpha', -991, 'Check Alpha', '999001', -991),
       ('_check_beta',  -992, 'Check Beta',  '999002', -991),
       ('_check_gamma', -993, 'Check Gamma', '999003', -991);

insert into meganet.sensor (station_id, sensor_id, type, ord, alert_id) values
  ('_check_alpha', '999001.0.R.64001', 'Rainfall', 0, 64001),   -- unique -> resolves
  ('_check_beta',  '999002.0.R.64002', 'Rainfall', 0, 64002),   -- shared -> stays null
  ('_check_gamma', '999003.0.R.64002', 'Rainfall', 0, 64002);

-- Ninety days to begin with, so everything below is inside the horizon and the
-- rollups run. The retention section turns it down at the end.
insert into meganet.app_meta (key, value) values ('retain_reading_days', '90')
on conflict (key) do update set value = excluded.value;

-- ── 1. The migration landed whole ────────────────────────────────────────────

do $$
begin
  -- At least 6, not exactly 6: this file checks the telemetry contract, and a
  -- database that has also applied 0007, 0008 or 0009 still has it. Asserting
  -- equality here meant this check failed on every current database from the
  -- moment 0007 landed.
  perform pg_temp.check_that('schema_version is at least 6',
    (select value::integer >= 6 from meganet.app_meta where key = 'schema_version'));

  perform pg_temp.check_that('all four tables exist',
    (select count(*) = 4 from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'meganet' and c.relkind = 'r'
        and c.relname in ('reading', 'reading_raw', 'reading_hourly', 'reading_daily')));

  perform pg_temp.check_that('RLS is on for every table this migration created',
    (select bool_and(c.relrowsecurity) from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'meganet'
        and c.relname in ('reading', 'reading_raw', 'reading_hourly', 'reading_daily',
                          'ingest_source', 'protocol', 'quality', 'unit')),
    'db/README.md: no table without RLS, in the same file');

  perform pg_temp.check_that('ingest() is not executable by anon',
    not has_function_privilege('anon', 'meganet.ingest(jsonb)', 'execute'),
    'a grant here would make the readings table writable from a published key');

  -- 0018 (#155): a wire protocol is rows, not DDL, and these are the rows.
  -- The full HFEM acceptance — a mapped message landing with them — is in
  -- check_mqtt.sql, on the route the bridge actually posts through.
  perform pg_temp.check_that('the HFEM vocabulary is present (0018)',
    exists (select 1 from meganet.protocol where code = 4 and key = 'hfem')
      and exists (select 1 from meganet.quality where code = 6 and key = 'maintenance')
      and (select count(*) = 2 from meganet.unit where key in ('W/m2', 'MPa')));

  perform pg_temp.check_that('reading_raw is not readable by anon',
    not has_table_privilege('anon', 'meganet.reading_raw', 'select'),
    'a submission is whatever a device sent, unread');
end
$$;

-- ── 2. A duplicate is a no-op, counted, not an error ─────────────────────────

do $$
declare
  a jsonb;
  b jsonb;
begin
  a := meganet.ingest(format($j${"source":"mqtt","protocol":"alert2","path":"DIRECT","readings":[
        {"alert_id":64001,"reading_ts":"%s","value_raw":12,
         "value":2.4,"unit":"mm","conversion":"raw x 0.2 mm per tip"}]}$j$,
        pg_temp.base('5 minutes'))::jsonb);

  -- The same transmission heard again, via two repeaters. That is what a
  -- repeater network is.
  b := meganet.ingest(format($j${"source":"mqtt","protocol":"alert2","path":"REPEATER_ONE","readings":[
        {"alert_id":64001,"reading_ts":"%1$s","value_raw":12},
        {"alert_id":64001,"reading_ts":"%1$s","value_raw":12,"path":"REPEATER_TWO"}]}$j$,
        pg_temp.base('5 minutes'))::jsonb);

  perform pg_temp.check_that('first submission is accepted',
    (a ->> 'accepted') = '1' and (a ->> 'duplicates') = '0', a::text);

  perform pg_temp.check_that('the same reading again is a duplicate, not an error',
    (b ->> 'accepted') = '0' and (b ->> 'duplicates') = '2'
      and jsonb_array_length(b -> 'rejected') = 0, b::text);

  perform pg_temp.check_that('one row, not three',
    (select count(*) = 1 from meganet.reading where alert_id = 64001));

  perform pg_temp.check_that('the duplicates are counted',
    (select dup_count = 2 from meganet.reading where alert_id = 64001));

  perform pg_temp.check_that('both other paths are recorded',
    (select dup_paths @> array['REPEATER_ONE','REPEATER_TWO']
       from meganet.reading where alert_id = 64001),
    'how often a reading arrives by three paths is the diagnostic');

  perform pg_temp.check_that('the submission is kept as it arrived',
    (select count(*) >= 2 from meganet.reading_raw
      where payload -> 'readings' @> '[{"alert_id":64001}]'::jsonb));

  -- Same address, same second, genuinely different value: kept, because
  -- value_raw is in the key.
  perform meganet.ingest(format($j$[{"alert_id":64001,"reading_ts":"%s",
    "value_raw":13,"source":"mqtt"}]$j$, pg_temp.base('5 minutes'))::jsonb);
  perform pg_temp.check_that('a same-second change is not eaten',
    (select count(*) = 2 from meganet.reading where alert_id = 64001));
end
$$;

-- ── 3. One bad row never costs the batch ─────────────────────────────────────
-- Eight rows: two good, six wrong in six different ways.

do $$
declare
  a jsonb;
begin
  a := meganet.ingest(format($j${"source":"http","protocol":"alert","readings":[
        {"alert_id":64010,"reading_ts":"%1$s","value_raw":1},
        {"alert_id":64011,"reading_ts":"1970-01-01T00:00:00Z","value_raw":1},
        {"alert_id":64012,"reading_ts":"%1$s","value_raw":3},
        {"alert_id":99999,"reading_ts":"%1$s","value_raw":4},
        {"reading_ts":"%1$s","value_raw":5},
        {"alert_id":64013,"reading_ts":"%1$s","value_raw":6,"unit":"furlongs"},
        {"alert_id":64014,"reading_ts":"%1$s","value_raw":"not a number"},
        {"alert_id":64015,"reading_ts":"%1$s","value_raw":7,"protocol":"smoke signals"}
      ]}$j$, pg_temp.base('1 hour'))::jsonb);

  perform pg_temp.check_that('the good rows in a mixed batch are stored',
    (a ->> 'accepted') = '2', a ->> 'accepted');

  perform pg_temp.check_that('they really are in the table',
    (select count(*) = 2 from meganet.reading where alert_id in (64010, 64012)));

  perform pg_temp.check_that('every bad row comes back with its index and a reason',
    jsonb_array_length(a -> 'rejected') = 6
      and not exists (select 1 from jsonb_array_elements(a -> 'rejected') e
                       where (e ->> 'why') is null or (e ->> 'why') = ''
                          or (e ->> 'i') is null),
    (a -> 'rejected')::text);

  perform pg_temp.check_that('the dead-clock row is rejected for its clock',
    exists (select 1 from jsonb_array_elements(a -> 'rejected') e
             where (e ->> 'i') = '1' and (e ->> 'why') like '%before 1990%'),
    (a -> 'rejected')::text);

  perform pg_temp.check_that('an out-of-range address is rejected',
    exists (select 1 from jsonb_array_elements(a -> 'rejected') e
             where (e ->> 'i') = '3' and (e ->> 'why') like '%1-65535%'));

  perform pg_temp.check_that('a reading with no address at all is rejected',
    exists (select 1 from jsonb_array_elements(a -> 'rejected') e
             where (e ->> 'i') = '4' and (e ->> 'why') like '%no address%'));

  perform pg_temp.check_that('an unknown unit is rejected, naming the unit',
    exists (select 1 from jsonb_array_elements(a -> 'rejected') e
             where (e ->> 'i') = '5' and (e ->> 'why') like '%furlongs%'));

  perform pg_temp.check_that('a value that is not a number is rejected',
    exists (select 1 from jsonb_array_elements(a -> 'rejected') e
             where (e ->> 'i') = '6' and (e ->> 'why') like '%value_raw%'));

  perform pg_temp.check_that('an unknown protocol is rejected, naming it',
    exists (select 1 from jsonb_array_elements(a -> 'rejected') e
             where (e ->> 'i') = '7' and (e ->> 'why') like '%smoke signals%'),
    'a new protocol is an INSERT into meganet.protocol, not a schema change');

  -- A reading a year in the future is the other half of the dead-clock case.
  a := meganet.ingest(format($j$[{"alert_id":64016,"reading_ts":"%s","value_raw":1,
        "source":"http"}]$j$, (now() + interval '400 days')::text)::jsonb);
  perform pg_temp.check_that('a clock a year fast is rejected too',
    (a ->> 'accepted') = '0'
      and (a -> 'rejected' -> 0 ->> 'why') like '%in the future%',
    (a -> 'rejected')::text);

  -- The envelope is a different kind of wrong from a row, and gets a different
  -- answer: SQLSTATE 22023, which PostgREST returns as HTTP 400.
  begin
    perform meganet.ingest('"just a string"'::jsonb);
    perform pg_temp.check_that('a malformed envelope is refused outright', false);
  exception when others then
    perform pg_temp.check_that('a malformed envelope is refused outright',
      sqlstate = '22023', sqlstate || ' ' || sqlerrm);
  end;
end
$$;

-- ── 4. Unknown addresses store, and resolve later ────────────────────────────

do $$
declare
  a jsonb;
  b jsonb;
begin
  -- 64001 is carried by exactly one station: resolved on the way in.
  perform pg_temp.check_that('an unambiguous address resolves on arrival',
    (select station_id = '_check_alpha' from meganet.reading
      where alert_id = 64001 and value_raw = 12));

  -- 64002 is carried by two: stored, and left null rather than guessed.
  a := meganet.ingest(format($j$[{"alert_id":64002,"reading_ts":"%s",
        "value_raw":5,"source":"http"}]$j$, pg_temp.base('2 hours'))::jsonb);
  perform pg_temp.check_that('a shared address is stored, not dropped',
    (a ->> 'accepted') = '1');
  perform pg_temp.check_that('a shared address is left unresolved, not guessed',
    (select station_id is null from meganet.reading where alert_id = 64002),
    '604 of 5,122 addresses are shared — picking one would invent a fact');

  -- 64099 belongs to nobody yet: the brand-new site reporting before anyone has
  -- got round to adding it to MegaNet.
  a := meganet.ingest(format($j$[{"alert_id":64099,"reading_ts":"%s",
        "value_raw":7,"source":"http"}]$j$, pg_temp.base('2 hours'))::jsonb);
  perform pg_temp.check_that('an address matching no station is still stored',
    (a ->> 'accepted') = '1'
      and (select station_id is null from meganet.reading where alert_id = 64099),
    'never drop a reading because the address is unresolved');

  -- Somebody adds the site the next morning.
  insert into meganet.station (id, ord, name, station_number, rm_system_id)
  values ('_check_delta', -994, 'Check Delta', '999004', -991);
  insert into meganet.sensor (station_id, sensor_id, type, ord, alert_id)
  values ('_check_delta', '999004.0.R.64099', 'Rainfall', 0, 64099);

  b := meganet.resolve_readings();
  perform pg_temp.check_that('the backfill resolves it once the station exists',
    (select station_id = '_check_delta' from meganet.reading where alert_id = 64099),
    b::text);
  perform pg_temp.check_that('the backfill leaves the still-ambiguous one alone',
    (select station_id is null from meganet.reading where alert_id = 64002));
end
$$;

-- ── 5. A station with no ALERT address at all ────────────────────────────────
-- Satellite and cellular sites are not radio and have no ALERT address. They
-- report under their station number, with a channel to say which sensor spoke.

do $$
declare
  a jsonb;
begin
  a := meganet.ingest(format($j${"source":"http","readings":[
        {"station_number":"999001","channel":"rain","reading_ts":"%1$s",
         "value_raw":1.5,"unit":"mm"},
        {"station_number":"999001","channel":"level","reading_ts":"%1$s",
         "value_raw":1.842,"unit":"m"}]}$j$, pg_temp.base('3 hours'))::jsonb);

  perform pg_temp.check_that('two channels at one station number are two readings',
    (a ->> 'accepted') = '2',
    'the number names the site, so the channel is what names the measurement');

  perform pg_temp.check_that('a station number resolves to its station',
    (select bool_and(station_id = '_check_alpha') from meganet.reading
      where station_number = '999001'));

  perform pg_temp.check_that('the address is the number and the channel',
    (select array_agg(addr order by addr) = array['s:999001/level','s:999001/rain']
       from meganet.reading where station_number = '999001'));

  -- And it deduplicates exactly the way the radio path does.
  a := meganet.ingest(format($j$[{"station_number":"999001","channel":"rain",
        "reading_ts":"%s","value_raw":1.5,"source":"http"}]$j$,
        pg_temp.base('3 hours'))::jsonb);
  perform pg_temp.check_that('a non-radio reading deduplicates too',
    (a ->> 'duplicates') = '1');

  -- A value with no count behind it: the engineering value is what was
  -- transmitted, and so is the raw one.
  a := meganet.ingest(format($j$[{"station_number":"999002","channel":"batt",
        "reading_ts":"%s","value":13.4,"unit":"V","source":"http"}]$j$,
        pg_temp.base('3 hours'))::jsonb);
  perform pg_temp.check_that('a source with no counts may send only a value',
    (a ->> 'accepted') = '1'
      and (select value_raw = 13.4 from meganet.reading where station_number = '999002'));

  -- Epoch seconds and epoch milliseconds, which is what a device will actually
  -- send over MQTT.
  a := meganet.ingest(format($j$[
        {"station_number":"999003","channel":"a","reading_ts":%s,"value_raw":1,"source":"mqtt"},
        {"station_number":"999003","channel":"b","reading_ts":%s,"value_raw":2,"source":"mqtt"}]$j$,
        floor(extract(epoch from (select t from _base)))::bigint,
        floor(extract(epoch from (select t from _base)) * 1000)::bigint)::jsonb);
  perform pg_temp.check_that('epoch seconds and milliseconds both parse',
    (a ->> 'accepted') = '2'
      and (select count(distinct reading_ts) = 1 from meganet.reading
            where station_number = '999003'),
    a::text);
end
$$;

-- ── 6. Rollups populate, and match the raw data ──────────────────────────────

do $$
declare
  a jsonb;
  b jsonb;
begin
  -- A tidy hour: four readings with known min/max/sum, one duplicate, and one
  -- reading in the hour after it so the daily rollup has two hours to add up.
  perform meganet.ingest(format($j${"source":"mqtt","protocol":"alert2","readings":[
      {"alert_id":64200,"reading_ts":"%1$s","value_raw":10,"value":2.0,"unit":"mm"},
      {"alert_id":64200,"reading_ts":"%2$s","value_raw":11,"value":2.2,"unit":"mm"},
      {"alert_id":64200,"reading_ts":"%3$s","value_raw":14,"value":2.8,"unit":"mm"},
      {"alert_id":64200,"reading_ts":"%4$s","value_raw":12,"value":2.4,"unit":"mm"},
      {"alert_id":64200,"reading_ts":"%5$s","value_raw":20,"value":4.0,"unit":"mm"},
      {"alert_id":64200,"reading_ts":"%4$s","value_raw":12,"value":2.4,"unit":"mm"}
    ]}$j$,
    pg_temp.base(), pg_temp.base('15 minutes'), pg_temp.base('30 minutes'),
    pg_temp.base('45 minutes'), pg_temp.base('65 minutes'))::jsonb);

  a := meganet.roll_up('-infinity'::timestamptz);
  perform pg_temp.check_that('roll_up() populates the hourly table',
    (select count(*) = 2 from meganet.reading_hourly where alert_id = 64200), a::text);

  perform pg_temp.check_that('the hourly rollup matches the readings it came from',
    (select h.n = 4 and h.n_dup = 1 and h.raw_min = 10 and h.raw_max = 14
        and h.raw_sum = 47 and h.raw_last = 12 and h.raw_mean = 11.75
        and h.val_sum = 9.4 and h.val_last = 2.4 and h.unit = 'mm'
        and h.first_ts = (select t from _base)
        and h.last_ts  = (select t + interval '45 minutes' from _base)
       from meganet.reading_hourly h
      where h.addr = 'a:64200' and h.bucket = (select t from _base)));

  perform pg_temp.check_that('the daily rollup is the hours, re-aggregated exactly',
    (select sum(d.n) = 5 and min(d.raw_min) = 10 and max(d.raw_max) = 20
        and sum(d.raw_sum) = 67 and sum(d.val_sum) = 13.4
       from meganet.reading_daily d where d.addr = 'a:64200'),
    'sums re-aggregate; means do not, which is why sums are what is stored');

  -- Asked of the data rather than worked out by hand: this is the acceptance
  -- line, so it is worth checking every bucket rather than the one above.
  perform pg_temp.check_that('every hourly bucket agrees with the raw readings',
    not exists (
      select 1
        from meganet.reading_hourly h
        join (select addr, date_trunc('hour', reading_ts) as bucket,
                     count(*) as n, min(value_raw) as lo, max(value_raw) as hi,
                     sum(value_raw) as total, min(reading_ts) as t0, max(reading_ts) as t1
                from meganet.reading group by 1, 2) r
          on r.addr = h.addr and r.bucket = h.bucket
       where h.n <> r.n or h.raw_min <> r.lo or h.raw_max <> r.hi
          or h.raw_sum <> r.total or h.first_ts <> r.t0 or h.last_ts <> r.t1));

  perform pg_temp.check_that('every daily bucket agrees with its hours',
    not exists (
      select 1
        from meganet.reading_daily d
        join (select addr, (bucket at time zone 'UTC')::date as day,
                     sum(n) as n, min(raw_min) as lo, max(raw_max) as hi,
                     sum(raw_sum) as total
                from meganet.reading_hourly group by 1, 2) h
          on h.addr = d.addr and h.day = d.bucket
       where d.n <> h.n or d.raw_min <> h.lo or d.raw_max <> h.hi
          or d.raw_sum <> h.total));

  -- Running it again changes nothing, which is what makes it safe on a cron.
  b := meganet.roll_up('-infinity'::timestamptz);
  perform pg_temp.check_that('roll_up() is idempotent',
    (select h.n = 4 and h.raw_sum = 47 from meganet.reading_hourly h
      where h.addr = 'a:64200' and h.bucket = (select t from _base)),
    b::text);

  perform pg_temp.check_that('the unresolved readings are rolled up too',
    (select station_id is null and n = 1 from meganet.reading_hourly
      where addr = 'a:64002'),
    'an unresolved address is a reading like any other');
end
$$;

-- ── 7. Retention: the readings age out, the rollups stay ─────────────────────

do $$
declare
  a jsonb;
  n_hourly bigint;
  n_daily  bigint;
begin
  select count(*) into n_hourly from meganet.reading_hourly;
  select count(*) into n_daily  from meganet.reading_daily;

  -- Turn the window down to a day. Everything above is 26 hours old.
  insert into meganet.app_meta (key, value) values ('retain_reading_days', '1')
  on conflict (key) do update set value = excluded.value;

  a := meganet.retain();

  perform pg_temp.check_that('retain() ages out the old readings',
    (select count(*) = 0 from meganet.reading
      where reading_ts < now() - interval '1 day'), a::text);

  perform pg_temp.check_that('retain() rolled up before it deleted',
    (a -> 'rolled' -> 'hours') is not null,
    'a reading deleted before it is rolled up is gone from both places');

  perform pg_temp.check_that('it refused to re-roll buckets past the horizon',
    (a -> 'rolled' ->> 'skipped')::integer > 0,
    'recomputing a half-deleted bucket would overwrite a rollup that was right');

  perform pg_temp.check_that('retain() keeps the rollups',
    (select count(*) >= n_hourly from meganet.reading_hourly)
      and (select count(*) >= n_daily from meganet.reading_daily),
    'the whole point: the readings go, the history stays');

  perform pg_temp.check_that('the rollups are still right after the readings are gone',
    (select h.n = 4 and h.raw_sum = 47 and h.raw_last = 12
       from meganet.reading_hourly h
      where h.addr = 'a:64200' and h.bucket = (select t from _base))
      and (select sum(d.raw_sum) = 67 from meganet.reading_daily d
            where d.addr = 'a:64200'));

  perform pg_temp.check_that('retain() says whether there is more to do',
    (a ? 'more') and (a ->> 'more') = 'false', a::text);
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
