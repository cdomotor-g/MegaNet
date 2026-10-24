-- 0082_finding_titles_ppm.sql — A transmitter 10 ppm or more off says how far:
-- its finding's title read "+#.# ppm".
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0082_finding_titles_ppm.sql
--
-- After 0081: it refuses to go in before it (below).
--
-- Why this file exists
-- ────────────────────
-- refresh_transmitter_findings() (0075, restated by 0077 and 0078) writes its
-- numbers into the findings with to_char(), and its patterns had room for one
-- digit before the point: 'SG0.0' and 'SG0.00' for parts per million, 'SG9990'
-- for hertz. to_char() does not widen a pattern for a bigger number; it fills
-- it with '#'. So a transmitter 10 ppm or more off the others was titled
-- "ALERT2 10315: transmitting +#.# ppm off the others (+2467 Hz)" — on
-- 25 Oct 2026 three open findings, ALERT2 10315 and Lake Manchester AL among
-- them at about 16 ppm: the ones furthest off, the ones the title is for. A
-- drift of 10 ppm or more in a week and its detail's two offsets broke the
-- same way, and the hertz at 10 kHz.
--
-- What changes: those three patterns, and nothing else — the function is
-- 0078's as it stands, restated whole because a function is replaced whole.
-- 'FMSG9990.0' and 'FMSG9990.00' print what 'SG0.0' and 'SG0.00' did for
-- every number those could hold ("+2.5", "-3.95" — FM drops the padding a
-- wider pattern would add) and the rest in full ("+16.3"). 'FMSG999990' does
-- the same for the hertz, and drops the blanks 'SG9990' left after the sign
-- under 1 kHz as well: "(+ 460 Hz)" is "(+460 Hz)" now, so most off-channel
-- findings open are retitled, not only the three. No column, no data. They
-- are retitled by the run at the foot of this file — health_apply() (0059)
-- rewrites an open finding's title each time it still holds — and by every
-- hourly run after it.

-- ── After 0081 ───────────────────────────────────────────────────────────────
-- Nothing here needs 0080 or 0081. But each migration sets schema_version to
-- its own number, and db-migrate applies only the files above it: 0082 pasted
-- in first would set 82 and leave 0080 and 0081 out, with nothing to say so.

do $$
begin
  if coalesce((select a.value::integer from meganet.app_meta a where a.key = 'schema_version'), 0) < 81 then
    raise exception '0082 goes in after 0080 and 0081 — schema_version reads %; apply those first',
      coalesce((select a.value from meganet.app_meta a where a.key = 'schema_version'), 'nothing');
  end if;
end
$$;

-- ── The findings, their numbers in full ──────────────────────────────────────

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
  v_fleet   double precision;
  v_fmin    integer := coalesce((select a.value::integer from meganet.app_meta a where a.key = 'tx_flip_min'), 5);
  v_fw      double precision := coalesce((select a.value::double precision from meganet.app_meta a where a.key = 'tx_flip_warn_rate'), 0.02);
  v_fc      double precision := coalesce((select a.value::double precision from meganet.app_meta a where a.key = 'tx_flip_crit_rate'), 0.10);
begin
  if not pg_catalog.pg_try_advisory_xact_lock(5900217) then
    return pg_catalog.jsonb_build_object('at', p_now, 'skipped', 'another run is under way');
  end if;
  perform meganet.health_begin();

  drop table if exists pg_temp._ts;
  create temporary table _ts on commit drop as
  with s as (select * from meganet.carrier_offsets(38))
  select s.tx, pg_catalog.min(s.protocol) as protocol, pg_catalog.min(s.station_id) as station_id, pg_catalog.max(s.via) as via,
         pg_catalog.count(*) filter (where s.day > v_today - 7)::integer                                as w_days,
         pg_catalog.sum(s.offset_ppm * s.bursts) filter (where s.day > v_today - 7)
           / nullif(pg_catalog.sum(s.bursts) filter (where s.day > v_today - 7), 0)                     as w_ppm,
         pg_catalog.sum(s.offset_hz * s.bursts) filter (where s.day > v_today - 7)
           / nullif(pg_catalog.sum(s.bursts) filter (where s.day > v_today - 7), 0)                     as w_hz,
         pg_catalog.count(*) filter (where s.day <= v_today - 7 and s.day > v_today - 37)::integer       as b_days,
         pg_catalog.sum(s.offset_ppm * s.bursts) filter (where s.day <= v_today - 7 and s.day > v_today - 37)
           / nullif(pg_catalog.sum(s.bursts) filter (where s.day <= v_today - 7 and s.day > v_today - 37), 0) as b_ppm,
         coalesce(pg_catalog.sum(s.bursts) filter (where s.day > v_today - 7), 0)::bigint                as w_bursts,
         coalesce(pg_catalog.max(s.receivers) filter (where s.day > v_today - 7), 0)::integer            as receivers,
         pg_catalog.max(s.freq_mhz)                                                                     as freq,
         pg_catalog.array_agg(s.day order by s.day)                                                     as days,
         pg_catalog.array_agg(pg_catalog.round(s.offset_ppm::numeric, 3)::real order by s.day)           as ppm
    from s group by s.tx;

  for t in select * from _ts loop
    continue when coalesce(t.w_days, 0) = 0;
    v_judged := v_judged + 1;
    v_sid := case when t.tx like 'a2:%' then meganet.resolve_a2_station(pg_catalog.substr(t.tx, 4)::integer)
                  when t.tx like 'st:%' then pg_catalog.substr(t.tx, 4) end;
    v_name := (select st.name from meganet.station st where st.id = v_sid);
    v_name := case when t.tx like 'a2:%' then 'ALERT2 ' || pg_catalog.substr(t.tx, 4) || coalesce(' (' || nullif(v_name, '') || ')', '')
                   when t.tx like 'a:%'  then 'ALERT ' || pg_catalog.substr(t.tx, 3)
                   else coalesce(nullif(v_name, ''), pg_catalog.substr(t.tx, 4)) end;

    if t.w_days >= 2 and pg_catalog.abs(t.w_ppm) >= v_ow then
      insert into pg_temp._health_now values (
        'transmitter-off-channel', t.tx, v_sid, null, null,
        case when pg_catalog.abs(t.w_ppm) >= v_oc then 'critical' else 'warn' end,
        v_name || ': transmitting ' || pg_catalog.to_char(t.w_ppm, 'FMSG9990.0') || ' ppm off the others ('
          || pg_catalog.to_char(t.w_hz, 'FMSG999990') || ' Hz)',
        'Over the last ' || t.w_days || ' days its carrier has been ' || pg_catalog.round(pg_catalog.abs(t.w_hz))::text
          || ' Hz ' || case when t.w_hz > 0 then 'above' else 'below' end || ' the other transmitters the same receivers hear — '
          || pg_catalog.to_char(pg_catalog.abs(t.w_ppm), 'FM990.0') || ' ppm at ' || pg_catalog.to_char(t.freq, 'FM990.0000')
          || ' MHz. A transmitter this far off decodes worse and then not at all; its frequency wants checking at the next visit.',
        pg_catalog.jsonb_build_object('tx', t.tx, 'protocol', t.protocol, 'via', t.via, 'category', 'comms',
          'action', 'Check the transmitter''s frequency at the next visit; a crystal this far off is due for replacement.',
          'offset_ppm', pg_catalog.round(t.w_ppm::numeric, 2), 'offset_hz', pg_catalog.round(t.w_hz::numeric),
          'days', t.w_days, 'bursts', t.w_bursts, 'receivers', t.receivers, 'freq_mhz', t.freq,
          'warn_ppm', v_ow, 'critical_ppm', v_oc)
          || case when t.tx like 'a2:%' then pg_catalog.jsonb_build_object('addr', pg_catalog.substr(t.tx, 4)::integer) else '{}'::jsonb end);
    end if;

    if t.w_days >= 3 and t.b_days >= 5 and pg_catalog.abs(t.w_ppm - t.b_ppm) >= v_dw then
      insert into pg_temp._health_now values (
        'transmitter-drift', t.tx, v_sid, null, null,
        case when pg_catalog.abs(t.w_ppm - t.b_ppm) >= v_dc then 'critical' else 'warn' end,
        v_name || ': drifted ' || pg_catalog.to_char(t.w_ppm - t.b_ppm, 'FMSG9990.0') || ' ppm in a week',
        'Its carrier offset against the other transmitters was ' || pg_catalog.to_char(t.b_ppm, 'FMSG9990.00') || ' ppm over the '
          || t.b_days || ' days before last week, and ' || pg_catalog.to_char(t.w_ppm, 'FMSG9990.00') || ' ppm over the last '
          || t.w_days || '. A crystal moving this fast is ageing or failing, or the site is running hot or cold; it tends to end in silence.',
        pg_catalog.jsonb_build_object('tx', t.tx, 'protocol', t.protocol, 'via', t.via, 'category', 'comms',
          'action', 'Its crystal is moving: check the frequency soon, and the site''s temperature and power — before it goes quiet.',
          'recent_ppm', pg_catalog.round(t.w_ppm::numeric, 2), 'earlier_ppm', pg_catalog.round(t.b_ppm::numeric, 2),
          'recent_days', t.w_days, 'earlier_days', t.b_days, 'receivers', t.receivers, 'freq_mhz', t.freq,
          'warn_ppm', v_dw, 'critical_ppm', v_dc)
          || case when t.tx like 'a2:%' then pg_catalog.jsonb_build_object('addr', pg_catalog.substr(t.tx, 4)::integer) else '{}'::jsonb end);
    end if;
  end loop;

  -- ── Who corrupts (0078) ──────────────────────────────────────────────────
  -- Each transmitter's last 7 days: what it sent (its bursts by carrier, the
  -- corrupted ones too) and how much of it was a corrupted copy; how many of
  -- those were clear — as strong as the clean copy, within 6 dB: it sent wrong
  -- bits, not our receiver mishearing a weak one — and how many reached us
  -- clean from upstream as well (the corruption entered at this transmitter:
  -- its own receiver, or itself). Only clear ones make a finding.
  drop table if exists pg_temp._fs;
  create temporary table _fs on commit drop as
  with sent as (
    select c.tx, pg_catalog.min(c.station_id) as sid, pg_catalog.sum(c.n + c.n_out)::bigint as bursts
      from meganet.carrier_daily c
     where c.protocol = 'alert' and c.day > v_today - 7
     group by c.tx
  ), fl as (
    select f.bad_tx as tx, pg_catalog.count(*)::integer as flips,
           -- Clear: as strong as the clean copy, within 6 dB (or not known) — it
           -- was sent wrong; a much weaker one may be this receiver mishearing.
           pg_catalog.count(*) filter (where f.bad_snr is null or f.good_snr is null or f.bad_snr >= f.good_snr - 6)::integer as clear,
           -- The clean version from someone else, and the corrupted one not the
           -- station's own: the corruption entered on the way, here.
           pg_catalog.count(*) filter (where f.good_tx is not null and f.good_tx <> f.bad_tx
                                         and f.bad_tx is distinct from 'st:' || meganet.resolve_station(f.true_addr, null))::integer as clean_upstream,
           pg_catalog.count(*) filter (where f.addr_flip)::integer as addr_flips,
           pg_catalog.count(distinct f.true_addr)::integer as addrs,
           (select pg_catalog.jsonb_agg(z order by z.n desc) from (
              select f2.true_addr as true_addr, f2.bad_addr as bad_addr, pg_catalog.count(*) as n
                from meganet.flip_event f2 where f2.bad_tx = f.bad_tx and f2.day > v_today - 7
               group by 1, 2 order by 3 desc limit 5) z) as top
      from meganet.flip_event f
     where f.day > v_today - 7 and f.bad_tx is not null
     group by f.bad_tx
  )
  select s.tx, s.sid, s.bursts, coalesce(fl.flips, 0) as flips, coalesce(fl.clear, 0) as clear,
         coalesce(fl.clean_upstream, 0) as clean_upstream, coalesce(fl.addr_flips, 0) as addr_flips, coalesce(fl.addrs, 0) as addrs,
         fl.top, coalesce(fl.flips, 0)::double precision / nullif(s.bursts + coalesce(fl.flips, 0), 0) as rate,
         coalesce(fl.clear, 0)::double precision / nullif(s.bursts + coalesce(fl.flips, 0), 0) as clear_rate
    from sent s left join fl on fl.tx = s.tx;

  v_fleet := (select pg_catalog.percentile_cont(0.5) within group (order by z.clear_rate) from _fs z where z.bursts >= 30);
  for t in select * from _fs z where z.clear >= v_fmin and z.clear_rate >= greatest(v_fw, 3 * coalesce(v_fleet, 0)) loop
    v_sid := case when t.tx like 'st:%' then pg_catalog.substr(t.tx, 4) end;
    v_name := (select st.name from meganet.station st where st.id = v_sid);
    v_name := case when t.tx like 'a:%' then 'ALERT ' || pg_catalog.substr(t.tx, 3)
                   else coalesce(nullif(v_name, ''), pg_catalog.substr(t.tx, 4)) end;
    insert into pg_temp._health_now values (
      'transmitter-corrupting', t.tx, v_sid, null, null,
      case when t.clear_rate >= v_fc then 'critical' else 'warn' end,
      v_name || ': ' || t.flips || ' corrupted cop' || case when t.flips = 1 then 'y' else 'ies' end || ' in a week ('
        || pg_catalog.to_char(t.rate * 100, 'FM990.0') || '% of what it sent)',
      'Its own carrier carried ' || t.flips || ' copies of other stations'' readings with one or two bits wrong over the last 7 days, out of '
        || (t.bursts + t.flips) || ' bursts it sent — against ' || pg_catalog.to_char(coalesce(v_fleet, 0) * 100, 'FM990.00')
        || '% for a typical transmitter. ' || t.clear || ' of them arrived as strong as the clean copy, so it sent the wrong bits rather than this receiver mishearing them'
        || case when t.clean_upstream > 0 then '; ' || t.clean_upstream || ' times the clean version reached us from upstream as well, so the corruption entered here' else '' end
        || '. ' || t.addr_flips || ' were wrong in the address — a reading turning up under another station''s number.',
      pg_catalog.jsonb_build_object('tx', t.tx, 'protocol', 'alert', 'category', 'comms',
        'action', 'Look at this transmitter first for the network''s bit flips: its receiver (interference or a weak input at its site), its modem, or its own transmitter. The Bit Flipper shows which addresses it corrupts and into what.',
        'flips', t.flips, 'bursts', t.bursts + t.flips, 'rate', pg_catalog.round(t.rate::numeric, 4), 'clear', t.clear,
        'clear_rate', pg_catalog.round(t.clear_rate::numeric, 4),
        'clean_upstream', t.clean_upstream, 'addr_flips', t.addr_flips, 'addresses', t.addrs, 'top', t.top,
        'fleet_rate', pg_catalog.round(coalesce(v_fleet, 0)::numeric, 4), 'warn_rate', v_fw, 'critical_rate', v_fc));
  end loop;

  delete from meganet.flip_summary where true;
  insert into meganet.flip_summary (tx, station_id, bursts, flips, rate, clear, clear_rate, clean_upstream, addr_flips, addresses, top, fleet_rate, judged_at)
  select z.tx, z.sid, z.bursts + z.flips, z.flips, z.rate, z.clear, z.clear_rate, z.clean_upstream, z.addr_flips, z.addrs, coalesce(z.top, '[]'::jsonb), v_fleet, p_now
    from _fs z;

  -- What the tab draws: every transmitter judged, as judged.
  delete from meganet.transmitter_summary where true;
  insert into meganet.transmitter_summary (tx, protocol, station_id, via, freq_mhz, w_days, w_ppm, w_hz, b_days, b_ppm,
                                           change_ppm, bursts, receivers, days, ppm, judged_at)
  select z.tx, z.protocol,
         case when z.tx like 'a2:%' then meganet.resolve_a2_station(pg_catalog.substr(z.tx, 4)::integer) else z.station_id end,
         z.via, z.freq, z.w_days, z.w_ppm, z.w_hz, z.b_days, z.b_ppm,
         case when z.w_days >= 3 and z.b_days >= 5 then z.w_ppm - z.b_ppm end,
         z.w_bursts, z.receivers, z.days, z.ppm, p_now
    from _ts z;

  v_out := meganet.health_apply('transmitters', p_now, true);
  v_took := greatest(0, extract(epoch from pg_catalog.clock_timestamp() - v_started) * 1000)::integer;
  insert into meganet.health_refresh as hr (source, at, took_ms, detail)
  values ('transmitters', p_now, v_took, pg_catalog.jsonb_build_object('transmitters', v_judged))
  on conflict (source) do update set at = excluded.at, took_ms = excluded.took_ms, detail = excluded.detail;

  return pg_catalog.jsonb_build_object('at', p_now, 'took_ms', v_took, 'judged', v_judged) || v_out;
end;
$$;

comment on function meganet.refresh_transmitter_findings(timestamptz) is
  'Judges every transmitter (0075, 0077, 0078, 0082): transmitter-off-channel, transmitter-drift and transmitter-corrupting findings, transmitter_summary and flip_summary for the Station Health tab. pg_cron hourly (meganet-transmitter-health). The owner and service_role only.';

-- ── Grants ───────────────────────────────────────────────────────────────────
-- create or replace keeps them; said again so this file stands on its own.

revoke all on function meganet.refresh_transmitter_findings(timestamptz) from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;
  grant execute on function meganet.refresh_transmitter_findings(timestamptz) to service_role;
end
$$;

-- ── The findings open now, retitled ──────────────────────────────────────────
-- The hourly run (pg_cron, minute 13) holds this lock while it judges, and the
-- function skips a run that cannot take it: wait for that one to finish first
-- (the session then holds the lock, and the function's own try takes it).

do $$
declare
  v jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock(5900217);
  v := meganet.refresh_transmitter_findings();
  if v ? 'skipped' then
    raise exception '0082 could not judge the transmitters (%) — apply it again', v ->> 'skipped';
  end if;
end
$$;

do $$
begin
  if exists (select 1 from meganet.health_finding h
              where h.source = 'transmitters' and h.cleared_at is null and h.title ~ '[+-]#') then
    raise exception '0082 did not take: an open transmitter finding is still titled with #';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 82 when this is applied.

insert into meganet.app_meta (key, value)
values ('schema_version', '82')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
