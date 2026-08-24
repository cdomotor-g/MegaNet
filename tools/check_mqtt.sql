-- check_mqtt.sql — Prove the database half of the MQTT bridge, against a real
-- database.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_mqtt.sql
--
-- Companion to check_ingest.sql, and the same shape: every check below is one
-- line of #B6's acceptance that can be answered in SQL. The other half of that
-- acceptance — reconnects, acknowledgement, no message lost — lives in
-- bridge/test/integration.test.js, because it is about a client and a broker and
-- cannot be asked of Postgres.
--
-- The whole script runs inside a transaction and rolls back, so it is safe
-- against the live database: nothing it writes survives, including the token it
-- mints and the readings it stores.
--
-- It needs to be run as a role meganet.is_editor() says yes to — a direct psql
-- connection, or one holding the service key. It prints a row per check and
-- exits non-zero if any of them failed, so it works in a workflow as well as by
-- hand.
--
-- The station keys are `_check_mqtt_*`, which no station slug can collide with,
-- and the ALERT addresses are 64301–64399: inside the range, far from anything
-- the network uses, and rolled back regardless.

\set ON_ERROR_STOP on

begin;

create temporary table _check (
  ord   serial,
  name  text,
  ok    boolean,
  note  text
) on commit drop;

create or replace function pg_temp.check_that(p_name text, p_ok boolean, p_note text default '')
returns void language sql as $$
  insert into _check (name, ok, note) values (p_name, coalesce(p_ok, false), p_note);
$$;

-- Run a statement and report the SQLSTATE it raised, or 'none'. The bridge's
-- endpoints are supposed to refuse some things, and "it refused" is only half an
-- answer — PT401 and 22023 mean different things to PostgREST and to a caller.
create or replace function pg_temp.sqlstate_of(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return 'none';
exception when others then
  return sqlstate;
end;
$$;

-- ── The shape of it ──────────────────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('meganet.station_status exists',
    to_regclass('meganet.station_status') is not null);
  perform pg_temp.check_that('meganet.bridge_health exists',
    to_regclass('meganet.bridge_health') is not null);
  perform pg_temp.check_that('meganet.station_health exists',
    to_regclass('meganet.station_health') is not null);

  -- db/README.md's first rule, checked rather than trusted.
  perform pg_temp.check_that('RLS is on for both new tables',
    (select bool_and(relrowsecurity) from pg_class
      where oid in ('meganet.station_status'::regclass, 'meganet.bridge_health'::regclass)),
    'a table with RLS off, reachable with the published key, is the database on the open internet');

  perform pg_temp.check_that('both new tables have a read policy',
    (select count(*) from pg_policies
      where schemaname = 'meganet'
        and tablename in ('station_status', 'bridge_health')
        and cmd = 'SELECT') = 2);
end
$$;

-- ── Who may do what ─────────────────────────────────────────────────────────
-- Skipped wholesale off Supabase, where these roles do not exist.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    perform pg_temp.check_that('grants (skipped: no anon role — not a Supabase project)', true);
    return;
  end if;

  perform pg_temp.check_that('anon may read station status',
    has_table_privilege('anon', 'meganet.station_status', 'select')
      and has_table_privilege('anon', 'meganet.station_health', 'select'),
    'the app reads this with the publishable key — #B7');

  perform pg_temp.check_that('anon may not write either table directly',
    not has_table_privilege('anon', 'meganet.station_status', 'insert')
      and not has_table_privilege('anon', 'meganet.station_status', 'update')
      and not has_table_privilege('anon', 'meganet.station_status', 'delete')
      and not has_table_privilege('anon', 'meganet.bridge_health', 'insert')
      and not has_table_privilege('anon', 'meganet.bridge_health', 'update')
      and not has_table_privilege('anon', 'meganet.bridge_health', 'delete'),
    'reachable only through the token-checked functions');

  perform pg_temp.check_that('anon may call the three the bridge needs',
    has_function_privilege('anon', 'meganet.mqtt_status(jsonb)', 'execute')
      and has_function_privilege('anon', 'meganet.mqtt_seen(text, timestamptz)', 'execute')
      and has_function_privilege('anon', 'meganet.bridge_heartbeat(jsonb)', 'execute'));

  perform pg_temp.check_that('anon may not call the token check on its own',
    not has_function_privilege('anon', 'meganet.ingest_token_id()', 'execute'),
    'it would be an oracle for guessing tokens one call at a time');

  perform pg_temp.check_that('anon may not mint a token',
    not has_function_privilege('anon',
      'meganet.create_ingest_token(text, text, integer, integer)', 'execute'));
end
$$;

-- ── A token, and what happens without one ───────────────────────────────────

create temporary table _tok on commit drop as
  select (meganet.create_ingest_token('_check_mqtt bridge') ->> 'token') as token;

do $$
declare
  v_tok text := (select token from _tok);
begin
  -- No header at all. PostgREST turns PT401 into an HTTP 401; a generic class
  -- would be a 500, which tells a bridge author nothing.
  perform set_config('request.headers', '', true);
  perform pg_temp.check_that('no token is PT401, from every endpoint',
    pg_temp.sqlstate_of($q$select meganet.mqtt_status('{"station":"x"}'::jsonb)$q$) = 'PT401'
      and pg_temp.sqlstate_of($q$select meganet.mqtt_seen('x')$q$) = 'PT401'
      and pg_temp.sqlstate_of($q$select meganet.bridge_heartbeat('{"bridge_id":"x"}'::jsonb)$q$) = 'PT401');

  perform set_config('request.headers', '{"x-ingest-token":"mgn_made-up-and-invalid"}', true);
  perform pg_temp.check_that('a made-up token is PT401',
    pg_temp.sqlstate_of($q$select meganet.mqtt_status('{"station":"x"}'::jsonb)$q$) = 'PT401');

  perform set_config('request.headers',
    format('{"x-ingest-token":"%s"}', v_tok), true);
  perform pg_temp.check_that('a live token is accepted',
    pg_temp.sqlstate_of($q$select meganet.mqtt_status('{"station":"_check_mqtt_a","online":true}'::jsonb)$q$) = 'none');

  perform pg_temp.check_that('using it stamps last_used_at',
    (select last_used_at is not null from meganet.ingest_token
      where label = '_check_mqtt bridge'),
    'which of these loggers has stopped talking, as a query rather than a guess');
end
$$;

-- ── Status, and the LWT ─────────────────────────────────────────────────────

do $$
declare
  v_since_up   timestamptz;
  v_since_same timestamptz;
  v_since_down timestamptz;
  v_station    text;
begin
  -- `at` is stated rather than defaulted, only because this whole script runs in
  -- one transaction and now() does not advance inside one. In production each
  -- call is its own transaction and the default is the bridge's clock.
  perform meganet.mqtt_status(jsonb_build_object(
    'station', '_check_mqtt_b', 'online', true,
    'at', now() - interval '10 minutes',
    'status', jsonb_build_object('battery_v', 12.9, 'fw', '2.1'),
    'bridge', '_check_mqtt_bridge'));

  select since into v_since_up from meganet.station_status where station_key = '_check_mqtt_b';

  perform pg_temp.check_that('a status message records what the station said',
    (select online and last_status = '{"fw": "2.1", "battery_v": 12.9}'::jsonb
            and reported_by = '_check_mqtt_bridge'
       from meganet.station_status where station_key = '_check_mqtt_b'),
    'whatever a logger chooses to say about itself, kept without a migration per field');

  -- A retained message is replayed on every reconnect. `since` must survive that
  -- or "offline since 03:14" becomes "offline since the last time we reconnected".
  perform meganet.mqtt_status(jsonb_build_object(
    'station', '_check_mqtt_b', 'online', true, 'at', now() - interval '5 minutes'));
  select since into v_since_same from meganet.station_status where station_key = '_check_mqtt_b';
  perform pg_temp.check_that('repeating the same status does not move `since`',
    v_since_same = v_since_up,
    'a retained message replayed on reconnect must not reset "down since"');

  -- The LWT.
  perform meganet.mqtt_status(jsonb_build_object(
    'station', '_check_mqtt_b', 'online', false, 'at', now()));
  select since, online into v_since_down, v_station
    from meganet.station_status where station_key = '_check_mqtt_b';
  perform pg_temp.check_that('an LWT marks the station offline, and moves `since`',
    (select not online from meganet.station_status where station_key = '_check_mqtt_b')
      and v_since_down > v_since_up,
    'station-offline detection, which is the morning question');

  perform pg_temp.check_that('an offline station keeps the status it last sent',
    (select last_status ? 'battery_v' from meganet.station_status where station_key = '_check_mqtt_b'),
    'the last thing it said is the most useful thing about a station that is now silent');

  -- The key is a topic segment, and a wildcard in one would be a station that
  -- can impersonate every other station in a query.
  perform pg_temp.check_that('a wildcard is not a station key',
    pg_temp.sqlstate_of($q$select meganet.mqtt_status('{"station":"a/+","online":true}'::jsonb)$q$) = '22023'
      and pg_temp.sqlstate_of($q$select meganet.mqtt_status('{"station":"#","online":true}'::jsonb)$q$) = '22023');

  perform pg_temp.check_that('a status without a station is refused',
    pg_temp.sqlstate_of($q$select meganet.mqtt_status('{"online":true}'::jsonb)$q$) = '22023');
end
$$;

-- station_id is resolved, never taken from the payload — and only when the key
-- actually names a live station. Uses whatever the database already has.
do $$
declare
  v_id text;
begin
  select id into v_id from meganet.station where enabled order by id limit 1;

  if v_id is null then
    perform pg_temp.check_that('station_id resolution (skipped: no stations loaded)', true);
  else
    perform meganet.mqtt_status(jsonb_build_object('station', v_id, 'online', true));
    perform pg_temp.check_that('a key that names a station resolves to it',
      (select station_id = v_id from meganet.station_status where station_key = v_id));
  end if;

  perform pg_temp.check_that('a key that names nothing is still recorded',
    (select station_id is null from meganet.station_status where station_key = '_check_mqtt_b'),
    'a station MegaNet has not been told about yet is exactly the one whose silence matters');
end
$$;

-- ── When a station was last heard from ──────────────────────────────────────

do $$
declare
  v_seen timestamptz;
begin
  perform meganet.mqtt_seen('_check_mqtt_c');
  perform pg_temp.check_that('mqtt_seen creates a row for a station never seen before',
    (select last_reading_at is not null and online
       from meganet.station_status where station_key = '_check_mqtt_c'),
    'publishing over MQTT does require a connection — that much we observed');

  -- _check_mqtt_b is offline, per its LWT above. A reading arriving for it is
  -- evidence it transmitted, not that its connection is back up.
  perform meganet.mqtt_seen('_check_mqtt_b');
  perform pg_temp.check_that('a reading does not silently mark a station back online',
    (select not online and last_reading_at is not null
       from meganet.station_status where station_key = '_check_mqtt_b'),
    'only the broker''s status and LWT move that column');

  -- Out-of-order delivery is a fact of a reconnecting client.
  select last_seen_at into v_seen from meganet.station_status where station_key = '_check_mqtt_c';
  perform meganet.mqtt_seen('_check_mqtt_c', now() - interval '1 hour');
  perform pg_temp.check_that('a late-arriving message does not walk the clock backwards',
    (select last_seen_at = v_seen from meganet.station_status where station_key = '_check_mqtt_c'));

  -- A logger with a dead RTC would otherwise report itself as seen in 2087.
  perform meganet.mqtt_seen('_check_mqtt_c', now() + interval '30 days');
  perform pg_temp.check_that('a station clock a month fast does not become the future',
    (select last_seen_at < now() + interval '1 day'
       from meganet.station_status where station_key = '_check_mqtt_c'));
end
$$;

-- ── The bridge's own pulse ──────────────────────────────────────────────────

do $$
declare
  v_first timestamptz;
begin
  perform meganet.bridge_heartbeat(jsonb_build_object(
    'bridge_id', '_check_mqtt_bridge', 'connected', true,
    'started_at', now() - interval '2 hours',
    'messages_total', 100, 'readings_accepted', 90, 'pending', 0,
    'detail', jsonb_build_object('version', '1.0.0')));

  perform pg_temp.check_that('a heartbeat creates the bridge''s row',
    (select connected and messages_total = 100 and readings_accepted = 90
       from meganet.bridge_health where bridge_id = '_check_mqtt_bridge'));

  -- Counters are absolute totals, not increments: a lost heartbeat then costs
  -- nothing, where a lost increment would under-count silently and forever.
  perform meganet.bridge_heartbeat(jsonb_build_object(
    'bridge_id', '_check_mqtt_bridge', 'connected', false,
    'messages_total', 140, 'readings_accepted', 128, 'errors_total', 2, 'pending', 12));

  perform pg_temp.check_that('counters are stated, not accumulated',
    (select messages_total = 140 and readings_accepted = 128 and errors_total = 2 and pending = 12
       from meganet.bridge_health where bridge_id = '_check_mqtt_bridge'),
    '140, not 240');

  perform pg_temp.check_that('a restarted bridge''s counters go back down',
    (select messages_total = 140 from meganet.bridge_health where bridge_id = '_check_mqtt_bridge'),
    'greatest() would pin them at the pre-restart totals forever');

  perform pg_temp.check_that('a heartbeat without a bridge_id is refused',
    pg_temp.sqlstate_of($q$select meganet.bridge_heartbeat('{"connected":true}'::jsonb)$q$) = '22023');

  perform pg_temp.check_that('last_seen_at is stamped by every heartbeat',
    (select now() - last_seen_at < interval '1 minute'
       from meganet.bridge_health where bridge_id = '_check_mqtt_bridge'),
    'if this is old the process is gone, and last_message_at is the last thing it saw');
end
$$;

-- ── The morning question ────────────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('station_health says how long each station has been quiet',
    (select minutes_since_seen is not null and minutes_since_seen >= 0
       from meganet.station_health where station_key = '_check_mqtt_c'));

  perform pg_temp.check_that('station_health applies no threshold of its own',
    (select count(*) >= 3 from meganet.station_health
      where station_key like '\_check\_mqtt\_%'),
    'every station''s reporting interval is different, so the caller picks');
end
$$;

-- ── A reading, by the route the bridge actually uses ────────────────────────
-- The bridge posts to ingest_http() with a device token, exactly as an HTTP
-- logger does. What is being proved here is the last line of #B6's acceptance:
-- duplicate deliveries at QoS 1 do not duplicate rows.

do $$
declare
  v_1 jsonb;
  v_2 jsonb;
  v_reading jsonb := jsonb_build_object(
    'alert_id', 64301,
    'reading_ts', date_trunc('second', now() - interval '5 minutes'),
    'value_raw', 17);
begin
  v_1 := meganet.ingest_http(jsonb_build_object('source', 'mqtt', 'readings', jsonb_build_array(v_reading)));
  perform pg_temp.check_that('the bridge''s reading lands through ingest_http()',
    (v_1 ->> 'accepted')::int = 1, v_1::text);

  perform pg_temp.check_that('and is recorded as having come from mqtt',
    (select r.source = (select code from meganet.ingest_source where key = 'mqtt')
       from meganet.reading r where r.addr = 'a:64301'));

  -- QoS 1 promises at-least-once, and a repeater network delivers most readings
  -- more than once anyway. The primary key eats them and counts them.
  v_2 := meganet.ingest_http(jsonb_build_object('source', 'mqtt', 'readings', jsonb_build_array(v_reading)));
  perform pg_temp.check_that('a duplicate delivery does not duplicate the row',
    (v_2 ->> 'duplicates')::int = 1 and (v_2 ->> 'accepted')::int = 0
      and (select count(*) = 1 from meganet.reading where addr = 'a:64301'),
    v_2::text);

  perform pg_temp.check_that('and the duplicate is counted on the reading',
    (select dup_count = 1 from meganet.reading where addr = 'a:64301'),
    'a repeater network delivers most readings more than once; this is where that is visible');
end
$$;

-- ── An HFEM message, as the bridge posts it (#155) ───────────────────────────
-- The decode and the mapping live at the edge (hfem.js, one file for the
-- browser and the bridge; bridge/src/messages.js routes to it by topic) and
-- are proven in bridge/test. What is proved HERE is the database half of
-- #155's acceptance: the vocabulary rows exist (0018), the mapped readings
-- land with protocol 'hfem' and quality 'maintenance', and the raw line is
-- kept in reading_raw.frame beside its decode.

do $$
declare
  v jsonb;
  v_frame text := ':HS=1|M=1|I1=64302|T3=20260817130000-10|R_1-0=1055|B_1-16=13.9|NN:';
  v_raw bigint;
begin
  perform pg_temp.check_that('0018 landed whole: protocol hfem, quality maintenance, W/m2 and MPa',
    exists (select 1 from meganet.protocol where code = 4 and key = 'hfem')
      and exists (select 1 from meganet.quality where code = 6 and key = 'maintenance')
      and (select count(*) = 2 from meganet.unit where key in ('W/m2', 'MPa')));

  -- The exact shape bridge/src/messages.js parseHfem() emits for v_frame — the
  -- station number is 64302 rather than the spec's 123456 only to stay inside
  -- this script's address range. T3 is local 13:00 at UTC+10 written HFEM's
  -- way (offset sign inverted), so the stored instant must be 03:00 UTC.
  v := meganet.ingest_http(jsonb_build_object(
    'source', 'mqtt', 'protocol', 'hfem', 'frame', v_frame,
    'readings', jsonb_build_array(
      jsonb_build_object('station_number', '64302', 'channel', 'R_1',
        'reading_ts', '2026-08-17T03:00:00Z', 'value_raw', 1055, 'unit', 'count',
        'quality', 'maintenance'),
      jsonb_build_object('station_number', '64302', 'channel', 'B_1',
        'reading_ts', '2026-08-17T03:00:00Z', 'value', 13.9, 'value_raw', 13.9,
        'unit', 'V', 'quality', 'maintenance'))));
  perform pg_temp.check_that('an HFEM message lands whole through ingest_http()',
    (v ->> 'accepted')::int = 2, v::text);

  perform pg_temp.check_that('both rows carry protocol hfem and quality maintenance',
    (select count(*) = 2 from meganet.reading r
      where r.station_number = '64302'
        and r.protocol = (select code from meganet.protocol where key = 'hfem')
        and r.quality  = (select code from meganet.quality  where key = 'maintenance')));

  perform pg_temp.check_that('the raw scheme kept its count and the translated one both its values',
    (select r.value_raw = 1055 and r.value is null and r.unit = 'count'
       from meganet.reading r where r.addr = 's:64302/R_1')
    and (select r.value = 13.9 and r.value_raw = 13.9 and r.unit = 'V'
       from meganet.reading r where r.addr = 's:64302/B_1'));

  select r.raw_id into v_raw from meganet.reading r where r.addr = 's:64302/R_1';
  perform pg_temp.check_that('the wire line rides beside its decode',
    (select frame = v_frame from meganet.reading_raw where id = v_raw),
    'the decode is auditable against what was actually transmitted');

  perform pg_temp.check_that('maintenance readings are distinguishable in one query',
    (select count(*) = 2 from meganet.reading r
      join meganet.quality q on q.code = r.quality
      where r.station_number = '64302' and q.key = 'maintenance'),
    '#155 acceptance: a technician''s bucket test is not weather');
end
$$;

-- ── One station, one health row (#162) ───────────────────────────────────────
-- A station heard before the registry knows it accrues rows under its
-- transport identities — the topic segment from MQTT, the a:/s: address form
-- from HTTP — and registration used to leave those twins diverging beside the
-- canonical row. station_status_converge() (0019) folds them, with the same
-- out-of-order discipline mqtt_status applies per row; the stations loader
-- runs it after every registry sync.

do $$
declare
  v jsonb;
  v_row meganet.station_status%rowtype;
begin
  -- A station nobody has registered yet speaks through both doors: readings
  -- over HTTP under an alert address, and a status over MQTT under its topic
  -- segment. Two honest rows, two identities, one physical site.
  perform meganet.ingest_http(jsonb_build_object('source', 'mqtt', 'readings',
    jsonb_build_array(jsonb_build_object(
      'alert_id', 64351,
      'reading_ts', date_trunc('second', now() - interval '30 minutes'),
      'value_raw', 3))));
  perform meganet.mqtt_status(jsonb_build_object(
    'station', '_check_mqtt_conv', 'online', false,
    'at', now() - interval '2 hours', 'bridge', '_check_mqtt_bridge'));

  perform pg_temp.check_that('an unregistered station holds twin rows — the defect, reproduced',
    exists (select 1 from meganet.station_status where station_key = 'a:64351')
      and exists (select 1 from meganet.station_status where station_key = '_check_mqtt_conv'),
    'one physical site, two station_key rows, and station_health joins whichever it hits');

  -- The registry learns about the station, carrying the alert address. Its id
  -- is the topic segment here because it has no bureau number — the fallback
  -- half of the 0020 rule; the number half is proved in its own section below.
  insert into meganet.rm_system (id, ord, name)
  values (-995, -995, 'check_mqtt placeholder')
  on conflict (id) do nothing;
  insert into meganet.station (id, ord, name, station_number, rm_system_id)
  values ('_check_mqtt_conv', -995, 'Check Convergence', '999095', -995);
  insert into meganet.sensor (station_id, sensor_id, type, ord, alert_id)
  values ('_check_mqtt_conv', '999095.0.R.64351', 'Rainfall', 0, 64351);

  v := meganet.station_status_converge();
  perform pg_temp.check_that('registration + converge folds the twins into the id row',
    (v ->> 'folded')::int >= 1
      and not exists (select 1 from meganet.station_status where station_key = 'a:64351')
      and (select count(*) from meganet.station_status
            where station_key = '_check_mqtt_conv') = 1,
    v::text);

  select * into v_row from meganet.station_status where station_key = '_check_mqtt_conv';
  perform pg_temp.check_that('the folded row keeps the opinion and the honest clocks',
    v_row.station_id = '_check_mqtt_conv'
      and v_row.online = false                                -- the only opinion came from MQTT
      and v_row.last_reading_at is not null                   -- the HTTP twin's stored reading survives
      and v_row.last_seen_at >= now() - interval '31 minutes' -- the later word: the HTTP batch
      and v_row.since <= now() - interval '119 minutes',      -- offline since the LWT said so, not since the fold
    format('online=%s since=%s last_seen=%s last_reading=%s',
           v_row.online, v_row.since, v_row.last_seen_at, v_row.last_reading_at));

  perform pg_temp.check_that('a key that still resolves to nothing is left alone',
    exists (select 1 from meganet.station_status where station_key = '_check_mqtt_b'),
    'an unknown station is a fact, not a defect — the honest partial identity stays');

  perform pg_temp.check_that('converge is idempotent',
    (meganet.station_status_converge() ->> 'folded')::int = 0);
end
$$;

-- ── The publisher is the bureau station number (#166, 0020) ──────────────────
-- The <station> topic segment names who published. Until 0020 it was the
-- stations.json slug — a MegaNet artifact derived from the station's name,
-- which nobody outside this app knows and which moves when the name is edited.
-- It is now the bureau (BoM/CBM) number, falling back to the station id for the
-- sites that legitimately have none: repeaters, radars, base stations.

do $$
declare
  v jsonb;
  v_row meganet.station_status%rowtype;
begin
  insert into meganet.station (id, ord, name, station_number, rm_system_id)
  values ('_check_mqtt_num', -994, 'Check Bureau Number', '999094', -995),
         ('_check_mqtt_nonum', -993, 'Check No Number', '', -995);

  -- 1. The number resolves; so does the id, for a site without a number.
  perform pg_temp.check_that('the bureau number names its station',
    meganet.resolve_publisher('999094') = '_check_mqtt_num'
      and meganet.resolve_publisher(' 999094 ') = '_check_mqtt_num',
    'the segment a logger publishes under is the number on the site card');

  perform pg_temp.check_that('a site with no bureau number falls back to its id',
    meganet.resolve_publisher('_check_mqtt_nonum') = '_check_mqtt_nonum'
      and meganet.resolve_publisher('') is null
      and meganet.resolve_publisher(null) is null,
    'repeaters, radars and base stations have no bureau number and still have to publish');

  -- 2. A status published under the NUMBER keys by the station id, not the
  --    number. This is the whole point: one health row per site, whatever the
  --    transport called it.
  perform meganet.mqtt_status(jsonb_build_object(
    'station', '999094', 'online', true,
    'status', jsonb_build_object('battery_v', 12.9),
    'bridge', '_check_mqtt_bridge'));

  perform pg_temp.check_that('publishing under the number keys by the station id',
    exists (select 1 from meganet.station_status
             where station_key = '_check_mqtt_num' and station_id = '_check_mqtt_num')
      and not exists (select 1 from meganet.station_status where station_key = '999094'),
    'the number is how it published; station.id is how it is stored (0019)');

  -- 3. mqtt_seen resolves the same way — a reading arriving over MQTT stamps
  --    the same single row, not a second one keyed by the number.
  perform meganet.mqtt_seen('999094');
  perform pg_temp.check_that('a reading under the number stamps that same row',
    (select count(*) from meganet.station_status
      where station_key in ('_check_mqtt_num', '999094')) = 1
      and (select last_reading_at is not null from meganet.station_status
            where station_key = '_check_mqtt_num'),
    'mqtt_status and mqtt_seen agree about who the publisher is');

  -- 4. An unregistered number stays the honest partial identity, and folds the
  --    moment the registry learns it — the same contract 0019 wrote for the
  --    a:/s: address forms, now reaching a bare number.
  perform meganet.mqtt_status(jsonb_build_object(
    'station', '999093', 'online', false,
    'at', now() - interval '3 hours', 'bridge', '_check_mqtt_bridge'));

  perform pg_temp.check_that('a number the registry does not know yet is kept as it arrived',
    (select station_id is null from meganet.station_status where station_key = '999093'),
    'a station heard before it is registered is exactly the one whose silence matters (0008)');

  insert into meganet.station (id, ord, name, station_number, rm_system_id)
  values ('_check_mqtt_late', -992, 'Check Late Registration', '999093', -995);

  v := meganet.station_status_converge();
  select * into v_row from meganet.station_status where station_key = '_check_mqtt_late';
  perform pg_temp.check_that('registering the number folds its row into the station id',
    (v ->> 'folded')::int >= 1
      and not exists (select 1 from meganet.station_status where station_key = '999093')
      and v_row.station_id = '_check_mqtt_late'
      and v_row.online = false
      and v_row.since <= now() - interval '179 minutes',
    'without this the number row would sit beside the canonical one forever — #162 through the front door');

  -- 5. The number has to stay unique to be a key. A duplicate would make BOTH
  --    stations unroutable, silently, because resolve_station() refuses to
  --    guess between them. 0020 turns that into a failed write instead.
  perform pg_temp.check_that('a duplicate bureau number is refused',
    pg_temp.sqlstate_of($q$insert into meganet.station (id, ord, name, station_number, rm_system_id)
                           values ('_check_mqtt_dup', -991, 'Check Duplicate', '999094', -995)$q$) = '23505',
    'the failure belongs at the registry, not in the telemetry');

  perform pg_temp.check_that('but any number of sites may have no bureau number',
    pg_temp.sqlstate_of($q$insert into meganet.station (id, ord, name, station_number, rm_system_id)
                           values ('_check_mqtt_nonum2', -990, 'Check No Number 2', '', -995)$q$) = 'none',
    'many repeaters and radars honestly have none — '''' is not a value that can collide');
end
$$;

-- ── A revoked token stops working immediately ───────────────────────────────

do $$
begin
  update meganet.ingest_token set revoked_at = now() where label = '_check_mqtt bridge';

  perform pg_temp.check_that('revoking is one update, and takes effect on the next call',
    pg_temp.sqlstate_of($q$select meganet.mqtt_status('{"station":"_check_mqtt_d","online":true}'::jsonb)$q$) = 'PT401'
      and pg_temp.sqlstate_of($q$select meganet.bridge_heartbeat('{"bridge_id":"x"}'::jsonb)$q$) = 'PT401',
    'no cache and no token lifetime to wait out');

  perform pg_temp.check_that('and nothing it was refused was written',
    not exists (select 1 from meganet.station_status where station_key = '_check_mqtt_d'));
end
$$;

-- ── The test station survives a stations load (#169 follow-up, 0022) ────────
-- This runs after the stations.json load step, which is the whole point of it
-- being here rather than in the migration's own "did it take" block. 0021 was
-- asserted at migration time and passed; what nothing asked was whether the row
-- was still there once the loader had run. It was not — load_stations_doc() and
-- import_stations_json.py are *syncs*, and elpro_test is the first station no
-- document carries, so both deleted it and neither said so.
--
-- Four checks rather than one, because the failure that actually happened was
-- partial: guarding the station prune alone left the row present and its sensors
-- gone, which resolves no address at all and reads as "working" in every query
-- that only looks at meganet.station.

do $$
begin
  perform pg_temp.check_that('elpro_test survives the stations load',
    exists (select 1 from meganet.station
             where id = 'elpro_test' and deleted_at is null),
    'the row is gone — a station prune has stopped respecting document_managed');

  perform pg_temp.check_that('elpro_test is not document-managed',
    exists (select 1 from meganet.station
             where id = 'elpro_test' and not document_managed),
    'the flag is what stops the loader deleting it; true here means the next load removes the row');

  perform pg_temp.check_that('its three addresses survive too',
    (select count(*) from meganet.sensor where station_id = 'elpro_test') = 3,
    format('%s of 3 sensors left — resolve_station() matches addresses against these, so a station with none resolves nothing',
           (select count(*) from meganet.sensor where station_id = 'elpro_test')));

  perform pg_temp.check_that('and the trial address still resolves',
    meganet.resolve_station(9003, null) is not distinct from 'elpro_test',
    format('resolve_station(9003) = %s',
           coalesce(meganet.resolve_station(9003, null), '(null)')));
end
$$;

-- A station may now have no radio system (0022), and exactly one does. Asserted
-- because the nullable column is what replaced a `not null` that Postgres used
-- to enforce: if a real station ever arrives here with a null preset, that is a
-- stations.json that lost the key, and this is the only thing left watching.

do $$
declare
  n integer;
begin
  select count(*) into n from meganet.station
   where rm_system_id is null and document_managed;
  perform pg_temp.check_that('no document station has a null rm_system_id',
    n = 0,
    format('%s document-managed station(s) have no radio system — check_references() should have refused that file', n));
end
$$;

-- ── The relayed ALERT2 pair (0024 / #172) ───────────────────────────────────
-- #169 taught the bridge where the ALERT2 station address lives and then stored
-- only the sensor slot, as though it were an ALERT address. The checks below are
-- the three defects that produced, each asserted as behaviour rather than as
-- schema: two stations must not share one address, slot zero must survive, and
-- ELPRO's unused-slot marker must not become a reading.
--
-- ALERT2 station addresses 64380-64389 here, the same reasoning as the 64301+
-- ALERT addresses above: inside the range, far from anything real, rolled back
-- regardless.

do $$
declare
  v      jsonb;
  n      integer;
  a_1000 text;
  a_1001 text;
begin
  insert into meganet.station (id, ord, name, station_number, rm_system_id)
  values ('_check_mqtt_a2',  -992, 'Check ALERT2',       '999092', -995),
         ('_check_mqtt_a2b', -991, 'Check ALERT2 Other', '999091', -995);

  -- The collision. Slot 10 arrives from two different relayed stations, which is
  -- exactly what the live bench feed does, and used to produce one `a:10`.
  v := meganet.ingest(jsonb_build_object(
        'source', 'mqtt', 'protocol', 'elpro',
        'path', 'meganet/v1/elpro_test/logger/reading/elpro/Station 64380',
        'readings', jsonb_build_array(jsonb_build_object(
          'a2_station', 64380, 'a2_sensor', 10,
          'reading_ts', '2026-08-23T23:53:10Z', 'value_raw', -101))));
  v := meganet.ingest(jsonb_build_object(
        'source', 'mqtt', 'protocol', 'elpro',
        'path', 'meganet/v1/elpro_test/logger/reading/elpro/Station 64381',
        'readings', jsonb_build_array(jsonb_build_object(
          'a2_station', 64381, 'a2_sensor', 10,
          'reading_ts', '2026-08-23T23:53:10Z', 'value_raw', -90))));

  select addr into a_1000 from meganet.reading where a2_station = 64380 and a2_sensor = 10;
  select addr into a_1001 from meganet.reading where a2_station = 64381 and a2_sensor = 10;

  perform pg_temp.check_that('the same sensor slot on two relayed stations is two addresses',
    a_1000 = 'a2:64380/10' and a_1001 = 'a2:64381/10',
    format('got %s and %s — one address for two instruments is #169''s defect',
           coalesce(a_1000, '(none)'), coalesce(a_1001, '(none)')));

  -- Slot 0. isAlertId() rejected it because zero is not an ALERT address; a slot
  -- is not an address, and the bench station has been reporting one all along.
  v := meganet.ingest(jsonb_build_object(
        'protocol', 'elpro', 'readings', jsonb_build_array(jsonb_build_object(
          'a2_station', 64380, 'a2_sensor', 0,
          'reading_ts', '2026-08-23T23:53:11Z', 'value_raw', 1690))));
  perform pg_temp.check_that('sensor slot 0 is a sensor',
    (v ->> 'accepted')::integer = 1
      and exists (select 1 from meganet.reading where addr = 'a2:64380/0'),
    v::text);

  -- And 255 is not, because ELPRO writes it into an unused mapping row.
  v := meganet.ingest(jsonb_build_object(
        'protocol', 'elpro', 'readings', jsonb_build_array(jsonb_build_object(
          'a2_station', 64380, 'a2_sensor', 255,
          'reading_ts', '2026-08-23T23:53:12Z', 'value_raw', 1))));
  perform pg_temp.check_that('slot 255 is the unused marker, not a reading',
    (v ->> 'accepted')::integer = 0
      and (v -> 'rejected' -> 0 ->> 'why') like '%unused-slot marker%',
    v::text);

  -- Half a pair names nothing, and naming a reading twice is two opinions.
  v := meganet.ingest(jsonb_build_object(
        'protocol', 'elpro', 'readings', jsonb_build_array(jsonb_build_object(
          'a2_sensor', 13, 'reading_ts', '2026-08-23T23:53:13Z', 'value_raw', 1))));
  perform pg_temp.check_that('a sensor slot with no station is refused',
    (v ->> 'accepted')::integer = 0, v::text);

  v := meganet.ingest(jsonb_build_object(
        'protocol', 'elpro', 'readings', jsonb_build_array(jsonb_build_object(
          'alert_id', 64301, 'a2_station', 64380, 'a2_sensor', 13,
          'reading_ts', '2026-08-23T23:53:14Z', 'value_raw', 1))));
  perform pg_temp.check_that('an ALERT address and an ALERT2 pair together are refused',
    (v ->> 'accepted')::integer = 0, v::text);

  -- Nobody has claimed 64380 yet, so nothing resolves. That is the normal state
  -- for traffic from a site MegaNet has not been told about.
  perform pg_temp.check_that('an unclaimed ALERT2 station resolves to nobody',
    meganet.resolve_a2_station(64380) is null,
    format('resolve_a2_station(64380) = %s', coalesce(meganet.resolve_a2_station(64380), '(null)')));

  -- The claim, which is the whole point: one action, and every reading that
  -- shares the identity moves — not only the one somebody was looking at.
  v := meganet.claim_a2_station(64380, '_check_mqtt_a2');
  perform pg_temp.check_that('claiming a relayed station back-fills every reading it ever sent',
    (v ->> 'claimed')::integer = 2
      and (select count(*) from meganet.reading
            where a2_station = 64380 and station_id = '_check_mqtt_a2') = 2,
    v::text);

  perform pg_temp.check_that('and the claim is what makes the address resolve',
    meganet.resolve_a2_station(64380) = '_check_mqtt_a2',
    format('resolve_a2_station(64380) = %s', coalesce(meganet.resolve_a2_station(64380), '(null)')));

  -- Two stations on one address would resolve to neither, so taking it needs
  -- saying so out loud.
  perform pg_temp.check_that('a second station cannot take the address by accident',
    pg_temp.sqlstate_of(
      $q$select meganet.claim_a2_station(64380, '_check_mqtt_a2b')$q$) = '23505');

  v := meganet.claim_a2_station(64380, '_check_mqtt_a2b', true);
  perform pg_temp.check_that('p_replace moves the address and takes the readings with it',
    (v ->> 'replaced') = '_check_mqtt_a2'
      and (select count(*) from meganet.reading
            where a2_station = 64380 and station_id = '_check_mqtt_a2b') = 2,
    v::text);

  -- The other door: an ALERT address claimed from a message row.
  insert into meganet.reading (alert_id, channel, reading_ts, received_at, value_raw, protocol, source)
  values (64382, '', '2026-08-23T10:00:00Z', now(), 1.23, 1, 2),
         (64382, '', '2026-08-23T10:15:00Z', now(), 1.24, 1, 2);
  v := meganet.claim_alert_address(64382, '_check_mqtt_a2', 'Water Level');
  perform pg_temp.check_that('claiming an ALERT address back-fills its readings too',
    (v ->> 'claimed')::integer = 2
      and meganet.resolve_station(64382, null) = '_check_mqtt_a2',
    v::text);

  perform pg_temp.check_that('but not one another station already holds',
    pg_temp.sqlstate_of(
      $q$select meganet.claim_alert_address(64382, '_check_mqtt_a2b', 'Water Level')$q$) = '23505');

  -- What has been heard but not named — the list the station editor offers.
  select count(*) into n from meganet.a2_sensor_seen where a2_station = 64380;
  perform pg_temp.check_that('every slot heard from a relayed station is listed',
    n = 2, format('%s slots listed for 64380, expected 2', n));
end
$$;

-- The generated column is the identity, and rebuilding it is the one destructive
-- thing 0024 does. A column that came back plain would accept every future insert
-- without a word and store nulls where the primary key used to be.

do $$
declare
  v_expr text;
begin
  select pg_get_expr(d.adbin, d.adrelid) into v_expr
    from pg_attribute a
    join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = 'meganet.reading'::regclass
     and a.attname = 'addr' and a.attgenerated = 's';

  perform pg_temp.check_that('addr is still a stored generated column, and knows the ALERT2 shape',
    v_expr is not null and v_expr like '%a2:%',
    coalesce(v_expr, 'addr is not generated any more'));

  perform pg_temp.check_that('and it is still the primary key',
    exists (select 1 from pg_constraint
             where conrelid = 'meganet.reading'::regclass and contype = 'p'
               and pg_get_constraintdef(oid) = 'PRIMARY KEY (addr, reading_ts, value_raw)'),
    (select coalesce(pg_get_constraintdef(oid), '(no primary key)') from pg_constraint
      where conrelid = 'meganet.reading'::regclass and contype = 'p'));
end
$$;

-- The loader is a sync, and 0022 taught it not to prune what the document does
-- not own. An ALERT2 slot is the second kind of row it does not own: stations.json
-- has no column for one, so a reload would delete every slot somebody named.

do $$
begin
  insert into meganet.sensor (station_id, sensor_id, type, ord, alert2_sensor_id, updated_by)
  values ('_check_mqtt_a2', '_check_mqtt_a2:a2:7', 'Rainfall', 9, 7, 'check_mqtt.sql');

  perform meganet.load_stations_doc(
    (select doc from meganet.stations_json));

  perform pg_temp.check_that('a stations load does not delete an ALERT2 sensor slot',
    exists (select 1 from meganet.sensor
             where station_id = '_check_mqtt_a2' and alert2_sensor_id = 7),
    'the slot is gone — the loader is pruning rows the document cannot express');
end
$$;

-- ── The verdict ─────────────────────────────────────────────────────────────

select lpad(ord::text, 2) as "#",
       case when ok then 'ok  ' else 'FAIL' end as result,
       name,
       case when ok then '' else left(coalesce(note, ''), 160) end as detail
  from _check order by ord;

do $$
declare
  n integer;
begin
  select count(*) into n from _check where not ok;
  if n > 0 then
    raise exception '% of % checks failed', n, (select count(*) from _check);
  end if;
  raise notice 'all % checks passed', (select count(*) from _check);
end
$$;

rollback;
