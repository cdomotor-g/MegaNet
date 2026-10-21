-- check_transmitter_drift.sql — Prove 0075, transmitter drift as a health
-- finding (#217), against a real database.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_transmitter_drift.sql
--
-- One row per claim, a non-zero exit if any fails, and a transaction that
-- rolls back, so it is safe against the live database. A made-up receiver
-- hears six made-up transmitters (addresses 99001–99006) for thirty days:
-- four steady, one drifting in the last week, one far off channel — and the
-- receiver's own crystal wanders by up to 90 Hz a day, which must not show
-- in any of them.

\set ON_ERROR_STOP on

begin;

create temporary table _check (ord serial, name text, ok boolean, note text) on commit drop;
create or replace function pg_temp.check_that(p_name text, p_ok boolean, p_note text default '')
returns void language sql as $$ insert into _check (name, ok, note) values (p_name, coalesce(p_ok, false), p_note); $$;
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

-- The transmitters' true offsets (Hz), and the receiver's error each day.
create temporary table _tx (a integer primary key, hz double precision, drift double precision) on commit drop;
insert into _tx values
  (99001,    0, 0), (99002,   60, 0), (99003,  -40, 0), (99004,  20, 0),
  (99005,   30, 450),     -- moves +450 Hz (3 ppm) over the last week
  (99006, -600, 0);       -- 4 ppm below the rest, steady

insert into meganet.reception_daily (bucket, ingest_token_id, point_id, protocol, station, path, survey,
  n, n_ok, n_bad, n_dup, n_rejected, n_undecoded, n_shadow, n_status, n_frame, n_crc,
  snr_n, nf_dbfs_n, nf_dbm_n, rssi_n, level_n,
  cfo_n, cfo_min, cfo_max, cfo_sum, freq_min, freq_max, first_heard, last_heard)
select dd.day, -217, 'check-drift-sdr', 'alert2', t.a, '{}'::integer[], null,
       100, 100, 0, 0, 0, 0, 0, 0, 0, 0,
       0, 0, 0, 0, 0,
       100, 0, 0,
       100 * (250 + t.hz + case when dd.age < 7 then t.drift else 0 end + 90 * sin(dd.age)),
       150.0, 150.0, now(), now()
  from _tx t,
       lateral (select ((now() at time zone 'UTC')::date - g) as day, g as age from generate_series(0, 29) g) dd
 where not (t.a = 99002 and dd.age % 3 = 0);   -- one is not heard every day

-- And one copy over a repeater: measured on the repeater's carrier (99004's).
insert into meganet.reception_daily (bucket, ingest_token_id, point_id, protocol, station, path, survey,
  n, n_ok, n_bad, n_dup, n_rejected, n_undecoded, n_shadow, n_status, n_frame, n_crc,
  snr_n, nf_dbfs_n, nf_dbm_n, rssi_n, level_n,
  cfo_n, cfo_sum, freq_min, freq_max, first_heard, last_heard)
select (now() at time zone 'UTC')::date - 1, -217, 'check-drift-sdr', 'alert2', 99999, array[99004], null,
       50, 50, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
       50, 50 * (250 + 20 + 90 * sin(1)), 150.0, 150.0, now(), now();

create temporary table _off on commit drop as
  select * from meganet.transmitter_offsets(37) where addr between 99001 and 99999;

do $$
declare
  v_spread double precision;
  v_n integer;
begin
  -- The steady four: the receiver's 180 Hz swing must not show.
  select pg_catalog.max(o.offset_hz) - pg_catalog.min(o.offset_hz) into v_spread
    from _off o where o.addr = 99001;
  perform pg_temp.check_that('a steady transmitter stays steady while the receiver''s crystal wanders 180 Hz',
    v_spread < 5, format('spread %s Hz', round(v_spread::numeric, 1)));
  perform pg_temp.check_that('… including one not heard every day',
    (select pg_catalog.max(offset_hz) - pg_catalog.min(offset_hz) from _off where addr = 99002) < 5);
  perform pg_temp.check_that('each is measured against the fleet: their differences are the true ones',
    pg_catalog.abs((select pg_catalog.avg(offset_hz) from _off where addr = 99002)
                 - (select pg_catalog.avg(offset_hz) from _off where addr = 99001) - 60) < 3
      and pg_catalog.abs((select pg_catalog.avg(offset_hz) from _off where addr = 99006)
                       - (select pg_catalog.avg(offset_hz) from _off where addr = 99001) + 600) < 3);
  perform pg_temp.check_that('… and in ppm of the frequency',
    pg_catalog.abs((select pg_catalog.avg(offset_ppm) from _off where addr = 99006)
                 - (select pg_catalog.avg(offset_hz) from _off where addr = 99006) / 150) < 0.01);
  perform pg_temp.check_that('a relayed copy counts for the repeater that sent it last, not its source',
    exists (select 1 from _off where addr = 99004 and day = (now() at time zone 'UTC')::date - 1 and bursts = 150)
      and not exists (select 1 from _off where addr = 99999));
  select pg_catalog.count(distinct day) into v_n from _off where addr = 99005;
  perform pg_temp.check_that('the drifting one shows its move in the last week',
    (select pg_catalog.avg(offset_hz) from _off where addr = 99005 and day > (now() at time zone 'UTC')::date - 7)
      - (select pg_catalog.avg(offset_hz) from _off where addr = 99005 and day <= (now() at time zone 'UTC')::date - 7) between 400 and 500,
    format('%s days', v_n));
end
$$;

create temporary table _run on commit drop as select meganet.refresh_transmitter_findings() as r;

do $$
declare
  f record;
begin
  select * into f from meganet.health_finding
   where source = 'transmitters' and kind = 'transmitter-drift' and subject = 'a2:99005' and cleared_at is null;
  perform pg_temp.check_that('a transmitter that moved 3 ppm in a week is a critical drift finding',
    f.id is not null and f.severity = 'critical' and f.title like 'ALERT2 99005%drifted +3.0 ppm in a week',
    coalesce(f.title, '<none>'));
  select * into f from meganet.health_finding
   where source = 'transmitters' and kind = 'transmitter-off-channel' and subject = 'a2:99006' and cleared_at is null;
  perform pg_temp.check_that('one 4 ppm off the rest is an off-channel warning, with its numbers',
    f.id is not null and f.severity = 'warn' and (f.evidence ->> 'offset_ppm')::numeric between -4.2 and -3.8
      and f.ingest_token_id is null, coalesce(f.title, '<none>'));
  perform pg_temp.check_that('the steady ones are not findings',
    not exists (select 1 from meganet.health_finding where source = 'transmitters' and cleared_at is null
                 and subject in ('a2:99001', 'a2:99002', 'a2:99003', 'a2:99004')));
  perform pg_temp.check_that('the run is recorded, and says what it opened',
    exists (select 1 from meganet.health_refresh where source = 'transmitters')
      and jsonb_array_length((select r from _run) -> 'opened') >= 2, left((select r from _run)::text, 300));
end
$$;

-- A finding clears when it stops holding.
update meganet.reception_daily set cfo_sum = 100 * (250 + 30 + 90 * sin(((now() at time zone 'UTC')::date - bucket)))
 where point_id = 'check-drift-sdr' and station = 99005;
create temporary table _run2 on commit drop as select meganet.refresh_transmitter_findings() as r;

do $$
begin
  perform pg_temp.check_that('back where it was, the drift finding clears; the off-channel one stays',
    exists (select 1 from meganet.health_finding where source = 'transmitters' and subject = 'a2:99005' and cleared_at is not null)
      and exists (select 1 from meganet.health_finding where source = 'transmitters' and subject = 'a2:99006' and cleared_at is null));
  perform pg_temp.check_that('the thresholds are app_meta rows',
    (select count(*) from meganet.app_meta where key in ('tx_offset_warn_ppm', 'tx_offset_crit_ppm', 'tx_drift_warn_ppm', 'tx_drift_crit_ppm')) = 4);
  perform pg_temp.check_that('the other health sources are untouched by this run',
    pg_catalog.strpos(pg_catalog.pg_get_constraintdef((select oid from pg_constraint where conname = 'health_finding_kind')), 'receiver-deaf') > 0);
end
$$;

-- Who may.
do $$
declare v text;
begin
  v := pg_temp.as_role('anon', '{"role":"anon"}',
    $q$select count(*)::text from meganet.transmitter_offsets(37) where addr between 99001 and 99006$q$);
  perform pg_temp.check_that('anyone may read the offsets (no receiver is named)', v not like 'ERROR %' and v::int > 0, v);
  v := pg_temp.as_role('anon', '{"role":"anon"}',
    $q$select count(*)::text from meganet.health_finding where source = 'transmitters' and subject = 'a2:99006'$q$);
  perform pg_temp.check_that('… and the findings, like station findings', v = '1', v);
  perform pg_temp.check_that('nobody but the owner and the service key runs the refresh',
    not has_function_privilege('anon', 'meganet.refresh_transmitter_findings(timestamptz)', 'execute')
      and not has_function_privilege('authenticated', 'meganet.refresh_transmitter_findings(timestamptz)', 'execute'));
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
