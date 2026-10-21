-- 0075_transmitter_drift.sql — A transmitter drifting off its frequency, as a
-- health finding, from the carrier offsets the base stations already measure
-- (#217).
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0075_transmitter_drift.sql
--
-- Why this file exists
-- ────────────────────
-- A field transmitter whose crystal drifts shows first as weaker decodes and
-- then as silence — and by then it is a site visit. RPi ALERT's decoder
-- measures every ALERT2 burst's carrier frequency offset (`cfo_hz`) and sends
-- it with each reception; since 0072 it is a column, and since 0071 it is in
-- reception_hourly / reception_daily for good. #217 asked for the RPi side to
-- send it and for a column on the reading; neither is needed — it arrives on
-- the reception, which is per copy, which is what this needs.
--
-- Four decisions, from the live data (2026-10-21).
--
-- **1. The offset is the last transmitter's, not the source's.** A copy
-- relayed over a repeater is on the repeater's carrier: every copy whose path
-- ends at 10019 measured ~240 Hz, as 10019 heard direct (242); every one
-- ending at 33300 ~490 (direct, 493); at 10310 ~460 (direct, 459). So the
-- transmitter is the path's last address, or the source when the path is
-- empty — and repeaters are measured too, for nothing. Bursts agree to about
-- ±20 Hz, so a day's mean is precise to a few Hz.
--
-- **2. The receiver's own error taken out, day by day.** An RTL-SDR's
-- crystal is off by a few ppm and wanders with temperature, and that moves
-- every transmitter it hears together. Per receiver: each transmitter's mean
-- over the window; the receiver's error each day is the median of how far
-- its transmitters sat from those means that day (two or more heard); with
-- that removed, a transmitter is measured against the median of the whole
-- fleet that receiver heard over the window (three or more). A first try —
-- against the median of the others heard *that day* — moved a transmitter by
-- 200 Hz when two others happened not to be heard; this holds to ~15 Hz day
-- to day on the live data, and the receiver's own error came out at −16 to
-- +20 Hz. Several receivers' days are combined, weighted by bursts. Offsets
-- are also in ppm of the frequency, which a transmitter's tolerance is
-- written in. They are relative — to the fleet, not to a standard — so a
-- transmitter far from the rest is the one to check.
--
-- **3. Two findings** (source `transmitters`, subject `a2:<address>`, public
-- like station findings — the numbers are about the network's transmitters,
-- and no receiver is named):
--   * `transmitter-off-channel` — the last 7 days' offset is beyond
--     2.5 ppm (warn; a typical land-mobile tolerance, ~380 Hz at 151.5 MHz)
--     or 5 ppm (critical), on at least 2 days.
--   * `transmitter-drift` — the last 7 days have moved from the 30 days before
--     them by 1 ppm (warn) or 2 ppm (critical), with at least 3 recent and 5
--     earlier days to say so. Reception data with offsets begins 2026-10-19,
--     so this cannot fire before November.
--   The thresholds are app_meta rows (tx_offset_warn_ppm …), not code.
--
-- **4. On pg_cron hourly at minute 13**, after the reception rollups (minute
-- 9). `station_id` is filled where the register knows the ALERT2 address
-- (`station.alert2_station_id`, 0024) — none do yet, so for now the findings
-- name the address, and attach to their stations as the register fills in.
-- meganet.transmitter_offsets() is the daily series behind them, public, for
-- the Station Health tab.

-- ── The knobs ────────────────────────────────────────────────────────────────

insert into meganet.app_meta (key, value) values
  ('tx_offset_warn_ppm', '2.5'), ('tx_offset_crit_ppm', '5'),
  ('tx_drift_warn_ppm', '1'),    ('tx_drift_crit_ppm', '2')
on conflict (key) do nothing;

-- ── health_finding and health_refresh take a third source ────────────────────

alter table meganet.health_finding drop constraint if exists health_finding_source;
alter table meganet.health_finding add constraint health_finding_source
  check (source in ('stations', 'base-stations', 'transmitters'));
alter table meganet.health_finding drop constraint if exists health_finding_kind;
alter table meganet.health_finding add constraint health_finding_kind
  check (kind ~ '^[a-z][a-z0-9-]{1,39}$'
         and (source = 'stations'
              or (source = 'base-stations' and kind in ('base-station-quiet', 'receiver-deaf'))
              or (source = 'transmitters' and kind in ('transmitter-off-channel', 'transmitter-drift'))));
alter table meganet.health_refresh drop constraint if exists health_refresh_source;
alter table meganet.health_refresh add constraint health_refresh_source
  check (source in ('stations', 'base-stations', 'transmitters'));

-- ── The daily series ─────────────────────────────────────────────────────────

create or replace function meganet.transmitter_offsets(p_days integer default 37)
returns table (addr integer, day date, offset_hz double precision, offset_ppm double precision,
               bursts bigint, receivers integer, freq_mhz double precision)
language sql
stable
security definer
set search_path = ''
as $$
  -- cfo(transmitter, day) = the transmitter's own offset + the receiver's
  -- error that day + noise, per receiver; the receiver's error is what every
  -- transmitter it heard that day moved by together.
  with tx as (
    -- Each receiver's day of each transmitter: the last address on the path,
    -- or the source when there is none. 20 bursts or more.
    select h.bucket as d, h.ingest_token_id as tok, h.point_id as rx,
           coalesce(h.path[pg_catalog.array_length(h.path, 1)], h.station) as a,
           pg_catalog.sum(h.cfo_n)::bigint as n,
           pg_catalog.sum(h.cfo_sum) / pg_catalog.sum(h.cfo_n) as cfo,
           pg_catalog.max(h.freq_max)::double precision as f
      from meganet.reception_daily h
     where h.protocol = 'alert2' and h.cfo_n > 0
       and h.bucket >= (pg_catalog.now() at time zone 'UTC')::date - greatest(coalesce(p_days, 37), 1)
       and coalesce(h.path[pg_catalog.array_length(h.path, 1)], h.station) is not null
     group by 1, 2, 3, 4
    having pg_catalog.sum(h.cfo_n) >= 20
  ), m0 as (
    -- A first guess at each transmitter: its mean over the window.
    select t.tok, t.rx, t.a, pg_catalog.sum(t.cfo * t.n) / pg_catalog.sum(t.n) as m
      from tx t group by 1, 2, 3
  ), e as (
    -- The receiver's error each day: the median of how far its transmitters
    -- sat from their own means that day. Two or more transmitters a day.
    select t.tok, t.rx, t.d,
           pg_catalog.percentile_cont(0.5) within group (order by t.cfo - m0.m) as e,
           pg_catalog.count(*) as k
      from tx t join m0 on m0.tok = t.tok and m0.rx = t.rx and m0.a = t.a
     group by 1, 2, 3
  ), m1 as (
    -- Each transmitter again, with the receiver's daily error taken out.
    select t.tok, t.rx, t.a, pg_catalog.sum((t.cfo - e.e) * t.n) / pg_catalog.sum(t.n) as m
      from tx t join e on e.tok = t.tok and e.rx = t.rx and e.d = t.d
     where e.k >= 2
     group by 1, 2, 3
  ), fl as (
    -- The fleet that receiver hears, over the whole window: their median is
    -- zero. Three transmitters or more.
    select m1.tok, m1.rx, pg_catalog.percentile_cont(0.5) within group (order by m1.m) as med,
           pg_catalog.count(*) as ntx
      from m1 group by 1, 2
  ), rel as (
    select t.a, t.d, t.n, t.f, t.cfo - e.e - fl.med as off
      from tx t
      join e  on e.tok = t.tok and e.rx = t.rx and e.d = t.d
      join fl on fl.tok = t.tok and fl.rx = t.rx
     where e.k >= 2 and fl.ntx >= 3
  )
  select r.a, r.d,
         pg_catalog.sum(r.off * r.n) / pg_catalog.sum(r.n),
         pg_catalog.sum(r.off * r.n) / pg_catalog.sum(r.n) / nullif(pg_catalog.max(r.f), 0),
         pg_catalog.sum(r.n)::bigint,
         pg_catalog.count(*)::integer,
         pg_catalog.max(r.f)
    from rel r
   group by r.a, r.d
   order by r.a, r.d;
$$;

comment on function meganet.transmitter_offsets(integer) is
  'Each ALERT2 transmitter''s carrier offset by UTC day over the last p_days (0075, #217): the last address on a copy''s path (or its source), with each receiver''s own daily error taken out and measured against the median of the fleet that receiver hears, in Hz and ppm, combined across receivers by bursts. From reception_daily. Public: no receiver is named.';

-- ── The findings ─────────────────────────────────────────────────────────────

create or replace function meganet.refresh_transmitter_findings(p_now timestamptz default pg_catalog.now())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_started timestamptz := pg_catalog.clock_timestamp();
  v_today   date := (p_now at time zone 'UTC')::date;
  v_ow      double precision := coalesce((select a.value::double precision from meganet.app_meta a where a.key = 'tx_offset_warn_ppm'), 2.5);
  v_oc      double precision := coalesce((select a.value::double precision from meganet.app_meta a where a.key = 'tx_offset_crit_ppm'), 5);
  v_dw      double precision := coalesce((select a.value::double precision from meganet.app_meta a where a.key = 'tx_drift_warn_ppm'), 1);
  v_dc      double precision := coalesce((select a.value::double precision from meganet.app_meta a where a.key = 'tx_drift_crit_ppm'), 2);
  t         record;
  v_sid     text;
  v_name    text;
  v_judged  integer := 0;
  v_out     jsonb;
  v_took    integer;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(5900217) then
    return pg_catalog.jsonb_build_object('at', p_now, 'skipped', 'another run is under way');
  end if;
  perform meganet.health_begin();

  for t in
    with s as (select * from meganet.transmitter_offsets(38))
    select s.addr,
           pg_catalog.count(*) filter (where s.day > v_today - 7)                                         as w_days,
           pg_catalog.sum(s.offset_ppm * s.bursts) filter (where s.day > v_today - 7)
             / nullif(pg_catalog.sum(s.bursts) filter (where s.day > v_today - 7), 0)                     as w_ppm,
           pg_catalog.sum(s.offset_hz * s.bursts) filter (where s.day > v_today - 7)
             / nullif(pg_catalog.sum(s.bursts) filter (where s.day > v_today - 7), 0)                     as w_hz,
           pg_catalog.count(*) filter (where s.day <= v_today - 7 and s.day > v_today - 37)                as b_days,
           pg_catalog.sum(s.offset_ppm * s.bursts) filter (where s.day <= v_today - 7 and s.day > v_today - 37)
             / nullif(pg_catalog.sum(s.bursts) filter (where s.day <= v_today - 7 and s.day > v_today - 37), 0) as b_ppm,
           pg_catalog.sum(s.bursts) filter (where s.day > v_today - 7)                                    as w_bursts,
           pg_catalog.max(s.receivers) filter (where s.day > v_today - 7)                                 as receivers,
           pg_catalog.max(s.freq_mhz)                                                                     as freq
      from s group by s.addr
  loop
    continue when coalesce(t.w_days, 0) = 0;
    v_judged := v_judged + 1;
    v_sid := meganet.resolve_a2_station(t.addr);
    v_name := (select st.name from meganet.station st where st.id = v_sid);
    v_name := 'ALERT2 ' || t.addr || coalesce(' (' || nullif(v_name, '') || ')', '');

    if t.w_days >= 2 and pg_catalog.abs(t.w_ppm) >= v_ow then
      insert into pg_temp._health_now values (
        'transmitter-off-channel', 'a2:' || t.addr, v_sid, null, null,
        case when pg_catalog.abs(t.w_ppm) >= v_oc then 'critical' else 'warn' end,
        v_name || ': transmitting ' || pg_catalog.to_char(t.w_ppm, 'SG0.0') || ' ppm off the others ('
          || pg_catalog.to_char(t.w_hz, 'SG9990') || ' Hz)',
        'Over the last ' || t.w_days || ' days its carrier has been ' || pg_catalog.round(pg_catalog.abs(t.w_hz))::text
          || ' Hz ' || case when t.w_hz > 0 then 'above' else 'below' end || ' the other transmitters the same receivers hear — '
          || pg_catalog.to_char(pg_catalog.abs(t.w_ppm), 'FM990.0') || ' ppm at ' || pg_catalog.to_char(t.freq, 'FM990.0000')
          || ' MHz. A transmitter this far off decodes worse and then not at all; its frequency wants checking at the next visit.',
        pg_catalog.jsonb_build_object('addr', t.addr, 'offset_ppm', pg_catalog.round(t.w_ppm::numeric, 2),
          'offset_hz', pg_catalog.round(t.w_hz::numeric), 'days', t.w_days, 'bursts', t.w_bursts,
          'receivers', t.receivers, 'freq_mhz', t.freq, 'warn_ppm', v_ow, 'critical_ppm', v_oc));
    end if;

    if t.w_days >= 3 and t.b_days >= 5 and pg_catalog.abs(t.w_ppm - t.b_ppm) >= v_dw then
      insert into pg_temp._health_now values (
        'transmitter-drift', 'a2:' || t.addr, v_sid, null, null,
        case when pg_catalog.abs(t.w_ppm - t.b_ppm) >= v_dc then 'critical' else 'warn' end,
        v_name || ': drifted ' || pg_catalog.to_char(t.w_ppm - t.b_ppm, 'SG0.0') || ' ppm in a week',
        'Its carrier offset against the other transmitters was ' || pg_catalog.to_char(t.b_ppm, 'SG0.00') || ' ppm over the '
          || t.b_days || ' days before last week, and ' || pg_catalog.to_char(t.w_ppm, 'SG0.00') || ' ppm over the last '
          || t.w_days || '. A crystal moving this fast is ageing or failing, or the site is running hot or cold; it tends to end in silence.',
        pg_catalog.jsonb_build_object('addr', t.addr, 'recent_ppm', pg_catalog.round(t.w_ppm::numeric, 2),
          'earlier_ppm', pg_catalog.round(t.b_ppm::numeric, 2), 'recent_days', t.w_days, 'earlier_days', t.b_days,
          'receivers', t.receivers, 'freq_mhz', t.freq, 'warn_ppm', v_dw, 'critical_ppm', v_dc));
    end if;
  end loop;

  v_out := meganet.health_apply('transmitters', p_now, true);
  v_took := greatest(0, extract(epoch from pg_catalog.clock_timestamp() - v_started) * 1000)::integer;
  insert into meganet.health_refresh as hr (source, at, took_ms, detail)
  values ('transmitters', p_now, v_took, pg_catalog.jsonb_build_object('transmitters', v_judged))
  on conflict (source) do update set at = excluded.at, took_ms = excluded.took_ms, detail = excluded.detail;

  return pg_catalog.jsonb_build_object('at', p_now, 'took_ms', v_took, 'judged', v_judged) || v_out;
end;
$$;

comment on function meganet.refresh_transmitter_findings(timestamptz) is
  'Opens, updates and clears the transmitter findings (0075, #217): transmitter-off-channel (the last 7 days beyond tx_offset_warn_ppm / _crit_ppm of the others) and transmitter-drift (the last 7 days moved from the 30 before by tx_drift_warn_ppm / _crit_ppm), from transmitter_offsets(). Answers what opened, got worse and cleared, as the other health runs do. pg_cron hourly (meganet-transmitter-health); the owner and service_role only.';

revoke all on function meganet.transmitter_offsets(integer) from public;
revoke all on function meganet.refresh_transmitter_findings(timestamptz) from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;
  grant execute on function meganet.transmitter_offsets(integer) to anon, authenticated, service_role;
  grant execute on function meganet.refresh_transmitter_findings(timestamptz) to service_role;
  notify pgrst, 'reload schema';
end
$$;

-- ── Hourly, where the server has pg_cron ─────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron is not available on this server: nothing will run meganet.refresh_transmitter_findings() on a schedule.';
    return;
  end if;
  begin
    create extension if not exists pg_cron;
    perform cron.schedule('meganet-transmitter-health', '13 * * * *', 'select meganet.refresh_transmitter_findings()');
    raise notice 'meganet.refresh_transmitter_findings() runs hourly at minute 13 (pg_cron job meganet-transmitter-health).';
  exception when others then
    raise warning 'pg_cron could not be set up (%): transmitter findings will not be kept until it is.', sqlerrm;
  end;
end
$$;

-- ── Proof it took ────────────────────────────────────────────────────────────

do $$
begin
  if pg_catalog.to_regprocedure('meganet.transmitter_offsets(integer)') is null
     or pg_catalog.to_regprocedure('meganet.refresh_transmitter_findings(timestamptz)') is null then
    raise exception '0075 did not take: a function is missing';
  end if;
  if pg_catalog.strpos(pg_catalog.pg_get_constraintdef((select c.oid from pg_catalog.pg_constraint c
       where c.conrelid = 'meganet.health_finding'::regclass and c.conname = 'health_finding_source')), 'transmitters') = 0 then
    raise exception '0075 did not take: health_finding does not take the transmitters source';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 75 when this is applied.

insert into meganet.app_meta (key, value)
values ('schema_version', '75')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
