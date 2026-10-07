-- check_health_findings.sql — Prove 0059: the network's health kept by the
-- database. A base station that stops checking in, and a receiver that runs
-- but decodes nothing, each become a finding on the next run and clear when
-- they recover; what the station analysis reports opens, updates and clears
-- the same way; and nobody reads what is not theirs.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_health_findings.sql
--
-- One row per claim, a non-zero exit if any fails, and the whole script in a
-- transaction that rolls back — the tokens it mints, the check-ins and the
-- findings included — so it is safe against the live database. Time is moved
-- by handing the runs a `now` of their own and setting when a base station
-- last checked in, since inside one transaction the clock does not move.

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

-- One statement as another role with a request's claims: its first column as
-- text, or 'ERROR <sqlstate>'. Rolled back.
create or replace function pg_temp.as_role(p_role text, p_claims text, p_sql text)
returns text language plpgsql as $$
declare
  v text;
begin
  begin
    execute pg_catalog.format('set local role %I', p_role);
    perform pg_catalog.set_config('request.jwt.claims', p_claims, true);
    execute p_sql into v;
    raise exception using errcode = 'MNRLB', message = coalesce(v, '<null>');
  exception
    when sqlstate 'MNRLB' then return sqlerrm;
    when others then return 'ERROR ' || sqlstate;
  end;
end;
$$;

-- The same, kept: for the writes the next checks read.
create or replace function pg_temp.as_role_keep(p_role text, p_claims text, p_sql text)
returns text language plpgsql as $$
declare
  v text;
begin
  perform pg_catalog.set_config('request.jwt.claims', p_claims, true);
  execute pg_catalog.format('set local role %I', p_role);
  execute p_sql into v;
  execute 'reset role';
  perform pg_catalog.set_config('request.jwt.claims', '', true);
  return v;
end;
$$;

-- A base station checking in, kept: anon with its token, as PostgREST hands it over.
create or replace function pg_temp.checkin(p_token text, p_payload jsonb)
returns jsonb language plpgsql as $$
declare
  v text;
begin
  perform pg_catalog.set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform pg_catalog.set_config('request.headers', pg_catalog.json_build_object('x-ingest-token', p_token)::text, true);
  execute 'set local role anon';
  execute pg_catalog.format('select meganet.base_station_checkin(%L::jsonb)::text', p_payload) into v;
  execute 'reset role';
  perform pg_catalog.set_config('request.headers', '', true);
  perform pg_catalog.set_config('request.jwt.claims', '', true);
  return v::jsonb;
end;
$$;

-- The station analysis reporting, kept: the secret key is service_role.
create or replace function pg_temp.report(p_report jsonb)
returns jsonb language plpgsql as $$
begin
  return pg_temp.as_role_keep('service_role', '{"role":"service_role"}',
    pg_catalog.format('select meganet.report_station_findings(%L::jsonb)::text', p_report))::jsonb;
end;
$$;

-- A base station's last check-in and heartbeat, moved to p_at.
create or replace function pg_temp.seen(p_id bigint, p_at timestamptz, p_rx jsonb default null)
returns void language sql as $$
  update meganet.base_station
     set last_seen_at = p_at,
         beat_at = p_at,
         beat = case when p_rx is null then beat else coalesce(beat, '{}'::jsonb) || pg_catalog.jsonb_build_object('rx', p_rx) end
   where ingest_token_id = p_id;
$$;

create or replace function pg_temp.open_of(p_source text, p_kind text, p_subject text)
returns meganet.health_finding language sql stable as $$
  select * from meganet.health_finding
   where source = p_source and kind = p_kind and subject = p_subject and cleared_at is null;
$$;

-- People: an editor, and an administrator.
insert into meganet.editor_allow (entry, note) values
  ('hf-editor@example.test', 'check_health_findings — rolled back'),
  ('hf-admin@example.test',  'check_health_findings — rolled back')
on conflict (entry) do nothing;
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000d5901', 'hf-editor@example.test', now()),
  ('00000000-0000-4000-8000-0000000d5902', 'hf-admin@example.test', now())
on conflict (id) do nothing;
update meganet.app_user set role = 'admin' where id = '00000000-0000-4000-8000-0000000d5902';

create temporary table _who (k text primary key, claims text) on commit drop;
insert into _who values
  ('anon',   '{"role":"anon"}'),
  ('editor', '{"role":"authenticated","email":"hf-editor@example.test","sub":"00000000-0000-4000-8000-0000000d5901"}'),
  ('admin',  '{"role":"authenticated","email":"hf-admin@example.test","sub":"00000000-0000-4000-8000-0000000d5902"}');
create or replace function pg_temp.who(p_k text) returns text language sql stable as $$ select claims from _who where k = p_k $$;

-- Two base stations: one that is watched closely here, one that goes away.
create temporary table _ctx (k text primary key, v text) on commit drop;
grant select on _ctx to anon, authenticated, service_role;
do $$
declare
  j jsonb;
  nm text;
begin
  -- Nothing left over from a live database's own findings decides a check.
  delete from meganet.health_finding;
  delete from meganet.health_receiver;
  delete from meganet.health_refresh;
  foreach nm in array array['pi', 'gone'] loop
    j := meganet.create_ingest_token('_check hf ' || nm, null);
    insert into _ctx values ('tok_' || nm, j ->> 'token'), ('id_' || nm, j ->> 'id');
  end loop;
end
$$;
create or replace function pg_temp.ctx(p_k text) returns text language sql stable as $$ select v from _ctx where k = p_k $$;
create or replace function pg_temp.id(p_k text) returns bigint language sql stable as $$ select v::bigint from _ctx where k = p_k $$;

-- ── Shape and access ─────────────────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('the three tables have RLS on',
    (select bool_and(relrowsecurity) from pg_class
      where oid in ('meganet.health_finding'::regclass, 'meganet.health_receiver'::regclass, 'meganet.health_refresh'::regclass)));
  perform pg_temp.check_that('anon may read findings and when each run last happened, and write neither',
    has_table_privilege('anon', 'meganet.health_finding', 'select') and has_table_privilege('anon', 'meganet.health_refresh', 'select')
      and not has_table_privilege('anon', 'meganet.health_finding', 'insert,update,delete')
      and not has_table_privilege('authenticated', 'meganet.health_finding', 'insert,update,delete')
      and not has_table_privilege('authenticated', 'meganet.health_refresh', 'insert,update,delete'));
  perform pg_temp.check_that('nothing a browser holds may read the receivers'' memory',
    not has_table_privilege('anon', 'meganet.health_receiver', 'select')
      and not has_table_privilege('authenticated', 'meganet.health_receiver', 'select'));
  perform pg_temp.check_that('only the secret key may run the base station rules or report station findings',
    has_function_privilege('service_role', 'meganet.refresh_base_station_findings(timestamptz)', 'execute')
      and has_function_privilege('service_role', 'meganet.report_station_findings(jsonb)', 'execute')
      and not has_function_privilege('anon', 'meganet.refresh_base_station_findings(timestamptz)', 'execute')
      and not has_function_privilege('authenticated', 'meganet.refresh_base_station_findings(timestamptz)', 'execute')
      and not has_function_privilege('anon', 'meganet.report_station_findings(jsonb)', 'execute')
      and not has_function_privilege('authenticated', 'meganet.report_station_findings(jsonb)', 'execute'));
  perform pg_temp.check_that('the helpers are granted to nothing a browser holds',
    not has_function_privilege('anon', 'meganet.base_station_state(text, integer, timestamptz, timestamptz)', 'execute')
      and not has_function_privilege('authenticated', 'meganet.health_apply(text, timestamptz, boolean)', 'execute')
      and not has_function_privilege('authenticated', 'meganet.health_begin()', 'execute'));
  perform pg_temp.check_that('one definition of a base station''s state: online within three intervals (never under 3 min), quiet within the hour, then offline; off is off',
    meganet.base_station_state('manage', 60, now() - interval '170 seconds', now()) = 'online'
      and meganet.base_station_state('manage', 60, now() - interval '4 minutes', now()) = 'quiet'
      and meganet.base_station_state('manage', 300, now() - interval '14 minutes', now()) = 'online'
      and meganet.base_station_state('report', 60, now() - interval '59 minutes', now()) = 'quiet'
      and meganet.base_station_state('manage', 60, now() - interval '61 minutes', now()) = 'offline'
      and meganet.base_station_state('off', 60, now() - interval '9 days', now()) = 'off');
  perform pg_temp.check_that('a span reads as the analysis says it',
    meganet.health_span(40 * 60) = '40 min' and meganet.health_span(7.5 * 3600) = '7.5 h'
      and meganet.health_span(30 * 3600) = '30 h' and meganet.health_span(3.24 * 86400) = '3.2 days');
end
$$;

-- ── Base stations ────────────────────────────────────────────────────────────

do $$
declare
  t0  timestamptz := now();
  pi  bigint := pg_temp.id('id_pi');
  gone bigint := pg_temp.id('id_gone');
  rx  jsonb;
  r   jsonb;
  f   meganet.health_finding;
  f2  meganet.health_finding;
  st  jsonb;
begin
  -- Both check in, with a whole status naming their receivers, and a heartbeat.
  rx := '[["sdr-serial:0001", "running", 500, null], ["gps-1", "running", 0, null], ["ert-1", "disabled", 0, null]]';
  perform pg_temp.checkin(pg_temp.ctx('tok_pi'), jsonb_build_object('v', 1, 'mode', 'manage', 'idle_s', 60,
    'beat', jsonb_build_object('up', 100, 'rx', rx),
    'status', jsonb_build_object('receivers', jsonb_build_array(
      jsonb_build_object('key', 'sdr-serial:0001', 'name', 'Stick 1', 'kind', 'sdr', 'state', 'running'),
      jsonb_build_object('key', 'gps-1', 'name', 'GPS', 'kind', 'gps', 'state', 'running'),
      jsonb_build_object('key', 'ert-1', 'name', 'ERT', 'kind', 'ert-a2', 'state', 'disabled')))));
  perform pg_temp.checkin(pg_temp.ctx('tok_gone'), '{"v": 1, "mode": "report", "idle_s": 60, "beat": {"rx": []}}');

  r := meganet.refresh_base_station_findings(t0);
  perform pg_temp.check_that('two base stations checking in now: nothing found, and the run says what it judged',
    jsonb_array_length(r -> 'opened') = 0 and (r ->> 'open')::int = 0
      and (r -> 'judged' ->> 'base_stations')::int = 2 and (r -> 'judged' ->> 'receivers')::int = 1, r::text);
  perform pg_temp.check_that('…a receiver''s count is remembered; a GPS and a receiver set aside are not judged',
    (select count(*) from meganet.health_receiver where ingest_token_id = pi) = 1
      and exists (select 1 from meganet.health_receiver where ingest_token_id = pi and rx_key = 'sdr-serial:0001' and decoded = 500));
  perform pg_temp.check_that('…and the run records when it happened',
    (select at from meganet.health_refresh where source = 'base-stations') = t0);

  -- Quiet: ten minutes since `gone` checked in.
  perform pg_temp.seen(pi, t0 + interval '9 minutes 30 seconds');
  r := meganet.refresh_base_station_findings(t0 + interval '10 minutes');
  f := pg_temp.open_of('base-stations', 'base-station-quiet', 'token:' || gone);
  perform pg_temp.check_that('a base station not heard from for ten minutes is a warning on the next run, opened then',
    f.id is not null and f.severity = 'warn' and f.first_seen = t0 + interval '10 minutes' and f.ingest_token_id = gone
      and f.title like '_check hf gone: quiet — not heard from for 10 min' and f.evidence ->> 'state' = 'quiet'
      and jsonb_array_length(r -> 'opened') = 1 and r -> 'opened' -> 0 ->> 'subject' = 'token:' || gone, r::text);
  perform pg_temp.check_that('…and only that one: the other checked in thirty seconds ago',
    (pg_temp.open_of('base-stations', 'base-station-quiet', 'token:' || pi)).id is null);

  perform pg_temp.seen(pi, t0 + interval '19 minutes 30 seconds');
  r := meganet.refresh_base_station_findings(t0 + interval '20 minutes');
  f2 := pg_temp.open_of('base-stations', 'base-station-quiet', 'token:' || gone);
  perform pg_temp.check_that('still quiet ten minutes later: the same finding, brought up to date, not opened again',
    f2.id = f.id and f2.first_seen = f.first_seen and f2.last_seen = t0 + interval '20 minutes'
      and f2.title like '%not heard from for 20 min' and jsonb_array_length(r -> 'opened') = 0, r::text);

  perform pg_temp.seen(pi, t0 + interval '2 hours' - interval '30 seconds');
  r := meganet.refresh_base_station_findings(t0 + interval '2 hours');
  f2 := pg_temp.open_of('base-stations', 'base-station-quiet', 'token:' || gone);
  perform pg_temp.check_that('past the hour it is offline: critical, and the run says it got worse',
    f2.id = f.id and f2.severity = 'critical' and f2.title like '%: offline — not heard from for 2 h'
      and jsonb_array_length(r -> 'worse') = 1 and r -> 'worse' -> 0 ->> 'was' = 'warn', r::text);

  perform pg_temp.check_that('the Base Stations tab''s row carries the state and what is open about the station',
    (select meganet.base_station_row(t, b, t0 + interval '2 hours') ->> 'state' = 'offline'
        and jsonb_array_length(meganet.base_station_row(t, b, t0 + interval '2 hours') -> 'findings') = 1
        and meganet.base_station_row(t, b, t0 + interval '2 hours') -> 'findings' -> 0 ->> 'kind' = 'base-station-quiet'
       from meganet.ingest_token t join meganet.base_station b on b.ingest_token_id = t.id where t.id = gone)
      and (select meganet.base_station_row(t, b, t0 + interval '2 hours') ->> 'state' = 'online'
       from meganet.ingest_token t join meganet.base_station b on b.ingest_token_id = t.id where t.id = pi));

  -- It comes back.
  perform pg_temp.seen(pi, t0 + interval '2 hours 4 minutes');
  perform pg_temp.seen(gone, t0 + interval '2 hours 4 minutes');
  r := meganet.refresh_base_station_findings(t0 + interval '2 hours 5 minutes');
  f2 := (select h from meganet.health_finding h where h.id = f.id);
  perform pg_temp.check_that('checking in again clears it on the next run, and the run says so',
    f2.cleared_at = t0 + interval '2 hours 5 minutes' and (pg_temp.open_of('base-stations', 'base-station-quiet', 'token:' || gone)).id is null
      and jsonb_array_length(r -> 'cleared') = 1 and r -> 'cleared' -> 0 ->> 'id' = f.id::text, r::text);

  -- ── a receiver that runs and hears nothing ──
  -- Six hours on, the stick's count has not moved: 500 every heartbeat.
  perform pg_temp.seen(pi, t0 + interval '5 hours 54 minutes');
  r := meganet.refresh_base_station_findings(t0 + interval '5 hours 55 minutes');
  perform pg_temp.check_that('an SDR that has decoded nothing for just under six hours is not yet a finding',
    (pg_temp.open_of('base-stations', 'receiver-deaf', 'token:' || pi || '/sdr-serial:0001')).id is null, r::text);
  perform pg_temp.seen(pi, t0 + interval '6 hours 4 minutes');
  r := meganet.refresh_base_station_findings(t0 + interval '6 hours 5 minutes');
  f := pg_temp.open_of('base-stations', 'receiver-deaf', 'token:' || pi || '/sdr-serial:0001');
  perform pg_temp.check_that('…at six hours it is: running, its count still, named by the station and the stick',
    f.id is not null and f.severity = 'warn' and f.rx_key = 'sdr-serial:0001' and f.ingest_token_id = pi
      and f.title = '_check hf pi — Stick 1: nothing decoded for 6.1 h' and f.detail like 'It is running, and its count of decoded frames has not moved%'
      and f.evidence ->> 'decoded' = '500', coalesce(f.title, '<none>'));
  perform pg_temp.check_that('…and the Base Stations tab''s row carries it',
    (select meganet.base_station_row(t, b, t0 + interval '6 hours 5 minutes') -> 'findings' -> 0 ->> 'rx_key'
       from meganet.ingest_token t join meganet.base_station b on b.ingest_token_id = t.id where t.id = pi) = 'sdr-serial:0001');

  -- The station goes quiet: nothing is known about its receivers, so what was found stands.
  r := meganet.refresh_base_station_findings(t0 + interval '6 hours 30 minutes');
  perform pg_temp.check_that('while its base station is away, a receiver''s finding is held — not cleared, not updated',
    (pg_temp.open_of('base-stations', 'receiver-deaf', 'token:' || pi || '/sdr-serial:0001')).last_seen = t0 + interval '6 hours 5 minutes'
      and (pg_temp.open_of('base-stations', 'base-station-quiet', 'token:' || pi)).id is not null, r::text);

  -- Back, and decoding.
  perform pg_temp.seen(pi, t0 + interval '6 hours 34 minutes', '[["sdr-serial:0001", "running", 512, null], ["gps-1", "running", 0, null]]');
  r := meganet.refresh_base_station_findings(t0 + interval '6 hours 35 minutes');
  perform pg_temp.check_that('a count that moves clears it on the next run',
    (pg_temp.open_of('base-stations', 'receiver-deaf', 'token:' || pi || '/sdr-serial:0001')).id is null
      and (select cleared_at from meganet.health_finding where id = f.id) = t0 + interval '6 hours 35 minutes'
      and (select changed_at from meganet.health_receiver where ingest_token_id = pi and rx_key = 'sdr-serial:0001') = t0 + interval '6 hours 34 minutes', r::text);

  -- Unplugged: a restart resets the count, which is a change; then nothing for a day.
  perform pg_temp.seen(pi, t0 + interval '7 hours', '[["sdr-serial:0001", "unplugged", 0, null]]');
  r := meganet.refresh_base_station_findings(t0 + interval '7 hours');
  perform pg_temp.seen(pi, t0 + interval '31 hours', '[["sdr-serial:0001", "unplugged", 0, null]]');
  r := meganet.refresh_base_station_findings(t0 + interval '31 hours');
  f := pg_temp.open_of('base-stations', 'receiver-deaf', 'token:' || pi || '/sdr-serial:0001');
  perform pg_temp.check_that('a count reset by a restart is a change; a day of nothing after it is critical, and says the stick is unplugged',
    f.severity = 'critical' and f.title like '%nothing decoded for 24 h' and f.detail like 'It is unplugged, and has decoded nothing%'
      and jsonb_array_length(r -> 'opened') = 1, coalesce(f.title, '<none>'));

  -- Forgotten on the station: the heartbeat no longer names it.
  perform pg_temp.seen(pi, t0 + interval '31 hours 4 minutes', '[]');
  r := meganet.refresh_base_station_findings(t0 + interval '31 hours 5 minutes');
  perform pg_temp.check_that('a receiver the station no longer names: its finding clears and nothing remembers it',
    (pg_temp.open_of('base-stations', 'receiver-deaf', 'token:' || pi || '/sdr-serial:0001')).id is null
      and not exists (select 1 from meganet.health_receiver where ingest_token_id = pi), r::text);

  -- A first sighting with no count history takes the heartbeat's "data ago" when it has one.
  perform pg_temp.seen(pi, t0 + interval '32 hours', '[["serial:/dev/ttyACM0", "running", 7, 50000]]');
  r := meganet.refresh_base_station_findings(t0 + interval '32 hours');
  perform pg_temp.check_that('a receiver seen for the first time is dated from when the heartbeat says data last arrived',
    (select changed_at from meganet.health_receiver where ingest_token_id = pi and rx_key = 'serial:/dev/ttyACM0')
      = t0 + interval '32 hours' - interval '50000 seconds'
      and (pg_temp.open_of('base-stations', 'receiver-deaf', 'token:' || pi || '/serial:/dev/ttyACM0')).id is not null, r::text);

  -- Revoked: nothing is found about it, and what was is cleared.
  update meganet.ingest_token set revoked_at = t0 where id = pi;
  r := meganet.refresh_base_station_findings(t0 + interval '33 hours');
  perform pg_temp.check_that('a revoked token''s findings clear and its receivers are forgotten',
    not exists (select 1 from meganet.health_finding where ingest_token_id = pi and cleared_at is null)
      and not exists (select 1 from meganet.health_receiver where ingest_token_id = pi), r::text);

  -- A station that says it turned check-ins off is not a fault.
  update meganet.base_station set mode = 'off', last_seen_at = t0 where ingest_token_id = gone;
  r := meganet.refresh_base_station_findings(t0 + interval '40 hours');
  perform pg_temp.check_that('a base station turned off on purpose is not quiet',
    (pg_temp.open_of('base-stations', 'base-station-quiet', 'token:' || gone)).id is null, r::text);
  update meganet.base_station set mode = 'report' where ingest_token_id = gone;
  r := meganet.refresh_base_station_findings(t0 + interval '40 hours');
end
$$;

-- ── Station findings, as the analysis reports them ───────────────────────────

do $$
declare
  t   timestamptz := now() - interval '40 minutes';
  r   jsonb;
  f   meganet.health_finding;
  f2  meganet.health_finding;
  sid text := (select id from meganet.station where deleted_at is null order by id limit 1);
  rep jsonb;
  v_bs integer := (select count(*) from meganet.health_finding where source = 'base-stations' and cleared_at is null);
begin
  rep := jsonb_build_object('at', t, 'complete', true, 'detail', jsonb_build_object('readings', 1234, 'took_ms', 900, 'commit', 'abc123'),
    'findings', jsonb_build_array(
      jsonb_build_object('subject', 'silent:' || sid, 'kind', 'silent', 'severity', 'warn', 'station_id', sid,
        'title', 'Silent — missed its last 2 checks', 'detail', 'Checks every 3 h; nothing heard since 09:10 Wed 7 Oct (6.5 h).',
        'evidence', jsonb_build_object('trailingMisses', 2, 'periodMin', 180)),
      jsonb_build_object('subject', 'receiver-silent:serial-monitor/rpi-1', 'kind', 'receiver-silent', 'severity', 'critical',
        'title', 'rpi-1: nothing delivered for 2 h', 'detail', 'It delivered 900 readings and stopped.', 'evidence', jsonb_build_object())));

  perform pg_temp.check_that('nothing a browser holds may report',
    pg_temp.as_role('anon', pg_temp.who('anon'), format('select meganet.report_station_findings(%L::jsonb)::text', rep)) = 'ERROR 42501'
      and pg_temp.as_role('authenticated', pg_temp.who('admin'), format('select meganet.report_station_findings(%L::jsonb)::text', rep)) = 'ERROR 42501');

  r := pg_temp.report(rep);
  f := pg_temp.open_of('stations', 'silent', 'silent:' || sid);
  perform pg_temp.check_that('a report opens what it names, as of when the analysis ran',
    f.id is not null and f.station_id = sid and f.first_seen = t and f.severity = 'warn' and f.evidence ->> 'periodMin' = '180'
      and (r ->> 'open')::int = 2 and jsonb_array_length(r -> 'opened') = 2, r::text);
  perform pg_temp.check_that('…and records the run: when, how long, what it read',
    (select at = t and took_ms = 900 and detail ->> 'readings' = '1234' and detail ->> 'complete' = 'true' and detail ->> 'findings' = '2'
       from meganet.health_refresh where source = 'stations'));

  perform pg_temp.check_that('anybody may read a station''s findings and when they were worked out',
    pg_temp.as_role('anon', pg_temp.who('anon'), format($q$select count(*)::text from meganet.health_finding where source = 'stations' and cleared_at is null$q$)) = '2'
      and pg_temp.as_role('anon', pg_temp.who('anon'), $q$select count(*)::text from meganet.health_refresh$q$) = '2');
  perform pg_temp.check_that('…but only an administrator a base station''s',
    pg_temp.as_role('anon', pg_temp.who('anon'), $q$select count(*)::text from meganet.health_finding where source = 'base-stations'$q$) = '0'
      and pg_temp.as_role('authenticated', pg_temp.who('editor'), $q$select count(*)::text from meganet.health_finding where source = 'base-stations'$q$) = '0'
      and pg_temp.as_role('authenticated', pg_temp.who('admin'), $q$select count(*)::text from meganet.health_finding where source = 'base-stations'$q$)::int
          = (select count(*) from meganet.health_finding where source = 'base-stations'));

  -- Fifteen minutes on: worse, and the receiver back.
  rep := jsonb_set(jsonb_set(rep, '{at}', to_jsonb(t + interval '15 minutes')), '{findings}', jsonb_build_array(
    jsonb_build_object('subject', 'silent:' || sid, 'kind', 'silent', 'severity', 'critical', 'station_id', sid,
      'title', 'Silent — missed its last 4 checks', 'detail', 'Checks every 3 h.', 'evidence', jsonb_build_object('trailingMisses', 4))));
  r := pg_temp.report(rep);
  f2 := pg_temp.open_of('stations', 'silent', 'silent:' || sid);
  perform pg_temp.check_that('the next report updates the same finding, says it got worse, and clears what it no longer names',
    f2.id = f.id and f2.first_seen = t and f2.last_seen = t + interval '15 minutes' and f2.severity = 'critical'
      and f2.title = 'Silent — missed its last 4 checks'
      and jsonb_array_length(r -> 'worse') = 1 and jsonb_array_length(r -> 'opened') = 0
      and jsonb_array_length(r -> 'cleared') = 1 and r -> 'cleared' -> 0 ->> 'kind' = 'receiver-silent', r::text);

  -- An older report arriving late changes nothing.
  r := pg_temp.report(jsonb_set(rep, '{at}', to_jsonb(t + interval '5 minutes')));
  perform pg_temp.check_that('a report older than the last one accepted is refused as stale, and changes nothing',
    (r ->> 'stale')::boolean and (pg_temp.open_of('stations', 'silent', 'silent:' || sid)).last_seen = t + interval '15 minutes', r::text);

  -- A capped read is not the whole week: it may open, but it clears nothing.
  r := pg_temp.report(jsonb_build_object('at', t + interval '30 minutes', 'complete', false, 'findings', '[]'::jsonb));
  perform pg_temp.check_that('an incomplete report clears nothing',
    (pg_temp.open_of('stations', 'silent', 'silent:' || sid)).id is not null and jsonb_array_length(r -> 'cleared') = 0, r::text);
  r := pg_temp.report(jsonb_build_object('at', t + interval '35 minutes', 'complete', true, 'findings', '[]'::jsonb));
  perform pg_temp.check_that('a complete one that no longer names it clears it — heard again',
    (pg_temp.open_of('stations', 'silent', 'silent:' || sid)).id is null
      and (select cleared_at from meganet.health_finding where id = f.id) = t + interval '35 minutes', r::text);

  perform pg_temp.check_that('the station reports never touched a base station''s findings',
    v_bs > 0 and v_bs = (select count(*) from meganet.health_finding where source = 'base-stations' and cleared_at is null), v_bs::text);

  -- What it refuses.
  perform pg_temp.check_that('a finding without a kind, a subject, a known severity or a title is refused by its place in the list',
    pg_temp.as_role('service_role', '{"role":"service_role"}', format('select meganet.report_station_findings(%L::jsonb)::text',
      jsonb_build_object('at', now(), 'findings', jsonb_build_array(jsonb_build_object('subject', 'x', 'kind', 'silent', 'severity', 'dire', 'title', 'x')))))
      = 'ERROR 22023'
      and pg_temp.as_role('service_role', '{"role":"service_role"}', format('select meganet.report_station_findings(%L::jsonb)::text',
      jsonb_build_object('at', now(), 'findings', jsonb_build_array(jsonb_build_object('subject', 'x', 'kind', 'Silent!', 'severity', 'warn', 'title', 'x')))))
      = 'ERROR 22023');
  perform pg_temp.check_that('…and so is a report from the future, or more than a day old',
    pg_temp.as_role('service_role', '{"role":"service_role"}', format('select meganet.report_station_findings(%L::jsonb)::text',
      jsonb_build_object('at', now() + interval '1 hour', 'findings', '[]'::jsonb))) = 'ERROR 22023'
      and pg_temp.as_role('service_role', '{"role":"service_role"}', format('select meganet.report_station_findings(%L::jsonb)::text',
      jsonb_build_object('at', now() - interval '2 days', 'findings', '[]'::jsonb))) = 'ERROR 22023');
  perform pg_temp.check_that('a station finding cannot name an ingest point, nor a base station run a station kind (the table says so)',
    pg_temp.as_role('postgres', '{}', $q$insert into meganet.health_finding (source, kind, subject, ingest_token_id, severity, title, detail, first_seen, last_seen)
       values ('stations', 'silent', 'x', 1, 'warn', 'x', '', now(), now()) returning 'inserted'$q$) = 'ERROR 23514'
      and pg_temp.as_role('postgres', '{}', $q$insert into meganet.health_finding (source, kind, subject, station_id, severity, title, detail, first_seen, last_seen)
       values ('base-stations', 'silent', 'x', null, 'warn', 'x', '', now(), now()) returning 'inserted'$q$) = 'ERROR 23514');
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
