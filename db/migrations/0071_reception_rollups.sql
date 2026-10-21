-- 0071_reception_rollups.sql — Receptions rolled up by the hour and the day,
-- kept forever: the long-term record of the network's health (#241).
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0071_reception_rollups.sql
--
-- Why this file exists
-- ────────────────────
-- meganet.reception (0047) keeps every copy every receiver hears: when, how
-- loud (SNR, noise floor, level), over which repeater path, and why it failed.
-- That is what network-health forensics reads, and since the second receiver
-- came up on 2026-10-19 it is ~96k rows and ~65 MB a day. EPIC #240's regime
-- (agreed with the owner, 2026-10-21): full detail 90 days in the database,
-- every raw row archived to R2 (#243), and **these rollups in the database
-- forever** — so "has this receiver's noise floor crept up since last winter",
-- "is this repeater link fading", "did failures start the week the new
-- transmitter went in" stay instant questions years from now. Measured on the
-- live table: ~4.5k hourly rows a day where there were ~96k receptions.
--
-- Nothing here deletes a reception. That is #243's, and it waits for the
-- archive.
--
-- Five decisions.
--
-- **1. The key is who heard whom, over what, when.** An ingest point and its
-- receiver (`ingest_token_id`, `point_id`), the protocol, the transmitting
-- station, the repeater path, the survey (a drive's receptions are not a fixed
-- receiver's) and the hour of `heard_at`. The station is the ALERT2 source
-- address (`detail.source`) for ALERT2 and `alert_id` for legacy ALERT; null is
-- "not identified" — an undecoded burst — kept as its own row, because a
-- receiver's undecoded rate is one of the things this is for. `path` is the
-- ALERT2 path as an integer array, null for legacy ALERT.
--
-- **2. Counts and sums, never means** — 0006's rule for readings. A day is
-- built from its hours exactly, and a month or a year from days, which a mean
-- cannot do. Min, max, sum and count for SNR, both noise floors (the
-- receiver's dBFS from `detail.nf_dbfs`; `nf_dbm` where a receiver reports
-- one), RSSI, level and carrier offset; a count per fault (0047's six, which a
-- constraint holds, so a new one is a migration that comes here too).
--
-- **3. Work by the hour, from a queue.** A first try at the whole table in one
-- statement took 26 s on the live project. So `roll_up_receptions()` notes the
-- hours that new receptions touched (by `id`, above a watermark — a range on
-- the primary key, never a scan of `received_at`, which has no index) in
-- `reception_rollup_dirty`, then rebuilds at most `p_max_hours` of them, oldest
-- first, each one a BRIN range on `heard_at`: delete that hour's rows, insert
-- them again. The days those hours fall in are rebuilt from the hours. The
-- backfill is the same queue, drained a batch at a time.
--
-- **4. Late rows are caught twice over.** A reception can commit after one
-- with a higher id (two ingest calls at once), and a watermark on id alone
-- would step past it. So the watermark only advances over rows received more
-- than two minutes ago, and the current and previous hours are marked dirty on
-- every run regardless. The Pi's queue can hold receptions back (8.5 minutes
-- at most on the live table so far); those land in the hour they were heard,
-- which the queue rebuilds when they arrive.
--
-- **5. Not past the horizon.** An hour whose receptions #243 has already aged
-- out cannot be rebuilt — what is left would overwrite a rollup that was
-- correct when it was made — so the run drops those from the queue and says
-- how many (as `roll_up()` does). The horizon is `app_meta`
-- `retain_reception_days`, written here as 90 for #243 to read.
--
-- Days are UTC days, as `reading_daily`'s are. Read like receptions: editors
-- only. pg_cron hourly at minute 9, after `meganet-roll-up` at 7.

-- ── The horizon ──────────────────────────────────────────────────────────────

insert into meganet.app_meta (key, value)
values ('retain_reception_days', '90')
on conflict (key) do nothing;

-- ── The rollups ──────────────────────────────────────────────────────────────

create table if not exists meganet.reception_hourly (
  bucket           timestamptz not null,
  ingest_token_id  bigint      not null,
  point_id         text        not null,
  protocol         text        not null,
  station          integer,
  path             integer[],
  survey           text,
  n                integer     not null,
  n_ok             integer     not null,
  n_bad            integer     not null,
  n_dup            integer     not null,
  n_rejected       integer     not null,
  n_undecoded      integer     not null,
  n_shadow         integer     not null,
  n_status         integer     not null,
  n_frame          integer     not null,
  n_crc            integer     not null,
  snr_n            integer     not null,
  snr_min          real,
  snr_max          real,
  snr_sum          double precision,
  nf_dbfs_n        integer     not null,
  nf_dbfs_min      real,
  nf_dbfs_max      real,
  nf_dbfs_sum      double precision,
  nf_dbm_n         integer     not null,
  nf_dbm_min       real,
  nf_dbm_max       real,
  nf_dbm_sum       double precision,
  rssi_n           integer     not null,
  rssi_min         real,
  rssi_max         real,
  rssi_sum         double precision,
  level_n          integer     not null,
  level_min        real,
  level_max        real,
  level_sum        double precision,
  cfo_n            integer     not null,
  cfo_min          real,
  cfo_max          real,
  cfo_sum          double precision,
  freq_min         real,
  freq_max         real,
  first_heard      timestamptz not null,
  last_heard       timestamptz not null,
  rolled_at        timestamptz not null default now()
);

create unique index if not exists reception_hourly_key on meganet.reception_hourly
  (bucket, ingest_token_id, point_id, protocol, station, path, survey) nulls not distinct;
create index if not exists reception_hourly_point on meganet.reception_hourly (point_id, bucket);
create index if not exists reception_hourly_station on meganet.reception_hourly (station, bucket) where station is not null;

comment on table meganet.reception_hourly is
  'Receptions rolled up by the hour of heard_at (0071, #241): per ingest point and receiver, protocol, transmitting station (ALERT2 source, else alert_id; null = not identified), repeater path and survey — counts, faults, and min/max/sum/count of SNR, noise floor, RSSI, level and carrier offset. Sums, not means, so days are built from hours exactly. Kept forever. Editors only, like reception.';

create table if not exists meganet.reception_daily (like meganet.reception_hourly including defaults);
alter table meganet.reception_daily alter column bucket type date using bucket::date;

create unique index if not exists reception_daily_key on meganet.reception_daily
  (bucket, ingest_token_id, point_id, protocol, station, path, survey) nulls not distinct;
create index if not exists reception_daily_point on meganet.reception_daily (point_id, bucket);
create index if not exists reception_daily_station on meganet.reception_daily (station, bucket) where station is not null;

comment on table meganet.reception_daily is
  'reception_hourly summed by the UTC day (0071, #241), from the hours, so it stays exact after the receptions behind it are gone. Kept forever. Editors only.';

-- The hours waiting to be rebuilt. Internal: RLS on, no policy.
create table if not exists meganet.reception_rollup_dirty (
  bucket   timestamptz primary key,
  noted_at timestamptz not null default now()
);

comment on table meganet.reception_rollup_dirty is
  'Hours of heard_at that roll_up_receptions() still has to rebuild (0071). Internal.';

alter table meganet.reception_hourly       enable row level security;
alter table meganet.reception_daily        enable row level security;
alter table meganet.reception_rollup_dirty enable row level security;

drop policy if exists reception_hourly_read_editors on meganet.reception_hourly;
create policy reception_hourly_read_editors on meganet.reception_hourly
  for select to authenticated using (meganet.is_editor());
drop policy if exists reception_daily_read_editors on meganet.reception_daily;
create policy reception_daily_read_editors on meganet.reception_daily
  for select to authenticated using (meganet.is_editor());

-- ── The job ──────────────────────────────────────────────────────────────────

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
               case when r.protocol = 'alert2' and (r.detail ->> 'source') ~ '^[0-9]{1,9}$'
                    then (r.detail ->> 'source')::integer
                    else r.alert_id end                                          as station,
               case when pg_catalog.jsonb_typeof(r.detail -> 'path') = 'array'
                    then array(select e::integer
                                 from pg_catalog.jsonb_array_elements_text(r.detail -> 'path') e
                                where e ~ '^[0-9]{1,9}$') end                    as path,
               nullif(r.detail ->> 'survey', '')                                 as survey,
               r.ok, r.fault,
               coalesce(r.detail -> 'duplicate' = 'true'::jsonb, false)          as dup,
               case when pg_catalog.jsonb_typeof(r.detail -> 'snr_db')   = 'number' then (r.detail ->> 'snr_db')::double precision   end as snr,
               case when pg_catalog.jsonb_typeof(r.detail -> 'nf_dbfs')  = 'number' then (r.detail ->> 'nf_dbfs')::double precision  end as nf_dbfs,
               r.nf_dbm::double precision                                        as nf_dbm,
               r.rssi_dbm::double precision                                      as rssi,
               r.level_dbfs::double precision                                    as level,
               case when pg_catalog.jsonb_typeof(r.detail -> 'cfo_hz')   = 'number' then (r.detail ->> 'cfo_hz')::double precision   end as cfo,
               case when pg_catalog.jsonb_typeof(r.detail -> 'freq_mhz') = 'number' then (r.detail ->> 'freq_mhz')::double precision end as freq,
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

comment on function meganet.roll_up_receptions(integer) is
  'Rebuild reception_hourly for up to p_max_hours hours that new receptions touched (oldest first), and reception_daily for their days (0071, #241). Idempotent; never touches an hour past retain_reception_days. Returns hours, days, skipped, pending and the watermark. pg_cron hourly (meganet-roll-up-receptions); editors and the service key.';

revoke all on function meganet.roll_up_receptions(integer) from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;
  grant select on meganet.reception_hourly, meganet.reception_daily to authenticated, service_role;
  grant select, insert, update, delete on meganet.reception_rollup_dirty to service_role;
  grant execute on function meganet.roll_up_receptions(integer) to authenticated, service_role;
  notify pgrst, 'reload schema';
end
$$;

-- ── Hourly, where the server has pg_cron ─────────────────────────────────────
-- Minute 9, after meganet-roll-up at 7. As 0059, 0062 and 0070 schedule
-- theirs, and skipped the same way on CI's postgres:16. The backfill drains
-- 48 hours a run from here on, or faster by hand:
--   select meganet.roll_up_receptions(500);

do $$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron is not available on this server: nothing will run meganet.roll_up_receptions() on a schedule.';
    return;
  end if;
  begin
    create extension if not exists pg_cron;
    perform cron.schedule('meganet-roll-up-receptions', '9 * * * *', 'select meganet.roll_up_receptions()');
    raise notice 'meganet.roll_up_receptions() runs hourly at minute 9 (pg_cron job meganet-roll-up-receptions).';
  exception when others then
    raise warning 'pg_cron could not be set up (%): the reception rollups will not be built until it is.', sqlerrm;
  end;
end
$$;

-- ── Proof it took ────────────────────────────────────────────────────────────

do $$
begin
  if pg_catalog.to_regclass('meganet.reception_hourly') is null
     or pg_catalog.to_regclass('meganet.reception_daily') is null
     or pg_catalog.to_regclass('meganet.reception_rollup_dirty') is null
     or pg_catalog.to_regprocedure('meganet.roll_up_receptions(integer)') is null then
    raise exception '0071 did not take: a rollup table or roll_up_receptions() is missing';
  end if;
  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'meganet.reception_hourly'::regclass)
     or not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'meganet.reception_daily'::regclass)
     or not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'meganet.reception_rollup_dirty'::regclass) then
    raise exception '0071 did not take: RLS is off on a rollup table';
  end if;
  if (select pg_catalog.format_type(a.atttypid, a.atttypmod) from pg_catalog.pg_attribute a
       where a.attrelid = 'meganet.reception_daily'::regclass and a.attname = 'bucket') <> 'date' then
    raise exception '0071 did not take: reception_daily.bucket is not a date';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 71 in the same commit. The guard means
-- applying it out of order leaves the higher number.

insert into meganet.app_meta (key, value)
values ('schema_version', '71')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
