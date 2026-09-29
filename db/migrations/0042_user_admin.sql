-- 0042_user_admin.sql — Managing people from the app's Admin tab: the users,
-- their roles, and the allowlist that decides who may sign in at all.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0042_user_admin.sql
--
-- Until this file, every one of these was a statement typed at a psql prompt
-- by the owner (docs/access.md, docs/field-photos.md "Administrators"): insert
-- into editor_allow to let somebody in, update app_user to make them an
-- administrator, delete from auth.users to take them out again. The Admin tab
-- (admin.js) does the same through the functions below, and nothing else.
--
-- ── What this adds ─────────────────────────────────────────────────────────────
--
--   1. editor_allow.initial_role — the role a person is given the first time
--      they sign in, so an administrator can be made before they ever arrive.
--      auth_user_sync() (0005) is restated to read it; it still never writes
--      role on an update, so a role changed later is never reset by a sign-in.
--   2. whoami() (0005) restated to say is_admin as well, so the app can offer
--      the Admin tab's controls without a second round trip.
--   3. Seven functions, every one refusing anybody meganet.is_admin() (0036)
--      says no to — anon never, an editor whose app_user row is not 'admin'
--      never, service_role and a direct connection always:
--        admin_users()                       list people, with last sign-in
--        admin_user_save(id, role, name)     change a role or display name
--        admin_user_delete(id, disallow)     remove a person (and their entry)
--        admin_allowlist()                   list the allowlist
--        admin_allow_save(entry, note, role) add or edit an entry
--        admin_allow_remove(entry)           remove an entry
--
-- ── The lockout guards ────────────────────────────────────────────────────────
--
-- An administrator cannot demote or delete themselves, cannot remove the last
-- administrator, and cannot remove the allowlist entry that is the only one
-- letting themselves in. Each would be one click in a browser that leaves the
-- database with nobody able to undo it except the owner at a psql prompt. The
-- owner (a direct connection) and the service key are not guarded: they are
-- what recovers from a mistake, and they have no app_user row to lose.
--
-- ── What "create a user" means here ───────────────────────────────────────────
--
-- A person becomes a user by signing in (0005's trigger provisions them); a
-- browser cannot mint an auth.users row and should not. So "add a user" is an
-- allowlist entry for their address, with the role they will have — the row in
-- app_user appears the first time they sign in, already carrying that role.
--
-- ── Viewer is still not enforced ──────────────────────────────────────────────
--
-- is_editor() asks editor_allow, not app_user.role, exactly as 0005 left it.
-- Setting somebody to 'viewer' records a wish; to stop somebody writing, take
-- their allowlist entry away. The Admin tab says this beside the role column.


-- ── 1. The role a new person arrives with ─────────────────────────────────────

alter table meganet.editor_allow
  add column if not exists initial_role text;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conname = 'editor_allow_initial_role_check') then
    alter table meganet.editor_allow
      add constraint editor_allow_initial_role_check
      check (initial_role is null or initial_role in ('viewer', 'editor', 'admin'));
  end if;
end
$$;

comment on column meganet.editor_allow.initial_role is
  'The app_user.role given the first time a matching address signs in (0042). An exact address wins over its domain; null means editor. Never applied again after that first sign-in.';

-- The role for an address arriving now: its own entry's, then its domain's,
-- then editor. Definer for the same reason email_allowed() is — the list stays
-- unreadable to anyone who might call it.
create or replace function meganet.initial_role_for(p_email text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select a.initial_role from meganet.editor_allow a
      where pg_catalog.lower(a.entry) = pg_catalog.lower(p_email)
        and a.initial_role is not null),
    (select a.initial_role from meganet.editor_allow a
      where pg_catalog.left(a.entry, 1) = '@'
        and pg_catalog.lower(p_email) like '%' || pg_catalog.lower(a.entry)
        and a.initial_role is not null
      order by pg_catalog.length(a.entry) desc
      limit 1),
    'editor');
$$;

comment on function meganet.initial_role_for(text) is
  'The role a first sign-in by this address is provisioned with: its own editor_allow entry''s initial_role, then its domain''s, then editor (0042).';

-- 0005's, with the role on insert read from the allowlist. The update branch is
-- unchanged: role is never touched once the row exists.
create or replace function meganet.auth_user_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into meganet.app_user (id, email, display_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name',
             new.raw_user_meta_data ->> 'name'),
    meganet.initial_role_for(new.email)
  )
  on conflict (id) do update
    set email        = excluded.email,
        display_name = coalesce(excluded.display_name, meganet.app_user.display_name);

  return new;
end;
$$;

comment on function meganet.auth_user_sync() is
  'AFTER INSERT/UPDATE on auth.users: provisions and keeps meganet.app_user in step. The role is set once, on insert, from editor_allow.initial_role (0042); never written on update.';


-- ── 2. whoami, saying whether this is an administrator ────────────────────────

create or replace function meganet.whoami()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'signed_in', auth.uid() is not null,
    'email',     nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'email',
    'role',      (select u.role from meganet.app_user u where u.id = auth.uid()),
    'may_write', meganet.is_editor(),
    'is_admin',  auth.uid() is not null and meganet.is_admin(),
    'schema_version', (select m.value from meganet.app_meta m where m.key = 'schema_version')
  );
$$;

comment on function meganet.whoami() is
  'Identity, write permission and administration as the database sees them. Anonymous callers get signed_in false rather than an error.';


-- ── 3. The Admin tab's functions ──────────────────────────────────────────────

create or replace function meganet.admin_require()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not meganet.is_admin() then
    raise exception 'only an administrator may manage users'
      using errcode = '42501',
            hint = 'An administrator is an editor whose meganet.app_user row says role = ''admin''.';
  end if;
end;
$$;

comment on function meganet.admin_require() is
  'Raise 42501 unless meganet.is_admin(). The first line of every admin_* function (0042).';

-- Is this request a signed-in person (and so subject to the lockout guards),
-- rather than the owner or the service key?
create or replace function meganet.admin_is_person()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select auth.uid() is not null
     and coalesce(nullif(pg_catalog.current_setting('role', true), 'none'), '') = 'authenticated';
$$;

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
             'may_edit',        meganet.email_allowed(u.email),
             'is_you',          u.id = auth.uid())
           order by pg_catalog.lower(u.email))
      from meganet.app_user u
      left join auth.users au on au.id = u.id), '[]'::jsonb);
end;
$$;

comment on function meganet.admin_users() is
  'Every app_user row with its last sign-in and whether the allowlist still lets it edit. Administrators only (0042).';

create or replace function meganet.admin_user_save(p_id uuid, p_role text, p_display_name text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row meganet.app_user;
begin
  perform meganet.admin_require();

  if p_role is null or p_role not in ('viewer', 'editor', 'admin') then
    raise exception 'role must be viewer, editor or admin — not %', coalesce(p_role, 'nothing')
      using errcode = '22023';
  end if;

  select * into v_row from meganet.app_user where id = p_id for update;
  if not found then
    raise exception 'no such user' using errcode = 'P0002';
  end if;

  if v_row.role = 'admin' and p_role <> 'admin' then
    if meganet.admin_is_person() and p_id = auth.uid() then
      raise exception 'you cannot take away your own administration — ask another administrator'
        using errcode = '42501';
    end if;
    if (select count(*) from meganet.app_user where role = 'admin') <= 1 then
      raise exception 'that is the last administrator — make somebody else one first'
        using errcode = '42501';
    end if;
  end if;

  update meganet.app_user
     set role         = p_role,
         display_name = nullif(pg_catalog.btrim(coalesce(p_display_name, '')), '')
   where id = p_id
  returning * into v_row;

  return pg_catalog.to_jsonb(v_row);
end;
$$;

comment on function meganet.admin_user_save(uuid, text, text) is
  'Set a person''s role and display name. Refuses demoting yourself or the last administrator. Administrators only (0042).';

create or replace function meganet.admin_user_delete(p_id uuid, p_disallow boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row  meganet.app_user;
  v_gone int := 0;
begin
  perform meganet.admin_require();

  select * into v_row from meganet.app_user where id = p_id for update;
  if not found then
    raise exception 'no such user' using errcode = 'P0002';
  end if;
  if meganet.admin_is_person() and p_id = auth.uid() then
    raise exception 'you cannot delete yourself' using errcode = '42501';
  end if;
  if v_row.role = 'admin' and (select count(*) from meganet.app_user where role = 'admin') <= 1 then
    raise exception 'that is the last administrator — make somebody else one first'
      using errcode = '42501';
  end if;

  -- The auth.users row is the person; app_user goes with it by cascade (0005).
  -- If they are only in app_user (auth is somebody else's schema), delete that.
  begin
    delete from auth.users where id = p_id;
  exception when foreign_key_violation then
    raise exception 'something still refers to this person, so they cannot be deleted — take their allowlist entry away instead'
      using errcode = '23503';
  end;
  delete from meganet.app_user where id = p_id;

  if p_disallow then
    delete from meganet.editor_allow where pg_catalog.lower(entry) = pg_catalog.lower(v_row.email);
    get diagnostics v_gone = row_count;
  end if;

  return jsonb_build_object('deleted', true, 'email', v_row.email,
                            'disallowed', v_gone > 0,
                            -- Still allowed through a domain entry: signing in again
                            -- would make them a user again.
                            'still_allowed', meganet.email_allowed(v_row.email));
end;
$$;

comment on function meganet.admin_user_delete(uuid, boolean) is
  'Delete a person (auth.users, and app_user with it), optionally with their own allowlist entry. Refuses yourself and the last administrator. Administrators only (0042).';

create or replace function meganet.admin_allowlist()
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
             'entry',        a.entry,
             'kind',         case when pg_catalog.left(a.entry, 1) = '@' then 'domain' else 'address' end,
             'note',         a.note,
             'initial_role', a.initial_role,
             'added_at',     a.added_at,
             'added_by',     a.added_by,
             'users',        (select count(*) from meganet.app_user u
                               where pg_catalog.lower(u.email) = pg_catalog.lower(a.entry)
                                  or (pg_catalog.left(a.entry, 1) = '@'
                                      and pg_catalog.lower(u.email) like '%' || pg_catalog.lower(a.entry))))
           order by pg_catalog.left(a.entry, 1) <> '@', pg_catalog.lower(a.entry))
      from meganet.editor_allow a), '[]'::jsonb);
end;
$$;

comment on function meganet.admin_allowlist() is
  'Every editor_allow entry with how many users it matches. Administrators only (0042).';

create or replace function meganet.admin_allow_save(p_entry text, p_note text default '', p_initial_role text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_entry, '')));
  v_row   meganet.editor_allow;
begin
  perform meganet.admin_require();

  if v_entry !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and v_entry !~ '^@[^@\s]+\.[^@\s]+$' then
    raise exception '"%" is neither an address (name@example.org) nor a domain (@example.org)', p_entry
      using errcode = '22023';
  end if;
  if p_initial_role is not null and p_initial_role not in ('viewer', 'editor', 'admin') then
    raise exception 'initial role must be viewer, editor, admin or empty — not %', p_initial_role
      using errcode = '22023';
  end if;

  insert into meganet.editor_allow (entry, note, added_by, initial_role)
  values (v_entry, coalesce(p_note, ''), meganet.actor(), p_initial_role)
  on conflict (entry) do update
    set note         = excluded.note,
        initial_role = excluded.initial_role
  returning * into v_row;

  return pg_catalog.to_jsonb(v_row);
end;
$$;

comment on function meganet.admin_allow_save(text, text, text) is
  'Add or edit an editor_allow entry (an address, or a domain with its at-sign), with the role a first sign-in gets. Administrators only (0042).';

create or replace function meganet.admin_allow_remove(p_entry text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me    text;
  v_entry text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_entry, '')));
begin
  perform meganet.admin_require();

  if meganet.admin_is_person() then
    v_me := (select u.email from meganet.app_user u where u.id = auth.uid());
    if v_me is not null
       and (pg_catalog.lower(v_me) = v_entry
            or (pg_catalog.left(v_entry, 1) = '@' and pg_catalog.lower(v_me) like '%' || v_entry))
       and not exists (
         select 1 from meganet.editor_allow a
          where pg_catalog.lower(a.entry) <> v_entry
            and (pg_catalog.lower(a.entry) = pg_catalog.lower(v_me)
                 or (pg_catalog.left(a.entry, 1) = '@'
                     and pg_catalog.lower(v_me) like '%' || pg_catalog.lower(a.entry)))) then
      raise exception 'that entry is the only one letting you in — removing it would lock you out'
        using errcode = '42501';
    end if;
  end if;

  delete from meganet.editor_allow where pg_catalog.lower(entry) = v_entry;
  return found;
end;
$$;

comment on function meganet.admin_allow_remove(text) is
  'Remove an editor_allow entry. Refuses the only entry letting the caller in. Administrators only (0042).';


-- ── Who may run what ─────────────────────────────────────────────────────────
-- EXECUTE defaults to PUBLIC on a new function; each is revoked and granted by
-- name. authenticated may call the admin_* functions — admin_require() is what
-- says no — so the refusal is an honest 42501 rather than a 404.

revoke all on function meganet.initial_role_for(text)                 from public;
revoke all on function meganet.admin_require()                        from public;
revoke all on function meganet.admin_is_person()                      from public;
revoke all on function meganet.admin_users()                          from public;
revoke all on function meganet.admin_user_save(uuid, text, text)      from public;
revoke all on function meganet.admin_user_delete(uuid, boolean)       from public;
revoke all on function meganet.admin_allowlist()                      from public;
revoke all on function meganet.admin_allow_save(text, text, text)     from public;
revoke all on function meganet.admin_allow_remove(text)               from public;
revoke all on function meganet.whoami()                               from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  grant execute on function meganet.whoami()                           to anon, authenticated, service_role;
  grant execute on function meganet.admin_is_person()                  to authenticated, service_role;
  grant execute on function meganet.admin_users()                      to authenticated, service_role;
  grant execute on function meganet.admin_user_save(uuid, text, text)  to authenticated, service_role;
  grant execute on function meganet.admin_user_delete(uuid, boolean)   to authenticated, service_role;
  grant execute on function meganet.admin_allowlist()                  to authenticated, service_role;
  grant execute on function meganet.admin_allow_save(text, text, text) to authenticated, service_role;
  grant execute on function meganet.admin_allow_remove(text)           to authenticated, service_role;

  notify pgrst, 'reload schema';
end
$$;


-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 41 → 42 in the same commit as this file.

insert into meganet.app_meta (key, value)
values ('schema_version', '42')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
