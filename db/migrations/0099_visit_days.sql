-- 0099_visit_days.sql — The Admin tab's "N days in 30" counts days, not
-- browser-days.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0099_visit_days.sql
--
-- Why this file exists
-- ────────────────────
-- admin_users() (0043, restated by 0062) answers visits_30d, which the Users
-- table shows under Last seen as "N days in 30". It counted rows of
-- meganet.app_visit, and app_visit is one row per *browser* per day (its key
-- is day and visitor). Somebody who uses Flood-Net on a phone and two
-- computers was counted three times a day, so an administrator read "48 days
-- in 30". It now counts the distinct days. Nothing else in the function moves:
-- this is 0062's text with that one count changed.
--
-- Depends on 0043 (app_visit, user_sessions), 0062 (account_standing, this
-- function's shape). tools/check_admin_dashboard.sql proves it.

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
             'status',          meganet.account_standing(u.id),
             'decided_at',      u.decided_at,
             'decided_by',      u.decided_by,
             'confirmed_at',    au.email_confirmed_at,
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
                        count(distinct a.day) filter (where a.day > current_date - 30) as days
                   from meganet.app_visit a
                  where a.user_id is not null
                  group by a.user_id) v on v.user_id = u.id), '[]'::jsonb);
end;
$$;

comment on function meganet.admin_users() is
  'Every app_user row with its standing (0062), last sign-in, last seen, active sessions, on how many of the last 30 days it was used (0099: days, not browsers), and whether the allowlist lets it edit. Administrators only (0042, 0043, 0062, 0099).';

-- The same signature, so create or replace keeps the grants 0043 and 0062
-- made (authenticated and service_role; admin_require() is what says no).

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 98 → 99 once db-migrate.yml has applied
-- this file.

insert into meganet.app_meta (key, value)
values ('schema_version', '99')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
