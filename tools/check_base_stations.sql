-- check_base_stations.sql — Prove 0049: a base station checks in with its
-- health, an administrator asks it to do something, and the team SSH keys.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_base_stations.sql
--
-- One row per claim, a non-zero exit if any fails, and the whole script in a
-- transaction that rolls back — the people it signs up, the tokens it mints,
-- the check-ins and the keys included — so it is safe against the live
-- database. Base stations are anon holding a token in X-Ingest-Token, as
-- PostgREST hands it over; people are made through 0005's triggers, as
-- check_ingest_token_requests.sql makes them.

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
-- text, or 'ERROR <sqlstate>'. Rolled back, so each check starts clean.
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

-- A base station: anon, with p_token in X-Ingest-Token (none when null). Rolled back.
create or replace function pg_temp.as_device(p_token text, p_sql text)
returns text language plpgsql as $$
declare
  v text;
begin
  begin
    execute 'set local role anon';
    perform pg_catalog.set_config('request.jwt.claims', '{"role":"anon"}', true);
    perform pg_catalog.set_config('request.headers',
      case when p_token is null then '{}' else pg_catalog.json_build_object('x-ingest-token', p_token)::text end, true);
    execute p_sql into v;
    raise exception using errcode = 'MNRLB', message = coalesce(v, '<null>');
  exception
    when sqlstate 'MNRLB' then return sqlerrm;
    when others then return 'ERROR ' || sqlstate;
  end;
end;
$$;

-- The same, kept: for the check-ins whose writes the next checks read.
create or replace function pg_temp.as_device_keep(p_token text, p_sql text)
returns text language plpgsql as $$
declare
  v text;
begin
  perform pg_catalog.set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform pg_catalog.set_config('request.headers', pg_catalog.json_build_object('x-ingest-token', p_token)::text, true);
  execute 'set local role anon';
  execute p_sql into v;
  execute 'reset role';
  perform pg_catalog.set_config('request.headers', '', true);
  perform pg_catalog.set_config('request.jwt.claims', '', true);
  return v;
end;
$$;

-- A check-in, kept: payload → the answer.
create or replace function pg_temp.checkin(p_token text, p_payload jsonb)
returns jsonb language plpgsql as $$
begin
  return pg_temp.as_device_keep(p_token, pg_catalog.format('select meganet.base_station_checkin(%L::jsonb)::text', p_payload))::jsonb;
end;
$$;

create or replace function pg_temp.as_admin_keep(p_sql text)
returns text language plpgsql as $$
declare
  v text;
begin
  perform pg_catalog.set_config('request.jwt.claims',
    '{"role":"authenticated","email":"bs-admin@example.test","sub":"00000000-0000-4000-8000-0000000dc702"}', true);
  execute 'set local role authenticated';
  execute p_sql into v;
  execute 'reset role';
  perform pg_catalog.set_config('request.jwt.claims', '', true);
  return v;
end;
$$;

insert into meganet.editor_allow (entry, note) values
  ('bs-editor@example.test', 'check_base_stations — rolled back'),
  ('bs-admin@example.test',  'check_base_stations — rolled back')
on conflict (entry) do nothing;
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000dc701', 'bs-editor@example.test'),
  ('00000000-0000-4000-8000-0000000dc702', 'bs-admin@example.test')
on conflict (id) do nothing;
update meganet.app_user set role = 'admin' where id = '00000000-0000-4000-8000-0000000dc702';

create temporary table _who (k text primary key, claims text) on commit drop;
insert into _who values
  ('anon',   '{"role":"anon"}'),
  ('editor', '{"role":"authenticated","email":"bs-editor@example.test","sub":"00000000-0000-4000-8000-0000000dc701"}'),
  ('admin',  '{"role":"authenticated","email":"bs-admin@example.test","sub":"00000000-0000-4000-8000-0000000dc702"}');

-- Four ingest points, minted the way the Admin tab mints them: two that check
-- in, one that never does, one revoked.
create temporary table _ctx (k text primary key, v text) on commit drop;
grant select on _ctx to anon, authenticated;
do $$
declare
  j jsonb;
  nm text;
begin
  foreach nm in array array['one', 'two', 'never', 'gone'] loop
    j := meganet.create_ingest_token('_check bs ' || nm, null);
    insert into _ctx values ('tok_' || nm, j ->> 'token'), ('id_' || nm, j ->> 'id');
  end loop;
  update meganet.ingest_token set revoked_at = now() where id = (select v::bigint from _ctx where k = 'id_gone');
end
$$;

create or replace function pg_temp.ctx(p_k text) returns text language sql stable as $$ select v from _ctx where k = p_k $$;

-- Made with ssh-keygen, with its own fingerprints (ssh-keygen -lf), as the
-- base station's own test holds its reader to.
insert into _ctx values
  ('key_ed', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPe8hvW1PCMkuoplQxeOFxa2TvuF2q0PFfleQ85hNXHo vec-ed25519@test'),
  ('fp_ed',  'SHA256:VeBIQNSQYe0Ge+JIoXnjKbfB0gSWAJChLuItuhNNFew'),
  ('key_ec', 'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBLbLD/E41tmQJt+U1fetJOuOc0jgqqf/guPCE8hi44NkDIBLOTPkxOA4ARYwct0+ql87t1YZVUb+dK5Ornw5xqg= vec-ecdsa@test'),
  ('fp_ec',  'SHA256:RknIRqux7NWt85Wr0wnUI0GZOtVaVIIGAxKdQwI8OEU'),
  ('key_weak', 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQDdW6rTeThWDCPw2L3zu53N0l9R3fe++zLyN3njKTAf6bpcE/yKXTDcaxCf4Yx1CdOnqK2SDQGhea3357ZlWGjHwrKQHcB5UQJZDyjJTg4c6eJ2jeRq8resqUQM6Lb/RxmwYY57WiUxmFtWfpeEncBuuXt7EWZNQgNraXaJuzFGVQ== weak@test');

-- ── Shape and access ─────────────────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('the three tables have RLS on, no policy, and no grant to a role a browser holds',
    (select bool_and(relrowsecurity) from pg_class where oid in ('meganet.base_station'::regclass, 'meganet.base_station_command'::regclass, 'meganet.base_station_key'::regclass))
      and not exists (select 1 from pg_policies where schemaname = 'meganet' and tablename in ('base_station', 'base_station_command', 'base_station_key'))
      and not has_table_privilege('anon', 'meganet.base_station', 'select')
      and not has_table_privilege('authenticated', 'meganet.base_station_command', 'select')
      and not has_table_privilege('authenticated', 'meganet.base_station_key', 'select'));
  perform pg_temp.check_that('anon may check in and fetch the team keys, and may not list, ask or add keys',
    has_function_privilege('anon', 'meganet.base_station_checkin(jsonb)', 'execute')
      and has_function_privilege('anon', 'meganet.base_station_keys(jsonb)', 'execute')
      and not has_function_privilege('anon', 'meganet.admin_base_stations()', 'execute')
      and not has_function_privilege('anon', 'meganet.admin_base_station_command(bigint, text, jsonb)', 'execute')
      and not has_function_privilege('anon', 'meganet.admin_base_station_key_add(text, text)', 'execute'));
  perform pg_temp.check_that('the helpers are granted to nothing a browser holds',
    not has_function_privilege('anon', 'meganet.base_station_verb_check(text, jsonb)', 'execute')
      and not has_function_privilege('authenticated', 'meganet.base_station_verb_check(text, jsonb)', 'execute')
      and not has_function_privilege('authenticated', 'meganet.base_station_key_parse(text)', 'execute')
      and not has_function_privilege('anon', 'meganet.base_station_keys_hash()', 'execute'));
end
$$;

-- ── A base station checks in ─────────────────────────────────────────────────

do $$
declare
  v_empty text := encode(sha256(convert_to('', 'utf8')), 'hex');
  a jsonb;
begin
  perform pg_temp.check_that('no token, an unknown one, or a revoked one: refused (PT401)',
    pg_temp.as_device(null, $q$select meganet.base_station_checkin('{}')::text$q$) = 'ERROR PT401'
      and pg_temp.as_device('mgn_' || repeat('0', 64), $q$select meganet.base_station_checkin('{}')::text$q$) = 'ERROR PT401'
      and pg_temp.as_device(pg_temp.ctx('tok_gone'), $q$select meganet.base_station_checkin('{}')::text$q$) = 'ERROR PT401');

  a := pg_temp.checkin(pg_temp.ctx('tok_one'), jsonb_build_object('v', 1, 'agent', jsonb_build_object('app', 'check', 'version', '9.9.9'),
    'mode', 'manage', 'idle_s', 60, 'beat', jsonb_build_object('up', 100, 'q', 3),
    'status', jsonb_build_object('name', 'Bench', 'receivers', '[]'::jsonb, 'config', jsonb_build_object('name', 'Bench'),
                                 'access', jsonb_build_object('available', true, 'keys', '[]'::jsonb, 'policy', jsonb_build_object('meganetKeys', false))),
    'keys_hash', 'none'));
  perform pg_temp.check_that('a first check-in is answered: a minute until the next, nobody watching, nothing asked, its label, the keys'' hash',
    (a ->> 'next_s')::int = 60 and (a ->> 'watch')::boolean = false and a -> 'commands' = '[]'::jsonb
      and a ->> 'label' = '_check bs one' and a ->> 'keys_hash' = v_empty, a::text);
  perform pg_temp.check_that('…and what it said is kept: software, mode, status, heartbeat',
    exists (select 1 from meganet.base_station b where b.ingest_token_id = pg_temp.ctx('id_one')::bigint
             and b.app = 'check' and b.version = '9.9.9' and b.mode = 'manage' and b.checkins = 1
             and b.status ->> 'name' = 'Bench' and (b.beat ->> 'q')::int = 3 and b.keys_hash = 'none'));

  update meganet.base_station set status_at = now() - interval '1 hour' where ingest_token_id = pg_temp.ctx('id_one')::bigint;
  a := pg_temp.checkin(pg_temp.ctx('tok_one'), '{"v": 1, "mode": "manage", "idle_s": 5, "beat": {"up": 160, "q": 0}}');
  perform pg_temp.check_that('a heartbeat alone keeps the status it sent before, and moves only the heartbeat',
    exists (select 1 from meganet.base_station b where b.ingest_token_id = pg_temp.ctx('id_one')::bigint
             and b.status ->> 'name' = 'Bench' and b.status_at < now() - interval '50 minutes' and (b.beat ->> 'q')::int = 0 and b.checkins = 2));
  perform pg_temp.check_that('a station that asks to check in every 5 s is held to 30',
    (a ->> 'next_s')::int = 30 and (select idle_s from meganet.base_station where ingest_token_id = pg_temp.ctx('id_one')::bigint) = 30, a::text);
  perform pg_temp.check_that('a check-in of another version, an unknown mode, or too much is refused, saying so (22023)',
    pg_temp.as_device(pg_temp.ctx('tok_one'), $q$select meganet.base_station_checkin('{"v": 2}')::text$q$) = 'ERROR 22023'
      and pg_temp.as_device(pg_temp.ctx('tok_one'), $q$select meganet.base_station_checkin('{"mode": "sometimes"}')::text$q$) = 'ERROR 22023'
      and pg_temp.as_device(pg_temp.ctx('tok_one'), $q$select meganet.base_station_checkin('{"status": [1, 2]}')::text$q$) = 'ERROR 22023'
      and pg_temp.as_device(pg_temp.ctx('tok_one'), format('select meganet.base_station_checkin(%L::jsonb)::text',
            jsonb_build_object('status', jsonb_build_object('x', repeat('x', 17000))))) = 'ERROR 22023'
      and pg_temp.as_device(pg_temp.ctx('tok_one'), format('select meganet.base_station_checkin(%L::jsonb)::text',
            jsonb_build_object('beat', jsonb_build_object('x', repeat('x', 2100))))) = 'ERROR 22023'
      and pg_temp.as_device(pg_temp.ctx('tok_one'), format('select meganet.base_station_checkin(%L::jsonb)::text',
            jsonb_build_object('results', (select jsonb_agg(jsonb_build_object('id', g)) from generate_series(1, 21) g)))) = 'ERROR 22023');

  perform pg_temp.checkin(pg_temp.ctx('tok_two'), '{"v": 1, "mode": "manage", "beat": {"up": 1}}');
end
$$;

-- ── The tab: who may see it, and what it lists ───────────────────────────────

do $$
declare
  l jsonb;
  one jsonb; never jsonb;
begin
  perform pg_temp.check_that('an editor who is not an administrator is refused (42501); anon cannot reach it at all',
    pg_temp.as_role('authenticated', (select claims from _who where k = 'editor'), 'select meganet.admin_base_stations()::text') = 'ERROR 42501'
      and pg_temp.as_role('anon', (select claims from _who where k = 'anon'), 'select meganet.admin_base_stations()::text') = 'ERROR 42501');
  l := pg_temp.as_admin_keep('select meganet.admin_base_stations()::text')::jsonb;
  select s into one from jsonb_array_elements(l -> 'stations') s where (s ->> 'id')::bigint = pg_temp.ctx('id_one')::bigint;
  select s into never from jsonb_array_elements(l -> 'stations') s where (s ->> 'id')::bigint = pg_temp.ctx('id_never')::bigint;
  perform pg_temp.check_that('an administrator gets every ingest point: one that checks in with its heartbeat and status',
    (one ->> 'managed')::boolean and one ->> 'version' = '9.9.9' and one -> 'status' ->> 'name' = 'Bench' and (one -> 'beat' ->> 'up')::int = 160, one::text);
  perform pg_temp.check_that('…the list''s status without the settings and the SSH detail, which the station''s panel has',
    not (one -> 'status' ? 'config') and not (one -> 'status' ? 'access') and (one -> 'access' ->> 'keys')::int = 0, one::text);
  perform pg_temp.check_that('…one that never checked in, listed as not managed',
    never is not null and not (never ->> 'managed')::boolean and never -> 'status' = 'null'::jsonb, coalesce(never::text, 'missing'));
  perform pg_temp.check_that('…and not a revoked token nothing has heard from',
    not exists (select 1 from jsonb_array_elements(l -> 'stations') s where (s ->> 'id')::bigint = pg_temp.ctx('id_gone')::bigint));
  perform pg_temp.check_that('the station''s panel has the whole status, settings and all',
    (pg_temp.as_admin_keep(format('select meganet.admin_base_station(%s)::text', pg_temp.ctx('id_one')))::jsonb -> 'station' -> 'status' -> 'config' ->> 'name') = 'Bench');
end
$$;

-- ── Asking (decision 2) ──────────────────────────────────────────────────────

do $$
declare
  ask text := 'select meganet.admin_base_station_command(%s, %L, %L::jsonb)::text';
  r jsonb;
  a jsonb;
begin
  perform pg_temp.check_that('an editor cannot ask a base station anything (42501)',
    pg_temp.as_role('authenticated', (select claims from _who where k = 'editor'),
      format(ask, pg_temp.ctx('id_one'), 'log', '{}')) = 'ERROR 42501');
  perform pg_temp.check_that('nothing can be asked of one that has never checked in (22023)',
    pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
      format(ask, pg_temp.ctx('id_never'), 'log', '{}')) = 'ERROR 22023');
  perform pg_temp.check_that('a request not on the list is refused (22023): a shell is not a thing it can be asked for',
    pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'), format(ask, pg_temp.ctx('id_one'), 'shell', '{"cmd": "id"}')) = 'ERROR 22023'
      and pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'), format(ask, pg_temp.ctx('id_one'), 'log', '{"lines": 401}')) = 'ERROR 22023'
      and pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'), format(ask, pg_temp.ctx('id_one'), 'update.auto', '{"on": "yes"}')) = 'ERROR 22023');
  perform pg_temp.check_that('settings may not reach the token, where readings go, the web page or what MegaNet may do (22023)',
    pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'), format(ask, pg_temp.ctx('id_one'), 'config.set', '{"patch": {"meganet": {"token": "mgn_x"}}}')) = 'ERROR 22023'
      and pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'), format(ask, pg_temp.ctx('id_one'), 'config.set', '{"patch": {"meganet": {"endpoints": ["https://x.invalid"]}}}')) = 'ERROR 22023'
      and pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'), format(ask, pg_temp.ctx('id_one'), 'config.set', '{"patch": {"web": {"passwordHash": ""}}}')) = 'ERROR 22023'
      and pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'), format(ask, pg_temp.ctx('id_one'), 'config.set', '{"patch": {"remote": {"mode": "manage"}}}')) = 'ERROR 22023'
      and pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'), format(ask, pg_temp.ctx('id_one'), 'config.set', '{"patch": {}}')) = 'ERROR 22023');

  r := pg_temp.as_admin_keep(format(ask, pg_temp.ctx('id_one'), 'config.set', '{"patch": {"receivers": {"sdr": {"freqHz": 151525000}}, "meganet": {"enabled": true}}}'))::jsonb;
  insert into _ctx values ('cmd1', r ->> 'id');
  perform pg_temp.check_that('a request on the list waits for the station, under the asker''s name, for ten minutes',
    r ->> 'status' = 'queued' and r ->> 'created_by' = 'bs-admin@example.test'
      and (r ->> 'expires_at')::timestamptz between now() + interval '9 minutes' and now() + interval '11 minutes', r::text);
  perform pg_temp.check_that('…and asking starts the station''s five-second check-ins',
    (select watch_until from meganet.base_station where ingest_token_id = pg_temp.ctx('id_one')::bigint) > now() + interval '2 minutes');

  a := pg_temp.checkin(pg_temp.ctx('tok_one'), '{"v": 1, "mode": "manage", "beat": {"up": 200}}');
  perform pg_temp.check_that('the next check-in hands it over, with its arguments, and says five seconds',
    jsonb_array_length(a -> 'commands') = 1 and (a -> 'commands' -> 0 ->> 'id') = pg_temp.ctx('cmd1')
      and a -> 'commands' -> 0 ->> 'verb' = 'config.set' and (a -> 'commands' -> 0 -> 'args' -> 'patch' -> 'receivers' -> 'sdr' ->> 'freqHz')::int = 151525000
      and (a ->> 'next_s')::int = 5 and (a ->> 'watch')::boolean, a::text);
  perform pg_temp.check_that('…once: the check-in after hands nothing over again',
    pg_temp.checkin(pg_temp.ctx('tok_one'), '{"v": 1, "mode": "manage"}') -> 'commands' = '[]'::jsonb
      and (select status from meganet.base_station_command where id = pg_temp.ctx('cmd1')::bigint) = 'sent');

  perform pg_temp.checkin(pg_temp.ctx('tok_two'), jsonb_build_object('v', 1, 'mode', 'manage',
    'results', jsonb_build_array(jsonb_build_object('id', pg_temp.ctx('cmd1')::bigint, 'ok', true, 'result', 'not mine'))));
  perform pg_temp.check_that('another station cannot answer it',
    (select status from meganet.base_station_command where id = pg_temp.ctx('cmd1')::bigint) = 'sent');
  perform pg_temp.checkin(pg_temp.ctx('tok_one'), jsonb_build_object('v', 1, 'mode', 'manage',
    'results', jsonb_build_array(jsonb_build_object('id', pg_temp.ctx('cmd1')::bigint, 'ok', true, 'result', jsonb_build_object('changed', jsonb_build_array('receivers.sdr.freqHz'))))));
  perform pg_temp.check_that('its own station''s answer marks it done, with what it said',
    exists (select 1 from meganet.base_station_command where id = pg_temp.ctx('cmd1')::bigint and status = 'done'
             and result -> 'changed' ->> 0 = 'receivers.sdr.freqHz' and done_at is not null));

  r := pg_temp.as_admin_keep(format(ask, pg_temp.ctx('id_one'), 'reboot', '{}'))::jsonb;
  perform pg_temp.checkin(pg_temp.ctx('tok_one'), '{"v": 1, "mode": "manage"}');
  perform pg_temp.checkin(pg_temp.ctx('tok_one'), jsonb_build_object('v', 1, 'mode', 'manage',
    'results', jsonb_build_array(jsonb_build_object('id', (r ->> 'id')::bigint, 'ok', false, 'error', 'could not'))));
  perform pg_temp.check_that('an answer that it was not done marks it failed, with the reason',
    exists (select 1 from meganet.base_station_command where id = (r ->> 'id')::bigint and status = 'failed' and error = 'could not' and result is null));

  r := pg_temp.as_admin_keep(format(ask, pg_temp.ctx('id_one'), 'status', '{}'))::jsonb;
  perform pg_temp.check_that('one still waiting can be cancelled — and is then never handed over',
    pg_temp.as_admin_keep(format('select meganet.admin_base_station_cancel(%s)::text', r ->> 'id'))::jsonb ->> 'status' = 'cancelled'
      and pg_temp.checkin(pg_temp.ctx('tok_one'), '{"v": 1, "mode": "manage"}') -> 'commands' = '[]'::jsonb);
  perform pg_temp.check_that('one already handed over cannot be called back (22023)',
    pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
      format('select meganet.admin_base_station_cancel(%s)::text', pg_temp.ctx('cmd1'))) = 'ERROR 22023');

  r := pg_temp.as_admin_keep(format(ask, pg_temp.ctx('id_one'), 'send-now', '{}'))::jsonb;
  update meganet.base_station_command set expires_at = now() - interval '1 second' where id = (r ->> 'id')::bigint;
  perform pg_temp.check_that('one nobody collected in ten minutes reads as expired, and is never handed over',
    (select c ->> 'status' from jsonb_array_elements(pg_temp.as_admin_keep(format('select meganet.admin_base_station(%s)::text', pg_temp.ctx('id_one')))::jsonb -> 'commands') c
      where (c ->> 'id') = r ->> 'id') = 'expired'
      and pg_temp.checkin(pg_temp.ctx('tok_one'), '{"v": 1, "mode": "manage"}') -> 'commands' = '[]'::jsonb);
end
$$;

do $$
declare
  ask text := 'select meganet.admin_base_station_command(%s, %L, %L::jsonb)::text';
  last text;
begin
  for i in 1..20 loop
    perform pg_temp.as_admin_keep(format(ask, pg_temp.ctx('id_two'), 'device.rescan', '{}'));
  end loop;
  last := pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'), format(ask, pg_temp.ctx('id_two'), 'device.rescan', '{}'));
  perform pg_temp.check_that('with 20 waiting, the next is refused until it catches up (PT429)', last = 'ERROR PT429', last);
  perform pg_temp.check_that('…which it does ten at a time, saying come back in two seconds for the rest',
    (select jsonb_array_length(a -> 'commands') = 10 and (a ->> 'next_s')::int = 5
       from (select pg_temp.checkin(pg_temp.ctx('tok_two'), '{"v": 1, "mode": "manage"}') a) x));
end
$$;

-- ── The station decides (decision 3) ─────────────────────────────────────────

do $$
declare
  a jsonb;
begin
  a := pg_temp.checkin(pg_temp.ctx('tok_two'), '{"v": 1, "mode": "report"}');
  perform pg_temp.check_that('a station that only reports is handed nothing, and what waited fails, saying why',
    a -> 'commands' = '[]'::jsonb
      and not exists (select 1 from meganet.base_station_command where ingest_token_id = pg_temp.ctx('id_two')::bigint and status = 'queued')
      and exists (select 1 from meganet.base_station_command where ingest_token_id = pg_temp.ctx('id_two')::bigint and status = 'failed'
                   and error like '%only reports%'), a::text);
  perform pg_temp.check_that('…and asking it anything is refused (22023)',
    pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
      format('select meganet.admin_base_station_command(%s, %L, %L::jsonb)::text', pg_temp.ctx('id_two'), 'log', '{}')) = 'ERROR 22023');
  a := pg_temp.checkin(pg_temp.ctx('tok_two'), '{"v": 1, "mode": "off"}');
  perform pg_temp.check_that('one that turned this off is told no time for a next check-in, and is listed as off',
    a -> 'next_s' = 'null'::jsonb and (select mode from meganet.base_station where ingest_token_id = pg_temp.ctx('id_two')::bigint) = 'off', a::text);
end
$$;

-- ── Watching ─────────────────────────────────────────────────────────────────

do $$
declare
  a jsonb;
  w jsonb;
begin
  update meganet.base_station set watch_until = null where ingest_token_id = pg_temp.ctx('id_one')::bigint;
  w := pg_temp.as_admin_keep(format('select meganet.admin_base_station_watch(%s, true)::text', pg_temp.ctx('id_one')))::jsonb;
  a := pg_temp.checkin(pg_temp.ctx('tok_one'), '{"v": 1, "mode": "manage"}');
  perform pg_temp.check_that('an administrator opening a station: five seconds, and the whole status asked for',
    (a ->> 'watch')::boolean and (a ->> 'next_s')::int = 5 and (a ->> 'want_status')::boolean
      and (w ->> 'watch_until')::timestamptz > now() + interval '2 minutes', a::text || ' ' || w::text);
  a := pg_temp.checkin(pg_temp.ctx('tok_one'), '{"v": 1, "mode": "manage", "status": {"name": "Bench, again"}}');
  perform pg_temp.check_that('…the status arrives, and is no longer asked for',
    not (a ->> 'want_status')::boolean
      and (select status ->> 'name' from meganet.base_station where ingest_token_id = pg_temp.ctx('id_one')::bigint) = 'Bench, again', a::text);
  update meganet.base_station set watch_until = now() - interval '1 second' where ingest_token_id = pg_temp.ctx('id_one')::bigint;
  perform pg_temp.check_that('…and when the panel has been shut three minutes, back to its own pace',
    (pg_temp.checkin(pg_temp.ctx('tok_one'), '{"v": 1, "mode": "manage", "idle_s": 60}') ->> 'next_s')::int = 60);
  perform pg_temp.check_that('watching one that never checked in is refused (22023)',
    pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'),
      format('select meganet.admin_base_station_watch(%s)::text', pg_temp.ctx('id_never'))) = 'ERROR 22023');

  insert into meganet.base_station_command (ingest_token_id, verb, created_by, created_at, expires_at, status)
  values (pg_temp.ctx('id_one')::bigint, 'status', 'old', now() - interval '91 days', now() - interval '91 days', 'done');
  perform pg_temp.checkin(pg_temp.ctx('tok_one'), '{"v": 1, "mode": "manage"}');
  perform pg_temp.check_that('a station''s requests a quarter of a year old are swept away at its next check-in',
    not exists (select 1 from meganet.base_station_command where ingest_token_id = pg_temp.ctx('id_one')::bigint and created_by = 'old'));
end
$$;

-- ── Team SSH keys (decision 4) ───────────────────────────────────────────────

do $$
declare
  add text := 'select meganet.admin_base_station_key_add(%L, %L)::text';
  h0 text := meganet.base_station_keys_hash();
  r jsonb;
  served jsonb;
begin
  perform pg_temp.check_that('an editor cannot add a team key (42501)',
    pg_temp.as_role('authenticated', (select claims from _who where k = 'editor'), format(add, pg_temp.ctx('key_ed'), 'Jo')) = 'ERROR 42501');
  r := pg_temp.as_admin_keep(format(add, pg_temp.ctx('key_ed'), '  Jo Bloggs  '))::jsonb;
  insert into _ctx values ('key1', r ->> 'id');
  perform pg_temp.check_that('an administrator adds a public key: its fingerprint the one ssh-keygen prints, its owner kept',
    r ->> 'fingerprint' = pg_temp.ctx('fp_ed') and r ->> 'owner' = 'Jo Bloggs' and r ->> 'key_type' = 'ssh-ed25519'
      and (select comment from meganet.base_station_key where id = (r ->> 'id')::bigint) = 'vec-ed25519@test', r::text);
  perform pg_temp.check_that('ECDSA too, fingerprinted the same way',
    pg_temp.as_admin_keep(format(add, pg_temp.ctx('key_ec'), 'Sam'))::jsonb ->> 'fingerprint' = pg_temp.ctx('fp_ec'));
  perform pg_temp.check_that('a weak RSA key, a key that is not one, a key twice, or no owner: refused, saying why',
    pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'), format(add, pg_temp.ctx('key_weak'), 'Weak')) = 'ERROR 22023'
      and pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'), format(add, 'hello there', 'Nobody')) = 'ERROR 22023'
      and pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'), format(add, 'from="10.0.0.0/8" ' || pg_temp.ctx('key_ed'), 'Jo')) = 'ERROR 22023'
      and pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'), format(add, pg_temp.ctx('key_ed'), 'Jo again')) = 'ERROR 23505'
      and pg_temp.as_role('authenticated', (select claims from _who where k = 'admin'), format(add, pg_temp.ctx('key_ec'), '   ')) = 'ERROR 22023');

  served := pg_temp.as_device(pg_temp.ctx('tok_one'), $q$select meganet.base_station_keys('{}')::text$q$)::jsonb;
  perform pg_temp.check_that('a base station fetches them with its token: the keys, whose they are, and the list''s hash',
    jsonb_array_length(served -> 'keys') = 2 and served -> 'keys' -> 0 ->> 'key' = split_part(pg_temp.ctx('key_ed'), ' ', 1) || ' ' || split_part(pg_temp.ctx('key_ed'), ' ', 2)
      and served -> 'keys' -> 0 ->> 'comment' = 'Jo Bloggs' and served ->> 'hash' <> h0
      and served ->> 'hash' = (pg_temp.checkin(pg_temp.ctx('tok_one'), '{"v": 1, "mode": "manage"}') ->> 'keys_hash'), served::text);
  perform pg_temp.check_that('…and nobody without a live token does (PT401)',
    pg_temp.as_device(null, $q$select meganet.base_station_keys('{}')::text$q$) = 'ERROR PT401'
      and pg_temp.as_device(pg_temp.ctx('tok_gone'), $q$select meganet.base_station_keys('{}')::text$q$) = 'ERROR PT401');

  r := pg_temp.as_admin_keep(format('select meganet.admin_base_station_key_remove(%s)::text', pg_temp.ctx('key1')))::jsonb;
  served := pg_temp.as_device(pg_temp.ctx('tok_one'), $q$select meganet.base_station_keys('{}')::text$q$)::jsonb;
  perform pg_temp.check_that('a key taken off the list is no longer served, and the hash says the list changed',
    jsonb_array_length(served -> 'keys') = 1 and served -> 'keys' -> 0 ->> 'fingerprint' = pg_temp.ctx('fp_ec')
      and r ->> 'hash' = served ->> 'hash' and r ->> 'removed_at' is not null, served::text);
  perform pg_temp.check_that('…and stays on the record, with who took it off',
    exists (select 1 from jsonb_array_elements(pg_temp.as_admin_keep('select meganet.admin_base_station_keys()::text')::jsonb -> 'keys') k
             where k ->> 'fingerprint' = pg_temp.ctx('fp_ed') and k ->> 'removed_by' = 'bs-admin@example.test'));
  perform pg_temp.check_that('…and the same key can be added again later',
    pg_temp.as_admin_keep(format(add, pg_temp.ctx('key_ed'), 'Jo Bloggs'))::jsonb ->> 'fingerprint' = pg_temp.ctx('fp_ed'));
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
