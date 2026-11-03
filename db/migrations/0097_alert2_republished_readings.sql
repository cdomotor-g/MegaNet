-- 0097_alert2_republished_readings.sql — An ALERT2 report the ELPRO gateway
-- published again is one reading, not one per publish.
--
-- SUPERSEDED BY 0098. The premise below was wrong: the gateway does not
-- republish ALERT2 — the bench stations transmit on their own rhythm and their
-- stamps simply do not move — so most of the "repeats" this removed were real
-- transmissions. 0098 puts them back. Kept as it ran, because it ran.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0097_alert2_republished_readings.sql
--
-- Why this file exists
-- ────────────────────
-- The bench ELPRO gateway relays ALERT2 to the MQTT bridge as
-- `…/reading/elpro/Station NNNN`, one array of {timestamp, Sensor, Value,
-- AlertTimestamp} per message. `timestamp` is when the gateway published;
-- `AlertTimestamp` is the relayed station's own stamp, which every new
-- transmission changes. The gateway publishes a station's last report again
-- every 15 minutes and on the hour, each time with a fresh `timestamp`, for as
-- long as the station sends nothing new — and the bridge filed every one of
-- them as a new reading, so a station that had gone quiet kept being heard.
-- Measured on 2 November 2026 over every such message still in reading_raw
-- (2 October onwards): 22,271 sets, of which 4,316 were a report seen for the
-- first time.
--
-- The bridge stops doing it from 2 November (bridge/src/resends.js, freshA2).
-- This file takes the same rule back over what it already stored, walking the
-- raw messages in the order they arrived. Per topic and sensor slot, a set with
-- the same AlertTimestamp and value as the slot's last first sighting is:
--
--   * a copy, within 10 s of that sighting — the same burst heard twice, or
--     the same publish delivered twice. Its row is removed and counted on the
--     first sighting's reading (dup_count, last_dup_at), as ingest() counts any
--     copy;
--   * a repeat, after that and within 11 hours — the gateway's timer. Its row
--     is removed.
--   * Anything else is a first sighting and stays. Eleven hours because the
--     stamp counts a half-day and wraps: a station transmitting at the same
--     second each hour sends the same stamp twelve hours later.
--
-- On the live database that is 8,960 repeats removed and 2,146 copies folded
-- into their first sighting, of 19,575 ALERT2 rows from those messages.
--
-- What it does not touch
-- ──────────────────────
--   * reading_raw: every message stays, byte for byte.
--   * Readings from before the raw window (21 August – 2 October 2026): their
--     messages are in the R2 archive, and without the AlertTimestamp nothing
--     here can tell a repeat from a report.
--   * Sets with no AlertTimestamp (Station 1003's) and legacy ALERT: the first
--     cannot be told apart, the second was never stored twice (0096, resends.js).
--   * station_status: ALERT2 readings put no row there (ingest_http keys it by
--     alert_id or station_number only).
--
-- reading_hourly and reading_daily are rebuilt for every address and bucket a
-- removed or recounted row sat in, by roll_up()'s own aggregation (0087),
-- because roll_up() only revisits buckets that new readings touch and would
-- otherwise go on counting the rows removed here.

-- Working tables, temporary, and cleared first so a second run in the same
-- session starts clean (dropped again at the end; plain rather than
-- `on commit drop`, so the file also runs outside a single transaction).
drop table if exists pg_temp._a2_sets, pg_temp._a2_class, pg_temp._a2_doomed,
                     pg_temp._a2_gone, pg_temp._roll_hours, pg_temp._roll_days;

-- ── 1. Every ALERT2 set from an ELPRO relay message still in reading_raw ────

create temporary table _a2_sets as
select pg_catalog.row_number() over (order by r.received_at, r.id, x.o) as n,
       r.id as raw_id, r.received_at, x.o, r.path,
       t.a2_station,
       (x.v ->> 'Sensor')::integer as sensor,
       (x.v ->> 'Value')::numeric as value_raw,
       (x.v ->> 'AlertTimestamp')::integer as stamp,
       (x.v ->> 'timestamp')::bigint as at_ms,
       meganet.as_ts(x.v -> 'timestamp', 'reading_ts') as reading_ts
  from meganet.reading_raw r
  -- The relayed station off the topic tail, as bridge/src/topics.js reads it.
  cross join lateral (
    select ((pg_catalog.regexp_match(pg_catalog.substring(r.path, '/reading/elpro/(.*)$'),
                                     '^\s*(?:station\s+)?([0-9]{1,5})\s*$', 'i'))[1])::integer as a2_station
  ) t
  cross join lateral pg_catalog.jsonb_array_elements(r.frame::jsonb) with ordinality as x(v, o)
 where r.path like 'meganet/v1/%/reading/elpro/%'
   and t.a2_station between 1 and 65535
   and pg_catalog.pg_input_is_valid(r.frame, 'jsonb')
   and pg_catalog.jsonb_typeof(r.frame::jsonb) = 'array'
   and pg_catalog.jsonb_typeof(x.v -> 'Sensor') = 'number'
   and pg_catalog.jsonb_typeof(x.v -> 'Value') = 'number'
   and pg_catalog.jsonb_typeof(x.v -> 'AlertTimestamp') = 'number'
   and pg_catalog.jsonb_typeof(x.v -> 'timestamp') = 'number'
   and (x.v ->> 'Sensor') ~ '^[0-9]+$' and (x.v ->> 'Sensor')::integer <= 254
   and (x.v ->> 'AlertTimestamp') ~ '^[0-9]+$';

-- ── 2. The bridge's rule, walked in arrival order ───────────────────────────

create temporary table _a2_class (
  n       bigint primary key,
  kind    text not null,          -- 'fresh' | 'copy' | 'repeat'
  kept_ts timestamptz not null    -- the first sighting's reading_ts
);

do $$
declare
  s        record;
  k_path   text;
  k_sensor integer;
  l_stamp  integer;
  l_value  numeric;
  l_ts     timestamptz;
  l_at     bigint;
begin
  for s in select * from pg_temp._a2_sets order by path, sensor, received_at, raw_id, o loop
    if k_path is distinct from s.path or k_sensor is distinct from s.sensor then
      k_path := s.path; k_sensor := s.sensor; l_stamp := null;
    end if;
    if l_stamp is not null and s.stamp = l_stamp and s.value_raw = l_value
       and s.at_ms - l_at < 11 * 3600 * 1000 then
      insert into pg_temp._a2_class values
        (s.n, case when s.at_ms - l_at <= 10000 then 'copy' else 'repeat' end, l_ts);
    else
      insert into pg_temp._a2_class values (s.n, 'fresh', s.reading_ts);
      l_stamp := s.stamp; l_value := s.value_raw; l_ts := s.reading_ts; l_at := s.at_ms;
    end if;
  end loop;
end
$$;

-- The rows to go: every copy or repeat, except where it is the very row a
-- first sighting stored (a redelivery of the same publish carries the same
-- time, and was already counted on that row).
create temporary table _a2_doomed as
with c as (
  select s.a2_station, s.sensor, 'a2:' || s.a2_station || '/' || s.sensor as addr,
         s.reading_ts, s.value_raw, k.kind, k.kept_ts
    from pg_temp._a2_sets s join pg_temp._a2_class k using (n)
), fresh as (
  select distinct addr, reading_ts, value_raw from c where kind = 'fresh'
)
select c.addr, c.reading_ts, c.value_raw,
       pg_catalog.bool_or(c.kind = 'copy') as is_copy,
       pg_catalog.min(c.kept_ts) filter (where c.kind = 'copy') as kept_ts
  from c
 where c.kind in ('copy', 'repeat')
   and not exists (select 1 from fresh f
                    where f.addr = c.addr and f.reading_ts = c.reading_ts and f.value_raw = c.value_raw)
 group by c.addr, c.reading_ts, c.value_raw;

-- Only rows the bridge wrote off these topics, and a copy only where the
-- reading it is counted on is still there to count it.
create temporary table _a2_gone as
select r.addr, r.reading_ts, r.value_raw, r.received_at, r.dup_count, r.last_dup_at,
       d.is_copy, d.kept_ts
  from pg_temp._a2_doomed d
  join meganet.reading r
    on r.addr = d.addr and r.reading_ts = d.reading_ts and r.value_raw = d.value_raw
 where r.a2_station is not null
   and r.path like 'meganet/v1/%/reading/elpro/%'
   and (not d.is_copy or exists (
         select 1 from meganet.reading k
          where k.addr = d.addr and k.reading_ts = d.kept_ts and k.value_raw = d.value_raw));

-- ── 3. Copies counted on their first sighting ───────────────────────────────

with folded as (
  select g.addr, g.kept_ts, g.value_raw,
         pg_catalog.sum(g.dup_count + 1)::integer as n,
         pg_catalog.max(greatest(g.received_at, g.last_dup_at)) as last_at
    from pg_temp._a2_gone g
   where g.is_copy
   group by g.addr, g.kept_ts, g.value_raw
)
update meganet.reading k
   set dup_count   = k.dup_count + f.n,
       last_dup_at = greatest(k.last_dup_at, f.last_at)
  from folded f
 where k.addr = f.addr and k.reading_ts = f.kept_ts and k.value_raw = f.value_raw;

-- ── 4. The copies and repeats themselves ────────────────────────────────────

create temporary table _roll_hours as
select distinct g.addr, pg_catalog.date_trunc('hour', g.reading_ts) as bucket
  from pg_temp._a2_gone g
union
select distinct g.addr, pg_catalog.date_trunc('hour', g.kept_ts)
  from pg_temp._a2_gone g
 where g.is_copy;

delete from meganet.reading r
 using pg_temp._a2_gone g
 where r.addr = g.addr and r.reading_ts = g.reading_ts and r.value_raw = g.value_raw;

-- ── 5. The hourly and daily rollups those rows were counted in ──────────────
-- roll_up()'s aggregation (0087), for exactly these buckets. Each bucket is
-- cleared first, so an hour whose every row was a repeat goes rather than
-- keeping its old count.

delete from meganet.reading_hourly h
 using pg_temp._roll_hours t
 where h.addr = t.addr and h.bucket = t.bucket;

insert into meganet.reading_hourly (
  addr, bucket, alert_id, a2_station, a2_sensor, station_number, channel,
  station_id, unit,
  n, n_dup, n_val, raw_min, raw_max, raw_sum, raw_last,
  val_min, val_max, val_sum, val_last, first_ts, last_ts, rolled_at)
select r.addr,
       pg_catalog.date_trunc('hour', r.reading_ts),
       pg_catalog.max(r.alert_id),
       pg_catalog.max(r.a2_station),
       pg_catalog.max(r.a2_sensor),
       pg_catalog.max(r.station_number),
       pg_catalog.max(r.channel),
       pg_catalog.max(r.station_id),
       pg_catalog.max(r.unit),
       pg_catalog.count(*)::integer,
       coalesce(pg_catalog.sum(r.dup_count), 0)::integer,
       pg_catalog.count(r.value)::integer,
       pg_catalog.min(r.value_raw),
       pg_catalog.max(r.value_raw),
       pg_catalog.sum(r.value_raw),
       (pg_catalog.array_agg(r.value_raw order by r.reading_ts desc, r.received_at desc))[1],
       pg_catalog.min(r.value),
       pg_catalog.max(r.value),
       pg_catalog.sum(r.value),
       (pg_catalog.array_agg(r.value order by r.reading_ts desc, r.received_at desc)
          filter (where r.value is not null))[1],
       pg_catalog.min(r.reading_ts),
       pg_catalog.max(r.reading_ts),
       pg_catalog.now()
  from meganet.reading r
  join pg_temp._roll_hours h
    on h.addr = r.addr and r.reading_ts >= h.bucket and r.reading_ts < h.bucket + interval '1 hour'
 group by r.addr, pg_catalog.date_trunc('hour', r.reading_ts)
on conflict (addr, bucket) do update set
  alert_id = excluded.alert_id, station_number = excluded.station_number,
  a2_station = excluded.a2_station, a2_sensor  = excluded.a2_sensor,
  channel  = excluded.channel,  station_id     = excluded.station_id,
  unit     = excluded.unit,     n              = excluded.n,
  n_dup    = excluded.n_dup,    n_val          = excluded.n_val,
  raw_min  = excluded.raw_min,  raw_max        = excluded.raw_max,
  raw_sum  = excluded.raw_sum,  raw_last       = excluded.raw_last,
  val_min  = excluded.val_min,  val_max        = excluded.val_max,
  val_sum  = excluded.val_sum,  val_last       = excluded.val_last,
  first_ts = excluded.first_ts, last_ts        = excluded.last_ts,
  rolled_at = excluded.rolled_at;

create temporary table _roll_days as
select distinct t.addr, (t.bucket at time zone 'UTC')::date as day
  from pg_temp._roll_hours t;

delete from meganet.reading_daily d
 using pg_temp._roll_days t
 where d.addr = t.addr and d.bucket = t.day;

insert into meganet.reading_daily (
  addr, bucket, alert_id, a2_station, a2_sensor, station_number, channel,
  station_id, unit,
  n, n_dup, n_val, raw_min, raw_max, raw_sum, raw_last,
  val_min, val_max, val_sum, val_last, first_ts, last_ts, rolled_at)
select h.addr,
       (h.bucket at time zone 'UTC')::date,
       pg_catalog.max(h.alert_id),
       pg_catalog.max(h.a2_station),
       pg_catalog.max(h.a2_sensor),
       pg_catalog.max(h.station_number),
       pg_catalog.max(h.channel),
       pg_catalog.max(h.station_id),
       pg_catalog.max(h.unit),
       pg_catalog.sum(h.n)::integer,
       pg_catalog.sum(h.n_dup)::integer,
       pg_catalog.sum(h.n_val)::integer,
       pg_catalog.min(h.raw_min),
       pg_catalog.max(h.raw_max),
       pg_catalog.sum(h.raw_sum),
       (pg_catalog.array_agg(h.raw_last order by h.bucket desc))[1],
       pg_catalog.min(h.val_min),
       pg_catalog.max(h.val_max),
       pg_catalog.sum(h.val_sum),
       (pg_catalog.array_agg(h.val_last order by h.bucket desc)
          filter (where h.val_last is not null))[1],
       pg_catalog.min(h.first_ts),
       pg_catalog.max(h.last_ts),
       pg_catalog.now()
  from pg_temp._roll_days d
  join meganet.reading_hourly h
    on h.addr = d.addr
   and h.bucket >= (d.day::timestamp at time zone 'UTC')
   and h.bucket <  ((d.day + 1)::timestamp at time zone 'UTC')
 group by h.addr, (h.bucket at time zone 'UTC')::date
on conflict (addr, bucket) do update set
  alert_id = excluded.alert_id, station_number = excluded.station_number,
  a2_station = excluded.a2_station, a2_sensor  = excluded.a2_sensor,
  channel  = excluded.channel,  station_id     = excluded.station_id,
  unit     = excluded.unit,     n              = excluded.n,
  n_dup    = excluded.n_dup,    n_val          = excluded.n_val,
  raw_min  = excluded.raw_min,  raw_max        = excluded.raw_max,
  raw_sum  = excluded.raw_sum,  raw_last       = excluded.raw_last,
  val_min  = excluded.val_min,  val_max        = excluded.val_max,
  val_sum  = excluded.val_sum,  val_last       = excluded.val_last,
  first_ts = excluded.first_ts, last_ts        = excluded.last_ts,
  rolled_at = excluded.rolled_at;

-- ── 6. Check it took ─────────────────────────────────────────────────────────

do $$
begin
  -- Every first sighting is still there.
  if exists (
       select 1
         from pg_temp._a2_sets s join pg_temp._a2_class k using (n)
        where k.kind = 'fresh'
          and not exists (select 1 from meganet.reading r
                           where r.addr = 'a2:' || s.a2_station || '/' || s.sensor
                             and r.reading_ts = s.reading_ts and r.value_raw = s.value_raw)) then
    raise exception '0097 did not take: a first sighting of an ALERT2 report is missing';
  end if;
  -- No copy or repeat is.
  if exists (select 1 from pg_temp._a2_gone g join meganet.reading r
                on r.addr = g.addr and r.reading_ts = g.reading_ts and r.value_raw = g.value_raw) then
    raise exception '0097 did not take: a republished ALERT2 reading is still stored';
  end if;
  -- Every rebuilt hour counts the readings it holds.
  if exists (
       select 1 from pg_temp._roll_hours t
         left join meganet.reading_hourly h on h.addr = t.addr and h.bucket = t.bucket
        where coalesce(h.n, 0) <> (select pg_catalog.count(*) from meganet.reading r
                                    where r.addr = t.addr and r.reading_ts >= t.bucket
                                      and r.reading_ts < t.bucket + interval '1 hour')) then
    raise exception '0097 did not take: reading_hourly does not match the readings left';
  end if;
end
$$;

drop table if exists pg_temp._a2_sets, pg_temp._a2_class, pg_temp._a2_doomed,
                     pg_temp._a2_gone, pg_temp._roll_hours, pg_temp._roll_days;

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 96 → 97 once db-migrate.yml has applied
-- this file.

insert into meganet.app_meta (key, value)
values ('schema_version', '97')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
