-- 0054_verify_editor_email_and_contain_sync.sql — Verify an editor's email
-- against auth.users, stop a user controlling the name admins see, and bring
-- the base-station config.set allow-list into line with the Pi.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0054_verify_editor_email_and_contain_sync.sql
--
-- Security appraisal 2026-10: M-4, L-11, L-3.

-- ── M-4: an editor's address must be confirmed, proven by auth.users ──────────
-- is_editor() trusted the JWT's user_metadata.email_verified, which the user can
-- write (PUT /auth/v1/user {"data":{"email_verified":true}}). So an account made
-- for an address the user never proved they hold could edit. Verify against
-- auth.users.email_confirmed_at instead — the server-side truth — and take the
-- address from there too. A definer helper does the lookup, because the
-- authenticated role cannot read auth.users directly. It only ever returns the
-- caller's own confirmed address (keyed by auth.uid()), so it is not an oracle.

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
$$;

comment on function meganet.editor_email() is
  'The signed-in user''s email from auth.users, only when it is confirmed; else null. SECURITY DEFINER so is_editor() checks the server-side truth, not the user-writable email_verified JWT claim (security appraisal M-4).';

revoke all on function meganet.editor_email() from public;
grant execute on function meganet.editor_email() to authenticated;

create or replace function meganet.is_editor()
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  claims jsonb;
  v_role text;
  v_email text;
begin
  claims := nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb;
  v_role := coalesce(nullif(pg_catalog.current_setting('role', true), 'none'),
                     claims ->> 'role',
                     current_user::text);

  -- Anonymous, always, whatever else is true — except the one door 0007 opens:
  -- a request that already proved it holds a live meganet.ingest_token, for the
  -- single meganet.ingest() call that follows.
  if v_role in ('anon', 'authenticator') then
    if v_role = 'anon'
       and pg_catalog.current_setting('meganet.ingest_authorized', true) = 'true' then
      return true;
    end if;
    return false;
  end if;

  -- The service key: a server-side secret, never in a browser.
  if v_role = 'service_role' then
    return true;
  end if;

  if v_role = 'authenticated' then
    if claims is null then
      return false;
    end if;
    -- The address, proven confirmed by auth.users rather than taken from a
    -- user-writable claim (M-4). Null means unconfirmed, or not a known user.
    v_email := meganet.editor_email();
    if v_email is null then
      return false;
    end if;
    return meganet.email_allowed(v_email);
  end if;

  -- Anything else is a direct database connection — psql, a migration, a
  -- scheduled job — writing with whatever its own role was granted.
  return true;
end;
$$;

-- ── L-11: the display name admins see is set once, and cleaned ────────────────
-- auth_user_sync ran on every change to auth.users and copied full_name/name
-- from raw_user_meta_data (which the user controls) into app_user.display_name,
-- overwriting a name an admin had set, with no length or control-character
-- limit. Set it only when the row is first created, and clean it.

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
        pg_catalog.regexp_replace(
          coalesce(new.raw_user_meta_data ->> 'full_name',
                   new.raw_user_meta_data ->> 'name', ''),
          '[[:cntrl:]]', '', 'g'),
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

-- ── L-3: config.set from MegaNet refuses the same keys the Pi does ────────────
-- The Pi's remote handler also keeps hotspot settings local; the database check
-- blocked only web/remote/version. Add hotspot so the two agree (defence in
-- depth — the Pi enforces its own list regardless).

create or replace function meganet.base_station_verb_check(p_verb text, p_args jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_patch jsonb;
begin
  if p_args is null or pg_catalog.jsonb_typeof(p_args) <> 'object' then
    return 'the request''s arguments are an object';
  end if;
  if pg_catalog.octet_length(p_args::text) > 8192 then
    return 'the request''s arguments are at most 8 KB';
  end if;
  case coalesce(p_verb, '')
    when 'status', 'device.rescan', 'send-now', 'stations.refresh', 'agent.restart', 'reboot',
         'update.check', 'update.install', 'access.sync' then
      return null;
    when 'log' then
      if p_args ? 'lines' and (pg_catalog.jsonb_typeof(p_args -> 'lines') <> 'number'
                               or (p_args ->> 'lines')::numeric not between 1 and 400) then
        return 'log: lines, 1–400';
      end if;
      return null;
    when 'config.set' then
      v_patch := p_args -> 'patch';
      if v_patch is null or pg_catalog.jsonb_typeof(v_patch) <> 'object' or v_patch = '{}'::jsonb then
        return 'config.set: the settings to change, as an object';
      end if;
      if v_patch ?| array['web', 'hotspot', 'remote', 'version'] then
        return 'the web page''s password and port, its own Wi-Fi network, and what the base station lets MegaNet do, are set on the base station itself';
      end if;
      if v_patch ? 'meganet' and (pg_catalog.jsonb_typeof(v_patch -> 'meganet') <> 'object'
          or exists (select 1 from pg_catalog.jsonb_object_keys(v_patch -> 'meganet') k where k not in ('enabled', 'receptions'))) then
        return 'of the MegaNet settings, only whether to send (enabled, receptions) may be changed from here — never the token or where readings go';
      end if;
      return null;
    when 'device.restart', 'device.forget' then
      if pg_catalog.jsonb_typeof(p_args -> 'key') <> 'string' or pg_catalog.length(p_args ->> 'key') not between 1 and 200 then
        return p_verb || ': key — the receiver''s, as its status names it';
      end if;
      return null;
    when 'update.auto' then
      if pg_catalog.jsonb_typeof(p_args -> 'on') <> 'boolean' then
        return 'update.auto: on, true or false';
      end if;
      return null;
    else
      return 'a base station cannot be asked to "' || pg_catalog.left(coalesce(p_verb, ''), 40) || '"';
  end case;
end;
$$;

-- ── Schema version ────────────────────────────────────────────────────────────
-- Apply after 0053. core.js DB_SCHEMA_VERSION follows (to 54) once both are live.
insert into meganet.app_meta (key, value)
values ('schema_version', '54')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
