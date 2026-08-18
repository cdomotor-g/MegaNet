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
