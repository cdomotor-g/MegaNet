-- 0043_admin_dashboard.sql — The Admin tab's dashboard: how the database is,
-- where its bytes are, who has been here and when, without opening Supabase or
-- Cloudflare.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0043_admin_dashboard.sql
--
-- ── What this adds ─────────────────────────────────────────────────────────────
--
--   1. meganet.app_visit — one row per browser per day: how many times the app
--      was opened or a tab switched to, which tabs, phone/tablet/desktop, and
--      whether that browser was signed in. The only way to count people who
--      never sign in: Cloudflare Access lets them in and the database never
--      otherwise sees them.
--   2. meganet.log_visit(visitor, tab, device) — the one writer, callable by
--      anon and authenticated. What it stores is deliberately thin (below).
--   3. meganet.admin_dashboard() — one jsonb answer for the dashboard:
--      database health, every schema's and table's size and row count, the
--      storage buckets, sessions, visits, and API calls by role. Administrators
--      only, like the rest of 0042's admin_* functions.
--   4. meganet.admin_users() (0042) restated with last_seen_at, active
--      sessions, the latest session's browser, and visits in the last 30 days.
--
-- ── What a visit records, and what it does not ────────────────────────────────
--
-- The visitor is a random id the browser makes for itself and keeps in
-- localStorage (admin.js) — not a fingerprint, not an IP address, not a cookie
-- anything else reads. Clearing the browser's storage makes a new visitor. A
-- signed-in visit also records the user id, which is who the dashboard's "last
-- seen" is about; an anonymous one records nothing that names anybody. Rows
-- older than 400 days are deleted as new ones arrive.
--
-- **This is an anonymous write, and it is bounded rather than trusted.** The
-- publishable key is public, so anybody can call log_visit(). What it can do is
-- add at most one row per (day, id), refuse any tab name that is not a short
-- slug, keep at most 40 tabs per row, and stop adding rows once a day has
-- 5,000 of them. The worst a script can do is make one day's numbers
-- meaningless, which the dashboard would show as a spike.
--
-- ── Why pg_stat_statements for "access stats" ─────────────────────────────────
--
-- Every request the Data API serves runs as anon, authenticated or
-- service_role, and pg_stat_statements (installed on every Supabase project)
-- counts statements per role since its last reset. That is the closest the
-- database can get to Cloudflare's request counts, and it separates anonymous
-- reads, signed-in work and the syncs without any logging of our own. Read
-- through dynamic SQL so a database without the extension (CI's) answers null.


-- ── 1. Visits ────────────────────────────────────────────────────────────────

create table if not exists meganet.app_visit (
  day        date        not null default current_date,
  visitor    uuid        not null,
  signed_in  boolean     not null default false,
  user_id    uuid,
  device     text        check (device is null or device in ('phone', 'tablet', 'desktop')),
  hits       integer     not null default 1,
  tabs       text[]      not null default '{}',
  first_at   timestamptz not null default now(),
  last_at    timestamptz not null default now(),
  primary key (day, visitor)
);

comment on table meganet.app_visit is
  'One row per browser per day (0043): hits, tabs, device, signed in or not. The visitor id is random and browser-held; nothing names an anonymous visitor. Written only by meganet.log_visit(); read only through meganet.admin_dashboard().';

create index if not exists app_visit_user_idx on meganet.app_visit (user_id, last_at desc) where user_id is not null;

-- No policy for any browser-held role and no grant below: the function writes,
-- the dashboard reads, and nobody selects it directly.
alter table meganet.app_visit enable row level security;

create or replace function meganet.log_visit(p_visitor uuid, p_tab text default null, p_device text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tab    text := case when p_tab ~ '^[a-z0-9_-]{1,24}$' then p_tab end;
  v_device text := case when p_device in ('phone', 'tablet', 'desktop') then p_device end;
  v_uid    uuid := auth.uid();
begin
  if p_visitor is null then
    return;
  end if;

  -- A day that already holds 5,000 visitors takes no new ones (an existing
  -- visitor still counts). Nothing legitimate comes near it.
  if not exists (select 1 from meganet.app_visit where day = current_date and visitor = p_visitor)
     and (select count(*) from meganet.app_visit where day = current_date) >= 5000 then
    return;
  end if;

  insert into meganet.app_visit as v (day, visitor, signed_in, user_id, device, tabs)
  values (current_date, p_visitor, v_uid is not null, v_uid, v_device,
          case when v_tab is null then '{}'::text[] else array[v_tab] end)
  on conflict (day, visitor) do update
    set hits      = v.hits + 1,
        last_at   = pg_catalog.now(),
        signed_in = v.signed_in or excluded.signed_in,
        user_id   = coalesce(excluded.user_id, v.user_id),
        device    = coalesce(excluded.device, v.device),
        tabs      = case
                      when v_tab is null or v_tab = any (v.tabs)
                           or pg_catalog.cardinality(v.tabs) >= 40 then v.tabs
                      else v.tabs || v_tab
                    end;

  -- Retention, on the way past: the day index makes this cheap, and it means
  -- nothing has to run on a schedule.
  delete from meganet.app_visit where day < current_date - 400;
end;
$$;

comment on function meganet.log_visit(uuid, text, text) is
  'Record that a browser opened the app or a tab today (0043). Anon and authenticated; bounded — one row per visitor per day, slug tabs only, 5,000 visitors a day at most, 400 days kept.';


-- ── 2. last seen, for admin_users ─────────────────────────────────────────────
-- The latest of: the last sign-in, the last time a session was refreshed (the
-- app refreshes an open tab's token about hourly), and the last visit logged.
-- auth.sessions is read through dynamic SQL because it is Supabase's, and a
-- database without it (CI's scaffold) should still answer.

create or replace function meganet.user_sessions()
returns table (user_id uuid, active integer, last_at timestamptz, user_agent text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if pg_catalog.to_regclass('auth.sessions') is null then
    return;
  end if;
  return query execute $q$
    select s.user_id,
           count(*) filter (where (s.not_after is null or s.not_after > now())
                              and coalesce(s.refreshed_at::timestamptz, s.updated_at, s.created_at)
                                  > now() - interval '2 hours')::integer,
           max(coalesce(s.refreshed_at::timestamptz, s.updated_at, s.created_at)),
           (array_agg(s.user_agent order by coalesce(s.refreshed_at::timestamptz, s.updated_at, s.created_at) desc))[1]
      from auth.sessions s
     group by s.user_id
  $q$;
end;
$$;

comment on function meganet.user_sessions() is
  'Per user: sessions active in the last two hours, the latest session activity, and its browser. Empty where auth.sessions does not exist. Called only by the admin functions (0043).';

create or replace function meganet.admin_users()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform meganet.admin_require();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id',              u.id,
             'email',           u.email,
             'display_name',    u.display_name,
             'role',            u.role,
             'created_at',      u.created_at,
             'updated_at',      u.updated_at,
             'last_sign_in_at', au.last_sign_in_at,
             'last_seen_at',    greatest(au.last_sign_in_at, s.last_at, v.last_at),
             'active_sessions', coalesce(s.active, 0),
             'user_agent',      s.user_agent,
             'visits_30d',      coalesce(v.days, 0),
             'may_edit',        meganet.email_allowed(u.email),
             'is_you',          u.id = auth.uid())
           order by greatest(au.last_sign_in_at, s.last_at, v.last_at) desc nulls last,
                    pg_catalog.lower(u.email))
      from meganet.app_user u
      left join auth.users au on au.id = u.id
      left join meganet.user_sessions() s on s.user_id = u.id
      left join (select a.user_id, max(a.last_at) as last_at,
                        count(*) filter (where a.day > current_date - 30) as days
                   from meganet.app_visit a
                  where a.user_id is not null
                  group by a.user_id) v on v.user_id = u.id), '[]'::jsonb);
end;
$$;

comment on function meganet.admin_users() is
  'Every app_user row with its last sign-in, last seen (sign-in, session refresh or visit), active sessions, and whether the allowlist still lets it edit. Administrators only (0042, 0043).';


-- ── 3. The dashboard ─────────────────────────────────────────────────────────

create or replace function meganet.admin_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_db       jsonb;
  v_conn     jsonb;
  v_schemas  jsonb;
  v_tables   jsonb;
  v_storage  jsonb := '[]'::jsonb;
  v_users    jsonb;
  v_visits   jsonb;
  v_api      jsonb := null;
  v_slow     jsonb := null;
  v_pss      text;
begin
  perform meganet.admin_require();

  select jsonb_build_object(
           'size_bytes',     pg_catalog.pg_database_size(pg_catalog.current_database()),
           'version',        pg_catalog.current_setting('server_version'),
           'started_at',     pg_catalog.pg_postmaster_start_time(),
           'max_connections', pg_catalog.current_setting('max_connections')::integer,
           'cache_hit',      case when d.blks_hit + d.blks_read > 0
                                  then round(d.blks_hit::numeric / (d.blks_hit + d.blks_read), 5) end,
           'commits',        d.xact_commit,
           'rollbacks',      d.xact_rollback,
           'deadlocks',      d.deadlocks,
           'temp_bytes',     d.temp_bytes,
           'stats_reset',    d.stats_reset,
           'schema_version', (select m.value from meganet.app_meta m where m.key = 'schema_version'),
           'now',            pg_catalog.now())
    into v_db
    from pg_catalog.pg_stat_database d
   where d.datname = pg_catalog.current_database();

  select jsonb_build_object(
           'total',       count(*),
           'active',      count(*) filter (where a.state = 'active'),
           'idle',        count(*) filter (where a.state = 'idle'),
           'idle_in_tx',  count(*) filter (where a.state like 'idle in transaction%'),
           'waiting',     count(*) filter (where a.wait_event_type = 'Lock'),
           'longest_tx_s', extract(epoch from max(pg_catalog.now() - a.xact_start))::integer,
           'by_app',      coalesce((select jsonb_object_agg(k, n) from (
                             select coalesce(nullif(b.application_name, ''), b.usename::text, 'other') as k, count(*) as n
                               from pg_catalog.pg_stat_activity b
                              where b.datname = pg_catalog.current_database() and b.backend_type = 'client backend'
                              group by 1) x), '{}'::jsonb))
    into v_conn
    from pg_catalog.pg_stat_activity a
   where a.datname = pg_catalog.current_database() and a.backend_type = 'client backend';

  select coalesce(jsonb_agg(jsonb_build_object('schema', s.nspname, 'bytes', s.bytes, 'tables', s.n)
                            order by s.bytes desc), '[]'::jsonb)
    into v_schemas
    from (select n.nspname, sum(pg_catalog.pg_total_relation_size(c.oid))::bigint as bytes, count(*) as n
            from pg_catalog.pg_class c
            join pg_catalog.pg_namespace n on n.oid = c.relnamespace
           where c.relkind in ('r', 'm', 'p')
             and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
             and n.nspname not like 'pg\_temp%' and n.nspname not like 'pg\_toast\_temp%'
           group by n.nspname) s;

  select coalesce(jsonb_agg(jsonb_build_object(
           'schema',       n.nspname,
           'name',         c.relname,
           'kind',         case c.relkind when 'm' then 'matview' when 'p' then 'partitioned' else 'table' end,
           'bytes',        pg_catalog.pg_total_relation_size(c.oid),
           'table_bytes',  pg_catalog.pg_relation_size(c.oid),
           'index_bytes',  pg_catalog.pg_indexes_size(c.oid),
           'rows',         coalesce(st.n_live_tup, greatest(c.reltuples, 0)::bigint),
           'dead_rows',    st.n_dead_tup,
           'seq_scans',    st.seq_scan,
           'idx_scans',    st.idx_scan,
           'inserts',      st.n_tup_ins,
           'updates',      st.n_tup_upd,
           'deletes',      st.n_tup_del,
           'last_vacuum',  greatest(st.last_vacuum, st.last_autovacuum),
           'last_analyze', greatest(st.last_analyze, st.last_autoanalyze),
           'rls',          c.relrowsecurity)
           order by pg_catalog.pg_total_relation_size(c.oid) desc), '[]'::jsonb)
    into v_tables
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    left join pg_catalog.pg_stat_all_tables st on st.relid = c.oid
   where c.relkind in ('r', 'm', 'p')
     and n.nspname in ('meganet', 'auth', 'storage', 'public');

  -- File storage lives outside the database (Supabase keeps the bytes in
  -- object storage), so its size is the objects' own metadata, per bucket.
  if pg_catalog.to_regclass('storage.objects') is not null then
    execute $q$
      select coalesce(jsonb_agg(jsonb_build_object('bucket', b, 'objects', n, 'bytes', bytes, 'last_at', last_at)
                                order by bytes desc), '[]'::jsonb)
        from (select o.bucket_id as b, count(*) as n,
                     coalesce(sum(case when (o.metadata ->> 'size') ~ '^[0-9]+$'
                                       then (o.metadata ->> 'size')::bigint end), 0) as bytes,
                     max(o.created_at) as last_at
                from storage.objects o
               group by o.bucket_id) x
    $q$ into v_storage;
  end if;

  select jsonb_build_object(
           'total',        (select count(*) from meganet.app_user),
           'by_role',      coalesce((select jsonb_object_agg(role, n) from
                              (select u.role, count(*) as n from meganet.app_user u group by u.role) r), '{}'::jsonb),
           'allow_entries', (select count(*) from meganet.editor_allow),
           'active_now',   (select count(*) from meganet.user_sessions() s where s.active > 0),
           'sessions_active', (select coalesce(sum(s.active), 0) from meganet.user_sessions() s),
           'seen_24h',     (select count(*) from meganet.app_user u
                              left join auth.users au on au.id = u.id
                              left join meganet.user_sessions() s on s.user_id = u.id
                             where greatest(au.last_sign_in_at, s.last_at,
                                            (select max(a.last_at) from meganet.app_visit a where a.user_id = u.id))
                                   > pg_catalog.now() - interval '24 hours'),
           'seen_7d',      (select count(*) from meganet.app_user u
                              left join auth.users au on au.id = u.id
                              left join meganet.user_sessions() s on s.user_id = u.id
                             where greatest(au.last_sign_in_at, s.last_at,
                                            (select max(a.last_at) from meganet.app_visit a where a.user_id = u.id))
                                   > pg_catalog.now() - interval '7 days'),
           'seen_30d',     (select count(*) from meganet.app_user u
                              left join auth.users au on au.id = u.id
                              left join meganet.user_sessions() s on s.user_id = u.id
                             where greatest(au.last_sign_in_at, s.last_at,
                                            (select max(a.last_at) from meganet.app_visit a where a.user_id = u.id))
                                   > pg_catalog.now() - interval '30 days'))
    into v_users;

  select jsonb_build_object(
           'since',     (select min(a.day) from meganet.app_visit a),
           'days',      coalesce((select jsonb_agg(jsonb_build_object(
                                     'day', g.day::date, 'signed_in', coalesce(x.si, 0),
                                     'anonymous', coalesce(x.an, 0), 'hits', coalesce(x.hits, 0))
                                   order by g.day)
                                  from pg_catalog.generate_series(current_date - 29, current_date, interval '1 day') g(day)
                                  left join (select a.day, count(*) filter (where a.signed_in) as si,
                                                    count(*) filter (where not a.signed_in) as an,
                                                    sum(a.hits) as hits
                                               from meganet.app_visit a
                                              where a.day > current_date - 30
                                              group by a.day) x on x.day = g.day::date), '[]'::jsonb),
           'visitors_30d',  (select count(distinct a.visitor) from meganet.app_visit a where a.day > current_date - 30),
           'anonymous_30d', (select count(distinct a.visitor) from meganet.app_visit a
                              where a.day > current_date - 30 and not a.signed_in),
           'last_anonymous_at', (select max(a.last_at) from meganet.app_visit a where not a.signed_in),
           'active_15m',    (select count(*) from meganet.app_visit a
                              where a.day >= current_date - 1 and a.last_at > pg_catalog.now() - interval '15 minutes'),
           'tabs',      coalesce((select jsonb_agg(jsonb_build_object('tab', t, 'visitors', n) order by n desc, t)
                                    from (select t, count(*) as n
                                            from meganet.app_visit a, unnest(a.tabs) t
                                           where a.day > current_date - 30
                                           group by t) x), '[]'::jsonb),
           'devices',   coalesce((select jsonb_object_agg(coalesce(device, 'unknown'), n)
                                    from (select a.device, count(*) as n from meganet.app_visit a
                                           where a.day > current_date - 30 group by a.device) x), '{}'::jsonb))
    into v_visits;

  select n.nspname into v_pss
    from pg_catalog.pg_extension e
    join pg_catalog.pg_namespace n on n.oid = e.extnamespace
   where e.extname = 'pg_stat_statements';
  if v_pss is not null then
    begin
      execute pg_catalog.format($q$
        select coalesce(jsonb_agg(jsonb_build_object('role', r, 'calls', calls, 'ms', ms, 'rows', nrows)
                                  order by calls desc), '[]'::jsonb)
          from (select r.rolname as r, sum(s.calls)::bigint as calls,
                       round(sum(s.total_exec_time)::numeric, 1) as ms, sum(s.rows)::bigint as nrows
                  from %I.pg_stat_statements s
                  join pg_catalog.pg_roles r on r.oid = s.userid
                 where s.dbid = (select oid from pg_catalog.pg_database where datname = pg_catalog.current_database())
                 group by r.rolname) x
      $q$, v_pss) into v_api;
      execute pg_catalog.format($q$
        select coalesce(jsonb_agg(jsonb_build_object('role', r, 'calls', calls, 'mean_ms', mean_ms,
                                                     'total_ms', total_ms, 'query', q)
                                  order by total_ms desc), '[]'::jsonb)
          from (select r.rolname as r, s.calls, round(s.mean_exec_time::numeric, 2) as mean_ms,
                       round(s.total_exec_time::numeric, 1) as total_ms,
                       left(regexp_replace(s.query, '\s+', ' ', 'g'), 240) as q
                  from %I.pg_stat_statements s
                  join pg_catalog.pg_roles r on r.oid = s.userid
                 where s.dbid = (select oid from pg_catalog.pg_database where datname = pg_catalog.current_database())
                   and r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                 order by s.total_exec_time desc
                 limit 12) x
      $q$, v_pss) into v_slow;
    exception when others then
      v_api := null; v_slow := null;   -- no privilege to read it: say nothing rather than fail the page
    end;
  end if;

  return jsonb_build_object(
    'db',          v_db,
    'connections', v_conn,
    'schemas',     v_schemas,
    'tables',      v_tables,
    'storage',     v_storage,
    'users',       v_users,
    'visits',      v_visits,
    'api',         v_api,
    'slow',        v_slow);
end;
$$;

comment on function meganet.admin_dashboard() is
  'Database health, schema and table sizes, storage buckets, users and sessions, visits and API calls by role, as one jsonb for the Admin tab. Administrators only (0043).';


-- ── Who may run what ─────────────────────────────────────────────────────────

revoke all on function meganet.log_visit(uuid, text, text) from public;
revoke all on function meganet.user_sessions()             from public;
revoke all on function meganet.admin_users()               from public;
revoke all on function meganet.admin_dashboard()           from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  grant execute on function meganet.log_visit(uuid, text, text) to anon, authenticated, service_role;
  grant execute on function meganet.admin_users()               to authenticated, service_role;
  grant execute on function meganet.admin_dashboard()           to authenticated, service_role;

  notify pgrst, 'reload schema';
end
$$;


-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 42 → 43 in the same commit as this file.

insert into meganet.app_meta (key, value)
values ('schema_version', '43')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
