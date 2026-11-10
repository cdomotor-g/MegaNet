-- 0111_base_station_steady_signals.sql — What sits on a base station's
-- spectrum all the time, and what comes in through each base station. For the
-- Base Stations tab's Steady signals and What comes in through each panels.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0111_base_station_steady_signals.sql
--
-- Why this file exists
-- ────────────────────
-- In November 2026 the waterfalls (0068) of both running base stations showed
-- bright bands that never went away, at frequencies nobody could put a name
-- to. A waterfall shows them and says nothing about them: whether one is the
-- stick's own doing, the computer beside it, a licensed neighbour or something
-- that ought not to be there, and whether anything need be done. Telling them
-- apart takes days of looking, not an hour — is it there every minute, only
-- in daylight, since when, does the other stick see it — and the spectrum rows
-- are kept two days and folded, for the picture, to the strongest each bin
-- was. The strongest is the wrong fold for this: one burst a slice makes a
-- busy channel look like a carrier.
--
-- And nothing said, a base station a row, what each one brings in: how many
-- stations, how many messages, how much of it legacy ALERT and how much
-- ALERT2, what only that base station hears.
--
-- Five decisions.
--
-- **1. An hour a row, and the lowest tenth.** base_station_spectrum_hourly
-- keeps, for each stick and tuning, an hour of its rows as two lines: `low`,
-- the level each bin was at or above in nine rows of ten (the 10th percentile
-- of the rows' values), and `mid`, their median. A row is already the
-- strongest a bin was in its minute, so `low` well over the floor means
-- something was there in nearly every minute of the hour — a carrier, not
-- traffic — and `mid` high with `low` at the floor means busy, not constant.
-- Half-dB steps over each row's own floor, as the rows are. About 600 bytes a
-- stick an hour; ninety days kept, so "since when" and "only in daylight" can
-- be answered long after the rows have gone.
--
-- **2. A tuning is part of the key.** A stick's centre and window change when
-- its channels do. A band that stays on its frequency when the stick moves is
-- on the air; one that moves with the stick is made inside it. So an hour in
-- which a stick was retuned is two rows, never an average of two windows.
--
-- **3. Closed hours, from a watermark.** roll_up_spectrum() folds each hour
-- once it has closed — a spectrum row is stamped as it arrives, so none comes
-- late — from where the last run stopped (`app_meta` `spectrum_rolled_to`), at
-- most `p_max_hours` a run, reading each base station's rows by its index.
-- The first run takes in the two days there are. pg_cron hourly at minute 13.
--
-- **4. The judging is the tab's.** admin_base_station_bands() hands the hours
-- over; what is a band, what it probably is and what to do about it is worked
-- out in the browser (base-station-bands.js), beside the ACMA's licences and
-- the channel table it already has — where it can be tested and reworded
-- without a migration.
--
-- **5. Ingest from the rollups.** admin_base_station_ingest() reads
-- reception_hourly up to 14 days and reception_daily beyond (0071), as 0081
-- does, never `reception`: per base station and protocol, messages heard and
-- decoded, the stations decoded (three decodes before one counts, as 0081),
-- how many of them the register has, how many no other base station decoded,
-- the same per receiver, and a count a day.
--
-- Administrators only, like everything about a base station. Depends on 0049,
-- 0068, 0071 and 0081. tools/check_base_station_steady.sql proves it.

-- ── The hours ────────────────────────────────────────────────────────────────

create table if not exists meganet.base_station_spectrum_hourly (
  bucket           timestamptz  not null,
  ingest_token_id  bigint       not null references meganet.ingest_token (id),
  rx_key           text         not null,
  center_hz        bigint       not null,
  rate             integer      not null,
  -- Bins a row.
  len              integer      not null,
  -- Spectrum rows folded in.
  n                integer      not null,
  -- Their mean floor, in the stick's own dB.
  floor_db         real,
  -- A byte a bin, lowest frequency first, half-dB steps over the rows' own
  -- floors: the 10th percentile of the hour's rows, and their median.
  low              bytea        not null,
  mid              bytea        not null,
  rolled_at        timestamptz  not null default now(),

  primary key (ingest_token_id, bucket, rx_key, center_hz, rate, len)
);

comment on table meganet.base_station_spectrum_hourly is
  'Each SDR stick''s spectrum by the hour (0111): per stick and tuning, the level each bin was at or above in nine of the hour''s ten rows (low) and their median (mid), half-dB steps over the rows'' floors. What stays in `low` is there all the time. Ninety days kept. RLS on, no policy and no grant: written by roll_up_spectrum(), read through admin_base_station_bands().';

alter table meganet.base_station_spectrum_hourly enable row level security;

-- ── Folding the hours ────────────────────────────────────────────────────────

create or replace function meganet.roll_up_spectrum(p_max_hours integer default 12)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_to     timestamptz := pg_catalog.date_trunc('hour', pg_catalog.now());
  v_mark   timestamptz;
  v_h      timestamptz;
  v_hours  integer := 0;
  v_rows   integer := 0;
  v_n      integer;
  v_max    integer := greatest(1, least(48, coalesce(p_max_hours, 12)));
begin
  select case when m.value ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$' then m.value::timestamptz end
    into v_mark
    from meganet.app_meta m where m.key = 'spectrum_rolled_to';
  -- The rows are kept two days: nothing older is there to fold.
  v_h := greatest(coalesce(v_mark, '-infinity'::timestamptz), v_to - interval '47 hours');

  while v_h < v_to and v_hours < v_max loop
    with r as materialized (
      select p.ingest_token_id, p.rx_key, p.center_hz, p.rate, pg_catalog.octet_length(p.bins) as len, p.floor_db, p.bins
        from meganet.base_station b
        join meganet.base_station_spectrum p
          on p.ingest_token_id = b.ingest_token_id and p.at >= v_h and p.at < v_h + interval '1 hour'),
    g as (
      select r.ingest_token_id, r.rx_key, r.center_hz, r.rate, r.len,
             pg_catalog.count(*)::integer as n, pg_catalog.avg(r.floor_db)::real as floor_db
        from r group by r.ingest_token_id, r.rx_key, r.center_hz, r.rate, r.len),
    c as (
      select r.ingest_token_id, r.rx_key, r.center_hz, r.rate, r.len, i.i,
             percentile_disc(0.1) within group (order by pg_catalog.get_byte(r.bins, i.i)) as lo,
             percentile_disc(0.5) within group (order by pg_catalog.get_byte(r.bins, i.i)) as mid
        from r cross join lateral pg_catalog.generate_series(0, r.len - 1) as i(i)
       group by r.ingest_token_id, r.rx_key, r.center_hz, r.rate, r.len, i.i),
    j as (
      select c.ingest_token_id, c.rx_key, c.center_hz, c.rate, c.len,
             pg_catalog.decode(pg_catalog.string_agg(pg_catalog.lpad(pg_catalog.to_hex(c.lo), 2, '0'), '' order by c.i), 'hex') as low,
             pg_catalog.decode(pg_catalog.string_agg(pg_catalog.lpad(pg_catalog.to_hex(c.mid), 2, '0'), '' order by c.i), 'hex') as mid
        from c group by c.ingest_token_id, c.rx_key, c.center_hz, c.rate, c.len)
    insert into meganet.base_station_spectrum_hourly as t
      (bucket, ingest_token_id, rx_key, center_hz, rate, len, n, floor_db, low, mid)
    select v_h, g.ingest_token_id, g.rx_key, g.center_hz, g.rate, g.len, g.n, g.floor_db, j.low, j.mid
      from g join j using (ingest_token_id, rx_key, center_hz, rate, len)
    on conflict (ingest_token_id, bucket, rx_key, center_hz, rate, len) do update
      set n = excluded.n, floor_db = excluded.floor_db, low = excluded.low, mid = excluded.mid, rolled_at = pg_catalog.now();
    get diagnostics v_n = row_count;
    v_rows := v_rows + v_n;
    v_hours := v_hours + 1;
    v_h := v_h + interval '1 hour';
  end loop;

  insert into meganet.app_meta (key, value)
  values ('spectrum_rolled_to', pg_catalog.to_char(v_h at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
  on conflict (key) do update set value = excluded.value;

  delete from meganet.base_station_spectrum_hourly t where t.bucket < v_to - interval '90 days';

  return pg_catalog.jsonb_build_object('hours', v_hours, 'rows', v_rows, 'to', v_h, 'pending', v_h < v_to);
end;
$$;

comment on function meganet.roll_up_spectrum(integer) is
  'Folds each closed hour of base_station_spectrum into base_station_spectrum_hourly (0111): per stick and tuning, each bin''s 10th percentile and median. From the `spectrum_rolled_to` watermark, at most p_max_hours (1–48, default 12) a run; drops hours older than ninety days. pg_cron hourly at minute 13. Returns { hours, rows, to, pending }.';

-- ── The panel's call: a station's hours ──────────────────────────────────────

create or replace function meganet.admin_base_station_bands(p_id bigint, p_days integer default 2)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now   timestamptz := pg_catalog.now();
  v_days  integer := greatest(1, least(7, coalesce(p_days, 2)));
  v_from  timestamptz;
  v_lat   double precision;
  v_lon   double precision;
  v_rows  jsonb;
begin
  perform meganet.admin_require();
  if not exists (select 1 from meganet.ingest_token t where t.id = p_id) then
    raise exception 'no ingest token %', p_id using errcode = '22023';
  end if;
  v_from := pg_catalog.date_trunc('hour', v_now) - pg_catalog.make_interval(days => v_days);

  -- Where it is, as 0081 has it: what it last said, else its host station.
  select coalesce(case when pg_catalog.jsonb_typeof(b.status -> 'location' -> 'lat') = 'number' then (b.status -> 'location' ->> 'lat')::double precision end,
                  h.lat::double precision),
         coalesce(case when pg_catalog.jsonb_typeof(b.status -> 'location' -> 'lon') = 'number' then (b.status -> 'location' ->> 'lon')::double precision end,
                  h.lon::double precision)
    into v_lat, v_lon
    from meganet.ingest_token t
    left join meganet.base_station b on b.ingest_token_id = t.id
    left join meganet.station h on h.id = t.host_station_id
   where t.id = p_id;

  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           't', extract(epoch from s.bucket)::bigint, 'key', s.rx_key, 'center_hz', s.center_hz, 'rate', s.rate,
           'n', s.n, 'floor_db', pg_catalog.round(s.floor_db::numeric, 1),
           'low', pg_catalog.translate(pg_catalog.encode(s.low, 'base64'), E'\n', ''),
           'mid', pg_catalog.translate(pg_catalog.encode(s.mid, 'base64'), E'\n', ''))
           order by s.bucket, s.rx_key, s.center_hz, s.rate)
    into v_rows
    from meganet.base_station_spectrum_hourly s
   where s.ingest_token_id = p_id and s.bucket >= v_from;

  return pg_catalog.jsonb_build_object(
    'now', v_now, 'days', v_days, 'from', v_from,
    'to', (select m.value from meganet.app_meta m where m.key = 'spectrum_rolled_to'),
    'site', case when v_lat is not null and v_lon is not null then pg_catalog.jsonb_build_object('lat', v_lat, 'lon', v_lon) end,
    'rows', coalesce(v_rows, '[]'::jsonb));
end;
$$;

comment on function meganet.admin_base_station_bands(bigint, integer) is
  'A base station''s spectrum by the hour over the last p_days (1–7, default 2) for the Base Stations tab''s Steady signals (0111): per stick, tuning and hour, each bin''s 10th percentile (low) and median (mid) in base64, half-dB steps over the floor, with the rows folded in and their mean floor; where the station is; how far the hours are folded. Administrators only.';

-- ── The panel's call: what comes in through each ─────────────────────────────

create or replace function meganet.admin_base_station_ingest(p_days integer default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now    timestamptz := pg_catalog.now();
  v_days   integer := greatest(1, least(90, coalesce(p_days, 7)));
  v_from   timestamptz;
  v_to     timestamptz;
  v_out    jsonb;
  v_net    jsonb;
  c_min    constant integer := 3;   -- decodes before a station counts, as 0081
begin
  perform meganet.admin_require();
  v_from := v_now - pg_catalog.make_interval(days => v_days);

  with src as materialized (
    select r.ingest_token_id as tok, r.point_id, coalesce(r.protocol, 'alert') as protocol, r.station as id,
           (r.bucket at time zone 'UTC')::date as day, r.n, r.n_ok, r.n_undecoded, r.n_dup, r.n_bad, r.last_heard
      from meganet.reception_hourly r
     where v_days <= 14 and r.bucket >= v_from and r.survey is null
    union all
    select r.ingest_token_id, r.point_id, coalesce(r.protocol, 'alert'), r.station,
           r.bucket, r.n, r.n_ok, r.n_undecoded, r.n_dup, r.n_bad, r.last_heard
      from meganet.reception_daily r
     where v_days > 14 and r.bucket >= (v_from at time zone 'UTC')::date and r.survey is null),
  -- A station a base station decoded: the ID, and how often.
  ids as (
    select s.tok, s.protocol, s.id, pg_catalog.sum(s.n_ok)::bigint as ok
      from src s where s.id is not null
     group by s.tok, s.protocol, s.id
    having pg_catalog.sum(s.n_ok) > 0),
  counted as (
    select i.tok, i.protocol, i.id,
           case when i.protocol = 'alert2'
                then exists (select 1 from meganet.station st where st.alert2_station_id = i.id and st.deleted_at is null)
                else exists (select 1 from meganet.sensor se where se.alert_id = i.id) end as known,
           not exists (select 1 from ids o where o.protocol = i.protocol and o.id = i.id and o.tok <> i.tok) as only_here
      from ids i where i.ok >= c_min),
  proto as (
    select s.tok, s.protocol,
           pg_catalog.sum(s.n)::bigint as n, pg_catalog.sum(s.n_ok)::bigint as ok,
           pg_catalog.sum(s.n_undecoded)::bigint as undecoded, pg_catalog.sum(s.n_dup)::bigint as dup,
           pg_catalog.sum(s.n_bad)::bigint as bad, pg_catalog.max(s.last_heard) as last
      from src s group by s.tok, s.protocol),
  proto_j as (
    select p.tok, pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'protocol', p.protocol, 'n', p.n, 'ok', p.ok, 'undecoded', p.undecoded, 'dup', p.dup, 'bad', p.bad, 'last', p.last,
             'ids', (select pg_catalog.count(*) from counted c where c.tok = p.tok and c.protocol = p.protocol),
             'known', (select pg_catalog.count(*) from counted c where c.tok = p.tok and c.protocol = p.protocol and c.known),
             'only_here', (select pg_catalog.count(*) from counted c where c.tok = p.tok and c.protocol = p.protocol and c.only_here))
             order by p.protocol) as j
      from proto p group by p.tok),
  rx as (
    select s.tok, s.point_id, s.protocol, pg_catalog.sum(s.n)::bigint as n, pg_catalog.sum(s.n_ok)::bigint as ok,
           pg_catalog.count(distinct s.id) filter (where s.n_ok > 0) as ids, pg_catalog.max(s.last_heard) as last
      from src s group by s.tok, s.point_id, s.protocol),
  rx_j as (
    select x.tok, pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'point_id', x.point_id, 'protocol', x.protocol, 'n', x.n, 'ok', x.ok, 'ids', x.ids, 'last', x.last,
             'name', (select q.name from meganet.ingest_point_report q
                       where q.ingest_token_id = x.tok and q.point_id = x.point_id order by q.reported_at desc limit 1))
             order by x.point_id, x.protocol) as j
      from rx x group by x.tok),
  day as (
    select s.tok, s.day,
           pg_catalog.sum(s.n_ok) filter (where s.protocol = 'alert')::bigint as alert,
           pg_catalog.sum(s.n_ok) filter (where s.protocol = 'alert2')::bigint as alert2,
           pg_catalog.sum(s.n)::bigint as n
      from src s group by s.tok, s.day),
  day_j as (
    select d.tok, pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(d.day, coalesce(d.alert, 0), coalesce(d.alert2, 0), d.n) order by d.day) as j
      from day d group by d.tok)
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id', t.id, 'label', t.label, 'revoked', t.revoked_at is not null,
           'host_station', (select h.name from meganet.station h where h.id = t.host_station_id),
           'protocols', coalesce(p.j, '[]'::jsonb), 'receivers', coalesce(x.j, '[]'::jsonb), 'days', coalesce(d.j, '[]'::jsonb))
           order by t.label, t.id),
         (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('protocol', w.protocol, 'ids', w.ids, 'known', w.known) order by w.protocol)
            from (select c.protocol, pg_catalog.count(distinct c.id) as ids, pg_catalog.count(distinct c.id) filter (where c.known) as known
                    from counted c group by c.protocol) w)
    into v_out, v_net
    from meganet.ingest_token t
    left join proto_j p on p.tok = t.id
    left join rx_j x on x.tok = t.id
    left join day_j d on d.tok = t.id
   where p.tok is not null or exists (select 1 from meganet.base_station b where b.ingest_token_id = t.id);

  if v_days <= 14 then
    select pg_catalog.max(r.bucket) + interval '1 hour' into v_to from meganet.reception_hourly r where r.bucket >= v_from;
  else
    select (pg_catalog.max(r.bucket) + 1)::timestamp at time zone 'UTC' into v_to
      from meganet.reception_daily r where r.bucket >= (v_from at time zone 'UTC')::date;
  end if;

  return pg_catalog.jsonb_build_object(
    'now', v_now, 'days', v_days, 'from', v_from, 'to', v_to, 'min_decodes', c_min,
    'stations', coalesce(v_out, '[]'::jsonb), 'network', coalesce(v_net, '[]'::jsonb));
end;
$$;

comment on function meganet.admin_base_station_ingest(integer) is
  'What comes in through each base station over the last p_days (1–90, default 7) for the Base Stations tab (0111): per ingest token and protocol, from the reception rollups (hourly up to 14 days, daily beyond; drive surveys left out), messages heard, decoded, undecoded, duplicate and bad, the stations decoded three times or more, how many of them the register has and how many no other base station decoded; the same per receiver; decoded messages a UTC day; and the stations decoded by the network as a whole. Administrators only.';

-- ── Who may run what ─────────────────────────────────────────────────────────

revoke all on function meganet.roll_up_spectrum(integer) from public;
revoke all on function meganet.admin_base_station_bands(bigint, integer) from public;
revoke all on function meganet.admin_base_station_ingest(integer) from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;
  -- authenticated, not anon: admin_require() asks as well. roll_up_spectrum()
  -- is the scheduler's alone.
  grant execute on function meganet.admin_base_station_bands(bigint, integer) to authenticated, service_role;
  grant execute on function meganet.admin_base_station_ingest(integer) to authenticated, service_role;
  notify pgrst, 'reload schema';
end
$$;

-- ── The schedule, and the two days there are ─────────────────────────────────

select meganet.roll_up_spectrum(48);

do $$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron is not available on this server: nothing will run meganet.roll_up_spectrum() on a schedule.';
    return;
  end if;
  begin
    create extension if not exists pg_cron;
    perform cron.schedule('meganet-roll-up-spectrum', '13 * * * *', 'select meganet.roll_up_spectrum()');
    raise notice 'meganet.roll_up_spectrum() runs hourly at minute 13 (pg_cron job meganet-roll-up-spectrum).';
  exception when others then
    raise warning 'pg_cron could not be set up (%): spectrum hours will not be folded until it is.', sqlerrm;
  end;
end
$$;

-- ── Did it take ──────────────────────────────────────────────────────────────

do $$
begin
  if pg_catalog.to_regclass('meganet.base_station_spectrum_hourly') is null
     or pg_catalog.to_regprocedure('meganet.roll_up_spectrum(integer)') is null
     or pg_catalog.to_regprocedure('meganet.admin_base_station_bands(bigint, integer)') is null
     or pg_catalog.to_regprocedure('meganet.admin_base_station_ingest(integer)') is null then
    raise exception '0111 did not take: the hourly table or a function is missing';
  end if;
  if pg_catalog.has_function_privilege('public', 'meganet.roll_up_spectrum(integer)', 'execute')
     or pg_catalog.has_function_privilege('public', 'meganet.admin_base_station_bands(bigint, integer)', 'execute')
     or pg_catalog.has_function_privilege('public', 'meganet.admin_base_station_ingest(integer)', 'execute') then
    raise exception '0111 did not take: public may run a function';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 111 once this is applied. The guard means
-- applying it out of order leaves the higher number.

insert into meganet.app_meta (key, value)
values ('schema_version', '111')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
