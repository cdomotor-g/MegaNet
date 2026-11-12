-- 0123_telemetry.sql — What the base stations hear, for anybody: how much, how
-- much of it decoded, on which channel, by which base station, hour by hour or
-- day by day; and which addresses each base station hears, how strongly.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0123_telemetry.sql
--
-- Why this file exists
-- ────────────────────
-- The 📡 Telemetry tab (telemetry.js) charts the network's traffic: ALERT
-- against ALERT2, channel against channel, base station against base station,
-- and what became of each burst — decoded, a copy, set aside as a bit-flipped
-- shadow, a broken frame, nothing readable. Everything it needs is in the
-- reception roll-ups (0071, 0072): an hourly and a daily tally per receiver,
-- protocol, transmitting address, repeater path and survey, kept for good.
-- They are editors' only, like the receptions under them, because a
-- receiver can be a vehicle and its survey a record of where it went.
--
-- A named base station is not a vehicle. Its name and its receivers' codes are
-- public (0115), and so are its last three days of copies (0116). Totals per
-- base station, channel and hour say less than either. So this publishes them,
-- and nothing finer.
--
-- What it publishes
-- ─────────────────
-- meganet.telemetry_traffic(p_days, p_hourly): the last 1–400 days, by the
-- hour (up to 14 days) or the UTC day — one row a bucket, base station (by
-- name), channel and protocol:
--   n          bursts heard
--   decoded    decoded and new to that receiver (n_ok − n_dup)
--   copies     decoded, but the receiver had it already (n_dup): ALERT2's
--              repeats and repeater copies, a legacy burst heard twice
--   shadow     a bit-flipped copy the decoder set aside (fault 'shadow')
--   undecoded  energy that made no message (fault 'undecoded')
--   frame      a frame that did not add up (fault 'frame', and the old
--              'status')
--   check      failed its check or refused by the radio ('crc', 'rejected')
--   other      any other burst that did not decode
--   snr_n / snr_sum     the signal-to-noise of the bursts that carried one
--   nf_n / nf_sum       the stick's noise floor, dBFS, beside each burst
-- Returned as one JSON object, columns named once and rows as arrays, so that
-- PostgREST's row limit never cuts a window short and a week is ~60 kB.
--
-- meganet.telemetry_links(p_days): the last 1–90 days, from reception_daily —
-- one row a base station, protocol, transmitting address and channel, for an
-- address decoded three times or more (once can be a corrupted copy that
-- passed its checks, as 0081 found): decoded, copies, relayed (decoded with a
-- repeater path), signal count, sum, weakest and strongest, the days it was
-- heard, when last, and the register station the address resolves to.
--
-- Never: the receiver's code, its stick, its position, a survey's or a drive's
-- receptions, a payload, a value. Only receivers a base station name is on
-- file for (meganet.base_station_name) — a phone on a drive has none.
--
-- What a channel is
-- ─────────────────
-- A stick that decodes channel by channel says so in its point_id
-- ('rpi-83071968-sdr1-151.5375'): that frequency, exactly. A receiver that
-- does not (a wide stick's '-sdr1', a radio) is put to the 12.5 kHz channel
-- its tally's lowest and highest frequency share; a tally that spans two
-- channels, or carries none, is channel unknown (null).
--
-- The database's disk
-- ───────────────────
-- reception_hourly held ~190,000 rows (93 MB) on 12 November 2026, ~2,100 an
-- hour of the network; reception_daily ~41,000 (22 MB). A week of hours is
-- ~15,000 rows read on the bucket index, ninety days of days ~40,000. Neither
-- reads the receptions.

-- ── 1. The channel a tally was heard on ─────────────────────────────────────
create or replace function meganet.telemetry_channel(p_point_id text, p_freq_min real, p_freq_max real)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    when p_point_id ~ '-sdr[0-9]+-[0-9]{2,4}(\.[0-9]+)?$'
      then pg_catalog.round(pg_catalog.substring(p_point_id from '-sdr[0-9]+-([0-9.]+)$')::numeric, 4)
    when p_freq_min is not null
         and pg_catalog.round((p_freq_min / 0.0125)::numeric)
           = pg_catalog.round((coalesce(p_freq_max, p_freq_min) / 0.0125)::numeric)
      then pg_catalog.round(pg_catalog.round((p_freq_min / 0.0125)::numeric) * 0.0125, 4)
  end
$$;
comment on function meganet.telemetry_channel(text, real, real) is
  'The channel a reception tally was heard on (0123): the frequency a channel-by-channel stick names in its point_id, else the 12.5 kHz channel the tally''s lowest and highest frequency share, else null.';

-- ── 2. Traffic, by the hour or the day ───────────────────────────────────────
create or replace function meganet.telemetry_traffic(p_days integer default 7, p_hourly boolean default true)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_days   integer := least(greatest(coalesce(p_days, 7), 1), 400);
  v_hourly boolean := coalesce(p_hourly, true) and least(greatest(coalesce(p_days, 7), 1), 400) <= 14;
  v_from   timestamptz;
  v_rows   jsonb;
begin
  if v_hourly then
    v_from := pg_catalog.date_trunc('hour', pg_catalog.now()) - (v_days * 24 - 1) * interval '1 hour';
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
             pg_catalog.extract(epoch from x.bucket)::bigint, x.base, x.ch, x.protocol,
             x.n, x.decoded, x.copies, x.shadow, x.undecoded, x.frame, x.chk, x.other,
             x.snr_n, x.snr_sum, x.nf_n, x.nf_sum)
           order by x.bucket, x.base, x.ch, x.protocol), '[]'::jsonb)
      into v_rows
      from (
        select h.bucket, b.name as base,
               meganet.telemetry_channel(h.point_id, h.freq_min, h.freq_max) as ch,
               coalesce(h.protocol, 'other') as protocol,
               pg_catalog.sum(h.n)::bigint as n,
               pg_catalog.sum(greatest(h.n_ok - h.n_dup, 0))::bigint as decoded,
               pg_catalog.sum(least(h.n_dup, h.n_ok))::bigint as copies,
               pg_catalog.sum(h.n_shadow)::bigint as shadow,
               pg_catalog.sum(h.n_undecoded)::bigint as undecoded,
               pg_catalog.sum(h.n_frame + h.n_status)::bigint as frame,
               pg_catalog.sum(h.n_crc + h.n_rejected)::bigint as chk,
               pg_catalog.sum(greatest(h.n_bad - h.n_shadow - h.n_undecoded - h.n_frame - h.n_status - h.n_crc - h.n_rejected, 0))::bigint as other,
               pg_catalog.sum(h.snr_n)::bigint as snr_n,
               pg_catalog.round(coalesce(pg_catalog.sum(h.snr_sum), 0)::numeric, 1) as snr_sum,
               pg_catalog.sum(h.nf_dbfs_n)::bigint as nf_n,
               pg_catalog.round(coalesce(pg_catalog.sum(h.nf_dbfs_sum), 0)::numeric, 1) as nf_sum
          from meganet.reception_hourly h
          join meganet.base_station_name b
            on b.receiver = 'serial-monitor/' || pg_catalog.regexp_replace(h.point_id, '-sdr\d+(-[\d.]+)?$', '')
         where h.bucket >= v_from
           and h.survey is null
         group by 1, 2, 3, 4
      ) x;
  else
    v_from := ((pg_catalog.now() at time zone 'utc')::date - (v_days - 1))::timestamp at time zone 'utc';
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
             pg_catalog.extract(epoch from (x.bucket::timestamp at time zone 'utc'))::bigint, x.base, x.ch, x.protocol,
             x.n, x.decoded, x.copies, x.shadow, x.undecoded, x.frame, x.chk, x.other,
             x.snr_n, x.snr_sum, x.nf_n, x.nf_sum)
           order by x.bucket, x.base, x.ch, x.protocol), '[]'::jsonb)
      into v_rows
      from (
        select d.bucket, b.name as base,
               meganet.telemetry_channel(d.point_id, d.freq_min, d.freq_max) as ch,
               coalesce(d.protocol, 'other') as protocol,
               pg_catalog.sum(d.n)::bigint as n,
               pg_catalog.sum(greatest(d.n_ok - d.n_dup, 0))::bigint as decoded,
               pg_catalog.sum(least(d.n_dup, d.n_ok))::bigint as copies,
               pg_catalog.sum(d.n_shadow)::bigint as shadow,
               pg_catalog.sum(d.n_undecoded)::bigint as undecoded,
               pg_catalog.sum(d.n_frame + d.n_status)::bigint as frame,
               pg_catalog.sum(d.n_crc + d.n_rejected)::bigint as chk,
               pg_catalog.sum(greatest(d.n_bad - d.n_shadow - d.n_undecoded - d.n_frame - d.n_status - d.n_crc - d.n_rejected, 0))::bigint as other,
               pg_catalog.sum(d.snr_n)::bigint as snr_n,
               pg_catalog.round(coalesce(pg_catalog.sum(d.snr_sum), 0)::numeric, 1) as snr_sum,
               pg_catalog.sum(d.nf_dbfs_n)::bigint as nf_n,
               pg_catalog.round(coalesce(pg_catalog.sum(d.nf_dbfs_sum), 0)::numeric, 1) as nf_sum
          from meganet.reception_daily d
          join meganet.base_station_name b
            on b.receiver = 'serial-monitor/' || pg_catalog.regexp_replace(d.point_id, '-sdr\d+(-[\d.]+)?$', '')
         where d.bucket >= (v_from at time zone 'utc')::date
           and d.survey is null
         group by 1, 2, 3, 4
      ) x;
  end if;

  return pg_catalog.jsonb_build_object(
    'grain', case when v_hourly then 'hour' else 'day' end,
    'days', v_days,
    'from', v_from,
    'to', pg_catalog.now(),
    'cols', pg_catalog.jsonb_build_array('t', 'base', 'channel', 'protocol',
              'n', 'decoded', 'copies', 'shadow', 'undecoded', 'frame', 'check', 'other',
              'snr_n', 'snr_sum', 'nf_n', 'nf_sum'),
    'rows', v_rows);
end
$$;
comment on function meganet.telemetry_traffic(integer, boolean) is
  'What the named base stations heard over the last 1–400 days (0123), by the hour (up to 14 days) or the UTC day, per base station name, channel and protocol: bursts, decoded, copies, shadows, undecoded, broken frames, failed checks, other, and the sums behind mean signal and noise floor. From reception_hourly / reception_daily; no receiver code, stick, survey or position leaves it. One JSON object: cols, then rows as arrays. Public. For the Telemetry tab.';

-- ── 3. The addresses each base station hears ─────────────────────────────────
create or replace function meganet.telemetry_links(p_days integer default 7)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with d as (
    select b.name as base,
           coalesce(r.protocol, 'other') as protocol,
           r.station as addr,
           meganet.telemetry_channel(r.point_id, r.freq_min, r.freq_max) as ch,
           r.bucket, r.n_ok, r.n_dup, r.snr_n, r.snr_sum, r.snr_min, r.snr_max, r.last_heard,
           coalesce(pg_catalog.cardinality(r.path), 0) > 0 as relayed
      from meganet.reception_daily r
      join meganet.base_station_name b
        on b.receiver = 'serial-monitor/' || pg_catalog.regexp_replace(r.point_id, '-sdr\d+(-[\d.]+)?$', '')
     where r.bucket >= (pg_catalog.now() at time zone 'utc')::date - (least(greatest(coalesce(p_days, 7), 1), 90) - 1)
       and r.survey is null
       and r.station is not null
       and r.n_ok > 0
  ), g as (
    select d.base, d.protocol, d.addr, d.ch,
           pg_catalog.sum(greatest(d.n_ok - d.n_dup, 0))::bigint as decoded,
           pg_catalog.sum(least(d.n_dup, d.n_ok))::bigint as copies,
           (pg_catalog.sum(d.n_ok) filter (where d.relayed))::bigint as relayed,
           pg_catalog.sum(d.snr_n)::bigint as snr_n,
           pg_catalog.round(coalesce(pg_catalog.sum(d.snr_sum), 0)::numeric, 1) as snr_sum,
           pg_catalog.round(pg_catalog.min(d.snr_min)::numeric, 1) as snr_min,
           pg_catalog.round(pg_catalog.max(d.snr_max)::numeric, 1) as snr_max,
           pg_catalog.count(distinct d.bucket)::integer as days,
           pg_catalog.max(d.last_heard) as last_heard
      from d
     group by 1, 2, 3, 4
    having pg_catalog.sum(d.n_ok) >= 3
  )
  select pg_catalog.jsonb_build_object(
    'days', least(greatest(coalesce(p_days, 7), 1), 90),
    'to', pg_catalog.now(),
    'cols', pg_catalog.jsonb_build_array('base', 'protocol', 'address', 'channel', 'station_id',
              'decoded', 'copies', 'relayed', 'snr_n', 'snr_sum', 'snr_min', 'snr_max', 'days', 'last_heard'),
    'rows', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
              g.base, g.protocol, g.addr, g.ch,
              case when g.protocol = 'alert2' then meganet.resolve_a2_station(g.addr)
                   else meganet.resolve_station(g.addr, null) end,
              g.decoded, g.copies, coalesce(g.relayed, 0), g.snr_n, g.snr_sum, g.snr_min, g.snr_max, g.days,
              pg_catalog.extract(epoch from g.last_heard)::bigint)
            order by g.base, g.protocol, g.addr, g.ch), '[]'::jsonb))
    from g;
$$;
comment on function meganet.telemetry_links(integer) is
  'Each transmitting address each named base station decoded three times or more over the last 1–90 days (0123), per protocol and channel: decoded, copies, relayed (with a repeater path), signal count, sum, weakest and strongest, days heard, last heard, and the register station it resolves to. From reception_daily; no receiver code, stick, survey or position. One JSON object: cols, then rows as arrays. Public. For the Telemetry tab.';

-- ── 4. Who may call them ─────────────────────────────────────────────────────
revoke all on function meganet.telemetry_channel(text, real, real)      from public;
revoke all on function meganet.telemetry_traffic(integer, boolean)      from public;
revoke all on function meganet.telemetry_links(integer)                 from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;
  grant execute on function meganet.telemetry_channel(text, real, real) to anon, authenticated, service_role;
  grant execute on function meganet.telemetry_traffic(integer, boolean) to anon, authenticated, service_role;
  grant execute on function meganet.telemetry_links(integer)            to anon, authenticated, service_role;
end
$$;

-- ── Did it take ──────────────────────────────────────────────────────────────
do $$
declare
  v jsonb;
begin
  if meganet.telemetry_channel('rpi-83071968-sdr1-151.5375', null, null) is distinct from 151.5375 then
    raise exception '0123 did not take: a stick''s own channel reads %',
      meganet.telemetry_channel('rpi-83071968-sdr1-151.5375', null, null);
  end if;
  if meganet.telemetry_channel('rpi-83071968-sdr1', 151.5375::real, 151.5376::real) is distinct from 151.5375 then
    raise exception '0123 did not take: a wide stick''s channel reads %',
      meganet.telemetry_channel('rpi-83071968-sdr1', 151.5375::real, 151.5376::real);
  end if;
  if meganet.telemetry_channel('rpi-83071968-sdr1', 151.500::real, 151.575::real) is not null then
    raise exception '0123 did not take: a tally across two channels was given one';
  end if;
  v := meganet.telemetry_traffic(1, true);
  if v ->> 'grain' <> 'hour' or pg_catalog.jsonb_typeof(v -> 'rows') <> 'array'
     or pg_catalog.jsonb_array_length(v -> 'cols') <> 16 then
    raise exception '0123 did not take: telemetry_traffic(1) answered %', pg_catalog.left(v::text, 200);
  end if;
  if meganet.telemetry_traffic(30, true) ->> 'grain' <> 'day' then
    raise exception '0123 did not take: thirty days by the hour were not refused';
  end if;
  v := meganet.telemetry_links(1);
  if pg_catalog.jsonb_typeof(v -> 'rows') <> 'array' or pg_catalog.jsonb_array_length(v -> 'cols') <> 14 then
    raise exception '0123 did not take: telemetry_links(1) answered %', pg_catalog.left(v::text, 200);
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
     and not pg_catalog.has_function_privilege('anon', 'meganet.telemetry_traffic(integer, boolean)', 'execute') then
    raise exception '0123 did not take: anon may not call telemetry_traffic';
  end if;
end
$$;

-- DB_SCHEMA_VERSION in core.js goes 122 → 123 once this is applied.
insert into meganet.app_meta (key, value)
values ('schema_version', '123')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;

notify pgrst, 'reload schema';
