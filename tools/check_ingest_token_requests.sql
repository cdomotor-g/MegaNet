-- check_ingest_token_requests.sql — Prove 0048: a base station asks for its
-- ingest token, and an administrator approves it from the Admin tab.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_ingest_token_requests.sql
--
-- One row per claim, a non-zero exit if any fails, and the whole script in a
-- transaction that rolls back — the people it signs up, the requests and the
-- tokens included — so it is safe against the live database. The devices are
-- anon holding a token in X-Ingest-Token, as PostgREST would hand it over; the
-- people are made through 0005's triggers, as check_ingest_token_admin.sql
-- makes them. Run after the stations are loaded: one check files a request
-- under a real station.

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

-- A token a device would make for itself: mgn_ and 64 lower-case hex.
create or replace function pg_temp.tok(p_n integer)
returns text language sql immutable as $$
  select 'mgn_' || encode(sha256(convert_to('check0048-' || p_n, 'utf8')), 'hex');
$$;
create or replace function pg_temp.hash(p_token text)
returns text language sql immutable as $$
  select encode(sha256(convert_to(p_token, 'utf8')), 'hex');
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

-- A device: anon, with p_token in X-Ingest-Token (none when null). Rolled back.
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

-- The same, kept: for the steps whose writes the next checks read.
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

create or replace function pg_temp.as_admin_keep(p_sql text)
returns text language plpgsql as $$
declare
  v text;
begin
  perform pg_catalog.set_config('request.jwt.claims',
    '{"role":"authenticated","email":"req-admin@example.test","sub":"00000000-0000-4000-8000-0000000dc602"}', true);
  execute 'set local role authenticated';
  execute p_sql into v;
  execute 'reset role';
  perform pg_catalog.set_config('request.jwt.claims', '', true);
  return v;
end;
$$;

insert into meganet.editor_allow (entry, note) values
  ('req-editor@example.test', 'check_ingest_token_requests — rolled back'),
  ('req-admin@example.test',  'check_ingest_token_requests — rolled back')
on conflict (entry) do nothing;
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000dc601', 'req-editor@example.test'),
  ('00000000-0000-4000-8000-0000000dc602', 'req-admin@example.test')
on conflict (id) do nothing;
update meganet.app_user set role = 'admin' where id = '00000000-0000-4000-8000-0000000dc602';

create temporary table _who (k text primary key, claims text) on commit drop;
insert into _who values
  ('anon',   '{"role":"anon"}'),
  ('editor', '{"role":"authenticated","email":"req-editor@example.test","sub":"00000000-0000-4000-8000-0000000dc601"}'),
  ('admin',  '{"role":"authenticated","email":"req-admin@example.test","sub":"00000000-0000-4000-8000-0000000dc602"}');
grant select on _who to anon, authenticated;

-- What later blocks need from earlier ones.
create temporary table _ctx (k text primary key, v text) on commit drop;
grant select on _ctx to anon, authenticated;
insert into _ctx values ('station', (select id from meganet.station order by id limit 1));

-- ── Shape and access ─────────────────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('the table has RLS on, no policy, and no grant to a role a browser holds',
    (select relrowsecurity from pg_class where oid = 'meganet.ingest_token_request'::regclass)
      and not exists (select 1 from pg_policies where schemaname = 'meganet' and tablename = 'ingest_token_request')
      and not has_table_privilege('anon', 'meganet.ingest_token_request', 'select')
      and not has_table_privilege('authenticated', 'meganet.ingest_token_request', 'select'));
  perform pg_temp.check_that('anon may ask and may ask how it is going, and may not list, approve or deny',
    has_function_privilege('anon', 'meganet.request_ingest_token(jsonb)', 'execute')
      and has_function_privilege('anon', 'meganet.ingest_token_request_status(jsonb)', 'execute')
      and has_function_privilege('anon', 'meganet.withdraw_ingest_token_request(jsonb)', 'execute')
      and not has_function_privilege('anon', 'meganet.admin_ingest_token_requests()', 'execute')
      and not has_function_privilege('anon', 'meganet.admin_approve_ingest_token_request(bigint, text, text, bigint)', 'execute')
      and not has_function_privilege('anon', 'meganet.admin_deny_ingest_token_request(bigint)', 'execute'));
  perform pg_temp.check_that('the helpers are granted to nothing a browser holds — the state reader takes a hash',
    not has_function_privilege('anon', 'meganet.ingest_token_request_state(text)', 'execute')
      and not has_function_privilege('authenticated', 'meganet.ingest_token_request_state(text)', 'execute')
      and not has_function_privilege('anon', 'meganet.ingest_token_request_code()', 'execute')
      and not has_function_privilege('anon', 'meganet.ingest_token_request_hash()', 'execute'));
end
$$;

-- ── A device asks ────────────────────────────────────────────────────────────

create temporary table _r1 on commit drop as
  select pg_temp.as_device_keep(pg_temp.tok(1), format(
    $q$select meganet.request_ingest_token('{"label":"  _check Bench Pi  ","host_station_id":%s,"detail":{"app":"check","host":"bench"}}')::text$q$,
    to_json((select v from _ctx where k = 'station'))::text))::jsonb as j;
grant select on _r1 to anon, authenticated;

do $$
declare
  j jsonb := (select j from _r1);
  v_again jsonb;
begin
  insert into _ctx values ('r1', j ->> 'id');
  perform pg_temp.check_that('a device asks and is told: pending, a code of eight consonants, half an hour',
    j ->> 'status' = 'pending' and j ->> 'code' ~ '^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$'
      and (j ->> 'expires_in')::int between 1790 and 1800 and j ->> 'label' = '_check Bench Pi', j::text);
  perform pg_temp.check_that('only the hash of its token is kept',
    exists (select 1 from meganet.ingest_token_request r where r.id = (j ->> 'id')::bigint and r.token_hash = pg_temp.hash(pg_temp.tok(1)))
      and (select r::text from meganet.ingest_token_request r where r.id = (j ->> 'id')::bigint) not like '%' || pg_temp.tok(1) || '%');
  perform pg_temp.check_that('the station it says it sits at is kept, when MegaNet knows it',
    (select host_station_id from meganet.ingest_token_request where id = (j ->> 'id')::bigint)
      is not distinct from (select v from _ctx where k = 'station'));

  v_again := pg_temp.as_device(pg_temp.tok(1), $q$select meganet.request_ingest_token('{"label":"_check Bench Pi"}')::text$q$)::jsonb;
  perform pg_temp.check_that('asking again with the same token is the same request, with the same code',
    v_again ->> 'id' = j ->> 'id' and v_again ->> 'code' = j ->> 'code'
      and (select count(*) from meganet.ingest_token_request where token_hash = pg_temp.hash(pg_temp.tok(1))) = 1, v_again::text);
  perform pg_temp.check_that('a device asking how it is going is told pending, with its code',
    (pg_temp.as_device(pg_temp.tok(1), 'select meganet.ingest_token_request_status()::text')::jsonb ->> 'code') = j ->> 'code'
      and (pg_temp.as_device(pg_temp.tok(1), $q$select meganet.ingest_token_request_status('{}')::text$q$)::jsonb ->> 'status') = 'pending');
end
$$;

do $$
declare
  v_r2 jsonb := pg_temp.as_device_keep(pg_temp.tok(2),
    $q$select meganet.request_ingest_token('{"label":"_check other","host_station_id":"_no_such_station_"}')::text$q$)::jsonb;
begin
  perform pg_temp.check_that('a station MegaNet does not know is dropped from the request, not refused',
    v_r2 ->> 'status' = 'pending'
      and (select host_station_id is null from meganet.ingest_token_request where id = (v_r2 ->> 'id')::bigint), v_r2::text);
  perform pg_temp.check_that('a token of the wrong shape, or none, is refused (22023)',
    pg_temp.as_device('mgn_short', $q$select meganet.request_ingest_token('{"label":"x"}')::text$q$) = 'ERROR 22023'
      and pg_temp.as_device(upper(pg_temp.tok(3)), $q$select meganet.request_ingest_token('{"label":"x"}')::text$q$) = 'ERROR 22023'
      and pg_temp.as_device(null, $q$select meganet.request_ingest_token('{"label":"x"}')::text$q$) = 'ERROR 22023');
  perform pg_temp.check_that('a request needs a one-line label and at most 4 KB of description (22023)',
    pg_temp.as_device(pg_temp.tok(3), $q$select meganet.request_ingest_token('{"label":"   "}')::text$q$) = 'ERROR 22023'
      and pg_temp.as_device(pg_temp.tok(3), $q$select meganet.request_ingest_token('{"label":"two\nlines"}')::text$q$) = 'ERROR 22023'
      and pg_temp.as_device(pg_temp.tok(3), $q$select meganet.request_ingest_token('{"label":"x","detail":[1]}')::text$q$) = 'ERROR 22023'
      and pg_temp.as_device(pg_temp.tok(3), format($q$select meganet.request_ingest_token('{"label":"x","detail":{"pad":"%s"}}')::text$q$, repeat('a', 5000))) = 'ERROR 22023'
      and pg_temp.as_device(pg_temp.tok(3), $q$select meganet.request_ingest_token('[]')::text$q$) = 'ERROR 22023');
  perform pg_temp.check_that('a token nobody asked with is unknown; no token at all is PT401',
    (pg_temp.as_device(pg_temp.tok(99), 'select meganet.ingest_token_request_status()::text')::jsonb ->> 'status') = 'unknown'
      and pg_temp.as_device(null, 'select meganet.ingest_token_request_status()::text') = 'ERROR PT401'
      and pg_temp.as_device(null, 'select meganet.withdraw_ingest_token_request()::text') = 'ERROR PT401');
end
$$;

-- ── Who may decide ───────────────────────────────────────────────────────────

do $$
declare
  c_anon   text := (select claims from _who where k = 'anon');
  c_editor text := (select claims from _who where k = 'editor');
  c_admin  text := (select claims from _who where k = 'admin');
  v_id     text := (select v from _ctx where k = 'r1');
  v_list   jsonb;
begin
  perform pg_temp.check_that('anon, and an editor who is not an administrator, may not list, approve or deny',
    pg_temp.as_role('anon', c_anon, 'select meganet.admin_ingest_token_requests()::text') like 'ERROR %'
      and pg_temp.as_role('anon', c_anon, format('select meganet.admin_approve_ingest_token_request(%s)::text', v_id)) like 'ERROR %'
      and pg_temp.as_role('authenticated', c_editor, 'select meganet.admin_ingest_token_requests()::text') like 'ERROR %'
      and pg_temp.as_role('authenticated', c_editor, format('select meganet.admin_approve_ingest_token_request(%s)::text', v_id)) like 'ERROR %'
      and pg_temp.as_role('authenticated', c_editor, format('select meganet.admin_deny_ingest_token_request(%s)::text', v_id)) like 'ERROR %');

  v_list := pg_temp.as_role('authenticated', c_admin, 'select meganet.admin_ingest_token_requests()::text')::jsonb;
  perform pg_temp.check_that('an administrator sees the waiting request, with its code and the device''s description, and never its hash',
    exists (select 1 from jsonb_array_elements(v_list) e
             where e ->> 'id' = v_id and e ->> 'status' = 'pending' and e ->> 'label' = '_check Bench Pi'
               and e -> 'detail' ->> 'host' = 'bench' and e ->> 'code' ~ '^[A-Z]{4}-[A-Z]{4}$')
      and v_list::text not like '%token_hash%'
      and v_list::text not like '%' || pg_temp.hash(pg_temp.tok(1)) || '%'
      and v_list::text not like '%' || pg_temp.tok(1) || '%');
end
$$;

-- ── Approved ─────────────────────────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('until it is approved, the device''s token opens no door (PT401)',
    pg_temp.as_device(pg_temp.tok(1), $q$select meganet.report_ingest_point('{"point_id":"rpi-check-qs1","receiver":"quansheng","name":"Check radio"}')::text$q$) = 'ERROR PT401');
end
$$;

create temporary table _a1 on commit drop as
  select pg_temp.as_admin_keep(format($q$select meganet.admin_approve_ingest_token_request(%s, ' _check Bench Pi (renamed) ')::text$q$,
                                      (select v from _ctx where k = 'r1')))::jsonb as j;
grant select on _a1 to anon, authenticated;

do $$
declare
  j       jsonb := (select j from _a1);
  c_admin text  := (select claims from _who where k = 'admin');
  v_state jsonb;
  v_door  text;
begin
  insert into _ctx values ('t1', j ->> 'id');
  perform pg_temp.check_that('approved under another label: the token is the device''s own hash, made by the administrator, at the station it named',
    exists (select 1 from meganet.ingest_token t
             where t.id = (j ->> 'id')::bigint and t.token_hash = pg_temp.hash(pg_temp.tok(1))
               and t.label = '_check Bench Pi (renamed)' and t.created_by ilike '%req-admin@example.test%'
               and t.revoked_at is null
               and t.host_station_id is not distinct from (select v from _ctx where k = 'station')), j::text);
  perform pg_temp.check_that('the request records the decision: approved, by whom, when, and which token',
    exists (select 1 from meganet.ingest_token_request r
             where r.id = (j ->> 'request_id')::bigint and r.status = 'approved' and r.decided_by ilike '%req-admin@example.test%'
               and r.decided_at is not null and r.ingest_token_id = (j ->> 'id')::bigint));

  v_state := pg_temp.as_device(pg_temp.tok(1), 'select meganet.ingest_token_request_status()::text')::jsonb;
  perform pg_temp.check_that('the device is told approved, under the label MegaNet knows it by — and not who approved it',
    v_state ->> 'status' = 'approved' and v_state ->> 'label' = '_check Bench Pi (renamed)'
      and v_state::text not like '%req-admin%', v_state::text);

  v_door := pg_temp.as_device(pg_temp.tok(1), $q$select meganet.report_ingest_point('{"point_id":"rpi-check-qs1","receiver":"quansheng","name":"Check radio"}')::text$q$);
  perform pg_temp.check_that('and its token opens the door at once, with nothing to collect',
    v_door not like 'ERROR %' and (v_door::jsonb ->> 'label') = '_check Bench Pi (renamed)', v_door);

  perform pg_temp.check_that('approving it twice is refused (22023)',
    pg_temp.as_role('authenticated', c_admin, format('select meganet.admin_approve_ingest_token_request(%s)::text', j ->> 'request_id')) = 'ERROR 22023');
  perform pg_temp.check_that('asking again with an approved token says approved and asks nothing',
    (pg_temp.as_device(pg_temp.tok(1), $q$select meganet.request_ingest_token('{"label":"_check Bench Pi"}')::text$q$)::jsonb ->> 'status') = 'approved'
      and (select count(*) from meganet.ingest_token_request where token_hash = pg_temp.hash(pg_temp.tok(1))) = 1);
  perform pg_temp.check_that('the Admin tab''s token list (0046) shows it like any other',
    exists (select 1 from jsonb_array_elements(pg_temp.as_role('authenticated', c_admin, 'select meganet.admin_ingest_tokens()::text')::jsonb) e
             where e ->> 'label' = '_check Bench Pi (renamed)' and e ->> 'revoked_at' is null));
end
$$;

-- ── The same name again: refused as it is, accepted as a replacement ─────────

create temporary table _r3 on commit drop as
  select pg_temp.as_device_keep(pg_temp.tok(3), $q$select meganet.request_ingest_token('{"label":"_check Bench Pi (renamed)"}')::text$q$)::jsonb as j;
grant select on _r3 to anon, authenticated;

do $$
declare
  c_admin text := (select claims from _who where k = 'admin');
  v_id    text := (select j ->> 'id' from _r3);
begin
  perform pg_temp.check_that('a request under a live token''s label cannot be approved as it is (23505)',
    pg_temp.as_role('authenticated', c_admin, format('select meganet.admin_approve_ingest_token_request(%s)::text', v_id)) = 'ERROR 23505');
  perform pg_temp.check_that('replacing a token that is not live is refused (22023)',
    pg_temp.as_role('authenticated', c_admin, format('select meganet.admin_approve_ingest_token_request(%s, null, null, -1)::text', v_id)) = 'ERROR 22023');
  perform pg_temp.check_that('a host station MegaNet does not know is refused at approval (22023)',
    pg_temp.as_role('authenticated', c_admin, format($q$select meganet.admin_approve_ingest_token_request(%s, '_check other name', '_no_such_station_')::text$q$, v_id)) = 'ERROR 22023');
end
$$;

create temporary table _a3 on commit drop as
  select pg_temp.as_admin_keep(format($q$select meganet.admin_approve_ingest_token_request(%s, null, '', %s)::text$q$,
                                      (select j ->> 'id' from _r3), (select v from _ctx where k = 't1')))::jsonb as j;
grant select on _a3 to anon, authenticated;

do $$
declare
  j jsonb := (select j from _a3);
begin
  perform pg_temp.check_that('…and approving it as that token''s replacement revokes the old one and makes the new one, in one step',
    (j ->> 'replaced_token_id') = (select v from _ctx where k = 't1')
      and (select revoked_at is not null from meganet.ingest_token where id = (select v from _ctx where k = 't1')::bigint)
      and exists (select 1 from meganet.ingest_token t where t.id = (j ->> 'id')::bigint and t.revoked_at is null
                    and t.label = '_check Bench Pi (renamed)' and t.host_station_id is null
                    and t.token_hash = pg_temp.hash(pg_temp.tok(3))), j::text);
  perform pg_temp.check_that('the replaced token is refused at the door at once (PT401), and its device is told revoked',
    pg_temp.as_device(pg_temp.tok(1), $q$select meganet.report_ingest_point('{"point_id":"rpi-check-qs1","receiver":"quansheng","name":"Check radio"}')::text$q$) = 'ERROR PT401'
      and (pg_temp.as_device(pg_temp.tok(1), 'select meganet.ingest_token_request_status()::text')::jsonb ->> 'status') = 'revoked');
end
$$;

-- ── Denied, withdrawn, expired ───────────────────────────────────────────────

create temporary table _later on commit drop as
  select n, pg_temp.as_device_keep(pg_temp.tok(n), format($q$select meganet.request_ingest_token('{"label":"_check device %s"}')::text$q$, n))::jsonb as j
    from generate_series(4, 6) n;
grant select on _later to anon, authenticated;

do $$
declare
  c_admin text := (select claims from _who where k = 'admin');
  v4 text := (select j ->> 'id' from _later where n = 4);
begin
  perform pg_temp.as_admin_keep(format('select meganet.admin_deny_ingest_token_request(%s)::text', v4));
  perform pg_temp.check_that('a denied request''s device is told denied, and its token opens nothing (PT401)',
    (pg_temp.as_device(pg_temp.tok(4), 'select meganet.ingest_token_request_status()::text')::jsonb ->> 'status') = 'denied'
      and pg_temp.as_device(pg_temp.tok(4), $q$select meganet.report_ingest_point('{"point_id":"rpi-check-qs4","receiver":"quansheng","name":"x"}')::text$q$) = 'ERROR PT401'
      and exists (select 1 from meganet.ingest_token_request where id = v4::bigint and decided_by ilike '%req-admin@example.test%'));
  perform pg_temp.check_that('a denied request cannot then be approved, and denying it again changes nothing',
    pg_temp.as_role('authenticated', c_admin, format('select meganet.admin_approve_ingest_token_request(%s)::text', v4)) = 'ERROR 22023'
      and (pg_temp.as_role('authenticated', c_admin, format('select meganet.admin_deny_ingest_token_request(%s)::text', v4))::jsonb ->> 'status') = 'denied');
  perform pg_temp.check_that('an approved request cannot be denied — its token is revoked instead (22023)',
    pg_temp.as_role('authenticated', c_admin, format('select meganet.admin_deny_ingest_token_request(%s)::text', (select j ->> 'request_id' from _a1))) = 'ERROR 22023');
  perform pg_temp.check_that('deciding a request that does not exist is 22023',
    pg_temp.as_role('authenticated', c_admin, 'select meganet.admin_deny_ingest_token_request(-1)::text') = 'ERROR 22023'
      and pg_temp.as_role('authenticated', c_admin, 'select meganet.admin_approve_ingest_token_request(-1)::text') = 'ERROR 22023');
end
$$;

do $$
declare
  c_admin text := (select claims from _who where k = 'admin');
  v5 text := (select j ->> 'id' from _later where n = 5);
  v6 text := (select j ->> 'id' from _later where n = 6);
  v_w jsonb;
begin
  v_w := pg_temp.as_device_keep(pg_temp.tok(5), 'select meganet.withdraw_ingest_token_request()::text')::jsonb;
  perform pg_temp.check_that('a device that stops waiting withdraws its request, and it cannot then be approved',
    v_w ->> 'status' = 'withdrawn'
      and pg_temp.as_role('authenticated', c_admin, format('select meganet.admin_approve_ingest_token_request(%s)::text', v5)) = 'ERROR 22023'
      and exists (select 1 from jsonb_array_elements(pg_temp.as_role('authenticated', c_admin, 'select meganet.admin_ingest_token_requests()::text')::jsonb) e
                   where e ->> 'id' = v5 and e ->> 'status' = 'withdrawn'), v_w::text);
  perform pg_temp.check_that('withdrawing an approved request leaves it approved',
    (pg_temp.as_device(pg_temp.tok(3), 'select meganet.withdraw_ingest_token_request()::text')::jsonb ->> 'status') = 'approved');

  update meganet.ingest_token_request set requested_at = now() - interval '40 minutes', expires_at = now() - interval '10 minutes' where id = v6::bigint;
  perform pg_temp.check_that('an expired request reads expired to the device and to the administrator, and cannot be approved',
    (pg_temp.as_device(pg_temp.tok(6), 'select meganet.ingest_token_request_status()::text')::jsonb ->> 'status') = 'expired'
      and exists (select 1 from jsonb_array_elements(pg_temp.as_role('authenticated', c_admin, 'select meganet.admin_ingest_token_requests()::text')::jsonb) e
                   where e ->> 'id' = v6 and e ->> 'status' = 'expired')
      and pg_temp.as_role('authenticated', c_admin, format('select meganet.admin_approve_ingest_token_request(%s)::text', v6)) = 'ERROR 22023');
  perform pg_temp.check_that('a token that has asked before cannot ask again — denied, withdrawn or expired (23505)',
    pg_temp.as_device(pg_temp.tok(4), $q$select meganet.request_ingest_token('{"label":"again"}')::text$q$) = 'ERROR 23505'
      and pg_temp.as_device(pg_temp.tok(5), $q$select meganet.request_ingest_token('{"label":"again"}')::text$q$) = 'ERROR 23505'
      and pg_temp.as_device(pg_temp.tok(6), $q$select meganet.request_ingest_token('{"label":"again"}')::text$q$) = 'ERROR 23505');

  -- A day past its expiry, a request is swept by the next one to arrive.
  update meganet.ingest_token_request set requested_at = now() - interval '2 days', expires_at = now() - interval '2 days' where id = v6::bigint;
  perform pg_temp.as_device_keep(pg_temp.tok(7), $q$select meganet.request_ingest_token('{"label":"_check device 7"}')::text$q$);
  perform pg_temp.check_that('a request a day past its expiry is swept away by the next request',
    not exists (select 1 from meganet.ingest_token_request where id = v6::bigint));
end
$$;

-- ── Codes, and the waiting list's limit ──────────────────────────────────────

do $$
declare
  v_waiting integer;
  v_last    text;
  n         integer := 100;
begin
  perform pg_temp.check_that('no two waiting requests can show the same code (a unique partial index)',
    exists (select 1 from pg_indexes where schemaname = 'meganet' and indexname = 'ingest_token_request_pending_code_idx'
             and indexdef ilike '%unique%' and indexdef ilike '%where%pending%')
      and (select count(*) = count(distinct code) from meganet.ingest_token_request where status = 'pending'));

  select count(*) into v_waiting from meganet.ingest_token_request where status = 'pending' and expires_at > now();
  while v_waiting < 20 loop
    perform pg_temp.as_device_keep(pg_temp.tok(n), format($q$select meganet.request_ingest_token('{"label":"_check filler %s"}')::text$q$, n));
    n := n + 1;
    v_waiting := v_waiting + 1;
  end loop;
  v_last := pg_temp.as_device(pg_temp.tok(n), $q$select meganet.request_ingest_token('{"label":"_check one too many"}')::text$q$);
  perform pg_temp.check_that('with 20 waiting, the next device is told to try later (PT429) — and a retry of a waiting one is still answered',
    v_last = 'ERROR PT429'
      and (pg_temp.as_device(pg_temp.tok(7), $q$select meganet.request_ingest_token('{"label":"_check device 7"}')::text$q$)::jsonb ->> 'status') = 'pending', v_last);
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
