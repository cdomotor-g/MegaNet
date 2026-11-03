-- check_account_merge.sql — Prove one person, one account (0100) against a
-- real database: that an administrator folds a person's second account into
-- their first — teams (owning where it owned), tasks, notes, the ALERT2
-- plan's list, devices and views moving over, with the higher role, the
-- approval and the editing — and that its address then stays with the kept
-- account: where the mail goes if the person says so, found when somebody
-- adds them to a team by it, shown on the roster, and refused as an account
-- of its own until an administrator frees it. And that nobody else may do
-- any of it, nor fold in an unconfirmed or declined account, nor themselves,
-- nor an account some table the merge does not know still points at.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_account_merge.sql
--
-- One row per claim, a non-zero exit if any fails, and the whole script in a
-- transaction that rolls back, so it is safe against the live database. Run
-- it as a direct psql connection. CI runs it in the db-checks job after every
-- migration has been applied from zero.
--
-- What it deliberately does not check: the Admin tab's *Same person…* and
-- *Your account*'s choice of address, which are admin.js's and auth.js's,
-- held by test/accounts.mjs; and the mail itself, which needs Resend.

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

-- One statement as another role with a request's claims, rolled back: 'ok',
-- or the SQLSTATE it was refused with.
create or replace function pg_temp.as_role(p_role text, p_claims text, p_sql text)
returns text language plpgsql as $$
declare
  v_state text;
begin
  begin
    execute pg_catalog.format('set local role %I', p_role);
    perform pg_catalog.set_config('request.jwt.claims', p_claims, true);
    execute p_sql;
    raise exception using errcode = 'MNRLB', message = 'ok';
  exception
    when sqlstate 'MNRLB' then return 'ok';
    when others then
      get stacked diagnostics v_state = returned_sqlstate;
      return v_state;
  end;
end;
$$;

-- The same, kept, answering the statement's first column as text — or
-- 'ERROR <sqlstate>' with nothing kept.
create or replace function pg_temp.as_role_keep(p_role text, p_claims text, p_sql text)
returns text language plpgsql as $$
declare
  v text;
begin
  execute pg_catalog.format('set local role %I', p_role);
  perform pg_catalog.set_config('request.jwt.claims', p_claims, true);
  begin
    execute p_sql into v;
  exception when others then
    v := 'ERROR ' || sqlstate;
  end;
  execute 'reset role';
  perform pg_catalog.set_config('request.jwt.claims', '', true);
  return v;
end;
$$;

-- ── Fixtures ─────────────────────────────────────────────────────────────────
-- An administrator; a person with a personal account (kept) and a work one
-- on an allowlisted domain, an administrator too (folded in); a team owner
-- who adds people by address; an account never confirmed; a declined one;
-- and a pair whose second account a table the merge does not know points at.

update meganet.app_meta set value = 'open' where key = 'signup';

insert into meganet.editor_allow (entry, note) values
  ('am-admin@example.test', 'check_account_merge — rolled back'),
  ('@am-bureau.test',       'check_account_merge — rolled back')
on conflict (entry) do nothing;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000a9001', 'am-admin@example.test',     now()),
  ('00000000-0000-4000-8000-0000000a9002', 'am-keep@example.invalid',   now()),
  ('00000000-0000-4000-8000-0000000a9003', 'AM-Work@am-bureau.test',    now() - interval '30 days'),
  ('00000000-0000-4000-8000-0000000a9004', 'am-owner@example.invalid',  now()),
  ('00000000-0000-4000-8000-0000000a9005', 'am-unconf@example.invalid', null),
  ('00000000-0000-4000-8000-0000000a9006', 'am-declined@example.invalid', now()),
  ('00000000-0000-4000-8000-0000000a9007', 'am-x@example.invalid',      now()),
  ('00000000-0000-4000-8000-0000000a9008', 'am-y@example.invalid',      now())
on conflict (id) do nothing;

update meganet.app_user set role = 'admin', display_name = 'Check Admin'
 where id = '00000000-0000-4000-8000-0000000a9001';
update meganet.app_user set status = 'approved', display_name = 'Check Keep'
 where id = '00000000-0000-4000-8000-0000000a9002';
update meganet.app_user set role = 'admin', display_name = 'Check Work'
 where id = '00000000-0000-4000-8000-0000000a9003';
update meganet.app_user set status = 'approved', display_name = 'Check Owner'
 where id = '00000000-0000-4000-8000-0000000a9004';
update meganet.app_user set status = 'declined'
 where id = '00000000-0000-4000-8000-0000000a9006';
update meganet.app_user set status = 'approved'
 where id in ('00000000-0000-4000-8000-0000000a9007', '00000000-0000-4000-8000-0000000a9008');

create temporary table _who (k text primary key, role text, claims text) on commit drop;
insert into _who values
  ('anon',  'anon',          '{"role":"anon"}'),
  ('admin', 'authenticated', '{"role":"authenticated","email":"am-admin@example.test","sub":"00000000-0000-4000-8000-0000000a9001"}'),
  ('keep',  'authenticated', '{"role":"authenticated","email":"am-keep@example.invalid","sub":"00000000-0000-4000-8000-0000000a9002"}'),
  ('work',  'authenticated', '{"role":"authenticated","email":"AM-Work@am-bureau.test","sub":"00000000-0000-4000-8000-0000000a9003"}'),
  ('owner', 'authenticated', '{"role":"authenticated","email":"am-owner@example.invalid","sub":"00000000-0000-4000-8000-0000000a9004"}');

create or replace function pg_temp.as_who(p_who text, p_sql text)
returns text language sql as $$
  select pg_temp.as_role(w.role, w.claims, p_sql) from _who w where w.k = p_who;
$$;
create or replace function pg_temp.json_as(p_who text, p_sql text)
returns jsonb language plpgsql as $$
declare
  v text;
begin
  select pg_temp.as_role_keep(w.role, w.claims, p_sql) into v from _who w where w.k = p_who;
  if v is null or v like 'ERROR %' then
    return pg_catalog.jsonb_build_object('error', v);
  end if;
  return v::jsonb;
end;
$$;

-- Two teams: the work account owns one and is on the other with the personal
-- one, owning it there; a third team the owner owns. A task the work account
-- made, a note it wrote, its place on the ALERT2 plan's list, its views and a
-- device.
insert into meganet.team (id, name) values
  ('00000000-0000-4000-8000-0000000a9101', 'Check Merge One'),
  ('00000000-0000-4000-8000-0000000a9102', 'Check Merge Both'),
  ('00000000-0000-4000-8000-0000000a9103', 'Check Merge Owner''s')
on conflict do nothing;
insert into meganet.team_member (team_id, user_id, is_owner, added_by) values
  ('00000000-0000-4000-8000-0000000a9101', '00000000-0000-4000-8000-0000000a9003', true,  '00000000-0000-4000-8000-0000000a9001'),
  ('00000000-0000-4000-8000-0000000a9102', '00000000-0000-4000-8000-0000000a9002', false, '00000000-0000-4000-8000-0000000a9003'),
  ('00000000-0000-4000-8000-0000000a9102', '00000000-0000-4000-8000-0000000a9003', true,  '00000000-0000-4000-8000-0000000a9001'),
  ('00000000-0000-4000-8000-0000000a9103', '00000000-0000-4000-8000-0000000a9004', true,  '00000000-0000-4000-8000-0000000a9001');
insert into meganet.task (id, title, team_id, created_by) values
  ('00000000-0000-4000-8000-0000000a9201', 'Check merge task', '00000000-0000-4000-8000-0000000a9101',
   '00000000-0000-4000-8000-0000000a9003');
insert into meganet.task_note (task_id, author_id, kind, body) values
  ('00000000-0000-4000-8000-0000000a9201', '00000000-0000-4000-8000-0000000a9003', 'note', 'Check merge note');
insert into meganet.a2plan_member (user_id, nominates) values
  ('00000000-0000-4000-8000-0000000a9003', true)
on conflict (user_id) do nothing;
insert into meganet.user_pref (user_id, nav_views) values
  ('00000000-0000-4000-8000-0000000a9003', '{"check": "work views"}');
insert into meganet.push_subscription (user_id, endpoint, p256dh, auth, vapid_key) values
  ('00000000-0000-4000-8000-0000000a9003', 'https://web.push.apple.com/check-account-merge',
   'B' || repeat('p', 86), repeat('a', 22), 'B' || repeat('k', 86));

-- ── 1. The shape ─────────────────────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('account_address has RLS on and no policy',
    (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'meganet.account_address'::regclass)
    and not exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'meganet.account_address'::regclass));
  perform pg_temp.check_that('the new functions are security definer with an empty search_path',
    (select count(*) = 6 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'meganet'
        and p.proname in ('account_by_address', 'mail_address', 'account_addresses',
                          'account_merge', 'admin_address_remove', 'my_mail_to')
        and p.prosecdef and p.proconfig @> array['search_path=""']));
  perform pg_temp.check_that('public may execute none of them',
    not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'meganet'
                   and p.proname in ('account_by_address', 'mail_address', 'account_addresses',
                                     'account_merge', 'admin_address_remove', 'my_mail_to')
                   and pg_catalog.has_function_privilege('public', p.oid, 'execute')));
  perform pg_temp.check_that('a browser reads no second address straight from the table',
    pg_temp.as_who('keep', 'select 1 from meganet.account_address') = '42501'
    and pg_temp.as_who('anon', 'select 1 from meganet.account_address') = '42501');
end
$$;

-- ── 2. Who may fold one account into another ────────────────────────────────

do $$
begin
  perform pg_temp.check_that('nobody signed out may',
    pg_temp.as_who('anon', $q$select meganet.account_merge('00000000-0000-4000-8000-0000000a9002',
                                                           '00000000-0000-4000-8000-0000000a9003')$q$) = '42501');
  perform pg_temp.check_that('an approved account that is not an administrator may not',
    pg_temp.as_who('keep', $q$select meganet.account_merge('00000000-0000-4000-8000-0000000a9002',
                                                           '00000000-0000-4000-8000-0000000a9003')$q$) = '42501');
  perform pg_temp.check_that('an administrator does not fold in the account they are signed in with',
    pg_temp.as_who('work', $q$select meganet.account_merge('00000000-0000-4000-8000-0000000a9002',
                                                           '00000000-0000-4000-8000-0000000a9003')$q$) = '42501');
  perform pg_temp.check_that('nor an account into itself',
    pg_temp.as_who('admin', $q$select meganet.account_merge('00000000-0000-4000-8000-0000000a9002',
                                                            '00000000-0000-4000-8000-0000000a9002')$q$) = '22023');
  perform pg_temp.check_that('nor one that never confirmed its address',
    pg_temp.as_who('admin', $q$select meganet.account_merge('00000000-0000-4000-8000-0000000a9002',
                                                            '00000000-0000-4000-8000-0000000a9005')$q$) = '22023');
  perform pg_temp.check_that('nor into one that never confirmed its address',
    pg_temp.as_who('admin', $q$select meganet.account_merge('00000000-0000-4000-8000-0000000a9005',
                                                            '00000000-0000-4000-8000-0000000a9002')$q$) = '22023');
  perform pg_temp.check_that('nor a declined one',
    pg_temp.as_who('admin', $q$select meganet.account_merge('00000000-0000-4000-8000-0000000a9002',
                                                            '00000000-0000-4000-8000-0000000a9006')$q$) = '22023');
  perform pg_temp.check_that('nor one that is not there',
    pg_temp.as_who('admin', $q$select meganet.account_merge('00000000-0000-4000-8000-0000000a9002',
                                                            '00000000-0000-4000-8000-0000000a9999')$q$) = 'P0002');
end
$$;

-- A table the merge does not know, pointing at the second account of the
-- other pair: the merge stops, and nothing is changed. A real table (a
-- temporary one may not point at auth.users), gone with the rollback.
create table public._check_am_unknown (user_id uuid references auth.users (id) on delete cascade);
insert into public._check_am_unknown values ('00000000-0000-4000-8000-0000000a9008');

do $$
begin
  perform pg_temp.check_that('a table the merge does not know, still pointing at the account, stops it (23503)',
    pg_temp.as_who('admin', $q$select meganet.account_merge('00000000-0000-4000-8000-0000000a9007',
                                                            '00000000-0000-4000-8000-0000000a9008')$q$) = '23503');
  perform pg_temp.check_that('…and the account and its row are still there',
    exists (select 1 from auth.users where id = '00000000-0000-4000-8000-0000000a9008')
    and exists (select 1 from public._check_am_unknown));
end
$$;

-- ── 3. The merge ─────────────────────────────────────────────────────────────

do $$
declare
  r jsonb;
begin
  -- The personal account is not on the allowlist and is an editor; the work
  -- one is on it by domain, and an administrator.
  perform pg_temp.check_that('before: the kept account may not edit',
    not (pg_temp.json_as('keep', 'select meganet.whoami()::text') ->> 'may_write')::boolean);

  r := pg_temp.json_as('admin', $q$select meganet.account_merge('00000000-0000-4000-8000-0000000a9002',
                                                                '00000000-0000-4000-8000-0000000a9003')::text$q$);
  perform pg_temp.check_that('an administrator folds the work account into the personal one',
    r ->> 'kept' = 'am-keep@example.invalid' and r ->> 'folded_in' = 'AM-Work@am-bureau.test', r::text);
  perform pg_temp.check_that('it says the teams, the ownerships, the task and the note it moved',
    (r ->> 'teams')::int = 2 and (r ->> 'owns')::int = 2 and (r ->> 'tasks')::int = 1
    and (r ->> 'notes')::int = 1 and (r ->> 'devices')::int = 1, r::text);
  perform pg_temp.check_that('the work account''s sign-in is gone',
    not exists (select 1 from auth.users where id = '00000000-0000-4000-8000-0000000a9003')
    and not exists (select 1 from meganet.app_user where id = '00000000-0000-4000-8000-0000000a9003'));
  perform pg_temp.check_that('the kept account has the higher role: administrator',
    (select role from meganet.app_user where id = '00000000-0000-4000-8000-0000000a9002') = 'admin'
    and r ->> 'role' = 'admin', r::text);
  perform pg_temp.check_that('its own address went on the allowlist, as the work one was on it',
    (r ->> 'allowlisted')::boolean
    and exists (select 1 from meganet.editor_allow where entry = 'am-keep@example.invalid'));
  r := pg_temp.json_as('keep', 'select meganet.whoami()::text');
  perform pg_temp.check_that('…so the person may edit and administer, signed in with the personal address',
    (r ->> 'may_write')::boolean and (r ->> 'is_admin')::boolean, r::text);
  perform pg_temp.check_that('whoami() names the second address, where the mail now goes',
    r -> 'addresses' -> 0 ->> 'email' = 'am-work@am-bureau.test'
    and (r -> 'addresses' -> 0 ->> 'mail_here')::boolean
    and r ->> 'mail_to' = 'am-work@am-bureau.test', r::text);
  perform pg_temp.check_that('the address keeps when it was confirmed',
    (select confirmed_at < now() - interval '29 days' from meganet.account_address
      where email = 'am-work@am-bureau.test'));

  perform pg_temp.check_that('the team only the work account was on is the kept one''s, owned',
    exists (select 1 from meganet.team_member where team_id = '00000000-0000-4000-8000-0000000a9101'
             and user_id = '00000000-0000-4000-8000-0000000a9002' and is_owner));
  perform pg_temp.check_that('the team both were on has the person once, owning it',
    (select count(*) = 1 and bool_and(is_owner) from meganet.team_member
      where team_id = '00000000-0000-4000-8000-0000000a9102'
        and user_id in ('00000000-0000-4000-8000-0000000a9002', '00000000-0000-4000-8000-0000000a9003')));
  perform pg_temp.check_that('who added somebody is the kept account now',
    (select added_by from meganet.team_member where team_id = '00000000-0000-4000-8000-0000000a9102'
       and user_id = '00000000-0000-4000-8000-0000000a9002') = '00000000-0000-4000-8000-0000000a9002');
  perform pg_temp.check_that('the task it made and the note it wrote are the kept account''s',
    (select created_by from meganet.task where id = '00000000-0000-4000-8000-0000000a9201') = '00000000-0000-4000-8000-0000000a9002'
    and (select author_id from meganet.task_note where task_id = '00000000-0000-4000-8000-0000000a9201')
          = '00000000-0000-4000-8000-0000000a9002');
  perform pg_temp.check_that('its place on the ALERT2 plan''s list, nominating, is the kept account''s',
    (select nominates from meganet.a2plan_member where user_id = '00000000-0000-4000-8000-0000000a9002'));
  perform pg_temp.check_that('its views came over, the kept account having none',
    (select nav_views ->> 'check' from meganet.user_pref where user_id = '00000000-0000-4000-8000-0000000a9002') = 'work views');
  perform pg_temp.check_that('its device came over',
    (select user_id from meganet.push_subscription where endpoint = 'https://web.push.apple.com/check-account-merge')
      = '00000000-0000-4000-8000-0000000a9002');
end
$$;

-- ── 4. The address, afterwards ──────────────────────────────────────────────

do $$
declare
  r jsonb;
  v_state text;
begin
  -- Signing up with it again would make two people of one.
  begin
    insert into auth.users (id, email, email_confirmed_at)
    values ('00000000-0000-4000-8000-0000000a9013', 'am-work@AM-bureau.test', now());
    v_state := 'ok';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.check_that('an account of its own is refused for a second address, whatever its case (42501)',
    v_state = '42501', v_state);

  r := pg_temp.json_as('owner', $q$select meganet.team_member_save('00000000-0000-4000-8000-0000000a9103',
                                                                   'AM-Work@am-bureau.test')::text$q$);
  perform pg_temp.check_that('a team''s owner adds the person by their second address, and gets the kept account',
    exists (select 1 from meganet.team_member where team_id = '00000000-0000-4000-8000-0000000a9103'
             and user_id = '00000000-0000-4000-8000-0000000a9002'), r::text);
  perform pg_temp.check_that('the owner sees both addresses on the roster',
    exists (select 1 from pg_catalog.jsonb_array_elements(r -> 'teams') t,
                          pg_catalog.jsonb_array_elements(t -> 'roster') p
             where t ->> 'name' = 'Check Merge Owner''s'
               and p ->> 'email' = 'am-keep@example.invalid'
               and p -> 'also' ? 'am-work@am-bureau.test'), r::text);

  r := pg_temp.json_as('keep', $q$select meganet.a2plan_member_save('am-work@am-bureau.test')::text$q$);
  perform pg_temp.check_that('the ALERT2 plan''s list finds the kept account by the second address, and adds it once',
    (select count(*) = 1 from meganet.a2plan_member where user_id = '00000000-0000-4000-8000-0000000a9002'), r::text);

  perform pg_temp.check_that('mail_address() is the second address while the person says so',
    meganet.mail_address('00000000-0000-4000-8000-0000000a9002') = 'am-work@am-bureau.test');
  r := pg_temp.json_as('keep', $q$select meganet.my_mail_to(null)::text$q$);
  perform pg_temp.check_that('the person sends it back to the address they sign in with',
    r ->> 'mail_to' = 'am-keep@example.invalid'
    and meganet.mail_address('00000000-0000-4000-8000-0000000a9002') = 'am-keep@example.invalid', r::text);
  r := pg_temp.json_as('keep', $q$select meganet.my_mail_to('AM-Work@am-bureau.test')::text$q$);
  perform pg_temp.check_that('…and to the second address again',
    r ->> 'mail_to' = 'am-work@am-bureau.test', r::text);
  perform pg_temp.check_that('nobody chooses an address that is not theirs (P0002)',
    pg_temp.as_who('owner', $q$select meganet.my_mail_to('am-work@am-bureau.test')$q$) = 'P0002');
  perform pg_temp.check_that('nor anybody signed out (42501)',
    pg_temp.as_who('anon', $q$select meganet.my_mail_to(null)$q$) = '42501');

  r := pg_temp.json_as('admin', 'select meganet.admin_users()::text');
  perform pg_temp.check_that('the Admin tab''s users list shows the second address with its account',
    exists (select 1 from pg_catalog.jsonb_array_elements(r) u
             where u ->> 'email' = 'am-keep@example.invalid'
               and u -> 'addresses' -> 0 ->> 'email' = 'am-work@am-bureau.test'), left(r::text, 400));

  perform pg_temp.check_that('only an administrator frees a second address',
    pg_temp.as_who('owner', $q$select meganet.admin_address_remove('am-work@am-bureau.test')$q$) = '42501');
  r := pg_temp.json_as('admin', $q$select meganet.admin_address_remove('am-work@am-bureau.test')::text$q$);
  perform pg_temp.check_that('an administrator frees it',
    not exists (select 1 from meganet.account_address where email = 'am-work@am-bureau.test')
    and meganet.mail_address('00000000-0000-4000-8000-0000000a9002') = 'am-keep@example.invalid', left(r::text, 200));
  begin
    insert into auth.users (id, email, email_confirmed_at)
    values ('00000000-0000-4000-8000-0000000a9013', 'am-work@am-bureau.test', now());
    v_state := 'ok';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.check_that('…and then it may be an account of its own again', v_state = 'ok', v_state);
end
$$;

-- ── The verdict ──────────────────────────────────────────────────────────────

select lpad(ord::text, 2) as "#",
       case when ok then 'ok  ' else 'FAIL' end as result,
       name,
       case when ok then '' else left(coalesce(note, ''), 200) end as detail
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
