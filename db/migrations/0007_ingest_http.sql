-- 0007_ingest_http.sql — A door a field station can knock on by itself, with a
-- key that isn't the one committed to a public repo.
--
-- #B5. Every reading still goes through meganet.ingest() — 0006 already built
-- that — so this file is deliberately thin: one table for the keys, one function
-- that checks a key and hands the batch to ingest(), and the grants that make an
-- HTTP logger able to do exactly that and nothing else.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0007_ingest_http.sql
--
-- Three decisions, stated here rather than discovered in the SQL.
--
-- **1. Not `Authorization: Bearer`, on purpose.** #B5's sketch used that header,
-- and it cannot work as written: PostgREST treats `Authorization` as a JWT and
-- answers 401 for anything that fails to parse as one, *before* a request ever
-- reaches Postgres — a per-device opaque token would be refused unconditionally,
-- valid or not. There is no Edge Function in front to intercept it either, by the
-- same choice #B5 already made for `ingest()` itself. So the token travels in a
-- plain header PostgREST passes straight through: `X-Ingest-Token`. See
-- `docs/ingest-http.md` for the curl that proves it works.
--
-- **2. The token is checked in SQL, not by switching Postgres role.** #B5 asked
-- for "a Postgres role with execute on ingest() and nothing else". A literal
-- per-device role needs PostgREST to `SET ROLE`, which only happens from a JWT's
-- `role` claim — and minting real per-device JWTs means holding this project's
-- JWT secret in the database, which is a bigger and riskier thing to build than
-- this ticket's effort budget. What is here instead is functionally the same
-- promise: `meganet.ingest_http()` is the *only* door a device token opens, it
-- is granted to `anon` and nothing else is, and it authorises exactly one call to
-- `meganet.ingest()` for the transaction the device is making. A compromised
-- token cannot select from `meganet.reading` through it, cannot call
-- `save_station()`, cannot do anything but post readings — the "nothing else" is
-- true, even though it is enforced by the function boundary rather than by role
-- membership.
--
-- **3. `station_id` and the ALERT range are recorded, not enforced.** Same trade
-- 0005 made with `app_user.role`: the columns exist so that scoping a token to
-- one station is one `update` away and never a migration, but nothing here
-- refuses a reading outside the range yet. Wiring that up is a later ticket, and
-- the note is here so that finding out happens by reading this file rather than
-- by testing it in production.

-- ── The keys ──────────────────────────────────────────────────────────────────
-- One row per device credential. Only the hash is stored — same reason a
-- password never is — so a leaked database backup does not hand out working
-- tokens, and revocation is a column, not a rotation of every key that wasn't
-- compromised.
create table if not exists meganet.ingest_token (
  id            bigint      generated always as identity primary key,
  label         text        not null,
  token_hash    text        not null unique,

  -- Scope. Neither is enforced yet — see decision 3 above — but a token minted
  -- today already carries whichever of these its logger is for, so enforcing it
  -- later touches no device in the field.
  station_id    text        references meganet.station (id),
  alert_low     integer,
  alert_high    integer,

  created_at    timestamptz not null default now(),
  created_by    text,
  last_used_at  timestamptz,
  revoked_at    timestamptz,

  constraint ingest_token_alert_range check (
    (alert_low is null) = (alert_high is null)
    and (alert_low is null or alert_low <= alert_high)),
  constraint ingest_token_alert_bounds check (
    alert_low is null
    or (alert_low between 1 and 65535 and alert_high between 1 and 65535))
);

comment on table meganet.ingest_token is
  'Per-device credentials for the HTTP ingest endpoint. Only token_hash is stored — see meganet.create_ingest_token(). RLS is on with no policy: reachable only with the service key or a direct connection, same trade as meganet.editor_allow.';
comment on column meganet.ingest_token.token_hash is
  'sha256 of the token, hex-encoded. The plaintext is returned once, by create_ingest_token(), and never stored.';
comment on column meganet.ingest_token.station_id is
  'Which station this logger is for, when it is for one. Recorded, not yet enforced.';
comment on column meganet.ingest_token.revoked_at is
  'Set to stop the token working immediately — meganet.ingest_http() checks this on every call, so there is no cache to wait out.';
comment on column meganet.ingest_token.last_used_at is
  'Stamped on every accepted call, valid or not, so "which of these loggers has stopped talking" is a query rather than a guess.';

alter table meganet.ingest_token enable row level security;
-- No policy for any verb, on purpose: this table holds nothing a browser should
-- ever see, not even its own shape. Reached only through the functions below, or
-- with the service key, or a direct connection — the same trade db/README.md
-- already documents for meganet.editor_allow.

-- ── Minting one ──────────────────────────────────────────────────────────────
-- Generates the token, stores only its hash, and returns the plaintext exactly
-- once. There is no second copy anywhere — losing the returned value means
-- minting a new token, not looking the old one up.
create or replace function meganet.create_ingest_token(
         p_label      text,
         p_station_id text    default null,
         p_alert_low  integer default null,
         p_alert_high integer default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text;
  v_hash  text;
  v_id    bigint;
begin
  if p_label is null or pg_catalog.btrim(p_label) = '' then
    raise exception 'a token needs a label — which logger is this for?'
      using errcode = '23502';
  end if;

  -- Two random UUIDs, hyphens stripped, prefixed so a token is recognisable in a
  -- log line at a glance. gen_random_uuid() has drawn from the OS's CSPRNG since
  -- PostgreSQL 13 — no extension needed.
  v_token := 'mgn_' || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '')
                     || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');
  v_hash  := pg_catalog.encode(
               pg_catalog.sha256(pg_catalog.convert_to(v_token, 'utf8')), 'hex');

  insert into meganet.ingest_token
    (label, token_hash, station_id, alert_low, alert_high, created_by)
  values
    (pg_catalog.btrim(p_label), v_hash, p_station_id, p_alert_low, p_alert_high,
     meganet.actor())
  returning id into v_id;

  return pg_catalog.jsonb_build_object(
    'id', v_id, 'label', p_label, 'token', v_token);
end;
$$;

comment on function meganet.create_ingest_token(text, text, integer, integer) is
  'Mint a device token and return it once — only its hash is kept from here on. Callable with the service key or a direct connection; see docs/ingest-http.md.';

-- ── The endpoint ─────────────────────────────────────────────────────────────
-- POST /rest/v1/rpc/ingest_http, with the device token in X-Ingest-Token — see
-- decision 1 above for why not Authorization. Checks the token, then hands the
-- batch to meganet.ingest() exactly as any other adapter would.
create or replace function meganet.ingest_http(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_headers   jsonb;
  v_token_txt text;
  v_hash      text;
  v_tok       meganet.ingest_token%rowtype;
  v_env       jsonb;
  v_n         integer;
  c_max_batch constant integer := 1000;
begin
  v_headers   := nullif(pg_catalog.current_setting('request.headers', true), '')::jsonb;
  v_token_txt := nullif(pg_catalog.btrim(coalesce(v_headers ->> 'x-ingest-token', '')), '');

  -- PT401 is PostgREST's custom-status convention — same idea as save_station()'s
  -- PT409 for a stale write (db/README.md) — used here instead of a generic
  -- SQLSTATE class so "no token, or a bad one, is 401" is exact rather than
  -- inferred from a class-to-status table.
  if v_token_txt is null then
    raise exception 'missing X-Ingest-Token header'
      using errcode = 'PT401',
            hint    = 'see docs/ingest-http.md for how a logger authenticates';
  end if;

  v_hash := pg_catalog.encode(
              pg_catalog.sha256(pg_catalog.convert_to(v_token_txt, 'utf8')), 'hex');

  select * into v_tok from meganet.ingest_token t where t.token_hash = v_hash;

  if not found or v_tok.revoked_at is not null then
    raise exception 'invalid or revoked ingest token'
      using errcode = 'PT401',
            hint    = 'see docs/ingest-http.md';
  end if;

  -- Logged whether or not the batch below turns out to be any good — a device
  -- that posted garbage still posted, and "stopped talking" is the question this
  -- column exists to answer.
  update meganet.ingest_token set last_used_at = pg_catalog.now() where id = v_tok.id;

  -- Batch limit. ingest() would work through an oversized array just fine, but a
  -- device retrying a timeout deserves a clear refusal rather than a request that
  -- times out again the same way.
  v_n := case
           when pg_catalog.jsonb_typeof(payload) = 'array'
             then pg_catalog.jsonb_array_length(payload)
           when pg_catalog.jsonb_typeof(payload) = 'object' and payload ? 'readings'
                and pg_catalog.jsonb_typeof(payload -> 'readings') = 'array'
             then pg_catalog.jsonb_array_length(payload -> 'readings')
           else 1
         end;
  if v_n > c_max_batch then
    raise exception
      'batch of % exceeds the %-reading limit — split it into more than one POST',
      v_n, c_max_batch
      using errcode = '22023';
  end if;

  -- Default the envelope's source to http, the same way any other adapter would
  -- identify itself; a caller with a better answer (a backfill riding this same
  -- door with its own token) may still say so.
  v_env := case when pg_catalog.jsonb_typeof(payload) = 'object' then payload
                else pg_catalog.jsonb_build_object('readings', payload) end;
  if not v_env ? 'source' then
    v_env := v_env || pg_catalog.jsonb_build_object('source', 'http');
  end if;

  -- A transaction-local flag, not a role switch — see decision 2 above.
  -- meganet.is_editor() reads it and nothing else does; it cannot outlive this
  -- call, because PostgREST runs each request in its own transaction.
  perform pg_catalog.set_config('meganet.ingest_authorized', 'true', true);

  return meganet.ingest(v_env);
end;
$$;

comment on function meganet.ingest_http(jsonb) is
  'The HTTP ingest endpoint (#B5). Checks X-Ingest-Token against meganet.ingest_token, then hands the batch to meganet.ingest(). The only door a device token opens.';

-- ── Letting a valid token stand in for an editor, for one call ──────────────
-- meganet.is_editor() otherwise refuses anon unconditionally — see 0004. This
-- adds the one exception: anon, carrying the flag ingest_http() just set after
-- checking a real token against meganet.ingest_token. Nothing else can set that
-- flag, because set_config above runs inside a security definer function anon
-- has no other way to reach into.
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

  -- The service key. It is a server-side secret, never in a browser, and is what
  -- a maintenance script or a workflow holds.
  if v_role = 'service_role' then
    return true;
  end if;

  if v_role = 'authenticated' then
    if claims is null then
      return false;
    end if;
    -- An unverified address is an address somebody typed, not one they proved
    -- they hold. Absent means the provider did not say, which #B8's magic-link
    -- flow does not do — present-and-false is the case being refused here.
    if (claims -> 'user_metadata' ->> 'email_verified') = 'false' then
      return false;
    end if;
    return meganet.email_allowed(claims ->> 'email');
  end if;

  -- Anything else is a direct database connection — psql, a migration, a
  -- scheduled job. It writes with whatever its own role was granted, and there
  -- is nothing here for it to get around.
  return true;
end;
$$;

comment on function meganet.is_editor() is
  'May the current request write? Anon never, except for the one meganet.ingest() call a valid meganet.ingest_token just authorised (0007). service_role always; authenticated when its verified email is on meganet.editor_allow.';

-- ── Who may run what ─────────────────────────────────────────────────────────
-- Same rule as every migration before this one: EXECUTE defaults to PUBLIC on a
-- new function, so it is revoked and re-granted by name.
--
-- ingest_http() is granted to anon deliberately — that is the entire point of
-- this file — but it is the *only* function anon gains here, and it is the only
-- thing that can ever set meganet.ingest_authorized. create_ingest_token() mints
-- credentials and is never granted to anon or authenticated.
revoke all on function meganet.create_ingest_token(text, text, integer, integer) from public;
revoke all on function meganet.ingest_http(jsonb)                                from public;
revoke all on function meganet.is_editor()                                       from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  -- No select/insert/update/delete grant to anon or authenticated: the table is
  -- reachable only through the functions above, the service key, or a direct
  -- connection.
  grant select, insert, update, delete on meganet.ingest_token to service_role;

  grant execute on function meganet.create_ingest_token(text, text, integer, integer)
    to service_role;
  grant execute on function meganet.ingest_http(jsonb)
    to anon, authenticated, service_role;
  grant execute on function meganet.is_editor()
    to anon, authenticated, service_role;

  notify pgrst, 'reload schema';
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────

insert into meganet.app_meta (key, value)
values ('schema_version', '7')
on conflict (key) do update set value = excluded.value;
