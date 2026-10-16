-- check_accounts.sql — Prove 0062 against a real database: anybody may make an
-- account, a Bureau address is approved as soon as it is confirmed and any
-- other waits, an approved account (a member) sees the field photos and reads
-- the inspection records with the site codes in them but cannot write one (0064), a
-- declined one is locked out at once, an administrator decides, sign-up can be
-- closed to the allowlist, and an account keeps its own left-bar views.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_accounts.sql
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
-- check starts from the same people (check_user_admin.sql's helper).
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

-- …and the same, keeping what the statement wrote: for a change whose effect a
-- later check reads (an approval, a decline, a saved view).
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
  reset role;
  perform pg_catalog.set_config('request.jwt.claims', '', true);
  return coalesce(v, '<null>');
end;
$$;

-- ── The people ───────────────────────────────────────────────────────────────
-- A Bureau-like domain on the allowlist; a council and a contractor that are
-- not. Sign-up is open (0062's default) for the inserts, as it is for a
-- stranger arriving.

update meganet.app_meta set value = 'open' where key = 'signup';

insert into meganet.editor_allow (entry, note) values
  ('@acc-bureau.test', 'check_accounts — rolled back')
on conflict (entry) do nothing;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000ac001', 'staff@acc-bureau.test',  now(), '{}'),
  ('00000000-0000-4000-8000-0000000ac002', 'pat@acc-council.test',   now(), '{"full_name":"  Pat\u0007 Example  "}'),
  ('00000000-0000-4000-8000-0000000ac003', 'unconf@acc-council.test', null, '{}'),
  ('00000000-0000-4000-8000-0000000ac004', 'admin@acc-bureau.test',  now(), '{}'),
  ('00000000-0000-4000-8000-0000000ac005', 'lee@acc-contract.test',  now(), '{}'),
  ('00000000-0000-4000-8000-0000000ac006', 'kim@acc-contract.test',  now(), '{}')
on conflict (id) do nothing;

-- Only this script's administrator, so its decisions are testable whatever the
-- database it runs against already holds.
update meganet.app_user set role = 'editor' where role = 'admin'
   and id <> '00000000-0000-4000-8000-0000000ac004';
update meganet.app_user set role = 'admin' where id = '00000000-0000-4000-8000-0000000ac004';

create temporary table _who (k text primary key, claims text) on commit drop;
insert into _who values
  ('anon',    '{"role":"anon"}'),
  ('staff',   '{"role":"authenticated","email":"staff@acc-bureau.test","sub":"00000000-0000-4000-8000-0000000ac001"}'),
  ('pat',     '{"role":"authenticated","email":"pat@acc-council.test","sub":"00000000-0000-4000-8000-0000000ac002"}'),
  ('unconf',  '{"role":"authenticated","email":"unconf@acc-council.test","sub":"00000000-0000-4000-8000-0000000ac003"}'),
  ('admin',   '{"role":"authenticated","email":"admin@acc-bureau.test","sub":"00000000-0000-4000-8000-0000000ac004"}'),
  ('lee',     '{"role":"authenticated","email":"lee@acc-contract.test","sub":"00000000-0000-4000-8000-0000000ac005"}'),
  ('kim',     '{"role":"authenticated","email":"kim@acc-contract.test","sub":"00000000-0000-4000-8000-0000000ac006"}'),
  ('service', '{"role":"service_role"}');

-- A live field photo and a removed one, for what a member sees.
insert into meganet.field_photo (id, storage_path, content_type, byte_size, sha256, uploaded_by)
values ('00000000-0000-4000-8000-0000000acf01', 'photo/00000000-0000-4000-8000-0000000acf01.jpg', 'image/jpeg', 10,
        repeat('a', 64), 'check_accounts')
on conflict do nothing;

-- A visit whose remark carries a site's gate code, for what a member reads (0064).
insert into meganet.inspection (id, config_key, inspected_on, remarks)
values ('00000000-0000-4000-8000-0000000acf11', 'alert', current_date,
        'Gate combination 0000 (check_accounts)')
on conflict do nothing;

-- ── 1. Sign-up ───────────────────────────────────────────────────────────────

do $$
declare v text; n int;
begin
  select count(*) into n from meganet.app_user
   where id in ('00000000-0000-4000-8000-0000000ac002', '00000000-0000-4000-8000-0000000ac003');
  perform pg_temp.check_that('sign-up open: an address on no list becomes an account', n = 2, n::text);

  select status into v from meganet.app_user where id = '00000000-0000-4000-8000-0000000ac002';
  perform pg_temp.check_that('…which waits: its status is pending until somebody decides', v = 'pending', v);

  select display_name into v from meganet.app_user where id = '00000000-0000-4000-8000-0000000ac002';
  perform pg_temp.check_that('…its name from the sign-up, trimmed and with no control characters', v = 'Pat Example', coalesce(v, '<null>'));

  v := pg_temp.as_role('anon', (select claims from _who where k = 'anon'), $q$select meganet.email_may_sign_in('someone@nowhere.test')::text$q$);
  perform pg_temp.check_that('the sign-in panel hears yes for any address while sign-up is open', v = 'true', v);

  v := pg_temp.as_role('anon', (select claims from _who where k = 'anon'), $q$select meganet.signup_check('x@acc-bureau.test')::text$q$);
  perform pg_temp.check_that('signup_check: a listed domain is approved automatically', v::jsonb @> '{"open":true,"automatic":true,"allowed":true}', v);

  v := pg_temp.as_role('anon', (select claims from _who where k = 'anon'), $q$select meganet.signup_check('x@acc-council.test')::text$q$);
  perform pg_temp.check_that('signup_check: any other may sign up, and waits', v::jsonb @> '{"open":true,"automatic":false,"allowed":true}', v);

  -- Closed: back to 0005's gate.
  update meganet.app_meta set value = 'allowlist' where key = 'signup';
  begin
    insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-4000-8000-0000000ac0ff', 'stranger@acc-nowhere.test', now());
    v := 'inserted';
  exception when others then
    v := 'ERROR ' || sqlstate;
  end;
  perform pg_temp.check_that('sign-up closed: an unlisted address is refused at the door', v = 'ERROR 42501', v);
  begin
    insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-4000-8000-0000000ac0fe', 'another@acc-bureau.test', now());
    v := 'inserted';
  exception when others then
    v := 'ERROR ' || sqlstate;
  end;
  perform pg_temp.check_that('…and a listed one still becomes an account', v = 'inserted', v);
  v := pg_temp.as_role('anon', (select claims from _who where k = 'anon'), $q$select meganet.email_may_sign_in('someone@nowhere.test')::text$q$);
  perform pg_temp.check_that('…and the sign-in panel hears no for the unlisted one', v = 'false', v);
  v := pg_temp.as_role('anon', (select claims from _who where k = 'anon'), $q$select meganet.signup_check('x@acc-council.test') ->> 'allowed'$q$);
  perform pg_temp.check_that('…as does signup_check', v = 'false', v);
  update meganet.app_meta set value = 'open' where key = 'signup';

  begin
    insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000ac0fd', null);
    v := 'inserted';
  exception when others then
    v := 'ERROR ' || sqlstate;
  end;
  perform pg_temp.check_that('an account with no address is refused, open or not', v = 'ERROR 42501', v);
end
$$;

-- ── 2. Members ───────────────────────────────────────────────────────────────

do $$
declare v text;
begin
  v := pg_temp.as_role('anon', (select claims from _who where k = 'anon'), 'select meganet.is_member()::text');
  perform pg_temp.check_that('anonymous is not a member', v = 'false', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'staff'), 'select meganet.is_member()::text');
  perform pg_temp.check_that('a confirmed address on the allowlist is a member, nobody having clicked', v = 'true', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'pat'), 'select meganet.is_member()::text');
  perform pg_temp.check_that('a confirmed address on no list is not, yet', v = 'false', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'unconf'), 'select meganet.is_member()::text');
  perform pg_temp.check_that('an address nobody confirmed is nothing', v = 'false', v);
  v := pg_temp.as_role('service_role', (select claims from _who where k = 'service'), 'select meganet.is_member()::text');
  perform pg_temp.check_that('the service key is', v = 'true', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'staff'),
         $q$select count(*)::text from meganet.field_photo where id = '00000000-0000-4000-8000-0000000acf01'$q$);
  perform pg_temp.check_that('a member reads a field photo', v = '1', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'pat'),
         $q$select count(*)::text from meganet.field_photo$q$);
  perform pg_temp.check_that('an account waiting for approval reads none', v = '0', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'staff'),
         $q$select remarks from meganet.inspection where id = '00000000-0000-4000-8000-0000000acf11'$q$);
  perform pg_temp.check_that('a member reads an inspection''s remarks, gate code and all (0064)', v like 'Gate combination%', coalesce(v, '<null>'));
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'pat'),
         $q$select count(*)::text from meganet.inspection$q$);
  perform pg_temp.check_that('an account waiting for approval reads no inspection', v = '0', v);
  v := pg_temp.as_role('anon', (select claims from _who where k = 'anon'), $q$select count(*)::text from meganet.inspection$q$);
  perform pg_temp.check_that('anonymous cannot read the inspections at all', v like 'ERROR%', v);
  v := pg_temp.as_role('anon', (select claims from _who where k = 'anon'), $q$select count(*)::text from meganet.field_photo$q$);
  perform pg_temp.check_that('anonymous cannot read the table at all', v like 'ERROR%', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'staff'), 'select meganet.whoami()::text');
  perform pg_temp.check_that('whoami: a Bureau address is a member, approved automatically, may write, sign-up open',
    v::jsonb @> '{"is_member":true,"status":"automatic","may_write":true,"signup":"open"}' and (v::jsonb -> 'approvals_waiting') = 'null', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'pat'), 'select meganet.whoami()::text');
  perform pg_temp.check_that('whoami: an address on no list is waiting, no member, no editor, its name said',
    v::jsonb @> '{"is_member":false,"status":"pending","may_write":false,"display_name":"Pat Example"}', v);
  v := pg_temp.as_role('anon', (select claims from _who where k = 'anon'), 'select meganet.whoami()::text');
  perform pg_temp.check_that('whoami: anonymous is no member, has no standing, and hears whether sign-up is open',
    v::jsonb @> '{"signed_in":false,"is_member":false,"signup":"open"}' and (v::jsonb -> 'status') = 'null', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'), $q$select meganet.whoami() ->> 'approvals_waiting'$q$);
  perform pg_temp.check_that('whoami: an administrator hears how many confirmed accounts wait',
    v::int = (select count(*) from meganet.app_user a join auth.users u on u.id = a.id
               where a.status = 'pending' and u.email_confirmed_at is not null and not meganet.email_allowed(u.email))
      and v::int >= 3, v);
end
$$;

-- ── 3. An administrator decides ──────────────────────────────────────────────

do $$
declare v text;
begin
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'staff'),
         $q$select meganet.admin_user_decide('00000000-0000-4000-8000-0000000ac002', 'approve')::text$q$);
  perform pg_temp.check_that('an editor who is not an administrator cannot decide', v = 'ERROR 42501', v);
  v := pg_temp.as_role('anon', (select claims from _who where k = 'anon'),
         $q$select meganet.admin_user_decide('00000000-0000-4000-8000-0000000ac002', 'approve')::text$q$);
  perform pg_temp.check_that('nor can anonymous', v like 'ERROR%', v);

  v := pg_temp.as_role_keep('authenticated', (select claims from _who where k = 'admin'),
         $q$select meganet.admin_user_decide('00000000-0000-4000-8000-0000000ac002', 'approve') ->> 'standing'$q$);
  perform pg_temp.check_that('an administrator approves: the account is approved', v = 'approved', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'pat'), 'select meganet.is_member()::text');
  perform pg_temp.check_that('…a member from that moment', v = 'true', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'pat'),
         $q$select count(*)::text from meganet.field_photo where id = '00000000-0000-4000-8000-0000000acf01'$q$);
  perform pg_temp.check_that('…who sees the field photo', v = '1', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'pat'), 'select meganet.is_editor()::text');
  perform pg_temp.check_that('…and is still not an editor', v = 'false', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'pat'),
         $q$select remarks from meganet.inspection where id = '00000000-0000-4000-8000-0000000acf11'$q$);
  perform pg_temp.check_that('…who reads the site''s codes in an inspection''s remarks (0064)', v like 'Gate combination%', coalesce(v, '<null>'));
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'pat'),
         $q$select meganet.save_inspection('{"config_key":"alert","inspected_on":"2026-10-16"}'::jsonb)::text$q$);
  perform pg_temp.check_that('…but cannot save one', v = 'ERROR 42501', v);
  select coalesce(decided_by, '<null>') || ' ' || (user_told_at is null)::text into v
    from meganet.app_user where id = '00000000-0000-4000-8000-0000000ac002';
  perform pg_temp.check_that('…the decision is the administrator''s, and the approval email is owed', v = 'admin@acc-bureau.test true', v);

  v := pg_temp.as_role_keep('authenticated', (select claims from _who where k = 'admin'),
         $q$select meganet.admin_user_decide('00000000-0000-4000-8000-0000000ac006', 'approve', true) ->> 'may_edit'$q$);
  perform pg_temp.check_that('Approve as editor puts the address on the allowlist', v = 'true', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'kim'), 'select meganet.is_editor()::text');
  perform pg_temp.check_that('…so it may edit', v = 'true', v);

  v := pg_temp.as_role_keep('authenticated', (select claims from _who where k = 'admin'),
         $q$select meganet.admin_user_decide('00000000-0000-4000-8000-0000000ac005', 'decline') ->> 'standing'$q$);
  perform pg_temp.check_that('an administrator declines: the account is declined', v = 'declined', v);
  select (banned_until > now() + interval '99 years')::text into v from auth.users where id = '00000000-0000-4000-8000-0000000ac005';
  perform pg_temp.check_that('…and banned in auth.users, so it cannot sign in or refresh', v = 'true', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'lee'), 'select coalesce(meganet.editor_email(), ''<null>'')');
  perform pg_temp.check_that('…and a token it already holds stops counting at once', v = '<null>', v);
  select coalesce(user_told_at is not null, false)::text into v from meganet.app_user where id = '00000000-0000-4000-8000-0000000ac005';
  perform pg_temp.check_that('…and nobody emails a stranger to say no', v = 'true', v);

  v := pg_temp.as_role_keep('authenticated', (select claims from _who where k = 'admin'),
         $q$select meganet.admin_user_decide('00000000-0000-4000-8000-0000000ac005', 'reset') ->> 'standing'$q$);
  perform pg_temp.check_that('reset undoes it: waiting again', v = 'pending', v);
  select coalesce(banned_until::text, '<null>') into v from auth.users where id = '00000000-0000-4000-8000-0000000ac005';
  perform pg_temp.check_that('…and unbanned', v = '<null>', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
         $q$select meganet.admin_user_decide('00000000-0000-4000-8000-0000000ac004', 'decline')::text$q$);
  perform pg_temp.check_that('an administrator cannot decline themselves', v = 'ERROR 42501', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
         $q$select meganet.admin_user_decide('00000000-0000-4000-8000-0000000ac002', 'banish')::text$q$);
  perform pg_temp.check_that('a decision that is not approve, decline or reset is refused', v = 'ERROR 22023', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
         $q$select meganet.admin_user_decide('00000000-0000-4000-8000-00000000ffff', 'approve')::text$q$);
  perform pg_temp.check_that('an account that does not exist is said so', v = 'ERROR P0002', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
         $q$select (select e ->> 'status' from jsonb_array_elements(meganet.admin_users()) e where e ->> 'email' = 'unconf@acc-council.test')$q$);
  perform pg_temp.check_that('the Admin tab hears an unconfirmed sign-up as unconfirmed', v = 'unconfirmed', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
         $q$select (select e ->> 'status' from jsonb_array_elements(meganet.admin_users()) e where e ->> 'email' = 'staff@acc-bureau.test')$q$);
  perform pg_temp.check_that('…and a Bureau address as approved automatically', v = 'automatic', v);

  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'staff'), 'select meganet.admin_set_signup(false)');
  perform pg_temp.check_that('only an administrator closes sign-up', v = 'ERROR 42501', v);
  v := pg_temp.as_role_keep('authenticated', (select claims from _who where k = 'admin'), 'select meganet.admin_set_signup(false)');
  perform pg_temp.check_that('an administrator closes it to the allowlist', v = 'allowlist' and not meganet.signup_open(), v);
  v := pg_temp.as_role_keep('authenticated', (select claims from _who where k = 'admin'), 'select meganet.admin_set_signup(true)');
  perform pg_temp.check_that('…and opens it again', v = 'open' and meganet.signup_open(), v);
end
$$;

-- ── 4. An account's own views ────────────────────────────────────────────────

do $$
declare v text;
  good text := '{"v":1,"current":"v-mine1","views":[{"id":"simple","preset":"simple"},{"id":"v-mine1","name":"Mine","groups":[{"name":"On site","tabs":["stations","lookaround"]}]}]}';
begin
  v := pg_temp.as_role('anon', (select claims from _who where k = 'anon'), format('select meganet.save_my_views(%L::jsonb)::text', good));
  perform pg_temp.check_that('anonymous cannot keep views', v like 'ERROR%', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'unconf'), format('select meganet.save_my_views(%L::jsonb)::text', good));
  perform pg_temp.check_that('nor can an address nobody confirmed', v = 'ERROR 42501', v);

  v := pg_temp.as_role_keep('authenticated', (select claims from _who where k = 'lee'), format('select meganet.save_my_views(%L::jsonb) ? ''updated_at''', good));
  perform pg_temp.check_that('any confirmed account keeps its views — one waiting for approval too', v = 'true', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'lee'), $q$select meganet.my_prefs() -> 'nav_views' ->> 'current'$q$);
  perform pg_temp.check_that('…and reads them back', v = 'v-mine1', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'staff'), $q$select coalesce(meganet.my_prefs() -> 'nav_views' ->> 'current', '<none>')$q$);
  perform pg_temp.check_that('…another account does not', v = '<none>', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'staff'), 'select count(*)::text from meganet.user_pref');
  perform pg_temp.check_that('…nor can it read the row through the table', v = '0', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'lee'),
         $q$insert into meganet.user_pref (user_id, nav_views) values ('00000000-0000-4000-8000-0000000ac001', '{}') returning 'written'$q$);
  perform pg_temp.check_that('no account writes the table except through save_my_views', v like 'ERROR%', v);
  v := pg_temp.as_role('anon', (select claims from _who where k = 'anon'), 'select meganet.my_prefs()::text');
  perform pg_temp.check_that('anonymous cannot ask for anybody''s', v like 'ERROR%', v);

  -- The shape.
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'lee'), $q$select meganet.save_my_views('[]'::jsonb)::text$q$);
  perform pg_temp.check_that('views that are not an object are refused', v = 'ERROR 22023', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'lee'), $q$select meganet.save_my_views('{"views":[{"id":"Bad Id","name":"x","groups":[]}]}')::text$q$);
  perform pg_temp.check_that('a view id that is not lower-case letters, digits and hyphens is refused', v = 'ERROR 22023', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'lee'), $q$select meganet.save_my_views('{"views":[{"id":"a","groups":[]},{"id":"a","groups":[]}]}')::text$q$);
  perform pg_temp.check_that('two views with one id are refused', v = 'ERROR 22023', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'lee'), $q$select meganet.save_my_views('{"views":[{"id":"a","preset":"desk"}]}')::text$q$);
  perform pg_temp.check_that('a preset that is not simple or field is refused', v = 'ERROR 22023', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'lee'),
         format('select meganet.save_my_views(%L::jsonb)::text', '{"views":[{"id":"a","name":"' || repeat('x', 41) || '","groups":[]}]}'));
  perform pg_temp.check_that('a name over 40 characters is refused', v = 'ERROR 22023', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'lee'), $q$select meganet.save_my_views('{"views":[{"id":"a","groups":[{"name":"G","tabs":["<script>"]}]}]}')::text$q$);
  perform pg_temp.check_that('a tab that is not a tab id''s shape is refused', v = 'ERROR 22023', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'lee'), $q$select meganet.save_my_views('{"views":[{"id":"a","groups":[{"name":"","tabs":[]}]}]}')::text$q$);
  perform pg_temp.check_that('a group with no name is refused', v = 'ERROR 22023', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'lee'),
         format('select meganet.save_my_views(%L::jsonb)::text',
                (select jsonb_build_object('views', jsonb_agg(jsonb_build_object('id', 'v' || i, 'preset', 'simple'))) from generate_series(1, 25) i)::text));
  perform pg_temp.check_that('more than 24 views are refused', v = 'ERROR 22023', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'lee'),
         format('select meganet.save_my_views(%L::jsonb)::text',
                jsonb_build_object('views', '[]'::jsonb, 'pad', repeat('x', 33000))::text));
  perform pg_temp.check_that('more than 32 KB is refused', v = 'ERROR 22023', v);
end
$$;

-- ── 5. What a stranger with an account cannot reach ──────────────────────────

do $$
declare v text;
begin
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'pat'), 'select meganet.station_status_converge()::text');
  perform pg_temp.check_that('an account cannot run the registry''s converge job (0019''s grant, gone)', v = 'ERROR 42501', v);
  v := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'), 'select meganet.send_account_mail()::text');
  perform pg_temp.check_that('no browser role sends account mail — not even an administrator', v = 'ERROR 42501', v);
  v := pg_temp.as_role('anon', (select claims from _who where k = 'anon'), 'select meganet.send_account_mail()::text');
  perform pg_temp.check_that('…nor anonymous', v = 'ERROR 42501', v);
  v := (meganet.send_account_mail())::text;
  perform pg_temp.check_that('the owner''s run sends nothing and errs at nothing without a key in the Vault',
    pg_catalog.to_regclass('vault.decrypted_secrets') is not null or v::jsonb = '{"admins_told_about":0,"approvals_sent":0}', v);
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
