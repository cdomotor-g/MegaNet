-- 0074_archive_indexes.sql — Receptions and submissions found by time with a
-- btree, and the archive's counting done where it is cheap (#243).
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0074_archive_indexes.sql
--
-- Why this file exists
-- ────────────────────
-- The first archive run (2026-10-21) wrote 55 days of submissions and then
-- every call timed out (PostgREST's 8 s): one hour of `reading_raw` by
-- `received_at` took 3–7 s, one hour of `reception` by `heard_at` 11 s, and
-- archive_due() for receptions — a count of every row by day — 8 s.
--
-- **The cause is the BRIN indexes, and 0072 made it worse.** A BRIN index
-- (0006, 0047) is a few kilobytes because it trusts the table to be in time
-- order on disk: it keeps a min and max per 128 pages. 0072's backfill
-- rewrote every reception, and VACUUM then left the old versions as free
-- space all through the table; new receptions fill that space, so any range
-- of pages now holds rows from many days, and the index says "maybe" to
-- nearly all of it (an hour of receptions: 13,440 pages read for 4,216 rows).
-- `reading_raw` is the same, on a smaller scale. retain() deleting old days
-- would do the same to every table in time — the free space is at the start.
-- The Reception Map's window (reception_window(), by heard_at) pays it too.
--
-- Three changes.
--
-- **1. A btree on `reception (heard_at)` and `reading_raw (received_at)`.**
-- It finds an hour whatever the physical order. About 20 bytes a row — a few
-- MB for receptions at 90 days of October's traffic is tens of MB; it is the
-- price of a table that is deleted from. The BRIN indexes stay (kilobytes);
-- `reading`'s still work (0.4 s an hour), as nothing rewrites that table.
--
-- **2. archive_due() counts from the daily rollups** for readings and
-- receptions — reading_daily and reception_daily already hold every day's
-- count, exactly — and from the table only for submissions (30 days, with
-- the new index). A day whose rollup lags a late row is offered at the
-- rollup's count; the archiver reads more rows than that, says the day is
-- still changing, and takes it on a later run once the rollup has caught up.
-- archive_record() and retain() still count the rows themselves.
--
-- **3. retain() counts only the days it might release** — those in the
-- manifest, past the horizon, not yet released — one day at a time through
-- the new indexes, rather than every day of the table.

-- ── The indexes ──────────────────────────────────────────────────────────────

create index if not exists reception_heard_idx on meganet.reception (heard_at);
create index if not exists reading_raw_received_idx on meganet.reading_raw (received_at);

-- ── Counting by day, from the rollups where they hold it ─────────────────────

create or replace function meganet.archive_day_counts_fast(p_table text, p_before date)
returns table (day date, rows bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  case p_table
    when 'reading' then
      return query select h.bucket, pg_catalog.sum(h.n)::bigint
        from meganet.reading_daily h where h.bucket < p_before group by 1;
    when 'reception' then
      return query select h.bucket, pg_catalog.sum(h.n)::bigint
        from meganet.reception_daily h where h.bucket < p_before group by 1;
    when 'reading_raw' then
      return query select (r.received_at at time zone 'UTC')::date, pg_catalog.count(*)
        from meganet.reading_raw r where r.received_at < (p_before::timestamp at time zone 'UTC') group by 1;
    else
      raise exception 'not a table the archive keeps: %', p_table using errcode = '22023';
  end case;
end;
$$;

comment on function meganet.archive_day_counts_fast(text, date) is
  'Rows a day for each UTC day before p_before (0074): readings and receptions from their daily rollups, which hold every day''s count; submissions from the table. What archive_due() asks; archive_record() and retain() count the rows themselves.';

revoke all on function meganet.archive_day_counts_fast(text, date) from public;

-- ── archive_due() and retain(), restated from 0073 with only the counting changed

create or replace function meganet.archive_due(p_table text, p_limit integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_before date := ((pg_catalog.now() at time zone 'UTC')::date) - 1;
begin
  if not meganet.is_editor() then
    raise exception 'the archive is the service key''s' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'day', c.day, 'rows', c.rows, 'version', coalesce(m.version, 0) + 1) order by c.day)
      from (select * from meganet.archive_day_counts_fast(p_table, v_before)) c
      left join lateral (
        select a.version, a.rows, a.released_at from meganet.archive_day a
         where a.table_name = p_table and a.day = c.day
         order by a.version desc limit 1) m on true
     where (m.version is null or m.rows <> c.rows)
       and not exists (select 1 from meganet.archive_day a
                        where a.table_name = p_table and a.day = c.day and a.released_at is not null)
     limit greatest(coalesce(p_limit, 30), 0)), '[]'::jsonb);
end;
$$;

comment on function meganet.archive_due(text, integer) is
  'The UTC days of a table (reading, reading_raw, reception) the archive should write next (0073): two or more days old, not in archive_day at their current row count, not already being released; oldest first, at most p_limit. [{day, rows, version}]. The service key.';


create or replace function meganet.retain(p_max_rows integer default 200000)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today   date := (pg_catalog.now() at time zone 'UTC')::date;
  v_days    jsonb := '{}'::jsonb;
  v_rolled  jsonb;
  v_rx      jsonb;
  v_out     jsonb := '{}'::jsonb;
  t         text;
  v_keep    integer;
  v_horizon date;
  v_left    integer;
  v_n       integer;
  v_del     integer;
  v_rel     integer;
  d         record;
begin
  if not meganet.is_editor() then
    raise exception 'not authorised to age out readings' using errcode = '42501';
  end if;

  -- Roll up first. Always.
  v_rolled := meganet.roll_up();
  v_rx     := meganet.roll_up_receptions(500);

  foreach t in array array['reading', 'reading_raw', 'reception'] loop
    v_keep := coalesce((select a.value::integer from meganet.app_meta a
                         where a.key = case t when 'reading' then 'retain_reading_days'
                                              when 'reading_raw' then 'retain_reading_raw_days'
                                              else 'retain_reception_days' end),
                       case t when 'reading' then 730 when 'reading_raw' then 30 else 90 end);
    v_horizon := v_today - v_keep;
    v_left := greatest(coalesce(p_max_rows, 200000), 0);
    v_del := 0;
    v_rel := 0;

    -- Release the days that are cleared: past the horizon, archived at their
    -- count, and rolled up to it.
    for d in
      select c.day, c.rows
        from (select m0.day, meganet.archive_day_count(t, m0.day) as rows
                from (select distinct a.day from meganet.archive_day a
                       where a.table_name = t and a.day < v_horizon and a.released_at is null) m0) c
        join lateral (select a.* from meganet.archive_day a
                       where a.table_name = t and a.day = c.day
                       order by a.version desc limit 1) m on true
       where m.released_at is null
         and m.rows = c.rows
         and (t = 'reading_raw'
              or (t = 'reading' and coalesce((select pg_catalog.sum(h.n) from meganet.reading_daily h where h.bucket = c.day), 0) = c.rows)
              or (t = 'reception' and coalesce((select pg_catalog.sum(h.n) from meganet.reception_daily h where h.bucket = c.day), 0) = c.rows))
       order by c.day
    loop
      update meganet.archive_day a set released_at = pg_catalog.now()
       where a.table_name = t and a.day = d.day
         and a.version = (select pg_catalog.max(b.version) from meganet.archive_day b where b.table_name = t and b.day = d.day);
      v_rel := v_rel + 1;
    end loop;

    -- Delete from released days only, capped.
    for d in
      select distinct a.day from meganet.archive_day a
       where a.table_name = t and a.released_at is not null and a.day < v_horizon
       order by a.day
    loop
      exit when v_left <= 0;
      if t = 'reading' then
        with doomed as (
          select r.ctid from meganet.reading r
           where r.reading_ts >= (d.day::timestamp at time zone 'UTC')
             and r.reading_ts <  ((d.day + 1)::timestamp at time zone 'UTC')
           limit v_left)
        delete from meganet.reading r using doomed x where r.ctid = x.ctid;
      elsif t = 'reading_raw' then
        with doomed as (
          select r.id from meganet.reading_raw r
           where r.received_at >= (d.day::timestamp at time zone 'UTC')
             and r.received_at <  ((d.day + 1)::timestamp at time zone 'UTC')
           limit v_left)
        delete from meganet.reading_raw r using doomed x where r.id = x.id;
      else
        with doomed as (
          select r.id from meganet.reception r
           where r.heard_at >= (d.day::timestamp at time zone 'UTC')
             and r.heard_at <  ((d.day + 1)::timestamp at time zone 'UTC')
           limit v_left)
        delete from meganet.reception r using doomed x where r.id = x.id;
      end if;
      get diagnostics v_n = row_count;
      v_del := v_del + v_n;
      v_left := v_left - v_n;
    end loop;

    v_out := v_out || pg_catalog.jsonb_build_object(t, pg_catalog.jsonb_build_object(
               'keep_days', v_keep, 'horizon', v_horizon, 'released_days', v_rel, 'deleted', v_del));
  end loop;

  return pg_catalog.jsonb_build_object(
    'rolled', v_rolled, 'rolled_receptions', v_rx, 'tables', v_out,
    'more', exists (
      select 1 from meganet.archive_day a where a.released_at is not null
         and ((a.table_name = 'reading' and exists (select 1 from meganet.reading r
                where r.reading_ts >= (a.day::timestamp at time zone 'UTC') and r.reading_ts < ((a.day + 1)::timestamp at time zone 'UTC')))
           or (a.table_name = 'reading_raw' and exists (select 1 from meganet.reading_raw r
                where r.received_at >= (a.day::timestamp at time zone 'UTC') and r.received_at < ((a.day + 1)::timestamp at time zone 'UTC')))
           or (a.table_name = 'reception' and exists (select 1 from meganet.reception r
                where r.heard_at >= (a.day::timestamp at time zone 'UTC') and r.heard_at < ((a.day + 1)::timestamp at time zone 'UTC'))))));
end;
$$;

comment on function meganet.retain(integer) is
  'Roll up (readings and receptions), then delete — only days that are past their table''s horizon (retain_reading_days 730, retain_reading_raw_days 30, retain_reception_days 90), archived to R2 at exactly their row count now, and rolled up to it (0073, #243). At most p_max_rows a table a run; a released day is finished by the next. pg_cron daily (meganet-retain).';


-- ── Proof it took ────────────────────────────────────────────────────────────

do $$
begin
  if pg_catalog.to_regclass('meganet.reception_heard_idx') is null
     or pg_catalog.to_regclass('meganet.reading_raw_received_idx') is null then
    raise exception '0074 did not take: an index is missing';
  end if;
  if pg_catalog.strpos(pg_catalog.pg_get_functiondef('meganet.archive_due(text, integer)'::regprocedure), 'archive_day_counts_fast') = 0
     or pg_catalog.strpos(pg_catalog.pg_get_functiondef('meganet.retain(integer)'::regprocedure), 'archive_day_count(t, m0.day)') = 0 then
    raise exception '0074 did not take: archive_due() or retain() is still 0073''s';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────

insert into meganet.app_meta (key, value)
values ('schema_version', '74')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
