-- check_flip_fingerprints.sql — Prove 0078: corrupted copies found, and each
-- put down to the transmitter whose carrier it came on (#217's fingerprints,
-- for the bit flips).
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_flip_fingerprints.sql
--
-- One row per claim, a non-zero exit if any fails, and a transaction that
-- rolls back, so it is safe against the live database.
--
-- A made-up base station hears a made-up network for a week (addresses
-- 8000–8063, none of them real), its own crystal wandering 100 Hz a day:
--
--   * five stations, chk_f8001 … chk_f8005, each reporting eight times a day,
--     heard direct and relayed by two repeaters that both pass 8000–8020:
--     chk_fr1 (carrier +250, own sensor 8060), clean, and chk_fr2 (−300, own
--     sensor 8047), which corrupts one report a day of three stations — two
--     values with a high bit flipped, one address flipped onto 8035, which no
--     station has. Pass ranges alone cannot tell the two repeaters apart.
--   * chk_f8004 misheard once a day, direct and weak (6 dB).
--   * a corrupted copy on a carrier nobody has (+700), and one with no carrier.
--   * chk_f8006 reporting twice in two seconds, values one apart: real.
--   * chk_fs, a station with sensors 8010 and 8011 in one burst: real.

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

insert into meganet.editor_allow (entry, note) values ('flip-editor@example.test', 'check_flip_fingerprints — rolled back') on conflict (entry) do nothing;
select meganet.create_ingest_token('_check_flip pi') is not null as minted \gset
create temporary table _tok on commit drop as select id from meganet.ingest_token where label = '_check_flip pi';
create temporary table _days on commit drop as
  select g as age, ((now() at time zone 'UTC')::date - g) as d, 50 * sin(g) as rxe from generate_series(1, 7) g;

-- The register.
insert into meganet.station (id, ord, name, roles) values
  ('chk_fr1', 910001, 'Check flip R1', array['repeater']), ('chk_fr2', 910002, 'Check flip R2', array['repeater']),
  ('chk_f8001', 910003, 'Check flip 8001', array['field']), ('chk_f8002', 910004, 'Check flip 8002', array['field']),
  ('chk_f8003', 910005, 'Check flip 8003', array['field']), ('chk_f8004', 910006, 'Check flip 8004', array['field']),
  ('chk_f8005', 910007, 'Check flip 8005', array['field']), ('chk_f8006', 910008, 'Check flip 8006', array['field']),
  ('chk_fs', 910009, 'Check flip two sensors', array['field']);
insert into meganet.sensor (station_id, sensor_id, type, ord, alert_id) values
  ('chk_fr1', 's1', 'Battery', 0, 8060), ('chk_fr2', 's1', 'Battery', 0, 8047),
  ('chk_f8001', 's1', 'Water Level', 0, 8001), ('chk_f8002', 's1', 'Water Level', 0, 8002),
  ('chk_f8003', 's1', 'Water Level', 0, 8003), ('chk_f8004', 's1', 'Water Level', 0, 8004),
  ('chk_f8005', 's1', 'Water Level', 0, 8005), ('chk_f8006', 's1', 'Rainfall', 0, 8006),
  ('chk_fs', 's1', 'Rainfall', 0, 8010), ('chk_fs', 's2', 'Battery', 1, 8011);
insert into meganet.repeater (station_id) values ('chk_fr1'), ('chk_fr2');
insert into meganet.pass_range (repeater_id, kind, lo, hi, ord) values
  ('chk_fr1', 'pass', 8000, 8020, 0), ('chk_fr2', 'pass', 8000, 8020, 0);

create or replace function pg_temp.rx(p_t timestamptz, p_a integer, p_v integer, p_cfo double precision, p_dup boolean, p_snr double precision default 14)
returns void language sql as $$
  insert into meganet.reception (ingest_token_id, point_id, receiver, heard_at, protocol, alert_id, value_raw, ok, detail)
  values ((select id from _tok), 'check-flip-sdr', 'rtl-sdr', p_t, 'alert', p_a, p_v, true,
          jsonb_build_object('freq_mhz', 151.5, 'snr_db', p_snr)
            || case when p_cfo is null then '{}'::jsonb else jsonb_build_object('cfo_hz', round(p_cfo)::integer) end
            || case when p_dup then '{"duplicate": true, "copy": 1}'::jsonb else '{}'::jsonb end);
$$;

-- The five stations: eight reports a day, each heard direct and relayed by both.
create temporary table _st (a integer, hz double precision) on commit drop;
insert into _st values (8001, 0), (8002, 60), (8003, -40), (8004, 20), (8005, 30);
create temporary table _rep on commit drop as
  select s.a, s.hz, d.d, d.age, d.rxe, k,
         (d.d::text || ' 00:00:00+00')::timestamptz + make_interval(hours => 1 + 3 * k, mins => (s.a - 8000) * 7) as t,
         200 + 10 * (s.a - 8000) + (7 - d.age) * 8 + k as v
    from _st s, _days d, generate_series(0, 7) k;
-- The readings they were (what the fit rule reads).
insert into meganet.reading (alert_id, reading_ts, value_raw)
select r.a, r.t, r.v from _rep r;
select count(*) > 0 as direct from (
  select pg_temp.rx(r.t, r.a, case when r.a = 8004 and r.k = 2 then r.v # 256 else r.v end, r.hz + r.rxe, false,
                    case when r.a = 8004 and r.k = 2 then 6 else 14 end) from _rep r) z \gset
select count(*) > 0 as via_r1 from (
  select pg_temp.rx(r.t + interval '1 second', r.a, r.v, 250 + r.rxe, true) from _rep r) z \gset
select count(*) > 0 as via_r2 from (
  select pg_temp.rx(r.t + interval '1500 milliseconds',
                    case when r.a = 8003 and r.k = 1 then 8035 else r.a end,
                    case when r.a in (8001, 8002) and r.k = 1 then r.v # 512 else r.v end,
                    -300 + r.rxe, true) from _rep r) z \gset
-- The repeaters' own sensors, four times a day.
select count(*) > 0 as own from (
  select pg_temp.rx((d.d::text || ' 00:00:00+00')::timestamptz + make_interval(hours => 2 + 6 * k, mins => 41), 8060, 120, 250 + d.rxe, false),
         pg_temp.rx((d.d::text || ' 00:00:00+00')::timestamptz + make_interval(hours => 2 + 6 * k, mins => 53), 8047, 121, -300 + d.rxe, false)
    from _days d, generate_series(0, 3) k) z \gset
-- A corrupted copy on a carrier nobody has, and one with no carrier.
select count(*) > 0 as odd from (
  select pg_temp.rx(r.t + interval '500 milliseconds', r.a, r.v # 512, 700 + r.rxe, false) from _rep r where r.a = 8005 and r.k = 3
  union all
  select pg_temp.rx(r.t + interval '700 milliseconds', r.a, r.v # 512, null, false) from _rep r where r.a = 8002 and r.k = 3) z \gset
-- Real pairs: two rain reports in two seconds; one station's two sensors in one burst.
insert into meganet.reading (alert_id, reading_ts, value_raw)
select 8006, (d.d::text || ' 00:00:00+00')::timestamptz + make_interval(hours => 4), 300 from _days d;
select count(*) > 0 as real_pairs from (
  select pg_temp.rx((d.d::text || ' 00:00:00+00')::timestamptz + make_interval(hours => 9, mins => 13), 8006, 302, -90 + d.rxe, false),
         pg_temp.rx((d.d::text || ' 00:00:00+00')::timestamptz + make_interval(hours => 9, mins => 13, secs => 2), 8006, 303, -90 + d.rxe, false),
         pg_temp.rx((d.d::text || ' 00:00:00+00')::timestamptz + make_interval(hours => 10, mins => 17), 8010, 300, 110 + d.rxe, false),
         pg_temp.rx((d.d::text || ' 00:00:00+00')::timestamptz + make_interval(hours => 10, mins => 17, secs => 1), 8011, 301, 110 + d.rxe, false)
    from _days d) z \gset

-- Across midnight: chk_f8001 misheard at 23:59:59 (weak), its clean copy via
-- R1 two seconds later, on the next day.
insert into meganet.reading (alert_id, reading_ts, value_raw)
select 8001, (d.d::text || ' 23:59:59+00')::timestamptz, 242 from _days d where d.age = 4;
select count(*) > 0 as midnight from (
  select pg_temp.rx((d.d::text || ' 23:59:59+00')::timestamptz, 8001, 242 # 512, 0 + d.rxe, false, 5),
         pg_temp.rx((d.d::text || ' 23:59:59+00')::timestamptz + interval '2 seconds', 8001, 242, 250 + d.rxe, true)
    from _days d where d.age = 4) z \gset
create temporary table _rolled on commit drop as
  select meganet.roll_up_carriers((now() at time zone 'UTC')::date - 7, (now() at time zone 'UTC')::date) as r;
create temporary table _fe on commit drop as
  select * from meganet.flip_event where ingest_token_id = (select id from _tok);
create temporary table _run on commit drop as select meganet.refresh_transmitter_findings() as r;

do $$
declare v jsonb; f record;
begin
  -- ── Finding them ───────────────────────────────────────────────────────────
  perform pg_temp.check_that('every corrupted copy is found, once each — a week of R2''s three a day, the weak one, the two odd ones',
    (select count(*) from _fe) = 7 * (3 + 1 + 2) + 1 and (select count(distinct bad_reception_id) from _fe) = (select count(*) from _fe),
    (select format('%s events, %s distinct', count(*), count(distinct bad_reception_id)) from _fe));
  perform pg_temp.check_that('…a value flip told by its address''s own series, an address flip by its address being on no station',
    (select count(*) from _fe where rule = 'fit' and not addr_flip and bad_tx = 'st:chk_fr2') = 14
      and (select count(*) from _fe where rule = 'ghost' and addr_flip and true_addr = 8003 and bad_addr = 8035) = 7);
  perform pg_temp.check_that('a corrupted copy across midnight is found once, on the day it was heard, and left out of that day''s carrier',
    (select count(*) from _fe where true_addr = 8001 and true_value = 242) = 1
      and (select day = (heard_at at time zone 'UTC')::date from _fe where true_addr = 8001 and true_value = 242)
      and (select n from meganet.carrier_daily where ingest_token_id = (select id from _tok) and tx = 'st:chk_f8001'
             and day = (now() at time zone 'UTC')::date - 4) = 8);
  perform pg_temp.check_that('…the true reading kept as the true one, the bits counted',
    not exists (select 1 from _fe where bad_value <> (true_value # 512) and bad_value <> (true_value # 256) and not addr_flip)
      and (select bool_and(bits = 1) from _fe));
  perform pg_temp.check_that('two real reports in two seconds, and one station''s two sensors in one burst, are not flips',
    not exists (select 1 from _fe where true_addr in (8006, 8010, 8011) or bad_addr in (8006, 8010, 8011)));
  v := (select detail -> 'flips' from meganet.carrier_receiver_day where ingest_token_id = (select id from _tok)
         and day = (now() at time zone 'UTC')::date - 2);
  perform pg_temp.check_that('…and each receiver''s day says so: pairs, decided, not flips',
    (v ->> 'not_flips')::int = 2 and (v -> 'by_rule' ->> 'rapid')::int = 1 and (v -> 'by_rule' ->> 'same-station')::int = 1
      and (v ->> 'decided')::int >= 6, coalesce(v::text, '<none>'));

  -- ── Who sent them ──────────────────────────────────────────────────────────
  perform pg_temp.check_that('R2''s corrupted copies are put down to R2, by its carrier — not split with R1, which passes the same stations',
    (select count(*) from _fe where bad_tx = 'st:chk_fr2') = 21 and not exists (select 1 from _fe where bad_tx = 'st:chk_fr1'));
  perform pg_temp.check_that('…and each of them reached us clean from upstream too (the station or R1): the corruption entered at R2',
    (select bool_and(good_tx is not null and good_tx <> 'st:chk_fr2') from _fe where bad_tx = 'st:chk_fr2'));
  perform pg_temp.check_that('the station misheard direct is its own, and weak',
    (select bool_and(bad_tx = 'st:chk_f8004' and bad_snr < 15) from _fe where true_addr = 8004) and (select count(*) from _fe where true_addr = 8004) = 7
      and (select clean_upstream = 0 from meganet.flip_summary where tx = 'st:chk_f8004'));
  perform pg_temp.check_that('one on a carrier nobody has is unmatched; one with no carrier is said to have none',
    (select count(*) from _fe where bad_how = 'unmatched' and true_addr = 8005) = 7
      and (select count(*) from _fe where bad_how = 'no-carrier' and true_addr = 8002) = 7);
  perform pg_temp.check_that('a corrupted copy is left out of its carrier: the station misheard once a day keeps its own seven',
    (select bool_and(n = 7 and n_out = 0) from meganet.carrier_daily where ingest_token_id = (select id from _tok) and tx = 'st:chk_f8004'),
    (select string_agg(format('%s n=%s', day, n), '; ') from meganet.carrier_daily where ingest_token_id = (select id from _tok) and tx = 'st:chk_f8004'));
  perform pg_temp.check_that('a corrupted copy is left out of the carriers: no transmitter under the address it was corrupted to',
    not exists (select 1 from meganet.carrier_daily where ingest_token_id = (select id from _tok) and tx in ('a:8035', 'st:chk_f8035'))
      and (select bool_and(not mixed) from meganet.carrier_daily where ingest_token_id = (select id from _tok) and tx in ('st:chk_f8001', 'st:chk_f8002', 'st:chk_fr2')));

  -- ── The finding ────────────────────────────────────────────────────────────
  select * into f from meganet.health_finding where source = 'transmitters' and kind = 'transmitter-corrupting'
     and subject = 'st:chk_fr2' and cleared_at is null;
  -- The summary's week is the last seven days, today among them: six of ours.
  perform pg_temp.check_that('R2 is a transmitter-corrupting finding, on its station, with its numbers',
    f.id is not null and f.station_id = 'chk_fr2' and (f.evidence ->> 'flips')::int = 18 and (f.evidence ->> 'clear')::int = 18
      and (f.evidence ->> 'clean_upstream')::int = 18 and f.title like 'Check flip R2: 18 corrupted copies in a week%',
    coalesce(f.title, '<none>') || ' ' || coalesce(f.evidence::text, ''));
  perform pg_temp.check_that('…R1, the stations, and the one misheard weakly (6 dB against the clean copy''s 14) are not',
    not exists (select 1 from meganet.health_finding where source = 'transmitters' and kind = 'transmitter-corrupting' and cleared_at is null
                 and subject in ('st:chk_fr1', 'st:chk_f8001', 'st:chk_f8002', 'st:chk_f8003', 'st:chk_f8004', 'st:chk_f8005')));
  perform pg_temp.check_that('flip_summary has R2''s rate and its commonest corruptions, R1 at nothing',
    (select flips = 18 and rate between 0.05 and 0.08 and top @> '[{"true_addr": 8003, "bad_addr": 8035}]'::jsonb
       from meganet.flip_summary where tx = 'st:chk_fr2')
      and (select flips = 0 from meganet.flip_summary where tx = 'st:chk_fr1')
      and (select flips = 6 and clear = 0 from meganet.flip_summary where tx = 'st:chk_f8004'),
    (select format('%s %s %s', flips, rate, top) from meganet.flip_summary where tx = 'st:chk_fr2'));
  perform pg_temp.check_that('recent_flips() lists them, by address or by sender, without a receiver',
    (select count(*) from meganet.recent_flips(7, 8003, null)) = 6
      and (select count(*) from meganet.recent_flips(7, null, 'st:chk_fr2')) = 18);
  v := meganet.flip_overview(7);
  perform pg_temp.check_that('flip_overview() counts them, by how their sender was found',
    (v ->> 'corrupted')::int >= 36 and (v -> 'by_how' ->> 'unmatched')::int >= 6 and (v -> 'by_how' ->> 'no-carrier')::int >= 6
      and (v ->> 'weak')::int >= 6, v::text);
  perform pg_temp.check_that('rolling a day up again replaces its flips, not adds to them',
    (select (meganet.roll_up_carriers_day((now() at time zone 'UTC')::date - 3) ->> 'flips')::int) = 6
      and (select count(*) from meganet.flip_event where ingest_token_id = (select id from _tok) and day = (now() at time zone 'UTC')::date - 3) = 6);
end
$$;

-- Who may.
do $$
declare v text;
begin
  v := pg_temp.as_role('anon', '{"role":"anon"}', $q$select count(*)::text from meganet.flip_summary where tx like 'st:chk\_f%'$q$);
  perform pg_temp.check_that('anyone may read flip_summary (no receiver named)', v not like 'ERROR %' and v::int > 0, v);
  v := pg_temp.as_role('anon', '{"role":"anon"}', $q$select count(*)::text from meganet.recent_flips(7, 8003, null)$q$);
  perform pg_temp.check_that('…and recent_flips()', v = '6', v);
  v := pg_temp.as_role('anon', '{"role":"anon"}', $q$select count(*)::text from meganet.flip_event$q$);
  perform pg_temp.check_that('…but not flip_event, which names receivers', v like 'ERROR %' or v = '0', v);
  perform pg_temp.check_that('nobody but the owner and the service key attributes a burst by its carrier',
    not has_function_privilege('anon', 'meganet.carrier_tx(date, bigint, text, integer, double precision, double precision)', 'execute'));
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
