-- 0079_flip_sources.sql — The Bit-Flip Sources tab's evidence, built hourly:
-- which stations' readings are being corrupted, which repeaters could have
-- done it and at what rate, who the carrier fingerprint says did, and when.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0079_flip_sources.sql
--
-- After 0078.
--
-- Why this file exists
-- ────────────────────
-- 0078 finds corrupted copies and charges each to the transmitter whose
-- carrier it came on. That needs a carrier, and on the day it went live 2,244
-- of the 2,262 found had none — they predate RPi ALERT 0.14. The circumstantial
-- evidence still says a lot, if it is weighed: a corrupted copy of a reading
-- is the work of one of the repeaters that pass its address. Split evenly
-- between them (Station Health's repeater-bitflips does this in the browser)
-- the broad-ranged repeaters top the list just by passing the most stations:
-- on the live fortnight Hillcrest (Wine Glass) and Constitution Hill each
-- "carry" 250 of the corrupted stations. What separates a suspect is its
-- **rate** — its share of the corrupted copies against its share of everything
-- heard from the addresses it passes — and how many it was the only possible
-- carrier of. On that fortnight Schultz Lookout (8.0%), Toowoomba (6.1%, 135
-- only it could have carried) and Mt Petersen (5.8%) stood at two to three
-- times the rest.
--
-- meganet.flip_sources — one public row per period (7 and 30 days), a jsonb
-- the tab draws as it is, rebuilt hourly (pg_cron meganet-flip-sources, minute
-- 14, after the transmitter findings at 13):
--   candidates  every repeater that passes a corrupted address: its split share
--               (`blame`), the corrupted copies only it could have carried
--               (`only`), the stations hit, what it carried (receptions of the
--               addresses it passes, split the same way, from reception_daily),
--               the rate, and the copies the carrier fingerprint put on it
--               (`by_carrier`, `clear`);
--   stations    each corrupted address: how many, how many into other
--               addresses, what it became, who sent the corrupted copies (by
--               carrier), and the repeaters that could have;
--   hours       corrupted copies by hour of day, Brisbane time — interference
--               keeps hours, a failing radio does not;
--   days        corrupted copies a day;
--   network_rate  all corrupted copies against everything heard.
-- No receiver is named.

create table if not exists meganet.flip_sources (
  period_days  integer      primary key check (period_days between 1 and 90),
  data         jsonb        not null,
  built_at     timestamptz  not null
);
comment on table meganet.flip_sources is
  'The Bit-Flip Sources tab''s evidence (0079), a row per period (7, 30 days), rebuilt hourly by refresh_flip_sources(): candidate repeaters with their pass-range share, rate and carrier-fingerprint count; the corrupted stations; corrupted copies by hour and day. Public: no receiver is named.';

alter table meganet.flip_sources enable row level security;
drop policy if exists flip_sources_read_all on meganet.flip_sources;
create policy flip_sources_read_all on meganet.flip_sources for select using (true);

create or replace function meganet.flip_sources_build(p_days integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_days  integer := least(greatest(coalesce(p_days, 7), 1), 90);
  v_from  date := (pg_catalog.now() at time zone 'UTC')::date - v_days;   -- day > v_from
  v_out   jsonb;
begin
  -- The live repeaters and the addresses each passes (less exclusions).
  drop table if exists pg_temp._fs_rp;
  create temporary table _fs_rp on commit drop as
  select s.id as rid, s.name, s.lat, s.lon from meganet.repeater r
    join meganet.station s on s.id = r.station_id and s.deleted_at is null;

  drop table if exists pg_temp._fs_f;
  create temporary table _fs_f on commit drop as
  select f.* from meganet.flip_event f where f.day > v_from;

  -- Each corrupted copy's possible carriers.
  drop table if exists pg_temp._fs_c;
  create temporary table _fs_c on commit drop as
  select distinct f.id, rp.rid
    from _fs_f f
    join meganet.pass_range p on p.kind = 'pass' and f.true_addr between p.lo and p.hi
    join _fs_rp rp on rp.rid = p.repeater_id
   where not exists (select 1 from meganet.pass_range e where e.repeater_id = p.repeater_id
                      and e.kind = 'exclusion' and f.true_addr between e.lo and e.hi);
  drop table if exists pg_temp._fs_k;
  create temporary table _fs_k on commit drop as
  select c.id, pg_catalog.count(*) as k from _fs_c c group by 1;

  -- What each repeater could have carried: every ok reception of the
  -- addresses it passes, split between the repeaters that pass each.
  drop table if exists pg_temp._fs_heard;
  create temporary table _fs_heard on commit drop as
  select h.station as a, pg_catalog.sum(h.n_ok)::numeric as n
    from meganet.reception_daily h
   where h.protocol = 'alert' and h.bucket > v_from and h.station between 0 and 8191
   group by 1;
  drop table if exists pg_temp._fs_hp;
  create temporary table _fs_hp on commit drop as
  select distinct hd.a, hd.n, rp.rid
    from _fs_heard hd
    join meganet.pass_range p on p.kind = 'pass' and hd.a between p.lo and p.hi
    join _fs_rp rp on rp.rid = p.repeater_id
   where not exists (select 1 from meganet.pass_range e where e.repeater_id = p.repeater_id
                      and e.kind = 'exclusion' and hd.a between e.lo and e.hi);

  with hk as (select x.a, pg_catalog.count(*) as k from _fs_hp x group by 1),
  carried as (select x.rid, pg_catalog.sum(x.n / hk.k) as n from _fs_hp x join hk on hk.a = x.a group by 1),
  cand as (
    select c.rid, pg_catalog.sum(1.0 / k.k) as blame, pg_catalog.count(*) filter (where k.k = 1) as only_it,
           pg_catalog.count(distinct f.true_addr) as stations
      from _fs_c c join _fs_k k on k.id = c.id join _fs_f f on f.id = c.id
     group by 1
  ),
  bycar as (
    select pg_catalog.substr(f.bad_tx, 4) as rid, pg_catalog.count(*) as n,
           pg_catalog.count(*) filter (where f.bad_snr is null or f.good_snr is null or f.bad_snr >= f.good_snr - 6) as clear
      from _fs_f f where f.bad_tx like 'st:%' group by 1
  ),
  rows_c as (
    select rp.rid, rp.name, rp.lat, rp.lon,
           pg_catalog.round(coalesce(cand.blame, 0)::numeric, 1) as blame, coalesce(cand.only_it, 0) as only_it,
           coalesce(cand.stations, 0) as stations, pg_catalog.round(coalesce(carried.n, 0)) as carried,
           case when carried.n > 0 then pg_catalog.round((coalesce(cand.blame, 0) / carried.n)::numeric, 5) end as rate,
           coalesce(bycar.n, 0) as by_carrier, coalesce(bycar.clear, 0) as clear
      from _fs_rp rp
      left join cand on cand.rid = rp.rid
      left join carried on carried.rid = rp.rid
      left join bycar on bycar.rid = rp.rid
     where cand.rid is not null or bycar.rid is not null
  ),
  st as (
    select f.true_addr as a,
           (select se.station_id from meganet.sensor se join meganet.station s on s.id = se.station_id and s.deleted_at is null
             where se.alert_id = f.true_addr order by se.station_id limit 1) as station_id,
           pg_catalog.count(*) as n, pg_catalog.count(*) filter (where f.addr_flip) as addr_flips,
           pg_catalog.count(*) filter (where f.bad_how = 'no-carrier') as no_carrier,
           pg_catalog.min(f.heard_at) as first_at, pg_catalog.max(f.heard_at) as last_at
      from _fs_f f group by 1
  )
  select pg_catalog.jsonb_build_object(
    'days', v_days,
    'built_at', pg_catalog.now(),
    'corrupted', (select pg_catalog.count(*) from _fs_f),
    'by_how', coalesce((select pg_catalog.jsonb_object_agg(z.bad_how, z.n) from
                (select f.bad_how, pg_catalog.count(*) as n from _fs_f f group by 1) z), '{}'::jsonb),
    'heard', coalesce((select pg_catalog.sum(hd.n) from _fs_heard hd), 0),
    'network_rate', (select pg_catalog.round((pg_catalog.count(*)::numeric / nullif((select pg_catalog.sum(hd.n) from _fs_heard hd), 0)), 5) from _fs_f),
    'candidates', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) order by r.by_carrier desc, r.rate desc nulls last, r.blame desc)
                              from rows_c r), '[]'::jsonb),
    'stations', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'addr', s.a, 'station_id', s.station_id, 'n', s.n, 'addr_flips', s.addr_flips, 'no_carrier', s.no_carrier,
        'first_at', s.first_at, 'last_at', s.last_at,
        'targets', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('addr', t.bad_addr, 'n', t.n) order by t.n desc)
                    from (select f.bad_addr, pg_catalog.count(*) as n from _fs_f f where f.true_addr = s.a and f.addr_flip
                           group by 1 order by 2 desc limit 6) t), '[]'::jsonb),
        'senders', coalesce((select pg_catalog.jsonb_object_agg(t.bad_tx, t.n)
                    from (select f.bad_tx, pg_catalog.count(*) as n from _fs_f f where f.true_addr = s.a and f.bad_tx is not null
                           group by 1) t), '{}'::jsonb),
        'candidates', coalesce((select pg_catalog.jsonb_agg(distinct c.rid)
                    from _fs_c c join _fs_f f on f.id = c.id where f.true_addr = s.a), '[]'::jsonb))
        order by s.n desc)
      from (select * from st order by n desc limit 300) s), '[]'::jsonb),
    'hours', (select pg_catalog.jsonb_agg(coalesce(z.n, 0) order by h.h)
                from pg_catalog.generate_series(0, 23) h(h)
                left join (select extract(hour from f.heard_at at time zone 'Australia/Brisbane')::integer as hr, pg_catalog.count(*) as n
                             from _fs_f f group by 1) z on z.hr = h.h),
    'per_day', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('day', z.day, 'n', z.n) order by z.day)
                from (select f.day, pg_catalog.count(*) as n from _fs_f f group by 1) z), '[]'::jsonb))
    into v_out;
  return v_out;
end;
$$;

comment on function meganet.flip_sources_build(integer) is
  'The Bit-Flip Sources evidence for the last p_days (0079) as one jsonb: candidates (pass-range share, only-it, stations hit, carried, rate, by carrier), stations, hours (Brisbane), per_day, network_rate. The service key''s; read it from flip_sources.';

create or replace function meganet.refresh_flip_sources()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d integer;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(5900219) then
    return pg_catalog.jsonb_build_object('skipped', 'another run is under way');
  end if;
  foreach d in array array[7, 30] loop
    insert into meganet.flip_sources (period_days, data, built_at)
    values (d, meganet.flip_sources_build(d), pg_catalog.now())
    on conflict (period_days) do update set data = excluded.data, built_at = excluded.built_at;
  end loop;
  return pg_catalog.jsonb_build_object('built', pg_catalog.now());
end;
$$;

comment on function meganet.refresh_flip_sources() is
  'Rebuilds meganet.flip_sources for 7 and 30 days (0079). pg_cron hourly at minute 14 (meganet-flip-sources). The service key''s.';

revoke all on function meganet.flip_sources_build(integer) from public;
revoke all on function meganet.refresh_flip_sources() from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;
  grant select on meganet.flip_sources to anon, authenticated, service_role;
  grant execute on function meganet.flip_sources_build(integer) to service_role;
  grant execute on function meganet.refresh_flip_sources() to service_role;
  notify pgrst, 'reload schema';
end
$$;

do $$
begin
  perform meganet.refresh_flip_sources();
end
$$;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron is not available on this server: nothing will run meganet.refresh_flip_sources() on a schedule.';
    return;
  end if;
  begin
    create extension if not exists pg_cron;
    perform cron.schedule('meganet-flip-sources', '14 * * * *', 'select meganet.refresh_flip_sources()');
    raise notice 'meganet.refresh_flip_sources() runs hourly at minute 14 (pg_cron job meganet-flip-sources).';
  exception when others then
    raise warning 'pg_cron could not be set up (%): the Bit-Flip Sources tab will not be refreshed until it is.', sqlerrm;
  end;
end
$$;

do $$
begin
  if pg_catalog.to_regclass('meganet.flip_sources') is null
     or not exists (select 1 from meganet.flip_sources where period_days = 7) then
    raise exception '0079 did not take: flip_sources is missing or empty';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 79 when this is applied.

insert into meganet.app_meta (key, value)
values ('schema_version', '79')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
