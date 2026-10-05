-- 0049_base_stations.sql — The Base Stations tab: every base station's health
-- in one list, and an administrator asking one of them to do something.
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0049_base_stations.sql
--
-- Why this file exists
-- ────────────────────
-- A base station is a computer in a hut with receivers plugged into it, and
-- since 0048 it can ask for its own ingest token. Once it posts, MegaNet knows
-- it only by what it sends: readings (0007), what each receiver is (0045) and
-- what it heard (0047). Whether it is healthy — up, cool, with its queue
-- draining and its receivers receiving — and changing anything on it, both
-- meant somebody going to it. This gives MegaNet a tab for both.
--
-- Four decisions.
--
-- **1. The base station calls in; MegaNet never calls out.** There is no
-- address MegaNet could dial — base stations sit behind NAT, the Bureau's
-- firewall, a cellular modem — and there should not be: a door that opens
-- inwards is a door somebody else can find. So the station checks in, through
-- the same door and with the same ingest token as its readings
-- (base_station_checkin(), granted to anon and checked by
-- meganet.ingest_token_id() like report_ingest_point()), about once a minute:
-- a heartbeat of a few hundred bytes every time, and its whole status when it
-- changed. The answer tells it when to check in next — every five seconds
-- while an administrator has it open (watch_until, set by
-- admin_base_station_watch()) — and hands over anything asked of it. A request
-- therefore waits for the next check-in: a minute at worst for the first one,
-- seconds after that.
--
-- **2. What may be asked is a short list, checked twice.** status, log,
-- config.set, device.restart, device.rescan, device.forget, send-now,
-- stations.refresh, agent.restart, reboot, update.check, update.install,
-- update.auto, access.sync — base_station_verb_check() below, and the base
-- station holds itself to the same list again. config.set may not touch the
-- web page's password or port, what the station lets MegaNet do (`remote`), or
-- any MegaNet setting but whether to send — so a request can never take the
-- token, point the readings somewhere else, or widen what MegaNet may ask.
-- Nothing on the list is a shell, a file or a credential, and nothing secret
-- crosses in either direction: a status carries the station's settings less
-- its token, and the SSH keys below are public keys. A request is handed over
-- once (sent), answered once (done or failed), and one nobody collected within
-- ten minutes reads as expired rather than running hours later; at most 20
-- wait per station.
--
-- **3. The station decides how much of this it takes.** It says, every
-- check-in, whether it manages (health, and the list above), only reports
-- (health; anything asked fails at once, here, with the reason), or has
-- turned this off (it says so once and stops checking in). That choice is
-- made on the station and nowhere else — config.set cannot reach it.
--
-- **4. Team SSH keys are public keys, and the station fetches them.** A
-- station's maintenance login is opened by a list of SSH keys, one per person
-- (the station's own docs/access.md). base_station_key is MegaNet's share of
-- that list: public keys an administrator adds and removes here, served to any
-- base station holding a live token (base_station_keys()), and taken only by
-- one whose owner said so on the station. The hash every check-in answers lets
-- a station notice within a minute that the list changed. MegaNet never holds a
-- password, a private key or anything else that would open a station by
-- itself.
--
-- Who can read it: administrators, through the admin_* functions only — a
-- status names the station's addresses and who may log in. RLS on, no policy
-- and no grant on all three tables, as for meganet.ingest_token_request (0048).

-- ── What each base station last said ─────────────────────────────────────────

create table if not exists meganet.base_station (
  ingest_token_id  bigint       primary key references meganet.ingest_token (id),
  -- The software checking in, as it names itself, and its version.
  app              text,
  version          text,
  -- manage, report or off — the station's own choice (decision 3).
  mode             text         not null default 'manage',
  -- How often it checks in when nobody is watching, as it says.
  idle_s           integer      not null default 60,
  -- The whole status, when it last sent one: receivers, uplink, clock,
  -- software, SSH access (fingerprints, never keys), settings less the token.
  status           jsonb,
  status_at        timestamptz,
  -- The heartbeat every check-in carries: uptime, temperature, queue, each
  -- receiver's state.
  beat             jsonb,
  beat_at          timestamptz,
  first_seen_at    timestamptz  not null default now(),
  last_seen_at     timestamptz  not null default now(),
  checkins         bigint       not null default 0,
  -- An administrator has it open: answer "every five seconds" until then.
  watch_until      timestamptz,
  -- An administrator asked for the whole status; cleared when it arrives.
  want_status      boolean      not null default false,
  -- The team keys the station last said it holds (decision 4).
  keys_hash        text,

  constraint base_station_mode      check (mode in ('manage', 'report', 'off')),
  constraint base_station_idle      check (idle_s between 30 and 900),
  constraint base_station_status    check (status is null or (pg_catalog.jsonb_typeof(status) = 'object'
                                                              and pg_catalog.octet_length(status::text) <= 16384)),
  constraint base_station_beat      check (beat is null or (pg_catalog.jsonb_typeof(beat) = 'object'
                                                            and pg_catalog.octet_length(beat::text) <= 2048)),
  constraint base_station_app       check (app is null or pg_catalog.length(app) <= 40),
  constraint base_station_version   check (version is null or pg_catalog.length(version) <= 40),
  constraint base_station_keys_hash check (keys_hash is null or pg_catalog.length(keys_hash) <= 128)
);

comment on table meganet.base_station is
  'What each base station said about itself at its last check-in (0049): heartbeat, whole status, software, and how much MegaNet may do. One row per ingest token that has checked in. RLS on, no policy and no grant: read through admin_base_stations() and admin_base_station(), written only by base_station_checkin() and admin_base_station_watch().';
comment on column meganet.base_station.mode is
  'manage (health, and the requests base_station_verb_check() allows), report (health only), or off (the station turned check-ins off and said so). The station''s choice; nothing here can change it.';
comment on column meganet.base_station.watch_until is
  'An administrator has this station open on the Base Stations tab: until then its check-ins are answered "every five seconds".';

alter table meganet.base_station enable row level security;

-- ── What administrators asked ────────────────────────────────────────────────

create table if not exists meganet.base_station_command (
  id               bigint       generated always as identity primary key,
  ingest_token_id  bigint       not null references meganet.ingest_token (id),
  verb             text         not null,
  args             jsonb        not null default '{}'::jsonb,
  -- queued → sent (handed over, once) → done | failed; or cancelled. A queued
  -- request past expires_at reads as expired: worked out, not stored, so it
  -- can never disagree with the clock (0048's rule).
  status           text         not null default 'queued',
  created_at       timestamptz  not null default now(),
  created_by       text         not null,
  expires_at       timestamptz  not null,
  sent_at          timestamptz,
  done_at          timestamptz,
  result           jsonb,
  error            text,

  constraint base_station_command_status check (status in ('queued', 'sent', 'done', 'failed', 'cancelled')),
  constraint base_station_command_verb   check (verb ~ '^[a-z][a-z.-]{1,39}$'),
  constraint base_station_command_args   check (pg_catalog.jsonb_typeof(args) = 'object' and pg_catalog.octet_length(args::text) <= 8192),
  constraint base_station_command_result check (result is null or pg_catalog.octet_length(result::text) <= 65536),
  constraint base_station_command_error  check (error is null or pg_catalog.length(error) <= 1000)
);

comment on table meganet.base_station_command is
  'A request an administrator made of a base station (0049): handed over once at its next check-in, answered once. RLS on, no policy and no grant: made through admin_base_station_command(), read through admin_base_station(), answered through base_station_checkin().';

create index if not exists base_station_command_station_idx
  on meganet.base_station_command (ingest_token_id, id desc);
create index if not exists base_station_command_queued_idx
  on meganet.base_station_command (ingest_token_id, id) where status = 'queued';

alter table meganet.base_station_command enable row level security;

-- ── Team SSH keys ────────────────────────────────────────────────────────────

create table if not exists meganet.base_station_key (
  id           bigint       generated always as identity primary key,
  key_type     text         not null,
  key_b64      text         not null,
  -- As ssh-keygen -l prints it: SHA256: and the digest in base64, unpadded.
  fingerprint  text         not null,
  -- Whose key: the one thing a station's list shows besides the fingerprint.
  owner        text         not null,
  -- The key's own comment, as pasted (you@laptop).
  comment      text,
  added_at     timestamptz  not null default now(),
  added_by     text         not null,
  removed_at   timestamptz,
  removed_by   text,

  constraint base_station_key_type   check (key_type in ('ssh-ed25519', 'sk-ssh-ed25519@openssh.com', 'ecdsa-sha2-nistp256',
                                                         'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'sk-ecdsa-sha2-nistp256@openssh.com', 'ssh-rsa')),
  constraint base_station_key_b64    check (key_b64 ~ '^[A-Za-z0-9+/]+={0,2}$' and pg_catalog.length(key_b64) <= 2048),
  constraint base_station_key_fp     check (fingerprint ~ '^SHA256:[A-Za-z0-9+/]{43}$'),
  constraint base_station_key_owner  check (pg_catalog.length(owner) between 1 and 120 and owner !~ '[[:cntrl:]]'),
  constraint base_station_key_note   check (comment is null or pg_catalog.length(comment) <= 120),
  constraint base_station_key_gone   check ((removed_at is null) = (removed_by is null))
);

comment on table meganet.base_station_key is
  'MegaNet''s team SSH keys (0049): public keys only, which a base station whose owner allows it installs for its maintenance account. Kept after removal (removed_at) as the record of who could get in, when. RLS on, no policy and no grant.';

-- One live row per key.
create unique index if not exists base_station_key_live_idx
  on meganet.base_station_key (fingerprint) where removed_at is null;

alter table meganet.base_station_key enable row level security;

-- ── The list's fingerprint ───────────────────────────────────────────────────
-- What every check-in answers, so a station notices within a minute that the
-- team's keys changed and fetches them (its root helper does; the station's
-- agent only asks it to).

create or replace function meganet.base_station_keys_hash()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(
           (select pg_catalog.string_agg(k.key_type || ' ' || k.key_b64 || ' ' || k.owner, E'\n' order by k.fingerprint)
              from meganet.base_station_key k where k.removed_at is null), ''), 'utf8')), 'hex');
$$;

comment on function meganet.base_station_keys_hash() is
  'sha256 (hex) of the live team SSH keys and their owners (0049) — what a check-in compares with the list a station holds. Internal.';

-- ── What may be asked (decision 2) ───────────────────────────────────────────
-- null for a request that may be made, else why not. The base station checks
-- the same list again: this is the half that refuses before anything waits.

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
      if v_patch ?| array['web', 'remote', 'version'] then
        return 'the web page''s password and port, and what the base station lets MegaNet do, are set on the base station itself';
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

comment on function meganet.base_station_verb_check(text, jsonb) is
  'Why a request may not be made of a base station, or null if it may (0049, decision 2): the fixed list of verbs, their arguments, and config.set kept away from the token, the endpoints, the web page and the station''s own remote settings. Internal.';

-- ── The door a base station checks in at ─────────────────────────────────────
-- POST /rest/v1/rpc/base_station_checkin, X-Ingest-Token, body
--   {"payload": {"v": 1, "agent": {"app", "version"}, "mode": "manage",
--                "idle_s": 60, "beat": {…}, "status": {…}, "results": [{"id",
--                "ok", "result", "error"}], "keys_hash": "…"}}
-- → {"next_s", "watch", "want_status", "commands": [{"id", "verb", "args"}],
--    "keys_hash", "label", "at"}

create or replace function meganet.base_station_checkin(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token    bigint;
  v_mode     text;
  v_idle     integer;
  v_status   jsonb;
  v_beat     jsonb;
  v_results  jsonb;
  v_keys     text;
  v_r        jsonb;
  v_row      meganet.base_station;
  v_cmds     jsonb := '[]'::jsonb;
  v_watch    boolean;
  v_label    text;
begin
  v_token := meganet.ingest_token_id();   -- PT401 for a missing, unknown or revoked token

  if payload is null or pg_catalog.jsonb_typeof(payload) <> 'object' then
    raise exception 'base_station_checkin takes an object, got %', coalesce(pg_catalog.jsonb_typeof(payload), 'null')
      using errcode = '22023';
  end if;
  if coalesce(payload ->> 'v', '1') <> '1' then
    raise exception 'this MegaNet takes check-ins of version 1, not %', pg_catalog.left(payload ->> 'v', 10)
      using errcode = '22023';
  end if;

  v_mode := coalesce(payload ->> 'mode', 'manage');
  if v_mode not in ('manage', 'report', 'off') then
    raise exception 'mode is manage, report or off, not %', pg_catalog.left(v_mode, 20) using errcode = '22023';
  end if;
  v_idle := case when pg_catalog.jsonb_typeof(payload -> 'idle_s') = 'number'
                 then greatest(30, least(900, pg_catalog.round((payload ->> 'idle_s')::numeric)::integer)) else 60 end;

  v_status := nullif(payload -> 'status', 'null'::jsonb);
  if v_status is not null and (pg_catalog.jsonb_typeof(v_status) <> 'object' or pg_catalog.octet_length(v_status::text) > 16384) then
    raise exception 'status is an object of at most 16 KB' using errcode = '22023';
  end if;
  v_beat := nullif(payload -> 'beat', 'null'::jsonb);
  if v_beat is not null and (pg_catalog.jsonb_typeof(v_beat) <> 'object' or pg_catalog.octet_length(v_beat::text) > 2048) then
    raise exception 'beat is an object of at most 2 KB' using errcode = '22023';
  end if;
  v_results := nullif(payload -> 'results', 'null'::jsonb);
  if v_results is not null and (pg_catalog.jsonb_typeof(v_results) <> 'array' or pg_catalog.jsonb_array_length(v_results) > 20) then
    raise exception 'results is a list of at most 20 answers' using errcode = '22023';
  end if;
  v_keys := pg_catalog.left(nullif(payload ->> 'keys_hash', ''), 128);

  insert into meganet.base_station as b
    (ingest_token_id, app, version, mode, idle_s, status, status_at, beat, beat_at, last_seen_at, checkins, keys_hash)
  values
    (v_token, pg_catalog.left(payload -> 'agent' ->> 'app', 40), pg_catalog.left(payload -> 'agent' ->> 'version', 40),
     v_mode, v_idle, v_status, case when v_status is not null then pg_catalog.now() end,
     v_beat, case when v_beat is not null then pg_catalog.now() end, pg_catalog.now(), 1, v_keys)
  on conflict (ingest_token_id) do update set
    app          = coalesce(excluded.app, b.app),
    version      = coalesce(excluded.version, b.version),
    mode         = excluded.mode,
    idle_s       = excluded.idle_s,
    status       = coalesce(excluded.status, b.status),
    status_at    = coalesce(excluded.status_at, b.status_at),
    beat         = coalesce(excluded.beat, b.beat),
    beat_at      = coalesce(excluded.beat_at, b.beat_at),
    last_seen_at = pg_catalog.now(),
    checkins     = b.checkins + 1,
    keys_hash    = coalesce(excluded.keys_hash, b.keys_hash),
    want_status  = case when excluded.status is not null then false else b.want_status end
  returning * into v_row;

  -- The answers to what was handed over — this station's own requests only.
  for v_r in select * from pg_catalog.jsonb_array_elements(coalesce(v_results, '[]'::jsonb)) loop
    continue when pg_catalog.jsonb_typeof(v_r) <> 'object' or pg_catalog.jsonb_typeof(v_r -> 'id') <> 'number';
    continue when (v_r ->> 'id')::numeric not between 1 and 9000000000000000000;
    update meganet.base_station_command c
       set status  = case when v_r -> 'ok' = 'true'::jsonb then 'done' else 'failed' end,
           result  = case when v_r -> 'result' is null then null
                          when pg_catalog.octet_length((v_r -> 'result')::text) <= 65536 then nullif(v_r -> 'result', 'null'::jsonb)
                          else pg_catalog.jsonb_build_object('truncated', true) end,
           error   = pg_catalog.left(v_r ->> 'error', 1000),
           done_at = pg_catalog.now()
     where c.id = (v_r ->> 'id')::numeric::bigint
       and c.ingest_token_id = v_token
       and c.status in ('sent', 'queued');
  end loop;

  if v_mode = 'manage' then
    -- Handed over once, ten at a time, oldest first.
    with picked as (
      select c.id from meganet.base_station_command c
       where c.ingest_token_id = v_token and c.status = 'queued' and c.expires_at > pg_catalog.now()
       order by c.id
       limit 10
       for update skip locked),
    handed as (
      update meganet.base_station_command c
         set status = 'sent', sent_at = pg_catalog.now()
        from picked where c.id = picked.id
      returning c.id, c.verb, c.args)
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', h.id, 'verb', h.verb, 'args', h.args) order by h.id), '[]'::jsonb)
      into v_cmds from handed h;
  else
    -- Decision 3: a station that only reports, or has turned this off, is never
    -- handed a request; anything waiting fails now, saying why.
    update meganet.base_station_command c
       set status = 'failed', done_at = pg_catalog.now(),
           error = case v_mode when 'report' then 'the base station only reports — its owner has turned requests off'
                               else 'the base station has turned remote management off' end
     where c.ingest_token_id = v_token and c.status = 'queued';
  end if;

  -- Housekeeping, this station's own: requests a quarter of a year old.
  delete from meganet.base_station_command c
   where c.ingest_token_id = v_token and c.created_at < pg_catalog.now() - interval '90 days';

  v_watch := v_row.watch_until is not null and v_row.watch_until > pg_catalog.now();
  select t.label into v_label from meganet.ingest_token t where t.id = v_token;

  return pg_catalog.jsonb_build_object(
    'next_s',      case when v_mode = 'off' then null
                        when v_watch then 5
                        when exists (select 1 from meganet.base_station_command c
                                      where c.ingest_token_id = v_token and c.status = 'queued' and c.expires_at > pg_catalog.now()) then 2
                        else v_idle end,
    'watch',       v_watch,
    'want_status', v_row.want_status,
    'commands',    v_cmds,
    'keys_hash',   meganet.base_station_keys_hash(),
    'label',       v_label,
    'at',          pg_catalog.now());
end;
$$;

comment on function meganet.base_station_checkin(jsonb) is
  'A base station checks in (0049): token-checked like report_ingest_point(); records its heartbeat, its whole status when it sends one, its mode and the answers to what it was asked; hands over up to ten requests (to a station that manages — a reporting one''s fail with the reason); answers when to check in next (5 s while an administrator watches) and the team keys'' hash. Granted to anon: the token is the authority.';

-- ── The team keys, for a station that takes them ─────────────────────────────
-- POST /rest/v1/rpc/base_station_keys, X-Ingest-Token, {"payload": {}}.
-- Public keys and whose they are; the station's root helper fetches them.

create or replace function meganet.base_station_keys(payload jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform meganet.ingest_token_id();
  return pg_catalog.jsonb_build_object(
    'hash', meganet.base_station_keys_hash(),
    'keys', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'key', k.key_type || ' ' || k.key_b64, 'comment', k.owner, 'fingerprint', k.fingerprint) order by k.id)
        from meganet.base_station_key k where k.removed_at is null), '[]'::jsonb));
end;
$$;

comment on function meganet.base_station_keys(jsonb) is
  'MegaNet''s team SSH keys for a base station holding a live ingest token (0049): public keys, whose they are, and the list''s hash. A station installs them only if its owner said so on the station. Granted to anon: the token is the authority.';

-- ── The Base Stations tab ────────────────────────────────────────────────────

-- One station as the list shows it — the whole status but the settings and
-- the SSH detail, which only the station's own panel needs.
create or replace function meganet.base_station_row(p_token meganet.ingest_token, p_station meganet.base_station, p_now timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'id',              p_token.id,
    'label',           p_token.label,
    'host_station_id', p_token.host_station_id,
    'host_station',    (select s.name from meganet.station s where s.id = p_token.host_station_id),
    'created_at',      p_token.created_at,
    'last_used_at',    p_token.last_used_at,
    'revoked_at',      p_token.revoked_at,
    'managed',         p_station.ingest_token_id is not null,
    'app',             p_station.app,
    'version',         p_station.version,
    'mode',            p_station.mode,
    'idle_s',          p_station.idle_s,
    'first_seen_at',   p_station.first_seen_at,
    'last_seen_at',    p_station.last_seen_at,
    'checkins',        p_station.checkins,
    'status',          p_station.status - 'config' - 'access',
    'status_at',       p_station.status_at,
    'access',          case when p_station.status ? 'access' then pg_catalog.jsonb_build_object(
                         'available',    p_station.status -> 'access' -> 'available',
                         'meganet_keys', p_station.status -> 'access' -> 'policy' -> 'meganetKeys',
                         'keys',         pg_catalog.jsonb_array_length(coalesce(p_station.status -> 'access' -> 'keys', '[]'::jsonb)),
                         'ssh',          p_station.status -> 'access' -> 'ssh' -> 'active') end,
    'beat',            p_station.beat,
    'beat_at',         p_station.beat_at,
    'watch_until',     p_station.watch_until,
    'keys_hash',       p_station.keys_hash,
    'waiting',         (select pg_catalog.count(*) from meganet.base_station_command c
                         where c.ingest_token_id = p_token.id and c.status = 'queued' and c.expires_at > p_now),
    'receivers',       coalesce((
                         select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                                  'point_id', p.point_id, 'name', p.name, 'receiver', p.receiver, 'last_seen_at', p.last_seen_at)
                                order by p.last_seen_at desc)
                           from meganet.ingest_point_latest p where p.ingest_token_id = p_token.id), '[]'::jsonb));
$$;

comment on function meganet.base_station_row(meganet.ingest_token, meganet.base_station, timestamptz) is
  'One base station as the Base Stations tab lists it (0049). Internal.';

create or replace function meganet.admin_base_stations()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.now();
begin
  perform meganet.admin_require();
  return pg_catalog.jsonb_build_object(
    'now', v_now,
    'keys_hash', meganet.base_station_keys_hash(),
    'stations', coalesce((
      select pg_catalog.jsonb_agg(meganet.base_station_row(t, b, v_now)
               order by (b.ingest_token_id is null), b.last_seen_at desc nulls last, t.last_used_at desc nulls last, t.id desc)
        from meganet.ingest_token t
        left join meganet.base_station b on b.ingest_token_id = t.id
       where t.revoked_at is null or b.last_seen_at > v_now - interval '30 days'), '[]'::jsonb));
end;
$$;

comment on function meganet.admin_base_stations() is
  'Every ingest point for the Base Stations tab (0049): each live token — and a revoked one heard from in the last 30 days — with its last check-in, heartbeat and status (less settings and SSH detail), how many requests wait, and its receivers (0045). Those that never checked in are listed too, as not managed. Administrators only.';

create or replace function meganet.admin_base_station(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.now();
  v_t   meganet.ingest_token;
  v_b   meganet.base_station;
begin
  perform meganet.admin_require();
  select * into v_t from meganet.ingest_token where id = p_id;
  if not found then
    raise exception 'no ingest token %', p_id using errcode = '22023';
  end if;
  select * into v_b from meganet.base_station where ingest_token_id = p_id;
  return pg_catalog.jsonb_build_object(
    'now', v_now,
    'keys_hash', meganet.base_station_keys_hash(),
    'station', meganet.base_station_row(v_t, v_b, v_now) || pg_catalog.jsonb_build_object('status', v_b.status, 'want_status', v_b.want_status),
    'commands', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'id', c.id, 'verb', c.verb, 'args', c.args,
               'status', case when c.status = 'queued' and c.expires_at <= v_now then 'expired' else c.status end,
               'created_at', c.created_at, 'created_by', c.created_by, 'expires_at', c.expires_at,
               'sent_at', c.sent_at, 'done_at', c.done_at, 'result', c.result, 'error', c.error) order by c.id desc)
        from (select * from meganet.base_station_command x where x.ingest_token_id = p_id order by x.id desc limit 50) c), '[]'::jsonb));
end;
$$;

comment on function meganet.admin_base_station(bigint) is
  'One base station for its panel on the Base Stations tab (0049): everything the list says, its whole status, and its last 50 requests with what became of each. Administrators only.';

-- Asking: the station must have checked in, still hold a live token, and
-- manage (decision 3); the request must be on the list (decision 2); at most
-- 20 wait. Opening the request also starts the fast check-ins.
create or replace function meganet.admin_base_station_command(p_id bigint, p_verb text, p_args jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_b     meganet.base_station;
  v_rev   timestamptz;
  v_why   text;
  v_cmd   meganet.base_station_command;
begin
  perform meganet.admin_require();
  select * into v_b from meganet.base_station where ingest_token_id = p_id for update;
  if not found then
    raise exception 'that ingest point has never checked in, so it cannot be asked anything — its software does not take requests'
      using errcode = '22023';
  end if;
  select t.revoked_at into v_rev from meganet.ingest_token t where t.id = p_id;
  if v_rev is not null then
    raise exception 'its ingest token is revoked, so it can no longer check in' using errcode = '22023';
  end if;
  if v_b.mode <> 'manage' then
    raise exception '%', case v_b.mode when 'report' then 'it only reports — its owner has turned requests off on the base station'
                                      else 'it has turned remote management off' end
      using errcode = '22023';
  end if;
  v_why := meganet.base_station_verb_check(p_verb, coalesce(p_args, '{}'::jsonb));
  if v_why is not null then
    raise exception '%', v_why using errcode = '22023';
  end if;
  if (select pg_catalog.count(*) from meganet.base_station_command c
       where c.ingest_token_id = p_id and c.status = 'queued' and c.expires_at > pg_catalog.now()) >= 20 then
    raise exception '20 requests are already waiting for this base station — let it catch up' using errcode = 'PT429';
  end if;

  insert into meganet.base_station_command (ingest_token_id, verb, args, created_by, expires_at)
  values (p_id, p_verb, coalesce(p_args, '{}'::jsonb), meganet.actor(), pg_catalog.now() + interval '10 minutes')
  returning * into v_cmd;

  update meganet.base_station
     set watch_until = greatest(coalesce(watch_until, pg_catalog.now()), pg_catalog.now() + interval '3 minutes')
   where ingest_token_id = p_id;

  return pg_catalog.jsonb_build_object('id', v_cmd.id, 'verb', v_cmd.verb, 'args', v_cmd.args, 'status', v_cmd.status,
    'created_at', v_cmd.created_at, 'created_by', v_cmd.created_by, 'expires_at', v_cmd.expires_at);
end;
$$;

comment on function meganet.admin_base_station_command(bigint, text, jsonb) is
  'Ask a base station to do something (0049): one of the requests base_station_verb_check() allows, of a station that checked in, holds a live token and manages; handed over at its next check-in, expired if not collected in ten minutes; at most 20 waiting (PT429). Starts the five-second check-ins. Administrators only.';

create or replace function meganet.admin_base_station_cancel(p_command_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cmd meganet.base_station_command;
begin
  perform meganet.admin_require();
  update meganet.base_station_command
     set status = 'cancelled', done_at = pg_catalog.now()
   where id = p_command_id and status = 'queued'
  returning * into v_cmd;
  if v_cmd.id is null then
    select * into v_cmd from meganet.base_station_command where id = p_command_id;
    if not found then
      raise exception 'no request %', p_command_id using errcode = '22023';
    end if;
    raise exception 'that request is % already — only one still waiting can be cancelled', v_cmd.status using errcode = '22023';
  end if;
  return pg_catalog.jsonb_build_object('id', v_cmd.id, 'status', v_cmd.status);
end;
$$;

comment on function meganet.admin_base_station_cancel(bigint) is
  'Cancel a request that is still waiting for its base station (0049). One already handed over cannot be called back. Administrators only.';

-- An administrator has the station open: five-second check-ins for three
-- minutes, renewed while the panel stays open; p_status asks for the whole
-- status with the next one.
create or replace function meganet.admin_base_station_watch(p_id bigint, p_status boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_b meganet.base_station;
begin
  perform meganet.admin_require();
  update meganet.base_station
     set watch_until = greatest(coalesce(watch_until, pg_catalog.now()), pg_catalog.now() + interval '3 minutes'),
         want_status = want_status or coalesce(p_status, false)
   where ingest_token_id = p_id
  returning * into v_b;
  if v_b.ingest_token_id is null then
    raise exception 'that ingest point has never checked in' using errcode = '22023';
  end if;
  return pg_catalog.jsonb_build_object('id', p_id, 'watch_until', v_b.watch_until, 'want_status', v_b.want_status,
    'next_checkin_by', v_b.last_seen_at + pg_catalog.make_interval(secs => v_b.idle_s * 1.1));
end;
$$;

comment on function meganet.admin_base_station_watch(bigint, boolean) is
  'An administrator has a base station open (0049): its check-ins are answered "every five seconds" for three minutes from now; p_status asks for its whole status at the next one. Administrators only.';

-- ── The team keys, on the tab ────────────────────────────────────────────────

-- A pasted public key → its parts, or 22023 saying what is wrong with it. The
-- base station checks every key again the way OpenSSH reads them; this is the
-- half that refuses before a bad one is listed.
create or replace function meganet.base_station_key_parse(p_text text,
         out key_type text, out key_b64 text, out comment text, out fingerprint text)
language plpgsql
immutable
set search_path = ''
as $$
declare
  m       text[];
  v_blob  bytea;
  v_len   integer;
  v_off   integer;
  v_bits  integer;
begin
  m := pg_catalog.regexp_match(pg_catalog.btrim(coalesce(p_text, '')), '^(\S+)\s+([A-Za-z0-9+/]+={0,2})(?:\s+(.*))?$');
  if m is null then
    raise exception 'that is not a public key — paste the whole line of the .pub file: its type, the key, and a comment'
      using errcode = '22023';
  end if;
  key_type := m[1];
  key_b64  := m[2];
  if key_type not in ('ssh-ed25519', 'sk-ssh-ed25519@openssh.com', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384',
                      'ecdsa-sha2-nistp521', 'sk-ecdsa-sha2-nistp256@openssh.com', 'ssh-rsa') then
    raise exception 'a % key is not accepted — use ssh-ed25519 (or ECDSA, or RSA of 2048 bits or more)', pg_catalog.left(key_type, 40)
      using errcode = '22023';
  end if;
  begin
    v_blob := pg_catalog.decode(key_b64, 'base64');
  exception when others then
    raise exception 'the key is cut short or mistyped' using errcode = '22023';
  end;
  if pg_catalog.length(key_b64) % 4 <> 0 or pg_catalog.length(v_blob) < 20 then
    raise exception 'the key is cut short or mistyped' using errcode = '22023';
  end if;
  -- An SSH key blob begins with its own type, as a length and the name.
  v_len := (pg_catalog.get_byte(v_blob, 0) << 24) | (pg_catalog.get_byte(v_blob, 1) << 16)
         | (pg_catalog.get_byte(v_blob, 2) << 8) | pg_catalog.get_byte(v_blob, 3);
  if v_len <> pg_catalog.length(key_type) or pg_catalog.length(v_blob) < 4 + v_len
     or pg_catalog.convert_from(pg_catalog.substr(v_blob, 5, v_len), 'SQL_ASCII') <> key_type then
    raise exception 'the key does not match its type (%)', key_type using errcode = '22023';
  end if;
  if key_type = 'ssh-ed25519' and pg_catalog.length(v_blob) <> 51 then
    raise exception 'the Ed25519 key is cut short' using errcode = '22023';
  end if;
  if key_type = 'ssh-rsa' then
    -- The exponent, then the modulus: its length less a leading zero byte.
    v_off := 4 + v_len;
    v_len := (pg_catalog.get_byte(v_blob, v_off) << 24) | (pg_catalog.get_byte(v_blob, v_off + 1) << 16)
           | (pg_catalog.get_byte(v_blob, v_off + 2) << 8) | pg_catalog.get_byte(v_blob, v_off + 3);
    v_off := v_off + 4 + v_len;
    if v_off + 4 > pg_catalog.length(v_blob) then
      raise exception 'the RSA key is cut short' using errcode = '22023';
    end if;
    v_len := (pg_catalog.get_byte(v_blob, v_off) << 24) | (pg_catalog.get_byte(v_blob, v_off + 1) << 16)
           | (pg_catalog.get_byte(v_blob, v_off + 2) << 8) | pg_catalog.get_byte(v_blob, v_off + 3);
    v_bits := (v_len - case when pg_catalog.get_byte(v_blob, v_off + 4) = 0 then 1 else 0 end) * 8;
    if v_bits < 2048 then
      raise exception 'RSA keys under 2048 bits are refused' using errcode = '22023';
    end if;
  end if;
  comment := nullif(pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(m[3], ''), '[[:cntrl:]]+', ' ', 'g')), 120), '');
  fingerprint := 'SHA256:' || pg_catalog.rtrim(pg_catalog.encode(pg_catalog.sha256(v_blob), 'base64'), '=');
end;
$$;

comment on function meganet.base_station_key_parse(text) is
  'A pasted SSH public key: its type, key, comment and SHA256 fingerprint as ssh-keygen -l prints it — or 22023 saying what is wrong (0049). Internal.';

create or replace function meganet.admin_base_station_keys()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform meganet.admin_require();
  return pg_catalog.jsonb_build_object(
    'hash', meganet.base_station_keys_hash(),
    'keys', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'id', k.id, 'key_type', k.key_type, 'fingerprint', k.fingerprint, 'owner', k.owner, 'comment', k.comment,
               'added_at', k.added_at, 'added_by', k.added_by, 'removed_at', k.removed_at, 'removed_by', k.removed_by)
             order by k.removed_at is not null, k.added_at desc)
        from meganet.base_station_key k
       where k.removed_at is null or k.removed_at > pg_catalog.now() - interval '90 days'), '[]'::jsonb));
end;
$$;

comment on function meganet.admin_base_station_keys() is
  'The team SSH keys (0049): every live one and every one removed in the last 90 days, with who added and removed it. Never the key itself — its fingerprint. Administrators only.';

create or replace function meganet.admin_base_station_key_add(p_public_key text, p_owner text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_k     record;
  v_owner text := pg_catalog.btrim(coalesce(p_owner, ''));
  v_id    bigint;
begin
  perform meganet.admin_require();
  if v_owner = '' or pg_catalog.length(v_owner) > 120 or v_owner ~ '[[:cntrl:]]' then
    raise exception 'say whose key it is — a name, one line, at most 120 characters' using errcode = '22023';
  end if;
  select * into v_k from meganet.base_station_key_parse(p_public_key);
  if exists (select 1 from meganet.base_station_key k where k.fingerprint = v_k.fingerprint and k.removed_at is null) then
    raise exception 'that key is on the list already' using errcode = '23505';
  end if;
  insert into meganet.base_station_key (key_type, key_b64, fingerprint, owner, comment, added_by)
  values (v_k.key_type, v_k.key_b64, v_k.fingerprint, v_owner, v_k.comment, meganet.actor())
  returning id into v_id;
  return pg_catalog.jsonb_build_object('id', v_id, 'fingerprint', v_k.fingerprint, 'key_type', v_k.key_type, 'owner', v_owner,
    'hash', meganet.base_station_keys_hash());
end;
$$;

comment on function meganet.admin_base_station_key_add(text, text) is
  'Add a team SSH public key, and whose it is (0049). Checked and fingerprinted; one live row per key. Base stations that take the team keys install it within a minute (checking in) or an hour. Administrators only.';

create or replace function meganet.admin_base_station_key_remove(p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_k meganet.base_station_key;
begin
  perform meganet.admin_require();
  update meganet.base_station_key
     set removed_at = pg_catalog.now(), removed_by = meganet.actor()
   where id = p_id and removed_at is null
  returning * into v_k;
  if v_k.id is null then
    if not exists (select 1 from meganet.base_station_key where id = p_id) then
      raise exception 'no team key %', p_id using errcode = '22023';
    end if;
    select * into v_k from meganet.base_station_key where id = p_id;
  end if;
  return pg_catalog.jsonb_build_object('id', v_k.id, 'fingerprint', v_k.fingerprint, 'owner', v_k.owner,
    'removed_at', v_k.removed_at, 'hash', meganet.base_station_keys_hash());
end;
$$;

comment on function meganet.admin_base_station_key_remove(bigint) is
  'Take a team SSH key off the list (0049): base stations drop it at their next fetch — within a minute for one checking in. The row stays, as the record of who could get in, when. Administrators only.';

-- ── Who may run what ─────────────────────────────────────────────────────────

revoke all on function meganet.base_station_keys_hash()                                     from public;
revoke all on function meganet.base_station_verb_check(text, jsonb)                         from public;
revoke all on function meganet.base_station_checkin(jsonb)                                  from public;
revoke all on function meganet.base_station_keys(jsonb)                                     from public;
revoke all on function meganet.base_station_row(meganet.ingest_token, meganet.base_station, timestamptz) from public;
revoke all on function meganet.admin_base_stations()                                        from public;
revoke all on function meganet.admin_base_station(bigint)                                   from public;
revoke all on function meganet.admin_base_station_command(bigint, text, jsonb)              from public;
revoke all on function meganet.admin_base_station_cancel(bigint)                            from public;
revoke all on function meganet.admin_base_station_watch(bigint, boolean)                    from public;
revoke all on function meganet.base_station_key_parse(text)                                 from public;
revoke all on function meganet.admin_base_station_keys()                                    from public;
revoke all on function meganet.admin_base_station_key_add(text, text)                       from public;
revoke all on function meganet.admin_base_station_key_remove(bigint)                        from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;
  -- The station's two: anon, because the token they carry — not a session —
  -- is what they are about.
  grant execute on function meganet.base_station_checkin(jsonb)       to anon, authenticated, service_role;
  grant execute on function meganet.base_station_keys(jsonb)          to anon, authenticated, service_role;
  -- The tab's: authenticated, not anon — each asks admin_require() as well,
  -- but an anonymous caller has no business reaching the question.
  grant execute on function meganet.admin_base_stations()                            to authenticated, service_role;
  grant execute on function meganet.admin_base_station(bigint)                       to authenticated, service_role;
  grant execute on function meganet.admin_base_station_command(bigint, text, jsonb)  to authenticated, service_role;
  grant execute on function meganet.admin_base_station_cancel(bigint)                to authenticated, service_role;
  grant execute on function meganet.admin_base_station_watch(bigint, boolean)        to authenticated, service_role;
  grant execute on function meganet.admin_base_station_keys()                        to authenticated, service_role;
  grant execute on function meganet.admin_base_station_key_add(text, text)           to authenticated, service_role;
  grant execute on function meganet.admin_base_station_key_remove(bigint)            to authenticated, service_role;
  -- The helpers run only inside the functions above, as their owner.
  grant execute on function meganet.base_station_keys_hash()          to service_role;
  grant execute on function meganet.base_station_verb_check(text, jsonb) to service_role;
  grant execute on function meganet.base_station_key_parse(text)      to service_role;
  notify pgrst, 'reload schema';
end
$$;

-- ── Did it take ──────────────────────────────────────────────────────────────

do $$
begin
  if to_regclass('meganet.base_station') is null
     or to_regclass('meganet.base_station_command') is null
     or to_regclass('meganet.base_station_key') is null
     or to_regprocedure('meganet.base_station_checkin(jsonb)') is null
     or to_regprocedure('meganet.base_station_keys(jsonb)') is null
     or to_regprocedure('meganet.admin_base_stations()') is null
     or to_regprocedure('meganet.admin_base_station(bigint)') is null
     or to_regprocedure('meganet.admin_base_station_command(bigint, text, jsonb)') is null
     or to_regprocedure('meganet.admin_base_station_cancel(bigint)') is null
     or to_regprocedure('meganet.admin_base_station_watch(bigint, boolean)') is null
     or to_regprocedure('meganet.admin_base_station_keys()') is null
     or to_regprocedure('meganet.admin_base_station_key_add(text, text)') is null
     or to_regprocedure('meganet.admin_base_station_key_remove(bigint)') is null then
    raise exception '0049 did not take: the Base Stations tables or functions are missing';
  end if;
  if exists (select 1 from pg_catalog.pg_class c
              where c.oid in ('meganet.base_station'::pg_catalog.regclass, 'meganet.base_station_command'::pg_catalog.regclass,
                              'meganet.base_station_key'::pg_catalog.regclass)
                and not c.relrowsecurity) then
    raise exception '0049 did not take: a Base Stations table has RLS off';
  end if;
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────
-- DB_SCHEMA_VERSION in core.js goes 48 → 49 in the same commit as this file.

insert into meganet.app_meta (key, value)
values ('schema_version', '49')
on conflict (key) do update set value = excluded.value
  where meganet.app_meta.value::integer < excluded.value::integer;
