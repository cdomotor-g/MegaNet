-- 0116_receptions_public.sql — Every copy a base station heard, for anybody:
-- when, which base station, its frequency, level, SNR and carrier offset —
-- and, beside it, the repeaters whose carriers each receiver found that day,
-- so a copy can be put down to the station or repeater that sent it.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0116_receptions_public.sql
--
-- Why this file exists
-- ────────────────────
-- A reading is a value kept once (0006, 0096); its copies are counted on it
-- (dup_count, dup_paths) and nothing more. The receptions (0047) keep every
-- copy — the repeater's beside the station's own, with each one's signal —
-- and are what the Reception Map, Signal Routes and Repeaters read. They are
-- editors' only, because a reception can be a record of where a vehicle went
-- (a drive, a site survey) and carries the receiver's position.
--
-- A repeater's maintainer asked (11 November 2026) to read a station's copies
-- through the agent API after a site visit — to confirm a new repeater is
-- passing its IDs without opening the web app, from a field app. A fixed base
-- station's receptions say nothing about anybody's whereabouts: its name and
-- its receivers' codes are public already (0115), and a reading's path is.
--
-- What it publishes
-- ─────────────────
-- meganet.reception_public, one row a reception, only when all of these hold:
--   * the receiver is a named base station's (meganet.base_station_name);
--   * it was not moving and was not on a survey: its position, if any, came
--     from the station register or was typed in (location_source station,
--     manual or none — never gps or browser), no speed, no survey in detail;
--   * it was heard in the last three days. The table is the database's
--     largest (0.4 GB, ~3,000 rows an hour in November 2026) on a small disk
--     budget; a read with no time bound of its own reads at most this, and
--     the agent API reads an hour or a few at a time off reception_heard_idx.
-- Its columns: id, heard_at, the base station's name, the receiver and the
-- stick's path as a reading's path names them, protocol, alert_id,
-- value_raw, ok, fault, copy (the decoder had heard it already — a repeat or
-- another path's copy), the ALERT2 source and path, frequency, level, RSSI,
-- SNR, carrier offset (cfo_hz), cfo_split (a burst of two carriers, whose
-- average is neither's), the frame format.
-- Not: the position (lat, lon, accuracy, speed, heading), the payload, the
-- ingest token, votes, the rest of detail.
--
-- meganet.repeater_carrier_public, one row a receiver's stick, UTC day and
-- repeater: the repeater carriers roll_up_carriers_day() found in that day's
-- legacy bursts (0077, 0092: carrier_receiver_day.detail.repeaters) — the
-- repeater, the carrier's centre in Hz, how many of the addresses it passes
-- were heard on it. Four days, the named base stations' only. With the
-- register's pass ranges, which are public, that is what puts a legacy copy
-- down to a repeater: a copy within 30 Hz of exactly one of these carriers,
-- of an address that repeater passes. carrier_receiver_day stays the service
-- key's (its other counts).
--
-- Both deliberately not security_invoker, as 0102's station_benchmark_public
-- and 0115's base_station_name are not: what they carry is fixed here and
-- checked below.

create or replace view meganet.reception_public as
select r.id,
       r.heard_at,
       b.name                                   as base_station,
       b.receiver,
       'serial-monitor/' || r.point_id          as path,
       r.protocol,
       r.alert_id,
       r.value_raw,
       r.ok,
       r.fault,
       coalesce(r.a2_duplicate, false)          as copy,
       r.a2_source,
       r.a2_path,
       r.freq_mhz,
       r.level_dbfs,
       r.rssi_dbm,
       r.snr_db,
       r.cfo_hz,
       (r.detail ? 'cfo_split')                 as cfo_split,
       r.fmt
  from meganet.reception r
  join meganet.base_station_name b
    on b.receiver = 'serial-monitor/' || pg_catalog.regexp_replace(r.point_id, '-sdr\d+(-[\d.]+)?$', '')
 where r.heard_at > pg_catalog.now() - interval '3 days'
   and r.location_source in ('station', 'manual', 'none')
   and coalesce(r.speed_mps, 0) = 0
   and not (r.detail ? 'survey');

comment on view meganet.reception_public is
  'Every copy a named base station heard in the last three days, for anybody (0116): when, which base station and stick, protocol, address, value, whether it decoded, whether it was a copy, the ALERT2 source and path, frequency, level, RSSI, SNR and carrier offset. Only fixed receivers — never a moving one or a survey — and never a position, payload or token: those are meganet.reception''s, for editors. Read it a few hours at a time by heard_at.';

create or replace view meganet.repeater_carrier_public as
select d.day,
       b.base_station,
       b.receiver,
       'serial-monitor/' || d.point_id          as path,
       e ->> 'station_id'                       as station_id,
       (e ->> 'centre_hz')::double precision    as centre_hz,
       (e ->> 'addresses')::integer             as addresses
  from meganet.carrier_receiver_day d
  join (select n.name as base_station, n.receiver from meganet.base_station_name n) b
    on b.receiver = 'serial-monitor/' || pg_catalog.regexp_replace(d.point_id, '-sdr\d+(-[\d.]+)?$', '')
 cross join lateral pg_catalog.jsonb_array_elements(
         case when pg_catalog.jsonb_typeof(d.detail -> 'repeaters') = 'array' then d.detail -> 'repeaters' else '[]'::jsonb end) e
 where d.day >= (pg_catalog.now() at time zone 'utc')::date - 3;

comment on view meganet.repeater_carrier_public is
  'The repeater carriers the hourly carrier roll-up found in each named base station stick''s UTC day of legacy bursts, the last four days (0116, from carrier_receiver_day, 0077/0092): the repeater, its carrier''s centre in Hz, the addresses it passes heard on it. A legacy copy within 30 Hz of exactly one of these, of an address that repeater passes, is that repeater''s. Today''s is the day so far, rebuilt every hour.';

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;
  grant select on meganet.reception_public, meganet.repeater_carrier_public to anon, authenticated, service_role;
  revoke insert, update, delete, truncate on meganet.reception_public, meganet.repeater_carrier_public from anon, authenticated;
  notify pgrst, 'reload schema';
end
$$;

-- ── Did it take ──────────────────────────────────────────────────────────────

do $$
declare
  v_cols text;
begin
  if pg_catalog.to_regclass('meganet.reception_public') is null
     or pg_catalog.to_regclass('meganet.repeater_carrier_public') is null then
    raise exception '0116 did not take: a view is missing';
  end if;
  select string_agg(a.attname, ',' order by a.attnum) into v_cols
    from pg_catalog.pg_attribute a
   where a.attrelid = 'meganet.reception_public'::regclass and a.attnum > 0 and not a.attisdropped;
  if v_cols is distinct from 'id,heard_at,base_station,receiver,path,protocol,alert_id,value_raw,ok,fault,copy,a2_source,a2_path,freq_mhz,level_dbfs,rssi_dbm,snr_db,cfo_hz,cfo_split,fmt' then
    raise exception '0116 did not take: reception_public publishes % — no position, payload or token may be public', v_cols;
  end if;
  select string_agg(a.attname, ',' order by a.attnum) into v_cols
    from pg_catalog.pg_attribute a
   where a.attrelid = 'meganet.repeater_carrier_public'::regclass and a.attnum > 0 and not a.attisdropped;
  if v_cols is distinct from 'day,base_station,receiver,path,station_id,centre_hz,addresses' then
    raise exception '0116 did not take: repeater_carrier_public publishes %', v_cols;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    if not pg_catalog.has_table_privilege('anon', 'meganet.reception_public', 'select')
       or not pg_catalog.has_table_privilege('anon', 'meganet.repeater_carrier_public', 'select') then
      raise exception '0116 did not take: anon cannot read the views';
    end if;
    if pg_catalog.has_table_privilege('anon', 'meganet.reception_public', 'insert,update,delete')
       or pg_catalog.has_table_privilege('anon', 'meganet.repeater_carrier_public', 'insert,update,delete') then
      raise exception '0116 did not take: anon can write a view';
    end if;
    if pg_catalog.has_table_privilege('anon', 'meganet.reception', 'select')
       and not exists (select 1 from pg_catalog.pg_class c
                        where c.oid = 'meganet.reception'::regclass and c.relrowsecurity) then
      raise exception '0116 did not take: the receptions themselves are open to anon';
    end if;
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 116 once this is applied. The guard means
-- applying it out of order leaves the higher number.

insert into meganet.app_meta (key, value)
values ('schema_version', '116')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
