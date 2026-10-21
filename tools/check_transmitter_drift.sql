-- check_transmitter_drift.sql — Prove 0075 and 0077, transmitter drift as a
-- health finding (#217), against a real database.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_transmitter_drift.sql
--
-- One row per claim, a non-zero exit if any fails, and a transaction that
-- rolls back, so it is safe against the live database.
--
-- A made-up base station hears, for thirty days, a made-up network — and its
-- own crystal wanders by up to 90 Hz a day, which must not show anywhere:
--
--   ALERT2: six transmitters (99001–99006): four steady, one drifting +450 Hz
--   in the last week, one 600 Hz below the rest; one copy relayed by 99004.
--
--   Legacy ALERT (addresses 64101–64399, stations chk_…):
--     * chk_r1, a repeater (own sensor 64190, carrier +250) passing 64100–64120:
--       64103 and 64104 are heard only through it; 64101 is heard direct and
--       its copy relayed; 64105 is heard direct (and drifts +450 Hz in the last
--       week) and its copy relayed.
--     * chk_r2, a repeater not heard on its own sensors (carrier −300) passing
--       64200–64220: 64201–64205 heard only through it, 64206–64208 direct.
--     * chk_r3, a repeater not heard at all, passing 64300–64320: its
--       stations heard direct, two of them by chance near one carrier.
--     * 64102, 64106 (−600 Hz: off channel), 64107, 64108 heard direct.
--     * 64150 direct at +255 — on chk_r1's carrier, but not its to pass.
--     * 64160 heard at two carriers a day (a repeater not on the register).
--     * a copy of 64160 no repeater explains, and a burst split in two.

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

-- A receiver of our own.
insert into meganet.editor_allow (entry, note) values ('drift-editor@example.test', 'check_transmitter_drift — rolled back') on conflict (entry) do nothing;
select meganet.create_ingest_token('_check_drift pi') is not null as minted \gset
create temporary table _tok on commit drop as select id from meganet.ingest_token where label = '_check_drift pi';

-- The receiver's own error each day (Hz), and the days.
create temporary table _days on commit drop as
  select g as age, ((now() at time zone 'UTC')::date - g) as d, 90 * sin(g) as rxe from generate_series(0, 29) g;

-- The register: stations, their sensors, three repeaters and what they pass.
insert into meganet.station (id, ord, name, roles)
select 'chk_' || s, 900000 + row_number() over (), 'Check ' || s, case when s like 'r%' then array['repeater'] else array['field'] end
  from unnest(array['r1', 'r2', 'r3', 'l64101', 'l64102', 'l64103', 'l64104', 'l64105', 'l64106', 'l64107', 'l64108',
                    'l64150', 'l64160', 'l64201', 'l64202', 'l64203', 'l64204', 'l64205', 'l64206', 'l64207', 'l64208',
                    'l64301', 'l64302', 'l64303', 'l64304', 'l64305', 'l64306',
                    'r4', 'l64401', 'l64402', 'l64403', 'l64404', 'l64405', 'l64170', 'l64180']) s;
insert into meganet.sensor (station_id, sensor_id, type, ord, alert_id)
select st.id, 's1', 'Rainfall', 0, case when st.id = 'chk_r1' then 64190 when st.id = 'chk_r2' then 64290 when st.id = 'chk_r3' then 64390
                                       when st.id = 'chk_r4' then 64115
                                       else substr(st.id, 6)::integer end
  from meganet.station st where st.id like 'chk\_%';
insert into meganet.repeater (station_id) values ('chk_r1'), ('chk_r2'), ('chk_r3'), ('chk_r4');
insert into meganet.pass_range (repeater_id, kind, lo, hi, ord) values
  ('chk_r1', 'pass', 64100, 64120, 0), ('chk_r1', 'pass', 64400, 64420, 1),
  ('chk_r2', 'pass', 64200, 64220, 0), ('chk_r2', 'exclusion', 64205, 64205, 1),
  ('chk_r3', 'pass', 64300, 64320, 0),
  ('chk_r4', 'pass', 64400, 64420, 0);

-- Legacy bursts: (address, the carrier it is heard on — before the receiver's
-- error — as a function of the day's age, and whether it is a copy).
create temporary table _leg (a integer, hz_recent double precision, hz double precision, dup boolean, per_day integer) on commit drop;
insert into _leg values
  (64190, 250, 250, false, 4),                         -- chk_r1 on its own sensor
  (64101,   0,   0, false, 4), (64101, 250, 250, true, 4),   -- direct, and relayed by chk_r1
  (64103, 250, 250, false, 4), (64104, 250, 250, false, 4),  -- only through chk_r1
  (64105, 480,  30, false, 4), (64105, 250, 250, true, 4),   -- drifting; relayed too
  (64102,  60,  60, false, 4), (64106, -600, -600, false, 4), (64107, -40, -40, false, 4), (64108, 20, 20, false, 4),
  (64150, 255, 255, false, 4),                         -- on chk_r1's carrier, not in its range
  (64201, -300, -300, false, 4), (64202, -300, -300, false, 4), (64203, -300, -300, false, 4),
  (64204, -300, -300, false, 4), (64205, -300, -300, false, 4),  -- through chk_r2
  (64206, 110, 110, false, 4), (64207, -150, -150, false, 4), (64208, 45, 45, false, 4),
  (64301, 100, 100, false, 4), (64302, 108, 108, false, 4), (64303, -210, -210, false, 4),
  (64304, 330, 330, false, 4), (64305, -80, -80, false, 4), (64306, 170, 170, false, 4),
  -- chk_r4 and its stations, heard only through chk_r1, which passes them and
  -- chk_r4's own sensor (64115): all on chk_r1's carrier.
  (64115, 250, 250, false, 4), (64401, 250, 250, false, 4), (64402, 250, 250, false, 4),
  (64403, 250, 250, false, 4), (64404, 250, 250, false, 4), (64405, 250, 250, false, 4),
  -- 64170: three bursts a day at +10 and one stray at +120; 64180 half at 0,
  -- half at +80 — two carriers too close for the median to part.
  (64170, 10, 10, false, 3), (64170, 120, 120, false, 1), (64180, 0, 0, false, 2), (64180, 80, 80, false, 2);

insert into meganet.reception (ingest_token_id, point_id, receiver, heard_at, protocol, alert_id, value_raw, ok, detail)
select (select id from _tok), 'check-drift-sdr', 'rtl-sdr',
       (dd.d::text || ' 00:00:00+00')::timestamptz + make_interval(hours => 1 + 5 * k, mins => (l.a % 50),
         secs => case when l.dup then 1 else 0 end + case when l.hz >= 80 and l.a in (64170, 64180) then 30 else 0 end),
       'alert', l.a, 10 + k, true,
       jsonb_build_object('freq_mhz', 151.5, 'cfo_hz', round((case when dd.age < 7 then l.hz_recent else l.hz end) + dd.rxe + 8 * sin(dd.age * 7 + k + l.a))::integer)
         || case when l.dup then '{"duplicate": true, "copy": 1}'::jsonb else '{}'::jsonb end
  from _leg l, _days dd, generate_series(0, 3) k
 where k < l.per_day;

-- 64160: two carriers a day under one name; and a copy nobody explains.
insert into meganet.reception (ingest_token_id, point_id, receiver, heard_at, protocol, alert_id, value_raw, ok, detail)
select (select id from _tok), 'check-drift-sdr', 'rtl-sdr', (dd.d::text || ' 00:00:00+00')::timestamptz + make_interval(hours => 2 + 5 * k),
       'alert', 64160, 5, true, jsonb_build_object('freq_mhz', 151.5, 'cfo_hz', round(case when k % 2 = 0 then -20 else 400 end + dd.rxe)::integer)
  from _days dd, generate_series(0, 3) k;
insert into meganet.reception (ingest_token_id, point_id, receiver, heard_at, protocol, alert_id, value_raw, ok, detail)
select (select id from _tok), 'check-drift-sdr', 'rtl-sdr', (dd.d::text || ' 03:00:01+00')::timestamptz,
       'alert', 64160, 5, true, jsonb_build_object('freq_mhz', 151.5, 'cfo_hz', round(700 + dd.rxe)::integer, 'duplicate', true, 'copy', 1)
  from _days dd;
-- A burst that was two carriers: no offset, its halves on record.
insert into meganet.reception (ingest_token_id, point_id, receiver, heard_at, protocol, alert_id, value_raw, ok, detail)
select (select id from _tok), 'check-drift-sdr', 'rtl-sdr', (d::text || ' 04:00:00+00')::timestamptz, 'alert', 64102, 7, true,
       '{"cfo_split": [60, 250]}'::jsonb
  from _days where age = 1;

-- ALERT2: true offsets (Hz) and the drifter.
create temporary table _tx (a integer primary key, hz double precision, drift double precision) on commit drop;
insert into _tx values (99001, 0, 0), (99002, 60, 0), (99003, -40, 0), (99004, 20, 0), (99005, 30, 450), (99006, -600, 0);
insert into meganet.reception (ingest_token_id, point_id, receiver, heard_at, protocol, alert_id, value_raw, ok, detail)
select (select id from _tok), 'check-drift-sdr', 'rtl-sdr', (dd.d::text || ' 00:00:00+00')::timestamptz + make_interval(hours => k, mins => t.a % 60),
       'alert2', 1000 + k, 1, true,
       jsonb_build_object('source', t.a, 'path', '[]'::jsonb, 'freq_mhz', 150.0,
         'cfo_hz', round(t.hz + case when dd.age < 7 then t.drift else 0 end + dd.rxe + 6 * sin(k + t.a))::integer)
  from _tx t, _days dd, generate_series(0, 23) k
 where not (t.a = 99002 and dd.age % 3 = 0);            -- one is not heard every day
-- One copy over a repeater, on the repeater's carrier (99004's).
insert into meganet.reception (ingest_token_id, point_id, receiver, heard_at, protocol, alert_id, value_raw, ok, detail)
select (select id from _tok), 'check-drift-sdr', 'rtl-sdr', (d::text || ' 12:00:00+00')::timestamptz + make_interval(secs => k), 'alert2', 2000 + k, 1, true,
       jsonb_build_object('source', 99999, 'path', '[99004]'::jsonb, 'freq_mhz', 150.0, 'cfo_hz', round(20 + rxe)::integer, 'duplicate', true)
  from _days, generate_series(0, 3) k where age = 1;

-- Roll it all up and judge it.
create temporary table _rolled on commit drop as
  select meganet.roll_up_carriers((now() at time zone 'UTC')::date - 29, (now() at time zone 'UTC')::date) as r;
create temporary table _cd on commit drop as
  select * from meganet.carrier_daily where ingest_token_id = (select id from _tok);
create temporary table _off on commit drop as
  select * from meganet.carrier_offsets(37) where tx like 'st:chk\_%' or tx like 'a:64%' or tx like 'a2:99%';

do $$
declare
  v_spread double precision;
  v jsonb;
begin
  -- ── ALERT2, as 0075 ────────────────────────────────────────────────────────
  select max(o.offset_hz) - min(o.offset_hz) into v_spread from _off o where o.tx = 'a2:99001';
  perform pg_temp.check_that('ALERT2: a steady transmitter stays steady while the receiver''s crystal wanders 180 Hz',
    v_spread < 15, format('spread %s Hz', round(v_spread::numeric, 1)));
  perform pg_temp.check_that('…including one not heard every day',
    (select max(offset_hz) - min(offset_hz) from _off where tx = 'a2:99002') < 15);
  perform pg_temp.check_that('…each measured against the fleet: their differences are the true ones',
    abs((select avg(offset_hz) from _off where tx = 'a2:99002') - (select avg(offset_hz) from _off where tx = 'a2:99001') - 60) < 8
      and abs((select avg(offset_hz) from _off where tx = 'a2:99006') - (select avg(offset_hz) from _off where tx = 'a2:99001') + 600) < 8);
  perform pg_temp.check_that('…a relayed copy counts for the repeater that sent it last, not its source',
    exists (select 1 from _cd where tx = 'a2:99004' and day = (now() at time zone 'UTC')::date - 1 and n = 28)
      and not exists (select 1 from _cd where tx = 'a2:99999'));
  perform pg_temp.check_that('…and transmitter_offsets() is still its ALERT2 series, by address',
    (select count(*) from meganet.transmitter_offsets(37) where addr = 99006) = (select count(*) from _off where tx = 'a2:99006'));

  -- ── Legacy: who sent each burst ────────────────────────────────────────────
  perform pg_temp.check_that('a repeater heard on its own sensor: its carrier found, and what it relays put down to it',
    (select sum(n) from _cd where tx = 'st:chk_r1' and via = 'repeater' and day = (now() at time zone 'UTC')::date - 2) = 4 * 11
      and (select max(ids) from _cd where tx = 'st:chk_r1') = 11,
    (select string_agg(format('%s n=%s ids=%s', day, n, ids), '; ') from _cd where tx = 'st:chk_r1' and day >= (now() at time zone 'UTC')::date - 2));
  perform pg_temp.check_that('…so a station heard only through it is not measured on the repeater''s carrier',
    not exists (select 1 from _cd where tx in ('st:chk_l64103', 'st:chk_l64104')));
  perform pg_temp.check_that('…while one heard direct as well keeps its own carrier, its relayed copy going to the repeater',
    (select round(avg((cfo_sum / n) - d.rxe)) from _cd c join _days d on d.d = c.day where c.tx = 'st:chk_l64101') between -5 and 5
      and (select sum(n) from _cd where tx = 'st:chk_l64101') = 4 * 30);
  perform pg_temp.check_that('a repeater not heard on its own sensors: found from the addresses it passes sharing one carrier',
    (select count(*) from _cd where tx = 'st:chk_r2' and via = 'repeater') = 30
      and not exists (select 1 from _cd where tx in ('st:chk_l64201', 'st:chk_l64202', 'st:chk_l64203', 'st:chk_l64204'))
      and exists (select 1 from _cd where tx = 'st:chk_l64206'));
  perform pg_temp.check_that('…but not for an address its exclusion range takes out',
    (select count(*) from _cd where tx = 'st:chk_l64205' and via = 'own') = 30);
  perform pg_temp.check_that('a repeater whose own sensor another repeater passes, heard only through it: the relaying one is the carrier',
    not exists (select 1 from _cd where tx = 'st:chk_r4' or tx like 'st:chk\_l644%')
      and (select count(*) from meganet.carrier_receiver_day where ingest_token_id = (select id from _tok)
             and not (detail -> 'repeaters') @> '[{"station_id": "chk_r4"}]'::jsonb) = 30,
    (select string_agg(distinct tx, ',') from _cd where tx like 'st:chk\_r%' or tx like 'st:chk\_l644%'));
  perform pg_temp.check_that('a stray burst is left out of its day and counted, not taken for a second carrier',
    (select bool_and(not mixed and n = 3 and n_out = 1) from _cd where tx = 'st:chk_l64170')
      and abs((select avg(cfo_sum / n - d.rxe) from _cd c join _days d on d.d = c.day where c.tx = 'st:chk_l64170') - 10) < 6);
  perform pg_temp.check_that('two carriers 80 Hz apart, half and half, are mixed',
    (select bool_and(mixed) from _cd where tx = 'st:chk_l64180'));
  perform pg_temp.check_that('a repeater not heard at all is not invented out of its stations'' own carriers',
    not exists (select 1 from _cd where tx = 'st:chk_r3')
      and (select count(distinct tx) from _cd where tx like 'st:chk\_l643%') = 6);
  perform pg_temp.check_that('a station on a repeater''s carrier but not its to pass stays its own',
    (select count(*) from _cd where tx = 'st:chk_l64150' and via = 'own') = 30);
  perform pg_temp.check_that('two carriers a day under one name is marked mixed, and not measured',
    (select bool_and(mixed) from _cd where tx = 'st:chk_l64160')
      and not exists (select 1 from _off where tx = 'st:chk_l64160'));
  v := (select detail from meganet.carrier_receiver_day where ingest_token_id = (select id from _tok)
         and day = (now() at time zone 'UTC')::date - 1);
  perform pg_temp.check_that('each receiver''s day says what was found: repeaters, unexplained copies, split bursts',
    (v -> 'unexplained')::int = 1 and (v -> 'split')::int = 1 and jsonb_array_length(v -> 'repeaters') = 2
      and (v -> 'repeaters') @> '[{"station_id": "chk_r1"}, {"station_id": "chk_r2"}]'::jsonb
      and abs(((v -> 'repeaters' -> 0 ->> 'centre_hz')::numeric) - (250 + 90 * sin(1))::numeric) < 10, left(v::text, 400));

  -- ── Legacy: the offsets ────────────────────────────────────────────────────
  select max(o.offset_hz) - min(o.offset_hz) into v_spread from _off o where o.tx = 'st:chk_l64107';
  perform pg_temp.check_that('legacy: a steady station stays steady while the receiver''s crystal wanders 180 Hz',
    v_spread < 25, format('spread %s Hz', round(v_spread::numeric, 1)));
  perform pg_temp.check_that('…and is measured against the fleet: its differences are the true ones',
    abs((select avg(offset_hz) from _off where tx = 'st:chk_l64106') - (select avg(offset_hz) from _off where tx = 'st:chk_l64107') + 560) < 10);
  perform pg_temp.check_that('…the repeaters too, at their own carriers',
    abs((select avg(offset_hz) from _off where tx = 'st:chk_r1') - (select avg(offset_hz) from _off where tx = 'st:chk_l64107') - 290) < 10
      and abs((select avg(offset_hz) from _off where tx = 'st:chk_r2') - (select avg(offset_hz) from _off where tx = 'st:chk_l64107') + 260) < 10);
end
$$;

create temporary table _run on commit drop as select meganet.refresh_transmitter_findings() as r;

do $$
declare
  f record;
begin
  select * into f from meganet.health_finding
   where source = 'transmitters' and kind = 'transmitter-drift' and subject = 'a2:99005' and cleared_at is null;
  perform pg_temp.check_that('ALERT2: one that moved 3 ppm in a week is a critical drift finding',
    f.id is not null and f.severity = 'critical' and f.title like 'ALERT2 99005%drifted +3.0 ppm in a week', coalesce(f.title, '<none>'));
  select * into f from meganet.health_finding
   where source = 'transmitters' and kind = 'transmitter-off-channel' and subject = 'a2:99006' and cleared_at is null;
  perform pg_temp.check_that('ALERT2: one 4 ppm off the rest is an off-channel warning, with its numbers',
    f.id is not null and f.severity = 'warn' and (f.evidence ->> 'offset_ppm')::numeric between -4.4 and -3.6, coalesce(f.title, '<none>'));
  select * into f from meganet.health_finding
   where source = 'transmitters' and kind = 'transmitter-drift' and subject = 'st:chk_l64105' and cleared_at is null;
  perform pg_temp.check_that('legacy: a station that moved 3 ppm in a week is a critical drift finding, on its station, by name',
    f.id is not null and f.severity = 'critical' and f.station_id = 'chk_l64105' and f.title like 'Check l64105: drifted +3.0 ppm in a week',
    coalesce(f.title, '<none>'));
  perform pg_temp.check_that('…and its repeater, which relayed it all along, is not',
    not exists (select 1 from meganet.health_finding where source = 'transmitters' and subject = 'st:chk_r1' and cleared_at is null));
  select * into f from meganet.health_finding
   where source = 'transmitters' and kind = 'transmitter-off-channel' and subject = 'st:chk_l64106' and cleared_at is null;
  perform pg_temp.check_that('legacy: one 600 Hz below the rest is off channel', f.id is not null and f.severity = 'warn', coalesce(f.title, '<none>'));
  perform pg_temp.check_that('the steady ones are not findings',
    not exists (select 1 from meganet.health_finding where source = 'transmitters' and cleared_at is null
                 and subject in ('a2:99001', 'a2:99002', 'a2:99003', 'a2:99004', 'st:chk_l64101', 'st:chk_l64107', 'st:chk_l64108', 'st:chk_r2')));
  perform pg_temp.check_that('transmitter_summary holds every transmitter judged, its line and its change',
    (select count(*) from meganet.transmitter_summary where tx like 'st:chk\_%' or tx like 'a2:99%') = 26
      and (select array_length(ppm, 1) = array_length(days, 1) and array_length(days, 1) >= 28 and change_ppm between 2.7 and 3.3
             from meganet.transmitter_summary where tx = 'st:chk_l64105'),
    (select format('%s %s %s', array_length(days, 1), change_ppm, w_ppm) from meganet.transmitter_summary where tx = 'st:chk_l64105'));
  perform pg_temp.check_that('the run is recorded, and says what it opened',
    exists (select 1 from meganet.health_refresh where source = 'transmitters')
      and jsonb_array_length((select r from _run) -> 'opened') >= 4, left((select r from _run)::text, 300));
end
$$;

-- A finding clears when it stops holding: 99005 back where it was.
update meganet.reception set cfo_hz = cfo_hz - 450
 where ingest_token_id = (select id from _tok) and protocol = 'alert2' and a2_source = 99005
   and heard_at >= ((now() at time zone 'UTC')::date - 6)::timestamptz;
select meganet.roll_up_carriers((now() at time zone 'UTC')::date - 6, (now() at time zone 'UTC')::date) is not null as rerolled \gset
create temporary table _run2 on commit drop as select meganet.refresh_transmitter_findings() as r;
insert into meganet.archive_day (table_name, day, version, rows, bytes, sha256, object_key, released_at)
values ('reception', (now() at time zone 'UTC')::date - 29, 1, 1, 1, repeat('a', 64), 'check', now())
on conflict do nothing;

do $$
begin
  perform pg_temp.check_that('back where it was, the drift finding clears; the off-channel one stays',
    exists (select 1 from meganet.health_finding where source = 'transmitters' and subject = 'a2:99005' and cleared_at is not null)
      and exists (select 1 from meganet.health_finding where source = 'transmitters' and subject = 'a2:99006' and cleared_at is null));
  perform pg_temp.check_that('rolling a day up again replaces it, not adds to it',
    (select sum(n) from meganet.carrier_daily where ingest_token_id = (select id from _tok) and tx = 'st:chk_r1'
       and day = (now() at time zone 'UTC')::date - 2) = 4 * 11);
  perform pg_temp.check_that('a day whose receptions are released is never rebuilt, and keeps what it had',
    (select meganet.roll_up_carriers_day((now() at time zone 'UTC')::date - 29) ->> 'skipped') is not null
      and (select count(*) from meganet.carrier_daily where ingest_token_id = (select id from _tok)
             and day = (now() at time zone 'UTC')::date - 29) > 20);
  perform pg_temp.check_that('the thresholds are app_meta rows',
    (select count(*) from meganet.app_meta where key in ('tx_offset_warn_ppm', 'tx_offset_crit_ppm', 'tx_drift_warn_ppm', 'tx_drift_crit_ppm')) = 4);
  perform pg_temp.check_that('the other health sources are untouched',
    strpos(pg_get_constraintdef((select oid from pg_constraint where conname = 'health_finding_kind')), 'receiver-deaf') > 0);
end
$$;

-- Who may.
do $$
declare v text;
begin
  v := pg_temp.as_role('anon', '{"role":"anon"}', $q$select count(*)::text from meganet.carrier_offsets(37) where tx like 'st:chk\_%'$q$);
  perform pg_temp.check_that('anyone may read the offsets (no receiver is named)', v not like 'ERROR %' and v::int > 0, v);
  v := pg_temp.as_role('anon', '{"role":"anon"}', $q$select count(*)::text from meganet.transmitter_summary where tx like 'st:chk\_%'$q$);
  perform pg_temp.check_that('…and the summary', v not like 'ERROR %' and v::int > 0, v);
  v := pg_temp.as_role('anon', '{"role":"anon"}', $q$select count(*)::text from meganet.health_finding where source = 'transmitters' and subject = 'st:chk_l64106'$q$);
  perform pg_temp.check_that('…and the findings, like station findings', v = '1', v);
  v := pg_temp.as_role('anon', '{"role":"anon"}', $q$select count(*)::text from meganet.carrier_daily$q$);
  perform pg_temp.check_that('…but not carrier_daily, which names receivers', v like 'ERROR %' or v = '0', v);
  v := pg_temp.as_role('anon', '{"role":"anon"}', $q$select count(*)::text from meganet.carrier_receiver_day$q$);
  perform pg_temp.check_that('…nor carrier_receiver_day', v like 'ERROR %' or v = '0', v);
  perform pg_temp.check_that('nobody but the owner and the service key rolls up or judges',
    not has_function_privilege('anon', 'meganet.refresh_transmitter_findings(timestamptz)', 'execute')
      and not has_function_privilege('authenticated', 'meganet.refresh_transmitter_findings(timestamptz)', 'execute')
      and not has_function_privilege('anon', 'meganet.roll_up_carriers(date, date)', 'execute')
      and not has_function_privilege('authenticated', 'meganet.roll_up_carriers_day(date)', 'execute'));
end
$$;

select lpad(ord::text, 2) as "#", case when ok then 'ok  ' else 'FAIL' end as result, name,
       case when ok then '' else left(coalesce(note, ''), 300) end as detail
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
