-- 0100_one_person_two_addresses.sql — One person, one account: an account may
-- keep a second, confirmed address, and an administrator folds a person's
-- second account into their first.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0100_one_person_two_addresses.sql
--
-- …and then, for somebody with two accounts, an administrator presses *Same
-- person…* on the Admin tab's users table — or, from the SQL editor, a direct
-- connection, with the two accounts' ids:
--
--   select meganet.account_merge('<the account kept>', '<the account folded in>');
--
-- Why this file exists
-- ────────────────────
-- The owner had two accounts, a personal address signed in with Google and a
-- Bureau one, and with teams and tasks (0095) that is two people: a task
-- handed to one is not on the other's Tasks tab, a team's owner is only one
-- of them, and a colleague adding them by the Bureau address finds the
-- account they never sign in with. They asked (November 2026) to sign in
-- with Google and to keep the Bureau address "for notifications at least,
-- or unforeseen situations".
--
-- GoTrue keeps one address an account and cannot sign a second one in to
-- it, so the second address lives here, beside the account:
--
--   1. account_address    An account's other addresses — each one confirmed,
--                         because each arrived as a confirmed account of its
--                         own — and which of them, if any, Flood-Net's
--                         emails go to (mail_here). Private: RLS on, no
--                         policy, no grant; read through whoami(),
--                         admin_users() and a team's roster.
--   2. account_merge()    An administrator's: everything one account has —
--                         its teams and whether it owns them, the tasks it
--                         made and the notes it wrote, the ALERT2 plan's list,
--                         its devices, its visits — moves to the other, with
--                         whatever it could do (role, approval, editing); its
--                         address becomes the other's second address; and its
--                         sign-in is removed. A table this file does not know
--                         that still points at it stops the merge, rather than
--                         losing rows by cascade.
--   3. The gate           auth_user_gate() refuses to make an account for a
--                         second address, so the person who signs in with it
--                         by mistake is not made two people again. Freeing one
--                         is admin_address_remove().
--   4. By either address  team_member_save() and a2plan_member_save() find
--                         the account by a second address too.
--   5. Mail               send_account_mail() writes to mail_address(): the
--                         second address the person chose, else the one they
--                         sign in with. #216's alerts are to use it as well.
--   6. my_mail_to()       The person chooses, on *Your account*.
--
-- What it does not do: let anybody add a second address without an
-- administrator. Confirming one needs an email sent and a code typed; until
-- #237's mail is on, the honest way to prove an address is the one there is —
-- sign up with it, confirm it, and have an administrator fold that account in.
-- Nor do access checks read second addresses: is_member() and is_editor()
-- still ask the address the person signs in with, and a merge writes that
-- address onto the allowlist where the folded-in one was on it, so nothing
-- that decides access changes here.


-- ── 1. The table ─────────────────────────────────────────────────────────────

create table if not exists meganet.account_address (
  email         text        primary key,
  user_id       uuid        not null references auth.users (id) on delete cascade,
  mail_here     boolean     not null default false,
  confirmed_at  timestamptz not null,
  added_at      timestamptz not null default now(),
  added_by      text,
  constraint account_address_email_shape
    check (email = pg_catalog.lower(pg_catalog.btrim(email)) and email like '%_@_%')
);

comment on table meganet.account_address is
  'An account''s other addresses (0100): each confirmed (it arrived as a confirmed account of its own, folded in by account_merge()), and whether Flood-Net''s emails go to it (mail_here, one an account at most). Never an address anybody signs in with — auth_user_gate() refuses to make an account for one. Private: RLS on, no policy, no grant; read through whoami(), admin_users() and team_roster().';
comment on column meganet.account_address.mail_here is
  'Flood-Net''s emails to this person go here rather than to the address they sign in with (0100). mail_address() reads it; the person sets it with my_mail_to().';
comment on column meganet.account_address.confirmed_at is
  'When the address was confirmed — the email_confirmed_at of the account it came from (0100).';

create index if not exists account_address_user_idx on meganet.account_address (user_id);
create unique index if not exists account_address_one_mail_idx
  on meganet.account_address (user_id) where mail_here;

alter table meganet.account_address enable row level security;
-- No policy: read through the functions below alone, as team_member is (0095).


-- ── 2. Internals ─────────────────────────────────────────────────────────────

-- The account an address belongs to: the one that signs in with it, else the
-- one that keeps it as a second address.
create or replace function meganet.account_by_address(p_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select u.id
       from auth.users u
      where pg_catalog.lower(u.email) = pg_catalog.lower(pg_catalog.btrim(p_email))
      order by u.created_at
      limit 1),
    (select a.user_id
       from meganet.account_address a
      where a.email = pg_catalog.lower(pg_catalog.btrim(p_email))));
$$;

comment on function meganet.account_by_address(text) is
  'The account an address belongs to — the one that signs in with it, else the one keeping it as a second address (0100). Internal: the doors that add somebody by address call it.';

-- Where Flood-Net's emails to an account go.
create or replace function meganet.mail_address(p_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select a.email from meganet.account_address a where a.user_id = p_id and a.mail_here),
    (select u.email from auth.users u where u.id = p_id));
$$;

comment on function meganet.mail_address(uuid) is
  'Where Flood-Net''s emails to an account go (0100): the second address it chose (account_address.mail_here), else the one it signs in with. send_account_mail() writes to it, and #216''s alerts are to.';

-- An account's second addresses, oldest first.
create or replace function meganet.account_addresses(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'email',        a.email,
           'mail_here',    a.mail_here,
           'confirmed_at', a.confirmed_at)
         order by a.added_at, a.email), '[]'::jsonb)
    from meganet.account_address a
   where a.user_id = p_id;
$$;

comment on function meganet.account_addresses(uuid) is
  'An account''s second addresses, [{email, mail_here, confirmed_at}], oldest first (0100). Internal: whoami(), admin_users() and team_roster() call it.';


-- ── 3. The gate ──────────────────────────────────────────────────────────────

-- 0062's, and one more refusal: an address that is already somebody's second
-- address does not become an account of its own. GoTrue shows the person a
-- generic "Database error saving new user"; the panel words it (auth.js).
create or replace function meganet.auth_user_gate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is null or pg_catalog.btrim(new.email) = '' then
    raise exception 'Flood-Net: an account needs an email address, so none was created'
      using errcode = '42501';
  end if;
  if exists (select 1 from meganet.account_address a
              where a.email = pg_catalog.lower(pg_catalog.btrim(new.email))) then
    raise exception
      'Flood-Net: % is the second address of an existing account, so no account of its own was created', new.email
      using errcode = '42501',
            hint = 'The person signs in with that account. To let the address have an account of its own, an administrator frees it: meganet.admin_address_remove() (0100).';
  end if;
  if not meganet.signup_open() and not meganet.email_allowed(new.email) then
    raise exception
      'Flood-Net: sign-up is allowlist-only and % is not on meganet.editor_allow, so no account was created', new.email
      using errcode = '42501',
            hint = 'Add the address, or its domain with a leading @, to meganet.editor_allow — or open sign-up (app_meta signup = open). See docs/access.md.';
  end if;
  return new;
end;
$$;

comment on function meganet.auth_user_gate() is
  'BEFORE INSERT on auth.users: refuses an account with no address, one for an address that is already another account''s second address (0100), and — while sign-up is allowlist-only (app_meta signup) — an address that is not on meganet.editor_allow (0005, 0062, 0100).';


-- ── 4. Folding one account into another ─────────────────────────────────────

create or replace function meganet.account_merge(p_keep uuid, p_retire uuid, p_mail_here boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  k_email  text;
  k_conf   timestamptz;
  r_email  text;
  r_conf   timestamptz;
  k_app    meganet.app_user;
  r_app    meganet.app_user;
  k_stand  text;
  r_stand  text;
  v_by     text := meganet.actor();
  v_teams  integer := 0;
  v_owns   integer := 0;
  v_tasks  integer := 0;
  v_notes  integer := 0;
  v_push   integer := 0;
  v_left   boolean;
  v_allow  boolean := false;
  v_rank   constant jsonb := '{"viewer": 1, "editor": 2, "admin": 3}';
  fk       record;
begin
  perform meganet.admin_require();

  if p_keep is null or p_retire is null or p_keep = p_retire then
    raise exception 'name two different accounts: the one kept, and the one folded into it'
      using errcode = '22023';
  end if;

  select u.email, u.email_confirmed_at into k_email, k_conf from auth.users u where u.id = p_keep for update;
  if not found then
    raise exception 'there is no account to keep with that id' using errcode = 'P0002';
  end if;
  select u.email, u.email_confirmed_at into r_email, r_conf from auth.users u where u.id = p_retire for update;
  if not found then
    raise exception 'there is no account to fold in with that id' using errcode = 'P0002';
  end if;

  if meganet.admin_is_person() and p_retire = auth.uid() then
    raise exception 'that is the account you are signed in with — sign in with the one you are keeping, and fold this one into it there'
      using errcode = '42501';
  end if;
  if k_conf is null then
    raise exception '% has not confirmed its address, so it cannot be the account kept', k_email
      using errcode = '22023';
  end if;
  if r_conf is null then
    raise exception '% never confirmed its address, so nothing says the person holds it — delete that account instead', r_email
      using errcode = '22023';
  end if;
  if pg_catalog.lower(pg_catalog.btrim(k_email)) = pg_catalog.lower(pg_catalog.btrim(r_email)) then
    raise exception 'both accounts have the address %', k_email using errcode = '22023';
  end if;
  if exists (select 1 from meganet.account_address a
              where a.email = pg_catalog.lower(pg_catalog.btrim(r_email))
                and a.user_id not in (p_keep, p_retire)) then
    raise exception '% is already a second address of a third account', r_email using errcode = '23505';
  end if;

  k_stand := meganet.account_standing(p_keep);
  r_stand := meganet.account_standing(p_retire);
  if k_stand = 'declined' or r_stand = 'declined' then
    raise exception 'a declined account is not folded in or into — undo the decline first, if they are the same person'
      using errcode = '22023';
  end if;

  select * into k_app from meganet.app_user a where a.id = p_keep for update;
  select * into r_app from meganet.app_user a where a.id = p_retire for update;

  -- Whatever the folded-in account could do, the kept one can: the higher
  -- role, approval, and — through the allowlist, which is what is_editor()
  -- asks — editing.
  update meganet.app_user a
     set role = case when coalesce((v_rank ->> r_app.role)::int, 0) > coalesce((v_rank ->> a.role)::int, 0)
                     then r_app.role else a.role end,
         display_name = coalesce(nullif(pg_catalog.btrim(a.display_name), ''), r_app.display_name),
         status       = case when a.status = 'pending' and r_stand in ('approved', 'automatic')
                             then 'approved' else a.status end,
         decided_at   = case when a.status = 'pending' and r_stand in ('approved', 'automatic')
                             then pg_catalog.now() else a.decided_at end,
         decided_by   = case when a.status = 'pending' and r_stand in ('approved', 'automatic')
                             then 'the same person as ' || r_email else a.decided_by end,
         -- Approved by being the same person: nobody needs to be told.
         user_told_at = case when a.status = 'pending' and r_stand in ('approved', 'automatic')
                             then pg_catalog.now() else a.user_told_at end
   where a.id = p_keep;

  if meganet.email_allowed(r_email) and not meganet.email_allowed(k_email) then
    insert into meganet.editor_allow (entry, note, added_by)
    values (pg_catalog.lower(pg_catalog.btrim(k_email)),
            'The same person as ' || r_email || ', folded in (0100)', v_by)
    on conflict (entry) do nothing;
    v_allow := true;
  end if;

  -- Teams: on a team as both, one place on it, owning it if either did.
  update meganet.team_member k
     set is_owner = k.is_owner or r.is_owner,
         added_at = least(k.added_at, r.added_at)
    from meganet.team_member r
   where k.team_id = r.team_id and k.user_id = p_keep and r.user_id = p_retire;
  delete from meganet.team_member r
   where r.user_id = p_retire
     and exists (select 1 from meganet.team_member k where k.team_id = r.team_id and k.user_id = p_keep);
  update meganet.team_member set user_id = p_keep where user_id = p_retire;
  select count(*), count(*) filter (where m.is_owner) into v_teams, v_owns
    from meganet.team_member m where m.user_id = p_keep;
  update meganet.team_member set added_by   = p_keep where added_by   = p_retire;
  update meganet.team        set created_by = p_keep where created_by = p_retire;
  update meganet.task        set created_by = p_keep where created_by = p_retire;
  get diagnostics v_tasks = row_count;
  update meganet.task_note   set author_id  = p_keep where author_id  = p_retire;
  get diagnostics v_notes = row_count;

  -- The ALERT2 plan's list (0076): one place on it, nominating if either did.
  update meganet.a2plan_member k
     set nominates = k.nominates or r.nominates,
         added_at  = least(k.added_at, r.added_at)
    from meganet.a2plan_member r
   where k.user_id = p_keep and r.user_id = p_retire;
  delete from meganet.a2plan_member r
   where r.user_id = p_retire
     and exists (select 1 from meganet.a2plan_member k where k.user_id = p_keep);
  update meganet.a2plan_member   set user_id     = p_keep where user_id     = p_retire;
  update meganet.a2plan_member   set added_by    = p_keep where added_by    = p_retire;
  update meganet.a2plan_scenario set owner_id    = p_keep where owner_id    = p_retire;
  update meganet.a2plan_site     set updated_by  = p_keep where updated_by  = p_retire;
  update meganet.link_fade_margin set computed_by = p_keep where computed_by = p_retire;

  -- Devices and visits.
  update meganet.push_subscription set user_id = p_keep where user_id = p_retire;
  get diagnostics v_push = row_count;
  update meganet.app_visit set user_id = p_keep where user_id = p_retire;

  -- Left-bar views: the kept account's own, unless it has none.
  if not exists (select 1 from meganet.user_pref p where p.user_id = p_keep and p.nav_views is not null) then
    delete from meganet.user_pref p where p.user_id = p_keep;
    update meganet.user_pref set user_id = p_keep where user_id = p_retire;
  end if;
  delete from meganet.user_pref p where p.user_id = p_retire;

  -- Its own second addresses come too, none of them where mail goes yet.
  update meganet.account_address set user_id = p_keep, mail_here = false where user_id = p_retire;

  -- Nothing else may still point at it: a table added after this file, with
  -- a foreign key to auth.users, stops the merge here rather than losing its
  -- rows to the cascade below. app_user goes with the account, as it should.
  for fk in
    select c.conrelid::regclass::text as tbl, a.attname as col
      from pg_catalog.pg_constraint c
      join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
     where c.contype = 'f'
       and c.confrelid = 'auth.users'::regclass
       and c.connamespace <> 'auth'::regnamespace
       and c.conrelid <> 'meganet.app_user'::regclass
  loop
    execute pg_catalog.format('select exists (select 1 from %s where %I = $1)', fk.tbl, fk.col)
       into v_left using p_retire;
    if v_left then
      raise exception '%.% still refers to %, and account_merge() does not know how to move it — nothing was changed',
        fk.tbl, fk.col, r_email
        using errcode = '23503',
              hint = 'Teach account_merge() that table in a migration, then merge again.';
    end if;
  end loop;

  -- The sign-in goes, and its address stays — on the kept account.
  delete from auth.users u where u.id = p_retire;
  delete from meganet.app_user a where a.id = p_retire;

  insert into meganet.account_address (email, user_id, mail_here, confirmed_at, added_by)
  values (pg_catalog.lower(pg_catalog.btrim(r_email)), p_keep, false, r_conf, v_by)
  on conflict (email) do update
    set user_id = excluded.user_id, confirmed_at = excluded.confirmed_at, added_by = excluded.added_by;

  if p_mail_here then
    update meganet.account_address set mail_here = false where user_id = p_keep and mail_here;
    update meganet.account_address set mail_here = true
     where email = pg_catalog.lower(pg_catalog.btrim(r_email));
  end if;

  return pg_catalog.jsonb_build_object(
    'kept',       k_email,
    'folded_in',  r_email,
    'status',     meganet.account_standing(p_keep),
    'role',       (select a.role from meganet.app_user a where a.id = p_keep),
    'allowlisted', v_allow,
    'teams',      v_teams,
    'owns',       v_owns,
    'tasks',      v_tasks,
    'notes',      v_notes,
    'devices',    v_push,
    'mail_to',    meganet.mail_address(p_keep),
    'addresses',  meganet.account_addresses(p_keep));
end;
$$;

comment on function meganet.account_merge(uuid, uuid, boolean) is
  'Fold one person''s second account (p_retire) into their first (p_keep) (0100): its teams (owning where it owned), the tasks it made and notes it wrote, the ALERT2 plan''s list, its devices, visits and — where the kept one has none — its views move over; the kept account gets the higher role, approval and allowlisting where the other had them; its sign-in is deleted and its confirmed address becomes the kept account''s second address — where mail goes, with p_mail_here. Refuses an unconfirmed or declined account, yourself, and any table it does not know still pointing at the account. Administrators, or the owner from the SQL editor.';

-- An administrator frees a second address: it is no longer the account's,
-- and may sign up on its own again.
create or replace function meganet.admin_address_remove(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform meganet.admin_require();
  delete from meganet.account_address a where a.email = pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  if not found then
    raise exception '% is nobody''s second address', p_email using errcode = 'P0002';
  end if;
  return meganet.admin_users();
end;
$$;

comment on function meganet.admin_address_remove(text) is
  'Take a second address off whichever account keeps it, so that it may sign up as an account of its own again (0100). Administrators only; answers admin_users().';

-- The person chooses where Flood-Net's emails go: an address of their own,
-- or null (or the one they sign in with) for that one.
create or replace function meganet.my_mail_to(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mail text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
begin
  if auth.uid() is null or meganet.editor_email() is null then
    raise exception 'sign in with a confirmed account to choose where its emails go' using errcode = '42501';
  end if;
  if v_mail <> ''
     and v_mail <> pg_catalog.lower(meganet.editor_email())
     and not exists (select 1 from meganet.account_address a where a.user_id = auth.uid() and a.email = v_mail) then
    raise exception '% is not one of this account''s addresses', p_email using errcode = 'P0002';
  end if;
  update meganet.account_address set mail_here = false where user_id = auth.uid() and mail_here;
  update meganet.account_address set mail_here = true  where user_id = auth.uid() and email = v_mail;
  return meganet.whoami();
end;
$$;

comment on function meganet.my_mail_to(text) is
  'Where Flood-Net''s emails to the caller go: one of their second addresses, or null — or the address they sign in with — for that one (0100). Answers whoami().';


-- ── 5. By either address ─────────────────────────────────────────────────────

-- 0095's, finding the account by a second address too.
create or replace function meganet.team_member_save(p_team_id uuid, p_email text, p_owner boolean default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin boolean := meganet.is_admin();
  v_owner boolean;
  v_id    uuid;
  v_was   boolean;
  v_stand text;
  v_mail  text := pg_catalog.btrim(coalesce(p_email, ''));
begin
  if not meganet.is_member() then
    raise exception 'sign in with an approved account to change a team'
      using errcode = '42501';
  end if;
  if not exists (select 1 from meganet.team t where t.id = p_team_id) then
    raise exception 'no such team' using errcode = 'P0002';
  end if;
  v_owner := p_team_id = any (meganet.my_teams(true));
  if not v_admin and not v_owner then
    raise exception 'only the team''s owners, or an administrator, change who is on it'
      using errcode = '42501';
  end if;
  if not v_admin and coalesce(p_owner, false) then
    raise exception 'only an administrator names a team''s owners' using errcode = '42501';
  end if;
  if v_mail = '' then
    raise exception 'whose address?' using errcode = '22023';
  end if;
  v_id := meganet.account_by_address(v_mail);
  if v_id is null then
    raise exception 'nobody has a Flood-Net account as % — they sign up once, then you add them', v_mail
      using errcode = 'P0002';
  end if;
  v_stand := meganet.account_standing(v_id);
  if v_stand is null or v_stand not in ('approved', 'automatic') then
    raise exception '%''s account is not approved (%), so the team''s tasks would not open for them — an administrator approves it on the Admin tab first',
      v_mail, coalesce(v_stand, 'no account') using errcode = '22023';
  end if;

  select m.is_owner into v_was from meganet.team_member m where m.team_id = p_team_id and m.user_id = v_id;
  if found then
    if p_owner is not null and p_owner <> v_was then
      if not v_admin then
        raise exception 'only an administrator names a team''s owners' using errcode = '42501';
      end if;
      update meganet.team_member m set is_owner = p_owner where m.team_id = p_team_id and m.user_id = v_id;
    end if;
  else
    insert into meganet.team_member (team_id, user_id, is_owner, added_by)
    values (p_team_id, v_id, coalesce(p_owner, false), auth.uid());
  end if;
  return meganet.teams_read();
end;
$$;

comment on function meganet.team_member_save(uuid, text, boolean) is
  'Put an approved account on a team by its address — the one it signs in with or a second one (0100) — or make it an owner or not (null leaves that) (0095). An administrator does either; a team''s owner adds members to it, and names no owner. P0002 for an address with no account, 22023 for one not approved. Answers teams_read().';

-- 0076's, the same way.
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
  v_id := meganet.account_by_address(p_email);
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
  'Put an approved account on the ALERT2 Transition Plan''s list by its address — the one it signs in with or a second one (0100) — or change whether it may nominate (null leaves that) (0076). Refuses taking it from the last nominator. Nominators only; answers the list.';

-- 0095's roster, with each person's second addresses beside the one they
-- sign in with, to the people who see addresses.
create or replace function meganet.team_roster(p_team uuid, p_addresses boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id',       m.user_id,
           'who',      meganet.person_name(m.user_id),
           'email',    case when p_addresses then coalesce(u.email, au.email) end,
           'also',     case when p_addresses then
                         (select coalesce(pg_catalog.jsonb_agg(a.email order by a.added_at, a.email), '[]'::jsonb)
                            from meganet.account_address a where a.user_id = m.user_id) end,
           'owner',    m.is_owner,
           'you',      m.user_id = auth.uid(),
           'added_at', m.added_at,
           'added_by', meganet.person_name(m.added_by))
         order by m.is_owner desc, pg_catalog.lower(meganet.person_name(m.user_id))), '[]'::jsonb)
    from meganet.team_member m
    left join meganet.app_user u on u.id = m.user_id
    left join auth.users au on au.id = m.user_id
   where m.team_id = p_team;
$$;

comment on function meganet.team_roster(uuid, boolean) is
  'A team''s roster (0095), owners first, addresses only with p_addresses — the one each signs in with, and their second addresses (also, 0100). Granted to nobody: teams_read() and the team writers answer it after asking who is calling.';


-- ── 6. Mail ──────────────────────────────────────────────────────────────────

-- 0062's, writing to where each person's mail goes.
create or replace function meganet.send_account_mail()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_site    text := coalesce((select m.value from meganet.app_meta m where m.key = 'site_url'),
                             'https://floodwarning.net/');
  v_admins  text[];
  v_ids     uuid[];
  v_lines   text;
  v_n       integer;
  v_told    integer := 0;
  v_welcome integer := 0;
  r         record;
begin
  -- 1. The accounts waiting that the administrators have not heard about:
  --    confirmed, not approved by the allowlist, nobody has decided. One
  --    message to every administrator, however many there are.
  select pg_catalog.array_agg(a.id order by u.email_confirmed_at),
         pg_catalog.string_agg(
           '  • ' || a.email
             || coalesce(' — ' || nullif(a.display_name, ''), '')
             || ' (confirmed ' || pg_catalog.to_char(u.email_confirmed_at at time zone 'Australia/Brisbane', 'DD Mon HH24:MI') || ')',
           E'\n' order by u.email_confirmed_at),
         count(*)
    into v_ids, v_lines, v_n
    from meganet.app_user a
    join auth.users u on u.id = a.id
   where a.status = 'pending'
     and a.admins_told_at is null
     and u.email_confirmed_at is not null
     and not meganet.email_allowed(u.email);

  if v_n > 0 then
    select pg_catalog.array_agg(distinct meganet.mail_address(a.id))
      into v_admins
      from meganet.app_user a
      join auth.users u on u.id = a.id
     where a.role = 'admin'
       and a.status <> 'declined'
       and u.email_confirmed_at is not null;

    if meganet.account_mail_one(
         v_admins,
         case when v_n = 1 then 'Flood-Net: an account is waiting for your approval'
              else 'Flood-Net: ' || v_n || ' accounts are waiting for your approval' end,
         case when v_n = 1 then 'This account has confirmed its address and is waiting for an administrator:'
              else 'These accounts have confirmed their addresses and are waiting for an administrator:' end
           || E'\n\n' || v_lines || E'\n\n'
           || 'Approve or decline them on the Admin tab: ' || v_site || '?tab=admin' || E'\n\n'
           || 'Bureau addresses are approved without you; you hear only about the rest.') then
      update meganet.app_user set admins_told_at = pg_catalog.now() where id = any (v_ids);
      v_told := v_n;
    end if;
  end if;

  -- 2. The people an administrator approved, each told once.
  for r in
    select a.id, a.email, a.display_name
      from meganet.app_user a
      join auth.users u on u.id = a.id
     where a.status = 'approved'
       and a.user_told_at is null
       and u.email_confirmed_at is not null
     order by a.decided_at
     limit 20
  loop
    if meganet.account_mail_one(
         array[meganet.mail_address(r.id)],
         'Your Flood-Net account is approved',
         'Hello' || coalesce(' ' || nullif(r.display_name, ''), '') || E',\n\n'
           || 'An administrator has approved your Flood-Net account, so the field photos are yours to see now. '
           || 'Sign in at ' || v_site || ' with ' || r.email || '.' || E'\n\n'
           || 'Your left-bar views are saved to the account, so they follow you to every device you sign in on.') then
      update meganet.app_user set user_told_at = pg_catalog.now() where id = r.id;
      v_welcome := v_welcome + 1;
    end if;
  end loop;

  return jsonb_build_object('admins_told_about', v_told, 'approvals_sent', v_welcome);
end;
$$;

comment on function meganet.send_account_mail() is
  'Tell the administrators which confirmed accounts are waiting, in one message, and tell each person an administrator approved (0062) — each at mail_address(), the second address they chose or the one they sign in with (0100). Sends nothing until Vault holds resend_api_key. pg_cron every five minutes; the owner and service_role only.';


-- ── 7. Who sees it ───────────────────────────────────────────────────────────

-- 0099's (days, not browsers), with each account's second addresses.
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
             'addresses',       meganet.account_addresses(u.id),
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
  'Every app_user row with its second addresses (0100), its standing (0062), last sign-in, last seen, active sessions, on how many of the last 30 days it was used (0099: days, not browsers), and whether the allowlist lets it edit. Administrators only (0042, 0043, 0062, 0099, 0100).';

-- 0095's, with the caller's second addresses and where their mail goes.
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
    -- The account's other addresses, and where its emails go (0100).
    'addresses',    case when auth.uid() is not null then meganet.account_addresses(auth.uid()) else '[]'::jsonb end,
    'mail_to',      case when auth.uid() is not null then meganet.mail_address(auth.uid()) end,
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
    -- Teams and tasks (0095): the Tasks tab is listed by `tasks` — an
    -- administrator, somebody on a team, or somebody who made a task.
    'tasks',      auth.uid() is not null and meganet.is_member()
                  and (meganet.is_admin()
                       or pg_catalog.cardinality(meganet.my_teams(false)) > 0
                       or exists (select 1 from meganet.task k where k.created_by = auth.uid())),
    'hands_out',  auth.uid() is not null and meganet.hands_out_tasks(),
    'team_owner', auth.uid() is not null and pg_catalog.cardinality(meganet.my_teams(true)) > 0,
    'teams',      case when auth.uid() is not null then pg_catalog.cardinality(meganet.my_teams(false)) else 0 end,
    'schema_version', (select m.value from meganet.app_meta m where m.key = 'schema_version')
  );
$$;

comment on function meganet.whoami() is
  'Identity, standing, membership, write permission and administration as the database sees them, the caller''s second addresses and where their mail goes (addresses, mail_to — 0100), whether sign-up is open, to an administrator the accounts waiting for a decision, whether the caller is on the ALERT2 Transition Plan''s list and may nominate, and where they stand with teams and tasks — tasks, hands_out, team_owner, teams (0005, 0042, 0062, 0076, 0095, 0100). Anonymous callers get signed_in false rather than an error.';


-- ── Grants ───────────────────────────────────────────────────────────────────
-- Every new function revoked from public (db/README.md); the doors granted to
-- the roles a request can be, the internals to nobody. The functions replaced
-- above keep the grants they had.

revoke all on function meganet.account_by_address(text)            from public;
revoke all on function meganet.mail_address(uuid)                  from public;
revoke all on function meganet.account_addresses(uuid)             from public;
revoke all on function meganet.account_merge(uuid, uuid, boolean)  from public;
revoke all on function meganet.admin_address_remove(text)          from public;
revoke all on function meganet.my_mail_to(text)                    from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  revoke all on meganet.account_address from anon, authenticated;
  -- The Worker's alerts (#216) read where mail goes with the secret key.
  grant select on meganet.account_address to service_role;

  grant execute on function meganet.account_merge(uuid, uuid, boolean) to authenticated, service_role;
  grant execute on function meganet.admin_address_remove(text)         to authenticated, service_role;
  grant execute on function meganet.my_mail_to(text)                   to authenticated, service_role;
  grant execute on function meganet.mail_address(uuid)                 to service_role;

  notify pgrst, 'reload schema';
end
$$;

-- ── Proof it took ────────────────────────────────────────────────────────────

do $$
declare
  f text;
begin
  if pg_catalog.to_regclass('meganet.account_address') is null then
    raise exception '0100 did not take: meganet.account_address is missing';
  end if;
  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'meganet.account_address'::regclass) then
    raise exception '0100 did not take: RLS is off on meganet.account_address';
  end if;
  if exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'meganet.account_address'::regclass) then
    raise exception '0100 did not take: meganet.account_address has a policy — it is read through functions alone';
  end if;
  if pg_catalog.strpos(pg_catalog.pg_get_functiondef('meganet.auth_user_gate()'::regprocedure), 'account_address') = 0 then
    raise exception '0100 did not take: the gate still makes an account for a second address';
  end if;
  if pg_catalog.strpos(pg_catalog.pg_get_functiondef('meganet.team_member_save(uuid, text, boolean)'::regprocedure), 'account_by_address') = 0 then
    raise exception '0100 did not take: a team still finds people by the address they sign in with alone';
  end if;
  if pg_catalog.strpos(pg_catalog.pg_get_functiondef('meganet.send_account_mail()'::regprocedure), 'mail_address') = 0 then
    raise exception '0100 did not take: the account mail does not go where the person asked';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    if pg_catalog.has_table_privilege('anon', 'meganet.account_address', 'select,insert,update,delete')
       or pg_catalog.has_table_privilege('authenticated', 'meganet.account_address', 'select,insert,update,delete') then
      raise exception '0100 did not take: a browser can read or write meganet.account_address';
    end if;
  end if;
  foreach f in array array['meganet.account_by_address(text)', 'meganet.mail_address(uuid)',
                           'meganet.account_addresses(uuid)', 'meganet.account_merge(uuid, uuid, boolean)',
                           'meganet.admin_address_remove(text)', 'meganet.my_mail_to(text)'] loop
    if pg_catalog.has_function_privilege('public', f, 'execute') then
      raise exception '0100 did not take: public may execute %', f;
    end if;
    if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
       and pg_catalog.has_function_privilege('anon', f, 'execute') then
      raise exception '0100 did not take: anon may execute %', f;
    end if;
  end loop;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated')
     and (pg_catalog.has_function_privilege('authenticated', 'meganet.account_by_address(text)', 'execute')
          or pg_catalog.has_function_privilege('authenticated', 'meganet.account_addresses(uuid)', 'execute')
          or pg_catalog.has_function_privilege('authenticated', 'meganet.mail_address(uuid)', 'execute')) then
    raise exception '0100 did not take: a browser may look an address up without being asked who it is';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION goes to 100 once this is applied. The guard means
-- applying it out of order leaves the higher number.

insert into meganet.app_meta (key, value)
values ('schema_version', '100')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
