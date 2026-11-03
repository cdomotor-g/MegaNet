-- 0098_alert2_readings_restored.sql — Put back the bench ALERT2 readings
-- 0097 removed and the bridge dropped, and the legacy reports dropped right
-- after a bridge restart.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0098_alert2_readings_restored.sql
--
-- Why this file exists
-- ────────────────────
-- 0097 took an ELPRO ALERT2 set with the same AlertTimestamp and value as the
-- slot's last one, minutes or hours later, for the gateway republishing, and
-- removed it; from 02:00 UTC on 2 November the bridge dropped such sets as they
-- arrived (bridge/src/resends.js). That was wrong. Each bench station has its
-- own rhythm — Station 1000 every 15 minutes, 1001-1003 about hourly — and
-- their values change between messages while the bench units' stamps stay put
-- for hours: a repeated stamp there is a clock that has not moved, and the sets
-- were real transmissions. What does repeat is the same burst published twice
-- within seconds, and the retained message the broker hands over whenever the
-- bridge subscribes. The bridge was corrected on 3 November to fold only the
-- first (a copy) and ignore the second; this file brings the stored readings
-- into line with that rule, over every message still in reading_raw.
--
-- Per ELPRO ALERT2 relay message, tied to the first message with its exact
-- bytes (a retained hand-over or redelivery repeats them, publish times and
-- all), and per sensor slot in the order they arrived:
--
--   * the same stamp and value within 10 s of the slot's last reading is a
--     copy, counted on that reading (dup_count) and with no row of its own;
--   * everything else is a reading, and has a row.
--
-- So it inserts the readings that have no row, through meganet.ingest() as the
-- bridge would have, linked to their raw message and with their copies counted;
-- removes the rows a redelivery stored for a copy (the copy itself was already
-- counted, or is counted now on its restored reading); and re-links the other
-- rows a redelivery stored to the original message.
--
-- The legacy ALERT path (`…/elpro/Alert1`) lost reports too, once per bridge
-- restart: a batch of reports that arrived together (like Mt Morriston's 614,
-- 616, 615 at :25 each hour) is kept whole only once the bridge knows the
-- gateway's table, so the first one after a restart kept its first entry. The
-- bridge's own rule, walked over the whole feed as a bridge that never
-- restarted, says what it should have kept; what it kept and the database
-- lacks is put back.
--
-- reading_hourly and reading_daily are rebuilt for every address and bucket a
-- row was added to, removed from or recounted in, by roll_up()'s aggregation
-- (0087, as 0097 did).

drop table if exists pg_temp._e_raw, pg_temp._e_sets, pg_temp._e_class, pg_temp._e_restore,
                     pg_temp._e_gone, pg_temp._l_kept, pg_temp._l_restore, pg_temp._touched,
                     pg_temp._roll_hours, pg_temp._roll_days;

-- ── 1. The ALERT2 relay messages, each tied to the first with its bytes ─────

create temporary table _e_raw as
select r.id, r.received_at, r.path, r.frame::jsonb as j, t.a2_station,
       pg_catalog.first_value(r.id) over (partition by r.path, pg_catalog.md5(r.frame)
                                           order by r.received_at, r.id) as original_id
  from meganet.reading_raw r
  cross join lateral (
    select ((pg_catalog.regexp_match(pg_catalog.substring(r.path, '/reading/elpro/(.*)$'),
                                     '^\s*(?:station\s+)?([0-9]{1,5})\s*$', 'i'))[1])::integer as a2_station
  ) t
 where r.path like 'meganet/v1/%/reading/elpro/%'
   and t.a2_station between 1 and 65535
   and pg_catalog.pg_input_is_valid(r.frame, 'jsonb')
   and pg_catalog.jsonb_typeof(r.frame::jsonb) = 'array';

create temporary table _e_sets as
select pg_catalog.row_number() over (order by r.received_at, r.id, x.o) as n,
       r.id as raw_id, r.original_id, r.received_at, r.path, r.a2_station, x.o,
       (x.v ->> 'Sensor')::integer as sensor,
       'a2:' || r.a2_station || '/' || (x.v ->> 'Sensor') as addr,
       (x.v ->> 'Value')::numeric as value_raw,
       (x.v ->> 'AlertTimestamp')::integer as stamp,
       (x.v ->> 'timestamp')::bigint as at_ms,
       meganet.as_ts(x.v -> 'timestamp', 'reading_ts') as reading_ts
  from pg_temp._e_raw r
  cross join lateral pg_catalog.jsonb_array_elements(r.j) with ordinality as x(v, o)
 where pg_catalog.jsonb_typeof(x.v -> 'Sensor') = 'number'
   and pg_catalog.jsonb_typeof(x.v -> 'Value') = 'number'
   and pg_catalog.jsonb_typeof(x.v -> 'AlertTimestamp') = 'number'
   and pg_catalog.jsonb_typeof(x.v -> 'timestamp') = 'number'
   and (x.v ->> 'Sensor') ~ '^[0-9]+$' and (x.v ->> 'Sensor')::integer <= 254
   and (x.v ->> 'AlertTimestamp') ~ '^[0-9]+$';

-- ── 2. Copy or reading — the bridge's rule since 3 November (freshA2) ───────

create temporary table _e_class (
  n       bigint primary key,
  kind    text not null,          -- 'reading' | 'copy'
  kept_ts timestamptz not null    -- a copy's reading; a reading's own time
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
  for s in select * from pg_temp._e_sets where raw_id = original_id
            order by path, sensor, received_at, raw_id, o loop
    if k_path is distinct from s.path or k_sensor is distinct from s.sensor then
      k_path := s.path; k_sensor := s.sensor; l_stamp := null;
    end if;
    if l_stamp is not null and s.stamp = l_stamp and s.value_raw = l_value
       and s.at_ms >= l_at and s.at_ms - l_at <= 10000 then
      insert into pg_temp._e_class values (s.n, 'copy', l_ts);
    else
      insert into pg_temp._e_class values (s.n, 'reading', s.reading_ts);
      l_stamp := s.stamp; l_value := s.value_raw; l_ts := s.reading_ts; l_at := s.at_ms;
    end if;
  end loop;
end
$$;

-- The readings with no row, each with the copies counted on it.
create temporary table _e_restore as
with copies as (
  select c.addr, ck.kept_ts, c.value_raw, pg_catalog.count(*)::integer as n
    from pg_temp._e_sets c join pg_temp._e_class ck using (n)
   where ck.kind = 'copy'
   group by c.addr, ck.kept_ts, c.value_raw
)
select s.raw_id, s.received_at, s.path, s.a2_station, s.sensor, s.addr, s.reading_ts, s.value_raw, s.at_ms,
       coalesce(c.n, 0) as copies
  from pg_temp._e_sets s
  join pg_temp._e_class k using (n)
  left join copies c on c.addr = s.addr and c.kept_ts = s.reading_ts and c.value_raw = s.value_raw
 where k.kind = 'reading'
   and not exists (select 1 from meganet.reading r
                    where r.addr = s.addr and r.reading_ts = s.reading_ts and r.value_raw = s.value_raw);

-- The rows a redelivery stored for a set that is a copy in the original.
create temporary table _e_gone as
select distinct d.addr, d.reading_ts, d.value_raw
  from pg_temp._e_sets d
  join pg_temp._e_sets o on o.raw_id = d.original_id and o.o = d.o
  join pg_temp._e_class k on k.n = o.n and k.kind = 'copy'
  join meganet.reading r
    on r.addr = d.addr and r.reading_ts = d.reading_ts and r.value_raw = d.value_raw and r.raw_id = d.raw_id
 where d.raw_id <> d.original_id;

-- ── 3. The legacy reports the bridge cut short ──────────────────────────────
-- The bridge's legacy rule (resends.js fresh(), rules 1-5) walked over every
-- message from the start of the feed, in arrival order, as one bridge that
-- never restarted would have: a restart only ever loses (it keeps the first
-- entry of a message it cannot split), so whatever this walk keeps and the
-- database lacks is what a restart cost.

create temporary table _l_kept (
  raw_id      bigint,
  received_at timestamptz,
  path        text,
  alert_id    integer,
  value_raw   numeric,
  at_ms       bigint,
  reading_ts  timestamptz
);

do $$
declare
  m       record;
  e       record;
  v_order integer[];
  v_prev  integer[];
  v_known jsonb;
  v_path  text;
  n       integer;
  t       integer;
  v_lead  integer;
begin
  for m in
    select q.id, q.received_at, q.path, q.j,
           (select pg_catalog.array_agg((x ->> 'Sensor')::integer order by o)
              from pg_catalog.jsonb_array_elements(q.j) with ordinality a(x, o)
             where pg_catalog.jsonb_typeof(x -> 'Sensor') = 'number') as arr
      from (select r.id, r.received_at, r.path, r.frame::jsonb as j,
                   pg_catalog.first_value(r.id) over (partition by r.path, pg_catalog.md5(r.frame)
                                                       order by r.received_at, r.id) as original_id
              from meganet.reading_raw r
             where r.path like 'meganet/v1/%/reading/elpro/Alert1'
               and pg_catalog.pg_input_is_valid(r.frame, 'jsonb')
               and pg_catalog.jsonb_typeof(r.frame::jsonb) = 'array') q
     -- the first message with these bytes only: a redelivery is not a message
     where q.id = q.original_id
     order by q.path, q.received_at, q.id
  loop
    if v_path is distinct from m.path then
      v_path := m.path; v_order := null; v_prev := null; v_known := '{}'::jsonb;
    end if;
    n := coalesce(pg_catalog.cardinality(m.arr), 0);
    v_lead := n;
    if n > 1 then
      t := coalesce(pg_catalog.cardinality(v_order), 0);
      if t > 0 and n > t and m.arr[n - t + 1 : n] = v_order and n - t <= 8 then
        v_lead := n - t;                                       -- rule 2
        v_order := m.arr;
      elsif v_prev is not null and n > pg_catalog.cardinality(v_prev)
            and m.arr[n - pg_catalog.cardinality(v_prev) + 1 : n] = v_prev then
        v_lead := 1;                                           -- rule 3
        v_order := m.arr;
      elsif v_order is not null and n <= 8 then
        v_lead := n;                                           -- rule 4
      else
        v_lead := 1;                                           -- rule 5
        if n > 8 then v_order := m.arr; end if;
      end if;
    end if;

    for e in select x.o, (x.v ->> 'Sensor')::integer as a, (x.v ->> 'Value')::numeric as v,
                    (x.v ->> 'timestamp')::bigint as ms
               from pg_catalog.jsonb_array_elements(m.j) with ordinality as x(v, o)
              where pg_catalog.jsonb_typeof(x.v -> 'Sensor') = 'number'
                and pg_catalog.jsonb_typeof(x.v -> 'Value') = 'number'
                and pg_catalog.jsonb_typeof(x.v -> 'timestamp') = 'number'
              order by x.o loop
      if e.a between 1 and 65535
         and (e.o <= v_lead
              or (v_known ? e.a::text and (v_known ->> e.a::text)::numeric <> e.v)) then
        insert into pg_temp._l_kept values
          (m.id, m.received_at, m.path, e.a, e.v, e.ms, meganet.as_ts(pg_catalog.to_jsonb(e.ms), 'reading_ts'));
      end if;
    end loop;

    -- learn after deciding, as the bridge does
    select v_known || coalesce(pg_catalog.jsonb_object_agg(x.v ->> 'Sensor', (x.v ->> 'Value')::numeric), '{}'::jsonb)
      into v_known
      from pg_catalog.jsonb_array_elements(m.j) as x(v)
     where pg_catalog.jsonb_typeof(x.v -> 'Sensor') = 'number'
       and pg_catalog.jsonb_typeof(x.v -> 'Value') = 'number';
    if n > 0 then v_prev := m.arr; end if;
  end loop;
end
$$;

-- What it keeps that is not stored — not even as a copy within ingest()'s
-- window (0096), which is how a second copy of a burst is already counted.
create temporary table _l_restore as
select k.* from pg_temp._l_kept k
 where not exists (select 1 from meganet.reading r
                    where r.addr = 'a:' || k.alert_id and r.value_raw = k.value_raw
                      and r.reading_ts between k.reading_ts - interval '8 seconds'
                                           and k.reading_ts + interval '8 seconds');

-- Every address and hour this file adds to, takes from or recounts.
create temporary table _touched as
select addr, pg_catalog.date_trunc('hour', reading_ts) as bucket from pg_temp._e_restore
union
select addr, pg_catalog.date_trunc('hour', reading_ts) from pg_temp._e_gone
union
select 'a:' || alert_id, pg_catalog.date_trunc('hour', reading_ts) from pg_temp._l_restore;

-- ── 4. Put the readings back ─────────────────────────────────────────────────
-- Through ingest(), as the bridge posts them: one call per path, the receipt
-- time and path per row, no raw row of its own (each is linked to the message
-- it came in, below).

do $$
declare
  p    record;
begin
  for p in select path,
                  pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                    'a2_station', a2_station, 'a2_sensor', sensor, 'reading_ts', at_ms,
                    'value_raw', value_raw, 'received_at', received_at) order by received_at) as rows
             from pg_temp._e_restore group by path loop
    perform meganet.ingest(pg_catalog.jsonb_build_object(
      'keep_raw', false, 'source', 'mqtt', 'protocol', 'elpro', 'path', p.path, 'readings', p.rows));
  end loop;
  for p in select path,
                  pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                    'alert_id', alert_id, 'reading_ts', at_ms, 'value_raw', value_raw,
                    'received_at', received_at) order by received_at) as rows
             from pg_temp._l_restore group by path loop
    perform meganet.ingest(pg_catalog.jsonb_build_object(
      'keep_raw', false, 'source', 'mqtt', 'protocol', 'elpro', 'path', p.path, 'readings', p.rows));
  end loop;
end
$$;

update meganet.reading r
   set raw_id = e.raw_id, dup_count = r.dup_count + e.copies
  from pg_temp._e_restore e
 where r.addr = e.addr and r.reading_ts = e.reading_ts and r.value_raw = e.value_raw
   and r.raw_id is null;

update meganet.reading r
   set raw_id = l.raw_id
  from pg_temp._l_restore l
 where r.addr = 'a:' || l.alert_id and r.reading_ts = l.reading_ts and r.value_raw = l.value_raw
   and r.raw_id is null;

-- ── 5. The rows a redelivery stored ─────────────────────────────────────────

delete from meganet.reading r
 using pg_temp._e_gone g
 where r.addr = g.addr and r.reading_ts = g.reading_ts and r.value_raw = g.value_raw;

update meganet.reading r
   set raw_id = s.original_id
  from (select distinct raw_id, original_id from pg_temp._e_sets where raw_id <> original_id) s
 where r.raw_id = s.raw_id
   and r.a2_station is not null;

-- What each raw message this file touched now has stored.
update meganet.reading_raw w
   set accepted = (select pg_catalog.count(*)::integer from meganet.reading r where r.raw_id = w.id)
 where w.id in (select raw_id from pg_temp._e_restore
                union select raw_id from pg_temp._l_restore
                union select original_id from pg_temp._e_sets where raw_id <> original_id
                union select raw_id from pg_temp._e_sets where raw_id <> original_id);

-- ── 6. The rollups those rows are counted in ────────────────────────────────

create temporary table _roll_hours as select distinct addr, bucket from pg_temp._touched;

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

-- ── 7. Check it took ─────────────────────────────────────────────────────────

do $$
begin
  -- Every reading has a row.
  if exists (
       select 1 from pg_temp._e_sets s join pg_temp._e_class k using (n)
        where k.kind = 'reading'
          and not exists (select 1 from meganet.reading r
                           where r.addr = s.addr and r.reading_ts = s.reading_ts and r.value_raw = s.value_raw)) then
    raise exception '0098 did not take: an ALERT2 reading has no row';
  end if;
  -- No copy kept a row from a redelivery.
  if exists (select 1 from pg_temp._e_gone g join meganet.reading r
                on r.addr = g.addr and r.reading_ts = g.reading_ts and r.value_raw = g.value_raw) then
    raise exception '0098 did not take: a copy still has a row of its own';
  end if;
  -- Every legacy batch is whole.
  if exists (select 1 from pg_temp._l_restore l
              where not exists (select 1 from meganet.reading r
                                 where r.addr = 'a:' || l.alert_id and r.value_raw = l.value_raw
                                   and r.reading_ts between l.reading_ts - interval '8 seconds'
                                                        and l.reading_ts + interval '8 seconds')) then
    raise exception '0098 did not take: a legacy batch is still short';
  end if;
  -- Every rebuilt hour counts the readings it holds.
  if exists (
       select 1 from pg_temp._roll_hours t
         left join meganet.reading_hourly h on h.addr = t.addr and h.bucket = t.bucket
        where coalesce(h.n, 0) <> (select pg_catalog.count(*) from meganet.reading r
                                    where r.addr = t.addr and r.reading_ts >= t.bucket
                                      and r.reading_ts < t.bucket + interval '1 hour')) then
    raise exception '0098 did not take: reading_hourly does not match the readings';
  end if;
end
$$;

drop table if exists pg_temp._e_raw, pg_temp._e_sets, pg_temp._e_class, pg_temp._e_restore,
                     pg_temp._e_gone, pg_temp._l_kept, pg_temp._l_restore, pg_temp._touched,
                     pg_temp._roll_hours, pg_temp._roll_days;

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 97 → 98 once db-migrate.yml has applied
-- this file.

insert into meganet.app_meta (key, value)
values ('schema_version', '98')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
