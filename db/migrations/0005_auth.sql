-- 0005_auth.sql — The gate, at the data layer. Who may sign in at all, who they
-- are once they have, and the row that will one day carry a privilege level.
--
-- 0004 built the write path and left a hole in the shape of a session: every
-- write is checked by meganet.is_editor(), which refuses `anon` unconditionally,
-- and until something mints an `authenticated` token there is nothing for it to
-- say yes to. This file is what mints one — or rather, it is the half of that
-- which lives in the database. Supabase Auth (GoTrue) does the emailing and the
-- signing; what belongs here is the answer to "should this address have been
-- given a session in the first place", because that answer has to survive
-- somebody calling the auth endpoint directly with curl.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0005_auth.sql
--
-- Three decisions, stated before the SQL rather than discovered in it.
--
-- **The allowlist is the one 0004 already built.** #B8 sketched a table called
-- `allowed_domains`; 0004 shipped `meganet.editor_allow`, whose single `entry`
-- column holds either a whole address or a domain with its at-sign, and whose
-- lookup — meganet.email_allowed() — already matches both. A second table would
-- be a second source of truth for one question, and the failure mode of two
-- allowlists is that a person is removed from one of them. So there is no
-- `allowed_domains` here: `editor_allow` *is* it, and the acceptance criterion
-- that matters ("a second domain can be allowed without a deploy") is one
-- insert:
--
--   insert into meganet.editor_allow (entry, note, added_by)
--   values ('@other-company.com', 'Why they are here', 'your name');
--
-- **Signup is refused, not just writes.** The alternative — let anyone hold a
-- session and lean on is_editor() to refuse the writes — is defensible and it is
-- not what #B8 asked for. It also leaves a pile of auth.users rows for people
-- who were never meant to be here. The trigger below refuses the insert, so an
-- unlisted address never becomes a user at all.
--
-- **The role column exists now and decides nothing yet.** Everyone provisioned
-- here is an `editor`, and no code reads the column. That is the point: adding a
-- column early costs one line, and retrofitting identity onto rows that were
-- written anonymously costs a migration and a guess about who did what.


-- ── app_user ─────────────────────────────────────────────────────────────────
-- One row per person who has ever signed in, keyed by the auth.users id so the
-- join is a primary key and not an email match. Email is carried here as well
-- as in auth.users — denormalised on purpose, because auth is a schema this
-- project does not own and may not always be able to select from.
--
-- Provisioned by trigger, never by the app: a browser that could insert its own
-- app_user row could pick its own role.
create table if not exists meganet.app_user (
  id            uuid        primary key references auth.users (id) on delete cascade,
  email         text        not null,
  display_name  text,

  -- Where levelled privileges land when they are wanted. Nothing reads this
  -- today — meganet.is_editor() asks editor_allow, not this column — so setting
  -- somebody to 'viewer' right now does not stop them writing. Wiring it up is a
  -- later ticket, and the note is here so that discovery happens by reading
  -- rather than by testing in production.
  role          text        not null default 'editor'
                            check (role in ('viewer', 'editor', 'admin')),

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table meganet.app_user is
  'One row per signed-in person, provisioned by trigger from auth.users. role is recorded but not yet enforced — meganet.is_editor() still asks meganet.editor_allow.';
comment on column meganet.app_user.role is
  'viewer | editor | admin. Reserved for levelled privileges; no code reads it yet. Everyone is provisioned editor.';

create index if not exists app_user_email_idx on meganet.app_user (lower(email));

drop trigger if exists app_user_touch_updated_at on meganet.app_user;
create trigger app_user_touch_updated_at
  before update on meganet.app_user
  for each row execute function meganet.touch_updated_at();

alter table meganet.app_user enable row level security;

-- Your own row and nobody else's. This table is a staff list; the app needs it
-- to show "signed in as", and that need stops at one row.
--
-- No insert, update or delete policy for any browser-held role, and no grant for
-- those verbs below. The trigger writes it; a person does not.
drop policy if exists app_user_read_self on meganet.app_user;
create policy app_user_read_self on meganet.app_user
  for select
  to authenticated
  using (id = auth.uid());


-- ── May this address sign in? ────────────────────────────────────────────────
-- The same question meganet.email_allowed() answers, exposed to `anon` so the
-- sign-in panel can refuse an address in the browser instead of sending a code
-- to a mailbox that was never going to be let in.
--
-- The trade is stated plainly, because it is a real one: this is an oracle. Ask
-- it about an address and it says yes or no, which for an individually-added
-- person confirms that they are on the list. It does not expose the list —
-- editor_allow has no select grant and no policy, so entries cannot be
-- enumerated, only guessed at one at a time — and the blanket domain it mostly
-- returns true for (@bom.gov.au) is written down in a public repository.
--
-- Under option (a) on #72 that is an acceptable price for an honest, immediate
-- refusal. If it ever stops being acceptable, the fix is one line: drop the
-- `anon` grant at the foot of this file. The signup trigger below is the check
-- that actually enforces this, and it keeps working with nothing granted to
-- anyone — the sign-in panel simply loses its early "no" and the refusal arrives
-- after the email round trip instead.
create or replace function meganet.email_may_sign_in(p_email text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select meganet.email_allowed(p_email);
$$;

comment on function meganet.email_may_sign_in(text) is
  'Yes/no for one address, callable anonymously so the sign-in panel can refuse before emailing. Deliberately an oracle; see 0005_auth.sql.';


-- ── The signup gate ──────────────────────────────────────────────────────────
-- On auth.users rather than anywhere in meganet, because this has to hold
-- against a request that never touches the Data API. `POST /auth/v1/otp` with
-- any address in the world reaches GoTrue directly; the only thing downstream of
-- every path into this system is the insert itself.
--
-- security definer because the trigger fires as supabase_auth_admin, which has
-- no business being granted anything in meganet. The function owner (whoever
-- runs this migration — postgres, normally) is who reads editor_allow.
--
-- The raised message is written for a human reading logs. GoTrue does not pass
-- it to the browser: the caller gets a generic "Database error saving new user",
-- which is why the app pre-checks with email_may_sign_in() above and has its own
-- wording ready for this case. Do not spend effort making this string prettier
-- for the browser's benefit — the browser never sees it.
create or replace function meganet.auth_user_gate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is null or not meganet.email_allowed(new.email) then
    raise exception
      'MegaNet: % is not on meganet.editor_allow, so no account was created', coalesce(new.email, '(no address)')
      using errcode = '42501',
            hint = 'Add the address, or its domain with a leading @, to meganet.editor_allow. See docs/access.md.';
  end if;
  return new;
end;
$$;

comment on function meganet.auth_user_gate() is
  'BEFORE INSERT on auth.users: refuses an address that is not on meganet.editor_allow, so an unlisted person never becomes a user.';

drop trigger if exists meganet_auth_user_gate on auth.users;
create trigger meganet_auth_user_gate
  before insert on auth.users
  for each row execute function meganet.auth_user_gate();


-- ── Provisioning ─────────────────────────────────────────────────────────────
-- The app_user row, created the moment the auth user is and kept in step with
-- the address afterwards. Role is left to the column default on insert and never
-- touched on update — an administrator who sets somebody to 'viewer' should not
-- have it reset by them signing in again.
create or replace function meganet.auth_user_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into meganet.app_user (id, email, display_name)
  values (
    new.id,
    new.email,
    -- Whatever the identity provider offered. An OTP sign-in offers nothing, so
    -- this is usually null and the app falls back to the address.
    coalesce(new.raw_user_meta_data ->> 'full_name',
             new.raw_user_meta_data ->> 'name')
  )
  on conflict (id) do update
    set email        = excluded.email,
        display_name = coalesce(excluded.display_name, meganet.app_user.display_name);

  return new;
end;
$$;

comment on function meganet.auth_user_sync() is
  'AFTER INSERT/UPDATE on auth.users: provisions and keeps meganet.app_user in step. Never writes role.';

drop trigger if exists meganet_auth_user_sync on auth.users;
create trigger meganet_auth_user_sync
  after insert or update of email, raw_user_meta_data on auth.users
  for each row execute function meganet.auth_user_sync();

-- Anyone already in auth.users from before this migration — the owner's own
-- account, most likely — gets their row now rather than on next sign-in.
insert into meganet.app_user (id, email, display_name)
select u.id,
       u.email,
       coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name')
  from auth.users u
 where u.email is not null
on conflict (id) do nothing;


-- ── whoami ───────────────────────────────────────────────────────────────────
-- What the app shows in the header, from the only party whose opinion counts.
--
-- The browser could assemble most of this itself by decoding the JWT it is
-- holding, and that is exactly why this exists: a token's payload is what the
-- client *claims*, and `may_write` in particular is a question only the database
-- can answer, because the answer depends on a table the browser cannot read.
-- Calling this on sign-in is also the cheapest possible proof that the token
-- actually works — a session that looks fine in localStorage and is rejected by
-- PostgREST is the failure this turns into a message.
--
-- Callable by anon on purpose: signed out it returns signed_in false, which
-- lets the app use one code path for both states.
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
    -- Echoed back so the app can show which database answered, and so a token
    -- minted against a different project is obvious rather than mysterious.
    'schema_version', (select m.value from meganet.app_meta m where m.key = 'schema_version')
  );
$$;

comment on function meganet.whoami() is
  'Identity and write permission as the database sees them. Anonymous callers get signed_in false rather than an error.';


-- ── Who may run what ─────────────────────────────────────────────────────────
-- Same rule as 0004: EXECUTE defaults to PUBLIC on a new function, so every one
-- of these is revoked first and then granted by name.
revoke all on function meganet.email_may_sign_in(text) from public;
revoke all on function meganet.whoami()                 from public;
revoke all on function meganet.auth_user_gate()         from public;
revoke all on function meganet.auth_user_sync()         from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  -- Read-only, and only ever your own row — the policy above is what limits it
  -- to one. No write verb for either browser-held role: the triggers do that.
  grant select on meganet.app_user to authenticated;
  grant select, insert, update, delete on meganet.app_user to service_role;

  grant execute on function meganet.email_may_sign_in(text) to anon, authenticated, service_role;
  grant execute on function meganet.whoami()                to anon, authenticated, service_role;

  notify pgrst, 'reload schema';
end
$$;


-- ── Schema version ───────────────────────────────────────────────────────────

insert into meganet.app_meta (key, value)
values ('schema_version', '5')
on conflict (key) do update set value = excluded.value;
