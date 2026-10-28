-- 0087_disk_io.sql — The database's disk reads and writes cut back to what
-- the work needs: readings paged in time order from an index, not sorted on
-- disk; the hourly roll-up finding its hours by range; the carrier roll-up
-- no longer re-working finished days every hour.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0087_disk_io.sql
--
-- Why this file exists
-- ────────────────────
-- Supabase wrote on 2026-10-28 that the project is using up its Disk IO
-- Budget. The project is on the smallest compute (shared_buffers 224 MB,
-- work_mem 2 MB) and the database is 902 MB, so anything that is not hot
-- comes off disk, and every sort over 2 MB goes to a temporary file.
-- pg_stat_statements over the nine days from 2026-10-19 named the writers:
--
--   query                                calls  temp written  local written  read from disk
--   reading paged by reading_ts         17,961        26 GB              —          0.3 GB
--   roll_up_carriers()                     178       3.8 GB         7.6 GB           4.0 GB
--   roll_up()                              188      0.05 GB              —           2.7 GB
--
-- **1. Readings in time order (Station Health, the Reception Map, the latency
-- map, station-health.yml).** health.js and tools/health/report.mjs page
-- every reading of a window in twelve-hour chunks, ordered (reading_ts, addr,
-- value_raw), a thousand at a time by offset. No index held that order: each
-- page found its chunk through reading_ts_brin — lossy, 3,423 heap pages read
-- for 10,326 rows — and sorted all of it again, 1.5 MB to disk, to hand back
-- one page. 2.3 s a page, 2,000 pages a day. A btree in that exact order
-- serves each page from the index: no sort, and only the rows asked for.
-- About 23 MB, the size of the primary key.
--
-- **2. roll_up() (hourly, `meganet-roll-up`).** It joined each touched
-- (address, hour) to meganet.reading on `date_trunc('hour', reading_ts) =
-- bucket` — an expression no index has — so the primary key was walked over
-- every reading the address ever sent and the hour filtered out after (639
-- rows thrown away for every 3 kept; 3.9 s for an hour's 461 buckets). The
-- day did the same to reading_hourly. Both are now the same rows asked for
-- as a range the primary keys answer (24 ms; 0.2 s). What is written is
-- unchanged.
--
-- **3. roll_up_carriers() (hourly, `meganet-roll-up-carriers`).** With no
-- dates it rebuilt the last three UTC days every hour: 42 s a run, two of the
-- three days long finished. No reception has arrived more than three hours
-- after the end of the UTC day it was heard (checked over every day still
-- kept), so with no dates it now rebuilds today; yesterday too in the first
-- three hours after midnight UTC; and the day before as well once a day, at
-- 03:xx UTC, for a receiver that was cut off for a day. A run with dates
-- does what it always did. A register change (a pass range, a repeater)
-- reaches days before that only when someone asks:
--   select meganet.roll_up_carriers(current_date - 14, current_date);
--
-- **4. meganet._check_0072_before** (23 MB), 0072's fingerprint of every
-- reception, checked and finished with on 2026-10-21 (roadmap revision 172),
-- waiting for the drop that only a file can give it.
--
-- The index is built inside this file's transaction: meganet.reading takes
-- no new rows for the few seconds that takes, and ingest waits rather than
-- failing, as for 0086.

-- ── 1. Readings in time order ────────────────────────────────────────────────

create index if not exists reading_ts_idx on meganet.reading (reading_ts, addr, value_raw);

comment on index meganet.reading_ts_idx is
  'Readings in time order (0087): the order health.js and tools/health/report.mjs page a window in — (reading_ts, addr, value_raw) — so a page is read from the index, not sorted on disk.';

-- ── 2. roll_up(), by range ───────────────────────────────────────────────────
-- 0024's text but for the two joins, and the temporary table analysed so the
-- planner knows how few rows it holds.

create or replace function meganet.roll_up(p_since timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_since   timestamptz;
  v_high    timestamptz;
  v_floor   timestamptz;
  v_hours   integer := 0;
  v_days    integer := 0;
  v_skipped integer := 0;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to roll up readings' using errcode = '42501';
  end if;

  v_since := coalesce(
    p_since,
    (select a.value::timestamptz from meganet.app_meta a where a.key = 'rollup_watermark'),
    '-infinity'::timestamptz);

  select pg_catalog.max(r.received_at) into v_high
    from meganet.reading r where r.received_at >= v_since;

  if v_high is null then
    return pg_catalog.jsonb_build_object('hours', 0, 'days', 0, 'skipped', 0,
                                         'since', v_since, 'watermark', v_since);
  end if;

  -- A bucket whose readings have already aged out cannot be recomputed — what is
  -- left of it would overwrite a rollup that was correct when it was made. So the
  -- sweep stops at the retention horizon and says how many buckets it left alone.
  v_floor := pg_catalog.date_trunc('hour',
               pg_catalog.now()
               - coalesce((select a.value::integer from meganet.app_meta a
                            where a.key = 'retain_reading_days'), 90)
                 * interval '1 day')
             + interval '1 hour';

  create temporary table pg_temp._roll_hours on commit drop as
    select distinct r.addr, pg_catalog.date_trunc('hour', r.reading_ts) as bucket
      from meganet.reading r
     where r.received_at >= v_since;

  select pg_catalog.count(*) into v_skipped from pg_temp._roll_hours where bucket < v_floor;
  delete from pg_temp._roll_hours where bucket < v_floor;
  analyze pg_temp._roll_hours;

  insert into meganet.reading_hourly (
    addr, bucket, alert_id, a2_station, a2_sensor, station_number, channel,
    station_id, unit,
    n, n_dup, n_val, raw_min, raw_max, raw_sum, raw_last,
    val_min, val_max, val_sum, val_last, first_ts, last_ts, rolled_at)
  select r.addr,
         pg_catalog.date_trunc('hour', r.reading_ts),
         -- addr determines these, so any row's copy is the value. max() rather
         -- than min() for station_id, so a backfilled row wins over a null.
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
    -- The hour as a range on the primary key (addr, reading_ts, …), not
    -- date_trunc() of every reading the address has (0087).
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

  get diagnostics v_hours = row_count;

  -- The day is built from the hours, not from the readings. Sums re-aggregate
  -- exactly, which is why they are what is stored, and it means the daily rollup
  -- goes on being correct after the readings behind it are gone.
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
    -- Each touched (address, UTC day) once, and its hours as a range on
    -- reading_hourly's primary key (addr, bucket) (0087).
    from (select distinct t.addr, (t.bucket at time zone 'UTC')::date as day
            from pg_temp._roll_hours t) d
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

  get diagnostics v_days = row_count;

  drop table pg_temp._roll_hours;

  insert into meganet.app_meta (key, value)
  values ('rollup_watermark', v_high::text)
  on conflict (key) do update set value = excluded.value;

  return pg_catalog.jsonb_build_object(
    'hours', v_hours, 'days', v_days, 'skipped', v_skipped,
    'since', v_since, 'watermark', v_high);
end;
$$;

comment on function meganet.roll_up(timestamptz) is
  'Rebuild the hourly and daily rollups for every bucket touched since the watermark, each found by range on its primary key (0087). Idempotent; running it twice changes nothing.';

-- ── 3. roll_up_carriers(): the days that can still change ────────────────────

create or replace function meganet.roll_up_carriers(p_from date default null, p_to date default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now  timestamp := pg_catalog.now() at time zone 'UTC';
  v_to   date := coalesce(p_to, v_now::date);
  -- No dates: today; yesterday too until 03:00 UTC (no reception has come in
  -- later than that after its day); the day before as well at 03:xx, once a
  -- day, for a receiver that was cut off (0087). An end date alone: the three
  -- days to it, as before.
  v_from date := coalesce(p_from, v_to - case when p_to is not null then 2
                                              when pg_catalog.date_part('hour', v_now) < 3 then 1
                                              when pg_catalog.date_part('hour', v_now) < 4 then 2
                                              else 0 end);
  d      date;
  v_out  jsonb := '[]'::jsonb;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(5900218) then
    return pg_catalog.jsonb_build_object('skipped', 'another run is under way');
  end if;
  d := v_from;
  while d <= v_to loop
    v_out := v_out || pg_catalog.jsonb_build_array(meganet.roll_up_carriers_day(d));
    d := d + 1;
  end loop;
  return pg_catalog.jsonb_build_object('days', v_out);
end;
$$;

comment on function meganet.roll_up_carriers(date, date) is
  'roll_up_carriers_day() for each day from p_from to p_to. With no dates (0087): today; yesterday too before 03:00 UTC; the day before as well from 03:00 to 03:59 UTC. A day whose receptions are gone is skipped, never emptied. pg_cron hourly (meganet-roll-up-carriers). The service key''s.';

-- Who may run either is unchanged: create or replace keeps 0024's and 0077's
-- grants.

-- ── 4. 0072's fingerprint, finished with ─────────────────────────────────────

drop table if exists meganet._check_0072_before;

-- ── Proof it took ────────────────────────────────────────────────────────────

do $$
begin
  if pg_catalog.to_regclass('meganet.reading_ts_idx') is null then
    raise exception '0087 did not take: meganet.reading_ts_idx is missing';
  end if;
  if pg_catalog.strpos(pg_catalog.pg_get_functiondef('meganet.roll_up(timestamptz)'::regprocedure),
                       'h.bucket + interval ''1 hour''') = 0 then
    raise exception '0087 did not take: roll_up() still joins the hour by date_trunc()';
  end if;
  if pg_catalog.strpos(pg_catalog.pg_get_functiondef('meganet.roll_up_carriers(date,date)'::regprocedure),
                       'date_part(''hour''') = 0 then
    raise exception '0087 did not take: roll_up_carriers() still rebuilds three days every hour';
  end if;
  if pg_catalog.to_regclass('meganet._check_0072_before') is not null then
    raise exception '0087 did not take: meganet._check_0072_before is still there';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION follows once this is live.

insert into meganet.app_meta (key, value)
values ('schema_version', '87')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
