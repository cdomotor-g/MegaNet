-- 0062_open_accounts_and_views.sql — Anyone may make an account. A Bureau
-- address is approved the moment it is confirmed; anybody else's waits for an
-- administrator, who is told. An approved account — a member — sees the field
-- photos. And every account keeps its own left-bar views.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0062_open_accounts_and_views.sql
--
-- Why this file exists
-- ────────────────────
-- Until now an account was a privilege handed out in advance: 0005's trigger
-- refused to create one for any address that was not on meganet.editor_allow,
-- so everybody holding a session was somebody the allowlist had already let
-- edit. That made "signed in" and "editor" the same people, and left nothing
-- between "may edit every station" and "may not even sign in" — no way to show
-- the field photos to a council officer or a contractor without also handing
-- them the station register. The owner asked for that middle (October 2026):
-- anybody may sign up with an email address and a password, the Bureau's own
-- addresses go straight through, and everybody else is approved by hand.
--
--   1. Sign-up is open — or, by one switch, allowlist-only again.
--      app_meta 'signup' is 'open' (the default) or 'allowlist'. Open, the
--      auth.users gate refuses only an account with no address; allowlist, it
--      refuses an unlisted address exactly as 0005 did. meganet.signup_open()
--      reads it; admin_set_signup() sets it from the Admin tab.
--   2. Standing. app_user.status records an administrator's decision —
--      pending (none yet), approved, declined — and who made it when. Approval
--      by the allowlist is NOT stored: it is worked out each time from the
--      confirmed address, so somebody who leaves the Bureau's domain stops
--      being approved by it, and a Bureau address needs nobody to click.
--   3. meganet.is_member(): the caller's address is confirmed, they are not
--      declined, and they are approved — by an administrator, or by the
--      allowlist. Every editor is a member; a member need not be an editor.
--   4. Declined means locked out. A decline also bans the account in
--      auth.users, so it cannot sign in or refresh a session, and
--      editor_email() (0054) stops answering for it, so a token it already
--      holds stops counting for is_editor() and is_member() at once.
--   5. The field photos are members' (0035 made them editors'). The rows here;
--      the bytes are signed by the Worker (worker/photos.js), which asks
--      rpc/is_member for a view and still rpc/is_editor to add or remove one.
--   6. whoami() says all of it: is_member, the caller's standing, their
--      display name, whether sign-up is open, and — to an administrator — how
--      many accounts are waiting.
--   7. The Admin tab decides: admin_user_decide() approves (optionally onto
--      the allowlist as an editor), declines, or puts an account back to
--      waiting; admin_users() says each account's standing.
--   8. An administrator is told. meganet.send_account_mail(), on pg_cron
--      every five minutes, emails the administrators one list of the accounts
--      that have confirmed their address and are waiting, and emails each
--      person an administrator approved. It sends through Resend's HTTP API
--      with a key kept in Supabase Vault (`resend_api_key`), and does nothing
--      at all until that secret exists — the Admin tab's badge and list work
--      without it. docs/accounts.md is the setup.
--   9. Views. meganet.user_pref holds an account's left-bar views
--      (nav-views.js); my_prefs() reads them back and save_my_views() checks
--      their shape and keeps them. One row per account, its own and nobody
--      else's.
--  10. One grant made safe for strangers. station_status_converge() (0019)
--      was granted to `authenticated` when that meant an allowlisted editor;
--      it is a registry job that tools/import_stations_json.py runs as the
--      owner, so the grant goes.
--
-- What does not change: who may edit. is_editor() still asks the allowlist,
-- and an account approved by hand is a member, not an editor, unless the
-- administrator also puts it on the allowlist (admin_user_decide's
-- p_make_editor does exactly that). Inspections, level surveys, site
-- features, a station's history and every other editors-only read stay
-- editors-only: each of those was decided on its own, and widening one is a
-- policy line of its own, not a side effect of this file.
--
-- Depends on 0004 (is_editor, actor), 0005 (app_user, the auth.users
-- triggers, whoami), 0035 (field_photo), 0042 (admin_require, admin_is_person),
-- 0043 (admin_users' last-seen columns, user_sessions), 0054 (editor_email).
-- tools/check_accounts.sql proves it.


-- ── 1. Sign-up: open, or allowlist only ──────────────────────────────────────

insert into meganet.app_meta (key, value)
values ('signup', 'open')
on conflict (key) do nothing;

create or replace function meganet.signup_open()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select m.value from meganet.app_meta m where m.key = 'signup'), 'open') = 'open';
$$;

comment on function meganet.signup_open() is
  'Whether anybody may create an account (app_meta signup = open, the default) or only an allowlisted address (allowlist). 0062.';

-- 0005's gate, with the allowlist test only while sign-up is closed. An
-- account with no address is still refused either way: everything downstream
-- — approval, the editors list, the mail — is keyed on one.
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
  'BEFORE INSERT on auth.users: refuses an account with no address, and — while sign-up is allowlist-only (app_meta signup) — an address that is not on meganet.editor_allow (0005, 0062).';

-- The sign-in panel's early answer (0005), for the same panel now that it
-- offers sign-up: yes for anybody while sign-up is open.
create or replace function meganet.email_may_sign_in(p_email text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select meganet.signup_open() or meganet.email_allowed(p_email);
$$;

comment on function meganet.email_may_sign_in(text) is
  'Yes/no for one address: yes for anybody while sign-up is open, else whether the allowlist lets it in. Callable anonymously so the sign-in panel can refuse before emailing. Deliberately an oracle; see 0005_auth.sql.';

-- What the Create account form says under the address as it is typed: whether
-- an account can be made for it at all, and whether it will be approved
-- without anybody clicking. The same oracle as the function above, one bit
-- wider, and for the same accepted reason: the domain it mostly says yes to is
-- written down in this public repository.
create or replace function meganet.signup_check(p_email text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'open',      meganet.signup_open(),
    'automatic', coalesce(meganet.email_allowed(p_email), false),
    'allowed',   meganet.signup_open() or coalesce(meganet.email_allowed(p_email), false));
$$;

comment on function meganet.signup_check(text) is
  'For the Create account form (0062): {open, automatic, allowed} — whether sign-up is open, whether this address is approved by the allowlist once confirmed, and whether an account can be made for it at all. Callable anonymously; an oracle like email_may_sign_in().';


-- ── 2. Standing ──────────────────────────────────────────────────────────────

-- Added, and everybody already here approved, in one step that only ever runs
-- once: a re-apply must not approve the accounts that have arrived since.
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'meganet' and table_name = 'app_user'
                    and column_name = 'status') then
    alter table meganet.app_user add column status text not null default 'pending';
    alter table meganet.app_user add column decided_at timestamptz;
    alter table meganet.app_user add column decided_by text;
    alter table meganet.app_user add column admins_told_at timestamptz;
    alter table meganet.app_user add column user_told_at timestamptz;
    -- Every account before this file was one the allowlist let in.
    update meganet.app_user
       set status = 'approved', decided_at = now(),
           decided_by = 'before sign-up opened (0062)', user_told_at = now();
  end if;
end
$$;

alter table meganet.app_user add column if not exists decided_at     timestamptz;
alter table meganet.app_user add column if not exists decided_by     text;
alter table meganet.app_user add column if not exists admins_told_at timestamptz;
alter table meganet.app_user add column if not exists user_told_at   timestamptz;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'app_user_status_check') then
    alter table meganet.app_user
      add constraint app_user_status_check check (status in ('pending', 'approved', 'declined'));
  end if;
end
$$;

comment on column meganet.app_user.status is
  'An administrator''s decision (0062): pending (none yet), approved or declined. Approval by the allowlist is not stored here — is_member() works it out from the confirmed address each time.';
comment on column meganet.app_user.admins_told_at is
  'When send_account_mail() told the administrators this account was waiting (0062). Null until then.';
comment on column meganet.app_user.user_told_at is
  'When send_account_mail() told this person an administrator had approved them (0062). Null until then.';

create index if not exists app_user_waiting_idx on meganet.app_user (created_at) where status = 'pending';

-- 0054's provisioning, with the name a stranger types at sign-up cleaned the
-- whole way: control characters out (as 0054 did), and now runs of spaces
-- made one and the ends trimmed, so "  Pat   Example " reaches the Admin tab as
-- "Pat Example" and a name of nothing but spaces is no name. Still set once,
-- on insert, and never from the user's own metadata again (L-11).
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
    nullif(
      pg_catalog.left(
        pg_catalog.btrim(
          pg_catalog.regexp_replace(
            pg_catalog.regexp_replace(
              coalesce(new.raw_user_meta_data ->> 'full_name',
                       new.raw_user_meta_data ->> 'name', ''),
              '[[:cntrl:]]', '', 'g'),
            '\s+', ' ', 'g')),
        60),
      ''),
    meganet.initial_role_for(new.email)
  )
  on conflict (id) do update
    -- Keep the email in step, but never let a later change to the user's own
    -- metadata overwrite the display name an admin controls (L-11).
    set email = excluded.email;

  return new;
end;
$$;

comment on function meganet.auth_user_sync() is
  'AFTER INSERT/UPDATE on auth.users: provisions and keeps meganet.app_user in step. The role is set once, on insert, from editor_allow.initial_role (0042); the display name once, on insert, cleaned of control characters and extra spaces (0054, 0062); never written on update.';

-- An account's standing, in one word, for whoami() and the Admin tab:
--   unconfirmed  the address has not been confirmed — nothing counts yet
--   declined     an administrator said no
--   approved     an administrator said yes
--   automatic    the allowlist says yes (a Bureau address, or one listed)
--   pending      waiting for an administrator
-- Definer because it reads auth.users; granted to nobody — the two functions
-- that call it are definers themselves.
create or replace function meganet.account_standing(p_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
           when u.id is null                  then null
           when u.email_confirmed_at is null  then 'unconfirmed'
           when a.status = 'declined'         then 'declined'
           when a.status = 'approved'         then 'approved'
           when meganet.email_allowed(u.email) then 'automatic'
           else 'pending'
         end
    from auth.users u
    left join meganet.app_user a on a.id = u.id
   where u.id = p_id;
$$;

comment on function meganet.account_standing(uuid) is
  'unconfirmed | declined | approved | automatic | pending — an account''s standing (0062). Called by whoami() and admin_users() only.';


-- ── 3 & 4. Members, and a decline that locks the door ─────────────────────────

-- 0054's, now also blind to a declined or banned account. Everything that asks
-- "who is this, really" — is_editor(), is_member() — asks through here, so a
-- decline takes effect on the token the person already holds, not only on the
-- next one they cannot get.
create or replace function meganet.editor_email()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select u.email
    from auth.users u
   where u.id = auth.uid()
     and u.email_confirmed_at is not null
     and (u.banned_until is null or u.banned_until <= pg_catalog.now())
     and not exists (select 1 from meganet.app_user a
                      where a.id = u.id and a.status = 'declined')
$$;

comment on function meganet.editor_email() is
  'The signed-in user''s email from auth.users, only when it is confirmed and the account is neither banned nor declined; else null (0054, 0062). SECURITY DEFINER so is_editor() and is_member() check the server-side truth, not a user-writable claim.';

create or replace function meganet.is_member()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  claims  jsonb;
  v_role  text;
  v_email text;
begin
  claims := nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb;
  -- The role GUC, as is_editor() and is_admin() read it: under a definer
  -- function current_user is the owner, and the GUC still names the caller.
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
    -- Confirmed, not banned, not declined — or null.
    v_email := meganet.editor_email();
    if v_email is null then
      return false;
    end if;
    return meganet.email_allowed(v_email)
        or exists (select 1 from meganet.app_user a
                    where a.id = auth.uid() and a.status = 'approved');
  end if;

  -- A direct connection: psql, a migration, a scheduled job.
  return true;
end;
$$;

comment on function meganet.is_member() is
  'Whether the caller is an approved account (0062): confirmed, not declined or banned, and approved by an administrator or by the allowlist. Every editor is a member. anon never; service_role and a direct connection always.';


-- ── 5. The field photos are members' ─────────────────────────────────────────

drop policy if exists field_photo_read_editors on meganet.field_photo;
drop policy if exists field_photo_read_members on meganet.field_photo;
-- In a sub-select so that it is asked once a query rather than once a row.
create policy field_photo_read_members on meganet.field_photo
  for select to authenticated
  using ((select meganet.is_member()) and deleted_at is null);


-- ── 6. whoami ────────────────────────────────────────────────────────────────

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
    'schema_version', (select m.value from meganet.app_meta m where m.key = 'schema_version')
  );
$$;

comment on function meganet.whoami() is
  'Identity, standing, membership, write permission and administration as the database sees them, whether sign-up is open, and to an administrator the accounts waiting for a decision (0005, 0042, 0062). Anonymous callers get signed_in false rather than an error.';


-- ── 7. The Admin tab decides ─────────────────────────────────────────────────

-- 0043's, with each account's standing, when it confirmed its address, whether
-- it is a member, and who decided and when.
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
                        count(*) filter (where a.day > current_date - 30) as days
                   from meganet.app_visit a
                  where a.user_id is not null
                  group by a.user_id) v on v.user_id = u.id), '[]'::jsonb);
end;
$$;

comment on function meganet.admin_users() is
  'Every app_user row with its standing (0062), last sign-in, last seen, active sessions, and whether the allowlist lets it edit. Administrators only (0042, 0043, 0062).';

-- One decision about one account:
--   approve  a member from now on. With p_make_editor, its address also goes on
--            the allowlist (initial role editor), so it may edit as well.
--   decline  locked out: declined here, and banned in auth.users so that it
--            cannot sign in or refresh. Not yourself, not the last
--            administrator.
--   reset    back to waiting, unbanned — the undo for either.
create or replace function meganet.admin_user_decide(
  p_id          uuid,
  p_decision    text,
  p_make_editor boolean default false,
  p_note        text    default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row  meganet.app_user;
  v_note text := nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p_note, '')), 200), '');
begin
  perform meganet.admin_require();

  if p_decision is null or p_decision not in ('approve', 'decline', 'reset') then
    raise exception 'a decision is approve, decline or reset — not %', coalesce(p_decision, 'nothing')
      using errcode = '22023';
  end if;

  select * into v_row from meganet.app_user where id = p_id for update;
  if not found then
    raise exception 'no such account' using errcode = 'P0002';
  end if;

  if p_decision = 'decline' then
    if meganet.admin_is_person() and p_id = auth.uid() then
      raise exception 'you cannot decline your own account' using errcode = '42501';
    end if;
    if v_row.role = 'admin' and (select count(*) from meganet.app_user where role = 'admin' and status <> 'declined') <= 1 then
      raise exception 'that is the last administrator — make somebody else one first' using errcode = '42501';
    end if;
  end if;

  update meganet.app_user
     set status       = case p_decision when 'approve' then 'approved'
                                        when 'decline' then 'declined'
                                        else 'pending' end,
         decided_at   = case when p_decision = 'reset' then null else pg_catalog.now() end,
         decided_by   = case when p_decision = 'reset' then null else meganet.actor() end,
         -- The approval email goes once, for an approval by a person; a
         -- decline is never mailed (a stranger's sign-up is not owed one).
         user_told_at = case p_decision when 'approve' then null else pg_catalog.now() end,
         -- Back to waiting is waiting again: the administrators hear of it again.
         admins_told_at = case when p_decision = 'reset' then null else admins_told_at end
   where id = p_id
  returning * into v_row;

  update auth.users
     set banned_until = case when p_decision = 'decline'
                             then pg_catalog.now() + interval '100 years' end
   where id = p_id;

  if p_decision = 'approve' and coalesce(p_make_editor, false)
     and not meganet.email_allowed(v_row.email) then
    insert into meganet.editor_allow (entry, note, added_by, initial_role)
    values (pg_catalog.lower(v_row.email),
            coalesce(v_note, 'Approved from the Admin tab'), meganet.actor(), 'editor')
    on conflict (entry) do nothing;
  end if;

  return pg_catalog.to_jsonb(v_row)
      || jsonb_build_object('standing', meganet.account_standing(p_id),
                            'may_edit', meganet.email_allowed(v_row.email));
end;
$$;

comment on function meganet.admin_user_decide(uuid, text, boolean, text) is
  'Approve (optionally onto the allowlist as an editor), decline (and ban in auth.users) or reset an account (0062). Refuses declining yourself or the last administrator. Administrators only.';

-- The switch behind §1, from the Admin tab.
create or replace function meganet.admin_set_signup(p_open boolean)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform meganet.admin_require();
  if p_open is null then
    raise exception 'say whether sign-up is open, true or false' using errcode = '22023';
  end if;
  insert into meganet.app_meta (key, value)
  values ('signup', case when p_open then 'open' else 'allowlist' end)
  on conflict (key) do update set value = excluded.value, updated_at = pg_catalog.now();
  return case when p_open then 'open' else 'allowlist' end;
end;
$$;

comment on function meganet.admin_set_signup(boolean) is
  'Open sign-up to anybody (true) or close it to the allowlist (false): app_meta signup (0062). Administrators only.';


-- ── 8. An administrator is told ──────────────────────────────────────────────

-- One message through Resend's HTTP API. False — never an error — when there
-- is no key in the Vault, no http extension, or Resend says no: the caller
-- leaves whatever it was telling somebody to the next run.
create or replace function meganet.account_mail_one(p_to text[], p_subject text, p_text text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key    text;
  v_from   text := coalesce((select m.value from meganet.app_meta m where m.key = 'mail_from'),
                            'Flood-Net <noreply@floodwarning.net>');
  v_status integer;
begin
  if p_to is null or pg_catalog.cardinality(p_to) = 0 then
    return false;
  end if;
  if pg_catalog.to_regclass('vault.decrypted_secrets') is null
     or pg_catalog.to_regprocedure('extensions.http(extensions.http_request)') is null then
    return false;
  end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 order by created_at desc limit 1'
     into v_key using 'resend_api_key';
  if coalesce(pg_catalog.btrim(v_key), '') = '' then
    return false;
  end if;

  begin
    perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '15');
    execute $q$
      select (extensions.http((
        'POST', 'https://api.resend.com/emails',
        array[extensions.http_header('Authorization', 'Bearer ' || $1)],
        'application/json', $2)::extensions.http_request)).status
    $q$ into v_status
      using v_key,
            jsonb_build_object('from', v_from, 'to', pg_catalog.to_jsonb(p_to),
                               'subject', p_subject, 'text', p_text)::text;
  exception when others then
    raise warning 'Flood-Net account mail: % (%)', sqlerrm, sqlstate;
    return false;
  end;

  if v_status between 200 and 299 then
    return true;
  end if;
  raise warning 'Flood-Net account mail: Resend answered HTTP %', v_status;
  return false;
end;
$$;

comment on function meganet.account_mail_one(text[], text, text) is
  'Send one plain-text email through Resend with the Vault secret resend_api_key (0062). False, never an error, when there is no key, no http extension, or Resend refuses. send_account_mail() only.';

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
    select pg_catalog.array_agg(distinct u.email)
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
         array[r.email],
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
  'Tell the administrators which confirmed accounts are waiting, in one message, and tell each person an administrator approved (0062). Sends nothing until Vault holds resend_api_key. pg_cron every five minutes; the owner and service_role only.';


-- ── 9. Views ─────────────────────────────────────────────────────────────────

create table if not exists meganet.user_pref (
  user_id     uuid        primary key references auth.users (id) on delete cascade,
  nav_views   jsonb,
  updated_at  timestamptz not null default now(),
  constraint user_pref_nav_views_size check (nav_views is null or pg_catalog.octet_length(nav_views::text) <= 32768)
);

comment on table meganet.user_pref is
  'One row per account: what it keeps for itself across devices (0062). nav_views is the left bar''s views (nav-views.js). Read through my_prefs(), written through save_my_views() — your own row and nobody else''s.';

drop trigger if exists user_pref_touch_updated_at on meganet.user_pref;
create trigger user_pref_touch_updated_at
  before update on meganet.user_pref
  for each row execute function meganet.touch_updated_at();

alter table meganet.user_pref enable row level security;

drop policy if exists user_pref_read_own on meganet.user_pref;
create policy user_pref_read_own on meganet.user_pref
  for select to authenticated
  using (user_id = auth.uid());

create or replace function meganet.my_prefs()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when auth.uid() is null then null else coalesce(
    (select jsonb_build_object('nav_views', p.nav_views, 'updated_at', p.updated_at)
       from meganet.user_pref p
      where p.user_id = auth.uid()),
    jsonb_build_object('nav_views', null, 'updated_at', null)) end;
$$;

comment on function meganet.my_prefs() is
  'The caller''s own user_pref row as {nav_views, updated_at}, or nulls if they have kept nothing yet; null when signed out (0062).';

-- The shape, checked here because a browser is free to send anything:
--   { "v": 1, "current": "<id>"?, "views": [ <view>, … ] }   at most 24 views
--   <view> = { "id": "simple" | "field" | "v-…", "name": "…"?,
--              "preset": "simple" | "field"?, "groups": [ <group>, … ]? }
--   <group> = { "name": "…", "tabs": ["stations", …] }       at most 30 a view
--                                                            and 80 tabs a group
-- Names are 1–40 characters with no control characters; an id is lower-case
-- letters, digits and hyphens; a tab is a tab id's shape (whether the app has
-- such a tab is the app's business — it skips one it does not know).
create or replace function meganet.save_my_views(p_views jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_view  jsonb;
  v_group jsonb;
  v_tab   jsonb;
  v_name  text;
  v_ids   text[] := '{}';
  v_at    timestamptz;
begin
  if auth.uid() is null or meganet.editor_email() is null then
    raise exception 'sign in to keep views' using errcode = '42501';
  end if;
  if p_views is null or pg_catalog.jsonb_typeof(p_views) <> 'object' then
    raise exception 'views are an object' using errcode = '22023';
  end if;
  if pg_catalog.octet_length(p_views::text) > 32768 then
    raise exception 'views are at most 32 KB' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(p_views -> 'views') is distinct from 'array'
     or pg_catalog.jsonb_array_length(p_views -> 'views') > 24 then
    raise exception 'views.views is a list of at most 24' using errcode = '22023';
  end if;
  if p_views ? 'current' and pg_catalog.jsonb_typeof(p_views -> 'current') <> 'null'
     and (pg_catalog.jsonb_typeof(p_views -> 'current') <> 'string'
          or (p_views ->> 'current') !~ '^[a-z0-9][a-z0-9-]{0,39}$') then
    raise exception 'views.current is a view id' using errcode = '22023';
  end if;

  for v_view in select x from pg_catalog.jsonb_array_elements(p_views -> 'views') x loop
    if pg_catalog.jsonb_typeof(v_view) <> 'object'
       or pg_catalog.jsonb_typeof(v_view -> 'id') is distinct from 'string'
       or (v_view ->> 'id') !~ '^[a-z0-9][a-z0-9-]{0,39}$' then
      raise exception 'every view has an id of lower-case letters, digits and hyphens' using errcode = '22023';
    end if;
    if (v_view ->> 'id') = any (v_ids) then
      raise exception 'two views are called %', v_view ->> 'id' using errcode = '22023';
    end if;
    v_ids := v_ids || (v_view ->> 'id');
    if v_view ? 'preset' and pg_catalog.jsonb_typeof(v_view -> 'preset') <> 'null'
       and (v_view ->> 'preset') not in ('simple', 'field') then
      raise exception 'a view''s preset is simple or field' using errcode = '22023';
    end if;
    if v_view ? 'name' and pg_catalog.jsonb_typeof(v_view -> 'name') <> 'null' then
      v_name := v_view ->> 'name';
      if pg_catalog.jsonb_typeof(v_view -> 'name') <> 'string'
         or pg_catalog.length(pg_catalog.btrim(v_name)) not between 1 and 40
         or v_name ~ '[[:cntrl:]]' then
        raise exception 'a view''s name is 1–40 characters' using errcode = '22023';
      end if;
    end if;
    if v_view ? 'groups' and pg_catalog.jsonb_typeof(v_view -> 'groups') <> 'null' then
      if pg_catalog.jsonb_typeof(v_view -> 'groups') <> 'array'
         or pg_catalog.jsonb_array_length(v_view -> 'groups') > 30 then
        raise exception 'a view''s groups are a list of at most 30' using errcode = '22023';
      end if;
      for v_group in select g from pg_catalog.jsonb_array_elements(v_view -> 'groups') g loop
        v_name := v_group ->> 'name';
        if pg_catalog.jsonb_typeof(v_group) <> 'object'
           or pg_catalog.jsonb_typeof(v_group -> 'name') is distinct from 'string'
           or pg_catalog.length(pg_catalog.btrim(v_name)) not between 1 and 40
           or v_name ~ '[[:cntrl:]]' then
          raise exception 'every group has a name of 1–40 characters' using errcode = '22023';
        end if;
        if pg_catalog.jsonb_typeof(v_group -> 'tabs') is distinct from 'array'
           or pg_catalog.jsonb_array_length(v_group -> 'tabs') > 80 then
          raise exception 'a group''s tabs are a list of at most 80' using errcode = '22023';
        end if;
        for v_tab in select t from pg_catalog.jsonb_array_elements(v_group -> 'tabs') t loop
          if pg_catalog.jsonb_typeof(v_tab) <> 'string' or (v_tab #>> '{}') !~ '^[a-z0-9]{1,30}$' then
            raise exception 'a tab is named by its id' using errcode = '22023';
          end if;
        end loop;
      end loop;
    end if;
  end loop;

  insert into meganet.user_pref (user_id, nav_views)
  values (auth.uid(), p_views)
  on conflict (user_id) do update set nav_views = excluded.nav_views
  returning updated_at into v_at;

  return jsonb_build_object('updated_at', v_at);
end;
$$;

comment on function meganet.save_my_views(jsonb) is
  'Keep the caller''s left-bar views (0062), its shape checked: at most 24 views of at most 30 groups of at most 80 tabs, named 1–40 characters, 32 KB in all. Any confirmed account, for its own row only.';


-- ── 10, and who may run what ─────────────────────────────────────────────────

revoke all on function meganet.signup_open()                                  from public;
revoke all on function meganet.signup_check(text)                             from public;
revoke all on function meganet.account_standing(uuid)                         from public;
revoke all on function meganet.is_member()                                    from public;
revoke all on function meganet.admin_user_decide(uuid, text, boolean, text)   from public;
revoke all on function meganet.admin_set_signup(boolean)                     from public;
revoke all on function meganet.account_mail_one(text[], text, text)           from public;
revoke all on function meganet.send_account_mail()                            from public;
revoke all on function meganet.my_prefs()                                     from public;
revoke all on function meganet.save_my_views(jsonb)                           from public;
revoke all on function meganet.auth_user_gate()                               from public;
revoke all on function meganet.auth_user_sync()                               from public;
revoke all on function meganet.email_may_sign_in(text)                        from public;
revoke all on function meganet.whoami()                                       from public;
revoke all on function meganet.admin_users()                                  from public;
revoke all on function meganet.editor_email()                                 from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  -- §10: a registry job, not a stranger's.
  revoke execute on function meganet.station_status_converge() from authenticated;
  -- Said out loud, whatever default privileges a project carries: the mail
  -- sender would send anything to anybody on Flood-Net's key, and the
  -- standing reads auth.users — neither is any browser role's to call.
  revoke execute on function meganet.account_mail_one(text[], text, text) from anon, authenticated;
  revoke execute on function meganet.account_standing(uuid)              from anon, authenticated;
  revoke execute on function meganet.send_account_mail()                 from anon, authenticated;

  grant execute on function meganet.signup_open()                                to anon, authenticated, service_role;
  grant execute on function meganet.signup_check(text)                           to anon, authenticated, service_role;
  grant execute on function meganet.email_may_sign_in(text)                      to anon, authenticated, service_role;
  grant execute on function meganet.whoami()                                     to anon, authenticated, service_role;
  grant execute on function meganet.is_member()                                  to anon, authenticated, service_role;
  grant execute on function meganet.editor_email()                               to authenticated;
  grant execute on function meganet.admin_users()                                to authenticated, service_role;
  grant execute on function meganet.admin_user_decide(uuid, text, boolean, text) to authenticated, service_role;
  grant execute on function meganet.admin_set_signup(boolean)                    to authenticated, service_role;
  grant execute on function meganet.my_prefs()                                   to authenticated, service_role;
  grant execute on function meganet.save_my_views(jsonb)                         to authenticated, service_role;
  grant execute on function meganet.send_account_mail()                          to service_role;

  revoke all on meganet.user_pref from anon;
  revoke insert, update, delete, truncate on meganet.user_pref from authenticated;
  grant select on meganet.user_pref to authenticated;
  grant select, insert, update, delete on meganet.user_pref to service_role;

  notify pgrst, 'reload schema';
end
$$;

-- Every five minutes, where the server has pg_cron — as 0059 schedules its
-- job, and skipped the same way where it has not (CI's postgres:16).
-- cron.schedule() replaces a job of the same name, so a re-apply changes
-- nothing. The function sends nothing until the Vault has the key.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron is not available on this server: nothing will run meganet.send_account_mail() on a schedule.';
    return;
  end if;
  begin
    create extension if not exists pg_cron;
    perform cron.schedule('meganet-account-mail', '*/5 * * * *', 'select meganet.send_account_mail()');
    raise notice 'meganet.send_account_mail() runs every five minutes (pg_cron job meganet-account-mail).';
  exception when others then
    raise warning 'pg_cron could not be set up (%): nobody will be emailed about accounts until it is.', sqlerrm;
  end;
end
$$;


-- ── Proof it took ────────────────────────────────────────────────────────────

do $$
begin
  if pg_catalog.to_regclass('meganet.user_pref') is null then
    raise exception '0062 did not take: meganet.user_pref is missing';
  end if;
  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'meganet.user_pref'::regclass) then
    raise exception '0062 did not take: RLS is off on meganet.user_pref';
  end if;
  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'meganet' and tablename = 'field_photo'
                    and policyname = 'field_photo_read_members') then
    raise exception '0062 did not take: the field photos are not the members''';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    if pg_catalog.has_table_privilege('anon', 'meganet.user_pref', 'select')
       or pg_catalog.has_table_privilege('authenticated', 'meganet.user_pref', 'insert,update,delete') then
      raise exception '0062 did not take: a browser role can reach meganet.user_pref beyond reading its own row';
    end if;
    if pg_catalog.has_function_privilege('authenticated', 'meganet.station_status_converge()', 'execute') then
      raise exception '0062 did not take: authenticated can still run station_status_converge()';
    end if;
    if pg_catalog.has_function_privilege('anon', 'meganet.send_account_mail()', 'execute')
       or pg_catalog.has_function_privilege('authenticated', 'meganet.send_account_mail()', 'execute')
       or pg_catalog.has_function_privilege('anon', 'meganet.account_mail_one(text[], text, text)', 'execute')
       or pg_catalog.has_function_privilege('authenticated', 'meganet.account_mail_one(text[], text, text)', 'execute') then
      raise exception '0062 did not take: a browser role can send account mail';
    end if;
    if pg_catalog.has_function_privilege('anon', 'meganet.account_standing(uuid)', 'execute')
       or pg_catalog.has_function_privilege('authenticated', 'meganet.account_standing(uuid)', 'execute') then
      raise exception '0062 did not take: a browser role can read an account''s standing directly';
    end if;
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- core.js DB_SCHEMA_VERSION went to 62 in the same commit as this file, not
-- after it was live as for 0053–0061: a database still on 61 then says so on
-- the Admin tab. The guard means applying it out of order leaves the higher
-- number.

insert into meganet.app_meta (key, value)
values ('schema_version', '62')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
