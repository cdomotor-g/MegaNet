-- 0008_mqtt_bridge.sql — Where the MQTT bridge puts what it learns that is not
-- a reading: which stations are talking, and whether the bridge itself is alive.
--
-- #B6. Readings still go through meganet.ingest() by way of meganet.ingest_http()
-- — the bridge is an MQTT *client* on one side and an ordinary HTTP ingest client
-- on the other, holding nothing but a device token — so this file adds no second
-- write path for readings and deliberately does not touch ingest().
--
-- Forward-only, idempotent, no begin/commit — see db/README.md:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
--        -f db/migrations/0008_mqtt_bridge.sql
--
-- Four decisions, stated here rather than discovered in the SQL.
--
-- **1. The bridge holds a device token, not the service key.** It is the first
-- MegaNet component that runs somewhere permanently, which means it is the first
-- credential sitting on a host nobody is watching. A service key on that host
-- would be the whole database; an ingest token is three RPCs — post readings,
-- report a station's status, report your own health — and `revoked_at` turns all
-- three off in one `update`. The bridge is not more trusted than the loggers it
-- relays for, and it should not be.
--
-- **2. `station_status` is keyed by the topic segment, not by `station.id`.**
-- Same reasoning as `reading.station_id` having no foreign key (0006): a station
-- that starts publishing before MegaNet has been told about it is exactly the one
-- whose silence matters, and a foreign key would refuse to record it. `station_id`
-- is resolved where the key matches a live station and left null where it does
-- not — a fact we do not have rather than one we invented.
--
-- **3. `online` is what the broker last said, and staleness is computed, not
-- stored.** The LWT tells us a station's connection dropped, which is not the same
-- as the station having stopped reporting — a logger that publishes hourly over a
-- marginal link is offline between transmissions and perfectly healthy. So the
-- column records the last thing the broker actually told us, `last_seen_at` and
-- `last_reading_at` record when it last spoke, and `meganet.station_health` exposes
-- the minutes since each without picking a threshold. Every station's reporting
-- interval is different; a "stale after N hours" constant here would be wrong for
-- most of the network and invisible when it was.
--
-- **4. Both tables are world-readable, and carry nothing that should not be.**
-- "Which sites stopped talking overnight" is the morning question, and #B7 will
-- ask it from the browser with the publishable key. That is the same trade
-- 0002 made for the station list itself. The corollary is a rule the bridge is
-- written to keep: `detail` carries a short reason string, never a connection
-- string, token or broker URL. See bridge/README.md.

-- ── Is this request carrying a live ingest token? ────────────────────────────
-- 0007 does this check inline inside ingest_http(). This file needs the same
-- check in two more places, so it is a function now — and 0007 is not edited,
-- because migrations are forward-only. Returns the token's id; raises PT401,
-- PostgREST's custom-status convention, so a bad token is an HTTP 401 exactly
-- rather than by inference from a SQLSTATE class.
create or replace function meganet.ingest_token_id()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_headers   jsonb;
  v_token_txt text;
  v_hash      text;
  v_id        bigint;
  v_revoked   timestamptz;
begin
  v_headers   := nullif(pg_catalog.current_setting('request.headers', true), '')::jsonb;
  v_token_txt := nullif(pg_catalog.btrim(coalesce(v_headers ->> 'x-ingest-token', '')), '');

  if v_token_txt is null then
    raise exception 'missing X-Ingest-Token header'
      using errcode = 'PT401',
            hint    = 'see docs/ingest-mqtt.md for how the bridge authenticates';
  end if;

  v_hash := pg_catalog.encode(
              pg_catalog.sha256(pg_catalog.convert_to(v_token_txt, 'utf8')), 'hex');

  select t.id, t.revoked_at into v_id, v_revoked
    from meganet.ingest_token t where t.token_hash = v_hash;

  if v_id is null or v_revoked is not null then
    raise exception 'invalid or revoked ingest token'
      using errcode = 'PT401',
            hint    = 'see docs/ingest-mqtt.md';
  end if;

  -- Same as ingest_http(): stamped before what follows is judged. One honest
  -- caveat (#102): the stamp rides the request's own transaction, so a request
  -- that errors after this point rolls the stamp back with it — last_used_at
  -- records the last *successful* use, which is still the answer "has this
  -- credential stopped being used" needs, just with failed attempts invisible.
  update meganet.ingest_token set last_used_at = pg_catalog.now() where id = v_id;

  return v_id;
end;
$$;

comment on function meganet.ingest_token_id() is
  'Check the X-Ingest-Token header against meganet.ingest_token and return its id, or raise PT401. The token check 0007 does inline, factored out for 0008''s endpoints.';

-- ── What the broker last said about each station ─────────────────────────────
-- One row per topic identity — the <station> segment of meganet/v1/<station>/… —
-- fed by the retained status message and the Last Will and Testament. See
-- decision 2 for why that is the key.
create table if not exists meganet.station_status (
  station_key      text        primary key,

  -- Resolved where the key names a station MegaNet knows, null where it does
  -- not. No foreign key, on purpose — decision 2.
  station_id       text,

  -- The last thing the broker told us: true from a status message, false from
  -- the LWT the broker published on the station's behalf when its connection
  -- dropped. Not a health verdict — decision 3.
  online           boolean     not null default false,
  -- When the current value of `online` began, so "down since 3am" is a column
  -- rather than a scan of a log nobody kept.
  since            timestamptz not null default now(),

  last_seen_at     timestamptz,
  last_reading_at  timestamptz,
  -- The retained status payload exactly as the station published it. Firmware
  -- versions, battery, signal — whatever a logger chooses to say about itself,
  -- kept verbatim so a field on it does not need a migration to start existing.
  last_status      jsonb       not null default '{}'::jsonb,

  -- Which bridge instance reported this. Two bridges against one broker is a
  -- supported way to run — MQTT delivers to both — and knowing which one is
  -- speaking is the difference between "the station is down" and "one bridge is".
  reported_by      text,
  updated_at       timestamptz not null default now(),

  constraint station_status_key_shape check (
    station_key = pg_catalog.btrim(station_key)
    and station_key <> ''
    and station_key !~ '[+#/]')
);

comment on table meganet.station_status is
  'What the broker last said about each station: retained status, and the LWT it publishes when a connection drops. Keyed by the topic segment, not station.id — a station MegaNet has not been told about yet is exactly the one whose silence matters.';
comment on column meganet.station_status.station_key is
  'The <station> segment of meganet/v1/<station>/… . No wildcards or separators — a topic segment, not a topic.';
comment on column meganet.station_status.online is
  'What the broker last told us, not a health verdict: a logger that publishes hourly is offline between transmissions and perfectly well. See meganet.station_health.';
comment on column meganet.station_status.since is
  'When the current value of online began. "Down since 3am" without keeping a log.';
comment on column meganet.station_status.last_status is
  'The retained status payload verbatim. Whatever the firmware chooses to say about itself, kept without a migration per field.';

create index if not exists station_status_station_idx on meganet.station_status (station_id)
  where station_id is not null;

alter table meganet.station_status enable row level security;

-- ── Whether the bridge itself is alive ───────────────────────────────────────
-- The failure this table exists for: a bridge that died quietly a week ago and
-- a network that looks, from the app, like a network where nothing has happened.
-- Silence from the field and silence from the relay are indistinguishable
-- without this row, and they need completely different people out of bed.
create table if not exists meganet.bridge_health (
  bridge_id         text        primary key,

  started_at        timestamptz,
  -- When the current broker connection was established. It moving is a
  -- reconnect; it moving repeatedly is a link worth looking at.
  connected_since   timestamptz,
  connected         boolean     not null default false,

  -- The two the ticket asks for by name, and the two that answer "is it doing
  -- anything": a bridge receiving messages but inserting nothing is a database
  -- problem, one receiving nothing is a broker or a network problem.
  last_message_at   timestamptz,
  last_insert_at    timestamptz,
  -- Every heartbeat, whether or not anything else moved. If this is old, the
  -- process is gone and the two above are the last thing it ever saw.
  last_seen_at      timestamptz not null default now(),

  messages_total    bigint      not null default 0,
  readings_accepted bigint      not null default 0,
  readings_dup      bigint      not null default 0,
  readings_rejected bigint      not null default 0,
  errors_total      bigint      not null default 0,
  -- Currently buffered and not yet acked to the broker. Persistently non-zero
  -- means the bridge is failing to insert and the broker is holding the backlog
  -- — which is the design working, and worth seeing anyway.
  pending           integer     not null default 0,

  -- A short reason string and version, never a URL, token or connection string
  -- — decision 4, and bridge/README.md says the same thing to whoever edits it.
  detail            jsonb       not null default '{}'::jsonb,
  updated_at        timestamptz not null default now(),

  constraint bridge_health_id_shape check (
    bridge_id = pg_catalog.btrim(bridge_id) and bridge_id <> '')
);

comment on table meganet.bridge_health is
  'One row per running MQTT bridge instance. Exists so that "no readings since Tuesday" can be told apart from "the relay has been dead since Tuesday" — the same silence, different person out of bed.';
comment on column meganet.bridge_health.last_seen_at is
  'Stamped by every heartbeat. If this is old the process is gone, and last_message_at is the last thing it ever saw.';
comment on column meganet.bridge_health.pending is
  'Messages received, not yet acked to the broker. Non-zero and rising means inserts are failing and the broker is holding the backlog — by design, but worth seeing.';
comment on column meganet.bridge_health.detail is
  'A short reason string and version. Never a broker URL, token or connection string: this table is world-readable.';

alter table meganet.bridge_health enable row level security;

-- ── Reading them ─────────────────────────────────────────────────────────────
-- Both tables are readable with the publishable key, and writable only through
-- the token-checked functions below — decision 4.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'meganet' and tablename = 'station_status'
                    and policyname = 'station_status_read_all') then
    create policy station_status_read_all on meganet.station_status for select using (true);
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'meganet' and tablename = 'bridge_health'
                    and policyname = 'bridge_health_read_all') then
    create policy bridge_health_read_all on meganet.bridge_health for select using (true);
  end if;
end
$$;

-- The morning question, as a query. No threshold is applied — decision 3 — only
-- the numbers a caller needs to apply its own, per station, in the app or in a
-- psql one-liner:
--
--   select station_key, online, round(minutes_since_seen) as quiet_for
--     from meganet.station_health
--    where minutes_since_seen > 180 order by minutes_since_seen desc;
create or replace view meganet.station_health
with (security_invoker = true) as
  select s.station_key,
         s.station_id,
         st.name                                                       as station_name,
         s.online,
         s.since,
         s.last_seen_at,
         s.last_reading_at,
         extract(epoch from (now() - s.last_seen_at))    / 60.0        as minutes_since_seen,
         extract(epoch from (now() - s.last_reading_at)) / 60.0        as minutes_since_reading,
         s.last_status,
         s.reported_by,
         s.updated_at
    from meganet.station_status s
    left join meganet.station st on st.id = s.station_id;

comment on view meganet.station_health is
  'station_status with the minutes since each station last spoke. Deliberately applies no staleness threshold — every station''s reporting interval is different, so the caller picks. security_invoker, so the underlying RLS is the one that answers.';

-- ── What the bridge reports ──────────────────────────────────────────────────
-- A status or LWT message, relayed. The bridge does not decide what online
-- means; it repeats what the broker delivered and says which topic it came from.
--
--   {"station": "MT_STUART", "online": false, "at": "2026-08-12T19:04:11Z",
--    "status": {"battery_v": 12.9}, "bridge": "bridge-fra-1"}
create or replace function meganet.mqtt_status(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key     text;
  v_online  boolean;
  v_at      timestamptz;
  v_status  jsonb;
  v_bridge  text;
  v_station text;
  v_prev    meganet.station_status%rowtype;
  v_since   timestamptz;
begin
  perform meganet.ingest_token_id();

  if payload is null or pg_catalog.jsonb_typeof(payload) <> 'object' then
    raise exception 'mqtt_status takes an object, got %',
                    coalesce(pg_catalog.jsonb_typeof(payload), 'null')
      using errcode = '22023';
  end if;

  v_key := nullif(pg_catalog.btrim(coalesce(payload ->> 'station', '')), '');
  if v_key is null then
    raise exception 'mqtt_status needs a station — the <station> segment of the topic'
      using errcode = '22023';
  end if;
  if v_key ~ '[+#/]' then
    raise exception 'station % is a topic, not a topic segment', v_key
      using errcode = '22023';
  end if;

  v_online := coalesce((payload ->> 'online')::boolean, false);
  -- The bridge's clock, not the station's: a status message says the connection
  -- is up now, and "now" is the moment we heard it. A logger with a dead RTC
  -- would otherwise report itself online in 1970.
  v_at     := coalesce(meganet.as_ts(payload -> 'at', 'at'), pg_catalog.now());
  if v_at > pg_catalog.now() + interval '1 day' then
    v_at := pg_catalog.now();
  end if;
  v_status := case when pg_catalog.jsonb_typeof(payload -> 'status') = 'object'
                   then payload -> 'status' else '{}'::jsonb end;
  v_bridge := nullif(pg_catalog.btrim(coalesce(payload ->> 'bridge', '')), '');

  -- Resolved, never taken from the payload — same rule as reading.station_id.
  select st.id into v_station from meganet.station st
   where st.id = v_key and st.enabled;

  select * into v_prev from meganet.station_status where station_key = v_key;

  -- `since` moves only when the state actually changes, which is the entire
  -- value of the column: "offline since 03:14" survives a bridge that repeats
  -- the retained message on every reconnect.
  v_since := case when v_prev.station_key is null or v_prev.online is distinct from v_online
                  then v_at else v_prev.since end;

  insert into meganet.station_status as ss
    (station_key, station_id, online, since, last_seen_at, last_status,
     reported_by, updated_at)
  values
    (v_key, v_station, v_online, v_since, v_at,
     case when v_status = '{}'::jsonb and v_prev.station_key is not null
          then v_prev.last_status else v_status end,
     v_bridge, pg_catalog.now())
  on conflict (station_key) do update set
    station_id   = coalesce(excluded.station_id, ss.station_id),
    online       = excluded.online,
    since        = excluded.since,
    -- Out-of-order delivery is a fact of a reconnecting client: a retained
    -- message replayed after a live one must not walk the clock backwards.
    last_seen_at = greatest(ss.last_seen_at, excluded.last_seen_at),
    last_status  = case when excluded.last_status = '{}'::jsonb
                        then ss.last_status else excluded.last_status end,
    reported_by  = coalesce(excluded.reported_by, ss.reported_by),
    updated_at   = pg_catalog.now();

  return pg_catalog.jsonb_build_object(
    'station', v_key, 'station_id', v_station, 'online', v_online, 'since', v_since);
end;
$$;

comment on function meganet.mqtt_status(jsonb) is
  'Record a station''s retained status or its LWT, as relayed by the MQTT bridge (#B6). Token-checked like ingest_http(); `since` moves only on a real state change.';

-- Readings do not come through here — the bridge posts them to ingest_http() —
-- but the moment one lands is a fact about the station, and the bridge is the
-- only thing that knows both. One small call, rather than making a status row
-- lie about when the site last actually said something.
create or replace function meganet.mqtt_seen(p_station text, p_at timestamptz default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text := nullif(pg_catalog.btrim(coalesce(p_station, '')), '');
  v_at  timestamptz := coalesce(p_at, pg_catalog.now());
begin
  perform meganet.ingest_token_id();

  if v_key is null or v_key ~ '[+#/]' then
    raise exception 'mqtt_seen needs the <station> topic segment' using errcode = '22023';
  end if;
  if v_at > pg_catalog.now() + interval '1 day' then
    v_at := pg_catalog.now();
  end if;

  insert into meganet.station_status as ss
    (station_key, station_id, online, since, last_seen_at, last_reading_at, updated_at)
  values
    (v_key,
     (select st.id from meganet.station st where st.id = v_key and st.enabled),
     true, v_at, v_at, v_at, pg_catalog.now())
  on conflict (station_key) do update set
    last_seen_at    = greatest(ss.last_seen_at, excluded.last_seen_at),
    last_reading_at = greatest(ss.last_reading_at, excluded.last_reading_at),
    station_id      = coalesce(ss.station_id, excluded.station_id),
    updated_at      = pg_catalog.now();
    -- On an existing row `online` is deliberately not touched: a reading is
    -- evidence the station transmitted, not that its connection is up now, and
    -- only the broker's status and LWT are entitled to move that column. The
    -- insert above starts a first-ever row at true because publishing over MQTT
    -- does require a connection — that much we did just observe.
end;
$$;

comment on function meganet.mqtt_seen(text, timestamptz) is
  'Stamp when a station''s reading last arrived, from the bridge. Does not touch `online` — a reading proves it transmitted, not that its connection is up now.';

-- The bridge's own pulse. Called on a timer and after anything interesting, so
-- that a dead bridge is visible as an old row rather than as a quiet network.
create or replace function meganet.bridge_heartbeat(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id     text;
  v_detail jsonb;
begin
  perform meganet.ingest_token_id();

  if payload is null or pg_catalog.jsonb_typeof(payload) <> 'object' then
    raise exception 'bridge_heartbeat takes an object, got %',
                    coalesce(pg_catalog.jsonb_typeof(payload), 'null')
      using errcode = '22023';
  end if;

  v_id := nullif(pg_catalog.btrim(coalesce(payload ->> 'bridge_id', '')), '');
  if v_id is null then
    raise exception 'bridge_heartbeat needs a bridge_id — which instance is this?'
      using errcode = '22023';
  end if;

  v_detail := case when pg_catalog.jsonb_typeof(payload -> 'detail') = 'object'
                   then payload -> 'detail' else '{}'::jsonb end;

  -- Counters are absolute, not increments: the bridge keeps its own totals since
  -- start-up and states them. A lost heartbeat then costs nothing, where a lost
  -- increment would silently under-count forever.
  insert into meganet.bridge_health as b
    (bridge_id, started_at, connected_since, connected,
     last_message_at, last_insert_at, last_seen_at,
     messages_total, readings_accepted, readings_dup, readings_rejected,
     errors_total, pending, detail, updated_at)
  values
    (v_id,
     meganet.as_ts(payload -> 'started_at', 'started_at'),
     meganet.as_ts(payload -> 'connected_since', 'connected_since'),
     coalesce((payload ->> 'connected')::boolean, false),
     meganet.as_ts(payload -> 'last_message_at', 'last_message_at'),
     meganet.as_ts(payload -> 'last_insert_at', 'last_insert_at'),
     pg_catalog.now(),
     coalesce((payload ->> 'messages_total')::bigint, 0),
     coalesce((payload ->> 'readings_accepted')::bigint, 0),
     coalesce((payload ->> 'readings_dup')::bigint, 0),
     coalesce((payload ->> 'readings_rejected')::bigint, 0),
     coalesce((payload ->> 'errors_total')::bigint, 0),
     coalesce((payload ->> 'pending')::integer, 0),
     v_detail, pg_catalog.now())
  on conflict (bridge_id) do update set
    started_at        = coalesce(excluded.started_at, b.started_at),
    connected_since   = excluded.connected_since,
    connected         = excluded.connected,
    -- A restarted bridge resets its counters, and greatest() would pin them at
    -- the pre-restart totals forever. started_at moving is how you know.
    last_message_at   = coalesce(excluded.last_message_at, b.last_message_at),
    last_insert_at    = coalesce(excluded.last_insert_at, b.last_insert_at),
    last_seen_at      = pg_catalog.now(),
    messages_total    = excluded.messages_total,
    readings_accepted = excluded.readings_accepted,
    readings_dup      = excluded.readings_dup,
    readings_rejected = excluded.readings_rejected,
    errors_total      = excluded.errors_total,
    pending           = excluded.pending,
    detail            = excluded.detail,
    updated_at        = pg_catalog.now();

  return pg_catalog.jsonb_build_object('bridge_id', v_id, 'at', pg_catalog.now());
end;
$$;

comment on function meganet.bridge_heartbeat(jsonb) is
  'The MQTT bridge''s pulse (#B6): last message in, last insert out, counters since start-up. Absolute totals, not increments, so a lost heartbeat costs nothing.';

-- ── Who may run what ─────────────────────────────────────────────────────────
-- Same rule as every migration before this one: EXECUTE defaults to PUBLIC on a
-- new function, so it is revoked and re-granted by name. The three the bridge
-- calls are granted to anon for the same reason ingest_http() is — the token,
-- not the role, is what authorises them — and they are the only ones here that
-- are.
revoke all on function meganet.ingest_token_id()                    from public;
revoke all on function meganet.mqtt_status(jsonb)                   from public;
revoke all on function meganet.mqtt_seen(text, timestamptz)         from public;
revoke all on function meganet.bridge_heartbeat(jsonb)              from public;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role — not a Supabase project, skipping Data API setup.';
    return;
  end if;

  -- Read for everyone, write for nobody: both tables are reached only through
  -- the functions above, the service key, or a direct connection.
  grant select on meganet.station_status to anon, authenticated, service_role;
  grant select on meganet.bridge_health  to anon, authenticated, service_role;
  grant select on meganet.station_health to anon, authenticated, service_role;
  grant insert, update, delete on meganet.station_status to service_role;
  grant insert, update, delete on meganet.bridge_health  to service_role;

  -- ingest_token_id() is not granted to anon: it is the check, not a door, and
  -- anon reaching it directly would be a way to ask "is this token live?" one
  -- guess at a time. The three functions that call it are security definer and
  -- run it as their owner.
  grant execute on function meganet.ingest_token_id()            to service_role;
  grant execute on function meganet.mqtt_status(jsonb)           to anon, authenticated, service_role;
  grant execute on function meganet.mqtt_seen(text, timestamptz) to anon, authenticated, service_role;
  grant execute on function meganet.bridge_heartbeat(jsonb)      to anon, authenticated, service_role;

  notify pgrst, 'reload schema';
end
$$;

-- ── Schema version ───────────────────────────────────────────────────────────

insert into meganet.app_meta (key, value)
values ('schema_version', '8')
on conflict (key) do update set value = excluded.value;
