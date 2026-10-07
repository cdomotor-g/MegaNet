-- 0057_reading_latest.sql — The newest reading of every address, so "what is
-- every gauge saying now?" is one read.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0057_reading_latest.sql
--
-- Why this file exists
-- ────────────────────
-- #230 asks the agent API (worker/api.js) for every station's latest reading in
-- one call. That API reads only through PostgREST, only by GET, only with the
-- publishable key, and calls no function at all (CLAUDE.md) — so the answer
-- has to be a relation `anon` can select, and none of the public ones is it:
--
--   meganet.reading          every reading, for 90 days. "The newest one per
--                            address" is DISTINCT ON, which PostgREST cannot
--                            say. Without it the API would page through every
--                            reading in a window to keep one row in a hundred,
--                            and the window would decide what goes missing: a
--                            rain gauge reports on a tip, and can be days
--                            quieter than the water level on the same mast.
--   meganet.reading_hourly,  carry raw_last and val_last, but only as of the
--   meganet.reading_daily    last roll_up(), which retain() runs once a day or
--                            somebody runs by hand. Not "now".
--   meganet.station_health   when each station last sent a reading — not what
--                            it said, nor on which of its channels.
--
-- So, a view: one row per address, its newest reading. Newest by reading_ts,
-- the device's own time, as everywhere else in this schema (ingest() refuses a
-- time more than a day ahead, so a fast clock cannot hold the top for long);
-- of two readings at the same instant, the one received later. Every column is
-- one `anon` can already read on meganet.reading — the view adds no fact, only
-- the question — and it is security_invoker, so reading's own RLS answers. It
-- leaves out the bookkeeping: dup_paths, last_dup_at, raw_id, and the ingest
-- point a reading came in through (ingest points are editors only, 0045).
--
-- How it finds them
-- ─────────────────
-- DISTINCT ON (addr) would read every reading the table holds to keep one per
-- address: 90 days of the pilot is half a million rows; of the whole network,
-- eighty million. Postgres has no skip scan for that, so the view walks the
-- primary key (addr, reading_ts, value_raw) itself — the first address, then
-- the next one after it, one index probe each (a recursive CTE, the "loose
-- index scan") — and makes one backward probe per address for its newest
-- reading. Two probes per address, however many readings there are.
--
-- Depends on 0006 (meganet.reading), 0024 (its ALERT2 pair) and 0050 (its
-- frequency and signal); on nothing in 0053–0056, so it applies with or
-- without them. tools/check_reading_latest.sql proves it.

create or replace view meganet.reading_latest
with (security_invoker = true) as
with recursive addrs as (
  (select r.addr from meganet.reading r order by r.addr limit 1)
  union all
  select (select r.addr from meganet.reading r
           where r.addr > a.addr
           order by r.addr
           limit 1)
    from addrs a
   where a.addr is not null
)
select l.addr,
       l.alert_id,
       l.a2_station,
       l.a2_sensor,
       l.station_number,
       l.channel,
       l.station_id,
       l.reading_ts,
       l.received_at,
       l.value_raw,
       l.value,
       l.unit,
       l.conversion,
       l.quality,
       l.protocol,
       l.source,
       l.path,
       l.dup_count,
       l.freq_mhz,
       l.rssi_dbm,
       l.level_dbfs,
       l.snr_db
  from addrs a
  cross join lateral (
    select r.addr, r.alert_id, r.a2_station, r.a2_sensor, r.station_number, r.channel,
           r.station_id, r.reading_ts, r.received_at, r.value_raw, r.value, r.unit,
           r.conversion, r.quality, r.protocol, r.source, r.path, r.dup_count,
           r.freq_mhz, r.rssi_dbm, r.level_dbfs, r.snr_db
      from meganet.reading r
     where r.addr = a.addr
     order by r.reading_ts desc, r.received_at desc, r.value_raw desc
     limit 1
  ) l
 where a.addr is not null;

comment on view meganet.reading_latest is
  'One row per address: its newest reading in meganet.reading — the latest reading_ts (the device''s time), and of two at the same instant the later received. Walks the primary key, two index probes per address, so its cost is the number of addresses rather than of readings. What the agent API''s GET /api/v1/readings/latest reads (0057). security_invoker.';

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  grant select on meganet.reading_latest to anon, authenticated, service_role;

  notify pgrst, 'reload schema';
end
$$;

-- ── Proof it took ────────────────────────────────────────────────────────────

do $$
begin
  if pg_catalog.to_regclass('meganet.reading_latest') is null then
    raise exception '0057 did not take: meganet.reading_latest is missing';
  end if;
  if not exists (select 1 from pg_catalog.pg_class c
                  where c.oid = 'meganet.reading_latest'::pg_catalog.regclass
                    and 'security_invoker=true' = any (coalesce(c.reloptions, '{}'))) then
    raise exception '0057 did not take: meganet.reading_latest is not security_invoker';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
     and exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    if not pg_catalog.has_table_privilege('anon', 'meganet.reading_latest', 'select') then
      raise exception '0057 did not take: anon cannot read meganet.reading_latest';
    end if;
    if pg_catalog.has_table_privilege('anon', 'meganet.reading_latest', 'insert,update,delete') then
      raise exception '0057 did not take: anon can write through meganet.reading_latest';
    end if;
  end if;
  if exists (select 1 from meganet.reading_latest group by addr having pg_catalog.count(*) > 1) then
    raise exception '0057 did not take: meganet.reading_latest has an address twice';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION follows once this is live, as for 0053–0055. The
-- guard means applying it before or after 0056 leaves the higher number.

insert into meganet.app_meta (key, value)
values ('schema_version', '57')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
