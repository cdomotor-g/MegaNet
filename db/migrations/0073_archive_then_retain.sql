-- 0073_archive_then_retain.sql — Every row archived to R2 before anything is
-- deleted, and then retain() on a schedule (#243).
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0073_archive_then_retain.sql
--
-- Why this file exists
-- ────────────────────
-- EPIC #240's regime, as the owner agreed it on 2026-10-21: keep everything,
-- tiered by age. Readings 730 days in the database (0070), receptions 90,
-- submissions 30; the rollups of both forever (0006, 0071); and **every raw
-- row forever in R2** — with one rule over all of it: *nothing leaves the
-- database that has not been both rolled up and archived.* Until this file
-- retain() had never run (0006 left it to be run by hand), so nothing had
-- been deleted, and nothing could be safely.
--
-- The archive is written from outside the database — a GitHub Action
-- (`.github/workflows/archive-r2.yml`, `tools/archive/archive-to-r2.mjs`)
-- reads a UTC day an hour at a time through archive_rows(), gzips it as
-- NDJSON and puts it through the Worker's /api/archive route
-- (worker/archive.js) into the `meganet-archive` bucket. It reads the object
-- back, and only then calls archive_record(), which writes the manifest. The
-- database's part is the manifest and the rule.
--
-- Five decisions.
--
-- **1. A day is the unit, and its clock is the one retain() deletes by.**
-- `reading` by `reading_ts`, `reading_raw` by `received_at`, `reception` by
-- `heard_at` — each a BRIN range — in UTC days, as the daily rollups are.
-- One object per table per day per version:
-- `<table>/<yyyy>/<mm>/<dd>.v<n>.ndjson.gz`.
--
-- **2. The manifest counts, and the count must still be true.**
-- archive_record() refuses a day whose row count is not the database's now.
-- A row that arrives after its day was archived — the Pi's queue, a late
-- batch (ingest accepts readings 90 days old) — makes the count wrong again,
-- archive_due() offers the day again, and it is written again as the next
-- version. Objects are create-only; an old version is never overwritten.
--
-- **3. retain() deletes a day only when it is *cleared*:** past its table's
-- horizon, archived at exactly the count it has now, and — for readings and
-- receptions — rolled up to exactly that count too (the daily rollup's `n`
-- for that day equals the rows). A cleared day is marked `released_at` before
-- its first row goes, so a day deleted across two runs (retain()'s cap) is
-- finished by the next one rather than looking like a changed count. Nothing
-- else is ever deleted, whatever its age.
--
-- **4. retain() rolls up first, as 0006 has it**, and now the receptions too
-- (roll_up_receptions(), 0071).
--
-- **5. On pg_cron daily at 15:17 UTC (01:17 Brisbane)**, as 0006 planned —
-- after the archive Action at 14:37 UTC. It is safe to schedule before the
-- first archive has run: with an empty manifest it deletes nothing.

-- ── The knobs ────────────────────────────────────────────────────────────────

insert into meganet.app_meta (key, value) values ('retain_reception_days', '90')
on conflict (key) do nothing;

-- ── The manifest ─────────────────────────────────────────────────────────────

create table if not exists meganet.archive_day (
  table_name  text        not null check (table_name in ('reading', 'reading_raw', 'reception')),
  day         date        not null,
  version     integer     not null check (version >= 1),
  rows        bigint      not null check (rows >= 0),
  bytes       bigint      not null check (bytes > 0),
  sha256      text        not null check (sha256 ~ '^[0-9a-f]{64}$'),
  object_key  text        not null,
  archived_at timestamptz not null default now(),
  released_at timestamptz,
  primary key (table_name, day, version)
);

comment on table meganet.archive_day is
  'Every UTC day of reading, reading_raw and reception archived to R2 (0073, #243): its object (create-only, <table>/<yyyy>/<mm>/<dd>.v<n>.ndjson.gz in the meganet-archive bucket), the rows it holds, its size and SHA-256 — and when retain() began deleting that day from the database (released_at). Written only by archive_record(), after the object was read back. Editors read it.';

alter table meganet.archive_day enable row level security;
do $$
begin
  if not exists (select 1 from pg_catalog.pg_policy
                  where polrelid = 'meganet.archive_day'::regclass and polname = 'archive_day_read_editors') then
    create policy archive_day_read_editors on meganet.archive_day
      for select to authenticated using (meganet.is_editor());
  end if;
end
$$;

-- ── How many rows a table holds for each UTC day ─────────────────────────────

create or replace function meganet.archive_day_counts(p_table text, p_before date)
returns table (day date, rows bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  case p_table
    when 'reading' then
      return query select (r.reading_ts at time zone 'UTC')::date, pg_catalog.count(*)
        from meganet.reading r where r.reading_ts < (p_before::timestamp at time zone 'UTC') group by 1;
    when 'reading_raw' then
      return query select (r.received_at at time zone 'UTC')::date, pg_catalog.count(*)
        from meganet.reading_raw r where r.received_at < (p_before::timestamp at time zone 'UTC') group by 1;
    when 'reception' then
      return query select (r.heard_at at time zone 'UTC')::date, pg_catalog.count(*)
        from meganet.reception r where r.heard_at < (p_before::timestamp at time zone 'UTC') group by 1;
    else
      raise exception 'not a table the archive keeps: %', p_table using errcode = '22023';
  end case;
end;
$$;

create or replace function meganet.archive_day_count(p_table text, p_day date)
returns bigint
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from timestamptz := p_day::timestamp at time zone 'UTC';
  v_to   timestamptz := (p_day + 1)::timestamp at time zone 'UTC';
  v      bigint;
begin
  case p_table
    when 'reading'     then select pg_catalog.count(*) into v from meganet.reading r     where r.reading_ts  >= v_from and r.reading_ts  < v_to;
    when 'reading_raw' then select pg_catalog.count(*) into v from meganet.reading_raw r where r.received_at >= v_from and r.received_at < v_to;
    when 'reception'   then select pg_catalog.count(*) into v from meganet.reception r   where r.heard_at    >= v_from and r.heard_at    < v_to;
    else raise exception 'not a table the archive keeps: %', p_table using errcode = '22023';
  end case;
  return v;
end;
$$;

-- ── What the archive should write next ───────────────────────────────────────
-- Days two or more UTC days old whose rows are not in the archive at their
-- count now, oldest first. A day retain() has begun deleting is not offered.

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
      from (select * from meganet.archive_day_counts(p_table, v_before)) c
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

-- ── One hour of one day, as rows ─────────────────────────────────────────────
-- Every column as stored (to_jsonb of the row), so an archived row loads back
-- with jsonb_populate_record. In a stable order, so a day written twice is the
-- same bytes if nothing changed.

create or replace function meganet.archive_rows(p_table text, p_day date, p_hour integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from timestamptz;
  v_to   timestamptz;
  v      jsonb;
begin
  if not meganet.is_editor() then
    raise exception 'the archive is the service key''s' using errcode = '42501';
  end if;
  if p_hour is null or p_hour < 0 or p_hour > 23 then
    raise exception 'an hour is 0 to 23' using errcode = '22023';
  end if;
  v_from := (p_day::timestamp at time zone 'UTC') + p_hour * interval '1 hour';
  v_to   := v_from + interval '1 hour';
  case p_table
    when 'reading' then
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) order by r.reading_ts, r.addr, r.value_raw) into v
        from meganet.reading r where r.reading_ts >= v_from and r.reading_ts < v_to;
    when 'reading_raw' then
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) order by r.id) into v
        from meganet.reading_raw r where r.received_at >= v_from and r.received_at < v_to;
    when 'reception' then
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) order by r.id) into v
        from meganet.reception r where r.heard_at >= v_from and r.heard_at < v_to;
    else
      raise exception 'not a table the archive keeps: %', p_table using errcode = '22023';
  end case;
  return coalesce(v, '[]'::jsonb);
end;
$$;

comment on function meganet.archive_rows(text, date, integer) is
  'One UTC hour of one day of a table, every column as stored, in a stable order (0073) — what the archive writes, a line a row. The service key.';

-- ── The manifest, written once the object is in R2 ───────────────────────────

create or replace function meganet.archive_record(p_table text, p_day date, p_version integer,
                                                  p_rows bigint, p_bytes bigint, p_sha256 text, p_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now  bigint;
  v_last integer;
begin
  if not meganet.is_editor() then
    raise exception 'the archive is the service key''s' using errcode = '42501';
  end if;
  v_now := meganet.archive_day_count(p_table, p_day);
  if v_now <> p_rows then
    raise exception '% on % holds % rows now, not the % archived — archive it again', p_table, p_day, v_now, p_rows
      using errcode = '40001';
  end if;
  select pg_catalog.max(a.version) into v_last from meganet.archive_day a
   where a.table_name = p_table and a.day = p_day;
  -- Later than every version recorded. Not necessarily the next: a version
  -- whose object was written but never recorded is stepped over, not reused.
  if p_version <= coalesce(v_last, 0) then
    raise exception 'version % of % on % is not after the last recorded (%)', p_version, p_table, p_day, v_last
      using errcode = '22023';
  end if;
  if p_key <> pg_catalog.format('%s/%s.v%s.ndjson.gz', p_table, pg_catalog.to_char(p_day, 'YYYY/MM/DD'), p_version) then
    raise exception 'the object key % is not this day''s', p_key using errcode = '22023';
  end if;
  insert into meganet.archive_day (table_name, day, version, rows, bytes, sha256, object_key)
  values (p_table, p_day, p_version, p_rows, p_bytes, pg_catalog.lower(p_sha256), p_key);
  return pg_catalog.jsonb_build_object('table', p_table, 'day', p_day, 'version', p_version, 'rows', p_rows);
end;
$$;

comment on function meganet.archive_record(text, date, integer, bigint, bigint, text, text) is
  'Records one archived day (0073), after the object was read back: refuses a count that is not the day''s now (40001 — archive it again), a version not after the last recorded, or a key that is not the day''s. The service key.';

-- ── retain(), with the rule ──────────────────────────────────────────────────

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
        from meganet.archive_day_counts(t, v_horizon) c
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

revoke all on function meganet.archive_day_counts(text, date) from public;
revoke all on function meganet.archive_day_count(text, date) from public;
revoke all on function meganet.archive_due(text, integer) from public;
revoke all on function meganet.archive_rows(text, date, integer) from public;
revoke all on function meganet.archive_record(text, date, integer, bigint, bigint, text, text) from public;
revoke all on function meganet.retain(integer) from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;
  grant select on meganet.archive_day to authenticated, service_role;
  grant execute on function meganet.archive_due(text, integer) to service_role;
  grant execute on function meganet.archive_rows(text, date, integer) to service_role;
  grant execute on function meganet.archive_record(text, date, integer, bigint, bigint, text, text) to service_role;
  grant execute on function meganet.retain(integer) to authenticated, service_role;
  notify pgrst, 'reload schema';
end
$$;

-- ── Daily, where the server has pg_cron ──────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron is not available on this server: nothing will run meganet.retain() on a schedule.';
    return;
  end if;
  begin
    create extension if not exists pg_cron;
    perform cron.schedule('meganet-retain', '17 15 * * *', 'select meganet.retain()');
    raise notice 'meganet.retain() runs daily at 15:17 UTC, 01:17 Brisbane (pg_cron job meganet-retain).';
  exception when others then
    raise warning 'pg_cron could not be set up (%): nothing will age out until it is.', sqlerrm;
  end;
end
$$;

-- ── Proof it took ────────────────────────────────────────────────────────────

do $$
begin
  if pg_catalog.to_regclass('meganet.archive_day') is null
     or pg_catalog.to_regprocedure('meganet.archive_record(text, date, integer, bigint, bigint, text, text)') is null
     or pg_catalog.to_regprocedure('meganet.archive_due(text, integer)') is null
     or pg_catalog.to_regprocedure('meganet.archive_rows(text, date, integer)') is null then
    raise exception '0073 did not take: the manifest or a function is missing';
  end if;
  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'meganet.archive_day'::regclass) then
    raise exception '0073 did not take: RLS is off on archive_day';
  end if;
  if pg_catalog.strpos(pg_catalog.pg_get_functiondef('meganet.retain(integer)'::regprocedure), 'archive_day') = 0 then
    raise exception '0073 did not take: retain() does not consult the archive';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 73 when this is applied. The guard means
-- applying it out of order leaves the higher number.

insert into meganet.app_meta (key, value)
values ('schema_version', '73')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
