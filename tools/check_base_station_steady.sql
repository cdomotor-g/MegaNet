-- check_base_station_steady.sql — Prove 0111, 0112 and 0114: a base station's spectrum folded
-- by the hour — per stick and tuning, each bin's lowest tenth and its median,
-- closed hours only, from a watermark, once — and what comes in through each
-- base station from the reception rollups: messages and stations by protocol,
-- the register's and the ones only it hears, per receiver and per day, drive
-- surveys left out — and administrators the only callers.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_base_station_steady.sql
--
-- One row per claim, a non-zero exit if any fails, and the whole script in a
-- transaction that rolls back, so it is safe against the live database. Its
-- IDs (8271–8279, ALERT2 65511–65519) are ones the register does not use.

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

-- One statement as another role with a request's claims: its first column as
-- text, or 'ERROR <sqlstate>'. Rolled back.
create or replace function pg_temp.as_role(p_role text, p_claims text, p_sql text)
returns text language plpgsql as $$
declare
  v text;
begin
  begin
    execute pg_catalog.format('set local role %I', p_role);
    perform pg_catalog.set_config('request.jwt.claims', p_claims, true);
    execute p_sql into v;
    raise exception using errcode = 'MNRLC', message = coalesce(v, '<null>');
  exception
    when sqlstate 'MNRLC' then return sqlerrm;
    when others then return 'ERROR ' || sqlstate;
  end;
end;
$$;

insert into meganet.editor_allow (entry, note) values
  ('bs-editor@example.test', 'check_base_station_steady — rolled back'),
  ('bs-admin@example.test',  'check_base_station_steady — rolled back')
on conflict (entry) do nothing;
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000b5801', 'bs-editor@example.test', now()),
  ('00000000-0000-4000-8000-0000000b5802', 'bs-admin@example.test', now())
on conflict (id) do nothing;
update meganet.app_user set role = 'admin' where id = '00000000-0000-4000-8000-0000000b5802';

create temporary table _ctx (k text primary key, v text) on commit drop;
grant select on _ctx to anon, authenticated;
create or replace function pg_temp.ctx(p_k text) returns text language sql as $$ select v from _ctx where k = p_k $$;

-- ── The register: one station holding legacy 8271 and ALERT2 65511 ──────────

insert into meganet.station (id, ord, name, lat, lon, roles, owner, alert2_station_id) values
  ('_check_bs_gauge', -971, 'Check Steady Gauge', -31.65, 161.15, '{}', null, 65511),
  ('_check_bs_host',  -972, 'Check Steady Host',  -31.60, 161.10, '{}', null, null)
on conflict (id) do nothing;
insert into meganet.sensor (station_id, sensor_id, type, ord, alert_id) values
  ('_check_bs_gauge', 'r1', 'rain', 1, 8271)
on conflict do nothing;

do $$
declare
  j jsonb;
  k jsonb;
begin
  j := meganet.create_ingest_token('_check bs one', '_check_bs_host');
  k := meganet.create_ingest_token('_check bs two', null);
  insert into _ctx values ('id', j ->> 'id'), ('id2', k ->> 'id');
end
$$;

insert into meganet.base_station (ingest_token_id, app, version, mode, idle_s, status, status_at, beat, beat_at, first_seen_at, last_seen_at, checkins)
values (pg_temp.ctx('id')::bigint, 'RPi ALERT', '0.22.0', 'manage', 60, '{}', now(), '{}', now(), now(), now(), 1);

-- ── Spectrum rows ───────────────────────────────────────────────────────────
-- Three hours ago, twenty rows of 64 bins on one tuning: bin 10 at 60 in every
-- row (a carrier), bin 20 at 80 in eleven rows of the twenty (busy, not
-- constant), everything else at 4. Two more rows the same hour on another
-- centre (the stick was retuned). And three rows in the hour still open.

insert into meganet.base_station_spectrum (ingest_token_id, rx_key, at, span_s, center_hz, rate, floor_db, bins)
select pg_temp.ctx('id')::bigint, 'sdr-1', pg_catalog.date_trunc('hour', now()) - interval '3 hours' + g * interval '2 minutes',
       60, 151500000, 240000, -40 - (g % 2),
       pg_catalog.set_byte(pg_catalog.set_byte(pg_catalog.decode(pg_catalog.repeat('04', 64), 'hex'), 10, 60), 20, case when g < 11 then 80 else 4 end)
  from pg_catalog.generate_series(0, 19) g;
insert into meganet.base_station_spectrum (ingest_token_id, rx_key, at, span_s, center_hz, rate, floor_db, bins)
select pg_temp.ctx('id')::bigint, 'sdr-1', pg_catalog.date_trunc('hour', now()) - interval '3 hours' + interval '50 minutes' + g * interval '1 minute',
       60, 151600000, 240000, -40, pg_catalog.decode(pg_catalog.repeat('06', 64), 'hex')
  from pg_catalog.generate_series(0, 1) g;
insert into meganet.base_station_spectrum (ingest_token_id, rx_key, at, span_s, center_hz, rate, floor_db, bins)
select pg_temp.ctx('id')::bigint, 'sdr-1', pg_catalog.date_trunc('hour', now()) + g * interval '1 second',
       60, 151500000, 240000, -40, pg_catalog.decode(pg_catalog.repeat('08', 64), 'hex')
  from pg_catalog.generate_series(0, 2) g;

-- An hour folded a hundred days ago: past what is kept.
insert into meganet.base_station_spectrum_hourly (bucket, ingest_token_id, rx_key, center_hz, rate, len, n, floor_db, low, mid)
values (pg_catalog.date_trunc('hour', now()) - interval '100 days', pg_temp.ctx('id')::bigint, 'sdr-1', 151500000, 240000, 16, 60, -40,
        pg_catalog.decode(pg_catalog.repeat('00', 16), 'hex'), pg_catalog.decode(pg_catalog.repeat('00', 16), 'hex'));

-- As if nothing had been folded yet.
delete from meganet.app_meta where key = 'spectrum_rolled_to';

do $$
declare
  admin  text := '{"role":"authenticated","email":"bs-admin@example.test","sub":"00000000-0000-4000-8000-0000000b5802"}';
  editor text := '{"role":"authenticated","email":"bs-editor@example.test","sub":"00000000-0000-4000-8000-0000000b5801"}';
  id     bigint := pg_temp.ctx('id')::bigint;
  r  jsonb;
  r2 jsonb;
  h  meganet.base_station_spectrum_hourly;
  b  jsonb;
  x  jsonb;
begin
  r := meganet.roll_up_spectrum(6);
  perform pg_temp.check_that('a run folds at most the hours it was given, oldest first, and says more are waiting',
    (r ->> 'hours')::int = 6 and (r ->> 'pending')::boolean, r::text);
  r := meganet.roll_up_spectrum(48);
  perform pg_temp.check_that('…and the next takes up where it stopped, to the hour now open',
    (r ->> 'hours')::int = 41 and not (r ->> 'pending')::boolean
    and (r ->> 'to')::timestamptz = pg_catalog.date_trunc('hour', now()), r::text);

  select * into h from meganet.base_station_spectrum_hourly t
   where t.ingest_token_id = id and t.center_hz = 151500000 and t.bucket = pg_catalog.date_trunc('hour', now()) - interval '3 hours';
  perform pg_temp.check_that('an hour of a stick''s rows is one row: how many, their mean floor, a byte a bin',
    h.n = 20 and h.floor_db = -40.5 and h.len = 64 and pg_catalog.octet_length(h.low) = 64 and pg_catalog.octet_length(h.mid) = 64,
    pg_catalog.format('n %s floor %s len %s', h.n, h.floor_db, h.len));
  perform pg_temp.check_that('a bin lit in every row stays in the lowest tenth and the median',
    pg_catalog.get_byte(h.low, 10) = 60 and pg_catalog.get_byte(h.mid, 10) = 60, pg_catalog.encode(h.low, 'hex'));
  perform pg_temp.check_that('a bin lit in eleven rows of twenty is in the median, not the lowest tenth',
    pg_catalog.get_byte(h.low, 20) = 4 and pg_catalog.get_byte(h.mid, 20) = 80, pg_catalog.encode(h.mid, 'hex'));
  perform pg_temp.check_that('a quiet bin stays at the floor in both',
    pg_catalog.get_byte(h.low, 30) = 4 and pg_catalog.get_byte(h.mid, 30) = 4);
  perform pg_temp.check_that('a stick retuned inside the hour is two rows, a tuning each',
    (select pg_catalog.count(*) from meganet.base_station_spectrum_hourly t
      where t.ingest_token_id = id and t.bucket = pg_catalog.date_trunc('hour', now()) - interval '3 hours') = 2
    and exists (select 1 from meganet.base_station_spectrum_hourly t where t.ingest_token_id = id and t.center_hz = 151600000 and t.n = 2));
  perform pg_temp.check_that('the hour still open is not folded',
    not exists (select 1 from meganet.base_station_spectrum_hourly t where t.ingest_token_id = id and t.bucket >= pg_catalog.date_trunc('hour', now())));
  perform pg_temp.check_that('an hour past ninety days is dropped',
    not exists (select 1 from meganet.base_station_spectrum_hourly t where t.ingest_token_id = id and t.bucket < now() - interval '91 days'));

  r := meganet.roll_up_spectrum(48);
  perform pg_temp.check_that('a run with nothing new folds nothing, and leaves what is there',
    (r ->> 'hours')::int = 0 and (select pg_catalog.count(*) from meganet.base_station_spectrum_hourly t where t.ingest_token_id = id) = 2, r::text);

  -- ── What an administrator reads ──────────────────────────────────────────
  b := pg_temp.as_role('authenticated', admin, pg_catalog.format('select meganet.admin_base_station_bands(%s, 2)::text', id))::jsonb;
  select e into x from jsonb_array_elements(b -> 'rows') e where (e ->> 'center_hz')::bigint = 151500000;
  perform pg_temp.check_that('the panel gets the hours: stick, tuning, rows folded, floor, and both lines in base64',
    jsonb_array_length(b -> 'rows') = 2 and (x ->> 'n')::int = 20 and x ->> 'key' = 'sdr-1' and (x ->> 'rate')::int = 240000
    and (x ->> 'floor_db')::numeric = -40.5
    and pg_catalog.get_byte(pg_catalog.decode(x ->> 'low', 'base64'), 10) = 60
    and pg_catalog.get_byte(pg_catalog.decode(x ->> 'mid', 'base64'), 20) = 80
    and (x ->> 't')::bigint = extract(epoch from pg_catalog.date_trunc('hour', now()) - interval '3 hours')::bigint, b::text);
  perform pg_temp.check_that('…where the station is (its host station''s, when it has not said), and how far the hours are folded',
    (b -> 'site' ->> 'lat')::numeric = -31.6 and (b ->> 'to')::timestamptz = pg_catalog.date_trunc('hour', now()), b - 'rows' #>> '{}');
  perform pg_temp.check_that('the window is one to seven days',
    (pg_temp.as_role('authenticated', admin, pg_catalog.format('select meganet.admin_base_station_bands(%s, 99) ->> ''days''', id)))::int = 7
    and (pg_temp.as_role('authenticated', admin, pg_catalog.format('select meganet.admin_base_station_bands(%s, 0) ->> ''days''', id)))::int = 1);
  perform pg_temp.check_that('a token there is not is refused',
    pg_temp.as_role('authenticated', admin, 'select meganet.admin_base_station_bands(-5, 2)::text') = 'ERROR 22023');
  perform pg_temp.check_that('an editor who is not an administrator is refused both, and an anonymous caller',
    pg_temp.as_role('authenticated', editor, pg_catalog.format('select meganet.admin_base_station_bands(%s, 2)::text', id)) = 'ERROR 42501'
    and pg_temp.as_role('authenticated', editor, 'select meganet.admin_base_station_ingest(7)::text') = 'ERROR 42501'
    and pg_temp.as_role('anon', '{"role":"anon"}', 'select meganet.admin_base_station_ingest(7)::text') like 'ERROR %'
    and pg_temp.as_role('anon', '{"role":"anon"}', pg_catalog.format('select meganet.admin_base_station_bands(%s, 2)::text', id)) like 'ERROR %');
  perform pg_temp.check_that('nobody but the scheduler folds the hours, and nobody reads the table',
    pg_temp.as_role('authenticated', admin, 'select meganet.roll_up_spectrum(1)::text') like 'ERROR %'
    and pg_temp.as_role('authenticated', admin, 'select pg_catalog.count(*)::text from meganet.base_station_spectrum_hourly') like 'ERROR %');
end
$$;

-- ── What came in, as roll_up_receptions() leaves it ─────────────────────────

create or replace function pg_temp.hour(p_tok text, p_ago integer, p_point text, p_proto text, p_station integer,
                                        p_n integer, p_ok integer, p_und integer, p_survey text default null)
returns void language sql as $$
  insert into meganet.reception_hourly (bucket, ingest_token_id, point_id, protocol, station, path, survey,
    n, n_ok, n_bad, n_dup, n_rejected, n_undecoded, n_shadow, n_status, n_frame, n_crc,
    snr_n, nf_dbfs_n, nf_dbm_n, rssi_n, level_n, cfo_n, freq_min, freq_max, first_heard, last_heard)
  values (pg_catalog.date_trunc('hour', now()) - p_ago * interval '1 hour', pg_temp.ctx(p_tok)::bigint, p_point, p_proto, p_station, null, p_survey,
    p_n, p_ok, p_n - p_ok - p_und, 0, 0, p_und, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 151.5, 151.5,
    pg_catalog.date_trunc('hour', now()) - p_ago * interval '1 hour' + interval '5 minutes',
    pg_catalog.date_trunc('hour', now()) - p_ago * interval '1 hour' + interval '50 minutes');
$$;

do $$
begin
  perform pg_temp.hour('id',  2,  'rpi-s-sdr1', 'alert', 8271, 10, 9, 0);    -- the register's, and the other base station decodes it too
  perform pg_temp.hour('id',  30, 'rpi-s-sdr1', 'alert', 8271, 5, 5, 0);     -- …a day earlier
  perform pg_temp.hour('id',  2,  'rpi-s-sdr1', 'alert', 8273, 6, 6, 0);     -- not the register's, heard only here
  perform pg_temp.hour('id',  2,  'rpi-s-sdr1', 'alert', 8274, 2, 2, 0);     -- decoded twice: not counted
  perform pg_temp.hour('id',  2,  'rpi-s-sdr1', 'alert', null, 7, 0, 7);     -- undecoded bursts
  perform pg_temp.hour('id',  3,  'rpi-s-sdr2', 'alert2', 65511, 20, 20, 0); -- ALERT2, the register's, on the second stick
  perform pg_temp.hour('id',  2,  'rpi-s-sdr1', 'alert', 8279, 50, 50, 0, 'a-drive');  -- a drive survey: not a base station's ingest
  perform pg_temp.hour('id2', 2,  'rpi-t-sdr1', 'alert', 8271, 4, 4, 0);     -- the other base station
  perform pg_temp.hour('id',  400, 'rpi-s-sdr1', 'alert', 8275, 3, 3, 0);    -- 17 days ago: outside a week
  -- 0112: the ALERT2 came through a repeater the register knows and one it does not
  update meganet.reception_hourly set path = '{65511,64999}'
   where ingest_token_id = pg_temp.ctx('id')::bigint and protocol = 'alert2';
end
$$;

insert into meganet.reception_daily (bucket, ingest_token_id, point_id, protocol, station, path, survey,
  n, n_ok, n_bad, n_dup, n_rejected, n_undecoded, n_shadow, n_status, n_frame, n_crc,
  snr_n, nf_dbfs_n, nf_dbm_n, rssi_n, level_n, cfo_n, freq_min, freq_max, first_heard, last_heard)
values ((now() at time zone 'UTC')::date - 17, pg_temp.ctx('id')::bigint, 'rpi-s-sdr1', 'alert', 8275, null, null,
  3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 151.5, 151.5, now() - interval '17 days', now() - interval '17 days');

do $$
declare
  admin text := '{"role":"authenticated","email":"bs-admin@example.test","sub":"00000000-0000-4000-8000-0000000b5802"}';
  r  jsonb;
  s  jsonb;
  s2 jsonb;
  a  jsonb;
  a2 jsonb;
  n  jsonb;
begin
  r := pg_temp.as_role('authenticated', admin, 'select meganet.admin_base_station_ingest(7)::text')::jsonb;
  select e into s  from jsonb_array_elements(r -> 'stations') e where e ->> 'id' = pg_temp.ctx('id');
  select e into s2 from jsonb_array_elements(r -> 'stations') e where e ->> 'id' = pg_temp.ctx('id2');
  select e into a  from jsonb_array_elements(s -> 'protocols') e where e ->> 'protocol' = 'alert';
  select e into a2 from jsonb_array_elements(s -> 'protocols') e where e ->> 'protocol' = 'alert2';

  perform pg_temp.check_that('a base station a row, with its label and where it is hosted',
    s ->> 'label' = '_check bs one' and s ->> 'host_station' = 'Check Steady Host' and s2 is not null, r::text);
  perform pg_temp.check_that('legacy ALERT and ALERT2 are counted apart: heard, decoded, undecoded',
    (a ->> 'n')::int = 30 and (a ->> 'ok')::int = 22 and (a ->> 'undecoded')::int = 7
    and (a2 ->> 'n')::int = 20 and (a2 ->> 'ok')::int = 20, s -> 'protocols' #>> '{}');
  perform pg_temp.check_that('a station counts once decoded three times: two here, one of them the register''s',
    (a ->> 'ids')::int = 2 and (a ->> 'known')::int = 1, a::text);
  perform pg_temp.check_that('…and one no other base station decoded',
    (a ->> 'only_here')::int = 1 and (a2 ->> 'only_here')::int = 1, a::text);
  perform pg_temp.check_that('an ALERT2 source is the register''s by its ALERT2 address',
    (a2 ->> 'ids')::int = 1 and (a2 ->> 'known')::int = 1, a2::text);
  perform pg_temp.check_that('a drive survey''s receptions are not a base station''s ingest',
    not exists (select 1 from jsonb_array_elements(s -> 'receivers') e where (e ->> 'n')::int >= 50), s -> 'receivers' #>> '{}');
  perform pg_temp.check_that('a receiver and protocol a row under it',
    jsonb_array_length(s -> 'receivers') = 2
    and exists (select 1 from jsonb_array_elements(s -> 'receivers') e where e ->> 'point_id' = 'rpi-s-sdr2' and e ->> 'protocol' = 'alert2' and (e ->> 'ok')::int = 20 and (e ->> 'ids')::int = 1),
    s -> 'receivers' #>> '{}');
  perform pg_temp.check_that('decoded messages a UTC day, legacy and ALERT2 apart',
    (select pg_catalog.sum((e ->> 1)::int) from jsonb_array_elements(s -> 'days') e) = 22
    and (select pg_catalog.sum((e ->> 2)::int) from jsonb_array_elements(s -> 'days') e) = 20, s -> 'days' #>> '{}');
  -- 0112: station by station, by path, and the day's own numbers
  perform pg_temp.check_that('each counted station is named: the register''s with its station and sensor type, the stranger with neither',
    jsonb_array_length(s -> 'ids') = 3
    and (s -> 'ids') @> '[["alert", 8271, 14, "_check_bs_gauge", "rain", false]]'::jsonb
    and (s -> 'ids') @> '[["alert", 8273, 6, null, null, true]]'::jsonb
    and (s -> 'ids') @> '[["alert2", 65511, 20, "_check_bs_gauge", null, true]]'::jsonb
    and not (s -> 'ids')::text like '%8274%', s -> 'ids' #>> '{}');
  perform pg_temp.check_that('ALERT2 by the repeaters it came through, named where the register has the address',
    jsonb_array_length(s -> 'paths') = 1
    and (s -> 'paths' -> 0 -> 'path') = '[65511, 64999]'::jsonb and (s -> 'paths' -> 0 ->> 'ok')::int = 20 and (s -> 'paths' -> 0 ->> 'ids')::int = 1
    and (s -> 'paths' -> 0 -> 'names') = '["Check Steady Gauge", null]'::jsonb, s -> 'paths' #>> '{}');
  perform pg_temp.check_that('a day also says what was heard and how many stations, each protocol apart',
    (select pg_catalog.sum((e ->> 4)::int) from jsonb_array_elements(s -> 'days') e) = 30
    and (select pg_catalog.sum((e ->> 5)::int) from jsonb_array_elements(s -> 'days') e) = 20
    and (select pg_catalog.max((e ->> 6)::int) from jsonb_array_elements(s -> 'days') e) = 3
    and (select pg_catalog.max((e ->> 7)::int) from jsonb_array_elements(s -> 'days') e) = 1, s -> 'days' #>> '{}');
  -- 0114: the ones the register does not hold, and where the base station is
  perform pg_temp.check_that('a station the register does not hold is laid out: decoded and heard, its frequency, its receiver, when',
    jsonb_array_length(s -> 'strangers') = 1
    and (s -> 'strangers' -> 0) @> '{"protocol": "alert", "id": 8273, "ok": 6, "n": 6, "days": 1, "only_here": true, "fmin": 151.5, "fmax": 151.5}'::jsonb
    and (s -> 'strangers' -> 0 -> 'points') = '[["rpi-s-sdr1", 6, 151.5, 151.5, null]]'::jsonb
    and (s -> 'strangers' -> 0 ->> 'first')::timestamptz < (s -> 'strangers' -> 0 ->> 'last')::timestamptz
    and (s -> 'strangers' -> 0 -> 'paths') = 'null'::jsonb, s -> 'strangers' #>> '{}');
  perform pg_temp.check_that('…and the base station says where it is: its host station, having reported no position',
    (s -> 'site' ->> 'lat')::numeric = -31.60 and (s -> 'site' ->> 'lon')::numeric = 161.10 and (s2 -> 'site') = 'null'::jsonb, (s -> 'site')::text || (s2 -> 'site')::text);
  select e into n from jsonb_array_elements(r -> 'network') e where e ->> 'protocol' = 'alert';
  perform pg_temp.check_that('the network''s own count takes a station heard by two base stations once',
    (n ->> 'ids')::int < (select pg_catalog.sum((p ->> 'ids')::int) from jsonb_array_elements(r -> 'stations') e, jsonb_array_elements(e -> 'protocols') p
                           where p ->> 'protocol' = 'alert')
    and (n ->> 'ids')::int >= 2 and (n ->> 'known')::int >= 1, r -> 'network' #>> '{}');
  perform pg_temp.check_that('a week does not reach seventeen days back',
    not (s -> 'days')::text like '%' || ((now() at time zone 'UTC')::date - 17)::text || '%');

  r := pg_temp.as_role('authenticated', admin, 'select meganet.admin_base_station_ingest(30)::text')::jsonb;
  select e into s from jsonb_array_elements(r -> 'stations') e where e ->> 'id' = pg_temp.ctx('id');
  perform pg_temp.check_that('a month is read from the daily rollup',
    (r ->> 'days')::int = 30 and (s -> 'days')::text like '%' || ((now() at time zone 'UTC')::date - 17)::text || '%', s::text);
end
$$;

-- ── The verdict ─────────────────────────────────────────────────────────────

select lpad(ord::text, 2) as "#",
       case when ok then 'ok  ' else 'FAIL' end as result,
       name,
       case when ok then '' else left(coalesce(note, ''), 300) end as detail
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
