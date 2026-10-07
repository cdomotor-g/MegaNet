-- check_user_admin.sql — Prove the Admin tab's user management (0042) against a
-- real database: who may call it, what it changes, and the guards that stop an
-- administrator locking everybody out.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_user_admin.sql
--
-- The whole script runs inside a transaction and rolls back, so it is safe
-- against the live database: nothing it writes survives. It prints a row per
-- check and exits non-zero if any failed. CI runs it in the db-checks job
-- (.github/workflows/web-smoke.yml).

\set ON_ERROR_STOP on

begin;

create temporary table _check (
  ord   serial,
  name  text,
  ok    boolean,
  note  text
) on commit drop;

create or replace function pg_temp.check_that(p_name text, p_ok boolean, p_note text default '')
returns void language sql as $$
  insert into _check (name, ok, note) values (p_name, coalesce(p_ok, false), p_note);
$$;

-- Run one statement as another role with a request's claims and answer with its
-- first column as text, or 'ERROR <sqlstate>' — then roll it back, so every
-- check starts from the same people (check_photo_review.sql's helper).
create or replace function pg_temp.as_role(p_role text, p_claims text, p_sql text)
returns text language plpgsql as $$
declare
  v text;
begin
  begin
    execute pg_catalog.format('set local role %I', p_role);
    perform pg_catalog.set_config('request.jwt.claims', p_claims, true);
    execute p_sql into v;
    raise exception using errcode = 'MNRLB', message = coalesce(v, '<null>');
  exception
    when sqlstate 'MNRLB' then return sqlerrm;
    when others then return 'ERROR ' || sqlstate;
  end;
end;
$$;

-- ── The people ───────────────────────────────────────────────────────────────

insert into meganet.editor_allow (entry, note) values
  ('ua-editor@example.test', 'check_user_admin — rolled back'),
  ('ua-admin@example.test',  'check_user_admin — rolled back'),
  ('@ua-domain.test',        'check_user_admin — rolled back')
on conflict (entry) do nothing;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-00000000ad01', 'ua-editor@example.test', now()),
  ('00000000-0000-4000-8000-00000000ad02', 'ua-admin@example.test', now()),
  ('00000000-0000-4000-8000-00000000ad03', 'ua-other@ua-domain.test', now())
on conflict (id) do nothing;

-- Only this script's administrator, so "the last administrator" is testable
-- whatever the database it runs against already holds.
update meganet.app_user set role = 'editor' where role = 'admin'
   and id <> '00000000-0000-4000-8000-00000000ad02';
update meganet.app_user set role = 'admin' where id = '00000000-0000-4000-8000-00000000ad02';

create temporary table _who (k text primary key, claims text) on commit drop;
insert into _who values
  ('anon',    '{"role":"anon"}'),
  ('editor',  '{"role":"authenticated","email":"ua-editor@example.test","sub":"00000000-0000-4000-8000-00000000ad01"}'),
  ('admin',   '{"role":"authenticated","email":"ua-admin@example.test","sub":"00000000-0000-4000-8000-00000000ad02"}'),
  ('service', '{"role":"service_role"}');

-- ── 1. Who may call it ───────────────────────────────────────────────────────

do $$
declare v text;
begin
  v := pg_temp.as_role('anon', (select claims from _who where k = 'anon'), 'select meganet.admin_users()::text');
  perform pg_temp.check_that('anonymous cannot list users', v like 'ERROR%', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'editor'), 'select meganet.admin_users()::text');
  perform pg_temp.check_that('an editor cannot list users', v = 'ERROR 42501', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'editor'),
         $q$select meganet.admin_allow_save('sneaky@example.test')::text$q$);
  perform pg_temp.check_that('an editor cannot add to the allowlist', v = 'ERROR 42501', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
         'select jsonb_array_length(meganet.admin_users())::text');
  perform pg_temp.check_that('an administrator can list users', v ~ '^[0-9]+$' and v::int >= 3, v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
         $q$select (select e ->> 'is_you' from jsonb_array_elements(meganet.admin_users()) e
                     where e ->> 'email' = 'ua-admin@example.test')$q$);
  perform pg_temp.check_that('the list marks the caller as themselves', v = 'true', v);

  v := pg_temp.as_role('service_role', (select claims from _who where k = 'service'),
         'select jsonb_array_length(meganet.admin_allowlist())::text');
  perform pg_temp.check_that('the service key can list the allowlist', v ~ '^[0-9]+$', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'), $q$select meganet.whoami() ->> 'is_admin'$q$);
  perform pg_temp.check_that('whoami says an administrator is one', v = 'true', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'editor'), $q$select meganet.whoami() ->> 'is_admin'$q$);
  perform pg_temp.check_that('whoami says an editor is not', v = 'false', v);

  v := pg_temp.as_role('anon', (select claims from _who where k = 'anon'), $q$select meganet.whoami() ->> 'is_admin'$q$);
  perform pg_temp.check_that('whoami says anonymous is not', v = 'false', v);
end
$$;

-- ── 2. What it changes ───────────────────────────────────────────────────────

do $$
declare v text;
begin
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
         $q$select meganet.admin_user_save('00000000-0000-4000-8000-00000000ad01', 'viewer', '  Ed  ') ->> 'role'$q$);
  perform pg_temp.check_that('an administrator can change a role', v = 'viewer', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
         $q$select meganet.admin_user_save('00000000-0000-4000-8000-00000000ad01', 'editor', '  Ed  ') ->> 'display_name'$q$);
  perform pg_temp.check_that('a display name is trimmed', v = 'Ed', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
         $q$select meganet.admin_user_save('00000000-0000-4000-8000-00000000ad01', 'owner')::text$q$);
  perform pg_temp.check_that('a role that is not viewer, editor or admin is refused', v = 'ERROR 22023', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
         $q$select meganet.admin_allow_save('  New.Person@Example.Test ', 'hi', 'admin') ->> 'entry'$q$);
  perform pg_temp.check_that('an allowlist entry is trimmed and lower-cased', v = 'new.person@example.test', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
         $q$select meganet.admin_allow_save('not an address')::text$q$);
  perform pg_temp.check_that('something that is neither address nor domain is refused', v = 'ERROR 22023', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
         $q$select meganet.admin_allow_remove('@ua-domain.test')::text$q$);
  perform pg_temp.check_that('an administrator can remove an entry', v = 'true', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
         $q$select meganet.admin_user_delete('00000000-0000-4000-8000-00000000ad01', true)::text$q$);
  perform pg_temp.check_that('an administrator can delete a person and their entry',
    v like '%"deleted": true%' and v like '%"disallowed": true%', v);
end
$$;

-- The role an address arrives with — outside as_role, because the trigger is
-- what runs, and it runs as whoever inserts into auth.users.
insert into meganet.editor_allow (entry, note, initial_role) values
  ('ua-newadmin@example.test', 'check_user_admin — rolled back', 'admin'),
  ('@ua-viewers.test',         'check_user_admin — rolled back', 'viewer');
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-00000000ad04', 'ua-newadmin@example.test', now()),
  ('00000000-0000-4000-8000-00000000ad05', 'someone@ua-viewers.test', now()),
  ('00000000-0000-4000-8000-00000000ad06', 'plain@ua-domain.test', now());

do $$
begin
  perform pg_temp.check_that('an address''s initial role is applied on first sign-in',
    (select role from meganet.app_user where id = '00000000-0000-4000-8000-00000000ad04') = 'admin');
  perform pg_temp.check_that('a domain''s initial role is applied to its addresses',
    (select role from meganet.app_user where id = '00000000-0000-4000-8000-00000000ad05') = 'viewer');
  perform pg_temp.check_that('no initial role means editor',
    (select role from meganet.app_user where id = '00000000-0000-4000-8000-00000000ad06') = 'editor');

  update auth.users set raw_user_meta_data = '{"name":"N"}'
   where id = '00000000-0000-4000-8000-00000000ad05';
  perform pg_temp.check_that('a later sign-in never rewrites the role',
    (select role from meganet.app_user where id = '00000000-0000-4000-8000-00000000ad05') = 'viewer');
end
$$;

-- ── 3. The lockout guards ────────────────────────────────────────────────────

-- The administrator provisioned above is set back, so this script's own is
-- the last one again.
update meganet.app_user set role = 'editor' where id = '00000000-0000-4000-8000-00000000ad04';

do $$
declare v text;
begin
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
         $q$select meganet.admin_user_save('00000000-0000-4000-8000-00000000ad02', 'editor')::text$q$);
  perform pg_temp.check_that('an administrator cannot demote themselves', v = 'ERROR 42501', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
         $q$select meganet.admin_user_delete('00000000-0000-4000-8000-00000000ad02')::text$q$);
  perform pg_temp.check_that('an administrator cannot delete themselves', v = 'ERROR 42501', v);

  v := pg_temp.as_role('service_role', (select claims from _who where k = 'service'),
         $q$select meganet.admin_user_save('00000000-0000-4000-8000-00000000ad02', 'editor')::text$q$);
  perform pg_temp.check_that('not even the service key can demote the last administrator', v = 'ERROR 42501', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
         $q$select meganet.admin_allow_remove('ua-admin@example.test')::text$q$);
  perform pg_temp.check_that('an administrator cannot remove the only entry letting them in', v = 'ERROR 42501', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
         $q$select meganet.admin_allow_save('@example.test') is not null and meganet.admin_allow_remove('ua-admin@example.test')$q$);
  perform pg_temp.check_that('…but can once another entry lets them in', v = 'true', v);
end
$$;

-- ── The verdict ──────────────────────────────────────────────────────────────

select lpad(ord::text, 2) as "#",
       case when ok then 'ok  ' else 'FAIL' end as result,
       name,
       case when ok then '' else left(coalesce(note, ''), 160) end as detail
  from _check order by ord;

do $$
declare
  n integer;
begin
  select count(*) into n from _check where not ok;
  if n > 0 then
    raise exception '% of % checks failed', n, (select count(*) from _check);
  end if;
  raise notice 'all % checks passed', (select count(*) from _check);
end
$$;

rollback;
