-- check_station_snr.sql — Prove 0083: each transmitter's SNR, measured only
-- where its own carrier says it sent the burst, its fall a health finding,
-- each receiver's own steps taken out — against a real database.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_station_snr.sql
--
-- One row per claim, a non-zero exit if any fails, and a transaction that
-- rolls back, so it is safe against the live database.
--
-- Three made-up base stations hear a made-up network for 95 days:
--
--   A  hears everything below. Its own SNR wobbles 1.5 dB day to day, and 20
--      days ago everything it hears dropped 5 dB at once (its cable, say) —
--      which must not show as any station falling, in a week or in three
--      months.
--   B  hears some of the same stations 5 dB stronger, with no step.
--   C  came up five days ago: it has no history, and must not water down a
--      change the others see.
--
--   Legacy stations (addresses 65101–65110, stations chk_s…):
--     65101–65106  steady (65102 with a stray burst a day on another carrier
--                  at 30 dB, which must be left out of its SNR);
--     65107        5 dB weaker in the last week, at A and B: a warning, both
--                  base stations agreeing;
--     65108        sliding 7 dB over the 90 days: under the line in a week,
--                  over it in three months;
--     65109        8 dB weaker in the last week at A; C hears it too, newly:
--                  critical, judged by A alone;
--     65110        steady at A, 14 dB weaker in the last week at B: one path
--                  — a warning that says so, never critical.
--   chk_q1, a repeater heard on its own sensor (65190, carrier +250), passing
--   65150–65160, 7 dB weaker in the last week. 65151 and 65152 are heard only
--   through it; 65153 is heard direct at 9 dB and relayed too. The fade is the
--   repeater's alone.
--   ALERT2 at A: 99101–99103 steady, 99104 4 dB weaker in the last week.

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
    raise exception using errcode = 'MNRLS', message = coalesce(v, '<null>');
  exception
    when sqlstate 'MNRLS' then return sqlerrm;
    when others then return 'ERROR ' || sqlstate;
  end;
end;
$$;

-- An administrator and an editor, for the Base Stations tab's view.
insert into meganet.editor_allow (entry, note) values
  ('snr-editor@example.test', 'check_station_snr — rolled back'),
  ('snr-admin@example.test',  'check_station_snr — rolled back')
on conflict (entry) do nothing;
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000c5801', 'snr-editor@example.test', now()),
  ('00000000-0000-4000-8000-0000000c5802', 'snr-admin@example.test', now())
on conflict (id) do nothing;
update meganet.app_user set role = 'admin' where id = '00000000-0000-4000-8000-0000000c5802';

-- The three receivers.
select meganet.create_ingest_token('_check_snr a') is not null as minted_a \gset
select meganet.create_ingest_token('_check_snr b') is not null as minted_b \gset
select meganet.create_ingest_token('_check_snr c') is not null as minted_c \gset
create temporary table _tok on commit drop as
  select (select id from meganet.ingest_token where label = '_check_snr a') as a,
         (select id from meganet.ingest_token where label = '_check_snr b') as b,
         (select id from meganet.ingest_token where label = '_check_snr c') as c;

-- The days: A's own wobble and its step 20 days ago, B's wobble, and each
-- receiver's crystal (which the carriers must survive, as 0077's do).
create temporary table _days on commit drop as
  select g as age, ((now() at time zone 'UTC')::date - g) as d,
         1.5 * sin(g * 1.3) + case when g < 20 then -5 else 0 end as a_shift,
         0.8 * sin(g * 0.7) as b_shift,
         40 * sin(g) as rxe
    from generate_series(0, 94) g;

-- The register.
insert into meganet.station (id, ord, name, roles)
select 'chk_' || s, 910000 + row_number() over (), 'Check ' || s, case when s like 'q%' then array['repeater'] else array['field'] end
  from unnest(array['q1', 's65101', 's65102', 's65103', 's65104', 's65105', 's65106', 's65107', 's65108', 's65109', 's65110',
                    's65151', 's65152', 's65153']) s;
insert into meganet.sensor (station_id, sensor_id, type, ord, alert_id)
select st.id, 's1', 'Rainfall', 0, case when st.id = 'chk_q1' then 65190 else substr(st.id, 6)::integer end
  from meganet.station st where st.id like 'chk\_q1' or st.id like 'chk\_s65%';
insert into meganet.repeater (station_id) values ('chk_q1');
insert into meganet.pass_range (repeater_id, kind, lo, hi, ord) values ('chk_q1', 'pass', 65150, 65160, 0);

-- What each receiver hears: (receiver, address, carrier Hz, SNR as a function
-- of the day's age, a copy?, bursts a day).
create temporary table _leg (rx text, a integer, hz double precision, lvl double precision,
                             recent double precision, slide double precision, dup boolean, per_day integer) on commit drop;
insert into _leg values
  -- receiver A
  ('a', 65101, -300, 10, 0, 0, false, 4), ('a', 65102, -200, 14, 0, 0, false, 4), ('a', 65103, -120, 18, 0, 0, false, 4),
  ('a', 65104,  -40, 22, 0, 0, false, 4), ('a', 65105,   40, 12, 0, 0, false, 4), ('a', 65106, 120, 16, 0, 0, false, 4),
  ('a', 65107,  420, 15, -5, 0, false, 4),                         -- weaker in the last week
  ('a', 65108,  500, 20, 0, -7, false, 4),                         -- sliding over the 90 days
  ('a', 65109,  580, 17, -8, 0, false, 4),                         -- much weaker in the last week
  ('a', 65110,  660, 13, 0, 0, false, 4),
  ('a', 65190,  250, 20, -7, 0, false, 4),                         -- the repeater, on its own sensor
  ('a', 65151,  250, 20, -7, 0, false, 4), ('a', 65152, 250, 20, -7, 0, false, 4),   -- only through it
  ('a', 65153, -100,  9, 0, 0, false, 4), ('a', 65153, 250, 20, -7, 0, true, 4),     -- direct, and relayed
  -- receiver B: some of them, 5 dB stronger, no step
  ('b', 65101, -300, 15, 0, 0, false, 4), ('b', 65102, -200, 19, 0, 0, false, 4), ('b', 65103, -120, 23, 0, 0, false, 4),
  ('b', 65104,  -40, 27, 0, 0, false, 4), ('b', 65105,   40, 17, 0, 0, false, 4), ('b', 65106, 120, 21, 0, 0, false, 4),
  ('b', 65107,  420, 20, -5, 0, false, 4),
  ('b', 65110,  660, 25, -14, 0, false, 4);                        -- one path

insert into meganet.reception (ingest_token_id, point_id, receiver, heard_at, protocol, alert_id, value_raw, ok, detail)
select case l.rx when 'a' then t.a else t.b end, 'check-snr-' || l.rx, 'rtl-sdr',
       (dd.d::text || ' 00:00:00+00')::timestamptz + make_interval(hours => 1 + 5 * k, mins => (l.a % 50), secs => case when l.dup then 1 else 0 end),
       'alert', l.a, 10 + k, true,
       jsonb_build_object('freq_mhz', 151.5,
         'cfo_hz', round(l.hz + dd.rxe + 6 * sin(dd.age * 5 + k + l.a))::integer,
         'snr_db', round((l.lvl + case when dd.age < 7 then l.recent else 0 end + l.slide * (90 - least(dd.age, 90)) / 90.0
                          + case l.rx when 'a' then dd.a_shift else dd.b_shift end + 1.2 * sin(dd.age * 3 + k * 1.7 + l.a))::numeric, 1))
         || case when l.dup then '{"duplicate": true, "copy": 1}'::jsonb else '{}'::jsonb end
  from _leg l, _days dd, _tok t, generate_series(0, 3) k
 where k < l.per_day;

-- 65102's stray: a burst a day on another carrier, loud — another transmitter's.
insert into meganet.reception (ingest_token_id, point_id, receiver, heard_at, protocol, alert_id, value_raw, ok, detail)
select t.a, 'check-snr-a', 'rtl-sdr', (dd.d::text || ' 22:52:30+00')::timestamptz, 'alert', 65102, 10, true,
       jsonb_build_object('freq_mhz', 151.5, 'cfo_hz', round(-200 + 200 + dd.rxe)::integer, 'snr_db', 30)
  from _days dd, _tok t;

-- Receiver C, these last five days: five stations at levels of its own.
insert into meganet.reception (ingest_token_id, point_id, receiver, heard_at, protocol, alert_id, value_raw, ok, detail)
select t.c, 'check-snr-c', 'rtl-sdr', (dd.d::text || ' 00:00:00+00')::timestamptz + make_interval(hours => 2 + 5 * k, mins => (x.a % 50)),
       'alert', x.a, 10 + k, true,
       jsonb_build_object('freq_mhz', 151.5, 'cfo_hz', round(x.hz + 6 * sin(k + x.a))::integer,
                          'snr_db', round((x.lvl + 0.8 * sin(dd.age + k + x.a))::numeric, 1))
  from (values (65101, -300::double precision, 25::double precision), (65102, -200, 11), (65103, -120, 30), (65104, -40, 14), (65109, 580, 19)) x(a, hz, lvl),
       _days dd, _tok t, generate_series(0, 3) k
 where dd.age < 5;

-- ALERT2 at A, its own decoder: four transmitters, one weaker in the last week.
insert into meganet.reception (ingest_token_id, point_id, receiver, heard_at, protocol, alert_id, value_raw, ok, detail)
select t.a, 'check-snr-a', 'rtl-sdr', (dd.d::text || ' 00:00:00+00')::timestamptz + make_interval(hours => 4 * k, mins => x.a % 60),
       'alert2', 1000 + k, 1, true,
       jsonb_build_object('source', x.a, 'path', '[]'::jsonb, 'freq_mhz', 150.0, 'cfo_hz', round(x.hz + dd.rxe + 5 * sin(k + x.a))::integer,
                          'snr_db', round((x.lvl + case when dd.age < 7 then x.recent else 0 end + dd.a_shift + 0.8 * sin(dd.age * 2 + k + x.a))::numeric, 1))
  from (values (99101, 0::double precision, 18::double precision, 0::double precision), (99102, 60, 22, 0), (99103, -40, 15, 0), (99104, 120, 20, -4)) x(a, hz, lvl, recent),
       _days dd, _tok t, generate_series(0, 5) k;

-- Roll it all up and judge it.
create temporary table _rolled on commit drop as
  select meganet.roll_up_carriers((now() at time zone 'UTC')::date - 94, (now() at time zone 'UTC')::date) as r;
create temporary table _run on commit drop as select meganet.refresh_transmitter_findings() as r;
create temporary table _cd on commit drop as
  select c.*, case c.ingest_token_id when t.a then 'a' when t.b then 'b' when t.c then 'c' end as rx
    from meganet.carrier_daily c, _tok t where c.ingest_token_id in (t.a, t.b, t.c);
create temporary table _sum on commit drop as
  select * from meganet.transmitter_summary where tx like 'st:chk\_%' or tx like 'a2:991%';
create temporary table _f on commit drop as
  select * from meganet.health_finding
   where source = 'transmitters' and kind = 'transmitter-snr-falling' and cleared_at is null
     and (subject like 'st:chk\_%' or subject like 'a2:991%');
create temporary table _rsd on commit drop as
  select r.*, d.age from meganet.receiver_snr_day r join _days d on d.d = r.day
   where r.ingest_token_id = (select a from _tok) and r.protocol = 'alert';

do $$
declare
  f record;
  v double precision;
  w double precision;
begin
  -- ── The SNR beside the carrier ──────────────────────────────────────────────
  perform pg_temp.check_that('each receiver''s day of a station keeps the SNR of the bursts its own carrier says it sent',
    (select bool_and(snr_n = 4 and abs(snr_sum / snr_n - (10 + d.a_shift)) < 1.5)
       from _cd c join _days d on d.d = c.day where c.tx = 'st:chk_s65101' and c.rx = 'a'),
    (select string_agg(format('%s n=%s %s', day, snr_n, round((snr_sum / nullif(snr_n, 0))::numeric, 1)), '; ')
       from (select * from _cd where tx = 'st:chk_s65101' and rx = 'a' order by day desc limit 3) z));
  perform pg_temp.check_that('…a stray on another carrier is left out of it, as out of the offset',
    (select bool_and(snr_n = 4 and n_out = 1 and snr_sum / snr_n < 20) from _cd where tx = 'st:chk_s65102' and rx = 'a'),
    (select format('n=%s out=%s mean=%s', min(snr_n), min(n_out), round(max(snr_sum / nullif(snr_n, 0))::numeric, 1)) from _cd where tx = 'st:chk_s65102' and rx = 'a'));
  perform pg_temp.check_that('a station heard only through its repeater has no SNR of its own — its relays are the repeater''s',
    not exists (select 1 from _cd where tx in ('st:chk_s65151', 'st:chk_s65152'))
      and not exists (select 1 from _sum where tx in ('st:chk_s65151', 'st:chk_s65152') and snr_receivers > 0));
  perform pg_temp.check_that('…the repeater carries them: its own sensor, both stations behind it and the relayed copy',
    (select bool_and(snr_n = 16 and via = 'repeater') from _cd where tx = 'st:chk_q1' and rx = 'a'),
    (select format('n=%s via=%s', min(snr_n), min(via)) from _cd where tx = 'st:chk_q1'));
  perform pg_temp.check_that('…and a station heard direct as well keeps its own SNR, not its repeater''s',
    (select abs(avg(snr_sum / snr_n - d.a_shift) - 9) < 1 and min(snr_n) = 4
       from _cd c join _days d on d.d = c.day where c.tx = 'st:chk_s65153'),
    (select format('mean %s', round(avg(snr_sum / snr_n - d.a_shift)::numeric, 1)) from _cd c join _days d on d.d = c.day where c.tx = 'st:chk_s65153'));

  -- ── The receiver's own steps ────────────────────────────────────────────────
  v := (select avg(shift_db) filter (where age < 20) - avg(shift_db) filter (where age >= 20) from _rsd);
  perform pg_temp.check_that('the receiver''s own step — everything 5 dB weaker at once — is found as the receiver''s',
    abs(v + 5) < 0.8 and (select min(links) from _rsd) >= 3, format('step %s dB', round(v::numeric, 2)));
  perform pg_temp.check_that('…and its day-to-day wobble with it',
    (select corr(r.shift_db, d.a_shift) from _rsd r join _days d on d.d = r.day where r.age >= 20) > 0.9,
    format('r %s', round((select corr(r.shift_db, d.a_shift) from _rsd r join _days d on d.d = r.day where r.age >= 20)::numeric, 3)));
  perform pg_temp.check_that('so a steady station is steady through it, in a week and in three months',
    (select bool_and(abs(snr_change_db) < 1 and abs(snr_season_db) < 1) from _sum
      where tx in ('st:chk_s65101', 'st:chk_s65103', 'st:chk_s65104', 'st:chk_s65105', 'st:chk_s65106')),
    (select string_agg(format('%s %s/%s', tx, round(snr_change_db::numeric, 1), round(snr_season_db::numeric, 1)), '; ') from _sum
      where tx in ('st:chk_s65101', 'st:chk_s65103', 'st:chk_s65104', 'st:chk_s65105', 'st:chk_s65106')));
  perform pg_temp.check_that('…and is not a finding',
    not exists (select 1 from _f where subject in ('st:chk_s65101', 'st:chk_s65102', 'st:chk_s65103', 'st:chk_s65104',
                                                   'st:chk_s65105', 'st:chk_s65106', 'st:chk_s65153', 'a2:99101', 'a2:99102', 'a2:99103')),
    (select string_agg(title, '; ') from _f));

  -- ── The findings ────────────────────────────────────────────────────────────
  select * into f from _f where subject = 'st:chk_s65107';
  perform pg_temp.check_that('5 dB weaker in a week, at both base stations: a warning, on its station, saying both saw it',
    f.id is not null and f.severity = 'warn' and f.station_id = 'chk_s65107'
      and f.title ~ '^Check s65107: SNR down [45]\.[0-9] dB in a week$' and f.detail like '%All 2 base stations that hear it directly saw the drop%'
      and (f.evidence ->> 'judged')::int = 2 and (f.evidence ->> 'falling')::int = 2 and f.evidence ->> 'window' = 'week',
    coalesce(f.title, '<none>') || ' | ' || coalesce(f.evidence::text, ''));
  select * into f from _f where subject = 'st:chk_s65109';
  perform pg_temp.check_that('8 dB weaker in a week: critical — and a base station new this week does not water it down',
    f.id is not null and f.severity = 'critical' and (f.evidence ->> 'drop_db')::numeric between 7 and 9
      and (f.evidence ->> 'judged')::int = 1 and (f.evidence ->> 'receivers')::int = 2,
    coalesce(f.title, '<none>') || ' | ' || coalesce(f.evidence::text, ''));
  select * into f from _f where subject = 'st:chk_s65108';
  perform pg_temp.check_that('a slow slide is caught over three months, though no week is past the line',
    f.id is not null and f.severity = 'warn' and f.evidence ->> 'window' = 'season' and f.title like '%dB in three months'
      and (f.evidence ->> 'season_db')::numeric between -5.5 and -3.9 and (f.evidence ->> 'change_db')::numeric > -3,
    coalesce(f.title, '<none>') || ' | ' || coalesce(f.evidence::text, ''));
  select * into f from _f where subject = 'st:chk_s65110';
  perform pg_temp.check_that('one base station''s path alone: a warning that says so, never critical, however far it fell',
    f.id is not null and f.severity = 'warn' and (f.evidence ->> 'drop_db')::numeric >= 6
      and (f.evidence ->> 'judged')::int = 2 and (f.evidence ->> 'falling')::int = 1
      and f.detail like '%Only 1 of the 2 base stations that hear it directly saw the drop%',
    coalesce(f.title, '<none>') || ' | ' || coalesce(f.detail, ''));
  select * into f from _f where subject = 'st:chk_q1';
  perform pg_temp.check_that('a repeater fading is the repeater''s finding, on its own name',
    f.id is not null and f.severity = 'critical' and f.title like 'Check q1: SNR down %' and f.evidence ->> 'via' = 'repeater',
    coalesce(f.title, '<none>'));
  perform pg_temp.check_that('…and the stations behind it, or relayed by it, are not',
    not exists (select 1 from _f where subject in ('st:chk_s65151', 'st:chk_s65152', 'st:chk_s65153')));
  select * into f from _f where subject = 'a2:99104';
  perform pg_temp.check_that('ALERT2 the same way, against its own decoder''s receiver',
    f.id is not null and f.severity = 'warn' and f.title like 'ALERT2 99104: SNR down %dB in a week' and (f.evidence ->> 'addr')::int = 99104,
    coalesce(f.title, '<none>'));
  perform pg_temp.check_that('a finding says what the receivers did themselves, when they moved',
    (select detail from _f where subject = 'st:chk_s65109') like '%everything those receivers hear moved -%dB together%'
      and abs(((select evidence from _f where subject = 'st:chk_s65109') ->> 'receivers_shift_db')::numeric) >= 1,
    (select detail from _f where subject = 'st:chk_s65109'));

  -- ── The summary ─────────────────────────────────────────────────────────────
  perform pg_temp.check_that('transmitter_summary carries the signal: its level, spread, changes, base stations and line',
    (select snr_receivers = 2 and snr_judged = 2 and snr_falling = 2 and snr_change_db between -6 and -4
            and snr_db between 8 and 25 and snr_sd between 0.3 and 3
            and array_length(snr_rel, 1) = array_length(snr_days, 1) and array_length(snr_days, 1) >= 90
       from _sum where tx = 'st:chk_s65107'),
    (select format('rx=%s judged=%s falling=%s change=%s snr=%s sd=%s days=%s', snr_receivers, snr_judged, snr_falling,
                   round(snr_change_db::numeric, 2), round(snr_db::numeric, 1), round(snr_sd::numeric, 2), array_length(snr_days, 1))
       from _sum where tx = 'st:chk_s65107'));
  select avg(r) filter (where i > n - 6), avg(r) filter (where i between n - 36 and n - 8) into v, w
    from (select r, i, count(*) over () as n from _sum, unnest(snr_rel) with ordinality u(r, i) where tx = 'st:chk_s65109') z;
  perform pg_temp.check_that('…its line against its thirty days before last week: 0 then, about −8 now',
    abs(w) < 0.6 and v between -9 and -7, format('before %s, now %s', round(w::numeric, 2), round(v::numeric, 2)));
  perform pg_temp.check_that('…and its carrier row is the same row',
    (select w_ppm is not null and array_length(days, 1) > 20 from _sum where tx = 'st:chk_s65107'));
  perform pg_temp.check_that('the run is recorded with how many signals it judged',
    ((select detail from meganet.health_refresh where source = 'transmitters') ->> 'signal')::int >= 14,
    (select detail::text from meganet.health_refresh where source = 'transmitters'));
end
$$;

-- A finding clears when it stops holding: 65107 back as it was.
update meganet.reception set snr_db = snr_db + 5
 where ingest_token_id in ((select a from _tok), (select b from _tok)) and protocol = 'alert' and alert_id = 65107
   and heard_at >= ((now() at time zone 'UTC')::date - 6)::timestamptz;
select meganet.roll_up_carriers((now() at time zone 'UTC')::date - 6, (now() at time zone 'UTC')::date) is not null as rerolled \gset
create temporary table _run2 on commit drop as select meganet.refresh_transmitter_findings() as r;

do $$
begin
  perform pg_temp.check_that('back as it was, its finding clears; the others stay',
    exists (select 1 from meganet.health_finding where source = 'transmitters' and kind = 'transmitter-snr-falling'
             and subject = 'st:chk_s65107' and cleared_at is not null)
      and exists (select 1 from meganet.health_finding where source = 'transmitters' and kind = 'transmitter-snr-falling'
                   and subject = 'st:chk_s65109' and cleared_at is null));
  perform pg_temp.check_that('the lines are app_meta rows',
    (select count(*) from meganet.app_meta where key in ('tx_snr_drop_warn_db', 'tx_snr_drop_crit_db')) = 2);
  perform pg_temp.check_that('the other transmitter findings still work beside it',
    strpos(pg_get_constraintdef((select oid from pg_constraint where conname = 'health_finding_kind')), 'transmitter-corrupting') > 0
      and strpos(pg_get_constraintdef((select oid from pg_constraint where conname = 'health_finding_kind')), 'receiver-deaf') > 0);
end
$$;

-- Who may.
do $$
declare
  v text;
  j jsonb;
  admin text := '{"role":"authenticated","email":"snr-admin@example.test","sub":"00000000-0000-4000-8000-0000000c5802"}';
  editor text := '{"role":"authenticated","email":"snr-editor@example.test","sub":"00000000-0000-4000-8000-0000000c5801"}';
begin
  v := pg_temp.as_role('anon', '{"role":"anon"}', $q$select count(*)::text from meganet.carrier_snr(97) where tx like 'st:chk\_%'$q$);
  perform pg_temp.check_that('anyone may read each transmitter''s signal by day (no receiver is named)', v not like 'ERROR %' and v::int > 500, v);
  v := pg_temp.as_role('anon', '{"role":"anon"}', $q$select count(*)::text from meganet.transmitter_summary where tx like 'st:chk\_%' and snr_receivers > 0$q$);
  perform pg_temp.check_that('…and the summary''s signal columns', v not like 'ERROR %' and v::int >= 12, v);
  v := pg_temp.as_role('anon', '{"role":"anon"}', $q$select count(*)::text from meganet.health_finding where kind = 'transmitter-snr-falling' and subject = 'st:chk_s65109'$q$);
  perform pg_temp.check_that('…and the findings, like station findings', v = '1', v);
  v := pg_temp.as_role('anon', '{"role":"anon"}', $q$select count(*)::text from meganet.carrier_snr_links(97)$q$);
  perform pg_temp.check_that('…but not the links, which name receivers', v like 'ERROR %', v);
  v := pg_temp.as_role('anon', '{"role":"anon"}', $q$select count(*)::text from meganet.receiver_snr_day$q$);
  perform pg_temp.check_that('…nor the receivers'' own shifts', v like 'ERROR %' or v = '0', v);
  v := pg_temp.as_role('authenticated', editor, format('select meganet.admin_base_station_signal(%s)::text', (select a from _tok)));
  perform pg_temp.check_that('an editor may not read a base station''s receivers'' signal', v like 'ERROR %', v);
  v := pg_temp.as_role('authenticated', admin, format('select meganet.admin_base_station_signal(%s)::text', (select a from _tok)));
  j := case when v like 'ERROR %' then null else v::jsonb end;
  perform pg_temp.check_that('an administrator may: each receiver and protocol, its days with the shift, the transmitters and its noise floor',
    j is not null and jsonb_array_length(j -> 'receivers') = 2
      and (j -> 'receivers') @> '[{"point_id": "check-snr-a", "protocol": "alert"}, {"point_id": "check-snr-a", "protocol": "alert2"}]'::jsonb
      and jsonb_array_length((j -> 'receivers' -> 0 -> 'days')) >= 90 and jsonb_array_length((j -> 'receivers' -> 0 -> 'days' -> 0)) = 5
      and (j ->> 'warn_db')::numeric = 3,
    left(coalesce(v, '<null>'), 300));
  perform pg_temp.check_that('nobody but the owner and the service key judges',
    not has_function_privilege('anon', 'meganet.refresh_transmitter_findings(timestamptz)', 'execute')
      and not has_function_privilege('authenticated', 'meganet.carrier_snr_links(integer)', 'execute')
      and not has_function_privilege('anon', 'meganet.admin_base_station_signal(bigint)', 'execute'));
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
