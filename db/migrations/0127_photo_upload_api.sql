-- 0127_photo_upload_api.sql — Field photos sent in by other apps and
-- contractors, over an API, each with a key of its own.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0127_photo_upload_api.sql
--
-- ── The shape of it ──────────────────────────────────────────────────────────
--
-- A contractor's app PUTs a photo to https://floodwarning.net/api/upload/v1/photos
-- with its key (worker/upload.js). The Worker has milliseconds of CPU a request,
-- far too few to hash or read a 25 MB photo, so it reads nothing: it asks this
-- database whether the key is good and whether this photo was sent before,
-- streams the bytes into an inbox in R2 (which checks the SHA-256 the sender
-- declared, at no CPU cost to the Worker), and answers 202 with a receipt.
-- Every fifteen minutes the field photo sync (tools/field-photos, PHOTO_SOURCE
-- =api) takes each waiting receipt, reads the photo exactly as the Dropbox and
-- Google Drive syncs do — photo-meta.js, then add_field_photo(), which files it
-- under the nearest station — logs it to the Review panel, and settles the
-- receipt with what became of it.
--
--   1. One more way in, 'api', and one more way a photo is placed or timed,
--      'sender': a position or time the sending app gave, used only when the
--      photo itself says nothing.
--   2. meganet.photo_upload_token — a key per contractor. The plaintext is
--      shown once, when an administrator mints it on the Admin tab; only its
--      SHA-256 is kept. Each has a daily allowance and may have an end date.
--   3. meganet.photo_upload_receipt — a row per photo accepted, keyed by
--      (key, SHA-256): the same bytes sent twice with one key are one receipt,
--      which is what makes a retry safe.
--   4. Functions: the Admin tab's list / mint / revoke (administrators only),
--      and the Worker's and the sync's check / accept / store / abandon /
--      status / waiting / settle (the project's secret key only).
--
-- Neither table is granted to anon or authenticated: no browser reads them
-- except through the admin functions, and the Worker and the sync run as
-- service_role. The read-only agent API (worker/api.js) knows nothing of any of
-- this, and nothing here is added to its READABLE_RELATIONS.

-- ── 1. The words ─────────────────────────────────────────────────────────────

insert into meganet.field_photo_origin (key, ord, label) values
  ('api', 4, 'Sent in through the upload API')
on conflict (key) do update set ord = excluded.ord, label = excluded.label;

insert into meganet.field_photo_placement (key, ord, label) values
  ('sender', 6, 'Given by the app that sent it')
on conflict (key) do update set ord = excluded.ord, label = excluded.label;

alter table meganet.field_photo drop constraint if exists field_photo_taken_source;
alter table meganet.field_photo add constraint field_photo_taken_source
  check (taken_source is null or taken_source in ('exif', 'xmp', 'ocr', 'manual', 'sender'));

-- ── 2. The keys ──────────────────────────────────────────────────────────────

create table if not exists meganet.photo_upload_token (
  id            bigint      generated always as identity primary key,
  label         text        not null,
  token_hash    text        not null unique,
  day_limit     integer     not null default 500,
  expires_at    timestamptz,
  created_at    timestamptz not null default now(),
  created_by    text        not null default '',
  revoked_at    timestamptz,
  last_used_at  timestamptz,

  constraint photo_upload_token_label check (pg_catalog.length(pg_catalog.btrim(label)) between 1 and 120),
  constraint photo_upload_token_hash  check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint photo_upload_token_day   check (day_limit between 1 and 5000)
);

comment on table meganet.photo_upload_token is
  'A key per contractor or app for the photo upload API (0127, worker/upload.js). Only the SHA-256 of the key is kept; the key itself is shown once, when minted. day_limit is photos accepted in any 24 hours. No grant to anon or authenticated: read through admin_photo_upload_tokens().';

create index if not exists photo_upload_token_live_idx on meganet.photo_upload_token (pg_catalog.lower(label)) where revoked_at is null;

-- ── 3. The receipts ──────────────────────────────────────────────────────────

create table if not exists meganet.photo_upload_receipt (
  id            uuid        primary key default gen_random_uuid(),
  token_id      bigint      not null references meganet.photo_upload_token (id),
  sha256        text        not null,
  file_name     text        not null,
  content_type  text        not null,
  byte_size     bigint      not null,
  hints         jsonb       not null default '{}'::jsonb,
  state         text        not null default 'receiving',
  received_at   timestamptz not null default now(),
  stored_at     timestamptz,
  settled_at    timestamptz,
  attempts      integer     not null default 0,
  reason        text        not null default '',
  photo_id      uuid        references meganet.field_photo (id) on delete set null,
  station_id    text        references meganet.station (id) on delete set null,

  constraint photo_upload_receipt_sha    check (sha256 ~ '^[0-9a-f]{64}$'),
  constraint photo_upload_receipt_name   check (pg_catalog.length(file_name) between 1 and 300),
  constraint photo_upload_receipt_size   check (byte_size > 0),
  constraint photo_upload_receipt_hints  check (pg_catalog.jsonb_typeof(hints) = 'object'),
  constraint photo_upload_receipt_state  check (state in ('receiving', 'waiting', 'imported', 'unplaced', 'duplicate', 'refused')),
  constraint photo_upload_receipt_reason check (pg_catalog.length(reason) <= 1000),
  constraint photo_upload_receipt_once   unique (token_id, sha256)
);

comment on table meganet.photo_upload_receipt is
  'One row per photo the upload API accepted (0127). receiving: the bytes are on their way into the R2 inbox; waiting: in the inbox for the next sync run; imported / unplaced / duplicate / refused: what became of it, as meganet.field_photo_outcome says. Unique per (key, SHA-256), so a photo sent again with the same key is the same receipt.';
comment on column meganet.photo_upload_receipt.hints is
  'What the sending app said about the photo: station_id, caption, lat, lon, taken_at. Used only where the photo itself says nothing (placement and taken_source ''sender'').';

create index if not exists photo_upload_receipt_waiting_idx on meganet.photo_upload_receipt (received_at) where state = 'waiting';
create index if not exists photo_upload_receipt_token_idx   on meganet.photo_upload_receipt (token_id, received_at desc);

alter table meganet.photo_upload_token   enable row level security;
alter table meganet.photo_upload_receipt enable row level security;

-- ── 4a. The Admin tab: list, mint, revoke ────────────────────────────────────

create or replace function meganet.admin_photo_upload_tokens()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform meganet.admin_require();
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'id',           t.id,
             'label',        t.label,
             'day_limit',    t.day_limit,
             'expires_at',   t.expires_at,
             'created_at',   t.created_at,
             'created_by',   t.created_by,
             'revoked_at',   t.revoked_at,
             'last_used_at', t.last_used_at,
             'day_used',     (select pg_catalog.count(*) from meganet.photo_upload_receipt r
                               where r.token_id = t.id and r.received_at > pg_catalog.now() - interval '24 hours'),
             'waiting',      (select pg_catalog.count(*) from meganet.photo_upload_receipt r
                               where r.token_id = t.id and r.state in ('receiving', 'waiting')),
             'imported',     (select pg_catalog.count(*) from meganet.photo_upload_receipt r
                               where r.token_id = t.id and r.state in ('imported', 'unplaced')),
             'refused',      (select pg_catalog.count(*) from meganet.photo_upload_receipt r
                               where r.token_id = t.id and r.state = 'refused'))
           order by t.revoked_at is not null, t.last_used_at desc nulls last, t.id desc)
      from meganet.photo_upload_token t), '[]'::jsonb);
end;
$$;

comment on function meganet.admin_photo_upload_tokens() is
  'Every photo upload key, for the Admin tab (0127): label, daily allowance and use, end date, who made it, last used, revoked, and its receipts counted. Never the hash. Administrators only.';

create or replace function meganet.admin_create_photo_upload_token(
         p_label      text,
         p_day_limit  integer     default 500,
         p_expires_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_label text := pg_catalog.btrim(coalesce(p_label, ''));
  v_day   integer := coalesce(p_day_limit, 500);
  v_token text;
  v_id    bigint;
begin
  perform meganet.admin_require();
  if v_label = '' then
    raise exception 'a key needs a label — name the contractor or the app it is for' using errcode = '22023';
  end if;
  if pg_catalog.length(v_label) > 120 then
    raise exception 'a label of at most 120 characters, please' using errcode = '22023';
  end if;
  if v_day < 1 or v_day > 5000 then
    raise exception 'a daily allowance between 1 and 5000 photos, please' using errcode = '22023';
  end if;
  if p_expires_at is not null and p_expires_at <= pg_catalog.now() then
    raise exception 'the end date has already passed' using errcode = '22023';
  end if;
  if exists (select 1 from meganet.photo_upload_token t
              where pg_catalog.lower(t.label) = pg_catalog.lower(v_label) and t.revoked_at is null) then
    raise exception 'a live key is already called %, and two would be impossible to tell apart — choose another label, or revoke that one first', v_label
      using errcode = '23505';
  end if;

  -- Two random UUIDs, hyphens stripped: 244 random bits, from the OS's CSPRNG.
  -- fnp_ so a key is recognisable at a glance — and by secret scanners.
  v_token := 'fnp_' || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '')
                    || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');
  insert into meganet.photo_upload_token (label, token_hash, day_limit, expires_at, created_by)
  values (v_label, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_token, 'utf8')), 'hex'),
          v_day, p_expires_at, meganet.actor())
  returning id into v_id;

  return pg_catalog.jsonb_build_object('id', v_id, 'label', v_label, 'day_limit', v_day,
                                       'expires_at', p_expires_at, 'token', v_token);
end;
$$;

comment on function meganet.admin_create_photo_upload_token(text, integer, timestamptz) is
  'Mint a photo upload key from the Admin tab (0127): the plaintext is returned once and only its SHA-256 is kept. A label must be unique among live keys. Administrators only.';

create or replace function meganet.admin_revoke_photo_upload_token(p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row meganet.photo_upload_token%rowtype;
begin
  perform meganet.admin_require();
  update meganet.photo_upload_token set revoked_at = pg_catalog.now()
   where id = p_id and revoked_at is null
  returning * into v_row;
  if not found then
    select * into v_row from meganet.photo_upload_token where id = p_id;
    if not found then
      raise exception 'no photo upload key %', p_id using errcode = 'P0002';
    end if;
  end if;
  return pg_catalog.jsonb_build_object('id', v_row.id, 'label', v_row.label, 'revoked_at', v_row.revoked_at);
end;
$$;

comment on function meganet.admin_revoke_photo_upload_token(bigint) is
  'Revoke a photo upload key (0127): refused from its next request, within the minute the Worker remembers a verdict. Photos already accepted are still imported. Nothing un-revokes. Administrators only.';

-- ── 4b. The Worker: check, accept, stored, abandon, status ───────────────────

-- Whose key is this. p_hash is the SHA-256 (hex) of the key the request
-- carried; the key itself never reaches the database. Null for no key, a
-- revoked one or an expired one — the Worker says the same thing for each.
create or replace function meganet.photo_upload_check(p_hash text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
           'id', t.id, 'label', t.label, 'day_limit', t.day_limit, 'expires_at', t.expires_at,
           'day_used', (select pg_catalog.count(*) from meganet.photo_upload_receipt r
                         where r.token_id = t.id and r.received_at > pg_catalog.now() - interval '24 hours'))
    from meganet.photo_upload_token t
   where t.token_hash = p_hash
     and t.revoked_at is null
     and (t.expires_at is null or t.expires_at > pg_catalog.now());
$$;

-- A photo announced: the receipt for it, new or the one it already has.
--
--   {receipt, state, fresh: true}        new — the Worker stores the bytes next
--   {receipt, state, fresh: false}       sent before with this key — nothing to store
--   {receipt, state:'duplicate', photo_id, fresh: false}
--                                        already in Flood-Net by another way in
--   {refused: 'day_limit' | 'busy' | 'key', message}
--
-- A 'receiving' receipt over an hour old is a Worker that never said how the
-- store went; it is taken to have failed and the photo is accepted afresh.
create or replace function meganet.photo_upload_accept(p_token_id bigint, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tok    meganet.photo_upload_token%rowtype;
  v_row    meganet.photo_upload_receipt%rowtype;
  v_sha    text := pg_catalog.lower(coalesce(p ->> 'sha256', ''));
  v_hints  jsonb := coalesce(p -> 'hints', '{}'::jsonb);
  v_out    jsonb := '{}'::jsonb;
  v_key    text;
  v_lat    numeric;
  v_lon    numeric;
  v_taken  timestamptz;
  v_used   bigint;
  v_photo  uuid;
begin
  select * into v_tok from meganet.photo_upload_token
   where id = p_token_id and revoked_at is null and (expires_at is null or expires_at > pg_catalog.now())
   for update;
  if not found then
    return pg_catalog.jsonb_build_object('refused', 'key', 'message', 'this key is not live');
  end if;
  if v_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'sha256 has to be 64 hex digits' using errcode = '22023';
  end if;

  -- The same bytes with the same key: the receipt there is.
  select * into v_row from meganet.photo_upload_receipt where token_id = p_token_id and sha256 = v_sha;
  if found then
    if v_row.state = 'receiving' and v_row.received_at > pg_catalog.now() - interval '1 hour' then
      return pg_catalog.jsonb_build_object('refused', 'busy', 'receipt', v_row.id,
        'message', 'this photo is being received right now — ask again in a minute');
    elsif v_row.state <> 'receiving' then
      return pg_catalog.jsonb_build_object('receipt', v_row.id, 'state', v_row.state, 'fresh', false,
        'photo_id', v_row.photo_id, 'station_id', v_row.station_id, 'reason', v_row.reason);
    end if;
    delete from meganet.photo_upload_receipt where id = v_row.id;
  end if;

  select pg_catalog.count(*) into v_used from meganet.photo_upload_receipt r
   where r.token_id = p_token_id and r.received_at > pg_catalog.now() - interval '24 hours';
  if v_used >= v_tok.day_limit then
    return pg_catalog.jsonb_build_object('refused', 'day_limit',
      'message', pg_catalog.format('this key has sent its %s photos for the last 24 hours', v_tok.day_limit));
  end if;

  -- What the sender said, checked now so the sync never meets a bad one.
  if pg_catalog.jsonb_typeof(v_hints) <> 'object' then
    raise exception 'hints has to be a JSON object' using errcode = '22023';
  end if;
  for v_key in select pg_catalog.jsonb_object_keys(v_hints) loop
    if v_key not in ('station_id', 'caption', 'lat', 'lon', 'taken_at') then
      raise exception 'not something a photo can be sent with: %', v_key using errcode = '22023',
        hint = 'station, caption, lat, lon and taken_at are the whole list';
    end if;
  end loop;
  if nullif(v_hints ->> 'station_id', '') is not null
     and not exists (select 1 from meganet.station where id = v_hints ->> 'station_id' and deleted_at is null) then
    raise exception 'no such station: %', v_hints ->> 'station_id' using errcode = '22023';
  end if;
  if pg_catalog.length(coalesce(v_hints ->> 'caption', '')) > 1000 then
    raise exception 'a caption of at most 1000 characters, please' using errcode = '22023';
  end if;
  begin
    v_lat := (v_hints ->> 'lat')::numeric;
    v_lon := (v_hints ->> 'lon')::numeric;
  exception when others then
    raise exception 'lat and lon are numbers' using errcode = '22023';
  end;
  if (v_lat is null) <> (v_lon is null) then
    raise exception 'a position is a latitude and a longitude, or neither' using errcode = '22023';
  end if;
  if v_lat is not null and (v_lat not between -90 and 90 or v_lon not between -180 and 180) then
    raise exception 'that position is not on the Earth' using errcode = '22023';
  end if;
  begin
    v_taken := nullif(v_hints ->> 'taken_at', '')::timestamptz;
  exception when others then
    raise exception 'taken_at is not a time: %', v_hints ->> 'taken_at' using errcode = '22023';
  end;
  if v_taken is not null and v_hints ->> 'taken_at' !~ '(Z|[+-]\d\d(:?\d\d)?)$' then
    raise exception 'taken_at needs its time zone (Z or +10:00): %', v_hints ->> 'taken_at' using errcode = '22023';
  end if;

  if coalesce(p ->> 'file_name', '') = '' or pg_catalog.length(p ->> 'file_name') > 300 then
    raise exception 'a file name of 1 to 300 characters, please' using errcode = '22023';
  end if;

  -- In Flood-Net already by another way in: a receipt that says so, settled
  -- now, and nothing for the Worker to store. It still counts to the day.
  select id into v_photo from meganet.field_photo where sha256 = v_sha and deleted_at is null limit 1;

  insert into meganet.photo_upload_receipt
    (token_id, sha256, file_name, content_type, byte_size, hints, state, settled_at, reason, photo_id, station_id)
  values
    (p_token_id, v_sha, p ->> 'file_name', coalesce(p ->> 'content_type', ''), (p ->> 'byte_size')::bigint, v_hints,
     case when v_photo is null then 'receiving' else 'duplicate' end,
     case when v_photo is null then null else pg_catalog.now() end,
     case when v_photo is null then '' else 'the same photo is already in Flood-Net' end,
     v_photo,
     (select station_id from meganet.field_photo where id = v_photo))
  returning * into v_row;

  update meganet.photo_upload_token set last_used_at = pg_catalog.now() where id = p_token_id;

  return pg_catalog.jsonb_build_object('receipt', v_row.id, 'state', v_row.state, 'fresh', v_photo is null,
    'photo_id', v_row.photo_id, 'station_id', v_row.station_id, 'reason', v_row.reason);
end;
$$;

-- The bytes are in the inbox: the receipt waits for the sync.
create or replace function meganet.photo_upload_stored(p_receipt uuid)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  update meganet.photo_upload_receipt set state = 'waiting', stored_at = pg_catalog.now()
   where id = p_receipt and state = 'receiving'
  returning pg_catalog.jsonb_build_object('receipt', id, 'state', state);
$$;

-- The bytes did not arrive (cut short, or not the SHA-256 declared): the
-- receipt goes, so sending it again starts afresh.
create or replace function meganet.photo_upload_abandon(p_receipt uuid)
returns boolean
language sql
security definer
set search_path = ''
as $$
  with gone as (delete from meganet.photo_upload_receipt where id = p_receipt and state = 'receiving' returning 1)
  select exists (select 1 from gone);
$$;

-- A receipt, for the key that has it — another key's receipt is no receipt.
create or replace function meganet.photo_upload_status(p_token_id bigint, p_receipt uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
           'receipt', r.id, 'state', r.state, 'file_name', r.file_name, 'sha256', r.sha256,
           'byte_size', r.byte_size, 'received_at', r.received_at, 'settled_at', r.settled_at,
           'reason', r.reason, 'photo_id', r.photo_id, 'station_id', r.station_id)
    from meganet.photo_upload_receipt r
   where r.id = p_receipt and r.token_id = p_token_id;
$$;

-- ── 4c. The sync: waiting, settle ────────────────────────────────────────────

-- The receipts the inbox holds, oldest first, with the label of the key that
-- sent each (the photo's uploaded_by is 'api:<label>').
create or replace function meganet.photo_upload_waiting(p_limit integer default 200)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(x order by x ->> 'received_at'), '[]'::jsonb)
    from (select pg_catalog.jsonb_build_object(
                   'receipt', r.id, 'sha256', r.sha256, 'file_name', r.file_name,
                   'content_type', r.content_type, 'byte_size', r.byte_size, 'hints', r.hints,
                   'received_at', r.received_at, 'attempts', r.attempts, 'label', t.label) as x
            from meganet.photo_upload_receipt r
            join meganet.photo_upload_token t on t.id = r.token_id
           where r.state = 'waiting'
           order by r.received_at
           limit greatest(1, least(coalesce(p_limit, 200), 1000))) w;
$$;

-- What became of a waiting photo. imported / unplaced / duplicate / refused
-- settle it; failed (something trying again may mend) counts an attempt and
-- leaves it waiting, until the fifth, which refuses it. {state, final}.
create or replace function meganet.photo_upload_settle(p_receipt uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_outcome text := coalesce(p ->> 'outcome', '');
  v_reason  text := pg_catalog.left(coalesce(p ->> 'reason', ''), 1000);
  v_row     meganet.photo_upload_receipt%rowtype;
begin
  if v_outcome not in ('imported', 'unplaced', 'duplicate', 'refused', 'failed') then
    raise exception '% is not what becomes of a photo', v_outcome using errcode = '22023';
  end if;
  select * into v_row from meganet.photo_upload_receipt where id = p_receipt for update;
  if not found then
    raise exception 'no receipt %', p_receipt using errcode = 'P0002';
  end if;
  if v_row.state <> 'waiting' then
    return pg_catalog.jsonb_build_object('state', v_row.state, 'final', true);
  end if;
  if v_outcome = 'failed' then
    v_row.attempts := v_row.attempts + 1;
    if v_row.attempts < 5 then
      update meganet.photo_upload_receipt set attempts = v_row.attempts, reason = v_reason where id = p_receipt;
      return pg_catalog.jsonb_build_object('state', 'waiting', 'final', false);
    end if;
    v_outcome := 'refused';
    v_reason := pg_catalog.left('tried five times — ' || v_reason, 1000);
  end if;
  update meganet.photo_upload_receipt
     set state = v_outcome, settled_at = pg_catalog.now(), attempts = v_row.attempts, reason = v_reason,
         photo_id = case when v_outcome = 'refused' then null else nullif(p ->> 'photo_id', '')::uuid end,
         station_id = case when v_outcome = 'refused' then null
                           else (select id from meganet.station where id = nullif(p ->> 'station_id', '')) end
   where id = p_receipt;
  return pg_catalog.jsonb_build_object('state', v_outcome, 'final', true);
end;
$$;

-- ── Who may run what ─────────────────────────────────────────────────────────

revoke all on function meganet.admin_photo_upload_tokens()                                     from public;
revoke all on function meganet.admin_create_photo_upload_token(text, integer, timestamptz)    from public;
revoke all on function meganet.admin_revoke_photo_upload_token(bigint)                        from public;
revoke all on function meganet.photo_upload_check(text)                                       from public;
revoke all on function meganet.photo_upload_accept(bigint, jsonb)                             from public;
revoke all on function meganet.photo_upload_stored(uuid)                                      from public;
revoke all on function meganet.photo_upload_abandon(uuid)                                     from public;
revoke all on function meganet.photo_upload_status(bigint, uuid)                              from public;
revoke all on function meganet.photo_upload_waiting(integer)                                  from public;
revoke all on function meganet.photo_upload_settle(uuid, jsonb)                               from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;
  -- The Admin tab's three: authenticated, and each asks admin_require() too.
  grant execute on function meganet.admin_photo_upload_tokens()                                  to authenticated, service_role;
  grant execute on function meganet.admin_create_photo_upload_token(text, integer, timestamptz) to authenticated, service_role;
  grant execute on function meganet.admin_revoke_photo_upload_token(bigint)                     to authenticated, service_role;
  -- The Worker's and the sync's: the project's secret key only.
  grant execute on function meganet.photo_upload_check(text)           to service_role;
  grant execute on function meganet.photo_upload_accept(bigint, jsonb) to service_role;
  grant execute on function meganet.photo_upload_stored(uuid)          to service_role;
  grant execute on function meganet.photo_upload_abandon(uuid)         to service_role;
  grant execute on function meganet.photo_upload_status(bigint, uuid)  to service_role;
  grant execute on function meganet.photo_upload_waiting(integer)      to service_role;
  grant execute on function meganet.photo_upload_settle(uuid, jsonb)   to service_role;
  grant select, insert, update, delete on meganet.photo_upload_token, meganet.photo_upload_receipt to service_role;
  notify pgrst, 'reload schema';
end
$$;

-- ── Did it take ──────────────────────────────────────────────────────────────

do $$
begin
  if to_regprocedure('meganet.photo_upload_accept(bigint, jsonb)') is null
     or to_regprocedure('meganet.photo_upload_settle(uuid, jsonb)') is null
     or to_regprocedure('meganet.admin_create_photo_upload_token(text, integer, timestamptz)') is null then
    raise exception '0127 did not take: the photo upload functions are missing';
  end if;
  if not exists (select 1 from meganet.field_photo_origin where key = 'api')
     or not exists (select 1 from meganet.field_photo_placement where key = 'sender') then
    raise exception '0127 did not take: the api origin or the sender placement is missing';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
     and (has_table_privilege('anon', 'meganet.photo_upload_token', 'select')
          or has_table_privilege('authenticated', 'meganet.photo_upload_receipt', 'select')
          or has_function_privilege('anon', 'meganet.photo_upload_accept(bigint, jsonb)', 'execute')
          or has_function_privilege('authenticated', 'meganet.photo_upload_check(text)', 'execute')) then
    raise exception '0127 did not take: the upload keys or receipts are open to a browser';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 126 → 127 once this is applied.

insert into meganet.app_meta (key, value)
values ('schema_version', '127')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;

notify pgrst, 'reload schema';
