-- check_base_station_channels.sql — Prove 0081: a base station's channels,
-- from the reception rollups — a frequency and a protocol a row, 151.5375 kept
-- to the tenth of a kHz, its IDs put down to the register's nearest station
-- (near, far or unknown, and only those decoded three times counted), the
-- register's frequencies around it, the window read by the hour or the day —
-- and administrators the only callers.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_base_station_channels.sql
--
-- One row per claim, a non-zero exit if any fails, and the whole script in a
-- transaction that rolls back, so it is safe against the live database. The
-- base station sits in the Tasman Sea (31.6 S, 161.1 E) and its IDs (8171–
-- 8179, ALERT2 65501–65509) are ones the register does not use, so nothing
-- real comes near it.

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
  ('bc-editor@example.test', 'check_base_station_channels — rolled back'),
  ('bc-admin@example.test',  'check_base_station_channels — rolled back')
on conflict (entry) do nothing;
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000bc801', 'bc-editor@example.test', now()),
  ('00000000-0000-4000-8000-0000000bc802', 'bc-admin@example.test', now())
on conflict (id) do nothing;
update meganet.app_user set role = 'admin' where id = '00000000-0000-4000-8000-0000000bc802';

create temporary table _ctx (k text primary key, v text) on commit drop;
grant select on _ctx to anon, authenticated;
create or replace function pg_temp.ctx(p_k text) returns text language sql as $$ select v from _ctx where k = p_k $$;

-- ── The register around it ──────────────────────────────────────────────────
-- A repeater 7 km away (RX 151.5, TX 152.4) holding legacy ID 8171 and ALERT2
-- source 65501; a station 1,700 km away holding 8171 too, and 8172 alone; a
-- link station 20 km away with a listed pair on 151.5375; a host station for
-- the second token, which says nothing of where it is.

insert into meganet.station (id, ord, name, lat, lon, roles, owner, alert2_station_id) values
  ('_check_bc_rptr', -981, 'Check Near Repeater', -31.65, 161.15, '{repeater}', 'Check Owner', 65501),
  ('_check_bc_far',  -982, 'Check Far Gauge',     -38.00, 146.50, '{}', null, null),
  ('_check_bc_link', -983, 'Check Link Hill',     -31.45, 161.20, '{}', null, null),
  ('_check_bc_host', -984, 'Check Host',          -31.60, 161.10, '{}', null, null)
on conflict (id) do nothing;
insert into meganet.sensor (station_id, sensor_id, type, ord, alert_id) values
  ('_check_bc_rptr', 'r1', 'rain', 1, 8171),
  ('_check_bc_far',  'r1', 'rain', 1, 8171),
  ('_check_bc_far',  'w1', 'level', 2, 8172)
on conflict do nothing;
insert into meganet.repeater (station_id, rx_mhz, tx_mhz, acma_licence) values ('_check_bc_rptr', 151.5, 152.4, '9990001/1')
on conflict (station_id) do update set rx_mhz = excluded.rx_mhz, tx_mhz = excluded.tx_mhz, acma_licence = excluded.acma_licence;
insert into meganet.station_frequency (station_id, ord, rx_mhz, tx_mhz, label, acma_licence)
values ('_check_bc_link', 1, 151.5375, 151.5375, 'Check link', '')
on conflict do nothing;

do $$
declare
  j jsonb;
  k jsonb;
begin
  j := meganet.create_ingest_token('_check bc one', null);
  k := meganet.create_ingest_token('_check bc two', '_check_bc_host');
  insert into _ctx values ('id', j ->> 'id'), ('id2', k ->> 'id');
end
$$;

-- It said where it is at its last check-in.
insert into meganet.base_station (ingest_token_id, app, version, mode, idle_s, status, status_at, beat, beat_at, first_seen_at, last_seen_at, checkins)
values (pg_temp.ctx('id')::bigint, 'RPi ALERT', '0.15.1', 'manage', 60,
        '{"location": {"lat": -31.6, "lon": 161.1, "source": "manual"}}', now(), '{}', now(), now(), now(), 1);

-- ── What it heard, as roll_up_receptions() leaves it ────────────────────────
-- An hour a row: (hours ago, point, protocol, station, n, n_ok, n_undecoded,
-- snr_n, snr_sum, freq).

create or replace function pg_temp.hour(p_ago integer, p_point text, p_proto text, p_station integer,
                                        p_n integer, p_ok integer, p_und integer, p_snr_n integer, p_snr_sum double precision, p_freq real)
returns void language sql as $$
  insert into meganet.reception_hourly (bucket, ingest_token_id, point_id, protocol, station, path, survey,
    n, n_ok, n_bad, n_dup, n_rejected, n_undecoded, n_shadow, n_status, n_frame, n_crc,
    snr_n, snr_min, snr_max, snr_sum, nf_dbfs_n, nf_dbm_n, rssi_n, level_n, cfo_n, freq_min, freq_max, first_heard, last_heard)
  values (pg_catalog.date_trunc('hour', now()) - p_ago * interval '1 hour', pg_temp.ctx('id')::bigint, p_point, p_proto, p_station, null, null,
    p_n, p_ok, p_n - p_ok - p_und, 0, 0, p_und, 0, 0, 0, 0,
    p_snr_n, case when p_snr_n > 0 then p_snr_sum / p_snr_n end, case when p_snr_n > 0 then p_snr_sum / p_snr_n + 2 end, p_snr_sum,
    0, 0, 0, 0, 0, p_freq, p_freq,
    pg_catalog.date_trunc('hour', now()) - p_ago * interval '1 hour' + interval '5 minutes',
    pg_catalog.date_trunc('hour', now()) - p_ago * interval '1 hour' + interval '50 minutes');
$$;

do $$
begin
  perform pg_temp.hour(2,  'rpi-x-sdr1', 'alert', 8171, 10, 9, 0, 9, 108, 151.5);    -- the near repeater's ID (and the far one's)
  perform pg_temp.hour(30, 'rpi-x-sdr1', 'alert', 8171, 5,  5, 0, 5, 50,  151.5);    -- …a day earlier
  perform pg_temp.hour(2,  'rpi-x-sdr1', 'alert', 8172, 4,  4, 0, 4, 40,  151.5);    -- only the far station holds it
  perform pg_temp.hour(2,  'rpi-x-sdr1', 'alert', 8173, 6,  6, 0, 6, 60,  151.5);    -- nobody holds it
  perform pg_temp.hour(2,  'rpi-x-sdr1', 'alert', 8174, 2,  2, 0, 2, 20,  151.5);    -- held by nobody, decoded twice: not counted
  perform pg_temp.hour(2,  'rpi-x-sdr1', 'alert', null, 7,  0, 7, 0, 0,   151.5);    -- undecoded bursts
  perform pg_temp.hour(3,  'rpi-x-sdr1', 'alert2', 65501, 20, 20, 0, 20, 400, 151.5); -- ALERT2 on the same frequency
  perform pg_temp.hour(2,  'rpi-x-sdr1-151.5375', 'alert2', 65509, 30, 30, 0, 30, 570, 151.5375);
  perform pg_temp.hour(400, 'rpi-x-sdr1', 'alert', 8175, 3, 3, 0, 3, 30, 151.95);    -- 17 days ago: outside a week
end
$$;

-- …and a day of it in the daily rollup, for a window longer than 14 days.
insert into meganet.reception_daily (bucket, ingest_token_id, point_id, protocol, station, path, survey,
  n, n_ok, n_bad, n_dup, n_rejected, n_undecoded, n_shadow, n_status, n_frame, n_crc,
  snr_n, snr_sum, nf_dbfs_n, nf_dbm_n, rssi_n, level_n, cfo_n, freq_min, freq_max, first_heard, last_heard)
values ((now() at time zone 'UTC')::date - 17, pg_temp.ctx('id')::bigint, 'rpi-x-sdr1', 'alert', 8175, null, null,
  3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 3, 30, 0, 0, 0, 0, 0, 151.95, 151.95, now() - interval '17 days', now() - interval '17 days');

-- ── What an administrator reads ─────────────────────────────────────────────

do $$
declare
  admin text := '{"role":"authenticated","email":"bc-admin@example.test","sub":"00000000-0000-4000-8000-0000000bc802"}';
  r jsonb;
  a jsonb;
  a2 jsonb;
  l jsonb;
  t jsonb;
  g jsonb;
begin
  r := pg_temp.as_role('authenticated', admin, pg_catalog.format('select meganet.admin_base_station_channels(%s, 7)::text', pg_temp.ctx('id')))::jsonb;
  select x into a  from jsonb_array_elements(r -> 'channels') x where x ->> 'f' = '151.5000' and x ->> 'protocol' = 'alert';
  select x into a2 from jsonb_array_elements(r -> 'channels') x where x ->> 'f' = '151.5000' and x ->> 'protocol' = 'alert2';
  select x into l  from jsonb_array_elements(r -> 'channels') x where x ->> 'protocol' = 'alert2' and x ->> 'f' like '151.53%';

  perform pg_temp.check_that('a channel is a frequency and a protocol: ALERT and ALERT2 on 151.5 are two rows, and a week holds three',
    a is not null and a2 is not null and jsonb_array_length(r -> 'channels') = 3, r::text);
  perform pg_temp.check_that('…its counts are the rollup''s sums: heard, decoded, undecoded',
    (a ->> 'n')::int = 34 and (a ->> 'ok')::int = 26 and (a ->> 'undecoded')::int = 7, a::text);
  perform pg_temp.check_that('…its SNR the mean of every decode''s, from the sums (278 / 26)',
    (a ->> 'snr')::numeric = 10.7, a ->> 'snr');
  perform pg_temp.check_that('…the hours it was heard in, and its receivers',
    (a ->> 'buckets')::int = 2 and a -> 'points' = '["rpi-x-sdr1"]'::jsonb, a::text);
  perform pg_temp.check_that('151.5375 comes back as 151.5375, not the 151.538 a real prints',
    l ->> 'f' = '151.5375', coalesce(l ->> 'f', r::text));
  perform pg_temp.check_that('a day a row: what was heard and decoded each UTC day',
    jsonb_array_length(a -> 'days') = 2 and (a -> 'days' -> 1 ->> 1)::int + (a -> 'days' -> 0 ->> 1)::int = 34, a -> 'days' ->> 0);

  perform pg_temp.check_that('an ID held by two stations is put down to the nearer, with how many hold it',
    exists (select 1 from jsonb_array_elements(a -> 'top') e where (e ->> 0)::int = 8171 and e ->> 4 = '_check_bc_rptr'
                                                                 and (e ->> 7)::int between 5 and 9 and (e ->> 8)::int = 2), a -> 'top' ->> 0);
  perform pg_temp.check_that('…an ID only a station 1,700 km away holds is another network''s: far, and listed',
    (a -> 'ids' ->> 'far')::int = 1 and (a -> 'far' -> 0 ->> 0)::int = 8172 and (a -> 'far' -> 0 ->> 7)::int > 1500, a -> 'ids' ->> 'far');
  perform pg_temp.check_that('…an ID nobody holds is unknown, and listed',
    (a -> 'ids' ->> 'unknown')::int = 1 and (a -> 'unknown' -> 0 ->> 0)::int = 8173, a::text);
  perform pg_temp.check_that('…one decoded only twice is heard but not counted',
    (a -> 'ids' ->> 'any')::int = 4 and (a -> 'ids' ->> 'counted')::int = 3 and (a -> 'ids' ->> 'near')::int = 1
      and (a -> 'ids' ->> 'unknown_ok')::int = 8, a ->> 'ids');
  perform pg_temp.check_that('an ALERT2 source is put down to the station whose ALERT2 address it is',
    (a2 -> 'top' -> 0 ->> 0)::int = 65501 and a2 -> 'top' -> 0 ->> 4 = '_check_bc_rptr' and (a2 -> 'ids' ->> 'near')::int = 1, a2::text);

  select x into g from jsonb_array_elements(r -> 'register') x where x ->> 'station_id' = '_check_bc_rptr' and x ->> 'dir' = 'tx';
  perform pg_temp.check_that('the register''s frequencies: a repeater''s TX, with its station, licence and distance',
    g ->> 'f' = '152.4000' and g ->> 'kind' = 'repeater' and g ->> 'licence' = '9990001/1' and (g ->> 'km')::int between 5 and 9
      and g ->> 'name' = 'Check Near Repeater', coalesce(g::text, r ->> 'register'));
  perform pg_temp.check_that('…its RX too, and a listed pair (an empty licence is none)',
    exists (select 1 from jsonb_array_elements(r -> 'register') x where x ->> 'station_id' = '_check_bc_rptr' and x ->> 'dir' = 'rx' and x ->> 'f' = '151.5000')
      and exists (select 1 from jsonb_array_elements(r -> 'register') x where x ->> 'station_id' = '_check_bc_link' and x ->> 'kind' = 'listed'
                    and x ->> 'f' = '151.5375' and x ->> 'label' = 'Check link' and x -> 'licence' = 'null'::jsonb),
    r ->> 'register');
  perform pg_temp.check_that('…and where the station is, the window and how it was read',
    (r -> 'site' ->> 'lat')::numeric = -31.6 and (r ->> 'days')::int = 7 and r ->> 'by' = 'hour'
      and (r ->> 'far_km')::int = 400 and (r ->> 'min_decodes')::int = 3 and r ->> 'to' is not null, r::text);

  t := pg_temp.as_role('authenticated', admin, pg_catalog.format('select meganet.admin_base_station_channels(%s, 30)::text', pg_temp.ctx('id')))::jsonb;
  perform pg_temp.check_that('thirty days are read by the day, and reach what a week does not',
    t ->> 'by' = 'day' and exists (select 1 from jsonb_array_elements(t -> 'channels') x where x ->> 'f' = '151.9500'), t::text);
  t := pg_temp.as_role('authenticated', admin, pg_catalog.format('select meganet.admin_base_station_channels(%s, 100000)::text', pg_temp.ctx('id')))::jsonb;
  perform pg_temp.check_that('…and the window is held to 1–90 days',
    (t ->> 'days')::int = 90
      and (pg_temp.as_role('authenticated', admin, pg_catalog.format('select meganet.admin_base_station_channels(%s, 0)::text', pg_temp.ctx('id')))::jsonb ->> 'days')::int = 1,
    t ->> 'days');

  t := pg_temp.as_role('authenticated', admin, pg_catalog.format('select meganet.admin_base_station_channels(%s, 7)::text', pg_temp.ctx('id2')))::jsonb;
  perform pg_temp.check_that('a token that never checked in: where its host station is, and no channels — an empty list',
    (t -> 'site' ->> 'lon')::numeric = 161.1 and t -> 'channels' = '[]'::jsonb, t::text);
  perform pg_temp.check_that('…and a token that does not exist is refused by name',
    pg_temp.as_role('authenticated', admin, 'select meganet.admin_base_station_channels(-1, 7)::text') = 'ERROR 22023');
end
$$;

-- ── Who may read it ─────────────────────────────────────────────────────────

do $$
declare
  editor text := '{"role":"authenticated","email":"bc-editor@example.test","sub":"00000000-0000-4000-8000-0000000bc801"}';
begin
  perform pg_temp.check_that('an editor is refused',
    pg_temp.as_role('authenticated', editor, pg_catalog.format('select meganet.admin_base_station_channels(%s, 7)::text', pg_temp.ctx('id'))) = 'ERROR 42501');
  perform pg_temp.check_that('anon is refused',
    pg_temp.as_role('anon', '{"role":"anon"}', pg_catalog.format('select meganet.admin_base_station_channels(%s, 7)::text', pg_temp.ctx('id'))) like 'ERROR 42%');
  perform pg_temp.check_that('geo_km: Brisbane to Sydney is about 730 km, and a missing point is null',
    meganet.geo_km(-27.47, 153.03, -33.87, 151.21) between 725 and 735 and meganet.geo_km(null, 153, -33, 151) is null);
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
