-- 0048_ingest_token_requests.sql — A base station asks for its ingest token,
-- and an administrator approves it from the Admin tab on any device.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0048_ingest_token_requests.sql
--
-- Why this file exists
-- ────────────────────
-- 0046 moved minting a token out of the SQL editor and onto the Admin tab. The
-- token still had to travel: an administrator, signed in somewhere, minted it,
-- and somebody carried 68 characters to the base station — a Raspberry Pi with
-- no keyboard, or a browser that would first have to sign in by email code to
-- mint one for itself. Signing in on the Pi was the step people stalled on.
--
-- This turns it round, the way a television signs in to a streaming service
-- (RFC 8628, the device authorisation grant): the device asks, shows a short
-- code, and an administrator who is signed in anywhere — a phone, a work
-- computer — sees the request on the Admin tab, checks the code and approves.
-- The device notices within seconds and starts posting.
--
-- Three decisions.
--
-- **1. The device makes its own token, and only its hash ever arrives.** It
-- draws `mgn_` and 64 hex characters from its own CSPRNG, keeps them, and sends
-- them in X-Ingest-Token exactly as it will every time after. The request keeps
-- sha256 of it — the same hash meganet.ingest_token keeps — and approving
-- copies that hash into a new ingest_token row. So nothing has to be collected
-- after approval: no plaintext waits anywhere in the database, a lost response
-- cannot lose the token, and the device's next ingest_http() simply works.
-- meganet.create_ingest_token() is not used for exactly that reason: it makes
-- the token, and here the device already has one. The shape is enforced
-- (`^mgn_[0-9a-f]{64}$`) so a request cannot arrive holding a short one.
--
-- **2. The code is for matching, and two waiting requests never share one.** An
-- administrator sees every waiting request and approves one by pressing a
-- button beside it; the code the device shows is how they know the one they
-- press is the one in front of them, and not a stranger's request wearing a
-- copied name. Codes are eight letters from RFC 8628's twenty consonants (no
-- vowels, so no words; no 0/O or 1/I/L to misread), drawn from
-- gen_random_uuid()'s CSPRNG, and unique among waiting requests by index — so a
-- second request can never show the same code as the first.
--
-- **3. Asking is open, and bounded.** request_ingest_token() is granted to anon
-- — a device that could sign in would not need it. What bounds it: a request
-- lasts 30 minutes, at most 20 can be waiting at once (PT429 after that), it
-- describes itself in at most 4 KB, and until an administrator approves it, it
-- is a row nobody can read and a token nothing accepts. Spam can fill the
-- waiting list; it cannot get a token. The device's own two calls — "how is my
-- request doing" and "never mind" — are token-checked by the same hash, and
-- say nothing about anybody else's request: not the approver, not the list.
--
-- Nothing about what a token may do changes. An approved request is an
-- ordinary meganet.ingest_token row — revoked from the same panel, the same way.

-- ── The requests ─────────────────────────────────────────────────────────────

create table if not exists meganet.ingest_token_request (
  id               bigint       generated always as identity primary key,
  -- sha256 (hex) of the token the device made for itself. The plaintext is
  -- never sent here except as the header it authenticates with, and never kept.
  token_hash       text         not null unique,
  -- What the device shows, and what the administrator matches before approving.
  code             text         not null,
  -- What the device calls itself; the token's label on approval, unless the
  -- administrator changes it there.
  label            text         not null,
  -- The station the device says it sits at, when it named one MegaNet knows. A
  -- suggestion for the token's host_station_id, never a constraint — and no
  -- foreign key, for station_status's reason (0008): this is a record of what
  -- was said, and the function nulls an id it cannot find.
  host_station_id  text,
  -- The device describing itself, for the administrator: app, version, host,
  -- board, receivers. Shown, escaped, and never acted on.
  detail           jsonb        not null default '{}'::jsonb,

  requested_at     timestamptz  not null default now(),
  expires_at       timestamptz  not null,
  -- 'expired' is not stored: it is a pending request past expires_at, worked
  -- out when asked, so it can never disagree with the clock.
  status           text         not null default 'pending',
  decided_at       timestamptz,
  decided_by       text,
  -- The token approving it made.
  ingest_token_id  bigint       references meganet.ingest_token (id),

  constraint ingest_token_request_hash_shape check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint ingest_token_request_code_shape check (code ~ '^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$'),
  constraint ingest_token_request_label_len  check (pg_catalog.length(label) between 1 and 120),
  constraint ingest_token_request_status     check (status in ('pending', 'approved', 'denied', 'withdrawn')),
  constraint ingest_token_request_decided    check ((status = 'pending') = (decided_at is null)),
  constraint ingest_token_request_token      check ((status = 'approved') = (ingest_token_id is not null)),
  constraint ingest_token_request_detail     check (pg_catalog.jsonb_typeof(detail) = 'object'
                                                    and pg_catalog.octet_length(detail::text) <= 4096)
);

comment on table meganet.ingest_token_request is
  'A base station asking for an ingest token (0048): the hash of the token it made for itself, the code it shows, what it calls itself, and what an administrator decided. RLS on, no policy and no grant: reached only through request_ingest_token(), ingest_token_request_status(), withdraw_ingest_token_request() and the admin_* functions.';
comment on column meganet.ingest_token_request.token_hash is
  'sha256 of the token the device made for itself, hex — the hash meganet.ingest_token keeps. Approving copies it there; the plaintext never reaches the database except as the header that authenticates a call.';
comment on column meganet.ingest_token_request.code is
  'Eight letters from RFC 8628''s twenty consonants, XXXX-XXXX, shown by the device and matched by the administrator. Unique among pending requests.';
comment on column meganet.ingest_token_request.status is
  'pending, approved, denied or withdrawn (the device changed its mind). A pending request past expires_at reads as expired; that is worked out, not stored.';

-- Two waiting requests never show the same code — decision 2.
create unique index if not exists ingest_token_request_pending_code_idx
  on meganet.ingest_token_request (code) where status = 'pending';

-- "How many are waiting" is asked on every request.
create index if not exists ingest_token_request_pending_idx
  on meganet.ingest_token_request (expires_at) where status = 'pending';

alter table meganet.ingest_token_request enable row level security;
-- No policy for any verb, and no grant: the same trade as meganet.ingest_token.
-- Every way in is one of the functions below.

-- ── The code ─────────────────────────────────────────────────────────────────
-- From gen_random_uuid(), which draws on the OS's CSPRNG (PostgreSQL 13+), so
-- there is no extension to depend on. Bytes 6 and 8 carry the UUID's version and
-- variant bits and are skipped; a byte of 240 or more is skipped too, because
-- 240 is twelve twenties and anything above it would favour the first letters.

create or replace function meganet.ingest_token_request_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  c_alpha constant text := 'BCDFGHJKLMNPQRSTVWXZ';
  v_out   text := '';
  v_bytes bytea;
  v_b     integer;
begin
  while pg_catalog.length(v_out) < 8 loop
    v_bytes := pg_catalog.uuid_send(pg_catalog.gen_random_uuid());
    for i in 0..15 loop
      continue when i in (6, 8);
      v_b := pg_catalog.get_byte(v_bytes, i);
      continue when v_b >= 240;
      v_out := v_out || pg_catalog.substr(c_alpha, v_b % 20 + 1, 1);
      exit when pg_catalog.length(v_out) = 8;
    end loop;
  end loop;
  return pg_catalog.substr(v_out, 1, 4) || '-' || pg_catalog.substr(v_out, 5, 4);
end;
$$;

comment on function meganet.ingest_token_request_code() is
  'A fresh XXXX-XXXX code from twenty consonants, unbiased, from the CSPRNG behind gen_random_uuid() (0048). Internal.';

-- ── What a device is told about its own token ────────────────────────────────
-- One answer for the request call and the status call, so they cannot drift.
-- A token MegaNet already holds says approved (or revoked) with the label it is
-- known by — which is the administrator's, if they changed it. Never the
-- approver's address: that is not the device's business.

create or replace function meganet.ingest_token_request_state(p_hash text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tok meganet.ingest_token;
  v_req meganet.ingest_token_request;
begin
  select * into v_tok from meganet.ingest_token t where t.token_hash = p_hash;
  if found then
    return pg_catalog.jsonb_build_object(
      'status',     case when v_tok.revoked_at is null then 'approved' else 'revoked' end,
      'label',      v_tok.label,
      'decided_at', coalesce(v_tok.revoked_at, v_tok.created_at));
  end if;

  select * into v_req from meganet.ingest_token_request r where r.token_hash = p_hash;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'unknown');
  end if;

  return pg_catalog.jsonb_build_object(
    'status',       case when v_req.status = 'pending' and v_req.expires_at <= pg_catalog.now()
                         then 'expired' else v_req.status end,
    'id',           v_req.id,
    'code',         v_req.code,
    'label',        v_req.label,
    'requested_at', v_req.requested_at,
    'expires_at',   v_req.expires_at,
    -- Seconds rather than only a time: a Raspberry Pi has no real-time clock,
    -- and one that has not reached NTP yet can still count down from this.
    'expires_in',   greatest(0, pg_catalog.ceil(extract(epoch from v_req.expires_at - pg_catalog.now())))::integer,
    'decided_at',   v_req.decided_at,
    'poll_s',       5);
end;
$$;

comment on function meganet.ingest_token_request_state(text) is
  'What a device is told about the token whose hash this is: approved or revoked (with its label), or its request''s status, code and expiry, or unknown (0048). Internal — the device asks through ingest_token_request_status(), holding the token itself.';

-- The token a device presents, hashed — or null when the header is missing.
create or replace function meganet.ingest_token_request_hash()
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_token text;
begin
  v_token := nullif(pg_catalog.btrim(coalesce(
               nullif(pg_catalog.current_setting('request.headers', true), '')::jsonb ->> 'x-ingest-token', '')), '');
  if v_token is null then
    return null;
  end if;
  return pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_token, 'utf8')), 'hex');
end;
$$;

comment on function meganet.ingest_token_request_hash() is
  'sha256 (hex) of the X-Ingest-Token header, or null without one (0048). Internal.';

-- ── The door a device asks at ────────────────────────────────────────────────
-- POST /rest/v1/rpc/request_ingest_token, X-Ingest-Token: the token the device
-- made, body {"payload": {"label": …, "host_station_id": …, "detail": {…}}}.
-- Asking again with the same token while the request waits is a retry and gets
-- the same request back — a device whose answer was lost asks again and shows
-- the same code. A token that has asked before and been turned down (or has
-- expired, or was withdrawn) cannot ask again: one request per token, and a
-- device that wants another makes another token, so a decision is never undone
-- by a request that looks like the one already decided.

create or replace function meganet.request_ingest_token(payload jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_ttl     constant interval := interval '30 minutes';
  c_waiting constant integer  := 20;
  v_token   text;
  v_hash    text;
  v_label   text;
  v_host    text;
  v_detail  jsonb;
  v_prior   jsonb;
  v_id      bigint;
  v_tries   integer := 0;
begin
  v_token := pg_catalog.btrim(coalesce(
               nullif(pg_catalog.current_setting('request.headers', true), '')::jsonb ->> 'x-ingest-token', ''));
  if v_token !~ '^mgn_[0-9a-f]{64}$' then
    raise exception 'send the token this device made for itself in X-Ingest-Token: mgn_ and 64 lower-case hex characters'
      using errcode = '22023',
            hint    = 'see docs/ingest-http.md, "A base station that asks for its token"';
  end if;
  v_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_token, 'utf8')), 'hex');

  if payload is null or pg_catalog.jsonb_typeof(payload) <> 'object' then
    raise exception 'request_ingest_token takes an object, got %',
                    coalesce(pg_catalog.jsonb_typeof(payload), 'null')
      using errcode = '22023';
  end if;

  -- Requests are serialised: the waiting count and the code's uniqueness are
  -- then exact rather than nearly so. They are rare and quick.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('meganet.ingest_token_request')::bigint);

  -- Already a token, or already asked: say where it stands rather than ask twice.
  v_prior := meganet.ingest_token_request_state(v_hash);
  if v_prior ->> 'status' in ('pending', 'approved') then
    return v_prior;
  end if;
  if v_prior ->> 'status' <> 'unknown' then
    raise exception 'this token has asked before and its request is % — make a new token and ask again', v_prior ->> 'status'
      using errcode = '23505';
  end if;

  v_label := pg_catalog.btrim(coalesce(payload ->> 'label', payload ->> 'name', ''));
  if v_label = '' then
    raise exception 'a request needs a label — what this base station is called, e.g. "Mt Stuart base"'
      using errcode = '22023';
  end if;
  if pg_catalog.length(v_label) > 120 then
    raise exception 'a label of at most 120 characters, please' using errcode = '22023';
  end if;
  if v_label ~ '[[:cntrl:]]' then
    raise exception 'a label is one line of text' using errcode = '22023';
  end if;

  v_detail := coalesce(payload -> 'detail', '{}'::jsonb);
  if pg_catalog.jsonb_typeof(v_detail) <> 'object' then
    raise exception 'detail is an object describing the device' using errcode = '22023';
  end if;
  if pg_catalog.octet_length(v_detail::text) > 4096 then
    raise exception 'detail is at most 4 KB' using errcode = '22023';
  end if;

  -- Kept only when it names a station MegaNet knows; a stale id is not an error.
  select s.id into v_host from meganet.station s
   where s.id = nullif(pg_catalog.btrim(coalesce(payload ->> 'host_station_id', '')), '');

  -- Housekeeping, while the lock is held: a request that expired a day ago,
  -- and a decision a month old, have nothing left to say. An approved one's
  -- token is meganet.ingest_token's, and stays there.
  delete from meganet.ingest_token_request r
   where (r.status = 'pending' and r.expires_at < pg_catalog.now() - interval '1 day')
      or (r.status <> 'pending' and r.decided_at < pg_catalog.now() - interval '30 days');

  if (select pg_catalog.count(*) from meganet.ingest_token_request r
       where r.status = 'pending' and r.expires_at > pg_catalog.now()) >= c_waiting then
    raise exception '% base stations are already waiting for an administrator — try again in a few minutes', c_waiting
      using errcode = 'PT429',
            hint    = 'an administrator can approve or deny them on the Admin tab, under Ingest tokens';
  end if;

  -- A code a waiting request already shows is skipped (the partial index) and
  -- another drawn. One in 25 billion per waiting request; the bound is for form.
  loop
    v_tries := v_tries + 1;
    insert into meganet.ingest_token_request
      (token_hash, code, label, host_station_id, detail, requested_at, expires_at)
    values
      (v_hash, meganet.ingest_token_request_code(), v_label, v_host, v_detail,
       pg_catalog.now(), pg_catalog.now() + c_ttl)
    on conflict (code) where status = 'pending' do nothing
    returning id into v_id;
    exit when v_id is not null;
    if v_tries >= 10 then
      raise exception 'could not draw a free code' using errcode = 'XX000';
    end if;
  end loop;

  return meganet.ingest_token_request_state(v_hash);
end;
$$;

comment on function meganet.request_ingest_token(jsonb) is
  'A base station asks for an ingest token (0048): X-Ingest-Token carries the token it made for itself (mgn_ + 64 hex), the payload its label, host_station_id and detail. Answers its status, code and expiry. A retry while it waits answers the same request. 30 minutes; at most 20 waiting (PT429). Granted to anon: until an administrator approves it, the token opens nothing.';

-- ── The device, asking how it is going ───────────────────────────────────────
-- POST /rest/v1/rpc/ingest_token_request_status, X-Ingest-Token, body {} (or
-- {"payload": {}} — the argument is there so a client that always wraps its
-- body under "payload", as every other ingest call takes one, is answered too).
-- pending · approved · denied · withdrawn · expired · revoked · unknown.

create or replace function meganet.ingest_token_request_status(payload jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_hash text := meganet.ingest_token_request_hash();
begin
  if v_hash is null then
    raise exception 'missing X-Ingest-Token header'
      using errcode = 'PT401',
            hint    = 'send the token the request was made with';
  end if;
  return meganet.ingest_token_request_state(v_hash);
end;
$$;

comment on function meganet.ingest_token_request_status(jsonb) is
  'How the request made with this X-Ingest-Token stands (0048): pending (with its code and expiry), approved (with the label MegaNet knows it by), denied, withdrawn, expired, revoked, or unknown. Says nothing about any other request. Granted to anon.';

-- ── The device, changing its mind ────────────────────────────────────────────
-- A device that stops waiting says so, so the request leaves the Admin tab's
-- waiting list rather than sitting there to be approved for nobody. A request
-- already decided is left as it is, and the answer says how.

create or replace function meganet.withdraw_ingest_token_request(payload jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash text := meganet.ingest_token_request_hash();
begin
  if v_hash is null then
    raise exception 'missing X-Ingest-Token header'
      using errcode = 'PT401',
            hint    = 'send the token the request was made with';
  end if;
  update meganet.ingest_token_request
     set status = 'withdrawn', decided_at = pg_catalog.now(), decided_by = 'the device'
   where token_hash = v_hash and status = 'pending';
  return meganet.ingest_token_request_state(v_hash);
end;
$$;

comment on function meganet.withdraw_ingest_token_request(jsonb) is
  'The device that made this X-Ingest-Token''s request stops waiting (0048): a pending request becomes withdrawn; a decided one is left alone. Answers the status. Granted to anon.';

-- ── The Admin tab ────────────────────────────────────────────────────────────
-- Every waiting request, and what was decided or expired in the last day — so
-- "approved two minutes ago, by you" is on the screen the device was approved
-- from. Never the hash.

create or replace function meganet.admin_ingest_token_requests()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform meganet.admin_require();
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'id',               r.id,
             'code',             r.code,
             'label',            r.label,
             'host_station_id',  r.host_station_id,
             'host_station',     s.name,
             'detail',           r.detail,
             'requested_at',     r.requested_at,
             'expires_at',       r.expires_at,
             'status',           case when r.status = 'pending' and r.expires_at <= pg_catalog.now()
                                      then 'expired' else r.status end,
             'decided_at',       r.decided_at,
             'decided_by',       r.decided_by,
             'ingest_token_id',  r.ingest_token_id,
             'token_label',      t.label,
             'token_revoked_at', t.revoked_at)
           order by (r.status = 'pending' and r.expires_at > pg_catalog.now()) desc,
                    coalesce(r.decided_at, r.requested_at) desc, r.id desc)
      from meganet.ingest_token_request r
      left join meganet.station s on s.id = r.host_station_id
      left join meganet.ingest_token t on t.id = r.ingest_token_id
     where (r.status = 'pending' and r.expires_at > pg_catalog.now() - interval '1 day')
        or r.decided_at > pg_catalog.now() - interval '1 day'
  ), '[]'::jsonb);
end;
$$;

comment on function meganet.admin_ingest_token_requests() is
  'Base stations asking for an ingest token (0048): every waiting request, waiting ones first, plus what was decided or expired in the last day — code, label, suggested host station, the device''s own description, and the decision. Never the hash. Administrators only.';

-- Approving: the token is the device's own, its label the device's unless the
-- administrator gives another (unique among live tokens, as 0046 requires), and
-- its host station the one given — null keeps the device's suggestion, '' is
-- none. p_replace_token_id revokes a live token first, in the same transaction:
-- a Pi that was reflashed asks under the name its old token still holds, and
-- "this one replaces that one" should be one decision, not two.

create or replace function meganet.admin_approve_ingest_token_request(
         p_id               bigint,
         p_label            text   default null,
         p_host_station_id  text   default null,
         p_replace_token_id bigint default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req     meganet.ingest_token_request;
  v_label   text;
  v_host    text;
  v_id      bigint;
  v_old     bigint;
begin
  perform meganet.admin_require();

  select * into v_req from meganet.ingest_token_request where id = p_id for update;
  if not found then
    raise exception 'no token request %', p_id using errcode = '22023';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'that request was already % — %', v_req.status,
      case v_req.status when 'approved'  then 'its token is in the list below'
                        when 'withdrawn' then 'the device stopped waiting; ask it to request again'
                        else 'ask the device to request again' end
      using errcode = '22023';
  end if;
  if v_req.expires_at <= pg_catalog.now() then
    raise exception 'that request expired — ask the device to request again' using errcode = '22023';
  end if;

  v_label := coalesce(nullif(pg_catalog.btrim(coalesce(p_label, '')), ''), v_req.label);
  if pg_catalog.length(v_label) > 120 then
    raise exception 'a label of at most 120 characters, please' using errcode = '22023';
  end if;
  if v_label ~ '[[:cntrl:]]' then
    raise exception 'a label is one line of text' using errcode = '22023';
  end if;

  if p_host_station_id is null then
    select s.id into v_host from meganet.station s where s.id = v_req.host_station_id;
  else
    v_host := nullif(pg_catalog.btrim(p_host_station_id), '');
    if v_host is not null and not exists (select 1 from meganet.station s where s.id = v_host) then
      raise exception 'no station %', v_host using errcode = '22023';
    end if;
  end if;

  if p_replace_token_id is not null then
    update meganet.ingest_token set revoked_at = pg_catalog.now()
     where id = p_replace_token_id and revoked_at is null
    returning id into v_old;
    if v_old is null then
      raise exception 'no live ingest token % to replace', p_replace_token_id using errcode = '22023';
    end if;
  end if;

  if exists (select 1 from meganet.ingest_token t
              where pg_catalog.lower(t.label) = pg_catalog.lower(v_label) and t.revoked_at is null) then
    raise exception 'a live token is already called %, and two would be impossible to tell apart — give this one another label, or replace that one', v_label
      using errcode = '23505';
  end if;

  insert into meganet.ingest_token (label, token_hash, host_station_id, created_by)
  values (v_label, v_req.token_hash, v_host, meganet.actor())
  returning id into v_id;

  update meganet.ingest_token_request
     set status = 'approved', decided_at = pg_catalog.now(), decided_by = meganet.actor(), ingest_token_id = v_id
   where id = v_req.id;

  return pg_catalog.jsonb_build_object(
    'id', v_id, 'label', v_label, 'host_station_id', v_host,
    'request_id', v_req.id, 'code', v_req.code, 'replaced_token_id', v_old);
end;
$$;

comment on function meganet.admin_approve_ingest_token_request(bigint, text, text, bigint) is
  'Approve a waiting token request (0048): the device''s own token hash becomes an ingest_token, labelled as given (default the device''s, unique among live tokens), at the host station given (null keeps the device''s suggestion, '''' is none), created_by the administrator. p_replace_token_id revokes a live token first, in the same transaction. Administrators only.';

create or replace function meganet.admin_deny_ingest_token_request(p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req meganet.ingest_token_request;
begin
  perform meganet.admin_require();
  select * into v_req from meganet.ingest_token_request where id = p_id for update;
  if not found then
    raise exception 'no token request %', p_id using errcode = '22023';
  end if;
  if v_req.status = 'approved' then
    raise exception 'that request was approved — revoke its token instead' using errcode = '22023';
  end if;
  if v_req.status = 'pending' then
    update meganet.ingest_token_request
       set status = 'denied', decided_at = pg_catalog.now(), decided_by = meganet.actor()
     where id = v_req.id
    returning * into v_req;
  end if;
  return pg_catalog.jsonb_build_object('id', v_req.id, 'label', v_req.label, 'code', v_req.code, 'status', v_req.status);
end;
$$;

comment on function meganet.admin_deny_ingest_token_request(bigint) is
  'Turn a waiting token request down (0048): denied, and its token never opens anything. A request already denied or withdrawn is left as it is; an approved one is refused — revoke its token instead. Administrators only.';

-- ── Who may run what ─────────────────────────────────────────────────────────

revoke all on function meganet.ingest_token_request_code()                                        from public;
revoke all on function meganet.ingest_token_request_state(text)                                   from public;
revoke all on function meganet.ingest_token_request_hash()                                        from public;
revoke all on function meganet.request_ingest_token(jsonb)                                        from public;
revoke all on function meganet.ingest_token_request_status(jsonb)                                 from public;
revoke all on function meganet.withdraw_ingest_token_request(jsonb)                               from public;
revoke all on function meganet.admin_ingest_token_requests()                                      from public;
revoke all on function meganet.admin_approve_ingest_token_request(bigint, text, text, bigint)     from public;
revoke all on function meganet.admin_deny_ingest_token_request(bigint)                            from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;
  -- The device's three: anon, because the token they carry — not a session —
  -- is what they are about.
  grant execute on function meganet.request_ingest_token(jsonb)                to anon, authenticated, service_role;
  grant execute on function meganet.ingest_token_request_status(jsonb)         to anon, authenticated, service_role;
  grant execute on function meganet.withdraw_ingest_token_request(jsonb)       to anon, authenticated, service_role;
  -- The Admin tab's three: authenticated, not anon — each asks admin_require()
  -- as well, but an anonymous caller has no business reaching the question.
  grant execute on function meganet.admin_ingest_token_requests()                                  to authenticated, service_role;
  grant execute on function meganet.admin_approve_ingest_token_request(bigint, text, text, bigint) to authenticated, service_role;
  grant execute on function meganet.admin_deny_ingest_token_request(bigint)                        to authenticated, service_role;
  -- The three helpers are reached only from inside the functions above, which
  -- run as their owner. Granted to nothing a browser holds: the state reader
  -- takes a hash, and a door that answers for a hash is a door nobody needs.
  grant execute on function meganet.ingest_token_request_state(text) to service_role;
  notify pgrst, 'reload schema';
end
$$;

-- ── Did it take ──────────────────────────────────────────────────────────────

do $$
begin
  if to_regclass('meganet.ingest_token_request') is null
     or to_regprocedure('meganet.request_ingest_token(jsonb)') is null
     or to_regprocedure('meganet.ingest_token_request_status(jsonb)') is null
     or to_regprocedure('meganet.withdraw_ingest_token_request(jsonb)') is null
     or to_regprocedure('meganet.admin_ingest_token_requests()') is null
     or to_regprocedure('meganet.admin_approve_ingest_token_request(bigint, text, text, bigint)') is null
     or to_regprocedure('meganet.admin_deny_ingest_token_request(bigint)') is null then
    raise exception '0048 did not take: the token request functions are missing';
  end if;
  if not (select c.relrowsecurity from pg_catalog.pg_class c
           where c.oid = 'meganet.ingest_token_request'::pg_catalog.regclass) then
    raise exception '0048 did not take: meganet.ingest_token_request has RLS off';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes to 48 in the same commit as this file.

insert into meganet.app_meta (key, value)
values ('schema_version', '48')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
