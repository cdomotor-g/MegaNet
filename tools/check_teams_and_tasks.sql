-- check_teams_and_tasks.sql — Prove teams and tasks (0095) against a real
-- database: that an administrator makes the teams and names their owners, an
-- owner changes who else is on theirs, and a roster is seen by its team and
-- administrators alone; that tasks are handed out only by the people who may
-- (any team for an administrator or a member of a team that hands out tasks,
-- their own team for an owner), seen by the people who hand out tasks, the
-- team it is handed to and whoever made it — through the policy and through
-- the doors alike — and moved on by the team, cancelled and handed elsewhere
-- by whoever manages it; that the same job handed over twice is made once;
-- and that nobody signed out, nor a declined account, sees any of it.
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f tools/check_teams_and_tasks.sql
--
-- One row per claim, a non-zero exit if any fails, and the whole script in a
-- transaction that rolls back, so it is safe against the live database: the
-- hub, the station, the people, the teams and the tasks all go. Run it as a
-- direct psql connection. CI runs it in the db-checks job after every
-- migration has been applied from zero.
--
-- What it deliberately does not check: the Tasks tab, the Admin tab's Teams
-- panel and SoRT's hand-off, which are tasks.js's and admin-teams.js's, held
-- by test/tasks.mjs.

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

-- One statement as another role with a request's claims, rolled back: 'ok',
-- or the SQLSTATE it was refused with (check_alert2_plan.sql's helper).
create or replace function pg_temp.as_role(p_role text, p_claims text, p_sql text)
returns text language plpgsql as $$
declare
  v_state text;
begin
  begin
    execute pg_catalog.format('set local role %I', p_role);
    perform pg_catalog.set_config('request.jwt.claims', p_claims, true);
    execute p_sql;
    raise exception using errcode = 'MNRLB', message = 'ok';
  exception
    when sqlstate 'MNRLB' then return 'ok';
    when others then
      get stacked diagnostics v_state = returned_sqlstate;
      return v_state;
  end;
end;
$$;

-- The same, kept, answering the statement's first column as text — or
-- 'ERROR <sqlstate>' with nothing kept (check_accounts.sql's helper).
create or replace function pg_temp.as_role_keep(p_role text, p_claims text, p_sql text)
returns text language plpgsql as $$
declare
  v text;
begin
  execute pg_catalog.format('set local role %I', p_role);
  perform pg_catalog.set_config('request.jwt.claims', p_claims, true);
  begin
    execute p_sql into v;
  exception when others then
    v := 'ERROR ' || sqlstate;
  end;
  execute 'reset role';
  perform pg_catalog.set_config('request.jwt.claims', '', true);
  return v;
end;
$$;

-- ── Fixtures ─────────────────────────────────────────────────────────────────
-- A hub and a station in the Tasman Sea, and the people: an administrator, a
-- member of the SoRT Forum (which hands out tasks), the owner of team A, a
-- member of team A, a member of team B, an approved account on no team, an
-- account still waiting, a declined one later, and nobody signed in. Sign-up
-- is open so the addresses on no list get accounts.

update meganet.app_meta set value = 'open' where key = 'signup';

insert into meganet.hub (id, ord, name) values ('_check_tt_hub', -967, 'Check Hub') on conflict (id) do nothing;
insert into meganet.hub (id, ord, name) values ('_check_tt_hub2', -968, 'Check Hub Two') on conflict (id) do nothing;

insert into meganet.rm_system (id, ord, name)
values (-967, -967, 'check_teams_and_tasks placeholder')
on conflict (id) do nothing;

insert into meganet.station (id, ord, name, station_number, rm_system_id, lat, lon, roles) values
  ('_check_tt_stn', -967, 'Check Fifteen Mile', '996701', -967, -31.7, 161.2, '{field}'),
  ('_check_tt_gone', -968, 'Check Gone Station', '996702', -967, -31.8, 161.3, '{field}')
on conflict (id) do nothing;
update meganet.station set deleted_at = now() where id = '_check_tt_gone';

insert into meganet.editor_allow (entry, note) values
  ('tt-admin@example.test', 'check_teams_and_tasks — rolled back')
on conflict (entry) do nothing;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000a7001', 'tt-admin@example.test',       now()),
  ('00000000-0000-4000-8000-0000000a7002', 'tt-sort@example.invalid',     now()),
  ('00000000-0000-4000-8000-0000000a7003', 'tt-owner@example.invalid',    now()),
  ('00000000-0000-4000-8000-0000000a7004', 'tt-member@example.invalid',   now()),
  ('00000000-0000-4000-8000-0000000a7005', 'tt-other@example.invalid',    now()),
  ('00000000-0000-4000-8000-0000000a7006', 'tt-outsider@example.invalid', now()),
  ('00000000-0000-4000-8000-0000000a7007', 'tt-waiting@example.invalid',  now())
on conflict (id) do nothing;

update meganet.app_user set role = 'admin', display_name = 'Check Admin'
 where id = '00000000-0000-4000-8000-0000000a7001';
update meganet.app_user set status = 'approved', display_name = 'Check Sort'
 where id = '00000000-0000-4000-8000-0000000a7002';
update meganet.app_user set status = 'approved', display_name = 'Check Owner'
 where id = '00000000-0000-4000-8000-0000000a7003';
update meganet.app_user set status = 'approved', display_name = 'Check Member'
 where id = '00000000-0000-4000-8000-0000000a7004';
update meganet.app_user set status = 'approved', display_name = 'Check Other'
 where id = '00000000-0000-4000-8000-0000000a7005';
update meganet.app_user set status = 'approved', display_name = 'Check Outsider'
 where id = '00000000-0000-4000-8000-0000000a7006';

create temporary table _who (k text primary key, role text, claims text) on commit drop;
insert into _who values
  ('anon',     'anon',          '{"role":"anon"}'),
  ('admin',    'authenticated', '{"role":"authenticated","email":"tt-admin@example.test","sub":"00000000-0000-4000-8000-0000000a7001"}'),
  ('sort',     'authenticated', '{"role":"authenticated","email":"tt-sort@example.invalid","sub":"00000000-0000-4000-8000-0000000a7002"}'),
  ('owner',    'authenticated', '{"role":"authenticated","email":"tt-owner@example.invalid","sub":"00000000-0000-4000-8000-0000000a7003"}'),
  ('member',   'authenticated', '{"role":"authenticated","email":"tt-member@example.invalid","sub":"00000000-0000-4000-8000-0000000a7004"}'),
  ('other',    'authenticated', '{"role":"authenticated","email":"tt-other@example.invalid","sub":"00000000-0000-4000-8000-0000000a7005"}'),
  ('outsider', 'authenticated', '{"role":"authenticated","email":"tt-outsider@example.invalid","sub":"00000000-0000-4000-8000-0000000a7006"}'),
  ('waiting',  'authenticated', '{"role":"authenticated","email":"tt-waiting@example.invalid","sub":"00000000-0000-4000-8000-0000000a7007"}');

create or replace function pg_temp.as_who(p_who text, p_sql text)
returns text language sql as $$
  select pg_temp.as_role(w.role, w.claims, p_sql) from _who w where w.k = p_who;
$$;
create or replace function pg_temp.keep_as(p_who text, p_sql text)
returns text language sql as $$
  select pg_temp.as_role_keep(w.role, w.claims, p_sql) from _who w where w.k = p_who;
$$;
create or replace function pg_temp.json_as(p_who text, p_sql text)
returns jsonb language plpgsql as $$
declare
  v text := pg_temp.keep_as(p_who, p_sql);
begin
  if v is null or v like 'ERROR %' then
    return pg_catalog.jsonb_build_object('error', v);
  end if;
  return v::jsonb;
end;
$$;

-- The ids things get, kept for later blocks.
create temporary table _ids (k text primary key, id uuid) on commit drop;
create or replace function pg_temp.id_of(p_k text) returns uuid language sql as $$
  select i.id from _ids i where i.k = p_k;
$$;
create or replace function pg_temp.team_in(p_read jsonb, p_name text) returns jsonb language sql as $$
  select x from pg_catalog.jsonb_array_elements(p_read -> 'teams') x where x ->> 'name' = p_name;
$$;
-- The ids of the tasks a person sees through task_list(), and through the
-- table's own policy, as sorted text.
create or replace function pg_temp.listed(p_who text) returns text language sql as $$
  select coalesce((select pg_catalog.string_agg(x ->> 'title', ',' order by x ->> 'title')
                     from pg_catalog.jsonb_array_elements(pg_temp.json_as(p_who, 'select meganet.task_list()::text')) x
                    where x ->> 'title' like 'Check %'), '');
$$;
create or replace function pg_temp.selected(p_who text) returns text language sql as $$
  select coalesce(pg_temp.keep_as(p_who,
    'select pg_catalog.string_agg(title, '','' order by title) from meganet.task where title like ''Check %'''), '');
$$;

-- ── 1. The shape ─────────────────────────────────────────────────────────────

do $$
begin
  perform pg_temp.check_that('the four tables have RLS on',
    (select bool_and(c.relrowsecurity) from pg_catalog.pg_class c
      where c.oid in ('meganet.team'::regclass, 'meganet.team_member'::regclass,
                      'meganet.task'::regclass, 'meganet.task_note'::regclass)));
  perform pg_temp.check_that('the roster has no policy: it is read through teams_read() alone',
    not exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'meganet.team_member'::regclass));
  perform pg_temp.check_that('the doors are security definer with an empty search_path',
    (select count(*) = 10 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'meganet'
        and p.proname in ('teams_read', 'team_save', 'team_remove', 'team_member_save', 'team_member_remove',
                          'task_list', 'task_get', 'task_refs', 'task_create', 'task_update')
        and p.prosecdef and p.proconfig @> array['search_path=""']));
  perform pg_temp.check_that('public may execute none of them, nor the internals',
    not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'meganet'
                   and p.proname in ('teams_read', 'team_save', 'team_remove', 'team_member_save', 'team_member_remove',
                                     'task_list', 'task_get', 'task_refs', 'task_create', 'task_update',
                                     'team_roster', 'person_name', 'task_json', 'task_may', 'hands_out_tasks', 'my_teams')
                   and pg_catalog.has_function_privilege('public', p.oid, 'execute')));
  perform pg_temp.check_that('anon may neither read the tables nor call a door',
    not pg_catalog.has_table_privilege('anon', 'meganet.team', 'select')
    and not pg_catalog.has_table_privilege('anon', 'meganet.team_member', 'select')
    and not pg_catalog.has_table_privilege('anon', 'meganet.task', 'select')
    and not pg_catalog.has_table_privilege('anon', 'meganet.task_note', 'select')
    and not pg_catalog.has_function_privilege('anon', 'meganet.task_list(text, boolean)', 'execute')
    and not pg_catalog.has_function_privilege('anon', 'meganet.teams_read()', 'execute')
    and not pg_catalog.has_function_privilege('anon', 'meganet.task_create(jsonb)', 'execute'));
  perform pg_temp.check_that('no browser role writes a table, reads a roster, or asks the internals',
    not pg_catalog.has_table_privilege('authenticated', 'meganet.team', 'insert,update,delete')
    and not pg_catalog.has_table_privilege('authenticated', 'meganet.task', 'insert,update,delete')
    and not pg_catalog.has_table_privilege('authenticated', 'meganet.task_note', 'insert,update,delete')
    and not pg_catalog.has_table_privilege('authenticated', 'meganet.team_member', 'select,insert,update,delete')
    and not pg_catalog.has_function_privilege('authenticated', 'meganet.team_roster(uuid, boolean)', 'execute')
    and not pg_catalog.has_function_privilege('authenticated', 'meganet.person_name(uuid)', 'execute')
    and not pg_catalog.has_function_privilege('authenticated', 'meganet.task_json(meganet.task, boolean, boolean)', 'execute'));
  perform pg_temp.check_that('the starter teams are there: SoRT Forum hands out tasks, the other four do not',
    (select count(*) = 5 from meganet.team t
      where (t.name, t.hands_out) in (('SoRT Forum', true), ('Property Services', false), ('Radio licensing', false),
                                      ('OTE', false), ('ID', false))));
  perform pg_temp.check_that('…and every hub there was is looked after by a team named like it',
    not exists (select 1 from meganet.hub h
                 where h.id not like '\_check%'
                   and not exists (select 1 from meganet.team t where t.hub_id = h.id and t.name = h.name)));
  perform pg_temp.check_that('tasks are in none of the agent API''s readable relations: anon reads no task, ever',
    pg_temp.as_who('anon', 'select count(*) from meganet.task') = '42501');
end
$$;

-- ── 2. Teams, made ───────────────────────────────────────────────────────────

do $$
declare
  v text;
  r jsonb;
  a uuid;
begin
  v := pg_temp.as_who('sort', 'select meganet.team_save(null, ''Check Team A'', null, false)');
  perform pg_temp.check_that('only an administrator makes a team — not even somebody who hands out tasks', v = '42501', v);
  v := pg_temp.as_who('owner', 'select meganet.team_save(null, ''Check Team A'', null, false)');
  perform pg_temp.check_that('…nor an approved account on no team', v = '42501', v);

  r := pg_temp.json_as('admin', 'select meganet.team_save(null, ''Check Team A'', ''_check_tt_hub'', false)::text');
  a := (pg_temp.team_in(r, 'Check Team A') ->> 'id')::uuid;
  insert into _ids values ('a', a);
  perform pg_temp.check_that('an administrator makes a team, linked to a hub, and teams_read() answers it',
    a is not null and pg_temp.team_in(r, 'Check Team A') ->> 'hub_id' = '_check_tt_hub'
    and pg_temp.team_in(r, 'Check Team A') ->> 'hub' = 'Check Hub', r::text);
  r := pg_temp.json_as('admin', 'select meganet.team_save(null, ''Check Team B'', null, false)::text');
  insert into _ids values ('b', (pg_temp.team_in(r, 'Check Team B') ->> 'id')::uuid);
  r := pg_temp.json_as('admin', 'select meganet.team_save(null, ''Check Empty'', null, true)::text');
  insert into _ids values ('empty', (pg_temp.team_in(r, 'Check Empty') ->> 'id')::uuid);

  v := pg_temp.as_who('admin', 'select meganet.team_save(null, ''check team a'', null, false)');
  perform pg_temp.check_that('a second team by the same name, case aside, is refused', v = '23505', v);
  v := pg_temp.as_who('admin', pg_catalog.format('select meganet.team_save(%L, ''Check Team B'', ''_check_tt_hub'', false)',
                                                 pg_temp.id_of('b')));
  perform pg_temp.check_that('a hub already looked after by one team is refused to another', v = '23505', v);
  v := pg_temp.as_who('admin', 'select meganet.team_save(null, ''Check Nowhere'', ''_check_no_hub'', false)');
  perform pg_temp.check_that('a hub that is not one is refused', v = '22023', v);
  v := pg_temp.as_who('admin', 'select meganet.team_save(null, '''', null, false)');
  perform pg_temp.check_that('a team with no name is refused', v = '22023', v);
  v := pg_temp.as_who('admin', 'select meganet.team_save(''00000000-0000-4000-8000-000000000000'', ''Check Ghost'', null, false)');
  perform pg_temp.check_that('changing a team that is not there says so', v = 'P0002', v);

  r := pg_temp.json_as('admin', pg_catalog.format('select meganet.team_save(%L, ''Check Team A'', ''_check_tt_hub2'', false)::text',
                                                 pg_temp.id_of('a')));
  perform pg_temp.check_that('an administrator moves a team to another hub, freeing the first',
    pg_temp.team_in(r, 'Check Team A') ->> 'hub_id' = '_check_tt_hub2', r::text);
  r := pg_temp.json_as('admin', pg_catalog.format('select meganet.team_save(%L, ''Check Team A'', ''_check_tt_hub'', false)::text',
                                                 pg_temp.id_of('a')));
end
$$;

-- ── 3. Who is on a team ──────────────────────────────────────────────────────

do $$
declare
  v text;
  r jsonb;
  t jsonb;
begin
  v := pg_temp.as_who('owner', pg_catalog.format('select meganet.team_member_save(%L, ''tt-member@example.invalid'', null)',
                                                 pg_temp.id_of('a')));
  perform pg_temp.check_that('nobody adds to a team they do not own', v = '42501', v);

  r := pg_temp.json_as('admin', pg_catalog.format('select meganet.team_member_save(%L, ''TT-Owner@Example.invalid'', true)::text',
                                                 pg_temp.id_of('a')));
  t := pg_temp.team_in(r, 'Check Team A');
  perform pg_temp.check_that('an administrator names an owner, by address, case aside',
    t -> 'roster' -> 0 ->> 'email' = 'tt-owner@example.invalid' and (t -> 'roster' -> 0 ->> 'owner')::boolean, t::text);
  perform pg_temp.json_as('admin', pg_catalog.format('select meganet.team_member_save(%L, ''tt-sort@example.invalid'', false)::text',
                                                     (select t2.id from meganet.team t2 where t2.name = 'SoRT Forum')));
  perform pg_temp.json_as('admin', pg_catalog.format('select meganet.team_member_save(%L, ''tt-other@example.invalid'', false)::text',
                                                     pg_temp.id_of('b')));

  r := pg_temp.json_as('owner', pg_catalog.format('select meganet.team_member_save(%L, ''tt-member@example.invalid'', null)::text',
                                                 pg_temp.id_of('a')));
  t := pg_temp.team_in(r, 'Check Team A');
  perform pg_temp.check_that('the owner adds a member by address, and sees the roster with addresses',
    pg_catalog.jsonb_array_length(t -> 'roster') = 2 and t -> 'roster' -> 1 ->> 'email' = 'tt-member@example.invalid'
    and t ->> 'role' = 'owner', t::text);
  v := pg_temp.as_who('owner', pg_catalog.format('select meganet.team_member_save(%L, ''tt-outsider@example.invalid'', true)',
                                                 pg_temp.id_of('a')));
  perform pg_temp.check_that('an owner names no owner', v = '42501', v);
  v := pg_temp.as_who('owner', pg_catalog.format('select meganet.team_member_save(%L, ''tt-member@example.invalid'', true)',
                                                 pg_temp.id_of('a')));
  perform pg_temp.check_that('…nor makes a member one', v = '42501', v);
  v := pg_temp.as_who('owner', pg_catalog.format('select meganet.team_member_save(%L, ''tt-waiting@example.invalid'', null)',
                                                 pg_temp.id_of('a')));
  perform pg_temp.check_that('an account still waiting for approval is refused, in words', v = '22023', v);
  v := pg_temp.as_who('owner', pg_catalog.format('select meganet.team_member_save(%L, ''nobody@example.invalid'', null)',
                                                 pg_temp.id_of('a')));
  perform pg_temp.check_that('an address with no account is refused, in words', v = 'P0002', v);
  v := pg_temp.as_who('owner', pg_catalog.format('select meganet.team_member_save(%L, ''tt-outsider@example.invalid'', null)',
                                                 pg_temp.id_of('b')));
  perform pg_temp.check_that('an owner adds to their own team only', v = '42501', v);
  v := pg_temp.as_who('member', pg_catalog.format('select meganet.team_member_save(%L, ''tt-outsider@example.invalid'', null)',
                                                  pg_temp.id_of('a')));
  perform pg_temp.check_that('a member changes nobody', v = '42501', v);

  -- What each person reads.
  r := pg_temp.json_as('member', 'select meganet.teams_read()::text');
  t := pg_temp.team_in(r, 'Check Team A');
  perform pg_temp.check_that('a member reads their team''s roster, names and no addresses',
    t ->> 'role' = 'member' and pg_catalog.jsonb_array_length(t -> 'roster') = 2
    and t -> 'roster' -> 0 ->> 'who' = 'Check Owner' and (t -> 'roster' -> 0 ->> 'email') is null
    and (t -> 'roster' -> 1 ->> 'you')::boolean, t::text);
  perform pg_temp.check_that('…and every team''s name, but not another team''s roster, nor the hubs',
    pg_temp.team_in(r, 'Check Team B') ->> 'name' = 'Check Team B'
    and pg_catalog.jsonb_typeof(pg_temp.team_in(r, 'Check Team B') -> 'roster') = 'null'
    and pg_catalog.jsonb_typeof(r -> 'hubs') = 'null'
    and pg_catalog.jsonb_typeof(pg_temp.team_in(r, 'Check Team A') -> 'tasks') = 'null', r::text);
  r := pg_temp.json_as('outsider', 'select meganet.teams_read()::text');
  perform pg_temp.check_that('an approved account on no team reads the names and no roster at all',
    not exists (select 1 from pg_catalog.jsonb_array_elements(r -> 'teams') x where pg_catalog.jsonb_typeof(x -> 'roster') <> 'null')
    and pg_temp.team_in(r, 'SoRT Forum') ->> 'hands_out' = 'true', r::text);
  r := pg_temp.json_as('admin', 'select meganet.teams_read()::text');
  perform pg_temp.check_that('an administrator reads every roster, with addresses, and the hubs',
    pg_catalog.jsonb_array_length(pg_temp.team_in(r, 'Check Team B') -> 'roster') = 1
    and pg_temp.team_in(r, 'Check Team B') -> 'roster' -> 0 ->> 'email' = 'tt-other@example.invalid'
    and exists (select 1 from pg_catalog.jsonb_array_elements(r -> 'hubs') h where h ->> 'id' = '_check_tt_hub'), r::text);
  v := pg_temp.as_who('waiting', 'select meganet.teams_read()');
  perform pg_temp.check_that('an account still waiting reads no team', v = '42501', v);
  v := pg_temp.as_who('anon', 'select meganet.teams_read()');
  perform pg_temp.check_that('nor does anybody signed out', v = '42501', v);
  v := pg_temp.keep_as('outsider', 'select count(*) from meganet.team where name like ''Check Team%''');
  perform pg_temp.check_that('an approved account reads the team names through the table too', v = '2', v);
  v := pg_temp.as_who('outsider', 'select count(*) from meganet.team_member');
  perform pg_temp.check_that('…but no roster through it', v = '42501', v);
end
$$;

-- ── 4. whoami ────────────────────────────────────────────────────────────────

do $$
declare
  w jsonb;
begin
  w := pg_temp.json_as('member', 'select meganet.whoami()::text');
  perform pg_temp.check_that('whoami(): a member of a team has the Tasks tab, hands nothing out and owns nothing',
    (w ->> 'tasks')::boolean and not (w ->> 'hands_out')::boolean and not (w ->> 'team_owner')::boolean
    and (w ->> 'teams')::integer = 1, w::text);
  w := pg_temp.json_as('owner', 'select meganet.whoami()::text');
  perform pg_temp.check_that('…an owner owns a team', (w ->> 'tasks')::boolean and (w ->> 'team_owner')::boolean
    and not (w ->> 'hands_out')::boolean, w::text);
  w := pg_temp.json_as('sort', 'select meganet.whoami()::text');
  perform pg_temp.check_that('…a SoRT Forum member hands out tasks', (w ->> 'tasks')::boolean and (w ->> 'hands_out')::boolean, w::text);
  w := pg_temp.json_as('admin', 'select meganet.whoami()::text');
  perform pg_temp.check_that('…an administrator on no team has the tab and hands out tasks',
    (w ->> 'tasks')::boolean and (w ->> 'hands_out')::boolean and (w ->> 'teams')::integer = 0, w::text);
  w := pg_temp.json_as('outsider', 'select meganet.whoami()::text');
  perform pg_temp.check_that('…an approved account on no team has neither',
    not (w ->> 'tasks')::boolean and not (w ->> 'hands_out')::boolean, w::text);
  w := pg_temp.json_as('anon', 'select meganet.whoami()::text');
  perform pg_temp.check_that('…and nobody signed out has either',
    not (w ->> 'tasks')::boolean and not (w ->> 'hands_out')::boolean and (w ->> 'teams')::integer = 0, w::text);
end
$$;

-- ── 5. Tasks, made ───────────────────────────────────────────────────────────

do $$
declare
  v text;
  r jsonb;
  sort_id uuid := (select t.id from meganet.team t where t.name = 'SoRT Forum');
begin
  v := pg_temp.as_who('outsider', pg_catalog.format(
         'select meganet.task_create(%L)', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
           'title', 'Check refused', 'team_id', pg_temp.id_of('a')))));
  perform pg_temp.check_that('an approved account that hands nothing out makes no task', v = '42501', v);
  v := pg_temp.as_who('member', pg_catalog.format(
         'select meganet.task_create(%L)', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
           'title', 'Check refused', 'team_id', pg_temp.id_of('a')))));
  perform pg_temp.check_that('…nor does a member of a team, for their own team', v = '42501', v);

  r := pg_temp.json_as('owner', pg_catalog.format(
         'select meganet.task_create(%L)::text', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
           'title', '  Check A owner job  ', 'details', 'Clear the orifice line', 'station_id', '_check_tt_stn',
           'team_id', pg_temp.id_of('a'), 'due_on', '2026-12-01'))));
  insert into _ids values ('a1', (r -> 'created' -> 0 ->> 'id')::uuid);
  perform pg_temp.check_that('an owner hands a task to their own team, the title trimmed',
    pg_catalog.jsonb_array_length(r -> 'created') = 1
    and (select k.title = 'Check A owner job' and k.due_on = date '2026-12-01' and k.status = 'open'
                and k.source = 'floodnet' and k.station_id = '_check_tt_stn'
           from meganet.task k where k.id = pg_temp.id_of('a1')), r::text);
  v := pg_temp.as_who('owner', pg_catalog.format(
         'select meganet.task_create(%L)', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
           'title', 'Check refused', 'team_id', pg_temp.id_of('b')))));
  perform pg_temp.check_that('…and to no other team', v = '42501', v);
  v := pg_temp.as_who('owner', pg_catalog.format(
         'select meganet.task_create(%L)', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('title', 'Check refused'))));
  perform pg_temp.check_that('…and leaves none unassigned', v = '42501', v);

  r := pg_temp.json_as('sort', pg_catalog.format('select meganet.task_create(%L)::text', pg_catalog.jsonb_build_array(
         pg_catalog.jsonb_build_object('title', 'Check B from SoRT', 'details', 'Transfer the ACMA licence',
           'team_id', pg_temp.id_of('b'), 'source', 'sort', 'source_date', '2026-10-07',
           'source_ref', 'sort:check-session:acmaTransfer', 'station_id', '_check_tt_stn'),
         pg_catalog.jsonb_build_object('title', 'Check unassigned from SoRT', 'source', 'sort', 'source_date', '2026-10-07',
           'source_ref', 'sort:check-session:custom-1'),
         pg_catalog.jsonb_build_object('title', 'Check B from SoRT again', 'team_id', pg_temp.id_of('b'), 'source', 'sort',
           'source_ref', 'sort:check-session:acmaTransfer'))));
  insert into _ids values ('b1', (r -> 'created' -> 0 ->> 'id')::uuid), ('u1', (r -> 'created' -> 1 ->> 'id')::uuid);
  perform pg_temp.check_that('somebody who hands out tasks hands them to any team and to none, in one go',
    pg_catalog.jsonb_array_length(r -> 'created') = 2
    and (select k.source = 'sort' and k.source_date = date '2026-10-07' from meganet.task k where k.id = pg_temp.id_of('b1'))
    and (select k.team_id is null from meganet.task k where k.id = pg_temp.id_of('u1')), r::text);
  perform pg_temp.check_that('…the same reference twice in one go made once, the second answered as made',
    pg_catalog.jsonb_array_length(r -> 'existing') = 1 and r -> 'existing' -> 0 ->> 'ref' = 'sort:check-session:acmaTransfer'
    and (r -> 'existing' -> 0 ->> 'id')::uuid = pg_temp.id_of('b1'), r::text);
  r := pg_temp.json_as('admin', pg_catalog.format('select meganet.task_create(%L)::text', pg_catalog.jsonb_build_array(
         pg_catalog.jsonb_build_object('title', 'Check B from SoRT a third time', 'team_id', pg_temp.id_of('a'), 'source', 'sort',
           'source_ref', 'sort:check-session:acmaTransfer'))));
  perform pg_temp.check_that('…and handed over again later, made no second time — it says when the first was',
    pg_catalog.jsonb_array_length(r -> 'created') = 0 and (r -> 'existing' -> 0 ->> 'visible')::boolean
    and (select count(*) = 1 from meganet.task k where k.source_ref = 'sort:check-session:acmaTransfer'), r::text);
  r := pg_temp.json_as('owner', 'select meganet.task_refs(array[''sort:check-session:acmaTransfer'', ''sort:check-session:nothing''])::text');
  perform pg_temp.check_that('task_refs() names a reference already made, and says the owner of another team may not open it',
    pg_catalog.jsonb_array_length(r) = 1 and not (r -> 0 ->> 'visible')::boolean and (r -> 0 ->> 'id') is null, r::text);
  perform pg_temp.check_that('every task made starts its thread with being made, and the team it went to',
    (select n.kind = 'created' and n.to_value = 'Check Team B' from meganet.task_note n where n.task_id = pg_temp.id_of('b1'))
    and (select n.kind = 'created' and n.to_value is null from meganet.task_note n where n.task_id = pg_temp.id_of('u1')));

  -- Refused in words.
  v := pg_temp.as_who('sort', pg_catalog.format('select meganet.task_create(%L)',
         pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('title', 'Check x', 'colour', 'red'))));
  perform pg_temp.check_that('a key a task does not have is refused', v = '22023', v);
  v := pg_temp.as_who('sort', pg_catalog.format('select meganet.task_create(%L)',
         pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('title', 'Check x', 'station_id', '_check_no_station'))));
  perform pg_temp.check_that('a station the register does not have is refused', v = '22023', v);
  v := pg_temp.as_who('sort', pg_catalog.format('select meganet.task_create(%L)',
         pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('title', 'Check x', 'station_id', '_check_tt_gone'))));
  perform pg_temp.check_that('…and so is a deleted one', v = '22023', v);
  v := pg_temp.as_who('sort', pg_catalog.format('select meganet.task_create(%L)',
         pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('title', pg_catalog.repeat('x', 201)))));
  perform pg_temp.check_that('a title over 200 characters is refused', v = '22023', v);
  v := pg_temp.as_who('sort', pg_catalog.format('select meganet.task_create(%L)',
         pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('title', 'Check x', 'due_on', '2026-02-30'))));
  perform pg_temp.check_that('a due date that is not a date is refused', v = '22023', v);
  v := pg_temp.as_who('sort', pg_catalog.format('select meganet.task_create(%L)',
         pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('title', 'Check x', 'source', 'sort'))));
  perform pg_temp.check_that('a task from SoRT without its reference is refused', v = '22023', v);
  v := pg_temp.as_who('sort', pg_catalog.format('select meganet.task_create(%L)',
         (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('title', 'Check many ' || g)) from pg_catalog.generate_series(1, 51) g)));
  perform pg_temp.check_that('more than 50 at once is refused', v = '22023', v);
  v := pg_temp.as_who('sort', pg_catalog.format('select meganet.task_create(%L)', pg_catalog.jsonb_build_array(
         pg_catalog.jsonb_build_object('title', 'Check fine'),
         pg_catalog.jsonb_build_object('title', 'Check x', 'team_id', 'not-a-uuid'))));
  perform pg_temp.check_that('one bad task refuses the lot', v = '22023'
    and not exists (select 1 from meganet.task k where k.title = 'Check fine'), v);
  perform pg_temp.json_as('sort', pg_catalog.format('select meganet.task_create(%L)::text',
         pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('title', 'Check A from SoRT', 'team_id', pg_temp.id_of('a')))));
end
$$;

-- ── 6. Who sees a task ───────────────────────────────────────────────────────

do $$
declare
  v text;
begin
  perform pg_temp.check_that('a member sees their team''s tasks and no other''s — through the door and the table alike',
    pg_temp.listed('member') = 'Check A from SoRT,Check A owner job' and pg_temp.selected('member') = pg_temp.listed('member'),
    pg_temp.listed('member') || ' | ' || pg_temp.selected('member'));
  perform pg_temp.check_that('…the other team its own',
    pg_temp.listed('other') = 'Check B from SoRT' and pg_temp.selected('other') = pg_temp.listed('other'),
    pg_temp.listed('other') || ' | ' || pg_temp.selected('other'));
  perform pg_temp.check_that('…somebody who hands out tasks every one, the unassigned included',
    pg_temp.listed('sort') = 'Check A from SoRT,Check A owner job,Check B from SoRT,Check unassigned from SoRT'
    and pg_temp.selected('sort') = pg_temp.listed('sort'), pg_temp.listed('sort'));
  perform pg_temp.check_that('…an administrator every one too',
    pg_temp.listed('admin') = pg_temp.listed('sort') and pg_temp.selected('admin') = pg_temp.listed('sort'), pg_temp.listed('admin'));
  perform pg_temp.check_that('…an approved account on no team none',
    pg_temp.listed('outsider') = '' and pg_temp.selected('outsider') = '', pg_temp.listed('outsider'));
  v := pg_temp.as_who('waiting', 'select meganet.task_list()');
  perform pg_temp.check_that('…an account still waiting is refused the list', v = '42501', v);
  v := pg_temp.keep_as('waiting', 'select count(*) from meganet.task');
  perform pg_temp.check_that('…and reads no row of the table', v = '0', v);
  v := pg_temp.keep_as('member', 'select pg_catalog.jsonb_array_length(meganet.task_list(''_check_tt_stn'', true))');
  perform pg_temp.check_that('a station''s open tasks, as its card asks for them, are the ones its viewer may see', v = '1', v);
  v := pg_temp.keep_as('other', pg_catalog.format('select count(*) from meganet.task_note where task_id = %L', pg_temp.id_of('a1')));
  perform pg_temp.check_that('another team''s task''s thread is not read through the table', v = '0', v);
  v := pg_temp.as_who('other', pg_catalog.format('select meganet.task_get(%L)', pg_temp.id_of('a1')));
  perform pg_temp.check_that('…nor opened through the door, which does not say it is there', v = 'P0002', v);
end
$$;

-- ── 7. Moving a task on ──────────────────────────────────────────────────────

do $$
declare
  v text;
  r jsonb;
  a1 uuid := pg_temp.id_of('a1');
begin
  r := pg_temp.json_as('member', pg_catalog.format('select meganet.task_update(%L, %L)::text', a1,
         '{"status": "in_progress", "note": "On it this week"}'));
  perform pg_temp.check_that('its team moves it on, the note going with the change into the thread',
    r ->> 'status' = 'in_progress' and r -> 'thread' -> -1 ->> 'kind' = 'status'
    and r -> 'thread' -> -1 ->> 'from' = 'open' and r -> 'thread' -> -1 ->> 'to' = 'in_progress'
    and r -> 'thread' -> -1 ->> 'body' = 'On it this week' and r -> 'thread' -> -1 ->> 'who' = 'Check Member'
    and (r -> 'may' ->> 'work')::boolean and not (r -> 'may' ->> 'manage')::boolean, r::text);
  r := pg_temp.json_as('member', pg_catalog.format('select meganet.task_update(%L, %L)::text', a1, '{"note": "Gate was locked"}'));
  perform pg_temp.check_that('…writes a note of its own', r -> 'thread' -> -1 ->> 'kind' = 'note' and (r ->> 'notes')::integer = 1, r::text);
  v := pg_temp.as_who('member', pg_catalog.format('select meganet.task_update(%L, %L)', a1, '{"status": "cancelled"}'));
  perform pg_temp.check_that('…but does not cancel it', v = '42501', v);
  v := pg_temp.as_who('member', pg_catalog.format('select meganet.task_update(%L, %L)', a1,
         pg_catalog.jsonb_build_object('team_id', pg_temp.id_of('b'))));
  perform pg_temp.check_that('…nor hand it to another team', v = '42501', v);
  v := pg_temp.as_who('member', pg_catalog.format('select meganet.task_update(%L, %L)', a1, '{"title": "Check renamed"}'));
  perform pg_temp.check_that('…nor change its words', v = '42501', v);
  v := pg_temp.as_who('member', pg_catalog.format('select meganet.task_update(%L, %L)', a1, '{"colour": "red"}'));
  perform pg_temp.check_that('a change a task cannot have is refused', v = '22023', v);
  v := pg_temp.as_who('outsider', pg_catalog.format('select meganet.task_update(%L, %L)', a1, '{"note": "hello"}'));
  perform pg_temp.check_that('somebody who may not see it changes nothing, and is not told it is there', v = 'P0002', v);

  r := pg_temp.json_as('member', pg_catalog.format('select meganet.task_update(%L, %L)::text', a1, '{"status": "done"}'));
  perform pg_temp.check_that('done closes it', r ->> 'status' = 'done' and (r ->> 'closed_at') is not null, r::text);
  r := pg_temp.json_as('member', pg_catalog.format('select meganet.task_update(%L, %L)::text', a1, '{"status": "waiting"}'));
  perform pg_temp.check_that('…and its team opens it again', r ->> 'status' = 'waiting' and (r ->> 'closed_at') is null, r::text);

  v := pg_temp.as_who('owner', pg_catalog.format('select meganet.task_update(%L, %L)', a1,
         pg_catalog.jsonb_build_object('team_id', pg_temp.id_of('b'))));
  perform pg_temp.check_that('an owner, who made it, hands it to no team but their own', v = '42501', v);
  r := pg_temp.json_as('owner', pg_catalog.format('select meganet.task_update(%L, %L)::text', a1,
         '{"title": "Check A owner job, renamed", "due_on": null, "details": "Clear it and flush it"}'));
  perform pg_temp.check_that('…edits its words and its date, the thread saying which',
    r ->> 'title' = 'Check A owner job, renamed' and (r ->> 'due_on') is null and r ->> 'details' = 'Clear it and flush it'
    and r -> 'thread' -> -1 ->> 'kind' = 'edit' and r -> 'thread' -> -1 ->> 'to' = 'title, details, due date', r::text);
  r := pg_temp.json_as('sort', pg_catalog.format('select meganet.task_update(%L, %L)::text', a1,
         pg_catalog.jsonb_build_object('team_id', pg_temp.id_of('b'), 'note', 'Team B has the ladder')));
  perform pg_temp.check_that('somebody who hands out tasks hands it to another team, the names in the thread',
    r ->> 'team' = 'Check Team B' and r -> 'thread' -> -1 ->> 'kind' = 'team'
    and r -> 'thread' -> -1 ->> 'from' = 'Check Team A' and r -> 'thread' -> -1 ->> 'to' = 'Check Team B'
    and r -> 'thread' -> -1 ->> 'body' = 'Team B has the ladder', r::text);
  perform pg_temp.check_that('…and it goes from the old team''s list to the new one''s, its maker still seeing it',
    pg_temp.listed('member') = 'Check A from SoRT' and pg_temp.listed('other') = 'Check A owner job, renamed,Check B from SoRT'
    and pg_temp.listed('owner') = 'Check A from SoRT,Check A owner job, renamed',
    pg_temp.listed('member') || ' | ' || pg_temp.listed('other') || ' | ' || pg_temp.listed('owner'));
  r := pg_temp.json_as('owner', pg_catalog.format('select meganet.task_update(%L, %L)::text', a1, '{"status": "cancelled"}'));
  perform pg_temp.check_that('whoever made it cancels it', r ->> 'status' = 'cancelled' and (r ->> 'closed_at') is not null, r::text);
  v := pg_temp.as_who('other', pg_catalog.format('select meganet.task_update(%L, %L)', a1, '{"status": "open"}'));
  perform pg_temp.check_that('…and the team it is with does not bring it back', v = '42501', v);
  v := pg_temp.as_who('member', pg_catalog.format('select meganet.task_update(%L, %L)', pg_temp.id_of('b1'), '{"note": "hi"}'));
  perform pg_temp.check_that('a member writes nothing on another team''s task', v = 'P0002', v);
  v := pg_temp.as_who('sort', pg_catalog.format('select meganet.task_update(%L, %L)', pg_temp.id_of('u1'),
         '{"station_id": "_check_no_station"}'));
  perform pg_temp.check_that('a station the register does not have is refused here too', v = '22023', v);
  r := pg_temp.json_as('sort', pg_catalog.format('select meganet.task_update(%L, %L)::text', pg_temp.id_of('u1'),
         pg_catalog.jsonb_build_object('team_id', pg_temp.id_of('a'))));
  perform pg_temp.check_that('an unassigned task is handed to a team, and its team sees it',
    r ->> 'team' = 'Check Team A' and pg_temp.listed('member') = 'Check A from SoRT,Check unassigned from SoRT', r::text);
  r := pg_temp.json_as('member', pg_catalog.format('select meganet.task_get(%L)::text', pg_temp.id_of('u1')));
  perform pg_temp.check_that('task_get() answers the details, the thread in order and what the caller may do',
    r ->> 'source' = 'sort' and r ->> 'source_date' = '2026-10-07' and r ->> 'created_by' = 'Check Sort'
    and r -> 'thread' -> 0 ->> 'kind' = 'created' and r -> 'thread' -> 1 ->> 'kind' = 'team'
    and (r -> 'may' ->> 'work')::boolean and not (r -> 'may' ->> 'manage')::boolean, r::text);
end
$$;

-- ── 8. Leaving, and a decline ────────────────────────────────────────────────

do $$
declare
  v text;
  r jsonb;
begin
  v := pg_temp.as_who('owner', pg_catalog.format('select meganet.team_member_remove(%L, %L)', pg_temp.id_of('a'),
         '00000000-0000-4000-8000-0000000a7003'));
  perform pg_temp.check_that('an owner does not take an owner off — themselves included', v = '42501', v);
  v := pg_temp.as_who('member', pg_catalog.format('select meganet.team_member_remove(%L, %L)', pg_temp.id_of('a'),
         '00000000-0000-4000-8000-0000000a7003'));
  perform pg_temp.check_that('a member takes nobody off', v = '42501', v);
  r := pg_temp.json_as('owner', pg_catalog.format('select meganet.team_member_remove(%L, %L)::text', pg_temp.id_of('a'),
         '00000000-0000-4000-8000-0000000a7004'));
  perform pg_temp.check_that('an owner takes a member off',
    pg_catalog.jsonb_array_length(pg_temp.team_in(r, 'Check Team A') -> 'roster') = 1, r::text);
  perform pg_temp.check_that('…who sees the team''s tasks no more, and no longer has the tab',
    pg_temp.listed('member') = '' and not (pg_temp.json_as('member', 'select meganet.whoami()::text') ->> 'tasks')::boolean,
    pg_temp.listed('member'));
  r := pg_temp.json_as('owner', pg_catalog.format('select meganet.team_member_remove(%L, %L)::text', pg_temp.id_of('a'),
         '00000000-0000-4000-8000-0000000a7004'));
  perform pg_temp.check_that('taking off somebody not on it changes nothing',
    pg_catalog.jsonb_array_length(pg_temp.team_in(r, 'Check Team A') -> 'roster') = 1, r::text);

  -- A decline takes everything at once.
  update meganet.app_user set status = 'declined' where id = '00000000-0000-4000-8000-0000000a7005';
  v := pg_temp.as_who('other', 'select meganet.task_list()');
  perform pg_temp.check_that('a declined account is refused its tasks at once', v = '42501', v);
  v := pg_temp.keep_as('other', 'select count(*) from meganet.task');
  perform pg_temp.check_that('…and reads no row of the table', v = '0', v);
  update meganet.app_user set status = 'approved' where id = '00000000-0000-4000-8000-0000000a7005';

  -- Removing a team.
  v := pg_temp.as_who('admin', pg_catalog.format('select meganet.team_remove(%L)', pg_temp.id_of('b')));
  perform pg_temp.check_that('a team tasks have been handed to stays', v = '23503', v);
  v := pg_temp.as_who('owner', pg_catalog.format('select meganet.team_remove(%L)', pg_temp.id_of('empty')));
  perform pg_temp.check_that('only an administrator removes a team', v = '42501', v);
  r := pg_temp.json_as('admin', pg_catalog.format('select meganet.team_remove(%L)::text', pg_temp.id_of('empty')));
  perform pg_temp.check_that('an administrator removes one nothing was handed to',
    pg_temp.team_in(r, 'Check Empty') is null and not exists (select 1 from meganet.team t where t.id = pg_temp.id_of('empty')), r::text);
  r := pg_temp.json_as('admin', pg_catalog.format('select meganet.team_member_remove(%L, %L)::text', pg_temp.id_of('a'),
         '00000000-0000-4000-8000-0000000a7003'));
  perform pg_temp.check_that('an administrator takes an owner off',
    pg_catalog.jsonb_array_length(pg_temp.team_in(r, 'Check Team A') -> 'roster') = 0, r::text);
end
$$;

-- ── The verdict ──────────────────────────────────────────────────────────────

select lpad(ord::text, 2) as "#",
       case when ok then 'ok  ' else 'FAIL' end as result,
       name,
       case when ok then '' else left(coalesce(note, ''), 200) end as detail
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
