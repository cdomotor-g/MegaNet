-- check_reception_rollups.sql — Prove 0071, receptions rolled up by the hour
-- and the day (#241), against a real database.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_reception_rollups.sql
--
-- One row per claim, a non-zero exit if any fails, and a transaction that
-- rolls back — the token, the people, the receptions and every rollup row
-- included — so it is safe against the live database. Its receptions are heard
-- 30 days ago, an hour the live table has nothing in, so what it asserts about
-- its own rows is not muddied by real ones.

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

insert into meganet.editor_allow (entry, note) values ('rr-editor@example.test', 'check_reception_rollups — rolled back') on conflict (entry) do nothing;
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000ee601', 'rr-editor@example.test', now()),
  ('00000000-0000-4000-8000-0000000ee602', 'rr-stranger@example.test', now())
on conflict (id) do nothing;

select meganet.create_ingest_token('_check_rr pi') is not null as minted \gset

create temporary table _h on commit drop as
  select pg_catalog.date_trunc('hour', now() - interval '30 days') as h,
         (select id from meganet.ingest_token where label = '_check_rr pi') as tok;

-- Receptions, received ten minutes ago so the watermark takes them (0071,
-- decision 4). Hour H: three ALERT2 copies of station 33300 over 11056→10019
-- (one a duplicate), one over 10019 alone, a legacy ALERT 1234 and its shadow,
-- and an undecoded burst. Hour H+1: two more copies over 11056→10019.
insert into meganet.reception (ingest_token_id, point_id, receiver, heard_at, received_at, protocol, alert_id, ok, fault, level_dbfs, detail)
select t.tok, 'rr-sdr1', 'rtl-sdr', v.at, now() - interval '10 minutes', v.protocol, v.alert_id, v.ok, v.fault, v.level, v.detail
  from _h t,
       lateral (values
         (t.h + interval '1 minute',  'alert2', 501, true,  null::text, -30::real, '{"source":33300,"path":[11056,10019],"snr_db":10,"nf_dbfs":-60,"cfo_hz":100,"freq_mhz":151.5375}'::jsonb),
         (t.h + interval '2 minutes', 'alert2', 502, true,  null,       -31,       '{"source":33300,"path":[11056,10019],"snr_db":20,"nf_dbfs":-62,"cfo_hz":200,"freq_mhz":151.5375,"duplicate":true}'),
         (t.h + interval '3 minutes', 'alert2', 503, true,  null,       -32,       '{"source":33300,"path":[11056,10019],"snr_db":30,"nf_dbfs":-64,"cfo_hz":300,"freq_mhz":151.5375,"duplicate":false}'),
         (t.h + interval '4 minutes', 'alert2', 504, true,  null,       -33,       '{"source":33300,"path":[10019],"snr_db":15,"nf_dbfs":-61}'),
         (t.h + interval '5 minutes', 'alert',  1234, true,  null,      -40,       '{"snr_db":5,"nf_dbfs":-70}'),
         (t.h + interval '5 minutes' + interval '200 ms', 'alert', 1234, false, 'shadow', -41, '{}'),
         (t.h + interval '6 minutes', 'alert',  null, false, 'undecoded', -50,     '{"nf_dbfs":-69}'),
         (t.h + interval '61 minutes', 'alert2', 505, true, null,       -34,       '{"source":33300,"path":[11056,10019],"snr_db":40,"nf_dbfs":-63}'),
         (t.h + interval '62 minutes', 'alert2', 506, true, null,       -35,       '{"source":33300,"path":[11056,10019],"snr_db":50,"nf_dbfs":-65}')
       ) as v(at, protocol, alert_id, ok, fault, level, detail);

select meganet.roll_up_receptions(100000) as first_run \gset

do $$
declare
  t record;
  r record;
  v_raw integer;
  v_rolled integer;
begin
  select * into t from _h;

  select * into r from meganet.reception_hourly
   where bucket = t.h and ingest_token_id = t.tok and station = 33300 and path = array[11056, 10019];
  perform pg_temp.check_that('an hour, a station, a path: three copies, one a duplicate',
    r.n = 3 and r.n_ok = 3 and r.n_bad = 0 and r.n_dup = 1 and r.protocol = 'alert2', pg_catalog.row_to_json(r)::text);
  perform pg_temp.check_that('SNR, noise floor and carrier offset kept as min, max, sum and count',
    r.snr_n = 3 and r.snr_min = 10 and r.snr_max = 30 and r.snr_sum = 60
      and r.nf_dbfs_n = 3 and r.nf_dbfs_min = -64 and r.nf_dbfs_max = -60 and r.nf_dbfs_sum = -186
      and r.cfo_n = 3 and r.cfo_sum = 600 and r.level_n = 3 and r.level_sum = -93
      and r.freq_min = 151.5375::real and r.freq_max = 151.5375::real, pg_catalog.row_to_json(r)::text);
  perform pg_temp.check_that('the first and last copy heard',
    r.first_heard = t.h + interval '1 minute' and r.last_heard = t.h + interval '3 minutes');

  perform pg_temp.check_that('another path is another row',
    (select n from meganet.reception_hourly where bucket = t.h and ingest_token_id = t.tok and path = array[10019]) = 1);

  select * into r from meganet.reception_hourly
   where bucket = t.h and ingest_token_id = t.tok and protocol = 'alert' and station = 1234;
  perform pg_temp.check_that('legacy ALERT keyed by its alert_id, its shadow counted as a fault',
    r.n = 2 and r.n_ok = 1 and r.n_bad = 1 and r.n_shadow = 1 and r.path is null and r.snr_n = 1, pg_catalog.row_to_json(r)::text);

  select * into r from meganet.reception_hourly
   where bucket = t.h and ingest_token_id = t.tok and protocol = 'alert' and station is null;
  perform pg_temp.check_that('an undecoded burst is kept under no station',
    r.n = 1 and r.n_undecoded = 1 and r.n_bad = 1 and r.nf_dbfs_n = 1, pg_catalog.row_to_json(r)::text);

  select pg_catalog.count(*) into v_raw from meganet.reception
   where ingest_token_id = t.tok;
  select pg_catalog.sum(n) into v_rolled from meganet.reception_hourly
   where ingest_token_id = t.tok;
  perform pg_temp.check_that('every reception is in exactly one hour', v_raw = v_rolled and v_raw = 9,
    pg_catalog.format('raw %s, rolled %s', v_raw, v_rolled));

  select * into r from meganet.reception_daily
   where bucket = (t.h at time zone 'UTC')::date and ingest_token_id = t.tok and station = 33300 and path = array[11056, 10019];
  perform pg_temp.check_that('the day is its hours summed — across the two hours, or the one if H+1 is the next UTC day',
    r.n = (select pg_catalog.sum(h.n) from meganet.reception_hourly h
            where h.ingest_token_id = t.tok and h.station = 33300 and h.path = array[11056, 10019]
              and (h.bucket at time zone 'UTC')::date = (t.h at time zone 'UTC')::date)
      and r.snr_sum = (select pg_catalog.sum(h.snr_sum) from meganet.reception_hourly h
            where h.ingest_token_id = t.tok and h.station = 33300 and h.path = array[11056, 10019]
              and (h.bucket at time zone 'UTC')::date = (t.h at time zone 'UTC')::date),
    pg_catalog.row_to_json(r)::text);
  perform pg_temp.check_that('the days hold every reception the hours do',
    (select pg_catalog.sum(n) from meganet.reception_daily where ingest_token_id = t.tok) = v_rolled);
end
$$;

-- Idempotent: a second run changes nothing.
create temporary table _before on commit drop as
  select bucket, point_id, station, path, n, snr_sum, nf_dbfs_sum from meganet.reception_hourly
   where ingest_token_id = (select tok from _h);
select meganet.roll_up_receptions(100000) as second_run \gset

do $$
begin
  perform pg_temp.check_that('a second run changes nothing',
    not exists (
      (select bucket, point_id, station, path, n, snr_sum, nf_dbfs_sum from meganet.reception_hourly
        where ingest_token_id = (select tok from _h))
      except
      (select * from _before))
    and (select pg_catalog.count(*) from _before)
        = (select pg_catalog.count(*) from meganet.reception_hourly where ingest_token_id = (select tok from _h)));
  perform pg_temp.check_that('nothing is left in the queue but the current and previous hours',
    (select pg_catalog.count(*) from meganet.reception_rollup_dirty
      where bucket < pg_catalog.date_trunc('hour', now()) - interval '1 hour') = 0);
end
$$;

-- A copy that arrives late, into an hour already rolled up, rebuilds it.
insert into meganet.reception (ingest_token_id, point_id, receiver, heard_at, received_at, protocol, alert_id, ok, detail)
select tok, 'rr-sdr1', 'rtl-sdr', h + interval '7 minutes', now() - interval '5 minutes', 'alert2', 507, true,
       '{"source":33300,"path":[11056,10019],"snr_db":25}'::jsonb
  from _h;
-- One received under two minutes ago, into an hour nothing else touched this
-- run, waits for the watermark to take it (decision 4). (Into an hour that is
-- being rebuilt anyway it would be counted at once: a rebuild reads every row
-- heard in the hour.)
insert into meganet.reception (ingest_token_id, point_id, receiver, heard_at, received_at, protocol, alert_id, ok, detail)
select tok, 'rr-sdr1', 'rtl-sdr', h + interval '68 minutes', now(), 'alert2', 508, true,
       '{"source":33300,"path":[11056,10019],"snr_db":26}'::jsonb
  from _h;
select meganet.roll_up_receptions(100000) as third_run \gset

do $$
declare t record;
begin
  select * into t from _h;
  perform pg_temp.check_that('a late copy rebuilds its hour',
    (select n from meganet.reception_hourly
      where bucket = t.h and ingest_token_id = t.tok and station = 33300 and path = array[11056, 10019]) = 4);
  perform pg_temp.check_that('one received just now, in an hour nothing else touched, waits',
    (select n from meganet.reception_hourly
      where bucket = t.h + interval '1 hour' and ingest_token_id = t.tok and station = 33300 and path = array[11056, 10019]) = 2);
end
$$;

update meganet.reception set received_at = now() - interval '3 minutes'
 where ingest_token_id = (select tok from _h) and alert_id = 508;
select meganet.roll_up_receptions(100000) as fourth_run \gset

do $$
declare t record;
begin
  select * into t from _h;
  perform pg_temp.check_that('… and is taken once it is two minutes old',
    (select n from meganet.reception_hourly
      where bucket = t.h + interval '1 hour' and ingest_token_id = t.tok and station = 33300 and path = array[11056, 10019]) = 3);
end
$$;

-- Past the horizon: not rebuilt, and said so.
insert into meganet.reception (ingest_token_id, point_id, receiver, heard_at, received_at, protocol, alert_id, ok, detail)
select tok, 'rr-sdr1', 'rtl-sdr', now() - interval '100 days', now() - interval '5 minutes', 'alert2', 509, true,
       '{"source":33300,"snr_db":1}'::jsonb
  from _h;
create temporary table _fifth on commit drop as select meganet.roll_up_receptions(100000) as r;

do $$
declare v jsonb := (select r from _fifth);
begin
  perform pg_temp.check_that('an hour past retain_reception_days is skipped, not rebuilt',
    (v ->> 'skipped')::int >= 1
      and not exists (select 1 from meganet.reception_hourly
                       where ingest_token_id = (select tok from _h)
                         and bucket = pg_catalog.date_trunc('hour', now() - interval '100 days')),
    v::text);
  perform pg_temp.check_that('the horizon is 90 days unless app_meta says otherwise',
    (select value from meganet.app_meta where key = 'retain_reception_days') = '90');
end
$$;

-- Who may read and run it.
do $$
declare
  c_editor   text := '{"role":"authenticated","email":"rr-editor@example.test","sub":"00000000-0000-4000-8000-0000000ee601"}';
  c_stranger text := '{"role":"authenticated","email":"rr-stranger@example.test","sub":"00000000-0000-4000-8000-0000000ee602"}';
  v text;
begin
  perform pg_temp.check_that('anon can neither read the rollups nor run the job',
    not has_table_privilege('anon', 'meganet.reception_hourly', 'select')
      and not has_table_privilege('anon', 'meganet.reception_daily', 'select')
      and not has_function_privilege('anon', 'meganet.roll_up_receptions(integer)', 'execute'));
  perform pg_temp.check_that('the queue is the service key''s alone',
    not has_table_privilege('authenticated', 'meganet.reception_rollup_dirty', 'select')
      and (select relrowsecurity from pg_class where oid = 'meganet.reception_rollup_dirty'::regclass));

  v := pg_temp.as_role('authenticated', c_editor,
    $q$select count(*)::text from meganet.reception_hourly where point_id = 'rr-sdr1'$q$);
  perform pg_temp.check_that('an editor reads the hours', v not like 'ERROR %' and v::int >= 4, v);
  v := pg_temp.as_role('authenticated', c_stranger,
    $q$select count(*)::text from meganet.reception_daily where point_id = 'rr-sdr1'$q$);
  perform pg_temp.check_that('a signed-in account that is not an editor reads none', v = '0', v);
  v := pg_temp.as_role('authenticated', c_stranger, $q$select meganet.roll_up_receptions(1)::text$q$);
  perform pg_temp.check_that('and may not run the job', v = 'ERROR 42501', v);
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
