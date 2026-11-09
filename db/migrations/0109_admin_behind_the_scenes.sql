-- 0109_admin_behind_the_scenes.sql — The Admin tab's "Behind the scenes":
-- data flow, base stations and their receivers, what is waiting on an
-- administrator, the scheduled jobs, and how fast the database is growing —
-- in one cheap call.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0109_admin_behind_the_scenes.sql
--
-- Why this file exists
-- ────────────────────
-- The owner kept a separate dashboard (a claude.ai page) beside the Admin tab
-- and asked for one place to look. Half of it the Admin tab already had
-- (database size, connections, visitors, tables); the rest is here.
--
-- That page also cost the database more than it showed. It asked
-- meganet.reception for the last 24 hours by received_at, which has no index
-- (0074 indexed heard_at), so every open read the whole table — 0.4 GB — four
-- times over, for numbers the rollups already hold. Everything below is a
-- bounded read on an index, a rollup or a table of a few rows:
--
--   flow       the last packet heard (reception_heard_idx, backwards, one
--              row), the last reading stored (reading_received_idx, one row),
--              readings in 24 hours (reading_received_idx, index only), and
--              receptions in the 24 rolled-up hours (reception_hourly_key).
--   days       receptions a UTC day for 30 days, from reception_daily.
--   stations   each base station with base_station_state() — the Base
--              Stations tab's one definition — and its receivers from
--              health_receiver (0059).
--   waiting    token requests pending (0048), health findings open by
--              severity (0059), push subscriptions failing (0066).
--   jobs       each pg_cron job, its runs in 7 days and its last failure —
--              cron.job_run_details is a few MB; where the server has no
--              pg_cron (CI) the list is empty and `cron` false.
--   growth     how fast the database grows, measured: today's size against a
--              snapshot from up to a week ago (meganet.db_size_day, below),
--              and the tables that grew most. The other page multiplied a
--              day's new rows by each table's row size, which no longer means
--              much since 0108: reception deletes a day for each day it adds,
--              and the space is reused, not grown.
--
-- meganet.db_size_day keeps one row a day, written by pg_cron
-- (meganet-size-snapshot, 15:41 UTC, after meganet-retain) and once by this
-- file, so the first growth figure is a day away. 400 days kept.
--
-- What the database cannot see stays off: the Supabase API gateway's error
-- counts and its security and performance advisors (Supabase's Management
-- API), and Cloudflare's Workers and R2 buckets (Cloudflare's API). Each needs
-- an account token that nothing here holds.
--
-- Depends on 0042 (admin_require), 0048, 0049 (base_station), 0059
-- (health_receiver, health_finding, base_station_state), 0066, 0071
-- (reception_hourly, reception_daily), 0074 (reception_heard_idx), 0106
-- (reading_received_idx). tools/check_admin_dashboard.sql proves it.

-- ── A day's size ─────────────────────────────────────────────────────────────

create table if not exists meganet.db_size_day (
  day       date         primary key,
  db_bytes  bigint       not null,
  -- Every table of 1 MB or more, as {"schema.table": bytes with its indexes
  -- and TOAST}. Smaller ones cannot move the growth figure.
  tables    jsonb        not null default '{}'::jsonb,
  taken_at  timestamptz  not null default now()
);

comment on table meganet.db_size_day is
  'The database''s size once a UTC day, and each table of 1 MB or more (0109): what admin_ops() measures growth from. Written by snapshot_db_size() (pg_cron meganet-size-snapshot). 400 days kept. RLS on, no policy and no grant: administrators read it through admin_ops().';

alter table meganet.db_size_day enable row level security;

create or replace function meganet.snapshot_db_size()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  insert into meganet.db_size_day (day, db_bytes, tables, taken_at)
  select (pg_catalog.now() at time zone 'UTC')::date,
         pg_catalog.pg_database_size(pg_catalog.current_database()),
         coalesce((select pg_catalog.jsonb_object_agg(n.nspname || '.' || c.relname, pg_catalog.pg_total_relation_size(c.oid))
                     from pg_catalog.pg_class c
                     join pg_catalog.pg_namespace n on n.oid = c.relnamespace
                    where c.relkind in ('r', 'p', 'm')
                      and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
                      and pg_catalog.pg_total_relation_size(c.oid) >= 1048576), '{}'::jsonb),
         pg_catalog.now()
  on conflict (day) do update
    set db_bytes = excluded.db_bytes, tables = excluded.tables, taken_at = excluded.taken_at;

  delete from meganet.db_size_day d where d.day < (pg_catalog.now() at time zone 'UTC')::date - 400;
end;
$$;

comment on function meganet.snapshot_db_size() is
  'Record today''s database size and each table of 1 MB or more in db_size_day, replacing today''s row; delete rows past 400 days (0109). pg_cron daily (meganet-size-snapshot). Internal: no grant.';

-- ── The call ─────────────────────────────────────────────────────────────────

create or replace function meganet.admin_ops()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now      timestamptz := pg_catalog.now();
  v_today    date        := (pg_catalog.now() at time zone 'UTC')::date;
  -- The 24 hours the rollup has finished: meganet-roll-up-receptions runs at
  -- nine past, so before a quarter past the hour just gone is not in yet.
  v_to       timestamptz := pg_catalog.date_trunc('hour', pg_catalog.now())
                            - case when extract(minute from pg_catalog.now()) < 15 then interval '1 hour' else interval '0' end;
  v_db       bigint      := pg_catalog.pg_database_size(pg_catalog.current_database());
  v_flow     jsonb;
  v_days     jsonb;
  v_stations jsonb;
  v_waiting  jsonb;
  v_jobs     jsonb := '[]'::jsonb;
  v_cron     boolean := false;
  v_then     meganet.db_size_day;
  v_growth   jsonb;
  v_span     double precision;
begin
  perform meganet.admin_require();

  -- ── Data flowing in ──
  select pg_catalog.jsonb_build_object(
           'last_heard_at',   (select r.heard_at from meganet.reception r
                                where r.heard_at <= v_now + interval '5 minutes'
                                order by r.heard_at desc limit 1),
           'last_reading_at', (select r.received_at from meganet.reading r
                                order by r.received_at desc limit 1),
           'readings_24h',    (select pg_catalog.count(*) from meganet.reading r
                                where r.received_at > v_now - interval '24 hours'),
           'receptions_24h',  coalesce(h.n, 0),
           'ok_24h',          coalesce(h.n_ok, 0),
           'rolled_to',       v_to)
    into v_flow
    from (select pg_catalog.sum(x.n)::bigint as n, pg_catalog.sum(x.n_ok)::bigint as n_ok
            from meganet.reception_hourly x
           where x.bucket >= v_to - interval '24 hours' and x.bucket < v_to) h;

  -- ── Receptions a day, 30 UTC days, gaps included ──
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'day', pg_catalog.to_char(g.day, 'YYYY-MM-DD'),
           'n',   coalesce(d.n, 0),
           'ok',  coalesce(d.n_ok, 0)) order by g.day)
    into v_days
    from pg_catalog.generate_series(v_today - 29, v_today, interval '1 day') as g(day)
    left join (select x.bucket, pg_catalog.sum(x.n)::bigint as n, pg_catalog.sum(x.n_ok)::bigint as n_ok
                 from meganet.reception_daily x
                where x.bucket >= v_today - 29
                group by x.bucket) d on d.bucket = g.day::date;

  -- ── Base stations and their receivers ──
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id',           b.ingest_token_id,
           'label',        coalesce(nullif(pg_catalog.btrim(t.label), ''), 'Ingest point ' || b.ingest_token_id),
           'state',        meganet.base_station_state(b.mode, b.idle_s, b.last_seen_at, v_now),
           'last_seen_at', b.last_seen_at,
           'receivers',    coalesce((
             select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                      'name',       coalesce(nullif(pg_catalog.btrim(hr.name), ''), hr.rx_key),
                      'kind',       hr.kind,
                      'state',      hr.state,
                      'decoded',    hr.decoded,
                      'changed_at', hr.changed_at,
                      'seen_at',    hr.seen_at) order by hr.name, hr.rx_key)
               from meganet.health_receiver hr
              where hr.ingest_token_id = b.ingest_token_id), '[]'::jsonb))
           order by b.last_seen_at desc), '[]'::jsonb)
    into v_stations
    from meganet.base_station b
    join meganet.ingest_token t on t.id = b.ingest_token_id
   where t.revoked_at is null;

  -- ── Waiting on an administrator ──
  select pg_catalog.jsonb_build_object(
           'token_requests',    (select pg_catalog.count(*) from meganet.ingest_token_request q
                                  where q.status = 'pending' and q.expires_at > v_now),
           'findings_critical', (select pg_catalog.count(*) from meganet.health_finding f
                                  where f.cleared_at is null and f.severity = 'critical'),
           'findings_warn',     (select pg_catalog.count(*) from meganet.health_finding f
                                  where f.cleared_at is null and f.severity = 'warn'),
           'findings_info',     (select pg_catalog.count(*) from meganet.health_finding f
                                  where f.cleared_at is null and f.severity = 'info'),
           'push_failing',      (select pg_catalog.count(*) from meganet.push_subscription p
                                  where p.failures > 0))
    into v_waiting;

  -- ── Scheduled jobs, where the server has pg_cron ──
  if exists (select 1 from pg_catalog.pg_namespace n where n.nspname = 'cron')
     and pg_catalog.to_regclass('cron.job') is not null
     and pg_catalog.to_regclass('cron.job_run_details') is not null then
    v_cron := true;
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'name',          j.jobname,
             'schedule',      j.schedule,
             'active',        j.active,
             'ok_7d',         coalesce(r.ok, 0),
             'failed_7d',     coalesce(r.failed, 0),
             'failed_24h',    coalesce(r.failed_24h, 0),
             'last_at',       r.last_at,
             'last_status',   r.last_status,
             'last_error',    r.last_error,
             'last_error_at', r.last_error_at) order by j.jobname), '[]'::jsonb)
      into v_jobs
      from cron.job j
      left join (select x.jobid,
                        pg_catalog.count(*) filter (where x.status = 'succeeded') as ok,
                        pg_catalog.count(*) filter (where x.status = 'failed') as failed,
                        pg_catalog.count(*) filter (where x.status = 'failed' and x.start_time > v_now - interval '24 hours') as failed_24h,
                        pg_catalog.max(x.start_time) as last_at,
                        (pg_catalog.array_agg(x.status order by x.start_time desc))[1] as last_status,
                        (pg_catalog.array_agg(pg_catalog.left(x.return_message, 300) order by x.start_time desc)
                           filter (where x.status = 'failed'))[1] as last_error,
                        pg_catalog.max(x.start_time) filter (where x.status = 'failed') as last_error_at
                   from cron.job_run_details x
                  where x.start_time > v_now - interval '7 days'
                  group by x.jobid) r on r.jobid = j.jobid;
  end if;

  -- ── Growth, measured ──
  -- The oldest snapshot from the last eight days that is at least 20 hours
  -- old: a week's change where there is one, a day's at the start.
  select * into v_then
    from meganet.db_size_day d
   where d.day >= v_today - 8 and d.taken_at <= v_now - interval '20 hours'
   order by d.day
   limit 1;

  if v_then.day is null then
    v_growth := pg_catalog.jsonb_build_object(
      'measured',   false,
      'db_bytes',   v_db,
      'first_day',  (select pg_catalog.min(d.day) from meganet.db_size_day d));
  else
    v_span := extract(epoch from v_now - v_then.taken_at) / 86400.0;
    v_growth := pg_catalog.jsonb_build_object(
      'measured',  true,
      'since',     v_then.taken_at,
      'days',      pg_catalog.round(v_span::numeric, 1),
      'db_bytes',  v_db,
      'then_bytes', v_then.db_bytes,
      'per_day',   pg_catalog.round((v_db - v_then.db_bytes) / v_span),
      'tables',    coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                 'name', g.name, 'bytes', g.bytes, 'per_day', g.per_day) order by g.per_day desc)
          from (select n.nspname || '.' || c.relname as name,
                       pg_catalog.pg_total_relation_size(c.oid) as bytes,
                       pg_catalog.round((pg_catalog.pg_total_relation_size(c.oid)
                         - coalesce((v_then.tables ->> (n.nspname || '.' || c.relname))::bigint, 0)) / v_span) as per_day
                  from pg_catalog.pg_class c
                  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
                 where c.relkind in ('r', 'p', 'm')
                   and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
                   and pg_catalog.pg_total_relation_size(c.oid) >= 1048576
                 order by 3 desc
                 limit 8) g
         where g.per_day > 0), '[]'::jsonb));
  end if;

  return pg_catalog.jsonb_build_object(
    'at',       v_now,
    'flow',     v_flow,
    'days',     coalesce(v_days, '[]'::jsonb),
    'stations', v_stations,
    'waiting',  v_waiting,
    'cron',     v_cron,
    'jobs',     v_jobs,
    'growth',   v_growth);
end;
$$;

comment on function meganet.admin_ops() is
  'The Admin tab''s Behind the scenes (0109): data flow, receptions a day for 30 days, base stations and their receivers, what is waiting on an administrator, the pg_cron jobs, and measured growth — bounded reads on indexes and rollups only. Administrators only.';

-- ── Who may run what ─────────────────────────────────────────────────────────

revoke all on function meganet.snapshot_db_size() from public;
revoke all on function meganet.admin_ops()        from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  grant execute on function meganet.admin_ops() to authenticated, service_role;

  notify pgrst, 'reload schema';
end
$$;

-- ── The first snapshot, and one a day after it ───────────────────────────────

do $$
begin
  perform meganet.snapshot_db_size();
end
$$;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron is not available on this server: nothing will snapshot the database size on a schedule.';
    return;
  end if;
  begin
    create extension if not exists pg_cron;
    perform cron.schedule('meganet-size-snapshot', '41 15 * * *', 'select meganet.snapshot_db_size()');
    raise notice 'meganet.snapshot_db_size() runs daily at 15:41 UTC, 01:41 Brisbane (pg_cron job meganet-size-snapshot).';
  exception when others then
    raise warning 'pg_cron could not be set up (%): the growth figure will not move until it is.', sqlerrm;
  end;
end
$$;

-- ── Did it take ──────────────────────────────────────────────────────────────

do $$
begin
  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'meganet.db_size_day'::regclass) then
    raise exception '0109 did not take: db_size_day has RLS off';
  end if;
  if not exists (select 1 from meganet.db_size_day d where d.day = (pg_catalog.now() at time zone 'UTC')::date) then
    raise exception '0109 did not take: no snapshot for today';
  end if;
  if pg_catalog.has_function_privilege('public', 'meganet.admin_ops()', 'execute') then
    raise exception '0109 did not take: public may run admin_ops()';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 109 once this is applied. The guard means
-- applying it out of order leaves the higher number.

insert into meganet.app_meta (key, value)
values ('schema_version', '109')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
