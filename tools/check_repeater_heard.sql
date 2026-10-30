-- check_repeater_heard.sql — Prove 0092: what each repeater is heard relaying,
-- and its turnaround from a station's burst to its copy, kept by the carrier
-- roll-up and summed a row a repeater — against a real database.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_repeater_heard.sql
--
-- One row per claim, a non-zero exit if any fails, and a transaction that
-- rolls back, so it is safe against the live database.
--
-- Two made-up base stations hear a made-up repeater for nine days:
--
--   chk_r1, passing 64150–64170, heard at A on its own sensor (64190) on its
--   carrier (+250 Hz), and relaying:
--     64151–64154  heard direct first, on their own carriers, and then its
--                  copy 1.25 s later on its carrier: relayed, four gaps a
--                  station a day, every one 1,250 ms;
--     64155–64158  heard only through it: relayed, and no gap (nothing direct
--                  to measure from);
--     64165        in its range, heard direct at A and never on its carrier:
--                  elsewhere;
--     64180        not in its range, heard direct and then copied on its
--                  carrier: off record, its copies counted;
--     64160        in its range, heard direct at A and also on its carrier:
--                  relayed — so never elsewhere, whatever else A heard.
--   B hears only 64151 direct: B never found the repeater, so what B heard
--   says nothing about it.
-- And a relay_daily row 120 days old, which the summary's refresh drops.

\set ON_ERROR_STOP on

begin;

create temporary table _check (ord serial, name text, ok boolean, note text) on commit drop;
create or replace function pg_temp.check_that(p_name text, p_ok boolean, p_note text default '')
returns void language sql as $$ insert into _check (name, ok, note) values (p_name, coalesce(p_ok, false), p_note); $$;
create or replace function pg_temp.as_role(p_role text, p_sql text)
returns text language plpgsql as $$
declare v text;
begin
  begin
    execute pg_catalog.format('set local role %I', p_role);
    execute p_sql into v;
    raise exception using errcode = 'MNRLS', message = coalesce(v, '<null>');
  exception
    when sqlstate 'MNRLS' then return sqlerrm;
    when others then return 'ERROR ' || sqlstate;
  end;
end;
$$;

select meganet.create_ingest_token('_check_heard a') is not null as minted_a \gset
select meganet.create_ingest_token('_check_heard b') is not null as minted_b \gset
create temporary table _tok on commit drop as
  select (select id from meganet.ingest_token where label = '_check_heard a') as a,
         (select id from meganet.ingest_token where label = '_check_heard b') as b;

create temporary table _days on commit drop as
  select g as age, ((now() at time zone 'UTC')::date - g) as d from generate_series(0, 8) g;

-- The register.
insert into meganet.station (id, ord, name, roles)
select 'chk_' || s, 920000 + row_number() over (), 'Check ' || s, case when s = 'r1' then array['repeater'] else array['field'] end
  from unnest(array['r1', 's64151', 's64152', 's64153', 's64154', 's64155', 's64156', 's64157', 's64158',
                    's64160', 's64165', 's64180']) s;
insert into meganet.sensor (station_id, sensor_id, type, ord, alert_id)
select st.id, 's1', 'Rainfall', 0, case when st.id = 'chk_r1' then 64190 else substr(st.id, 6)::integer end
  from meganet.station st where st.id = 'chk_r1' or st.id like 'chk\_s641%';
insert into meganet.repeater (station_id) values ('chk_r1');
insert into meganet.pass_range (repeater_id, kind, lo, hi, ord) values ('chk_r1', 'pass', 64150, 64170, 0);

-- What is heard: (receiver, address, carrier Hz, a copy of a direct burst?,
-- seconds after the hour-slot's start). A copy is 1.25 s after its direct burst.
create temporary table _leg (rx text, a integer, hz double precision, dup boolean, off_s double precision) on commit drop;
insert into _leg values
  ('a', 64190, 250, false, 0),                                                      -- the repeater's own sensor
  ('a', 64151, -400, false, 0), ('a', 64151, 250, true, 1.25),
  ('a', 64152, -340, false, 0), ('a', 64152, 250, true, 1.25),
  ('a', 64153, -280, false, 0), ('a', 64153, 250, true, 1.25),
  ('a', 64154, -220, false, 0), ('a', 64154, 250, true, 1.25),
  ('a', 64155, 250, false, 0), ('a', 64156, 250, false, 0), ('a', 64157, 250, false, 0), ('a', 64158, 250, false, 0),
  ('a', 64160, -40, false, 0), ('a', 64160, 250, true, 1.25),
  ('a', 64165, 120, false, 0),                                                      -- in range, never on its carrier
  ('a', 64180, 160, false, 0), ('a', 64180, 250, true, 1.25),                       -- off record
  ('b', 64151, -400, false, 0);

insert into meganet.reception (ingest_token_id, point_id, receiver, heard_at, protocol, alert_id, value_raw, ok, detail)
select case l.rx when 'a' then t.a else t.b end, 'check-heard-' || l.rx, 'rtl-sdr',
       (dd.d::text || ' 00:00:00+00')::timestamptz + make_interval(hours => 1 + 5 * k, mins => (l.a % 50), secs => l.off_s),
       'alert', l.a, 10 + k, true,
       jsonb_build_object('freq_mhz', 151.5, 'cfo_hz', round(l.hz + 3 * sin(dd.age + k + l.a))::integer, 'snr_db', 20)
         || case when l.dup then '{"duplicate": true, "copy": 1}'::jsonb else '{}'::jsonb end
  from _leg l, _days dd, _tok t, generate_series(0, 3) k;

-- A row from long ago, which the refresh drops.
insert into meganet.relay_daily (day, station_id, alert_id, kind, n)
values ((now() at time zone 'UTC')::date - 120, 'chk_r1', 64151, 'relayed', 3);

create temporary table _rolled on commit drop as
  select meganet.roll_up_carriers((now() at time zone 'UTC')::date - 8, (now() at time zone 'UTC')::date) as r;
create temporary table _rd on commit drop as select * from meganet.relay_daily where station_id = 'chk_r1';
create temporary table _rs on commit drop as select * from meganet.relay_summary where station_id = 'chk_r1';

do $$
declare
  s record;
  n1 integer;
  n2 integer;
begin
  select * into s from _rs;

  -- ── A day at a time ────────────────────────────────────────────────────────
  perform pg_temp.check_that('each day keeps the addresses the repeater relayed, on its carrier, from its range',
    (select bool_and(n = 4) and count(*) = 9 * 9
       from _rd where kind = 'relayed' and alert_id in (64151, 64152, 64153, 64154, 64155, 64156, 64157, 64158, 64160)),
    (select string_agg(distinct alert_id::text, ',') from _rd where kind = 'relayed'));
  perform pg_temp.check_that('…its own sensor is never one it relayed, nor an address outside its range',
    not exists (select 1 from _rd where kind = 'relayed' and alert_id in (64190, 64180, 64165)));
  perform pg_temp.check_that('…the relayed copies of stations heard direct are counted as copies',
    (select bool_and(n_dup = 4) from _rd where kind = 'relayed' and alert_id = 64151)
      and (select bool_and(n_dup = 0) from _rd where kind = 'relayed' and alert_id = 64155));
  perform pg_temp.check_that('an address it does not pass, copied on its carrier, is off record, with its copies and every burst of it',
    (select bool_and(n = 4 and n_dup = 4 and n_all = 8) and count(*) = 9 from _rd where kind = 'off_record' and alert_id = 64180),
    (select string_agg(format('%s n=%s dup=%s all=%s', day, n, n_dup, n_all), '; ') from _rd where kind = 'off_record'));
  perform pg_temp.check_that('…and nothing else is off record',
    not exists (select 1 from _rd where kind = 'off_record' and alert_id <> 64180));
  perform pg_temp.check_that('an address in its range heard where it was found, but never on its carrier, is elsewhere',
    (select count(*) = 9 from _rd where kind = 'elsewhere' and alert_id = 64165));
  perform pg_temp.check_that('…a station heard at B, which never found the repeater, says nothing about it',
    (select bool_and(receivers = 1) from _rd where alert_id = 64151));
  perform pg_temp.check_that('the gap from a station''s burst to the repeater''s copy is kept: 1,250 ms, four stations four times a day',
    (select bool_and(g.n = 20 and abs(g.gaps_ms[1] - 1250) < 2 and abs(g.gaps_ms[g.n] - 1250) < 2) and count(*) = 9
       from meganet.relay_gap_daily g where g.station_id = 'chk_r1'),
    (select string_agg(format('%s n=%s %s–%s', day, n, gaps_ms[1], gaps_ms[n]), '; ')
       from meganet.relay_gap_daily where station_id = 'chk_r1'));
  perform pg_temp.check_that('…the copies of off-record 64180 and of 64160 are gaps too: it relayed them, on record or not, so they time it',
    (select n from meganet.relay_gap_daily where station_id = 'chk_r1' limit 1) = 20);

  -- ── Rolled again, the same ─────────────────────────────────────────────────
  select count(*) into n1 from meganet.relay_daily where station_id = 'chk_r1';
  perform meganet.roll_up_carriers_day((now() at time zone 'UTC')::date - 3);
  select count(*) into n2 from meganet.relay_daily where station_id = 'chk_r1';
  perform pg_temp.check_that('a day rolled up again keeps the same rows, not two of each', n1 = n2, format('%s then %s', n1, n2));

  -- ── The week, a row ────────────────────────────────────────────────────────
  perform pg_temp.check_that('the summary is the last seven days: found on all seven, from the first to today',
    s.days = 7 and s.window_days = 7 and s.first_day = (now() at time zone 'UTC')::date - 6
      and s.last_day = (now() at time zone 'UTC')::date and s.window_from = s.first_day,
    format('days=%s window=%s first=%s last=%s', s.days, s.window_days, s.first_day, s.last_day));
  perform pg_temp.check_that('…the addresses it relayed, each with its bursts',
    s.relayed = array[64151, 64152, 64153, 64154, 64155, 64156, 64157, 64158, 64160]
      and s.relayed_n = array_fill(28, array[9]) and s.bursts = 9 * 28,
    format('%s %s %s', s.relayed, s.relayed_n, s.bursts));
  perform pg_temp.check_that('…off record with its copies, own-looking bursts and every burst',
    s.off_record = array[64180] and s.off_dup = array[28] and s.off_own = array[0] and s.off_all = array[56],
    format('%s %s %s %s', s.off_record, s.off_dup, s.off_own, s.off_all));
  perform pg_temp.check_that('…elsewhere only what was never relayed',
    s.elsewhere = array[64165], format('%s', s.elsewhere));
  perform pg_temp.check_that('…and its turnaround, measured: 1,250 ms over 140 gaps on seven days',
    abs(s.gap_ms - 1250) < 2 and abs(s.gap_lo_ms - 1250) < 2 and abs(s.gap_hi_ms - 1250) < 2 and s.gap_n = 140 and s.gap_days = 7,
    format('%s (%s–%s) n=%s days=%s', s.gap_ms, s.gap_lo_ms, s.gap_hi_ms, s.gap_n, s.gap_days));
  perform pg_temp.check_that('the run says it rebuilt the summary',
    (select (r ->> 'relay_summary')::integer >= 1 from _rolled));
  perform pg_temp.check_that('a day more than 90 days old is dropped',
    not exists (select 1 from meganet.relay_daily where station_id = 'chk_r1' and day < (now() at time zone 'UTC')::date - 90));

  -- ── Who may read it ────────────────────────────────────────────────────────
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    perform pg_temp.check_that('anybody reads the summary — it names no receiver',
      pg_temp.as_role('anon', 'select count(*)::text from meganet.relay_summary where station_id = ''chk_r1''') = '1');
    perform pg_temp.check_that('…but not the days under it, nor writes it',
      pg_temp.as_role('anon', 'select count(*)::text from meganet.relay_daily') like 'ERROR%'
        and pg_temp.as_role('authenticated', 'select count(*)::text from meganet.relay_gap_daily') like 'ERROR%'
        and pg_temp.as_role('anon', 'with d as (delete from meganet.relay_summary returning 1) select count(*)::text from d') like 'ERROR%');
    perform pg_temp.check_that('nobody but the owner and the service key rebuilds it',
      not has_function_privilege('anon', 'meganet.refresh_relay_summary(integer)', 'execute')
        and not has_function_privilege('authenticated', 'meganet.refresh_relay_summary(integer)', 'execute'));
  end if;
end
$$;

select lpad(ord::text, 2) as "#", case when ok then 'ok  ' else 'FAIL' end as result, name,
       case when ok then '' else left(coalesce(note, ''), 400) end as detail
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
