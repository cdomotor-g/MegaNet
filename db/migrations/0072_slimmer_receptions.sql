-- 0072_slimmer_receptions.sql — A reception's detail kept as typed columns,
-- not as the same keys spelled out on every row (#242).
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0072_slimmer_receptions.sql
--
-- Then, once, the rows already stored (bounded batches, safe to stop and
-- resume; repeat until `remaining` is 0):
--
--   select meganet.reception_split_backfill(25000);
--
-- Why this file exists
-- ────────────────────
-- On 2026-10-21 meganet.reception was 204 MB and growing ~65 MB a day, and a
-- row averaged 560 bytes, 392 of them the `detail` jsonb (0047). Every row
-- spelled out the same keys — `"app":"RPi ALERT"`, `"clock":"utc"`, `"fmt"`,
-- `"freq_mhz"`, `"snr_db"`, `"nf_dbfs"`, `"sync"`, `"baud"`, `"cfo_hz"`, the
-- ALERT2 header's `source`, `path`, `hop_limit`, `stamp`, `fixed` and the
-- agent's `duplicate`, `late`, `before_s` — and jsonb stores every key's name
-- in every row. A trial on 20,000 live rows (2026-10-21): 560 → 282 bytes a
-- row with those keys as columns, 21 bytes of rarer keys left in `detail`.
-- EPIC #240's rule is that nothing is lost, so this is a change of how a
-- reception is stored, not of what is.
--
-- Five decisions.
--
-- **1. The door does not change.** report_receptions() (0047) still takes
-- `detail` as the receiver sends it, from any agent version, and nothing a
-- Pi or a browser posts changes. A trigger on the table splits it as the row
-- is written — so every way a row arrives (the door, a check, a backfill) is
-- split the same way, by one function.
--
-- **2. Only what comes back exactly is moved.** A key moves to its column
-- only when its value has the column's type and round-trips: a number stored
-- as `real` must come back as the same jsonb number (to_jsonb() of the real
-- equals the original), an integer must fit, a path must be an array of
-- integers. Anything else — a string where a number was expected, a value
-- with more digits than a real holds, a key nobody has named — stays in
-- `detail` as it came. `freq_mhz` is `double precision` because 151.5375 does
-- not survive a `real`; the trial found 18,572 of 20,000 that would not have.
--
-- **3. Everything that reads it reads it whole.** meganet.reception_detail(r)
-- puts the columns back as keys over what is left in `detail` — the same
-- object, key for key, that was posted. reception_window() and
-- survey_receptions() hand that to the app, so the Reception Map and the
-- survey pages see exactly what they saw before; survey_summary(),
-- admin_base_station_spectrum() and roll_up_receptions() read their keys
-- through it. Each is restated below from its own last definition with only
-- those reads changed. `survey` and `survey_name` are not moved: they are on
-- drives' rows only, and reception_survey_idx (0051) is built on them.
--
-- **4. One index replaced.** reception_alert_idx (alert_id, heard_at) was 11 MB
-- and grew with every row; its one reader is survey_summary(), and only for a
-- survey's own receptions. It becomes a partial index over survey rows. The
-- other index #242 asked about, reading_ingest_token_idx, stays: it answers
-- "what did this token write", which is the question a leaked or misused base
-- station key asks, and a scan of two years of readings is the wrong answer
-- to have to wait for then.
--
-- **5. The space comes back by reuse, not by a lock.** The backfill rewrites
-- each old row once; autovacuum then marks the old versions free, and new
-- receptions fill that space before the table grows again — roughly the
-- next few days of receptions, at October's rate. A VACUUM FULL would hand
-- the space back at once but locks the table, and the ingest with it, for as
-- long as it takes; it is not needed for the database to stop growing.

-- ── The columns ──────────────────────────────────────────────────────────────

alter table meganet.reception
  add column if not exists snr_db       real,
  add column if not exists nf_dbfs      real,
  add column if not exists freq_mhz     double precision,
  add column if not exists cfo_hz       real,
  add column if not exists sync         real,
  add column if not exists baud         real,
  add column if not exists before_s     real,
  add column if not exists a2_source    integer,
  add column if not exists a2_path      integer[],
  add column if not exists hop_limit    smallint,
  add column if not exists a2_stamp     integer,
  add column if not exists a2_fixed     smallint,
  add column if not exists a2_duplicate boolean,
  add column if not exists a2_late      boolean,
  add column if not exists fmt          text,
  add column if not exists app          text,
  add column if not exists clock        text;

comment on column meganet.reception.snr_db       is 'detail.snr_db (0072): signal over the receiver''s noise floor, dB.';
comment on column meganet.reception.nf_dbfs      is 'detail.nf_dbfs (0072): the receiver''s noise floor, dBFS — an RTL-SDR''s, uncalibrated. nf_dbm (0047) is a calibrated receiver''s.';
comment on column meganet.reception.freq_mhz     is 'detail.freq_mhz (0072). double precision: a real does not hold 151.5375.';
comment on column meganet.reception.cfo_hz       is 'detail.cfo_hz (0072): carrier frequency offset the decoder measured, Hz.';
comment on column meganet.reception.sync         is 'detail.sync (0072): the ALERT2 decoder''s sync quality, 0–1.';
comment on column meganet.reception.baud         is 'detail.baud (0072): the symbol rate the decoder locked to.';
comment on column meganet.reception.before_s     is 'detail.before_s (0072): seconds since the agent last heard this message (RPi ALERT).';
comment on column meganet.reception.a2_source    is 'detail.source (0072): the ALERT2 source address — the station that sent it.';
comment on column meganet.reception.a2_path      is 'detail.path (0072): the ALERT2 path, the repeaters it came through.';
comment on column meganet.reception.hop_limit    is 'detail.hop_limit (0072): the ALERT2 hop limit left.';
comment on column meganet.reception.a2_stamp     is 'detail.stamp (0072): the ALERT2 header''s time stamp.';
comment on column meganet.reception.a2_fixed     is 'detail.fixed (0072): bits the ALERT2 FEC corrected.';
comment on column meganet.reception.a2_duplicate is 'detail.duplicate (0072): the agent had already heard this message (another copy, often over another path).';
comment on column meganet.reception.a2_late      is 'detail.late (0072): the agent judged this copy late.';
comment on column meganet.reception.fmt          is 'detail.fmt (0072): the frame format the decoder named (ABF, ALERT2, …).';
comment on column meganet.reception.app          is 'detail.app (0072): the receiving software (RPi ALERT, …).';
comment on column meganet.reception.clock        is 'detail.clock (0072): which clock heard_at came from (utc, …).';

-- ── The split, as a row is written ───────────────────────────────────────────

create or replace function meganet.reception_split_detail_row(r meganet.reception)
returns meganet.reception
language plpgsql
immutable
set search_path = ''
as $$
declare
  d  jsonb := coalesce(r.detail, '{}'::jsonb);
  v  jsonb;
  n  numeric;
begin
  if pg_catalog.jsonb_typeof(d) <> 'object' then
    return r;
  end if;

  -- real: a number in range whose real is the same number again.
  v := d -> 'snr_db';
  if pg_catalog.jsonb_typeof(v) = 'number' then
    n := (v #>> '{}')::numeric;
    if pg_catalog.abs(n) < 1e30 and pg_catalog.to_jsonb(n::real) = v then r.snr_db := n::real; d := d - 'snr_db'; end if;
  end if;
  v := d -> 'nf_dbfs';
  if pg_catalog.jsonb_typeof(v) = 'number' then
    n := (v #>> '{}')::numeric;
    if pg_catalog.abs(n) < 1e30 and pg_catalog.to_jsonb(n::real) = v then r.nf_dbfs := n::real; d := d - 'nf_dbfs'; end if;
  end if;
  v := d -> 'cfo_hz';
  if pg_catalog.jsonb_typeof(v) = 'number' then
    n := (v #>> '{}')::numeric;
    if pg_catalog.abs(n) < 1e30 and pg_catalog.to_jsonb(n::real) = v then r.cfo_hz := n::real; d := d - 'cfo_hz'; end if;
  end if;
  v := d -> 'sync';
  if pg_catalog.jsonb_typeof(v) = 'number' then
    n := (v #>> '{}')::numeric;
    if pg_catalog.abs(n) < 1e30 and pg_catalog.to_jsonb(n::real) = v then r.sync := n::real; d := d - 'sync'; end if;
  end if;
  v := d -> 'baud';
  if pg_catalog.jsonb_typeof(v) = 'number' then
    n := (v #>> '{}')::numeric;
    if pg_catalog.abs(n) < 1e30 and pg_catalog.to_jsonb(n::real) = v then r.baud := n::real; d := d - 'baud'; end if;
  end if;
  v := d -> 'before_s';
  if pg_catalog.jsonb_typeof(v) = 'number' then
    n := (v #>> '{}')::numeric;
    if pg_catalog.abs(n) < 1e30 and pg_catalog.to_jsonb(n::real) = v then r.before_s := n::real; d := d - 'before_s'; end if;
  end if;

  -- double precision.
  v := d -> 'freq_mhz';
  if pg_catalog.jsonb_typeof(v) = 'number' then
    n := (v #>> '{}')::numeric;
    if pg_catalog.abs(n) < 1e300 and pg_catalog.to_jsonb(n::double precision) = v then r.freq_mhz := n::double precision; d := d - 'freq_mhz'; end if;
  end if;

  -- integers that fit.
  v := d -> 'source';
  if pg_catalog.jsonb_typeof(v) = 'number' and (v #>> '{}') ~ '^-?[0-9]{1,9}$' then
    r.a2_source := (v #>> '{}')::integer; d := d - 'source';
  end if;
  v := d -> 'stamp';
  if pg_catalog.jsonb_typeof(v) = 'number' and (v #>> '{}') ~ '^-?[0-9]{1,9}$' then
    r.a2_stamp := (v #>> '{}')::integer; d := d - 'stamp';
  end if;
  v := d -> 'hop_limit';
  if pg_catalog.jsonb_typeof(v) = 'number' and (v #>> '{}') ~ '^-?[0-9]{1,4}$' then
    r.hop_limit := (v #>> '{}')::smallint; d := d - 'hop_limit';
  end if;
  v := d -> 'fixed';
  if pg_catalog.jsonb_typeof(v) = 'number' and (v #>> '{}') ~ '^-?[0-9]{1,4}$' then
    r.a2_fixed := (v #>> '{}')::smallint; d := d - 'fixed';
  end if;

  -- a path: an array of integers, and nothing else.
  v := d -> 'path';
  if pg_catalog.jsonb_typeof(v) = 'array'
     and not exists (select 1 from pg_catalog.jsonb_array_elements(v) e
                      where pg_catalog.jsonb_typeof(e) <> 'number' or (e #>> '{}') !~ '^-?[0-9]{1,9}$') then
    r.a2_path := array(select (e #>> '{}')::integer from pg_catalog.jsonb_array_elements(v) with ordinality as t(e, i) order by i);
    d := d - 'path';
  end if;

  -- booleans.
  v := d -> 'duplicate';
  if pg_catalog.jsonb_typeof(v) = 'boolean' then r.a2_duplicate := (v #>> '{}')::boolean; d := d - 'duplicate'; end if;
  v := d -> 'late';
  if pg_catalog.jsonb_typeof(v) = 'boolean' then r.a2_late := (v #>> '{}')::boolean; d := d - 'late'; end if;

  -- strings.
  v := d -> 'fmt';
  if pg_catalog.jsonb_typeof(v) = 'string' then r.fmt := v #>> '{}'; d := d - 'fmt'; end if;
  v := d -> 'app';
  if pg_catalog.jsonb_typeof(v) = 'string' then r.app := v #>> '{}'; d := d - 'app'; end if;
  v := d -> 'clock';
  if pg_catalog.jsonb_typeof(v) = 'string' then r.clock := v #>> '{}'; d := d - 'clock'; end if;

  r.detail := d;
  return r;
end;
$$;

comment on function meganet.reception_split_detail_row(meganet.reception) is
  'A reception with each detail key that has a column (0072) moved into it — when its value has the column''s type and comes back exactly; anything else stays in detail. meganet.reception_detail(r) is its inverse.';

create or replace function meganet.reception_split_detail()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new := meganet.reception_split_detail_row(new);
  return new;
end;
$$;

comment on function meganet.reception_split_detail() is
  'Before insert, and before an update of detail: meganet.reception_split_detail_row() on the new row (0072).';

drop trigger if exists reception_split_detail on meganet.reception;
create trigger reception_split_detail
  before insert or update of detail on meganet.reception
  for each row execute function meganet.reception_split_detail();

-- ── And back ─────────────────────────────────────────────────────────────────
-- The columns as keys, then what is left of detail over them — the object as
-- it was posted. (A key can be in both only if a later update of detail put
-- back one the split could not take; then detail, the newer, wins.)

create or replace function meganet.reception_detail(r meganet.reception)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
           'snr_db', r.snr_db, 'nf_dbfs', r.nf_dbfs, 'freq_mhz', r.freq_mhz, 'cfo_hz', r.cfo_hz,
           'sync', r.sync, 'baud', r.baud, 'before_s', r.before_s,
           'source', r.a2_source, 'path', r.a2_path, 'hop_limit', r.hop_limit, 'stamp', r.a2_stamp,
           'fixed', r.a2_fixed, 'duplicate', r.a2_duplicate, 'late', r.a2_late,
           'fmt', r.fmt, 'app', r.app, 'clock', r.clock))
         || coalesce(r.detail, '{}'::jsonb);
$$;

comment on function meganet.reception_detail(meganet.reception) is
  'A reception''s detail whole (0072): the typed columns put back as their keys, under what is left in detail. What every reader of a reception''s detail reads.';

-- ── The readers, restated with their detail read whole ───────────────────────
-- Each from its last definition (0047, 0051, 0068, 0071) with only
-- `<alias>.detail` changed to `meganet.reception_detail(<alias>)` where a moved
-- key is read; `detail ? 'survey'` and `detail ->> 'survey'` are unchanged.
-- create or replace keeps each one's grants and comment.

create or replace function meganet.reception_window(p_from timestamptz, p_to timestamptz default now(), p_limit integer default 20000)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not meganet.is_editor() then
    raise exception 'receptions are for editors' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'heard_at', x.heard_at, 'receiver', x.receiver, 'point_id', x.point_id,
             'point_name', coalesce(p.name, x.point_id), 'token_label', t.label,
             'protocol', x.protocol, 'alert_id', x.alert_id, 'value_raw', x.value_raw, 'payload_hex', x.payload_hex,
             'ok', x.ok, 'fault', x.fault, 'rssi_dbm', x.rssi_dbm, 'level_dbfs', x.level_dbfs, 'nf_dbm', x.nf_dbm,
             'votes', x.votes, 'lat', x.lat, 'lon', x.lon, 'accuracy_m', x.accuracy_m,
             'location_source', x.location_source, 'location_approx', x.location_approx,
             'speed_mps', x.speed_mps, 'heading_deg', x.heading_deg, 'detail', meganet.reception_detail(x))
           order by x.heard_at)
      from (select * from meganet.reception
             where heard_at >= p_from and heard_at <= coalesce(p_to, pg_catalog.now())
             order by heard_at desc
             limit greatest(1, least(coalesce(p_limit, 20000), 50000))) x
      join meganet.ingest_token t on t.id = x.ingest_token_id
      left join meganet.ingest_point_latest p on p.ingest_token_id = x.ingest_token_id and p.point_id = x.point_id
  ), '[]'::jsonb);
end;
$$;

create or replace function meganet.survey_receptions(p_survey text, p_limit integer default 50000)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not meganet.is_editor() then
    raise exception 'site surveys are for editors' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'heard_at', x.heard_at, 'receiver', x.receiver, 'point_id', x.point_id,
             'point_name', coalesce(p.name, x.point_id), 'token_label', t.label,
             'protocol', x.protocol, 'alert_id', x.alert_id, 'value_raw', x.value_raw, 'payload_hex', x.payload_hex,
             'ok', x.ok, 'fault', x.fault, 'rssi_dbm', x.rssi_dbm, 'level_dbfs', x.level_dbfs, 'nf_dbm', x.nf_dbm,
             'votes', x.votes, 'lat', x.lat, 'lon', x.lon, 'accuracy_m', x.accuracy_m,
             'location_source', x.location_source, 'location_approx', x.location_approx,
             'speed_mps', x.speed_mps, 'heading_deg', x.heading_deg, 'detail', meganet.reception_detail(x))
           order by x.heard_at)
      from (select * from meganet.reception r
             where r.detail ? 'survey' and r.detail ->> 'survey' = p_survey
             order by r.heard_at
             limit greatest(1, least(coalesce(p_limit, 50000), 100000))) x
      join meganet.ingest_token t on t.id = x.ingest_token_id
      left join meganet.ingest_point_latest p on p.ingest_token_id = x.ingest_token_id and p.point_id = x.point_id
  ), '[]'::jsonb);
end;
$$;

create or replace function meganet.survey_summary(p_survey text, p_match_s integer default 10)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_w     interval;
  v_t0    timestamptz;
  v_t1    timestamptz;
  v_paths text[];
  v_head  jsonb;
  v_rows  jsonb;
  v_slots integer;
  v_radio smallint[];
begin
  if not meganet.is_editor() then
    raise exception 'site surveys are for editors' using errcode = '42501';
  end if;
  v_w := pg_catalog.make_interval(secs => greatest(1, least(coalesce(p_match_s, 10), 300)));
  v_radio := array(select p.code from meganet.protocol p where p.key in ('alert', 'alert2'));

  select pg_catalog.min(x.heard_at), pg_catalog.max(x.heard_at),
         pg_catalog.array_agg(distinct 'serial-monitor/' || x.point_id)
    into v_t0, v_t1, v_paths
    from meganet.reception x
   where x.detail ? 'survey' and x.detail ->> 'survey' = p_survey;
  if v_t0 is null then
    return null;
  end if;

  -- Twenty-minute slots with anything heard: how long it was listening.
  select pg_catalog.count(distinct pg_catalog.date_bin(interval '20 minutes', x.heard_at, v_t0))
    into v_slots
    from meganet.reception x
   where x.detail ? 'survey' and x.detail ->> 'survey' = p_survey;

  select pg_catalog.jsonb_build_object(
           'id', p_survey,
           'name', pg_catalog.max(x.detail ->> 'survey_name'),
           'token_label', pg_catalog.max(t.label),
           'first_heard', v_t0, 'last_heard', v_t1,
           'listening_h', pg_catalog.round(v_slots / 3.0, 1),
           'match_s', pg_catalog.date_part('epoch', v_w)::integer,
           'frames', pg_catalog.count(*),
           'ok', pg_catalog.count(*) filter (where x.ok),
           'bad', pg_catalog.count(*) filter (where not x.ok and x.alert_id is not null),
           'undecoded', pg_catalog.count(*) filter (where x.alert_id is null),
           'lat', pg_catalog.avg(x.lat), 'lon', pg_catalog.avg(x.lon),
           'gps', coalesce(pg_catalog.bool_or(x.location_source = 'gps'), false),
           'location_source', pg_catalog.max(x.location_source),
           'points', (select pg_catalog.jsonb_agg(pp order by pp.point_id) from (
                        select y.point_id, y.receiver,
                               pg_catalog.max(case when pg_catalog.jsonb_typeof(meganet.reception_detail(y) -> 'freq_mhz') = 'number' then (meganet.reception_detail(y) ->> 'freq_mhz')::numeric end) as freq_mhz,
                               pg_catalog.count(*) filter (where y.ok) as ok,
                               pg_catalog.count(*) filter (where not y.ok and y.alert_id is not null) as bad,
                               pg_catalog.count(*) filter (where y.alert_id is null) as undecoded
                          from meganet.reception y
                         where y.detail ? 'survey' and y.detail ->> 'survey' = p_survey
                         group by y.point_id, y.receiver) pp))
    into v_head
    from meganet.reception x
    join meganet.ingest_token t on t.id = x.ingest_token_id
   where x.detail ? 'survey' and x.detail ->> 'survey' = p_survey;

  with sv as (
    select x.alert_id, x.value_raw, x.heard_at, x.ok, x.point_id, x.rssi_dbm, x.level_dbfs,
           case when pg_catalog.jsonb_typeof(meganet.reception_detail(x) -> 'snr_db') = 'number' then (meganet.reception_detail(x) ->> 'snr_db')::real
                when x.rssi_dbm is not null and x.nf_dbm is not null then x.rssi_dbm - x.nf_dbm end as snr_db,
           case when pg_catalog.jsonb_typeof(meganet.reception_detail(x) -> 'freq_mhz') = 'number' then (meganet.reception_detail(x) ->> 'freq_mhz')::numeric end as freq_mhz
      from meganet.reception x
     where x.detail ? 'survey' and x.detail ->> 'survey' = p_survey and x.alert_id is not null
  ),
  heard as (
    select s.alert_id,
           pg_catalog.count(*) filter (where s.ok) as ok,
           pg_catalog.count(*) filter (where not s.ok) as bad,
           pg_catalog.min(s.heard_at) filter (where s.ok) as first_heard,
           pg_catalog.max(s.heard_at) filter (where s.ok) as last_heard,
           pg_catalog.percentile_disc(array[0.1, 0.5, 0.9]) within group (order by s.level_dbfs) filter (where s.ok and s.level_dbfs is not null) as level_dbfs,
           pg_catalog.percentile_disc(array[0.1, 0.5, 0.9]) within group (order by s.rssi_dbm) filter (where s.ok and s.rssi_dbm is not null) as rssi_dbm,
           pg_catalog.percentile_disc(0.5) within group (order by s.snr_db) filter (where s.ok and s.snr_db is not null) as snr_db,
           pg_catalog.array_agg(distinct s.freq_mhz) filter (where s.freq_mhz is not null) as freqs,
           pg_catalog.array_agg(distinct s.point_id) as points
      from sv s
     group by s.alert_id
  ),
  -- The site's good frames as transmissions: one per address and value within 5 s.
  svt as (
    select q.alert_id, q.value_raw, q.heard_at
      from (select s.alert_id, s.value_raw, s.heard_at,
                   pg_catalog.lag(s.heard_at) over (partition by s.alert_id, s.value_raw order by s.heard_at) as prev
              from sv s
             where s.ok and s.value_raw is not null) q
     where q.prev is null or q.heard_at - q.prev > interval '5 seconds'
  ),
  only_here as (
    select t.alert_id, pg_catalog.count(*) as n
      from svt t
     where not exists (
             select 1 from meganet.reading r
              where r.addr = 'a:' || t.alert_id
                and r.reading_ts between t.heard_at - v_w and t.heard_at + v_w
                and r.value_raw = t.value_raw
                and not (coalesce(r.path, '') = any (v_paths)
                         and not exists (select 1 from pg_catalog.unnest(r.dup_paths) d where d <> all (v_paths))))
     group by t.alert_id
  ),
  -- What the network stored over the same days, less what only the survey stored.
  net as (
    select q.alert_id, q.value_raw, q.reading_ts
      from (select r.alert_id, r.value_raw, r.reading_ts,
                   pg_catalog.lag(r.reading_ts) over (partition by r.alert_id, r.value_raw order by r.reading_ts) as prev
              from meganet.reading r
             where r.reading_ts between v_t0 and v_t1
               and r.alert_id is not null
               and r.protocol = any (v_radio)
               and not (coalesce(r.path, '') = any (v_paths)
                        and not exists (select 1 from pg_catalog.unnest(r.dup_paths) d where d <> all (v_paths)))) q
     where q.prev is null or q.reading_ts - q.prev > interval '5 seconds'
  ),
  sent as (
    select n.alert_id,
           pg_catalog.count(*) as sent,
           pg_catalog.count(*) filter (where exists (
             select 1 from meganet.reception s
              where s.alert_id = n.alert_id and s.heard_at between n.reading_ts - v_w and n.reading_ts + v_w
                and s.value_raw = n.value_raw and s.ok
                and s.detail ? 'survey' and s.detail ->> 'survey' = p_survey)) as heard_of_sent
      from net n
     where exists (select 1 from meganet.reception s
                    where s.detail ? 'survey' and s.detail ->> 'survey' = p_survey
                      and s.heard_at between n.reading_ts - interval '20 minutes' and n.reading_ts + interval '20 minutes')
     group by n.alert_id
  )
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'alert_id', coalesce(h.alert_id, n.alert_id),
           'ok', coalesce(h.ok, 0), 'bad', coalesce(h.bad, 0),
           'first_heard', h.first_heard, 'last_heard', h.last_heard,
           'level_dbfs', h.level_dbfs, 'rssi_dbm', h.rssi_dbm, 'snr_db', h.snr_db,
           'freqs', h.freqs, 'points', h.points,
           'sent', coalesce(n.sent, 0), 'heard_of_sent', coalesce(n.heard_of_sent, 0),
           'only_here', coalesce(o.n, 0))
           order by coalesce(h.ok, 0) desc, coalesce(h.alert_id, n.alert_id))
    into v_rows
    from heard h
    full join sent n on n.alert_id = h.alert_id
    left join only_here o on o.alert_id = coalesce(h.alert_id, n.alert_id);

  return v_head || pg_catalog.jsonb_build_object('stations', coalesce(v_rows, '[]'::jsonb));
end;
$$;

create or replace function meganet.admin_base_station_spectrum(p_id bigint, p_hours integer default 1, p_since timestamptz default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now    timestamptz := pg_catalog.now();
  v_hours  integer := greatest(1, least(48, coalesce(p_hours, 1)));
  v_bucket integer;
  v_from   timestamptz;
  v_rows   jsonb;
  v_bursts jsonb;
begin
  perform meganet.admin_require();
  if not exists (select 1 from meganet.ingest_token t where t.id = p_id) then
    raise exception 'no ingest token %', p_id using errcode = '22023';
  end if;
  -- 360 slices a window: ten seconds an hour shown.
  v_bucket := v_hours * 10;
  v_from := v_now - pg_catalog.make_interval(hours => v_hours);
  if p_since is not null and p_since > v_from then
    v_from := pg_catalog.to_timestamp((pg_catalog.floor(extract(epoch from p_since) / v_bucket) * v_bucket)::double precision);
  end if;

  with r as (
    select p.rx_key, p.center_hz, p.rate, p.floor_db, p.span_s, p.bins, pg_catalog.octet_length(p.bins) as len,
           (pg_catalog.floor(extract(epoch from p.at) / v_bucket) * v_bucket)::bigint as t
      from meganet.base_station_spectrum p
     where p.ingest_token_id = p_id and p.at >= v_from),
  g as (
    select r.rx_key, r.center_hz, r.rate, r.len, r.t,
           pg_catalog.round(pg_catalog.avg(r.floor_db)::numeric, 1) as floor_db, pg_catalog.sum(r.span_s) as span_s, pg_catalog.count(*) as n
      from r group by r.rx_key, r.center_hz, r.rate, r.len, r.t),
  m as (
    select r.rx_key, r.center_hz, r.rate, r.len, r.t, i.i, pg_catalog.max(pg_catalog.get_byte(r.bins, i.i)) as v
      from r cross join lateral pg_catalog.generate_series(0, r.len - 1) as i(i)
     group by r.rx_key, r.center_hz, r.rate, r.len, r.t, i.i),
  j as (
    select m.rx_key, m.center_hz, m.rate, m.len, m.t,
           pg_catalog.decode(pg_catalog.string_agg(pg_catalog.lpad(pg_catalog.to_hex(m.v), 2, '0'), '' order by m.i), 'hex') as bins
      from m group by m.rx_key, m.center_hz, m.rate, m.len, m.t)
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           't', g.t, 'key', g.rx_key, 'center_hz', g.center_hz, 'rate', g.rate, 'floor_db', g.floor_db,
           'span_s', g.span_s, 'n', g.n, 'bins', pg_catalog.translate(pg_catalog.encode(j.bins, 'base64'), E'\n', ''))
           order by g.t, g.rx_key)
    into v_rows
    from g join j using (rx_key, center_hz, rate, len, t);

  -- What it heard, in the same slices: a burst is a moment a receiver heard
  -- something on a frequency, however many readings it carried.
  with x as (
    select (pg_catalog.floor(extract(epoch from x.heard_at) / v_bucket) * v_bucket)::bigint as t,
           pg_catalog.round((meganet.reception_detail(x) ->> 'freq_mhz')::numeric, 4) as f,
           x.heard_at, x.ok, x.protocol,
           case when pg_catalog.jsonb_typeof(meganet.reception_detail(x) -> 'snr_db') = 'number' then (meganet.reception_detail(x) ->> 'snr_db')::numeric
                when x.level_dbfs is not null and pg_catalog.jsonb_typeof(meganet.reception_detail(x) -> 'nf_dbfs') = 'number'
                  then x.level_dbfs::numeric - (meganet.reception_detail(x) ->> 'nf_dbfs')::numeric end as snr
      from meganet.reception x
     where x.ingest_token_id = p_id and x.heard_at >= v_from and x.heard_at <= v_now + interval '1 minute'
       and pg_catalog.jsonb_typeof(meganet.reception_detail(x) -> 'freq_mhz') = 'number'),
  y as (
    select x.t, x.f, pg_catalog.count(distinct x.heard_at) as n,
           pg_catalog.count(distinct x.heard_at) filter (where x.ok) as decoded,
           pg_catalog.count(distinct x.heard_at) filter (where x.ok and x.protocol = 'alert2') as alert2,
           pg_catalog.round(pg_catalog.max(x.snr), 1) as snr
      from x group by x.t, x.f
     order by x.t desc, x.f
     limit 5000)
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(y.t, y.f, y.n, y.decoded, y.alert2, y.snr) order by y.t, y.f)
    into v_bursts
    from y;

  return pg_catalog.jsonb_build_object(
    'now', v_now, 'hours', v_hours, 'bucket_s', v_bucket, 'from', v_from,
    'rows', coalesce(v_rows, '[]'::jsonb), 'bursts', coalesce(v_bursts, '[]'::jsonb));
end;
$$;

create or replace function meganet.roll_up_receptions(p_max_hours integer default 48)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_days_kept integer;
  v_floor     timestamptz;
  v_wm        bigint;
  v_high      bigint;
  v_skipped   integer := 0;
  v_hours     integer := 0;
  v_days      integer := 0;
  v_hour      timestamptz;
  v_day       date;
  v_touched   date[] := '{}';
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to roll up receptions' using errcode = '42501';
  end if;

  v_days_kept := coalesce((select a.value::integer from meganet.app_meta a
                            where a.key = 'retain_reception_days'), 90);
  v_floor := pg_catalog.date_trunc('hour', pg_catalog.now() - v_days_kept * interval '1 day')
             + interval '1 hour';

  -- Note the hours new receptions touched. Only rows received two minutes ago
  -- or more move the watermark: see decision 4.
  v_wm := coalesce((select a.value::bigint from meganet.app_meta a
                     where a.key = 'reception_rollup_watermark'), 0);
  select pg_catalog.max(r.id) into v_high
    from meganet.reception r
   where r.id > v_wm and r.received_at < pg_catalog.now() - interval '2 minutes';

  if v_high is not null then
    insert into meganet.reception_rollup_dirty (bucket)
    select distinct pg_catalog.date_trunc('hour', r.heard_at)
      from meganet.reception r
     where r.id > v_wm and r.id <= v_high
    on conflict (bucket) do nothing;

    insert into meganet.app_meta (key, value)
    values ('reception_rollup_watermark', v_high::text)
    on conflict (key) do update set value = excluded.value;
  end if;

  insert into meganet.reception_rollup_dirty (bucket)
  values (pg_catalog.date_trunc('hour', pg_catalog.now())),
         (pg_catalog.date_trunc('hour', pg_catalog.now()) - interval '1 hour')
  on conflict (bucket) do nothing;

  with gone as (
    delete from meganet.reception_rollup_dirty d where d.bucket < v_floor returning 1
  )
  select pg_catalog.count(*) into v_skipped from gone;

  for v_hour in
    select d.bucket from meganet.reception_rollup_dirty d
     order by d.bucket
     limit greatest(coalesce(p_max_hours, 48), 0)
  loop
    delete from meganet.reception_hourly h where h.bucket = v_hour;

    insert into meganet.reception_hourly (
      bucket, ingest_token_id, point_id, protocol, station, path, survey,
      n, n_ok, n_bad, n_dup,
      n_rejected, n_undecoded, n_shadow, n_status, n_frame, n_crc,
      snr_n, snr_min, snr_max, snr_sum,
      nf_dbfs_n, nf_dbfs_min, nf_dbfs_max, nf_dbfs_sum,
      nf_dbm_n, nf_dbm_min, nf_dbm_max, nf_dbm_sum,
      rssi_n, rssi_min, rssi_max, rssi_sum,
      level_n, level_min, level_max, level_sum,
      cfo_n, cfo_min, cfo_max, cfo_sum,
      freq_min, freq_max, first_heard, last_heard, rolled_at)
    select v_hour, x.ingest_token_id, x.point_id, x.protocol, x.station, x.path, x.survey,
           pg_catalog.count(*)::integer,
           (pg_catalog.count(*) filter (where x.ok))::integer,
           (pg_catalog.count(*) filter (where not x.ok))::integer,
           (pg_catalog.count(*) filter (where x.dup))::integer,
           (pg_catalog.count(*) filter (where x.fault = 'rejected'))::integer,
           (pg_catalog.count(*) filter (where x.fault = 'undecoded'))::integer,
           (pg_catalog.count(*) filter (where x.fault = 'shadow'))::integer,
           (pg_catalog.count(*) filter (where x.fault = 'status'))::integer,
           (pg_catalog.count(*) filter (where x.fault = 'frame'))::integer,
           (pg_catalog.count(*) filter (where x.fault = 'crc'))::integer,
           pg_catalog.count(x.snr)::integer, pg_catalog.min(x.snr), pg_catalog.max(x.snr), pg_catalog.sum(x.snr),
           pg_catalog.count(x.nf_dbfs)::integer, pg_catalog.min(x.nf_dbfs), pg_catalog.max(x.nf_dbfs), pg_catalog.sum(x.nf_dbfs),
           pg_catalog.count(x.nf_dbm)::integer, pg_catalog.min(x.nf_dbm), pg_catalog.max(x.nf_dbm), pg_catalog.sum(x.nf_dbm),
           pg_catalog.count(x.rssi)::integer, pg_catalog.min(x.rssi), pg_catalog.max(x.rssi), pg_catalog.sum(x.rssi),
           pg_catalog.count(x.level)::integer, pg_catalog.min(x.level), pg_catalog.max(x.level), pg_catalog.sum(x.level),
           pg_catalog.count(x.cfo)::integer, pg_catalog.min(x.cfo), pg_catalog.max(x.cfo), pg_catalog.sum(x.cfo),
           pg_catalog.min(x.freq), pg_catalog.max(x.freq),
           pg_catalog.min(x.heard_at), pg_catalog.max(x.heard_at), pg_catalog.now()
      from (
        select r.ingest_token_id, r.point_id, r.protocol,
               case when r.protocol = 'alert2' and (meganet.reception_detail(r) ->> 'source') ~ '^[0-9]{1,9}$'
                    then (meganet.reception_detail(r) ->> 'source')::integer
                    else r.alert_id end                                          as station,
               case when pg_catalog.jsonb_typeof(meganet.reception_detail(r) -> 'path') = 'array'
                    then array(select e::integer
                                 from pg_catalog.jsonb_array_elements_text(meganet.reception_detail(r) -> 'path') e
                                where e ~ '^[0-9]{1,9}$') end                    as path,
               nullif(r.detail ->> 'survey', '')                                 as survey,
               r.ok, r.fault,
               coalesce(meganet.reception_detail(r) -> 'duplicate' = 'true'::jsonb, false)          as dup,
               case when pg_catalog.jsonb_typeof(meganet.reception_detail(r) -> 'snr_db')   = 'number' then (meganet.reception_detail(r) ->> 'snr_db')::double precision   end as snr,
               case when pg_catalog.jsonb_typeof(meganet.reception_detail(r) -> 'nf_dbfs')  = 'number' then (meganet.reception_detail(r) ->> 'nf_dbfs')::double precision  end as nf_dbfs,
               r.nf_dbm::double precision                                        as nf_dbm,
               r.rssi_dbm::double precision                                      as rssi,
               r.level_dbfs::double precision                                    as level,
               case when pg_catalog.jsonb_typeof(meganet.reception_detail(r) -> 'cfo_hz')   = 'number' then (meganet.reception_detail(r) ->> 'cfo_hz')::double precision   end as cfo,
               case when pg_catalog.jsonb_typeof(meganet.reception_detail(r) -> 'freq_mhz') = 'number' then (meganet.reception_detail(r) ->> 'freq_mhz')::double precision end as freq,
               r.heard_at
          from meganet.reception r
         where r.heard_at >= v_hour and r.heard_at < v_hour + interval '1 hour'
      ) x
     group by x.ingest_token_id, x.point_id, x.protocol, x.station, x.path, x.survey;

    delete from meganet.reception_rollup_dirty d where d.bucket = v_hour;
    v_hours := v_hours + 1;
    v_day := (v_hour at time zone 'UTC')::date;
    if not v_day = any (v_touched) then
      v_touched := v_touched || v_day;
    end if;
  end loop;

  -- The days, from the hours.
  foreach v_day in array v_touched loop
    delete from meganet.reception_daily d where d.bucket = v_day;

    insert into meganet.reception_daily (
      bucket, ingest_token_id, point_id, protocol, station, path, survey,
      n, n_ok, n_bad, n_dup,
      n_rejected, n_undecoded, n_shadow, n_status, n_frame, n_crc,
      snr_n, snr_min, snr_max, snr_sum,
      nf_dbfs_n, nf_dbfs_min, nf_dbfs_max, nf_dbfs_sum,
      nf_dbm_n, nf_dbm_min, nf_dbm_max, nf_dbm_sum,
      rssi_n, rssi_min, rssi_max, rssi_sum,
      level_n, level_min, level_max, level_sum,
      cfo_n, cfo_min, cfo_max, cfo_sum,
      freq_min, freq_max, first_heard, last_heard, rolled_at)
    select v_day, h.ingest_token_id, h.point_id, h.protocol, h.station, h.path, h.survey,
           pg_catalog.sum(h.n)::integer, pg_catalog.sum(h.n_ok)::integer, pg_catalog.sum(h.n_bad)::integer, pg_catalog.sum(h.n_dup)::integer,
           pg_catalog.sum(h.n_rejected)::integer, pg_catalog.sum(h.n_undecoded)::integer, pg_catalog.sum(h.n_shadow)::integer,
           pg_catalog.sum(h.n_status)::integer, pg_catalog.sum(h.n_frame)::integer, pg_catalog.sum(h.n_crc)::integer,
           pg_catalog.sum(h.snr_n)::integer, pg_catalog.min(h.snr_min), pg_catalog.max(h.snr_max), pg_catalog.sum(h.snr_sum),
           pg_catalog.sum(h.nf_dbfs_n)::integer, pg_catalog.min(h.nf_dbfs_min), pg_catalog.max(h.nf_dbfs_max), pg_catalog.sum(h.nf_dbfs_sum),
           pg_catalog.sum(h.nf_dbm_n)::integer, pg_catalog.min(h.nf_dbm_min), pg_catalog.max(h.nf_dbm_max), pg_catalog.sum(h.nf_dbm_sum),
           pg_catalog.sum(h.rssi_n)::integer, pg_catalog.min(h.rssi_min), pg_catalog.max(h.rssi_max), pg_catalog.sum(h.rssi_sum),
           pg_catalog.sum(h.level_n)::integer, pg_catalog.min(h.level_min), pg_catalog.max(h.level_max), pg_catalog.sum(h.level_sum),
           pg_catalog.sum(h.cfo_n)::integer, pg_catalog.min(h.cfo_min), pg_catalog.max(h.cfo_max), pg_catalog.sum(h.cfo_sum),
           pg_catalog.min(h.freq_min), pg_catalog.max(h.freq_max),
           pg_catalog.min(h.first_heard), pg_catalog.max(h.last_heard), pg_catalog.now()
      from meganet.reception_hourly h
     where h.bucket >= (v_day::timestamp at time zone 'UTC')
       and h.bucket <  ((v_day + 1)::timestamp at time zone 'UTC')
     group by h.ingest_token_id, h.point_id, h.protocol, h.station, h.path, h.survey;

    v_days := v_days + 1;
  end loop;

  return pg_catalog.jsonb_build_object(
    'hours',     v_hours,
    'days',      v_days,
    'skipped',   v_skipped,
    'pending',   (select pg_catalog.count(*) from meganet.reception_rollup_dirty),
    'watermark', coalesce(v_high, v_wm));
end;
$$;

-- ── reception_alert_idx, for survey rows only ────────────────────────────────

drop index if exists meganet.reception_alert_idx;
create index if not exists reception_survey_alert_idx on meganet.reception (alert_id, heard_at)
  where detail ? 'survey';

-- ── The backfill ─────────────────────────────────────────────────────────────
-- Rewriting detail fires the split. Oldest first, at most p_max_rows a call,
-- so a call is bounded and a stopped run resumes where it left off.

create or replace function meganet.reception_split_backfill(p_max_rows integer default 25000)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_keys text[] := array['snr_db', 'nf_dbfs', 'freq_mhz', 'cfo_hz', 'sync', 'baud', 'before_s',
                         'source', 'path', 'hop_limit', 'stamp', 'fixed', 'duplicate', 'late',
                         'fmt', 'app', 'clock'];
  v_from bigint := coalesce((select a.value::bigint from meganet.app_meta a
                              where a.key = 'reception_split_backfill_from'), 0);
  v_to   bigint;
  v_n    integer;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to rewrite receptions' using errcode = '42501';
  end if;

  select pg_catalog.max(q.id) into v_to
    from (select r.id from meganet.reception r
           where r.id > v_from order by r.id limit greatest(coalesce(p_max_rows, 25000), 1)) q;
  if v_to is null then
    return pg_catalog.jsonb_build_object('updated', 0, 'through_id', v_from, 'remaining', 0);
  end if;

  update meganet.reception r set detail = r.detail
   where r.id > v_from and r.id <= v_to and r.detail ?| v_keys;
  get diagnostics v_n = row_count;

  insert into meganet.app_meta (key, value) values ('reception_split_backfill_from', v_to::text)
  on conflict (key) do update set value = excluded.value;

  return pg_catalog.jsonb_build_object(
    'updated', v_n, 'through_id', v_to,
    'remaining', (select pg_catalog.count(*) from meganet.reception r where r.id > v_to));
end;
$$;

comment on function meganet.reception_split_backfill(integer) is
  'Splits the detail of receptions stored before 0072, oldest first, at most p_max_rows ids a call; resumable (app_meta reception_split_backfill_from). Run until remaining is 0. Editors and the service key.';

revoke all on function meganet.reception_split_backfill(integer) from public;
revoke all on function meganet.reception_split_detail() from public;
revoke all on function meganet.reception_split_detail_row(meganet.reception) from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;
  grant execute on function meganet.reception_split_backfill(integer) to service_role;
  grant execute on function meganet.reception_detail(meganet.reception) to authenticated, service_role;
  notify pgrst, 'reload schema';
end
$$;

-- ── Proof it took ────────────────────────────────────────────────────────────

do $$
declare
  v_in  jsonb := '{"app":"RPi ALERT","fmt":"ALERT2","baud":4800,"late":false,"path":[11056,10019],"sync":0.96,"clock":"utc","fixed":0,"stamp":15621,"cfo_hz":262,"snr_db":21.6,"source":33300,"nf_dbfs":-61.5,"before_s":20,"freq_mhz":151.5375,"duplicate":true,"hop_limit":3,"crc":null,"kind":"other","snr_x":"odd"}'::jsonb;
  r     meganet.reception;
begin
  if pg_catalog.to_regprocedure('meganet.reception_detail(meganet.reception)') is null
     or not exists (select 1 from pg_catalog.pg_trigger t
                     where t.tgrelid = 'meganet.reception'::regclass and t.tgname = 'reception_split_detail') then
    raise exception '0072 did not take: the split trigger or reception_detail() is missing';
  end if;
  r.detail := v_in;
  r := meganet.reception_split_detail_row(r);
  if meganet.reception_detail(r) <> v_in then
    raise exception '0072 did not take: a reception''s detail does not come back whole (% vs %)', meganet.reception_detail(r), v_in;
  end if;
  if r.detail <> '{"crc":null,"kind":"other","snr_x":"odd"}'::jsonb or r.freq_mhz <> 151.5375 or r.a2_path <> array[11056, 10019] then
    raise exception '0072 did not take: the split is not what it should be (%)', r.detail;
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 72 when this is applied. The guard means
-- applying it out of order leaves the higher number.

insert into meganet.app_meta (key, value)
values ('schema_version', '72')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
