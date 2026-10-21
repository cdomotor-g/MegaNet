-- 0076_alert2_plan_list.sql — The ALERT2 Transition Plan for the people the
-- owner nominates, rather than for every administrator.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0076_alert2_plan_list.sql
--
-- …and then, once, the owner puts themselves on the list (the SQL editor is a
-- direct connection, which may), with the address they sign in with:
--
--   select meganet.a2plan_member_save('you@example.org', true);
--
-- Until that runs nobody sees the plan — not even an administrator.
--
-- Why this file exists
-- ────────────────────
-- 0065 gave the plan to every administrator. The owner asked for it to be seen
-- only by people they nominate, starting with themselves alone. So the plan
-- has a list — the one group 0065's foot foresaw — and every door into it asks
-- the list where it asked meganet.is_admin():
--
--   * a2plan_member: one row a person on the list. `nominates` is whether
--     they may put people on it and take them off; the owner's own row says
--     so, and a person they add does not unless they tick it. Administration
--     has nothing to do with it either way: an administrator who is not on the
--     list sees nothing, and a member who is sees the plan.
--   * Somebody on the list is an approved account (meganet.is_member()) as
--     well, so a decline or a ban takes the plan with it at once; a nominator
--     is refused an account that is not approved yet.
--   * The plan always has a nominator: the last one cannot be taken off the
--     list or lose it. The service key and a direct connection may do anything
--     here, and are how a mistake is undone.
--   * "Shared" scenarios (0065) are now shared with everybody on the list.
--     A shared scenario stays when its author leaves the list; their private
--     ones are seen by nobody until they are back.
--
-- Who
-- ───
--   * is_a2plan_member() and is_a2plan_nominator() — the two questions, the
--     same shape as is_admin(): anon never, service_role and a direct
--     connection always, an authenticated caller by the list.
--   * whoami() says both (a2plan, a2plan_nominates), and the app lists the
--     tab by them; a database before this file says neither, and the app goes
--     on asking is_admin, as 0065 does.
--   * a2plan_read() also answers the list — `people`, with who added each —
--     to everybody on it: they see who a shared scenario is shared with.
--   * a2plan_member_save() and a2plan_member_remove(): nominators only.
--   * The table: no browser role reads or writes it; RLS on, no policy.

-- ── 1. The list ──────────────────────────────────────────────────────────────

create table if not exists meganet.a2plan_member (
  user_id    uuid        primary key references auth.users (id) on delete cascade,
  nominates  boolean     not null default false,
  added_by   uuid        references auth.users (id) on delete set null,
  added_at   timestamptz not null default now()
);

comment on table meganet.a2plan_member is
  'Who sees the ALERT2 Transition Plan (0076): one row a person, nominated by the owner or by somebody they let nominate (nominates). Administration gives nothing here. Read through a2plan_read() and whoami(); written through a2plan_member_save() and a2plan_member_remove().';

alter table meganet.a2plan_member enable row level security;

-- ── 2. The two questions ─────────────────────────────────────────────────────
-- The role from the `role` GUC for is_admin()'s reason (0036): inside a
-- definer function current_user is the owner, and would wave everybody through.

create or replace function meganet.a2plan_may(p_nominate boolean)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  claims jsonb;
  v_role text;
begin
  claims := nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb;
  v_role := coalesce(nullif(pg_catalog.current_setting('role', true), 'none'),
                     claims ->> 'role',
                     current_user::text);

  if v_role in ('anon', 'authenticator') then
    return false;
  end if;
  if v_role = 'service_role' then
    return true;
  end if;
  if v_role = 'authenticated' then
    if auth.uid() is null or not meganet.is_member() then
      return false;
    end if;
    return exists (select 1 from meganet.a2plan_member m
                    where m.user_id = auth.uid() and (m.nominates or not p_nominate));
  end if;
  -- A direct connection: psql, the SQL editor, a migration.
  return true;
end;
$$;

comment on function meganet.a2plan_may(boolean) is
  'The ALERT2 Transition Plan''s list asked (0076): on it, or with p_nominate on it and allowed to nominate. anon never; service_role and a direct connection always; an authenticated caller by meganet.a2plan_member, and only while an approved account. Through is_a2plan_member() and is_a2plan_nominator().';

create or replace function meganet.is_a2plan_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$ select meganet.a2plan_may(false) $$;

comment on function meganet.is_a2plan_member() is
  'May the caller see the ALERT2 Transition Plan (0076)? On its list, an approved account — or the service key or a direct connection.';

create or replace function meganet.is_a2plan_nominator()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$ select meganet.a2plan_may(true) $$;

comment on function meganet.is_a2plan_nominator() is
  'May the caller put people on the ALERT2 Transition Plan''s list and take them off (0076)? On it with nominates — or the service key or a direct connection.';

-- ── 3. The plan's tables, read by the list ───────────────────────────────────

drop policy if exists a2plan_site_read_admins on meganet.a2plan_site;
drop policy if exists a2plan_site_read_list on meganet.a2plan_site;
create policy a2plan_site_read_list on meganet.a2plan_site
  for select to authenticated
  using ((select meganet.is_a2plan_member()));

drop policy if exists a2plan_scenario_read_own_or_shared on meganet.a2plan_scenario;
create policy a2plan_scenario_read_own_or_shared on meganet.a2plan_scenario
  for select to authenticated
  using ((select meganet.is_a2plan_member()) and (owner_id = (select auth.uid()) or shared));

comment on table meganet.a2plan_site is
  'What a repeater site needs before it carries ALERT2, as somebody on the plan''s list knows it (0065, 0076): fit (a fit-out only), retrofit (power, antenna, enclosure, earthing, access) or rebuild (the structure). One row a site; no row is "not assessed". Read through a2plan_read(), written through a2plan_site_set().';
comment on table meganet.a2plan_scenario is
  'A saved ALERT2 Transition Plan scenario (0065): the card''s settings as an object the app checks again on load, a name and notes. Private to owner_id until shared, then seen by everybody on the plan''s list (0076); only its owner changes or deletes it. Read through a2plan_read(), written through a2plan_scenario_save() and a2plan_scenario_delete().';

-- ── 4. The four doors of 0065, asking the list ───────────────────────────────
-- As 0065 wrote them but for the question and the words; `people` added to
-- the read.

create or replace function meganet.a2plan_read()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not meganet.is_a2plan_member() then
    raise exception 'the ALERT2 Transition Plan is for the people nominated to it' using errcode = '42501';
  end if;
  return pg_catalog.jsonb_build_object(
    'sites', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'station_id', s.station_id, 'condition', s.condition, 'updated_at', s.updated_at,
               'by', coalesce(nullif(pg_catalog.btrim(u.display_name), ''), u.email))
             order by s.station_id)
        from meganet.a2plan_site s
        left join meganet.app_user u on u.id = s.updated_by), '[]'::jsonb),
    'scenarios', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'id', c.id, 'name', c.name, 'notes', c.notes, 'shared', c.shared,
               'mine', c.owner_id = auth.uid(), 'by', coalesce(nullif(pg_catalog.btrim(u.display_name), ''), u.email),
               'settings', c.settings, 'created_at', c.created_at, 'updated_at', c.updated_at)
             order by c.updated_at desc, c.id)
        from meganet.a2plan_scenario c
        left join meganet.app_user u on u.id = c.owner_id
       where c.owner_id = auth.uid() or c.shared), '[]'::jsonb),
    'people', meganet.a2plan_people());
end;
$$;

comment on function meganet.a2plan_read() is
  'The ALERT2 Transition Plan''s shared state for somebody on its list (0065, 0076): {sites: [{station_id, condition, updated_at, by}], scenarios: [{id, name, notes, shared, mine, by, settings, created_at, updated_at}], people: [{id, who, email, nominates, you, added_at, added_by}]} — every site condition, the caller''s own scenarios and every shared one, and who is on the list.';

create or replace function meganet.a2plan_site_set(p_station_id text, p_condition text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  if not meganet.is_a2plan_member() then
    raise exception 'only somebody on the plan''s list may say what a site needs' using errcode = '42501';
  end if;
  if p_station_id is null or not exists (select 1 from meganet.station st where st.id = p_station_id) then
    raise exception 'no station %', coalesce(p_station_id, '(none)') using errcode = '22023';
  end if;
  if p_condition is null or p_condition = '' then
    delete from meganet.a2plan_site where station_id = p_station_id;
    return pg_catalog.jsonb_build_object('station_id', p_station_id, 'condition', null);
  end if;
  if p_condition not in ('fit', 'retrofit', 'rebuild') then
    raise exception 'a site condition is fit, retrofit or rebuild' using errcode = '22023';
  end if;
  insert into meganet.a2plan_site (station_id, condition, updated_by)
  values (p_station_id, p_condition, auth.uid())
  on conflict (station_id) do update
    set condition = excluded.condition, updated_by = excluded.updated_by;
  select pg_catalog.jsonb_build_object(
           'station_id', s.station_id, 'condition', s.condition, 'updated_at', s.updated_at,
           'by', coalesce(nullif(pg_catalog.btrim(u.display_name), ''), u.email))
    into v
    from meganet.a2plan_site s
    left join meganet.app_user u on u.id = s.updated_by
   where s.station_id = p_station_id;
  return v;
end;
$$;

comment on function meganet.a2plan_site_set(text, text) is
  'Set what a repeater site needs — fit, retrofit or rebuild — or clear it with null or '''' (0065). The plan''s list only (0076); everybody on it sees the same answer.';

create or replace function meganet.a2plan_scenario_save(
  p_id uuid, p_name text, p_notes text, p_shared boolean, p_settings jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row meganet.a2plan_scenario;
  v_by  text;
begin
  if auth.uid() is null or not meganet.is_a2plan_member() then
    raise exception 'only somebody on the plan''s list, signed in, may save a scenario' using errcode = '42501';
  end if;
  if p_name is not null and (pg_catalog.length(pg_catalog.btrim(p_name)) not between 1 and 80 or p_name ~ '[[:cntrl:]]') then
    raise exception 'a scenario''s name is 1–80 characters' using errcode = '22023';
  end if;
  if p_notes is not null and pg_catalog.length(p_notes) > 2000 then
    raise exception 'a scenario''s notes are at most 2,000 characters' using errcode = '22023';
  end if;
  if p_settings is not null and (pg_catalog.jsonb_typeof(p_settings) <> 'object'
                                 or pg_catalog.octet_length(p_settings::text) > 65536) then
    raise exception 'a scenario''s settings are an object of at most 64 KB' using errcode = '22023';
  end if;

  if p_id is null then
    if p_name is null or p_settings is null then
      raise exception 'a new scenario needs a name and its settings' using errcode = '22023';
    end if;
    if (select count(*) from meganet.a2plan_scenario c where c.owner_id = auth.uid()) >= 200 then
      raise exception 'at most 200 scenarios each — delete one first' using errcode = '22023';
    end if;
    insert into meganet.a2plan_scenario (owner_id, name, notes, shared, settings)
    values (auth.uid(), pg_catalog.btrim(p_name), nullif(pg_catalog.btrim(p_notes), ''), coalesce(p_shared, false), p_settings)
    returning * into v_row;
  else
    update meganet.a2plan_scenario c
       set name     = coalesce(pg_catalog.btrim(p_name), c.name),
           notes    = case when p_notes is null then c.notes else nullif(pg_catalog.btrim(p_notes), '') end,
           shared   = coalesce(p_shared, c.shared),
           settings = coalesce(p_settings, c.settings)
     where c.id = p_id and c.owner_id = auth.uid()
    returning * into v_row;
    if not found then
      if exists (select 1 from meganet.a2plan_scenario c where c.id = p_id and (c.shared or c.owner_id = auth.uid())) then
        raise exception 'only the person who saved a scenario may change it — save your own copy' using errcode = '42501';
      end if;
      raise exception 'no such scenario' using errcode = 'P0002';
    end if;
  end if;

  select coalesce(nullif(pg_catalog.btrim(u.display_name), ''), u.email) into v_by
    from meganet.app_user u where u.id = v_row.owner_id;
  return pg_catalog.jsonb_build_object(
    'id', v_row.id, 'name', v_row.name, 'notes', v_row.notes, 'shared', v_row.shared, 'mine', true, 'by', v_by,
    'settings', v_row.settings, 'created_at', v_row.created_at, 'updated_at', v_row.updated_at);
end;
$$;

comment on function meganet.a2plan_scenario_save(uuid, text, text, boolean, jsonb) is
  'Save an ALERT2 plan scenario (0065): p_id null makes a new one, private unless p_shared; otherwise its author changes it, a null argument leaving that field. The plan''s list only (0076).';

create or replace function meganet.a2plan_scenario_delete(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  if auth.uid() is null or not meganet.is_a2plan_member() then
    raise exception 'only somebody on the plan''s list, signed in, may remove a scenario' using errcode = '42501';
  end if;
  with gone as (
    delete from meganet.a2plan_scenario s
     where s.id = p_id and s.owner_id = auth.uid()
    returning 1)
  select count(*) into n from gone;
  if n > 0 then
    return true;
  end if;
  if exists (select 1 from meganet.a2plan_scenario s where s.id = p_id and s.shared) then
    raise exception 'only the person who saved a scenario may remove it' using errcode = '42501';
  end if;
  return false;
end;
$$;

comment on function meganet.a2plan_scenario_delete(uuid) is
  'Remove an ALERT2 plan scenario (0065), its author only; false when there was none to remove. The plan''s list only (0076).';

-- ── 5. The list, read and changed ────────────────────────────────────────────

-- Everybody on the list, nominators first. Not a door of its own: a2plan_read()
-- and the two writes below answer it, each having asked who is calling.
create or replace function meganet.a2plan_people()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id', m.user_id,
           'who', coalesce(nullif(pg_catalog.btrim(u.display_name), ''), u.email, au.email),
           'email', coalesce(u.email, au.email),
           'nominates', m.nominates,
           'you', m.user_id = auth.uid(),
           'added_at', m.added_at,
           'added_by', coalesce(nullif(pg_catalog.btrim(b.display_name), ''), b.email))
         order by m.nominates desc, pg_catalog.lower(coalesce(nullif(pg_catalog.btrim(u.display_name), ''), u.email, au.email))),
         '[]'::jsonb)
    from meganet.a2plan_member m
    left join meganet.app_user u on u.id = m.user_id
    left join auth.users au on au.id = m.user_id
    left join meganet.app_user b on b.id = m.added_by;
$$;

comment on function meganet.a2plan_people() is
  'The ALERT2 Transition Plan''s list (0076), nominators first. Granted to nobody: a2plan_read() and the list''s writes answer it after asking who is calling.';

-- Somebody put on the list, by the address they sign in with — or, already on
-- it, their nominates changed (null leaves it). Answers the whole list.
create or replace function meganet.a2plan_member_save(p_email text, p_nominates boolean default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id    uuid;
  v_was   boolean;
  v_stand text;
begin
  if not meganet.is_a2plan_nominator() then
    raise exception 'only somebody the owner lets nominate may change who sees the plan' using errcode = '42501';
  end if;
  if p_email is null or pg_catalog.btrim(p_email) = '' then
    raise exception 'whose address?' using errcode = '22023';
  end if;
  select u.id into v_id
    from auth.users u
   where pg_catalog.lower(u.email) = pg_catalog.lower(pg_catalog.btrim(p_email))
   order by u.created_at
   limit 1;
  if v_id is null then
    raise exception 'nobody has an account as % — they sign up once, then you add them', pg_catalog.btrim(p_email)
      using errcode = 'P0002';
  end if;
  v_stand := meganet.account_standing(v_id);
  if v_stand is null or v_stand not in ('approved', 'automatic') then
    raise exception '%''s account is not approved (%), so the plan would not open for them — an administrator approves it on the Admin tab first',
      pg_catalog.btrim(p_email), coalesce(v_stand, 'no account') using errcode = '22023';
  end if;

  select m.nominates into v_was from meganet.a2plan_member m where m.user_id = v_id;
  if found then
    if p_nominates is not null and p_nominates <> v_was then
      if not p_nominates and not exists (select 1 from meganet.a2plan_member m
                                          where m.nominates and m.user_id <> v_id) then
        raise exception 'that is the only person who may nominate — let somebody else first' using errcode = '42501';
      end if;
      update meganet.a2plan_member set nominates = p_nominates where user_id = v_id;
    end if;
  else
    insert into meganet.a2plan_member (user_id, nominates, added_by)
    values (v_id, coalesce(p_nominates, false), auth.uid());
  end if;
  return meganet.a2plan_people();
end;
$$;

comment on function meganet.a2plan_member_save(text, boolean) is
  'Put an approved account on the ALERT2 Transition Plan''s list by its address, or change whether it may nominate (null leaves that) (0076). Refuses taking it from the last nominator. Nominators only; answers the list.';

-- Somebody taken off the list. Not the last nominator; answers the list.
create or replace function meganet.a2plan_member_remove(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_nom boolean;
begin
  if not meganet.is_a2plan_nominator() then
    raise exception 'only somebody the owner lets nominate may change who sees the plan' using errcode = '42501';
  end if;
  select m.nominates into v_nom from meganet.a2plan_member m where m.user_id = p_user_id;
  if not found then
    return meganet.a2plan_people();
  end if;
  if v_nom and not exists (select 1 from meganet.a2plan_member m where m.nominates and m.user_id <> p_user_id) then
    raise exception 'that is the only person who may nominate — let somebody else first' using errcode = '42501';
  end if;
  delete from meganet.a2plan_member where user_id = p_user_id;
  return meganet.a2plan_people();
end;
$$;

comment on function meganet.a2plan_member_remove(uuid) is
  'Take somebody off the ALERT2 Transition Plan''s list (0076); their shared scenarios stay, their private ones wait. Refuses the last nominator. Nominators only; answers the list.';

-- ── 6. whoami ────────────────────────────────────────────────────────────────
-- 0062's, saying whether the caller is on the plan's list and may nominate.

create or replace function meganet.whoami()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'signed_in',    auth.uid() is not null,
    'email',        nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'email',
    'role',         (select u.role from meganet.app_user u where u.id = auth.uid()),
    'display_name', (select u.display_name from meganet.app_user u where u.id = auth.uid()),
    'may_write',    meganet.is_editor(),
    'is_admin',     auth.uid() is not null and meganet.is_admin(),
    'is_member',    auth.uid() is not null and meganet.is_member(),
    'status',       case when auth.uid() is not null then meganet.account_standing(auth.uid()) end,
    'signup',       case when meganet.signup_open() then 'open' else 'allowlist' end,
    -- To an administrator only: the accounts a decision is waiting on — the
    -- Admin tab's badge, and the nudge an administrator gets on arrival.
    'approvals_waiting', case when auth.uid() is not null and meganet.is_admin() then (
        select count(*)
          from meganet.app_user a
          join auth.users u on u.id = a.id
         where a.status = 'pending'
           and u.email_confirmed_at is not null
           and not meganet.email_allowed(u.email)) end,
    -- The ALERT2 Transition Plan's list (0076): the tab is listed by these.
    'a2plan',           auth.uid() is not null and meganet.is_a2plan_member(),
    'a2plan_nominates', auth.uid() is not null and meganet.is_a2plan_nominator(),
    'schema_version', (select m.value from meganet.app_meta m where m.key = 'schema_version')
  );
$$;

comment on function meganet.whoami() is
  'Identity, standing, membership, write permission and administration as the database sees them, whether sign-up is open, to an administrator the accounts waiting for a decision, and whether the caller is on the ALERT2 Transition Plan''s list and may nominate (0005, 0042, 0062, 0076). Anonymous callers get signed_in false rather than an error.';

-- ── Grants ───────────────────────────────────────────────────────────────────

revoke all on function meganet.a2plan_may(boolean)                 from public;
revoke all on function meganet.is_a2plan_member()                  from public;
revoke all on function meganet.is_a2plan_nominator()               from public;
revoke all on function meganet.a2plan_people()                     from public;
revoke all on function meganet.a2plan_member_save(text, boolean)   from public;
revoke all on function meganet.a2plan_member_remove(uuid)          from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  revoke all on meganet.a2plan_member from anon, authenticated;
  grant select, insert, update, delete on meganet.a2plan_member to service_role;
  -- The policies ask is_a2plan_member() as the caller, so authenticated may;
  -- a2plan_may() it asks as the owner.
  grant execute on function meganet.a2plan_may(boolean)               to service_role;
  grant execute on function meganet.is_a2plan_member()                to authenticated, service_role;
  grant execute on function meganet.is_a2plan_nominator()             to authenticated, service_role;
  grant execute on function meganet.a2plan_people()                   to service_role;
  grant execute on function meganet.a2plan_member_save(text, boolean) to authenticated, service_role;
  grant execute on function meganet.a2plan_member_remove(uuid)        to authenticated, service_role;

  notify pgrst, 'reload schema';
end
$$;

-- ── Proof it took ────────────────────────────────────────────────────────────

do $$
declare
  f text;
begin
  if pg_catalog.to_regclass('meganet.a2plan_member') is null then
    raise exception '0076 did not take: meganet.a2plan_member is missing';
  end if;
  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'meganet.a2plan_member'::regclass) then
    raise exception '0076 did not take: RLS is off on meganet.a2plan_member';
  end if;
  if exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'meganet.a2plan_site'::regclass
                                                    and p.polname = 'a2plan_site_read_admins') then
    raise exception '0076 did not take: a2plan_site is still read by every administrator';
  end if;
  if pg_catalog.strpos(pg_catalog.pg_get_functiondef('meganet.a2plan_read()'::regprocedure), 'is_a2plan_member') = 0 then
    raise exception '0076 did not take: a2plan_read() does not ask the list';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    if pg_catalog.has_table_privilege('anon', 'meganet.a2plan_member', 'select,insert,update,delete')
       or pg_catalog.has_table_privilege('authenticated', 'meganet.a2plan_member', 'select,insert,update,delete') then
      raise exception '0076 did not take: a browser role can read or write meganet.a2plan_member';
    end if;
  end if;
  foreach f in array array['meganet.a2plan_people()', 'meganet.a2plan_member_save(text, boolean)',
                           'meganet.a2plan_member_remove(uuid)'] loop
    if pg_catalog.has_function_privilege('public', f, 'execute') then
      raise exception '0076 did not take: public may execute %', f;
    end if;
    if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
       and pg_catalog.has_function_privilege('anon', f, 'execute') then
      raise exception '0076 did not take: anon may execute %', f;
    end if;
  end loop;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated')
     and pg_catalog.has_function_privilege('authenticated', 'meganet.a2plan_people()', 'execute') then
    raise exception '0076 did not take: a browser may read the list without being asked who it is';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 76 once this is applied. The guard means
-- applying it out of order leaves the higher number.

insert into meganet.app_meta (key, value)
values ('schema_version', '76')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
