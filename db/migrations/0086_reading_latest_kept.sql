-- 0086_reading_latest_kept.sql — Each address's newest reading, kept as the
-- readings arrive, so meganet.reading_latest answers at once rather than
-- working it out on every read.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0086_reading_latest_kept.sql
--
-- Why this file exists
-- ────────────────────
-- 0057 made reading_latest a view that walks meganet.reading's primary key:
-- two index probes per address, every time it is read. At 6,738 addresses
-- (October 2026) that is 3.2 s — past the 3 s statement timeout the anon role
-- has — so the agent API's GET /api/v1/readings/latest answered 503 (57014)
-- on and off, and a field team's request for one site's box failed every
-- time: a filter on the view could not reach inside the walk, so a box around
-- one site cost what the whole network did.
--
--   1. reading_newest      one row per address: its newest reading, by the
--                          rule 0057 wrote down — the latest reading_ts (the
--                          device's own time), then the later received, then
--                          the larger value. Indexed by station, so a page of
--                          stations is one probe each.
--   2. reading_newest_keep the trigger that keeps it, after every insert,
--                          update and delete on meganet.reading: a newer
--                          reading takes an address's row; a change to, or the
--                          deletion of, the reading an address's row came from
--                          works that address out again from meganet.reading
--                          (one index probe) — a duplicate's count, a station
--                          resolved later, a day the archive released.
--   3. reading_latest      the same view, the same columns in the same order,
--                          now reading the table. Nothing that reads it
--                          changes.
--
-- The rows are copied once, from the walk 0057 did, while the trigger already
-- holds meganet.reading against writes; ingest waits for the few seconds that
-- takes rather than slipping a reading between the copy and the trigger.
--
-- Who reads it: everybody, as meganet.reading (0006, 0050). Nobody writes it
-- but the trigger, which runs as the owner.
--
-- Depends on 0006, 0024, 0050 (the reading's columns) and 0057 (the view).
-- tools/check_reading_latest.sql proves it.

-- ── 1. The newest reading of each address ────────────────────────────────────

create table if not exists meganet.reading_newest (
  addr            text         primary key,
  alert_id        integer,
  a2_station      integer,
  a2_sensor       integer,
  station_number  text,
  channel         text         not null,
  station_id      text,
  reading_ts      timestamptz  not null,
  received_at     timestamptz  not null,
  value_raw       numeric      not null,
  value           numeric,
  unit            text,
  conversion      text,
  quality         smallint     not null,
  protocol        smallint     not null,
  source          smallint     not null,
  path            text,
  dup_count       integer      not null,
  freq_mhz        numeric,
  rssi_dbm        real,
  level_dbfs      real,
  snr_db          real
);

comment on table meganet.reading_newest is
  'One row per address: its newest reading in meganet.reading — the latest reading_ts, then the later received, then the larger value — kept by the trigger reading_newest_keep as readings arrive, change and go (0086). What meganet.reading_latest reads. Public, as the readings are; written by the trigger alone.';

create index if not exists reading_newest_station_idx
  on meganet.reading_newest (station_id) where station_id is not null;

alter table meganet.reading_newest enable row level security;
drop policy if exists reading_newest_read on meganet.reading_newest;
create policy reading_newest_read on meganet.reading_newest
  for select to anon, authenticated
  using (true);

-- ── 2. Keeping it ────────────────────────────────────────────────────────────

-- An address worked out again from meganet.reading: its newest row, or none.
create or replace function meganet.reading_newest_redo(p_addr text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into meganet.reading_newest as n (addr, alert_id, a2_station, a2_sensor, station_number, channel, station_id,
    reading_ts, received_at, value_raw, value, unit, conversion, quality, protocol, source, path, dup_count,
    freq_mhz, rssi_dbm, level_dbfs, snr_db)
  select r.addr, r.alert_id, r.a2_station, r.a2_sensor, r.station_number, r.channel, r.station_id,
         r.reading_ts, r.received_at, r.value_raw, r.value, r.unit, r.conversion, r.quality, r.protocol, r.source,
         r.path, r.dup_count, r.freq_mhz, r.rssi_dbm, r.level_dbfs, r.snr_db
    from meganet.reading r
   where r.addr = p_addr
   order by r.reading_ts desc, r.received_at desc, r.value_raw desc
   limit 1
  on conflict (addr) do update set
    alert_id = excluded.alert_id, a2_station = excluded.a2_station, a2_sensor = excluded.a2_sensor,
    station_number = excluded.station_number, channel = excluded.channel, station_id = excluded.station_id,
    reading_ts = excluded.reading_ts, received_at = excluded.received_at, value_raw = excluded.value_raw,
    value = excluded.value, unit = excluded.unit, conversion = excluded.conversion, quality = excluded.quality,
    protocol = excluded.protocol, source = excluded.source, path = excluded.path, dup_count = excluded.dup_count,
    freq_mhz = excluded.freq_mhz, rssi_dbm = excluded.rssi_dbm, level_dbfs = excluded.level_dbfs, snr_db = excluded.snr_db;
  if not found then
    delete from meganet.reading_newest n where n.addr = p_addr;
  end if;
end;
$$;

comment on function meganet.reading_newest_redo(text) is
  'Works one address''s row of meganet.reading_newest out again from meganet.reading — its newest reading, or no row (0086). Internal.';

create or replace function meganet.reading_newest_keep()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The reading an address's row came from, changed or gone: that address
  -- again, from scratch. Anything else that changed can only be newer or not.
  if tg_op = 'DELETE' then
    if exists (select 1 from meganet.reading_newest n
                where n.addr = old.addr and n.reading_ts = old.reading_ts and n.value_raw = old.value_raw) then
      perform meganet.reading_newest_redo(old.addr);
    end if;
    return null;
  end if;
  if tg_op = 'UPDATE' and exists (
       select 1 from meganet.reading_newest n
        where n.addr = old.addr and n.reading_ts = old.reading_ts and n.value_raw = old.value_raw) then
    perform meganet.reading_newest_redo(old.addr);
    if new.addr = old.addr then
      return null;
    end if;
  end if;

  insert into meganet.reading_newest as n (addr, alert_id, a2_station, a2_sensor, station_number, channel, station_id,
    reading_ts, received_at, value_raw, value, unit, conversion, quality, protocol, source, path, dup_count,
    freq_mhz, rssi_dbm, level_dbfs, snr_db)
  values (new.addr, new.alert_id, new.a2_station, new.a2_sensor, new.station_number, new.channel, new.station_id,
    new.reading_ts, new.received_at, new.value_raw, new.value, new.unit, new.conversion, new.quality, new.protocol,
    new.source, new.path, new.dup_count, new.freq_mhz, new.rssi_dbm, new.level_dbfs, new.snr_db)
  on conflict (addr) do update set
    alert_id = excluded.alert_id, a2_station = excluded.a2_station, a2_sensor = excluded.a2_sensor,
    station_number = excluded.station_number, channel = excluded.channel, station_id = excluded.station_id,
    reading_ts = excluded.reading_ts, received_at = excluded.received_at, value_raw = excluded.value_raw,
    value = excluded.value, unit = excluded.unit, conversion = excluded.conversion, quality = excluded.quality,
    protocol = excluded.protocol, source = excluded.source, path = excluded.path, dup_count = excluded.dup_count,
    freq_mhz = excluded.freq_mhz, rssi_dbm = excluded.rssi_dbm, level_dbfs = excluded.level_dbfs, snr_db = excluded.snr_db
  where (excluded.reading_ts, excluded.received_at, excluded.value_raw) > (n.reading_ts, n.received_at, n.value_raw);
  return null;
end;
$$;

comment on function meganet.reading_newest_keep() is
  'After each insert, update and delete on meganet.reading: keeps meganet.reading_newest — a newer reading takes its address''s row; a change to, or the deletion of, the reading a row came from works that address out again (0086). Internal.';

revoke all on function meganet.reading_newest_redo(text) from public;
revoke all on function meganet.reading_newest_keep()     from public;

-- Creating the trigger locks meganet.reading against writes until this
-- commits, so no reading slips between it and the copy below.
drop trigger if exists reading_newest_keep on meganet.reading;
create trigger reading_newest_keep
  after insert or update or delete on meganet.reading
  for each row execute function meganet.reading_newest_keep();

-- ── The rows, once: 0057's walk, two index probes per address ────────────────

insert into meganet.reading_newest as n (addr, alert_id, a2_station, a2_sensor, station_number, channel, station_id,
  reading_ts, received_at, value_raw, value, unit, conversion, quality, protocol, source, path, dup_count,
  freq_mhz, rssi_dbm, level_dbfs, snr_db)
with recursive addrs as (
  (select r.addr from meganet.reading r order by r.addr limit 1)
  union all
  select (select r.addr from meganet.reading r where r.addr > a.addr order by r.addr limit 1)
    from addrs a
   where a.addr is not null
)
select l.addr, l.alert_id, l.a2_station, l.a2_sensor, l.station_number, l.channel, l.station_id,
       l.reading_ts, l.received_at, l.value_raw, l.value, l.unit, l.conversion, l.quality, l.protocol, l.source,
       l.path, l.dup_count, l.freq_mhz, l.rssi_dbm, l.level_dbfs, l.snr_db
  from addrs a
  cross join lateral (
    select r.* from meganet.reading r
     where r.addr = a.addr
     order by r.reading_ts desc, r.received_at desc, r.value_raw desc
     limit 1
  ) l
 where a.addr is not null
on conflict (addr) do update set
  alert_id = excluded.alert_id, a2_station = excluded.a2_station, a2_sensor = excluded.a2_sensor,
  station_number = excluded.station_number, channel = excluded.channel, station_id = excluded.station_id,
  reading_ts = excluded.reading_ts, received_at = excluded.received_at, value_raw = excluded.value_raw,
  value = excluded.value, unit = excluded.unit, conversion = excluded.conversion, quality = excluded.quality,
  protocol = excluded.protocol, source = excluded.source, path = excluded.path, dup_count = excluded.dup_count,
  freq_mhz = excluded.freq_mhz, rssi_dbm = excluded.rssi_dbm, level_dbfs = excluded.level_dbfs, snr_db = excluded.snr_db;

-- An address with no reading left (applied again after the archive released
-- its days) has no row.
delete from meganet.reading_newest n
 where not exists (select 1 from meganet.reading r where r.addr = n.addr);

-- ── 3. The view, reading the table ───────────────────────────────────────────

create or replace view meganet.reading_latest
with (security_invoker = true) as
select n.addr,
       n.alert_id,
       n.a2_station,
       n.a2_sensor,
       n.station_number,
       n.channel,
       n.station_id,
       n.reading_ts,
       n.received_at,
       n.value_raw,
       n.value,
       n.unit,
       n.conversion,
       n.quality,
       n.protocol,
       n.source,
       n.path,
       n.dup_count,
       n.freq_mhz,
       n.rssi_dbm,
       n.level_dbfs,
       n.snr_db
  from meganet.reading_newest n;

comment on view meganet.reading_latest is
  'One row per address: its newest reading in meganet.reading — the latest reading_ts (the device''s time), and of two at the same instant the later received. Reads meganet.reading_newest, which a trigger keeps as readings arrive (0086; until then it walked the primary key on every read, 0057). What the agent API''s GET /api/v1/readings/latest reads. security_invoker.';

-- ── Grants ───────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  grant select on meganet.reading_newest to anon, authenticated, service_role;
  grant select on meganet.reading_latest to anon, authenticated, service_role;

  notify pgrst, 'reload schema';
end
$$;

-- ── Proof it took ────────────────────────────────────────────────────────────

do $$
begin
  if pg_catalog.to_regclass('meganet.reading_newest') is null then
    raise exception '0086 did not take: meganet.reading_newest is missing';
  end if;
  if not exists (select 1 from pg_catalog.pg_trigger t
                  where t.tgrelid = 'meganet.reading'::pg_catalog.regclass and t.tgname = 'reading_newest_keep'
                    and not t.tgisinternal) then
    raise exception '0086 did not take: the trigger that keeps it is missing';
  end if;
  if (select pg_catalog.count(*) from meganet.reading_newest)
     <> (select pg_catalog.count(distinct r.addr) from meganet.reading r) then
    raise exception '0086 did not take: reading_newest does not hold one row for every address meganet.reading has';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
     and exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    if not pg_catalog.has_table_privilege('anon', 'meganet.reading_latest', 'select')
       or not pg_catalog.has_table_privilege('anon', 'meganet.reading_newest', 'select') then
      raise exception '0086 did not take: anon cannot read the newest readings';
    end if;
    if pg_catalog.has_table_privilege('anon', 'meganet.reading_newest', 'insert,update,delete')
       or pg_catalog.has_table_privilege('authenticated', 'meganet.reading_newest', 'insert,update,delete') then
      raise exception '0086 did not take: a browser role can write meganet.reading_newest';
    end if;
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION follows once this is live.

insert into meganet.app_meta (key, value)
values ('schema_version', '86')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
